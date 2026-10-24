import { describe, expect, it } from "vitest";
import {
  CUT_OFF_RETRY_NOTE,
  VERBOSITY_PROFILES,
  cutToCompleteSentence,
  retryNote,
  splitWaifuReply,
  trimAtSentence,
  trimAtWord,
  validateWaifuOutput,
  verbosityProfile,
  type WaifuValidationContext
} from "../src/orchestration/verbosity.js";

const terse = VERBOSITY_PROFILES.terse;

function ctx(over: Partial<WaifuValidationContext> = {}): WaifuValidationContext {
  return {
    selfNames: ["Aria"],
    participantNames: ["Aria", "Kevin", "Riko"],
    blockTags: ["harness", "memories", "direction", "memory_note"],
    toolNames: ["add_memory"],
    profile: terse,
    ...over
  };
}

describe("verbosity profiles", () => {
  it("matches the spec numbers", () => {
    expect(VERBOSITY_PROFILES.terse).toMatchObject({ softMaxChars: 140, hardMaxChars: 280, maxLines: 2, splitChunkChars: 280 });
    expect(VERBOSITY_PROFILES.chatty).toMatchObject({ softMaxChars: 320, hardMaxChars: 600, maxLines: 3, splitChunkChars: 400 });
    expect(VERBOSITY_PROFILES.expressive).toMatchObject({ softMaxChars: 900, hardMaxChars: 1800, maxLines: 6, splitChunkChars: 900 });
  });

  it("defaults to terse", () => {
    expect(verbosityProfile(undefined)).toBe(terse);
    expect(verbosityProfile("chatty").level).toBe("chatty");
  });
});

describe("validateWaifuOutput verdicts", () => {
  it("passes a short clean reply", () => {
    expect(validateWaifuOutput("lol same", ctx())).toEqual({ verdict: "pass", violations: [] });
  });

  it("blocks a mass ping", () => {
    expect(validateWaifuOutput("@everyone look", ctx()).verdict).toBe("block");
  });

  it("asks for a retry on a leak, on the final attempt too (the caller blocks it)", () => {
    expect(validateWaifuOutput("hey <memories>", ctx()).verdict).toBe("retry");
    expect(validateWaifuOutput("hey <memories>", ctx({ finalAttempt: true })).verdict).toBe("retry");
  });

  it("flags header leaks and stray reply markers", () => {
    expect(validateWaifuOutput("ok\n[14:02 #k3] Kevin: hi", ctx()).violations.map((v) => v.check)).toContain("header-leak");
    expect(validateWaifuOutput("ok ↩#k3 sure", ctx()).violations.map((v) => v.check)).toContain("stray-reply-marker");
  });

  it("trims an over-long reply at a sentence boundary when ≥ 40% is kept", () => {
    const text = "I think the bake sale went great honestly, way better than any of us expected. " + "Everyone loved the lemon bars and the brownies were gone in ten minutes flat, which was wild to see happen.";
    const result = validateWaifuOutput(text, ctx());
    expect(result.verdict).toBe("trim");
    expect(result.trimmed).toBe("I think the bake sale went great honestly, way better than any of us expected.");
    expect(result.violations.map((v) => v.check)).toEqual(["length"]);
  });

  it("asks for a retry when a sentence trim would keep less than 40%", () => {
    const text = "Yes. " + "a".repeat(10) + " " + "word ".repeat(40);
    const result = validateWaifuOutput(text, ctx());
    expect(result.verdict).toBe("retry");
  });

  it("hard-trims at a word boundary to hardMaxChars on the final attempt", () => {
    const text = "word ".repeat(100).trim();
    const result = validateWaifuOutput(text, ctx({ finalAttempt: true }));
    expect(result.verdict).toBe("trim");
    expect(result.trimmed!.length).toBeLessThanOrEqual(terse.hardMaxChars);
    expect(result.trimmed!.endsWith("word")).toBe(true);
  });

  it("cuts extra lines beyond maxLines", () => {
    const result = validateWaifuOutput("one\ntwo\nthree", ctx());
    expect(result.verdict).toBe("trim");
    expect(result.trimmed).toBe("one\ntwo");
    expect(result.violations.map((v) => v.check)).toContain("too-many-lines");
  });

  it("never sends an over-limit reply unchanged (no soft-length bypass)", () => {
    const text = "x".repeat(400);
    const first = validateWaifuOutput(text, ctx());
    expect(first.verdict).toBe("retry");
    const last = validateWaifuOutput(text, ctx({ finalAttempt: true }));
    expect(last.verdict).toBe("trim");
    expect(Array.from(last.trimmed!).length).toBeLessThanOrEqual(terse.hardMaxChars);
  });

  it("uses the profile limits (chatty allows longer replies)", () => {
    const text = "This is a perfectly normal chatty message that runs a bit longer than a terse one would. It has two sentences.";
    expect(validateWaifuOutput(text, ctx({ profile: VERBOSITY_PROFILES.chatty })).verdict).toBe("pass");
  });
});

