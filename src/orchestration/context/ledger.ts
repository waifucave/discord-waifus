// Conversation ledger operations (spec 8.1/8.3). Pure functions over ConversationLedger; the
// store (contextStore.ts) runs them under the ledger's resource lock.
//
// - One entry per Discord message; `seq` is first-seen order and IS the transcript order, so late
//   arrivals still append.
// - An unsealed entry whose rendered content changed is replaced in place (same seq) — absorbs
//   quick typo fixes before any model saw it. Sealed entries are never rewritten in Phase 4
//   (Phase 5 adds edit events); only their image URLs are refreshed when Discord re-signs them.
// - "— earlier messages not loaded —" is a synthetic entry (id `gap:<first new id>`) appended
//   before a batch that did not reach the previous newest entry.

import { createHash } from "node:crypto";
import type { ConversationEvent, ConversationLedger, LedgerEntry } from "../../shared/schemas/context.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { GuildDirectoryView, MessageRenderer } from "./types.js";

export const GAP_ENTRY_PREFIX = "gap:";
export const EARLIER_MESSAGES_NOT_LOADED = "— earlier messages not loaded —";
export const LEDGER_ENTRY_CAP = 2000;
/** Pruning never removes the newest entries (protects a new context not yet persisted). */
export const LEDGER_PROTECT_NEWEST = 200;
export const ACTIVE_CONTEXT_MS = 7 * 24 * 60 * 60 * 1000;
/** What a deleted message renders as (spec 9.5): redacted in place, or at the next epoch start. */
export const DELETED_MESSAGE_BODY = "(message deleted)";
/** Spec 9.5: at most this many `edit` events per message; later edits only refresh `editedAt`. */
export const MAX_EDIT_EVENTS_PER_MESSAGE = 3;
export const EDIT_EVENT_TEXT_MAX = 500;
export const DEFAULT_REDACT_RECENT = 20;

/**
 * True when `entry` renders as "(message deleted)" in a context: it was redacted in the ledger
 * (recent / unsealed delete) or it was old when that context's epoch started (`redactedIds`).
 */
export function isRedactedEntry(entry: LedgerEntry, redactedIds?: readonly string[]): boolean {
  return entry.state === "deleted" && (entry.body === DELETED_MESSAGE_BODY || redactedIds?.includes(entry.id) === true);
}

/**
 * Ids of deleted ledger entries that must render as "(message deleted)" in an epoch starting at
 * `cursorSeq`: those after the cursor, plus the deleted targets of the edit notes that survive the
 * cut and of the edit events the epoch will convert (their text would otherwise carry the deleted
 * message's content into the new epoch even though the message itself is cut or masked).
 */
export function deletedEntryIdsAfter(
  entries: readonly LedgerEntry[],
  cursorSeq: number | null,
  carried: { notes?: ReadonlyArray<{ kind: string; messageId?: string }>; events?: readonly ConversationEvent[] } = {}
): string[] {
  const targets = new Set<string>();
  for (const note of carried.notes ?? []) if (note.kind === "edit" && note.messageId) targets.add(note.messageId);
  for (const event of carried.events ?? []) {
    if (event.kind === "edit" && (cursorSeq === null || event.anchorSeq > cursorSeq)) targets.add(event.messageId);
  }
  return entries
    .filter(
      (entry) =>
        entry.state === "deleted" &&
        !isGapEntry(entry) &&
        (cursorSeq === null || entry.seq > cursorSeq || targets.has(entry.id))
    )
    .map((entry) => entry.id);
}

/**
 * The pruning floor an active stage-manager observer holds (spec 8.7): it has read everything up
 * to and including its cursor, so entries from the cursor on must stay or the observer would
 * skip them (memory loss). A cursor that names no ledger entry yet (only a legacy message id, or
 * none) holds nothing, and the hold never reaches further back than `cap` entries from the head,
 * so a lagging observer cannot pin the ledger (a stale one is dropped by ACTIVE_CONTEXT_MS).
 */
export function observerPruneCursor(
  ledger: ConversationLedger,
  cursor: { cursorSeq: number | null; cursorMessageId: string | null },
  cap: number = LEDGER_ENTRY_CAP
): number | undefined {
  const seq = cursor.cursorSeq ?? (cursor.cursorMessageId ? ledger.entries[cursor.cursorMessageId]?.seq : undefined);
  if (seq === undefined) return undefined;
  const ordered = orderedEntries(ledger);
  return ordered.length > cap ? Math.max(seq, ordered[ordered.length - cap]!.seq) : seq;
}

