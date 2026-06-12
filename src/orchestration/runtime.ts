import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Logger } from "../backend/logger.js";
import {
  DiscordClearCommandEvent,
  DiscordClearType,
  DiscordAutocompleteChoice,
  DiscordDebugCommandEvent,
  DiscordGatewayFacade,
  DiscordMemoriesCommandEvent,
  DiscordMessageEvent,
  DiscordPrintCommandEvent,
  DiscordPrintWaifuAutocompleteEvent,
  DiscordRunCommandEvent,
  DiscordRunWaifuAutocompleteEvent,
  DiscordReviewCommandEvent,
  DiscordStopCommandEvent
} from "../discord/client.js";
import { dedupeNames, modelVisibleEmojiToken, stripLeakedContextHeader } from "../discord/normalization.js";
import { splitWaifuReply, typingDelayMs } from "./messageSplit.js";
import {
  PromptBlockContext,
  assembleWaifuPrompt,
  promptTagName,
  reconcileWaifuPromptLayout
} from "./promptBlocks.js";
import { ReplyQuoteExtraction, extractReplyQuote } from "./replyQuote.js";
import { getModel } from "../providers/catalog.js";
import { createModelPipeline, PipelineCredentials, ProviderPipelineError } from "../providers/pipelines.js";
import { ModelPipeline, StageManagerMemory, WaifuGenerationResult } from "../providers/types.js";
import {
  ActiveChatParticipant,
  ActiveChatParticipantsFile,
  ActiveChatParticipantsFileSchema,
  AgentConfig,
  AgentConfigSchema,
  DiscordBotsFileSchema,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  MemoryStore,
  MemoryStoreSchema,
  OrchestratorDebugConfigFileSchema,
  OrchestratorDecisionHistoryEntry,
  OrchestratorDecisionStatus,
  OrchestratorResponderOutcome,
  OrchestratorHistoryFileSchema,
  OrchestratorRespondingWaifu,
  ProviderCredentialsFile,
  ProviderCredentialsFileSchema,
  ReviewerHistoryFileSchema,
  MemoryRecord,
  ServerConfig,
  ServerConfigSchema,
  StageManagerHistoryFileSchema,
  WaifuConfig,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { extractEntities, WAIFU_NOTE_STRENGTH } from "./memoryEntities.js";
import { createRevisionedBase, nowIso } from "../shared/schemas/common.js";
import { StorageService } from "../storage/storageService.js";
import { StageManagerObservation, StageManagerToolCall } from "./stageManager.js";
import {
  ChannelSessionState,
  ChannelSessionStateSchema,
  createEmptyChannelSessionState
} from "./session.js";
import { ContextMessage, OrchestratorWakeMarker, formatTimestamp } from "./context.js";
import {
  DIRECTIVE_GOAL_MAX_CHARS,
  DirectiveIntent,
  MAX_WAIFU_DELAY_SECONDS,
  OrchestratorDecision,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS
} from "./decisions.js";
import { assessLoop } from "./loopDetector.js";

export type RuntimeOrchestratorOptions = {
  storage: StorageService;
  discord: DiscordGatewayFacade;
  logger: Logger;
  maxAutomaticTurns?: number;
  isPaused?: () => boolean;
  onActiveRunsChange?: (activeRuns: number) => void;
  createPipeline?: (modelId: string, credentials: PipelineCredentials) => ModelPipeline;
  ocr?: {
    enrichMessages(messages: ContextMessage[], options?: { signal?: AbortSignal }): Promise<ContextMessage[]>;
    dispose?(): Promise<void>;
  };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  stageManagerIdleDelayMs?: number;
};

type ActiveChannelRun = {
  guildId: string;
  channelId: string;
  controller: AbortController;
  promise: Promise<void>;
};

type ChannelRunOptions = {
  initialResponders?: OrchestratorRespondingWaifu[];
  initialReason?: string;
  firstOrchestratorMustReply?: boolean;
  firstResponderSceneDirectionOverride?: string;
  trigger?: "message" | "retrigger" | "manual";
};

type ExecuteResponderDecisionInput = {
  guildId: string;
  channelId: string;
  server: ServerConfig;
  channel: ServerConfig["channels"][string];
  decision: OrchestratorDecision;
  decisionId: string;
  responderOutcomes: OrchestratorResponderOutcome[];
  decisionDelayBaseMs: number;
  useDecisionRelativeDelays: boolean;
  availableWaifus: WaifuConfig[];
  signal: AbortSignal;
};

type ResponderQueueEntry = {
  responder: OrchestratorRespondingWaifu;
  outcomeId: string;
};

export type StageManagerRunResult = {
  status: "updated" | "no_change" | "already_running" | "disabled" | "failed";
  message?: string;
};

type StageManagerSchedule = {
  idleTimer?: NodeJS.Timeout;
};

type StageManagerDebugEntry = {
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  summary: string;
};

type WaifuPromptDebugParts = {
  waifuDisplayName: string;
  systemPrompt: string;
  midSystemBlock: string;
  trailingSystemBlock: string;
};

export class RuntimeOrchestrator {
  private readonly activeRuns = new Map<string, ActiveChannelRun>();
  private readonly retriggerTimers = new Map<string, NodeJS.Timeout>();
  private readonly stageManagerSchedules = new Map<string, StageManagerSchedule>();
  private readonly activeStageManagerRuns = new Set<Promise<StageManagerRunResult>>();
  private readonly maxAutomaticTurns: number;
  private readonly createPipeline: (modelId: string, credentials: PipelineCredentials) => ModelPipeline;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly stageManagerIdleDelayMs: number;
  private readonly recentSelfSentIds = new Map<string, number>();
  private readonly activeWaifuSendChannels = new Set<string>();
  private readonly activeWaifuQueries = new Map<string, number>();
  private readonly activeReviewerRuns = new Map<string, number>();
  private readonly channelRunVersions = new Map<string, number>();
  // One-shot: when a waifu in this channel just emitted a tool-only reply
  // (add_memory call with no Discord text), drop the memory tool from the
  // next decision so the chain doesn't loop on silent memory-tool turns.
  private readonly suppressMemoryToolOnce = new Set<string>();
  // Per-channel directive budget counter. Increments each decision a directive is not honored,
  // resets to 0 when one is honored; the budget opens once it reaches directiveCooldown.
  private readonly directiveDecisionCounts = new Map<string, number>();
  private static readonly SELF_SENT_TTL_MS = 60_000;
  private static readonly STAGE_MANAGER_IDLE_DELAY_MS = 60 * 60 * 1000;
  private static readonly ACTIVE_CHAT_PARTICIPANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  private unsubscribes: Array<() => void> = [];

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.maxAutomaticTurns = options.maxAutomaticTurns ?? 8;
    this.createPipeline = options.createPipeline ?? createModelPipeline;
    this.sleep = options.sleep ?? defaultSleep;
    this.stageManagerIdleDelayMs =
      options.stageManagerIdleDelayMs ?? RuntimeOrchestrator.STAGE_MANAGER_IDLE_DELAY_MS;
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
      await this.syncGuilds();
    }
    await this.healPendingOrchestratorDecisions();
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    await this.pause();
    await this.options.ocr?.dispose?.();
  }

  async pause(): Promise<void> {
    for (const timer of this.retriggerTimers.values()) {
      clearTimeout(timer);
    }
    this.retriggerTimers.clear();
    this.clearAllStageManagerTimers();
    for (const run of this.activeRuns.values()) {
      run.controller.abort(new Error("runtime paused"));
    }
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.promise));
    this.activeRuns.clear();
    await Promise.allSettled([...this.activeStageManagerRuns]);
    this.options.onActiveRunsChange?.(0);
  }

  private runBackground(
    label: string,
    context: Record<string, unknown>,
    task: () => void | Promise<unknown>
  ): void {
    void Promise.resolve()
      .then(task)
      .catch((error) => {
        this.options.logger.error(label, {
          ...context,
          message: error instanceof Error ? error.message : String(error)
        });
      });
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
      this.markSessionIdle(guildId, channelId)
    );
  }

  async handleDiscordMessage(event: DiscordMessageEvent): Promise<void> {
    if (!event.guildId || !event.channelId) return;
    if (this.wasSelfSent(event.messageId)) {
      return;
    }
    if (event.authorBot && this.activeWaifuSendChannels.has(event.channelId)) {
      return;
    }
    if (!event.authorBot) {
      void this.noteActiveChatParticipant(event.guildId, event.channelId, {
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
      await this.ensureChannelSession(event.guildId, event.channelId);
      return;
    }
    const server = await this.ensureServer(event.guildId);
    const serverWithChannel = await this.ensureChannelConfig(server, event.channelId);
    const channel = serverWithChannel.channels[event.channelId];
    if (!this.channelHasWaifus(channel)) {
      this.options.logger.info("Discord message observed in inactive channel; enable at least one waifu in Servers", {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId
      });
      await this.ensureChannelSession(event.guildId, event.channelId);
      return;
    }
    if (event.authorBot && !(await this.isKnownWaifuAuthor(event.authorId))) {
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
    this.noteStageManagerActivity(event.guildId, event.channelId);
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
      await this.clearScheduledRetrigger(guildId, channelId);
    }
    this.clearStageManagerTimers(guildId, channelId);

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
    return this.startStageManagerRun(guildId, channelId);
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
      const server = await this.ensureServer(event.guildId);
      const channel = server.channels[event.channelId];
      if (!this.channelHasWaifus(channel)) {
        await event.respond([]);
        return;
      }
      const query = normalizeRunWaifuName(event.focusedValue);
      const choices = (await this.listAvailableWaifusForChannel(channel))
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
      const server = await this.ensureServer(event.guildId);
      const query = normalizeRunWaifuName(event.focusedValue);
      const choices = (await this.listAvailableWaifusForGuild(server))
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
        await event.respond("Stage manager updated memories.");
      } else if (result.status === "no_change") {
        await event.respond("Stage manager found no memory changes.");
      } else if (result.status === "already_running") {
        await event.respond("Stage manager is already running in this channel.");
      } else if (result.status === "disabled") {
        await event.respond("Stage manager is disabled or missing a model.");
      } else {
        await event.respond(result.message ?? "Stage manager failed. Check logs.");
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
      const server = await this.ensureServer(event.guildId);
      const availableWaifus = await this.listAvailableWaifusForGuild(server);
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
      const { systemPrompt, midSystemBlock, trailingSystemBlock } = await this.buildWaifuPromptParts(
        input.guildId,
        input.waifu,
        input.availableWaifus,
        {
          channelId: input.channelId,
          pickNextWaifuToolOverride: input.server.tools.pickNextWaifu,
          shortTermMemoryToolOverride: input.server.tools.shortTermMemory
        }
      );
      return formatWaifuPromptDebugMessages({
        waifuDisplayName: input.waifu.displayName,
        systemPrompt,
        midSystemBlock,
        trailingSystemBlock
      });
    }
    if (input.type === "memories") {
      const content = await this.modelVisibleMemoryBlockForPrint(input.guildId, input.channelId, input.waifu);
      return formatPrintDebugBlock(`Memories (${input.waifu.displayName})`, content);
    }
    return formatPrintDebugBlock(
      `Personality (${input.waifu.displayName})`,
      input.waifu.persona.trim() || "(no personality configured)"
    );
  }

  private async modelVisibleMemoryBlockForPrint(
    guildId: string,
    _channelId: string,
    waifu: WaifuConfig
  ): Promise<string> {
    const now = Date.now();
    const store = await this.readMemoryStore();
    const lines = injectAllMemoryLines(store.memories, guildId, waifu.id, now);
    if (lines.length === 0) {
      return "(none)";
    }
    const waifuTag = promptTagName(waifu.name || waifu.id);
    return `<${waifuTag}_relevant_memories>\n${lines.join("\n")}\n</${waifuTag}_relevant_memories>`;
  }

  private async handleDebugCommand(event: DiscordDebugCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Debug type is required. Choose set or unset.");
        return;
      }
      if (event.type === "print") {
        await event.respond("/console print is deprecated. Use /print instead.");
        return;
      }
      const sourceChannelId = event.sourceChannelId?.trim();
      if (!sourceChannelId) {
        await event.respond("Source channel ID is required for set and unset.");
        return;
      }
      if (event.type === "unset") {
        const removed = await this.unsetDebugRoute(sourceChannelId);
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
      await this.setDebugRoute({
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
    if ((this.activeWaifuQueries.get(key) ?? 0) > 0) {
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
    const key = runKey(guildId);
    const versionKey = timerKey(guildId, channelId);
    this.channelRunVersions.set(versionKey, (this.channelRunVersions.get(versionKey) ?? 0) + 1);
    const existing = this.activeRuns.get(key);
    if (existing) {
      this.options.logger.info("Restarting active channel run", {
        guildId,
        channelId,
        previousChannelId: existing.channelId,
        reason
      });
      existing.controller.abort(new Error(`restarted by ${reason}`));
      this.markSessionIdleBackground(existing.guildId, existing.channelId, `restarted by ${reason}`);
    }
    this.clearRetriggerTimer(guildId, channelId);

    const controller = new AbortController();
    const promise = this.runChannelLoop(guildId, channelId, controller.signal, options)
      .catch((error) => {
        if (controller.signal.aborted) return;
        this.options.logger.error("Channel runtime loop failed", {
          guildId,
          channelId,
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof ProviderPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
        });
      })
      .finally(async () => {
        if (this.activeRuns.get(key)?.controller === controller) {
          this.activeRuns.delete(key);
          this.options.onActiveRunsChange?.(this.activeRuns.size);
          try {
            await this.markSessionIdle(guildId, channelId);
          } catch (error) {
            this.options.logger.error("Failed to mark session idle", {
              guildId,
              channelId,
              reason,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
      });
    this.activeRuns.set(key, { guildId, channelId, controller, promise });
    this.options.onActiveRunsChange?.(this.activeRuns.size);
    this.options.logger.info("Channel runtime loop started", { guildId, channelId, reason });
    await promise;
  }

  private async runChannelLoop(
    guildId: string,
    channelId: string,
    signal: AbortSignal,
    options: ChannelRunOptions = {}
  ): Promise<void> {
    let turns = 0;
    if (options.initialResponders?.length) {
      const server = await this.ensureServer(guildId);
      const channel = server.channels[channelId];
      if (!this.channelHasWaifus(channel)) {
        this.options.logger.info("Directed channel run stopped because no waifus are enabled for channel", {
          guildId,
          channelId
        });
        return;
      }
      const availableWaifus = await this.listAvailableWaifusForChannel(channel);
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
      const executedCount = await this.executeResponderDecision({
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
      if (executedCount === 0) {
        this.options.logger.info("Directed channel run stopped because no responders were executed", {
          guildId,
          channelId
        });
        return;
      }
    }

    await this.setActivePipeline(guildId, channelId, "orchestrator");
    while (turns < this.maxAutomaticTurns) {
      throwIfAborted(signal);
      turns += 1;
      const server = await this.ensureServer(guildId);
      const channel = server.channels[channelId];
      if (!this.channelHasWaifus(channel)) {
        this.options.logger.info("Channel runtime loop stopped because no waifus are enabled for channel", {
          guildId,
          channelId
        });
        return;
      }

      const orchestrator = await this.readAgentConfig("orchestrator", 40);
      if (!orchestrator.modelId) {
        this.options.logger.warn("Orchestrator model is not configured; channel loop stopped", { guildId, channelId });
        return;
      }
      let messages = await this.options.discord.fetchFreshContext({
        guildId,
        channelId,
        limit: server.contextWindows.orchestrator ?? orchestrator.contextWindow,
        signal
      });
      await this.noteActiveChatParticipantsFromContext(guildId, channelId, messages);
      messages = await this.messagesForModel(messages, orchestrator.modelId, signal);
      this.options.logger.info("Fetched Discord context for orchestrator", {
        guildId,
        channelId,
        messageCount: messages.length,
        modelId: orchestrator.modelId
      });
      const pipeline = await this.pipelineFor(orchestrator.modelId);
      if (!pipeline.decideOrchestrator) {
        throw new Error(`Model ${orchestrator.modelId} does not implement orchestrator decisions.`);
      }
      const availableWaifus = await this.listAvailableWaifusForChannel(channel);
      const pastDecisions = await this.readCompletedOrchestratorDecisionsForChannel(guildId, channelId);
      const requireReply = Boolean(options.firstOrchestratorMustReply && turns === 1);

      const loop = assessLoop(messages);
      const channelKey = timerKey(guildId, channelId);
      const directiveCount = this.directiveDecisionCounts.get(channelKey) ?? orchestrator.directiveCooldown;
      const directiveBudgetOpen = loop.suspected || directiveCount >= orchestrator.directiveCooldown;

      // On the first turn of a timer-fired retrigger, surface the wake marker (with the wake plan
      // the orchestrator promised last time) so it can pick up where it left off, plus escalate the
      // next backoff if it chooses no_reply again.
      let decisionMarkers: OrchestratorWakeMarker[] | undefined;
      // pastDecisions is newest-first (history file prepends); find() returns the most recent no_reply.
      const lastNoReply = pastDecisions.find((entry) => entry.action === "no_reply");
      const timerWakeSeconds =
        turns === 1 && options.trigger === "retrigger" ? lastNoReply?.retriggerAfterSeconds : undefined;
      if (timerWakeSeconds) {
        decisionMarkers = [{
          kind: "wake",
          timestamp: formatTimestamp(new Date()),
          scheduledSeconds: timerWakeSeconds,
          wakePlan: lastNoReply!.wakePlan
        }];
      }

      const trailingPrompt = this.buildOrchestratorTrailingPrompt(
        orchestrator,
        availableWaifus,
        requireReply,
        loop.notice
      );
      const orchestratorTyping = startTypingScope(this.options.discord, { guildId, channelId });
      let decision: OrchestratorDecision;
      try {
        decision = await pipeline.decideOrchestrator({
          modelId: orchestrator.modelId,
          messages,
          pastDecisions,
          decisionMarkers,
          directiveBudgetOpen,
          trailingPrompt,
          systemPrompt: this.buildOrchestratorSystemPrompt(orchestrator, server, requireReply),
          availableWaifuIds: availableWaifus.map((waifu) => waifu.id),
          replyRequired: requireReply,
          reasoning: orchestrator.reasoning,
          signal
        });
      } finally {
        orchestratorTyping.stop();
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
        loopSuspected: loop.suspected
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
          await this.updateOrchestratorResponderOutcome(decisionId, outcome.id, {
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
      void this.sendOrchestratorDebugLog({
        guildId,
        channelId,
        decision,
        availableWaifus
      });

      if (decision.action === "no_reply") {
        let seconds = decision.retriggerAfterSeconds ?? RETRIGGER_MIN_SECONDS;
        if (timerWakeSeconds) {
          seconds = Math.max(seconds, Math.ceil(timerWakeSeconds * 1.5));
        }
        await this.scheduleRetrigger(guildId, channelId, seconds);
        return;
      }

      const executedCount = await this.executeResponderDecision({
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
      if (executedCount === 0) {
        this.options.logger.info("Channel runtime loop stopped because no responders were executed", {
          guildId,
          channelId
        });
        return;
      }
      await this.setActivePipeline(guildId, channelId, "orchestrator");
    }

    this.options.logger.warn("Automatic turn limit reached; scheduling cooldown", {
      guildId,
      channelId,
      maxAutomaticTurns: this.maxAutomaticTurns
    });
    await this.scheduleRetrigger(guildId, channelId, RETRIGGER_MIN_SECONDS);
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
    await this.appendOrchestratorHistory({
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

  private async executeResponderDecision(input: ExecuteResponderDecisionInput): Promise<number> {
    let executedCount = 0;
    let directHandoffCount = 0;
    const allowedWaifus = new Set(input.channel.enabledWaifuIds ?? []);
    const responderQueue: ResponderQueueEntry[] = input.decision.respondingWaifus.map(
      (responder, index) => ({
        responder,
        outcomeId: input.responderOutcomes[index].id
      })
    );
    let responderIndex = 0;
    let decisionFinalized = false;
    let currentOutcomeId: string | undefined;
    let currentOutcomeFinalized = false;
    const channelKey = timerKey(input.guildId, input.channelId);
    const suppressMemoryToolThisDecision = this.suppressMemoryToolOnce.has(channelKey);
    this.suppressMemoryToolOnce.delete(channelKey);
    if (suppressMemoryToolThisDecision) {
      this.options.logger.info("Suppressing add_memory tool for this decision (previous turn was tool-only)", {
        guildId: input.guildId,
        channelId: input.channelId
      });
    }
    try {
      while (responderQueue.length > 0) {
        throwIfAborted(input.signal);
        const queueEntry = responderQueue.shift();
        if (!queueEntry) continue;
        const { responder, outcomeId } = queueEntry;
        currentOutcomeId = outcomeId;
        currentOutcomeFinalized = false;
        const currentResponderIndex = responderIndex;
        responderIndex += 1;
        if (!allowedWaifus.has(responder.waifuId)) {
          this.options.logger.warn("Orchestrator selected a waifu that is not enabled for channel", {
            guildId: input.guildId,
            channelId: input.channelId,
            selectedWaifuId: responder.waifuId
          });
          await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
            status: "unavailable",
            reason: "not_enabled_for_channel"
          });
          currentOutcomeFinalized = true;
          continue;
        }
        const waifu = await this.readWaifu(responder.waifuId).catch(() => undefined);
        if (!waifu) {
          this.options.logger.warn("Orchestrator selected an unknown waifu", {
            guildId: input.guildId,
            channelId: input.channelId,
            selectedWaifuId: responder.waifuId
          });
          await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
            status: "unavailable",
            reason: "unknown_waifu"
          });
          currentOutcomeFinalized = true;
          continue;
        }
        if (!waifu.enabled) {
          this.options.logger.warn("Orchestrator selected a disabled waifu", {
            guildId: input.guildId,
            channelId: input.channelId,
            selectedWaifuId: responder.waifuId
          });
          await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
            status: "unavailable",
            reason: "disabled"
          });
          currentOutcomeFinalized = true;
          continue;
        }
        if (!waifu.botId) {
          this.options.logger.warn("Orchestrator selected a waifu without a linked Discord bot", {
            guildId: input.guildId,
            channelId: input.channelId,
            selectedWaifuId: responder.waifuId
          });
          await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
            status: "unavailable",
            reason: "missing_discord_bot"
          });
          currentOutcomeFinalized = true;
          continue;
        }
        if (!waifu.modelId) {
          this.options.logger.warn("Orchestrator selected a waifu without a configured model", {
            guildId: input.guildId,
            channelId: input.channelId,
            selectedWaifuId: responder.waifuId
          });
          await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
            status: "unavailable",
            reason: "missing_model"
          });
          currentOutcomeFinalized = true;
          continue;
        }
        const waitMs = waitMsBeforeWaifuReply({
          delaySeconds: responder.delaySeconds,
          decisionDelayBaseMs: input.decisionDelayBaseMs,
          responderIndex: currentResponderIndex,
          useDecisionRelativeDelays: input.useDecisionRelativeDelays
        });
        if (waitMs > 0) {
          this.options.logger.info("Waiting before waifu reply", {
            guildId: input.guildId,
            channelId: input.channelId,
            waifuId: waifu.id,
            plannedDelaySeconds: responder.delaySeconds,
            waitMs,
            delayMode: input.useDecisionRelativeDelays ? "decision-relative" : "sequential"
          });
          await this.sleep(waitMs, input.signal);
          throwIfAborted(input.signal);
        }
        await this.setActivePipeline(input.guildId, input.channelId, "waifu");
        const waifuModelId = waifu.modelId;
        let waifuMessages = await this.options.discord.fetchFreshContext({
          guildId: input.guildId,
          channelId: input.channelId,
          limit: waifu.contextWindow || input.server.contextWindows.waifu,
          signal: input.signal
        });
        await this.noteActiveChatParticipantsFromContext(input.guildId, input.channelId, waifuMessages);
        const activeChatParticipants = await this.readActiveChatParticipants(input.guildId, input.channelId);
        waifuMessages = await this.messagesForModel(waifuMessages, waifuModelId, input.signal);
        const waifuPipeline = await this.pipelineFor(waifu.modelId);
        this.options.logger.info("Generating waifu reply", {
          guildId: input.guildId,
          channelId: input.channelId,
          waifuId: waifu.id,
          modelId: waifu.modelId,
          messageCount: waifuMessages.length
        });
        const waifuTyping = startTypingScope(this.options.discord, {
          guildId: input.guildId,
          channelId: input.channelId,
          senderBotId: waifu.botId
        });
        try {
          const nextWaifuIds = input.availableWaifus
            .filter((candidate) => candidate.id !== waifu.id && candidate.botId && candidate.modelId)
            .map((candidate) => candidate.id);
          const waifuQueryKey = runKey(input.guildId);
          const participantDisplayNames = waifuParticipantDisplayNames(
            waifu,
            input.availableWaifus,
            waifuMessages,
            activeChatParticipants
          );
          const waifuStopSequences = participantDisplayNames.map((name) => `\n${name}:`);
          const selfAuthorIds = [waifu.botId];
          const selfDisplayNames = dedupeNames([
            waifu.displayName,
            waifu.name,
            ...waifuMessages
              .filter((message) => message.authorId === waifu.botId)
              .flatMap((message) => [message.displayName, message.name])
          ]);
          const directiveText = directiveTextForWaifu(responder.directive);
          const effectiveShortTermMemory = input.server.tools.shortTermMemory && !suppressMemoryToolThisDecision;
          const { systemPrompt, midSystemBlock, trailingSystemBlock, selfGuildNickname } = await this.buildWaifuPromptParts(
            input.guildId,
            waifu,
            input.availableWaifus,
            {
              channelId: input.channelId,
              directorNote: directiveText,
              pickNextWaifuToolOverride: input.server.tools.pickNextWaifu,
              shortTermMemoryToolOverride: effectiveShortTermMemory
            }
          );
          const allSelfDisplayNames = selfGuildNickname
            ? dedupeNames([...selfDisplayNames, selfGuildNickname])
            : selfDisplayNames;
          const activeAuthorIds = waifuMessages.map((message) => message.authorId);
          const MAX_GENERATE_ATTEMPTS = 2;
          let result: WaifuGenerationResult = { content: "" };
          let strippedContent = "";
          let quoteExtraction: ReplyQuoteExtraction = {
            replyToMessageId: undefined,
            cleanedContent: ""
          };
          let chunks: string[] = [];
          let attemptsRun = 0;
          for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
            attemptsRun = attempt;
            incrementActive(this.activeWaifuQueries, waifuQueryKey);
            result = await (async () => {
              try {
                return await waifuPipeline.generateWaifu({
                  modelId: waifuModelId,
                  messages: waifuMessages,
                  systemPrompt,
                  midSystemBlock,
                  trailingSystemBlock,
                  retryUserMessage: attempt === 2 ? `${waifu.displayName}:` : undefined,
                  selfAuthorIds,
                  availableWaifuIds: nextWaifuIds,
                  pickNextWaifuToolEnabled: input.server.tools.pickNextWaifu,
                  shortTermMemoryToolEnabled: effectiveShortTermMemory,
                  temperature: waifu.generation.temperature,
                  topP: waifu.generation.topP,
                  maxOutputTokens: waifu.generation.maxOutputTokens,
                  reasoning: waifu.reasoning,
                  stopSequences: waifuStopSequences,
                  signal: input.signal
                });
              } finally {
                decrementActive(this.activeWaifuQueries, waifuQueryKey);
              }
            })();
            const metadataStrippedContent = stripLeakedContextHeader(result.content, {
              selfDisplayNames: allSelfDisplayNames,
              participantDisplayNames,
              stripImpersonation: false
            });
            const metadataStripped = metadataStrippedContent !== result.content;
            quoteExtraction = extractReplyQuote(metadataStrippedContent, waifuMessages);
            const replyQuoteExtracted = quoteExtraction.cleanedContent !== metadataStrippedContent;
            strippedContent = stripLeakedContextHeader(quoteExtraction.cleanedContent, {
              selfDisplayNames: allSelfDisplayNames,
              participantDisplayNames
            });
            const impersonationStripped = strippedContent !== quoteExtraction.cleanedContent;
            const strippedLeakedContent = metadataStripped || impersonationStripped;
            if (strippedLeakedContent) {
              this.options.logger.warn("Stripped leaked context header from waifu reply", {
                guildId: input.guildId,
                channelId: input.channelId,
                waifuId: waifu.id,
                attempt,
                before: result.content.slice(0, 80),
                after: strippedContent.slice(0, 80)
              });
            }
            if (replyQuoteExtracted) {
              this.options.logger.info("Extracted leading reply quote from waifu reply", {
                guildId: input.guildId,
                channelId: input.channelId,
                waifuId: waifu.id,
                attempt,
                matchedMessageId: quoteExtraction.replyToMessageId ?? null,
                quotePreview: metadataStrippedContent.slice(0, 120)
              });
            }
            chunks = splitWaifuReply(strippedContent);
            const becameEmptyDueToCleaning =
              chunks.length === 0 &&
              result.content.trim().length > 0 &&
              (metadataStripped || replyQuoteExtracted || impersonationStripped);
            if (!becameEmptyDueToCleaning || attempt === MAX_GENERATE_ATTEMPTS) break;
            this.options.logger.warn("Waifu reply was entirely removed during cleaning; retrying once", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              metadataStripped,
              replyQuoteExtracted,
              impersonationStripped,
              originalPreview: result.content.slice(0, 120)
            });
          }
          const usedToolWithoutVisibleMessage =
            Boolean(result.shortTermMemoryEntries?.length && effectiveShortTermMemory) ||
            Boolean(result.pickedNextWaifuId);
          if (chunks.length === 0 && !usedToolWithoutVisibleMessage) {
            this.options.logger.warn("Waifu reply was empty after cleaning; nothing sent", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              attempts: attemptsRun,
              lastOriginalPreview: result.content.slice(0, 120)
            });
          }
          const chosenReplyTarget = quoteExtraction.replyToMessageId ?? responder.replyToMessageId;
          const replyToMessageId = replyTargetForFreshContext(chosenReplyTarget, waifuMessages);
          if (chosenReplyTarget && !replyToMessageId) {
            this.options.logger.info("Omitting reply target because it is unavailable or the latest context message", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              replyToMessageId: chosenReplyTarget
            });
          }
          const sentMessageIds = await this.sendWaifuChunks({
            guildId: input.guildId,
            channelId: input.channelId,
            waifuId: waifu.id,
            senderBotId: waifu.botId,
            chunks,
            replyToMessageId,
            allowedUserMentionIds: activeAuthorIds,
            orchestratorDecisionId: input.decisionId,
            responderOutcomeId: outcomeId,
            signal: input.signal
          });
          if (sentMessageIds.length > 0) {
            await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
              status: "sent"
            });
            currentOutcomeFinalized = true;
          }
          if (result.shortTermMemoryEntries?.length && effectiveShortTermMemory) {
            await this.recordWaifuNotes({
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              entries: result.shortTermMemoryEntries
            });
            if (chunks.length === 0) {
              this.suppressMemoryToolOnce.add(channelKey);
              this.options.logger.info("Waifu tool-only reply detected; suppressing add_memory tool on next decision", {
                guildId: input.guildId,
                channelId: input.channelId,
                waifuId: waifu.id
              });
            }
          }
          if (sentMessageIds.length === 0) {
            await this.updateOrchestratorResponderOutcome(input.decisionId, outcomeId, {
              status: usedToolWithoutVisibleMessage ? "tool_only" : "empty",
              reason: usedToolWithoutVisibleMessage ? undefined : "empty_after_cleaning"
            });
            currentOutcomeFinalized = true;
          }
          if (result.rejectedPickNextWaifu) {
            this.options.logger.warn("Ignoring invalid PickNextWaifu call from waifu", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              attemptedWaifuId: result.rejectedPickNextWaifu.waifuId,
              attemptedSelfPick: result.rejectedPickNextWaifu.waifuId === waifu.id,
              reason: result.rejectedPickNextWaifu.reason
            });
          } else if (result.pickedNextWaifuId && directHandoffCount < this.maxAutomaticTurns) {
            directHandoffCount += 1;
            this.options.logger.info("Waifu picked next waifu; skipping orchestrator for direct handoff", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              pickedNextWaifuId: result.pickedNextWaifuId
            });
            const existingQueueIndex = responderQueue.findIndex(
              (entry) => entry.responder.waifuId === result.pickedNextWaifuId
            );
            if (existingQueueIndex >= 0) {
              const [existingQueueEntry] = responderQueue.splice(existingQueueIndex, 1);
              existingQueueEntry.responder = {
                ...existingQueueEntry.responder,
                delaySeconds: 0
              };
              responderQueue.unshift(existingQueueEntry);
              await this.moveOrchestratorResponderOutcomeAfter(
                input.decisionId,
                outcomeId,
                existingQueueEntry.outcomeId,
                waifu.id
              );
            } else {
              const handoffOutcome: OrchestratorResponderOutcome = {
                id: randomUUID(),
                waifuId: result.pickedNextWaifuId,
                source: "handoff",
                handoffFromWaifuId: waifu.id,
                status: "pending",
                messageIds: []
              };
              await this.insertOrchestratorResponderOutcomeAfter(
                input.decisionId,
                outcomeId,
                handoffOutcome
              );
              responderQueue.unshift({
                responder: {
                  waifuId: result.pickedNextWaifuId,
                  delaySeconds: 0
                },
                outcomeId: handoffOutcome.id
              });
            }
          } else if (result.pickedNextWaifuId) {
            this.options.logger.warn("Ignoring PickNextWaifu handoff because the automatic handoff limit was reached", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              pickedNextWaifuId: result.pickedNextWaifuId,
              maxAutomaticTurns: this.maxAutomaticTurns
            });
          }
        } finally {
          waifuTyping.stop();
        }
        executedCount += 1;
        currentOutcomeId = undefined;
        currentOutcomeFinalized = false;
      }
      await this.updateOrchestratorDecisionStatus(input.decisionId, "completed");
      decisionFinalized = true;
    } catch (error) {
      if (!decisionFinalized) {
        const status: OrchestratorDecisionStatus = input.signal.aborted ? "interrupted" : "failed";
        try {
          await this.finalizeOrchestratorDecisionAfterError({
            decisionId: input.decisionId,
            status,
            currentOutcomeId: currentOutcomeFinalized ? undefined : currentOutcomeId,
            reason: error instanceof Error ? error.message : String(error)
          });
        } catch (writeError) {
          this.options.logger.warn("Failed to finalize orchestrator decision status after error", {
            guildId: input.guildId,
            channelId: input.channelId,
            decisionId: input.decisionId,
            status,
            message: writeError instanceof Error ? writeError.message : String(writeError)
          });
        }
      }
      throw error;
    }
    return executedCount;
  }

  private noteStageManagerActivity(guildId: string, channelId: string): void {
    const key = timerKey(guildId, channelId);
    const schedule = this.stageManagerSchedules.get(key) ?? {};
    this.stageManagerSchedules.set(key, schedule);

    if (schedule.idleTimer) {
      clearTimeout(schedule.idleTimer);
    }
    schedule.idleTimer = setTimeout(() => {
      const current = this.stageManagerSchedules.get(key);
      if (!current) return;
      current.idleTimer = undefined;
      this.stageManagerSchedules.delete(key);
      this.runBackground("Scheduled stage manager run failed", { guildId, channelId }, () =>
        this.startStageManagerRun(guildId, channelId)
      );
    }, this.stageManagerIdleDelayMs);
  }

  private async runStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    const state = await this.ensureChannelSession(guildId, channelId);
    if (state.stageManager.active) {
      return { status: "already_running" };
    }
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      stageManager: { active: true, startedAt: nowIso() }
    }));
    try {
      const server = await this.ensureServer(guildId);
      const config = await this.readAgentConfig("stage-manager", 80);
      if (!config.enabled || !config.modelId) {
        return { status: "disabled" };
      }
      const pipeline = await this.pipelineFor(config.modelId);
      if (!pipeline.decideStageManagerObservations || !pipeline.decideStageManager) {
        throw new Error(`Model ${config.modelId} does not implement stage-manager decisions.`);
      }
      const channel = server.channels[channelId];
      const availableWaifus = channel ? await this.listAvailableWaifusForChannel(channel) : [];
      const allowedWaifuIds = availableWaifus.map((waifu) => waifu.id);
      let messages = await this.options.discord.fetchFreshContext({
        guildId,
        channelId,
        limit: server.contextWindows.stageManager ?? config.contextWindow
      });
      messages = await this.messagesForModel(messages, config.modelId);

      this.options.logger.info("Stage manager observer started", {
        guildId,
        channelId,
        modelId: config.modelId,
        contextMessages: messages.length
      });
      const observations = await pipeline.decideStageManagerObservations({
        modelId: config.modelId,
        messages,
        availableWaifuIds: allowedWaifuIds,
        reasoning: config.reasoning
      });
      const allowedObservations = observations.filter((observation) => allowedWaifuIds.includes(observation.waifuId));
      this.options.logger.info("Stage manager observer finished", {
        guildId,
        channelId,
        observations: observations.length,
        allowedObservations: allowedObservations.length
      });

      if (allowedObservations.length === 0) {
        const entry = {
          id: randomUUID(),
          guildId,
          channelId,
          tool: "no_change" as const,
          affectedMemoryIds: [] as string[],
          summary: observations.length === 0
            ? "No observations extracted"
            : `Dropped ${observations.length} observation(s) with unknown waifu ids`,
          observationCount: observations.length,
          createdAt: nowIso()
        };
        await this.appendStageManagerHistory(entry);
        void this.sendStageManagerDebugLog({
          guildId,
          channelId,
          entries: [entry],
          observationCount: observations.length
        });
        return { status: "no_change" };
      }

      const store = await this.readMemoryStore();
      const memoryInput = stageManagerMemories(
        store.memories,
        guildId,
        allowedWaifuIds,
        { observations: allowedObservations }
      );
      this.options.logger.info("Stage manager librarian started", {
        guildId,
        channelId,
        modelId: config.modelId,
        observations: allowedObservations.length,
        memories: memoryInput.memories.length
      });
      const calls = await pipeline.decideStageManager({
        modelId: config.modelId,
        messages: [],
        memories: memoryInput.memories,
        observations: allowedObservations,
        availableWaifuIds: allowedWaifuIds,
        reasoning: config.reasoning
      });
      this.options.logger.info("Stage manager librarian finished", {
        guildId,
        channelId,
        calls: calls.length
      });
      const result = await this.applyStageManagerCalls(
        guildId,
        calls,
        memoryInput.memoryIdByIndex,
        allowedWaifuIds
      );
      for (const entry of result.historyEntries) {
        await this.appendStageManagerHistory({
          ...entry,
          guildId,
          channelId,
          observationCount: allowedObservations.length
        });
      }
      void this.sendStageManagerDebugLog({
        guildId,
        channelId,
        entries: result.historyEntries,
        observationCount: allowedObservations.length
      });
      return { status: result.changed ? "updated" : "no_change" };
    } catch (error) {
      this.options.logger.error("Stage manager failed", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof ProviderPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
      });
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Stage manager failed."
      };
    } finally {
      await this.updateSession(guildId, channelId, (current) => ({
        ...current,
        stageManager: { active: false }
      }));
    }
  }

  private startStageManagerRun(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    const promise = this.runStageManager(guildId, channelId);
    this.activeStageManagerRuns.add(promise);
    void promise
      .finally(() => {
        this.activeStageManagerRuns.delete(promise);
      })
      .catch((error) => {
        this.options.logger.error("Stage manager run failed outside handler", {
          guildId,
          channelId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return promise;
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
    const config = await this.readAgentConfig("reviewer", 20);
    if (!config.enabled || !config.modelId) {
      throw new Error("Reviewer model is not configured or enabled.");
    }
    const server = await this.ensureServer(input.guildId);
    const messages = await this.options.discord.fetchFreshContext({
      guildId: input.guildId,
      channelId: input.channelId,
      limit: server.contextWindows.waifu ?? config.contextWindow
    });
    const target = [...messages].reverse().find((message) => message.authorKind === "waifu");
    const messageIds = target ? target.sourceMessageIds ?? [target.id] : [];
    if (!target) {
      await this.appendReviewerHistory({
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
    const pipeline = await this.pipelineFor(config.modelId);
    if (!pipeline.decideReviewer) {
      throw new Error(`Model ${config.modelId} does not implement reviewer decisions.`);
    }
    const decision = await pipeline.decideReviewer({
      modelId: config.modelId,
      messages: [],
      message: target.content,
      systemPrompt: config.prompt || DEFAULT_REVIEWER_PROMPT,
      reasoning: config.reasoning,
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

    await this.appendReviewerHistory({
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
    const server = await this.ensureServer(guildId);
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

  private async applyStageManagerCalls(
    guildId: string,
    calls: StageManagerToolCall[],
    memoryIdByIndex: Map<number, string>,
    allowedWaifuIds: string[]
  ): Promise<{
    changed: boolean;
    historyEntries: Array<{
      id: string;
      tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
      affectedMemoryIds: string[];
      summary: string;
      createdAt: string;
    }>;
  }> {
    const now = nowIso();
    const historyEntries: Array<{
      id: string;
      tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
      affectedMemoryIds: string[];
      summary: string;
      createdAt: string;
    }> = [];
    const allowedWaifus = new Set(allowedWaifuIds);

    const requestedChange = calls.some((call) => call.tool !== "no_change");
    if (!requestedChange) {
      for (const call of calls) {
        if (call.tool === "no_change") {
          historyEntries.push({
            id: randomUUID(),
            tool: call.tool,
            affectedMemoryIds: [],
            summary: call.reason ?? "No memory changes",
            createdAt: now
          });
        }
      }
      return { changed: false, historyEntries };
    }

    let changed = false;
    await this.options.storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      transform: (current) => {
        let memories = [...current.memories];
        for (const call of calls) {
          if (call.tool === "add_memory") {
            if (!allowedWaifus.has(call.memory.waifuId)) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: `Skipped invalid waifu id ${call.memory.waifuId}`,
                createdAt: now
              });
              continue;
            }
            const id = randomUUID();
            memories.push({
              id,
              waifuId: call.memory.waifuId,
              guildId,
              content: call.memory.content,
              kind: "fact" as const,
              source: "stage_manager" as const,
              pinned: false,
              // The librarian still speaks the 1-5 importance scale; map it onto strength.
              strength: call.memory.importance,
              entities: extractEntities(call.memory.content),
              createdAt: now,
              updatedAt: now,
              status: "active"
            });
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [id],
              summary: call.memory.content,
              createdAt: now
            });
            changed = true;
          } else if (call.tool === "update_memory") {
            if (call.patch.waifuId && !allowedWaifus.has(call.patch.waifuId)) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: `Skipped invalid waifu id ${call.patch.waifuId}`,
                createdAt: now
              });
              continue;
            }
            const memoryId = memoryIdByIndex.get(call.memoryIndex);
            if (!memoryId) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: `Skipped unknown memory index #${call.memoryIndex}`,
                createdAt: now
              });
              continue;
            }
            const target = memories.find((memory) => memory.id === memoryId && memory.guildId === guildId);
            if (!target) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: "Skipped memory outside current guild",
                createdAt: now
              });
              continue;
            }
            if (target.pinned) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: "Skipped user-managed pinned memory",
                createdAt: now
              });
              continue;
            }
            const updatedContent = call.patch.content ?? target.content;
            memories = memories.map((memory) => {
              if (memory.id !== memoryId || memory.guildId !== guildId) {
                return memory;
              }
              return {
                ...memory,
                ...(call.patch.waifuId ? { waifuId: call.patch.waifuId } : {}),
                ...(call.patch.content ? { content: call.patch.content, entities: extractEntities(call.patch.content) } : {}),
                // Librarian patch importance (1-5) maps onto stored strength.
                ...(call.patch.importance !== undefined ? { strength: call.patch.importance } : {}),
                updatedAt: now
              };
            });
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [memoryId],
              summary: `Updated memory: ${updatedContent}`,
              createdAt: now
            });
            changed = true;
          } else if (call.tool === "archive_memory") {
            const memoryId = memoryIdByIndex.get(call.memoryIndex);
            if (!memoryId) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: `Skipped unknown memory index #${call.memoryIndex}`,
                createdAt: now
              });
              continue;
            }
            const target = memories.find((memory) => memory.id === memoryId && memory.guildId === guildId);
            if (!target) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: "Skipped memory outside current guild",
                createdAt: now
              });
              continue;
            }
            if (target.pinned) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: "Skipped user-managed pinned memory",
                createdAt: now
              });
              continue;
            }
            memories = memories.map((memory) =>
              memory.id === memoryId && memory.guildId === guildId
                ? { ...memory, status: "archived" as const, updatedAt: now }
                : memory
            );
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [memoryId],
              summary: `Archived memory: ${target.content}`,
              createdAt: now
            });
            changed = true;
          } else if (call.tool === "merge_memories") {
            const id = randomUUID();
            const sourceMemoryIds = memoryIdsForIndices(call.sourceMemoryIndices, memoryIdByIndex);
            const source = memories.filter((memory) => memory.guildId === guildId && sourceMemoryIds.includes(memory.id));
            if (source.length < 2) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: "Skipped merge with unknown or duplicate memory indices",
                createdAt: now
              });
              continue;
            }
            if (source.some((memory) => memory.pinned)) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: "Skipped merge containing a user-managed pinned memory",
                createdAt: now
              });
              continue;
            }
            if (!allowedWaifus.has(source[0].waifuId)) {
              historyEntries.push({
                id: randomUUID(),
                tool: call.tool,
                affectedMemoryIds: [],
                summary: `Skipped invalid waifu id ${source[0].waifuId}`,
                createdAt: now
              });
              continue;
            }
            const sourceIds = new Set(source.map((memory) => memory.id));
            memories = memories
              .map((memory) =>
                memory.guildId === guildId && sourceIds.has(memory.id)
                  ? { ...memory, status: "archived" as const, updatedAt: now }
                  : memory
              )
              .concat({
                id,
                waifuId: source[0].waifuId,
                guildId,
                content: call.mergedContent,
                kind: "fact" as const,
                source: "stage_manager" as const,
                pinned: false,
                strength: Math.max(...source.map((memory) => memory.strength)),
                entities: extractEntities(call.mergedContent),
                createdAt: now,
                updatedAt: now,
                status: "active"
              });
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [id, ...source.map((memory) => memory.id)],
              summary: `Merged memory: ${call.mergedContent}`,
              createdAt: now
            });
            changed = true;
          } else {
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [],
              summary: call.reason ?? "No memory changes",
              createdAt: now
            });
          }
        }
        return { ...current, memories };
      }
    });
    return { changed, historyEntries };
  }

  private async scheduleRetrigger(guildId: string, channelId: string, seconds: number): Promise<void> {
    const bounded = Math.max(RETRIGGER_MIN_SECONDS, Math.min(RETRIGGER_MAX_SECONDS, seconds));
    const key = timerKey(guildId, channelId);
    const at = new Date(Date.now() + bounded * 1000).toISOString();
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      scheduledRetriggerAt: at,
      activePipeline: null
    }));
    const existing = this.retriggerTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.retriggerTimers.delete(key);
      this.startChannelRunBackground(guildId, channelId, "scheduled-retrigger", { trigger: "retrigger" });
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

  private clearStageManagerTimers(guildId: string, channelId: string): void {
    const key = timerKey(guildId, channelId);
    const schedule = this.stageManagerSchedules.get(key);
    if (!schedule) return;
    if (schedule.idleTimer) {
      clearTimeout(schedule.idleTimer);
    }
    this.stageManagerSchedules.delete(key);
  }

  private clearAllStageManagerTimers(): void {
    for (const schedule of this.stageManagerSchedules.values()) {
      if (schedule.idleTimer) {
        clearTimeout(schedule.idleTimer);
      }
    }
    this.stageManagerSchedules.clear();
  }

  private async clearScheduledRetrigger(guildId: string, channelId: string): Promise<void> {
    await this.updateSession(guildId, channelId, (current) => {
      const { scheduledRetriggerAt: _scheduledRetriggerAt, ...rest } = current;
      return {
        ...rest,
        activePipeline: null
      };
    });
  }

  private async sendWaifuChunks(input: {
    guildId: string;
    channelId: string;
    waifuId: string;
    senderBotId: string;
    chunks: string[];
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
    orchestratorDecisionId?: string;
    responderOutcomeId?: string;
    signal?: AbortSignal;
  }): Promise<string[]> {
    if (input.chunks.length === 0) {
      return [];
    }
    const messageIds: string[] = [];
    this.activeWaifuSendChannels.add(input.channelId);
    try {
      for (let i = 0; i < input.chunks.length; i++) {
        throwIfAborted(input.signal);
        if (i > 0) {
          void this.options.discord
            .sendTyping({ guildId: input.guildId, channelId: input.channelId, senderBotId: input.senderBotId })
            .catch(() => undefined);
          await this.sleep(typingDelayMs(input.chunks[i]), input.signal);
        }
        const sentResult = await this.options.discord.sendWaifuMessage({
          guildId: input.guildId,
          channelId: input.channelId,
          senderBotId: input.senderBotId,
          content: input.chunks[i],
          replyToMessageId: i === 0 ? input.replyToMessageId : undefined,
          allowedUserMentionIds: input.allowedUserMentionIds
        });
        this.rememberSelfSent(sentResult.messageId);
        messageIds.push(sentResult.messageId);
        if (input.orchestratorDecisionId) {
          await this.recordOrchestratorDecisionWaifuMessage(
            input.orchestratorDecisionId,
            input.responderOutcomeId,
            sentResult.messageId
          );
        }
        this.options.logger.info("Waifu message chunk sent", {
          guildId: input.guildId,
          channelId: input.channelId,
          waifuId: input.waifuId,
          chunkIndex: i,
          chunkCount: input.chunks.length,
          chunkLength: input.chunks[i].length
        });
      }
    } finally {
      this.activeWaifuSendChannels.delete(input.channelId);
    }
    return messageIds;
  }

  private async setActivePipeline(guildId: string, channelId: string, kind: "orchestrator" | "waifu") {
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      activePipeline: { kind, startedAt: nowIso() }
    }));
  }

  private rememberSelfSent(messageId: string): void {
    this.recentSelfSentIds.set(messageId, Date.now() + RuntimeOrchestrator.SELF_SENT_TTL_MS);
    if (this.recentSelfSentIds.size > 200) {
      const now = Date.now();
      for (const [id, expiresAt] of this.recentSelfSentIds) {
        if (expiresAt <= now) this.recentSelfSentIds.delete(id);
      }
    }
  }

  private wasSelfSent(messageId: string): boolean {
    const expiresAt = this.recentSelfSentIds.get(messageId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.recentSelfSentIds.delete(messageId);
      return false;
    }
    return true;
  }

  private async markSessionIdle(guildId: string, channelId: string) {
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      activePipeline: null
    }));
  }

  private async pipelineFor(modelId: string): Promise<ModelPipeline> {
    const model = getModel(modelId);
    if (!model) throw new Error(`Unknown model ${modelId}.`);
    const credentials = await this.readProviderCredentials();
    const saved = credentials.providers[model.providerId];
    if (!saved?.apiKey) {
      throw new Error(`Provider ${model.providerId} is missing API credentials.`);
    }
    return this.createPipeline(modelId, { apiKey: saved.apiKey });
  }

  private async messagesForModel(
    messages: ContextMessage[],
    modelId: string,
    signal?: AbortSignal
  ): Promise<ContextMessage[]> {
    const model = getModel(modelId);
    if (!model || model.supportsImageInput || !this.options.ocr) {
      return messages;
    }
    try {
      return await this.options.ocr.enrichMessages(messages, { signal });
    } catch (error) {
      this.options.logger.warn("OCR enrichment failed; continuing without OCR text", {
        modelId,
        message: error instanceof Error ? error.message : String(error)
      });
      return messages;
    }
  }

  private async readProviderCredentials(): Promise<ProviderCredentialsFile> {
    return this.options.storage.readJson(
      "user/providers.json",
      ProviderCredentialsFileSchema,
      ProviderCredentialsFileSchema.parse(createEmptyRevisionedFile({ providers: {} }))
    );
  }

  private async readAgentConfig(agent: "orchestrator" | "stage-manager" | "reviewer", defaultWindow: number): Promise<AgentConfig> {
    return this.options.storage.readJson(
      `user/${agent}/config.json`,
      AgentConfigSchema,
      AgentConfigSchema.parse(
        createEmptyRevisionedFile({
          enabled: false,
          contextWindow: defaultWindow,
          prompt: ""
        })
      )
    );
  }

  private async readWaifu(waifuId: string): Promise<WaifuConfig> {
    return this.options.storage.readJson(path.join("user", "waifus", waifuId, "waifu.json"), WaifuConfigSchema);
  }

  private async resolveRunWaifu(guildId: string, channelId: string, value: string): Promise<WaifuConfig | string> {
    const server = await this.ensureServer(guildId);
    const channel = server.channels[channelId];
    if (!this.channelHasWaifus(channel)) {
      return "No waifus are enabled in this channel.";
    }
    const waifus = await this.listWaifus();
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

  private async listWaifus(): Promise<WaifuConfig[]> {
    let entries: string[];
    try {
      entries = await readdir(path.join(this.options.storage.dataRoot, "user", "waifus"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const waifus = await Promise.all(
      entries.map((entry) => this.readWaifu(entry).catch(() => undefined))
    );
    return waifus.filter((waifu): waifu is WaifuConfig => Boolean(waifu));
  }

  private async listAvailableWaifusForChannel(channel: ServerConfig["channels"][string]): Promise<WaifuConfig[]> {
    const waifus = await this.listWaifus();
    const waifusById = new Map(
      waifus
        .filter((waifu) => waifu.enabled && waifu.modelId && waifu.botId)
        .map((waifu) => [waifu.id, waifu])
    );
    return (channel.enabledWaifuIds ?? [])
      .map((waifuId) => waifusById.get(waifuId))
      .filter((waifu): waifu is WaifuConfig => Boolean(waifu));
  }

  private async listAvailableWaifusForGuild(server: ServerConfig): Promise<WaifuConfig[]> {
    const enabledWaifuIds = new Set<string>();
    for (const channel of Object.values(server.channels)) {
      for (const waifuId of channel.enabledWaifuIds ?? []) {
        enabledWaifuIds.add(waifuId);
      }
    }
    if (enabledWaifuIds.size === 0) {
      return [];
    }
    const waifus = await this.listWaifus();
    const waifusById = new Map(waifus.map((waifu) => [waifu.id, waifu]));
    return [...enabledWaifuIds]
      .map((waifuId) => waifusById.get(waifuId))
      .filter((waifu): waifu is WaifuConfig => Boolean(waifu));
  }

  private async readMemoryStore(): Promise<MemoryStore> {
    return this.options.storage.readJson("user/memories.json", MemoryStoreSchema, emptyMemoryStore());
  }

  private async noteActiveChatParticipant(
    guildId: string,
    channelId: string,
    participant: { userId: string; displayName: string }
  ): Promise<void> {
    await this.noteActiveChatParticipants(guildId, channelId, [participant]);
  }

  private async noteActiveChatParticipantsFromContext(
    guildId: string,
    channelId: string,
    messages: ContextMessage[]
  ): Promise<void> {
    const participants = messages
      .filter((message) => message.authorKind === "user" && !message.authorBot)
      .map((message) => ({
        userId: message.authorId,
        displayName: message.displayName
      }));
    await this.noteActiveChatParticipants(guildId, channelId, participants);
  }

  private async noteActiveChatParticipants(
    guildId: string,
    channelId: string,
    participants: Array<{ userId: string; displayName: string }>
  ): Promise<void> {
    const validParticipants = participants
      .map((participant) => ({
        userId: participant.userId.trim(),
        displayName: participant.displayName.trim()
      }))
      .filter((participant) => participant.userId.length > 0 && participant.displayName.length > 0);
    if (validParticipants.length === 0) return;

    const now = Date.now();
    const lastSeenAt = new Date(now).toISOString();
    const expiresAt = new Date(now + RuntimeOrchestrator.ACTIVE_CHAT_PARTICIPANT_TTL_MS).toISOString();
    await this.options.storage.updateRevisionedJson({
      resourceKey: activeChatParticipantsResourceKey(guildId, channelId),
      relativePath: activeChatParticipantsRelativePath(guildId, channelId),
      schema: ActiveChatParticipantsFileSchema,
      fallback: emptyActiveChatParticipantsFile(guildId, channelId),
      transform: (current) => {
        const byUserId = new Map<string, ActiveChatParticipant>();
        for (const entry of current.participants) {
          if (Date.parse(entry.expiresAt) > now) {
            byUserId.set(entry.userId, entry);
          }
        }
        for (const participant of validParticipants) {
          byUserId.set(participant.userId, {
            userId: participant.userId,
            displayName: participant.displayName,
            lastSeenAt,
            expiresAt
          });
        }
        return {
          ...current,
          guildId,
          channelId,
          participants: sortActiveChatParticipants([...byUserId.values()])
        };
      }
    });
  }

  private async readActiveChatParticipants(guildId: string, channelId: string): Promise<ActiveChatParticipant[]> {
    const now = Date.now();
    const current = await this.options.storage.readJson(
      activeChatParticipantsRelativePath(guildId, channelId),
      ActiveChatParticipantsFileSchema,
      emptyActiveChatParticipantsFile(guildId, channelId)
    );
    return sortActiveChatParticipants(
      current.participants.filter((participant) => Date.parse(participant.expiresAt) > now)
    );
  }

  private async recordWaifuNotes(input: {
    guildId: string;
    channelId: string;
    waifuId: string;
    entries: string[];
  }): Promise<void> {
    if (input.entries.length === 0) return;
    const capped = input.entries.slice(0, NOTE_MAX_PER_REPLY);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + NOTE_LIFESPAN_MS).toISOString();
    await this.options.storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      transform: (current) => {
        // Dedup against notes already stored for this waifu in this channel —
        // the model frequently re-records the same fact on a later turn.
        const existingForScope = new Set(
          current.memories
            .filter(
              (memory) =>
                memory.source === "waifu_tool" &&
                memory.status === "active" &&
                memory.guildId === input.guildId &&
                memory.channelId === input.channelId &&
                memory.waifuId === input.waifuId &&
                (!memory.expiresAt || Date.parse(memory.expiresAt) > now)
            )
            .map((memory) => normalizeNoteContent(memory.content))
        );
        const additions: MemoryRecord[] = [];
        for (const content of capped) {
          const key = normalizeNoteContent(content);
          if (!key || existingForScope.has(key)) continue;
          existingForScope.add(key);
          additions.push({
            id: randomUUID(),
            guildId: input.guildId,
            channelId: input.channelId,
            waifuId: input.waifuId,
            content,
            kind: "context",
            source: "waifu_tool",
            pinned: false,
            strength: WAIFU_NOTE_STRENGTH,
            entities: extractEntities(content),
            expiresAt,
            createdAt,
            updatedAt: createdAt,
            status: "active"
          });
        }
        return { ...current, memories: [...current.memories, ...additions] };
      }
    });
  }

  private async buildWaifuPromptParts(
    guildId: string,
    waifu: WaifuConfig,
    availableWaifus: WaifuConfig[],
    options: {
      channelId: string;
      directorNote?: string;
      pickNextWaifuToolOverride?: boolean;
      shortTermMemoryToolOverride?: boolean;
    }
  ): Promise<{ systemPrompt: string; midSystemBlock: string; trailingSystemBlock: string; selfGuildNickname: string | undefined }> {
    const pickNextWaifuToolActive = options.pickNextWaifuToolOverride ?? false;
    const shortTermMemoryToolActive =
      options.shortTermMemoryToolOverride ?? true;
    const [store, emojis, activeChatParticipants, members] = await Promise.all([
      this.readMemoryStore(),
      this.options.storage.readJson(
        path.join("user", "servers", guildId, "emojis.json"),
        GuildEmojisFileSchema,
        GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
      ),
      this.readActiveChatParticipants(guildId, options.channelId),
      this.options.storage.readJson(
        path.join("user", "servers", guildId, "members.json"),
        GuildMembersFileSchema,
        GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
      )
    ]);
    const now = Date.now();
    // Task 1 keeps inject-all behavior but reads from the unified store: active + unexpired +
    // guild + waifu match, pinned first then the rest (Task 2 replaces this with retrieval).
    const memoryLines = injectAllMemoryLines(store.memories, guildId, waifu.id, now);
    const emojiList = emojis.emojis
      .filter((emoji) => emoji.available)
      .map(modelVisibleEmojiToken)
      .join(" ");
    // Raw persona text; the identity block adds the identity sentence separately.
    const personalityContent = waifu.persona.trim();
    const scheduleContent = formatWaifuScheduleForPrompt(waifu);
    const waifuTag = promptTagName(waifu.name || waifu.id);
    const toolUseInstructions = buildWaifuToolUseInstructions(waifu, availableWaifus, {
      pickNextWaifu: pickNextWaifuToolActive,
      shortTermMemory: shortTermMemoryToolActive
    });
    const guildNameByUserId = new Map(
      members.members
        .filter((member) => member.guildDisplayName)
        .map((member) => [member.userId, member.guildDisplayName as string])
    );
    const serverNickname = waifu.botId ? guildNameByUserId.get(waifu.botId) : undefined;

    // Roster line: guild display names of other configured waifus with bot IDs (excluding self),
    // with the configured displayName in parentheses when the guild name differs.
    const rosterLine = availableWaifus
      .filter((candidate) => candidate.id !== waifu.id && candidate.botId)
      .map((candidate) => {
        const guildName = guildNameByUserId.get(candidate.botId as string);
        const configured = candidate.displayName || candidate.name;
        return guildName && guildName !== configured ? `${guildName} (${configured})` : configured;
      })
      .join(", ");

    const blockContext: PromptBlockContext = {
      waifuTag,
      displayName: waifu.displayName || waifu.name || waifu.id,
      personalityContent,
      scheduleContent,
      toolUseInstructions,
      rosterLine,
      serverNickname: serverNickname !== waifu.displayName ? serverNickname : undefined,
      activeParticipantDisplayNames: channelParticipantDisplayNames(
        activeChatParticipants,
        waifu,
        availableWaifus
      ),
      emojiList,
      memoryLines,
      currentlyDoing: currentlyDoingForWaifu(waifu, new Date()),
      directorNote: options.directorNote?.trim() || undefined,
      personaDigest: waifu.personaDigest
        ? { voice: waifu.personaDigest.voice, role: waifu.personaDigest.role }
        : undefined
    };

    // The slot→string mapping is fixed; the composition of each slot is driven by the waifu's
    // editable prompt layout (see src/orchestration/promptBlocks.ts).
    return {
      ...assembleWaifuPrompt(reconcileWaifuPromptLayout(waifu.promptLayout), blockContext),
      selfGuildNickname: serverNickname !== waifu.displayName ? serverNickname : undefined
    };
  }

  private buildOrchestratorSystemPrompt(
    orchestrator: AgentConfig,
    server: ServerConfig,
    replyRequired = false
  ): string {
    const identity = replyRequired
      ? "You are the director of a multi-character Discord bot. This manual /run requires you to choose at least one waifu to reply now."
      : "You are the director of a multi-character Discord bot. On each pass you decide who (if anyone) speaks next and how the room is paced.";

    const rules = [
      "- Every respondingWaifus[].waifuId must be copied verbatim from the IDs in <active_waifus>.",
      replyRequired
        ? "- action must be \"reply\" for this manual /run, with at least one responding waifu and retriggerAfterSeconds null."
        : "- action \"reply\": respondingWaifus non-empty, retriggerAfterSeconds and wakePlan null. action \"no_reply\": respondingWaifus empty, retriggerAfterSeconds and wakePlan set.",
      "- Runtime pacing: when a human spoke within the last four chat messages, the first waifu starts immediately and later delays count from this decision; otherwise each delay counts after the previous waifu finishes. Any new chat message cancels the remaining chain.",
      "- Your own past orchestrator_decision tool calls appear in the conversation with their real outcomes; nobody else sees them. Lines like [12m pass] and [wake: ...] are runtime annotations, not chat messages.",
      "- Availability lines in <active_waifus> are soft signals, not rules — a sleeping waifu can still answer when the moment justifies it."
    ].join("\n");

    const messageStructure =
      "Each Discord message is its own user turn: an optional `replying to > Author: preview` line, then `DisplayName: <body>`, optionally followed by `[attachments: Nx image]` and `[image_text: ...]` lines.";

    return [
      `<orchestrator_identity>\n${identity}\n</orchestrator_identity>`,
      `<orchestrator_rules>\n${rules}\n</orchestrator_rules>`,
      orchestrator.promptSections.messageStructure
        ? `<chat_message_structure>\n${messageStructure}\n</chat_message_structure>`
        : null,
      `<discord_server_information>\n${server.name ?? server.guildId}\n</discord_server_information>`
    ].filter(Boolean).join("\n");
  }

  private buildOrchestratorTrailingPrompt(
    orchestrator: AgentConfig,
    availableWaifus: WaifuConfig[],
    replyRequired = false,
    loopNotice?: string
  ): string {
    const now = new Date();
    const activeWaifusContent = availableWaifus.length
      ? availableWaifus.map((waifu) => castingCard(waifu, now)).join("\n")
      : "No waifus are currently enabled for this channel.";

    const pausePlanning =
      "When you choose no_reply, retriggerAfterSeconds is a planned pause before YOU re-check the room — any new human message wakes you regardless, so long pauses cost nothing. wakePlan is one sentence on what you intend at wake; the runtime shows it back to you when the timer fires. A pivot plan should name the new topic, and when the wake comes you execute it with a change_topic directive — a plan without a directive usually dissolves into the old topic. Use the whole range: 100–300s when you expect a beat to need a nudge soon; 600–1800s for a cooling room with a planned revival; 3600s+ when you are mostly waiting for humans. Repeated quiet checks must back off to longer pauses.";

    const task = replyRequired
      ? `${DEFAULT_ORCHESTRATOR_PROMPT}\n\n${manualRunReplyRequiredInstruction()}`
      : DEFAULT_ORCHESTRATOR_PROMPT;

    return [
      `<task_instructions>\n${task}\n</task_instructions>`,
      orchestrator.promptSections.pausePlanning && !replyRequired
        ? `<pause_planning>\n${pausePlanning}\n</pause_planning>`
        : null,
      `<active_waifus>\n${activeWaifusContent}\n</active_waifus>`,
      `<current_time>\n${formatPromptCurrentHour(new Date())}\n</current_time>`,
      loopNotice ? `<runtime_notice>\n${loopNotice}\n</runtime_notice>` : null
    ].filter(Boolean).join("\n");
  }

  private async ensureServer(guildId: string): Promise<ServerConfig> {
    return this.options.storage.updateRevisionedJson({
      resourceKey: `server:${guildId}`,
      relativePath: path.join("user", "servers", guildId, "server.json"),
      schema: ServerConfigSchema,
      fallback: ServerConfigSchema.parse({ ...createRevisionedBase(), guildId, enabled: true }),
      transform: (current) => current
    });
  }

  private async ensureChannelConfig(server: ServerConfig, channelId: string): Promise<ServerConfig> {
    if (server.channels[channelId]) {
      return server;
    }
    let metadata:
      | {
          guildName?: string;
          channelName?: string;
        }
      | undefined;
    try {
      metadata = await this.options.discord.fetchChannelMetadata?.({
        guildId: server.guildId,
        channelId
      });
    } catch (error) {
      this.options.logger.warn("Failed to fetch Discord names for newly detected channel", {
        guildId: server.guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return this.options.storage.updateRevisionedJson({
      resourceKey: `server:${server.guildId}`,
      relativePath: path.join("user", "servers", server.guildId, "server.json"),
      schema: ServerConfigSchema,
      fallback: server,
      transform: (current) => {
        const currentChannel = current.channels[channelId];
        return {
          ...current,
          name: metadata?.guildName ?? current.name,
          channels: {
            ...current.channels,
            [channelId]: currentChannel
              ? {
                  ...currentChannel,
                  name: currentChannel.name ?? metadata?.channelName
                }
              : {
                  channelId,
                  name: metadata?.channelName,
                  enabled: false,
                  enabledWaifuIds: []
                }
          }
        };
      }
    });
  }

  private channelHasWaifus(
    channel: ServerConfig["channels"][string] | undefined
  ): channel is ServerConfig["channels"][string] {
    return Boolean(channel && (channel.enabledWaifuIds?.length ?? 0) > 0);
  }

  private async ensureChannelSession(guildId: string, channelId: string): Promise<ChannelSessionState> {
    return this.options.storage.updateRevisionedJson({
      resourceKey: `session:${guildId}:${channelId}`,
      relativePath: sessionRelativePath(guildId, channelId),
      schema: ChannelSessionStateSchema,
      fallback: createEmptyChannelSessionState(guildId, channelId),
      transform: (current) => current
    });
  }

  private async readChannelSession(guildId: string, channelId: string): Promise<ChannelSessionState> {
    return this.options.storage.withLocks(
      [`session:${guildId}:${channelId}`],
      () => this.options.storage.readJson(
        sessionRelativePath(guildId, channelId),
        ChannelSessionStateSchema,
        createEmptyChannelSessionState(guildId, channelId)
      )
    );
  }

  private async updateSession(
    guildId: string,
    channelId: string,
    transform: (current: ChannelSessionState) => ChannelSessionState
  ): Promise<ChannelSessionState> {
    return this.options.storage.updateRevisionedJson({
      resourceKey: `session:${guildId}:${channelId}`,
      relativePath: sessionRelativePath(guildId, channelId),
      schema: ChannelSessionStateSchema,
      fallback: createEmptyChannelSessionState(guildId, channelId),
      transform
    });
  }

  private async readCompletedOrchestratorDecisionsForChannel(
    guildId: string,
    channelId: string
  ): Promise<OrchestratorDecisionHistoryEntry[]> {
    const history = await this.options.storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }))
    );
    return history.decisions.filter(
      (decision) =>
        decision.guildId === guildId &&
        decision.channelId === channelId &&
        decision.status === "completed"
    );
  }

  private async appendOrchestratorHistory(entry: {
    id: string;
    guildId: string;
    channelId: string;
    action: "reply" | "no_reply";
    respondingWaifus: OrchestratorRespondingWaifu[];
    retriggerAfterSeconds?: number;
    wakePlan?: string;
    reasoning: string;
    status: OrchestratorDecisionStatus;
    waifuMessageIds: string[];
    responderOutcomes: OrchestratorResponderOutcome[];
    createdAt: string;
  }) {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({ ...current, decisions: [entry, ...current.decisions].slice(0, 200) })
    });
  }

  private async setDebugRoute(input: {
    sourceGuildId?: string;
    sourceChannelId: string;
    destinationGuildId?: string;
    destinationChannelId: string;
    userId: string;
  }): Promise<void> {
    const now = nowIso();
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:debug",
      relativePath: "user/orchestrator/debug.json",
      schema: OrchestratorDebugConfigFileSchema,
      fallback: OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} })),
      transform: (current) => {
        const previous = current.routes[input.sourceChannelId];
        return {
          ...current,
          routes: {
            ...current.routes,
            [input.sourceChannelId]: {
              sourceGuildId: input.sourceGuildId,
              sourceChannelId: input.sourceChannelId,
              destinationGuildId: input.destinationGuildId,
              destinationChannelId: input.destinationChannelId,
              createdByUserId: previous?.createdByUserId ?? input.userId,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now
            }
          }
        };
      }
    });
  }

  private async unsetDebugRoute(sourceChannelId: string): Promise<boolean> {
    let removed = false;
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:debug",
      relativePath: "user/orchestrator/debug.json",
      schema: OrchestratorDebugConfigFileSchema,
      fallback: OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} })),
      transform: (current) => {
        if (!current.routes[sourceChannelId]) {
          return current;
        }
        const { [sourceChannelId]: _removed, ...routes } = current.routes;
        removed = true;
        return { ...current, routes };
      }
    });
    return removed;
  }

  private async readDebugRoute(sourceChannelId: string) {
    const config = await this.options.storage.readJson(
      "user/orchestrator/debug.json",
      OrchestratorDebugConfigFileSchema,
      OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} }))
    );
    return config.routes[sourceChannelId];
  }

  private async sendOrchestratorDebugLog(input: {
    guildId: string;
    channelId: string;
    decision: OrchestratorDecision;
    availableWaifus: WaifuConfig[];
  }): Promise<void> {
    await this.sendDebugLogForChannel(
      input.guildId,
      input.channelId,
      formatOrchestratorDebugLog(input)
    );
  }

  private async sendStageManagerDebugLog(input: {
    guildId: string;
    channelId: string;
    entries: StageManagerDebugEntry[];
    observationCount: number;
  }): Promise<void> {
    await this.sendDebugLogForChannel(
      input.guildId,
      input.channelId,
      formatStageManagerDebugLog(input)
    );
  }

  private async sendDebugLogForChannel(guildId: string, channelId: string, content: string): Promise<void> {
    try {
      if (!this.options.discord.sendDebugMessage) {
        return;
      }
      const route = await this.readDebugRoute(channelId);
      if (!route) {
        return;
      }
      if (route.sourceGuildId && route.sourceGuildId !== guildId) {
        this.options.logger.warn("Skipping debug log for route with mismatched source guild", {
          sourceGuildId: guildId,
          sourceChannelId: channelId,
          routeSourceGuildId: route.sourceGuildId
        });
        return;
      }
      for (const chunk of splitDebugMessage(content)) {
        await this.options.discord.sendDebugMessage({
          channelId: route.destinationChannelId,
          content: chunk
        });
      }
    } catch (error) {
      this.options.logger.warn("Failed to send Discord debug log", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async updateOrchestratorDecisionStatus(id: string, status: OrchestratorDecisionStatus): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) =>
          decision.id === id ? { ...decision, status } : decision
        )
      })
    });
  }

  private async insertOrchestratorResponderOutcomeAfter(
    decisionId: string,
    afterOutcomeId: string,
    outcome: OrchestratorResponderOutcome
  ): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) => {
          if (decision.id !== decisionId) return decision;
          const responderOutcomes = [...decision.responderOutcomes];
          const afterIndex = responderOutcomes.findIndex((entry) => entry.id === afterOutcomeId);
          responderOutcomes.splice(afterIndex >= 0 ? afterIndex + 1 : responderOutcomes.length, 0, outcome);
          return { ...decision, responderOutcomes };
        })
      })
    });
  }

  private async moveOrchestratorResponderOutcomeAfter(
    decisionId: string,
    afterOutcomeId: string,
    outcomeId: string,
    handoffFromWaifuId: string
  ): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) => {
          if (decision.id !== decisionId) return decision;
          const responderOutcomes = [...decision.responderOutcomes];
          const existingIndex = responderOutcomes.findIndex((entry) => entry.id === outcomeId);
          if (existingIndex < 0) return decision;
          const [existing] = responderOutcomes.splice(existingIndex, 1);
          const afterIndex = responderOutcomes.findIndex((entry) => entry.id === afterOutcomeId);
          responderOutcomes.splice(afterIndex >= 0 ? afterIndex + 1 : responderOutcomes.length, 0, {
            ...existing,
            handoffFromWaifuId
          });
          return { ...decision, responderOutcomes };
        })
      })
    });
  }

  private async updateOrchestratorResponderOutcome(
    decisionId: string,
    outcomeId: string,
    patch: Partial<Pick<
      OrchestratorResponderOutcome,
      "handoffFromWaifuId" | "status" | "reason" | "directiveStripped"
    >>
  ): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) =>
          decision.id === decisionId
            ? {
                ...decision,
                responderOutcomes: decision.responderOutcomes.map((outcome) =>
                  outcome.id === outcomeId
                    ? {
                        ...outcome,
                        ...patch,
                        reason: patch.reason === undefined && "reason" in patch
                          ? undefined
                          : patch.reason ?? outcome.reason
                      }
                    : outcome
                )
              }
            : decision
        )
      })
    });
  }

  private async finalizeOrchestratorDecisionAfterError(input: {
    decisionId: string;
    status: Extract<OrchestratorDecisionStatus, "interrupted" | "failed">;
    currentOutcomeId?: string;
    reason: string;
  }): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) => {
          if (decision.id !== input.decisionId) return decision;
          return {
            ...decision,
            status: input.status,
            responderOutcomes: decision.responderOutcomes.map((outcome) => {
              if (outcome.status !== "pending") return outcome;
              if (input.status === "interrupted") {
                return { ...outcome, status: "interrupted" as const, reason: input.reason };
              }
              if (outcome.id === input.currentOutcomeId) {
                return { ...outcome, status: "failed" as const, reason: input.reason };
              }
              return { ...outcome, status: "not_run" as const, reason: "previous_responder_failed" };
            })
          };
        })
      })
    });
  }

  private async recordOrchestratorDecisionWaifuMessage(
    id: string,
    outcomeId: string | undefined,
    messageId: string
  ): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) =>
          decision.id === id
            ? {
                ...decision,
                waifuMessageIds: [...decision.waifuMessageIds, messageId],
                responderOutcomes: decision.responderOutcomes.map((outcome) =>
                  outcome.id === outcomeId
                    ? { ...outcome, messageIds: [...outcome.messageIds, messageId] }
                    : outcome
                )
              }
            : decision
        )
      })
    });
  }

  private async healPendingOrchestratorDecisions(): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "orchestrator:history",
      relativePath: "user/orchestrator/history.json",
      schema: OrchestratorHistoryFileSchema,
      fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
      transform: (current) => ({
        ...current,
        decisions: current.decisions.map((decision) =>
          decision.status === "pending"
            ? {
                ...decision,
                status: "interrupted" as const,
                responderOutcomes: decision.responderOutcomes.map((outcome) =>
                  outcome.status === "pending"
                    ? {
                        ...outcome,
                        status: "interrupted" as const,
                        reason: "runtime_restarted"
                      }
                    : outcome
                )
              }
            : decision
        )
      })
    });
  }

  private async appendStageManagerHistory(entry: {
    id: string;
    guildId?: string;
    channelId?: string;
    tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
    affectedMemoryIds: string[];
    summary: string;
    observationCount?: number;
    createdAt: string;
  }) {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "stage-manager:history",
      relativePath: "user/stage-manager/history.json",
      schema: StageManagerHistoryFileSchema,
      fallback: StageManagerHistoryFileSchema.parse(createEmptyRevisionedFile({ edits: [] })),
      transform: (current) => ({ ...current, edits: [entry, ...current.edits].slice(0, 200) })
    });
  }

  private async appendReviewerHistory(entry: {
    id: string;
    guildId?: string;
    channelId?: string;
    reviewerUserId?: string;
    targetMessageIds: string[];
    hallucination: boolean;
    deleted: boolean;
    createdAt: string;
  }) {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "reviewer:history",
      relativePath: "user/reviewer/history.json",
      schema: ReviewerHistoryFileSchema,
      fallback: ReviewerHistoryFileSchema.parse(createEmptyRevisionedFile({ reviews: [] })),
      transform: (current) => ({ ...current, reviews: [entry, ...current.reviews].slice(0, 200) })
    });
  }

  private async syncGuilds(): Promise<void> {
    const guilds = await this.options.discord.listGuilds?.();
    for (const guild of guilds ?? []) {
      const relativePath = path.join("user", "servers", guild.guildId, "server.json");
      const fallback = ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId: guild.guildId,
        name: guild.name,
        enabled: true
      });
      const existing = await this.options.storage.readJson(relativePath, ServerConfigSchema, fallback);
      const channelNames = new Map<string, string>();
      if (this.options.discord.fetchChannelMetadata) {
        for (const channelId of Object.keys(existing.channels)) {
          try {
            const metadata = await this.options.discord.fetchChannelMetadata({
              guildId: guild.guildId,
              channelId
            });
            if (metadata.channelName) {
              channelNames.set(channelId, metadata.channelName);
            }
          } catch (error) {
            this.options.logger.warn("Failed to refresh Discord channel name during startup", {
              guildId: guild.guildId,
              channelId,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      await this.options.storage.updateRevisionedJson({
        resourceKey: `server:${guild.guildId}`,
        relativePath,
        schema: ServerConfigSchema,
        fallback,
        transform: (current) => {
          const channels = Object.fromEntries(
            Object.entries(current.channels).map(([channelId, channel]) => [
              channelId,
              {
                ...channel,
                name: channelNames.get(channelId) ?? channel.name
              }
            ])
          );
          return {
            ...current,
            name: guild.name,
            channels
          };
        }
      });
    }
  }

  private async isKnownWaifuAuthor(authorId: string): Promise<boolean> {
    const bots = await this.options.storage.readJson(
      "user/discord-bots.json",
      DiscordBotsFileSchema,
      DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
    );
    return bots.waifus.some((bot) => bot.id === authorId || bot.applicationId === authorId);
  }

}

function emptyMemoryStore(): MemoryStore {
  return MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }));
}