describe("trim helpers", () => {
  it("trimAtSentence keeps whole sentences within the limit", () => {
    expect(trimAtSentence("Hi there. How are you doing today?", 12)).toBe("Hi there.");
    expect(trimAtSentence("short", 12)).toBe("short");
    expect(trimAtSentence("nopunctuationatallhere", 5)).toBe("");
  });

  it("trimAtWord cuts at a word boundary", () => {
    expect(trimAtWord("alpha beta gamma delta", 12)).toBe("alpha beta");
  });

  it("trimAtWord counts and cuts by grapheme, never splitting an emoji sequence", () => {
    const family = "👨‍👩‍👧‍👦";
    // Seven code points, one grapheme: fits a 5-character budget whole.
    expect(trimAtWord(`hi ${family}`, 5)).toBe(`hi ${family}`);
    // No boundary in the first half: a hard cut that keeps whole graphemes only.
    const flags = "🇯🇵🇫🇷🇩🇪🇮🇹";
    expect(trimAtWord(flags, 2)).toBe("🇯🇵🇫🇷");
    expect(trimAtWord(`ok ${"e\u0301".repeat(6)}`, 5)).toBe(`ok ${"e\u0301".repeat(2)}`);
  });

  it("cutToCompleteSentence drops a cut-off tail", () => {
    expect(cutToCompleteSentence("I loved it! Then we went to the")).toBe("I loved it!");
    expect(cutToCompleteSentence("first line\nsecond line cut")).toBe("first line");
    expect(cutToCompleteSentence("no sentence end here")).toBe("");
  });
});

describe("retryNote", () => {
  it("is a user-facing note that never speaks as the waifu", () => {
    const note = retryNote([{ check: "length", detail: "300 chars" }], terse);
    expect(note).toBe("Your last draft was rejected: it was too long — keep it under 140 characters. Write it again.");
    expect(note).not.toMatch(/^\w+:/);
  });

  it("joins several reasons", () => {
    const note = retryNote(
      [
        { check: "harness-tag", detail: "" },
        { check: "self-repeat", detail: "" }
      ],
      terse
    );
    expect(note).toContain("prompt tags");
    expect(note).toContain("you already said that");
  });

  it("has a fixed cut-off note (I5)", () => {
    expect(CUT_OFF_RETRY_NOTE).toBe("Your last message was cut off; write a shorter one.");
  });
});

describe("splitWaifuReply", () => {
  it("honors the author's line breaks", () => {
    expect(splitWaifuReply("hey\nwhat's up", terse)).toEqual(["hey", "what's up"]);
  });

  it("packs sentences up to the profile chunk size", () => {
    const words = ["apple", "river", "candle", "planet", "violin", "garden", "rocket", "pillow"];
    const text = words.map((w) => `Sentence about the ${w} keeps going for a while, ${w} ${w} ${w}.`).join(" ");
    const terseChunks = splitWaifuReply(text, terse);
    const expressiveChunks = splitWaifuReply(text, VERBOSITY_PROFILES.expressive);
    expect(terseChunks.length).toBeGreaterThan(1);
    expect(terseChunks.every((c) => c.length <= terse.splitChunkChars)).toBe(true);
    expect(expressiveChunks).toHaveLength(1);
  });

  it("drops near-duplicate drafts of the same line", () => {
    expect(splitWaifuReply("that is so cool honestly\nthat is so cool honestly!!", terse)).toEqual(["that is so cool honestly"]);
  });
});
