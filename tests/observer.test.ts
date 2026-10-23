import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../src/shared/schemas/context.js";
import type { MemoryRecord } from "../src/shared/schemas/domain.js";
import {
  applyObserverOps,
  existingMemoriesFor,
  ledgerEntriesAfterCursor,
  observerParticipants,
  renderObserverInput,
  windowMessagesAfterCursor
} from "../src/orchestration/observer.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import { parseRawObserverOps } from "../src/orchestration/tools.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const KEVIN = { discordUserId: "111", name: "Kevin" };
const MIA = { discordUserId: "222", name: "Mia" };

function entry(seq: number, authorId: string, authorName: string, body: string, bot = false): LedgerEntry {
  return {
    id: String(1000 + seq),
    seq,
    authorId,
    authorName,
    authorIsBot: bot,
    at: `2026-10-23T11:${String(seq).padStart(2, "0")}:00.000Z`,
    kind: "default",
    body,
    images: [],
    state: "live",
    sealed: false
  };
}

function memory(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    waifuId: "yuki",
    content: `Memory ${id}.`,
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: {},
    subjects: [KEVIN],
    revision: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    status: "active",
    ...overrides
  };
}

const entries = [
  entry(1, "111", "Kevin", "I'm allergic to peanuts btw"),
  entry(2, "900", "Yuki", "noted!", true),
  entry(3, "222", "Mia", "same here, but shellfish")
];
const waifuFor = (id: string) => (id === "900" ? "yuki" : undefined);

describe("observer input", () => {
  it("renders participants as handles, existing memories as m1..mN and the transcript", () => {
    const participants = observerParticipants(entries, waifuFor);
    const memories = existingMemoriesFor(
      [
        memory("a", { content: "Kevin loves hiking." }),
        memory("b", { subjects: [MIA], content: "Mia plays cello.", pinned: true, updatedAt: "2026-10-02T00:00:00.000Z" }),
        memory("c", { subjects: [{ discordUserId: "333", name: "Sam" }] }),
        memory("d", { waifuId: "mika" })
      ],
      { allowedWaifuIds: ["yuki"], participants, now: NOW }
    );
    expect(memories.map((m) => m.id)).toEqual(["b", "a"]);
    const input = renderObserverInput({ participants, memories, entries });
    expect(input.text).toBe([
      "Participants:",
      "- p1 = Kevin",
      "- w:yuki = Yuki (waifu)",
      "- p2 = Mia",
      "",
      "Existing memories:",
      "m1 [yuki · fact · strength 3 · pinned] about p2: Mia plays cello.",
      "m2 [yuki · fact · strength 3] about p1: Kevin loves hiking.",
      "",
      "Transcript:",
      "— 2026-10-23 (UTC) —",
      "[11:01] Kevin (p1): I'm allergic to peanuts btw",
      "[11:02] Yuki (w:yuki): noted!",
      "[11:03] Mia (p2): same here, but shellfish"
    ].join("\n"));
    expect(input.memoryHandles).toEqual(new Map([["m1", "b"], ["m2", "a"]]));
  });
});

