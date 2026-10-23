// ContextRuntime (spec 8.3 runtime seam): the one entry point the reply / orchestrator / background
// paths use to obtain a cache-stable prompt for (agent, conversation).
//
// prepare: load state → fetch since the newest ledger entry (first fetch of an epoch bounded by
// backfillCap) → reconcile ledger → assign refs → epoch start if headerText is null (freeze
// timeZone, memory snapshot, header; reset image counters) → propose memory notes → BUILD →
// compaction.check → (join inFlight ≤ waitTimeoutMs or compact; rebuild; on timeout a one-off hard
// truncation) → in ONE write: seal rendered entries, persist pendingNotes + memory notes + image
// modes, update lastUsedAt.
// call:   context_overflow → forced compact + rebuild + retry once (a second overflow surfaces).
// commit: stores the request's breakpoint C as lastBreakpoint, appends post-call notes, runs the
//         calibration hook with the returned usage.

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
import { conversationKey, type ContextAgent, type ConversationKey, type ConversationRef } from "./keys.js";
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
import { resolveTokenBudget } from "./tokens.js";
import type {
  BuiltPrompt,
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
  RoleRenderer
} from "./types.js";

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
  pendingNotes?: NewContextNote[]; // e.g. this turn's direction
  signal?: AbortSignal;
  /** Additive (all optional): */
  params?: Record<string, unknown>; // token budget (maxOutputTokens)
  server?: ServerConfig; // compaction settings override
  directory?: GuildDirectoryView; // mention/role/channel/emoji names for new ledger entries
  /** The agent's own-model summarizer (gatewayPipeline.summarizeContext); compaction needs it. */
  summarize?: (p: BuiltPrompt, instruction: string) => Promise<string>;
  waifuIdForAuthor?: (authorId: string) => string | undefined;
  memoryLimit?: number; // snapshot size (memoryInjectionLimit), default 12
  recentReactions?: string[];
  renderToolTurnsAsText?: boolean; // default: true when render.tools() is empty
};

type Internal = { input: PrepareInput; key: ConversationKey };

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

