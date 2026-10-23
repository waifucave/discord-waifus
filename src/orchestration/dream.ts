import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RevisionedRecordSchema } from "../shared/schemas/common.js";
import type { MemoryOrigin, MemoryRecord, MemorySubject, PendingObservation } from "../shared/schemas/domain.js";
import { DreamMemoryInput } from "../providers/types.js";
import { DreamOp } from "./stageManager.js";
import { dedupeSubjects, normalizeName } from "./memorySubjects.js";
import { applyMemoryCandidate, archiveMemoryRecord, bumpMemoryRecord } from "./stores/memories.js";
import { dedupeTokenSet, jaccard, normalizeForDedupe } from "./text.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Max memories per dream call; a waifu with more is split into several chunks. */
export const DREAM_CHUNK_SIZE = 80;
/** Dream calls per night across all waifus (spec 8.8, B12). */
export const DREAM_CHUNKS_PER_NIGHT = 8;

// One unit of work for the (global) dream pass: one waifu's active, non-pinned records (or an
// 80-record slice of them) plus that waifu's pending observations (first slice only).
// memoryIndex is 1-based WITHIN the chunk; indexMap resolves it back to the stored record id.
// key: the waifu id, `<waifuId>#<n>` for later slices.
export type DreamChunk = {
  key: string;
  waifuId: string;
  inputs: DreamMemoryInput[];
  observations: PendingObservation[];
  indexMap: Map<number, string>;
};

function ageDays(from: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(from)) / MS_PER_DAY);
}

function toDreamInput(record: MemoryRecord, memoryIndex: number, now: Date, nameFor: (s: MemorySubject) => string): DreamMemoryInput {
  const lastRetrieved = record.lastRetrievedAt ?? record.createdAt;
  const input: DreamMemoryInput = {
    memoryIndex,
    waifuId: record.waifuId,
    content: record.content,
    kind: record.kind,
    strength: record.strength,
    ageDays: Math.round(ageDays(record.createdAt, now) * 10) / 10,
    daysSinceRetrieved: Math.round(ageDays(lastRetrieved, now) * 10) / 10
  };
  if (record.expiresAt) {
    const hours = (Date.parse(record.expiresAt) - now.getTime()) / MS_PER_HOUR;
    input.expiresInHours = Math.round(hours * 10) / 10;
  }
  if (record.subjects.length > 0) input.subjects = record.subjects.map(nameFor);
  return input;
}

/** The dream chunks for one waifu; [] when she has neither dreamable records nor observations. */
export function buildWaifuDreamChunks(
  waifuId: string,
  records: MemoryRecord[],
  pendingObservations: PendingObservation[],
  now: Date,
  options: { chunkSize?: number; nameFor?: (s: MemorySubject) => string } = {}
): DreamChunk[] {
  const chunkSize = Math.max(1, options.chunkSize ?? DREAM_CHUNK_SIZE);
  const nameFor = options.nameFor ?? ((s: MemorySubject) => s.name);
  const active = records
    .filter((record) => record.waifuId === waifuId && record.status === "active" && !record.pinned)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const observations = pendingObservations.filter((observation) => observation.waifuId === waifuId);
  if (active.length === 0 && observations.length === 0) return [];
  const chunks: DreamChunk[] = [];
  for (let start = 0; start === 0 || start < active.length; start += chunkSize) {
    const slice = active.slice(start, start + chunkSize);
    const indexMap = new Map<number, string>();
    const inputs = slice.map((record, index) => {
      indexMap.set(index + 1, record.id);
      return toDreamInput(record, index + 1, now, nameFor);
    });
    const n = chunks.length;
    chunks.push({
      key: n === 0 ? waifuId : `${waifuId}#${n + 1}`,
      waifuId,
      inputs,
      observations: n === 0 ? observations : [],
      indexMap
    });
  }
  return chunks;
}

// Persisted global round-robin cursor: the last waifu whose chunks a nightly pass completed. A
// night is capped at DREAM_CHUNKS_PER_NIGHT, so without rotation the alphabetically-first
// waifus would be dreamed every night and later ones never.
export const DreamCursorFileSchema = RevisionedRecordSchema.extend({
  cursor: z.string().min(1).nullable().default(null)
});
export type DreamCursorFile = z.infer<typeof DreamCursorFileSchema>;
export const DREAM_CURSOR_RELATIVE_PATH = "user/memory/dream-cursor.json";