describe("applyObserverOps", () => {
  const participants = observerParticipants(entries, waifuFor);
  const setup = (store: MemoryRecord[]) => {
    const input = renderObserverInput({ participants, memories: store, entries });
    return { handles: input.handles, memoryHandles: input.memoryHandles, allowedWaifuIds: ["yuki"], origin: { guildId: "g1", channelId: "c1" }, conversationKey: "g_g1_c1", now: NOW };
  };

  it("fast-tracks importance ≥ 4 adds through the gate and queues the rest for the dream", () => {
    const result = applyObserverOps([], [
      { op: "add", waifuId: "yuki", content: "Kevin is allergic to peanuts.", kind: "fact", importance: 5, subjects: ["p1"] },
      { op: "add", waifuId: "yuki", content: "Mia dislikes shellfish.", kind: "preference", importance: 3, subjects: ["Mia"] },
      { op: "add", waifuId: "kevin", content: "Hallucinated owner.", kind: "fact", importance: 5, subjects: [] }
    ], setup([]));
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      content: "Kevin is allergic to peanuts.",
      strength: 5,
      subjects: [{ discordUserId: "111", name: "Kevin" }],
      origin: { guildId: "g1", channelId: "c1" },
      source: "stage_manager"
    });
    expect(result.queued).toEqual([expect.objectContaining({
      content: "Mia dislikes shellfish.",
      subjects: [{ discordUserId: "222", name: "Mia" }],
      origin: { guildId: "g1", channelId: "c1" },
      conversationKey: "g_g1_c1"
    })]);
    expect(result.skipped).toBe(1);
  });

  it("update / merge / expire edit existing memories with revision bumps; pinned are read-only", () => {
    const store = [
      memory("a", { content: "Kevin likes tea." }),
      memory("b", { content: "Kevin drinks tea daily.", strength: 4 }),
      memory("c", { content: "Kevin plans a trip on 2026-10-20." }),
      memory("d", { content: "Kevin is vegan.", pinned: true })
    ];
    const result = applyObserverOps(store, [
      { op: "update", memory: "m1", content: "Kevin likes green tea.", importance: 4 },
      { op: "merge", into: "m1", from: ["m2"], content: "Kevin drinks green tea daily." },
      { op: "expire", memory: "m3", reason: "the trip happened" },
      { op: "update", memory: "m4", content: "Kevin eats meat now." },
      { op: "expire", memory: "m9" }
    ], setup(store));
    const byId = new Map(result.memories.map((m) => [m.id, m]));
    expect(byId.get("a")).toMatchObject({ content: "Kevin drinks green tea daily.", strength: 4, revision: 2, status: "active" });
    expect(byId.get("b")).toMatchObject({ status: "archived", archivedReason: "merged", mergedInto: "a", revision: 1 });
    expect(byId.get("c")).toMatchObject({ status: "archived", archivedReason: "expired", revision: 1 });
    expect(byId.get("d")).toMatchObject({ content: "Kevin is vegan.", revision: 0 });
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(2);
  });
});

describe("parseRawObserverOps", () => {
  it("drops individually malformed ops but throws when a non-empty response has no valid op", () => {
    expect(parseRawObserverOps([])).toEqual([]);
    expect(parseRawObserverOps([{ op: "expire", memory: "m1" }, { op: "bogus" }])).toEqual([{ op: "expire", memory: "m1" }]);
    expect(() => parseRawObserverOps([{ op: "update" }, { nonsense: true }])).toThrow(/No valid observer ops/);
  });
});

describe("observer cursor", () => {
  it("ledger: reads only entries after cursorSeq, in cap-sized batches, and settles at the head", () => {
    const ledger = [1, 2, 3, 4, 5].map((seq) => entry(seq, "111", "Kevin", `m${seq}`));
    const first = ledgerEntriesAfterCursor(ledger, { cursorSeq: null, cursorMessageId: null }, 2);
    expect(first.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.next).toEqual({ cursorSeq: 2, cursorMessageId: "1002" });
    const second = ledgerEntriesAfterCursor(ledger, first.next, 2);
    expect(second.entries.map((e) => e.seq)).toEqual([3, 4]);
    const third = ledgerEntriesAfterCursor(ledger, second.next, 2);
    expect(third.entries.map((e) => e.seq)).toEqual([5]);
    const done = ledgerEntriesAfterCursor(ledger, third.next, 2);
    expect(done.entries).toEqual([]);
    expect(done.next.cursorSeq).toBe(5);
    // A legacy (message-id) cursor carries over to the ledger.
    expect(ledgerEntriesAfterCursor(ledger, { cursorSeq: null, cursorMessageId: "1003" }, 10).entries.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("window: only messages newer than the cursor message id (chunk source ids included)", () => {
    const msg = (id: string, sourceMessageIds?: string[]): ContextMessage => ({
      id, channelId: "c1", authorKind: "user", authorId: "111", name: "Kevin", displayName: "Kevin", content: id,
      timestamp: NOW.toISOString(), reactions: [], ...(sourceMessageIds ? { sourceMessageIds } : {})
    });
    const window = [msg("100000000000000010"), msg("100000000000000020", ["100000000000000020", "100000000000000025"]), msg("100000000000000030")];
    const fresh = windowMessagesAfterCursor(window, { cursorSeq: null, cursorMessageId: "100000000000000025" });
    expect(fresh.messages.map((m) => m.id)).toEqual(["100000000000000030"]);
    expect(fresh.next.cursorMessageId).toBe("100000000000000030");
    const first = windowMessagesAfterCursor(window, { cursorSeq: null, cursorMessageId: null });
    expect(first.next.cursorMessageId).toBe("100000000000000030");
    expect(windowMessagesAfterCursor(window, first.next).messages).toEqual([]);
  });
});
