import type { TextChannel } from "discord.js";
import type { AIRouter, ToolDefinition, ToolChoice } from "./ai-router.js";
import type { BotManager } from "./bot-manager.js";
import type { ConfigManager } from "./config-manager.js";
import type { FormattedMessage, MessageHandler } from "./message-handler.js";
import { PromptBuilder, type StageManagerParticipantView, type StageManagerPromptContext } from "./prompt-builder.js";
import type { RuntimeEventBus } from "./runtime-events.js";
import {
  stageManagerDecisionSchema,
  stageManagerDecisionToolInputSchema,
  type ChannelConfig,
  type StageManagerConfig,
  type StageManagerDecision,
  type WaifuConfig
} from "./types/index.js";
import { Logger } from "./utils/logger.js";
import {
  type StageManagerStateStore,
  type StageManagerApplyResult,
  type StageManagerParticipant
} from "./stage-manager-store.js";

type StageManagerTrigger = "quiet" | "manual" | "startup_reconciliation";

interface ScheduledRun {
  timer: NodeJS.Timeout;
  runAt: string;
  reason: StageManagerTrigger;
}

interface RunResult {
  decision: StageManagerDecision;
  applied: StageManagerApplyResult;
  snapshotLastMessageId: string | null;
  messageCount: number;
  newMessageCount: number;
  noOp: boolean;
  usedFallbackModel: boolean;
}

export class StageManager {
  private readonly logger = new Logger("StageManager");
  private readonly promptBuilder = new PromptBuilder();
  private readonly scheduledRuns = new Map<string, ScheduledRun>();
  private readonly dirtyChannels = new Set<string>();
  private readonly runningChannels = new Set<string>();
  private readonly rerunAfterCurrent = new Set<string>();

  constructor(
    private readonly aiRouter: AIRouter,
    private readonly configManager: ConfigManager,
    private readonly botManager: BotManager,
    private readonly messageHandler: MessageHandler,
    private readonly store: StageManagerStateStore,
    private readonly events?: RuntimeEventBus
  ) {
    this.events?.on("chat:message", (payload) => {
      void this.handleChatMessage(payload.channelId);
    });
  }

  getRuntimeState(): {
    scheduledChannels: Array<{ channelId: string; runAt: string; reason: StageManagerTrigger }>;
    runningChannels: string[];
    dirtyChannels: string[];
  } {
    return {
      scheduledChannels: [...this.scheduledRuns.entries()].map(([channelId, value]) => ({
        channelId,
        runAt: value.runAt,
        reason: value.reason
      })),
      runningChannels: [...this.runningChannels],
      dirtyChannels: [...this.dirtyChannels]
    };
  }

  getStateSnapshot() {
    return this.store.snapshot();
  }

  async reconcileOnStartup(): Promise<void> {
    if (!this.configManager.stageManager.enabled) {
      return;
    }

    const scheduledGuildIds = new Set<string>();
    for (const channelConfig of this.getEligibleChannels()) {
      if (scheduledGuildIds.has(channelConfig.guildId)) {
        continue;
      }

      const guildContext = await this.fetchGuildContext(channelConfig);
      if (!guildContext) {
        continue;
      }

      const checkpoint = this.store.getCheckpoint(guildContext.checkpointScopeId).lastProcessedMessageId;
      const unseenMessages = checkpoint
        ? guildContext.messages.filter((message) => compareMessageIds(message.id, checkpoint) > 0)
        : guildContext.messages;
      if (unseenMessages.length === 0) {
        continue;
      }

      this.dirtyChannels.add(guildContext.primaryChannelId);
      this.scheduleRun(guildContext.primaryChannelId, "startup_reconciliation");
      scheduledGuildIds.add(channelConfig.guildId);
    }
  }

  handleConfigChanged(): void {
    if (!this.configManager.stageManager.enabled) {
      this.clearAllTimers();
      this.dirtyChannels.clear();
      this.rerunAfterCurrent.clear();
      return;
    }

    for (const channelId of this.dirtyChannels) {
      this.scheduleRun(channelId, "quiet");
    }
  }

  async runNow(channelId: string): Promise<RunResult> {
    this.clearTimer(channelId);
    this.dirtyChannels.add(channelId);
    return this.runChannel(channelId, "manual");
  }

