import { describe, expect, it } from "vitest";
import { applyDreamOps, guildHash, selectDreamInput } from "../src/orchestration/dream.js";
import { DreamOp } from "../src/orchestration/stageManager.js";
import { MemoryRecord, PendingObservation } from "../src/shared/schemas/domain.js";

const NOW = new Date("2026-06-12T05:00:00.000Z");

function record(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  const created = overrides.createdAt ?? "2026-06-10T05:00:00.000Z";
  return {
    id: overrides.id,
    guildId: overrides.guildId ?? "guild-1",
    waifuId: overrides.waifuId ?? "yuki",
    content: overrides.content ?? "Kevin likes tea.",
    kind: overrides.kind ?? "fact",
    source: overrides.source ?? "stage_manager",
    pinned: overrides.pinned ?? false,
    strength: overrides.strength ?? 3,
    entities: overrides.entities ?? [],
    expiresAt: overrides.expiresAt,
    createdAt: created,
    updatedAt: overrides.updatedAt ?? created,
    lastRetrievedAt: overrides.lastRetrievedAt,
    status: overrides.status ?? "active",
    channelId: overrides.channelId
  };
}

function observation(overrides: Partial<PendingObservation> & { id: string }): PendingObservation {
  return {
    id: overrides.id,
    guildId: overrides.guildId ?? "guild-1",
    channelId: overrides.channelId ?? "channel-1",
    waifuId: overrides.waifuId ?? "yuki",
    content: overrides.content ?? "Kevin likes tea.",
    kind: overrides.kind ?? "fact",
    importance: overrides.importance ?? 3,
    entities: overrides.entities ?? [],
    createdAt: overrides.createdAt ?? "2026-06-12T04:00:00.000Z"
  };
}

function indexMapFor(records: MemoryRecord[]): Map<number, string> {
  const map = new Map<number, string>();
  records.forEach((r, index) => map.set(index + 1, r.id));
  return map;
}

describe("selectDreamInput", () => {
  it("returns one chunk under budget with all records and observations", () => {
    const records = [record({ id: "a" }), record({ id: "b", waifuId: "mika" })];
    const observations = [observation({ id: "o1" })];
    const chunks = selectDreamInput(records, observations, NOW);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].inputs.map((input) => input.memoryIndex)).toEqual([1, 2]);
    expect(chunks[0].observations).toEqual(observations);
    expect(chunks[0].indexMap.get(1)).toBe("a");
    expect(chunks[0].indexMap.get(2)).toBe("b");
  });

  it("excludes pinned and archived records", () => {
    const records = [
      record({ id: "active" }),
      record({ id: "pinned", pinned: true }),
      record({ id: "archived", status: "archived" })
    ];
    const chunks = selectDreamInput(records, [], NOW);
    expect(chunks[0].inputs.map((input) => input.memoryIndex)).toEqual([1]);
    expect(chunks[0].indexMap.get(1)).toBe("active");
  });

  it("computes ageDays, daysSinceRetrieved, and expiresInHours", () => {
    const records = [
      record({
        id: "note",
        source: "waifu_tool",
        kind: "context",
        createdAt: "2026-06-10T05:00:00.000Z",
        lastRetrievedAt: "2026-06-11T05:00:00.000Z",
        expiresAt: "2026-06-12T17:00:00.000Z"
      })
    ];
    const chunks = selectDreamInput(records, [], NOW);
    const input = chunks[0].inputs[0];
    expect(input.ageDays).toBe(2);
    expect(input.daysSinceRetrieved).toBe(1);
    expect(input.expiresInHours).toBe(12);
  });

  it("falls back to createdAt when lastRetrievedAt is absent", () => {
    const records = [record({ id: "a", createdAt: "2026-06-09T05:00:00.000Z" })];
    const chunks = selectDreamInput(records, [], NOW);
    expect(chunks[0].inputs[0].daysSinceRetrieved).toBe(3);
  });

  it("returns no chunks when there are no records and no observations", () => {
    expect(selectDreamInput([], [], NOW)).toEqual([]);
  });

  it("chunks by waifu when over budget, routing observations to the owning chunk", () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 60; i += 1) records.push(record({ id: `yuki-${i}`, waifuId: "yuki" }));
    for (let i = 0; i < 60; i += 1) records.push(record({ id: `mika-${i}`, waifuId: "mika" }));
    const observations = [
      observation({ id: "o-yuki", waifuId: "yuki" }),
      observation({ id: "o-mika", waifuId: "mika" })
    ];
    const chunks = selectDreamInput(records, observations, NOW, 80);
    expect(chunks).toHaveLength(2);
    // Deterministic order: mika sorts before yuki.
    expect(chunks[0].inputs.every((input) => input.waifuId === "mika")).toBe(true);
    expect(chunks[0].observations.map((o) => o.id)).toEqual(["o-mika"]);
    expect(chunks[1].inputs.every((input) => input.waifuId === "yuki")).toBe(true);
    expect(chunks[1].observations.map((o) => o.id)).toEqual(["o-yuki"]);
    // Each chunk's memoryIndex restarts at 1.
    expect(chunks[0].inputs[0].memoryIndex).toBe(1);
    expect(chunks[1].inputs[0].memoryIndex).toBe(1);
  });

  it("gives observations whose waifu has no active records their own chunk when over budget", () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 90; i += 1) records.push(record({ id: `yuki-${i}`, waifuId: "yuki" }));
    const observations = [observation({ id: "o-aria", waifuId: "aria" })];
    const chunks = selectDreamInput(records, observations, NOW, 80);
    expect(chunks).toHaveLength(2);
    const orphan = chunks[chunks.length - 1];
    expect(orphan.inputs).toEqual([]);
    expect(orphan.observations.map((o) => o.id)).toEqual(["o-aria"]);
  });
});

