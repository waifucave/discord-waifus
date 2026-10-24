// Executes an orchestrator decision's responders: per-waifu availability checks, delays, the
// context-engine prompt (ContextRuntime.prepare/call/commit with the waifu harness), the generate
// -> clean -> validate -> retry loop, chunked sending, tool handling (add_memory notes,
// PickNextWaifu handoffs, `tool` context notes) and responder-outcome bookkeeping.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { Logger } from "../backend/logger.js";
import { DiscordGatewayFacade } from "../discord/client.js";
import { loadGuildDirectoryView } from "../discord/directoryView.js";
import { dedupeNames, modelVisibleEmojiToken, stripLeakedContextHeader } from "../discord/normalization.js";
import type { ModelPipeline, WaifuGenerationResult } from "../providers/types.js";
import { PermissionWarningTracker, classifyDiscordSendError } from "./permissionWarnings.js";
import {
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  OrchestratorDecisionStatus,
  OrchestratorResponderOutcome,
  OrchestratorRespondingWaifu,
  ServerConfig,
  WaifuConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import type { LedgerEntry } from "../shared/schemas/context.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { contextSummarizer } from "./context/compaction.js";
import { conversationKey, type ConversationKey, type ConversationRef } from "./context/keys.js";
import { isGapEntry } from "./context/ledger.js";
import { parseReplyMarker, stripLeadingTranscriptHeader, type ParsedReplyMarker } from "./context/replyMarker.js";
import type { BuiltPrompt, NewContextNote, PreparedContext } from "./context/types.js";
import { resolveContextCap } from "./contextWindows.js";
import type { OrchestratorDecision } from "./decisions.js";
import { ModelAccess } from "./modelAccess.js";
import { directiveTextForWaifu } from "./promptBuilders.js";
import { type RuntimeContextServices, decrementActive, incrementActive, runKey, throwIfAborted, timerKey } from "./runtimeShared.js";
import { readDiscordBotsFile, readWaifu } from "./stores/config.js";
import { channelPlaceName, observeThread } from "./stores/threads.js";
import {
  finalizeOrchestratorDecisionAfterError,
  insertOrchestratorResponderOutcomeAfter,
  moveOrchestratorResponderOutcomeAfter,
  recordOrchestratorDecisionWaifuMessage,
  updateOrchestratorDecisionStatus,
  updateOrchestratorResponderOutcome
} from "./stores/decisionHistory.js";
import { NOTE_MAX_PER_REPLY, recordWaifuNotes } from "./stores/memories.js";
import type { GateDecision } from "./memoryWriteGate.js";
import { readActiveChatParticipants } from "./stores/participants.js";
import { setActivePipeline } from "./stores/sessions.js";
import { PICK_NEXT_WAIFU_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_NAME } from "./tools.js";
import { GatewayPipelineError } from "./pipeline/params.js";
import {
  CUT_OFF_RETRY_NOTE,
  type ValidationContext,
  type VerbosityProfile,
  type Violation,
  cutToCompleteSentence,
  retryNote,
  splitWaifuReply,
  typingDelayMs,
  validateWaifuOutput,
  verbosityProfile
} from "./verbosity.js";
import { WAIFU_HARNESS_TAGS, createWaifuHarness, waifuTools, type WaifuHarness, type WaifuPerson } from "./waifuHarness.js";

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
  // The exact prompt (BuiltPrompt.debug) of each waifu's most recent generation per conversation,
  // keyed by waifuPromptCaptureKey(conversationKey, waifuId), for /print system_prompt.
  readonly lastSentWaifuPrompts = new Map<
    string,
    { debug: BuiltPrompt["debug"]; at: string; channelId: string; conversationKey: string }
  >();
  private readonly recentSelfSentIds = new Map<string, number>();
  readonly activeWaifuSendChannels = new Set<string>();
  readonly activeWaifuQueries = new Map<string, number>();
  // One-shot: when a waifu in this channel just emitted a tool-only reply (add_memory call with no
  // Discord text), the next decision IGNORES add_memory calls (tool result "ignored") so the chain
  // doesn't loop on silent memory-tool turns. The tool stays listed (breakpoint A is stable).
  private readonly suppressMemoryToolOnce = new Set<string>();
  // Per channel: when a waifu message was last sent (spec 9.5: a deleted trigger only aborts a run
  // that has not sent anything yet).
  private readonly lastSendAt = new Map<string, number>();
  private static readonly SELF_SENT_TTL_MS = 60_000;

  constructor(
    private readonly options: RuntimeContextServices,
    private readonly models: ModelAccess,
    private readonly permissionWarnings: PermissionWarningTracker,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    private readonly maxAutomaticTurns: number
  ) {}

  /**
   * Spec 9.5: a classified Discord send failure (archived thread, AutoMod) becomes the responder
   * outcome. One call site for the history update so a change to its signature (per-guild history)
   * touches only this method.
   */
  private async recordSendFailureOutcome(
    input: ExecuteResponderDecisionInput,
    outcomeId: string,
    failure: NonNullable<ReturnType<typeof classifyDiscordSendError>>
  ): Promise<void> {
    await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
      status: failure.status,
      reason: failure.reason
    });
  }

  /** True while a waifu message is being sent in the channel, or one was sent at/after `sinceMs`. */
  hasSentSince(channelId: string, sinceMs: number): boolean {
    return this.activeWaifuSendChannels.has(channelId) || (this.lastSendAt.get(channelId) ?? 0) >= sinceMs;
  }

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
        const waifuPipeline = this.models.pipelineFor(
          { providerId: waifu.providerId, modelId: waifuModelId },
          "waifu"
        );
        const directionText = directiveTextForWaifu(responder.directive);
        const turn = await this.prepareWaifuTurn({
          guildId: input.guildId,
          channelId: input.channelId,
          server: input.server,
          waifu: { ...waifu, botId: waifu.botId, modelId: waifuModelId },
          availableWaifus: input.availableWaifus,
          directiveText: directionText,
          pipeline: waifuPipeline,
          signal: input.signal
        });
        const { prepared, harness } = turn;
        this.lastSentWaifuPrompts.set(waifuPromptCaptureKey(prepared.key, waifu.id), {
          debug: prepared.prompt.debug,
          at: new Date().toISOString(),
          channelId: input.channelId,
          conversationKey: prepared.key
        });
        this.options.logger.info("Generating waifu reply", {
          guildId: input.guildId,
          channelId: input.channelId,
          waifuId: waifu.id,
          modelId: waifu.modelId,
          transcriptCount: prepared.prompt.transcriptCount
        });
        const waifuTyping = startTypingScope(this.options.discord, {
          guildId: input.guildId,
          channelId: input.channelId,
          senderBotId: waifu.botId
        });
        // The prompt actually sent by the latest call that returned, with its usage: commit
        // calibrates against it (a retry differs from prepared.prompt in its tail).
        let lastCall: { prompt: BuiltPrompt; result: WaifuGenerationResult } | undefined;
        let committed = false;
        try {
          const waifuQueryKey = runKey(input.guildId);
          const profile = verbosityProfile(waifu.verbosity);
          const validatorDirective =
            responder.directive && responder.directive.intent !== "manual"
              ? { intent: responder.directive.intent, goal: responder.directive.goal ?? "" }
              : undefined;
          const { result, marker, chunks, attemptsRun, blockedViolations } = await generateValidatedWaifuReply({
            generate: async (retry) => {
              incrementActive(this.activeWaifuQueries, waifuQueryKey);
              try {
                return await this.options.contexts.call(prepared, async (prompt) => {
                  const sent = retry
                    ? promptWithTail(prompt, harness.tail(prepared.state, prepared.startedAt, { retryNote: retry }))
                    : prompt;
                  if (retry) {
                    this.lastSentWaifuPrompts.set(waifuPromptCaptureKey(prepared.key, waifu.id), {
                      debug: sent.debug,
                      at: new Date().toISOString(),
                      channelId: input.channelId,
                      conversationKey: prepared.key
                    });
                  }
                  const generated = await waifuPipeline.generateWaifu({
                    modelId: waifuModelId,
                    prompt: sent,
                    transcript: prepared.transcript,
                    availableWaifuIds: turn.pickNextWaifuIds,
                    params: waifu.params,
                    stopSequences: waifuStopSequences(waifu, turn.serverNickname),
                    attribution: {
                      purpose: retry ? "waifu_retry" : "waifu_reply",
                      agentId: `waifu-${waifu.id}`,
                      waifuId: waifu.id,
                      guildId: input.guildId,
                      channelId: input.channelId,
                      conversationKey: prepared.key
                    },
                    signal: input.signal
                  });
                  lastCall = { prompt: sent, result: generated };
                  return generated;
                });
              } finally {
                decrementActive(this.activeWaifuQueries, waifuQueryKey);
              }
            },
            refToMessageId: prepared.prompt.refToMessageId,
            selfDisplayNames: turn.selfDisplayNames,
            participantDisplayNames: turn.participantDisplayNames,
            profile,
            validator: {
              directive: validatorDirective,
              blockTags: [...WAIFU_HARNESS_TAGS],
              toolNames: WAIFU_VALIDATOR_TOOL_NAMES,
              recentSelfMessages: prepared.transcript
                .filter((entry) => turn.selfAuthorIds.includes(entry.authorId))
                .slice(-5)
                .map((entry) => entry.body)
            },
            logger: this.options.logger,
            logContext: { guildId: input.guildId, channelId: input.channelId, waifuId: waifu.id }
          });
          // add_memory runs only when listed for this conversation and not suppressed; otherwise
          // the call is answered "ignored" (spec 8.5: the tool stays listed).
          const memoryToolListed = harness.tools().some((tool) => tool.name === SHORT_TERM_MEMORY_TOOL_NAME);
          const memorySuppressed = suppressMemoryToolThisDecision || !memoryToolListed;
          const memoryCalls = planMemoryCalls(result, memorySuppressed);
          if (suppressMemoryToolThisDecision && (result.shortTermMemoryEntries?.length || memoryCalls.length)) {
            this.options.logger.info("Ignoring add_memory call (suppressed after a tool-only turn)", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id
            });
          }
          const memoryEntries = memoryCalls.flatMap((call) => (call.entry !== undefined ? [call.entry] : []));
          const usedToolWithoutVisibleMessage = memoryEntries.length > 0 || Boolean(result.pickedNextWaifuId);
          if (chunks.length === 0 && !usedToolWithoutVisibleMessage) {
            this.options.logger.warn("Waifu reply was empty after cleaning; nothing sent", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              attempts: attemptsRun,
              lastOriginalPreview: result.content.slice(0, 120)
            });
          }
          if (marker.unknownRef || marker.strippedTarget) {
            this.options.logger.info("Waifu reply marker did not name a known ref; sending unthreaded", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              ref: marker.unknownRef ?? marker.strippedTarget
            });
          }
          // The waifu owns her reply target (↩#ref). Without a marker the triggering message is
          // used only when it is not the latest one (today's default); a marker that did not
          // resolve (unknown ref, a copied ↩you/↩Name) sends unthreaded.
          const replyToMessageId = marker.replyToMessageId
            ? marker.replyToMessageId
            : marker.unknownRef || marker.strippedTarget
              ? undefined
              : replyTargetForTranscript(responder.replyToMessageId, prepared.transcript);
          let sentMessageIds: string[] = [];
          let sendFailure: ReturnType<typeof classifyDiscordSendError>;
          try {
            sentMessageIds = await this.sendWaifuChunks({
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              senderBotId: waifu.botId,
              chunks,
              replyToMessageId,
              allowedUserMentionIds: [...new Set(prepared.transcript.map((entry) => entry.authorId))],
              orchestratorDecisionId: input.decisionId,
              responderOutcomeId: outcomeId,
              signal: input.signal,
              ...(input.channel.thread ? { thread: true } : {})
            });
          } catch (sendError) {
            // Spec 9.5: an archived thread (50083) or an AutoMod block (200000/200001) is the
            // reply's final answer, not a crash of the whole decision.
            sendFailure = input.signal.aborted ? undefined : classifyDiscordSendError(sendError);
            if (!sendFailure) throw sendError;
            this.options.logger.warn("Waifu reply could not be delivered", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              status: sendFailure.status,
              reason: sendFailure.reason
            });
            if (sendFailure.reason === "thread_archived" && input.channel.thread) {
              // Silence the thread until Discord reports it unarchived.
              await observeThread(this.options.storage, input.guildId, {
                threadId: input.channelId,
                parentId: input.channel.thread.parentId,
                archived: true
              }).catch(() => undefined);
            }
          }
          if (sentMessageIds.length > 0) {
            await updateOrchestratorResponderOutcome(this.options.storage, input.decisionId, outcomeId, {
              status: "sent"
            });
            currentOutcomeFinalized = true;
          }
          // Empty or blocked output is NOT an executed turn (tool-only memory turns are; they
          // have their own add_memory suppression against silent loops).
          responderLanded = sentMessageIds.length > 0 || (usedToolWithoutVisibleMessage && !blockedViolations);
          if (memoryEntries.length > 0) {
            const decisions = await recordWaifuNotes(this.options.storage, {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              entries: memoryEntries
            });
            applyMemoryDecisions(memoryCalls, decisions);
            if (chunks.length === 0) {
              this.suppressMemoryToolOnce.add(channelKey);
              this.options.logger.info("Waifu tool-only reply detected; ignoring add_memory on the next decision", {
                guildId: input.guildId,
                channelId: input.channelId,
                waifuId: waifu.id
              });
            }
          }
          if (sentMessageIds.length === 0) {
            if (sendFailure) {
              await this.recordSendFailureOutcome(input, outcomeId, sendFailure);
            } else if (blockedViolations) {
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
          let handoff: "accepted" | "limit" | undefined;
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
            handoff = "accepted";
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
            handoff = "limit";
            this.options.logger.warn("Ignoring PickNextWaifu handoff because the automatic handoff limit was reached", {
              guildId: input.guildId,
              channelId: input.channelId,
              waifuId: waifu.id,
              pickedNextWaifuId: result.pickedNextWaifuId,
              maxAutomaticTurns: this.maxAutomaticTurns
            });
          }
          // One write: this turn's direction (only when her turn landed — a direction whose
          // reply never reached the room is not history) and her tool calls with their outcomes.
          const pickedName = result.pickedNextWaifuId
            ? input.availableWaifus.find((candidate) => candidate.id === result.pickedNextWaifuId)?.displayName ??
              result.pickedNextWaifuId
            : undefined;
          const notes: NewContextNote[] = [
            ...(responderLanded && directionText ? [{ kind: "direction" as const, text: directionText }] : []),
            ...toolNotes(result, memoryCalls, { handoff, pickedName })
          ];
          committed = true;
          await this.commitWaifuTurn(prepared, { notes, call: lastCall });
        } catch (error) {
          // Failure / abort: keep calibration, breakpoint and the background check, but never a
          // direction or reply that was not sent.
          if (!committed) await this.commitWaifuTurn(prepared, { notes: [], call: lastCall });
          throw error;
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

  /**
   * Builds her harness for this conversation and prepares the cache-stable context (spec 8.5).
   * This turn's orchestrator directive rides in the tail of the call it steers; it becomes a
   * `direction` note only when the turn is committed (commitWaifuTurn).
   */
  private async prepareWaifuTurn(input: {
    guildId: string;
    channelId: string;
    server: ServerConfig;
    waifu: WaifuConfig & { botId: string; modelId: string };
    availableWaifus: WaifuConfig[];
    directiveText: string | undefined;
    pipeline: ModelPipeline;
    signal: AbortSignal;
  }): Promise<PreparedWaifuTurn> {
    const { waifu, server } = input;
    const built = await this.buildWaifuHarness({ ...input, ...(input.directiveText ? { direction: input.directiveText } : {}) });
    const { harness, conversation, model, selfAuthorIds, serverNickname, roster, people, pickNextWaifuIds, waifuByAuthorId } = built;
    const directory = await loadGuildDirectoryView(this.options.storage, input.guildId, {
      channelName: (id) => server.channels[id]?.name
    });
    // Same tool choice / params / attribution as her reply call, so compaction reuses the cached
    // prefix (spec 8.9). Without a summarizer nothing compacts.
    const summarize = input.pipeline.summarizeContext
      ? contextSummarizer(input.pipeline, {
          toolChoice: "auto",
          params: waifu.params,
          attribution: {
            agentId: `waifu-${waifu.id}`,
            waifuId: waifu.id,
            guildId: input.guildId,
            channelId: input.channelId,
            conversationKey: conversationKey(conversation)
          }
        })
      : undefined;
    const prepared = await this.options.contexts.prepare({
      conversation,
      agent: { kind: "waifu", waifuId: waifu.id },
      model,
      backfillCap: resolveContextCap("waifu", server, waifu),
      selfAuthorIds,
      render: harness,
      // Tool notes render as user-role text lines: an assistant tool_use without the provider's
      // thinking block is rejected by Claude with thinking on (spec 8.5, T3 review C1).
      renderToolTurnsAsText: true,
      participantIds: people.flatMap((person) => (person.userId ? [person.userId] : [])),
      signal: input.signal,
      params: waifu.params,
      server,
      directory,
      ...(summarize ? { summarize } : {}),
      waifuIdForAuthor: (authorId) => waifuByAuthorId.get(authorId),
      memoryLimit: server.memoryInjectionLimit
    });
    const transcriptNames = prepared.transcript.map((entry) => entry.authorName);
    const selfDisplayNames = dedupeNames([
      waifu.displayName,
      waifu.name,
      serverNickname,
      ...prepared.transcript.filter((entry) => selfAuthorIds.includes(entry.authorId)).map((entry) => entry.authorName)
    ]);
    const participantDisplayNames = dedupeNames([
      ...selfDisplayNames,
      ...input.availableWaifus.map((candidate) => candidate.displayName),
      ...roster,
      ...people.map((person) => person.name),
      ...transcriptNames
    ]);
    return { prepared, harness, selfAuthorIds, selfDisplayNames, participantDisplayNames, pickNextWaifuIds, serverNickname };
  }

  /** Her static system prompt for this channel, as her next reply would send it (/print fallback). */
  async renderWaifuSystemPrompt(input: {
    guildId: string;
    channelId: string;
    server: ServerConfig;
    waifu: WaifuConfig & { modelId: string };
    availableWaifus: WaifuConfig[];
  }): Promise<string> {
    return (await this.buildWaifuHarness(input)).harness.system();
  }

  private async buildWaifuHarness(input: {
    guildId: string;
    channelId: string;
    server: ServerConfig;
    waifu: WaifuConfig & { modelId: string };
    availableWaifus: WaifuConfig[];
    direction?: string;
  }) {
    const { waifu, server } = input;
    const conversation: ConversationRef = { kind: "guild", guildId: input.guildId, channelId: input.channelId };
    const [bots, members, emojis, participants] = await Promise.all([
      readDiscordBotsFile(this.options.storage),
      this.options.storage.readJson(
        path.join("user", "servers", input.guildId, "members.json"),
        GuildMembersFileSchema,
        GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId: input.guildId, members: [] }))
      ),
      this.options.storage.readJson(
        path.join("user", "servers", input.guildId, "emojis.json"),
        GuildEmojisFileSchema,
        GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId: input.guildId, emojis: [] }))
      ),
      readActiveChatParticipants(this.options.storage, input.guildId, input.channelId)
    ]);
    // waifu.botId is the discord-bots ENTRY id; transcript authorIds carry the bot user
    // snowflake. Resolve both, or the waifu never recognizes her own prior messages.
    const selfAuthorIds = resolveBotAuthorIds(waifu.botId, bots);
    const guildNameByUserId = new Map(
      members.members
        .filter((member) => member.guildDisplayName)
        .map((member) => [member.userId, member.guildDisplayName as string])
    );
    const guildNameFor = (botIdRef: string | undefined) =>
      resolveBotAuthorIds(botIdRef, bots)
        .map((id) => guildNameByUserId.get(id))
        .find(Boolean);
    const name = waifu.displayName || waifu.name || waifu.id;
    const nickname = guildNameFor(waifu.botId);
    const serverNickname = nickname && nickname !== name ? nickname : undefined;
    const others = input.availableWaifus.filter((candidate) => candidate.id !== waifu.id && candidate.botId);
    const roster = others.map((candidate) => {
      const configured = candidate.displayName || candidate.name;
      const guildName = guildNameFor(candidate.botId);
      return guildName && guildName !== configured ? `${guildName} (${configured})` : configured;
    });
    // Humans present; a participant named like a character is that character (roster/identity).
    const characterNames = new Set(
      [waifu.displayName, waifu.name, nickname, ...others.flatMap((candidate) => [candidate.displayName, candidate.name])]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim().toLowerCase())
    );
    const seenNames = new Set<string>();
    const people: WaifuPerson[] = participants
      .map((participant) => ({ userId: participant.userId, name: participant.displayName.trim() }))
      .filter((person) => {
        const key = person.name.toLowerCase();
        if (!person.name || characterNames.has(key) || seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const model = this.models.resolvedModel({ providerId: waifu.providerId, modelId: waifu.modelId });
    if (!model) throw new GatewayPipelineError(`Unknown model ${waifu.providerId ?? "?"}:${waifu.modelId}`);
    const toolsUsable = waifu.tools.toolUse && model.features.tools.supported;
    const pickNextWaifuIds =
      toolsUsable && server.tools.pickNextWaifu
        ? others.filter((candidate) => candidate.modelId).map((candidate) => candidate.id)
        : [];
    const harness = createWaifuHarness({
      waifu,
      conversation,
      roster,
      ...(serverNickname ? { serverNickname } : {}),
      place: {
        kind: "guild",
        ...(server.name ? { serverName: server.name } : {}),
        ...(channelPlaceName(server, input.channelId) ? { channelName: channelPlaceName(server, input.channelId)! } : {})
      },
      people,
      emojis: emojis.emojis.filter((emoji) => emoji.available).map(modelVisibleEmojiToken),
      tools: waifuTools({ addMemory: toolsUsable && server.tools.shortTermMemory, pickNextWaifuIds }),
      ...(input.direction ? { direction: input.direction } : {})
    });
    const waifuByAuthorId = new Map<string, string>();
    for (const candidate of input.availableWaifus) {
      for (const id of resolveBotAuthorIds(candidate.botId, bots)) waifuByAuthorId.set(id, candidate.id);
    }
    return { harness, conversation, model, selfAuthorIds, serverNickname, roster, people, pickNextWaifuIds, waifuByAuthorId };
  }

  /**
   * Commits the turn (spec 8.5/8.9): stores the request's breakpoint, calibrates against the
   * prompt actually sent with its usage, and appends this turn's notes in one write. Failure and
   * abort paths commit too, with no notes.
   */
  private async commitWaifuTurn(
    prepared: PreparedContext,
    o: { notes: NewContextNote[]; call: { prompt: BuiltPrompt; result: WaifuGenerationResult } | undefined }
  ): Promise<void> {
    try {
      await this.options.contexts.commit(prepared, {
        notes: o.notes,
        ...(o.call?.result.usage ? { usage: o.call.result.usage } : {}),
        ...(o.call ? { sentPrompt: o.call.prompt } : {}),
        modelKey: prepared.modelKey
      });
    } catch (error) {
      this.options.logger.warn("Failed to commit waifu context", {
        conversationKey: prepared.key,
        message: error instanceof Error ? error.message : String(error)
      });
    }
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
    /** The channel is a thread: permission warnings mention Send Messages in Threads. */
    thread?: boolean;
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
          this.permissionWarnings.record(input.guildId, input.channelId, input.waifuId, error, {
            ...(input.thread ? { thread: true } : {})
          });
          throw error;
        }
        this.permissionWarnings.resolve(input.guildId, input.channelId);
        this.lastSendAt.set(input.channelId, Date.now());
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

type PreparedWaifuTurn = {
  prepared: PreparedContext;
  harness: WaifuHarness;
  selfAuthorIds: string[];
  selfDisplayNames: string[];
  participantDisplayNames: string[];
  pickNextWaifuIds: string[];
  serverNickname: string | undefined;
};

/** Tool names the validator flags when they leak into visible text. */
const WAIFU_VALIDATOR_TOOL_NAMES = [
  SHORT_TERM_MEMORY_TOOL_NAME,
  PICK_NEXT_WAIFU_TOOL_NAME,
  "orchestrator_decision",
  "dream_memories",
  "set_persona_digest"
];

/** `/print system_prompt` capture key: conversation + waifu (spec 8.8). */
export function waifuPromptCaptureKey(key: ConversationKey | string, waifuId: string): string {
  return `${key}|${waifuId}`;
}

/** Spec 8.5: the header guard plus her own name (and her server nickname when it differs). */
export function waifuStopSequences(waifu: Pick<WaifuConfig, "displayName" | "name">, serverNickname?: string): string[] {
  const name = waifu.displayName || waifu.name;
  return ["\n[", `\n${name}:`, ...(serverNickname && serverNickname !== name ? [`\n${serverNickname}:`] : [])];
}

/** Replace the prompt's ephemeral tail block (a retry note is tail-only: never cached, never stored). */
export function promptWithTail(prompt: BuiltPrompt, tail: string): BuiltPrompt {
  const messages = prompt.messages.slice();
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    const blocks = last.content.slice();
    const final = blocks[blocks.length - 1];
    if (final && final.type === "text" && final.text === prompt.debug.tail) {
      blocks[blocks.length - 1] = { type: "text", text: tail };
      messages[messages.length - 1] = { ...last, content: blocks };
      return { ...prompt, messages, debug: { ...prompt.debug, tail } };
    }
  }
  messages.push({ role: "user", content: [{ type: "text", text: tail }] });
  return { ...prompt, messages, debug: { ...prompt.debug, tail } };
}

/** One add_memory call of her reply and what happened to it (its tool note result). */
export type MemoryCall = { callId?: string; entry?: string; outcome: string };

/**
 * Plans her add_memory calls: suppressed/unlisted → `ignored`, unparsable or empty content →
 * `invalid arguments`, beyond the per-reply cap → `over limit`; the rest are recorded and get
 * `saved` / `duplicate — not saved` from the write gate (applyMemoryDecisions).
 */
export function planMemoryCalls(result: WaifuGenerationResult, suppressed: boolean): MemoryCall[] {
  const calls = (result.toolCalls ?? []).filter((call) => call.name === SHORT_TERM_MEMORY_TOOL_NAME);
  if (calls.length === 0) {
    // A result without call ids (fakes, older pipelines): entries only, no tool notes.
    if (suppressed) return [];
    return (result.shortTermMemoryEntries ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, NOTE_MAX_PER_REPLY)
      .map((entry) => ({ entry, outcome: "saved" }));
  }
  let valid = 0;
  return calls.map((call): MemoryCall => {
    if (suppressed) return { callId: call.id, outcome: "ignored" };
    let content: unknown;
    try {
      content = (JSON.parse(call.arguments) as { content?: unknown } | null)?.content;
    } catch {
      content = undefined;
    }
    if (typeof content !== "string" || !content.trim()) return { callId: call.id, outcome: "invalid arguments" };
    valid += 1;
    if (valid > NOTE_MAX_PER_REPLY) return { callId: call.id, outcome: "over limit" };
    return { callId: call.id, entry: content.trim(), outcome: "saved" };
  });
}

/** Write-gate decisions (in entry order) → tool note results. */
export function applyMemoryDecisions(calls: MemoryCall[], decisions: GateDecision[]): void {
  let index = 0;
  for (const call of calls) {
    if (call.entry === undefined) continue;
    const decision = decisions[index];
    index += 1;
    call.outcome = !decision || decision.action === "insert" ? "saved" : "duplicate — not saved";
  }
}

export function toolNotes(
  result: WaifuGenerationResult,
  memoryCalls: MemoryCall[],
  o: { handoff: "accepted" | "limit" | undefined; pickedName: string | undefined }
): NewContextNote[] {
  return (result.toolCalls ?? []).map((call) => {
    let outcome = "ignored";
    if (call.name === SHORT_TERM_MEMORY_TOOL_NAME) {
      outcome = memoryCalls.find((planned) => planned.callId === call.id)?.outcome ?? "ignored";
    } else if (call.name === PICK_NEXT_WAIFU_TOOL_NAME) {
      if (result.rejectedPickNextWaifu) outcome = result.rejectedPickNextWaifu.reason === "malformed" ? "invalid arguments" : "ignored — not available";
      else if (o.handoff === "accepted" && o.pickedName) outcome = `handing over to ${o.pickedName}`;
      else if (o.handoff === "limit") outcome = "ignored — handoff limit reached";
    }
    return { kind: "tool" as const, callId: call.id, name: call.name, arguments: call.arguments, result: outcome };
  });
}

export type WaifuReplyAttemptInput = {
  /** One model call; `retryNote` is set only on the corrective second attempt (tail-only). */
  generate(retryNote: string | undefined): Promise<WaifuGenerationResult>;
  /** The prompt's ref table (↩#ref markers resolve against it). */
  refToMessageId: ReadonlyMap<string, string>;
  /** Every self alias (display name, configured name, guild nickname, names on own messages). */
  selfDisplayNames: string[];
  participantDisplayNames: string[];
  profile: VerbosityProfile;
  validator: Pick<ValidationContext, "directive" | "blockTags" | "toolNames" | "recentSelfMessages">;
  logger: Logger;
  /** Leading fields of every log entry (guildId, channelId, waifuId). */
  logContext: Record<string, unknown>;
};

export type WaifuReplyAttemptResult = {
  /** The last raw generation (tool calls included). */
  result: WaifuGenerationResult;
  marker: ParsedReplyMarker;
  /** Chunks to send; empty when the reply was blocked or cleaned away. */
  chunks: string[];
  attemptsRun: number;
  /** Set when the validator rejected the reply with no usable retry left. */
  blockedViolations: Violation[] | undefined;
};

const EMPTY_AFTER_CLEANING_NOTE =
  "Your last draft was rejected: nothing was left after removing names, headers and notes. Write only your own message.";

/**
 * One waifu turn (spec 8.5), at most two model calls. Processing order per attempt: I5 length
 * cut → strip leaked header → parse ↩#ref marker → strip impersonation → validate (pass / trim /
 * retry / block) → split. Retries carry a short user-role note in the ephemeral tail, never a
 * turn written as the waifu.
 */
export async function generateValidatedWaifuReply(input: WaifuReplyAttemptInput): Promise<WaifuReplyAttemptResult> {
  const MAX_GENERATE_ATTEMPTS = 2;
  const { selfDisplayNames, participantDisplayNames, profile } = input;
  let result: WaifuGenerationResult = { content: "" };
  let marker: ParsedReplyMarker = { content: "" };
  let chunks: string[] = [];
  let attemptsRun = 0;
  let note: string | undefined;
  let blockedViolations: Violation[] | undefined;
  for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
    attemptsRun = attempt;
    const finalAttempt = attempt === MAX_GENERATE_ATTEMPTS;
    result = await input.generate(attempt === 1 ? undefined : note);
    chunks = [];
    let raw = result.content;
    const hasToolCall = Boolean(result.toolCalls?.length || result.shortTermMemoryEntries?.length || result.pickedNextWaifuId);
    if (result.finishReason === "length") {
      // I5: keep the complete sentences of a reply cut off by the output limit.
      raw = cutToCompleteSentence(raw);
      input.logger.warn("Waifu reply hit the output limit; trimmed to complete sentences", {
        ...input.logContext,
        attempt,
        before: result.content.slice(0, 80),
        after: raw.slice(0, 80)
      });
      if (!raw && !hasToolCall) {
        if (finalAttempt) break;
        note = CUT_OFF_RETRY_NOTE;
        continue;
      }
    }
    // 1. strip a leaked transcript header (and a leading self-name prefix)
    const headerStripped = stripLeakedContextHeader(stripLeadingTranscriptHeader(raw), {
      selfDisplayNames,
      participantDisplayNames,
      stripImpersonation: false
    });
    // 2. the ↩#ref marker
    marker = parseReplyMarker(headerStripped, input.refToMessageId);
    // 3. impersonation lines
    const text = stripLeakedContextHeader(marker.content, { selfDisplayNames, participantDisplayNames });
    if (text !== raw.trim()) {
      input.logger.info("Cleaned waifu reply before validation", {
        ...input.logContext,
        attempt,
        before: raw.slice(0, 80),
        after: text.slice(0, 80),
        replyRef: marker.ref ?? marker.unknownRef ?? null
      });
    }
    if (!text) {
      if (raw.trim() && !finalAttempt) {
        input.logger.warn("Waifu reply was entirely removed during cleaning; retrying once", {
          ...input.logContext,
          originalPreview: raw.slice(0, 120)
        });
        note = EMPTY_AFTER_CLEANING_NOTE;
        continue;
      }
      break;
    }
    // 4. validate
    const validation = validateWaifuOutput(text, {
      ...input.validator,
      selfNames: selfDisplayNames,
      participantNames: participantDisplayNames,
      profile,
      finalAttempt
    });
    const checks = validation.violations.map((entry) => entry.check).join(", ");
    if (validation.verdict === "retry" && !finalAttempt) {
      input.logger.warn("Output validator rejected waifu reply; regenerating once", { ...input.logContext, attempt, violations: checks });
      note = retryNote(validation.violations, profile);
      continue;
    }
    if (validation.verdict === "retry" || validation.verdict === "block") {
      input.logger.warn("Output validator blocked waifu reply; nothing sent", {
        ...input.logContext,
        attempt,
        verdict: validation.verdict,
        violations: checks
      });
      blockedViolations = validation.violations;
      break;
    }
    let final = text;
    if (validation.verdict === "trim" && validation.trimmed !== undefined) {
      input.logger.info("Trimmed waifu reply to her verbosity limits", {
        ...input.logContext,
        attempt,
        violations: checks,
        before: text.length,
        after: validation.trimmed.length
      });
      final = validation.trimmed;
    }
    // 5. split
    chunks = splitWaifuReply(final, profile);
    break;
  }
  return { result, marker, chunks, attemptsRun, blockedViolations };
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

/** The triggering message as the default reply target, unless it is unknown or the latest entry. */
function replyTargetForTranscript(replyToMessageId: string | undefined, transcript: LedgerEntry[]): string | undefined {
  if (!replyToMessageId) return undefined;
  const messages = transcript.filter((entry) => !isGapEntry(entry));
  const latest = messages.at(-1);
  const target = messages.find((entry) => entry.id === replyToMessageId);
  if (!target || target === latest) return undefined;
  return replyToMessageId;
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
