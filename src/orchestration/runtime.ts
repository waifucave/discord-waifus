import type {
  DiscordMessageDeleteEvent,
  DiscordMessageEditEvent,
  DiscordMessageEvent,
  DiscordThreadEvent,
  DiscordThreadInfo
} from "../discord/client.js";
import { loadGuildDirectoryView } from "../discord/directoryView.js";
import type { ServerConfig } from "../shared/schemas/domain.js";
import { createGatewayModelPipeline } from "./pipeline/gatewayPipeline.js";
import { sharedProviderAlerts, type ProviderAlerts } from "./providerAlerts.js";
import { sharedUsageLedger, type UsageLedger } from "./usageLedger.js";
import { PermissionWarningTracker } from "./permissionWarnings.js";
import { RUNTIME_SHUTDOWN_INTERRUPT_REASON } from "./restartResume.js";
import { OneShotDecider } from "./oneShot/decider.js";
import { ChannelRunner } from "./channelRunner.js";
import { RuntimeCommands } from "./commands.js";
import { MemoryJobs } from "./memoryJobs.js";
import { ModelAccess } from "./modelAccess.js";
import { ResponderExecutor } from "./responderExecutor.js";
import { ReviewerRunner } from "./reviewerRunner.js";
import { createAppContextRuntime } from "./context/appRuntime.js";
import { isGapEntry } from "./context/ledger.js";
import type { ConversationRef } from "./context/keys.js";
import type { ContextRuntime } from "./context/runtime.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import {
  type ChannelRunOptions,
  type RuntimeCollaboratorOptions,
  type RuntimeHooks,
  type RuntimeOrchestratorOptions,
  type StageManagerRunResult,
  runKey,
  timerKey
} from "./runtimeShared.js";
import { channelHasWaifus, ensureChannelConfig, ensureServer, isKnownWaifuAuthor, syncGuilds } from "./stores/config.js";
import { healPendingOrchestratorDecisions } from "./stores/decisionHistory.js";
import { noteActiveChatParticipant } from "./stores/participants.js";
import { clearScheduledRetrigger, ensureChannelSession, persistShutdownWake } from "./stores/sessions.js";
import { observeThread, parentSharesCast, readThreads, removeThread } from "./stores/threads.js";

/** Spec 9.5: an edit that adds a waifu mention to the newest human message this recently re-triggers. */
const EDIT_MENTION_RETRIGGER_MS = 2 * 60_000;

/**
 * A change to a message already in a conversation, in the shape of the Phase 5 conversation cache's
 * `update` / `delete` / `deleteBulk` events (`ConversationCacheEvent`), so switching the source from
 * the raw discord.js listeners to `conversations.onEvent` is one line. `source: "catchup"` marks a
 * change found after downtime or a reconnect: it is recorded like any other but never re-triggers.
 */
export type MessageChangeEvent =
  | {
      type: "update";
      conversation: ConversationRef;
      message: RawDiscordMessage;
      previous?: RawDiscordMessage;
      source?: "gateway" | "catchup";
    }
  | { type: "delete"; conversation: ConversationRef; messageId: string; previous?: RawDiscordMessage; source?: "gateway" | "catchup" }
  | { type: "deleteBulk"; conversation: ConversationRef; messageIds: string[] };

export type { DreamPassResult, RuntimeOrchestratorOptions, StageManagerRunResult } from "./runtimeShared.js";
export { currentlyDoingForWaifu } from "./promptBuilders.js";

