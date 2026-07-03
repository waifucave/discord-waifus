import { describe, expect, it } from "vitest";
import { resolveBotAuthorIds } from "../src/shared/botIdentity.js";

const bots = {
  waifus: [
    { id: "aria", displayName: "Aria", applicationId: "111222333444555666", enabled: true },
    { id: "yuki", displayName: "Yuki", enabled: true }
  ]
};

describe("resolveBotAuthorIds", () => {
  it("returns entry id and applicationId when the ref is an entry id", () => {
    expect(resolveBotAuthorIds("aria", bots)).toEqual(["aria", "111222333444555666"]);
  });

  it("returns both ids when the ref is already the applicationId", () => {
    expect(resolveBotAuthorIds("111222333444555666", bots)).toEqual(["111222333444555666", "aria"]);
  });

  it("falls back to the bare ref when no entry matches", () => {
    expect(resolveBotAuthorIds("aria-bot", bots)).toEqual(["aria-bot"]);
  });

  it("dedupes when the matched entry has no applicationId", () => {
    expect(resolveBotAuthorIds("yuki", bots)).toEqual(["yuki"]);
  });

  it("returns empty for a missing ref", () => {
    expect(resolveBotAuthorIds(undefined, bots)).toEqual([]);
  });

  it("tolerates a missing bots file", () => {
    expect(resolveBotAuthorIds("aria", undefined)).toEqual(["aria"]);
  });
});