export function isGapEntry(entry: Pick<LedgerEntry, "id">): boolean {
  return entry.id.startsWith(GAP_ENTRY_PREFIX);
}

/** Every entry, in transcript (seq) order. */
export function orderedEntries(ledger: ConversationLedger): LedgerEntry[] {
  return Object.values(ledger.entries).sort((a, b) => a.seq - b.seq);
}

/** The highest-seq real (non-gap) entry — the `afterMessageId` of the next fetch. */
export function newestMessageEntry(ledger: ConversationLedger): LedgerEntry | undefined {
  let newest: LedgerEntry | undefined;
  for (const entry of Object.values(ledger.entries)) {
    if (isGapEntry(entry)) continue;
    if (!newest || entry.seq > newest.seq) newest = entry;
  }
  return newest;
}

/** Highest seq in the ledger (0 when empty): the anchor for a note created now. */
export function newestSeq(ledger: ConversationLedger): number {
  let max = 0;
  for (const entry of Object.values(ledger.entries)) if (entry.seq > max) max = entry.seq;
  return max;
}

/** Discord snowflake order when both ids are numeric, else creation time then id. */
export function compareMessageOrder(
  a: Pick<RawDiscordMessage, "id" | "createdAt">,
  b: Pick<RawDiscordMessage, "id" | "createdAt">
): number {
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sameRendered(a: LedgerEntry, b: LedgerEntry): boolean {
  return (
    a.body === b.body &&
    a.kind === b.kind &&
    a.replyToId === b.replyToId &&
    a.editedAt === b.editedAt &&
    JSON.stringify(a.images) === JSON.stringify(b.images)
  );
}

/** Refresh re-signed image URLs in place (keys are stable). Undefined when nothing changed. */
function refreshImageUrls(entry: LedgerEntry, images: LedgerEntry["images"]): LedgerEntry | undefined {
  const byKey = new Map(images.map((image) => [image.key, image.url]));
  let changed = false;
  const next = entry.images.map((image) => {
    const url = byKey.get(image.key);
    if (url && url !== image.url) {
      changed = true;
      return { ...image, url };
    }
    return image;
  });
  return changed ? { ...entry, images: next } : undefined;
}

export type ReconcileOptions = {
  dir: GuildDirectoryView;
  timeZone: string;
  /** Insert the "earlier messages not loaded" entry before the first NEW message of this batch. */
  gapBeforeNew?: boolean;
  /** Recently deleted message ids (a delete that arrived before its message was reconciled). */
  skipIds?: ReadonlySet<string>;
  /** Clock for the edit events this reconcile creates (default: now). */
  now?: Date;
};

/** The mutable pieces of a ledger while an operation edits it. */
type Working = { entries: Record<string, LedgerEntry>; events: ConversationEvent[]; nextSeq: number };

function working(ledger: ConversationLedger): Working {
  return {
    entries: { ...ledger.entries },
    events: [...ledger.events],
    nextSeq: Math.max(ledger.nextSeq, newestSeq(ledger) + 1)
  };
}

function finish(ledger: ConversationLedger, w: Working): ConversationLedger {
  return { ...ledger, entries: w.entries, events: w.events, nextSeq: w.nextSeq };
}

function clipEditText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EDIT_EVENT_TEXT_MAX ? `${trimmed.slice(0, EDIT_EVENT_TEXT_MAX - 1).trimEnd()}…` : trimmed;
}

type SealedEditOutcome = "ignored" | "event" | "coalesced" | "capped";

/**
 * A sealed entry's message was edited (Discord's `editedTimestamp` moved forward): keep the frozen
 * body, remember the new `editedAt` and add an `edit` event (spec 9.5) that prepare turns into a
 * note anchored to the newest entry. A not-yet-converted event of the same message is replaced
 * under a fresh seq (a context that already converted the old text then converts the new text
 * too); at most MAX_EDIT_EVENTS_PER_MESSAGE events per message, later edits only move `editedAt`.
 */
