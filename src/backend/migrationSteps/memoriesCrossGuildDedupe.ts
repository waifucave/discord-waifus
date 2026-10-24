import { access } from "node:fs/promises";
import path from "node:path";
import { MemoryRecordSchema, type MemoryRecord } from "./legacySchemas.js";
import { subjectsOverlap } from "./legacy.js";
import { dedupeTokenSet, jaccard, normalizeForDedupe } from "../../orchestration/text.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, readJsonFile } from "./memorySupport.js";

export const MEMORIES_DEDUPE_MARKER = path.join("user", ".memories-dedupe-v1.json");
export const MEMORIES_DEDUPE_AUDIT = path.join("app", "logs", "migrations", "memories-dedupe-v1.json");
const DEDUPE_JACCARD = 0.92;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isDuplicatePair(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.waifuId !== b.waifuId || a.kind !== b.kind) return false;
  // Cross-guild only: same-guild near-duplicates are the dream's job.
  if ((a.origin.guildId ?? "") === (b.origin.guildId ?? "")) return false;
  const equal = normalizeForDedupe(a.content) === normalizeForDedupe(b.content);
  if (a.subjects.length === 0 && b.subjects.length === 0) return equal;
  if (!subjectsOverlap(a.subjects, b.subjects)) return false;
  return equal || jaccard(dedupeTokenSet(a.content), dedupeTokenSet(b.content)) >= DEDUPE_JACCARD;
}

// keep pinned > strongest > oldest (id breaks ties deterministically)
function keepOrder(a: MemoryRecord, b: MemoryRecord): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    b.strength - a.strength ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

// Step `memories-cross-guild-dedupe-v1` (spec 8.8): a conservative one-time merge of the
// duplicates that guild-scoped memory created — same waifu + kind, learned in different guilds,
// overlapping subjects (or both subject-less with normalized-equal text), and normalized
// equality or token jaccard ≥ 0.92. Per duplicate cluster the best record is kept (pinned >
// strongest > oldest); the rest are archived (`archivedReason: deduped`, `mergedInto`). Pinned
// records are never archived. Audited to app/logs/migrations/memories-dedupe-v1.json. Guarded by
// the marker file user/.memories-dedupe-v1.json so a lost migration ledger never re-runs it.
export async function migrateMemoriesCrossGuildDedupe(dataRoot: string): Promise<string | undefined> {
  const markerPath = path.join(dataRoot, MEMORIES_DEDUPE_MARKER);
  if (await exists(markerPath)) return undefined;
  const filePath = path.join(dataRoot, "user", "memories.json");
  const read = await readJsonFile(filePath);
  const now = new Date().toISOString();
  if (read.kind === "missing") {
    // Nothing to dedupe now; memories written later are never cross-guild legacy duplicates.
    await atomicWriteJson(markerPath, { appliedAt: now, archived: 0 });
    return undefined;
  }
  // An unreadable or malformed store is left untouched and unmarked, never treated as empty. In a
  // full boot the earlier memories-global-origin-subjects-v1 step already refuses such a store.
  if (read.kind === "invalid" || !isObject(read.value) || !Array.isArray(read.value.memories)) return undefined;
  const data = read.value;

  const raw = data.memories as unknown[];
  const parsed: Array<{ raw: Record<string, unknown>; record: MemoryRecord }> = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const result = MemoryRecordSchema.safeParse(item);
    if (result.success && result.data.status === "active") parsed.push({ raw: item, record: result.data });
  }

  // Union-find over duplicate pairs within each waifu+kind group.
  const parent = parsed.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const groups = new Map<string, number[]>();
  parsed.forEach((item, index) => {
    const key = `${item.record.waifuId}\u0000${item.record.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  for (const members of groups.values()) {
    for (let x = 0; x < members.length; x += 1) {
      for (let y = x + 1; y < members.length; y += 1) {
        const i = members[x]!;
        const j = members[y]!;
        if (isDuplicatePair(parsed[i]!.record, parsed[j]!.record)) parent[find(i)] = find(j);
      }
    }
  }
  const clusters = new Map<number, number[]>();
  parsed.forEach((_, index) => {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), index]);
  });

  const audit: Array<{ waifuId: string; kept: string; archived: string[] }> = [];
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;
    const ordered = [...indices].sort((a, b) => keepOrder(parsed[a]!.record, parsed[b]!.record));
    const keep = parsed[ordered[0]!]!.record;
    const archived: string[] = [];
    for (const index of ordered.slice(1)) {
      const item = parsed[index]!;
      if (item.record.pinned) continue;
      // Union-find chains transitively (A~B~C); only a record that is itself a duplicate of the
      // kept one is archived, so non-overlapping subjects and same-guild pairs never merge.
      if (!isDuplicatePair(keep, item.record)) continue;
      item.raw.status = "archived";
      item.raw.archivedReason = "deduped";
      item.raw.mergedInto = keep.id;
      item.raw.revision = item.record.revision + 1;
      item.raw.updatedAt = now;
      archived.push(item.record.id);
    }
    if (archived.length > 0) audit.push({ waifuId: keep.waifuId, kept: keep.id, archived });
  }

  const archivedCount = audit.reduce((sum, cluster) => sum + cluster.archived.length, 0);
  if (archivedCount > 0) {
    await atomicWriteJson(path.join(dataRoot, MEMORIES_DEDUPE_AUDIT), { appliedAt: now, archived: archivedCount, clusters: audit });
    await atomicWriteJson(filePath, data);
  }
  await atomicWriteJson(markerPath, { appliedAt: now, archived: archivedCount });
  return archivedCount > 0 ? `memories-cross-guild-dedupe-${archivedCount}` : undefined;
}
