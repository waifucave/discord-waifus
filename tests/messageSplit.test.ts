import { describe, expect, it } from "vitest";
import { splitWaifuReply, typingDelayMs } from "../src/orchestration/messageSplit.js";

describe("splitWaifuReply", () => {
  it("splits the user's example into three chunks", () => {
    const input =
      "Boredom is the enemy <:cutecat:1492857756011728896> Let's fix that. How about a quick game of \"Would You Rather\"? I'll start: would you rather have a personal chef for a year or a personal masseuse?";
    expect(splitWaifuReply(input)).toEqual([
      "Boredom is the enemy <:cutecat:1492857756011728896> Let's fix that.",
      "How about a quick game of \"Would You Rather\"?",
      "I'll start: would you rather have a personal chef for a year or a personal masseuse?"
    ]);
  });

  it("returns a single chunk when there are no terminal sentence punctuation marks", () => {
    expect(splitWaifuReply("Hey there friend")).toEqual(["Hey there friend"]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(splitWaifuReply("   \n  ")).toEqual([]);
  });

  it("does not split a decimal like 3.14", () => {
    expect(splitWaifuReply("Pi is 3.14 roughly.")).toEqual(["Pi is 3.14 roughly."]);
  });
});

describe("typingDelayMs", () => {
  it("clamps short chunks to the minimum delay", () => {
    expect(typingDelayMs("hi")).toBe(600);
  });

  it("scales with chunk length in the middle range", () => {
    expect(typingDelayMs("x".repeat(50))).toBe(1500);
  });

  it("clamps long chunks to the maximum delay", () => {
    expect(typingDelayMs("x".repeat(500))).toBe(4500);
  });
});
