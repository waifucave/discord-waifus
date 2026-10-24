import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../src/shared/schemas/context.js";
import type { MemoryRecord } from "../src/shared/schemas/domain.js";
import type { Participant } from "../src/orchestration/context/types.js";
import {
  createMemorySnapshotProvider,
  humanAge,
  proposeInlineNoteRecords,
  renderMemoryLine,
  scoreMemoryRecord,
  queryTokens,
  selectSnapshotRecords
} from "../src/orchestration/memorySnapshot.js";
import { jaccard, normalizeForDedupe, tokenSet } from "../src/orchestration/text.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const KEVIN = { discordUserId: "111", name: "Kevin" };
const MIA = { discordUserId: "222", name: "Mia" };
const guildA = { kind: "guild" as const, guildId: "guild-a", channelId: "chan-a" };
const guildB = { kind: "guild" as const, guildId: "guild-b", channelId: "chan-b" };

function memory(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    waifuId: "yuki",
    content: "Something durable.",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: {},
    subjects: [],
    revision: 0,
    createdAt: ago(3),
    updatedAt: ago(3),
    status: "active",
    ...overrides
  };
}

function entry(seq: number, body: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: `m${seq}`,
    seq,
    authorId: "111",
    authorName: "Kevin",
    authorIsBot: false,
    at: NOW.toISOString(),
    kind: "default",
    body,
    images: [],
    state: "live",
    sealed: false,
    ...overrides
  };
}

const kevin: Participant = { discordUserId: "111", displayName: "Kevin", isHuman: true };
const mia: Participant = { discordUserId: "222", displayName: "Mia", isHuman: true };
const yukiSelf: Participant = { discordUserId: "999", waifuId: "yuki", displayName: "Yuki", isHuman: false };

describe("Unicode tokenizer", () => {
  it("keeps accented words whole (the old ASCII tokenizer cut 'café' to 'caf')", () => {
    expect([...tokenSet("Un café crème à Zoë")]).toEqual(["café", "crème", "zoë"]);
  });

  it("NFKC-folds full-width and compatibility characters", () => {
    expect(tokenSet("ＫＥＶＩＮ ｌｏｖｅｓ ｔｅａ")).toEqual(tokenSet("kevin loves tea"));
    expect(tokenSet("ﬁsh")).toEqual(new Set(["fish"]));
  });

  it("turns Han/Kana/Hangul runs into character bigrams", () => {
    expect([...tokenSet("抹茶が好き")]).toEqual(["抹茶", "茶が", "が好", "好き"]);
    expect([...tokenSet("고양이")]).toEqual(["고양", "양이"]);
    expect(tokenSet("猫")).toEqual(new Set(["猫"]));
    // Mixed scripts split at the boundary.
    expect([...tokenSet("Kevinは猫")]).toEqual(["kevin", "は猫"]);
  });

  it("is unchanged for ASCII (stopwords, 3+ chars, punctuation splits)", () => {
    expect([...tokenSet("The cat's toy, and it is RED!")]).toEqual(["cat", "toy", "red"]);
    expect(jaccard(tokenSet("Kevin likes green tea"), tokenSet("kevin likes green tea!"))).toBe(1);
  });

  it("normalizeForDedupe folds case, whitespace and trailing punctuation", () => {
    expect(normalizeForDedupe("  Kevin   likes TEA.  ")).toBe("kevin likes tea");
    expect(normalizeForDedupe("抹茶が好き。")).toBe("抹茶が好き");
  });
});

