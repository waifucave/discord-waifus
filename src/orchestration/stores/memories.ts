// Memory store persistence. Every writer (waifu tool, stage-manager observer, dream, user/API)
// goes through `applyMemoryCandidate` → `admitMemoryWrite` (spec 8.8); content writes bump the
// per-record `revision`, retrieval stamps (`lastRetrievedAt`) never do.

import { randomUUID } from "node:crypto";
import {
  type MemoryArchivedReason,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryStore,
  MemoryStoreSchema,
  type MemorySubject,
  type PendingObservationsFile,
  PendingObservationsFileSchema,
  createEmptyRevisionedFile
} from "../../shared/schemas/domain.js";
import { StorageService } from "../../storage/storageService.js";
import type { CandidateMemory } from "../context/types.js";
import {
  type SubjectDirectory,
  WAIFU_NOTE_STRENGTH,
  dedupeSubjects,
  loadSubjectDirectory,
  resolveSubjectsInText
} from "../memorySubjects.js";
import { type GateDecision, type MemoryWriter, admitMemoryWrite } from "../memoryWriteGate.js";

export const MEMORY_STORE_RESOURCE = "memories:global";
export const MEMORY_STORE_PATH = "user/memories.json";
export const PENDING_OBSERVATIONS_RESOURCE = "memory:pending";
export const PENDING_OBSERVATIONS_PATH = "user/memory/pending-observations.json";

export function emptyMemoryStore(): MemoryStore {
  return MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }));
}

export async function readMemoryStore(storage: StorageService): Promise<MemoryStore> {
  return storage.readJson(MEMORY_STORE_PATH, MemoryStoreSchema, emptyMemoryStore());
}

export function emptyPendingObservations(): PendingObservationsFile {
  return PendingObservationsFileSchema.parse(createEmptyRevisionedFile({ observations: [] }));
}

export async function readPendingObservations(storage: StorageService): Promise<PendingObservationsFile> {
  return storage.readJson(PENDING_OBSERVATIONS_PATH, PendingObservationsFileSchema, emptyPendingObservations());
}

export function updateMemoryStore(
  storage: StorageService,
  transform: (current: MemoryStore) => MemoryStore | Promise<MemoryStore>,
  expectedRevision?: number
): Promise<MemoryStore> {
  return storage.updateRevisionedJson({
    resourceKey: MEMORY_STORE_RESOURCE,
    relativePath: MEMORY_STORE_PATH,
    schema: MemoryStoreSchema,
    fallback: emptyMemoryStore(),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    transform
  });
}

export function updatePendingObservations(
  storage: StorageService,
  transform: (current: PendingObservationsFile) => PendingObservationsFile
): Promise<PendingObservationsFile> {
  return storage.updateRevisionedJson({
    resourceKey: PENDING_OBSERVATIONS_RESOURCE,
    relativePath: PENDING_OBSERVATIONS_PATH,
    schema: PendingObservationsFileSchema,
    fallback: emptyPendingObservations(),
    transform
  });
}

/** A content write: applies the patch, bumps the record revision and updatedAt. */
export function bumpMemoryRecord(record: MemoryRecord, patch: Partial<MemoryRecord>, now: string): MemoryRecord {
  return { ...record, ...patch, revision: record.revision + 1, updatedAt: now };
}

export function archiveMemoryRecord(
  record: MemoryRecord,
  reason: MemoryArchivedReason | undefined,
  now: string,
  mergedInto?: string
): MemoryRecord {
  return bumpMemoryRecord(
    record,
    {
      status: "archived",
      ...(reason ? { archivedReason: reason } : {}),
      ...(mergedInto ? { mergedInto } : {})
    },
    now
  );
}

export type ApplyCandidateOptions = {
  writer?: MemoryWriter;
  now: Date;
  id?: string;
  strength?: number; // defaults to importance, else 3
  pinned?: boolean;
  expiresAt?: string;
};

export type ApplyCandidateResult = {
  memories: MemoryRecord[];
  decision: GateDecision;
  /** Id of the inserted or reinforced record (undefined when skipped). */
  recordId?: string;
  /** User writes only: the duplicate reported (the record was inserted anyway). */
  duplicateOf?: string;
};

/**
 * The single write path for new memories. User writes are report-only (always inserted, the
 * duplicate is returned as `duplicateOf`); other writers insert, reinforce or skip.
 */
