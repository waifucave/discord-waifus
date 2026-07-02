import { describe, expect, it } from "vitest";
import { planWaifuReplyChunks, splitWaifuReply, typingDelayMs } from "../src/orchestration/messageSplit.js";

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

describe("planWaifuReplyChunks", () => {
  it("keeps only the first two chunks when the third chunk is 18 characters or longer", () => {
    expect(planWaifuReplyChunks(["One.", "Two.", "123456789 12345678", "Four."])).toEqual({
      immediateChunks: ["One.", "Two."],
      cachedChunks: ["123456789 12345678", "Four."]
    });
  });

  it("allows the third chunk when it is shorter than 18 characters including spaces", () => {
    expect(planWaifuReplyChunks(["One.", "Two.", "short third", "Four."])).toEqual({
      immediateChunks: ["One.", "Two.", "short third"],
      cachedChunks: ["Four."]
    });
  });

  it("allows the fourth chunk when the third was allowed and the fourth is a server emoji", () => {
    expect(planWaifuReplyChunks(["One.", "Two.", "short third", "<:cutecat:>", "Five."])).toEqual({
      immediateChunks: ["One.", "Two.", "short third", "<:cutecat:>"],
      cachedChunks: ["Five."]
    });
  });

  it("allows the fourth chunk when the third was allowed and the fourth is a unicode emoji", () => {
    expect(planWaifuReplyChunks(["One.", "Two.", "short third", "🥹", "Five."])).toEqual({
      immediateChunks: ["One.", "Two.", "short third", "🥹"],
      cachedChunks: ["Five."]
    });
  });

  it("keeps the fourth chunk cached when the third chunk was too long", () => {
    expect(planWaifuReplyChunks(["One.", "Two.", "This third chunk is too long.", "🥹"])).toEqual({
      immediateChunks: ["One.", "Two."],
      cachedChunks: ["This third chunk is too long.", "🥹"]
    });
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
