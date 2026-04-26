import { setTimeout as sleep } from "node:timers/promises";
import type { Message, TextChannel } from "discord.js";
import { AIRouter, AIRouterAbortError, type ToolDefinition } from "./ai-router.js";
import type { BotManager } from "./bot-manager.js";
import type { ConfigManager } from "./config-manager.js";
import type { FormattedMessage, MessageHandler } from "./message-handler.js";
import { PromptBuilder, type PromptBuildContext } from "./prompt-builder.js";
import type { RuntimeEventBus } from "./runtime-events.js";
import type { StageManagerStateStore } from "./stage-manager-store.js";
import {
  type DirectInteractionDecision,
  orchestratorDecisionToolInputSchema,
  orchestratorDecisionSchema,
  type ChannelConfig,
  type OrchestratorDecision,
  type RespondingWaifuDecision,
  type WaifuConfig
} from "./types/index.js";
import { Logger } from "./utils/logger.js";

type TriggerType = "message" | "idle" | "waifu_followup";
type RunOutcome = "started" | "skipped_active" | "skipped_ineligible" | "skipped_unavailable";

interface TriggerContext {
  channelId: string;
  trigger: TriggerType;
  sourceMessage?: Message;
  lastSpeakerWaifuId?: string | null;
  consecutiveWaifuMessages: number;
  allowNoReply: boolean;
}

interface ActiveGeneration {
  abortController: AbortController;
  waifuId?: string;
  phase: "deciding" | "delay" | "generating";
  pendingUserRerun: boolean;
}

const WAIFU_CONTEXT_REFRESH_HEADSTART_MS = 1_000;
const RETRIGGER_OVERLAP_RETRY_SECONDS = 15;
const RETRIGGER_FAILURE_RETRY_SECONDS = 30;
const RETRIGGER_UNAVAILABLE_RETRY_SECONDS = 30;

export class Orchestrator {
  private readonly logger = new Logger("Orchestrator");
  private readonly promptBuilder = new PromptBuilder();
  private readonly activeGenerations = new Map<string, ActiveGeneration>();
  private readonly retriggerTimers = new Map<string, NodeJS.Timeout>();
  private readonly consecutiveWaifuMessages = new Map<string, number>();

  constructor(
    private readonly aiRouter: AIRouter,
    private readonly configManager: ConfigManager,
    private readonly botManager: BotManager,
    private readonly messageHandler: MessageHandler,
    private readonly stageManagerStore: StageManagerStateStore,
    private readonly events?: RuntimeEventBus
  ) {}

  async handleNewMessage(channelId: string, message: Message): Promise<void> {
    const waifuId = this.botManager.getWaifuIdByUserId(message.author.id);

    if (!waifuId) {
      this.consecutiveWaifuMessages.set(channelId, 0);
      const active = this.activeGenerations.get(channelId);
      if (active) {
        if (active.phase === "generating") {
          active.pendingUserRerun = true;
          return;
        }

        this.cancelGeneration(channelId, "New user message");
      }
      await this.run({
        channelId,
        trigger: "message",
        sourceMessage: message,
        consecutiveWaifuMessages: 0,
        allowNoReply: true
      });
      return;
    }

    const consecutiveCount = (this.consecutiveWaifuMessages.get(channelId) ?? 0) + 1;
    this.consecutiveWaifuMessages.set(channelId, consecutiveCount);
    await this.run({
      channelId,
      trigger: "waifu_followup",
      sourceMessage: message,
      lastSpeakerWaifuId: waifuId,
      consecutiveWaifuMessages: consecutiveCount,
      allowNoReply: true
    });
  }

  async handleIdleTrigger(channelId: string): Promise<void> {
    await this.run({
      channelId,
      trigger: "idle",
      consecutiveWaifuMessages: this.consecutiveWaifuMessages.get(channelId) ?? 0,
      allowNoReply: true
    });
  }

  getGenerationStatus(): Array<{ channelId: string; waifuId?: string }> {
    return [...this.activeGenerations.entries()].map(([channelId, state]) => ({
      channelId,
      waifuId: state.waifuId
    }));
  }