describe("renderMemoryLine", () => {
  const ctx = {
    now: NOW,
    nameFor: (s: { name: string }) => s.name,
    placeFor: (o: { guildId?: string; channelId?: string }) => (o.guildId === "guild-a" ? "Bake Club #general" : undefined)
  };

  it("renders subject prefix, kind, place and age", () => {
    const line = renderMemoryLine(
      memory({ id: "a", content: "allergic to peanuts", subjects: [KEVIN], origin: { guildId: "guild-a", channelId: "chan-a" }, createdAt: ago(21) }),
      ctx
    );
    expect(line).toBe("- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)");
  });

  it("omits the prefix when the content already names the subject, and an unknown place", () => {
    expect(renderMemoryLine(memory({ id: "a", content: "Kevin is allergic to peanuts.", subjects: [KEVIN], createdAt: ago(1) }), ctx)).toBe(
      "- Kevin is allergic to peanuts (fact · yesterday)"
    );
  });

  it("renders DM provenance as 'learned in a private chat' (O4)", () => {
    expect(renderMemoryLine(memory({ id: "a", content: "Kevin is moving to Osaka", origin: { dm: true }, createdAt: ago(5) }), ctx)).toBe(
      "- Kevin is moving to Osaka (fact · learned in a private chat · 5 days ago)"
    );
  });

  it("names the person a DM memory was learned with (O4)", () => {
    expect(
      renderMemoryLine(memory({ id: "a", content: "Kevin is moving to Osaka", subjects: [KEVIN], origin: { dm: true }, createdAt: ago(5) }), ctx)
    ).toBe("- Kevin is moving to Osaka (fact · learned in a private chat with Kevin · 5 days ago)");
  });

  it("matches subject names on word boundaries (Ed is not mentioned by Edited)", () => {
    const ed = { discordUserId: "444", name: "Ed" };
    expect(renderMemoryLine(memory({ id: "a", content: "Edited the club video", subjects: [ed], createdAt: ago(1) }), ctx)).toBe(
      "- Ed: Edited the club video (fact · yesterday)"
    );
    expect(renderMemoryLine(memory({ id: "b", content: "Ed edited the club video", subjects: [ed], createdAt: ago(1) }), ctx)).toBe(
      "- Ed edited the club video (fact · yesterday)"
    );
  });

  it("refreshes subject names at render time and labels waifu notes", () => {
    const line = renderMemoryLine(
      memory({ id: "a", content: "baking tonight", kind: "context", expiresAt: ago(-2), subjects: [KEVIN], createdAt: ago(0) }),
      { ...ctx, nameFor: () => "Kev" }
    );
    expect(line).toBe("- Kev: baking tonight (note · just now)");
    expect(humanAge(ago(400), NOW)).toBe("1 year ago");
  });
});