/** True for a gateway `context_overflow` error (also when wrapped as a cause). */
export function isContextOverflowError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  if ((error as { kind?: unknown }).kind === "context_overflow") return true;
  return isContextOverflowError((error as { cause?: unknown }).cause, depth + 1);
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
      if (!internal?.input.summarize) throw error;
      this.d.logger.warn("Context overflow; compacting and retrying once", { conversationKey: internal.key });
      await this.d.compaction.compact({
        conversation: p.conversation,
        agent: p.agent,
        prompt: p.prompt,
        trigger: "overflow",
        summarize: internal.input.summarize,
        settings: this.d.settings(internal.input.server),
        signal: internal.input.signal
      });
      const rebuilt = await this.prepareInternal({ ...internal.input, pendingNotes: [] }, false);
      Object.assign(p, rebuilt);
      this.internals.set(p, internal);
      return fn(p.prompt);
    }
  }

  async commit(p: PreparedContext, o: { notes?: NewContextNote[]; usage?: Usage; modelKey: string }): Promise<void> {
    const ledger = o.notes?.length ? await this.d.store.loadLedger(p.key) : undefined;
    const anchorSeq = ledger ? newestSeq(ledger) : 0;
    const now = this.now();
    await this.d.store.update(p.key, p.agent, (current) => {
      const notes = materializeNotes(current, o.notes ?? [], anchorSeq);
      let next: ContextState = {
        ...current,
        lastUsedAt: now.toISOString(),
        // A compaction that landed meanwhile started a new epoch; the old address means nothing there.
        lastBreakpoint: current.epoch === p.state.epoch ? p.prompt.breakpoint : current.lastBreakpoint,
        notes: [...current.notes, ...notes],
        noteSeq: current.noteSeq + notes.length
      };
      if (o.usage && this.d.calibrate) {
        const calibration = this.d.calibrate({
          state: next,
          prompt: p.prompt,
          rawEstimate: Math.round(p.prompt.estimatedTokens / (current.tokenCalibration[o.modelKey]?.ratio ?? 1)),
          usage: o.usage,
          modelKey: o.modelKey,
          now
        });
        if (calibration) next = { ...next, tokenCalibration: calibration };
      }
      return next;
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

  private async prepareInternal(i: PrepareInput, allowCompaction: boolean): Promise<PreparedContext> {
    const startedAt = this.now();
    const key = conversationKey(i.conversation);
    throwIfAborted(i.signal);

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
    let conflicts = 0;
    for (;;) {
      // 5. epoch start
      const epoch = await this.startEpochIfNeeded(state, { i, fresh: isFresh, all: view.all, timeZone, now: startedAt });
      const working = epoch.state;
      const transcript = view.all.filter((entry) => working.cursorSeq === null || entry.seq > working.cursorSeq);

      // 6. notes: ledger edit events this context has not seen yet (one counter with every other
      // note), this turn's pending notes, memory notes (mid-epoch only — the snapshot covers whoever
      // is present at epoch start).
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
      const pending = i.pendingNotes ?? [];
      const newNotes = materializeNotes(working, [...edits, ...pending, ...memoryNotes], view.anchorSeq);
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
            events: currentView.events,
            selfAuthorIds: i.selfAuthorIds,
            refs: currentView.refs,
            tail: i.render.tail(s, startedAt, { recentReactions: i.recentReactions, transcript: entries }),
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
      const trigger: CompactionTrigger | undefined = settings.enabled
        ? this.d.compaction.check({
            state: withNotes,
            prompt,
            budget: resolveTokenBudget(i.model, i.params ?? {}, settings),
            settings
          })
        : undefined;
      if (trigger && allowCompaction && !compacted && i.summarize) {
        compacted = true;
        const outcome = await this.awaitCompaction(key, i, prompt, trigger, settings);
        // An abort while waiting must not seal or persist anything.
        if (outcome === "aborted") throwIfAborted(i.signal);
        if (outcome === "done") {
          state = await this.d.store.load(key, i.agent);
          isFresh = false;
          view = await this.ledgerView(key);
          continue; // rebuild on the compacted state
        }
        if (outcome === "timeout") {
          // One-off hard truncation: newest keepRecent entries; the stored cursor is unchanged.
          rendered = transcript.slice(-Math.max(1, settings.keepRecent));
          const floor = rendered[0]?.seq ?? Number.POSITIVE_INFINITY;
          const truncatedState: ContextState = {
            ...withNotes,
            notes: withNotes.notes.filter((note) => note.anchorSeq >= floor)
          };
          prompt = await buildFor(truncatedState, rendered);
          this.d.logger.warn("Compaction did not finish in time; sending a hard-truncated prompt", {
            conversationKey: key,
            kept: rendered.length
          });
        }
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
          // new epoch and only persist this turn's pending notes (re-numbered from its counter).
          this.d.logger.warn("Context compacted during prepare; keeping only this turn's notes", { conversationKey: key });
          const extra = materializeNotes(current, pending, view.anchorSeq);
          return {
            ...current,
            notes: [...current.notes, ...extra],
            noteSeq: current.noteSeq + extra.length,
            lastUsedAt: final.lastUsedAt
          };
        }
      });
      if (!result.ok) {
        conflicts += 1;
        if (conflicts > MAX_PREPARE_CONFLICTS) {
          throw new Error(`Context ${key} kept changing during prepare (${result.conflict}); giving up.`);
        }
        this.d.logger.info("Context or ledger changed during prepare; rebuilding", { conversationKey: key, conflict: result.conflict });
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
      this.internals.set(prepared, { input: i, key });
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
      next.memorySnapshotIds = snapshot.ids;
      lines = snapshot.lines;
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
    settings: CompactionSettings
  ): Promise<"done" | "timeout" | "failed" | "aborted"> {
    const running =
      this.d.compaction.inFlight(key, i.agent) ??
      this.d.compaction.compact({
        conversation: i.conversation,
        agent: i.agent,
        prompt,
        trigger,
        summarize: i.summarize!,
        settings
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
