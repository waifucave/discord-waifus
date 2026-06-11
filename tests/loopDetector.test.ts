import { describe, expect, it } from "vitest";
import { assessLoop } from "../src/orchestration/loopDetector.js";
import { ContextMessage } from "../src/orchestration/context.js";

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
});
