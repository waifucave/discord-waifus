// The one dedupe gate every memory writer goes through (spec 8.8): waifu tool notes, observer
// adds, dream adds and user-created memories. Pure.

import type { MemoryRecord } from "../shared/schemas/domain.js";
import type { CandidateMemory } from "./context/types.js";
import { subjectsOverlap } from "./memorySubjects.js";
import { dedupeTokenSet, jaccard, normalizeForDedupe } from "./text.js";

export type MemoryWriter = "waifu_tool" | "stage_manager" | "dream" | "user";

export type GateDecision =
  | { action: "insert" }
  | { action: "reinforce"; targetId: string }
  | { action: "skip"; duplicateOf: string };

export const SAME_KIND_JACCARD = 0.82;
export const CROSS_KIND_JACCARD = 0.92;

function isLive(record: MemoryRecord, nowMs: number): boolean {
  return record.status === "active" && (!record.expiresAt || Date.parse(record.expiresAt) > nowMs);
}

/**
 * Duplicate ⇔ same waifuId ∧ subjects overlap (or both empty) ∧ (normalized equality ∨ token
 * jaccard ≥ 0.82 for the same kind, ≥ 0.92 across kinds). Only live (active, unexpired)
 * records count.
 */
export function findDuplicateMemory(
  store: MemoryRecord[],
  candidate: Pick<CandidateMemory, "waifuId" | "kind" | "content" | "subjects">,
  now: Date = new Date()
): MemoryRecord | undefined {
  const nowMs = now.getTime();
  const normalized = normalizeForDedupe(candidate.content);
  const tokens = dedupeTokenSet(candidate.content);
  let best: { record: MemoryRecord; score: number } | undefined;
  for (const record of store) {
    if (record.waifuId !== candidate.waifuId || !isLive(record, nowMs)) continue;
    const bothEmpty = record.subjects.length === 0 && candidate.subjects.length === 0;
    if (!bothEmpty && !subjectsOverlap(record.subjects, candidate.subjects)) continue;
    const equal = normalizeForDedupe(record.content) === normalized;
    const similarity = equal ? 1 : jaccard(tokens, dedupeTokenSet(record.content));
    const threshold = record.kind === candidate.kind ? SAME_KIND_JACCARD : CROSS_KIND_JACCARD;
    if (!equal && similarity < threshold) continue;
    if (!best || similarity > best.score) best = { record, score: similarity };
  }
  return best?.record;
}

/**
 * Gate one candidate write against the current store.
 * - no duplicate → insert;
 * - user writes are report-only: a duplicate yields `skip` with `duplicateOf`, and the API
 *   inserts anyway (it never blocks a user);
 * - a duplicate of a pinned record is skipped (pinned memories are never auto-edited);
 * - a duplicate whose strength is below the candidate's importance is reinforced (strength
 *   raised, revision bumped); otherwise it is skipped.
 */
export function admitMemoryWrite(
  store: MemoryRecord[],
  c: CandidateMemory,
  o: { writer?: MemoryWriter; now?: Date } = {}
): GateDecision {
  const duplicate = findDuplicateMemory(store, c, o.now);
  if (!duplicate) return { action: "insert" };
  const writer = o.writer ?? c.source;
  if (writer === "user" || duplicate.pinned) return { action: "skip", duplicateOf: duplicate.id };
  if (c.importance !== undefined && c.importance > duplicate.strength) {
    return { action: "reinforce", targetId: duplicate.id };
  }
  return { action: "skip", duplicateOf: duplicate.id };
}