// Waifu notes (formerly the short-term store) survive a weekend so a Friday plan is still around
// Monday; the dream pass promotes the keepers.
const NOTE_LIFESPAN_MS = 72 * 60 * 60 * 1000;
const NOTE_MAX_PER_REPLY = 5;

function normalizeNoteContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

// Task 1 inject-all selection over the unified store: active, unexpired, guild + waifu match.
// Pinned (user-managed) records come first, then the rest oldest→newest. Task 2 replaces this
// with scored retrieval.
function injectAllMemoryLines(
  memories: MemoryRecord[],
  guildId: string,
  waifuId: string,
  now: number
): string[] {
  const matching = memories.filter(
    (memory) =>
      memory.guildId === guildId &&
      memory.waifuId === waifuId &&
      memory.status === "active" &&
      (!memory.expiresAt || Date.parse(memory.expiresAt) > now)
  );
  const byCreatedAt = (a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt);
  const pinned = matching.filter((memory) => memory.pinned).sort(byCreatedAt);
  const rest = matching.filter((memory) => !memory.pinned).sort(byCreatedAt);
  return [...pinned, ...rest].map((memory) => `- ${memory.content}`);
}

const STAGE_MANAGER_MEMORY_BUDGET = 80;

function stageManagerMemories(
  memories: MemoryRecord[],
  guildId: string,
  allowedWaifuIds: string[],
  options?: { observations?: StageManagerObservation[]; budget?: number }
): {
  memories: StageManagerMemory[];
  memoryIdByIndex: Map<number, string>;
} {
  const allowedWaifus = new Set(allowedWaifuIds);
  const allActive = memories.filter((memory) =>
    memory.guildId === guildId &&
    memory.status === "active" &&
    !memory.pinned &&
    allowedWaifus.has(memory.waifuId)
  );
  const activeMemories = pruneMemoriesForObservations(allActive, options?.observations, options?.budget ?? STAGE_MANAGER_MEMORY_BUDGET);
  const memoryIdByIndex = new Map<number, string>();
  return {
    memories: activeMemories.map((memory, index) => {
      const memoryIndex = index + 1;
      memoryIdByIndex.set(memoryIndex, memory.id);
      return {
        memoryIndex,
        waifuId: memory.waifuId,
        content: memory.content,
        // The librarian's wire shape stays on the 1-5 `importance` scale this task; map the
        // stored strength onto it. Task 4 replaces the librarian with the dream pass.
        importance: strengthToImportance(memory.strength)
      };
    }),
    memoryIdByIndex
  };
}