  private async handleChatMessage(channelId: string): Promise<void> {
    if (!this.configManager.stageManager.enabled) {
      return;
    }

    const channelConfig = this.configManager.channels.find(
      (entry) =>
        entry.channelId === channelId &&
        entry.enabled &&
        entry.activeWaifuIds.length > 0
    );
    if (!channelConfig) {
      return;
    }

    this.dirtyChannels.add(channelId);
    if (this.runningChannels.has(channelId)) {
      this.rerunAfterCurrent.add(channelId);
      return;
    }

    this.scheduleRun(channelId, "quiet");
  }

  private scheduleRun(channelId: string, reason: StageManagerTrigger): void {
    if (!this.configManager.stageManager.enabled) {
      return;
    }

    this.clearTimer(channelId);
    const delayMs =
      reason === "manual"
        ? 0
        : Math.max(0, this.configManager.stageManager.quietPeriodSeconds * 1_000);
    const runAt = new Date(Date.now() + delayMs).toISOString();
    const timer = setTimeout(() => {
      void this.runChannel(channelId, reason).catch((error) => {
        this.logger.error("Scheduled stage-manager run failed", {
          channelId,
          reason,
          error
        });
      });
    }, delayMs);

    this.scheduledRuns.set(channelId, {
      timer,
      runAt,
      reason
    });
    this.events?.emit("stage-manager:scheduled", {
      channelId,
      runAt,
      reason,
      timestamp: new Date().toISOString()
    });
  }

