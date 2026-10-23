// Executes an orchestrator decision's responders: per-waifu availability checks, delays, prompt
// assembly, the generate -> clean -> validate -> retry loop, chunked sending, tool handling
// (add_memory notes, PickNextWaifu handoffs) and responder-outcome bookkeeping.

import { randomUUID } from "node:crypto";
import { Logger } from "../backend/logger.js";
import { DiscordGatewayFacade } from "../discord/client.js";
import { dedupeNames, stripLeakedContextHeader } from "../discord/normalization.js";
import { splitWaifuReply, typingDelayMs } from "./messageSplit.js";
import { waifuBlockTags } from "./promptBlocks.js";
import {
  SOFT_VALIDATOR_CHECKS,
  type ValidationContext,
  type Violation,
  correctiveRetryMessage,
  validateWaifuOutput
} from "./outputValidator.js";
import { type ReplyQuoteExtraction, extractReplyQuote } from "./replyQuote.js";
import { WaifuGenerationResult } from "../providers/types.js";
import { PermissionWarningTracker } from "./permissionWarnings.js";
import {
  ActiveChatParticipant,
  OrchestratorDecisionStatus,
  OrchestratorResponderOutcome,
  OrchestratorRespondingWaifu,
  ServerConfig,
  WaifuConfig
} from "../shared/schemas/domain.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import type { ContextMessage } from "./contextMessages.js";
import type { OrchestratorDecision } from "./decisions.js";
import { ModelAccess } from "./modelAccess.js";
import { buildWaifuPromptParts, directiveTextForWaifu } from "./promptBuilders.js";
import { type RuntimeServices, decrementActive, incrementActive, runKey, throwIfAborted, timerKey } from "./runtimeShared.js";
import { readDiscordBotsFile, readWaifu } from "./stores/config.js";
import {
  finalizeOrchestratorDecisionAfterError,
  insertOrchestratorResponderOutcomeAfter,
  moveOrchestratorResponderOutcomeAfter,
  recordOrchestratorDecisionWaifuMessage,
  updateOrchestratorDecisionStatus,
  updateOrchestratorResponderOutcome
} from "./stores/decisionHistory.js";
import { recordWaifuNotes } from "./stores/memories.js";
import { noteActiveChatParticipantsFromContext, readActiveChatParticipants } from "./stores/participants.js";
import { setActivePipeline } from "./stores/sessions.js";
import { legacyServerContextWindow } from "./contextWindows.js";

export type ResponderExecutionResult = {
  /** Responders that reached generation (enabled, linked, modeled). */
  attemptedCount: number;
  /** Responders whose turn actually landed: visible message sent, or a tool-only turn. */
  executedCount: number;
};