describe("applyDreamOps", () => {
  const guildId = "guild-1";
  const apply = (memories: MemoryRecord[], ops: DreamOp[], indexMap = indexMapFor(memories), maxOps?: number) =>
    applyDreamOps(memories, ops, indexMap, { guildId, now: NOW, maxOps });

  it("add creates a dream-sourced record with extracted entities when none given", () => {
    const result = apply([], [
      { op: "add", memory: { waifuId: "yuki", content: "Kevin loves Aria's cooking.", kind: "preference", strength: 4, entities: [] } }
    ], new Map());
    expect(result.applied).toBe(1);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({ source: "dream", waifuId: "yuki", strength: 4, kind: "preference", status: "active" });
    // extractEntities keeps mid-sentence capitalized tokens (sentence-initial "Kevin" is dropped).
    expect(result.memories[0].entities).toContain("Aria's");
    expect(result.historyEntries[0].tool).toBe("add_memory");
    expect(result.historyEntries[0].summary).toContain("[dream:add]");
  });

  it("promote clears expiry and applies the patch", () => {
    const memories = [record({ id: "note", source: "waifu_tool", kind: "context", strength: 2, expiresAt: "2026-06-13T05:00:00.000Z" })];
    const result = apply(memories, [
      { op: "promote", memoryIndex: 1, patch: { kind: "fact", strength: 4, content: "Kevin owns a 1998 Mercedes." } }
    ]);
    expect(result.applied).toBe(1);
    const promoted = result.memories[0];
    expect(promoted.expiresAt).toBeUndefined();
    expect(promoted.kind).toBe("fact");
    expect(promoted.strength).toBe(4);
    expect(promoted.content).toBe("Kevin owns a 1998 Mercedes.");
    expect(promoted.entities).toContain("Mercedes");
  });

  it("rewrite replaces content and re-extracts entities", () => {
    const memories = [record({ id: "a", content: "she owes him tacos" })];
    const result = apply(memories, [
      { op: "rewrite", memoryIndex: 1, content: "Riko owes Ali tacos since Thursday.", entities: ["Riko", "Ali"] }
    ]);
    expect(result.applied).toBe(1);
    expect(result.memories[0].content).toBe("Riko owes Ali tacos since Thursday.");
    expect(result.memories[0].entities).toEqual(["Riko", "Ali"]);
  });

  it("merge archives all sources and adds one consolidated record carrying op entities", () => {
    const memories = [
      record({ id: "a", content: "Kevin likes tea.", strength: 3 }),
      record({ id: "b", content: "Kevin likes green tea.", strength: 4 })
    ];
    const result = apply(memories, [
      { op: "merge", memoryIndices: [1, 2], content: "Kevin likes tea, especially green tea.", entities: ["Kevin"] }
    ]);
    expect(result.applied).toBe(1);
    expect(result.memories.find((m) => m.id === "a")?.status).toBe("archived");
    expect(result.memories.find((m) => m.id === "b")?.status).toBe("archived");
    const merged = result.memories.find((m) => m.status === "active" && m.source === "dream");
    expect(merged?.content).toBe("Kevin likes tea, especially green tea.");
    expect(merged?.strength).toBe(4);
    expect(merged?.entities).toEqual(["Kevin"]);
  });

  it("decay sets the new strength without archiving", () => {
    const memories = [record({ id: "a", strength: 2 })];
    const result = apply(memories, [{ op: "decay", memoryIndex: 1, strength: 0.5 }]);
    expect(result.applied).toBe(1);
    expect(result.memories[0].strength).toBe(0.5);
    expect(result.memories[0].status).toBe("active");
  });

  it("archive marks the record archived and records the reason", () => {
    const memories = [record({ id: "a", content: "The update ships tomorrow." })];
    const result = apply(memories, [{ op: "archive", memoryIndex: 1, reason: "already shipped" }]);
    expect(result.applied).toBe(1);
    expect(result.memories[0].status).toBe("archived");
    expect(result.historyEntries[0].summary).toContain("already shipped");
  });

  it("none writes a history note and changes nothing", () => {
    const memories = [record({ id: "a" })];
    const result = apply(memories, [{ op: "none" }]);
    expect(result.applied).toBe(0);
    expect(result.memories).toEqual(memories);
    expect(result.historyEntries[0].tool).toBe("no_change");
  });

  it("skips pinned records for every targeting op, recording the skip", () => {
    const memories = [record({ id: "pinned", pinned: true })];
    const result = apply(memories, [{ op: "archive", memoryIndex: 1, reason: "x" }]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.memories[0].status).toBe("active");
    expect(result.historyEntries[0].summary).toContain("pinned");
  });

  it("skips unknown indices", () => {
    const result = apply([record({ id: "a" })], [{ op: "decay", memoryIndex: 9, strength: 1 }]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.historyEntries[0].summary).toContain("unknown memory index");
  });

  it("skips records outside the guild", () => {
    const memories = [record({ id: "foreign", guildId: "guild-2" })];
    const result = apply(memories, [{ op: "decay", memoryIndex: 1, strength: 1 }]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.memories[0].strength).toBe(3);
  });

  it("skips a merge that contains a pinned source", () => {
    const memories = [record({ id: "a" }), record({ id: "pinned", pinned: true })];
    const result = apply(memories, [
      { op: "merge", memoryIndices: [1, 2], content: "merged", entities: [] }
    ]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.memories.every((m) => m.status === "active")).toBe(true);
  });

  it("drops ops beyond maxOps and counts them as skipped", () => {
    const memories = [record({ id: "a" }), record({ id: "b" })];
    const ops: DreamOp[] = [
      { op: "decay", memoryIndex: 1, strength: 1 },
      { op: "decay", memoryIndex: 2, strength: 1 }
    ];
    const result = apply(memories, ops, indexMapFor(memories), 1);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.memories.find((m) => m.id === "a")?.strength).toBe(1);
    expect(result.memories.find((m) => m.id === "b")?.strength).toBe(3);
  });
});