/** Waifu ids sorted, rotated to start right AFTER the cursor (ids that vanished still order). */
export function dreamWaifuOrder(waifuIds: Iterable<string>, cursor: string | null | undefined): string[] {
  const sorted = [...new Set(waifuIds)].sort();
  if (!cursor || sorted.length < 2) return sorted;
  const start = sorted.findIndex((id) => id > cursor);
  if (start <= 0) return sorted;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

// Waifus a chunk is about: owners of its records AND of its observations (a waifu whose first
// memories are still queued has no records yet). Dream ops may only assign memories to these.
export function dreamChunkWaifuIds(chunk: Pick<DreamChunk, "inputs" | "observations">): string[] {
  return [
    ...new Set([
      ...chunk.inputs.map((input) => input.waifuId),
      ...chunk.observations.map((observation) => observation.waifuId)
    ])
  ].sort();
}

export type DreamHistoryEntry = {
  id: string;
  // Mapped onto the existing stage-manager history enum for storage compatibility; the real op is
  // named in the [dream] summary.
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  affectedMemoryIds: string[];
  summary: string;
  createdAt: string;
};

export type ApplyDreamOpsResult = {
  memories: MemoryRecord[];
  historyEntries: DreamHistoryEntry[];
  applied: number;
  skipped: number;
};

const OP_TO_HISTORY_TOOL: Record<DreamOp["op"], DreamHistoryEntry["tool"]> = {
  add: "add_memory",
  promote: "update_memory",
  rewrite: "update_memory",
  merge: "merge_memories",
  decay: "update_memory",
  archive: "archive_memory",
  none: "no_change"
};

function poolSubject(name: string, pool: MemorySubject[]): MemorySubject | undefined {
  const key = normalizeName(name);
  const matches = dedupeSubjects(pool.filter((subject) => normalizeName(subject.name) === key));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Subjects for dream output: the op's entity names resolved against the chunk's known subjects
 * (records + observations, unique name match only), plus known subjects named in the content.
 */
export function resolveDreamSubjects(names: string[], content: string, pool: MemorySubject[]): MemorySubject[] {
  const fromNames = names.map((name) => poolSubject(name, pool)).filter((s): s is MemorySubject => s !== undefined);
  const haystack = normalizeName(content);
  const named = dedupeSubjects(pool).filter((subject) => {
    const key = normalizeName(subject.name);
    return key.length >= 2 && haystack.includes(key) && poolSubject(subject.name, pool) !== undefined;
  });
  return dedupeSubjects([...fromNames, ...named]);
}

function matchingObservation(observations: PendingObservation[], waifuId: string, content: string): PendingObservation | undefined {
  const normalized = normalizeForDedupe(content);
  const tokens = dedupeTokenSet(content);
  return observations.find(
    (observation) =>
      observation.waifuId === waifuId &&
      (normalizeForDedupe(observation.content) === normalized || jaccard(tokens, dedupeTokenSet(observation.content)) >= 0.82)
  );
}

// Apply a chunk's ops to the (global) memory store. Guardrails: pinned records are untouchable,
// unknown indices are skipped, ops beyond maxOps are dropped, adds go through the write gate,
// and merge archives its sources (mergedInto the consolidated record). Every content write
// bumps the record revision. indexMap is the PER-CHUNK 1-based memoryIndex → record id map.
export function applyDreamOps(
  memories: MemoryRecord[],
  ops: DreamOp[],
  indexMap: Map<number, string>,
  options: { now: Date; maxOps?: number; allowedWaifuIds?: string[]; observations?: PendingObservation[] }
): ApplyDreamOpsResult {
  const maxOps = options.maxOps ?? 30;
  const nowDate = options.now;
  const now = nowDate.toISOString();
  const observations = options.observations ?? [];
  const chunkIds = new Set(indexMap.values());
  const pool: MemorySubject[] = [
    ...memories.filter((memory) => chunkIds.has(memory.id)).flatMap((memory) => memory.subjects),
    ...observations.flatMap((observation) => observation.subjects ?? [])
  ];
  const historyEntries: DreamHistoryEntry[] = [];
  let working = [...memories];
  let applied = 0;
  let skipped = 0;

  const pushHistory = (op: DreamOp["op"], affectedMemoryIds: string[], summary: string): void => {
    historyEntries.push({
      id: randomUUID(),
      tool: OP_TO_HISTORY_TOOL[op],
      affectedMemoryIds,
      summary: `[dream:${op}] ${summary}`,
      createdAt: now
    });
  };
  const replace = (next: MemoryRecord) => {
    working = working.map((memory) => (memory.id === next.id ? next : memory));
  };

  const resolveTarget = (op: DreamOp["op"], memoryIndex: number): MemoryRecord | undefined => {
    const id = indexMap.get(memoryIndex);
    if (!id) {
      skipped += 1;
      pushHistory(op, [], `Skipped unknown memory index #${memoryIndex}`);
      return undefined;
    }
    const target = working.find((memory) => memory.id === id);
    if (!target) {
      skipped += 1;
      pushHistory(op, [], `Skipped memory that no longer exists (index #${memoryIndex})`);
      return undefined;
    }
    if (target.pinned) {
      skipped += 1;
      pushHistory(op, [], `Skipped user-managed pinned memory (index #${memoryIndex})`);
      return undefined;
    }
    return target;
  };

  let processed = 0;
  for (const op of ops) {
    if (processed >= maxOps) {
      skipped += 1;
      continue;
    }
    processed += 1;

    if (op.op === "none") {
      pushHistory("none", [], "No memory changes");
      continue;
    }

    if (op.op === "add") {
      // The tool schema constrains waifuId to the chunk's waifus, but re-validate so a
      // hallucinated owner never lands in the store.
      if (options.allowedWaifuIds && !options.allowedWaifuIds.includes(op.memory.waifuId)) {
        skipped += 1;
        pushHistory("add", [], `Skipped add with unknown waifu id ${op.memory.waifuId}`);
        continue;
      }
      const source = matchingObservation(observations, op.memory.waifuId, op.memory.content);
      const subjects = dedupeSubjects([
        ...(source?.subjects ?? []),
        ...resolveDreamSubjects(op.memory.entities, op.memory.content, pool)
      ]);
      const origin: MemoryOrigin = source?.origin ?? {};
      const result = applyMemoryCandidate(
        working,
        { waifuId: op.memory.waifuId, kind: op.memory.kind, content: op.memory.content, subjects, origin, importance: op.memory.strength, source: "dream" },
        { writer: "dream", now: nowDate, strength: op.memory.strength }
      );
      working = result.memories;
      if (result.decision.action === "skip") {
        skipped += 1;
        pushHistory("add", [], `Skipped duplicate of ${result.decision.duplicateOf}: ${op.memory.content}`);
        continue;
      }
      applied += 1;
      pushHistory("add", result.recordId ? [result.recordId] : [], op.memory.content);
      continue;
    }

    if (op.op === "merge") {
      const ids: string[] = [];
      let unresolved = false;
      for (const index of new Set(op.memoryIndices)) {
        const id = indexMap.get(index);
        if (!id) {
          unresolved = true;
          break;
        }
        ids.push(id);
      }
      const sources = working.filter((memory) => ids.includes(memory.id) && memory.status === "active");
      if (unresolved || sources.length < 2) {
        skipped += 1;
        pushHistory("merge", [], "Skipped merge with unknown or duplicate memory indices");
        continue;
      }
      if (sources.some((memory) => memory.pinned)) {
        skipped += 1;
        pushHistory("merge", [], "Skipped merge containing a user-managed pinned memory");
        continue;
      }
      const id = randomUUID();
      const subjects = dedupeSubjects([
        ...sources.flatMap((memory) => memory.subjects),
        ...resolveDreamSubjects(op.entities, op.content, pool)
      ]);
      for (const memory of sources) replace(archiveMemoryRecord(memory, "merged", now, id));
      working.push({
        id,
        waifuId: sources[0]!.waifuId,
        content: op.content,
        kind: sources[0]!.kind,
        source: "dream",
        pinned: false,
        strength: Math.max(...sources.map((memory) => memory.strength)),
        origin: sources[0]!.origin,
        subjects,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        status: "active"
      });
      applied += 1;
      pushHistory("merge", [id, ...sources.map((memory) => memory.id)], op.content);
      continue;
    }

    // The remaining ops (promote, rewrite, decay, archive) all target a single existing record.
    const target = resolveTarget(op.op, op.memoryIndex);
    if (!target) continue;

    if (op.op === "promote") {
      const { expiresAt: _expiresAt, ...rest } = target;
      replace(
        bumpMemoryRecord(
          rest as MemoryRecord,
          {
            ...(op.patch.kind ? { kind: op.patch.kind } : {}),
            ...(op.patch.strength !== undefined ? { strength: op.patch.strength } : {}),
            ...(op.patch.content ? { content: op.patch.content } : {})
          },
          now
        )
      );
      applied += 1;
      pushHistory("promote", [target.id], op.patch.content ?? target.content);
      continue;
    }

    if (op.op === "rewrite") {
      const subjects = dedupeSubjects([...target.subjects, ...resolveDreamSubjects(op.entities, op.content, pool)]);
      replace(bumpMemoryRecord(target, { content: op.content, subjects }, now));
      applied += 1;
      pushHistory("rewrite", [target.id], op.content);
      continue;
    }

    if (op.op === "decay") {
      replace(bumpMemoryRecord(target, { strength: op.strength }, now));
      applied += 1;
      pushHistory("decay", [target.id], `strength → ${op.strength}: ${target.content}`);
      continue;
    }

    // archive: the record is false or superseded (no archivedReason fits a judgement call).
    replace(archiveMemoryRecord(target, undefined, now));
    applied += 1;
    pushHistory("archive", [target.id], `${op.reason}: ${target.content}`);
  }

  return { memories: working, historyEntries, applied, skipped };
}