export function applyMemoryCandidate(
  memories: MemoryRecord[],
  candidate: CandidateMemory,
  options: ApplyCandidateOptions
): ApplyCandidateResult {
  const writer = options.writer ?? candidate.source;
  const nowIso = options.now.toISOString();
  const decision = admitMemoryWrite(memories, candidate, { writer, now: options.now });
  const insert = (): ApplyCandidateResult => {
    const id = options.id ?? randomUUID();
    const record: MemoryRecord = {
      id,
      waifuId: candidate.waifuId,
      content: candidate.content,
      kind: candidate.kind,
      source: candidate.source,
      pinned: options.pinned ?? false,
      strength: clampStrength(options.strength ?? candidate.importance ?? 3),
      origin: candidate.origin,
      subjects: dedupeSubjects(candidate.subjects),
      revision: 0,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      status: "active"
    };
    return {
      memories: [...memories, record],
      decision,
      recordId: id,
      ...(decision.action === "skip" ? { duplicateOf: decision.duplicateOf } : {})
    };
  };
  if (decision.action === "insert" || writer === "user") return insert();
  if (decision.action === "skip") return { memories, decision };
  const importance = candidate.importance ?? 0;
  return {
    memories: memories.map((record) => {
      if (record.id !== decision.targetId) return record;
      const expiresAt = !record.expiresAt || !options.expiresAt
        ? undefined
        : record.expiresAt > options.expiresAt ? record.expiresAt : options.expiresAt;
      const { expiresAt: _drop, ...rest } = record;
      return bumpMemoryRecord(
        rest as MemoryRecord,
        {
          strength: clampStrength(Math.max(record.strength, importance)),
          subjects: dedupeSubjects([...record.subjects, ...candidate.subjects]),
          ...(expiresAt ? { expiresAt } : {})
        },
        nowIso
      );
    }),
    decision,
    recordId: decision.targetId
  };
}

function clampStrength(value: number): number {
  return Math.max(0, Math.min(5, value));
}

// Waifu notes (formerly the short-term store) survive a weekend so a Friday plan is still around
// Monday; the dream pass promotes the keepers.
export const NOTE_LIFESPAN_MS = 72 * 60 * 60 * 1000;
const NOTE_MAX_PER_REPLY = 5;

/** The waifu `add_memory` tool writer: short-lived `context` notes through the gate. */
export async function recordWaifuNotes(storage: StorageService, input: {
  waifuId: string;
  entries: string[];
  origin?: MemoryOrigin;
  guildId?: string;
  channelId?: string;
  directory?: SubjectDirectory;
  subjects?: MemorySubject[];
  now?: Date;
}): Promise<GateDecision[]> {
  if (input.entries.length === 0) return [];
  const capped = input.entries.slice(0, NOTE_MAX_PER_REPLY).map((entry) => entry.trim()).filter(Boolean);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + NOTE_LIFESPAN_MS).toISOString();
  const origin: MemoryOrigin = input.origin ?? {
    ...(input.guildId ? { guildId: input.guildId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {})
  };
  const directory = input.directory ?? (await loadSubjectDirectory(storage, origin.guildId));
  const decisions: GateDecision[] = [];
  await updateMemoryStore(storage, (current) => {
    decisions.length = 0;
    let memories = current.memories;
    for (const content of capped) {
      const result = applyMemoryCandidate(
        memories,
        {
          waifuId: input.waifuId,
          kind: "context",
          content,
          subjects: input.subjects ?? resolveSubjectsInText(content, directory),
          origin,
          importance: WAIFU_NOTE_STRENGTH,
          source: "waifu_tool"
        },
        { writer: "waifu_tool", now, strength: WAIFU_NOTE_STRENGTH, expiresAt }
      );
      memories = result.memories;
      decisions.push(result.decision);
    }
    return { ...current, memories };
  });
  return decisions;
}

const RETRIEVAL_STAMP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Stamp `lastRetrievedAt` (a retrieval statistic: never bumps the record revision). Records
 * stamped within the last hour are skipped to avoid noisy writes; nothing is written when no
 * record needs a stamp.
 */
export async function markMemoriesRetrieved(storage: StorageService, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  const nowMs = now.getTime();
  const due = (record: MemoryRecord) =>
    wanted.has(record.id) &&
    (!record.lastRetrievedAt || nowMs - Date.parse(record.lastRetrievedAt) > RETRIEVAL_STAMP_INTERVAL_MS);
  const store = await readMemoryStore(storage);
  if (!store.memories.some(due)) return;
  const stamp = now.toISOString();
  await updateMemoryStore(storage, (current) => ({
    ...current,
    memories: current.memories.map((record) => (due(record) ? { ...record, lastRetrievedAt: stamp } : record))
  }));
}
