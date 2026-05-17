import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Logger } from "../backend/logger.js";
import {
  DiscordClearCommandEvent,
  DiscordGatewayFacade,
  DiscordMessageEvent,
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
import { formatTimestamp } from "./context.js";

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
      const result = await this.clearLatestWaifuMessages(event.guildId, event.channelId, event.count ?? 1);
      if (result.messageIds.length === 0) {
        await event.respond("No waifu message found to clear.");
      } else if (result.deleted) {
        const messageLabel = result.logicalMessageCount === 1 ? "waifu message" : "waifu messages";
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
      const orchestratorTyping = startTypingScope(this.options.discord, { guildId, channelId });
      let decision;
      try {
        decision = await pipeline.decideOrchestrator({
          modelId: orchestrator.modelId,
          messages,
          systemPrompt: this.buildOrchestratorSystemPrompt(orchestrator, server, availableWaifus),
          availableWaifuIds: availableWaifus.map((waifu) => waifu.id),
          reasoning: orchestrator.reasoning,
          signal
        });
      } finally {
        orchestratorTyping.stop();
      }
      await this.appendOrchestratorHistory({
        id: randomUUID(),
        guildId,
        channelId,
        action: decision.action,
        selectedWaifuIds: decision.action === "waifus" ? decision.selectedWaifus.map((waifu) => waifu.waifuId) : [],
        sceneDirections: decision.action === "waifus" ? decision.selectedWaifus.flatMap((waifu) => waifu.sceneDirection ? [waifu.sceneDirection] : []) : [],
        reasoning: decision.reasoning,
        retriggerAfterSeconds: "retriggerAfterSeconds" in decision ? decision.retriggerAfterSeconds : undefined,
        createdAt: nowIso()
      });
      this.options.logger.info("Orchestrator decision recorded", {
        guildId,
        channelId,
        action: decision.action,
        selectedWaifuIds: decision.action === "waifus" ? decision.selectedWaifus.map((waifu) => waifu.waifuId) : [],
        retriggerAfterSeconds: "retriggerAfterSeconds" in decision ? decision.retriggerAfterSeconds : undefined,
        reasoning: decision.reasoning
      });

      if (decision.action === "no_reply") {
        await this.scheduleRetrigger(guildId, channelId, decision.retriggerAfterSeconds);
        return;
      }
      if (decision.action === "stage_manager") {
        void this.runStageManager(guildId, channelId);
        await this.scheduleRetrigger(guildId, channelId, decision.retriggerAfterSeconds);
        return;
      }
      if (decision.action === "reviewer") {
        await this.runReviewer({
          guildId,
          channelId,
          triggerAfterActiveRun: true
        });
        return;
      }

      let sentCount = 0;
      const allowedWaifus = new Set(channel.enabledWaifuIds ?? []);
      for (const selected of decision.selectedWaifus) {
        throwIfAborted(signal);
        if (!allowedWaifus.has(selected.waifuId)) {
          this.options.logger.warn("Orchestrator selected a waifu that is not enabled for channel", {
            guildId,
            channelId,
            selectedWaifuId: selected.waifuId
          });
          continue;
        }
        const waifu = await this.readWaifu(selected.waifuId).catch(() => undefined);
        if (!waifu) {
          this.options.logger.warn("Orchestrator selected an unknown waifu", {
            guildId,
            channelId,
            selectedWaifuId: selected.waifuId
          });
          continue;
        }
        if (!waifu.modelId) {
          this.options.logger.warn("Orchestrator selected a waifu without a configured model", {
            guildId,
            channelId,
            selectedWaifuId: selected.waifuId
          });
          continue;
        }
        if (!waifu.botId) {
          this.options.logger.warn("Orchestrator selected a waifu without a linked Discord bot", {
            guildId,
            channelId,
            selectedWaifuId: selected.waifuId
          });
          continue;
        }
        await this.setActivePipeline(guildId, channelId, "waifu");
        const waifuMessages = await this.options.discord.fetchFreshContext({
          guildId,
          channelId,
          limit: waifu.contextWindow || server.contextWindows.waifu,
          signal
        });
        const waifuPipeline = await this.pipelineFor(waifu.modelId);
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
          const result = await waifuPipeline.generateWaifu({
            modelId: waifu.modelId,
            messages: waifuMessages,
            systemPrompt: await this.buildWaifuSystemPrompt(guildId, waifu),
            sceneDirection: selected.sceneDirection,
            temperature: waifu.generation.temperature,
            topP: waifu.generation.topP,
            maxOutputTokens: waifu.generation.maxOutputTokens,
            reasoning: waifu.reasoning,
            currentWaifuAuthorIds,
            signal
          });
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
          const replyToMessageId = replyTargetForFreshContext(selected.replyToMessageId, waifuMessages);
          if (selected.replyToMessageId && !replyToMessageId) {
            this.options.logger.info("Omitting reply target because it is the latest context message", {
              guildId,
              channelId,
              waifuId: waifu.id,
              replyToMessageId: selected.replyToMessageId
            });
          }
          this.activeWaifuSendChannels.add(channelId);
          try {
            for (let i = 0; i < chunks.length; i++) {
              throwIfAborted(signal);
              if (i > 0) {
                void this.options.discord
                  .sendTyping({ guildId, channelId, senderBotId: waifu.botId })
                  .catch(() => undefined);
                await this.sleep(typingDelayMs(chunks[i]), signal);
              }
              const sentResult = await this.options.discord.sendWaifuMessage({
                guildId,
                channelId,
                senderBotId: waifu.botId,
                content: chunks[i],
                replyToMessageId: i === 0 ? replyToMessageId : undefined,
                allowedUserMentionIds: activeAuthorIds
              });
              this.rememberSelfSent(sentResult.messageId);
              this.options.logger.info("Waifu message chunk sent", {
                guildId,
                channelId,
                waifuId: waifu.id,
                chunkIndex: i,
                chunkCount: chunks.length,
                chunkLength: chunks[i].length
              });
            }
          } finally {
            this.activeWaifuSendChannels.delete(channelId);
          }
        } finally {
          waifuTyping.stop();
        }
        sentCount += 1;
      }
      if (sentCount === 0) {
        this.options.logger.info("Channel runtime loop stopped because no waifu messages were sent", {
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
    await this.scheduleRetrigger(guildId, channelId, 100);
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

  private async clearLatestWaifuMessages(guildId: string, channelId: string, count: number): Promise<{
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
      .filter((message) => message.authorKind === "waifu")
      .slice(0, clearCount);
    const seenMessageIds = new Set<string>();
    const messageIds: string[] = [];
    const messageIdsByAuthor = new Map<string, string[]>();
    for (const target of targets) {
      const targetMessageIds = target.sourceMessageIds ?? [target.id];
      for (const messageId of targetMessageIds) {
        if (seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
        messageIds.push(messageId);
        const authorMessageIds = messageIdsByAuthor.get(target.authorId) ?? [];
        authorMessageIds.push(messageId);
        messageIdsByAuthor.set(target.authorId, authorMessageIds);
      }
    }
    if (targets.length === 0 || messageIds.length === 0) {
      return { deleted: false, logicalMessageCount: 0, messageIds: [] };
    }
    if (!this.options.discord.deleteMessages) {
      throw new Error("Discord message deletion is not available.");
    }
    const deletedMessageIds = new Set<string>();
    for (const [authorId, authorMessageIds] of messageIdsByAuthor) {
      const deletion = await this.options.discord.deleteMessages({
        guildId,
        channelId,
        messageIds: authorMessageIds,
        authorId
      });
      for (const deletedMessageId of deletion.deletedMessageIds) {
        deletedMessageIds.add(deletedMessageId);
      }
    }
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
    const bounded = Math.max(100, Math.min(28_800, seconds));
    const key = timerKey(guildId, channelId);
    const at = new Date(Date.now() + bounded * 1000).toISOString();
    await this.updateSession(guildId, channelId, (current) => ({
      ...current,
      scheduledRetriggerAt: at,
      activePipeline: null
    }));
    const timer = setTimeout(() => {
      this.retriggerTimers.delete(key);
      void this.startChannelRun(guildId, channelId, "scheduled-retrigger");
    }, bounded * 1000);
    this.retriggerTimers.set(key, timer);
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
      "If you really need to express something longer, prefer splitting it into multiple short sentences rather than one long run-on. Each sentence in your reply is delivered as a separate Discord message, so short sentences read as a natural back-and-forth instead of a wall of text.",
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

    const emojiBlock = `<available_server_emojis>\n${emojiList || "(none cached)"}\n</available_server_emojis>`;

    return `${behaviorBlock}\n${emojiBlock}`;
  }

  private buildOrchestratorSystemPrompt(
    orchestrator: AgentConfig,
    server: ServerConfig,
    availableWaifus: WaifuConfig[]
  ): string {
    const activeWaifusBlock = availableWaifus.length
      ? availableWaifus
          .map((waifu) => {
            const header = `### ${waifu.displayName || waifu.name} (ID: ${waifu.id})`;
            const persona = waifu.persona.trim();
            return persona ? `${header}\n${persona}` : `${header}\n(no persona configured)`;
          })
          .join("\n\n")
      : "No waifus are currently enabled for this channel.";
    return [
      orchestrator.prompt,
      `## Active Waifus\n${activeWaifusBlock}`,
      `## Current Time\n${formatTimestamp(new Date())} (UTC)`,
      `Server: ${server.name ?? server.guildId}`,
      "Use replyToIndex only when replying to an older message that is no longer the latest visible message. If the waifu is answering the latest message in chat, omit replyToIndex so Discord sends a normal message.",
      "When action is \"waifus\", every selectedWaifus[].waifuId must exactly match one of the Active Waifus IDs listed above. Do not invent IDs such as \"waifu_alice\" or numeric placeholders. If none of the listed waifus should answer, choose no_reply.",
      "If you want a waifu to do or say something specific, you MUST put it in her selectedWaifus[].sceneDirection. Without a scene direction she will improvise freely based only on her persona and the chat — she does not see your reasoning. Leave sceneDirection empty only when you genuinely want a free-form in-character reply.",
      "If the recent messages in context are all variations of the same beat — same topic, same vibe, same back-and-forth looping on itself — break the loop. Pick the waifu whose personality most naturally fits a hard pivot and give her a sceneDirection that introduces a completely new topic, even one that feels random or non-sequitur. A jarring topic shift is preferable to letting the conversation stagnate.",
      "If you suspect the latest waifu message is hallucinating or leaking internals, choose reviewer; the reviewer model makes the final judgment."
    ]
      .filter(Boolean)
      .join("\n\n");
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

  private async appendOrchestratorHistory(entry: {
    id: string;
    guildId: string;
    channelId: string;
    action: "waifus" | "stage_manager" | "reviewer" | "no_reply";
    selectedWaifuIds: string[];
    sceneDirections: string[];
    reasoning: string;
    retriggerAfterSeconds?: number;
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
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
