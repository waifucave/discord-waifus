import { describe, expect, it } from "vitest";
import {
  applyDreamOps,
  buildWaifuDreamChunks,
  dreamChunkWaifuIds,
  dreamWaifuOrder,
  resolveDreamSubjects
} from "../src/orchestration/dream.js";
import { DreamOp } from "../src/orchestration/stageManager.js";
import { MemoryRecord, PendingObservation } from "../src/shared/schemas/domain.js";

const NOW = new Date("2026-06-12T05:00:00.000Z");
const KEVIN = { discordUserId: "111", name: "Kevin" };
const ALI = { discordUserId: "222", name: "Ali" };

function record(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  const created = overrides.createdAt ?? "2026-06-10T05:00:00.000Z";
  return {
    waifuId: "yuki",
    content: "Kevin likes tea.",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: { guildId: "guild-1" },
    subjects: [],
    revision: 0,
    createdAt: created,
    updatedAt: created,
    status: "active",
    ...overrides
  };
}

function observation(overrides: Partial<PendingObservation> & { id: string }): PendingObservation {
  return {
    waifuId: "yuki",
    content: "Kevin likes tea.",
    kind: "fact",
    importance: 3,
    subjects: [],
    origin: { guildId: "guild-1", channelId: "channel-1" },
    conversationKey: "g_guild-1_channel-1",
    createdAt: "2026-06-12T04:00:00.000Z",
    ...overrides
  };
}

function indexMapFor(records: MemoryRecord[]): Map<number, string> {
  const map = new Map<number, string>();
  records.forEach((r, index) => map.set(index + 1, r.id));
  return map;
}

describe("buildWaifuDreamChunks", () => {
  it("returns one chunk with the waifu's dreamable records and observations", () => {
    const records = [
      record({ id: "a" }),
      record({ id: "b", waifuId: "mika" }),
      record({ id: "pinned", pinned: true }),
      record({ id: "archived", status: "archived" })
    ];
    const chunks = buildWaifuDreamChunks("yuki", records, [observation({ id: "o1" }), observation({ id: "o2", waifuId: "mika" })], NOW);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].key).toBe("yuki");
    expect(chunks[0].indexMap.get(1)).toBe("a");
    expect(chunks[0].inputs).toHaveLength(1);
    expect(chunks[0].observations.map((o) => o.id)).toEqual(["o1"]);
  });

  it("computes ages, expiry and current subject names", () => {
    const records = [
      record({
        id: "note",
        source: "waifu_tool",
        kind: "context",
        subjects: [KEVIN],
        createdAt: "2026-06-10T05:00:00.000Z",
        lastRetrievedAt: "2026-06-11T05:00:00.000Z",
        expiresAt: "2026-06-12T17:00:00.000Z"
      })
    ];
    const [chunk] = buildWaifuDreamChunks("yuki", records, [], NOW, { nameFor: () => "Kev" });
    expect(chunk.inputs[0]).toMatchObject({ ageDays: 2, daysSinceRetrieved: 1, expiresInHours: 12, subjects: ["Kev"] });
  });

  it("returns no chunks for a waifu with nothing to dream", () => {
    expect(buildWaifuDreamChunks("yuki", [record({ id: "x", waifuId: "mika" })], [], NOW)).toEqual([]);
  });

  it("offers a waifu with observations but no memories (B12)", () => {
    const chunks = buildWaifuDreamChunks("aria", [], [observation({ id: "o-aria", waifuId: "aria" })], NOW);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].inputs).toEqual([]);
    expect(dreamChunkWaifuIds(chunks[0])).toEqual(["aria"]);
  });

  it("splits a large store into slices; observations ride the first; indices restart at 1", () => {
    const records = Array.from({ length: 170 }, (_, i) => record({ id: `y-${String(i).padStart(3, "0")}`, createdAt: new Date(NOW.getTime() - (200 - i) * 60_000).toISOString() }));
    const chunks = buildWaifuDreamChunks("yuki", records, [observation({ id: "o1" })], NOW, { chunkSize: 80 });
    expect(chunks.map((c) => c.key)).toEqual(["yuki", "yuki#2", "yuki#3"]);
    expect(chunks.map((c) => c.inputs.length)).toEqual([80, 80, 10]);
    expect(chunks[0].observations).toHaveLength(1);
    expect(chunks[1].observations).toHaveLength(0);
    expect(chunks[1].inputs[0].memoryIndex).toBe(1);
  });
});

