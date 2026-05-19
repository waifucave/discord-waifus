import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { Logger } from "../backend/logger.js";
import {
  DiscordClearCommandEvent,
  DiscordClearType,
  DiscordGatewayFacade,
  DiscordMessageEvent,
  DiscordRunCommandEvent,
  DiscordReviewCommandEvent
} from "../discord/client.js";
import { modelVisibleEmojiToken, stripLeakedContextHeader } from "../discord/normalization.js";
import { planWaifuReplyChunks, splitWaifuReply, typingDelayMs } from "./messageSplit.js";
import { getModel } from "../providers/catalog.js";
import { createModelPipeline, PipelineCredentials, ProviderPipelineError } from "../providers/pipelines.js";
import { ModelPipeline } from "../providers/types.js";
import {
  AgentConfig,
  AgentConfigSchema,
  DiscordBotsFileSchema,
  GuildEmojisFileSchema,
  MemoryStore,
  MemoryStoreSchema,
  OrchestratorHistoryFileSchema,
  ProviderCredentialsFile,
  ProviderCredentialsFileSchema,
  ReviewerHistoryFileSchema,
  ServerConfig,
  ServerConfigSchema,
  StageManagerHistoryFileSchema,
  WaifuConfig,
  WaifuConfigSchema,
  WaifuMemory,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { createRevisionedBase, nowIso } from "../shared/schemas/common.js";
import { StorageService } from "../storage/storageService.js";
import { StageManagerToolCall } from "./stageManager.js";
import {
  ChannelSessionState,
  ChannelSessionStateSchema,
  createEmptyChannelSessionState
} from "./session.js";
import { ContextMessage, OrchestratorNoReplyMarker, formatTimestamp } from "./context.js";
import {
  IDLE_TRIGGER_VALUES,
  NO_REPLY_STEP_KIND,
  OrchestratorDecision,
  OrchestratorStep
} from "./decisions.js";

export type RuntimeOrchestratorOptions = {
  storage: StorageService;
  discord: DiscordGatewayFacade;
  logger: Logger;
  maxAutomaticTurns?: number;
  continuationIdleMs?: number;
  isPaused?: () => boolean;
  onActiveRunsChange?: (activeRuns: number) => void;
  createPipeline?: (modelId: string, credentials: PipelineCredentials) => ModelPipeline;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

type ActiveChannelRun = {
  guildId: string;
  channelId: string;
  controller: AbortController;
  promise: Promise<void>;
};

type ContinuationTimer = {
  guildId: string;
  channelId: string;
  timer: NodeJS.Timeout;
};

export class RuntimeOrchestrator {
  private readonly activeRuns = new Map<string, ActiveChannelRun>();
  private readonly idleTriggerTimers = new Map<string, NodeJS.Timeout>();
  private readonly continuationTimers = new Map<string, ContinuationTimer>();
  private readonly maxAutomaticTurns: number;
  private readonly continuationIdleMs: number;
  private readonly createPipeline: (modelId: string, credentials: PipelineCredentials) => ModelPipeline;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly recentSelfSentIds = new Map<string, number>();
  private readonly activeWaifuSendChannels = new Set<string>();
  private readonly activeWaifuQueries = new Map<string, number>();
  private readonly activeReviewerRuns = new Map<string, number>();
  private readonly channelRunVersions = new Map<string, number>();
  private static readonly SELF_SENT_TTL_MS = 60_000;
  private static readonly CONTINUATION_IDLE_MS = 480_000;
  private unsubscribes: Array<() => void> = [];

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.maxAutomaticTurns = options.maxAutomaticTurns ?? 8;
    this.continuationIdleMs = options.continuationIdleMs ?? RuntimeOrchestrator.CONTINUATION_IDLE_MS;
    this.createPipeline = options.createPipeline ?? createModelPipeline;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async start(): Promise<void> {
    this.unsubscribes = [
      this.options.discord.onMessage?.((event) => {
        void this.handleDiscordMessage(event);
      }),
      this.options.discord.onReviewCommand?.((event) => {
        void this.handleReviewCommand(event);
      }),
      this.options.discord.onClearCommand?.((event) => {
        void this.handleClearCommand(event);
      }),
      this.options.discord.onRunCommand?.((event) => {
        void this.handleRunCommand(event);
      })
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    if (this.options.discord.listGuilds) {
      await this.syncGuilds();
    }
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    await this.pause();
  }

  async pause(): Promise<void> {
    for (const timer of this.idleTriggerTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTriggerTimers.clear();
    const continuationTimers = [...this.continuationTimers.values()];
    for (const entry of continuationTimers) {
      clearTimeout(entry.timer);
    }
    this.continuationTimers.clear();
    for (const run of this.activeRuns.values()) {
      run.controller.abort(new Error("runtime paused"));
    }
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.promise));
    await Promise.allSettled(
      continuationTimers.map((entry) =>
        this.clearCachedWaifuContinuation(entry.guildId, entry.channelId, "runtime paused")
      )
    );
    this.activeRuns.clear();
    this.options.onActiveRunsChange?.(0);
  }

  async handleDiscordMessage(event: DiscordMessageEvent): Promise<void> {
    if (!event.guildId || !event.channelId) return;
    if (this.wasSelfSent(event.messageId)) {
      return;
    }
    if (event.authorBot && this.activeWaifuSendChannels.has(event.channelId)) {
      return;
    }
    await this.clearCachedWaifuContinuation(event.guildId, event.channelId, "new Discord activity");
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
    await this.startChannelRun(event.guildId, event.channelId, `message:${event.messageId}`);
  }

  async triggerChannel(guildId: string, channelId: string, reason = "manual"): Promise<void> {
    if (this.options.isPaused?.()) {
      this.options.logger.warn("Manual runtime trigger ignored because runtime is paused", { guildId, channelId });
      return;
    }
    await this.startChannelRun(guildId, channelId, reason);
  }

  async triggerStageManager(guildId: string, channelId: string): Promise<void> {
    await this.runStageManager(guildId, channelId);
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
      const result = await this.clearLatestMessages(event.guildId, event.channelId, event.count ?? 1, event.type ?? "waifus");
      if (result.messageIds.length === 0) {
        await event.respond(event.type === "all" ? "No message found to clear." : "No waifu message found to clear.");
      } else if (result.deleted) {
        const messageLabel = clearMessageLabel(event.type ?? "waifus", result.logicalMessageCount);
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
      await event.respond("Started orchestrator run.");
      void this.startChannelRun(event.guildId, event.channelId, `slash-run:${event.userId}`);
    } catch (error) {
      this.options.logger.error("Run command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Run failed.");
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

  private async startChannelRun(guildId: string, channelId: string, reason: string): Promise<void> {
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
      void this.markSessionIdle(existing.guildId, existing.channelId);
    }
    const timer = this.idleTriggerTimers.get(timerKey(guildId, channelId));
    if (timer) {
      clearTimeout(timer);
      this.idleTriggerTimers.delete(timerKey(guildId, channelId));
    }

    const controller = new AbortController();
    const promise = this.runChannelLoop(guildId, channelId, controller.signal)
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
          await this.markSessionIdle(guildId, channelId);
        }
      });
    this.activeRuns.set(key, { guildId, channelId, controller, promise });
    this.options.onActiveRunsChange?.(this.activeRuns.size);
    this.options.logger.info("Channel runtime loop started", { guildId, channelId, reason });
    await promise;
  }

  private async runChannelLoop(guildId: string, channelId: string, signal: AbortSignal): Promise<void> {
    let turns = 0;
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

      const orchestrator = await this.readAgentConfig("orchestrator", 20);
      if (!orchestrator.modelId) {
        this.options.logger.warn("Orchestrator model is not configured; channel loop stopped", { guildId, channelId });
        return;
      }
      const messages = await this.options.discord.fetchFreshContext({
        guildId,
        channelId,
        limit: server.contextWindows.orchestrator ?? orchestrator.contextWindow,
        signal
      });
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
      const decisionMarkers = await this.readRecentNoReplyMarkers(guildId, channelId, messages);
      const orchestratorTyping = startTypingScope(this.options.discord, { guildId, channelId });
      let decision;
      try {
        decision = await pipeline.decideOrchestrator({
          modelId: orchestrator.modelId,
          messages,
          decisionMarkers,
          systemPrompt: this.buildOrchestratorSystemPrompt(orchestrator, server, availableWaifus),
          availableWaifuIds: availableWaifus.map((waifu) => waifu.id),
          reasoning: orchestrator.reasoning,
          signal
        });
      } finally {
        orchestratorTyping.stop();
      }
      const historySteps = decision.steps.map((step) => ({
        kind: step.kind,
        sceneDirection: step.sceneDirection,
        replyToMessageId: step.replyToMessageId
      }));
      await this.appendOrchestratorHistory({
        id: randomUUID(),
        guildId,
        channelId,
        steps: historySteps,
        idleTrigger: decision.idleTrigger,
        reasoning: decision.reasoning,
        createdAt: nowIso()
      });
      this.options.logger.info("Orchestrator decision recorded", {
        guildId,
        channelId,
        steps: historySteps.map((step) => step.kind),
        idleTrigger: decision.idleTrigger,
        reasoning: decision.reasoning
      });

      let executedCount = 0;
      const allowedWaifus = new Set(channel.enabledWaifuIds ?? []);
      for (const step of decision.steps) {
        throwIfAborted(signal);
        if (step.kind === NO_REPLY_STEP_KIND) {
          if (decision.idleTrigger === undefined) continue;
          await this.setActivePipeline(guildId, channelId, "orchestrator");
          this.options.logger.info("Chain pause", {
            guildId,
            channelId,
            idleTrigger: decision.idleTrigger
          });
          await this.sleep(decision.idleTrigger * 1000, signal);
          throwIfAborted(signal);
          executedCount += 1;
          continue;
        }
        const waifuId = step.kind;
        if (!allowedWaifus.has(waifuId)) {
          this.options.logger.warn("Orchestrator selected a waifu that is not enabled for channel", {
            guildId,
            channelId,
            selectedWaifuId: waifuId
          });
          continue;
        }
        const waifu = await this.readWaifu(waifuId).catch(() => undefined);
        if (!waifu) {
          this.options.logger.warn("Orchestrator selected an unknown waifu", {
            guildId,
            channelId,
            selectedWaifuId: waifuId
          });
          continue;
        }
        if (!waifu.botId) {
          this.options.logger.warn("Orchestrator selected a waifu without a linked Discord bot", {
            guildId,
            channelId,
            selectedWaifuId: waifuId
          });
          continue;
        }
        if (await this.sendCachedContinuationForSelection({
          guildId,
          channelId,
          selectedWaifuId: waifuId,
          sceneDirection: step.sceneDirection,
          signal
        })) {
          executedCount += 1;
          continue;
        }
        if (!waifu.modelId) {
          this.options.logger.warn("Orchestrator selected a waifu without a configured model", {
            guildId,
            channelId,
            selectedWaifuId: waifuId
          });
          continue;
        }
        await this.clearCachedWaifuContinuation(guildId, channelId, "new waifu generation");
        await this.setActivePipeline(guildId, channelId, "waifu");
        const waifuMessages = await this.options.discord.fetchFreshContext({
          guildId,
          channelId,
          limit: waifu.contextWindow || server.contextWindows.waifu,
          signal
        });
        const waifuPipeline = await this.pipelineFor(waifu.modelId);
        const waifuModelId = waifu.modelId;
        this.options.logger.info("Generating waifu reply", {
          guildId,
          channelId,
          waifuId: waifu.id,
          modelId: waifu.modelId,
          messageCount: waifuMessages.length
        });
        const waifuTyping = startTypingScope(this.options.discord, {
          guildId,
          channelId,
          senderBotId: waifu.botId
        });
        try {
          const currentWaifuAuthorIds = await this.waifuAuthorIdsFor(waifu.botId);
          const waifuQueryKey = runKey(guildId);
          incrementActive(this.activeWaifuQueries, waifuQueryKey);
          const result = await (async () => {
            try {
              return await waifuPipeline.generateWaifu({
                modelId: waifuModelId,
                messages: waifuMessages,
                systemPrompt: await this.buildWaifuSystemPrompt(guildId, waifu),
                sceneDirection: step.sceneDirection,
                temperature: waifu.generation.temperature,
                topP: waifu.generation.topP,
                maxOutputTokens: waifu.generation.maxOutputTokens,
                reasoning: waifu.reasoning,
                currentWaifuAuthorIds,
                signal
              });
            } finally {
              decrementActive(this.activeWaifuQueries, waifuQueryKey);
            }
          })();
          const activeAuthorIds = waifuMessages.map((message) => message.authorId);
          const cleanedContent = stripLeakedContextHeader(result.content, {
            senderDisplayName: waifu.displayName
          });
          if (cleanedContent !== result.content) {
            this.options.logger.warn("Stripped leaked context header from waifu reply", {
              guildId,
              channelId,
              waifuId: waifu.id,
              before: result.content.slice(0, 80),
              after: cleanedContent.slice(0, 80)
            });
          }
          const chunks = splitWaifuReply(cleanedContent);
          if (chunks.length === 0) {
            this.options.logger.warn("Waifu reply was empty after cleaning; nothing sent", {
              guildId,
              channelId,
              waifuId: waifu.id
            });
          }
          const plannedChunks = planWaifuReplyChunks(chunks);
          const replyToMessageId = replyTargetForFreshContext(step.replyToMessageId, waifuMessages);
          if (step.replyToMessageId && !replyToMessageId) {
            this.options.logger.info("Omitting reply target because it is the latest context message", {
              guildId,
              channelId,
              waifuId: waifu.id,
              replyToMessageId: step.replyToMessageId
            });
          }
          await this.sendWaifuChunks({
            guildId,
            channelId,
            waifuId: waifu.id,
            senderBotId: waifu.botId,
            chunks: plannedChunks.immediateChunks,
            totalChunkCount: chunks.length,
            replyToMessageId,
            allowedUserMentionIds: activeAuthorIds,
            signal
          });
          if (plannedChunks.cachedChunks.length > 0) {
            await this.cacheWaifuContinuation({
              guildId,
              channelId,
              waifuId: waifu.id,
              senderBotId: waifu.botId,
              chunks: plannedChunks.cachedChunks,
              allowedUserMentionIds: activeAuthorIds
            });
          }
        } finally {
          waifuTyping.stop();
        }
        executedCount += 1;
      }
      if (executedCount === 0) {
        this.options.logger.info("Channel runtime loop stopped because no steps were executed", {
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
    await this.scheduleIdleTrigger(guildId, channelId, 100);
  }

  private async runStageManager(guildId: string, channelId: string): Promise<void> {
    const state = await this.ensureChannelSession(guildId, channelId);
    if (state.stageManager.active) return;
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      stageManager: { active: true, startedAt: nowIso() }
    }));
    try {
      const server = await this.ensureServer(guildId);
      const config = await this.readAgentConfig("stage-manager", 80);
      if (!config.enabled || !config.modelId) {
        return;
      }
      const pipeline = await this.pipelineFor(config.modelId);
      if (!pipeline.decideStageManager) {
        throw new Error(`Model ${config.modelId} does not implement stage-manager decisions.`);
      }
      const messages = await this.options.discord.fetchFreshContext({
        guildId,
        channelId,
        limit: server.contextWindows.stageManager ?? config.contextWindow
      });
      const store = await this.readMemoryStore();
      const calls = await pipeline.decideStageManager({
        modelId: config.modelId,
        messages,
        systemPrompt: config.prompt,
        memories: store.memories,
        reasoning: config.reasoning
      });
      const result = await this.applyStageManagerCalls(calls);
      for (const entry of result.historyEntries) {
        await this.appendStageManagerHistory({
          ...entry,
          guildId,
          channelId
        });
      }
      if (result.changed) {
        const sent = await this.options.discord.sendWaifuMessage({
          guildId,
          channelId,
          content: "memories updated",
          allowedUserMentionIds: []
        });
        this.rememberSelfSent(sent.messageId);
      }
    } catch (error) {
      this.options.logger.error("Stage manager failed", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await this.updateSession(guildId, channelId, (current) => ({
        ...current,
        stageManager: { active: false }
      }));
    }
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
      void this.startChannelRun(input.guildId, input.channelId, "reviewer-complete");
    } else if (noNewChannelRun && input.triggerAfterActiveRun) {
      setTimeout(() => {
        if ((this.channelRunVersions.get(versionKey) ?? 0) === runVersionAtStart && !this.activeRuns.has(runKey(input.guildId))) {
          void this.startChannelRun(input.guildId, input.channelId, "reviewer-complete");
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
      .filter((message) => type === "all" || message.authorKind === "waifu")
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

  private async applyStageManagerCalls(calls: StageManagerToolCall[]): Promise<{
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

    const changed = calls.some((call) => call.tool !== "no_change");
    if (!changed) {
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

    await this.options.storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      transform: (current) => {
        let memories = [...current.memories];
        for (const call of calls) {
          if (call.tool === "add_memory") {
            const id = randomUUID();
            memories.push({
              id,
              waifuId: call.memory.waifuId,
              scope: call.memory.scope,
              content: call.memory.content,
              importance: call.memory.importance,
              sourceMessageIds: call.memory.sourceMessageIds,
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
          } else if (call.tool === "update_memory") {
            memories = memories.map((memory) =>
              memory.id === call.memoryId
                ? { ...memory, ...call.patch, id: memory.id, createdAt: memory.createdAt, updatedAt: now }
                : memory
            );
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [call.memoryId],
              summary: "Updated memory",
              createdAt: now
            });
          } else if (call.tool === "archive_memory") {
            memories = memories.map((memory) =>
              memory.id === call.memoryId ? { ...memory, status: "archived", updatedAt: now } : memory
            );
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [call.memoryId],
              summary: "Archived memory",
              createdAt: now
            });
          } else if (call.tool === "merge_memories") {
            const id = randomUUID();
            const source = memories.filter((memory) => call.sourceMemoryIds.includes(memory.id));
            memories = memories
              .map((memory) =>
                call.sourceMemoryIds.includes(memory.id)
                  ? { ...memory, status: "archived" as const, updatedAt: now }
                  : memory
              )
              .concat({
                id,
                waifuId: source[0]?.waifuId ?? "global",
                scope: source[0]?.scope ?? "global",
                content: call.mergedContent,
                importance: 3,
                sourceMessageIds: [...new Set(source.flatMap((memory) => memory.sourceMessageIds))],
                createdAt: now,
                updatedAt: now,
                status: "active"
              });
            historyEntries.push({
              id: randomUUID(),
              tool: call.tool,
              affectedMemoryIds: [id, ...call.sourceMemoryIds],
              summary: call.mergedContent,
              createdAt: now
            });
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

  private async scheduleIdleTrigger(guildId: string, channelId: string, seconds: number): Promise<void> {
    const bounded = Math.max(100, Math.min(28_800, seconds));
    const key = timerKey(guildId, channelId);
    const at = new Date(Date.now() + bounded * 1000).toISOString();
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      scheduledIdleTriggerAt: at,
      activePipeline: null
    }));
    const timer = setTimeout(() => {
      this.idleTriggerTimers.delete(key);
      void this.startChannelRun(guildId, channelId, "scheduled-idle-trigger");
    }, bounded * 1000);
    this.idleTriggerTimers.set(key, timer);
  }

  private async sendCachedContinuationForSelection(input: {
    guildId: string;
    channelId: string;
    selectedWaifuId: string;
    sceneDirection?: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    if (input.sceneDirection?.trim()) {
      return false;
    }
    const state = await this.readChannelSession(input.guildId, input.channelId);
    const cached = state.cachedWaifuContinuation;
    if (!cached || cached.waifuId !== input.selectedWaifuId) {
      return false;
    }
    return this.sendCachedWaifuContinuation(input.guildId, input.channelId, "same-waifu-no-scene-direction", input.signal);
  }

  private async sendCachedWaifuContinuation(
    guildId: string,
    channelId: string,
    reason: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    throwIfAborted(signal);
    const state = await this.readChannelSession(guildId, channelId);
    const cached = state.cachedWaifuContinuation;
    if (!cached) {
      return false;
    }

    await this.clearCachedWaifuContinuation(guildId, channelId, `sending cached continuation: ${reason}`);
    this.options.logger.info("Sending cached waifu continuation", {
      guildId,
      channelId,
      waifuId: cached.waifuId,
      reason,
      chunkCount: cached.chunks.length
    });
    await this.sendWaifuChunks({
      guildId,
      channelId,
      waifuId: cached.waifuId,
      senderBotId: cached.senderBotId,
      chunks: cached.chunks,
      totalChunkCount: cached.chunks.length,
      allowedUserMentionIds: cached.allowedUserMentionIds,
      signal
    });
    return true;
  }

  private async sendCachedContinuationAfterIdle(guildId: string, channelId: string): Promise<void> {
    if (this.options.isPaused?.()) {
      await this.clearCachedWaifuContinuation(guildId, channelId, "runtime paused before cached continuation");
      return;
    }
    if (this.activeRuns.has(runKey(guildId))) {
      this.setContinuationTimer(guildId, channelId, Math.min(1000, Math.max(1, this.continuationIdleMs)));
      return;
    }
    const sent = await this.sendCachedWaifuContinuation(guildId, channelId, "idle-timeout");
    if (sent) {
      await this.startChannelRun(guildId, channelId, "cached-continuation");
    }
  }

  private async cacheWaifuContinuation(input: {
    guildId: string;
    channelId: string;
    waifuId: string;
    senderBotId: string;
    chunks: string[];
    allowedUserMentionIds: string[];
  }): Promise<void> {
    if (input.chunks.length === 0) {
      return;
    }

    const cachedAt = nowIso();
    const idleAfter = new Date(Date.now() + this.continuationIdleMs).toISOString();
    await this.updateSession(input.guildId, input.channelId, (current) => ({
      ...current,
      cachedWaifuContinuation: {
        waifuId: input.waifuId,
        senderBotId: input.senderBotId,
        chunks: input.chunks,
        allowedUserMentionIds: input.allowedUserMentionIds,
        cachedAt,
        idleAfter
      }
    }));
    this.scheduleContinuationTimer(input.guildId, input.channelId, idleAfter);
    this.options.logger.info("Cached unsent waifu continuation chunks", {
      guildId: input.guildId,
      channelId: input.channelId,
      waifuId: input.waifuId,
      chunkCount: input.chunks.length,
      idleAfter
    });
  }

  private async clearCachedWaifuContinuation(guildId: string, channelId: string, reason: string): Promise<void> {
    const key = timerKey(guildId, channelId);
    const timer = this.continuationTimers.get(key);
    if (timer) {
      clearTimeout(timer.timer);
      this.continuationTimers.delete(key);
    }

    const state = await this.readChannelSession(guildId, channelId);
    if (!state.cachedWaifuContinuation) {
      return;
    }
    const cached = state.cachedWaifuContinuation;
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      cachedWaifuContinuation: null
    }));
    this.options.logger.info("Cleared cached waifu continuation chunks", {
      guildId,
      channelId,
      waifuId: cached.waifuId,
      reason,
      chunkCount: cached.chunks.length
    });
  }

  private scheduleContinuationTimer(guildId: string, channelId: string, idleAfter: string): void {
    const delayMs = Math.max(0, new Date(idleAfter).getTime() - Date.now());
    this.setContinuationTimer(guildId, channelId, delayMs);
  }

  private setContinuationTimer(guildId: string, channelId: string, delayMs: number): void {
    const key = timerKey(guildId, channelId);
    const existing = this.continuationTimers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.continuationTimers.delete(key);
      void this.sendCachedContinuationAfterIdle(guildId, channelId).catch((error) => {
        this.options.logger.error("Cached waifu continuation failed", {
          guildId,
          channelId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, delayMs);
    this.continuationTimers.set(key, { guildId, channelId, timer });
  }

  private async sendWaifuChunks(input: {
    guildId: string;
    channelId: string;
    waifuId: string;
    senderBotId: string;
    chunks: string[];
    totalChunkCount: number;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
    signal?: AbortSignal;
  }): Promise<void> {
    if (input.chunks.length === 0) {
      return;
    }
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
        this.options.logger.info("Waifu message chunk sent", {
          guildId: input.guildId,
          channelId: input.channelId,
          waifuId: input.waifuId,
          chunkIndex: i,
          chunkCount: input.totalChunkCount,
          chunkLength: input.chunks[i].length
        });
      }
    } finally {
      this.activeWaifuSendChannels.delete(input.channelId);
    }
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
    const waifusById = new Map(waifus.filter((waifu) => waifu.modelId).map((waifu) => [waifu.id, waifu]));
    return (channel.enabledWaifuIds ?? [])
      .map((waifuId) => waifusById.get(waifuId))
      .filter((waifu): waifu is WaifuConfig => Boolean(waifu));
  }

  private async readMemoryStore(): Promise<MemoryStore> {
    return this.options.storage.readJson("user/memories.json", MemoryStoreSchema, emptyMemoryStore());
  }

  private async buildWaifuSystemPrompt(guildId: string, waifu: WaifuConfig): Promise<string> {
    const [store, emojis] = await Promise.all([
      this.readMemoryStore(),
      this.options.storage.readJson(
        path.join("user", "servers", guildId, "emojis.json"),
        GuildEmojisFileSchema,
        GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
      )
    ]);
    const memories = store.memories
      .filter((memory) => memory.waifuId === waifu.id && memory.status === "active")
      .map((memory) => `- ${memory.content}`)
      .join("\n");
    const emojiList = emojis.emojis
      .filter((emoji) => emoji.available)
      .map(modelVisibleEmojiToken)
      .join(" ");
    const behaviorTag = `${sanitizeTagName(waifu.name)}_behavior`;
    const hardRules = [
      "Each incoming message in this conversation arrives wrapped in inbound-only metadata tags so you can read context:",
      "a `[timestamp: ISO-8601 UTC]` prefix telling you when the message was sent, a `[sender: DisplayName]` prefix telling you who said it,",
      "and optionally `[reactions: ...]` and `[replying to: ...]` suffixes after the body.",
      "These tags are framing only — they are NOT part of what the speaker actually wrote, and they are NOT how Discord messages look.",
      "Your reply is the raw message body that will be sent verbatim to Discord. It MUST NOT contain any bracketed metadata tag (no `[timestamp: ...]`, no `[sender: ...]`, no `[reactions: ...]`, no `[replying to: ...]`, no `[index: ...]`, no `[scene_direction: ...]`, no other `[tag: value]` constructions).",
      "It MUST NOT begin with your own display name followed by a colon, and MUST NOT quote or paraphrase any prior message's framing tags. Begin with the first word you are actually saying."
    ].join(" ");

    const personaText = waifu.persona.trim();
    const personalityContent = personaText
      ? `You are ${waifu.displayName}. Stay in character.\n${personaText}`
      : `You are ${waifu.displayName}. Stay in character.`;

    const environmentRules = [
      "You are chatting in a live Discord text channel — this is a real chat room with real users, not a roleplay scene, story, or chat fiction.",
      "Write one Discord-safe message per turn.",
      "Do not output physical actions, roleplay narration, or stage directions. No asterisks-wrapped actions like *smiles* or *waves*, no parenthetical stage notes like (hugs them), no bracketed cues like [walks over]. Only write what you would actually type into a chat box.",
      "Keep replies short. One or two sentences is the norm; match the casual pacing of a Discord conversation rather than writing paragraphs.",
      "Avoid long sentences and long replies.",
      "If a reply would otherwise become long, break it into shorter, standalone sentences instead of writing one run-on sentence. Each sentence in your reply is delivered as a separate Discord message, so short sentences read as a natural back-and-forth instead of a wall of text.",
      "Reply with only what you would actually type — no narration, no meta commentary, no describing yourself in the third person.",
      "To ping a user, write <@sender> — where `sender` is copied verbatim from the [sender: ...] tag on one of their messages. Example: a message tagged [sender: Kevin] is pinged as <@Kevin>. Never use raw Discord IDs.",
      "Use only listed server emojis."
    ].join("\n");

    const behaviorSections: string[] = [
      `<hard_rules>\n${hardRules}\n</hard_rules>`,
      `<personality_instructions>\n${personalityContent}\n</personality_instructions>`,
      `<environment_instructions>\n${environmentRules}\n</environment_instructions>`
    ];
    if (memories) {
      behaviorSections.push(`<memories>\n${memories}\n</memories>`);
    }
    const behaviorBlock = `<${behaviorTag}>\n${behaviorSections.join("\n")}\n</${behaviorTag}>`;

    const currentTimeBlock = `<current_time>\n${formatTimestamp(new Date())} (UTC)\n</current_time>`;
    const emojiBlock = `<available_server_emojis>\n${emojiList || "(none cached)"}\n</available_server_emojis>`;

    return `${behaviorBlock}\n${emojiBlock}\n${currentTimeBlock}`;
  }

  private buildOrchestratorSystemPrompt(
    orchestrator: AgentConfig,
    server: ServerConfig,
    availableWaifus: WaifuConfig[]
  ): string {
    const activeWaifusContent = availableWaifus.length
      ? availableWaifus
          .map((waifu) => {
            const tagName = promptTagName(waifu.name || waifu.id);
            const displayName = waifu.displayName || waifu.name;
            const persona = waifu.persona.trim();
            const personaBlock = persona || "(no persona configured)";
            return `<${tagName}>\nID: ${waifu.id}\nDisplay name: ${displayName}\nPersona:\n${personaBlock}\n</${tagName}>`;
          })
          .join("\n\n")
      : "No waifus are currently enabled for this channel.";

    const identity =
      "You are the orchestrator for a multi-character Discord bot. On every incoming Discord message you decide an ordered chain of next moves — which (if any) waifus reply, in what order, with what scene direction, and where to insert paced pauses before the chain continues.";

    const idleTriggerEnumDisplay = IDLE_TRIGGER_VALUES.join(", ");
    const hardRules = [
      "- Every waifu step's kind must be copied verbatim from one of the IDs listed in <active_waifus>. The only other allowed kind is the literal \"no_reply\".",
      "- steps is an ordered, non-empty list. Steps execute sequentially: waifu steps post that waifu's reply; no_reply steps sleep for idleTrigger seconds. Any incoming chat message cancels the rest of the chain.",
      `- idleTrigger must be one of: ${idleTriggerEnumDisplay}. Include it only when steps contains at least one \"no_reply\"; omit it otherwise.`,
      "- Use replyToIndex only when replying to an older message that is no longer the latest visible message, and only on waifu steps. If a waifu is answering the latest message in chat, omit replyToIndex so Discord sends a normal message.",
      "- If you want a waifu to do or say something specific, you MUST put it in her step's sceneDirection. She does not see your reasoning — she only sees her own persona, the chat, and the sceneDirection. sceneDirection is only valid on waifu steps.",
      "- Consecutive waifu messages are a soft signal, not a ban. More consecutive waifus in a chain require a stronger reason: a fresh beat, escalation, interruption, joke, reaction, or emotional shift."
    ].join("\n");

    const taskInstructions = DEFAULT_ORCHESTRATOR_PROMPT;

    const loopBreaking = [
      "The recent messages in context are your most important signal. If the waifus are circling the same topic, the same vibe, or the same back-and-forth, they will keep circling unless you actively redirect them — each waifu only sees her own persona and the chat, so only you can see the loop forming from the outside.",
      "When you notice a loop forming (even a soft one — two or three messages already feeling similar is enough), pick the waifu whose personality most naturally fits a hard pivot and write a concrete sceneDirection that lands a brand-new topic, observation, memory, callback, or non-sequitur. Name the specific new topic in the sceneDirection — \"ask about Kevin's dog\", \"bring up the snowstorm last week\", \"complain about being hungry\" — rather than vague instructions like \"change the subject\". A jarring shift that still feels in-character is better than letting the conversation stagnate."
    ].join("\n\n");

    const idleTriggerPacing = [
      `idleTrigger is the duration (in seconds) of each "no_reply" pause in the chain. It is constrained to one of: ${idleTriggerEnumDisplay}.`,
      "",
      "A no_reply step is not a generic monitoring tick. It is a deliberate, planned pause inserted between or after waifu replies — a delayed opportunity for a future beat. If you have no specific conversational reason for a future beat, do not insert a no_reply.",
      "",
      "Human messages automatically retrigger the orchestrator, so there is no need to wake up soon just to check whether someone talked. Any incoming chat message during a no_reply pause also cancels the remaining chain and triggers a fresh orchestrator pass.",
      "",
      "When choosing idleTrigger, think in terms of intent:",
      "- 180s / 300s: moments that feel alive and may benefit from a natural waifu follow-up shortly after, if nobody responds first.",
      "- 900s / 1800s: cooling rooms where a waifu might revive the chat soon, but not immediately.",
      "- 3600s / 7200s / 14400s: quiet rooms where you are mostly waiting for humans and the next bot-led beat is a long shot.",
      "",
      "Patterns to think in:",
      "- [waifu1] — one waifu replies; no pause, no trailing wake-up. Use when a single reply is enough and the next move should be left to humans.",
      "- [waifu1, waifu2] — chain two waifus back-to-back; the second only fires if waifu1 isn't interrupted. Use when two waifus' voices belong in sequence.",
      "- [waifu1, no_reply, waifu2] with idleTrigger — waifu1 replies, then a pause, then waifu2 if nobody interrupted. The pause is for breathing room or letting the room react.",
      "- [waifu1, no_reply] with idleTrigger — waifu1 replies, then the orchestrator wakes after the pause to re-evaluate. Use when you might want a follow-up but want to give the room a chance first.",
      "- [no_reply] with idleTrigger — pure wait. Use when no waifu should speak now but you want to re-check the room after a delay.",
      "",
      "If the wake-up fires and the room is still quiet, you can choose no_reply again with a longer idleTrigger. Don't grind on a dead channel."
    ].join("\n");

    const messageStructure = [
      "Each message in the context is tagged with [index: #N], [timestamp: ISO-8601 UTC], and [sender: DisplayName] before its body, optionally followed by [reactions: ...] and [replying to: ...]. Reference messages by their #N index. replyToIndex must be one of the #N indices shown in the context.",
      "Some lines are your own prior decisions, interleaved with the chat by timestamp. They look like [no_reply] [timestamp: ...] [reason: ...] [idle_trigger: Ns] and have no #N index, no sender, no reactions, and no replying-to. They are not Discord messages — nobody else sees them. Use them to gauge how long the channel has actually been silent under your watch and to avoid stacking redundant no_reply choices."
    ].join("\n");

    const toolUse = [
      "Inspect the context and call orchestrator_decision once with the tool arguments. Do not write normal assistant text.",
      "Argument shape:",
      "{",
      "  \"steps\": [",
      "    { \"kind\": waifuId | \"no_reply\", \"sceneDirection\"?: string, \"replyToIndex\"?: number },",
      "    ...",
      "  ],",
      `  \"idleTrigger\"?: ${idleTriggerEnumDisplay},`,
      "  \"reasoning\": string",
      "}",
      "Rules:",
      "- steps must be non-empty and ordered. Steps execute sequentially; any incoming chat message cancels the remainder of the chain.",
      "- Each step's kind is either a waifu id from <active_waifus> or the literal \"no_reply\". Use \"no_reply\" only when you want a paced pause in the chain.",
      "- sceneDirection and replyToIndex are only valid on waifu steps. Omit them on \"no_reply\" steps.",
      `- Include idleTrigger (one of ${idleTriggerEnumDisplay}) when steps contains at least one \"no_reply\"; omit it otherwise. The same idleTrigger applies to every no_reply step in the chain.`
    ].join("\n");

    const sections = orchestrator.promptSections;
    const behavior = [
      `<task_instructions>\n${taskInstructions}\n</task_instructions>`,
      sections.loopBreaking ? `<loop_breaking>\n${loopBreaking}\n</loop_breaking>` : null,
      sections.idleTriggerPacing ? `<idle_trigger_pacing>\n${idleTriggerPacing}\n</idle_trigger_pacing>` : null,
      sections.messageStructure ? `<message_structure>\n${messageStructure}\n</message_structure>` : null,
      sections.toolUse ? `<tool_use>\n${toolUse}\n</tool_use>` : null,
      `<hard_rules>\n${hardRules}\n</hard_rules>`
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n");

    return [
      `<identity>\n${identity}\n</identity>`,
      `<behavior>\n${behavior}\n</behavior>`,
      `<discord_server_information>\n${server.name ?? server.guildId}\n</discord_server_information>`,
      `<active_waifus>\n${activeWaifusContent}\n</active_waifus>`
    ].join("\n");
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
    return this.options.storage.updateRevisionedJson({
      resourceKey: `server:${server.guildId}`,
      relativePath: path.join("user", "servers", server.guildId, "server.json"),
      schema: ServerConfigSchema,
      fallback: server,
      transform: (current) => ({
        ...current,
        channels: {
          ...current.channels,
          [channelId]: {
            channelId,
            enabled: false,
            enabledWaifuIds: []
          }
        }
      })
    });
  }

  private channelHasWaifus(channel: ServerConfig["channels"][string] | undefined): boolean {
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

  private async readRecentNoReplyMarkers(
    guildId: string,
    channelId: string,
    messages: ContextMessage[]
  ): Promise<OrchestratorNoReplyMarker[]> {
    if (!messages.length) return [];
    const latest = messages.reduce(
      (latestTimestamp, message) => message.timestamp > latestTimestamp ? message.timestamp : latestTimestamp,
      messages[0].timestamp
    );
    const history = await this.options.storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }))
    );
    const markers: OrchestratorNoReplyMarker[] = [];
    for (const decision of history.decisions) {
      if (decision.guildId !== guildId) continue;
      if (decision.channelId !== channelId) continue;
      if (decision.idleTrigger === undefined) continue;
      const noReplyCount = decision.steps.filter((step) => step.kind === NO_REPLY_STEP_KIND).length;
      if (noReplyCount === 0) continue;
      const timestamp = formatTimestamp(new Date(decision.createdAt));
      if (timestamp <= latest) continue;
      for (let i = 0; i < noReplyCount; i += 1) {
        markers.push({
          kind: "no_reply",
          timestamp,
          idleTrigger: decision.idleTrigger,
          reasoning: decision.reasoning
        });
      }
    }
    return markers;
  }

  private async appendOrchestratorHistory(entry: {
    id: string;
    guildId: string;
    channelId: string;
    steps: Array<{ kind: string; sceneDirection?: string; replyToMessageId?: string }>;
    idleTrigger?: 180 | 300 | 900 | 1800 | 3600 | 7200 | 14400;
    reasoning: string;
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

  private async appendStageManagerHistory(entry: {
    id: string;
    guildId?: string;
    channelId?: string;
    tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
    affectedMemoryIds: string[];
    summary: string;
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
      await this.options.storage.updateRevisionedJson({
        resourceKey: `server:${guild.guildId}`,
        relativePath: path.join("user", "servers", guild.guildId, "server.json"),
        schema: ServerConfigSchema,
        fallback: ServerConfigSchema.parse({
          ...createRevisionedBase(),
          guildId: guild.guildId,
          name: guild.name,
          enabled: true
        }),
        transform: (current) => ({
          ...current,
          name: current.name ?? guild.name
        })
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

  private async waifuAuthorIdsFor(botId: string): Promise<string[]> {
    const bots = await this.options.storage.readJson(
      "user/discord-bots.json",
      DiscordBotsFileSchema,
      DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
    );
    const match = bots.waifus.find((bot) => bot.id === botId);
    if (!match) return [botId];
    return [match.id, match.applicationId].filter((id): id is string => Boolean(id));
  }
}

function emptyMemoryStore(): MemoryStore {
  return MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }));
}

function sanitizeTagName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "waifu";
}

function runKey(guildId: string): string {
  return guildId;
}

function timerKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function sessionRelativePath(guildId: string, channelId: string): string {
  return path.join("user", "servers", guildId, "sessions", `${channelId}.json`);
}

function replyTargetForFreshContext(
  replyToMessageId: string | undefined,
  messages: Array<{ id: string }>
): string | undefined {
  if (!replyToMessageId) return undefined;
  const latestMessage = messages.at(-1);
  return latestMessage?.id === replyToMessageId ? undefined : replyToMessageId;
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

function normalizeClearCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(MAX_CLEAR_COUNT, Math.trunc(count)));
}

function clearMessageLabel(type: DiscordClearType, count: number): string {
  if (type === "all") return count === 1 ? "message" : "messages";
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

function promptTagName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `waifu_${normalized || "unknown"}`;
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
  "You watch one Discord channel and orchestrate a small cast of waifu personas. On each new message, decide from outside the scene an ordered chain of steps: which waifus speak (in what order, with what scene direction) and where to insert paced \"no_reply\" pauses before the chain continues.",
  "",
  "Be natural. Real group chats do not require everyone to reply every time, and not every beat needs a response — treat the room like a living scene, not a turn-taking queue. Pacing, silence, interruption, overlap, comedy, and escalation are all valid moves. Pick the waifu whose personality fits the moment based on her voice and the current flow; the same waifu may speak again, a different one may jump in, or two may chain if it feels right.",
  "",
  "Each step in your chain is either a waifu id (post that waifu's reply) or the literal \"no_reply\" (sleep idleTrigger seconds before continuing). A chain of just one no_reply means \"don't speak now; re-evaluate after the pause.\" Steps run sequentially and any incoming chat message cancels the remainder, so plan the chain you'd commit to if nobody interrupts.",
  "",
  "If a recent chat participant message or direct ping was missed while the room moved on, prefer steering a waifu to acknowledge it so the chat stays socially inclusive — unless silence is clearly the more natural choice.",
  "",
  "Reach for sceneDirection when the next reply needs steering that personality alone won't provide: redirecting topic, closing a beat, creating an interruption, shifting momentum, or deliberately starting something new even when it cuts against the current flow. Prefer a natural bridge when pivoting, but a jarring shift is fine if the scene needs it. Keep sceneDirection short, concrete, and immediately actionable — one sentence is usually enough. When you refer to a specific person, use their actual display name from the chat history, never generic phrases like \"the user\". Name intended participants explicitly when more than one person is involved; avoid ambiguous group references like \"us\", \"them\", or \"everyone\". If multiple waifus respond in the same turn, each may receive a different sceneDirection.",
  "",
  "When the trigger is a waifu follow-up, do not treat the last waifu as the default speaker. Re-evaluate the room from outside the scene: the same waifu may continue, another waifu may cut in, multiple waifus may chain, or the room may go quiet.",
  "",
  "Pay special attention to the latest 10 messages and the recent speaker pattern. If the same waifu has been carrying the scene for multiple beats, strongly consider switching to another waifu, using no_reply, or using sceneDirection to create a fresh beat.",
  "",
  "Do not wait for humans to explicitly call a different waifu before rotating speakers. A different waifu may naturally interrupt, tease, redirect, react, or start a new angle when it would make the chat more fun or less repetitive.",
  "",
  "Continue a waifu-to-waifu chain only when the next message adds something new: escalation, interruption, joke, emotional shift, contradiction, surprise, or a new topic. Do not continue just to restate the same mood."
].join("\n");

const TYPING_REFRESH_MS = 8000;
const MAX_CLEAR_COUNT = 100;

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
