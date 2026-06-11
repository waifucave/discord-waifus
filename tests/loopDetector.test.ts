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
    timestamp: `2026-06-11T20:00:0${id.length % 10}Z`,
    reactions: []
  };
}

describe("assessLoop", () => {
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
});