  private async runChannel(channelId: string, trigger: StageManagerTrigger): Promise<RunResult> {
    if (this.runningChannels.has(channelId)) {
      this.rerunAfterCurrent.add(channelId);
      return {
        decision: emptyDecision(),
        applied: emptyApplyResult(),
        snapshotLastMessageId: null,
        messageCount: 0,
        newMessageCount: 0,
        noOp: true,
        usedFallbackModel: false
      };
    }

    this.clearTimer(channelId);
    this.runningChannels.add(channelId);

    try {
      const result = await this.executeRun(channelId, trigger);
      return result;
    } catch (error) {
      this.events?.emit("stage-manager:error", {
        channelId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
      throw error;
    } finally {
      this.runningChannels.delete(channelId);
      if (this.rerunAfterCurrent.has(channelId) && this.configManager.stageManager.enabled) {
        this.rerunAfterCurrent.delete(channelId);
        this.scheduleRun(channelId, "quiet");
      }
    }
  }

  private async executeRun(channelId: string, trigger: StageManagerTrigger): Promise<RunResult> {
    const channelConfig = this.configManager.channels.find(
      (entry) => entry.channelId === channelId && entry.enabled && entry.activeWaifuIds.length > 0
    );
    if (!channelConfig || !this.configManager.stageManager.enabled) {
      return {
        decision: emptyDecision(),
        applied: emptyApplyResult(),
        snapshotLastMessageId: null,
        messageCount: 0,
        newMessageCount: 0,
        noOp: true,
        usedFallbackModel: false
      };
    }

    const guildContext = await this.fetchGuildContext(channelConfig);
    if (!guildContext) {
      throw new Error(`Unable to resolve stage-manager channel ${channelId}`);
    }

    const checkpointScopeId = guildContext.checkpointScopeId;
    const checkpoint = this.store.getCheckpoint(checkpointScopeId);
    const messages = guildContext.messages;
    const snapshotLastMessageId = messages.at(-1)?.id ?? checkpoint.lastProcessedMessageId ?? null;
    const newMessages = checkpoint.lastProcessedMessageId
      ? messages.filter((message) => compareMessageIds(message.id, checkpoint.lastProcessedMessageId!) > 0)
      : messages;

    this.events?.emit("stage-manager:start", {
      channelId,
      trigger,
      messageCount: messages.length,
      newMessageCount: newMessages.length,
      snapshotLastMessageId,
      timestamp: new Date().toISOString()
    });

    if (newMessages.length === 0) {
      const now = new Date().toISOString();
      await this.store.saveCheckpoint(checkpointScopeId, {
        lastRunAt: now
      });
      this.dirtyChannels.delete(channelId);
      const result = {
        decision: emptyDecision(),
        applied: emptyApplyResult(),
        snapshotLastMessageId,
        messageCount: messages.length,
        newMessageCount: 0,
        noOp: true,
        usedFallbackModel: false
      };
      this.events?.emit("stage-manager:complete", {
        channelId,
        trigger,
        relationshipUpdateCount: 0,
        memoryUpdateCount: 0,
        affectedWaifuIds: [],
        affectedParticipantKeys: [],
        reasoning: "",
        checkpointMessageId: checkpoint.lastProcessedMessageId,
        snapshotLastMessageId,
        noOp: true,
        usedFallbackModel: false,
        timestamp: now
      });
      return result;
    }

    const activeWaifus = guildContext.activeWaifus;
    const availableParticipants = this.collectAvailableParticipants(activeWaifus, messages);
    const currentTimeUTC = new Date().toISOString();
    const promptContext: StageManagerPromptContext = {
      activeWaifus,
      knownWaifus: this.configManager.waifus,
      channel: channelConfig,
      currentTimeUTC,
      config: this.configManager.stageManager,
      history: messages.slice(-this.configManager.stageManager.historyLimit),
      newMessages: newMessages.slice(-this.configManager.stageManager.historyLimit),
      checkpointMessageId: checkpoint.lastProcessedMessageId,
      availableParticipants: [...availableParticipants.values()].map((entry) => ({
        key: entry.key,
        label: entry.targetName,
        kind: entry.targetKind
      })),
      stageStateByWaifuId: Object.fromEntries(
        activeWaifus.map((waifu) => [waifu.id, this.store.getWaifuState(waifu.id, checkpointScopeId)])
      )
    };

    const { providerId, model, usedFallbackModel } = this.resolveModelConfig();
    const toolDefinition: ToolDefinition = {
      name: "stage_manager_update",
      description:
        "Apply durable relationship and memory updates for waifus when the chat justifies them.",
      inputSchema: stageManagerDecisionToolInputSchema
    };
    const response = await this.aiRouter.complete({
      providerId,
      model,
      messages: [
        {
          role: "system",
          content: this.promptBuilder.buildStageManagerSystemPrompt(promptContext)
        },
        {
          role: "user",
          content: this.promptBuilder.buildStageManagerUserPrompt(promptContext)
        }
      ],
      temperature: this.configManager.stageManager.temperature,
      maxTokens: this.configManager.stageManager.maxTokens,
      tools: [toolDefinition]
    });

    const toolCall = response.toolCalls?.find((call) => call.name === toolDefinition.name);
    const decision = toolCall
      ? parseStageManagerDecision(toolCall.arguments)
      : emptyDecision();
    const now = new Date().toISOString();
    const applied = toolCall
      ? await this.store.applyDecisionAndSave({
          decision,
          config: this.configManager.stageManager,
          knownWaifus: this.configManager.waifus,
          availableParticipantsByKey: availableParticipants,
          timestamp: now,
          checkpointScopeId,
          checkpointPatch: {
            lastProcessedMessageId: snapshotLastMessageId,
            lastRunAt: now
          }
        })
      : emptyApplyResult();
    if (!toolCall) {
      await this.store.saveCheckpoint(checkpointScopeId, {
        lastProcessedMessageId: snapshotLastMessageId,
        lastRunAt: now
      });
    }
    this.dirtyChannels.delete(channelId);

    this.events?.emit("stage-manager:complete", {
      channelId,
      trigger,
      relationshipUpdateCount: applied.relationshipUpdateCount,
      memoryUpdateCount: applied.memoryUpdateCount,
      affectedWaifuIds: applied.affectedWaifuIds,
      affectedParticipantKeys: applied.affectedParticipantKeys,
      reasoning: decision.reasoning,
      checkpointMessageId: checkpoint.lastProcessedMessageId,
      snapshotLastMessageId,
      noOp: !toolCall,
      usedFallbackModel,
      timestamp: now
    });

    return {
      decision,
      applied,
      snapshotLastMessageId,
      messageCount: messages.length,
      newMessageCount: newMessages.length,
      noOp: !toolCall,
      usedFallbackModel
    };
  }

  private resolveModelConfig(): {
    providerId: string;
    model: string;
    usedFallbackModel: boolean;
  } {
    const stageManagerConfig = this.configManager.stageManager;
    if (!stageManagerConfig.providerId || !stageManagerConfig.model) {
      return {
        providerId: this.configManager.orchestrator.providerId,
        model: this.configManager.orchestrator.model,
        usedFallbackModel: true
      };
    }

    const provider = this.aiRouter.getProvider(stageManagerConfig.providerId);
    if (!provider) {
      throw new Error(`Unknown stage-manager provider: ${stageManagerConfig.providerId}`);
    }
    if (!provider.models.includes(stageManagerConfig.model)) {
      throw new Error(
        `Invalid stage-manager model ${stageManagerConfig.model} for provider ${stageManagerConfig.providerId}`
      );
    }

    return {
      providerId: stageManagerConfig.providerId,
      model: stageManagerConfig.model,
      usedFallbackModel: false
    };
  }

  private collectAvailableParticipants(
    activeWaifus: WaifuConfig[],
    messages: FormattedMessage[]
  ): Map<string, StageManagerParticipant> {
    const participants = new Map<string, StageManagerParticipant>();

    for (const waifu of activeWaifus) {
      participants.set(`waifu:${waifu.id}`, {
        key: `waifu:${waifu.id}`,
        targetKind: "waifu",
        targetName: waifu.name,
        targetUserId: this.botManager.getUserIdByWaifuId(waifu.id),
        targetWaifuId: waifu.id
      });
    }

    for (const message of messages) {
      if (message.isWaifu || !message.authorId) {
        continue;
      }

      participants.set(`user:${message.authorId}`, {
        key: `user:${message.authorId}`,
        targetKind: "user",
        targetName: message.authorDisplayName,
        targetUserId: message.authorId,
        targetWaifuId: null
      });
    }

    return participants;
  }

  private async fetchGuildContext(channelConfig: ChannelConfig): Promise<{
    checkpointScopeId: string;
    primaryChannelId: string;
    messages: FormattedMessage[];
    activeWaifus: WaifuConfig[];
  } | null> {
    const guildChannels = this.getEligibleChannelsForGuild(channelConfig.guildId);
    const resolvedChannels = await Promise.all(
      guildChannels.map(async (candidate) => ({
        config: candidate,
        channel: await this.resolveChannel(candidate)
      }))
    );
    const availableChannels = resolvedChannels.filter(
      (entry): entry is { config: ChannelConfig; channel: TextChannel } => Boolean(entry.channel)
    );
    if (availableChannels.length === 0) {
      return null;
    }

    const histories = await Promise.all(
      availableChannels.map(({ config, channel }) =>
        this.messageHandler.fetchContext(
          channel,
          config.contextMessageCount ?? 80,
          config.contextAnchorMessageId ?? null
        )
      )
    );

    const mergedMessages = histories
      .flat()
      .sort((left, right) => compareMessageIds(left.id, right.id));
    const activeWaifuIds = new Set(
      guildChannels.flatMap((candidate) => candidate.activeWaifuIds)
    );

    return {
      checkpointScopeId: this.store.getCheckpointScopeId(channelConfig),
      primaryChannelId: availableChannels[0].config.channelId,
      messages: mergedMessages,
      activeWaifus: this.configManager.waifus.filter(
        (waifu) => waifu.enabled && activeWaifuIds.has(waifu.id)
      )
    };
  }

  private getEligibleChannelsForGuild(guildId: string): ChannelConfig[] {
    return this.configManager.channels.filter(
      (channel) =>
        channel.guildId === guildId &&
        channel.enabled &&
        channel.activeWaifuIds.length > 0
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

  private getEligibleChannels(): ChannelConfig[] {
    return this.configManager.channels.filter(
      (channel) => channel.enabled && channel.activeWaifuIds.length > 0
    );
  }

  private clearTimer(channelId: string): void {
    const scheduled = this.scheduledRuns.get(channelId);
    if (!scheduled) {
      return;
    }

    clearTimeout(scheduled.timer);
    this.scheduledRuns.delete(channelId);
  }

  private clearAllTimers(): void {
    for (const scheduled of this.scheduledRuns.values()) {
      clearTimeout(scheduled.timer);
    }
    this.scheduledRuns.clear();
  }
}

function parseStageManagerDecision(input: unknown): StageManagerDecision {
  const parsed = stageManagerDecisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Stage manager returned invalid tool arguments: ${JSON.stringify(parsed.error.issues)}`
    );
  }
  return parsed.data;
}

function emptyDecision(): StageManagerDecision {
  return {
    relationshipUpdates: [],
    memoryUpdates: [],
    reasoning: ""
  };
}

function emptyApplyResult(): StageManagerApplyResult {
  return {
    relationshipUpdateCount: 0,
    memoryUpdateCount: 0,
    affectedWaifuIds: [],
    affectedParticipantKeys: []
  };
}

function compareMessageIds(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}