// The stored strength is a continuous 0-5; the librarian wire expects an integer 1-5.
function strengthToImportance(strength: number): number {
  return Math.max(1, Math.min(5, Math.round(strength)));
}

function memoryIdsForIndices(indices: number[], memoryIdByIndex: Map<number, string>): string[] {
  const memoryIds: string[] = [];
  for (const index of new Set(indices)) {
    const memoryId = memoryIdByIndex.get(index);
    if (!memoryId) return [];
    memoryIds.push(memoryId);
  }
  return memoryIds;
}

const STAGE_MANAGER_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "that", "this", "these", "those", "it", "its", "as", "into", "about",
  "i", "you", "he", "she", "they", "we", "them", "his", "her", "their",
  "do", "does", "did", "have", "has", "had", "will", "would", "should", "could", "can",
  "not", "no", "yes", "so", "than", "then", "very", "just", "also", "too"
]);

function memoryTokenSet(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STAGE_MANAGER_STOPWORDS.has(token));
  return new Set(tokens);
}

function pruneMemoriesForObservations(
  memories: MemoryRecord[],
  observations: StageManagerObservation[] | undefined,
  budget: number
): MemoryRecord[] {
  if (!observations || observations.length === 0) {
    return capByStrengthThenRecency(memories, budget);
  }
  const observationWaifus = new Set(observations.map((o) => o.waifuId));
  const observationTokens = observations.flatMap((o) => Array.from(memoryTokenSet(o.content)));
  const tokenSet = new Set(observationTokens);
  const selected = memories.filter((memory) => {
    if (observationWaifus.has(memory.waifuId)) return true;
    if (tokenSet.size === 0) return false;
    const memoryTokens = memoryTokenSet(memory.content);
    for (const token of memoryTokens) {
      if (tokenSet.has(token)) return true;
    }
    return false;
  });
  return capByStrengthThenRecency(selected, budget);
}