describe("dreamWaifuOrder", () => {
  it("starts after the cursor and wraps around", () => {
    expect(dreamWaifuOrder(["yuki", "aria", "mika"], null)).toEqual(["aria", "mika", "yuki"]);
    expect(dreamWaifuOrder(["yuki", "aria", "mika"], "mika")).toEqual(["yuki", "aria", "mika"]);
    expect(dreamWaifuOrder(["yuki", "aria", "mika"], "yuki")).toEqual(["aria", "mika", "yuki"]);
    // A cursor whose waifu vanished still orders by position.
    expect(dreamWaifuOrder(["yuki", "aria", "mika"], "lumi")).toEqual(["mika", "yuki", "aria"]);
  });
});

describe("applyDreamOps", () => {
  const apply = (memories: MemoryRecord[], ops: DreamOp[], indexMap = indexMapFor(memories), extra: { maxOps?: number; observations?: PendingObservation[] } = {}) =>
    applyDreamOps(memories, ops, indexMap, { now: NOW, ...extra });

  it("add creates a dream record carrying the matching observation's subjects and origin", () => {
    const obs = observation({ id: "o1", content: "Kevin loves Aria's cooking.", subjects: [KEVIN] });
    const result = apply([], [
      { op: "add", memory: { waifuId: "yuki", content: "Kevin loves Aria's cooking.", kind: "preference", strength: 4, entities: [] } }
    ], new Map(), { observations: [obs] });
    expect(result.applied).toBe(1);
    expect(result.memories[0]).toMatchObject({
      source: "dream",
      waifuId: "yuki",
      strength: 4,
      kind: "preference",
      status: "active",
      revision: 0,
      subjects: [KEVIN],
      origin: { guildId: "guild-1", channelId: "channel-1" }
    });
    expect(result.historyEntries[0].summary).toContain("[dream:add]");
  });

  it("add goes through the write gate: a duplicate is skipped, a stronger one reinforces", () => {
    const existing = record({ id: "tea", content: "Kevin likes green tea.", subjects: [KEVIN], strength: 3 });
    const skipped = apply([existing], [
      { op: "add", memory: { waifuId: "yuki", content: "Kevin likes green tea", kind: "fact", strength: 2, entities: ["Kevin"] } }
    ]);
    expect(skipped.memories).toHaveLength(1);
    expect(skipped.skipped).toBe(1);
    const reinforced = apply([existing], [
      { op: "add", memory: { waifuId: "yuki", content: "Kevin likes green tea", kind: "fact", strength: 5, entities: ["Kevin"] } }
    ]);
    expect(reinforced.memories).toHaveLength(1);
    expect(reinforced.memories[0]).toMatchObject({ id: "tea", strength: 5, revision: 1 });
  });

  it("promote clears expiry, applies the patch and bumps the revision", () => {
    const memories = [record({ id: "note", source: "waifu_tool", kind: "context", strength: 2, expiresAt: "2026-06-13T05:00:00.000Z" })];
    const result = apply(memories, [
      { op: "promote", memoryIndex: 1, patch: { kind: "fact", strength: 4, content: "Kevin owns a 1998 Mercedes." } }
    ]);
    const promoted = result.memories[0];
    expect(promoted.expiresAt).toBeUndefined();
    expect(promoted).toMatchObject({ kind: "fact", strength: 4, content: "Kevin owns a 1998 Mercedes.", revision: 1 });
  });

  it("rewrite keeps subjects and adds entities resolvable from the chunk", () => {
    const memories = [record({ id: "a", content: "she owes him tacos", subjects: [KEVIN] }), record({ id: "b", subjects: [ALI] })];
    const result = apply(memories, [
      { op: "rewrite", memoryIndex: 1, content: "Kevin owes Ali tacos since Thursday.", entities: ["Ali", "Thursday"] }
    ]);
    expect(result.memories[0].content).toBe("Kevin owes Ali tacos since Thursday.");
    expect(result.memories[0].subjects).toEqual([KEVIN, ALI]);
    expect(result.memories[0].revision).toBe(1);
  });

  it("merge archives sources with mergedInto and adds one consolidated record with their subjects", () => {
    const memories = [
      record({ id: "a", content: "Kevin likes tea.", strength: 3, subjects: [KEVIN] }),
      record({ id: "b", content: "Kevin likes green tea.", strength: 4, subjects: [KEVIN] })
    ];
    const result = apply(memories, [
      { op: "merge", memoryIndices: [1, 2], content: "Kevin likes tea, especially green tea.", entities: ["Kevin"] }
    ]);
    const merged = result.memories.find((m) => m.status === "active" && m.source === "dream")!;
    expect(merged).toMatchObject({ content: "Kevin likes tea, especially green tea.", strength: 4, subjects: [KEVIN] });
    for (const id of ["a", "b"]) {
      expect(result.memories.find((m) => m.id === id)).toMatchObject({ status: "archived", archivedReason: "merged", mergedInto: merged.id, revision: 1 });
    }
  });

  it("decay and archive bump revisions; none changes nothing", () => {
    const decayed = apply([record({ id: "a", strength: 2 })], [{ op: "decay", memoryIndex: 1, strength: 0.5 }]);
    expect(decayed.memories[0]).toMatchObject({ strength: 0.5, status: "active", revision: 1 });
    const archived = apply([record({ id: "a", content: "The update ships tomorrow." })], [{ op: "archive", memoryIndex: 1, reason: "already shipped" }]);
    expect(archived.memories[0]).toMatchObject({ status: "archived", revision: 1 });
    expect(archived.historyEntries[0].summary).toContain("already shipped");
    const memories = [record({ id: "a" })];
    const none = apply(memories, [{ op: "none" }]);
    expect(none.memories).toEqual(memories);
    expect(none.historyEntries[0].tool).toBe("no_change");
  });

  it("skips pinned targets, unknown indices, pinned merge sources and ops beyond maxOps", () => {
    const pinned = apply([record({ id: "pinned", pinned: true })], [{ op: "archive", memoryIndex: 1, reason: "x" }]);
    expect(pinned.skipped).toBe(1);
    expect(pinned.historyEntries[0].summary).toContain("pinned");
    const unknown = apply([record({ id: "a" })], [{ op: "decay", memoryIndex: 9, strength: 1 }]);
    expect(unknown.historyEntries[0].summary).toContain("unknown memory index");
    const merge = apply([record({ id: "a" }), record({ id: "p", pinned: true })], [{ op: "merge", memoryIndices: [1, 2], content: "m", entities: [] }]);
    expect(merge.applied).toBe(0);
    const memories = [record({ id: "a" }), record({ id: "b" })];
    const capped = apply(memories, [{ op: "decay", memoryIndex: 1, strength: 1 }, { op: "decay", memoryIndex: 2, strength: 1 }], indexMapFor(memories), { maxOps: 1 });
    expect([capped.applied, capped.skipped]).toEqual([1, 1]);
  });

  it("a record from any guild is dreamable (no guild scope)", () => {
    const result = apply([record({ id: "foreign", origin: { guildId: "guild-2" } })], [{ op: "decay", memoryIndex: 1, strength: 1 }]);
    expect(result.applied).toBe(1);
  });

  it("skips an add whose waifuId is not allowed", () => {
    const { memories, skipped, historyEntries } = applyDreamOps(
      [],
      [{ op: "add", memory: { waifuId: "kevin", content: "Kevin likes tea.", kind: "preference", strength: 3, entities: [] } }],
      new Map(),
      { now: NOW, allowedWaifuIds: ["aria", "riko"] }
    );
    expect(memories).toHaveLength(0);
    expect(skipped).toBe(1);
    expect(historyEntries[0].summary).toContain("unknown waifu id kevin");
  });
});

describe("resolveDreamSubjects", () => {
  it("resolves names against the chunk's known subjects only (unique matches)", () => {
    const pool = [KEVIN, ALI, { discordUserId: "333", name: "Sam" }, { discordUserId: "444", name: "Sam" }];
    expect(resolveDreamSubjects(["Kevin", "Sam", "Thursday"], "Kevin and Sam went out", pool)).toEqual([KEVIN]);
    expect(resolveDreamSubjects([], "Ali owes Kevin tacos", pool)).toEqual([KEVIN, ALI]);
  });
});
