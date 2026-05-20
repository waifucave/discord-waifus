import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
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
import { splitWaifuReply, typingDelayMs } from "./messageSplit.js";
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
  OrchestratorRespondingWaifu,
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
  MAX_WAIFU_DELAY_SECONDS,
  OrchestratorDecision,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS
} from "./decisions.js";

export type RuntimeOrchestratorOptions = {
  storage: StorageService;
  discord: DiscordGatewayFacade;
  logger: Logger;
  maxAutomaticTurns?: number;
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

export class RuntimeOrchestrator {
  private readonly activeRuns = new Map<string, ActiveChannelRun>();
  private readonly retriggerTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxAutomaticTurns: number;
  private readonly createPipeline: (modelId: string, credentials: PipelineCredentials) => ModelPipeline;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly recentSelfSentIds = new Map<string, number>();
  private readonly activeWaifuSendChannels = new Set<string>();
  private readonly activeWaifuQueries = new Map<string, number>();
  private readonly activeReviewerRuns = new Map<string, number>();
  private readonly channelRunVersions = new Map<string, number>();
  private static readonly SELF_SENT_TTL_MS = 60_000;
  private unsubscribes: Array<() => void> = [];

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.maxAutomaticTurns = options.maxAutomaticTurns ?? 8;
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
    for (const timer of this.retriggerTimers.values()) {
      clearTimeout(timer);
    }
    this.retriggerTimers.clear();
    for (const run of this.activeRuns.values()) {
      run.controller.abort(new Error("runtime paused"));
    }
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.promise));
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
    const timer = this.retriggerTimers.get(timerKey(guildId, channelId));
    if (timer) {
      clearTimeout(timer);
      this.retriggerTimers.delete(timerKey(guildId, channelId));
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
      let decision: OrchestratorDecision;
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
      decision = capDecisionDelays(decision);
      await this.appendOrchestratorHistory({
        id: randomUUID(),
        guildId,
        channelId,
        action: decision.action,
        respondingWaifus: decision.respondingWaifus,
        retriggerAfterSeconds: decision.retriggerAfterSeconds,
        reasoning: decision.reasoning,
        createdAt: nowIso()
      });
      this.options.logger.info("Orchestrator decision recorded", {
        guildId,
        channelId,
        action: decision.action,
        responders: decision.respondingWaifus.map((entry) => entry.waifuId),
        retriggerAfterSeconds: decision.retriggerAfterSeconds,
        reasoning: decision.reasoning
      });

      if (decision.action === "no_reply") {
        const seconds = decision.retriggerAfterSeconds ?? RETRIGGER_MIN_SECONDS;
        await this.scheduleRetrigger(guildId, channelId, seconds);
        return;
      }

      let executedCount = 0;
      let directHandoffCount = 0;
      const allowedWaifus = new Set(channel.enabledWaifuIds ?? []);
      const responderQueue = [...decision.respondingWaifus];
      while (responderQueue.length > 0) {
        throwIfAborted(signal);
        const responder = responderQueue.shift();
        if (!responder) continue;
        if (!allowedWaifus.has(responder.waifuId)) {
          this.options.logger.warn("Orchestrator selected a waifu that is not enabled for channel", {
            guildId,
            channelId,
            selectedWaifuId: responder.waifuId
          });
          continue;
        }
        const waifu = await this.readWaifu(responder.waifuId).catch(() => undefined);
        if (!waifu) {
          this.options.logger.warn("Orchestrator selected an unknown waifu", {
            guildId,
            channelId,
            selectedWaifuId: responder.waifuId
          });
          continue;
        }
        if (!waifu.botId) {
          this.options.logger.warn("Orchestrator selected a waifu without a linked Discord bot", {
            guildId,
            channelId,
            selectedWaifuId: responder.waifuId
          });
          continue;
        }
        if (!waifu.modelId) {
          this.options.logger.warn("Orchestrator selected a waifu without a configured model", {
            guildId,
            channelId,
            selectedWaifuId: responder.waifuId
          });
          continue;
        }
        if (responder.delaySeconds > 0) {
          const cappedDelaySeconds = Math.min(responder.delaySeconds, MAX_WAIFU_DELAY_SECONDS);
          const cappedDelayMs = cappedDelaySeconds * 1000;
          this.options.logger.info("Waiting before waifu reply", {
            guildId,
            channelId,
            waifuId: waifu.id,
            delaySeconds: cappedDelaySeconds
          });
          await this.sleep(cappedDelayMs, signal);
          throwIfAborted(signal);
        }
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
          messageCount: waifuMessages.length,
          replyStyle: responder.replyStyle
        });
        const waifuTyping = startTypingScope(this.options.discord, {
          guildId,
          channelId,
          senderBotId: waifu.botId
        });
        try {
          const currentWaifuAuthorIds = await this.waifuAuthorIdsFor(waifu.botId);
          const nextWaifuIds = availableWaifus
            .filter((candidate) => candidate.id !== waifu.id && candidate.botId && candidate.modelId)
            .map((candidate) => candidate.id);
          const waifuQueryKey = runKey(guildId);
          incrementActive(this.activeWaifuQueries, waifuQueryKey);
          const result = await (async () => {
            try {
              return await waifuPipeline.generateWaifu({
                modelId: waifuModelId,
                messages: waifuMessages,
                systemPrompt: await this.buildWaifuSystemPrompt(guildId, waifu, availableWaifus),
                sceneDirection: responder.sceneDirection,
                replyStyle: responder.replyStyle,
                availableWaifuIds: nextWaifuIds,
                pickNextWaifuToolEnabled: waifu.tools.pickNextWaifu,
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
          const replyToMessageId = replyTargetForFreshContext(responder.replyToMessageId, waifuMessages);
          if (responder.replyToMessageId && !replyToMessageId) {
            this.options.logger.info("Omitting reply target because it is the latest context message", {
              guildId,
              channelId,
              waifuId: waifu.id,
              replyToMessageId: responder.replyToMessageId
            });
          }
          await this.sendWaifuChunks({
            guildId,
            channelId,
            waifuId: waifu.id,
            senderBotId: waifu.botId,
            chunks,
            replyToMessageId,
            allowedUserMentionIds: activeAuthorIds,
            signal
          });
          if (result.rejectedPickNextWaifu) {
            this.options.logger.warn("Ignoring invalid PickNextWaifu call from waifu", {
              guildId,
              channelId,
              waifuId: waifu.id,
              attemptedWaifuId: result.rejectedPickNextWaifu.waifuId,
              attemptedSelfPick: result.rejectedPickNextWaifu.waifuId === waifu.id,
              reason: result.rejectedPickNextWaifu.reason
            });
          } else if (result.pickedNextWaifuId && directHandoffCount < this.maxAutomaticTurns) {
            directHandoffCount += 1;
            this.options.logger.info("Waifu picked next waifu; skipping orchestrator for direct handoff", {
              guildId,
              channelId,
              waifuId: waifu.id,
              pickedNextWaifuId: result.pickedNextWaifuId
            });
            responderQueue.splice(0, responderQueue.length, {
              waifuId: result.pickedNextWaifuId,
              delaySeconds: 0,
              replyStyle: "normal"
            });
          } else if (result.pickedNextWaifuId) {
            this.options.logger.warn("Ignoring PickNextWaifu handoff because the automatic handoff limit was reached", {
              guildId,
              channelId,
              waifuId: waifu.id,
              pickedNextWaifuId: result.pickedNextWaifuId,
              maxAutomaticTurns: this.maxAutomaticTurns
            });
          }
        } finally {
          waifuTyping.stop();
        }
        executedCount += 1;
      }
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
      void this.startChannelRun(guildId, channelId, "scheduled-retrigger");
    }, bounded * 1000);
    this.retriggerTimers.set(key, timer);
  }

  private async sendWaifuChunks(input: {
    guildId: string;
    channelId: string;
    waifuId: string;
    senderBotId: string;
    chunks: string[];
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
          chunkCount: input.chunks.length,
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

  private async buildWaifuSystemPrompt(
    guildId: string,
    waifu: WaifuConfig,
    availableWaifus: WaifuConfig[]
  ): Promise<string> {
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
    const hardRules = [
      "Each incoming message in this conversation arrives wrapped in inbound-only metadata tags so you can read context:",
      "a `[timestamp: ISO-8601 UTC]` prefix telling you when the message was sent, a `[sender: DisplayName]` prefix telling you who said it,",
      "and optionally `[reactions: ...]` and `[replying to: ...]` suffixes after the body.",
      "These tags are framing only — they are NOT part of what the speaker actually wrote, and they are NOT how Discord messages look.",
      "Your reply is the raw message body that will be sent verbatim to Discord. It MUST NOT contain any bracketed metadata tag (no `[timestamp: ...]`, no `[sender: ...]`, no `[reactions: ...]`, no `[replying to: ...]`, no `[index: ...]`, no `[scene_direction: ...]`, no other `[tag: value]` constructions).",
      "It MUST NOT begin with your own display name followed by a colon, and MUST NOT quote or paraphrase any prior message's framing tags. Begin with the first word you are actually saying.",
      "Default to one short sentence. Use two short sentences only when the second adds a new beat. Do not write three or more sentences unless a scene_direction explicitly asks for it.",
      "Avoid long sentences, stacked clauses, and multi-line replies. Do not explain every angle; land one conversational beat and stop.",
      "Each sentence in your reply may be delivered as a separate Discord message, so fewer sentences is better. A sharp one-liner is usually stronger than a mini speech.",
      "Do not ping a user who is already active in the recent chat or who just spoke. Mention their display name in plain text instead. Only ping when you are reviving an older missed message, pulling back someone who has gone quiet, or a scene_direction explicitly asks for a ping.",
      "Use only listed server emojis."
    ].join("\n");

    const personaText = waifu.persona.trim();
    const personalityContent = personaText
      ? `You are ${waifu.displayName}. Stay in character.\n${personaText}`
      : `You are ${waifu.displayName}. Stay in character.`;
    const scheduleContent = formatWaifuScheduleForPrompt(waifu);

    const environmentRules = [
      "You are chatting in a live Discord text channel — this is a real chat room with real users, not a roleplay scene, story, or chat fiction.",
      "Write one Discord-safe message per turn.",
      "Do not output physical actions, roleplay narration, or stage directions. No asterisks-wrapped actions like *smiles* or *waves*, no parenthetical stage notes like (hugs them), no bracketed cues like [walks over]. Only write what you would actually type into a chat box.",
      "Reply with only what you would actually type — no narration, no meta commentary, no describing yourself in the third person.",
      "To ping a user, write <@sender> — where `sender` is copied verbatim from the [sender: ...] tag on one of their messages. Example: a message tagged [sender: Kevin] is pinged as <@Kevin>. Never use raw Discord IDs."
    ].join("\n");

    const behaviorSections: string[] = [
      `<personality_instructions>\n${personalityContent}\n</personality_instructions>`,
      `<your_schedule>\n${scheduleContent}\n</your_schedule>`,
      `<environment_instructions>\n${environmentRules}\n</environment_instructions>`,
      `<hard_rules>\n${hardRules}\n</hard_rules>`
    ];
    const toolUse = buildWaifuToolUseInstructions(waifu, availableWaifus);
    if (toolUse) {
      behaviorSections.push(`<tool_use>\n${toolUse}\n</tool_use>`);
    }
    const behaviorBlock = `<behavior>\n${behaviorSections.join("\n")}\n</behavior>`;
    const memoryBlock = memories ? `<memories>\n${memories}\n</memories>` : null;

    const currentTimeBlock = `<current_time>\n${formatPromptCurrentHour(new Date())}\n</current_time>`;
    const emojiBlock = `<server_emojis>\n${emojiList || "(none cached)"}\n</server_emojis>`;

    return [
      behaviorBlock,
      memoryBlock,
      emojiBlock,
      currentTimeBlock
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n");
  }

  private buildOrchestratorSystemPrompt(
    orchestrator: AgentConfig,
    server: ServerConfig,
    availableWaifus: WaifuConfig[]
  ): string {
    if (orchestrator.useLegacyPrompt) {
      return buildLegacyOrchestratorPrompt(server, availableWaifus);
    }

    const scheduleNow = new Date();
    const activeWaifusContent = availableWaifus.length
      ? availableWaifus
          .map((waifu) => {
            const tagName = promptTagName(waifu.name || waifu.id);
            const displayName = waifu.displayName || waifu.name;
            const persona = waifu.persona.trim();
            const personaBlock = persona || "(no persona configured)";
            const availability = formatWaifuAvailabilityForOrchestratorPrompt(waifu, scheduleNow);
            return `<${tagName}>\nID: ${waifu.id}\nDisplay name: ${displayName}\nPersona:\n${personaBlock}\nAvailability:\n${availability}\n</${tagName}>`;
          })
          .join("\n\n")
      : "No waifus are currently enabled for this channel.";

    const identity =
      "You are the orchestrator for a multi-character Discord bot. On every incoming Discord message you decide whether any waifu should reply right now, which waifus speak in what order, and how long to wait before re-evaluating when nobody speaks.";

    const hardRules = [
      "- Every respondingWaifus[].waifuId must be copied verbatim from one of the IDs listed in <active_waifus>.",
      "- action=\"reply\" requires a non-empty respondingWaifus array and a null retriggerAfterSeconds. action=\"no_reply\" requires respondingWaifus=[] and a retriggerAfterSeconds in [100, 7200].",
      `- delaySeconds is a realistic reading/typing delay before that waifu starts replying, in seconds, from 0 to ${MAX_WAIFU_DELAY_SECONDS}. Use 0 if she should start immediately.`,
      "- replyStyle is a soft hint for length/tone: \"normal\" by default; \"short\" for one terse line; \"long\" for a slightly fuller reply; \"sleepy\" for tired/low-energy voice.",
      "- Sleep and busy availability in <active_waifus> is soft context, not a hard rule. A sleeping or busy waifu can still answer if recent momentum suggests she is awake, if she just spoke, if she was directly pulled in, or if waking her improves the room.",
      "- repleyToMessageIndex should usually be null. Set it only when a waifu is reviving or anchoring to a specific older message that is no longer the latest visible message; never to the immediately previous message.",
      "- sceneDirection is the only private channel between you and that waifu. If you want her to do or say something specific, you MUST put it there. She does not see your reasoning. Use null when no special steering is needed.",
      "- After a single waifu message, do not default to no_reply just because a waifu already spoke. Actively consider whether another waifu should react, interrupt, tease, disagree, answer a missed user, or carry the beat one step further.",
      "- Prefer a two-waifu chain over a one-waifu reply when the second waifu has a distinct reaction that would make the room feel alive. Give the second waifu a small delaySeconds value so it feels like a timed follow-up, not simultaneous spam.",
      "- Consecutive waifu replies in a single decision are allowed when they add a fresh beat: escalation, interruption, joke, reaction, disagreement, emotional shift, or a new topic. Avoid only empty echoing or repetitive back-and-forth."
    ].join("\n");

    const taskInstructions = DEFAULT_ORCHESTRATOR_PROMPT;

    const loopBreaking = [
      "The recent messages in context are your most important signal. If the waifus are circling the same topic, the same vibe, or the same back-and-forth, they will keep circling unless you actively redirect them — each waifu only sees her own persona and the chat, so only you can see the loop forming from the outside.",
      "When you notice a loop forming (even a soft one — two or three messages already feeling similar is enough), pick the waifu whose personality most naturally fits a hard pivot and write a concrete sceneDirection that lands a brand-new topic, observation, memory, callback, or non-sequitur. Name the specific new topic in the sceneDirection — \"ask about Kevin's dog\", \"bring up the snowstorm last week\", \"complain about being hungry\" — rather than vague instructions like \"change the subject\". A jarring shift that still feels in-character is better than letting the conversation stagnate."
    ].join("\n\n");

    const retriggerPacing = [
      "retriggerAfterSeconds is only used with action=\"no_reply\". It is the number of seconds to wait before the orchestrator wakes up to re-evaluate the room, in the range [100, 7200].",
      "",
      "Human messages automatically wake the orchestrator, so retriggerAfterSeconds is not a generic monitoring tick — it is a deliberate, planned pause to give the room a chance to react. If a fresh chat message arrives before the timer fires, the timer is replaced by the new orchestrator pass.",
      "",
      "Rough intent ranges:",
      "- 100s–300s: moments that feel alive but do not have an obvious second waifu reaction. If there is an obvious second reaction, prefer respondingWaifus with two waifus and a short delay instead of no_reply.",
      "- 600s–1800s: cooling rooms where a waifu might revive the chat soon, but not immediately.",
      "- 3600s–7200s: quiet rooms where you are mostly waiting for humans and the next bot-led beat is a long shot.",
      "",
      "If the timer fires and the room is still quiet, you can choose no_reply again with a longer delay. Don't grind on a dead channel."
    ].join("\n");

    const messageStructure = [
      "Each message in the context is tagged with [index: #N], [timestamp: ISO-8601 UTC], and [sender: DisplayName] before its body, optionally followed by [reactions: ...] and [replying to: ...]. Reference older messages by their #N index using repleyToMessageIndex. The runtime maps that index to the actual Discord message id; raw message ids are not shown.",
      "Some lines are your own prior no_reply decisions, interleaved with the chat by timestamp. They look like [no_reply] [timestamp: ...] [reason: ...] [retrigger: Ns] and have no #N index, no sender, no reactions, and no replying-to. They are not Discord messages — nobody else sees them. Use them to gauge how long the channel has actually been silent under your watch and to avoid stacking redundant no_reply choices."
    ].join("\n");

    const toolUse = [
      "Inspect the context and call orchestrator_decision once with the tool arguments. Do not write normal assistant text.",
      "Argument shape:",
      "{",
      "  \"action\": \"reply\" | \"no_reply\",",
      "  \"respondingWaifus\": [",
      "    {",
      "      \"waifuId\": string,",
      `      \"delaySeconds\": number (0..${MAX_WAIFU_DELAY_SECONDS}),`,
      "      \"replyStyle\": \"normal\" | \"short\" | \"long\" | \"sleepy\",",
      "      \"repleyToMessageIndex\": number | null,",
      "      \"sceneDirection\": string | null",
      "    },",
      "    ...",
      "  ],",
      "  \"retriggerAfterSeconds\": number (100..7200) | null,",
      "  \"reasoning\": string",
      "}",
      "Rules:",
      "- action=\"reply\" => respondingWaifus is non-empty; retriggerAfterSeconds is null.",
      "- action=\"no_reply\" => respondingWaifus is empty; retriggerAfterSeconds is a number in [100, 7200].",
      "- Order matters in respondingWaifus: the first waifu speaks first, then the next, and so on. Each waifu's delay starts only after the previous waifu has finished. Any new chat message interrupts the rest of the chain.",
      "- When choosing two waifus, give each entry its own delaySeconds. Use 0 for the first when she should start immediately, then a small delay like 3-12 seconds for the second when it should feel like a natural follow-up.",
      "- All five fields on each respondingWaifus entry are required; set repleyToMessageIndex and sceneDirection to null when not needed."
    ].join("\n");

    const sections = orchestrator.promptSections;
    const behavior = [
      `<task_instructions>\n${taskInstructions}\n</task_instructions>`,
      sections.loopBreaking ? `<loop_breaking>\n${loopBreaking}\n</loop_breaking>` : null,
      sections.retriggerPacing ? `<retrigger_pacing>\n${retriggerPacing}\n</retrigger_pacing>` : null,
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
      if (decision.action !== "no_reply") continue;
      if (decision.retriggerAfterSeconds === undefined) continue;
      const timestamp = formatTimestamp(new Date(decision.createdAt));
      if (timestamp <= latest) continue;
      markers.push({
        kind: "no_reply",
        timestamp,
        retriggerAfterSeconds: decision.retriggerAfterSeconds,
        reasoning: decision.reasoning
      });
    }
    return markers;
  }

  private async appendOrchestratorHistory(entry: {
    id: string;
    guildId: string;
    channelId: string;
    action: "reply" | "no_reply";
    respondingWaifus: OrchestratorRespondingWaifu[];
    retriggerAfterSeconds?: number;
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

function buildWaifuToolUseInstructions(waifu: WaifuConfig, availableWaifus: WaifuConfig[]): string | undefined {
  if (!waifu.tools.toolUse || !waifu.tools.pickNextWaifu) return undefined;
  const model = waifu.modelId ? getModel(waifu.modelId) : undefined;
  if (!model?.supportsTools) return undefined;
  const candidates = availableWaifus
    .filter((candidate) => candidate.id !== waifu.id && candidate.botId && candidate.modelId)
    .map((candidate) => `${candidate.id} (${candidate.displayName || candidate.name})`);
  if (candidates.length === 0) return undefined;
  return [
    "You have one optional tool: PickNextWaifu.",
    "Use it only after writing your Discord reply when another waifu should immediately speak next and the orchestrator should be skipped for that handoff.",
    "Do not call it if your message should be the end of this beat.",
    "Arguments: { \"waifuId\": string }.",
    "Available waifus:",
    ...candidates.map((candidate) => `- ${candidate}`)
  ].join("\n");
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

function formatWaifuAvailabilityForOrchestratorPrompt(waifu: WaifuConfig, now: Date): string {
  const availability = waifu.availability;
  const currentMinutes = localTimeOfDayMinutes(now);
  const lines = [`- Current local schedule time: ${formatLocalTimeOfDay(now)}.`];
  if (availability.sleep.enabled) {
    const sleepingNow = dailyIntervalContains(currentMinutes, availability.sleep);
    lines.push(
      `- Sleep: ${availability.sleep.start}-${availability.sleep.end} daily (${sleepingNow ? "currently inside sleep time" : "not currently inside sleep time"}). Treat this as lower likelihood, not a rule; she may still be awake if she spoke recently, was directly pulled in, or waking her improves the room.`
    );
  } else {
    lines.push("- Sleep: none configured.");
  }
  if (availability.busy.length > 0) {
    lines.push("- Busy:");
    for (const interval of availability.busy) {
      const busyNow = dailyIntervalContains(currentMinutes, interval);
      lines.push(`  - ${interval.start}-${interval.end}: ${interval.reason}${busyNow ? " (currently busy)" : ""}`);
    }
  } else {
    lines.push("- Busy: none configured.");
  }
  return lines.join("\n");
}

function localTimeOfDayMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
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

function indentLines(value: string, indent: string): string {
  return value.split("\n").map((line) => `${indent}${line}`).join("\n");
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

function capDecisionDelays(decision: OrchestratorDecision): OrchestratorDecision {
  return {
    ...decision,
    respondingWaifus: decision.respondingWaifus.map((responder) => ({
      ...responder,
      delaySeconds: Math.min(responder.delaySeconds, MAX_WAIFU_DELAY_SECONDS)
    }))
  };
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
  "You watch one Discord channel and orchestrate a small cast of waifu personas. On each new message, decide from outside the scene whether any waifu should reply right now (action=\"reply\") or whether the room should stay quiet for a planned interval (action=\"no_reply\").",
  "",
  "Be natural. Real group chats do not require everyone to reply every time, and not every beat needs a response — treat the room like a living scene, not a turn-taking queue. Pacing, silence, interruption, overlap, comedy, and escalation are all valid moves. Pick the waifu whose personality fits the moment based on her voice and the current flow; the same waifu may speak again, a different one may jump in, or two may chain if it feels right.",
  "",
  "When action=\"reply\", list the waifus in respondingWaifus in the order they should speak. Order matters: the next waifu only sees the chat after the previous one has finished. Any new chat message between two replies cancels the rest of the chain. Plan the chain you'd commit to if nobody interrupts.",
  "",
  "When the beat can support it, prefer a planned two-waifu chain over one waifu followed by no_reply. The second waifu should have a distinct angle — reaction, interruption, tease, disagreement, missed-user acknowledgment, or escalation — and a small delaySeconds value so it feels like a natural follow-up.",
  "",
  "When action=\"no_reply\", set retriggerAfterSeconds to the number of seconds you want to wait before re-evaluating the room. The orchestrator also wakes up automatically on any new chat message, so retriggerAfterSeconds is a planned pause, not a polling tick. A chain of one no_reply means \"don't speak now; re-check after the pause.\"",
  "",
  "After a single waifu message, do not treat no_reply as the automatic cleanup move. Ask whether the room would feel more alive if another waifu reacts, cuts in, disagrees, lightly teases, answers a missed user, or follows the beat one step further. Choose no_reply when the beat has genuinely landed, the next bot message would feel repetitive, or silence creates better pacing.",
  "",
  "If a recent chat participant message or direct ping was missed while the room moved on, prefer steering a waifu to acknowledge it so the chat stays socially inclusive — unless silence is clearly the more natural choice.",
  "",
  "Reach for sceneDirection when the next reply needs steering that personality alone won't provide: redirecting topic, closing a beat, creating an interruption, shifting momentum, or deliberately starting something new even when it cuts against the current flow. Prefer a natural bridge when pivoting, but a jarring shift is fine if the scene needs it. Keep sceneDirection short, concrete, and immediately actionable — one sentence is usually enough. When you refer to a specific person, use their actual display name from the chat history, never generic phrases like \"the user\". Name intended participants explicitly when more than one person is involved; avoid ambiguous group references like \"us\", \"them\", or \"everyone\". If multiple waifus respond in the same turn, each may receive a different sceneDirection.",
  "",
  `delaySeconds is a realistic reading/typing delay before that waifu starts replying, capped at ${MAX_WAIFU_DELAY_SECONDS} seconds. Use 0 to start immediately; small values feel natural for short replies; larger values fit longer or more thoughtful replies. Keep it grounded in the chat's pace.`,
  "",
  "replyStyle is a soft hint for that one reply: \"normal\" by default, \"short\" for a one-line beat, \"long\" for a slightly fuller reply, \"sleepy\" for a low-energy tone. The waifu's persona still does most of the work.",
  "",
  "When the last visible event was a waifu reply, do not treat the last waifu as the default speaker. Re-evaluate the room from outside the scene: the same waifu may continue, another waifu may cut in, multiple waifus may chain, or the room may go quiet.",
  "",
  "Pay special attention to the latest 10 messages and the recent speaker pattern. If the same waifu has been carrying the scene for multiple beats, strongly consider switching to another waifu, using no_reply, or using sceneDirection to create a fresh beat.",
  "",
  "Continue a waifu-to-waifu chain when the next message adds something new: escalation, interruption, joke, emotional shift, contradiction, surprise, a missed-user acknowledgment, or a new topic. Do not continue just to restate the same mood."
].join("\n");

function buildLegacyOrchestratorPrompt(server: ServerConfig, availableWaifus: WaifuConfig[]): string {
  const scheduleNow = new Date();
  const waifuBlock = availableWaifus.length
    ? availableWaifus
        .map((waifu) => {
          const displayName = waifu.displayName || waifu.name || waifu.id;
          const persona = waifu.persona.trim() || "(no persona configured)";
          const availability = formatWaifuAvailabilityForOrchestratorPrompt(waifu, scheduleNow);
          return `### ${displayName} (ID: ${waifu.id})\n- Personality: ${persona}\n- Availability:\n${indentLines(availability, "  ")}`;
        })
        .join("\n\n")
    : "No waifus are currently enabled for this channel.";

  const currentTime = formatPromptCurrentHour(new Date());

  return [
    "You are the Orchestrator for a Discord group chat inhabited by AI waifus (characters).",
    "Your job is to direct the room: decide which waifu(s) should respond next, in what order, or whether nobody should respond right now.",
    "You must call the orchestrator_decision tool exactly once with your final decision.",
    "",
    "## Active Waifus",
    waifuBlock,
    "",
    "## Current Time",
    currentTime,
    "",
    "## Discord Server",
    server.name ?? server.guildId,
    "",
    "## Decision Rules",
    "1. Be natural. Real group chats do not require everyone to reply every time.",
    "2. You are allowed to shape pacing, tension, comedy, interruption, silence, and escalation. Treat the room like a living scene, not a turn-taking queue.",
    "3. Mentions, quotes, relationships, reactions, timestamps, and recent momentum are all useful signals, but none of them are hard rules.",
    "4. Always pay special attention to the latest 10 messages. They are the strongest signal for what the room is currently doing, who may have been overlooked, and whether a loop is starting to form.",
    "5. Sleep time, busy time, and consecutive-message heuristics are soft preferences. Break them whenever doing so would clearly improve conversational flow, realism, or enjoyment.",
    "6. The same waifu may speak again, a different waifu may jump in, or multiple waifus may chain if it feels right.",
    "7. Prefer a planned two-waifu chain when the second waifu has a distinct reaction and can follow after a small delaySeconds value.",
    "8. After a single waifu message, do not default to no_reply. Consider whether another waifu should react, interrupt, disagree, tease, answer a missed user, or carry the beat one step further.",
    "9. Avoid repetitive follow-ups that merely restate the same beat. Continue when the next message adds something new.",
    "10. If a recent user message or direct ping went unnoticed while the room moved on, prefer steering someone to acknowledge it so the chat stays socially inclusive unless silence is clearly more natural.",
    "11. \"no_reply\" is valid. If you choose it, set retriggerAfterSeconds to a natural delay between 100 and 7200 seconds. respondingWaifus must be empty.",
    "12. Use timestamps and pacing. Slow gaps matter.",
    `13. delaySeconds should reflect realistic reading and typing time from 0 to ${MAX_WAIFU_DELAY_SECONDS}. 0 means start immediately.`,
    "14. replyStyle is a soft hint: \"normal\" by default; \"short\" for one terse line; \"long\" for a slightly fuller reply; \"sleepy\" for a low-energy voice. Use \"normal\" when in doubt.",
    "15. repleyToMessageIndex is optional. Leave it null by default.",
    "16. Most waifu messages should be normal messages, not Discord replies.",
    "17. Do not set repleyToMessageIndex to the immediately previous message. If a waifu is simply responding to the latest beat, send a normal message instead.",
    "18. If you are reviving, acknowledging, or directly answering an older user message or direct ping that went overlooked, you should usually set repleyToMessageIndex to that message's #N context index so the response stays anchored to the right person and beat.",
    "19. Use repleyToMessageIndex only when targeting a specific older message materially improves clarity, isolates a side thread, answers an earlier question, or creates a specific social effect. Copy the #N index from the chat history.",
    "",
    "## sceneDirection",
    "sceneDirection is an invisible director note for that waifu's next message only.",
    "Use it when the next reply needs stronger steering than replyStyle alone can provide.",
    "The latest 10 messages are a good place to spot loops early; when you notice one forming, use sceneDirection to cut it before it hardens.",
    "You may use it to break loops, force a new beat, close a scene, redirect to a new topic, create an interruption, or shift momentum by changing the next objective.",
    "This is not a personality rewrite and not a long paragraph.",
    "Keep it short, concrete, and immediately actionable. One short sentence is usually enough.",
    "When referring to a specific user inside sceneDirection, use that user's actual name from chat history. Do not write generic phrases like \"the user\" when a specific person is meant.",
    "Name the intended participants explicitly when the direction involves more than one person.",
    "Do not use ambiguous group references like \"us\", \"them\", \"everyone\", or implied membership when specific names can be given.",
    "If the beat is about including or excluding someone, state exactly who is already involved and who should be pulled in.",
    "sceneDirection does not always need to follow the current mood or flow exactly. It may deliberately start something new when that will improve the scene.",
    "Use natural bridges when pivoting when possible.",
    "If multiple waifus respond, each one may receive a different sceneDirection.",
    "If no special steering is needed, return null.",
    "",
    "## Tool",
    "Call orchestrator_decision exactly once with the following arguments and no normal assistant text:",
    "{",
    "  \"action\": \"reply\" | \"no_reply\",",
    "  \"respondingWaifus\": [",
    `    { \"waifuId\": string, \"delaySeconds\": number (0..${MAX_WAIFU_DELAY_SECONDS}), \"replyStyle\": \"normal\"|\"short\"|\"long\"|\"sleepy\", \"repleyToMessageIndex\": number|null, \"sceneDirection\": string|null }`,
    "  ],",
    "  \"retriggerAfterSeconds\": number (100..7200) | null,",
    "  \"reasoning\": string",
    "}",
    "When action=\"reply\", respondingWaifus must be non-empty and retriggerAfterSeconds must be null.",
    "When action=\"no_reply\", respondingWaifus must be empty and retriggerAfterSeconds must be a number between 100 and 7200."
  ].join("\n");
}

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
