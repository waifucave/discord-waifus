// The DM run loop (spec 9.1): one 1:1 conversation per (waifu, Discord user), no orchestrator.
//
// Per conversation there is one slot `{ phase: idle | generating | sending, rerunRequested }`:
// 1. Inbound: record `lastInbound*`; a run still generating is aborted (`superseded`), a run that is
//    sending finishes and reruns once; the debounce (`discord.debounce.dmMs` / `dmMaxWaitMs`) re-arms.
// 2. Fire: a global semaphore slot (`discord.dm.maxConcurrentRuns`), eligibility re-check, the
//    undeliverable stop, the per-user rate-limit gate (no model call when limited; at most one
//    fixed-template notice per limited period), then `pending*` is written.
// 3. The same waifu harness, model, global memories and compaction as servers (ContextRuntime
//    prepare/call/commit), `PickNextWaifu` never listed, `add_memory` iff `tools.toolUse`.
// 4. Commit: context, one rate-limit timestamp when ≥ 1 chunk was sent, `lastReplied*`, a run
//    record, the DM observer.
// Restart/pause (9.1.2): shutdown keeps (and flushes debounced) `pending*`; pause clears them; boot
// and resume scan recent DM states and catch up inside `discord.dm.resumeWindowMinutes`.

import { randomUUID } from "node:crypto";
import type { Logger } from "../../backend/logger.js";
import type { DiscordDirectMessageEvent, DiscordGatewayFacade } from "../../discord/client.js";
import type { ConversationMessageCache } from "../../discord/conversationCache.js";
import { dedupeNames } from "../../discord/normalization.js";
import type { WaifuGenerationResult } from "../../providers/types.js";
import { resolveBotAuthorIds } from "../../shared/botIdentity.js";
import type { DmRunRecord, DmState } from "../../shared/schemas/dm.js";
import type { WaifuConfig } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";
import { contextSummarizer } from "../context/compaction.js";
import { conversationKey, type ConversationKey, type ConversationRef } from "../context/keys.js";
import type { ContextRuntime } from "../context/runtime.js";
import type { BuiltPrompt, NewContextNote, PreparedContext } from "../context/types.js";
import { resolveContextCap } from "../contextWindows.js";
import { KeyedDebouncer } from "../debounce.js";
import type { ModelAccess } from "../modelAccess.js";
import { GatewayPipelineError } from "../pipeline/params.js";
import {
  applyMemoryDecisions,
  generateValidatedWaifuReply,
  planMemoryCalls,
  promptWithTail,
  toolNotes,
  waifuStopSequences
} from "../responderExecutor.js";
import { listWaifus, readDiscordBotsFile } from "../stores/config.js";
import { recordWaifuNotes } from "../stores/memories.js";
import { PICK_NEXT_WAIFU_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_NAME } from "../tools.js";
import { typingDelayMs, verbosityProfile } from "../verbosity.js";
import { WAIFU_HARNESS_TAGS, createWaifuHarness, waifuTools, type WaifuHarness } from "../waifuHarness.js";
import { assessDmLimit, limitNoticeDue, renderLimitNotice } from "./rateLimit.js";
import {
  computeDmEligibility,
  listDmStates,
  readDmLimit,
  readDmState,
  updateDmLimit,
  updateDmState,
  updateExistingDmState,
  withRunRecord,
  withoutPending,
  type DmEligibility
} from "./dmStore.js";

export type DmRunnerSettings = {
  dmMs: number;
  dmMaxWaitMs: number;
  maxConcurrentRuns: number;
  resumeWindowMinutes: number;
  /** `memory.dmInjectionLimit`: memory snapshot size in DMs. */
  dmInjectionLimit: number;
};