describe("guildHash", () => {
  it("is deterministic and sums char codes", () => {
    expect(guildHash("ab")).toBe("a".charCodeAt(0) + "b".charCodeAt(0));
    expect(guildHash("guild-1")).toBe(guildHash("guild-1"));
  });
});

describe("applyDreamOps waifu validation", () => {
  it("skips an add whose waifuId is not a configured waifu", () => {
    const { memories, applied, skipped, historyEntries } = applyDreamOps(
      [],
      [{ op: "add", memory: { waifuId: "kevin", content: "Kevin likes tea.", kind: "preference", strength: 3, entities: [] } }],
      new Map(),
      { guildId: "g1", now: new Date("2026-06-12T18:00:00Z"), allowedWaifuIds: ["aria", "riko"] }
    );
    expect(memories).toHaveLength(0);
    expect(applied).toBe(0);
    expect(skipped).toBe(1);
    expect(historyEntries[0].summary).toContain("unknown waifu id kevin");
  });

  it("accepts an add for a configured waifu", () => {
    const { memories, applied } = applyDreamOps(
      [],
      [{ op: "add", memory: { waifuId: "aria", content: "Aria hates mornings.", kind: "preference", strength: 3, entities: [] } }],
      new Map(),
      { guildId: "g1", now: new Date("2026-06-12T18:00:00Z"), allowedWaifuIds: ["aria", "riko"] }
    );
    expect(memories).toHaveLength(1);
    expect(applied).toBe(1);
  });
});
