// The life loop (Living cast spec §5.2): one agent loop per waifu.
//
//   idle ──wake──► coalesce 2 s ──► turn:
//     append <notifications> user message (+ time line)
//     loop {
//       build request (§5.4) → ModelClient.call (abortable)
//       append the assistant message exactly as assembled (§5.3)
//       finish = length with tool calls → the last call gets "your message was cut off"
//       finish = refusal → end; no tool calls → end (after the unsent-reply check)
//       run tool calls in order (intents for side effects, §5.7) → append one tool-results message:
//         results (+ folded notifications for new wakes) + time line
//       caps: life.maxTurnMs, or the same failing calls three rounds in a row →
//         "[system] turn ended: <limit>" (no cap on the number of rounds)
//     }
//
// Her text is private: only SendMessage and React reach people. One turn at a time per waifu
// (`life:<id>` lock, shared with compaction, maintenance and forget); turns of different waifus run
// in parallel up to `life.maxConcurrentTurns`.

import { isDmPlaceKey } from "./lifeView.js";
import { availabilityFor, noteSend } from "./busy.js";
import { withPlaceRecord } from "./placeRecorder.js";
import { homeStoreFor, refreshPlacesFile } from "./home/index.js";
import { createHash } from "node:crypto";
import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { findCuratedModel, type CuratedModel } from "../models/catalog.js";
import { ModelCallError } from "../models/errors.js";
import { ImageBuildAbortedError } from "../orchestration/context/images.js";
import { emaTokenCalibration } from "../orchestration/context/compaction.js";
import { TOKEN_ESTIMATOR_VERSION } from "../orchestration/context/tokens.js";
import { promptTokensOf } from "../orchestration/usageLedger.js";
import { readWaifu } from "../orchestration/stores/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeLogKind, LifeLogLine, LifeState, Wake } from "../shared/schemas/life.js";
import { dayStartAt, timeLine } from "./clock.js";
import { compactLife, compactRetiredTools, currentHarness, KEPT_TURNS, newTurnId, startEpoch, startPendingEpoch, turnCount, type HarnessNow } from "./compaction.js";
import type { LifeDeps } from "./deps.js";
import { appendIntent, appendLifeLog, compactIntents, readLifeFile, readLifeLog, readLifeState, updateLifeFile, updateLifeState } from "./lifeStore.js";
import { renderNotifications, type NotificationView } from "./notifications.js";
import { REST_NOTICE, REST_REFUSED_RESULT, REST_REFUSED_TOOLS, REST_SUMMARY_FRAME, selfSummaryOf, selfSummaryRefusedNote } from "./rest.js";
import { messagesOf } from "./wakeMessages.js";
import { lifeLocks } from "./paths.js";
import { selfAuthorIds } from "./people.js";
import { collectPlaces, handleOf, refreshPlaces, resolvePlace, withPlaceCache } from "./places.js";
import { buildLifeRequest, estimateRequest, lifeBudget, PinnedImageMissingError } from "./request.js";
import type { KeyedMutex, Semaphore } from "./sync.js";
import { lifeTool } from "./tools/index.js";
import { streamedPlace, TypingKeeper } from "./typing.js";
import { toolError, type ToolOutput, type TurnScratch } from "./tools/types.js";
import { deferImmediate, DIRECT_REASONS, peekImmediate, pendingWakeCount, requeueWakes, takeWakes } from "./wakeQueue.js";
import type { DailyCost } from "./budget.js";
import { readDmFloor } from "../orchestration/dm/dmStore.js";
import { compareIds } from "../discord/rawMessage.js";
import { assignConversationRefs } from "../discord/refStore.js";
import { parseConversationKey } from "../orchestration/context/keys.js";

/** Identical all-failing rounds after the first before the turn ends (three in a row in all). */
const MAX_FAILED_REPEATS = 2;
export const COALESCE_MS = 2_000;
export const FOLLOW_UP_DELAY_MS = 60_000;
export const MEMORY_WARNING_RATIO = 0.85;
export const UNSENT_REPLY_NOTE = "[system] Nothing you wrote above was sent. If you meant to reply, use SendMessage; otherwise just end.";
export const FOLLOW_UP_NOTE = "[system] your last turn failed; the notifications above may still need you";
export const MEMORY_SUMMARISED_NOTE = "[system] memory summarised";
export const CUT_OFF_RESULT = "error: your message was cut off; try shorter";
export const INTERRUPTED_RESULT = "[interrupted]";
export const REFUSED_RESULT = "error: not run (your reply ended in a refusal)";

export { REST_NOTICE, REST_REFUSED_RESULT, REST_REFUSED_TOOLS, REST_SUMMARY_FRAME } from "./rest.js";

export type LifeHostHooks = {
  /** A turn ended (tests, dashboard). */
  onTurnEnd?(waifuId: string, info: { turnId: string; rounds: number; reason: string; sent: boolean }): void;
};

/**
 * Work the host reports as busy (§3, review I7): one lease per turn cycle, maintenance run or forget
 * scrub; `undefined` means the app is about to restart for an update and nothing new may start.
 */
export type LifeActivity = { begin(kind: "turn" | "maintenance" | "forget"): (() => void) | undefined };

export type LifeHost = {
  deps: LifeDeps;
  mutex: KeyedMutex;
  turns: Semaphore;
  hooks?: LifeHostHooks;
  activity?: LifeActivity;
  /** Her spend for the local day (§4.4 guard 5), checked again when a turn starts and while it runs. */
  cost?: DailyCost;
};

/** How long a life waits before trying again when the app was sealed for an update. */
const SEALED_RETRY_MS = 30_000;
/** Quota and billing errors open a provider cooldown: her wakes wait for it (review I6). */
const COOLDOWN_KINDS = new Set(["quota", "billing"]);

/** Her curated route, or undefined when she has no offered model. */
/** Her token calibration, unless it was learned under another estimator (then it starts over). */
export function currentCalibration<T extends { estimator?: number | undefined }>(calibration: T | undefined): T | undefined {
  return calibration?.estimator === TOKEN_ESTIMATOR_VERSION ? calibration : undefined;
}

export function lifeModelOf(deps: Pick<LifeDeps, "catalog">, waifu: WaifuConfig): CuratedModel | undefined {
  if (!waifu.model) return undefined;
  return findCuratedModel(waifu.model, deps.catalog());
}

type TurnRun = {
  waifu: WaifuConfig;
  model: CuratedModel;
  state: LifeState;
  lines: LifeLogLine[];
  turnId: string;
  wakes: Wake[];
  scratch: TurnScratch;
  signal: AbortSignal;
  startedMs: number;
  lastEstimate: number;
  selfIds: string[];
  /** What is left of her daily budget when the turn started (undefined: no budget). */
  budgetLeftUsd?: number;
  /** What this turn's calls cost so far. */
  spentUsd: number;
  /** "Typing…" in the place of the wake that started the turn (§6.3): pending until she commits. */
  /** `sentTo`: where she last wrote this turn; only her next SendMessage types again, there. */
  /**
   * `sends`: the arguments streamed so far of each SendMessage call whose place is not known yet;
   * `lookups`: a place being resolved, which the call waits for before it runs; `ran`: calls already
   * executed, so a late lookup never brings typing back after the send.
   */
  typing?: { keeper: TypingKeeper; sends: Map<string, string>; lookups: Map<string, Promise<void>>; ran: Set<string> };
  /** The rest turn (§19.3): no wakes fold in, tools that reach people are refused. */
  rest?: boolean;
  /** Her text in the round that ended the turn (the rest summary). */
  finalText?: string;
  /** Why the turn ended (`done`, `length`, a cap, `error`, `interrupted`, `compaction:…`). */
  endReason?: string;
};

