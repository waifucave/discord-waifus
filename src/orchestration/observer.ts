// Stage-manager observer (spec 8.8): reads one conversation from its per-conversation cursor,
// sees the participants as handles plus their existing memories m1..mN, and emits
// add | update | merge | expire ops. update/merge/expire and adds with importance ≥ 4 apply
// immediately through the write gate; lower adds queue for the dream. Pure helpers here; the
// scheduling/IO lives in memoryJobs.ts.

import { randomUUID } from "node:crypto";
import { ConversationLedgerSchema, type LedgerEntry } from "../shared/schemas/context.js";
import type { MemoryOrigin, MemoryRecord, MemorySubject, PendingObservation } from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import { type ConversationRef, conversationKey, conversationLedgerPath } from "./context/keys.js";
import type { Participant } from "./context/types.js";
import type { ContextMessage } from "./contextMessages.js";
import { type HandleTable, buildHandleTable, dedupeSubjects, normalizeName, subjectsOverlap } from "./memorySubjects.js";
import { contextMessagesAsEntries } from "./memoryRetrieval.js";
import { type ObserverCursor, isNewerMessageId } from "./observerCursor.js";
import type { ObserverOp } from "./stageManager.js";
import { applyMemoryCandidate, archiveMemoryRecord, bumpMemoryRecord } from "./stores/memories.js";

/** Existing memories shown to the observer (newest first, capped). */
export const OBSERVER_MAX_EXISTING_MEMORIES = 40;
/** Adds at or above this importance skip the dream queue (spec 6.8). */
export const OBSERVER_FAST_TRACK_IMPORTANCE = 4;

// ---------------------------------------------------------------------------
// Transcript since the cursor
// ---------------------------------------------------------------------------

export type ObserverTranscript = {
  source: "ledger" | "window";
  entries: LedgerEntry[];
  /** Legacy window messages behind `entries` (window source only). */
  messages: ContextMessage[];
  /** Cursor to persist once these entries are observed. */
  next: ObserverCursor;
};

function afterCursorById<T extends { id: string }>(items: T[], cursorId: string | null, idOf: (item: T) => string = (item) => item.id): T[] {
  if (!cursorId) return items;
  const position = items.findIndex((item) => idOf(item) === cursorId);
  if (position >= 0) return items.slice(position + 1);
  return items.filter((item) => isNewerMessageId(idOf(item), cursorId));
}