  cancelGeneration(channelId: string, reason: string): void {
    const active = this.activeGenerations.get(channelId);
    if (!active) {
      return;
    }

    active.abortController.abort();
    this.activeGenerations.delete(channelId);
    this.events?.emit("generation:cancelled", {
      channelId,
      waifuId: active.waifuId,
      reason
    });
  }

  private clearActiveGenerationIfCurrent(channelId: string, state: ActiveGeneration): void {
    if (this.activeGenerations.get(channelId) === state) {
      this.activeGenerations.delete(channelId);
    }
  }

  private async run(triggerContext: TriggerContext): Promise<RunOutcome> {
    if (this.activeGenerations.has(triggerContext.channelId)) {
      this.logger.info("Skipping overlapping orchestration run", {
        channelId: triggerContext.channelId,
        trigger: triggerContext.trigger
      });
      return "skipped_active";
    }

    const channelConfig = this.configManager.channels.find(
      (entry) => entry.channelId === triggerContext.channelId && entry.enabled
    );
    if (!channelConfig) {
      return "skipped_ineligible";
    }

    if (
      triggerContext.trigger === "waifu_followup" &&
      triggerContext.consecutiveWaifuMessages >= 50
    ) {
      this.logger.warn("Safety valve triggered for waifu chaining", {
        channelId: triggerContext.channelId
      });
      this.scheduleRetrigger(triggerContext.channelId, 60);
      return "started";
    }

    const activeState: ActiveGeneration = {
      abortController: new AbortController(),
      phase: "deciding",
      pendingUserRerun: false
    };
    this.activeGenerations.set(triggerContext.channelId, activeState);

    try {
      const channel = await this.resolveChannel(channelConfig);
      if (!channel) {
        this.logger.warn("No text channel available for orchestration", {
          channelId: triggerContext.channelId
        });
        return "skipped_unavailable";
      }

      const activeWaifus = this.getActiveWaifus(channelConfig);
      if (activeWaifus.length === 0) {
        return "skipped_ineligible";
      }

      const messages = await this.messageHandler.fetchContext(
        channel,
        channelConfig.contextMessageCount ?? 80,
        channelConfig.contextAnchorMessageId ?? null
      );
      const promptContext: PromptBuildContext = {
        activeWaifus,
        knownWaifus: this.configManager.waifus,
        messages,
        channel: channelConfig,
        availableServerEmojis: (
          await this.botManager.getAvailableGuildEmojis(channelConfig.guildId)
        ).slice(0, 40),
        currentTimeUTC: new Date().toISOString(),
        consecutiveWaifuMessages: triggerContext.consecutiveWaifuMessages,
        trigger: triggerContext.trigger,
        lastSpeakerWaifuId: triggerContext.lastSpeakerWaifuId ?? null,
        stageStateByWaifuId: this.buildStageStateByWaifuId(activeWaifus, channelConfig)
      };

      let decision: OrchestratorDecision;
      try {
        decision = await this.getDecision(
          promptContext,
          triggerContext.channelId,
          activeState.abortController.signal
        );
        this.throwIfAborted(activeState.abortController.signal);
      } catch (error) {
        if (error instanceof AIRouterAbortError || isAbortError(error)) {
          this.logger.info("Decision generation cancelled", {
            channelId: triggerContext.channelId
          });
          return "started";
        }

        this.logger.error("Failed to generate orchestrator decision", {
          channelId: triggerContext.channelId,
          error
        });
        this.events?.emit("generation:cancelled", {
          channelId: triggerContext.channelId,
          reason: "Orchestrator failure"
        });
        this.scheduleRetrigger(triggerContext.channelId, RETRIGGER_FAILURE_RETRY_SECONDS);
        return "started";
      }
      this.events?.emit("orchestrator:decision", {
        channelId: triggerContext.channelId,
        action: decision.action,
        respondingWaifus: decision.respondingWaifus.map((entry) => ({
          waifuId: entry.waifuId,
          delaySeconds: entry.delaySeconds,
          replyStyle: entry.replyStyle,
          sceneDirection: entry.sceneDirection
        })),
        directInteraction: decision.directInteraction
          ? {
              waifuId: decision.directInteraction.waifuId,
              delaySeconds: decision.directInteraction.delaySeconds,
              emoji: decision.directInteraction.emoji
            }
          : null,
        reasoning: decision.reasoning,
        retriggerAfterSeconds: decision.retriggerAfterSeconds,
        timestamp: new Date().toISOString()
      });

      const hasVisibleOutput =
        decision.directInteraction !== null || decision.respondingWaifus.length > 0;
      if (!hasVisibleOutput) {
        if (triggerContext.allowNoReply && decision.retriggerAfterSeconds) {
          this.scheduleRetrigger(triggerContext.channelId, decision.retriggerAfterSeconds);
        }
        return "started";
      }

      this.clearRetrigger(triggerContext.channelId);

      try {
        let lastSpeakerWaifuId: string | null = null;
        // Preserve the existing sequential reply semantics. The emoji-only direct interaction,
        // when present, runs before the normal respondingWaifus loop rather than introducing
        // a global scheduler that would change current reply ordering behavior.
        if (decision.directInteraction) {
          this.throwIfAborted(activeState.abortController.signal);
          activeState.phase = "delay";
          activeState.waifuId = decision.directInteraction.waifuId;
          lastSpeakerWaifuId = await this.executeDirectInteraction({
            channel,
            channelConfig,
            directInteraction: decision.directInteraction,
            activeState
          });
        }

        for (const responseDecision of decision.respondingWaifus) {
          this.throwIfAborted(activeState.abortController.signal);
          activeState.phase = "delay";
          activeState.waifuId = responseDecision.waifuId;
          lastSpeakerWaifuId = await this.executeResponse({
            channel,
            channelConfig,
            promptContext,
            responseDecision,
            activeState
          });
        }

        if (activeState.pendingUserRerun) {
          this.clearActiveGenerationIfCurrent(triggerContext.channelId, activeState);
          this.consecutiveWaifuMessages.set(channel.id, 0);
          await this.run({
            channelId: channel.id,
            trigger: "message",
            consecutiveWaifuMessages: 0,
            allowNoReply: true
          });
          return "started";
        }

        if (lastSpeakerWaifuId) {
          const nextCount = this.consecutiveWaifuMessages.get(channel.id) ?? 0;
          this.clearActiveGenerationIfCurrent(triggerContext.channelId, activeState);
          await sleep(500, undefined, { signal: activeState.abortController.signal });
          await this.run({
            channelId: channel.id,
            trigger: "waifu_followup",
            lastSpeakerWaifuId,
            consecutiveWaifuMessages: nextCount,
            allowNoReply: true
          });
        }

        return "started";
      } catch (error) {
        if (error instanceof AIRouterAbortError || isAbortError(error)) {
          this.logger.info("Generation cancelled", { channelId: triggerContext.channelId });
          return "started";
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AIRouterAbortError || isAbortError(error)) {
        this.logger.info("Generation cancelled", { channelId: triggerContext.channelId });
        return "started";
      }

      this.logger.error("Orchestration run failed", {
        channelId: triggerContext.channelId,
        trigger: triggerContext.trigger,
        error
      });
      this.events?.emit("generation:cancelled", {
        channelId: triggerContext.channelId,
        waifuId: activeState.waifuId,
        reason: "Orchestrator failure"
      });
      this.scheduleRetrigger(triggerContext.channelId, RETRIGGER_FAILURE_RETRY_SECONDS);
      return "started";
    } finally {
      this.clearActiveGenerationIfCurrent(triggerContext.channelId, activeState);
    }
  }

  private async getDecision(
    promptContext: PromptBuildContext,
    channelId: string,
    signal?: AbortSignal
  ): Promise<OrchestratorDecision> {
    const toolDefinition: ToolDefinition = {
      name: "orchestrator_decision",
      description:
        "Choose whether a waifu should reply next and which waifu(s) should respond.",
      inputSchema: orchestratorDecisionToolInputSchema
    };

    const toolResponse = await this.aiRouter.complete({
      providerId: this.configManager.orchestrator.providerId,
      model: this.configManager.orchestrator.model,
      messages: [
        {
          role: "system",
          content: this.promptBuilder.buildOrchestratorSystemPrompt(promptContext)
        },
        {
          role: "user",
          content: this.promptBuilder.buildOrchestratorUserPrompt(promptContext)
        }
      ],
      temperature: this.configManager.orchestrator.temperature,
      maxTokens: this.configManager.orchestrator.maxTokens,
      signal,
      timeoutMs: 45_000,
      tools: [toolDefinition],
      toolChoice: {
        type: "tool",
        name: toolDefinition.name
      }
    });

    const toolCall = toolResponse.toolCalls?.find((call) => call.name === toolDefinition.name);
    if (!toolCall) {
      throw new Error("Orchestrator did not return the required orchestrator_decision tool call");
    }

    const parsed = orchestratorDecisionSchema.safeParse(toolCall.arguments);
    if (!parsed.success) {
      throw new Error(
        `Orchestrator returned invalid tool arguments: ${JSON.stringify(parsed.error.issues)}`
      );
    }

    const sanitizedDecision = this.sanitizeDecision(parsed.data, promptContext);

    this.logger.info("Orchestrator decision received via tool call", {
      channelId,
      action: sanitizedDecision.action,
      waifus: sanitizedDecision.respondingWaifus.map((entry) => entry.waifuId),
      directInteractionWaifuId: sanitizedDecision.directInteraction?.waifuId ?? null
    });
    return sanitizedDecision;
  }

  private sanitizeDecision(
    decision: OrchestratorDecision,
    promptContext: PromptBuildContext
  ): OrchestratorDecision {
    const latestMessageId = promptContext.messages.at(-1)?.id ?? null;
    if (!latestMessageId) {
      return decision;
    }

    let changed = false;
    const respondingWaifus = decision.respondingWaifus.map((entry) => {
      if (entry.replyToMessageId && entry.replyToMessageId === latestMessageId) {
        changed = true;
        this.logger.info("Clearing replyToMessageId targeting the latest message", {
          channelId: promptContext.channel.channelId,
          waifuId: entry.waifuId,
          replyToMessageId: entry.replyToMessageId
        });
        return {
          ...entry,
          replyToMessageId: null
        };
      }

      return entry;
    });

    if (!changed) {
      return decision;
    }

    return {
      ...decision,
      respondingWaifus
    };
  }

  private async executeDirectInteraction(args: {
    channel: TextChannel;
    channelConfig: ChannelConfig;
    directInteraction: DirectInteractionDecision;
    activeState: ActiveGeneration;
  }): Promise<string | null> {
    const { channel, channelConfig, directInteraction, activeState } = args;
    const waifu = this.configManager.waifus.find(
      (entry) => entry.id === directInteraction.waifuId
    );
    if (!waifu) {
      this.logger.warn("Skipping direct interaction for unknown waifu", {
        waifuId: directInteraction.waifuId
      });
      return null;
    }

    const client = this.botManager.getClient(waifu.id);
    if (!client?.user) {
      this.logger.warn("Skipping direct interaction for waifu without ready client", {
        waifuId: waifu.id
      });
      return null;
    }
    const waifuChannel = await this.resolveWaifuChannel(waifu.id, channel.id);
    if (!waifuChannel) {
      this.logger.warn("Skipping direct interaction for waifu without channel access", {
        waifuId: waifu.id,
        channelId: channel.id
      });
      return null;
    }

    const resolvedEmoji = await this.botManager.resolveGuildEmojiToken(
      channelConfig.guildId,
      directInteraction.emoji
    );
    if (!resolvedEmoji) {
      this.logger.warn("Skipping direct interaction because emoji token could not be resolved", {
        waifuId: waifu.id,
        guildId: channelConfig.guildId,
        emoji: directInteraction.emoji
      });
      return null;
    }

    await sleep(Math.round(directInteraction.delaySeconds * 1_000), undefined, {
      signal: activeState.abortController.signal
    });
    this.throwIfAborted(activeState.abortController.signal);

    const outbound = await this.sendStandaloneMessage({
      waifuChannel,
      content: resolvedEmoji
    });

    const formatted = await this.messageHandler.formatMessage(outbound);
    this.events?.emit("chat:message", {
      channelId: channel.id,
      id: formatted.id,
      content: formatted.content,
      authorName: formatted.authorDisplayName,
      authorAvatar: client.user.displayAvatarURL(),
      isWaifu: true,
      waifuId: waifu.id,
      timestamp: formatted.timestamp
    });

    const nextCount = (this.consecutiveWaifuMessages.get(channel.id) ?? 0) + 1;
    this.consecutiveWaifuMessages.set(channel.id, nextCount);
    return waifu.id;
  }

  private async executeResponse(args: {
    channel: TextChannel;
    channelConfig: ChannelConfig;
    promptContext: PromptBuildContext;
    responseDecision: RespondingWaifuDecision;
    activeState: ActiveGeneration;
  }): Promise<string | null> {
    const { channel, channelConfig, promptContext, responseDecision, activeState } = args;
    const waifu = this.configManager.waifus.find((entry) => entry.id === responseDecision.waifuId);
    if (!waifu) {
      this.logger.warn("Skipping unknown waifu in decision", {
        waifuId: responseDecision.waifuId
      });
      return null;
    }

    const client = this.botManager.getClient(waifu.id);
    if (!client?.user) {
      this.logger.warn("Skipping waifu without ready client", { waifuId: waifu.id });
      return null;
    }
    const waifuChannel = await this.resolveWaifuChannel(waifu.id, channel.id);
    if (!waifuChannel) {
      this.logger.warn("Skipping waifu without channel access", {
        waifuId: waifu.id,
        channelId: channel.id
      });
      return null;
    }

    const typingInterval = setInterval(() => {
      void waifuChannel.sendTyping();
    }, 9_000);
    await waifuChannel.sendTyping();

    const startedAt = Date.now();
    let tokenCount = 0;
    let rawContent = "";
    this.events?.emit("generation:start", {
      channelId: channel.id,
      waifuId: waifu.id,
      waifuName: waifu.name
    });

    try {
      await sleep(this.getWaifuGenerationDelayMs(responseDecision.delaySeconds), undefined, {
        signal: activeState.abortController.signal
      });
      this.throwIfAborted(activeState.abortController.signal);
      const refreshedPromptContext = await this.buildFreshWaifuPromptContext({
        channel,
        channelConfig,
        basePromptContext: promptContext
      });
      this.throwIfAborted(activeState.abortController.signal);
      activeState.phase = "generating";

      const waifuSystemPrompt = this.promptBuilder.buildWaifuSystemPrompt(
        waifu,
        refreshedPromptContext,
        responseDecision.replyStyle,
        waifu.ai.systemPromptOverride
      );
      const replyToMessage =
        responseDecision.replyToMessageId
          ? refreshedPromptContext.messages.find(
              (message) => message.id === responseDecision.replyToMessageId
            ) ?? null
          : null;

      const waifuMessages = [
        {
          role: "system" as const,
          content: waifuSystemPrompt
        },
        ...this.promptBuilder.buildWaifuTranscriptMessages(refreshedPromptContext),
        this.promptBuilder.buildWaifuReplyCue(
          waifu,
          replyToMessage,
          responseDecision.sceneDirection
        )
      ];

      const completion = await this.aiRouter.complete({
        providerId: waifu.ai.providerId,
        model: waifu.ai.model,
        messages: waifuMessages,
        temperature: waifu.ai.temperature,
        repetitionPenalty: waifu.ai.repetitionPenalty,
        maxTokens: waifu.ai.maxTokens,
        signal: activeState.abortController.signal,
        timeoutMs: 60_000,
        onToken: (token) => {
          tokenCount += 1;
          rawContent += token;
          this.events?.emit("generation:token", {
            channelId: channel.id,
            waifuId: waifu.id,
            token,
            totalTokens: tokenCount
          });
        }
      });

      if (!rawContent) {
        rawContent = completion.content;
      }
      this.logger.info("Waifu generation completed", {
        channelId: channel.id,
        waifuId: waifu.id,
        finishReason: completion.finishReason,
        usage: completion.usage
      });

      const formattedContent = await this.formatOutboundContent(
        rawContent,
        refreshedPromptContext.messages,
        channelConfig.guildId
      );
      if (!formattedContent.trim() && !responseDecision.shouldReact) {
        return null;
      }

      const outbound = await this.sendMessage({
        waifu,
        channel,
        content: formattedContent,
        responseDecision
      });

      if (responseDecision.shouldReact && responseDecision.reactionEmoji) {
        const resolvedReactionEmoji =
          (await this.botManager.resolveGuildEmojiToken(
            channelConfig.guildId,
            responseDecision.reactionEmoji
          )) ?? responseDecision.reactionEmoji;
        const targetMessage = await this.resolveReactionTarget(
          waifuChannel,
          responseDecision.replyToMessageId ?? refreshedPromptContext.messages.at(-1)?.id ?? null
        );
        if (targetMessage) {
          await targetMessage.react(resolvedReactionEmoji);
        }
      }

      const formatted = await this.messageHandler.formatMessage(outbound);
      this.events?.emit("chat:message", {
        channelId: channel.id,
        id: formatted.id,
        content: formatted.content,
        authorName: formatted.authorDisplayName,
        authorAvatar: client.user.displayAvatarURL(),
        isWaifu: true,
        waifuId: waifu.id,
        timestamp: formatted.timestamp
      });
      this.events?.emit("generation:complete", {
        channelId: channel.id,
        waifuId: waifu.id,
        content: formattedContent,
        tokenCount,
        durationMs: Date.now() - startedAt
      });

      const nextCount = (this.consecutiveWaifuMessages.get(channel.id) ?? 0) + 1;
      this.consecutiveWaifuMessages.set(channel.id, nextCount);
      return waifu.id;
    } finally {
      clearInterval(typingInterval);
    }
  }

  private getWaifuGenerationDelayMs(delaySeconds: number): number {
    if (delaySeconds <= 0) {
      return 0;
    }

    return Math.max(0, Math.round(delaySeconds * 1_000) - WAIFU_CONTEXT_REFRESH_HEADSTART_MS);
  }

  private async buildFreshWaifuPromptContext(args: {
    channel: TextChannel;
    channelConfig: ChannelConfig;
    basePromptContext: PromptBuildContext;
  }): Promise<PromptBuildContext> {
    const { channel, channelConfig, basePromptContext } = args;

    try {
      const messages = await this.messageHandler.fetchContext(
        channel,
        channelConfig.contextMessageCount ?? 80,
        channelConfig.contextAnchorMessageId ?? null
      );
      return {
        ...basePromptContext,
        messages,
        currentTimeUTC: new Date().toISOString(),
        stageStateByWaifuId: this.buildStageStateByWaifuId(basePromptContext.activeWaifus, channelConfig)
      };
    } catch (error) {
      this.logger.warn("Failed to refresh waifu prompt context; using existing snapshot", {
        channelId: channel.id,
        error
      });
      return {
        ...basePromptContext,
        currentTimeUTC: new Date().toISOString(),
        stageStateByWaifuId: this.buildStageStateByWaifuId(basePromptContext.activeWaifus, channelConfig)
      };
    }
  }

  private buildStageStateByWaifuId(
    activeWaifus: WaifuConfig[],
    channelConfig: ChannelConfig
  ): NonNullable<PromptBuildContext["stageStateByWaifuId"]> {
    const checkpointScopeId = this.stageManagerStore.getCheckpointScopeId(channelConfig);
    return Object.fromEntries(
      activeWaifus.map((waifu) => [waifu.id, this.stageManagerStore.getWaifuState(waifu.id, checkpointScopeId)])
    );
  }

  private async sendMessage(args: {
    waifu: WaifuConfig;
    channel: TextChannel;
    content: string;
    responseDecision: RespondingWaifuDecision;
  }): Promise<Message> {
    const { waifu, channel, content, responseDecision } = args;
    const client = this.botManager.getClient(waifu.id);
    if (!client) {
      throw new Error(`Missing client for waifu ${waifu.id}`);
    }

    const clientChannel = await client.channels.fetch(channel.id);
    if (!clientChannel?.isTextBased() || !("send" in clientChannel)) {
      throw new Error(`Waifu ${waifu.id} cannot access text channel ${channel.id}`);
    }

    return new Promise<Message>((resolve, reject) => {
      void this.botManager
        .sendWithRateLimit(channel.id, async () => {
          if (
            responseDecision.replyToMessageId &&
            "messages" in clientChannel &&
            clientChannel.messages
          ) {
            try {
              const target = await clientChannel.messages.fetch(responseDecision.replyToMessageId);
              const sent = await target.reply({
                content,
                allowedMentions: { parse: ["users"] }
              });
              resolve(sent);
              return;
            } catch {
              // Fall through to standard send when reply target cannot be fetched.
            }
          }

          const sent = await clientChannel.send({
            content,
            allowedMentions: { parse: ["users"] }
          });
          resolve(sent);
        })
        .catch(reject);
    });
  }

  private async sendStandaloneMessage(args: {
    waifuChannel: TextChannel;
    content: string;
  }): Promise<Message> {
    const { waifuChannel, content } = args;

    return new Promise<Message>((resolve, reject) => {
      void this.botManager
        .sendWithRateLimit(waifuChannel.id, async () => {
          const sent = await waifuChannel.send({
            content,
            allowedMentions: { parse: ["users"] }
          });
          resolve(sent);
        })
        .catch(reject);
    });
  }

  private async formatOutboundContent(
    content: string,
    messages: FormattedMessage[],
    guildId: string
  ): Promise<string> {
    const { resolvedByNormalized, aliases } = await this.buildMentionLookup(guildId, messages);
    const aliasPattern = buildMentionAliasPattern(aliases);
    const mentionFormatted = aliasPattern
      ? content.replace(aliasPattern, (match) => {
          const normalized = normalizeLookupKey(match.slice(1));
          const userId = resolvedByNormalized.get(normalized);
          return userId ? `<@${userId}>` : match;
        })
      : content;

    return this.resolveGuildEmojiTokens(guildId, mentionFormatted);
  }

  private async buildMentionLookup(
    guildId: string,
    messages: FormattedMessage[]
  ): Promise<{ resolvedByNormalized: Map<string, string>; aliases: string[] }> {
    const nameToUserIds = new Map<string, Set<string>>();
    const normalizedToAliases = new Map<string, Set<string>>();
    const register = (name: string | null | undefined, userId: string | null | undefined): void => {
      if (!name || !userId) {
        return;
      }

      const key = normalizeLookupKey(name);
      if (!key) {
        return;
      }

      const ids = nameToUserIds.get(key) ?? new Set<string>();
      ids.add(userId);
      nameToUserIds.set(key, ids);

      const aliases = normalizedToAliases.get(key) ?? new Set<string>();
      aliases.add(name.trim());
      normalizedToAliases.set(key, aliases);
    };

    const guildMembers = await this.botManager.fetchGuildMembers(guildId);
    for (const member of guildMembers) {
      if (this.botManager.isOurBot(member.id)) {
        const waifu = this.configManager.waifus.find(
          (entry) => entry.id === this.botManager.getWaifuIdByUserId(member.id)
        );
        register(waifu?.name, member.id);
        continue;
      }

      register(member.displayName, member.id);
      register(member.user.globalName, member.id);
      register(member.user.username, member.id);
    }

    for (const waifu of this.configManager.waifus) {
      const userId = this.botManager.getUserIdByWaifuId(waifu.id);
      register(waifu.name, userId);
    }

    for (const message of messages) {
      register(message.authorDisplayName, message.authorId);
    }

    const resolvedByNormalized = new Map<string, string>();
    const aliases: string[] = [];

    for (const [normalized, userIds] of nameToUserIds.entries()) {
      if (userIds.size !== 1) {
        continue;
      }

      resolvedByNormalized.set(normalized, [...userIds][0]);
      aliases.push(...(normalizedToAliases.get(normalized) ?? []));
    }

    return { resolvedByNormalized, aliases };
  }

  private async resolveGuildEmojiTokens(guildId: string, content: string): Promise<string> {
    const matches = [...content.matchAll(/:([A-Za-z0-9_]{2,32}):/g)];
    if (matches.length === 0) {
      return content;
    }

    const replacements = new Map<string, string>();
    for (const match of matches) {
      const token = match[0];
      if (replacements.has(token)) {
        continue;
      }

      const resolved = await this.botManager.resolveGuildEmojiToken(guildId, token);
      if (resolved) {
        replacements.set(token, resolved);
      }
    }

    if (replacements.size === 0) {
      return content;
    }

    return content.replace(/:([A-Za-z0-9_]{2,32}):/g, (token) => replacements.get(token) ?? token);
  }

  private async resolveReactionTarget(
    channel: TextChannel,
    messageId: string | null
  ): Promise<Message | null> {
    if (!messageId) {
      return null;
    }

    try {
      return await channel.messages.fetch(messageId);
    } catch {
      return null;
    }
  }

  private async resolveWaifuChannel(
    waifuId: string,
    channelId: string
  ): Promise<TextChannel | null> {
    const client = this.botManager.getClient(waifuId);
    if (!client) {
      return null;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !("messages" in channel)) {
        return null;
      }

      return channel as TextChannel;
    } catch {
      return null;
    }
  }

