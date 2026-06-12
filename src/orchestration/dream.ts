import { randomUUID } from "node:crypto";
import { MemoryRecord, PendingObservation } from "../shared/schemas/domain.js";
import { DreamMemoryInput } from "../providers/types.js";
import { DreamOp } from "./stageManager.js";
import { extractEntities } from "./memoryEntities.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// One unit of work for the dream pass: the active records for one waifu (or a budget-sized slice
// of all active records) plus the pending observations that belong to them. memoryIndex is 1-based
// WITHIN the chunk, and indexMap resolves it back to the stored record id at apply time.
export type DreamChunk = {
  inputs: DreamMemoryInput[];
  observations: PendingObservation[];
  indexMap: Map<number, string>;
};

function ageDays(from: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(from)) / MS_PER_DAY);
}

function toDreamInput(record: MemoryRecord, memoryIndex: number, now: Date): DreamMemoryInput {
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
  return input;
}

// Build the dream input chunks for one guild's records. All active, non-pinned records are
// candidates; when the count exceeds `budget` they are split into per-waifu chunks so each call
// stays within the model's prompt budget. Pending observations are routed to the chunk owning their
// waifu; observations whose waifu has no active records form their own chunk.
export function selectDreamInput(
  records: MemoryRecord[],
  pendingObservations: PendingObservation[],
  now: Date,
  budget = 80
): DreamChunk[] {
  const active = records.filter((record) => record.status === "active" && !record.pinned);

  const buildChunk = (chunkRecords: MemoryRecord[], chunkObservations: PendingObservation[]): DreamChunk => {
    const indexMap = new Map<number, string>();
    const inputs = chunkRecords.map((record, index) => {
      const memoryIndex = index + 1;
      indexMap.set(memoryIndex, record.id);
      return toDreamInput(record, memoryIndex, now);
    });
    return { inputs, observations: chunkObservations, indexMap };
  };

  // Under budget: a single chunk carries every record and every observation.
  if (active.length <= budget) {
    if (active.length === 0 && pendingObservations.length === 0) {
      return [];
    }
    return [buildChunk(active, pendingObservations)];
  }

  // Over budget: chunk by waifu. Deterministic order keeps the iteration loop stable.
  const waifuIds = [...new Set(active.map((record) => record.waifuId))].sort();
  const chunks: DreamChunk[] = [];
  const observedWaifus = new Set<string>();
  for (const waifuId of waifuIds) {
    const chunkRecords = active.filter((record) => record.waifuId === waifuId);
    const chunkObservations = pendingObservations.filter((observation) => observation.waifuId === waifuId);
    chunkObservations.forEach((observation) => observedWaifus.add(observation.waifuId));
    chunks.push(buildChunk(chunkRecords, chunkObservations));
  }
  // Observations whose waifu has no active records still need a home: one extra add-only chunk.
  const orphanObservations = pendingObservations.filter((observation) => !observedWaifus.has(observation.waifuId));
  if (orphanObservations.length > 0) {
    chunks.push(buildChunk([], orphanObservations));
  }
  return chunks;
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

// Apply a chunk's ops to the guild's memory store. Guardrails: pinned records are untouchable,
// unknown indices are skipped, ops beyond maxOps are dropped, and merge archives its sources while
// adding one consolidated record. indexMap is the PER-CHUNK 1-based memoryIndex → record id map.
export function applyDreamOps(
  memories: MemoryRecord[],
  ops: DreamOp[],
  indexMap: Map<number, string>,
  options: { guildId: string; now: Date; maxOps?: number; allowedWaifuIds?: string[] }
): ApplyDreamOpsResult {
  const { guildId } = options;
  const maxOps = options.maxOps ?? 30;
  const now = options.now.toISOString();
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

  const resolveTarget = (op: DreamOp["op"], memoryIndex: number): MemoryRecord | undefined => {
    const id = indexMap.get(memoryIndex);
    if (!id) {
      skipped += 1;
      pushHistory(op, [], `Skipped unknown memory index #${memoryIndex}`);
      return undefined;
    }
    const target = working.find((memory) => memory.id === id && memory.guildId === guildId);
    if (!target) {
      skipped += 1;
      pushHistory(op, [], `Skipped memory outside current guild (index #${memoryIndex})`);
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
      // The tool schema constrains waifuId to the chunk's waifus, but the orphan-observation
      // chunk carries no enum — re-validate so a hallucinated owner never lands in the store.
      if (options.allowedWaifuIds && !options.allowedWaifuIds.includes(op.memory.waifuId)) {
        skipped += 1;
        pushHistory("add", [], `Skipped add with unknown waifu id ${op.memory.waifuId}`);
        continue;
      }
      const id = randomUUID();
      const entities = op.memory.entities.length > 0 ? op.memory.entities : extractEntities(op.memory.content);
      working.push({
        id,
        guildId,
        waifuId: op.memory.waifuId,
        content: op.memory.content,
        kind: op.memory.kind,
        source: "dream",
        pinned: false,
        strength: op.memory.strength,
        entities,
        createdAt: now,
        updatedAt: now,
        status: "active"
      });
      applied += 1;
      pushHistory("add", [id], op.memory.content);
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
      const sources = working.filter((memory) => memory.guildId === guildId && ids.includes(memory.id));
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
      const entities = op.entities.length > 0 ? op.entities : extractEntities(op.content);
      const sourceIds = new Set(sources.map((memory) => memory.id));
      working = working
        .map((memory) =>
          memory.guildId === guildId && sourceIds.has(memory.id)
            ? { ...memory, status: "archived" as const, updatedAt: now }
            : memory
        )
        .concat({
          id,
          guildId,
          waifuId: sources[0].waifuId,
          content: op.content,
          kind: sources[0].kind,
          source: "dream",
          pinned: false,
          strength: Math.max(...sources.map((memory) => memory.strength)),
          entities,
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
      working = working.map((memory) => {
        if (memory.id !== target.id) return memory;
        const { expiresAt: _expiresAt, ...rest } = memory;
        return {
          ...rest,
          ...(op.patch.kind ? { kind: op.patch.kind } : {}),
          ...(op.patch.strength !== undefined ? { strength: op.patch.strength } : {}),
          ...(op.patch.content
            ? { content: op.patch.content, entities: extractEntities(op.patch.content) }
            : {}),
          updatedAt: now
        };
      });
      applied += 1;
      pushHistory("promote", [target.id], op.patch.content ?? target.content);
      continue;
    }

    if (op.op === "rewrite") {
      const entities = op.entities.length > 0 ? op.entities : extractEntities(op.content);
      working = working.map((memory) =>
        memory.id === target.id ? { ...memory, content: op.content, entities, updatedAt: now } : memory
      );
      applied += 1;
      pushHistory("rewrite", [target.id], op.content);
      continue;
    }

    if (op.op === "decay") {
      working = working.map((memory) =>
        memory.id === target.id ? { ...memory, strength: op.strength, updatedAt: now } : memory
      );
      applied += 1;
      pushHistory("decay", [target.id], `strength → ${op.strength}: ${target.content}`);
      continue;
    }

    // archive
    working = working.map((memory) =>
      memory.id === target.id ? { ...memory, status: "archived" as const, updatedAt: now } : memory
    );
    applied += 1;
    pushHistory("archive", [target.id], `${op.reason}: ${target.content}`);
  }

  return { memories: working, historyEntries, applied, skipped };
}

// Deterministic per-guild jitter seed: a guild's dream runs at a stable minute offset each night.
export function guildHash(guildId: string): number {
  let sum = 0;
  for (let i = 0; i < guildId.length; i += 1) {
    sum += guildId.charCodeAt(i);
  }
  return sum;
}
