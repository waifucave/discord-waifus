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

  it("matches the preferred `replying to > Name: text` control line", () => {
    const result = extractReplyQuote("replying to > Alice: hey there\nyeah hi", [
      ctxMessage({ id: "m1", content: "earlier message" }),
      ctxMessage({ id: "m2", content: "hey there", displayName: "Alice", name: "Alice" })
    ]);
    expect(result.replyToMessageId).toBe("m2");
    expect(result.cleanedContent).toBe("yeah hi");
  });

  it("strips an embedded hallucinated reply control and collapses identical surrounding text", () => {
    const repeated = "fr babe i knew u were up to something 💀";
    const result = extractReplyQuote(
      `${repeated}\nreplying to > K: bro been getting caught up in too much po\n${repeated}`,
      [
        ctxMessage({
          id: "m1",
          content: "You guys talk a lot",
          displayName: "K",
          name: "K"
        })
      ]
    );
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe(repeated);
  });

  it("strips an embedded reply control and targets a real matching message", () => {
    const result = extractReplyQuote(
      "first thought\nreplying to > K: older question\nactual answer",
      [
        ctxMessage({
          id: "m1",
          content: "older question",
          displayName: "K",
          name: "K"
        })
      ]
    );
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("first thought\nactual answer");
  });

  it("maps `replying to > Name` to that participant's most recent message", () => {
    const result = extractReplyQuote("replying to > Alice\nanswering you", [
      ctxMessage({ id: "m1", content: "first", displayName: "Alice", name: "Alice" }),
      ctxMessage({ id: "m2", content: "middle", displayName: "Bob", name: "Bob" }),
      ctxMessage({ id: "m3", content: "latest from alice", displayName: "Alice", name: "Alice" })
    ]);
    expect(result.replyToMessageId).toBe("m3");
    expect(result.cleanedContent).toBe("answering you");
  });

  it("keeps legacy `> Name` targeting working", () => {
    const result = extractReplyQuote("> Alice\nanswering you", [
      ctxMessage({ id: "m1", content: "first", displayName: "Alice", name: "Alice" }),
      ctxMessage({ id: "m2", content: "middle", displayName: "Bob", name: "Bob" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("answering you");
  });

  it("matches preferred content-only targeting after `replying to >`", () => {
    const result = extractReplyQuote("replying to > older question\nhere is the answer", [
      ctxMessage({ id: "m1", content: "older question" }),
      ctxMessage({ id: "m2", content: "newer follow-up" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("here is the answer");
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

  it("normalizes an implicit `Name: text` first line into a reply target when text matches", () => {
    const result = extractReplyQuote("K: hello world\nyeah", [
      ctxMessage({ id: "m1", content: "hello world", displayName: "K", name: "K" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("yeah");
  });

  it("returns an empty cleaned body when a matching implicit quote is the entire reply", () => {
    const result = extractReplyQuote("Aria: back off riko nobody asked for your commentary fr", [
      ctxMessage({
        id: "m1",
        content: "back off riko nobody asked for your commentary fr",
        displayName: "Aria",
        name: "Aria"
      })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("");
  });

  it("normalizes an implicit quote via substring containment", () => {
    const result = extractReplyQuote(
      "K: blind bitch u cant even see whats on this image\nThat's your victory lap?",
      [ctxMessage({ id: "m1", content: "@Aria blind bitch u cant even see whats on this image" })]
    );
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("That's your victory lap?");
  });

  it("leaves implicit `Name: text` untouched when nothing in context matches", () => {
    const result = extractReplyQuote("K: totally unrelated random words\nyeah", [
      ctxMessage({ id: "m1", content: "the quick brown fox" })
    ]);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("K: totally unrelated random words\nyeah");
  });

  it("does not fire implicit-quote when the first line has no `Name:` shape", () => {
    const result = extractReplyQuote("hello there\nmore", [
      ctxMessage({ id: "m1", content: "hello there" })
    ]);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("hello there\nmore");
  });

  it("salvages a bare content-only first line when it matches an older message", () => {
    const result = extractReplyQuote("older question\nhere is the answer", [
      ctxMessage({ id: "m1", content: "older question" }),
      ctxMessage({ id: "m2", content: "newer follow-up" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("here is the answer");
  });

  it("does not strip a bare content-only first line when it matches the latest message", () => {
    const result = extractReplyQuote("newer follow-up\nhere is the answer", [
      ctxMessage({ id: "m1", content: "older question" }),
      ctxMessage({ id: "m2", content: "newer follow-up" })
    ]);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("newer follow-up\nhere is the answer");
  });

  it("resolves quotes against image-bearing context messages (attachments ignored)", () => {
    const candidate = ctxMessage({
      id: "m1",
      content: "blind bitch u cant even see whats on this image",
      images: [{ url: "https://cdn.example/star.png", ocrText: "" }]
    });
    const implicit = extractReplyQuote(
      "K: blind bitch u cant even see whats on this image\nThat's your victory lap?",
      [candidate]
    );
    expect(implicit.replyToMessageId).toBe("m1");
    const explicit = extractReplyQuote(
      "> K: blind bitch u cant even see whats on this image\nThat's your victory lap?",
      [candidate]
    );
    expect(explicit.replyToMessageId).toBe("m1");
  });

  it("does not fire implicit-quote on short opener phrases (Note: ok / PS: done / etc.)", () => {
    const candidates = [
      ctxMessage({ id: "m1", content: "ok" }),
      ctxMessage({ id: "m2", content: "yeah we shipped it yesterday around 3pm" })
    ];
    expect(extractReplyQuote("Note: ok\nlol", candidates).replyToMessageId).toBeUndefined();
    expect(extractReplyQuote("Update: shipped it\nfinally", candidates).replyToMessageId).toBeUndefined();
    expect(extractReplyQuote("PS: forgot it\nsorry", candidates).replyToMessageId).toBeUndefined();
  });

  it("explicit `>` quote still wins and does not fall through to implicit", () => {
    const result = extractReplyQuote("> Alice: hey\nyeah", [
      ctxMessage({ id: "explicit", content: "hey" }),
      ctxMessage({ id: "implicit", content: "different text" })
    ]);
    expect(result.replyToMessageId).toBe("explicit");
    expect(result.cleanedContent).toBe("yeah");
  });

  it("does not false-positive a `Spotify: Now Playing X` opener against unrelated context", () => {
    const result = extractReplyQuote("Spotify: Now Playing Bach\nlol classic", [
      ctxMessage({ id: "m1", content: "did you eat lunch yet?" })
    ]);
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.cleanedContent).toBe("Spotify: Now Playing Bach\nlol classic");
  });

  // Pinning the replyQuote-only contract: in isolation, an `Aria: hello there` opener
  // matches an `Aria` candidate with content "hello there". The runtime never reaches
  // this branch (its own-name strip runs first), but the standalone module should
  // still salvage the salvageable shape if asked.
  it("salvages an implicit `Aria: hello there` opener against an Aria-authored candidate", () => {
    const result = extractReplyQuote("Aria: hello there\nyeah", [
      ctxMessage({ id: "m1", content: "hello there", displayName: "Aria", name: "Aria" })
    ]);
    expect(result.replyToMessageId).toBe("m1");
    expect(result.cleanedContent).toBe("yeah");
  });
});