export class RuntimeOrchestrator {
  readonly permissionWarnings = new PermissionWarningTracker();
  /** Per-call usage lines (spec 8.10); shared with every pipeline this runtime creates. */
  readonly usageLedger: UsageLedger;
  /** Quota/billing cooldowns; surfaced as `/api/runtime.providerAlerts`. */
  readonly providerAlerts: ProviderAlerts;
  // Set by pause() and by a paused start(); resumeAfterPause() is a no-op unless it is set, so a
  // redundant Resume can never replan (and duplicate) live runs.
  private wasPaused = false;
  private unsubscribes: Array<() => void> = [];
  private stopping = false;
  private readonly oneShot: OneShotDecider;
  /**
   * @internal Observer/dream scheduler. Exposed only so tests can run one memory job directly
   * (memoryJobs.startStageManagerRun / startDreamRun); production callers use triggerStageManager.
   */
  readonly memoryJobs: MemoryJobs;
  private readonly executor: ResponderExecutor;
  private readonly runner: ChannelRunner;
  private readonly reviewer: ReviewerRunner;
  private readonly commands: RuntimeCommands;
  /** The one context engine for this runtime (spec 8.3); collaborators get it as `options.contexts`. */
  readonly contexts: ContextRuntime;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    const ocr = options.ocr;
    this.contexts =
      options.contexts ??
      createAppContextRuntime({
        storage: options.storage,
        discord: () => this.options.discord,
        logger: options.logger,
        ...(options.images ? { images: options.images } : {}),
        ...(options.imageConfig ? { imageConfig: options.imageConfig } : {}),
        ...(options.compaction ? { compactionSettings: options.compaction } : {}),
        ...(options.memory ? { memory: options.memory } : {}),
        ...(ocr?.cachedText
          ? {
              ocr: {
                cachedText: (ref) => ocr.cachedText!(ref),
                // Text-only waifus and directors get bounded OCR before an image freezes (spec 8.4).
                ...(ocr.textFor ? { textFor: (ref, o) => ocr.textFor!(ref, o) } : {})
              }
            }
          : {}),
        ...(options.contextCompaction ? { compaction: options.contextCompaction } : {}),
        // Late-bound: memoryJobs is constructed below. Fire-and-forget observer handoff (spec 8.9).
        observeThrough: (conversation, seq) => {
          void this.memoryJobs?.requestObserveThrough(conversation, seq).catch((error: unknown) => {
            options.logger.warn("Observer handoff after compaction failed", {
              message: error instanceof Error ? error.message : String(error)
            });
          });
        }
      });
    const services: RuntimeCollaboratorOptions = { ...options, contexts: this.contexts };
    const hooks: RuntimeHooks = {
      runBackground: (label, context, task) => this.runBackground(label, context, task),
      isStopping: () => this.stopping
    };
    const maxAutomaticTurns = options.maxAutomaticTurns ?? 8;
    this.usageLedger = options.usageLedger ?? sharedUsageLedger(options.storage.dataRoot);
    this.providerAlerts = options.providerAlerts ?? sharedProviderAlerts(options.storage.dataRoot);
    this.oneShot = new OneShotDecider(options.storage.dataRoot);
    const models = new ModelAccess(
      options,
      options.createPipeline ??
        ((target) => createGatewayModelPipeline({
          ...target,
          dataRoot: options.storage.dataRoot,
          usageLedger: this.usageLedger,
          providerAlerts: this.providerAlerts,
          logger: options.logger
        }))
    );
    this.executor = new ResponderExecutor(
      services,
      models,
      this.permissionWarnings,
      options.sleep ?? defaultSleep,
      maxAutomaticTurns
    );
    this.runner = new ChannelRunner(
      services,
      hooks,
      models,
      this.executor,
      this.oneShot,
      this.permissionWarnings,
      maxAutomaticTurns
    );
    this.reviewer = new ReviewerRunner(services, models, this.runner);
    this.memoryJobs = new MemoryJobs(
      services,
      models,
      {
        ...hooks,
        isGuildRunActive: (guildId) => this.runner.isGuildRunActive(guildId),
        isAnyRunActive: () => this.runner.activeRuns.size > 0
      },
      options.stageManagerIdleDelayMs
    );
    this.commands = new RuntimeCommands(services, {
      runtimeBusyReason: (guildId, channelId) => this.runtimeBusyReason(guildId, channelId),
      startChannelRunBackground: (guildId, channelId, reason, runOptions) =>
        this.runner.startChannelRunBackground(guildId, channelId, reason, runOptions),
      stopChannel: (guildId, channelId, reason) => this.stopChannel(guildId, channelId, reason),
      triggerStageManager: (guildId, channelId) => this.triggerStageManager(guildId, channelId),
      runReviewer: (input) => this.reviewer.runReviewer(input),
      lastSentWaifuPrompts: this.executor.lastSentWaifuPrompts,
      renderWaifuSystemPrompt: (input) => this.executor.renderWaifuSystemPrompt(input)
    });
  }

  async start(): Promise<void> {
    this.unsubscribes = [
      this.options.discord.onMessage?.((event) => {
        this.runBackground("Discord message handler failed", discordMessageLogContext(event), () =>
          this.handleDiscordMessage(event)
        );
      }),
      this.options.discord.onMessageEdit?.((event) => {
        this.runBackground("Discord message edit handler failed", discordEditLogContext(event), () =>
          this.handleDiscordMessageEdit(event)
        );
      }),
      this.options.discord.onMessageDelete?.((event) => {
        this.runBackground("Discord message delete handler failed", discordDeleteLogContext(event), () =>
          this.handleDiscordMessageDelete(event)
        );
      }),
      this.options.discord.onThreadChange?.((event) => {
        this.runBackground("Discord thread handler failed", { guildId: event.guildId, threadId: event.threadId, change: event.change }, () =>
          this.handleDiscordThreadChange(event)
        );
      }),
      this.options.discord.onReviewCommand?.((event) => {
        this.runBackground("Discord review command handler failed", slashCommandLogContext(event), () =>
          this.commands.handleReviewCommand(event)
        );
      }),
      this.options.discord.onClearCommand?.((event) => {
        this.runBackground("Discord clear command handler failed", slashCommandLogContext(event), () =>
          this.commands.handleClearCommand(event)
        );
      }),
      this.options.discord.onRunCommand?.((event) => {
        this.runBackground("Discord run command handler failed", slashCommandLogContext(event), () =>
          this.commands.handleRunCommand(event)
        );
      }),
      this.options.discord.onRunWaifuAutocomplete?.((event) =>
        this.commands.handleRunWaifuAutocomplete(event).catch((error) => {
          this.options.logger.warn("Discord run autocomplete handler failed", {
            guildId: event.guildId,
            channelId: event.channelId,
            focusedValue: event.focusedValue,
            message: error instanceof Error ? error.message : String(error)
          });
        })
      ),
      this.options.discord.onStopCommand?.((event) => {
        this.runBackground("Discord stop command handler failed", slashCommandLogContext(event), () =>
          this.commands.handleStopCommand(event)
        );
      }),
      this.options.discord.onMemoriesCommand?.((event) => {
        this.runBackground("Discord memories command handler failed", slashCommandLogContext(event), () =>
          this.commands.handleMemoriesCommand(event)
        );
      }),
      this.options.discord.onPrintWaifuAutocomplete?.((event) =>
        this.commands.handlePrintWaifuAutocomplete(event).catch((error) => {
          this.options.logger.warn("Discord print autocomplete handler failed", {
            guildId: event.guildId,
            channelId: event.channelId,
            focusedValue: event.focusedValue,
            message: error instanceof Error ? error.message : String(error)
          });
        })
      ),
      this.options.discord.onPrintCommand?.((event) => {
        this.runBackground("Discord print command handler failed", {
          ...slashCommandLogContext(event),
          type: event.type,
          waifuId: event.waifuId
        }, () => this.commands.handlePrintCommand(event));
      }),
      this.options.discord.onDebugCommand?.((event) => {
        this.runBackground("Discord debug command handler failed", {
          ...slashCommandLogContext(event),
          type: event.type,
          sourceChannelId: event.sourceChannelId
        }, () => this.commands.handleDebugCommand(event));
      })
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    if (this.options.discord.listGuilds) {
      await syncGuilds(this.options);
    }
    await healPendingOrchestratorDecisions(this.options.storage);
    await this.memoryJobs.scheduleDreamRuns();
    if (this.options.isPaused?.()) {
      // A paused runtime stays silent across restarts/reloads: no catch-up wakes, no resumed
      // replies. resumeAfterPause() runs the same catch-up once the user resumes.
      this.wasPaused = true;
      this.options.logger.info("Restart resume skipped because runtime is paused");
    } else {
      this.runBackground("Restart resume failed", {}, () => this.runner.resumeOrchestrationState());
    }
  }

  /** Re-run boot catch-up (persisted timers, downtime messages) after an explicit user resume. */
  resumeAfterPause(): void {
    if (!this.wasPaused || this.options.isPaused?.()) return;
    this.wasPaused = false;
    this.runBackground("Resume after pause failed", {}, () => this.runner.resumeOrchestrationState());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    // A planned stop (shutdown, `waifus restart`, update, config reload) interrupts replies with a
    // resumable reason, unlike an explicit user pause.
    await this.haltRuntime(RUNTIME_SHUTDOWN_INTERRUPT_REASON);
    this.oneShot.close();
    await this.options.ocr?.dispose?.();
    // Calls aborted by the halt above queue their `aborted` ledger lines fire-and-forget; wait for
    // them so a following process exit cannot lose them.
    await this.usageLedger.flush();
  }

  /** Explicit user pause: interrupted replies are never resumed later (see restartResume.ts). */
  async pause(): Promise<void> {
    this.wasPaused = true;
    await this.haltRuntime("runtime paused");
  }

  private async haltRuntime(reason: string): Promise<void> {
    for (const timer of this.runner.retriggerTimers.values()) {
      clearTimeout(timer);
    }
    this.runner.retriggerTimers.clear();
    this.memoryJobs.clearAllStageManagerTimers();
    this.memoryJobs.clearAllDreamTimers();
    const haltedRuns = [...this.runner.activeRuns.values()];
    const preempted = [...this.runner.preemptedChannels].flatMap(([guildId, channelIds]) =>
      [...channelIds.keys()].map((channelId) => ({ guildId, channelId }))
    );
    this.runner.preemptedChannels.clear();
    for (const run of haltedRuns) {
      run.controller.abort(new Error(reason));
    }
    await Promise.allSettled(haltedRuns.map((run) => run.promise));
    this.runner.activeRuns.clear();
    if (reason === RUNTIME_SHUTDOWN_INTERRUPT_REASON) {
      // Runs cut down mid-pass (and channels waiting on a preempted turn) owe the room a pass:
      // leave an immediate persisted wake so boot catch-up runs it (unless a wake is already set).
      for (const run of [...haltedRuns, ...preempted]) {
        await persistShutdownWake(this.options.storage, run.guildId, run.channelId).catch((error) => {
          this.options.logger.warn("Failed to persist shutdown wake", {
            guildId: run.guildId,
            channelId: run.channelId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
    await Promise.allSettled([...this.memoryJobs.activeStageManagerRuns]);
    await Promise.allSettled([...this.memoryJobs.activeDreamRuns]);
    this.options.onActiveRunsChange?.(0);
  }

  private runBackground(
    label: string,
    context: Record<string, unknown>,
    task: () => void | Promise<unknown>
  ): void {
    if (this.stopping) return;
    const release = this.options.updateActivity?.begin();
    if (this.options.updateActivity && !release) return;
    void Promise.resolve()
      .then(() => this.stopping ? undefined : task())
      .catch((error) => {
        this.options.logger.error(label, {
          ...context,
          message: error instanceof Error ? error.message : String(error)
        });
      }).finally(() => release?.());
  }

  async handleDiscordMessage(event: DiscordMessageEvent): Promise<void> {
    if (!event.guildId || !event.channelId) return;
    if (this.executor.wasSelfSent(event.messageId)) {
      return;
    }
    if (event.authorBot && this.executor.activeWaifuSendChannels.has(event.channelId)) {
      return;
    }
    if (!event.authorBot) {
      void noteActiveChatParticipant(this.options.storage, event.guildId, event.channelId, {
        userId: event.authorId,
        displayName: event.authorDisplayName ?? event.authorId
      }).catch((error) => {
        this.options.logger.warn("Failed to update active chat participants", {
          guildId: event.guildId,
          channelId: event.channelId,
          userId: event.authorId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    if (this.options.isPaused?.()) {
      this.options.logger.info("Discord message ignored because runtime is paused", {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId
      });
      await ensureChannelSession(this.options.storage, event.guildId, event.channelId);
      return;
    }
    const server = await ensureServer(this.options.storage, event.guildId);
    if (server.paused) {
      this.options.logger.info("Discord message ignored because server is paused", {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId
      });
      await ensureChannelSession(this.options.storage, event.guildId, event.channelId);
      return;
    }
    // Spec 9.5: a thread is never auto-created as a channel entry; it is tracked in threads.json and
    // inherits its parent's cast (unless the parent switched threads off or has no cast).
    const serverWithChannel = event.thread
      ? await this.admitThreadMessage(server, event)
      : await ensureChannelConfig(this.options, server, event.channelId);
    const channel = serverWithChannel.channels[event.channelId];
    if (!channelHasWaifus(channel)) {
      this.options.logger.info("Discord message observed in inactive channel; enable at least one waifu in Servers", {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId
      });
      await ensureChannelSession(this.options.storage, event.guildId, event.channelId);
      return;
    }
    if (event.authorBot && !(await isKnownWaifuAuthor(this.options.storage, event.authorId))) {
      this.options.logger.info("Discord bot message ignored because author is not a configured waifu", {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorId: event.authorId
      });
      return;
    }
    this.options.logger.info("Discord message accepted for orchestration", {
      guildId: event.guildId,
      channelId: event.channelId,
      messageId: event.messageId,
      authorBot: event.authorBot
    });
    this.memoryJobs.noteStageManagerActivity(event.guildId, event.channelId);
    await this.runner.startChannelRun(event.guildId, event.channelId, `message:${event.messageId}`, {
      trigger: "message"
    });
  }

  /** Track the thread a message arrived in (when it can take part) and return the refreshed server. */
  private async admitThreadMessage(server: ServerConfig, event: DiscordMessageEvent): Promise<ServerConfig> {
    const thread = event.thread!;
    const explicit = server.channels[event.channelId];
    const hasOwnCast = (explicit?.enabledWaifuIds?.length ?? 0) > 0 && !explicit?.thread;
    if (!hasOwnCast && !parentSharesCast(server.channels[thread.parentId])) return server;
    // A message in a thread means it is open: Discord unarchives on send, so a stale cached
    // `archived: true` must not silence it.
    await observeThread(this.options.storage, event.guildId, {
      threadId: event.channelId,
      parentId: thread.parentId,
      name: thread.name,
      kind: thread.kind,
      archived: false,
      locked: thread.locked,
      activity: true
    });
    return ensureServer(this.options.storage, event.guildId);
  }

  /** Raw discord.js edit event: translated to the shared adapter shape. */
  async handleDiscordMessageEdit(event: DiscordMessageEditEvent): Promise<void> {
    await this.applyMessageEvent(
      {
        type: "update",
        conversation: { kind: "guild", guildId: event.guildId, channelId: event.channelId },
        message: event.message,
        source: "gateway"
      },
      {
        ...(event.thread ? { thread: event.thread } : {}),
        ...(event.previousMentionIds ? { previousMentionIds: event.previousMentionIds } : {})
      }
    );
  }

  /** Raw discord.js delete / bulk delete event: translated to the shared adapter shape. */
  async handleDiscordMessageDelete(event: DiscordMessageDeleteEvent): Promise<void> {
    const conversation = { kind: "guild" as const, guildId: event.guildId, channelId: event.channelId };
    await this.applyMessageEvent({ type: "deleteBulk", conversation, messageIds: event.messageIds });
  }

  /**
   * The single entry point for message edits and deletes (spec 9.5), whatever the source.
   *
   * - `update`: recorded in the conversation ledger (in place while unsealed, else an `edit`
   *   event). Never starts a run, except a live edit that adds a waifu mention to the newest human
   *   message within 2 minutes: that is treated as a new message.
   * - `delete` / `deleteBulk`: hybrid rule O1 (recent or unsealed messages are redacted, older ones
   *   only marked). Never starts a run; deleting the message that triggered a run that has not sent
   *   anything yet aborts it (`trigger_deleted`).
   *
   * Only guild conversations are handled here; DM conversations belong to the DM runner (wave 2).
   * `extra.thread` carries the thread facts a re-trigger needs when the source knows them;
   * `extra.previousMentionIds` stands in for `event.previous` when only the old mentions are known.
   */
  async applyMessageEvent(
    event: MessageChangeEvent,
    extra: { thread?: DiscordThreadInfo; previousMentionIds?: string[] } = {}
  ): Promise<void> {
    const conversation = event.conversation;
    if (conversation.kind !== "guild") return;
    const { guildId, channelId } = conversation;
    if (event.type === "update") {
      const message = event.message;
      if (!message.editedAt) return;
      const retrigger = event.source !== "catchup" && (await this.editAddsWaifuMention(conversation, event, extra.previousMentionIds));
      const server = await ensureServer(this.options.storage, guildId);
      const directory = await loadGuildDirectoryView(this.options.storage, guildId, {
        channelName: (id) => server.channels[id]?.name
      });
      await this.contexts.recordMessageEdit(conversation, message, { directory });
      if (!retrigger) return;
      this.options.logger.info("Edit added a waifu mention to the newest human message; treating it as a new message", {
        guildId,
        channelId,
        messageId: message.id
      });
      await this.handleDiscordMessage({
        guildId,
        channelId,
        messageId: message.id,
        authorId: message.authorId,
        authorBot: message.authorIsBot,
        ...(extra.thread ? { thread: extra.thread } : {})
      });
      return;
    }
    const messageIds = event.type === "delete" ? [event.messageId] : event.messageIds;
    this.runner.abortRunIfTriggerDeleted(guildId, channelId, messageIds, (id, since) => this.executor.hasSentSince(id, since));
    await this.contexts.recordMessageDeletes(conversation, messageIds, {
      ...(this.options.deletedMessages ? { redactRecent: this.options.deletedMessages.redactRecent } : {})
    });
  }

  private async editAddsWaifuMention(
    conversation: { kind: "guild"; guildId: string; channelId: string },
    event: Extract<MessageChangeEvent, { type: "update" }>,
    fallbackPreviousIds?: string[]
  ): Promise<boolean> {
    const message = event.message;
    if (message.authorIsBot) return false;
    const editedAt = Date.parse(message.editedAt ?? "");
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isFinite(editedAt) || !Number.isFinite(createdAt) || editedAt - createdAt > EDIT_MENTION_RETRIGGER_MS) return false;
    if (Date.now() - createdAt > EDIT_MENTION_RETRIGGER_MS) return false;
    const mentioned = Object.keys(message.mentions.users);
    if (mentioned.length === 0) return false;
    const ledger = await this.contexts.peekLedger(conversation);
    let newestHuman: (typeof ledger.entries)[string] | undefined;
    for (const entry of Object.values(ledger.entries)) {
      if (isGapEntry(entry) || entry.authorIsBot || entry.kind !== "default" || entry.state === "deleted") continue;
      if (!newestHuman || entry.seq > newestHuman.seq) newestHuman = entry;
    }
    if (!newestHuman || newestHuman.id !== message.id) return false;
    // "Adds": not mentioned before the edit. The cached old message says so; otherwise the
    // frozen ledger body (`<@Name>`) does.
    const previousIds = event.previous ? Object.keys(event.previous.mentions.users) : fallbackPreviousIds;
    const added = mentioned.filter((id) =>
      previousIds ? !previousIds.includes(id) : !newestHuman!.body.includes(`<@${message.mentions.users[id]}>`)
    );
    for (const id of added) {
      if (await isKnownWaifuAuthor(this.options.storage, id)) return true;
    }
    return false;
  }

  /** Thread lifecycle (spec 9.5): track it, and stop its timers when it is archived, locked or deleted. */
  async handleDiscordThreadChange(event: DiscordThreadEvent): Promise<void> {
    const { guildId, threadId, thread } = event;
    if (event.change === "delete") {
      await removeThread(this.options.storage, guildId, threadId);
      await this.stopChannel(guildId, threadId, "thread_deleted");
      // The thread is gone: so is its conversation (ledger, refs, every agent context).
      await this.contexts
        .deleteConversation({ kind: "guild", guildId, channelId: threadId })
        .catch((error: unknown) => {
          this.options.logger.warn("Failed to delete a deleted thread's conversation", {
            guildId,
            threadId,
            message: error instanceof Error ? error.message : String(error)
          });
        });
      return;
    }
    const server = await ensureServer(this.options.storage, guildId);
    const explicit = server.channels[threadId];
    const hasOwnCast = (explicit?.enabledWaifuIds?.length ?? 0) > 0 && !explicit?.thread;
    const known = (await readThreads(this.options.storage, guildId)).threads[threadId];
    // Only threads that can take part are tracked (a cast of their own or one to inherit); one we
    // already track keeps following its archive / lock state even if the parent lost its cast.
    if (!hasOwnCast && !known && !parentSharesCast(server.channels[thread.parentId])) return;
    await observeThread(this.options.storage, guildId, {
      threadId,
      parentId: thread.parentId,
      name: thread.name,
      kind: thread.kind,
      archived: thread.archived,
      locked: thread.locked
    });
    if (thread.archived || thread.locked) {
      // Archive / lock clears the thread's timers and any run in it.
      await this.stopChannel(guildId, threadId, thread.archived ? "thread_archived" : "thread_locked");
      return;
    }
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

  async triggerChannel(
    guildId: string,
    channelId: string,
    reason = "manual",
    options: ChannelRunOptions = {}
  ): Promise<void> {
    if (this.options.isPaused?.()) {
      this.options.logger.warn("Manual runtime trigger ignored because runtime is paused", { guildId, channelId });
      return;
    }
    await this.runner.startChannelRun(guildId, channelId, reason, options);
  }

  async stopChannel(guildId: string, channelId: string, reason = "manual-stop"): Promise<{
    stoppedRun: boolean;
    clearedRetrigger: boolean;
    activeInAnotherChannel: boolean;
  }> {
    const key = runKey(guildId);
    const versionKey = timerKey(guildId, channelId);
    this.runner.channelRunVersions.set(versionKey, (this.runner.channelRunVersions.get(versionKey) ?? 0) + 1);

    const clearedRetrigger = this.runner.clearRetriggerTimer(guildId, channelId);
    if (clearedRetrigger) {
      await clearScheduledRetrigger(this.options.storage, guildId, channelId);
    }
    this.runner.dropPreemptedChannel(guildId, channelId);
    this.memoryJobs.clearStageManagerTimers(guildId, channelId);

    const activeRun = this.runner.activeRuns.get(key);
    const stoppedRun = Boolean(activeRun && activeRun.channelId === channelId);
    const activeInAnotherChannel = Boolean(activeRun && activeRun.channelId !== channelId);
    if (activeRun && stoppedRun) {
      this.options.logger.info("Stopping active channel run", { guildId, channelId, reason });
      activeRun.controller.abort(new Error(reason));
      this.runner.markSessionIdleBackground(guildId, channelId, reason);
    }

    return { stoppedRun, clearedRetrigger, activeInAnotherChannel };
  }

  async triggerStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    return this.memoryJobs.triggerStageManager(guildId, channelId);
  }

  async triggerReviewer(guildId: string, channelId: string, userId?: string): Promise<{
    hallucination: boolean;
    deleted: boolean;
    messageIds: string[];
  }> {
    return this.reviewer.runReviewer({ guildId, channelId, userId });
  }

  private runtimeBusyReason(guildId: string, channelId: string): string | undefined {
    const key = runKey(guildId);
    const activeRun = this.runner.activeRuns.get(key);
    if (activeRun) {
      return activeRun.channelId === channelId
        ? "Orchestrator is already running in this channel."
        : "Orchestrator is already running in another channel for this server.";
    }
    if ((this.executor.activeWaifuQueries.get(key) ?? 0) > 0) {
      return "A waifu response query is already in flight.";
    }
    if ((this.reviewer.activeReviewerRuns.get(key) ?? 0) > 0) {
      return "Reviewer is already running.";
    }
    return undefined;
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

function discordEditLogContext(event: DiscordMessageEditEvent): Record<string, unknown> {
  return { guildId: event.guildId, channelId: event.channelId, messageId: event.messageId };
}

function discordDeleteLogContext(event: DiscordMessageDeleteEvent): Record<string, unknown> {
  return { guildId: event.guildId, channelId: event.channelId, count: event.messageIds.length };
}

function slashCommandLogContext(event: {
  guildId: string;
  channelId: string;
  userId: string;
  commandMessageId?: string;
}): Record<string, unknown> {
  return {
    guildId: event.guildId,
    channelId: event.channelId,
    userId: event.userId,
    commandMessageId: event.commandMessageId
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