type TurnOutcome = "idle" | "again";

export class Life {
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private followUpTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private cycle: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private rerun = false;
  private stopped = false;
  private warnedNoModel = false;
  private compactionsThisCycle = 0;
  /** The running turn's typing keeper (stopped with the turn, or by stop()). */
  private typing: TypingKeeper | undefined;

  constructor(
    readonly waifuId: string,
    private readonly host: LifeHost
  ) {}

  private get deps(): LifeDeps {
    return this.host.deps;
  }

  /** New wakes are queued: a turn starts after the 2 s coalesce window (§4.6), or folds them in. */
  poke(o: { delayMs?: number } = {}): void {
    if (this.stopped) return;
    if (this.cycle) {
      this.rerun = true;
      return;
    }
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      this.start();
    }, o.delayMs ?? COALESCE_MS);
    this.coalesceTimer.unref?.();
  }

  /** Starts a cycle now (no coalesce). Resolves when the life is idle again. */
  runNow(): Promise<void> {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.start();
    return this.whenIdle();
  }

  private start(): void {
    if (this.stopped) return;
    if (this.cycle) {
      this.rerun = true;
      return;
    }
    this.cycle = this.runCycle().finally(() => {
      this.cycle = undefined;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.poke({ delayMs: 0 });
      }
    });
  }

  async whenIdle(): Promise<void> {
    while (this.cycle || this.coalesceTimer) {
      if (this.cycle) await this.cycle;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  get busy(): boolean {
    return this.cycle !== undefined;
  }

  /** Pause, shutdown, reset or a forget scrub: abort the in-flight call (§5.2). */
  abort(reason: string): void {
    this.controller?.abort(new Error(reason));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.coalesceTimer, this.followUpTimer, this.retryTimer]) if (timer) clearTimeout(timer);
    this.coalesceTimer = undefined;
    this.followUpTimer = undefined;
    this.retryTimer = undefined;
    this.typing?.stop();
    this.abort("shutdown");
  }

  /** A poke after `ms` (a provider cooldown ending, an update seal lifting). */
  private retryAfter(ms: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.poke({ delayMs: 0 });
    }, Math.max(0, ms));
    this.retryTimer.unref?.();
  }

  /**
   * After a restart: a failed turn's follow-up (§5.2) that has not run yet is armed again, due 60 s
   * after the failure (at once when that is past). Review M13.
   */
  armFollowUp(failedAtMs: number): void {
    if (this.stopped) return;
    this.scheduleFollowUp(Math.max(0, failedAtMs + FOLLOW_UP_DELAY_MS - this.deps.now().getTime()));
  }

  private async runCycle(): Promise<void> {
    // The life lock first, then a turn slot: a life waiting for her own maintenance or a forget
    // never holds one of the host's turn slots (review M6).
    await this.host.mutex.run(lifeLocks.life(this.waifuId), async () => {
      const lease = this.host.activity?.begin("turn");
      if (this.host.activity && !lease) {
        // The app is sealed for an update restart: her wakes stay queued.
        this.retryAfter(SEALED_RETRY_MS);
        return;
      }
      // Abortable while it waits for a slot too: a forget or a pause that comes meanwhile stops the
      // cycle before it takes any wake (and the forget gets her lock right after).
      this.controller = new AbortController();
      const waiting = this.controller;
      let release: () => void;
      try {
        release = await this.host.turns.acquire(waiting.signal);
      } catch {
        // Aborted while waiting for a slot: the wait ends at once, nothing was taken (N6).
        this.controller = undefined;
        lease?.();
        return;
      }
      try {
        this.compactionsThisCycle = 0;
        for (let guard = 0; guard < 8 && !this.stopped; guard += 1) {
          if (guard === 0 && waiting.signal.aborted) break;
          this.controller = guard === 0 ? waiting : new AbortController();
          let outcome: TurnOutcome;
          try {
            const signal = this.controller.signal;
            outcome = await withPlaceCache(() => this.turn(signal));
          } catch (error) {
            this.deps.logger.error("Life turn failed", { waifuId: this.waifuId, message: error instanceof Error ? error.message : String(error) });
            await updateLifeState(this.deps.storage, this.waifuId, (state) => ({ ...state, status: "idle", currentTurn: undefined })).catch(() => undefined);
            outcome = "idle";
          } finally {
            this.controller = undefined;
          }
          if (outcome !== "again") break;
        }
      } finally {
        this.controller = undefined;
        release();
        lease?.();
      }
    });
  }

  // ---- one turn -----------------------------------------------------------------------------------

  /** Handles and unread counts for the places a set of wakes names. */
  /** What is left of her daily budget today (undefined: she has none). */
  private async budgetLeft(waifu: WaifuConfig): Promise<number | undefined> {
    const budget = waifu.life.dailyBudgetUsd;
    if (budget === null || budget === undefined || !this.host.cost) return undefined;
    return budget - (await this.host.cost.today(this.waifuId, this.deps.now()));
  }

  private async notificationView(wakes: readonly Wake[], quietKeys: readonly string[], selfIdList: readonly string[]): Promise<NotificationView> {
    const deps = this.deps;
    const keys = new Set([...wakes.flatMap((wake) => (wake.placeKey ? [wake.placeKey] : [])), ...quietKeys]);
    const handles = new Map<string, string>();
    const unread = new Map<string, number>();
    const refs = new Map<string, Map<string, string>>();
    const cursors = await readLifeFile(deps.storage, this.waifuId, "reads");
    const selfIds = new Set(selfIdList);
    for (const key of keys) {
      handles.set(key, await handleOf(deps.storage, this.waifuId, key));
      const ref = parseConversationKey(key);
      if (!ref) continue;
      let floor: string | undefined = cursors.cursors[key]?.lastReadMessageId;
      if (ref.kind === "dm") {
        const dmFloor = await readDmFloor(deps.storage, ref.userId, ref.waifuId).catch(() => undefined);
        if (dmFloor && (!floor || compareIds(dmFloor, floor) > 0)) floor = dmFloor;
      }
      const buffered = deps.conversations.bufferedMessages(ref);
      const count = buffered.filter((message) => !selfIds.has(message.authorId) && (!floor || compareIds(message.id, floor) > 0)).length;
      if (count > 0) unread.set(key, count);
      // The notified messages get their refs now (§4.7), so she can reply to one without reading
      // first; the messages before them get theirs too, so refs stay in message order (a ref handed
      // to her own later send never jumps ahead of an older message). Only messages that exist get
      // one: the buffer and the latest page (served from the buffer when the conversation is trusted).
      // Every message a wake is about gets its line and its ref (§20).
      const wanted = wakes.flatMap((wake) => (wake.placeKey === key ? [...(wake.messageId ? [wake.messageId] : []), ...messagesOf(wake).map((message) => message.id)] : []));
      if (wanted.length === 0) continue;
      const dmFloor = ref.kind === "dm" ? await readDmFloor(deps.storage, ref.userId, ref.waifuId).catch(() => undefined) : undefined;
      const page = await deps.conversations.readPage({ conversation: ref, limit: 50 }).catch(() => ({ messages: [] as typeof buffered }));
      const known = [...new Set([...buffered, ...page.messages].map((message) => message.id))].filter((id) => !dmFloor || compareIds(id, dmFloor) > 0);
      const notified = wanted.filter((id) => known.includes(id));
      if (notified.length === 0) continue;
      const newest = notified.reduce((a, b) => (compareIds(a, b) >= 0 ? a : b));
      const ids = known.filter((id) => compareIds(id, newest) <= 0);
      refs.set(key, await assignConversationRefs(deps.storage, key as never, ids, deps.now()).catch(() => new Map<string, string>()));
    }
    return {
      timeZone: deps.timeZone,
      linesPerPlace: deps.config().life.notificationLinesPerPlace,
      handle: (key) => handles.get(key) ?? key,
      unread: (key) => unread.get(key),
      ref: (key, messageId) => refs.get(key)?.get(messageId)
    };
  }

  private async timeLineText(waifu: WaifuConfig, estimate: number, model: CuratedModel): Promise<string> {
    const config = this.deps.config();
    const trigger = config.compaction.triggerRatio * lifeBudget(model, config.life.maxContextTokens);
    // The rest notice replaces the "memory nearly full" warning (§19.2); with it off, the warning stays.
    // Busy from her day file, read on every use (§21.2); her bed time phase from her last send (§21.6c).
    const now = this.deps.now();
    const line = timeLine({ now, timeZone: this.deps.timeZone, status: await availabilityFor(this.deps, waifu, now), memoryWarning: !config.life.restNotice && estimate >= MEMORY_WARNING_RATIO * trigger });
    // A summary she wrote that was not used is explained once, on her next time line (§21.6b).
    const refused = (await readLifeState(this.deps.storage, this.waifuId)).selfSummaryRefused;
    if (refused === undefined) return line;
    await updateLifeState(this.deps.storage, this.waifuId, (current) => ({ ...current, selfSummaryRefused: undefined }));
    return `${line} ${selfSummaryRefusedNote(refused)}`;
  }

  /**
   * Her final reply was only `<summary>…</summary>` (§21.6b): a fresh start like an accepted rest
   * summary (§19.4), when the guards allow it; otherwise the text stays a private thought and her
   * next time line says why it was not used. Queued wakes wait for the new epoch.
   */
  private async selfSummaryRefusal(run: TurnRun, summary: string): Promise<string | undefined> {
    const deps = this.deps;
    const config = deps.config();
    const state = await readLifeState(deps.storage, this.waifuId);
    const trigger = config.compaction.triggerRatio * lifeBudget(run.model, config.life.maxContextTokens);
    const minutes = (deps.now().getTime() - Date.parse(state.epochStartedAt)) / 60_000;
    const refused =
      summary.length < Math.max(1, config.life.restSummaryMinChars)
        ? `it is shorter than ${config.life.restSummaryMinChars} characters`
        : (state.lastRequestTokens ?? 0) < config.life.selfSummaryMinRatio * trigger
          ? "your memory is still far from full"
          : minutes < config.life.selfSummaryCooldownMinutes
            ? `your last fresh start was less than ${config.life.selfSummaryCooldownMinutes} minutes ago`
            : undefined;
    if (refused) {
      await updateLifeState(deps.storage, this.waifuId, (current) => ({ ...current, selfSummaryRefused: refused }));
      deps.logger.info("Life summary not used", { category: "life", waifuId: this.waifuId, reason: refused });
    }
    return refused;
  }

  /** Her summary passed the guards: the turn ends and a new epoch starts from it alone (reason `self`). */
  private async selfSummary(run: TurnRun, rounds: number, summary: string): Promise<TurnOutcome> {
    const deps = this.deps;
    await this.finishIdle(run, rounds, "done");
    const harness = await currentHarness(deps, run.waifu, run.model);
    const next = await startEpoch(deps, this.waifuId, { harness, summary: `${REST_SUMMARY_FRAME}\n${summary}`, kept: [], readIds: [], reason: "self", summarized: true, strippedBlocks: 0 });
    deps.logger.info("Life rested on her own", { category: "life", waifuId: this.waifuId, epoch: next.epoch, summaryChars: summary.length });
    return (await pendingWakeCount(deps.storage, this.waifuId)) > 0 ? "again" : "idle";
  }

  /**
   * A rest turn is due (§19.2): the rest notice is on, her epoch is running, compaction is not
   * backing off, no rest notice was given in this epoch yet, and her last request reached `life.restNoticeRatio` × the compaction trigger but not
   * the trigger itself (that one compacts for her, as before).
   */
  private restDue(state: LifeState, model: CuratedModel): boolean {
    const config = this.deps.config();
    if (!config.life.restNotice || !state.systemSnapshot || state.pendingEpochStart || state.restTurn?.epoch === state.epoch) return false;
    if (state.compactionPausedUntil !== undefined && Date.parse(state.compactionPausedUntil) > this.deps.now().getTime()) return false;
    const trigger = config.compaction.triggerRatio * lifeBudget(model, config.life.maxContextTokens);
    const tokens = state.lastRequestTokens ?? 0;
    return tokens >= config.life.restNoticeRatio * trigger && tokens < trigger;
  }

  private async append(run: TurnRun, kind: LifeLogKind, message: ProviderMessageLike | Record<string, unknown>, extra: Partial<LifeLogLine> = {}): Promise<void> {
    const last = run.lines[run.lines.length - 1];
    const line: LifeLogLine = {
      seq: last ? last.seq + 1 : 0,
      at: this.deps.now().toISOString(),
      kind,
      turnId: run.turnId,
      message: message as Record<string, unknown>,
      ...extra
    };
    await appendLifeLog(this.deps.storage, this.waifuId, run.state.epoch, [line]);
    run.lines.push(line);
  }

  /**
   * The turn became a DM turn (a call resolved to a DM place, or a DM wake folded in): web entries
   * it already put on the dashboard's list become private (D14), and later ones are recorded so.
   */
  private async markDmTurn(run: TurnRun): Promise<void> {
    const wasDm = run.scratch.dm === true;
    run.scratch.dm = true;
    if (wasDm || !run.scratch.webEntries) return;
    await this.deps.web?.markTurnPrivate(run.turnId).catch((error: unknown) => {
      this.deps.logger.warn("Could not mark a DM turn's web searches private", { category: "life", waifuId: this.waifuId, message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** First epoch, a pending epoch start, a configuration change or a between-turns trigger (§5.6). */
  private async prepareEpoch(waifu: WaifuConfig, model: CuratedModel, state: LifeState, signal: AbortSignal): Promise<LifeState> {
    const deps = this.deps;
    const harness = await currentHarness(deps, waifu, model);
    if (!state.systemSnapshot) {
      const started = await startEpoch(deps, this.waifuId, { harness, summary: state.summary, kept: [], readIds: [], reason: "first", summarized: false, strippedBlocks: 0, first: true });
      // Her life begins with whatever woke her: her first morning wake is the next day's (§21.3).
      if (started.lastDayStart !== undefined) return started;
      const dayStart = dayStartAt(waifu, deps.now(), deps.timeZone, deps.config().life.dayStartHourLocal).toISOString();
      return updateLifeState(deps.storage, this.waifuId, (current) => (current.lastDayStart === undefined ? { ...current, lastDayStart: dayStart } : current));
    }
    if (state.pendingEpochStart && state.pendingEpochReason === "tools") {
      const old = state.modelRoute ? findCuratedModel(state.modelRoute, deps.catalog()) : undefined;
      const outcome = await compactRetiredTools(deps, {
        waifu,
        state,
        lines: await readLifeLog(deps.storage, this.waifuId, state.epoch),
        summaryRoute: old ?? lifeModelOf(deps, waifu),
        ...(state.modelRoute?.effort ? { effort: state.modelRoute.effort } : {}),
        nextHarness: harness,
        omit: { deleted: await this.deletedOmissions(state), people: [] },
        signal
      });
      return outcome.state;
    }
    if (state.pendingEpochStart) return startPendingEpoch(deps, this.waifuId, state, harness);
    const lines = await readLifeLog(deps.storage, this.waifuId, state.epoch);
    if (state.systemSnapshot.harnessHash !== harness.hash) {
      return this.compact(waifu, state, lines, harness, "config", signal);
    }
    const config = deps.config();
    const paused = state.compactionPausedUntil !== undefined && Date.parse(state.compactionPausedUntil) > deps.now().getTime();
    if (paused) return state;
    // She had her rest turn and its compaction was interrupted: compact now, leaving that turn out (§19.4).
    if (state.restTurn?.epoch === state.epoch) return this.compact(waifu, state, lines, harness, "tokens", signal, { openTurnId: state.restTurn.turnId });
    // Her morning turn ended: her new day's plan goes into block A (§21.3), once. An epoch of at most
    // the kept turns (it began this morning: an upgrade's or another compaction's) keeps them whole
    // and its summary: no second summary right after the first.
    if (state.dayCompactionDue) return this.compact(waifu, state, lines, harness, "day", signal, turnCount(lines) <= KEPT_TURNS ? { truncate: true } : {});
    const budget = lifeBudget(model, config.life.maxContextTokens);
    const messageLines = lines.filter((line) => line.message !== null).length;
    if ((state.lastRequestTokens ?? 0) >= config.compaction.triggerRatio * budget) return this.compact(waifu, state, lines, harness, "tokens", signal);
    if (messageLines >= config.life.maxLogMessages) return this.compact(waifu, state, lines, harness, "log_length", signal);
    return state;
  }

  private async compact(
    waifu: WaifuConfig,
    state: LifeState,
    lines: readonly LifeLogLine[],
    harness: HarnessNow,
    reason: string,
    signal: AbortSignal,
    o: { openTurnId?: string; truncate?: boolean } = {}
  ): Promise<LifeState> {
    // A model change compacts with the old model (§5.2); without it, the new one.
    const old = state.modelRoute ? findCuratedModel(state.modelRoute, this.deps.catalog()) : undefined;
    const summaryRoute = old ?? lifeModelOf(this.deps, waifu);
    const outcome = await compactLife(this.deps, {
      waifu,
      state,
      lines,
      summaryRoute,
      ...(state.modelRoute?.effort ? { effort: state.modelRoute.effort } : {}),
      nextHarness: harness,
      reason,
      ...(o.openTurnId ? { openTurnId: o.openTurnId } : {}),
      ...(o.truncate ? { truncate: true } : {}),
      // Over budget: the summary request leaves the last results out instead of resending them (M1).
      ...(reason === "budget" || reason === "overflow" ? { shrinkLastResults: true } : {}),
      omit: { deleted: await this.deletedOmissions(state), people: [] },
      signal
    });
    return outcome.state;
  }

  /** "Kevin's message #k3 in bake-club/#general"-style lines for the summary's omission list. */
  private async deletedOmissions(state: LifeState): Promise<string[]> {
    return state.deletedReadIds.map((id) => `message ${id}`);
  }

  private async turn(signal: AbortSignal): Promise<TurnOutcome> {
    const deps = this.deps;
    if (deps.isPaused()) return "idle";
    const waifu = await readWaifu(deps.storage, this.waifuId).catch(() => undefined);
    if (!waifu?.enabled) return "idle";
    const model = lifeModelOf(deps, waifu);
    if (!model) {
      if (!this.warnedNoModel) deps.logger.warn("Life has no offered model; wakes stay queued", { waifuId: this.waifuId });
      this.warnedNoModel = true;
      return "idle";
    }
    this.warnedNoModel = false;
    let state = await readLifeState(deps.storage, this.waifuId, deps.now());
    const nowMs = deps.now().getTime();
    const followUpDue = state.failedTurn !== undefined && !state.failedTurn.followUpDone && nowMs - Date.parse(state.failedTurn.at) >= FOLLOW_UP_DELAY_MS;
    const queued = await pendingWakeCount(deps.storage, this.waifuId);
    // A rest turn may be due with nothing queued: it follows the turn that filled her memory (§19.2).
    // So may the compaction after her morning turn (§21.3).
    if (queued === 0 && !followUpDue && !this.restDue(state, model) && !state.dayCompactionDue) return "idle";
    // Her provider is cooling down after a quota or billing error: the wakes wait in the queue and
    // she is poked again when the cooldown ends (review I6).
    const cooling = deps.models.cooldownRemainingMs?.(model.providerId);
    if (cooling !== undefined) {
      deps.logger.info("Life waits for a provider cooldown", { category: "life", waifuId: this.waifuId, providerId: model.providerId, waitMs: cooling });
      this.retryAfter(cooling + 1_000);
      return "idle";
    }
    // Her daily budget is spent (wakes queued before it ran out, or a morning batch released over
    // it): every wake but the owner's waits for her next local day, like guard 5 (§4.4).
    const budgetLeftUsd = await this.budgetLeft(waifu);
    if (budgetLeftUsd !== undefined && budgetLeftUsd <= 0) {
      const kept = await deferImmediate(deps.storage, this.waifuId, "budget", deps.now(), (wake) => wake.reason === "owner");
      if (kept === 0) {
        deps.logger.info("Life daily budget reached; wakes deferred", { category: "life", waifuId: this.waifuId });
        return "idle";
      }
    }
    state = await this.prepareEpoch(waifu, model, state, signal);
    // An interrupted compaction (pause, shutdown, a reload) changed nothing; no wakes are taken.
    if (signal.aborted) return "idle";
    // Her memory is nearly full: she rests before any queued wake is delivered (§19.2, R3).
    if (this.restDue(state, model)) return this.restTurn(waifu, model, state, signal, budgetLeftUsd);
    // Read now, removed once her state records them (a crash in between loses none, §4.6).
    const { wakes, quiet } = await peekImmediate(deps.storage, this.waifuId);
    if (wakes.length === 0 && !followUpDue) return "idle";
    // Her places file is current at every turn start (§16.6; unchanged content is not rewritten).
    await refreshPlacesFile(deps, waifu).catch((error: unknown) => {
      deps.logger.warn("Could not refresh places.md", { category: "life", waifuId: this.waifuId, message: error instanceof Error ? error.message : String(error) });
    });
    // And her profile file says what her config says (§17.1; her own layout kept while it agrees).
    await homeStoreFor(deps, waifu).writeProfileFromConfig().catch((error: unknown) => {
      deps.logger.warn("Could not refresh profile.json", { category: "life", waifuId: this.waifuId, message: error instanceof Error ? error.message : String(error) });
    });
    const turnId = newTurnId();
    const selfIds = await selfAuthorIds(deps.storage, waifu);
    const view = await this.notificationView(wakes, quiet.flatMap((line) => (line.placeKey ? [line.placeKey] : [])), selfIds);
    const notices = state.pendingNotices;
    const block = renderNotifications({ wakes, quiet, notices }, view);
    const run: TurnRun = {
      waifu,
      model,
      state,
      lines: await readLifeLog(deps.storage, this.waifuId, state.epoch),
      turnId,
      wakes,
      scratch: { id: turnId, sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
      signal,
      startedMs: nowMs,
      lastEstimate: state.lastRequestTokens ?? 0,
      selfIds,
      ...(budgetLeftUsd !== undefined ? { budgetLeftUsd } : {}),
      spentUsd: 0
    };
    const content: ContentBlockLike[] = [];
    if (followUpDue) content.push({ type: "text", text: FOLLOW_UP_NOTE });
    if (block) content.push({ type: "text", text: block });
    content.push({ type: "text", text: await this.timeLineText(waifu, run.lastEstimate, model) });
    run.state = await updateLifeState(deps.storage, this.waifuId, (current) => ({
      ...current,
      status: "turn",
      currentTurn: { id: turnId, startedAt: deps.now().toISOString(), rounds: 0, wakeIds: wakes.map((wake) => wake.id), wakes },
      pendingNotices: current.pendingNotices.slice(notices.length),
      ...(followUpDue && current.failedTurn ? { failedTurn: { ...current.failedTurn, followUpDone: true } } : {})
    }));
    await takeWakes(deps.storage, this.waifuId, wakes, quiet);
    const dmWakes = wakes.some((wake) => isDmPlaceKey(wake.placeKey)) || quiet.some((line) => isDmPlaceKey(line.placeKey));
    if (dmWakes) run.scratch.dm = true;
    await this.append(run, "notifications", { role: "user", content }, { dmWakes });
    deps.logger.info("Life turn started", { category: "life", waifuId: this.waifuId, turnId, wakes: wakes.length, reasons: [...new Set(wakes.map((wake) => wake.reason))] });
    const keeper = new TypingKeeper(deps, waifu);
    this.typing = keeper;
    run.typing = { keeper, sends: new Map(), lookups: new Map(), ran: new Set() };
    try {
      return await this.rounds(run);
    } finally {
      keeper.stop();
      if (this.typing === keeper) this.typing = undefined;
    }
  }

  /**
   * The rest turn (§19.3): a turn of her life in the current epoch (same system blocks and tools, so
   * the prompt cache holds) opened by the rest notice; no wake is taken or folded in. Her final text
   * becomes the summary her new epoch starts from (§19.4) when it is long enough and the turn ended
   * normally; otherwise compaction summarises for her right away, without this turn. An interrupted
   * rest turn changes nothing and runs again at the next cycle.
   */
  private async restTurn(waifu: WaifuConfig, model: CuratedModel, state: LifeState, signal: AbortSignal, budgetLeftUsd: number | undefined): Promise<TurnOutcome> {
    const deps = this.deps;
    const turnId = newTurnId();
    const selfIds = await selfAuthorIds(deps.storage, waifu);
    const run: TurnRun = {
      waifu,
      model,
      state,
      lines: await readLifeLog(deps.storage, this.waifuId, state.epoch),
      turnId,
      wakes: [],
      scratch: { id: turnId, sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
      signal,
      startedMs: deps.now().getTime(),
      lastEstimate: state.lastRequestTokens ?? 0,
      selfIds,
      ...(budgetLeftUsd !== undefined ? { budgetLeftUsd } : {}),
      spentUsd: 0,
      rest: true
    };
    run.state = await updateLifeState(deps.storage, this.waifuId, (current) => ({
      ...current,
      status: "turn",
      currentTurn: { id: turnId, startedAt: deps.now().toISOString(), rounds: 0, wakeIds: [], wakes: [] }
    }));
    await this.append(run, "notifications", { role: "user", content: [{ type: "text", text: REST_NOTICE }, { type: "text", text: await this.timeLineText(waifu, run.lastEstimate, model) }] }, { dmWakes: false });
    deps.logger.info("Life rest turn started", { category: "life", waifuId: this.waifuId, turnId, tokens: run.lastEstimate });
    let outcome = await this.rounds(run);
    // Interrupted (pause, shutdown, a reload): nothing changes; the rest turn runs again next cycle.
    if (run.endReason === "interrupted" || signal.aborted) return "idle";
    // A provider overflow already compacted for her (the mid-turn path).
    if (run.endReason?.startsWith("compaction:")) return outcome;
    // One rest notice per epoch: should compaction fail too, she is not asked again in this epoch.
    await updateLifeState(deps.storage, this.waifuId, (current) => (current.epoch === state.epoch ? { ...current, restTurn: { epoch: state.epoch, turnId } } : current));
    const summary = (run.finalText ?? "").trim();
    const harness = await currentHarness(deps, waifu, model);
    const current = await readLifeState(deps.storage, this.waifuId);
    if (run.endReason === "done" && summary.length >= Math.max(1, deps.config().life.restSummaryMinChars)) {
      const next = await startEpoch(deps, this.waifuId, { harness, summary: `${REST_SUMMARY_FRAME}\n${summary}`, kept: [], readIds: [], reason: "rest", summarized: true, strippedBlocks: 0 });
      deps.logger.info("Life rested", { category: "life", waifuId: this.waifuId, epoch: next.epoch, summaryChars: summary.length });
    } else {
      // Ignored (too short, failed, capped): compaction as before, leaving the rest turn out (R4).
      deps.logger.info("Life rest notice ignored; compacting", { category: "life", waifuId: this.waifuId, reason: run.endReason, summaryChars: summary.length });
      const lines = await readLifeLog(deps.storage, this.waifuId, current.epoch);
      await this.compact(waifu, current, lines, harness, "tokens", signal, { openTurnId: turnId });
      if (signal.aborted) return "idle";
    }
    outcome = (await pendingWakeCount(deps.storage, this.waifuId)) > 0 ? "again" : "idle";
    return outcome;
  }

  /** A streaming SendMessage's arguments so far: once its `place` is complete, typing starts there (§6.3). */
  private typeWhereSending(run: TurnRun, id: string, delta: string): void {
    const typing = run.typing;
    const sofar = typing?.sends.get(id);
    if (!typing || sofar === undefined || run.signal.aborted) return;
    const argumentsJson = sofar + delta;
    const handle = streamedPlace(argumentsJson);
    if (handle === undefined) {
      typing.sends.set(id, argumentsJson);
      return;
    }
    typing.sends.delete(id);
    const lookup = resolvePlace(this.deps.storage, this.waifuId, handle)
      .then((place) => {
        if (place && run.typing === typing && !typing.ran.has(id) && !run.signal.aborted) typing.keeper.start(place.placeKey);
      })
      .catch(() => undefined);
    typing.lookups.set(id, lookup);
  }

  private async rounds(run: TurnRun): Promise<TurnOutcome> {
    const deps = this.deps;
    const config = () => deps.config();
    // Recomputed each time: a direct wake folded in mid-turn counts too (review I1).
    const direct = () => run.wakes.some((wake) => (wake.reasons ?? [wake.reason]).some((reason) => DIRECT_REASONS.has(reason)));
    // Her daily budget ran out during this turn (owner wakes are exempt, like guard 5).
    const overBudget = () => run.budgetLeftUsd !== undefined && !run.wakes.some((wake) => wake.reason === "owner") && run.spentUsd >= run.budgetLeftUsd;
    let unsentChecked = false;
    let rounds = 0;
    let badRequests = 0;
    // The same calls failing round after round (a model stuck in a loop) end the turn.
    let failedCalls: string | undefined;
    let failedRepeats = 0;
    for (;;) {
      if (run.signal.aborted) return this.closeInterrupted(run);
      let request;
      try {
        request = await buildLifeRequest(deps, { state: run.state, lines: run.lines, route: run.model, signal: run.signal });
      } catch (error) {
        if (error instanceof PinnedImageMissingError) return this.midTurnCompaction(run, "image");
        if (error instanceof ImageBuildAbortedError || run.signal.aborted) return this.closeInterrupted(run);
        throw error;
      }
      deps.images?.setPins?.(this.waifuId, request.imageKeys);
      const ratio = currentCalibration(run.state.tokenCalibration)?.ratio;
      const estimate = estimateRequest(request, ratio);
      run.lastEstimate = estimate;
      const budget = lifeBudget(run.model, config().life.maxContextTokens);
      if (estimate > budget) return this.midTurnCompaction(run, "budget");
      let result;
      const firstCall = run.state.epochStrippedThinkingBlocks !== undefined;
      try {
        result = await deps.models.stream({
          route: { providerId: run.model.providerId, modelId: run.model.modelId },
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          ...(run.waifu.model?.effort ? { effort: run.waifu.model.effort } : {}),
          cacheKey: `life:${this.waifuId}`,
          signal: run.signal,
          timeoutMs: config().life.maxTurnMs,
          ...(firstCall ? { thinkingBlocksStripped: run.state.epochStrippedThinkingBlocks } : {}),
          attribution: { purpose: "life", waifuId: this.waifuId, turnId: run.turnId }
        }, {
          // Only a message on its way shows typing: a SendMessage's place streams first, her text
          // after it. Plain text is her own thoughts and every other tool is work: no typing.
          onToolCallStart: (id, name) => {
            if (name !== "SendMessage" || !run.typing) return;
            run.typing.ran.delete(id); // a provider may reuse ids across rounds
            run.typing.sends.set(id, "");
          },
          onToolCallDelta: (id, delta) => this.typeWhereSending(run, id, delta)
        });
      } catch (error) {
        if (run.signal.aborted || (error instanceof ModelCallError && error.kind === "aborted")) return this.closeInterrupted(run);
        if (error instanceof ModelCallError && error.kind === "context_overflow") return this.midTurnCompaction(run, "overflow");
        if (error instanceof ModelCallError && error.kind === "other" && error.status === 400 && !error.retryable) {
          badRequests += 1;
          if (badRequests >= 2) return this.midTurnCompaction(run, "bad_request", { truncate: true });
          continue;
        }
        return this.failTurn(run, error);
      }
      badRequests = 0;
      await this.append(run, "assistant", result.message);
      rounds += 1;
      if (result.costUsd !== undefined) {
        run.spentUsd += result.costUsd;
        this.host.cost?.add(this.waifuId, result.costUsd, deps.now());
      }
      const raw = estimateRequest(request);
      const usage = result.usage;
      run.state = await updateLifeState(deps.storage, this.waifuId, (current) => {
        const previous = currentCalibration(current.tokenCalibration);
        const calibration = usage
          ? emaTokenCalibration({ ...(previous ? { previous } : {}), promptTokens: promptTokensOf(usage), rawEstimate: raw, imageCount: request.imageCount, now: deps.now() })
          : undefined;
        return {
          ...current,
          ...(calibration ? { tokenCalibration: { ...calibration, estimator: TOKEN_ESTIMATOR_VERSION } } : {}),
          lastRequestTokens: estimate,
          epochStrippedThinkingBlocks: undefined,
          currentTurn: current.currentTurn ? { ...current.currentTurn, rounds } : current.currentTurn
        };
      });
      if (result.finishReason === "refusal") {
        // A refusal in the middle of tool calls: they are closed with error results, so the log
        // never holds an unanswered call (review M8).
        if (result.toolCalls.length > 0) {
          await this.append(
            run,
            "tool_results",
            {
              role: "user",
              content: [
                ...result.toolCalls.map((call) => ({ type: "tool_result" as const, tool_use_id: call.id, content: REFUSED_RESULT, is_error: true })),
                { type: "text", text: await this.timeLineText(run.waifu, estimate, run.model) }
              ]
            },
            { dmCalls: [] }
          );
        }
        return this.endTurn(run, rounds, "refusal");
      }
      const calls = result.toolCalls;
      run.finalText = result.text;
      if (calls.length === 0) {
        // Only `<summary>…</summary>`: she wants a fresh start (§21.6b; the rest turn has its own).
        const summary = run.rest || result.finishReason === "length" ? undefined : selfSummaryOf(result.text);
        // Accepted, it ends the turn; refused, the turn ends as any other (a DM still gets the nudge).
        if (summary !== undefined && !(await this.selfSummaryRefusal(run, summary))) return this.selfSummary(run, rounds, summary);
        if (!unsentChecked && direct() && result.text.trim() && run.scratch.sentPlaces.size === 0 && !overBudget()) {
          unsentChecked = true;
          await this.append(run, "system_note", { role: "user", content: [{ type: "text", text: UNSENT_REPLY_NOTE }, { type: "text", text: await this.timeLineText(run.waifu, estimate, run.model) }] });
          deps.logger.info("Life unsent-reply check", { category: "life", waifuId: this.waifuId, turnId: run.turnId });
          continue;
        }
        return this.endTurn(run, rounds, result.finishReason === "length" ? "length" : "done");
      }
      const executed = await this.runTools(run, calls, result.finishReason === "length");
      const allFailed = executed.results.length > 0 && executed.results.every((block) => (block as { is_error?: boolean }).is_error === true);
      const signature = JSON.stringify(calls.map((call) => [call.name, call.input]));
      failedRepeats = allFailed && signature === failedCalls ? failedRepeats + 1 : 0;
      failedCalls = allFailed ? signature : undefined;
      const capped =
        failedRepeats >= MAX_FAILED_REPEATS
          ? "the same call kept failing"
          : deps.now().getTime() - run.startedMs >= config().life.maxTurnMs
            ? "max turn time"
            : overBudget()
              ? "daily budget reached"
              : undefined;
      // A turn that ends here (capped or interrupted) never folds new wakes in: she could not answer
      // them; they stay queued for her next turn (review I1).
      const wakesBefore = run.wakes.length;
      // The rest turn takes no wake: they wait for her new epoch (§19.2, R3).
      const folded = run.rest || run.signal.aborted || capped || executed.interrupted ? [] : await this.foldWakes(run);
      const dmFolded = run.wakes.slice(wakesBefore).some((wake) => isDmPlaceKey(wake.placeKey));
      if (dmFolded || executed.dmCalls.length > 0) await this.markDmTurn(run);
      const tail: ContentBlockLike[] = [...folded];
      if (capped) tail.push({ type: "text", text: `[system] turn ended: ${capped}` });
      if (executed.interrupted) tail.push({ type: "text", text: "[system] interrupted" });
      tail.push({ type: "text", text: await this.timeLineText(run.waifu, estimate, run.model) });
      await this.append(run, "tool_results", { role: "user", content: [...executed.results, ...tail] }, { messageIds: executed.messageIds, dmCalls: executed.dmCalls, ...(folded.length > 0 ? { dmWakes: dmFolded } : {}) });
      if (executed.interrupted) return this.endInterrupted(run, rounds);
      if (capped) return this.endTurn(run, rounds, capped);
    }
  }

  private async runTools(run: TurnRun, calls: Array<{ id: string; name: string; input: unknown }>, cutOff: boolean): Promise<{ results: ContentBlockLike[]; messageIds: Record<string, string[]>; dmCalls: string[]; interrupted: boolean }> {
    const deps = this.deps;
    const results: ContentBlockLike[] = [];
    const messageIds: Record<string, string[]> = {};
    const dmCalls: string[] = [];
    const offered = new Set(run.state.systemSnapshot?.tools ?? []);
    let interrupted = false;
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      if (interrupted || run.signal.aborted) {
        interrupted = true;
        results.push({ type: "tool_result", tool_use_id: call.id, content: INTERRUPTED_RESULT, is_error: true });
        continue;
      }
      if (cutOff && index === calls.length - 1) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: CUT_OFF_RESULT, is_error: true });
        continue;
      }
      const tool = offered.has(call.name) ? lifeTool(call.name) : undefined;
      // Its place lookup (milliseconds) settles first, so typing never starts after the send.
      await run.typing?.lookups.get(call.id);
      run.typing?.lookups.delete(call.id);
      run.typing?.ran.add(call.id);
      run.typing?.sends.delete(call.id);
      let places: ReadonlySet<string> = new Set();
      let output: ToolOutput;
      if (!tool) {
        output = toolError(`there is no tool called ${call.name}`);
      } else if (run.rest && REST_REFUSED_TOOLS.has(call.name)) {
        // Offered (the cached prefix stays the same), refused at run time (§19.3).
        output = toolError(REST_REFUSED_RESULT);
      } else {
        const argsDigest = createHash("sha256").update(JSON.stringify(call.input ?? {})).digest("hex").slice(0, 32);
        if (tool.sideEffect) await appendIntent(deps.storage, this.waifuId, { turnId: run.turnId, toolCallId: call.id, tool: call.name, argsDigest, at: deps.now().toISOString() });
        try {
          const recorded = await withPlaceRecord(() => tool.run(call.input, {
            deps,
            waifu: run.waifu,
            route: run.model,
            turn: run.scratch,
            signal: run.signal,
            toolCallId: call.id,
            selfAuthorIds: run.selfIds,
            toolNames: run.state.systemSnapshot?.tools ?? [],
            ...(tool.sideEffect ? { intent: { turnId: run.turnId, toolCallId: call.id, tool: call.name, argsDigest } } : {})
          }));
          output = recorded.value;
          places = recorded.places;
          // D14 (spec §14.4): the owner's views hide a call that resolved to (or named) a DM place.
          if ([...recorded.places].some(isDmPlaceKey)) dmCalls.push(call.id);
        } catch (error) {
          if (error instanceof ImageBuildAbortedError || run.signal.aborted) {
            interrupted = true;
            results.push({ type: "tool_result", tool_use_id: call.id, content: INTERRUPTED_RESULT, is_error: true });
            continue;
          }
          deps.logger.warn("Life tool failed", { waifuId: this.waifuId, tool: call.name, message: error instanceof Error ? error.message : String(error) });
          output = toolError("something went wrong");
        }
        if (tool.sideEffect) {
          await appendIntent(deps.storage, this.waifuId, {
            turnId: run.turnId,
            toolCallId: call.id,
            tool: call.name,
            argsDigest,
            at: deps.now().toISOString(),
            done: true,
            ...(output.resultRef ? { resultRef: output.resultRef } : {})
          });
        }
      }
      if (run.typing && tool && !output.isError && call.name === "SendMessage") {
        for (const place of places) run.typing.keeper.sent(place);
      }
      // Her last send starts her bed time clock again (§21.6c); while she is busy, a place she answers
      // in after a wake that got through stays open (§21.4).
      if (tool && !output.isError && call.name === "SendMessage") {
        for (const place of places) {
          await noteSend(deps, run.waifu, place, run.wakes).catch((error: unknown) => {
            deps.logger.warn("Could not note a send", { category: "life", waifuId: this.waifuId, message: error instanceof Error ? error.message : String(error) });
          });
        }
      }
      if (output.messageIds?.length) messageIds[call.id] = output.messageIds;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: output.content as ContentBlockLike[] | string,
        ...(output.isError ? { is_error: true } : {})
      });
    }
    return { results, messageIds, dmCalls, interrupted };
  }

  /**
   * Wakes that became ready during a turn (§4.6, §5.2) are folded into the tool-results message of
   * the round that just ran, after its results: the same `<notifications>` block (with refs) as a
   * turn's first message. Only between rounds, never inside a model call or a tool call; each wake is
   * recorded in the open turn before it leaves the queue, so it is shown once and survives a crash.
   */
  private async foldWakes(run: TurnRun): Promise<ContentBlockLike[]> {
    const deps = this.deps;
    // Her morning wake opens a turn of its own (§21.3: compacted after it): it waits for the next one.
    const { wakes: ready, quiet } = await peekImmediate(deps.storage, this.waifuId);
    const wakes = ready.filter((wake) => wake.day === undefined);
    const state = await readLifeState(deps.storage, this.waifuId);
    const notices = state.pendingNotices;
    if (wakes.length === 0 && quiet.length === 0 && notices.length === 0) return [];
    // A folded wake can name a place that is new since the turn began (a first DM): the turn's
    // cached place list is read again, so the notification, places.md and the tools all see it (N2).
    const cached = await collectPlaces(deps.storage, this.waifuId);
    if (wakes.some((wake) => wake.placeKey && !cached.some((place) => place.placeKey === wake.placeKey))) {
      refreshPlaces(deps.storage, this.waifuId);
      await refreshPlacesFile(deps, run.waifu).catch(() => undefined);
    }
    const view = await this.notificationView(wakes, quiet.flatMap((line) => (line.placeKey ? [line.placeKey] : [])), run.selfIds);
    const block = renderNotifications({ wakes, quiet, notices }, view);
    run.wakes.push(...wakes);
    run.state = await updateLifeState(deps.storage, this.waifuId, (current) => ({
      ...current,
      pendingNotices: current.pendingNotices.slice(notices.length),
      currentTurn: current.currentTurn
        ? { ...current.currentTurn, wakeIds: [...current.currentTurn.wakeIds, ...wakes.map((wake) => wake.id)], wakes: [...current.currentTurn.wakes, ...wakes] }
        : current.currentTurn
    }));
    await takeWakes(deps.storage, this.waifuId, wakes, quiet);
    return block ? [{ type: "text", text: block }] : [];
  }

  private async finishIdle(run: TurnRun, rounds: number, reason: string): Promise<TurnOutcome> {
    const deps = this.deps;
    // Her morning turn ended (§21.3): the next cycle compacts with reason `day`, so block A shows
    // today's plan, written or not. An interrupted turn (its wakes go back) or one cut short by a
    // compaction (a new epoch already) asks again.
    const morning = reason !== "interrupted" && !reason.startsWith("compaction:") && run.wakes.some((wake) => wake.day !== undefined);
    run.state = await updateLifeState(deps.storage, this.waifuId, (current) => ({
      ...current,
      status: "idle",
      currentTurn: undefined,
      lastTurnEndedAt: deps.now().toISOString(),
      ...(morning ? { dayCompactionDue: true } : {})
    }));
    await compactIntents(deps.storage, this.waifuId, new Set()).catch(() => undefined);
    this.host.hooks?.onTurnEnd?.(this.waifuId, { turnId: run.turnId, rounds, reason, sent: run.scratch.sentPlaces.size > 0 });
    deps.logger.info("Life turn ended", { category: "life", waifuId: this.waifuId, turnId: run.turnId, rounds, reason, sent: run.scratch.sentPlaces.size > 0 });
    run.endReason = reason;
    if (reason === "interrupted") return "idle";
    if (morning) return "again";
    // Her memory is nearly full: the next cycle is her rest turn, before any queued wake (§19.2).
    if (!run.rest && this.restDue(run.state, run.model)) return "again";
    return (await pendingWakeCount(deps.storage, this.waifuId)) > 0 ? "again" : "idle";
  }

  private endTurn(run: TurnRun, rounds: number, reason: string): Promise<TurnOutcome> {
    return this.finishIdle(run, rounds, reason);
  }

  /**
   * §5.2 errors: a logged error line, the wakes stay consumed, and one follow-up turn after 60 s
   * (none when the failed turn was itself the follow-up).
   */
  private async failTurn(run: TurnRun, error: unknown): Promise<TurnOutcome> {
    const deps = this.deps;
    const kind = error instanceof ModelCallError ? error.kind : "other";
    deps.logger.warn("Life model call failed", { waifuId: this.waifuId, turnId: run.turnId, kind, message: error instanceof Error ? error.message : String(error) });
    await this.append(run, "system_note", {
      role: "user",
      content: [
        { type: "text", text: `[system] error: ${kind === "other" ? "the call failed" : kind.replace("_", " ")}` },
        { type: "text", text: await this.timeLineText(run.waifu, run.lastEstimate, run.model) }
      ]
    });
    // Quota or billing: the provider cools down. Her wakes were never answered, so they go back to
    // the queue and wait for the cooldown instead of a follow-up (review I6).
    const cooling = COOLDOWN_KINDS.has(kind) ? deps.models.cooldownRemainingMs?.(run.model.providerId) : undefined;
    if (cooling !== undefined) {
      await requeueWakes(deps.storage, this.waifuId, run.wakes);
      await this.finishIdle(run, 0, "error");
      this.retryAfter(cooling + 1_000);
      return "idle";
    }
    const wasFollowUp = run.wakes.length === 0;
    const now = deps.now();
    await updateLifeState(deps.storage, this.waifuId, (current) => ({
      ...current,
      failedTurn: wasFollowUp ? { at: current.failedTurn?.at ?? now.toISOString(), followUpDone: true } : { at: now.toISOString(), followUpDone: false }
    }));
    if (!wasFollowUp) this.scheduleFollowUp(FOLLOW_UP_DELAY_MS);
    await this.finishIdle(run, 0, "error");
    return "idle";
  }

  private scheduleFollowUp(ms: number): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = undefined;
      this.poke({ delayMs: 0 });
    }, ms);
    this.followUpTimer.unref?.();
  }

  /**
   * An interrupted turn (pause, shutdown, a reload, a forget, an aborted tool) ends; its wakes go
   * back to the queue, so nothing she was woken for is lost (review I4). A forget's scrub then
   * removes the forgotten person's wakes from the queue like any others.
   */
  private async endInterrupted(run: TurnRun, rounds: number): Promise<TurnOutcome> {
    await requeueWakes(this.deps.storage, this.waifuId, run.wakes);
    return this.finishIdle(run, rounds, "interrupted");
  }

  /** Abort: unanswered tool calls get `[interrupted]` results, then `[system] interrupted` (§5.2). */
  private async closeInterrupted(run: TurnRun): Promise<TurnOutcome> {
    const last = run.lines[run.lines.length - 1];
    const timeText = await this.timeLineText(run.waifu, run.lastEstimate, run.model);
    const message = (last?.message ?? undefined) as unknown as ProviderMessageLike | undefined;
    if (last?.kind === "assistant" && message && Array.isArray(message.content)) {
      const open = message.content.filter((block): block is Extract<ContentBlockLike, { type: "tool_use" }> => block.type === "tool_use");
      if (open.length > 0) {
        await this.append(run, "tool_results", {
          role: "user",
          content: [
            ...open.map((call) => ({ type: "tool_result" as const, tool_use_id: call.id, content: INTERRUPTED_RESULT, is_error: true })),
            { type: "text", text: "[system] interrupted" },
            { type: "text", text: timeText }
          ]
        });
        return this.endInterrupted(run, 0);
      }
    }
    await this.append(run, "system_note", { role: "user", content: [{ type: "text", text: "[system] interrupted" }, { type: "text", text: timeText }] });
    return this.endInterrupted(run, 0);
  }

  /**
   * §5.6 mid-turn overflow: close the open turn (`[system] memory summarised`), compact, then continue
   * in a new turn whose notifications repeat the open turn's wakes.
   */
  private async midTurnCompaction(run: TurnRun, reason: string, o: { truncate?: boolean } = {}): Promise<TurnOutcome> {
    const deps = this.deps;
    // Nobody sees a compaction: no typing while it runs.
    run.typing?.keeper.stop();
    run.typing?.sends.clear();
    this.compactionsThisCycle += 1;
    await this.append(run, "system_note", { role: "user", content: [{ type: "text", text: MEMORY_SUMMARISED_NOTE }, { type: "text", text: await this.timeLineText(run.waifu, run.lastEstimate, run.model) }] });
    await this.finishIdle(run, 0, `compaction:${reason}`);
    if (this.compactionsThisCycle > 1) {
      // A fresh epoch overflowed again: compaction cannot help this turn.
      deps.logger.warn("Life request still over budget after a compaction; dropping the turn", { waifuId: this.waifuId, reason });
      return "idle";
    }
    const harness = await currentHarness(deps, run.waifu, run.model);
    const state = await readLifeState(deps.storage, this.waifuId);
    await this.compact(run.waifu, state, run.lines, harness, reason, run.signal, { openTurnId: run.turnId, ...(o.truncate ? { truncate: true } : {}) });
    // The open turn's wakes come back as the next turn's notifications.
    await requeueWakes(deps.storage, this.waifuId, run.wakes);
    // An interrupted compaction changed nothing: the wakes wait for the next cycle.
    return run.signal.aborted ? "idle" : "again";
  }
}
