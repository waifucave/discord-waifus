import { describe, expect, it } from "vitest";
import { decideDeterministically, type DeterministicCastMember } from "../src/orchestration/deterministicOrchestrator.js";
import type { ContextMessage } from "../src/orchestration/context.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function msg(partial: Partial<ContextMessage> & { content: string }): ContextMessage {
  return {
    id: partial.id ?? `m-${Math.abs(hash(partial.content))}`,
    channelId: "c1",
    authorKind: partial.authorKind ?? "user",
    authorId: partial.authorId ?? "human-1",
    name: partial.name ?? partial.displayName ?? "K",
    displayName: partial.displayName ?? "K",
    content: partial.content,
    timestamp: partial.timestamp ?? "2026-07-06T11:59:30.000Z",
    reactions: [],
    ...(partial.replyTo ? { replyTo: partial.replyTo } : {})
  } as ContextMessage;
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

const AWAKE = { sleep: { enabled: false, start: "02:00", end: "09:00" }, busy: [] };
const cast: DeterministicCastMember[] = [
  { waifuId: "riko", names: ["Riko"], authorIds: ["bot-riko"], availability: AWAKE },
  { waifuId: "aria", names: ["Aria", "K的小娇妻"], authorIds: ["bot-aria"], availability: AWAKE },
  { waifuId: "lumi", names: ["Lumi"], authorIds: ["bot-lumi"], availability: AWAKE }
];

describe("decideDeterministically", () => {
  it("reply-target wins: human replying to Aria casts aria", () => {
    const decision = decideDeterministically({
      messages: [
        msg({ authorKind: "waifu", authorId: "bot-aria", displayName: "K的小娇妻", content: "a loyal hoe thank you 💅", timestamp: "2026-07-06T11:58:00.000Z" }),
        msg({ content: "sure you are", replyTo: { messageId: "x", authorName: "K的小娇妻" } })
      ],
      cast,
      now: NOW
    });
    expect(decision.action).toBe("reply");
    expect(decision.respondingWaifus[0]?.waifuId).toBe("aria");
  });

  it("talking TO Riko ABOUT Aria casts riko (address beats reference)", () => {
    const decision = decideDeterministically({
      messages: [msg({ content: "Riko, isn't Aria being so weird today" })],
      cast,
      now: NOW
    });
    expect(decision.respondingWaifus[0]?.waifuId).toBe("riko");
  });

  it("CJK nickname is matched for addressing", () => {
    const decision = decideDeterministically({
      messages: [msg({ content: "K的小娇妻 explain yourself" })],
      cast,
      now: NOW
    });
    expect(decision.respondingWaifus[0]?.waifuId).toBe("aria");
  });

  it("an addressed waifu who is asleep stays asleep", () => {
    // schedules are local-time (same convention as currentlyDoingForWaifu); build an
    // interval that contains NOW's local hour so the test passes in any timezone
    const localHour = NOW.getHours();
    const start = `${String(localHour).padStart(2, "0")}:00`;
    const end = `${String((localHour + 2) % 24).padStart(2, "0")}:00`;
    const sleepy: DeterministicCastMember[] = [
      { ...cast[0], availability: { sleep: { enabled: true, start, end }, busy: [] } },
      cast[1]
    ];
    const decision = decideDeterministically({
      messages: [msg({ content: "Riko you up?" })],
      cast: sleepy,
      now: NOW
    });
    expect(decision.respondingWaifus[0]?.waifuId).not.toBe("riko");
  });

  it("generic human message picks the least recently spoken awake waifu", () => {
    const decision = decideDeterministically({
      messages: [
        msg({ authorKind: "waifu", authorId: "bot-riko", displayName: "Riko", content: "later nerds", timestamp: "2026-07-06T11:50:00.000Z" }),
        msg({ authorKind: "waifu", authorId: "bot-aria", displayName: "Aria", content: "bye", timestamp: "2026-07-06T11:55:00.000Z" }),
        msg({ content: "anyone here" })
      ],
      cast,
      now: NOW
    });
    expect(decision.action).toBe("reply");
    expect(decision.respondingWaifus[0]?.waifuId).toBe("lumi");
  });

  it("does not cast the waifu who sent the very last waifu message when another candidate exists", () => {
    const decision = decideDeterministically({
      messages: [
        msg({ authorKind: "waifu", authorId: "bot-riko", displayName: "Riko", content: "I said what I said", timestamp: "2026-07-06T11:59:00.000Z" }),
        msg({ content: "lol ok" })
      ],
      cast,
      now: NOW
    });
    expect(decision.respondingWaifus[0]?.waifuId).not.toBe("riko");
  });

  it("cast-only room (latest is waifu) goes quiet with a long retrigger", () => {
    const decision = decideDeterministically({
      messages: [
        msg({ content: "gn", timestamp: "2026-07-06T08:00:00.000Z" }),
        msg({ authorKind: "waifu", authorId: "bot-lumi", displayName: "Lumi", content: "sleep well", timestamp: "2026-07-06T08:00:30.000Z" })
      ],
      cast,
      now: NOW
    });
    expect(decision.action).toBe("no_reply");
    expect(decision.retriggerAfterSeconds).toBeGreaterThanOrEqual(900);
  });

  it("fresh human activity gets a short retrigger on no_reply paths and is deterministic", () => {
    const input = {
      messages: [
        msg({ content: "brb", timestamp: "2026-07-06T11:59:40.000Z" }),
        msg({ authorKind: "waifu", authorId: "bot-lumi", displayName: "Lumi", content: "hurry back", timestamp: "2026-07-06T11:59:50.000Z" })
      ],
      cast,
      now: NOW
    };
    const a = decideDeterministically(input);
    const b = decideDeterministically(input);
    expect(a).toEqual(b);
    expect(a.action).toBe("no_reply");
    expect(a.retriggerAfterSeconds).toBeLessThanOrEqual(120);
  });

  it("no candidates at all → no_reply", () => {
    const decision = decideDeterministically({ messages: [msg({ content: "hello?" })], cast: [], now: NOW });
    expect(decision.action).toBe("no_reply");
  });
});
