import { describe, expect, it } from "vitest";
import { MemoryRecord } from "../src/shared/schemas/domain.js";
import {
  retrieveMemories,
  scoreMemory,
  relativeAge,
  RetrievalInput
} from "../src/orchestration/memoryRetrieval.js";
import { ContextMessage } from "../src/orchestration/context.js";

// Fixed reference time for all tests
const NOW = new Date("2026-06-12T18:00:00Z");
const NOW_ISO = NOW.toISOString();

// 3 days before now
const THREE_DAYS_AGO = new Date("2026-06-09T18:00:00Z").toISOString();
// 1 day before now
const ONE_DAY_AGO = new Date("2026-06-11T18:00:00Z").toISOString();
// 10 days before now
const TEN_DAYS_AGO = new Date("2026-06-02T18:00:00Z").toISOString();
// 30 minutes ago
const THIRTY_MIN_AGO = new Date("2026-06-12T17:30:00Z").toISOString();
// 2 hours ago
const TWO_HOURS_AGO = new Date("2026-06-12T16:00:00Z").toISOString();
// 47 hours ago (within 48h fresh-note window)
const FORTYSEVEN_HOURS_AGO = new Date("2026-06-10T19:00:00Z").toISOString();
// 49 hours ago (outside 48h fresh-note window)
const FORTYNINE_HOURS_AGO = new Date("2026-06-10T17:00:00Z").toISOString();

function makeMemory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return {
    guildId: "guild-1",
    waifuId: "yuki",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    entities: [],
    status: "active",
    createdAt: ONE_DAY_AGO,
    updatedAt: ONE_DAY_AGO,
    ...overrides
  };
}

function makeMessage(content: string, channelId = "channel-1"): ContextMessage {
  return {
    id: `msg-${Math.random()}`,
    channelId,
    guildId: "guild-1",
    authorKind: "user",
    authorId: "user-1",
    name: "Kevin",
    displayName: "Kevin",
    content,
    timestamp: NOW_ISO,
    reactions: []
  };
}

