import { describe, expect, it } from "vitest";
import { clipSurrogateSafe, sanitizeChatMessages, stripLoneSurrogates } from "../src/shared/text.js";

describe("stripLoneSurrogates", () => {
  it("removes an unpaired high surrogate (the DeepSeek 'unexpected end of hex escape' trigger)", () => {
    const broken = "scoreboard \ud83d"; // emoji cut in half by a naive slice
    expect(stripLoneSurrogates(broken)).toBe("scoreboard ");
  });

  it("removes an unpaired low surrogate", () => {
    expect(stripLoneSurrogates("\ude02 lol")).toBe(" lol");
  });

  it("preserves intact emoji and plain text", () => {
    const text = "1v1 me 😂🔥 já";
    expect(stripLoneSurrogates(text)).toBe(text);
  });
});

describe("clipSurrogateSafe", () => {
  it("never splits a surrogate pair at the clip boundary", () => {
    const text = "a".repeat(78) + "😂rest"; // pair straddles index 79
    const clipped = clipSurrogateSafe(text, 79);
    expect(clipped.length).toBeLessThanOrEqual(79);
    expect(stripLoneSurrogates(clipped)).toBe(clipped);
  });

  it("returns short strings untouched", () => {
    expect(clipSurrogateSafe("hi 😂", 79)).toBe("hi 😂");
  });
});

describe("sanitizeChatMessages", () => {
  it("cleans string content and text parts, leaving structure intact", () => {
    const messages = [
      { role: "system", content: "be riko \ud83d" },
      { role: "user", content: [{ type: "text", text: "half \udc00 emoji" }, { type: "image", data: "abc" }] }
    ];
    const cleaned = sanitizeChatMessages(messages as never) as typeof messages;
    expect(cleaned[0].content).toBe("be riko ");
    expect((cleaned[1].content as Array<Record<string, string>>)[0].text).toBe("half  emoji");
    expect((cleaned[1].content as Array<Record<string, string>>)[1].data).toBe("abc");
  });
});