function recordSealedEdit(
  w: Working,
  entry: LedgerEntry,
  message: Pick<RawDiscordMessage, "editedAt">,
  rendered: { body: string; images: readonly unknown[] },
  now: Date
): SealedEditOutcome {
  const editedAt = message.editedAt;
  if (!editedAt) return "ignored";
  const editedMs = Date.parse(editedAt);
  if (!Number.isFinite(editedMs)) return "ignored";
  // A duplicate or an out-of-order older edit (events can arrive in any order).
  if (entry.editedAt && Date.parse(entry.editedAt) >= editedMs) return "ignored";
  w.entries[entry.id] = { ...entry, editedAt, state: "edited" };
  const body = rendered.body.trim();
  // Embed-only / flag-only updates keep the text the model already saw: nothing to tell it.
  if (body === entry.body.trim() && rendered.images.length === entry.images.length) return "ignored";
  const text = clipEditText(body || (rendered.images.length > 0 ? "[image]" : "(no text)"));
  const anchorSeq = Math.max(0, ...Object.values(w.entries).map((candidate) => candidate.seq));
  const mine = w.events.filter((event) => event.kind === "edit" && event.messageId === entry.id);
  const open = mine.find((event) => event.kind === "edit" && !event.sealed);
  if (open) {
    const seq = w.nextSeq;
    w.nextSeq += 1;
    w.events = w.events.map((event) =>
      event === open ? { kind: "edit", seq, at: now.toISOString(), messageId: entry.id, anchorSeq, authorId: entry.authorId, text, sealed: false } : event
    );
    return "coalesced";
  }
  if (mine.length >= MAX_EDIT_EVENTS_PER_MESSAGE) return "capped";
  w.events.push({
    kind: "edit",
    seq: w.nextSeq,
    at: now.toISOString(),
    messageId: entry.id,
    anchorSeq,
    authorId: entry.authorId,
    text,
    sealed: false
  });
  w.nextSeq += 1;
  return "event";
}

export function reconcileEntries(
  ledger: ConversationLedger,
  fetched: readonly RawDiscordMessage[],
  render: MessageRenderer,
  o: ReconcileOptions
): { ledger: ConversationLedger; changed: boolean } {
  const w = working(ledger);
  const entries = w.entries;
  let changed = false;
  let gapPending = o.gapBeforeNew === true;
  const now = o.now ?? new Date();
  const sorted = [...fetched].sort(compareMessageOrder);
  const seen = new Set<string>();

  for (const message of sorted) {
    if (seen.has(message.id) || message.id.startsWith(GAP_ENTRY_PREFIX)) continue;
    seen.add(message.id);
    if (o.skipIds?.has(message.id)) continue;
    const existing = entries[message.id];
    // A deleted message is never resurrected by a stale fetch.
    if (existing?.state === "deleted") continue;
    const rendered = render.render(message, o.dir, o.timeZone);
    if (existing?.sealed) {
      if (!rendered) continue;
      const refreshed = refreshImageUrls(existing, rendered.images);
      if (refreshed) {
        entries[message.id] = refreshed;
        changed = true;
      }
      // Edits made while the bot was away (or missed): the fetched message carries a newer
      // `editedTimestamp` than the ledger remembers.
      const before = entries[message.id]!;
      const eventsBefore = w.events;
      const seqBefore = w.nextSeq;
      recordSealedEdit(w, before, message, rendered, now);
      if (entries[message.id] !== before || w.events !== eventsBefore || w.nextSeq !== seqBefore) changed = true;
      continue;
    }
    if (rendered === null) continue;
    const candidate: LedgerEntry = {
      id: message.id,
      seq: existing?.seq ?? w.nextSeq,
      authorId: message.authorId,
      authorName: existing?.authorName ?? message.authorName, // frozen at first render
      authorIsBot: message.authorIsBot,
      at: message.createdAt,
      ...(message.editedAt ? { editedAt: message.editedAt } : {}),
      kind: rendered.kind,
      body: rendered.body,
      images: rendered.images,
      ...(message.referenceMessageId ? { replyToId: message.referenceMessageId } : {}),
      state: "live",
      sealed: false
    };
    if (existing) {
      if (!sameRendered(existing, candidate)) {
        entries[message.id] = candidate;
        changed = true;
      }
      continue;
    }
    if (gapPending) {
      gapPending = false;
      const gapId = `${GAP_ENTRY_PREFIX}${message.id}`;
      entries[gapId] = {
        id: gapId,
        seq: w.nextSeq,
        authorId: "system",
        authorName: "",
        authorIsBot: false,
        at: message.createdAt,
        kind: "system",
        body: EARLIER_MESSAGES_NOT_LOADED,
        images: [],
        state: "live",
        sealed: false
      };
      w.nextSeq += 1;
      candidate.seq = w.nextSeq;
    }
    entries[message.id] = candidate;
    w.nextSeq += 1;
    changed = true;
  }
  if (!changed) return { ledger, changed: false };
  return { ledger: finish(ledger, w), changed: true };
}

export type EditOutcome = "unknown" | "ignored" | "replaced" | SealedEditOutcome;

