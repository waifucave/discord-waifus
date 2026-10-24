import { describe, expect, it } from "vitest";
import { assessLoop } from "../src/orchestration/loopDetector.js";
import { ContextMessage } from "../src/orchestration/contextMessages.js";

function msg(id: string, authorKind: "user" | "waifu", authorId: string, content: string): ContextMessage {
  return {
    id,
    channelId: "c1",
    authorKind,
    authorId,
    name: authorId,
    displayName: authorId,
    content,
    timestamp: `2026-06-11T20:00:0${id.charCodeAt(0) % 10}Z`,
    reactions: []
  };
}

describe("assessLoop", () => {
  it("returns not suspected for an empty window", () => {
    expect(assessLoop([])).toEqual({ suspected: false });
  });

  it("does not fire on a varied conversation", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "did you see the storm last night?"),
      msg("b", "waifu", "riko", "yeah my power went out for an hour"),
      msg("c", "waifu", "aria", "I just lit candles and read manga"),
      msg("d", "waifu", "riko", "of course you did, total gremlin behavior")
    ]);
    expect(result.suspected).toBe(false);
    expect(result.notice).toBeUndefined();
  });

  it("fires when consecutive waifu messages keep restating the same beat", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "we should totally get matching disaster trio shirts"),
      msg("b", "waifu", "riko", "yes matching disaster shirts to make the trio official"),
      msg("c", "waifu", "aria", "matching shirts for the disaster trio would be so official"),
      msg("d", "waifu", "riko", "official disaster trio matching shirts, I am drafting it")
    ]);
    expect(result.suspected).toBe(true);
    expect(result.notice).toContain("repetitive");
  });

  it("fires on a single near-duplicate pair (similarity above 0.8)", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "the broth defines the entire ramen experience honestly"),
      msg("b", "waifu", "riko", "honestly the broth defines the entire ramen experience")
    ]);
    expect(result.suspected).toBe(true);
  });

  it("ignores user messages when pairing", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "we should get matching shirts"),
      msg("b", "user", "kevin", "we should get matching shirts"),
      msg("c", "user", "kevin", "we should get matching shirts")
    ]);
    expect(result.suspected).toBe(false);
  });

  it("does not fire when old repetition falls outside the tail window", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "matching disaster shirts would be official"),
      msg("b", "waifu", "riko", "official disaster shirts matching would rock"),
      msg("c", "waifu", "aria", "disaster shirts official matching ensemble rocks"),
      msg("d", "waifu", "riko", "shirts official disaster matching idea totally rocks"),
      msg("e", "waifu", "aria", "official matching disaster shirts ensemble rocks"),
      msg("f", "waifu", "riko", "the massive storm knocked out power for miles"),
      msg("g", "waifu", "aria", "grabbed some candles and started reading manga"),
      msg("h", "waifu", "riko", "cooked ramen with homemade broth for dinner"),
      msg("i", "waifu", "aria", "finished homework with just one deadline left")
    ]);
    expect(result.suspected).toBe(false);
  });

  // I7: per-author history. Each waifu restates herself while the two never restate each other,
  // so every adjacent pair is dissimilar and only the same-speaker comparison sees the loop.
  it("fires on an A/B/A/B volley where each waifu repeats her own previous message", () => {
    const messages = [
      msg("a", "waifu", "aria", "volcano cake recipe needs molten chocolate centre"),
      msg("b", "waifu", "riko", "garage band rehearsal moved to thursday evening"),
      msg("c", "waifu", "aria", "molten chocolate centre makes volcano cake recipe"),
      msg("d", "waifu", "riko", "thursday evening garage band rehearsal moved"),
      msg("e", "waifu", "aria", "volcano cake recipe with molten chocolate centre"),
      msg("f", "waifu", "riko", "rehearsal for garage band moved thursday evening")
    ];
    const result = assessLoop(messages);
    expect(result.suspected).toBe(true);
    expect(result.notice).toContain("same-speaker pairs");
    // The adjacent-only view alone would have missed it: no consecutive pair overlaps at all.
    const adjacentOnly = assessLoop(messages.map((m, i) => ({ ...m, authorId: `speaker-${i}` })));
    expect(adjacentOnly.suspected).toBe(false);
  });

  // T5 review I3: same-speaker pairs only count inside an uninterrupted cast volley.
  it("does not fire on human-led chat where terse waifus answer each human turn alike", () => {
    const result = assessLoop([
      msg("a", "user", "kevin", "I finally beat the boss after twenty tries"),
      msg("b", "waifu", "aria", "haha yes amazing work kevin"),
      msg("c", "waifu", "riko", "nice one honestly"),
      msg("d", "user", "kevin", "and then I dropped my phone in the soup"),
      msg("e", "waifu", "aria", "haha yes amazing kevin"),
      msg("f", "waifu", "riko", "nice one honestly lol"),
      msg("g", "user", "mia", "the soup survived though"),
      msg("h", "waifu", "aria", "haha yes amazing work"),
      msg("i", "waifu", "riko", "honestly nice one")
    ]);
    expect(result.suspected).toBe(false);
  });

  it("still fires when the same volley runs with no human in between", () => {
    const result = assessLoop([
      msg("a", "user", "kevin", "I finally beat the boss after twenty tries"),
      msg("b", "waifu", "aria", "haha yes amazing work kevin"),
      msg("c", "waifu", "riko", "nice one honestly"),
      msg("e", "waifu", "aria", "haha yes amazing kevin"),
      msg("f", "waifu", "riko", "nice one honestly lol"),
      msg("h", "waifu", "aria", "haha yes amazing work"),
      msg("i", "waifu", "riko", "honestly nice one")
    ]);
    expect(result.suspected).toBe(true);
  });

  it("does not fire when each waifu moves on from her own previous message", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "volcano cake recipe needs molten chocolate"),
      msg("b", "waifu", "riko", "garage band rehearsal moved to thursday"),
      msg("c", "waifu", "aria", "anyway the bakery opened a second branch downtown"),
      msg("d", "waifu", "riko", "my drummer finally bought new cymbals")
    ]);
    expect(result.suspected).toBe(false);
  });

  it("accepts the minimal message shape (adapted ledger entries)", () => {
    expect(
      assessLoop([
        { authorKind: "waifu", authorId: "aria", content: "the broth defines the entire ramen experience honestly" },
        { authorKind: "waifu", authorId: "aria", content: "honestly the broth defines the entire ramen experience" }
      ]).suspected
    ).toBe(true);
  });
});

import { assessCastCadence } from "../src/orchestration/loopDetector.js";

describe("assessCastCadence", () => {
  const reply = { action: "reply" as const };
  const pause = { action: "no_reply" as const };

  it("flags the retire-after-two cadence (newest first: pause, reply, reply, pause, reply, pause)", () => {
    const result = assessCastCadence([pause, reply, reply, pause, reply, pause]);
    expect(result.suspected).toBe(true);
    expect(result.notice).toMatch(/retir|timer|keep casting/i);
  });

  it("does not flag long reply streaks", () => {
    const result = assessCastCadence([pause, reply, reply, reply, reply, pause]);
    expect(result.suspected).toBe(false);
  });

  it("does not flag mostly-quiet rooms (single pause, no rhythm)", () => {
    const result = assessCastCadence([pause, reply, reply]);
    expect(result.suspected).toBe(false);
  });

  it("needs at least two pauses in the window to call it a cadence", () => {
    const result = assessCastCadence([reply, reply, pause, reply, reply, reply]);
    expect(result.suspected).toBe(false);
  });
});