  private getActiveWaifus(channelConfig: ChannelConfig): WaifuConfig[] {
    return this.configManager.waifus.filter(
      (waifu) => waifu.enabled && channelConfig.activeWaifuIds.includes(waifu.id)
    );
  }

  private async resolveChannel(channelConfig: ChannelConfig): Promise<TextChannel | null> {
    const client = this.botManager.getFirstReadyClient(channelConfig.activeWaifuIds);
    if (!client) {
      return null;
    }

    const channel = await client.channels.fetch(channelConfig.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) {
      return null;
    }

    return channel as TextChannel;
  }

  private clearRetrigger(channelId: string): void {
    const timer = this.retriggerTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.retriggerTimers.delete(channelId);
    }
  }

  private scheduleRetrigger(channelId: string, seconds: number): void {
    this.clearRetrigger(channelId);
    const timeout = setTimeout(() => {
      if (this.retriggerTimers.get(channelId) !== timeout) {
        return;
      }

      this.retriggerTimers.delete(channelId);
      void this.run({
        channelId,
        trigger: "idle",
        consecutiveWaifuMessages: this.consecutiveWaifuMessages.get(channelId) ?? 0,
        allowNoReply: false
      })
        .then((outcome) => {
          const retryAfterSeconds =
            outcome === "skipped_active"
              ? RETRIGGER_OVERLAP_RETRY_SECONDS
              : outcome === "skipped_unavailable"
                ? RETRIGGER_UNAVAILABLE_RETRY_SECONDS
                : null;
          if (!retryAfterSeconds) {
            return;
          }

          this.logger.info("Retrying orchestrator retrigger", {
            channelId,
            outcome,
            retryAfterSeconds
          });
          this.scheduleRetrigger(channelId, retryAfterSeconds);
        })
        .catch((error) => {
          this.logger.error("Scheduled orchestrator retrigger failed", {
            channelId,
            error
          });
          this.scheduleRetrigger(channelId, RETRIGGER_FAILURE_RETRY_SECONDS);
        });
    }, seconds * 1_000);
    this.retriggerTimers.set(channelId, timeout);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) {
      return;
    }

    throw new AIRouterAbortError();
  }
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildMentionAliasPattern(aliases: string[]): RegExp | null {
  const uniqueAliases = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))];
  if (uniqueAliases.length === 0) {
    return null;
  }

  const escaped = uniqueAliases
    .sort((left, right) => right.length - left.length)
    .map((alias) => escapeRegex(alias));

  return new RegExp(`@(?:${escaped.join("|")})(?=$|[\\s.,!?;:)"'\\]}])`, "gu");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
