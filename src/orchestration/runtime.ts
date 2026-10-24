// The runtime facade: Discord lifecycle around the House bot and the waifu bots (spec 9.4, 9.5),
// thread tracking, DM eligibility and forget, pause/resume.
//
// Living cast L1 removed the director, the reply path and the memory jobs. Until L2 wires the
// intake, wake router and life loop (Living cast spec §3, §4), accepted guild messages and DMs are
// only logged: nobody replies between L1 and L2.

import type {
  DiscordDirectMessageEvent,
  DiscordDmForgetCommandEvent,
  DiscordMessageEvent,
  DiscordThreadEvent,
  DiscordThreadInfo
} from "../discord/client.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ConversationMessageCache } from "../discord/conversationCache.js";
import { GuildDirectory } from "../discord/guildDirectory.js";
import { ServerConfigSchema, type ServerConfig } from "../shared/schemas/domain.js";
import { sharedProviderAlerts, type ProviderAlerts } from "./providerAlerts.js";
import { sharedUsageLedger, type UsageLedger } from "./usageLedger.js";
import { PermissionWarningTracker } from "./permissionWarnings.js";
import { conversationDirPath, conversationKey, type ConversationRef } from "./context/keys.js";
import { EMPTY_GUILD_DIRECTORY, renderDiscordMessage } from "./context/messageRender.js";
import type { RuntimeOrchestratorOptions } from "./runtimeShared.js";
import { channelHasWaifus, ensureChannelConfig, ensureServer, isKnownWaifuAuthor, readDiscordBotsFile, syncGuilds, listWaifus } from "./stores/config.js";
import { noteActiveChatParticipant } from "./stores/participants.js";
import { observeThread, parentSharesCast, readThreads, removeThread } from "./stores/threads.js";
import { dmForget, type DmConversation, type DmForgetHooks, type DmForgetInput, type DmForgetResult } from "./dm/dmForget.js";
import { forgetUser, type ForgetUserResult } from "./dm/forgetUser.js";
import { computeDmEligibility, dmFloorAt } from "./dm/dmStore.js";

export type { RuntimeOrchestratorOptions } from "./runtimeShared.js";
export { currentlyDoingForWaifu } from "./timeOfDay.js";

/** Spec 9.6: `/api/runtime` `discord.dm`. */
export type DmRuntimeStatus = {
  eligibleWaifus: Array<{ waifuId: string; botId: string; intentActive: boolean }>;
  warnings: string[];
};

/** Logged for every message the runtime accepts until L2 wires Living cast. */
export const LIVING_CAST_NOT_WIRED = "Living cast not yet wired (L2)";