function capByStrengthThenRecency(memories: MemoryRecord[], budget: number): MemoryRecord[] {
  if (memories.length <= budget) return memories;
  return [...memories]
    .sort((a, b) => {
      if (b.strength !== a.strength) return b.strength - a.strength;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    })
    .slice(0, budget);
}

function buildWaifuToolUseInstructions(
  waifu: WaifuConfig,
  availableWaifus: WaifuConfig[],
  activeTools: { pickNextWaifu: boolean; shortTermMemory: boolean }
): string | undefined {
  if (!waifu.tools.toolUse) return undefined;
  const model = waifu.modelId ? getModel(waifu.modelId) : undefined;
  if (!model?.supportsTools) return undefined;
  const candidates = availableWaifus
    .filter((candidate) => candidate.id !== waifu.id && candidate.botId && candidate.modelId)
    .map((candidate) => `${candidate.id} (${candidate.displayName || candidate.name})`);
  const sections: string[] = [];
  if (activeTools.pickNextWaifu && candidates.length > 0) {
    sections.push(
      [
        "PickNextWaifu — only after your message, only when another waifu has an obvious immediate follow-up. Available:",
        ...candidates.map((candidate) => `- ${candidate}`)
      ].join("\n")
    );
  }
  if (activeTools.shortTermMemory) {
    sections.push(
      `add_memory — save a note whenever the chat produces something you'd want to know tomorrow (plans, promises, new facts about someone, the state of a running bit). Notes are what survives when the chat history vanishes. Skip facts already shown in <${promptTagName(waifu.name || waifu.id)}_relevant_memories>. Always also write your normal message in the same turn.`
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

function formatWaifuScheduleForPrompt(waifu: WaifuConfig): string {
  const availability = waifu.availability;
  const lines = [
    "- This is your configured routine. Treat it as background for your energy and timing, not as a live status readout.",
    "- It changes only when your schedule is edited."
  ];
  if (availability.sleep.enabled) {
    lines.push(
      `- Sleep: ${availability.sleep.start}-${availability.sleep.end} daily. This is your usual downtime, not a hard rule; you can still answer if you were just active, directly addressed, or joining helps the room.`
    );
  } else {
    lines.push("- Sleep: none configured.");
  }
  if (availability.busy.length > 0) {
    lines.push("- Busy:");
    for (const interval of availability.busy) {
      lines.push(`  - ${interval.start}-${interval.end}: ${interval.reason}`);
    }
  } else {
    lines.push("- Busy: none configured.");
  }
  return lines.join("\n");
}

function localTimeOfDayMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function currentlyDoingForWaifu(waifu: WaifuConfig, now: Date): string | undefined {
  const currentMinutes = localTimeOfDayMinutes(now);
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(currentMinutes, interval)) {
      const reason = interval.reason.trim();
      if (reason) return reason;
    }
  }
  if (waifu.availability.sleep.enabled && dailyIntervalContains(currentMinutes, waifu.availability.sleep)) {
    return "sleepy";
  }
  return undefined;
}

function formatLocalTimeOfDay(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dailyIntervalContains(currentMinutes: number, interval: { start: string; end: string }): boolean {
  const start = timeOfDayMinutes(interval.start);
  const end = timeOfDayMinutes(interval.end);
  if (start === end) return false;
  if (start < end) return currentMinutes >= start && currentMinutes < end;
  return currentMinutes >= start || currentMinutes < end;
}

function timeOfDayMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function formatPromptCurrentHour(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + `T${String(date.getHours()).padStart(2, "0")}`;
}

function runKey(guildId: string): string {
  return guildId;
}

function timerKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function normalizeRunWaifuName(value: string): string {
  return value.trim().toLowerCase();
}

function autocompleteWaifuName(waifu: WaifuConfig): string {
  return waifu.displayName === waifu.id ? waifu.id : `${waifu.displayName} (${waifu.id})`;
}

function manualRunReplyRequiredInstruction(): string {
  return "Manual /run override: choose action=\"reply\" now. Do not choose no_reply for this decision.";
}

function sessionRelativePath(guildId: string, channelId: string): string {
  return path.join("user", "servers", guildId, "sessions", `${channelId}.json`);
}

function activeChatParticipantsResourceKey(guildId: string, channelId: string): string {
  return `active-chat-participants:${guildId}:${channelId}`;
}

function activeChatParticipantsRelativePath(guildId: string, channelId: string): string {
  return path.join("user", "servers", guildId, "active-chat-participants", `${channelId}.json`);
}

function emptyActiveChatParticipantsFile(guildId: string, channelId: string): ActiveChatParticipantsFile {
  return ActiveChatParticipantsFileSchema.parse(
    createEmptyRevisionedFile({ guildId, channelId, participants: [] })
  );
}

function sortActiveChatParticipants(participants: ActiveChatParticipant[]): ActiveChatParticipant[] {
  return [...participants].sort((a, b) => {
    const display = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
    return display === 0 ? a.userId.localeCompare(b.userId) : display;
  });
}

function replyTargetForFreshContext(
  replyToMessageId: string | undefined,
  messages: Array<{ id: string; sourceMessageIds?: string[] }>
): string | undefined {
  if (!replyToMessageId) return undefined;
  const latestMessage = messages.at(-1);
  const target = messages.find((message) =>
    message.id === replyToMessageId || message.sourceMessageIds?.includes(replyToMessageId)
  );
  if (!target || target === latestMessage) return undefined;
  return replyToMessageId;
}


function waifuParticipantDisplayNames(
  self: WaifuConfig,
  availableWaifus: WaifuConfig[],
  messages: ContextMessage[] = [],
  activeParticipants: ActiveChatParticipant[] = []
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const addName = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  for (const candidate of [self, ...availableWaifus]) {
    addName(candidate.displayName);
  }
  for (const message of messages) {
    addName(message.displayName);
    addName(message.name);
  }
  for (const participant of activeParticipants) {
    addName(participant.displayName);
  }
  return names;
}

function channelParticipantDisplayNames(
  activeParticipants: ActiveChatParticipant[],
  self: WaifuConfig,
  availableWaifus: WaifuConfig[]
): string[] {
  const names = new Map<string, string>();
  for (const name of [
    self.displayName,
    ...availableWaifus.map((waifu) => waifu.displayName),
    ...activeParticipants.map((participant) => participant.displayName)
  ]) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!names.has(key)) {
      names.set(key, trimmed);
    }
  }
  return [...names.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

// Render a directive into the single-line note fed to the waifu prompt. Manual /run directions
// pass through verbatim; model intents get a parenthetical label prefix for the waifu's benefit.
// Accepts the loose stored shape (string intent, optional goal) so both the decision pipeline and
// directed-run paths can feed it without casting.
function directiveTextForWaifu(
  directive: { intent: string; goal?: string } | undefined
): string | undefined {
  if (!directive) return undefined;
  const goal = directive.goal ?? "";
  if (directive.intent === "manual") return goal || undefined;
  return `(${directive.intent.replace(/_/g, " ")}) ${goal}`.trim();
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

function hasRecentUserMessage(messages: ContextMessage[], count: number): boolean {
  return messages.slice(-count).some((message) => message.authorKind === "user");
}

function waitMsBeforeWaifuReply(input: {
  delaySeconds: number;
  decisionDelayBaseMs: number;
  responderIndex: number;
  useDecisionRelativeDelays: boolean;
}): number {
  const delayMs = input.delaySeconds * 1000;
  if (!input.useDecisionRelativeDelays) {
    return delayMs;
  }
  if (input.responderIndex === 0) {
    return 0;
  }
  return Math.max(0, input.decisionDelayBaseMs + delayMs - Date.now());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted.");
  }
}

function summarizeProviderPipelineDetails(details: unknown): string {
  try {
    return JSON.stringify(details).slice(0, 4000);
  } catch {
    return String(details).slice(0, 4000);
  }
}

function formatOrchestratorDebugLog(input: {
  guildId: string;
  channelId: string;
  decision: OrchestratorDecision;
  availableWaifus: WaifuConfig[];
}): string {
  const waifuNameById = new Map(input.availableWaifus.map((waifu) => [waifu.id, waifuDebugName(waifu)]));
  const lines = [
    `[orchestrator debug] guild=${input.guildId} channel=${input.channelId}`,
    `Decision: ${input.decision.action}`
  ];
  if (input.decision.action === "reply") {
    lines.push(
      `Waifus: ${input.decision.respondingWaifus
        .map((responder) => waifuNameById.get(responder.waifuId) ?? responder.waifuId)
        .join(" -> ")}`
    );
    const directives = input.decision.respondingWaifus
      .map((responder) => ({
        name: waifuNameById.get(responder.waifuId) ?? responder.waifuId,
        directive: responder.directive
      }))
      .filter(
        (entry): entry is { name: string; directive: NonNullable<typeof entry.directive> } =>
          Boolean(entry.directive)
      );
    if (directives.length > 0) {
      lines.push("Directives:");
      for (const entry of directives) {
        lines.push(`- ${entry.name}: (${entry.directive.intent}) ${clipDebugText(entry.directive.goal)}`);
      }
    }
  } else {
    lines.push(`Idle trigger: ${input.decision.retriggerAfterSeconds ?? RETRIGGER_MIN_SECONDS}s`);
    if (input.decision.wakePlan) {
      lines.push(`Wake plan: ${clipDebugText(input.decision.wakePlan)}`);
    }
  }
  lines.push(`Reasoning: ${clipDebugText(input.decision.reasoning)}`);
  return lines.join("\n");
}

function formatStageManagerDebugLog(input: {
  guildId: string;
  channelId: string;
  entries: StageManagerDebugEntry[];
  observationCount: number;
}): string {
  const lines = [
    `[stage-manager debug] guild=${input.guildId} channel=${input.channelId}`,
    `Observations: ${input.observationCount}`
  ];
  const entries = input.entries.length > 0 ? input.entries : [{ tool: "no_change" as const, summary: "No memory changes" }];
  if (entries.every((entry) => entry.tool === "no_change")) {
    lines.push("Memory changes: none");
  } else {
    lines.push("Memory changes:");
  }
  for (const entry of entries) {
    lines.push(`- ${stageManagerToolLabel(entry.tool)}: ${clipDebugText(entry.summary || "No details")}`);
  }
  return lines.join("\n");
}

function waifuDebugName(waifu: WaifuConfig): string {
  const display = waifu.displayName || waifu.name || waifu.id;
  return display === waifu.id ? waifu.id : `${display} (${waifu.id})`;
}

function stageManagerToolLabel(tool: StageManagerDebugEntry["tool"]): string {
  if (tool === "add_memory") return "added";
  if (tool === "update_memory") return "updated";
  if (tool === "archive_memory") return "deleted/archived";
  if (tool === "merge_memories") return "merged";
  return "no change";
}

function clipDebugText(value: string, maxLength = 700): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatWaifuPromptDebugMessages(input: WaifuPromptDebugParts): string[] {
  return [
    ...formatPrintDebugBlock(`System prompt block 1 (${input.waifuDisplayName})`, input.systemPrompt),
    ...formatPrintDebugBlock(`System prompt block 2 (${input.waifuDisplayName})`, input.midSystemBlock),
    ...formatPrintDebugBlock(`System prompt block 3 (${input.waifuDisplayName})`, input.trailingSystemBlock)
  ];
}

function formatPrintDebugBlock(title: string, content: string): string[] {
  const rawContent = content.length > 0 ? content : "(empty)";
  const fence = promptDebugCodeFence(rawContent);
  const messages: string[] = [];
  let remaining = rawContent;
  let part = 1;
  while (remaining.length > 0) {
    const prefix = part === 1 ? `## ${title}\n${fence}\n` : `${fence}\n`;
    const suffix = `\n${fence}`;
    const maxContentLength = Math.max(1, DISCORD_DEBUG_MESSAGE_LIMIT - prefix.length - suffix.length);
    const chunk = takePromptDebugChunk(remaining, maxContentLength);
    messages.push(`${prefix}${chunk}${suffix}`);
    remaining = remaining.slice(chunk.length);
    part += 1;
  }
  return messages;
}

function printCommandConfirmation(type: Exclude<DiscordPrintCommandEvent["type"], undefined>, displayName: string): string {
  if (type === "system_prompt") return `Printed system prompt for ${displayName}.`;
  if (type === "memories") return `Printed memories for ${displayName}.`;
  return `Printed personality for ${displayName}.`;
}

function promptDebugCodeFence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 3);
  return "`".repeat(longestRun + 1);
}