/**
 * One message was edited (Discord `messageUpdate`, spec 9.5). An unsealed entry is replaced in
 * place (no model has seen it); a sealed one keeps its body and gains an `edit` event. A message
 * the ledger does not hold (not fetched yet, pruned, before the backfill) is "unknown": a message
 * not fetched yet arrives already edited, so there is nothing to record.
 */
export function applyEdit(
  ledger: ConversationLedger,
  message: RawDiscordMessage,
  render: MessageRenderer,
  o: ReconcileOptions
): { ledger: ConversationLedger; outcome: EditOutcome } {
  const entry = ledger.entries[message.id];
  if (!entry || isGapEntry(entry)) return { ledger, outcome: "unknown" };
  if (entry.state === "deleted" || o.skipIds?.has(message.id)) return { ledger, outcome: "ignored" };
  if (!entry.sealed) {
    const result = reconcileEntries(ledger, [message], render, o);
    return { ledger: result.ledger, outcome: result.changed ? "replaced" : "ignored" };
  }
  const rendered = render.render(message, o.dir, o.timeZone);
  if (!rendered) return { ledger, outcome: "ignored" };
  const w = working(ledger);
  const eventsBefore = w.events;
  const outcome = recordSealedEdit(w, entry, message, rendered, o.now ?? new Date());
  if (w.entries[entry.id] === entry && w.events === eventsBefore && outcome === "ignored") return { ledger, outcome };
  return { ledger: finish(ledger, w), outcome };
}

export type DeleteResult = {
  ledger: ConversationLedger;
  /** Entries whose body became "(message deleted)" (unsealed or among the newest `redactRecent`). */
  redacted: string[];
  /** Older entries marked `deleted` with their text left alone (the cached transcript is intact). */
  marked: string[];
  /** Ids the ledger does not hold. */
  unknown: string[];
  /** Images of the redacted entries, for the caller to purge from the image cache. */
  purgedImages: LedgerEntry["images"];
};

/**
 * Spec 9.5 hybrid delete (O1). An unsealed entry, or one among the newest `redactRecent` real
 * entries of the ledger, is redacted in place: body "(message deleted)", images dropped, so the
 * rendered bytes change only from that message onward. An older sealed entry keeps its text (the
 * cache survives) and is only marked `deleted`; a compaction leaves it out of the summary and the
 * next epoch start renders it as "(message deleted)". Either way an audit `delete` event is added
 * and any not-yet-converted `edit` event of the message is dropped.
 */
export function applyDeletes(
  ledger: ConversationLedger,
  ids: readonly string[],
  o: { redactRecent: number; now?: Date }
): DeleteResult {
  const result: DeleteResult = { ledger, redacted: [], marked: [], unknown: [], purgedImages: [] };
  const real = orderedEntries(ledger).filter((entry) => !isGapEntry(entry));
  const recent = new Set(o.redactRecent > 0 ? real.slice(-o.redactRecent).map((entry) => entry.id) : []);
  const w = working(ledger);
  const at = (o.now ?? new Date()).toISOString();
  const dropUnsealedEdits = new Set<string>();
  for (const id of new Set(ids)) {
    const entry = ledger.entries[id];
    if (!entry || isGapEntry(entry)) {
      result.unknown.push(id);
      continue;
    }
    if (entry.state === "deleted") continue;
    dropUnsealedEdits.add(id);
    const anchorSeq = Math.max(0, ...Object.values(w.entries).map((candidate) => candidate.seq));
    w.events.push({ kind: "delete", seq: w.nextSeq, at, messageId: id, anchorSeq });
    w.nextSeq += 1;
    // The deleted message's edit text must not stay on disk, converted or not.
    w.events = w.events.map((event) =>
      event.kind === "edit" && event.messageId === id && event.text !== "" ? { ...event, text: "" } : event
    );
    if (!entry.sealed || recent.has(id)) {
      w.entries[id] = { ...entry, body: DELETED_MESSAGE_BODY, images: [], state: "deleted" };
      result.redacted.push(id);
      result.purgedImages = [...result.purgedImages, ...entry.images];
    } else {
      w.entries[id] = { ...entry, state: "deleted" };
      result.marked.push(id);
    }
  }
  if (result.redacted.length === 0 && result.marked.length === 0) return result;
  w.events = w.events.filter((event) => !(event.kind === "edit" && !event.sealed && dropUnsealedEdits.has(event.messageId)));
  result.ledger = finish(ledger, w);
  return result;
}

/**
 * Deletes visible as a gap in a contiguous page of recent messages (spec 9.5): every ledger entry
 * whose id lies between the page's oldest and newest message but is missing from it was deleted.
 * Only valid for a page fetched without holes (a REST page of the newest N messages).
 */
