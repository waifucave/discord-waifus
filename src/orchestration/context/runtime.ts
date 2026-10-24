// ContextRuntime (spec 8.3 runtime seam): the one entry point the reply / orchestrator / background
// paths use to obtain a cache-stable prompt for (agent, conversation).
//
// prepare: load state → fetch since the newest ledger entry (first fetch of an epoch bounded by
// backfillCap) → reconcile ledger → assign refs → epoch start if headerText is null (freeze
// timeZone, memory snapshot, header; reset image counters) → propose memory notes → BUILD →
// compaction.check → (join inFlight ≤ waitTimeoutMs or compact; rebuild; on timeout a one-off hard
// truncation) → in ONE write: seal rendered entries, persist edit + memory notes + image modes,
// update lastUsedAt.
// call:   context_overflow → forced compact + rebuild + retry once (a second overflow surfaces;
//         a failed compaction surfaces the original overflow).
// commit: stores the request's breakpoint C as lastBreakpoint, appends post-call notes, runs the
//         calibration hook with the returned usage, then a post-reply background compaction check
//         (spec 8.9) so the next turn rarely has to wait.
// compactNow: manual compaction (spec 10.4 / 11.6).

import type { ResolvedModel, Usage } from "@waifucave/gateway";
import type { Logger } from "../../backend/logger.js";
import type { ImageFetcher } from "../../discord/attachments.js";
import type { MemoryConfig } from "../../shared/schemas/config.js";
import { DEFAULT_APP_CONFIG } from "../../shared/schemas/config.js";
import type { ContextNote, ContextState, LedgerEntry } from "../../shared/schemas/context.js";
import type { ImageRef } from "../../shared/schemas/discordMessage.js";
import type { ServerConfig } from "../../shared/schemas/domain.js";
import { buildContext, modelKeyFor } from "./builder.js";
import type { ContextEngineStore } from "./contextStore.js";
import { FrozenImageRenderer, type OcrTextLookup } from "./images.js";
import { effectiveKeepRecent, entryTokens, isContextOverflowError, nextEpochState } from "./compaction.js";
import { contextAgentId, conversationKey, type ContextAgent, type ConversationKey, type ConversationRef } from "./keys.js";
import {
  ACTIVE_CONTEXT_MS,
  entryRenderHash,
  isGapEntry,
  newestMessageEntry,
  newestSeq,
  orderedEntries
} from "./ledger.js";
import { discordMessageRenderer, EMPTY_GUILD_DIRECTORY } from "./messageRender.js";
import { hostTimeZone } from "./timeFormat.js";
import { estimateTokens, resolveTokenBudget } from "./tokens.js";
import { NoopCompaction } from "./types.js";
import type {
  BuiltPrompt,
  CompactionOutcome,
  CompactionService,
  CompactionSettings,
  CompactionTrigger,
  ConversationMessageSource,
  GuildDirectoryView,
  MemorySnapshotProvider,
  MessageRenderer,
  NewContextNote,
  Participant,
  PreparedContext,
  RoleRenderer,
  Summarize,
  TokenBudget
} from "./types.js";

export { isContextOverflowError };

export type CalibrationHook = (i: {
  state: ContextState;
  prompt: BuiltPrompt;
  /** Uncalibrated estimate (ratio 1) of the prompt that was sent. */
  rawEstimate: number;
  usage: Usage;
  modelKey: string;
  now: Date;
}) => ContextState["tokenCalibration"] | undefined;

export type ContextRuntimeDeps = {
  store: ContextEngineStore;
  snapshots: MemorySnapshotProvider;
  compaction: CompactionService;
  messages: ConversationMessageSource;
  images: ImageFetcher;
  settings: (server?: ServerConfig) => CompactionSettings;
  logger: Logger;
  /** Additive (all optional): */
  renderer?: MessageRenderer;
  memory?: () => MemoryConfig;
  ocr?: OcrTextLookup;
  /** Max wait for OCR of a not-yet-frozen image when the model cannot take images (default 4 s). */
  ocrTimeoutMs?: number;
  now?: () => Date;
  timeZone?: () => string;
  /** T7b plugs per-model calibration (EMA, spec 8.9) in here; default: none. */
  calibrate?: CalibrationHook;
  /** Single-message refetch for an expired signed image URL (spec 8.4). */
  refreshImageUrl?: (conversation: ConversationRef, entry: LedgerEntry, ref: ImageRef) => Promise<string | undefined>;
};