/** Read the conversation ledger, if the context engine has written one. */
export async function readConversationLedger(storage: StorageService, ref: ConversationRef) {
  try {
    return await storage.readJson(conversationLedgerPath(conversationKey(ref)), ConversationLedgerSchema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Ledger entries after the cursor, oldest first, at most `cap` (the remainder is read on the
 * next run, so nothing is ever skipped or read twice). With no new entries the cursor still
 * advances to the ledger head so `requestObserveThrough` can settle.
 */
export function ledgerEntriesAfterCursor(
  entries: LedgerEntry[],
  cursor: ObserverCursor,
  cap: number
): { entries: LedgerEntry[]; next: ObserverCursor } {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const fresh = cursor.cursorSeq !== null
    ? ordered.filter((entry) => entry.seq > cursor.cursorSeq!)
    : afterCursorById(ordered, cursor.cursorMessageId);
  const batch = fresh.slice(0, Math.max(1, cap));
  const last = batch.at(-1) ?? ordered.at(-1);
  return {
    entries: batch.filter((entry) => entry.state !== "deleted"),
    next: last ? { cursorSeq: last.seq, cursorMessageId: last.id } : cursor
  };
}

function newestSourceId(message: ContextMessage): string {
  const ids = [message.id, ...(message.sourceMessageIds ?? [])];
  return ids.reduce((best, id) => (isNewerMessageId(id, best) ? id : best));
}

/** Legacy window path: the fetched messages newer than the cursor message id. */
export function windowMessagesAfterCursor(messages: ContextMessage[], cursor: ObserverCursor): { messages: ContextMessage[]; next: ObserverCursor } {
  const fresh = afterCursorById(messages, cursor.cursorMessageId, newestSourceId);
  const last = fresh.at(-1);
  return {
    messages: fresh,
    next: last ? { cursorSeq: cursor.cursorSeq, cursorMessageId: newestSourceId(last) } : cursor
  };
}

/** Window messages as ledger-shaped entries (image OCR text appended like the ledger renderer). */
export function windowEntries(messages: ContextMessage[]): LedgerEntry[] {
  return contextMessagesAsEntries(messages).map((entry, index) => {
    const ocr = (messages[index]?.images ?? []).map((image) => image.ocrText).filter(Boolean);
    return ocr.length > 0 ? { ...entry, body: `${entry.body}\n${ocr.map((text) => `[image: ${text}]`).join("\n")}` } : entry;
  });
}

// ---------------------------------------------------------------------------
// Participants and existing memories
// ---------------------------------------------------------------------------

/** Participants by first appearance; bot authors that are configured waifus get their waifu id. */
export function observerParticipants(entries: LedgerEntry[], waifuIdForAuthor: (authorId: string) => string | undefined): Participant[] {
  const seen = new Map<string, Participant>();
  for (const entry of entries) {
    if (seen.has(entry.authorId)) continue;
    const waifuId = entry.authorIsBot ? waifuIdForAuthor(entry.authorId) : undefined;
    seen.set(entry.authorId, {
      discordUserId: entry.authorId,
      ...(waifuId ? { waifuId } : {}),
      displayName: entry.authorName,
      isHuman: !entry.authorIsBot
    });
  }
  return [...seen.values()];
}

/** Active memories of the allowed waifus about the participants (newest first, capped). */
export function existingMemoriesFor(
  memories: MemoryRecord[],
  i: { allowedWaifuIds: string[]; participants: Participant[]; now: Date; max?: number }
): MemoryRecord[] {
  const table = buildHandleTable(i.participants);
  const subjects = table.entries.map((entry) => entry.subject);
  const nowMs = i.now.getTime();
  return memories
    .filter(
      (record) =>
        i.allowedWaifuIds.includes(record.waifuId) &&
        record.status === "active" &&
        (!record.expiresAt || Date.parse(record.expiresAt) > nowMs) &&
        subjectsOverlap(record.subjects, subjects)
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, i.max ?? OBSERVER_MAX_EXISTING_MEMORIES);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export type ObserverInput = {
  text: string;
  handles: HandleTable;
  /** m1..mN → memory id. */
  memoryHandles: Map<string, string>;
};

/** The observer's user message: participants, existing memories m1..mN, transcript (UTC). */
export function renderObserverInput(i: {
  participants: Participant[];
  memories: MemoryRecord[];
  entries: LedgerEntry[];
  nameFor?: (s: MemorySubject) => string;
}): ObserverInput {
  const handles = buildHandleTable(i.participants);
  const memoryHandles = new Map<string, string>();
  const participantLines = handles.entries.map(
    (entry) => `- ${entry.handle} = ${entry.participant.displayName}${entry.participant.isHuman ? "" : " (waifu)"}`
  );
  const memoryLines = i.memories.map((record, index) => {
    const handle = `m${index + 1}`;
    memoryHandles.set(handle, record.id);
    const about = record.subjects
      .map((subject) => handles.handleFor(subject) ?? (i.nameFor ? i.nameFor(subject) : subject.name))
      .join(", ");
    const flags = [record.waifuId, record.kind, `strength ${record.strength}`, record.pinned ? "pinned" : undefined]
      .filter(Boolean)
      .join(" · ");
    return `${handle} [${flags}]${about ? ` about ${about}` : ""}: ${record.content}`;
  });
  const transcript: string[] = [];
  let currentDay: string | undefined;
  for (const entry of i.entries) {
    const entryDay = day(entry.at);
    if (entryDay !== currentDay) {
      transcript.push(`— ${entryDay} (UTC) —`);
      currentDay = entryDay;
    }
    const handle = handles.entries.find((candidate) => candidate.participant.discordUserId === entry.authorId)?.handle;
    transcript.push(`[${clock(entry.at)}] ${entry.authorName}${handle ? ` (${handle})` : ""}: ${entry.body}`);
  }
  const text = [
    "Participants:",
    ...(participantLines.length ? participantLines : ["(none)"]),
    "",
    "Existing memories:",
    ...(memoryLines.length ? memoryLines : ["(none)"]),
    "",
    "Transcript:",
    ...(transcript.length ? transcript : ["(no new messages)"])
  ].join("\n");
  return { text, handles, memoryHandles };
}

// ---------------------------------------------------------------------------
// Applying ops
// ---------------------------------------------------------------------------

export type ObserverHistoryEntry = {
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  affectedMemoryIds: string[];
  summary: string;
};

export type ApplyObserverOpsResult = {
  memories: MemoryRecord[];
  queued: PendingObservation[];
  history: ObserverHistoryEntry[];
  applied: number;
  skipped: number;
};

/** Subjects from op strings: participant handles first, then a unique participant display name. */
export function resolveOpSubjects(values: string[], handles: HandleTable): MemorySubject[] {
  const subjects: MemorySubject[] = [];
  for (const value of values) {
    const byHandle = handles.subjectsFor([value]);
    if (byHandle.length > 0) {
      subjects.push(...byHandle);
      continue;
    }
    const key = normalizeName(value);
    const byName = handles.entries.filter((entry) => normalizeName(entry.participant.displayName) === key);
    if (byName.length === 1) subjects.push(byName[0]!.subject);
  }
  return dedupeSubjects(subjects);
}

export function applyObserverOps(
  memories: MemoryRecord[],
  ops: ObserverOp[],
  c: {
    handles: HandleTable;
    memoryHandles: Map<string, string>;
    allowedWaifuIds: string[];
    origin: MemoryOrigin;
    conversationKey?: string;
    now: Date;
    queuedIds?: () => string;
  }
): ApplyObserverOpsResult {
  const now = c.now.toISOString();
  let working = [...memories];
  const queued: PendingObservation[] = [];
  const history: ObserverHistoryEntry[] = [];
  let applied = 0;
  let skipped = 0;
  const skip = (summary: string) => {
    skipped += 1;
    history.push({ tool: "no_change", affectedMemoryIds: [], summary: `[observer] skipped: ${summary}` });
  };
  const target = (handle: string): MemoryRecord | undefined => {
    const id = c.memoryHandles.get(handle);
    const record = id ? working.find((candidate) => candidate.id === id) : undefined;
    if (!record || record.status !== "active" || record.pinned || !c.allowedWaifuIds.includes(record.waifuId)) return undefined;
    return record;
  };
  const replace = (next: MemoryRecord) => {
    working = working.map((record) => (record.id === next.id ? next : record));
  };

  for (const op of ops) {
    if (op.op === "add") {
      if (!c.allowedWaifuIds.includes(op.waifuId)) {
        skip(`add with unknown waifu id ${op.waifuId}`);
        continue;
      }
      const subjects = resolveOpSubjects(op.subjects, c.handles);
      if (op.importance < OBSERVER_FAST_TRACK_IMPORTANCE) {
        queued.push({
          id: c.queuedIds?.() ?? randomUUID(),
          waifuId: op.waifuId,
          content: op.content,
          kind: op.kind,
          importance: op.importance,
          subjects,
          origin: c.origin,
          ...(c.conversationKey ? { conversationKey: c.conversationKey } : {}),
          createdAt: now
        });
        continue;
      }
      const result = applyMemoryCandidate(
        working,
        { waifuId: op.waifuId, kind: op.kind, content: op.content, subjects, origin: c.origin, importance: op.importance, source: "stage_manager" },
        { writer: "stage_manager", now: c.now, strength: op.importance }
      );
      working = result.memories;
      if (result.decision.action === "skip") {
        skip(`duplicate of ${result.decision.duplicateOf}: ${op.content}`);
        continue;
      }
      applied += 1;
      history.push({
        tool: result.decision.action === "insert" ? "add_memory" : "update_memory",
        affectedMemoryIds: result.recordId ? [result.recordId] : [],
        summary: `[observer:${result.decision.action === "insert" ? "add" : "reinforce"}] ${op.content}`
      });
      continue;
    }

    if (op.op === "update") {
      const record = target(op.memory);
      if (!record) {
        skip(`update of unknown, pinned or inactive memory ${op.memory}`);
        continue;
      }
      const subjects = op.subjects ? resolveOpSubjects(op.subjects, c.handles) : undefined;
      replace(
        bumpMemoryRecord(
          record,
          {
            content: op.content,
            ...(op.kind ? { kind: op.kind } : {}),
            ...(op.importance !== undefined ? { strength: op.importance } : {}),
            ...(subjects && subjects.length > 0 ? { subjects } : {}),
            // A DM observer's edit is private content: the record becomes DM-origin.
            ...(c.origin.dm ? { origin: c.origin } : {})
          },
          now
        )
      );
      applied += 1;
      history.push({ tool: "update_memory", affectedMemoryIds: [record.id], summary: `[observer:update] ${op.content}` });
      continue;
    }

    if (op.op === "merge") {
      const into = target(op.into);
      const sources = [...new Set(op.from)].filter((handle) => handle !== op.into).map(target);
      if (!into || sources.length === 0 || sources.some((source) => !source || source.waifuId !== into.waifuId)) {
        skip(`merge with unknown, pinned or cross-owner memories (${op.into} ← ${op.from.join(", ")})`);
        continue;
      }
      const resolved = sources as MemoryRecord[];
      replace(
        bumpMemoryRecord(
          into,
          {
            content: op.content,
            strength: Math.max(into.strength, ...resolved.map((source) => source.strength)),
            subjects: dedupeSubjects([...into.subjects, ...resolved.flatMap((source) => source.subjects)]),
            // Merging private content in keeps it private (spec 9.1, O4).
            ...(mergedDmOrigin(c.origin, into, resolved) ? { origin: mergedDmOrigin(c.origin, into, resolved)! } : {})
          },
          now
        )
      );
      for (const source of resolved) replace(archiveMemoryRecord(source, "merged", now, into.id));
      applied += 1;
      history.push({
        tool: "merge_memories",
        affectedMemoryIds: [into.id, ...resolved.map((source) => source.id)],
        summary: `[observer:merge] ${op.content}`
      });
      continue;
    }

    const record = target(op.memory);
    if (!record) {
      skip(`expire of unknown, pinned or inactive memory ${op.memory}`);
      continue;
    }
    replace(archiveMemoryRecord(record, "expired", now));
    applied += 1;
    history.push({
      tool: "archive_memory",
      affectedMemoryIds: [record.id],
      summary: `[observer:expire] ${op.reason ? `${op.reason}: ` : ""}${record.content}`
    });
  }
  return { memories: working, queued, history, applied, skipped };
}

/** The DM origin a merge result must keep, if any part of it came from a private chat. */
export function mergedDmOrigin(
  context: MemoryOrigin,
  into: Pick<MemoryRecord, "origin">,
  sources: ReadonlyArray<Pick<MemoryRecord, "origin">>
): MemoryOrigin | undefined {
  if (context.dm) return context;
  if (into.origin.dm) return undefined; // already private
  return sources.find((source) => source.origin.dm)?.origin;
}
