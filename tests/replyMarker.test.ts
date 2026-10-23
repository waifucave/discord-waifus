import { describe, expect, it } from "vitest";
import {
  REPLY_MARKER_RE,
  parseReplyMarker,
  stripLeadingTranscriptHeader
} from "../src/orchestration/context/replyMarker.js";

const refs = new Map([
  ["k3", "1001"],
  ["a0", "1000"]
]);

describe("parseReplyMarker", () => {
  it("resolves a known ref and strips the marker", () => {
    expect(parseReplyMarker("↩#k3 yes exactly", refs)).toEqual({ content: "yes exactly", replyToMessageId: "1001", ref: "k3" });
  });

  it("accepts the emoji variant, a missing space and a newline after the marker", () => {
    expect(parseReplyMarker("↩️#a0 hi", refs).replyToMessageId).toBe("1000");
    expect(parseReplyMarker("↩ #a0 hi", refs).replyToMessageId).toBe("1000");
    expect(parseReplyMarker("↩#a0\nhi there", refs)).toMatchObject({ content: "hi there", replyToMessageId: "1000" });
    expect(parseReplyMarker("  ↩#a0 hi", refs).replyToMessageId).toBe("1000");
  });

  it("strips an unknown ref and sends unthreaded", () => {
    expect(parseReplyMarker("↩#zz9 hello", refs)).toEqual({ content: "hello", unknownRef: "zz9" });
  });

  it("leaves a mid-text marker alone (the validator flags it)", () => {
    expect(parseReplyMarker("lol ↩#k3 same", refs)).toEqual({ content: "lol ↩#k3 same" });
  });

  it("does not treat a hashtag or a glued word as a marker", () => {
    expect(parseReplyMarker("#k3 hi", refs)).toEqual({ content: "#k3 hi" });
    expect(parseReplyMarker("↩#k3hello", refs)).toEqual({ content: "↩#k3hello" });
    expect(REPLY_MARKER_RE.test("↩#k3")).toBe(true);
  });
});

describe("stripLeadingTranscriptHeader", () => {
  it("removes a leaked header (with or without reply part)", () => {
    expect(stripLeadingTranscriptHeader("[14:02 #k3] Aria: hi")).toBe("Aria: hi");
    expect(stripLeadingTranscriptHeader("[14:03 #k4 ↩#a1] hey")).toBe("hey");
    expect(stripLeadingTranscriptHeader("[9:05] hey")).toBe("hey");
  });

  it("keeps ordinary text and markers", () => {
    expect(stripLeadingTranscriptHeader("↩#k3 hi")).toBe("↩#k3 hi");
    expect(stripLeadingTranscriptHeader("[citation needed] lol")).toBe("[citation needed] lol");
  });
});
