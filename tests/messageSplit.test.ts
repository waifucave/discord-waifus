import { describe, expect, it } from "vitest";
import { splitWaifuReply, typingDelayMs } from "../src/orchestration/messageSplit.js";

describe("splitWaifuReply", () => {
  it("keeps a register-compliant multi-sentence reply as ONE message", () => {
    const input =
      "Boredom is the enemy <:cutecat:1492857756011728896> Let's fix that. How about a quick game of \"Would You Rather\"? I'll start: would you rather have a personal chef for a year or a personal masseuse?";
    expect(splitWaifuReply(input)).toEqual([input]);
  });

  it("packs sentences into chunks up to the hard limit for long replies", () => {
    const s1 = "First sentence about the plan we made earlier today with everyone involved somehow.";
    const s2 = "Second sentence keeps rambling about a completely different topic entirely for a while.";
    const s3 = "Third sentence closes the whole thought out with an unrelated final flourish at the end.";
    const s4 = "Fourth sentence pushes this over the two hundred eighty char packing limit completely now.";
    const chunks = splitWaifuReply(`${s1} ${s2} ${s3} ${s4}`);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(3);
    for (const chunk of chunks) expect([...chunk].length).toBeLessThanOrEqual(280);
    expect(chunks.join(" ")).toBe(`${s1} ${s2} ${s3} ${s4}`);
  });

  it("drops near-duplicate variants of the same beat within one reply", () => {
    const input = [
      "now let's go to dim sum so you can watch me sit next to MY husband while I eat YOUR tart",
      "something completely different happens here instead",
      "now let's go to dim sum so you can watch me sit next to MY husband while I eat the tart"
    ].join("\n");
    const chunks = splitWaifuReply(input);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe("something completely different happens here instead");
  });

  it("drops a reworded duplicate observed live (0.68 overlap)", () => {
    const input = [
      "and the tart's still in my hand from when you shoved it at me before your parking meter meltdown.",
      "and the tart's still in my hand from when you handed it to me before your curb meltdown."
    ].join("\n");
    expect(splitWaifuReply(input)).toHaveLength(1);
  });

  it("keeps distinct short chunks even when they share a few words", () => {
    const input = "K is late again\nK better bring snacks";
    expect(splitWaifuReply(input)).toEqual(["K is late again", "K better bring snacks"]);
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

  it("splits on paragraph breaks even when no sentence punctuation is present", () => {
    const input = "Baby you're so fine 😘💕\n\nNow don't tell K I said that~";
    expect(splitWaifuReply(input)).toEqual([
      "Baby you're so fine 😘💕",
      "Now don't tell K I said that~"
    ]);
  });

  it("splits long chunks at the middle-most comma, dropping the comma", () => {
    const s1 = "a".repeat(150);
    const s2 = "b".repeat(150);
    expect(splitWaifuReply(`${s1}, ${s2}`)).toEqual([s1, s2]);
  });

  it("splits after a middle-most emoji when no comma is available, keeping the emoji on the left", () => {
    const left = "a".repeat(150);
    const right = "b".repeat(150);
    expect(splitWaifuReply(`${left} 😘 ${right}`)).toEqual([`${left} 😘`, right]);
  });

  it("splits after a middle-most custom emoji when no comma is available", () => {
    const left = "x".repeat(150);
    const right = "y".repeat(150);
    expect(splitWaifuReply(`${left} <:cutecat:123456789> ${right}`)).toEqual([
      `${left} <:cutecat:123456789>`,
      right
    ]);
  });

  it("leaves a long chunk intact when it has no comma and no emoji", () => {
    const noMarkers = "z".repeat(150);
    expect(splitWaifuReply(noMarkers)).toEqual([noMarkers]);
  });
});

describe("splitWaifuReply Discord length limit", () => {
  const isLoneSurrogate = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

  it("hard-splits an over-2000-char run with no comma or emoji at whitespace", () => {
    const words = Array.from({ length: 900 }, (_, index) => `w${index.toString(36)}x`);
    const input = words.join(" ");
    expect(input.length).toBeGreaterThan(4000);
    const chunks = splitWaifuReply(input);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join(" ")).toBe(input);
  });

  it("hard-splits a whitespace-free run at 2000 UTF-16 units without breaking surrogate pairs", () => {
    const input = "\u{1D49C}".repeat(3001);
    const chunks = splitWaifuReply(input);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(isLoneSurrogate(chunk)).toBe(false);
    }
    expect(chunks.join("")).toBe(input);
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