describe("retrieveMemories", () => {
  // (a) Lexical overlap: snowstorm memory ranks above tacos memory when window discusses snow
  it("(a) ranks lexically relevant memory above irrelevant one", () => {
    const snowMemory = makeMemory({
      id: "snow-1",
      content: "Yuki loves snowstorms and gets excited when it snows",
      entities: ["Yuki"],
      updatedAt: ONE_DAY_AGO,
      createdAt: ONE_DAY_AGO
    });
    const tacosMemory = makeMemory({
      id: "tacos-1",
      content: "Yuki prefers chicken tacos over beef tacos",
      entities: ["Yuki"],
      updatedAt: ONE_DAY_AGO,
      createdAt: ONE_DAY_AGO
    });

    const window: ContextMessage[] = [
      makeMessage("there was a huge snowstorm last night, so much snow"),
      makeMessage("the snow is piling up outside")
    ];

    const input: RetrievalInput = {
      records: [snowMemory, tacosMemory],
      window,
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-1",
      now: NOW,
      limit: 10
    };

    const result = retrieveMemories(input);
    const snowIndex = result.selected.findIndex((r) => r.id === "snow-1");
    const tacosIndex = result.selected.findIndex((r) => r.id === "tacos-1");
    expect(snowIndex).toBeGreaterThanOrEqual(0);
    expect(tacosIndex).toBeGreaterThanOrEqual(0);
    expect(snowIndex).toBeLessThan(tacosIndex);
  });

  // (b) Pinned records always selected and NOT counted against limit
  it("(b) pinned records always selected and not counted against limit", () => {
    const pinnedMemory = makeMemory({
      id: "pinned-1",
      content: "Kevin is allergic to peanuts",
      pinned: true,
      strength: 5,
      createdAt: TEN_DAYS_AGO,
      updatedAt: TEN_DAYS_AGO
    });
    // Create limit + 2 scored records
    const scoredRecords = Array.from({ length: 3 }, (_, i) =>
      makeMemory({
        id: `scored-${i}`,
        content: `Memory number ${i} about coffee preferences`,
        strength: 3,
        createdAt: ONE_DAY_AGO,
        updatedAt: ONE_DAY_AGO
      })
    );

    const input: RetrievalInput = {
      records: [pinnedMemory, ...scoredRecords],
      window: [makeMessage("hello there")],
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-1",
      now: NOW,
      limit: 2 // only 2 scored records selected, but pinned is extra
    };

    const result = retrieveMemories(input);
    // Pinned is always included
    expect(result.selected.some((r) => r.id === "pinned-1")).toBe(true);
    // Scored records capped at limit=2
    const nonPinned = result.selected.filter((r) => !r.pinned);
    expect(nonPinned).toHaveLength(2);
    // Total is limit + pinned count
    expect(result.selected).toHaveLength(3);
  });

  // (c) channelMatch boosts same-channel notes
  it("(c) channelMatch boosts same-channel notes over different-channel notes", () => {
    const sameChannelMemory = makeMemory({
      id: "same-ch",
      content: "Kevin is planning something special",
      channelId: "channel-1",
      strength: 3,
      updatedAt: ONE_DAY_AGO,
      createdAt: ONE_DAY_AGO
    });
    const diffChannelMemory = makeMemory({
      id: "diff-ch",
      content: "Kevin is planning something special",
      channelId: "channel-2",
      strength: 3,
      updatedAt: ONE_DAY_AGO,
      createdAt: ONE_DAY_AGO
    });

    const sameScore = scoreMemory(sameChannelMemory, new Set(["kevin", "planning", "special"]), "channel-1", NOW);
    const diffScore = scoreMemory(diffChannelMemory, new Set(["kevin", "planning", "special"]), "channel-1", NOW);
    expect(sameScore).toBeGreaterThan(diffScore);
  });

  // (d) fresh waifu_tool notes (<48h) get the freshNote boost
  it("(d) fresh waifu_tool notes get freshNote boost", () => {
    const freshNote = makeMemory({
      id: "fresh-note",
      content: "Kevin is heading out at 5pm today",
      source: "waifu_tool",
      kind: "context",
      expiresAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      createdAt: THIRTY_MIN_AGO,
      updatedAt: THIRTY_MIN_AGO
    });
    const oldNote = makeMemory({
      id: "old-note",
      content: "Kevin is heading out at 5pm today",
      source: "waifu_tool",
      kind: "context",
      expiresAt: new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
      createdAt: FORTYNINE_HOURS_AGO,
      updatedAt: FORTYNINE_HOURS_AGO
    });

    const freshScore = scoreMemory(freshNote, new Set(), "channel-1", NOW);
    const oldNoteScore = scoreMemory(oldNote, new Set(), "channel-1", NOW);
    // fresh note should score higher due to freshNote boost
    expect(freshScore).toBeGreaterThan(oldNoteScore);
  });

  // (e) expired/archived/foreign-guild/foreign-waifu records excluded
  it("(e) excludes expired, archived, foreign-guild, and foreign-waifu records", () => {
    const expiredMemory = makeMemory({
      id: "expired",
      content: "Kevin had pizza last Friday",
      expiresAt: new Date(NOW.getTime() - 1000).toISOString() // expired 1 second ago
    });
    const archivedMemory = makeMemory({
      id: "archived",
      content: "Kevin once lived in Toronto",
      status: "archived"
    });
    const foreignGuildMemory = makeMemory({
      id: "foreign-guild",
      content: "Kevin loves autumn",
      guildId: "guild-2"
    });
    const foreignWaifuMemory = makeMemory({
      id: "foreign-waifu",
      content: "Kevin likes cats",
      waifuId: "mika"
    });
    const validMemory = makeMemory({
      id: "valid",
      content: "Kevin is a coffee person"
    });

    const input: RetrievalInput = {
      records: [expiredMemory, archivedMemory, foreignGuildMemory, foreignWaifuMemory, validMemory],
      window: [makeMessage("talking about coffee")],
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-1",
      now: NOW,
      limit: 10
    };

    const result = retrieveMemories(input);
    const selectedIds = result.selected.map((r) => r.id);
    expect(selectedIds).toContain("valid");
    expect(selectedIds).not.toContain("expired");
    expect(selectedIds).not.toContain("archived");
    expect(selectedIds).not.toContain("foreign-guild");
    expect(selectedIds).not.toContain("foreign-waifu");
  });

  // (f) selection caps at limit scored records
  it("(f) selection caps at limit scored records", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeMemory({
        id: `record-${i}`,
        content: `Memory ${i}`,
        strength: 3,
        createdAt: ONE_DAY_AGO,
        updatedAt: ONE_DAY_AGO
      })
    );

    const input: RetrievalInput = {
      records,
      window: [makeMessage("hello")],
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-1",
      now: NOW,
      limit: 5
    };

    const result = retrieveMemories(input);
    expect(result.selected).toHaveLength(5);
  });

  // (g) rendering: kind labels, notes get relative age, ordering pinned→durable→notes each oldest→newest
  it("(g) renders with kind labels and relative age, ordered pinned→durable→notes oldest→newest", () => {
    const olderPinned = makeMemory({
      id: "pinned-old",
      content: "Kevin is allergic to peanuts",
      kind: "fact",
      pinned: true,
      strength: 5,
      createdAt: TEN_DAYS_AGO,
      updatedAt: TEN_DAYS_AGO
    });
    const newerPinned = makeMemory({
      id: "pinned-new",
      content: "Kevin prefers dark roast",
      kind: "preference",
      pinned: true,
      strength: 5,
      createdAt: THREE_DAYS_AGO,
      updatedAt: THREE_DAYS_AGO
    });
    const durableMemory = makeMemory({
      id: "durable-1",
      content: "Kevin grew up in Montreal",
      kind: "fact",
      pinned: false,
      strength: 4,
      createdAt: TEN_DAYS_AGO,
      updatedAt: TEN_DAYS_AGO
    });
    const noteMemory = makeMemory({
      id: "note-1",
      content: "Kevin is heading out at 5pm",
      kind: "context",
      source: "waifu_tool",
      expiresAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      createdAt: TWO_HOURS_AGO,
      updatedAt: TWO_HOURS_AGO
    });

    const input: RetrievalInput = {
      records: [noteMemory, durableMemory, newerPinned, olderPinned],
      window: [makeMessage("hello")],
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-1",
      now: NOW,
      limit: 10
    };

    const result = retrieveMemories(input);

    // Check ordering: pinned first (oldest→newest), then durable, then notes
    const ids = result.selected.map((r) => r.id);
    expect(ids[0]).toBe("pinned-old");
    expect(ids[1]).toBe("pinned-new");
    expect(ids[2]).toBe("durable-1");
    expect(ids[3]).toBe("note-1");

    // Check rendering
    expect(result.lines[0]).toBe("- (fact) Kevin is allergic to peanuts");
    expect(result.lines[1]).toBe("- (preference) Kevin prefers dark roast");
    expect(result.lines[2]).toBe("- (fact) Kevin grew up in Montreal");
    // Note gets relative age label
    expect(result.lines[3]).toMatch(/^- \(note, 2h ago\) Kevin is heading out at 5pm$/);
  });

  // (h) cross-channel continuity: fresh note from channel A selected when retrieving for channel B
  it("(h) fresh waifu_tool note from channel A is selected when retrieving for channel B (guild-visible)", () => {
    // Note created in channel-1 (channel A)
    const noteFromChannelA = makeMemory({
      id: "note-channel-a",
      content: "Kevin just mentioned he is flying to Vancouver this weekend",
      kind: "context",
      source: "waifu_tool",
      channelId: "channel-1",
      expiresAt: new Date(NOW.getTime() + 48 * 3600_000).toISOString(),
      createdAt: THIRTY_MIN_AGO,
      updatedAt: THIRTY_MIN_AGO
    });

    const input: RetrievalInput = {
      records: [noteFromChannelA],
      window: [makeMessage("hey whats up", "channel-2")],
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-2", // retrieving for channel B
      now: NOW,
      limit: 10
    };

    const result = retrieveMemories(input);
    // The note is still selected despite being created in channel-1
    expect(result.selected.some((r) => r.id === "note-channel-a")).toBe(true);
    // But channel match boost does NOT apply (different channel)
    const noteScore = scoreMemory(noteFromChannelA, new Set(), "channel-2", NOW);
    const noteScoreSameChannel = scoreMemory(noteFromChannelA, new Set(), "channel-1", NOW);
    expect(noteScoreSameChannel).toBeGreaterThan(noteScore);
  });
});