export type DmRunnerDeps = {
  storage: StorageService;
  discord: DiscordGatewayFacade;
  logger: Logger;
  contexts: ContextRuntime;
  conversationCache: ConversationMessageCache;
  models: ModelAccess;
  settings: () => DmRunnerSettings;
  isPaused: () => boolean;
  isStopping: () => boolean;
  runBackground: (label: string, context: Record<string, unknown>, task: () => void | Promise<unknown>) => void;
  /** DM observer scheduling (memoryJobs.noteDmActivity). */
  noteActivity?: (conversation: Extract<ConversationRef, { kind: "dm" }>) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  /** Boot/resume scan stagger (spec: 2 s). */
  resumeStaggerMs?: number;
};

type DmRef = Extract<ConversationRef, { kind: "dm" }>;

type DmSlot = {
  conversation: DmRef;
  phase: "idle" | "generating" | "sending";
  controller?: AbortController;
  promise?: Promise<void>;
  rerunRequested: boolean;
};

/** Spec 9.1 edge case: Discord "Cannot send messages to this user" (DMs closed or bot blocked). */
export const DISCORD_CANNOT_DM_USER = 50007;
export const DM_SUPERSEDED_REASON = "superseded";
export const DM_PAUSED_REASON = "runtime paused";
const RESUME_SCAN_HOURS = 24;
const RESUME_SCAN_MAX = 50;
const TAIL_CHECK_SIZE = 5;
const TYPING_REFRESH_MS = 8000;