describe("snapshot scoring and selection", () => {
  const select = (records: MemoryRecord[], extra: Partial<Parameters<typeof selectSnapshotRecords>[1]> = {}) =>
    selectSnapshotRecords(records, {
      waifuId: "yuki",
      conversation: guildA,
      participants: [kevin, yukiSelf],
      window: [],
      now: NOW,
      limit: 12,
      maxPinned: 6,
      ...extra
    });

  it("applies the spec formula exactly", () => {
    const record = memory({ id: "a", content: "Kevin bakes sourdough", subjects: [KEVIN], strength: 5, updatedAt: ago(14), origin: { guildId: "guild-a", channelId: "chan-a" } });
    const window = [entry(1, "I baked sourdough today"), entry(2, "sourdough again", { authorIsBot: true, authorId: "999", authorName: "Yuki" })];
    const score = scoreMemoryRecord(record, { participants: [kevin], query: queryTokens(window), conversation: guildA, now: NOW });
    // subject 1.0·3 + lexical (kevin ✗, bakes ✗, sourdough human 1.0 → 1/3 tokens... names add "kevin")
    // tokens {kevin, bakes, sourdough}: sourdough hits a human line → 1/3.
    const expected = 3.0 * 1 + 2.0 * (1 / 3) + 1.0 * 0.5 + 0.6 * 1 + 0.3 * 1 - 0;
    expect(score).toBeCloseTo(expected, 10);
  });

  it("weighs human lines over the waifu's own lines", () => {
    const record = memory({ id: "a", content: "pottery wheel" });
    const human = scoreMemoryRecord(record, { participants: [], query: queryTokens([entry(1, "pottery wheel")]), conversation: guildA, now: NOW });
    const own = scoreMemoryRecord(record, {
      participants: [],
      query: queryTokens([entry(1, "pottery wheel", { authorIsBot: true })]),
      conversation: guildA,
      now: NOW
    });
    expect(human - own).toBeCloseTo(2.0 * (1 - 0.4), 10);
  });

  it("orders present people first: a present human beats a present waifu beats nobody", () => {
    const aboutKevin = memory({ id: "kevin", subjects: [KEVIN] });
    const aboutYuki = memory({ id: "self", subjects: [{ waifuId: "yuki", name: "Yuki" }] });
    const aboutMia = memory({ id: "mia", subjects: [MIA] });
    const { records } = select([aboutMia, aboutYuki, aboutKevin], { limit: 2 });
    expect(records.map((r) => r.id).sort()).toEqual(["kevin", "self"]);
  });

  it("penalizes memories retrieved within 24h (diversity), so the next epoch rotates", () => {
    const fresh = memory({ id: "fresh", content: "Kevin owns a cat" });
    const repeated = memory({ id: "repeated", content: "Kevin owns a dog", lastRetrievedAt: ago(0.5) });
    expect(select([repeated, fresh], { limit: 1 }).records.map((r) => r.id)).toEqual(["fresh"]);
    const stale = { ...repeated, lastRetrievedAt: ago(2) };
    const scores = select([stale, fresh]).scores;
    expect(scores.get("repeated")).toBeCloseTo(scores.get("fresh")!, 10);
  });

  it("caps pinned at maxPinned inside the total limit and orders pinned → durable → notes", () => {
    const pinned = Array.from({ length: 4 }, (_, i) => memory({ id: `pin${i}`, pinned: true, createdAt: ago(10 - i) }));
    const durable = [memory({ id: "d1", createdAt: ago(5) }), memory({ id: "d0", createdAt: ago(6) })];
    const note = memory({ id: "n", kind: "context", expiresAt: ago(-1), createdAt: ago(0.1) });
    const { records } = select([note, ...durable, ...pinned], { limit: 5, maxPinned: 2 });
    expect(records).toHaveLength(5);
    expect(records.slice(0, 2).every((r) => r.pinned)).toBe(true);
    expect(records.slice(2).map((r) => r.id)).toEqual(["d0", "d1", "n"]);
  });

  it("gives a same-origin boost (channel 1, guild 0.5, dm 1) but never filters by origin", () => {
    const sameChannel = memory({ id: "c", origin: { guildId: "guild-a", channelId: "chan-a" } });
    const sameGuild = memory({ id: "g", origin: { guildId: "guild-a", channelId: "other" } });
    const elsewhere = memory({ id: "e", origin: { guildId: "guild-b" } });
    const scores = select([sameChannel, sameGuild, elsewhere]).scores;
    expect(scores.get("c")! - scores.get("e")!).toBeCloseTo(0.3, 10);
    expect(scores.get("g")! - scores.get("e")!).toBeCloseTo(0.15, 10);
    expect(select([elsewhere]).records.map((r) => r.id)).toEqual(["e"]);
  });

  it("retrieves a memory learned in guild A for the same waifu in guild B", async () => {
    const learnedInA = memory({ id: "peanuts", content: "Kevin is allergic to peanuts", subjects: [KEVIN], origin: { guildId: "guild-a", channelId: "chan-a" } });
    const otherWaifu = memory({ id: "mika", waifuId: "mika", subjects: [KEVIN] });
    const provider = createMemorySnapshotProvider({ readMemories: async () => [learnedInA, otherWaifu] });
    const snapshot = await provider.selectSnapshot({
      waifuId: "yuki",
      conversation: guildB,
      participants: [kevin],
      window: [entry(1, "anyone want peanut butter cookies?")],
      now: NOW,
      limit: 12,
      maxPinned: 6
    });
    expect(snapshot.ids).toEqual(["peanuts"]);
    expect(snapshot.lines).toEqual(["- Kevin is allergic to peanuts (fact · 3 days ago)"]);
  });
});