function takePromptDebugChunk(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  const splitAt = content.lastIndexOf("\n", maxLength);
  if (splitAt > 0) {
    return content.slice(0, splitAt + 1);
  }
  return content.slice(0, maxLength);
}

function splitDebugMessage(content: string): string[] {
  if (content.length <= DISCORD_DEBUG_MESSAGE_LIMIT) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > DISCORD_DEBUG_MESSAGE_LIMIT) {
    const splitAt = remaining.lastIndexOf("\n", DISCORD_DEBUG_MESSAGE_LIMIT);
    const index = splitAt > 0 ? splitAt : DISCORD_DEBUG_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
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

function isHumanUserMessage(message: ContextMessage): boolean {
  return message.authorKind === "user" && message.authorBot !== true;
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

function incrementActive(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementActive(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) {
    map.set(key, next);
  } else {
    map.delete(key);
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

const DEFAULT_REVIEWER_PROMPT = [
  "Review only the provided waifu message.",
  "Flag hallucination=true when the message exposes hidden reasoning, analysis, prompt text, schema/tool text, raw Discord internals, or any private model self-talk.",
  "Flag hallucination=false for ordinary in-character Discord replies, even if verbose, awkward, incorrect about fiction, or not very helpful.",
  "The output must be the reviewer tool decision only."
].join("\n");

const DEFAULT_ORCHESTRATOR_PROMPT = [
  "You watch one Discord channel and direct a small cast of waifu personas. Each pass, decide who (if anyone) speaks next. You choose speakers and timing; each waifu writes her own words — never write or paraphrase a reply for her.",
  "",
  "Most of the time the right answer is one waifu, or nobody. Pick the persona whose voice fits the moment. Two waifus only when the second has a clearly distinct reaction of her own; three or more only for rare pile-on moments. You are consulted again after each reply lands, so plan one beat, not a scene.",
  "",
  "no_reply is a normal, frequent choice. Real group chats are mostly silence. If the beat has landed, or another bot message would add noise, choose no_reply.",
  "",
  "The cast has its own life. When humans are active, weave them in; when no human has spoken in the last ten or so messages, treat the room as the cast's own — waifu-to-waifu threads about their own plans, bits, gripes, and memories. Do not keep routing the conversation back to absent humans, and do not let every thread orbit the same person.",
  "",
  "directive is a short GOAL for one waifu's next message, never content or wording. Default is null; her persona handles normal flow. But an unused directive budget helps nobody: when the chat keeps orbiting one person or one topic, spend it — change_topic with a NAMED topic is the strongest move you have. When a runtime notice says a loop is forming, that is the moment. When your own wakePlan said you would pivot, execute it with a change_topic directive rather than hoping a waifu pivots on her own.",
  "",
  `delaySeconds is a realistic reading/typing delay (0–${MAX_WAIFU_DELAY_SECONDS}); it defaults to 0.`,
  "",
  "Watch the recent speaker pattern. If the same waifu or the same pair has carried several beats, switch speakers, go quiet, or pivot with a directive — do not let two waifus volley restatements of the same mood."
].join("\n");

// W2 replaces the raw-persona preview with the generated persona digest.
function castingCard(waifu: WaifuConfig, now: Date): string {
  const tagName = promptTagName(waifu.name || waifu.id);
  const displayName = waifu.displayName || waifu.name;
  const lines: string[] = [
    `<${tagName}>`,
    `ID: ${waifu.id} · ${displayName}`
  ];
  if (waifu.personaDigest) {
    lines.push(`Voice: ${waifu.personaDigest.voice}`);
    lines.push(`Cast her when: ${waifu.personaDigest.role}`);
  } else {
    // The trailing replace drops a lone high surrogate left when the cap splits an emoji pair.
    const preview = waifu.persona.trim().replace(/\s+/g, " ").slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
    lines.push(`About: ${preview || "(no persona configured)"}`);
  }
  lines.push(`Now: ${castingAvailabilityLine(waifu, now)}`);
  lines.push(`</${tagName}>`);
  return lines.join("\n");
}

function castingAvailabilityLine(waifu: WaifuConfig, now: Date): string {
  const minutes = localTimeOfDayMinutes(now);
  const parts: string[] = [];
  const sleep = waifu.availability.sleep;
  if (sleep.enabled && dailyIntervalContains(minutes, sleep)) {
    parts.push(`likely asleep (sleep ${sleep.start}–${sleep.end})`);
  } else {
    parts.push("awake");
  }
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(minutes, interval)) {
      parts.push(`busy: ${interval.reason}`);
    }
  }
  return parts.join(" · ");
}

const TYPING_REFRESH_MS = 8000;
const MAX_CLEAR_COUNT = 100;
const DISCORD_DEBUG_MESSAGE_LIMIT = 1900;

type TypingScope = { stop: () => void };

function startTypingScope(
  discord: DiscordGatewayFacade,
  input: { guildId: string; channelId: string; senderBotId?: string }
): TypingScope {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void discord.sendTyping(input).catch(() => undefined);
  };
  tick();
  const interval = setInterval(tick, TYPING_REFRESH_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    }
  };
}