/** Counting semaphore (spec 9.1: `discord.dm.maxConcurrentRuns`). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.active >= Math.max(1, this.limit())) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted.");
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  get inUse(): number {
    return this.active;
  }
}

function dmRef(waifuId: string, userId: string): DmRef {
  return { kind: "dm", waifuId, userId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class DmRunner {
  private readonly slots = new Map<ConversationKey, DmSlot>();
  readonly debouncer = new KeyedDebouncer<ConversationKey>();
  readonly semaphore: Semaphore;
  /** The exact prompt of each DM's latest generation (`dm:<key>`); never readable from a guild. */
  readonly lastSentPrompts = new Map<string, { debug: BuiltPrompt["debug"]; at: string }>();
  private readonly now: () => Date;

  constructor(private readonly d: DmRunnerDeps) {
    this.semaphore = new Semaphore(() => d.settings().maxConcurrentRuns);
    this.now = d.now ?? (() => new Date());
  }

  // ---- eligibility -----------------------------------------------------------------------------

  async eligibility(): Promise<{ eligibility: DmEligibility; waifus: WaifuConfig[] }> {
    const [waifus, bots] = await Promise.all([listWaifus(this.d.storage), readDiscordBotsFile(this.d.storage)]);
    return { eligibility: computeDmEligibility(waifus, bots), waifus };
  }

  private async eligibleWaifu(waifuId: string, botId?: string): Promise<WaifuConfig | undefined> {
    const { eligibility, waifus } = await this.eligibility();
    const entry = eligibility.eligible.find((candidate) => candidate.waifuId === waifuId);
    if (!entry || (botId !== undefined && entry.botId !== botId)) return undefined;
    return waifus.find((waifu) => waifu.id === waifuId);
  }

  // ---- inbound ---------------------------------------------------------------------------------

  /** Step 1: a human DM'd a waifu bot. */
  async handleInbound(event: DiscordDirectMessageEvent): Promise<void> {
    const waifu = await this.eligibleWaifu(event.waifuId, event.botId);
    if (!waifu) {
      // allowDms off (or not eligible): ignored entirely, nothing is written (spec 9.1).
      this.d.logger.debug?.("DM ignored: waifu does not take DMs", { waifuId: event.waifuId, botId: event.botId, messageId: event.messageId });
      return;
    }
    const conversation = dmRef(waifu.id, event.userId);
    const key = conversationKey(conversation);
    await updateDmState(this.d.storage, { userId: event.userId, waifuId: waifu.id, botId: event.botId }, (current) => {
      const newer = !current.lastInboundMessageId || compareIds(event.messageId, current.lastInboundMessageId) > 0;
      const { undeliverableSince: _cleared, ...rest } = current;
      return {
        ...rest,
        botId: event.botId,
        dmChannelId: event.channelId,
        ...(event.userDisplayName ? { userDisplayName: event.userDisplayName.slice(0, 100) } : {}),
        ...(newer ? { lastInboundMessageId: event.messageId, lastInboundAt: event.createdAt } : {})
      };
    });
    if (this.d.isPaused() || this.d.isStopping()) {
      // Recorded above so resume can find it; nothing runs while paused.
      this.d.logger.info("DM recorded but not answered: runtime is paused", { waifuId: waifu.id, messageId: event.messageId });
      return;
    }
    const slot = this.slot(conversation);
    if (slot.phase === "generating") slot.controller?.abort(new Error(DM_SUPERSEDED_REASON));
    else if (slot.phase === "sending") slot.rerunRequested = true;
    await this.arm(conversation);
  }

  private slot(conversation: DmRef): DmSlot {
    const key = conversationKey(conversation);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { conversation, phase: "idle", rerunRequested: false };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private async arm(conversation: DmRef): Promise<void> {
    const settings = this.d.settings();
    const key = conversationKey(conversation);
    const fired = this.debouncer.schedule(key, { quietMs: settings.dmMs, maxWaitMs: settings.dmMaxWaitMs }, () => this.fire(conversation));
    if (fired) await fired;
  }

  /** Step 2: the debounce fired. Resolves when this run (not a follow-up) is done. */
  private async fire(conversation: DmRef): Promise<void> {
    if (this.d.isPaused() || this.d.isStopping()) return;
    const slot = this.slot(conversation);
    if (slot.phase === "sending") {
      slot.rerunRequested = true;
      return;
    }
    if (slot.phase === "generating") {
      // Superseded on arrival; let it unwind first.
      await slot.promise?.catch(() => undefined);
      if ((slot.phase as DmSlot["phase"]) !== "idle") {
        slot.rerunRequested = true;
        return;
      }
    }
    const controller = new AbortController();
    slot.controller = controller;
    slot.phase = "generating";
    slot.rerunRequested = false;
    const promise = this.runGuarded(slot, controller.signal);
    slot.promise = promise;
    await promise;
  }

  private async runGuarded(slot: DmSlot, signal: AbortSignal): Promise<void> {
    const { waifuId, userId } = slot.conversation;
    let release: (() => void) | undefined;
    try {
      release = await this.semaphore.acquire(signal);
      await this.runOnce(slot, signal);
    } catch (error) {
      if (!signal.aborted) {
        this.d.logger.error("DM run failed", {
          waifuId,
          userId,
          message: errorMessage(error),
          details: error instanceof GatewayPipelineError ? String(error.details ?? "").slice(0, 2000) : undefined
        });
      }
    } finally {
      release?.();
      slot.phase = "idle";
      slot.controller = undefined;
      if (slot.rerunRequested && !this.d.isPaused() && !this.d.isStopping()) {
        slot.rerunRequested = false;
        // A message arrived while the reply was being sent: one debounced follow-up.
        this.d.runBackground("DM follow-up run failed", { waifuId, userId }, () => this.arm(slot.conversation));
      }
    }
  }

  // ---- one run ---------------------------------------------------------------------------------

  private async recordRun(
    conversation: DmRef,
    botId: string,
    run: Omit<DmRunRecord, "id" | "at" | "messageIds"> & { messageIds?: string[] },
    patch: (s: DmState) => DmState = (s) => s
  ): Promise<void> {
    const record: DmRunRecord = { id: randomUUID(), at: this.now().toISOString(), ...run, messageIds: run.messageIds ?? [] };
    await updateDmState(this.d.storage, { userId: conversation.userId, waifuId: conversation.waifuId, botId }, (current) =>
      withRunRecord(patch(current), record)
    );
    // Ids and status only (spec 9.1.3).
    this.d.logger.info("DM run finished", {
      waifuId: conversation.waifuId,
      userId: conversation.userId,
      status: record.status,
      triggerMessageId: record.triggerMessageId,
      messages: record.messageIds.length
    });
  }

  private async runOnce(slot: DmSlot, signal: AbortSignal): Promise<void> {
    const conversation = slot.conversation;
    const { waifuId, userId } = conversation;
    const startedAt = Date.now();
    const waifu = await this.eligibleWaifu(waifuId);
    if (!waifu || !waifu.botId || !waifu.modelId) {
      this.d.logger.info("DM run skipped: waifu no longer takes DMs", { waifuId, userId });
      await updateExistingDmState(this.d.storage, userId, waifuId, withoutPending);
      return;
    }
    const botId = waifu.botId;
    const state = await readDmState(this.d.storage, userId, waifuId);
    if (!state?.lastInboundMessageId) return;
    if (state.undeliverableSince) {
      // DMs closed / bot blocked: wait for the user's next message (which clears the flag).
      await updateExistingDmState(this.d.storage, userId, waifuId, withoutPending);
      return;
    }
    const triggerMessageId = state.lastInboundMessageId;
    const userName = state.userDisplayName ?? "them";

    // Rate-limit gate (spec 9.1.1): no model call when limited.
    const now = this.now();
    const limitState = await readDmLimit(this.d.storage, userId, waifuId);
    const assessment = assessDmLimit(limitState.replyTimestamps, waifu.dm.rateLimit, now);
    if (assessment.limited) {
      const noticeDue = waifu.dm.notifyWhenLimited && limitNoticeDue(assessment, limitState.limitNoticeSentAt);
      let noticeId: string | undefined;
      if (noticeDue && this.d.discord.sendDirectMessage) {
        try {
          const content = renderLimitNotice(waifu.dm.limitNotice, {
            name: waifu.displayName || waifu.name || waifu.id,
            user: userName,
            freesAt: assessment.freesAt,
            now
          });
          noticeId = (await this.d.discord.sendDirectMessage({ waifuId, userId, content })).messageId;
          await updateDmLimit(this.d.storage, userId, waifuId, (current) => ({
            ...current,
            replyTimestamps: assessDmLimit(current.replyTimestamps, waifu.dm.rateLimit, now).pruned,
            limitNoticeSentAt: now.toISOString()
          }));
        } catch (error) {
          if (isCannotDmError(error)) {
            await this.recordRun(conversation, botId, { triggerMessageId, status: "undeliverable", reason: "cannot_dm_user" }, (s) => ({
              ...withoutPending(s),
              undeliverableSince: now.toISOString()
            }));
            return;
          }
          this.d.logger.warn("DM limit notice could not be sent", { waifuId, userId, message: errorMessage(error) });
        }
      }
      await this.recordRun(
        conversation,
        botId,
        {
          triggerMessageId,
          status: noticeId ? "notice_sent" : "rate_limited",
          messageIds: noticeId ? [noticeId] : [],
          ...(assessment.freesAt ? { reason: `frees_at ${assessment.freesAt}` } : {})
        },
        // The limited message counts as handled: she answers the user's next message once free.
        (s) => ({ ...withoutPending(s), lastRepliedMessageId: triggerMessageId })
      );
      return;
    }

    await updateDmState(this.d.storage, { userId, waifuId, botId }, (current) => ({
      ...current,
      pendingTriggerMessageId: triggerMessageId,
      pendingSince: current.pendingSince ?? now.toISOString()
    }));

    const pipeline = this.d.models.pipelineFor({ providerId: waifu.providerId, modelId: waifu.modelId }, "waifu");
    const model = this.d.models.resolvedModel({ providerId: waifu.providerId, modelId: waifu.modelId });
    if (!model) throw new GatewayPipelineError(`Unknown model ${waifu.providerId ?? "?"}:${waifu.modelId}`);
    const bots = await readDiscordBotsFile(this.d.storage);
    const selfAuthorIds = [...new Set([...resolveBotAuthorIds(botId, bots), ...(this.d.discord.ownAuthorIds?.() ?? [])])];
    const toolsUsable = waifu.tools.toolUse && model.features.tools.supported;
    const harness: WaifuHarness = createWaifuHarness({
      waifu,
      conversation,
      roster: [],
      place: { kind: "dm", userName },
      people: [{ userId, name: userName }],
      emojis: [],
      tools: waifuTools({ addMemory: toolsUsable, pickNextWaifuIds: [] })
    });
    const key = conversationKey(conversation);
    const summarize = pipeline.summarizeContext
      ? contextSummarizer(pipeline, {
          toolChoice: "auto",
          params: waifu.params,
          attribution: { agentId: `waifu-${waifu.id}`, waifuId: waifu.id, conversationKey: key }
        })
      : undefined;

    const typing = this.startTyping(waifuId, userId);
    let prepared: PreparedContext | undefined;
    let lastCall: { prompt: BuiltPrompt; result: WaifuGenerationResult } | undefined;
    let committed = false;
    try {
      prepared = await this.d.contexts.prepare({
        conversation,
        agent: { kind: "waifu", waifuId: waifu.id },
        model,
        backfillCap: resolveContextCap("waifu", undefined, waifu),
        selfAuthorIds,
        render: harness,
        renderToolTurnsAsText: true,
        participantIds: [userId],
        recentReactions: ({ refs, transcript }) => {
          const lastOwn = [...transcript].reverse().find((entry) => selfAuthorIds.includes(entry.authorId));
          const visible = new Map<string, string>();
          for (const entry of transcript) {
            const ref = refs.get(entry.id);
            if (ref !== undefined) visible.set(entry.id, ref);
          }
          return this.d.conversationCache.recentReactions(conversation, { sinceMs: lastOwn ? Date.parse(lastOwn.at) || 0 : 0, refs: visible });
        },
        signal,
        params: waifu.params,
        ...(summarize ? { summarize } : {}),
        memoryLimit: this.d.settings().dmInjectionLimit
      });
      const ready = prepared;
      this.lastSentPrompts.set(`dm:${key}`, { debug: ready.prompt.debug, at: new Date().toISOString() });
      const profile = verbosityProfile(waifu.verbosity);
      const selfDisplayNames = dedupeNames([
        waifu.displayName,
        waifu.name,
        ...ready.transcript.filter((entry) => selfAuthorIds.includes(entry.authorId)).map((entry) => entry.authorName)
      ]);
      const participantDisplayNames = dedupeNames([...selfDisplayNames, userName, ...ready.transcript.map((entry) => entry.authorName)]);
      const reply = await generateValidatedWaifuReply({
        generate: async (retry) =>
          this.d.contexts.call(ready, async (prompt) => {
            const sent = retry ? promptWithTail(prompt, harness.tail(ready.state, ready.startedAt, { retryNote: retry })) : prompt;
            const generated = await pipeline.generateWaifu({
              modelId: waifu.modelId!,
              prompt: sent,
              transcript: ready.transcript,
              availableWaifuIds: [],
              params: waifu.params,
              stopSequences: waifuStopSequences(waifu),
              attribution: {
                purpose: retry ? "waifu_retry" : "waifu_reply",
                agentId: `waifu-${waifu.id}`,
                waifuId: waifu.id,
                conversationKey: key
              },
              signal
            });
            lastCall = { prompt: sent, result: generated };
            return generated;
          }),
        refToMessageId: ready.prompt.refToMessageId,
        selfDisplayNames,
        participantDisplayNames,
        profile,
        validator: {
          blockTags: [...WAIFU_HARNESS_TAGS],
          toolNames: [SHORT_TERM_MEMORY_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_NAME, "orchestrator_decision", "dream_memories", "set_persona_digest"],
          recentSelfMessages: ready.transcript
            .filter((entry) => selfAuthorIds.includes(entry.authorId))
            .slice(-5)
            .map((entry) => entry.body)
        },
        logger: this.d.logger,
        logContext: { waifuId, userId, dm: true }
      });
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(DM_SUPERSEDED_REASON);
      typing.stop();

      // From here the reply is never aborted by a new message (step 6).
      slot.phase = "sending";
      const { result, marker, chunks, blockedViolations } = reply;
      const memoryListed = harness.tools().some((tool) => tool.name === SHORT_TERM_MEMORY_TOOL_NAME);
      const memoryCalls = planMemoryCalls(result, !memoryListed);
      const memoryEntries = memoryCalls.flatMap((call) => (call.entry !== undefined ? [call.entry] : []));
      const replyToMessageId = marker.replyToMessageId;
      const sentIds: string[] = [];
      let sendError: unknown;
      for (let i = 0; i < chunks.length; i += 1) {
        if (i > 0) {
          void this.d.discord.sendDirectTyping?.({ waifuId, userId }).catch(() => undefined);
          await this.d.sleep(typingDelayMs(chunks[i]!));
        }
        try {
          const sent = await this.d.discord.sendDirectMessage!({
            waifuId,
            userId,
            content: chunks[i]!,
            ...(i === 0 && replyToMessageId ? { replyToMessageId } : {})
          });
          sentIds.push(sent.messageId);
        } catch (error) {
          sendError = error;
          break;
        }
      }
      if (memoryEntries.length > 0) {
        // DM-origin memories (O4): origin.dm, about this user; never printed into a guild.
        const decisions = await recordWaifuNotes(this.d.storage, {
          waifuId,
          entries: memoryEntries,
          origin: { dm: true },
          subjects: [{ discordUserId: userId, name: userName }]
        });
        applyMemoryDecisions(memoryCalls, decisions);
      }
      committed = true;
      await this.commit(ready, toolNotes(result, memoryCalls, { handoff: undefined, pickedName: undefined }), lastCall);

      const finishedAt = this.now();
      if (sentIds.length > 0) {
        await updateDmLimit(this.d.storage, userId, waifuId, (current) => ({
          ...current,
          replyTimestamps: [...assessDmLimit(current.replyTimestamps, waifu.dm.rateLimit, finishedAt).pruned, finishedAt.toISOString()].slice(-1000)
        }));
      }
      const undeliverable = sentIds.length === 0 && sendError !== undefined && isCannotDmError(sendError);
      if (sendError !== undefined && !undeliverable && sentIds.length === 0) {
        await this.recordRun(conversation, botId, { triggerMessageId, status: "failed", reason: errorMessage(sendError).slice(0, 200), durationMs: Date.now() - startedAt }, withoutPending);
        return;
      }
      const usedTool = memoryEntries.length > 0;
      const status: DmRunRecord["status"] = undeliverable
        ? "undeliverable"
        : sentIds.length > 0
          ? "sent"
          : blockedViolations
            ? "blocked"
            : usedTool
              ? "tool_only"
              : "empty";
      await this.recordRun(
        conversation,
        botId,
        {
          triggerMessageId,
          status,
          messageIds: sentIds,
          ...(blockedViolations && sentIds.length === 0 ? { reason: blockedViolations.map((v) => v.check).join(", ").slice(0, 200) } : {}),
          ...(sendError !== undefined && sentIds.length > 0 ? { reason: `partial_send: ${sentIds.length} of ${chunks.length}` } : {}),
          ...(undeliverable ? { reason: "cannot_dm_user" } : {}),
          durationMs: Date.now() - startedAt
        },
        (s) => ({
          ...withoutPending(s),
          ...(undeliverable ? { undeliverableSince: finishedAt.toISOString() } : { lastRepliedMessageId: triggerMessageId }),
          ...(sentIds.length > 0 ? { lastReplyAt: finishedAt.toISOString() } : {})
        })
      );
      this.d.noteActivity?.(conversation);
    } catch (error) {
      if (prepared && !committed) await this.commit(prepared, [], lastCall);
      if (signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
        const superseded = reason === DM_SUPERSEDED_REASON;
        // Superseded: the debounced rerun answers; shutdown keeps pending* for the next boot;
        // pause clears pending* itself.
        await this.recordRun(conversation, botId, {
          triggerMessageId,
          status: superseded ? "superseded" : "interrupted",
          reason: reason.slice(0, 200),
          durationMs: Date.now() - startedAt
        });
        return;
      }
      await this.recordRun(
        conversation,
        botId,
        { triggerMessageId, status: "failed", reason: errorMessage(error).slice(0, 200), durationMs: Date.now() - startedAt },
        withoutPending
      ).catch(() => undefined);
      throw error;
    } finally {
      typing.stop();
    }
  }

  private async commit(
    prepared: PreparedContext,
    notes: NewContextNote[],
    call: { prompt: BuiltPrompt; result: WaifuGenerationResult } | undefined
  ): Promise<void> {
    try {
      await this.d.contexts.commit(prepared, {
        notes,
        ...(call?.result.usage ? { usage: call.result.usage } : {}),
        ...(call ? { sentPrompt: call.prompt } : {}),
        modelKey: prepared.modelKey
      });
    } catch (error) {
      this.d.logger.warn("Failed to commit DM context", { conversationKey: prepared.key, message: errorMessage(error) });
    }
  }

  private startTyping(waifuId: string, userId: string): { stop(): void } {
    let stopped = false;
    const tick = () => {
      if (!stopped) void this.d.discord.sendDirectTyping?.({ waifuId, userId }).catch(() => undefined);
    };
    tick();
    const interval = setInterval(tick, TYPING_REFRESH_MS);
    interval.unref?.();
    return {
      stop: () => {
        stopped = true;
        clearInterval(interval);
      }
    };
  }

  // ---- lifecycle (spec 9.1.2) --------------------------------------------------------------------

  /** Shutdown: flush debounced bursts into `pending*`, abort live runs (they keep `pending*`). */
  async shutdown(reason: string): Promise<void> {
    for (const key of this.debouncer.drain()) {
      const slot = this.slots.get(key);
      if (!slot) continue;
      const { userId, waifuId } = slot.conversation;
      await updateExistingDmState(this.d.storage, userId, waifuId, (current) =>
        current.lastInboundMessageId
          ? { ...current, pendingTriggerMessageId: current.lastInboundMessageId, pendingSince: current.pendingSince ?? this.now().toISOString() }
          : current
      ).catch((error: unknown) => this.d.logger.warn("Failed to persist a pending DM at shutdown", { waifuId, userId, message: errorMessage(error) }));
    }
    await this.abortAll(reason);
  }

  /** Explicit pause: abort and clear `pending*`; resume catches up through the scan. */
  async pause(): Promise<void> {
    const keys = new Set([...this.slots.keys()]);
    this.debouncer.cancelAll();
    await this.abortAll(DM_PAUSED_REASON);
    for (const key of keys) {
      const slot = this.slots.get(key);
      if (!slot) continue;
      await updateExistingDmState(this.d.storage, slot.conversation.userId, slot.conversation.waifuId, withoutPending).catch(() => undefined);
    }
  }

  private async abortAll(reason: string): Promise<void> {
    const running: Array<Promise<void>> = [];
    for (const slot of this.slots.values()) {
      slot.rerunRequested = false;
      if (slot.controller) slot.controller.abort(new Error(reason));
      if (slot.promise) running.push(slot.promise);
    }
    await Promise.allSettled(running);
  }

  /** Abort and drop one conversation (DM forget). */
  async forgetConversation(conversation: DmRef): Promise<void> {
    const key = conversationKey(conversation);
    this.debouncer.cancel(key);
    const slot = this.slots.get(key);
    if (slot?.controller) slot.controller.abort(new Error("forgotten"));
    await slot?.promise?.catch(() => undefined);
    this.slots.delete(key);
  }

  /**
   * Boot / resume-after-pause (never while paused): DM states with an inbound in the last 24 h
   * (≤ 50, newest first, staggered) are due when `pending*` is set or a 5-message tail check shows
   * a newer human message than `lastRepliedMessageId`; inside the resume window they get a
   * debounced run, otherwise `pending*` is cleared.
   */
  async resume(): Promise<void> {
    if (this.d.isPaused() || this.d.isStopping()) return;
    const now = this.now().getTime();
    const windowMs = this.d.settings().resumeWindowMinutes * 60_000;
    const states = (await listDmStates(this.d.storage))
      .filter((state) => state.lastInboundAt && now - Date.parse(state.lastInboundAt) <= RESUME_SCAN_HOURS * 3_600_000)
      .sort((a, b) => Date.parse(b.lastInboundAt!) - Date.parse(a.lastInboundAt!))
      .slice(0, RESUME_SCAN_MAX);
    const { eligibility } = await this.eligibility();
    let first = true;
    for (const state of states) {
      if (this.d.isPaused() || this.d.isStopping()) return;
      if (!eligibility.eligible.some((entry) => entry.waifuId === state.waifuId)) continue;
      const conversation = dmRef(state.waifuId, state.userId);
      if (this.debouncer.has(conversationKey(conversation)) || this.slot(conversation).phase !== "idle") continue;
      if (!first) await this.d.sleep(this.d.resumeStaggerMs ?? 2000);
      first = false;
      const due = state.pendingTriggerMessageId !== undefined || (await this.tailShowsUnanswered(state));
      if (!due) continue;
      const age = now - Date.parse(state.pendingSince ?? state.lastInboundAt!);
      if (age <= windowMs && !state.undeliverableSince) {
        this.d.logger.info("DM resume: catching up a conversation", { waifuId: state.waifuId, userId: state.userId });
        this.d.runBackground("DM resume run failed", { waifuId: state.waifuId, userId: state.userId }, () => this.arm(conversation));
      } else if (state.pendingTriggerMessageId !== undefined) {
        await updateExistingDmState(this.d.storage, state.userId, state.waifuId, withoutPending);
      }
    }
  }

  private async tailShowsUnanswered(state: DmState): Promise<boolean> {
    if (!this.d.discord.fetchDmContextSince) return false;
    try {
      const page = await this.d.discord.fetchDmContextSince({ waifuId: state.waifuId, userId: state.userId, afterMessageId: null, maxMessages: TAIL_CHECK_SIZE });
      const newestHuman = page.messages
        .filter((message) => message.authorId === state.userId)
        .reduce<string | undefined>((acc, message) => (!acc || compareIds(message.id, acc) > 0 ? message.id : acc), undefined);
      if (!newestHuman) return false;
      if (newestHuman !== state.lastInboundMessageId && (!state.lastInboundMessageId || compareIds(newestHuman, state.lastInboundMessageId) > 0)) {
        // A DM that arrived while we were down: record it as the newest inbound.
        await updateExistingDmState(this.d.storage, state.userId, state.waifuId, (current) => ({
          ...current,
          lastInboundMessageId: newestHuman,
          lastInboundAt: page.messages.find((m) => m.id === newestHuman)?.createdAt ?? current.lastInboundAt
        }));
      }
      return !state.lastRepliedMessageId || compareIds(newestHuman, state.lastRepliedMessageId) > 0;
    } catch (error) {
      this.d.logger.info("DM resume tail check failed", { waifuId: state.waifuId, userId: state.userId, message: errorMessage(error) });
      return false;
    }
  }

  /** In-flight DM generations (status / tests). */
  get activeRuns(): number {
    return [...this.slots.values()].filter((slot) => slot.phase !== "idle").length;
  }
}

/** Discord 50007: the user closed DMs or blocked the bot. */
export function isCannotDmError(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === DISCORD_CANNOT_DM_USER;
}