describe("inline memory notes", () => {
  it("proposes a newcomer's memories once, then strong lexical hits, within budget", () => {
    const records = [
      memory({ id: "mia1", content: "Mia prefers green tea", subjects: [MIA], strength: 4 }),
      memory({ id: "mia2", content: "Mia plays the cello", subjects: [MIA] }),
      memory({ id: "kev", content: "Kevin restores vintage motorcycles", subjects: [KEVIN] }),
      memory({ id: "seen", content: "Kevin owns a cat", subjects: [KEVIN] })
    ];
    const notes = proposeInlineNoteRecords(records, {
      waifuId: "yuki",
      conversation: guildA,
      participants: [kevin, mia],
      newParticipants: [mia],
      excludeIds: ["seen"],
      window: [entry(1, "old talk", { at: ago(1) }), entry(2, "my vintage motorcycles need restoring")],
      epochStartedAt: ago(0.5),
      now: NOW,
      budget: 6
    });
    expect(notes.map((group) => group.map((r) => r.id))).toEqual([["mia1", "mia2"], ["kev"]]);
    const capped = proposeInlineNoteRecords(records, {
      waifuId: "yuki", conversation: guildA, participants: [kevin, mia], newParticipants: [mia], excludeIds: [],
      window: [], epochStartedAt: ago(0.5), now: NOW, budget: 0
    });
    expect(capped).toEqual([]);
  });

  it("decision 11: a memory written mid-epoch about someone present becomes a note; her own tool writes do not", () => {
    const epochStartedAt = ago(0.5);
    const records = [
      // Written by the stage manager after the epoch began, about Kevin (present): no lexical hit needed.
      memory({ id: "fresh", content: "Kevin got the job offer", subjects: [KEVIN], createdAt: ago(0.1), updatedAt: ago(0.1) }),
      // Her own add_memory since the epoch began: already in her transcript as a tool note.
      memory({ id: "own", content: "Kevin starts Monday", subjects: [KEVIN], source: "waifu_tool", createdAt: ago(0.2), updatedAt: ago(0.2) }),
      // Mid-epoch, but about someone not present.
      memory({ id: "absent", content: "Rui adopted a dog", subjects: [{ discordUserId: "333", name: "Rui" }], createdAt: ago(0.1) }),
      // Before the epoch: only via newcomer/lexical rules (none apply here).
      memory({ id: "old", content: "Kevin owns a cat", subjects: [KEVIN], createdAt: ago(2) })
    ];
    const notes = proposeInlineNoteRecords(records, {
      waifuId: "yuki",
      conversation: guildA,
      participants: [kevin, mia],
      newParticipants: [],
      excludeIds: [],
      window: [entry(1, "nothing relevant here")],
      epochStartedAt,
      now: NOW,
      budget: 6
    });
    expect(notes.map((group) => group.map((r) => r.id))).toEqual([["fresh"]]);
    // A waifu_tool record from before the epoch is not excluded (it is not in this transcript).
    const before = proposeInlineNoteRecords(
      [memory({ id: "own-old", content: "Kevin starts Monday", subjects: [KEVIN], source: "waifu_tool", createdAt: ago(2) })],
      { waifuId: "yuki", conversation: guildA, participants: [kevin], newParticipants: [kevin], excludeIds: [], window: [], epochStartedAt, now: NOW, budget: 6 }
    );
    expect(before.flat().map((r) => r.id)).toEqual(["own-old"]);
  });

  it("the provider renders notes and throttles markRetrieved", async () => {
    const stamped: string[][] = [];
    const provider = createMemorySnapshotProvider({
      readMemories: async () => [memory({ id: "mia1", content: "Mia prefers green tea", subjects: [MIA] })],
      stampRetrieved: async (ids) => {
        stamped.push(ids);
      }
    });
    const notes = await provider.proposeInlineNotes({
      waifuId: "yuki", conversation: guildA, participants: [mia], newParticipants: [mia], excludeIds: [],
      window: [], epochStartedAt: ago(0.1), now: NOW, budget: 6
    });
    expect(notes).toEqual([{ memoryIds: ["mia1"], text: "- Mia prefers green tea (fact · 3 days ago)" }]);
    provider.markRetrieved(["mia1"], NOW);
    provider.markRetrieved(["mia1"], new Date(NOW.getTime() + 60_000));
    await vi.waitFor(() => expect(stamped).toEqual([["mia1"]]));
  });
});