export type ExecuteResponderDecisionInput = {
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

export class ResponderExecutor {
  // Exact prompt parts sent with each waifu's most recent generation, for /print system_prompt.
  readonly lastSentWaifuPrompts = new Map<
    string,
    { systemPrompt: string; midSystemBlock: string; trailingSystemBlock: string; at: string; channelId: string }
  >();
  private readonly recentSelfSentIds = new Map<string, number>();
  readonly activeWaifuSendChannels = new Set<string>();
  readonly activeWaifuQueries = new Map<string, number>();
  // One-shot: when a waifu in this channel just emitted a tool-only reply
  // (add_memory call with no Discord text), drop the memory tool from the
  // next decision so the chain doesn't loop on silent memory-tool turns.
  private readonly suppressMemoryToolOnce = new Set<string>();
  private static readonly SELF_SENT_TTL_MS = 60_000;

  constructor(
    private readonly options: RuntimeServices,
    private readonly models: ModelAccess,
    private readonly permissionWarnings: PermissionWarningTracker,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    private readonly maxAutomaticTurns: number
  ) {}

  async executeResponderDecision(input: ExecuteResponderDecisionInput): Promise<ResponderExecutionResult> {
    let attemptedCount = 0;
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
          await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
            status: "unavailable",
            reason: "not_enabled_for_channel"
          });
          currentOutcomeFinalized = true;
          continue;
        }
        const waifu = await readWaifu(this.options.storage, responder.waifuId).catch(() => undefined);
        if (!waifu) {
          this.options.logger.warn("Orchestrator selected an unknown waifu", {
            guildId: input.guildId,
            channelId: input.channelId,
            selectedWaifuId: responder.waifuId
          });
          await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
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
          await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
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
          await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
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
          await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
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
        await setActivePipeline(this.options.storage, input.guildId, input.channelId, "waifu");
        const waifuModelId = waifu.modelId;
        let responderLanded = false;
        let waifuMessages = await this.options.discord.fetchFreshContext({
          guildId: input.guildId,
          channelId: input.channelId,
          limit: waifu.contextWindow || legacyServerContextWindow("waifu", input.server),
          signal: input.signal
        });
        await noteActiveChatParticipantsFromContext(this.options.storage, input.guildId, input.channelId, waifuMessages);
        const activeChatParticipants = await readActiveChatParticipants(this.options.storage, input.guildId, input.channelId);
        waifuMessages = await this.models.messagesForModel(
          waifuMessages,
          { providerId: waifu.providerId, modelId: waifuModelId },
          input.signal
        );
        const waifuPipeline = this.models.pipelineFor(
          { providerId: waifu.providerId, modelId: waifuModelId },
          "waifu"
        );
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
          // waifu.botId is the discord-bots ENTRY id; context authorIds carry the bot user
          // snowflake. Resolve both, or the waifu never recognizes her own prior messages.
          const selfAuthorIds = resolveBotAuthorIds(waifu.botId, await readDiscordBotsFile(this.options.storage));
          const selfDisplayNames = dedupeNames([
            waifu.displayName,
            waifu.name,
            ...waifuMessages
              .filter((message) => selfAuthorIds.includes(message.authorId))
              .flatMap((message) => [message.displayName, message.name])
          ]);
          const directiveText = directiveTextForWaifu(responder.directive);
          const effectiveShortTermMemory = input.server.tools.shortTermMemory && !suppressMemoryToolThisDecision;
          const { systemPrompt, midSystemBlock, trailingSystemBlock, selfGuildNickname } = await buildWaifuPromptParts(
            this.options,
            input.guildId,
            waifu,
            input.availableWaifus,
            {
              channelId: input.channelId,
              directorNote: directiveText,
              pickNextWaifuToolOverride: input.server.tools.pickNextWaifu,
              shortTermMemoryToolOverride: effectiveShortTermMemory,
              contextMessages: waifuMessages,
              memoryInjectionLimit: input.server.memoryInjectionLimit
            }
          );
          this.lastSentWaifuPrompts.set(`${input.guildId}:${waifu.id}`, {
            systemPrompt,
            midSystemBlock,
            trailingSystemBlock,
            at: new Date().toISOString(),
            channelId: input.channelId
          });
          const allSelfDisplayNames = selfGuildNickname
            ? dedupeNames([...selfDisplayNames, selfGuildNickname])
            : selfDisplayNames;
          const activeAuthorIds = waifuMessages.map((message) => message.authorId);
          const validatorDirective =
            responder.directive && responder.directive.intent !== "manual"
              ? { intent: responder.directive.intent, goal: responder.directive.goal ?? "" }
              : undefined;
          const validatorBlockTags = waifuBlockTags(waifu);
          const validatorToolNames = [
            "add_memory",
            "PickNextWaifu",
            "orchestrator_decision",
            "dream_memories",
            "set_persona_digest"
          ];
          const { result, quoteExtraction, chunks, attemptsRun, blockedViolations } = await generateValidatedWaifuReply({
            generate: async (retryUserMessage) => {
              incrementActive(this.activeWaifuQueries, waifuQueryKey);
              try {
                return await waifuPipeline.generateWaifu({
                  modelId: waifuModelId,
                  messages: waifuMessages,
                  systemPrompt,
                  midSystemBlock,
                  trailingSystemBlock,
                  retryUserMessage,
                  selfAuthorIds,
                  availableWaifuIds: nextWaifuIds,
                  pickNextWaifuToolEnabled: input.server.tools.pickNextWaifu,
                  shortTermMemoryToolEnabled: effectiveShortTermMemory,
                  params: waifu.params,
                  stopSequences: waifuStopSequences,
                  signal: input.signal
                });
              } finally {
                decrementActive(this.activeWaifuQueries, waifuQueryKey);
              }
            },
            displayName: waifu.displayName,
            contextMessages: waifuMessages,
            selfDisplayNames: allSelfDisplayNames,
            participantDisplayNames,
            selfAuthorIds,
            validator: {
              directive: validatorDirective,
              blockTags: validatorBlockTags,
              toolNames: validatorToolNames
            },
            logger: this.options.logger,
            logContext: { guildId: input.guildId, channelId: input.channelId, waifuId: waifu.id }
          });
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
            await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
              status: "sent"
            });
            currentOutcomeFinalized = true;
          }
          // Empty or blocked output is NOT an executed turn (tool-only memory turns are; they
          // have their own add_memory suppression against silent loops).
          responderLanded = sentMessageIds.length > 0 || (usedToolWithoutVisibleMessage && !blockedViolations);
          if (result.shortTermMemoryEntries?.length && effectiveShortTermMemory) {
            await recordWaifuNotes(this.options.storage, {
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
            if (blockedViolations) {
              // The model's text was rejected by the validator. Record "blocked" even when a tool
              // was also called: the leak channel is the visible reply, not the tool call, but the
              // text was the thing that was refused, so "blocked" takes precedence over "tool_only".
              await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
                status: "blocked",
                reason: blockedViolations.map((entry) => entry.check).join(", ")
              });
            } else {
              await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
                status: usedToolWithoutVisibleMessage ? "tool_only" : "empty",
                reason: usedToolWithoutVisibleMessage ? undefined : "empty_after_cleaning"
              });
            }
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
              await moveOrchestratorResponderOutcomeAfter(
                this.options.storage,
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
              await insertOrchestratorResponderOutcomeAfter(
                this.options.storage,
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
        attemptedCount += 1;
        if (responderLanded) executedCount += 1;
        currentOutcomeId = undefined;
        currentOutcomeFinalized = false;
      }
      await updateOrchestratorDecisionStatus(this.options.storage, input.decisionId, "completed");
      decisionFinalized = true;
    } catch (error) {
      if (!decisionFinalized) {
        const status: OrchestratorDecisionStatus = input.signal.aborted ? "interrupted" : "failed";
        // For interruptions record the ABORT reason (it decides restart resumability), not
        // whatever error the cancelled provider/Discord call happened to surface.
        const abortReason: unknown = input.signal.aborted ? input.signal.reason : undefined;
        const reason =
          abortReason instanceof Error
            ? abortReason.message
            : error instanceof Error
              ? error.message
              : String(error);
        try {
          await finalizeOrchestratorDecisionAfterError(this.options.storage, {
            decisionId: input.decisionId,
            status,
            currentOutcomeId: currentOutcomeFinalized ? undefined : currentOutcomeId,
            reason
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
    return { attemptedCount, executedCount };
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
        let sentResult;
        try {
          sentResult = await this.options.discord.sendWaifuMessage({
            guildId: input.guildId,
            channelId: input.channelId,
            senderBotId: input.senderBotId,
            content: input.chunks[i],
            replyToMessageId: i === 0 ? input.replyToMessageId : undefined,
            allowedUserMentionIds: input.allowedUserMentionIds
          });
        } catch (error) {
          this.permissionWarnings.record(input.guildId, input.channelId, input.waifuId, error);
          throw error;
        }
        this.permissionWarnings.resolve(input.guildId, input.channelId);
        this.rememberSelfSent(sentResult.messageId);
        messageIds.push(sentResult.messageId);
        if (input.orchestratorDecisionId) {
          await recordOrchestratorDecisionWaifuMessage(
            this.options.storage,
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

  private rememberSelfSent(messageId: string): void {
    this.recentSelfSentIds.set(messageId, Date.now() + ResponderExecutor.SELF_SENT_TTL_MS);
    if (this.recentSelfSentIds.size > 200) {
      const now = Date.now();
      for (const [id, expiresAt] of this.recentSelfSentIds) {
        if (expiresAt <= now) this.recentSelfSentIds.delete(id);
      }
    }
  }

  wasSelfSent(messageId: string): boolean {
    const expiresAt = this.recentSelfSentIds.get(messageId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.recentSelfSentIds.delete(messageId);
      return false;
    }
    return true;
  }
}

export type WaifuReplyAttemptInput = {
  /** One model call; retryUserMessage is set only on the corrective second attempt. */
  generate(retryUserMessage: string | undefined): Promise<WaifuGenerationResult>;
  displayName: string;
  contextMessages: ContextMessage[];
  /** Every self alias (display name, configured name, guild nickname, names on own messages). */
  selfDisplayNames: string[];
  participantDisplayNames: string[];
  selfAuthorIds: string[];
  validator: Pick<ValidationContext, "directive" | "blockTags" | "toolNames">;
  logger: Logger;
  /** Leading fields of every log entry (guildId, channelId, waifuId). */
  logContext: Record<string, unknown>;
};

export type WaifuReplyAttemptResult = {
  /** The last raw generation (tool calls included). */
  result: WaifuGenerationResult;
  quoteExtraction: ReplyQuoteExtraction;
  /** Chunks to send; empty when the reply was blocked or cleaned away. */
  chunks: string[];
  attemptsRun: number;
  /** Set when the validator rejected the reply with no usable retry left. */
  blockedViolations: Violation[] | undefined;
};

/**
 * The generate -> clean -> validate -> retry loop for one waifu turn: strips leaked context
 * headers and impersonation, extracts a leading reply quote, splits into chunks, runs the
 * deterministic output validator, and regenerates at most once (validator retry, or a reply that
 * was entirely removed during cleaning).
 */
export async function generateValidatedWaifuReply(input: WaifuReplyAttemptInput): Promise<WaifuReplyAttemptResult> {
  const {
    displayName,
    contextMessages: waifuMessages,
    selfDisplayNames: allSelfDisplayNames,
    participantDisplayNames,
    selfAuthorIds
  } = input;
  const MAX_GENERATE_ATTEMPTS = 2;
  let result: WaifuGenerationResult = { content: "" };
  let strippedContent = "";
  let quoteExtraction: ReplyQuoteExtraction = {
    replyToMessageId: undefined,
    cleanedContent: ""
  };
  let chunks: string[] = [];
  let attemptsRun = 0;
  // Corrective message fed to the next attempt. The cleaning-empty path keeps the bare
  // `${displayName}:` nudge; the validator's retry path overwrites it to name the violations.
  let retryUserMessage = `${displayName}:`;
  // Set when the reply is rejected with no usable retry left (validator block, or a retry
  // that survives the final attempt). When set, chunks are forced empty and nothing is sent.
  let blockedViolations: Violation[] | undefined;
  for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
    attemptsRun = attempt;
    result = await input.generate(attempt === 2 ? retryUserMessage : undefined);
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
      input.logger.warn("Stripped leaked context header from waifu reply", {
        ...input.logContext,
        attempt,
        before: result.content.slice(0, 80),
        after: strippedContent.slice(0, 80)
      });
    }
    if (replyQuoteExtracted) {
      input.logger.info("Extracted leading reply quote from waifu reply", {
        ...input.logContext,
        attempt,
        matchedMessageId: quoteExtraction.replyToMessageId ?? null,
        quotePreview: metadataStrippedContent.slice(0, 120)
      });
    }
    chunks = splitWaifuReply(strippedContent);
    // Deterministic leak validator on the finalized candidate, before it can be sent. Its
    // only powers are send-as-is (pass), regenerate once (retry on attempt 1), or send
    // nothing (block, or a retry that survives the final attempt). It never truncates.
    const validation = validateWaifuOutput(strippedContent, {
      selfNames: allSelfDisplayNames,
      participantNames: participantDisplayNames,
      directive: input.validator.directive,
      blockTags: input.validator.blockTags,
      toolNames: input.validator.toolNames,
      recentSelfMessages: waifuMessages
        .filter((message) => message.authorKind === "waifu" && selfAuthorIds.includes(message.authorId))
        .slice(-5)
        .map((message) => message.content)
    });
    if (validation.verdict !== "pass") {
      const checks = validation.violations.map((entry) => entry.check).join(", ");
      if (validation.verdict === "retry" && attempt < MAX_GENERATE_ATTEMPTS) {
        input.logger.warn("Output validator rejected waifu reply; regenerating once", {
          ...input.logContext,
          attempt,
          violations: checks
        });
        retryUserMessage = correctiveRetryMessage(displayName, validation.violations);
        continue;
      }
      const softOnly =
        validation.verdict === "retry" &&
        validation.violations.every((entry) => SOFT_VALIDATOR_CHECKS.has(entry.check));
      if (softOnly) {
        // Soft checks never withhold content: the retry already had its shot, send as-is.
        input.logger.info("Soft validator violations survived retry; sending anyway", {
          ...input.logContext,
          violations: checks
        });
      } else {
        // Final-attempt retry, or a block on any attempt: send nothing.
        input.logger.warn("Output validator blocked waifu reply; nothing sent", {
          ...input.logContext,
          attempt,
          verdict: validation.verdict,
          violations: checks
        });
        blockedViolations = validation.violations;
        chunks = [];
        break;
      }
    }
    const becameEmptyDueToCleaning =
      chunks.length === 0 &&
      result.content.trim().length > 0 &&
      (metadataStripped || replyQuoteExtracted || impersonationStripped);
    if (!becameEmptyDueToCleaning || attempt === MAX_GENERATE_ATTEMPTS) break;
    input.logger.warn("Waifu reply was entirely removed during cleaning; retrying once", {
      ...input.logContext,
      metadataStripped,
      replyQuoteExtracted,
      impersonationStripped,
      originalPreview: result.content.slice(0, 120)
    });
  }
  return { result, quoteExtraction, chunks, attemptsRun, blockedViolations };
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

const TYPING_REFRESH_MS = 8000;

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
