// Reviewer: checks the latest waifu message for leaked/hallucinated content, deletes it when
// flagged, records reviewer history, then re-triggers the channel unless a newer run took over.

import { randomUUID } from "node:crypto";
import { nowIso } from "../shared/schemas/common.js";
import { ChannelRunner } from "./channelRunner.js";
import { ModelAccess } from "./modelAccess.js";
import { type RuntimeServices, decrementActive, incrementActive, runKey, timerKey } from "./runtimeShared.js";
import { ensureServer, readAgentConfig } from "./stores/config.js";
import { appendReviewerHistory } from "./stores/decisionHistory.js";
import { resolveContextCap } from "./contextWindows.js";

export class ReviewerRunner {
  readonly activeReviewerRuns = new Map<string, number>();

  constructor(
    private readonly options: RuntimeServices,
    private readonly models: ModelAccess,
    private readonly runner: Pick<ChannelRunner, "activeRuns" | "channelRunVersions" | "startChannelRunBackground">
  ) {}

  async runReviewer(input: {
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
      limit: resolveContextCap("waifu", server, config)
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
      // System prompt plus one message (spec 8.7); the custom prompt is the owner policy (B28).
      message: target.content,
      authorName: target.displayName,
      ...(config.prompt.trim() ? { systemPrompt: config.prompt } : {}),
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
}
