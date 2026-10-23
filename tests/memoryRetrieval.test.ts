import { describe, expect, it } from "vitest";
import { MemoryRecord } from "../src/shared/schemas/domain.js";
import { relativeAge, scoreMemory } from "../src/orchestration/memoryRetrieval.js";
import { ContextMessage } from "../src/orchestration/contextMessages.js";

// The legacy prompt path's entry point: now global (D2), scored by the snapshot provider.
const NOW = new Date("2026-06-12T18:00:00Z");
const ONE_DAY_AGO = "2026-06-11T18:00:00.000Z";
const TEN_DAYS_AGO = "2026-06-02T18:00:00.000Z";

function makeMemory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return {
    waifuId: "yuki",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: { guildId: "guild-1", channelId: "channel-1" },
    subjects: [],
    revision: 0,
    status: "active",
    createdAt: ONE_DAY_AGO,
    updatedAt: ONE_DAY_AGO,
    ...overrides
  };
}

function makeMessage(content: string, authorId = "user-1"): ContextMessage {
  return {
    id: `msg-${Math.random()}`,
    channelId: "channel-1",
    guildId: "guild-1",
    authorKind: "user",
    authorId,
    name: "Kevin",
    displayName: "Kevin",
    content,
    timestamp: NOW.toISOString(),
    reactions: []
  };
}

const base = { guildId: "guild-1", channelId: "channel-1", waifuId: "yuki", now: NOW, limit: 12 };

describe("legacy memory scoring adapters", () => {
  it("scoreMemory favours recent, strong, same-channel records", () => {
    const recent = makeMemory({ id: "recent", content: "x fact", strength: 3 });
    const old = makeMemory({ id: "old", content: "x fact", strength: 3, updatedAt: TEN_DAYS_AGO });
    const strong = makeMemory({ id: "strong", content: "x fact", strength: 5 });
    const otherGuild = makeMemory({ id: "g2", content: "x fact", origin: { guildId: "guild-2" } });
    const score = (r: MemoryRecord) => scoreMemory(r, [], "guild-1", "channel-1", NOW);
    expect(score(recent)).toBeGreaterThan(score(old));
    expect(score(strong)).toBeGreaterThan(score(recent));
    expect(score(recent)).toBeGreaterThan(score(otherGuild));
  });

  it("relativeAge keeps its compact format", () => {
    expect(relativeAge("2026-06-12T17:30:00.000Z", NOW)).toBe("30m ago");
    expect(relativeAge("2026-06-12T16:00:00.000Z", NOW)).toBe("2h ago");
    expect(relativeAge("2026-06-09T18:00:00.000Z", NOW)).toBe("3d ago");
  });
});
