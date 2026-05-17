import { describe, expect, it } from "vitest";
import {
  buildContextMessages,
  formatTimestamp,
  WAIFU_CHUNK_COALESCE_WINDOW_MS,
  MessageLikeForContext
} from "../src/orchestration/context.js";

function msg(overrides: Partial<MessageLikeForContext> & {
  id: string;
  authorId: string;
  content: string;
  createdAt: Date;
}): MessageLikeForContext {
  return {
    channelId: "c1",
    guildId: "g1",
    authorName: overrides.authorId,
    authorDisplayName: overrides.authorId,
    ...overrides
  };
}

describe("formatTimestamp", () => {
  it("renders ISO-8601 UTC without milliseconds", () => {
    expect(formatTimestamp(new Date("2026-05-16T12:33:14.123Z"))).toBe("2026-05-16T12:33:14Z");
  });
});

describe("buildContextMessages coalescing", () => {
  it("merges consecutive same-waifu messages within the window", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "user1", content: "hey", createdAt: t0 }),
      msg({ id: "2", authorId: "aria-bot", content: "Hi K.", createdAt: new Date(t0.getTime() + 1000) }),
      msg({ id: "3", authorId: "aria-bot", content: "What's up?", createdAt: new Date(t0.getTime() + 2000) }),
      msg({ id: "4", authorId: "aria-bot", content: "Tell me.", createdAt: new Date(t0.getTime() + 3000) })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: ["aria-bot"] });
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe("Hi K. What's up? Tell me.");
    expect(out[1].id).toBe("2");
  });

  it("does not merge across the coalesce window", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "aria-bot", content: "first", createdAt: t0 }),
      msg({
        id: "2",
        authorId: "aria-bot",
        content: "much-later",
        createdAt: new Date(t0.getTime() + WAIFU_CHUNK_COALESCE_WINDOW_MS + 1)
      })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: ["aria-bot"] });
    expect(out).toHaveLength(2);
  });

  it("merges long chunk trains using adjacent chunk timing", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = Array.from({ length: 20 }, (_value, index) =>
      msg({
        id: `chunk-${index}`,
        authorId: "aria-bot",
        content: `part-${index}`,
        createdAt: new Date(t0.getTime() + index * 2500)
      })
    );
    const out = buildContextMessages(messages, { waifuAuthorIds: ["aria-bot"] });
    expect(out).toHaveLength(1);
    expect(out[0].sourceMessageIds).toEqual(messages.map((message) => message.id));
  });

  it("does not merge messages from different waifus", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "aria-bot", content: "hi", createdAt: t0 }),
      msg({ id: "2", authorId: "yuki-bot", content: "hello", createdAt: new Date(t0.getTime() + 1000) })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: ["aria-bot", "yuki-bot"] });
    expect(out).toHaveLength(2);
  });

  it("does not merge consecutive human messages", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "user1", content: "im bored", createdAt: t0 }),
      msg({ id: "2", authorId: "user1", content: "play with me", createdAt: new Date(t0.getTime() + 1000) })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out).toHaveLength(2);
  });

  it("aggregates reactions when merging chunks", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({
        id: "1",
        authorId: "aria-bot",
        content: "first",
        createdAt: t0,
        reactions: [{ emoji: "🔥", count: 1 }]
      }),
      msg({
        id: "2",
        authorId: "aria-bot",
        content: "second",
        createdAt: new Date(t0.getTime() + 1000),
        reactions: [{ emoji: "🔥", count: 2 }, { emoji: "🎉", count: 1 }]
      })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: ["aria-bot"] });
    expect(out).toHaveLength(1);
    expect(out[0].reactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ emoji: "🔥", count: 3 }),
        expect.objectContaining({ emoji: "🎉", count: 1 })
      ])
    );
  });
});