export type PrepareInput = {
  conversation: ConversationRef;
  agent: ContextAgent;
  model: ResolvedModel;
  backfillCap: number;
  selfAuthorIds: string[];
  render: RoleRenderer;
  signal?: AbortSignal;
  /** Additive (all optional): */
  params?: Record<string, unknown>; // token budget (maxOutputTokens)
  server?: ServerConfig; // compaction settings override
  directory?: GuildDirectoryView; // mention/role/channel/emoji names for new ledger entries
  /** The agent's own-model summarizer (gatewayPipeline.summarizeContext); compaction needs it. */
  summarize?: Summarize;
  waifuIdForAuthor?: (authorId: string) => string | undefined;
  memoryLimit?: number; // snapshot size (memoryInjectionLimit), default 12
  /**
   * Tail lines for recent reactions (spec 9.4), never part of the cached prefix. A function is
   * evaluated per build with the message refs and the entries being rendered, because a line like
   * `Kevin reacted 😂 to #k3` needs the refs that only exist once the ledger is reconciled.
   */
  recentReactions?: string[] | ((c: { refs: ReadonlyMap<string, string>; transcript: readonly LedgerEntry[] }) => string[]);
  /** Additive (T3): user ids the caller considers present; frozen with the epoch alongside the window's authors. */
  participantIds?: string[];
  renderToolTurnsAsText?: boolean; // default: true when render.tools() is empty
  /**
   * Entries kept when a context WITHOUT a summarizer outgrows its limits (durable truncation;
   * default: the effective keepRecent). A small-window agent such as the one-shot director
   * passes its own window.
   */
  truncateKeep?: number;
};

/** What a PreparedContext's prompt was built from (a compaction may have moved the stored state since). */
type Internal = { input: PrepareInput; key: ConversationKey; builtEpoch: number; builtCursorSeq: number | null };

const DEFAULT_MEMORY_LIMIT = 12;
/** Fetch cap for the shared ledger (spec 8.3 review): independent of any one agent's backfillCap. */
export const CONVERSATION_FETCH_CAP = 200;
const MAX_PREPARE_CONFLICTS = 2;

class PrepareAbortedError extends Error {
  override name = "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new PrepareAbortedError("Context prepare aborted.");
}

function participantsOf(
  entries: readonly LedgerEntry[],
  selfAuthorIds: readonly string[],
  waifuIdForAuthor: ((authorId: string) => string | undefined) | undefined
): Array<Participant & { firstSeq: number }> {
  const out = new Map<string, Participant & { firstSeq: number }>();
  for (const entry of entries) {
    if (isGapEntry(entry) || selfAuthorIds.includes(entry.authorId) || out.has(entry.authorId)) continue;
    const waifuId = waifuIdForAuthor?.(entry.authorId);
    out.set(entry.authorId, {
      discordUserId: entry.authorId,
      ...(waifuId ? { waifuId } : {}),
      displayName: entry.authorName,
      isHuman: !entry.authorIsBot,
      firstSeq: entry.seq
    });
  }
  return [...out.values()];
}

function stripFirstSeq(p: Participant & { firstSeq: number }): Participant {
  const { firstSeq: _seq, ...rest } = p;
  return rest;
}

function materializeNotes(state: ContextState, notes: readonly NewContextNote[], anchorSeq: number): ContextNote[] {
  let seq = state.noteSeq;
  return notes.map((note) => {
    seq += 1;
    return { ...note, id: `n${seq}`, seq, anchorSeq } as ContextNote;
  });
}

type BreakpointAddress = ContextState["lastBreakpoint"];

/** Transcript position of a block address: an entry, then the notes anchored after it by seq. */
function breakpointPosition(state: ContextState, address: NonNullable<BreakpointAddress>): [number, number] | undefined {
  if (address.kind === "entry") return [address.seq, -1];
  const note = state.notes.find((candidate) => candidate.seq === address.seq);
  return note ? [note.anchorSeq, note.seq] : undefined;
}

