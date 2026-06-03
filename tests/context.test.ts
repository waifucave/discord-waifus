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

  it("merges consecutive same-user messages with comma separators when unpunctuated", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "user1", content: "wait", createdAt: t0 }),
      msg({ id: "2", authorId: "user1", content: "i mean this", createdAt: new Date(t0.getTime() + 1000) }),
      msg({ id: "3", authorId: "user1", content: "actually nvm", createdAt: new Date(t0.getTime() + 2000) })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("wait, i mean this, actually nvm");
    expect(out[0].sourceMessageIds).toEqual(["1", "2", "3"]);
  });

  it("merges consecutive same-user messages with spaces after punctuation", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "user1", content: "wait.", createdAt: t0 }),
      msg({ id: "2", authorId: "user1", content: "i mean this", createdAt: new Date(t0.getTime() + 1000) })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("wait. i mean this");
  });

  it("does not merge messages from different users", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "1", authorId: "user1", content: "wait", createdAt: t0 }),
      msg({ id: "2", authorId: "user2", content: "what", createdAt: new Date(t0.getTime() + 1000) })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out).toHaveLength(2);
  });

  it("preserves bot authorship metadata on context messages", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const out = buildContextMessages([
      msg({ id: "1", authorId: "helper-bot", authorBot: true, content: "bot notice", createdAt: t0 })
    ], { waifuAuthorIds: [] });
    expect(out[0]).toMatchObject({
      authorKind: "user",
      authorBot: true
    });
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

  it("keeps a replied-to waifu chunk separate and does not merge across it", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "chunk-1", authorId: "aria-bot", content: "one", createdAt: t0 }),
      msg({ id: "chunk-2", authorId: "aria-bot", content: "two", createdAt: new Date(t0.getTime() + 1000) }),
      msg({ id: "chunk-3", authorId: "aria-bot", content: "three", createdAt: new Date(t0.getTime() + 2000) }),
      msg({ id: "chunk-4", authorId: "aria-bot", content: "four", createdAt: new Date(t0.getTime() + 3000) }),
      msg({
        id: "reply",
        authorId: "user1",
        content: "this one",
        createdAt: new Date(t0.getTime() + 4000),
        replyTo: { messageId: "chunk-3", authorName: "Aria", contentPreview: "three" }
      })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: ["aria-bot"] });
    expect(out.map((message) => message.content)).toEqual(["one two", "three", "four", "this one"]);
    expect(out[0].sourceMessageIds).toEqual(["chunk-1", "chunk-2"]);
    expect(out[1].id).toBe("chunk-3");
    expect(out[2].id).toBe("chunk-4");
    expect(out[3].replyTo?.messageId).toBe("chunk-3");
  });

  it("keeps a replied-to user chunk separate and does not merge across it", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({ id: "user-1", authorId: "user1", content: "wait", createdAt: t0 }),
      msg({ id: "user-2", authorId: "user1", content: "i mean this", createdAt: new Date(t0.getTime() + 1000) }),
      msg({ id: "user-3", authorId: "user1", content: "actually nvm", createdAt: new Date(t0.getTime() + 2000) }),
      msg({
        id: "reply",
        authorId: "user2",
        content: "which part",
        createdAt: new Date(t0.getTime() + 3000),
        replyTo: { messageId: "user-2", authorName: "user1", contentPreview: "i mean this" }
      })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out.map((message) => message.content)).toEqual(["wait", "i mean this", "actually nvm", "which part"]);
    expect(out[1].id).toBe("user-2");
    expect(out[3].replyTo?.messageId).toBe("user-2");
  });
});

describe("buildContextMessages image attachments", () => {
  it("carries image attachments onto the context message", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({
        id: "1",
        authorId: "user1",
        content: "look",
        createdAt: t0,
        images: [{ url: "https://cdn.example/a.png", contentType: "image/png" }]
      })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out[0].images).toEqual([{ url: "https://cdn.example/a.png", contentType: "image/png" }]);
  });

  it("merges images when coalescing adjacent chunks", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const messages = [
      msg({
        id: "1",
        authorId: "user1",
        content: "first",
        createdAt: t0,
        images: [{ url: "https://cdn.example/a.png" }]
      }),
      msg({
        id: "2",
        authorId: "user1",
        content: "second",
        createdAt: new Date(t0.getTime() + 1000),
        images: [{ url: "https://cdn.example/b.png" }]
      })
    ];
    const out = buildContextMessages(messages, { waifuAuthorIds: [] });
    expect(out).toHaveLength(1);
    expect(out[0].images).toEqual([
      { url: "https://cdn.example/a.png" },
      { url: "https://cdn.example/b.png" }
    ]);
  });

  it("leaves images undefined when there are none", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const out = buildContextMessages([msg({ id: "1", authorId: "user1", content: "hi", createdAt: t0 })], {
      waifuAuthorIds: []
    });
    expect(out[0].images).toBeUndefined();
  });

  it("carries OCR text on image attachments", () => {
    const t0 = new Date("2026-05-16T12:00:00Z");
    const out = buildContextMessages([
      msg({
        id: "1",
        authorId: "user1",
        content: "look",
        createdAt: t0,
        images: [{ url: "https://cdn.example/a.png", ocrText: "menu text" }]
      })
    ], { waifuAuthorIds: [] });
    expect(out[0].images?.[0].ocrText).toBe("menu text");
  });
});
