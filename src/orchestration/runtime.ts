import { randomUUID } from "node:crypto";
import {
  DiscordAutocompleteChoice,
  DiscordClearCommandEvent,
  DiscordClearType,
  DiscordDebugCommandEvent,
  DiscordMemoriesCommandEvent,
  DiscordMessageEvent,
  DiscordPrintCommandEvent,
  DiscordPrintWaifuAutocompleteEvent,
  DiscordReviewCommandEvent,
  DiscordRunCommandEvent,
  DiscordRunWaifuAutocompleteEvent,
  DiscordStopCommandEvent
} from "../discord/client.js";
import { createGatewayModelPipeline } from "./pipeline/gatewayPipeline.js";
import { PermissionWarningTracker, isPermissionError } from "./permissionWarnings.js";
import { decideDeterministically, enforceWakePlan } from "./deterministicOrchestrator.js";
import { RUNTIME_SHUTDOWN_INTERRUPT_REASON, planRestartResume } from "./restartResume.js";
import { GatewayPipelineError } from "./pipeline/params.js";
import {
  OrchestratorDecisionHistoryEntry,
  OrchestratorDecisionStatus,
  OrchestratorHistoryFileSchema,
  OrchestratorResponderOutcome,
  ServerConfig,
  WaifuConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { relativeAge } from "./memoryRetrieval.js";
import { nowIso } from "../shared/schemas/common.js";
import { ChannelSessionStateSchema, type RetriggerWake, createEmptyChannelSessionState } from "./session.js";
import { type ContextMessage, type OrchestratorWakeMarker, formatTimestamp } from "./context.js";
import {
  DIRECTIVE_GOAL_MAX_CHARS,
  type DirectiveIntent,
  MAX_WAIFU_DELAY_SECONDS,
  type OrchestratorDecision,
  RETRIGGER_DEFAULT_SECONDS,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS
} from "./decisions.js";
import { assessCastCadence, assessLoop } from "./loopDetector.js";
import { OneShotDecider } from "./oneShot/decider.js";
import { formatPrintDebugBlock, formatWaifuPromptDebugMessages } from "./debugFormat.js";
import { sendOrchestratorDebugLog } from "./debugLog.js";
import { MemoryJobs } from "./memoryJobs.js";
import { ModelAccess } from "./modelAccess.js";
import {
  DEFAULT_REVIEWER_PROMPT,
  buildDeterministicCast,
  buildOrchestratorSystemPrompt,
  buildOrchestratorTrailingPrompt,
  buildWaifuPromptParts
} from "./promptBuilders.js";
import { ResponderExecutor } from "./responderExecutor.js";
import {
  type ChannelRunOptions,
  type DreamPassResult,
  type RetriggerWakeInput,
  type RuntimeOrchestratorOptions,
  type StageManagerRunResult,
  decrementActive,
  incrementActive,
  isHumanUserMessage,
  runKey,
  summarizeProviderPipelineDetails,
  throwIfAborted,
  timerKey
} from "./runtimeShared.js";
import {
  channelHasWaifus,
  ensureChannelConfig,
  ensureServer,
  isKnownWaifuAuthor,
  listAvailableWaifusForChannel,
  listAvailableWaifusForGuild,
  listKnownGuildIds,
  listWaifus,
  readAgentConfig,
  syncGuilds
} from "./stores/config.js";
import { setDebugRoute, unsetDebugRoute } from "./stores/debugRoutes.js";
import {
  appendOrchestratorHistory,
  appendReviewerHistory,
  healPendingOrchestratorDecisions,
  readCompletedOrchestratorDecisionsForChannel,
  updateOrchestratorResponderOutcome
} from "./stores/decisionHistory.js";
import { readMemoryStore } from "./stores/memories.js";
import { noteActiveChatParticipant, noteActiveChatParticipantsFromContext } from "./stores/participants.js";
import {
  clearScheduledRetrigger,
  consumeScheduledRetrigger,
  ensureChannelSession,
  markSessionIdle,
  persistShutdownWake,
  sessionRelativePath,
  setActivePipeline,
  updateSession
} from "./stores/sessions.js";

export type { DreamPassResult, RuntimeOrchestratorOptions, StageManagerRunResult } from "./runtimeShared.js";
export { currentlyDoingForWaifu } from "./promptBuilders.js";

type ActiveChannelRun = {
  guildId: string;
  channelId: string;
  controller: AbortController;
  promise: Promise<void>;
  trigger?: ChannelRunOptions["trigger"];
  wake?: RetriggerWakeInput;
};

export class RuntimeOrchestrator {
  private readonly activeRuns = new Map<string, ActiveChannelRun>();
  readonly permissionWarnings = new PermissionWarningTracker();
  private readonly retriggerTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxAutomaticTurns: number;
  private readonly models: ModelAccess;
  private readonly activeReviewerRuns = new Map<string, number>();
  private readonly channelRunVersions = new Map<string, number>();
  // Consecutive crashed runs per guildId:channelId, for the crash-recovery wake backoff.
  private readonly recoveryAttempts = new Map<string, number>();
  // Per guild: channels whose run was aborted by another channel's run (insertion-ordered,
  // deduped). Each gets a short retrigger when the guild's run slot frees up.
  // The value is the wake identity to re-arm with: the deferred/aborted timer wake's own identity,
  // or { source: "preempted" } for an aborted human-message/manual run.
  private readonly preemptedChannels = new Map<string, Map<string, RetriggerWakeInput>>();
  // Set by pause() and by a paused start(); resumeAfterPause() is a no-op unless it is set, so a
  // redundant Resume can never replan (and duplicate) live runs.
  private wasPaused = false;
  // Per-channel directive budget counter. Increments each decision a directive is not honored,
  // resets to 0 when one is honored; the budget opens once it reaches directiveCooldown.
  private readonly directiveDecisionCounts = new Map<string, number>();
  private unsubscribes: Array<() => void> = [];
  private stopping = false;
  private readonly oneShot: OneShotDecider;
  private readonly memoryJobs: MemoryJobs;
  private readonly executor: ResponderExecutor;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.oneShot = new OneShotDecider(options.storage.dataRoot);
    this.maxAutomaticTurns = options.maxAutomaticTurns ?? 8;
    this.models = new ModelAccess(
      options,
      options.createPipeline ??
        ((target) => createGatewayModelPipeline({ ...target, dataRoot: options.storage.dataRoot }))
    );
    this.executor = new ResponderExecutor(
      options,
      this.models,
      this.permissionWarnings,
      options.sleep ?? defaultSleep,
      this.maxAutomaticTurns
    );
    this.memoryJobs = new MemoryJobs(
      options,
      this.models,
      {
        runBackground: (label, context, task) => this.runBackground(label, context, task),
        isStopping: () => this.stopping,
        isGuildRunActive: (guildId) =>
          this.activeRuns.has(runKey(guildId)) || [...this.activeRuns.values()].some((run) => run.guildId === guildId)
      },
      options.stageManagerIdleDelayMs
    );
  }

  async start(): Promise<void> {
    this.unsubscribes = [
      this.options.discord.onMessage?.((event) => {
        this.runBackground("Discord message handler failed", discordMessageLogContext(event), () =>
          this.handleDiscordMessage(event)
        );
      }),
      this.options.discord.onReviewCommand?.((event) => {
        this.runBackground("Discord review command handler failed", slashCommandLogContext(event), () =>
          this.handleReviewCommand(event)
        );
      }),
      this.options.discord.onClearCommand?.((event) => {
        this.runBackground("Discord clear command handler failed", slashCommandLogContext(event), () =>
          this.handleClearCommand(event)
        );
      }),
      this.options.discord.onRunCommand?.((event) => {
        this.runBackground("Discord run command handler failed", slashCommandLogContext(event), () =>
          this.handleRunCommand(event)
        );
      }),
      this.options.discord.onRunWaifuAutocomplete?.((event) =>
        this.handleRunWaifuAutocomplete(event).catch((error) => {
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
          this.handleStopCommand(event)
        );
      }),
      this.options.discord.onMemoriesCommand?.((event) => {
        this.runBackground("Discord memories command handler failed", slashCommandLogContext(event), () =>
          this.handleMemoriesCommand(event)
        );
      }),
      this.options.discord.onPrintWaifuAutocomplete?.((event) =>
        this.handlePrintWaifuAutocomplete(event).catch((error) => {
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
        }, () => this.handlePrintCommand(event));
      }),
      this.options.discord.onDebugCommand?.((event) => {
        this.runBackground("Discord debug command handler failed", {
          ...slashCommandLogContext(event),
          type: event.type,
          sourceChannelId: event.sourceChannelId
        }, () => this.handleDebugCommand(event));
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
      this.runBackground("Restart resume failed", {}, () => this.resumeOrchestrationState());
    }
  }

  /** Re-run boot catch-up (persisted timers, downtime messages) after an explicit user resume. */
  resumeAfterPause(): void {
    if (!this.wasPaused || this.options.isPaused?.()) return;
    this.wasPaused = false;
    this.runBackground("Resume after pause failed", {}, () => this.resumeOrchestrationState());
  }

  /**
   * Pretend the server was never restarted: re-arm persisted retriggers with their REMAINING
   * time, and re-execute decision responders whose lines the restart ate (directives intact,
   * via the initialResponders path so all normal run bookkeeping applies).
   */
  private async resumeOrchestrationState(): Promise<void> {
    // give the Discord bots a beat to finish connecting; failed sends self-heal regardless
    await new Promise((resolve) => setTimeout(resolve, this.options.restartResumeDelayMs ?? 5000));
    if (this.stopping || this.options.isPaused?.()) return;
    const guildIds = await listKnownGuildIds(this.options.storage);
    const history = await this.options.storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }))
    );
    for (const guildId of guildIds) {
      let server: ServerConfig;
      try {
        server = await ensureServer(this.options.storage, guildId);
      } catch {
        continue;
      }
      if (!server.enabled) continue;
      // Resumed replies in one guild run one after another (never preempting each other).
      const resumes: Array<() => Promise<void>> = [];
      for (const channel of Object.values(server.channels)) {
        if (!channelHasWaifus(channel)) continue;
        const channelId = channel.channelId;
        // After a live resume (not boot) the room may already be moving again: never replan a
        // channel whose run is live or whose latest decision is still in flight.
        if (this.activeRuns.get(runKey(guildId))?.channelId === channelId) continue;
        const session = await this.options.storage.readJson(
          sessionRelativePath(guildId, channelId),
          ChannelSessionStateSchema,
          createEmptyChannelSessionState(guildId, channelId)
        );
        // history is newest-first; find() returns the latest decision for this channel
        const latestDecision = history.decisions.find(
          (decision) => decision.guildId === guildId && decision.channelId === channelId
        );
        if (latestDecision?.status === "pending") continue;
        // Best-effort: a human message that landed while the server was down must wake the
        // channel promptly instead of resuming the old schedule (live 2026-07-06 10:08: K's
        // message hit the deploy window and waited out a restored 130s timer).
        let newestHumanMessageAt: string | undefined;
        try {
          const recent = await this.options.discord.fetchFreshContext({ guildId, channelId, limit: 10 });
          newestHumanMessageAt = recent.reduce<string | undefined>(
            (acc, message) =>
              message.authorKind === "user" && message.authorBot !== true && (!acc || message.timestamp > acc)
                ? message.timestamp
                : acc,
            undefined
          );
        } catch {
          // Discord not ready or channel unreadable — fall back to schedule-only planning.
        }
        const plan = planRestartResume({ guildId, channelId, session, latestDecision, newestHumanMessageAt }, new Date());
        if (plan.kind === "restore-timer") {
          if (this.retriggerTimers.has(timerKey(guildId, channelId))) continue;
          this.options.logger.info("Restart resume: retrigger restored", {
            guildId,
            channelId,
            seconds: plan.seconds,
            reason: plan.reason
          });
          await this.scheduleRetrigger(guildId, channelId, plan.seconds, plan.wake);
        } else if (plan.kind === "resume-responders") {
          this.options.logger.info("Restart resume: executing responders the restart interrupted", {
            guildId,
            channelId,
            decisionId: plan.decisionId,
            responders: plan.responders.map((responder) => responder.waifuId)
          });
          resumes.push(() =>
            this.startChannelRun(guildId, channelId, "restart-resume", {
              initialResponders: plan.responders,
              initialReason: `Resuming a decision interrupted by a server restart: ${plan.reasoning}`,
              trigger: "resume"
            })
          );
        }
      }
      if (resumes.length > 0) {
        this.runBackground("Restart resume run failed", { guildId }, async () => {
          for (const resume of resumes) await resume();
        });
      }
    }
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
  }

  /** Explicit user pause: interrupted replies are never resumed later (see restartResume.ts). */
  async pause(): Promise<void> {
    this.wasPaused = true;
    await this.haltRuntime("runtime paused");
  }

  private async haltRuntime(reason: string): Promise<void> {
    for (const timer of this.retriggerTimers.values()) {
      clearTimeout(timer);
    }
    this.retriggerTimers.clear();
    this.memoryJobs.clearAllStageManagerTimers();
    this.memoryJobs.clearAllDreamTimers();
    const haltedRuns = [...this.activeRuns.values()];
    const preempted = [...this.preemptedChannels].flatMap(([guildId, channelIds]) =>
      [...channelIds.keys()].map((channelId) => ({ guildId, channelId }))
    );
    this.preemptedChannels.clear();
    for (const run of haltedRuns) {
      run.controller.abort(new Error(reason));
    }
    await Promise.allSettled(haltedRuns.map((run) => run.promise));
    this.activeRuns.clear();
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

  private startChannelRunBackground(
    guildId: string,
    channelId: string,
    reason: string,
    options: ChannelRunOptions = {}
  ): void {
    this.runBackground("Background channel run failed", { guildId, channelId, reason }, () =>
      this.startChannelRun(guildId, channelId, reason, options)
    );
  }

  private markSessionIdleBackground(guildId: string, channelId: string, reason: string): void {
    this.runBackground("Failed to mark session idle", { guildId, channelId, reason }, () =>
      markSessionIdle(this.options.storage, guildId, channelId)
    );
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
    // Arm a dream timer for guilds that joined after startup (cheap check — no-op for existing guilds).
    if (!this.memoryJobs.dreamTimers.has(event.guildId) && !this.options.isPaused?.()) {
      this.memoryJobs.armDreamTimer(event.guildId);
    }
    const serverWithChannel = await ensureChannelConfig(this.options, server, event.channelId);
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
    await this.startChannelRun(event.guildId, event.channelId, `message:${event.messageId}`, {
      trigger: "message"
    });
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
    await this.startChannelRun(guildId, channelId, reason, options);
  }

  async stopChannel(guildId: string, channelId: string, reason = "manual-stop"): Promise<{
    stoppedRun: boolean;
    clearedRetrigger: boolean;
    activeInAnotherChannel: boolean;
  }> {
    const key = runKey(guildId);
    const versionKey = timerKey(guildId, channelId);
    this.channelRunVersions.set(versionKey, (this.channelRunVersions.get(versionKey) ?? 0) + 1);

    const clearedRetrigger = this.clearRetriggerTimer(guildId, channelId);
    if (clearedRetrigger) {
      await clearScheduledRetrigger(this.options.storage, guildId, channelId);
    }
    this.dropPreemptedChannel(guildId, channelId);
    this.memoryJobs.clearStageManagerTimers(guildId, channelId);

    const activeRun = this.activeRuns.get(key);
    const stoppedRun = Boolean(activeRun && activeRun.channelId === channelId);
    const activeInAnotherChannel = Boolean(activeRun && activeRun.channelId !== channelId);
    if (activeRun && stoppedRun) {
      this.options.logger.info("Stopping active channel run", { guildId, channelId, reason });
      activeRun.controller.abort(new Error(reason));
      this.markSessionIdleBackground(guildId, channelId, reason);
    }

    return { stoppedRun, clearedRetrigger, activeInAnotherChannel };
  }

  async triggerStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    return this.memoryJobs.triggerStageManager(guildId, channelId);
  }

  // Test/ops hook: run only the dream consolidation pass for a guild (no observer).
  // Goes through startDreamRun so the per-guild reentrancy guard is exercised.
  async runDreamPassForTest(guildId: string): Promise<DreamPassResult> {
    return this.memoryJobs.startDreamRun(guildId);
  }

  // Test hook: run only the observer (queue + fast-track), without the dream pass.
  async runObserverForTest(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    return this.memoryJobs.startStageManagerRun(guildId, channelId);
  }

  async triggerReviewer(guildId: string, channelId: string, userId?: string): Promise<{
    hallucination: boolean;
    deleted: boolean;
    messageIds: string[];
  }> {
    return this.runReviewer({ guildId, channelId, userId });
  }

  private async handleReviewCommand(event: DiscordReviewCommandEvent): Promise<void> {
    try {
      const result = await this.runReviewer({
        guildId: event.guildId,
        channelId: event.channelId,
        userId: event.userId,
        commandMessageId: event.commandMessageId
      });
      if (result.messageIds.length === 0) {
        await event.respond("No waifu message found to review.");
      } else if (result.hallucination && result.deleted) {
        await event.respond(`Removed ${result.messageIds.length} hallucinated waifu message chunk${result.messageIds.length === 1 ? "" : "s"}.`);
      } else if (result.hallucination) {
        await event.respond("Reviewer flagged the message, but deletion failed. Check bot message permissions.");
      } else {
        await event.respond("Reviewer found no hallucination in the latest waifu message.");
      }
    } catch (error) {
      this.options.logger.error("Reviewer command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Reviewer failed.");
    }
  }

  private async handleClearCommand(event: DiscordClearCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Clear type is required. Choose waifus, users, both, or everything.");
        return;
      }
      if (event.type === "everything") {
        const result = await this.clearAllChannelMessages(event.guildId, event.channelId);
        if (result.deletedCount === 0 && result.failedCount === 0) {
          await event.respond("No messages found to clear.");
        } else if (result.failedCount > 0) {
          const deletedLabel = clearMessageLabel("everything", result.deletedCount);
          const failedLabel = clearMessageLabel("everything", result.failedCount);
          await event.respond(
            `Cleared ${result.deletedCount} ${deletedLabel}. Failed to delete ${result.failedCount} ${failedLabel}. Check bot message permissions.`
          );
        } else {
          await event.respond(`Cleared ${result.deletedCount} ${clearMessageLabel("everything", result.deletedCount)}.`);
        }
        return;
      }
      if (event.count === undefined) {
        await event.respond("Count is required for this clear type.");
        return;
      }
      const result = await this.clearLatestMessages(event.guildId, event.channelId, event.count, event.type);
      if (result.messageIds.length === 0) {
        await event.respond(noClearTargetsMessage(event.type));
      } else if (result.deleted) {
        const messageLabel = clearMessageLabel(event.type, result.logicalMessageCount);
        const chunkSuffix = result.messageIds.length === result.logicalMessageCount
          ? ""
          : ` (${result.messageIds.length} Discord chunks)`;
        await event.respond(`Cleared ${result.logicalMessageCount} ${messageLabel}${chunkSuffix}.`);
      } else {
        await event.respond("Clear failed. Check bot message permissions.");
      }
    } catch (error) {
      this.options.logger.error("Clear command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Clear failed.");
    }
  }

  private async handleRunCommand(event: DiscordRunCommandEvent): Promise<void> {
    try {
      const busyReason = this.runtimeBusyReason(event.guildId, event.channelId);
      if (busyReason) {
        await event.respond(busyReason);
        return;
      }
      if (this.options.isPaused?.()) {
        await event.respond("Runtime is paused; /run did not start.");
        return;
      }
      if (event.waifuId) {
        const resolved = await this.resolveRunWaifu(event.guildId, event.channelId, event.waifuId);
        if (typeof resolved === "string") {
          await event.respond(resolved);
          return;
        }
        await event.respond(`Started directed run for ${resolved.displayName}.`);
        this.startChannelRunBackground(event.guildId, event.channelId, `slash-run:${event.userId}:${resolved.id}`, {
          initialResponders: [
            {
              waifuId: resolved.id,
              delaySeconds: 0,
              directive: event.sceneDirection
                ? { intent: "manual" as const, goal: event.sceneDirection }
                : undefined
            }
          ],
          initialReason: `Manual /run selected ${resolved.id}.`
        });
        return;
      }
      await event.respond(event.sceneDirection ? "Started orchestrator run with scene direction." : "Started orchestrator run.");
      this.startChannelRunBackground(event.guildId, event.channelId, `slash-run:${event.userId}`, {
        firstOrchestratorMustReply: true,
        firstResponderSceneDirectionOverride: event.sceneDirection
      });
    } catch (error) {
      this.options.logger.error("Run command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Run failed.");
    }
  }

  private async handleRunWaifuAutocomplete(event: DiscordRunWaifuAutocompleteEvent): Promise<void> {
    try {
      if (!event.guildId || !event.channelId) {
        await event.respond([]);
        return;
      }
      const server = await ensureServer(this.options.storage, event.guildId);
      const channel = server.channels[event.channelId];
      if (!channelHasWaifus(channel)) {
        await event.respond([]);
        return;
      }
      const query = normalizeRunWaifuName(event.focusedValue);
      const choices = (await listAvailableWaifusForChannel(this.options.storage, channel))
        .filter((waifu) => waifu.botId && waifu.modelId)
        .filter((waifu) => {
          if (!query) return true;
          return [waifu.id, waifu.name, waifu.displayName].some((value) =>
            normalizeRunWaifuName(value).includes(query)
          );
        })
        .map((waifu): DiscordAutocompleteChoice => ({
          name: autocompleteWaifuName(waifu),
          value: waifu.id
        }))
        .slice(0, 25);
      await event.respond(choices);
    } catch (error) {
      this.options.logger.warn("Run waifu autocomplete failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond([]);
    }
  }

  private async handleStopCommand(event: DiscordStopCommandEvent): Promise<void> {
    try {
      const result = await this.stopChannel(event.guildId, event.channelId, `slash-stop:${event.userId}`);
      if (result.stoppedRun || result.clearedRetrigger) {
        await event.respond("Stopped orchestrator and waifu work in this channel.");
      } else if (result.activeInAnotherChannel) {
        await event.respond("No work was running in this channel. Another channel in this server is active.");
      } else {
        await event.respond("No orchestrator or waifu work was running in this channel.");
      }
    } catch (error) {
      this.options.logger.error("Stop command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Stop failed.");
    }
  }

  private async handlePrintWaifuAutocomplete(event: DiscordPrintWaifuAutocompleteEvent): Promise<void> {
    try {
      if (!event.guildId) {
        await event.respond([]);
        return;
      }
      const server = await ensureServer(this.options.storage, event.guildId);
      const query = normalizeRunWaifuName(event.focusedValue);
      const choices = (await listAvailableWaifusForGuild(this.options.storage, server))
        .filter((waifu) => {
          if (!query) return true;
          return [waifu.id, waifu.name, waifu.displayName].some((value) =>
            normalizeRunWaifuName(value).includes(query)
          );
        })
        .map((waifu): DiscordAutocompleteChoice => ({
          name: autocompleteWaifuName(waifu),
          value: waifu.id
        }))
        .slice(0, 25);
      await event.respond(choices);
    } catch (error) {
      this.options.logger.warn("Print waifu autocomplete failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond([]);
    }
  }

  private async handleMemoriesCommand(event: DiscordMemoriesCommandEvent): Promise<void> {
    try {
      const result = await this.triggerStageManager(event.guildId, event.channelId);
      if (result.status === "updated") {
        await event.respond(result.message ?? "Observer and dream pass updated memories.");
      } else if (result.status === "no_change") {
        await event.respond(result.message ?? "Observer and dream pass found no memory changes.");
      } else if (result.status === "already_running") {
        await event.respond("Memory work is already running in this channel.");
      } else if (result.status === "disabled") {
        await event.respond("Memory work is disabled or missing a model.");
      } else {
        await event.respond(result.message ?? "Memory work failed. Check logs.");
      }
    } catch (error) {
      this.options.logger.error("Memories command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Stage manager failed.");
    }
  }

  private async handlePrintCommand(event: DiscordPrintCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Print type is required. Choose system prompt, memories, or personality.");
        return;
      }
      const waifuId = event.waifuId?.trim();
      if (!waifuId) {
        await event.respond("Waifu is required.");
        return;
      }
      const server = await ensureServer(this.options.storage, event.guildId);
      const availableWaifus = await listAvailableWaifusForGuild(this.options.storage, server);
      if (availableWaifus.length === 0) {
        await event.respond("No waifus are enabled in this server.");
        return;
      }
      const resolved = this.resolvePrintWaifu(availableWaifus, waifuId);
      if (typeof resolved === "string") {
        await event.respond(resolved);
        return;
      }
      if (!this.options.discord.sendDebugMessage) {
        throw new Error("Discord debug message sending is not available.");
      }

      const messages = await this.formatPrintCommandMessages({
        guildId: event.guildId,
        channelId: event.channelId,
        server,
        waifu: resolved,
        availableWaifus,
        type: event.type
      });
      for (const content of messages) {
        await this.options.discord.sendDebugMessage({
          channelId: event.channelId,
          content
        });
      }
      await event.respond(printCommandConfirmation(event.type, resolved.displayName));
    } catch (error) {
      this.options.logger.error("Print command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        type: event.type,
        waifuId: event.waifuId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Print command failed.");
    }
  }

  private async formatPrintCommandMessages(input: {
    guildId: string;
    channelId: string;
    server: ServerConfig;
    waifu: WaifuConfig;
    availableWaifus: WaifuConfig[];
    type: Exclude<DiscordPrintCommandEvent["type"], undefined>;
  }): Promise<string[]> {
    if (input.type === "system_prompt") {
      const captured = this.executor.lastSentWaifuPrompts.get(`${input.guildId}:${input.waifu.id}`);
      if (captured) {
        return [
          `Captured from ${input.waifu.displayName}'s last reply at ${captured.at} in <#${captured.channelId}> — exactly what the model received.`,
          ...formatWaifuPromptDebugMessages({
            waifuDisplayName: input.waifu.displayName,
            systemPrompt: captured.systemPrompt,
            midSystemBlock: captured.midSystemBlock,
            trailingSystemBlock: captured.trailingSystemBlock
          })
        ];
      }
      const { systemPrompt, midSystemBlock, trailingSystemBlock } = await buildWaifuPromptParts(this.options, 
        input.guildId,
        input.waifu,
        input.availableWaifus,
        {
          channelId: input.channelId,
          pickNextWaifuToolOverride: input.server.tools.pickNextWaifu,
          shortTermMemoryToolOverride: input.server.tools.shortTermMemory,
          // No generation since backend start: fresh render; no live window, scores on recency+strength.
          contextMessages: undefined,
          memoryInjectionLimit: input.server.memoryInjectionLimit
        }
      );
      return [
        `${input.waifu.displayName} has not replied since the backend started — showing a freshly rendered prompt, not one from a live turn.`,
        ...formatWaifuPromptDebugMessages({
          waifuDisplayName: input.waifu.displayName,
          systemPrompt,
          midSystemBlock,
          trailingSystemBlock
        })
      ];
    }
    if (input.type === "memories") {
      const content = await this.allMemoriesBlockForPrint(input.guildId, input.waifu);
      return formatPrintDebugBlock(`Memories (${input.waifu.displayName})`, content);
    }
    const digest = input.waifu.personaDigest;
    const digestText = digest
      ? `Voice: ${digest.voice}\nDrives: ${digest.role}`
      : "(no digest generated yet — the trailing anchor falls back to a 200-char persona slice)";
    return [
      ...formatPrintDebugBlock(
        `Personality block 1 — raw persona (${input.waifu.displayName})`,
        input.waifu.persona.trim() || "(no personality configured)"
      ),
      ...formatPrintDebugBlock(
        `Personality block 2 — trailing-anchor summary (${input.waifu.displayName})`,
        digestText
      )
    ];
  }

  /** Every memory for this waifu+guild — active AND archived — newest first, with flags. */
  private async allMemoriesBlockForPrint(guildId: string, waifu: WaifuConfig): Promise<string> {
    const now = new Date();
    const store = await readMemoryStore(this.options.storage);
    const records = store.memories
      .filter((record) => record.guildId === guildId && record.waifuId === waifu.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (records.length === 0) return "(none)";
    const active = records.filter((record) => record.status === "active").length;
    const lines = records.map((record) => {
      const expired = record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime();
      const flags = [record.kind, record.status, expired ? "expired" : undefined, record.pinned ? "pinned" : undefined, `s${record.strength}`]
        .filter(Boolean)
        .join("|");
      return `- [${flags}] (${relativeAge(record.createdAt, now)}) ${record.content}`;
    });
    return `${records.length} total (${active} active, ${records.length - active} archived)\n${lines.join("\n")}`;
  }

  private async handleDebugCommand(event: DiscordDebugCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Debug type is required. Choose set or unset.");
        return;
      }
      const sourceChannelId = event.sourceChannelId?.trim();
      if (!sourceChannelId) {
        await event.respond("Source channel ID is required for set and unset.");
        return;
      }
      if (event.type === "unset") {
        const removed = await unsetDebugRoute(this.options.storage, sourceChannelId);
        await event.respond(
          removed
            ? `Debug logs disabled for channel ${sourceChannelId}.`
            : `No debug route is set for channel ${sourceChannelId}.`
        );
        return;
      }
      if (!this.options.discord.validateDebugChannel) {
        throw new Error("Discord debug channel validation is not available.");
      }
      const [source, destination] = await Promise.all([
        this.options.discord.validateDebugChannel({ channelId: sourceChannelId, requireMessages: true }),
        this.options.discord.validateDebugChannel({ channelId: event.channelId, requireSend: true })
      ]);
      await setDebugRoute(this.options.storage, {
        sourceGuildId: source.guildId,
        sourceChannelId,
        destinationGuildId: destination.guildId ?? event.guildId,
        destinationChannelId: event.channelId,
        userId: event.userId
      });
      await event.respond(`Debug logs for channel ${sourceChannelId} will be posted in this channel.`);
    } catch (error) {
      this.options.logger.error("Debug command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        sourceChannelId: event.sourceChannelId,
        type: event.type,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Debug command failed.");
    }
  }

  private runtimeBusyReason(guildId: string, channelId: string): string | undefined {
    const key = runKey(guildId);
    const activeRun = this.activeRuns.get(key);
    if (activeRun) {
      return activeRun.channelId === channelId
        ? "Orchestrator is already running in this channel."
        : "Orchestrator is already running in another channel for this server.";
    }
    if ((this.executor.activeWaifuQueries.get(key) ?? 0) > 0) {
      return "A waifu response query is already in flight.";
    }
    if ((this.activeReviewerRuns.get(key) ?? 0) > 0) {
      return "Reviewer is already running.";
    }
    return undefined;
  }

  private async startChannelRun(
    guildId: string,
    channelId: string,
    reason: string,
    options: ChannelRunOptions = {}
  ): Promise<void> {
    // Every entry point (messages, timers, /run, restart resume, reviewer) funnels through here,
    // so the runtime-wide pause is enforced once for all of them.
    if (this.options.isPaused?.()) {
      this.options.logger.info("Channel run not started because runtime is paused", { guildId, channelId, reason });
      return;
    }
    // Runs are keyed per GUILD on purpose: a waifu is one Discord bot/persona shared by every
    // channel of the guild that enables her, so two concurrent channel runs could have the same
    // character generating and typing in two rooms at once (and double the guild's model spend).
    // /run, /stop, the reviewer and the dream deferral all rely on this one-run-per-guild slot.
    // Only human messages and manual commands preempt: they abort the other channel's run, which
    // is queued (deduped) and re-triggered shortly after the guild's slot frees, so its reply is
    // not lost. Timer wakes and boot catch-up never abort anything — they queue behind the live
    // run (keeping their wake identity), so two busy channels cannot ping-pong extra passes.
    const key = runKey(guildId);
    const existing = this.activeRuns.get(key);
    if (existing && (options.trigger === "retrigger" || options.trigger === "resume")) {
      if (existing.channelId !== channelId) {
        this.notePreemptedChannel(guildId, channelId, options.wake ?? { source: "preempted" });
        this.options.logger.info("Deferred channel wake behind another channel's active run", {
          guildId,
          channelId,
          activeChannelId: existing.channelId,
          reason
        });
      } else {
        // This channel's own live run already covers the room; it schedules its own next wake.
        this.options.logger.info("Dropped channel wake; the channel's run is already active", { guildId, channelId, reason });
      }
      return;
    }
    const versionKey = timerKey(guildId, channelId);
    this.channelRunVersions.set(versionKey, (this.channelRunVersions.get(versionKey) ?? 0) + 1);
    this.dropPreemptedChannel(guildId, channelId);
    if (existing) {
      this.options.logger.info("Restarting active channel run", {
        guildId,
        channelId,
        previousChannelId: existing.channelId,
        reason
      });
      existing.controller.abort(new Error(`restarted by ${reason}`));
      this.markSessionIdleBackground(existing.guildId, existing.channelId, `restarted by ${reason}`);
      if (existing.channelId !== channelId) {
        // An aborted timer-wake run keeps its own wake identity (marker, cast-wake budget); an
        // aborted human/manual run comes back as a "preempted" pass.
        const requeueWake = existing.trigger === "retrigger" && existing.wake ? existing.wake : { source: "preempted" as const };
        this.notePreemptedChannel(guildId, existing.channelId, requeueWake);
      }
    }
    this.clearRetriggerTimer(guildId, channelId);

    const controller = new AbortController();
    const recoveryKey = timerKey(guildId, channelId);
    const promise = this.runChannelLoop(guildId, channelId, controller.signal, options)
      .then(() => {
        this.recoveryAttempts.delete(recoveryKey);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (isPermissionError(error)) {
          this.permissionWarnings.record(guildId, channelId, "a waifu bot", error);
        }
        this.options.logger.error("Channel runtime loop failed", {
          guildId,
          channelId,
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof GatewayPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
        });
        // A run that dies (provider outage, safety block, …) has already cleared any pending
        // retrigger timer — without a recovery wake the channel stays dead until the next human
        // message that doesn't crash (live incident 2026-07-05: a Gemini PROHIBITED_CONTENT block
        // silenced an active room for hours). Fresh context on the retry usually clears the block.
        // Consecutive crashes back off exponentially (3m, 6m, 12m … capped at 2h) so a permanent
        // failure does not burn a model call every 3 minutes forever; a clean run resets it.
        const attempt = (this.recoveryAttempts.get(recoveryKey) ?? 0) + 1;
        this.recoveryAttempts.set(recoveryKey, attempt);
        const recoverySeconds = recoveryRetriggerSeconds(attempt);
        this.options.logger.warn("Scheduling crash-recovery wake", {
          guildId,
          channelId,
          attempt,
          seconds: recoverySeconds
        });
        void this.scheduleRetrigger(guildId, channelId, recoverySeconds, { source: "crash_recovery" }).catch(() => undefined);
      })
      .finally(async () => {
        if (this.activeRuns.get(key)?.controller === controller) {
          this.activeRuns.delete(key);
          this.options.onActiveRunsChange?.(this.activeRuns.size);
          try {
            await markSessionIdle(this.options.storage, guildId, channelId);
          } catch (error) {
            this.options.logger.error("Failed to mark session idle", {
              guildId,
              channelId,
              reason,
              message: error instanceof Error ? error.message : String(error)
            });
          }
          await this.retriggerPreemptedChannel(guildId);
        }
      });
    this.activeRuns.set(key, { guildId, channelId, controller, promise, trigger: options.trigger, wake: options.wake });
    this.options.onActiveRunsChange?.(this.activeRuns.size);
    this.options.logger.info("Channel runtime loop started", { guildId, channelId, reason });
    await promise;
  }

  private notePreemptedChannel(guildId: string, channelId: string, wake: RetriggerWakeInput): void {
    const pending = this.preemptedChannels.get(guildId) ?? new Map<string, RetriggerWakeInput>();
    // An interrupted human/manual turn outranks a deferred timer wake for the same channel.
    if (pending.get(channelId)?.source !== "preempted") pending.set(channelId, wake);
    this.preemptedChannels.set(guildId, pending);
  }

  private dropPreemptedChannel(guildId: string, channelId: string): void {
    const pending = this.preemptedChannels.get(guildId);
    if (!pending) return;
    pending.delete(channelId);
    if (pending.size === 0) this.preemptedChannels.delete(guildId);
  }

  // The guild's run slot just freed: give the oldest preempted channel its turn back.
  private async retriggerPreemptedChannel(guildId: string): Promise<void> {
    if (this.stopping || this.options.isPaused?.() || this.activeRuns.has(runKey(guildId))) return;
    const entry = this.preemptedChannels.get(guildId)?.entries().next().value;
    if (entry === undefined) return;
    const [next, wake] = entry;
    this.dropPreemptedChannel(guildId, next);
    // An already-armed wake will run the channel anyway; never shorten or replace it.
    if (this.retriggerTimers.has(timerKey(guildId, next))) return;
    this.options.logger.info("Re-triggering channel queued behind another channel's run", {
      guildId,
      channelId: next,
      source: wake.source
    });
    try {
      // scheduleRetrigger re-checks /stop, pause and newer runs after its write.
      await this.scheduleRetrigger(guildId, next, PREEMPTED_RETRIGGER_SECONDS, wake);
    } catch (error) {
      this.options.logger.warn("Failed to re-trigger preempted channel", {
        guildId,
        channelId: next,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runChannelLoop(
    guildId: string,
    channelId: string,
    signal: AbortSignal,
    options: ChannelRunOptions = {}
  ): Promise<void> {
    let turns = 0;
    // Tracks the newest human message seen across loop iterations so the post-limit
    // cooldown can distinguish an active room from cast-only self-chatter.
    let lastHumanMessageTs: string | undefined;
    // Whatever wake was persisted is consumed by this run (it either fired, or this run
    // supersedes it); every exit path that wants a later pass schedules a fresh one. Leaving it
    // set made every boot fire a spurious "retrigger elapsed during downtime" wake.
    await consumeScheduledRetrigger(this.options.storage, guildId, channelId);
    {
      // Timer wakes and manual triggers land here directly, so the per-server pause
      // must gate the loop itself, not just the message handler.
      const server = await ensureServer(this.options.storage, guildId);
      if (server.paused) {
        this.options.logger.info("Channel run skipped because server is paused", { guildId, channelId });
        return;
      }
    }
    if (options.initialResponders?.length) {
      const server = await ensureServer(this.options.storage, guildId);
      const channel = server.channels[channelId];
      if (!channelHasWaifus(channel)) {
        this.options.logger.info("Directed channel run stopped because no waifus are enabled for channel", {
          guildId,
          channelId
        });
        return;
      }
      const availableWaifus = await listAvailableWaifusForChannel(this.options.storage, channel);
      const decision: OrchestratorDecision = {
        action: "reply",
        respondingWaifus: options.initialResponders.map((responder) => ({
          waifuId: responder.waifuId,
          delaySeconds: responder.delaySeconds ?? 0,
          directive: responder.directive
            ? { intent: responder.directive.intent as DirectiveIntent, goal: responder.directive.goal ?? "" }
            : undefined,
          replyToMessageId: responder.replyToMessageId
        })),
        reasoning: options.initialReason ?? "Manual directed run."
      };
      const decisionId = randomUUID();
      // Manual directed runs bypass the directive budget entirely (their directives are
      // already "manual" intent and exempt); guardrails are not run here.
      const responderOutcomes = await this.recordOrchestratorDecision({
        guildId,
        channelId,
        decisionId,
        decision,
        status: "pending"
      });
      const { attemptedCount } = await this.executor.executeResponderDecision({
        guildId,
        channelId,
        server,
        channel,
        decision,
        decisionId,
        responderOutcomes,
        decisionDelayBaseMs: Date.now(),
        useDecisionRelativeDelays: true,
        availableWaifus,
        signal
      });
      // A directed turn that produced nothing still hands over to the orchestrator: it has not
      // judged this context yet, so this is not a re-decision loop.
      if (attemptedCount === 0) {
        this.options.logger.info("Directed channel run stopped because no responders were executed", {
          guildId,
          channelId
        });
        return;
      }
    }

    await setActivePipeline(this.options.storage, guildId, channelId, "orchestrator");
    let nothingSent = false;
    while (turns < this.maxAutomaticTurns) {
      throwIfAborted(signal);
      turns += 1;
      const server = await ensureServer(this.options.storage, guildId);
      const channel = server.channels[channelId];
      if (!channelHasWaifus(channel)) {
        this.options.logger.info("Channel runtime loop stopped because no waifus are enabled for channel", {
          guildId,
          channelId
        });
        return;
      }

      const orchestrator = await readAgentConfig(this.options.storage, "orchestrator", 40);
      // Deterministic when: no global model configured (free mode), or this guild explicitly
      // opted its channels into the model-free structural decider.
      const oneShotMode = server.orchestratorMode === "one-shot";
      const deterministicMode = server.orchestratorMode === "deterministic" || (!oneShotMode && !orchestrator.modelId);
      let messages = await this.options.discord.fetchFreshContext({
        guildId,
        channelId,
        limit: server.contextWindows.orchestrator ?? orchestrator.contextWindow,
        signal
      });
      await noteActiveChatParticipantsFromContext(this.options.storage, guildId, channelId, messages);
      if (!deterministicMode && !oneShotMode && orchestrator.modelId) {
        messages = await this.models.messagesForModel(
          messages,
          { providerId: orchestrator.providerId, modelId: orchestrator.modelId },
          signal
        );
      }
      if (oneShotMode && this.options.ocr) messages = await this.options.ocr.enrichMessages(messages, { signal });
      this.options.logger.info("Fetched Discord context for orchestrator", {
        guildId,
        channelId,
        messageCount: messages.length,
        modelId: oneShotMode ? server.oneShot.target : orchestrator.modelId
      });
      // Cast-only beat budget: a timer wake must not milk a beat the cast already covered.
      // When the humans are silent and several unanswered waifu messages already trail the
      // context, skip the model pass and check back later — unless the room has been quiet
      // long enough that a genuinely fresh beat is welcome.
      if (turns === 1 && options.trigger === "retrigger" && options.wake?.source !== "preempted") {
        const suppressed = shouldSuppressCastWake(messages, Date.now());
        if (suppressed) {
          this.options.logger.info("Cast-only wake suppressed; beat budget exhausted", {
            guildId,
            channelId,
            trailingBotMessages: suppressed.trailingBotMessages
          });
          await this.scheduleRetrigger(guildId, channelId, CAST_WAKE_SUPPRESS_SECONDS, { source: "cast_wake_suppressed" });
          return;
        }
      }
      const pipeline = deterministicMode || oneShotMode
        ? undefined
        : this.models.pipelineFor({ providerId: orchestrator.providerId, modelId: orchestrator.modelId! }, "orchestrator");
      if (pipeline && !pipeline.decideOrchestrator) {
        throw new Error(`Model ${orchestrator.modelId} does not implement orchestrator decisions.`);
      }
      const availableWaifus = await listAvailableWaifusForChannel(this.options.storage, channel);
      const { cast: deterministicCast, nicknames: guildNicknames } = await buildDeterministicCast(this.options.storage, 
        guildId,
        availableWaifus
      );
      const pastDecisions = await readCompletedOrchestratorDecisionsForChannel(this.options.storage, guildId, channelId);
      const requireReply = Boolean(options.firstOrchestratorMustReply && turns === 1);

      const loop = assessLoop(messages);
      // Only nag about early cast retirement while humans are actually around — in a dead room
      // the reply→pause rhythm is correct behavior, not a rut.
      const newestHumanTs = messages.reduce<string | undefined>(
        (acc, message) => (isHumanUserMessage(message) && (!acc || message.timestamp > acc) ? message.timestamp : acc),
        undefined
      );
      const humanActiveNow =
        newestHumanTs !== undefined && Date.now() - Date.parse(newestHumanTs) < HUMAN_RECENT_WINDOW_MS;
      const cadence = humanActiveNow ? assessCastCadence(pastDecisions) : { suspected: false as const };
      const runtimeNotice = [loop.notice, cadence.notice].filter(Boolean).join("\n") || undefined;
      const channelKey = timerKey(guildId, channelId);
      const directiveCount = this.directiveDecisionCounts.get(channelKey) ?? orchestrator.directiveCooldown;
      const directiveBudgetOpen = loop.suspected || cadence.suspected || directiveCount >= orchestrator.directiveCooldown;

      // On the first turn of a timer-fired retrigger, surface the wake marker (with the wake plan
      // the orchestrator promised last time) so it can pick up where it left off, plus escalate the
      // next backoff if it chooses no_reply again. Only a wake armed by a no_reply decision gets
      // a marker, and it describes THAT decision — not whatever no_reply happens to be newest
      // (turn-limit cooldowns, crash recovery and suppressed wakes have no plan to execute).
      let decisionMarkers: OrchestratorWakeMarker[] | undefined;
      const wakeDecision =
        turns === 1 && options.trigger === "retrigger" ? wakeSchedulingDecision(options.wake, pastDecisions) : undefined;
      // The armed delay (includes earlier escalation) when known, else the decision's own number.
      const timerWakeSeconds = wakeDecision ? options.wake?.seconds ?? wakeDecision.retriggerAfterSeconds : undefined;
      if (wakeDecision && timerWakeSeconds) {
        decisionMarkers = [{
          kind: "wake",
          timestamp: formatTimestamp(new Date()),
          scheduledSeconds: timerWakeSeconds,
          wakePlan: wakeDecision.wakePlan
        }];
      }

      const trailingPrompt = buildOrchestratorTrailingPrompt(
        orchestrator,
        availableWaifus,
        requireReply,
        runtimeNotice,
        guildNicknames
      );
      // No typing scope for orchestrator decisions: the orchestrator bot showing "typing…" while it
      // deliberates leaks the machinery's presence into the room. Only the waifu send path types.
      let decision: OrchestratorDecision;
      let semanticLoopDetected = false;
      if (oneShotMode) {
        try {
          const before = performance.now();
          const result = await (this.options.decideOneShot ?? ((input) => this.oneShot.decide(input)))({
            target: server.oneShot.target, messages, cast: deterministicCast, waifus: availableWaifus, now: new Date(),
            replyRequired: requireReply, directiveBudgetOpen, loopSuspected: loop.suspected, timerWakeSeconds,
            policy: orchestrator.prompt, signal
          });
          decision = result.decision;
          semanticLoopDetected = result.loopDetected;
          this.options.logger.info("One shot decision completed", { guildId, channelId, target: server.oneShot.target,
            action: decision.action, loopDetected: semanticLoopDetected, durationMs: Math.round(performance.now() - before) });
        } catch (error) {
          if (requireReply || signal.aborted) throw error;
          decision = decideDeterministically({ messages, cast: deterministicCast, now: new Date() });
          const code = error instanceof Error && /^one_shot_[a-z0-9_]+$/.test(error.message) ? error.message : "one_shot_failed";
          this.options.logger.warn("One shot failed; deterministic fallback decision used", { guildId, channelId, code, action: decision.action });
        }
      } else if (!pipeline || !pipeline.decideOrchestrator) {
        decision = decideDeterministically({ messages, cast: deterministicCast, now: new Date() });
        this.options.logger.info("Deterministic orchestrator decision (no model configured)", {
          guildId,
          channelId,
          action: decision.action,
          reasoning: decision.reasoning
        });
      } else {
        try {
          decision = await pipeline.decideOrchestrator({
            modelId: orchestrator.modelId!,
            messages,
            pastDecisions,
            decisionMarkers,
            directiveBudgetOpen,
            trailingPrompt,
            systemPrompt: buildOrchestratorSystemPrompt(orchestrator, server, requireReply),
            availableWaifuIds: availableWaifus.map((waifu) => waifu.id),
            replyRequired: requireReply,
            params: orchestrator.params,
            signal
          });
        } catch (error) {
          // Manual /run promised the user a reply from the model — surface its failure instead.
          if (requireReply || signal.aborted) throw error;
          decision = decideDeterministically({ messages, cast: deterministicCast, now: new Date() });
          this.options.logger.warn("Model orchestrator failed; deterministic fallback decision used", {
            guildId,
            channelId,
            message: error instanceof Error ? error.message : String(error),
            action: decision.action,
            reasoning: decision.reasoning
          });
        }
      }
      // Wake-plan enforcement: this pass IS the wake a no_reply plan scheduled. If the model
      // answers no_reply again — its second consecutive plan with no execution — the runtime
      // executes the promised plan itself (named waifu + the plan text as her change_topic
      // goal). Live 2026-07-06 08:11: "have Lumi start a new topic" → no_reply restating it.
      let wakePlanEnforced = false;
      if (
        !deterministicMode &&
        !oneShotMode &&
        !requireReply &&
        timerWakeSeconds &&
        wakeDecision?.wakePlan &&
        decision.action === "no_reply" &&
        pastDecisions[0]?.id === wakeDecision.id
      ) {
        const enforced = enforceWakePlan({
          plan: wakeDecision.wakePlan,
          cast: deterministicCast,
          messages,
          now: new Date()
        });
        if (enforced) {
          this.options.logger.warn("Wake-plan enforcement: model deferred its own plan twice; executing it", {
            guildId,
            channelId,
            plan: wakeDecision.wakePlan.slice(0, 140),
            executor: enforced.respondingWaifus[0]?.waifuId,
            modelReasoning: decision.reasoning.slice(0, 140)
          });
          decision = enforced;
          wakePlanEnforced = true;
        }
      }
      // Enforcement tier for the retire-early rut: the cadence notice is advisory, and
      // flash-lite-class models demonstrably acknowledge an active room and pause anyway
      // (live 2026-07-06 06:07: "conversation is still very active, but…" → no_reply 45).
      // When the detector fired, humans are around, and the model still pauses, a
      // deterministic reply keeps the room alive; the model resumes control next pass.
      if (!deterministicMode && !requireReply && cadence.suspected && humanActiveNow && decision.action === "no_reply") {
        const override = decideDeterministically({ messages, cast: deterministicCast, now: new Date() });
        if (override.action === "reply") {
          this.options.logger.warn("Cadence override: model retired an active room again; deterministic reply used", {
            guildId,
            channelId,
            modelReasoning: decision.reasoning.slice(0, 160),
            override: override.reasoning
          });
          decision = override;
        }
      }
      decision = capDecisionDelays(decision);
      if (requireReply) {
        decision = applyFirstResponderDirectiveOverride(
          decision,
          options.firstResponderSceneDirectionOverride
        );
      }
      const decisionDelayBaseMs = Date.now();
      const useDecisionRelativeDelays = hasRecentUserMessage(messages, 4);
      for (const message of messages) {
        if (message.authorKind === "user" && message.authorBot !== true) {
          if (!lastHumanMessageTs || message.timestamp > lastHumanMessageTs) {
            lastHumanMessageTs = message.timestamp;
          }
        }
      }
      const decisionId = randomUUID();
      const initialDecisionStatus: OrchestratorDecisionStatus =
        decision.action === "reply" ? "pending" : "completed";
      // Record history with the ORIGINAL decision (the dashboard shows what the model wanted), but
      // execute the guarded decision (stripped directives over budget/cap).
      const guarded = this.applyDirectiveGuardrails({
        guildId,
        channelId,
        decision,
        directiveCooldown: orchestrator.directiveCooldown,
        // wake-plan enforcement exists to fire a directive — it must not be budget-stripped
        loopSuspected: loop.suspected || semanticLoopDetected || wakePlanEnforced
      });
      const responderOutcomes = await this.recordOrchestratorDecision({
        guildId,
        channelId,
        decisionId,
        decision,
        status: initialDecisionStatus
      });
      for (const strippedEntry of guarded.stripped) {
        const outcome = responderOutcomes[strippedEntry.index];
        if (outcome) {
          await updateOrchestratorResponderOutcome(this.options.storage, decisionId, outcome.id, {
            directiveStripped: strippedEntry.reason
          });
          this.options.logger.info("Stripped orchestrator directive", {
            guildId,
            channelId,
            waifuId: outcome.waifuId,
            reason: strippedEntry.reason
          });
        }
      }
      void sendOrchestratorDebugLog(this.options, {
        guildId,
        channelId,
        decision,
        availableWaifus
      });

      if (decision.action === "no_reply") {
        let seconds = decision.retriggerAfterSeconds ?? RETRIGGER_DEFAULT_SECONDS;
        if (timerWakeSeconds) {
          seconds = Math.max(seconds, Math.ceil(timerWakeSeconds * 1.5));
        }
        await this.scheduleRetrigger(guildId, channelId, seconds, { source: "no_reply", decisionId });
        return;
      }

      const { attemptedCount, executedCount } = await this.executor.executeResponderDecision({
        guildId,
        channelId,
        server,
        channel,
        decision: guarded.decision,
        decisionId,
        responderOutcomes,
        decisionDelayBaseMs,
        useDecisionRelativeDelays,
        availableWaifus,
        signal
      });
      if (attemptedCount === 0) {
        this.options.logger.info("Channel runtime loop stopped because no responders were executed", {
          guildId,
          channelId
        });
        return;
      }
      if (executedCount === 0) {
        // Every responder came back empty/blocked: nothing changed in the room, so another pass
        // would re-decide on the same context (up to maxAutomaticTurns times). End the burst and
        // fall through to the normal cooldown wake instead.
        this.options.logger.warn("No responder sent anything; ending pass loop until the cooldown wake", {
          guildId,
          channelId,
          turns
        });
        nothingSent = true;
        break;
      }
      await setActivePipeline(this.options.storage, guildId, channelId, "orchestrator");
    }

    // Cast-only pacing: when no human has spoken recently, the room can idle far longer
    // between automatic bursts — this is also the API-credit throttle for self-chatter.
    const humanRecent =
      lastHumanMessageTs !== undefined &&
      Date.now() - Date.parse(lastHumanMessageTs) < HUMAN_RECENT_WINDOW_MS;
    const cooldownSeconds = humanRecent ? RETRIGGER_DEFAULT_SECONDS : CAST_ONLY_COOLDOWN_SECONDS;
    if (!nothingSent) {
      this.options.logger.warn("Automatic turn limit reached; scheduling cooldown", {
        guildId,
        channelId,
        maxAutomaticTurns: this.maxAutomaticTurns,
        humanRecent,
        cooldownSeconds
      });
    }
    await this.scheduleRetrigger(guildId, channelId, cooldownSeconds, {
      source: nothingSent ? "nothing_sent" : "turn_limit"
    });
  }

  private applyDirectiveGuardrails(input: {
    guildId: string;
    channelId: string;
    decision: OrchestratorDecision;
    directiveCooldown: number;
    loopSuspected: boolean;
  }): { decision: OrchestratorDecision; stripped: Array<{ index: number; reason: "cooldown" | "over_cap" }> } {
    const key = timerKey(input.guildId, input.channelId);
    const current = this.directiveDecisionCounts.get(key) ?? input.directiveCooldown;
    const budgetOpen = input.loopSuspected || current >= input.directiveCooldown;
    const stripped: Array<{ index: number; reason: "cooldown" | "over_cap" }> = [];
    let honored = false;
    const respondingWaifus = input.decision.respondingWaifus.map((responder, index) => {
      const directive = responder.directive;
      if (!directive) return responder;
      if (directive.intent === "manual") {
        honored = true;
        return responder;
      }
      if (directive.goal.length > DIRECTIVE_GOAL_MAX_CHARS) {
        stripped.push({ index, reason: "over_cap" });
        return { ...responder, directive: undefined };
      }
      if (!budgetOpen) {
        stripped.push({ index, reason: "cooldown" });
        return { ...responder, directive: undefined };
      }
      honored = true;
      return responder;
    });
    // Cap at a large sentinel purely to prevent unbounded growth on long-lived channels.
    this.directiveDecisionCounts.set(key, honored ? 0 : Math.min(current + 1, 1000));
    return { decision: { ...input.decision, respondingWaifus }, stripped };
  }

  private async recordOrchestratorDecision(input: {
    guildId: string;
    channelId: string;
    decisionId: string;
    decision: OrchestratorDecision;
    status: OrchestratorDecisionStatus;
  }): Promise<OrchestratorResponderOutcome[]> {
    const responderOutcomes = input.decision.respondingWaifus.map(
      (responder): OrchestratorResponderOutcome => ({
        id: randomUUID(),
        waifuId: responder.waifuId,
        source: "orchestrator",
        status: "pending",
        messageIds: []
      })
    );
    await appendOrchestratorHistory(this.options.storage, {
      id: input.decisionId,
      guildId: input.guildId,
      channelId: input.channelId,
      action: input.decision.action,
      respondingWaifus: input.decision.respondingWaifus,
      retriggerAfterSeconds: input.decision.retriggerAfterSeconds,
      wakePlan: input.decision.wakePlan,
      reasoning: input.decision.reasoning,
      status: input.status,
      waifuMessageIds: [],
      responderOutcomes,
      createdAt: nowIso()
    });
    this.options.logger.info("Orchestrator decision recorded", {
      guildId: input.guildId,
      channelId: input.channelId,
      action: input.decision.action,
      responders: input.decision.respondingWaifus.map((entry) => entry.waifuId),
      retriggerAfterSeconds: input.decision.retriggerAfterSeconds,
      reasoning: input.decision.reasoning
    });
    return responderOutcomes;
  }

  private async runReviewer(input: {
    guildId: string;
    channelId: string;
    userId?: string;
    commandMessageId?: string;
    triggerAfterActiveRun?: boolean;
  }): Promise<{ hallucination: boolean; deleted: boolean; messageIds: string[] }> {
    const key = runKey(input.guildId);
    incrementActive(this.activeReviewerRuns, key);
    try {
      return await this.runReviewerInternal(input);
    } finally {
      decrementActive(this.activeReviewerRuns, key);
    }
  }

  private async runReviewerInternal(input: {
    guildId: string;
    channelId: string;
    userId?: string;
    commandMessageId?: string;
    triggerAfterActiveRun?: boolean;
  }): Promise<{ hallucination: boolean; deleted: boolean; messageIds: string[] }> {
    const versionKey = timerKey(input.guildId, input.channelId);
    const runVersionAtStart = this.channelRunVersions.get(versionKey) ?? 0;
    const config = await readAgentConfig(this.options.storage, "reviewer", 20);
    if (!config.enabled || !config.modelId) {
      throw new Error("Reviewer model is not configured or enabled.");
    }
    const server = await ensureServer(this.options.storage, input.guildId);
    const messages = await this.options.discord.fetchFreshContext({
      guildId: input.guildId,
      channelId: input.channelId,
      limit: server.contextWindows.waifu ?? config.contextWindow
    });
    const target = [...messages].reverse().find((message) => message.authorKind === "waifu");
    const messageIds = target ? target.sourceMessageIds ?? [target.id] : [];
    if (!target) {
      await appendReviewerHistory(this.options.storage, {
        id: randomUUID(),
        guildId: input.guildId,
        channelId: input.channelId,
        reviewerUserId: input.userId,
        targetMessageIds: [],
        hallucination: false,
        deleted: false,
        createdAt: nowIso()
      });
      return { hallucination: false, deleted: false, messageIds: [] };
    }
    const pipeline = this.models.pipelineFor(
      { providerId: config.providerId, modelId: config.modelId },
      "reviewer"
    );
    if (!pipeline.decideReviewer) {
      throw new Error(`Model ${config.modelId} does not implement reviewer decisions.`);
    }
    const decision = await pipeline.decideReviewer({
      modelId: config.modelId,
      messages: [],
      message: target.content,
      systemPrompt: config.prompt || DEFAULT_REVIEWER_PROMPT,
      params: config.params,
      signal: undefined
    });

    let deleted = false;
    if (decision.hallucination && this.options.discord.deleteMessages) {
      const deletion = await this.options.discord.deleteMessages({
        guildId: input.guildId,
        channelId: input.channelId,
        messageIds,
        authorId: target.authorId
      });
      deleted = messageIds.every((messageId) => deletion.deletedMessageIds.includes(messageId));
      if (input.commandMessageId) {
        await this.options.discord.deleteMessages({
          guildId: input.guildId,
          channelId: input.channelId,
          messageIds: [input.commandMessageId]
        });
      }
    }

    await appendReviewerHistory(this.options.storage, {
      id: randomUUID(),
      guildId: input.guildId,
      channelId: input.channelId,
      reviewerUserId: input.userId,
      targetMessageIds: messageIds,
      hallucination: decision.hallucination,
      deleted,
      createdAt: nowIso()
    });

    const noNewChannelRun = (this.channelRunVersions.get(versionKey) ?? 0) === runVersionAtStart;
    if (noNewChannelRun && !this.activeRuns.has(runKey(input.guildId))) {
      this.startChannelRunBackground(input.guildId, input.channelId, "reviewer-complete");
    } else if (noNewChannelRun && input.triggerAfterActiveRun) {
      setTimeout(() => {
        if ((this.channelRunVersions.get(versionKey) ?? 0) === runVersionAtStart && !this.activeRuns.has(runKey(input.guildId))) {
          this.startChannelRunBackground(input.guildId, input.channelId, "reviewer-complete");
        }
      }, 0);
    }
    return { hallucination: decision.hallucination, deleted, messageIds };
  }

  private async clearLatestMessages(guildId: string, channelId: string, count: number, type: DiscordClearType): Promise<{
    deleted: boolean;
    logicalMessageCount: number;
    messageIds: string[];
  }> {
    const clearCount = normalizeClearCount(count);
    const server = await ensureServer(this.options.storage, guildId);
    const messages = await this.options.discord.fetchFreshContext({
      guildId,
      channelId,
      limit: Math.max(server.contextWindows.waifu, clearCount)
    });
    const targets = [...messages]
      .reverse()
      .filter((message) => isClearTarget(message, type))
      .slice(0, clearCount);
    const seenMessageIds = new Set<string>();
    const messageIds: string[] = [];
    const authorIdByMessageId: Record<string, string> = {};
    for (const target of targets) {
      const targetMessageIds = target.sourceMessageIds ?? [target.id];
      for (const messageId of targetMessageIds) {
        if (seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
        messageIds.push(messageId);
        authorIdByMessageId[messageId] = target.authorId;
      }
    }
    if (targets.length === 0 || messageIds.length === 0) {
      return { deleted: false, logicalMessageCount: 0, messageIds: [] };
    }
    if (!this.options.discord.deleteMessages) {
      throw new Error("Discord message deletion is not available.");
    }
    const deletion = await this.options.discord.deleteMessages({
      guildId,
      channelId,
      messageIds,
      authorIdByMessageId
    });
    const deletedMessageIds = new Set(deletion.deletedMessageIds);
    return {
      deleted: messageIds.every((messageId) => deletedMessageIds.has(messageId)),
      logicalMessageCount: targets.length,
      messageIds
    };
  }

  private async clearAllChannelMessages(guildId: string, channelId: string): Promise<{
    deletedCount: number;
    failedCount: number;
  }> {
    if (!this.options.discord.deleteAllMessages) {
      throw new Error("Discord full-channel message deletion is not available.");
    }
    const deletion = await this.options.discord.deleteAllMessages({ guildId, channelId });
    return {
      deletedCount: deletion.deletedCount,
      failedCount: deletion.failedCount
    };
  }

  // wake records who armed the timer (persisted with it, so a restored timer keeps its identity);
  // undefined only when restoring a timer persisted before sources were recorded.
  private async scheduleRetrigger(
    guildId: string,
    channelId: string,
    seconds: number,
    wake: RetriggerWakeInput | undefined
  ): Promise<void> {
    const bounded = Math.max(RETRIGGER_MIN_SECONDS, Math.min(RETRIGGER_MAX_SECONDS, seconds));
    const key = timerKey(guildId, channelId);
    const at = new Date(Date.now() + bounded * 1000).toISOString();
    const scheduled: RetriggerWake | undefined = wake
      ? { source: wake.source, seconds: wake.seconds ?? bounded, ...(wake.decisionId ? { decisionId: wake.decisionId } : {}) }
      : undefined;
    const versionAtStart = this.channelRunVersions.get(key) ?? 0;
    await updateSession(this.options.storage, guildId, channelId, (current) => {
      const { scheduledRetrigger: _previous, ...rest } = current;
      return {
        ...rest,
        scheduledRetriggerAt: at,
        ...(scheduled ? { scheduledRetrigger: scheduled } : {}),
        activePipeline: null
      };
    });
    // The write awaited; never arm a timer the world moved past meanwhile. Paused/stopping keeps
    // the persisted wake (resume / next boot restores it). A /stop or a newer run for this
    // channel (both bump the channel version) supersedes it entirely, so drop our write too.
    if (this.stopping || this.options.isPaused?.()) return;
    if ((this.channelRunVersions.get(key) ?? 0) !== versionAtStart) {
      await updateSession(this.options.storage, guildId, channelId, (current) => {
        if (current.scheduledRetriggerAt !== at) return current;
        const { scheduledRetriggerAt: _at, scheduledRetrigger: _wake, ...rest } = current;
        return rest;
      });
      return;
    }
    const existing = this.retriggerTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.retriggerTimers.delete(key);
      this.startChannelRunBackground(guildId, channelId, "scheduled-retrigger", { trigger: "retrigger", wake: scheduled });
    }, bounded * 1000);
    this.retriggerTimers.set(key, timer);
  }

  private clearRetriggerTimer(guildId: string, channelId: string): boolean {
    const key = timerKey(guildId, channelId);
    const timer = this.retriggerTimers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    this.retriggerTimers.delete(key);
    return true;
  }

  private async resolveRunWaifu(guildId: string, channelId: string, value: string): Promise<WaifuConfig | string> {
    const server = await ensureServer(this.options.storage, guildId);
    const channel = server.channels[channelId];
    if (!channelHasWaifus(channel)) {
      return "No waifus are enabled in this channel.";
    }
    const waifus = await listWaifus(this.options.storage);
    const waifusById = new Map(waifus.map((waifu) => [waifu.id, waifu]));
    const channelWaifus = (channel.enabledWaifuIds ?? [])
      .map((waifuId) => waifusById.get(waifuId))
      .filter((waifu): waifu is WaifuConfig => Boolean(waifu));

    const exactId = channelWaifus.find((waifu) => waifu.id === value);
    if (exactId) {
      return this.validateRunWaifuTarget(exactId);
    }

    const query = normalizeRunWaifuName(value);
    const matches = channelWaifus.filter((waifu) =>
      [waifu.name, waifu.displayName].some((candidate) => normalizeRunWaifuName(candidate) === query)
    );
    if (matches.length === 1) {
      return this.validateRunWaifuTarget(matches[0]);
    }
    if (matches.length > 1) {
      return `Waifu "${value}" is ambiguous; use the exact waifu id.`;
    }

    const anyWaifuMatch = waifus.find((waifu) =>
      waifu.id === value ||
      [waifu.name, waifu.displayName].some((candidate) => normalizeRunWaifuName(candidate) === query)
    );
    if (anyWaifuMatch) {
      return `${anyWaifuMatch.displayName} is not enabled in this channel.`;
    }
    return `Waifu "${value}" was not found.`;
  }

  private validateRunWaifuTarget(waifu: WaifuConfig): WaifuConfig | string {
    if (!waifu.botId) {
      return `${waifu.displayName} does not have a linked Discord bot.`;
    }
    if (!waifu.modelId) {
      return `${waifu.displayName} does not have a configured model.`;
    }
    return waifu;
  }

  private resolvePrintWaifu(availableWaifus: WaifuConfig[], value: string): WaifuConfig | string {
    const exactId = availableWaifus.find((waifu) => waifu.id === value);
    if (exactId) {
      return exactId;
    }

    const query = normalizeRunWaifuName(value);
    const matches = availableWaifus.filter((waifu) =>
      [waifu.name, waifu.displayName].some((candidate) => normalizeRunWaifuName(candidate) === query)
    );
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      return `Waifu "${value}" is ambiguous; use the exact waifu id.`;
    }
    return `Waifu "${value}" is not enabled in this server.`;
  }

}

function normalizeRunWaifuName(value: string): string {
  return value.trim().toLowerCase();
}

function autocompleteWaifuName(waifu: WaifuConfig): string {
  return waifu.displayName === waifu.id ? waifu.id : `${waifu.displayName} (${waifu.id})`;
}

function capDecisionDelays(decision: OrchestratorDecision): OrchestratorDecision {
  return {
    ...decision,
    respondingWaifus: decision.respondingWaifus.map((responder) => ({
      ...responder,
      delaySeconds: Math.min(responder.delaySeconds, MAX_WAIFU_DELAY_SECONDS)
    }))
  };
}

function applyFirstResponderDirectiveOverride(
  decision: OrchestratorDecision,
  sceneDirection: string | undefined
): OrchestratorDecision {
  const trimmed = sceneDirection?.trim();
  if (!trimmed || decision.action !== "reply" || decision.respondingWaifus.length === 0) {
    return decision;
  }
  return {
    ...decision,
    respondingWaifus: decision.respondingWaifus.map((responder, index) =>
      index === 0
        ? { ...responder, directive: { intent: "manual" as const, goal: trimmed } }
        : responder
    )
  };
}

const HUMAN_RECENT_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_RETRIGGER_SECONDS = 180;
const RECOVERY_RETRIGGER_MAX_SECONDS = 2 * 60 * 60;
// A preempted channel gets its turn back promptly once the guild's run slot frees.
const PREEMPTED_RETRIGGER_SECONDS = RETRIGGER_MIN_SECONDS;

/** Crash-recovery wake for the nth consecutive failed run: 3m, 6m, 12m, … capped at 2h. */
function recoveryRetriggerSeconds(attempt: number): number {
  return Math.min(RECOVERY_RETRIGGER_MAX_SECONDS, RECOVERY_RETRIGGER_SECONDS * 2 ** Math.max(0, attempt - 1));
}

// The no_reply decision that armed this wake, if any. Timers armed by anything else (turn-limit
// cooldown, crash recovery, suppressed wakes, preemption, boot catch-up) have no plan to execute.
function wakeSchedulingDecision(
  wake: RetriggerWakeInput | undefined,
  pastDecisions: OrchestratorDecisionHistoryEntry[]
): OrchestratorDecisionHistoryEntry | undefined {
  if (wake) {
    if (wake.source !== "no_reply" || !wake.decisionId) return undefined;
    return pastDecisions.find((entry) => entry.id === wake.decisionId && entry.action === "no_reply");
  }
  // Timer persisted before sources were recorded (or an external retrigger call): only trust the
  // newest completed decision, and only when it is itself a no_reply that would have armed it.
  const newest = pastDecisions[0];
  return newest?.action === "no_reply" ? newest : undefined;
}
const CAST_ONLY_COOLDOWN_SECONDS = 900;

const CAST_WAKE_MAX_TRAILING_BOT_MESSAGES = 4;
const CAST_WAKE_HUMAN_RECENT_MS = 30 * 60 * 1000;
const CAST_WAKE_FRESH_BEAT_MS = 2 * 60 * 60 * 1000;
const CAST_WAKE_SUPPRESS_SECONDS = 1800;

// A wake pass is suppressed when the cast has already stacked unanswered messages on a
// beat (>= CAST_WAKE_MAX_TRAILING_BOT_MESSAGES trailing bot messages, no human inside
// CAST_WAKE_HUMAN_RECENT_MS). A room quiet for CAST_WAKE_FRESH_BEAT_MS or longer is
// exempt: after a long lull a fresh cast beat is welcome again.
function shouldSuppressCastWake(
  messages: ContextMessage[],
  now: number
): { trailingBotMessages: number } | undefined {
  let lastHumanTs: number | undefined;
  let newestTs: number | undefined;
  for (const message of messages) {
    const ts = Date.parse(message.timestamp);
    if (Number.isNaN(ts)) continue;
    if (newestTs === undefined || ts > newestTs) newestTs = ts;
    if (message.authorKind === "user" && message.authorBot !== true) {
      if (lastHumanTs === undefined || ts > lastHumanTs) lastHumanTs = ts;
    }
  }
  let trailingBotMessages = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.authorKind === "user" && message.authorBot !== true) break;
    trailingBotMessages += 1;
  }
  if (trailingBotMessages < CAST_WAKE_MAX_TRAILING_BOT_MESSAGES) return undefined;
  if (lastHumanTs !== undefined && now - lastHumanTs < CAST_WAKE_HUMAN_RECENT_MS) return undefined;
  if (newestTs !== undefined && now - newestTs >= CAST_WAKE_FRESH_BEAT_MS) return undefined;
  return { trailingBotMessages };
}

