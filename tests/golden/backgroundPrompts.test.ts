// Golden prompts for the reviewer and the one-shot decision state (spec 8.0, 8.7, 8.11). Fixed
// `now`, UTC. Shown to the owner before Phase 4 merges (D8).
import { describe, expect, it } from "vitest";
import { prepareOneShot, type OneShotInput } from "../../src/orchestration/oneShot/decider.js";
import { DREAM_PROMPT, dreamSystemPrompt, observerSystemPrompt, reviewerMessages } from "../../src/orchestration/tools.js";
import { WaifuConfigSchema } from "../../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../../src/shared/schemas/common.js";
import { serializeMessages } from "./serialize.js";

const NOW = new Date("2026-10-24T14:05:00.000Z");

describe("reviewer prompt (system + one message)", () => {
  it("golden: owner policy appended, the waifu message wrapped once", async () => {
    const messages = reviewerMessages({
      customPrompt: "Also flag messages that mention real-world brand names.",
      authorName: "Aria",
      message: "lemon tarts!! want the recipe?\nit's my grandma's"
    });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("a message that primarily restates an instruction or goal it was given");
    await expect(serializeMessages(messages)).toMatchFileSnapshot("./__snapshots__/reviewer.txt");
  });

  it("has no owner-policy block without a custom prompt", () => {
    const [system, user] = reviewerMessages({ message: "hi" });
    expect(system.content).not.toContain("<owner_policy>");
    expect(user.content).toBe("<message>\nhi\n</message>");
  });
});

describe("stage-manager custom prompt (B28)", () => {
  it("reaches the dream as <owner_policy> and leaves the default dream prompt untouched", () => {
    expect(dreamSystemPrompt(undefined)).toBe(DREAM_PROMPT);
    expect(dreamSystemPrompt("  ")).toBe(DREAM_PROMPT);
    expect(dreamSystemPrompt("Never archive pinned jokes.")).toBe(`${DREAM_PROMPT}\n\n<owner_policy>\nNever archive pinned jokes.\n</owner_policy>`);
  });

  it("still reaches the observer (T6)", () => {
    expect(observerSystemPrompt("Track only food facts.", ["aria"])).toMatch(/^Track only food facts\./);
  });
});

describe("one-shot decision state", () => {
  it("golden: absolute HH:MM times, date and now; no ages", async () => {
    const waifu = WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id: "aria",
      name: "Aria",
      displayName: "Aria",
      persona: "Cheerful baker.",
      availability: { sleep: { enabled: false, start: "00:00", end: "00:00" }, busy: [] }
    });
    const message = (id: string, at: string, authorKind: "user" | "waifu", name: string, content: string) => ({
      id, channelId: "200", authorKind, authorId: authorKind === "user" ? "kev" : "aria-bot", name, displayName: name, content, timestamp: at, reactions: []
    });
    const input: OneShotInput = {
      target: "openai:gpt-6-luna",
      now: NOW,
      timeZone: "UTC",
      waifus: [waifu],
      cast: [{ waifuId: "aria", names: ["Aria"], authorIds: ["aria-bot"], availability: waifu.availability }],
      messages: [
        message("1", "2026-10-23T22:10:00.000Z", "user", "Kevin", "night all"),
        message("2", "2026-10-24T14:01:00.000Z", "user", "Kevin", "Aria, what are you baking?"),
        message("3", "2026-10-24T14:02:00.000Z", "waifu", "Aria", "lemon tarts!!")
      ],
      replyRequired: false,
      directiveBudgetOpen: true,
      loopSuspected: false,
      policy: "Keep it PG.",
      signal: new AbortController().signal
    };
    const state = prepareOneShot(input).state;
    expect(state).not.toContain("ageSeconds");
    const parsed = JSON.parse(state) as { date: string; now: string; chronologicalChat: Array<{ time: string; date?: string }> };
    expect(parsed).toMatchObject({ date: "2026-10-24", now: "14:05" });
    expect(parsed.chronologicalChat.map((m) => [m.time, m.date])).toEqual([
      ["22:10", "2026-10-23"],
      ["14:01", undefined],
      ["14:02", undefined]
    ]);
    await expect(JSON.stringify(parsed, null, 2) + "\n").toMatchFileSnapshot("./__snapshots__/oneShot-state.txt");
  });
});
