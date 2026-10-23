import { afterEach, describe, expect, it } from "vitest";
import type { CandidateMemory } from "../src/orchestration/context/types.js";
import { applyDreamOps } from "../src/orchestration/dream.js";
import { admitMemoryWrite } from "../src/orchestration/memoryWriteGate.js";
import { applyObserverOps } from "../src/orchestration/observer.js";
import { buildHandleTable } from "../src/orchestration/memorySubjects.js";
import { applyMemoryCandidate, readMemoryStore, recordWaifuNotes } from "../src/orchestration/stores/memories.js";
import { MemoryStoreSchema, createEmptyRevisionedFile, type MemoryRecord } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const NOW = new Date("2026-10-23T12:00:00.000Z");
const KEVIN = { discordUserId: "111", name: "Kevin" };
const MIA = { discordUserId: "222", name: "Mia" };

function existing(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "tea",
    waifuId: "yuki",
    content: "Kevin likes green tea.",
    kind: "preference",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: { guildId: "g1" },
    subjects: [KEVIN],
    revision: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: "active",
    ...overrides
  };
}

function candidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    waifuId: "yuki",
    kind: "preference",
    content: "kevin likes green tea",
    subjects: [KEVIN],
    origin: { guildId: "g2" },
    source: "stage_manager",
    ...overrides
  };
}

describe("admitMemoryWrite", () => {
  it("duplicate ⇔ same waifu ∧ overlapping subjects ∧ (normalized equality ∨ jaccard ≥ 0.82 / 0.92 across kinds)", () => {
    const store = [existing()];
    expect(admitMemoryWrite(store, candidate())).toEqual({ action: "skip", duplicateOf: "tea" });
    // Different waifu, disjoint subjects, unrelated text: insert.
    expect(admitMemoryWrite(store, candidate({ waifuId: "mika" }))).toEqual({ action: "insert" });
    expect(admitMemoryWrite(store, candidate({ subjects: [MIA] }))).toEqual({ action: "insert" });
    expect(admitMemoryWrite(store, candidate({ content: "Kevin hates loud music" }))).toEqual({ action: "insert" });
    // Near-duplicate (jaccard 0.8 < 0.82): insert; at/above the same-kind threshold: duplicate.
    expect(admitMemoryWrite(store, candidate({ content: "Kevin likes green tea a lot" }))).toEqual({ action: "insert" });
    expect(admitMemoryWrite([existing({ content: "Kevin really likes green tea every morning" })],
      candidate({ content: "Kevin really likes green tea every single morning" }))).toEqual({ action: "skip", duplicateOf: "tea" });
    // Across kinds the bar is 0.92 (equality still counts).
    expect(admitMemoryWrite([existing({ content: "Kevin really likes green tea every morning" })],
      candidate({ kind: "fact", content: "Kevin really likes green tea every single morning" }))).toEqual({ action: "insert" });
    expect(admitMemoryWrite(store, candidate({ kind: "fact" }))).toEqual({ action: "skip", duplicateOf: "tea" });
    // Both subject-less still compare; numbers are significant.
    const noSubjects = [existing({ subjects: [], content: "The bake-off is on 12 December." })];
    expect(admitMemoryWrite(noSubjects, candidate({ subjects: [], content: "the bake-off is on 12 december" })).action).toBe("skip");
    expect(admitMemoryWrite(noSubjects, candidate({ subjects: [], content: "The bake-off is on 13 December." })).action).toBe("insert");
  });

  it("archived and expired records never count", () => {
    expect(admitMemoryWrite([existing({ status: "archived" })], candidate())).toEqual({ action: "insert" });
    expect(admitMemoryWrite([existing({ expiresAt: "2026-10-23T11:00:00.000Z" })], candidate(), { now: NOW })).toEqual({ action: "insert" });
  });

  it("reinforces a weaker duplicate, skips a pinned one, and is report-only for users", () => {
    expect(admitMemoryWrite([existing()], candidate({ importance: 5 }))).toEqual({ action: "reinforce", targetId: "tea" });
    expect(admitMemoryWrite([existing({ pinned: true })], candidate({ importance: 5 }))).toEqual({ action: "skip", duplicateOf: "tea" });
    const user = applyMemoryCandidate([existing()], candidate({ source: "user" }), { writer: "user", now: NOW });
    expect(user.memories).toHaveLength(2);
    expect(user.duplicateOf).toBe("tea");
  });
});

describe("every writer goes through the gate", () => {
  it("waifu tool notes (recordWaifuNotes) skip duplicates already in the store", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    await storage.writeJson("memories:global", "user/memories.json", MemoryStoreSchema,
      MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [existing({ kind: "context", subjects: [], content: "Kevin is baking bread tonight." })] })));
    const decisions = await recordWaifuNotes(storage, {
      waifuId: "yuki",
      guildId: "g9",
      channelId: "c9",
      entries: ["kevin is baking bread tonight", "Kevin is baking bread tonight!", "Mia is visiting on Friday."],
      now: NOW
    });
    expect(decisions.map((decision) => decision.action)).toEqual(["skip", "skip", "insert"]);
    const store = await readMemoryStore(storage);
    expect(store.memories.map((memory) => memory.content)).toEqual(["Kevin is baking bread tonight.", "Mia is visiting on Friday."]);
    expect(store.memories[1]).toMatchObject({ origin: { guildId: "g9", channelId: "c9" }, kind: "context", strength: 2, revision: 0 });
  });

  it("observer adds (stage_manager) and dream adds are gated", () => {
    const handles = buildHandleTable([{ discordUserId: "111", displayName: "Kevin", isHuman: true }]);
    const observer = applyObserverOps([existing()], [
      { op: "add", waifuId: "yuki", content: "Kevin likes green tea", kind: "preference", importance: 4, subjects: ["p1"] }
    ], { handles, memoryHandles: new Map(), allowedWaifuIds: ["yuki"], origin: {}, now: NOW });
    expect(observer.memories).toHaveLength(1);
    expect(observer.memories[0]).toMatchObject({ id: "tea", strength: 4, revision: 1 });
    const dream = applyDreamOps([existing()], [
      { op: "add", memory: { waifuId: "yuki", content: "Kevin likes green tea.", kind: "preference", strength: 2, entities: ["Kevin"] } }
    ], new Map([[1, "tea"]]), { now: NOW });
    expect(dream.memories).toHaveLength(1);
    expect(dream.skipped).toBe(1);
  });
});