export function detectGapDeletes(ledger: ConversationLedger, page: readonly Pick<RawDiscordMessage, "id" | "createdAt">[]): string[] {
  if (page.length === 0) return [];
  const sorted = [...page].sort(compareMessageOrder);
  const oldest = sorted[0]!;
  const newest = sorted[sorted.length - 1]!;
  const present = new Set(page.map((message) => message.id));
  return Object.values(ledger.entries)
    .filter(
      (entry) =>
        !isGapEntry(entry) &&
        entry.state !== "deleted" &&
        !present.has(entry.id) &&
        compareMessageOrder({ id: entry.id, createdAt: entry.at }, oldest) > 0 &&
        compareMessageOrder({ id: entry.id, createdAt: entry.at }, newest) < 0
    )
    .map((entry) => entry.id);
}

/** Seal entries (and Phase 5 events) that a build rendered. Undefined when nothing changed. */
export function sealEntries(
  ledger: ConversationLedger,
  ids: readonly string[],
  eventSeqs: readonly number[] = []
): ConversationLedger | undefined {
  let entries: Record<string, LedgerEntry> | undefined;
  for (const id of ids) {
    const entry = (entries ?? ledger.entries)[id];
    if (!entry || entry.sealed) continue;
    entries ??= { ...ledger.entries };
    entries[id] = { ...entry, sealed: true };
  }
  const sealSet = new Set(eventSeqs);
  let eventsChanged = false;
  const events = ledger.events.map((event) => {
    if (event.kind === "edit" && sealSet.has(event.seq) && !event.sealed) {
      eventsChanged = true;
      return { ...event, sealed: true };
    }
    return event;
  });
  if (!entries && !eventsChanged) return undefined;
  return { ...ledger, entries: entries ?? ledger.entries, events: eventsChanged ? events : ledger.events };
}

/**
 * Hash of everything a build renders from an entry (image keys, not their re-signable URLs), so a
 * seal can verify the ledger still holds exactly what was rendered.
 */
export function entryRenderHash(entry: LedgerEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.id,
        entry.seq,
        entry.authorId,
        entry.authorName,
        entry.authorIsBot,
        entry.at,
        entry.kind,
        entry.body,
        entry.replyToId ?? null,
        entry.images.map((image) => image.key)
      ])
    )
    .digest("hex");
}

export type PruneInput = {
  /** cursorSeq of every ACTIVE context (lastUsedAt within 7 days); null = whole ledger in view. */
  activeCursors: ReadonlyArray<number | null>;
  cap?: number;
  protectNewest?: number;
};

/**
 * Spec 8.1 pruning: drop entries below the minimum cursor of active contexts; with no active
 * context only the cap (newest 2000) applies. Nothing at or above an active cursor is ever
 * pruned. Reply targets of kept entries are kept too, so a `↩Name` header (target before the
 * cursor) can never change under a live epoch.
 */
export function pruneLedgerEntries(
  ledger: ConversationLedger,
  input: PruneInput
): { ledger: ConversationLedger; removedIds: string[] } | undefined {
  const cap = input.cap ?? LEDGER_ENTRY_CAP;
  const ordered = orderedEntries(ledger);
  if (input.activeCursors.some((cursor) => cursor === null)) return undefined;
  let floor: number;
  if (input.activeCursors.length > 0) {
    floor = Math.min(...(input.activeCursors as number[]));
  } else {
    if (ordered.length <= cap) return undefined;
    floor = ordered[ordered.length - cap]!.seq;
  }
  const protect = input.protectNewest ?? LEDGER_PROTECT_NEWEST;
  if (protect > 0 && ordered.length > 0) {
    floor = Math.min(floor, ordered[Math.max(0, ordered.length - protect)]!.seq);
  }
  const keep = new Set(ordered.filter((entry) => entry.seq >= floor).map((entry) => entry.id));
  for (const entry of ordered) {
    if (keep.has(entry.id) && entry.replyToId && ledger.entries[entry.replyToId]) keep.add(entry.replyToId);
  }
  if (keep.size === ordered.length) return undefined;
  const removedIds = ordered.filter((entry) => !keep.has(entry.id)).map((entry) => entry.id);
  const entries = Object.fromEntries(ordered.filter((entry) => keep.has(entry.id)).map((entry) => [entry.id, entry]));
  const events = ledger.events.filter((event) => keep.has(event.messageId));
  return { ledger: { ...ledger, entries, events }, removedIds };
}