/** True when `next` is at or after `current` in the transcript (or `current` cannot be placed). */
export function breakpointAtOrAfter(state: ContextState, next: BreakpointAddress, current: BreakpointAddress): boolean {
  if (!next) return false;
  if (!current) return true;
  const a = breakpointPosition(state, next);
  const b = breakpointPosition(state, current);
  if (!a || !b) return true;
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<"done" | "timeout" | "failed" | "aborted"> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => "done" as const,
        () => "failed" as const
      ),
      new Promise<"timeout" | "aborted">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
        onAbort = () => resolve("aborted");
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export class ContextRuntime {
  private readonly internals = new WeakMap<PreparedContext, Internal>();
  private readonly now: () => Date;
  private readonly timeZone: () => string;
  private readonly renderer: MessageRenderer;
  private readonly warnedNoSummarize = new Set<string>();

  constructor(private readonly d: ContextRuntimeDeps) {
    this.now = d.now ?? (() => new Date());
    this.timeZone = d.timeZone ?? hostTimeZone;
    this.renderer = d.renderer ?? discordMessageRenderer;
  }

  async prepare(i: PrepareInput): Promise<PreparedContext> {
    return this.prepareInternal(i, true);
  }

  async call<T>(p: PreparedContext, fn: (prompt: BuiltPrompt) => Promise<T>): Promise<T> {
    try {
      return await fn(p.prompt);
    } catch (error) {
      if (!isContextOverflowError(error)) throw error;
      const internal = this.internals.get(p);
      if (!internal) throw error;
      const i = internal.input;
      const settings = this.d.settings(i.server);
      let truncate = false;
      const current = await this.d.store.load(internal.key, p.agent);
      // A compaction that moved the epoch/cursor since this prompt was built already did the work:
      // just rebuild on it. Otherwise compact (overflow → reduced summarize prompt), waiting at most
      // waitTimeoutMs (spec 6.6: a reply never waits longer); on timeout, failure or nothing to
      // compact, retry once with a hard-truncated rebuild instead.
      if (current.epoch === internal.builtEpoch && current.cursorSeq === internal.builtCursorSeq) {
        if (!i.summarize || !settings.enabled) {
          truncate = true;
        } else {
          this.d.logger.warn("Context overflow; compacting and retrying once", { conversationKey: internal.key });
          let result: CompactionOutcome | void = undefined;
          const running = this.d.compaction
            .compact({
              conversation: p.conversation,
              agent: p.agent,
              prompt: p.prompt,
              trigger: "overflow",
              summarize: i.summarize,
              settings,
              budget: resolveTokenBudget(i.model, i.params ?? {}, settings),
              selfAuthorIds: i.selfAuthorIds
              // no signal: the compaction outlives this reply; the wait below honours the signal
            })
            .then((r) => {
              result = r;
            });
          running.catch((compactionError: unknown) => {
            this.d.logger.warn("Compaction after a context overflow failed", {
              conversationKey: internal.key,
              message: compactionError instanceof Error ? compactionError.message : String(compactionError)
            });
          });
          const outcome = await withTimeout(running, settings.waitTimeoutMs, i.signal);
          if (outcome === "aborted") throwIfAborted(i.signal);
          const compacted = outcome === "done" && (result as CompactionOutcome | void)?.status !== "skipped";
          if (!compacted) {
            truncate = true;
            this.d.logger.warn("Overflow compaction unavailable in time; retrying with a hard-truncated prompt", {
              conversationKey: internal.key,
              outcome
            });
          }
        }
      }
      const rebuilt = await this.prepareInternal(i, false, truncate);
      Object.assign(p, rebuilt);
      this.internals.set(p, this.internals.get(rebuilt)!);
      return fn(p.prompt);
    }
  }

  /**
   * `sentPrompt` (additive, T3): the prompt actually sent when it differs from `p.prompt` only in
   * its ephemeral tail (a retry note); calibration measures against it.
   */
  async commit(
    p: PreparedContext,
    o: { notes?: NewContextNote[]; usage?: Usage; modelKey: string; sentPrompt?: BuiltPrompt }
  ): Promise<void> {
    const sent = o.sentPrompt ?? p.prompt;
    const now = this.now();
    const rawEstimate = estimateTokens(sent.messages, sent.tools);
    const internal = this.internals.get(p);
    const builtEpoch = internal?.builtEpoch ?? p.state.epoch;
    const builtCursorSeq = internal ? internal.builtCursorSeq : p.state.cursorSeq;
    const transform = (current: ContextState, anchorSeq: number): ContextState => {
      const notes = materializeNotes(current, o.notes ?? [], anchorSeq);
      const sameBasis = current.epoch === builtEpoch && current.cursorSeq === builtCursorSeq;
      let next: ContextState = {
        ...current,
        lastUsedAt: now.toISOString(),
        // The prompt's C address only means something in the epoch/cursor it was built on; a
        // compaction that landed meanwhile (even during prepare) started a new one. It only ever
        // moves forward: a run that commits late (e.g. after an abort) never moves it back.
        lastBreakpoint:
          sameBasis && breakpointAtOrAfter(current, p.prompt.breakpoint, current.lastBreakpoint)
            ? p.prompt.breakpoint
            : current.lastBreakpoint,
        notes: [...current.notes, ...notes],
        noteSeq: current.noteSeq + notes.length
      };
      if (o.usage && this.d.calibrate) {
        const calibration = this.d.calibrate({
          state: next,
          prompt: sent,
          rawEstimate,
          usage: o.usage,
          modelKey: o.modelKey,
          now
        });
        if (calibration) next = { ...next, tokenCalibration: calibration };
      }
      return next;
    };
    // Notes anchor to the newest ledger entry; read it under the same locks as the state write so
    // an entry reconciled concurrently can never end up after a note anchored "before" it.
    let committed: ContextState;
    if (o.notes?.length && this.d.store.updateAnchored) {
      committed = await this.d.store.updateAnchored(p.key, p.agent, transform);
    } else {
      const anchorSeq = o.notes?.length ? newestSeq(await this.d.store.loadLedger(p.key)) : 0;
      committed = await this.d.store.update(p.key, p.agent, (current) => transform(current, anchorSeq));
    }
    this.backgroundCheck(p, committed, o.usage);
  }

  /** Stable per-conversation refs for message ids (assigned on first use; spec 8.1). */
  async assignRefs(conversation: ConversationRef, messageIds: string[]): Promise<Map<string, string>> {
    if (messageIds.length === 0) return new Map();
    return this.d.store.assignRefs(conversationKey(conversation), messageIds);
  }

  /**
   * Manual compaction (spec 10.4 / 11.6): prepares the context (no automatic compaction) and
   * compacts it with trigger `manual`, waiting for the result. Needs `i.summarize`.
   */
  async compactNow(i: PrepareInput): Promise<CompactionOutcome> {
    if (!i.summarize) throw new Error("compactNow needs the agent's summarize function.");
    const p = await this.prepareInternal(i, false);
    const settings = this.d.settings(i.server);
    const outcome = await this.d.compaction.compact({
      conversation: p.conversation,
      agent: p.agent,
      prompt: p.prompt,
      trigger: "manual",
      summarize: i.summarize,
      settings,
      signal: i.signal,
      basedOn: p.state,
      budget: resolveTokenBudget(i.model, i.params ?? {}, settings),
      selfAuthorIds: i.selfAuthorIds
    });
    return outcome ?? { status: "skipped", reason: "compaction is not available" };
  }

  /**
   * Post-reply check (spec 8.9): when the request just sent is already over the budget (by the
   * estimate or by the provider's reported input tokens) or the message limit, compaction starts
   * in the background so the next prepare finds the new epoch instead of waiting for it.
   */
  private backgroundCheck(p: PreparedContext, committed: ContextState, usage: Usage | undefined): void {
    const internal = this.internals.get(p);
    const summarize = internal?.input.summarize;
    // Only on the epoch/cursor the prompt was built on: a stale prompt would re-compact (and
    // discard) a summary that just landed.
    if (!internal || !summarize) return;
    if (committed.epoch !== internal.builtEpoch || committed.cursorSeq !== internal.builtCursorSeq) return;
    if (this.d.compaction.inFlight(internal.key, p.agent)) return;
    const settings = this.d.settings(internal.input.server);
    if (!settings.enabled) return;
    const prompt: BuiltPrompt = { ...p.prompt, estimatedTokens: Math.max(p.prompt.estimatedTokens, usage?.inputTokens ?? 0) };
    const budget = resolveTokenBudget(internal.input.model, internal.input.params ?? {}, settings);
    const trigger = this.d.compaction.check({ state: committed, prompt, budget, settings });
    if (!trigger) return;
    this.d.compaction
      .compact({
        conversation: p.conversation,
        agent: p.agent,
        prompt: p.prompt,
        trigger,
        summarize,
        settings,
        basedOn: committed,
        budget,
        selfAuthorIds: internal.input.selfAuthorIds
      })
      .catch((error: unknown) => {
        this.d.logger.warn("Background context compaction failed", {
          conversationKey: internal.key,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private async ledgerView(key: ConversationKey) {
    const ledger = await this.d.store.loadLedger(key);
    const all = orderedEntries(ledger);
    const refs = await this.d.store.assignRefs(
      key,
      all.filter((entry) => !isGapEntry(entry)).map((entry) => entry.id)
    );
    const byId = new Map(all.map((entry) => [entry.id, entry]));
    return {
      all,
      events: ledger.events,
      refs,
      lookup: (id: string) => byId.get(id),
      // Notes created now anchor to the NEWEST ledger entry (`all` is in seq order).
      anchorSeq: all.length > 0 ? all[all.length - 1]!.seq : 0
    };
  }

  private isFresh(state: ContextState, now: Date): boolean {
    return state.revision === 0 || now.getTime() - Date.parse(state.lastUsedAt) > ACTIVE_CONTEXT_MS;
  }

  private async prepareInternal(i: PrepareInput, allowCompaction: boolean, forceTruncate = false): Promise<PreparedContext> {
    const startedAt = this.now();
    const key = conversationKey(i.conversation);
    throwIfAborted(i.signal);
    if (!i.summarize && this.d.compaction !== NoopCompaction) {
      const id = `${key}|${contextAgentId(i.agent)}`;
      if (!this.warnedNoSummarize.has(id)) {
        this.warnedNoSummarize.add(id);
        this.d.logger.warn("Context prepared without a summarize function; it truncates instead of summarizing", {
          conversationKey: key,
          agentId: contextAgentId(i.agent)
        });
      }
    }

    // 1. load state
    const loaded = await this.d.store.load(key, i.agent);
    const fresh = this.isFresh(loaded, startedAt);
    const timeZone = fresh || loaded.headerText === null ? this.timeZone() : loaded.timeZone;

    // 2. fetch since the newest ledger entry (not the cursor). The ledger is shared by every agent
    // of the conversation, so the fetch uses a conversation-level cap: a small-cap agent preparing
    // first after a burst must not write a permanent gap the others then inherit. backfillCap only
    // cuts the window of a new epoch (startEpochIfNeeded).
    const before = await this.d.store.loadLedger(key);
    const newest = newestMessageEntry(before);
    const fetched = await this.d.messages.fetchSince({
      conversation: i.conversation,
      afterMessageId: newest?.id ?? null,
      maxMessages: Math.max(1, i.backfillCap, CONVERSATION_FETCH_CAP),
      signal: i.signal
    });
    throwIfAborted(i.signal);
    const hasNew = fetched.messages.some((m) => before.entries[m.id] === undefined);
    const gap = !fetched.reachedCursor && newest !== undefined && hasNew;
    if (gap) {
      this.d.logger.info("More new messages than the fetch cap; earlier ones were not loaded", {
        conversationKey: key,
        fetched: fetched.messages.length
      });
    }

    // 3. reconcile ledger, 4. assign refs (shared by every agent, in seq order)
    await this.d.store.reconcileLedger(key, fetched.messages, this.renderer, {
      dir: i.directory ?? EMPTY_GUILD_DIRECTORY,
      timeZone,
      gapBeforeNew: gap
    });
    let view = await this.ledgerView(key);

    let state = loaded;
    let isFresh = fresh;
    let compacted = false;
    let truncatedDurably = false;
    let conflicts = 0;
    for (;;) {
      // 5. epoch start
      const epoch = await this.startEpochIfNeeded(state, { i, fresh: isFresh, all: view.all, timeZone, now: startedAt });
      const working = epoch.state;
      const transcript = view.all.filter((entry) => working.cursorSeq === null || entry.seq > working.cursorSeq);

      // 6. notes: ledger edit events this context has not seen yet (one counter with every other
      // note) and memory notes (mid-epoch only — the snapshot covers whoever is present at epoch
      // start). A turn's direction and tool notes are appended by commit, after the call.
      const seenEvents = new Set(working.notes.flatMap((note) => (note.kind === "edit" ? [note.eventSeq] : [])));
      const cursor = working.cursorSeq ?? -1;
      const edits: NewContextNote[] = [];
      for (const event of view.events) {
        if (event.kind !== "edit" || event.anchorSeq <= cursor || seenEvents.has(event.seq)) continue;
        edits.push({
          kind: "edit",
          eventSeq: event.seq,
          messageId: event.messageId,
          authorName: view.lookup(event.messageId)?.authorName ?? "",
          text: event.text
        });
      }
      const memoryNotes = epoch.started ? [] : await this.proposeMemoryNotes(working, transcript, i, startedAt);
      const newNotes = materializeNotes(working, [...edits, ...memoryNotes], view.anchorSeq);
      const withNotes: ContextState = {
        ...working,
        notes: [...working.notes, ...newNotes],
        noteSeq: working.noteSeq + newNotes.length,
        memoryNoteCount: working.memoryNoteCount + memoryNotes.length
      };

      // 7. build
      const images = this.frozenImages(i);
      const tools = i.render.tools();
      const currentView = view;
      const buildFor = (s: ContextState, entries: LedgerEntry[]) =>
        buildContext(
          {
            conversation: i.conversation,
            agent: i.agent,
            model: i.model,
            state: s,
            systemText: i.render.system(),
            headerText: s.headerText ?? "",
            transcript: entries,
            selfAuthorIds: i.selfAuthorIds,
            refs: currentView.refs,
            tail: i.render.tail(s, startedAt, {
              recentReactions:
                typeof i.recentReactions === "function"
                  ? i.recentReactions({ refs: currentView.refs, transcript: entries })
                  : i.recentReactions,
              transcript: entries
            }),
            tools,
            renderToolTurnsAsText: i.renderToolTurnsAsText ?? tools.length === 0,
            lookup: currentView.lookup
          },
          images
        );
      let prompt = await buildFor(withNotes, transcript);
      let rendered = transcript;
      throwIfAborted(i.signal);

      // 8. compaction check
      const settings = this.d.settings(i.server);
      const budget = resolveTokenBudget(i.model, i.params ?? {}, settings);
      // `compaction.enabled: false` turns off summaries, not the limits: the same triggers still
      // fire and truncate durably (no summary) below, so the prompt stays bounded.
      const trigger: CompactionTrigger | undefined = this.d.compaction.check({
        state: withNotes,
        prompt,
        budget,
        settings: { ...settings, enabled: true }
      });
      const canSummarize = Boolean(i.summarize) && settings.enabled;
      // One-off hard truncation (timeout, or an overflow retry): the newest effective-keepRecent
      // entries, halved while still over budget; the stored cursor is unchanged.
      const truncate = async (reason: string) => {
        let keep = Math.max(1, Math.min(transcript.length, effectiveKeepRecent(settings)));
        for (;;) {
          rendered = transcript.slice(-keep);
          const floor = rendered[0]?.seq ?? Number.POSITIVE_INFINITY;
          prompt = await buildFor({ ...withNotes, notes: withNotes.notes.filter((note) => note.anchorSeq >= floor) }, rendered);
          if (prompt.estimatedTokens <= budget.budgetTokens || keep <= 1) break;
          keep = Math.max(1, Math.floor(keep / 2));
        }
        this.d.logger.warn(reason, { conversationKey: key, kept: rendered.length });
      };
      // The compaction service decides WHEN (limits, backoff); without a summarizer the "how" is a
      // durable truncation instead of a summary (also when summaries are turned off).
      const durableTrigger: CompactionTrigger | undefined = !canSummarize ? trigger : undefined;
      if (durableTrigger && allowCompaction && !truncatedDurably && !forceTruncate && transcript.length > 1) {
        // No summarizer (deterministic / one-shot director, or a model that cannot summarize):
        // compaction would never run, the cursor would never advance and this context would pin
        // ledger/refs pruning for the whole conversation. Hard-truncate DURABLY instead: a new
        // epoch with no summary, the cursor before the newest kept entries, older notes dropped.
        // It is written by this prepare's own commitPrepare (one write, conflict-checked).
        truncatedDurably = true;
        const ratio = withNotes.tokenCalibration[modelKeyFor(i.model)]?.ratio ?? 1;
        let keep = Math.max(1, Math.min(transcript.length - 1, i.truncateKeep ?? effectiveKeepRecent(settings)));
        if (durableTrigger === "tokens" || durableTrigger === "overflow") keep = Math.max(1, Math.min(keep, Math.floor(transcript.length / 2)));
        const keptTokens = (k: number) => transcript.slice(-k).reduce((sum, entry) => sum + entryTokens(entry, ratio), 0);
        while (keep > 1 && keptTokens(keep) > budget.budgetTokens / 2) keep -= 1;
        const cursorEntry = transcript[transcript.length - keep - 1]!;
        this.d.logger.info("Context truncated without a summary (no summarizer)", {
          conversationKey: key,
          agentId: contextAgentId(i.agent),
          trigger: durableTrigger,
          kept: keep
        });
        state = nextEpochState(
          working,
          { cursorSeq: cursorEntry.seq, cursorMessageId: isGapEntry(cursorEntry) ? null : cursorEntry.id },
          null,
          durableTrigger,
          startedAt,
          view.all
        );
        isFresh = false;
        continue; // rebuild on the truncated epoch; this prepare's commitPrepare persists it
      }
      if (trigger && allowCompaction && !compacted && canSummarize && i.summarize) {
        compacted = true;
        const outcome = await this.awaitCompaction(key, i, prompt, trigger, settings, working, budget);
        // An abort while waiting must not seal or persist anything.
        if (outcome === "aborted") throwIfAborted(i.signal);
        if (outcome === "done") {
          state = await this.d.store.load(key, i.agent);
          // A compaction writes lastUsedAt, so a compacted context is never fresh; a no-op one
          // (nothing to summarize, or discarded) leaves a fresh context fresh.
          isFresh = this.isFresh(state, startedAt);
          view = await this.ledgerView(key);
          continue; // rebuild on the compacted state
        }
        if (outcome === "timeout") await truncate("Compaction did not finish in time; sending a hard-truncated prompt");
      } else if (forceTruncate) {
        await truncate("Retrying a context overflow with a hard-truncated prompt");
      }
      throwIfAborted(i.signal);

      // 9. one write: seal + notes + image modes + lastUsedAt (+ epoch fields) + pruning
      const decisions = images.decisions();
      const final: ContextState = {
        ...withNotes,
        imageModes: { ...withNotes.imageModes, ...decisions.imageModes },
        inlineImageCount: withNotes.inlineImageCount + decisions.inlineAdded,
        lastUsedAt: startedAt.toISOString()
      };
      const builtOn = state;
      const result = await this.d.store.commitPrepare(key, i.agent, {
        sealIds: rendered.map((entry) => entry.id),
        expectedHashes: Object.fromEntries(rendered.map((entry) => [entry.id, entryRenderHash(entry)])),
        eventSeqs: edits.map((note) => (note.kind === "edit" ? note.eventSeq : -1)),
        update: (current) => {
          if (current.revision === builtOn.revision) return final;
          // Same epoch, changed meanwhile (e.g. a concurrent commit): what this build froze (image
          // modes, note ids) may now collide — rebuild from the current state instead of merging.
          if (current.epoch === builtOn.epoch) return undefined;
          // A compaction finished meanwhile: the prompt is already built on the old epoch; keep the
          // new epoch as it is (this build's notes belong to the old one) and only mark it used.
          this.d.logger.warn("Context compacted during prepare; keeping the new epoch", { conversationKey: key });
          return { ...current, lastUsedAt: final.lastUsedAt };
        }
      });
      if (!result.ok) {
        conflicts += 1;
        if (conflicts > MAX_PREPARE_CONFLICTS) {
          throw new Error(`Context ${key} kept changing during prepare (${result.conflict}); giving up.`);
        }
        this.d.logger.info("Context or ledger changed during prepare; rebuilding", { conversationKey: key, conflict: result.conflict });
        truncatedDurably = false; // re-decide on the reloaded state
        state = await this.d.store.load(key, i.agent);
        isFresh = this.isFresh(state, startedAt);
        view = await this.ledgerView(key);
        continue;
      }
      const retrieved = [
        ...(epoch.started ? working.memorySnapshotIds : []),
        ...memoryNotes.flatMap((n) => (n.kind === "memory" ? n.memoryIds : []))
      ];
      if (retrieved.length > 0) {
        try {
          this.d.snapshots.markRetrieved(retrieved, startedAt);
        } catch {
          // fire-and-forget
        }
      }

      const prepared: PreparedContext = {
        conversation: i.conversation,
        agent: i.agent,
        key,
        state: result.state,
        prompt,
        transcript: rendered,
        modelKey: modelKeyFor(i.model),
        startedAt
      };
      this.internals.set(prepared, { input: i, key, builtEpoch: withNotes.epoch, builtCursorSeq: withNotes.cursorSeq });
      return prepared;
    }
  }

  private frozenImages(i: PrepareInput): FrozenImageRenderer {
    const memory = this.d.memory?.() ?? DEFAULT_APP_CONFIG.memory;
    const refresh = this.d.refreshImageUrl;
    return new FrozenImageRenderer({
      fetcher: this.d.images,
      acceptsImages: i.model.modalities.input.includes("image"),
      maxInlinePerEpoch: memory.maxInlineImagesPerEpoch,
      ocr: this.d.ocr,
      ...(this.d.ocrTimeoutMs !== undefined ? { ocrTimeoutMs: this.d.ocrTimeoutMs } : {}),
      signal: i.signal,
      logger: this.d.logger,
      ...(refresh ? { refreshUrl: (entry: LedgerEntry, ref: ImageRef) => refresh(i.conversation, entry, ref) } : {})
    });
  }

  private async startEpochIfNeeded(
    state: ContextState,
    o: { i: PrepareInput; fresh: boolean; all: LedgerEntry[]; timeZone: string; now: Date }
  ): Promise<{ state: ContextState; started: boolean }> {
    if (!o.fresh && state.headerText !== null) return { state, started: false };
    const next: ContextState = structuredClone(state);
    if (o.fresh) {
      // New context, or one idle beyond the pruning horizon: a new epoch over a fresh backfill
      // of the newest backfillCap ledger entries (older ones may have been pruned).
      if (state.revision > 0) next.epoch = state.epoch + 1;
      next.notes = [];
      next.headerText = null;
      const cap = Math.max(1, o.i.backfillCap);
      const cursorEntry = o.all.length > cap ? o.all[o.all.length - cap - 1] : undefined;
      next.cursorSeq = cursorEntry ? cursorEntry.seq : o.all.length > 0 ? o.all[0]!.seq - 1 : null;
      next.cursorMessageId = cursorEntry && !isGapEntry(cursorEntry) ? cursorEntry.id : null;
    }
    next.timeZone = o.timeZone;
    next.epochStartedAt = o.now.toISOString();
    next.lastBreakpoint = null;
    next.memoryNoteCount = 0;
    next.inlineImageCount = 0;
    const transcript = o.all.filter((entry) => next.cursorSeq === null || entry.seq > next.cursorSeq);
    const keptKeys = new Set(transcript.flatMap((entry) => entry.images.map((image) => image.key)));
    next.imageModes = Object.fromEntries(Object.entries(next.imageModes).filter(([imageKey]) => keptKeys.has(imageKey)));

    let lines: string[] = [];
    next.epochParticipantIds = [
      ...new Set([
        ...participantsOf(transcript, o.i.selfAuthorIds, o.i.waifuIdForAuthor).flatMap((p) => (p.discordUserId ? [p.discordUserId] : [])),
        ...(o.i.participantIds ?? [])
      ])
    ];
    next.memorySnapshotIds = [];
    if (o.i.agent.kind === "waifu") {
      const memory = this.d.memory?.() ?? DEFAULT_APP_CONFIG.memory;
      const snapshot = await this.d.snapshots.selectSnapshot({
        waifuId: o.i.agent.waifuId,
        conversation: o.i.conversation,
        participants: participantsOf(transcript, o.i.selfAuthorIds, o.i.waifuIdForAuthor).map(stripFirstSeq),
        window: transcript,
        now: o.now,
        limit: o.i.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
        maxPinned: memory.maxPinnedInjected
      });
      // Memory notes kept across a compaction already show their memories in the transcript.
      const noted = new Set(next.notes.flatMap((note) => (note.kind === "memory" ? note.memoryIds : [])));
      if (noted.size > 0 && snapshot.ids.length === snapshot.lines.length) {
        const keep = snapshot.ids.map((id) => !noted.has(id));
        next.memorySnapshotIds = snapshot.ids.filter((_id, index) => keep[index]);
        lines = snapshot.lines.filter((_line, index) => keep[index]);
      } else {
        next.memorySnapshotIds = snapshot.ids.filter((id) => !noted.has(id));
        lines = snapshot.lines;
      }
    }
    next.headerText = o.i.render.header({ lines }, next);
    return { state: next, started: true };
  }

  private async proposeMemoryNotes(
    state: ContextState,
    transcript: LedgerEntry[],
    i: PrepareInput,
    now: Date
  ): Promise<NewContextNote[]> {
    if (i.agent.kind !== "waifu") return [];
    const memory = this.d.memory?.() ?? DEFAULT_APP_CONFIG.memory;
    const budget = memory.maxMemoryNotesPerEpoch - state.memoryNoteCount;
    if (budget <= 0) return [];
    // "New" = first seen after this context's previous request (its stored breakpoint C).
    const previous = state.lastBreakpoint;
    const seenThrough =
      previous?.kind === "entry"
        ? previous.seq
        : previous?.kind === "note"
          ? state.notes.find((note) => note.seq === previous.seq)?.anchorSeq
          : undefined;
    const participants = participantsOf(transcript, i.selfAuthorIds, i.waifuIdForAuthor);
    const newParticipants =
      seenThrough === undefined ? [] : participants.filter((p) => p.firstSeq > seenThrough).map(stripFirstSeq);
    const excludeIds = [
      ...state.memorySnapshotIds,
      ...state.notes.flatMap((note) => (note.kind === "memory" ? note.memoryIds : []))
    ];
    const proposals = await this.d.snapshots.proposeInlineNotes({
      waifuId: i.agent.waifuId,
      conversation: i.conversation,
      participants: participants.map(stripFirstSeq),
      newParticipants,
      excludeIds,
      window: transcript,
      epochStartedAt: state.epochStartedAt,
      now,
      budget
    });
    return proposals.slice(0, budget).map((p) => ({ kind: "memory", memoryIds: p.memoryIds, text: p.text }));
  }

  private async awaitCompaction(
    key: ConversationKey,
    i: PrepareInput,
    prompt: BuiltPrompt,
    trigger: CompactionTrigger,
    settings: CompactionSettings,
    basedOn: ContextState,
    budget: TokenBudget
  ): Promise<"done" | "timeout" | "failed" | "aborted"> {
    const running =
      this.d.compaction.inFlight(key, i.agent) ??
      this.d.compaction.compact({
        conversation: i.conversation,
        agent: i.agent,
        prompt,
        trigger,
        summarize: i.summarize!,
        settings,
        basedOn,
        budget,
        selfAuthorIds: i.selfAuthorIds
        // no signal: a compaction outlives the reply that started it (spec 6.6)
      });
    running.catch((error: unknown) => {
      this.d.logger.warn("Context compaction failed", {
        conversationKey: key,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return withTimeout(running, settings.waitTimeoutMs, i.signal);
  }
}
