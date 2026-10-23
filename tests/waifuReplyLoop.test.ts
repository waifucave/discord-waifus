import { describe, expect, it } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import type { WaifuGenerationResult } from "../src/providers/types.js";
import { generateValidatedWaifuReply, type WaifuReplyAttemptInput } from "../src/orchestration/responderExecutor.js";

function recordingLogger() {
  const entries: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const log = (level: string) => (message: string, context?: Record<string, unknown>) => {
    entries.push({ level, message, context });
  };
  const logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") } as unknown as Logger;
  return { logger, entries };
}

function setup(replies: string[]) {
  const calls: Array<string | undefined> = [];
  const { logger, entries } = recordingLogger();
  const input: WaifuReplyAttemptInput = {
    generate: async (retryUserMessage) => {
      calls.push(retryUserMessage);
      const content = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { content } satisfies WaifuGenerationResult;
    },
    displayName: "Aria",
    contextMessages: [],
    selfDisplayNames: ["Aria"],
    participantDisplayNames: ["Aria", "Kevin"],
    selfAuthorIds: ["aria-bot"],
    validator: { blockTags: [], toolNames: ["add_memory"] },
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

  it("blocks a mass ping on the first attempt without regenerating", async () => {
    const { input, calls, entries } = setup(["@everyone wake up"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(1);
    expect(outcome.chunks).toEqual([]);
    expect(outcome.blockedViolations?.map((violation) => violation.check)).toContain("mass-ping");
    const blocked = entries.find((entry) => entry.message === "Output validator blocked waifu reply; nothing sent");
    expect(blocked?.context).toMatchObject({ guildId: "guild-1", channelId: "channel-1", waifuId: "aria", attempt: 1 });
  });

  it("regenerates once with a corrective message after a retry verdict", async () => {
    const { input, calls } = setup(["hi [mood: happy] there", "hi there"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatch(/^Aria: \(/);
    expect(outcome.attemptsRun).toBe(2);
    expect(outcome.chunks).toEqual(["hi there"]);
    expect(outcome.blockedViolations).toBeUndefined();
  });

  it("sends nothing when a hard retry violation survives the final attempt", async () => {
    const { input, calls } = setup(["hi [mood: happy] there"]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(outcome.chunks).toEqual([]);
    expect(outcome.blockedViolations?.map((violation) => violation.check)).toContain("bracket-tag");
  });

  it("sends a soft-only (length) violation as-is after the retry", async () => {
    const long = "this is a very long and rambling reply that keeps going well past the casual chat register limit";
    const { input, calls } = setup([long]);
    const outcome = await generateValidatedWaifuReply(input);
    expect(calls).toHaveLength(2);
    expect(outcome.blockedViolations).toBeUndefined();
    expect(outcome.chunks.join(" ")).toBe(long);
  });
});
