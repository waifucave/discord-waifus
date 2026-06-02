import { describe, expect, it } from "vitest";

import type { ContextMessage } from "../src/orchestration/context.js";
import { extractReplyQuote } from "../src/orchestration/replyQuote.js";

function ctxMessage(overrides: Partial<ContextMessage> & { id: string; content: string }): ContextMessage {
  return {
    channelId: "c",
    authorKind: "user",
    authorId: "u",
    name: "User",
    displayName: "User",
    timestamp: "2026-06-02T12:00:00Z",
    reactions: [],
    ...overrides
  };
}

describe("extractReplyQuote", () => {
  it("returns input unchanged when there is no quote", () => {
    const result = extractReplyQuote("hello there", []);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("hello there");
  });

  it("matches an exact quote with author prefix", () => {
    const result = extractReplyQuote("> Alice: hey there\nyeah hi", [
      ctxMessage({ id: "m1", content: "earlier message" }),
      ctxMessage({ id: "m2", content: "hey there", displayName: "Alice", name: "Alice" })
    ]);
    expect(result.replyToMessageId).toBe("m2");
    expect(result.cleanedContent).toBe("yeah hi");
  });

  it("matches with case and punctuation differences", () => {
    const result = extractReplyQuote("> Alice: Hey there!\nhi", [
      ctxMessage({ id: "m1", content: "hey there" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("hi");
  });

  it("matches via substring containment when the candidate is longer", () => {
    const result = extractReplyQuote("> hey there\nhi", [
      ctxMessage({ id: "m1", content: "hey there my friend, what's up" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
  });

  it("matches via Jaccard token overlap when wording drifts", () => {
    const result = extractReplyQuote("> we should go to the park today\nsure", [
      ctxMessage({ id: "m1", content: "we should go to the park tomorrow" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
  });

  it("returns undefined id when nothing matches above threshold", () => {
    const result = extractReplyQuote("> totally unrelated random words\nhi", [
      ctxMessage({ id: "m1", content: "the quick brown fox" })
    ]);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("hi");
  });

  it("joins consecutive blockquote lines into one quote", () => {
    const result = extractReplyQuote("> first part\n> second part\nbody", [
      ctxMessage({ id: "m1", content: "first part second part" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("body");
  });

  it("walks candidates from most recent to oldest", () => {
    const result = extractReplyQuote("> hi\nyes", [
      ctxMessage({ id: "old", content: "hi" }),
      ctxMessage({ id: "new", content: "hi" })
    ]);
    expect(result.replyToMessageId).toBe("new");
  });

  it("strips the quote even when no candidate is supplied", () => {
    const result = extractReplyQuote("> nothing here matches\nactual reply", []);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("actual reply");
  });

  it("returns an empty cleaned body when the quote has no following text", () => {
    const result = extractReplyQuote("> alice: hey", [
      ctxMessage({ id: "m1", content: "hey" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("");
  });

  it("ignores `>>>` blockquote syntax (no leading-quote extraction)", () => {
    const result = extractReplyQuote(">>> alice: hi\nbody", [
      ctxMessage({ id: "m1", content: "hi" })
    ]);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe(">>> alice: hi\nbody");
  });

  it("tolerates a quote line with no space after the >", () => {
    const result = extractReplyQuote(">hey there\nhi", [
      ctxMessage({ id: "m1", content: "hey there" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("hi");
  });
});
