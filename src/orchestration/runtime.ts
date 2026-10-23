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
import { PermissionWarningTracker } from "./permissionWarnings.js";
import { RUNTIME_SHUTDOWN_INTERRUPT_REASON } from "./restartResume.js";
import { ServerConfig, WaifuConfig } from "../shared/schemas/domain.js";
import { relativeAge } from "./memoryRetrieval.js";
import { nowIso } from "../shared/schemas/common.js";
import type { ContextMessage } from "./context.js";
import { OneShotDecider } from "./oneShot/decider.js";
import { ChannelRunner } from "./channelRunner.js";
import { formatPrintDebugBlock, formatWaifuPromptDebugMessages } from "./debugFormat.js";
import { MemoryJobs } from "./memoryJobs.js";
import { ModelAccess } from "./modelAccess.js";
import { DEFAULT_REVIEWER_PROMPT, buildWaifuPromptParts } from "./promptBuilders.js";
import { ResponderExecutor } from "./responderExecutor.js";
import {
  type ChannelRunOptions,
  type DreamPassResult,
  type RuntimeHooks,
  type RuntimeOrchestratorOptions,
  type StageManagerRunResult,
  decrementActive,
  incrementActive,
  isHumanUserMessage,
  runKey,
  timerKey
} from "./runtimeShared.js";
import {
  channelHasWaifus,
  ensureChannelConfig,
  ensureServer,
  isKnownWaifuAuthor,
  listAvailableWaifusForChannel,
  listAvailableWaifusForGuild,
  listWaifus,
  readAgentConfig,
  syncGuilds
} from "./stores/config.js";
import { setDebugRoute, unsetDebugRoute } from "./stores/debugRoutes.js";
import { appendReviewerHistory, healPendingOrchestratorDecisions } from "./stores/decisionHistory.js";
import { readMemoryStore } from "./stores/memories.js";
import { noteActiveChatParticipant } from "./stores/participants.js";
import { clearScheduledRetrigger, ensureChannelSession, persistShutdownWake } from "./stores/sessions.js";

export type { DreamPassResult, RuntimeOrchestratorOptions, StageManagerRunResult } from "./runtimeShared.js";
export { currentlyDoingForWaifu } from "./promptBuilders.js";

export class RuntimeOrchestrator {
  readonly permissionWarnings = new PermissionWarningTracker();
  private readonly models: ModelAccess;
  private readonly activeReviewerRuns = new Map<string, number>();
  // Set by pause() and by a paused start(); resumeAfterPause() is a no-op unless it is set, so a
  // redundant Resume can never replan (and duplicate) live runs.
  private wasPaused = false;
  private unsubscribes: Array<() => void> = [];
  private stopping = false;
  private readonly oneShot: OneShotDecider;
  private readonly memoryJobs: MemoryJobs;
  private readonly executor: ResponderExecutor;
  private readonly runner: ChannelRunner;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    const hooks: RuntimeHooks = {
      runBackground: (label, context, task) => this.runBackground(label, context, task),
      isStopping: () => this.stopping
    };
    const maxAutomaticTurns = options.maxAutomaticTurns ?? 8;
    this.oneShot = new OneShotDecider(options.storage.dataRoot);
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
      maxAutomaticTurns
    );
    this.runner = new ChannelRunner(
      options,
      hooks,
      this.models,
      this.executor,
      this.oneShot,
      this.permissionWarnings,
      maxAutomaticTurns
    );
    this.memoryJobs = new MemoryJobs(
      options,
      this.models,
      { ...hooks, isGuildRunActive: (guildId) => this.runner.isGuildRunActive(guildId) },
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
    await this.runner.startChannelRun(event.guildId, event.channelId, `message:${event.messageId}`, {
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
        this.runner.startChannelRunBackground(event.guildId, event.channelId, `slash-run:${event.userId}:${resolved.id}`, {
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
      this.runner.startChannelRunBackground(event.guildId, event.channelId, `slash-run:${event.userId}`, {
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
    const activeRun = this.runner.activeRuns.get(key);
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
    const runVersionAtStart = this.runner.channelRunVersions.get(versionKey) ?? 0;
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

    const noNewChannelRun = (this.runner.channelRunVersions.get(versionKey) ?? 0) === runVersionAtStart;
    if (noNewChannelRun && !this.runner.activeRuns.has(runKey(input.guildId))) {
      this.runner.startChannelRunBackground(input.guildId, input.channelId, "reviewer-complete");
    } else if (noNewChannelRun && input.triggerAfterActiveRun) {
      setTimeout(() => {
        if ((this.runner.channelRunVersions.get(versionKey) ?? 0) === runVersionAtStart && !this.runner.activeRuns.has(runKey(input.guildId))) {
          this.runner.startChannelRunBackground(input.guildId, input.channelId, "reviewer-complete");
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