describe("relativeAge", () => {
  it("formats minutes ago", () => {
    const from = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    expect(relativeAge(from, NOW)).toBe("30m ago");
  });

  it("formats hours ago", () => {
    const from = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    expect(relativeAge(from, NOW)).toBe("2h ago");
  });

  it("formats days ago for 36h+", () => {
    const from = new Date(NOW.getTime() - 48 * 3600_000).toISOString();
    expect(relativeAge(from, NOW)).toBe("2d ago");
  });

  it("uses at least 1m for near-instant", () => {
    const from = new Date(NOW.getTime() - 10_000).toISOString();
    expect(relativeAge(from, NOW)).toBe("1m ago");
  });
});

describe("scoreMemory", () => {
  it("returns 0 lexical when window is empty", () => {
    const memory = makeMemory({
      id: "m1",
      content: "Kevin loves snowboarding",
      entities: ["Kevin"],
      updatedAt: ONE_DAY_AGO
    });
    const score = scoreMemory(memory, new Set(), "channel-1", NOW);
    // recency + strength component at minimum
    expect(score).toBeGreaterThan(0);
    // but no lexical contribution
    const scoreWithLexical = scoreMemory(memory, new Set(["kevin", "loves", "snowboarding"]), "channel-1", NOW);
    expect(scoreWithLexical).toBeGreaterThan(score);
  });

  it("applies strength weighting: strength 5 > strength 1", () => {
    const highStrength = makeMemory({ id: "high", content: "test content", strength: 5, updatedAt: ONE_DAY_AGO });
    const lowStrength = makeMemory({ id: "low", content: "test content", strength: 1, updatedAt: ONE_DAY_AGO });
    const highScore = scoreMemory(highStrength, new Set(), "channel-1", NOW);
    const lowScore = scoreMemory(lowStrength, new Set(), "channel-1", NOW);
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("recency decays over time: recent > old", () => {
    const recent = makeMemory({ id: "recent", content: "test", updatedAt: ONE_DAY_AGO });
    const old = makeMemory({ id: "old", content: "test", updatedAt: TEN_DAYS_AGO });
    const recentScore = scoreMemory(recent, new Set(), "channel-1", NOW);
    const oldScore = scoreMemory(old, new Set(), "channel-1", NOW);
    expect(recentScore).toBeGreaterThan(oldScore);
  });
});

describe("retrieveMemories with empty window", () => {
  it("still selects records when window is empty (recency+strength only)", () => {
    const records = [
      makeMemory({ id: "r1", content: "fact about Kevin", strength: 5, updatedAt: THIRTY_MIN_AGO, createdAt: THIRTY_MIN_AGO }),
      makeMemory({ id: "r2", content: "old fact", strength: 2, updatedAt: TEN_DAYS_AGO, createdAt: TEN_DAYS_AGO })
    ];

    const result = retrieveMemories({
      records,
      window: [],
      guildId: "guild-1",
      waifuId: "yuki",
      channelId: "channel-1",
      now: NOW,
      limit: 5
    });

    expect(result.selected).toHaveLength(2);
  });
});