function hasRecentUserMessage(messages: ContextMessage[], count: number): boolean {
  // Other (non-waifu) bots are authorKind "user" too; only real humans count here.
  return messages.slice(-count).some(isHumanUserMessage);
}

function printCommandConfirmation(type: Exclude<DiscordPrintCommandEvent["type"], undefined>, displayName: string): string {
  if (type === "system_prompt") return `Printed system prompt for ${displayName}.`;
  if (type === "memories") return `Printed memories for ${displayName}.`;
  return `Printed personality for ${displayName}.`;
}

function normalizeClearCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(MAX_CLEAR_COUNT, Math.trunc(count)));
}

function isClearTarget(message: ContextMessage, type: DiscordClearType): boolean {
  if (type === "waifus") {
    return message.authorKind === "waifu";
  }
  if (type === "users") {
    return isHumanUserMessage(message);
  }
  if (type === "both") {
    return message.authorKind === "waifu" || isHumanUserMessage(message);
  }
  return true;
}

function noClearTargetsMessage(type: DiscordClearType): string {
  if (type === "waifus") return "No waifu message found to clear.";
  if (type === "users") return "No user message found to clear.";
  if (type === "both") return "No waifu or user message found to clear.";
  return "No message found to clear.";
}

function clearMessageLabel(type: DiscordClearType, count: number): string {
  if (type === "users") return count === 1 ? "user message" : "user messages";
  if (type === "both" || type === "everything") return count === 1 ? "message" : "messages";
  return count === 1 ? "waifu message" : "waifu messages";
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

const MAX_CLEAR_COUNT = 100;