export class RuntimeOrchestrator {
  readonly permissionWarnings = new PermissionWarningTracker();
  /** Per-call usage lines (spec 8.10); shared with every model call this runtime makes. */
  readonly usageLedger: UsageLedger;
  /** Quota/billing cooldowns; surfaced as `/api/runtime.providerAlerts`. */
  readonly providerAlerts: ProviderAlerts;
  /** Event-maintained names for mentions, roles, channels, emojis (spec 9.4); `/api/runtime` reads its status. */
  readonly directory: GuildDirectory;
  /** The conversation message cache (spec 9.4): `read_messages`' backend in L2. */
  readonly conversations: ConversationMessageCache;
  private unsubscribes: Array<() => void> = [];
  private readonly background = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.directory =
      options.directory ??
      new GuildDirectory({
        storage: options.storage,
        logger: options.logger,
        settings: () => ({ memberListRefreshHours: options.memberListRefreshHours ?? 24 }),
        bots: () => readDiscordBotsFile(options.storage)
      });
    this.conversations =
      options.conversationCache ??
      new ConversationMessageCache({ discord: () => this.options.discord, logger: options.logger, directory: this.directory });
    this.usageLedger = options.usageLedger ?? sharedUsageLedger(options.storage.dataRoot);
    this.providerAlerts = options.providerAlerts ?? sharedProviderAlerts(options.storage.dataRoot);
  }

  async start(): Promise<void> {
    // Before any handler can read a conversation: the feed marks conversations untrusted until
    // their first REST sync, and keeps names fresh from then on.
    const discord = this.options.discord;
    this.directory.start(discord.onDirectoryEvent ? (listener) => discord.onDirectoryEvent!(listener) : undefined);
    this.unsubscribes = [
      this.conversations.attach(),
      discord.onMessage?.((event) => {
        this.runBackground("Discord message handler failed", discordMessageLogContext(event), () => this.handleDiscordMessage(event));
      }),
      discord.onThreadChange?.((event) => {
        this.runBackground("Discord thread handler failed", { guildId: event.guildId, threadId: event.threadId, change: event.change }, () =>
          this.handleDiscordThreadChange(event)
        );
      }),
      discord.onDirectMessage?.((event) => {
        this.runBackground("Discord DM handler failed", { waifuId: event.waifuId, messageId: event.messageId }, () =>
          this.handleDirectMessage(event)
        );
      }),
      discord.onDmForgetCommand?.((event) => this.handleDmForgetCommand(event))
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    if (discord.listGuilds) await syncGuilds(this.options);
  }

  /** Re-run boot catch-up after an explicit user resume (L2: the life catch-up). */
  resumeAfterPause(): void {
    // Nothing to catch up until L2 wires lives.
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    await this.settleBackground();
    await this.options.ocr?.dispose?.();
    // Model calls queue their ledger lines fire-and-forget; wait for them so a following process
    // exit cannot lose them.
    await this.usageLedger.flush();
    await this.directory.close();
    this.options.onActiveRunsChange?.(0);
  }

  /** Explicit user pause. */
  async pause(): Promise<void> {
    this.options.onActiveRunsChange?.(0);
  }

  private runBackground(label: string, context: Record<string, unknown>, task: () => void | Promise<unknown>): void {
    if (this.stopping) return;
    const release = this.options.updateActivity?.begin();
    if (this.options.updateActivity && !release) return;
    const tracked = Promise.resolve()
      .then(() => (this.stopping ? undefined : task()))
      .catch((error) => {
        this.options.logger.error(label, {
          ...context,
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        release?.();
        this.background.delete(tracked);
      });
    this.background.add(tracked);
  }

  /** Track a fire-and-forget write (already error-handled) so stop() settles it. */
  private trackBackground(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work.finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Wait for the background handlers started so far (tests: before tearing the data root down). */
  async settleBackground(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /**
   * Guild message intake. Keeps the bookkeeping later layers rely on (active participants, server
   * and channel entries, thread tracking) and drops what Living cast would never wake for; an
   * accepted message is only logged until L2.
   */
  async handleDiscordMessage(event: DiscordMessageEvent): Promise<void> {
    if (!event.guildId || !event.channelId) return;
    if (!event.authorBot) {
      // Tracked so stop() waits for the write (never left racing a data-root teardown).
      this.trackBackground(noteActiveChatParticipant(this.options.storage, event.guildId, event.channelId, {
        userId: event.authorId,
        displayName: event.authorDisplayName ?? event.authorId
      }).catch((error) => {
        this.options.logger.warn("Failed to update active chat participants", {
          guildId: event.guildId,
          channelId: event.channelId,
          userId: event.authorId,
          message: error instanceof Error ? error.message : String(error)
        });
      }));
    }
    if (this.options.isPaused?.()) return;
    const server = await ensureServer(this.options.storage, event.guildId);
    if (server.paused) return;
    // Spec 9.5: a thread is never auto-created as a channel entry; it is tracked in threads.json and
    // inherits its parent's cast (unless the parent switched threads off or has no cast).
    const facts = event.thread ? { thread: event.thread } : await this.resolveThreadFacts(server, event);
    const serverWithChannel = facts.thread
      ? await this.admitThreadMessage(server, { ...event, thread: facts.thread })
      : await ensureChannelConfig(this.options, server, event.channelId, facts.metadata);
    const channel = serverWithChannel.channels[event.channelId];
    if (!channelHasWaifus(channel)) return;
    if (event.authorBot && !(await isKnownWaifuAuthor(this.options.storage, event.authorId))) return;
    this.options.logger.info(LIVING_CAST_NOT_WIRED, {
      guildId: event.guildId,
      channelId: event.channelId,
      messageId: event.messageId,
      authorBot: event.authorBot
    });
  }

  /** DM intake: logged only until L2 (the DM wake, spec §4.1 `dm`). */
  async handleDirectMessage(event: DiscordDirectMessageEvent): Promise<void> {
    if (this.options.isPaused?.()) return;
    this.options.logger.info(LIVING_CAST_NOT_WIRED, { waifuId: event.waifuId, messageId: event.messageId, dm: true });
  }

  /** Thread facts for a message event that carries none: a tracked thread, else Discord's channel metadata. */
  private async resolveThreadFacts(
    server: ServerConfig,
    event: DiscordMessageEvent
  ): Promise<{ thread?: DiscordThreadInfo; metadata?: { guildName?: string; channelName?: string } }> {
    const tracked = (await readThreads(this.options.storage, event.guildId)).threads[event.channelId];
    if (tracked) {
      return { thread: { parentId: tracked.parentId, name: tracked.name, kind: tracked.kind, archived: tracked.archived, locked: tracked.locked } };
    }
    // A channel with a stored entry of its own (not a thread overlay) is a plain channel.
    if (server.channels[event.channelId]) return {};
    // The gateway-fed directory knows channels and threads (A seeds it at boot).
    const known = this.directory.channel(event.guildId, event.channelId);
    if (known?.kind === "thread" && known.parentId) {
      return { thread: { parentId: known.parentId, name: known.name, kind: "public_thread", archived: false, locked: false } };
    }
    if (known) return {};
    try {
      const metadata = await this.options.discord.fetchChannelMetadata?.({ guildId: event.guildId, channelId: event.channelId });
      return metadata ? { ...(metadata.thread ? { thread: metadata.thread } : {}), metadata } : {};
    } catch {
      return {};
    }
  }

  /** Delete what remains of threads that left threads.json (deleted on Discord or idle for 30 days). */
  private async forgetThreads(guildId: string, threadIds: readonly string[], o: { removeEntry: boolean }): Promise<void> {
    for (const threadId of threadIds) {
      try {
        const conversation: ConversationRef = { kind: "guild", guildId, channelId: threadId };
        this.conversations.forget(conversation);
        await rm(this.options.storage.dataPath(conversationDirPath(conversationKey(conversation))), { recursive: true, force: true });
        if (o.removeEntry) await this.removeStoredChannelEntry(guildId, threadId);
      } catch (error) {
        this.options.logger.warn("Failed to forget a thread", {
          guildId,
          threadId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** Drop a channel entry from server.json when one exists (never creates the file). */
  private async removeStoredChannelEntry(guildId: string, channelId: string): Promise<void> {
    const relativePath = path.join("user", "servers", guildId, "server.json");
    const stored = await this.options.storage.readJson(relativePath, ServerConfigSchema).catch(() => undefined);
    if (!stored?.channels[channelId]) return;
    await this.options.storage.updateRevisionedJson({
      resourceKey: `server:${guildId}`,
      relativePath,
      schema: ServerConfigSchema,
      fallback: stored,
      transform: (current) => {
        const { [channelId]: _removed, ...channels } = current.channels;
        return { ...current, channels };
      }
    });
  }

  /** Track the thread a message arrived in (when it can take part) and return the refreshed server. */
  private async admitThreadMessage(server: ServerConfig, event: DiscordMessageEvent): Promise<ServerConfig> {
    const thread = event.thread!;
    const explicit = server.channels[event.channelId];
    const hasOwnCast = (explicit?.enabledWaifuIds?.length ?? 0) > 0 && (!explicit?.thread || explicit.thread.explicit === true);
    if (!hasOwnCast && !parentSharesCast(server.channels[thread.parentId])) return server;
    // A message in a thread means it is open: Discord unarchives on send, so a stale cached
    // `archived: true` must not silence it.
    const pruned: string[] = [];
    await observeThread(
      this.options.storage,
      event.guildId,
      {
        threadId: event.channelId,
        parentId: thread.parentId,
        name: thread.name,
        kind: thread.kind,
        archived: false,
        locked: thread.locked,
        activity: true
      },
      new Date(),
      pruned
    );
    await this.forgetThreads(event.guildId, pruned, { removeEntry: false });
    return ensureServer(this.options.storage, event.guildId);
  }

  /** Thread lifecycle (spec 9.5): track it, and forget it when it is deleted. */
  async handleDiscordThreadChange(event: DiscordThreadEvent): Promise<void> {
    const { guildId, threadId, thread } = event;
    if (event.change === "delete") {
      await removeThread(this.options.storage, guildId, threadId);
      // The thread is gone: so are its conversation directory and any explicit channel entry.
      await this.forgetThreads(guildId, [threadId], { removeEntry: true });
      return;
    }
    const server = await ensureServer(this.options.storage, guildId);
    const explicit = server.channels[threadId];
    const hasOwnCast = (explicit?.enabledWaifuIds?.length ?? 0) > 0 && (!explicit?.thread || explicit.thread.explicit === true);
    const known = (await readThreads(this.options.storage, guildId)).threads[threadId];
    // Only threads that can take part are tracked (a cast of their own or one to inherit); one we
    // already track keeps following its archive / lock state even if the parent lost its cast.
    if (!hasOwnCast && !known && !parentSharesCast(server.channels[thread.parentId])) return;
    const pruned: string[] = [];
    await observeThread(
      this.options.storage,
      guildId,
      {
        threadId,
        parentId: thread.parentId,
        name: thread.name,
        kind: thread.kind,
        archived: thread.archived,
        locked: thread.locked
      },
      new Date(),
      pruned
    );
    await this.forgetThreads(guildId, pruned, { removeEntry: false });
    if (thread.archived || thread.locked) return;
    if (event.change === "create" || event.previous?.archived) {
      // New or resumed (unarchived) thread: make sure the bot receives its messages.
      await this.options.discord.joinThread?.({ guildId, threadId }).catch((error: unknown) => {
        this.options.logger.info("Could not join thread", {
          guildId,
          threadId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  // ---- DMs (spec 9.1) ---------------------------------------------------------------------------

  /** After a waifu write that may change DM eligibility: re-log only bots whose intents changed. */
  async reconcileDmIntents(): Promise<{ relogged: string[] }> {
    return (await this.options.discord.reconcileDmIntents?.()) ?? { relogged: [] };
  }

  /** `/api/runtime` `discord.dm` (spec 9.6). */
  async dmStatus(): Promise<DmRuntimeStatus> {
    const [waifus, bots] = await Promise.all([listWaifus(this.options.storage), readDiscordBotsFile(this.options.storage)]);
    const eligibility = computeDmEligibility(waifus, bots);
    const intents = this.options.discord.dmIntentStatus?.() ?? [];
    const warnings = [...eligibility.warnings];
    const eligibleWaifus = eligibility.eligible.map((entry) => {
      const intent = intents.find((candidate) => candidate.botId === entry.botId);
      const intentActive = intent?.intentActive === true && intent.waifuId === entry.waifuId;
      if (intent?.connected && !intentActive) warnings.push(`dm_intent_pending_reconnect:${entry.botId}`);
      return { waifuId: entry.waifuId, botId: entry.botId, intentActive };
    });
    return { eligibleWaifus, warnings };
  }

  /** dmForget with the runtime's side effects: cached messages and images dropped. */
  async forgetDm(input: DmForgetInput): Promise<DmForgetResult> {
    return dmForget(this.options.storage, input, this.dmForgetHooks());
  }

  /** The owner's forget-user, DM part (spec 9.1.4), with the same runtime side effects. */
  async forgetUser(input: { discordUserId: string; dryRun?: boolean }): Promise<ForgetUserResult> {
    return forgetUser(this.options.storage, input, this.dmForgetHooks());
  }

  private dmForgetHooks(): DmForgetHooks {
    return {
      imageKeys: (conversation: DmConversation) =>
        this.conversations
          .bufferedMessages(conversation)
          .flatMap((message) => renderDiscordMessage(message, EMPTY_GUILD_DIRECTORY, "UTC")?.images.map((image) => image.key) ?? []),
      beforeDelete: async (conversation: DmConversation) => {
        // No cached messages from before the forget may be read back.
        this.conversations.forget(conversation);
        this.conversations.setFloor(conversation, dmFloorAt(new Date()));
      },
      ...(this.options.images?.purge || this.options.ocr?.purge
        ? {
            purgeImages: async (keys: string[]) => {
              await this.options.images?.purge?.(keys);
              await this.options.ocr?.purge?.(keys);
            }
          }
        : {})
    };
  }

  /** A confirmed DM `/forget` (spec 9.1.5, O3). Never touches the rate-limit counters. */
  async handleDmForgetCommand(event: DiscordDmForgetCommandEvent): Promise<string> {
    const result = await this.forgetDm({
      userId: event.userId,
      waifuId: event.waifuId,
      scope: event.scope === "everything" ? "all" : "conversation"
    });
    this.options.logger.info("DM forget command handled", { waifuId: event.waifuId, scope: result.scope, ...result.deleted });
    return event.scope === "everything"
      ? "Done: I forgot our private chat and everything I remembered about you."
      : "Done: I forgot our private chat.";
  }
}

function discordMessageLogContext(event: DiscordMessageEvent): Record<string, unknown> {
  return {
    guildId: event.guildId,
    channelId: event.channelId,
    messageId: event.messageId,
    authorId: event.authorId,
    authorBot: event.authorBot
  };
}
