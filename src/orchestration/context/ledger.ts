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

import type { ConversationLedger, LedgerEntry } from "../../shared/schemas/context.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { GuildDirectoryView, MessageRenderer } from "./types.js";

export const GAP_ENTRY_PREFIX = "gap:";
export const EARLIER_MESSAGES_NOT_LOADED = "— earlier messages not loaded —";
export const LEDGER_ENTRY_CAP = 2000;
export const ACTIVE_CONTEXT_MS = 7 * 24 * 60 * 60 * 1000;

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
};

export function reconcileEntries(
  ledger: ConversationLedger,
  fetched: readonly RawDiscordMessage[],
  render: MessageRenderer,
  o: ReconcileOptions
): { ledger: ConversationLedger; changed: boolean } {
  const entries = { ...ledger.entries };
  let nextSeq = Math.max(ledger.nextSeq, newestSeq(ledger) + 1);
  let changed = false;
  let gapPending = o.gapBeforeNew === true;
  const sorted = [...fetched].sort(compareMessageOrder);
  const seen = new Set<string>();

  for (const message of sorted) {
    if (seen.has(message.id) || message.id.startsWith(GAP_ENTRY_PREFIX)) continue;
    seen.add(message.id);
    const existing = entries[message.id];
    const rendered = render.render(message, o.dir, o.timeZone);
    if (existing?.sealed) {
      const refreshed = rendered ? refreshImageUrls(existing, rendered.images) : undefined;
      if (refreshed) {
        entries[message.id] = refreshed;
        changed = true;
      }
      continue;
    }
    if (rendered === null) continue;
    const candidate: LedgerEntry = {
      id: message.id,
      seq: existing?.seq ?? nextSeq,
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
        seq: nextSeq,
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
      nextSeq += 1;
      candidate.seq = nextSeq;
    }
    entries[message.id] = candidate;
    nextSeq += 1;
    changed = true;
  }
  if (!changed) return { ledger, changed: false };
  return { ledger: { ...ledger, entries, nextSeq }, changed: true };
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

export type PruneInput = {
  /** cursorSeq of every ACTIVE context (lastUsedAt within 7 days); null = whole ledger in view. */
  activeCursors: ReadonlyArray<number | null>;
  cap?: number;
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
