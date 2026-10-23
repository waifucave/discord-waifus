import { describe, expect, it } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import type { WaifuGenerationResult } from "../src/providers/types.js";
import { generateValidatedWaifuReply, type WaifuReplyAttemptInput } from "../src/orchestration/responderExecutor.js";
import { CUT_OFF_RETRY_NOTE, VERBOSITY_PROFILES } from "../src/orchestration/verbosity.js";

function recordingLogger() {
  const entries: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const log = (level: string) => (message: string, context?: Record<string, unknown>) => {
    entries.push({ level, message, context });
  };
  const logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") } as unknown as Logger;
  return { logger, entries };
}

function setup(replies: Array<string | WaifuGenerationResult>) {
  const calls: Array<string | undefined> = [];
  const { logger, entries } = recordingLogger();
  const input: WaifuReplyAttemptInput = {
    generate: async (retryNote) => {
      calls.push(retryNote);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return typeof reply === "string" ? { content: reply } : reply;
    },
    refToMessageId: new Map([["k3", "1003"]]),
    selfDisplayNames: ["Aria"],
    participantDisplayNames: ["Aria", "Kevin"],
    profile: VERBOSITY_PROFILES.terse,
    validator: { blockTags: ["memories", "direction"], toolNames: ["add_memory"] },
    logger,
    logContext: { guildId: "guild-1", channelId: "channel-1", waifuId: "aria" }
  };
  return { input, calls, entries };
}

describe("generateValidatedWaifuReply", () => {
  it("sends a clean first draft without retrying", async () => {
    const { input, calls } = setup(["hey kevin, long time"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toEqual([undefined]);
    expect(outcome.attemptsRun).toBe(1);
    expect(outcome.chunks).toEqual(["hey kevin, long time"]);
    expect(outcome.blockedViolations).toBeUndefined();
  });

  it("parses a known ↩#ref marker into the reply target", async () => {
    const { input } = setup(["↩#k3 yes exactly"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(outcome.marker).toEqual({ content: "yes exactly", replyToMessageId: "1003", ref: "k3" });
    expect(outcome.chunks).toEqual(["yes exactly"]);
  });

  it("strips a leaked header before the marker (processing order)", async () => {
    const { input } = setup(["[14:05 #k9] Aria: ↩#k3 yes"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(outcome.marker.replyToMessageId).toBe("1003");
    expect(outcome.chunks).toEqual(["yes"]);
  });

  it("strips an unknown ref and sends unthreaded", async () => {
    const { input } = setup(["↩#zz hi"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(outcome.marker).toEqual({ content: "hi", unknownRef: "zz" });
    expect(outcome.chunks).toEqual(["hi"]);
  });

  it("blocks a mass ping on the first attempt without regenerating", async () => {
    const { input, calls, entries } = setup(["@everyone wake up"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(1);
    expect(outcome.chunks).toEqual([]);
    expect(outcome.blockedViolations?.map((violation) => violation.check)).toContain("mass-ping");
    const blocked = entries.find((entry) => entry.message === "Output validator blocked waifu reply; nothing sent");
    expect(blocked?.context).toMatchObject({ guildId: "guild-1", channelId: "channel-1", waifuId: "aria", attempt: 1 });
  });

  it("regenerates once with a user-role retry note (never the waifu's name)", async () => {
    const { input, calls } = setup(["hi [mood: happy] there", "hi there"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatch(/^Your last draft was rejected: .*\. Write it again\.$/);
    expect(calls[1]).not.toMatch(/^Aria:/);
    expect(outcome.chunks).toEqual(["hi there"]);
  });

  it("sends nothing when a leak survives the final attempt", async () => {
    const { input, calls } = setup(["hi [mood: happy] there"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(outcome.chunks).toEqual([]);
    expect(outcome.blockedViolations?.map((violation) => violation.check)).toContain("bracket-tag");
  });

  it("trims an over-long reply at a sentence boundary without a retry", async () => {
    const reply =
      "omg the lemon bars were the best thing at the whole sale, no contest. " +
      "And the brownies vanished before I could even grab one which is honestly so rude of everyone.";
    const { input, calls } = setup([reply]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(1);
    expect(outcome.chunks).toEqual(["omg the lemon bars were the best thing at the whole sale, no contest."]);
  });

  it("retries an untrimmable over-long reply once, then hard-trims (no soft bypass)", async () => {
    const long = "word ".repeat(120).trim();
    const { input, calls } = setup([long]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("too long");
    expect(outcome.blockedViolations).toBeUndefined();
    expect(outcome.chunks.join(" ").length).toBeLessThanOrEqual(VERBOSITY_PROFILES.terse.hardMaxChars);
  });

  it("I5: a length finish keeps complete sentences", async () => {
    const { input, calls } = setup([{ content: "haha yes! and then we", finishReason: "length" }]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(1);
    expect(outcome.chunks).toEqual(["haha yes!"]);
  });

  it("I5: a length finish with nothing complete retries once with the cut-off note", async () => {
    const { input, calls } = setup([{ content: "so basically what i", finishReason: "length" }, "short one"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toEqual([undefined, CUT_OFF_RETRY_NOTE]);
    expect(outcome.chunks).toEqual(["short one"]);
  });

  it("retries once when cleaning removes the whole reply", async () => {
    const { input, calls } = setup(["Kevin: you wish", "fine"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("Your last draft was rejected");
    expect(outcome.chunks).toEqual(["fine"]);
  });
});
