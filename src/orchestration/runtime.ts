// The runtime facade: Discord lifecycle around the House bot and the waifu bots (spec 9.4, 9.5),
// thread tracking, DM eligibility and forget, pause/resume, and the Living cast host (spec §3):
// accepted guild messages, DMs and cache events go to its intake; the owner's forget and a DM
// /forget run its life scrub (§7.5).

import type {
  DiscordDirectMessageEvent,
  DiscordDmForgetCommandEvent,
  DiscordMessageEvent,
  DiscordPrintCommandEvent,
  DiscordThreadEvent,
  DiscordThreadInfo,
  DiscordWaifuAutocompleteEvent,
  DiscordWakeCommandEvent
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
import type { CastRuntimeOptions } from "./runtimeShared.js";
import { channelHasWaifus, ensureChannelConfig, ensureServer, isKnownWaifuAuthor, readDiscordBotsFile, syncGuilds, listWaifus } from "./stores/config.js";
import { noteActiveChatParticipant } from "./stores/participants.js";
import { observeThread, parentSharesCast, readThreads, removeThread } from "./stores/threads.js";
import { dmForget, type DmConversation, type DmForgetHooks, type DmForgetInput, type DmForgetResult } from "./dm/dmForget.js";
import { forgetUser, unqueuedForgetResult, type ForgetUserResult } from "./dm/forgetUser.js";
import { forgetCapturedTraffic } from "../shared/queryLog.js";
import { personMatcher } from "../life/text.js";
import { forgetConversationImageIndex } from "../discord/imageIndex.js";
import { computeDmEligibility, dmFloorAt } from "./dm/dmStore.js";
import { LifeActionError, LivingCast } from "../life/livingCast.js";
import type { ForgetScrubResult } from "../life/forget.js";
import { sharedModelClient } from "../models/client.js";
import { DEFAULT_APP_CONFIG } from "../shared/schemas/config.js";
import { withThreadChannels } from "./stores/threads.js";

export type { CastRuntimeOptions } from "./runtimeShared.js";
export { currentlyDoingForWaifu } from "./timeOfDay.js";

/** Spec 9.6: `/api/runtime` `discord.dm`. */
export type DmRuntimeStatus = {
  eligibleWaifus: Array<{ waifuId: string; botId: string; intentActive: boolean }>;
  warnings: string[];
};

/**
 * The owner's forget-user: the DM part (§7.5 step 1) plus every life's scrub (steps 2–5). `lives`:
 * each life scrubbed now; `livesQueued`: waifus whose scrub waits for her next start (no runtime).
 */
export type OwnerForgetResult = ForgetUserResult & { lives?: ForgetScrubResult[]; livesQueued?: string[] };

export class CastRuntime {
  readonly permissionWarnings = new PermissionWarningTracker();
  /** Per-call usage lines (spec 8.10); shared with every model call this runtime makes. */
  readonly usageLedger: UsageLedger;
  /** Quota/billing cooldowns; surfaced as `/api/runtime.providerAlerts`. */
  readonly providerAlerts: ProviderAlerts;
  /** Event-maintained names for mentions, roles, channels, emojis (spec 9.4); `/api/runtime` reads its status. */
  readonly directory: GuildDirectory;
  /** The conversation message cache (spec 9.4): `read_messages`' backend. */
  readonly conversations: ConversationMessageCache;
  /** Every life on this host (Living cast spec §3). */
  readonly cast: LivingCast;
  private unsubscribes: Array<() => void> = [];
  private readonly background = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(private readonly options: CastRuntimeOptions) {
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
    const appConfig = options.appConfig ?? DEFAULT_APP_CONFIG;
    this.cast = new LivingCast({
      storage: options.storage,
      logger: options.logger,
      discord: () => this.options.discord,
      conversations: this.conversations,
      directory: this.directory,
      models: options.models ?? sharedModelClient(options.storage.dataRoot),
      config: () => appConfig,
      isPaused: () => this.stopping || (this.options.isPaused?.() ?? false),
      usageLedger: this.usageLedger,
      // Turns, maintenance and forget scrubs hold update leases and count as active runs (review I7).
      ...(options.updateActivity ? { updateActivity: options.updateActivity } : {}),
      ...(options.onActiveRunsChange ? { onActiveRunsChange: options.onActiveRunsChange } : {}),
      ...(options.images ? { images: options.images } : {}),
      ...(options.ocr?.cachedText ? { ocr: { cachedText: (ref) => options.ocr!.cachedText!(ref), ...(options.ocr.textFor ? { textFor: (ref, o) => options.ocr!.textFor!(ref, o) } : {}) } } : {}),
      ...options.livingCast
    });
  }

  /** The enabled cast of a channel or tracked thread (inherited casts included). */
  private async castOf(guildId: string, channelId: string): Promise<string[]> {
    const server = await this.options.storage.readJson(path.join("user", "servers", guildId, "server.json"), ServerConfigSchema).catch(() => undefined);
    if (!server) return [];
    const withThreads = await withThreadChannels(this.options.storage, server).catch(() => server);
    const channel = withThreads.channels[channelId];
    return channelHasWaifus(channel) ? [...(channel.enabledWaifuIds ?? [])] : [];
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
      discord.onDmForgetCommand?.((event) => this.handleDmForgetCommand(event)),
      // The owner's slash commands on the House bot (§10.4).
      discord.onWakeCommand?.((event) => this.handleWakeCommand(event)),
      discord.onPrintCommand?.((event) => this.handlePrintCommand(event)),
      discord.onWaifuAutocomplete?.((event) => this.handleWaifuAutocomplete(event)),
      // Edits and deletes in a life (§10.3); a newly added mention under 2 minutes wakes (§4.2).
      this.conversations.onEvent((event) => this.cast.onCacheEvent(event, (guildId, channelId) => this.castOf(guildId, channelId))),
      // Bot roles: replaced from the bot's own member updates, refetched after role changes (§10.2).
      discord.onBotRolesChange?.((event) => this.cast.botRoles.set(event.guildId, event.botId, event.roleIds)),
      discord.onDirectoryEvent?.((event) => {
        if (event.type === "roleUpsert" || event.type === "roleDelete" || event.type === "guildDelete") this.cast.onRolesChanged(event.guildId);
        else if (event.type === "memberUpsert" && (discord.ownAuthorIds?.() ?? []).includes(event.member.userId)) this.cast.onRolesChanged(event.guildId);
      })
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    if (discord.listGuilds) await syncGuilds(this.options);
    await this.cast.start();
  }

  /** After an explicit user resume: the life catch-up (§5.7) and queued wakes. */
  resumeAfterPause(): void {
    this.cast.resume();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    await this.settleBackground();
    await this.cast.stop();
    await this.options.ocr?.dispose?.();
    // Model calls queue their ledger lines fire-and-forget; wait for them so a following process
    // exit cannot lose them.
    await this.usageLedger.flush();
    await this.directory.close();
    this.options.onActiveRunsChange?.(0);
  }

  /** Explicit user pause: in-flight turns are aborted, queues stay (§5.2). */
  async pause(): Promise<void> {
    // Aborted turns report their own end through the cast's active-run count.
    this.cast.pause();
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
   * Guild message intake. Keeps the bookkeeping (active participants, server and channel entries,
   * thread tracking), drops what Living cast would never wake for, and hands an accepted message to
   * the life intake (§4.2).
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
    const authorIsWaifu = event.authorBot && (await isKnownWaifuAuthor(this.options.storage, event.authorId));
    if (event.authorBot && !authorIsWaifu) return;
    await this.cast.onGuildMessage({
      guildId: event.guildId,
      channelId: event.channelId,
      messageId: event.messageId,
      castWaifuIds: [...(channel.enabledWaifuIds ?? [])],
      authorIsWaifu
    });
  }

  /** DM intake (§4.1 `dm`): the DM state is updated even while paused; the wake is not. */
  async handleDirectMessage(event: DiscordDirectMessageEvent): Promise<void> {
    await this.cast.onDirectMessage(event);
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
        const key = conversationKey(conversation);
        await forgetConversationImageIndex(this.options.storage.dataRoot, key, () =>
          rm(this.options.storage.dataPath(conversationDirPath(key)), { recursive: true, force: true })
        );
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

  /**
   * dmForget with the runtime's side effects (cached messages and images dropped), then her life:
   * a conversation forget rewrites her summary without the person (§7.5 steps 0–2), a full one runs
   * the whole scrub (steps 2–5).
   */
  async forgetDm(input: DmForgetInput, o: { source?: "owner" | "dm"; background?: boolean } = {}): Promise<DmForgetResult> {
    // Step 0 and the durable queue first: the identity is read before the DM state goes, and a
    // crash or failure from here on leaves the scrub queued.
    const prepared =
      !input.dryRun && input.waifuId
        ? await this.cast
            .prepareForget({ waifuId: input.waifuId, userId: input.userId, source: o.source ?? "owner", scope: input.scope === "all" ? "everything" : "conversation" })
            .catch((error: unknown) => {
              this.options.logger.warn("Life forget could not be queued", { waifuId: input.waifuId, message: error instanceof Error ? error.message : String(error) });
              return undefined;
            })
        : undefined;
    const result = await dmForget(this.options.storage, input, this.dmForgetHooks());
    if (prepared) {
      const life = this.cast.runForget(prepared).catch((error: unknown) => {
        this.options.logger.warn("Life forget scrub failed; it stays queued", { waifuId: input.waifuId, message: error instanceof Error ? error.message : String(error) });
      });
      if (o.background) this.trackBackground(life);
      else await life;
    }
    if (!input.dryRun) forgetCapturedTraffic(personMatcher(input.userId, prepared?.identity.names));
    return result;
  }

  /**
   * The owner's forget-user (§7.5): every life's scrub queued with the identity collected now, then
   * the DM part and the archive (spec 9.1.4, D-b), the directory's member lists, then the scrubs.
   * A part of step 1 that did not finish is reported in `pending` (it retries at the next start);
   * the life scrubs run all the same.
   */
  async forgetUser(input: { discordUserId: string; dryRun?: boolean }): Promise<OwnerForgetResult> {
    const prepared = input.dryRun ? undefined : await this.cast.prepareOwnerForget(input.discordUserId);
    const identities = prepared?.map((entry) => entry.identity) ?? [];
    const names = [...new Set(identities.flatMap((identity) => identity.names))];
    const avoidNames = [...new Set(identities.flatMap((identity) => identity.sharedNames))];
    const result = await forgetUser(this.options.storage, { ...input, names, avoidNames }, this.dmForgetHooks()).catch((error: unknown) => {
      if (input.dryRun) throw error;
      this.options.logger.warn("The owner's forget could not queue its DM part; the life scrubs still run", { message: error instanceof Error ? error.message : String(error) });
      return unqueuedForgetResult(input.discordUserId, error);
    });
    if (input.dryRun) return result;
    await this.directory.forgetMember(input.discordUserId).catch((error: unknown) => {
      this.options.logger.warn("Guild directory forget failed", { message: error instanceof Error ? error.message : String(error) });
    });
    const lives = await this.cast.forgetPerson(input.discordUserId, prepared);
    return { ...result, lives: lives.scrubbed };
  }

  private dmForgetHooks(): DmForgetHooks {
    return {
      logger: this.options.logger,
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

  /**
   * A confirmed DM `/forget` (spec 9.1.5, O3; Living cast §7.5). Never touches the rate-limit
   * counters. The DM part runs at once; her life's scrub runs in the background ("everything": the
   * whole scrub, at most once per 6 hours per user, later requests queue as a pending scrub).
   */
  async handleDmForgetCommand(event: DiscordDmForgetCommandEvent): Promise<string> {
    const everything = event.scope === "everything";
    const result = await this.forgetDm(
      {
        userId: event.userId,
        waifuId: event.waifuId,
        scope: everything ? "all" : "conversation"
      },
      { source: "dm", background: true }
    );
    this.options.logger.info("DM forget command handled", { waifuId: event.waifuId, scope: result.scope, ...result.deleted });
    return everything
      ? "Done: I deleted our private chat, and everything else I remember about you is marked to be forgotten."
      : "Done: I deleted our private chat.";
  }

  /** A waifu by id or display name (case-insensitive). */
  private async findWaifu(query: string | undefined): Promise<{ id: string; displayName: string } | undefined> {
    const wanted = query?.trim().toLowerCase();
    if (!wanted) return undefined;
    const waifus = await listWaifus(this.options.storage).catch(() => []);
    return waifus.find((waifu) => waifu.id.toLowerCase() === wanted) ?? waifus.find((waifu) => waifu.displayName.toLowerCase() === wanted);
  }

  /** Waifus cast anywhere in a server (any channel or thread entry). */
  private async guildCast(guildId: string): Promise<Set<string>> {
    const server = await this.options.storage.readJson(path.join("user", "servers", guildId, "server.json"), ServerConfigSchema).catch(() => undefined);
    const ids = new Set<string>();
    for (const channel of Object.values(server?.channels ?? {})) for (const id of channel.enabledWaifuIds ?? []) ids.add(id);
    return ids;
  }

  /** `/wake <waifu> [note]` (§10.4): an `owner` wake, which skips sleep and budget (§4.5). Only this server's cast. */
  async handleWakeCommand(event: DiscordWakeCommandEvent): Promise<void> {
    const waifu = await this.findWaifu(event.waifuId);
    if (!waifu) return event.respond("I don't know that waifu.");
    if (!(await this.guildCast(event.guildId)).has(waifu.id)) return event.respond(`${waifu.displayName} isn't cast in this server.`);
    // A cast that is stopping (a reload) refuses: the wake is dropped and the owner told so.
    const outcome = await this.cast.ownerWake(waifu.id, event.note).catch((error: unknown) => {
      if (error instanceof LifeActionError && error.code === "offline") return "dropped" as const;
      throw error;
    });
    await event.respond(
      outcome === "queued"
        ? `Woke ${waifu.displayName}.`
        : outcome === "dropped"
          ? `${waifu.displayName} can't be woken right now (paused or disabled).`
          : `${waifu.displayName}'s wake is queued.`
    );
  }

  /** `/print system_prompt|notes|life <waifu> [private]` (§10.4), only to the owner; DM content only with `private`. */
  async handlePrintCommand(event: DiscordPrintCommandEvent): Promise<void> {
    const waifu = await this.findWaifu(event.waifuId);
    if (!waifu) return event.respond("I don't know that waifu.");
    const text =
      event.type === "notes"
        ? await this.cast.printNotes(waifu.id)
        : event.type === "life"
          ? await this.cast.printLife(waifu.id, { private: event.private === true })
          : event.type === "system_prompt"
            ? await this.cast.printSystemPrompt(waifu.id, { private: event.private === true })
            : undefined;
    if (text === undefined) return event.respond("Pick what to print: system_prompt, notes or life.");
    await event.respond(text);
  }

  /**
   * The `waifu` option: this channel's cast first. `/wake` offers only this server's cast; `/print`
   * offers every waifu.
   */
  async handleWaifuAutocomplete(event: DiscordWaifuAutocompleteEvent): Promise<void> {
    const wanted = event.focusedValue.trim().toLowerCase();
    const here = event.guildId && event.channelId ? new Set(await this.castOf(event.guildId, event.channelId).catch(() => [])) : new Set<string>();
    const server = event.commandName === "wake" && event.guildId ? await this.guildCast(event.guildId) : undefined;
    const waifus = (await listWaifus(this.options.storage).catch(() => []))
      .filter((waifu) => (server ? server.has(waifu.id) : event.commandName === "print" || waifu.enabled || here.has(waifu.id)))
      .filter((waifu) => !wanted || waifu.id.toLowerCase().includes(wanted) || waifu.displayName.toLowerCase().includes(wanted))
      .sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id)) || a.displayName.localeCompare(b.displayName));
    await event.respond(waifus.map((waifu) => ({ name: waifu.displayName.slice(0, 100), value: waifu.id })));
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
