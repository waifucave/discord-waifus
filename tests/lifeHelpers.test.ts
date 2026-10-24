// Helpers kept from the retired reply path for the Living cast (L2 is their caller): outbound
// checks and typing delay, availability, name matching.
import { describe, expect, it } from "vitest";
import { isAvailable } from "../src/life/availability.js";
import { isOnlyToolCallSyntax, stripCopiedHeader, stripLeadingTranscriptHeader, typingDelayMs } from "../src/life/outbound.js";
import { normalizeName, wordBoundaryIncludes } from "../src/life/text.js";

describe("outbound checks (spec §6.3)", () => {
  it("typing delay is 30 ms per character, clamped to 0.6–4.5 s", () => {
    expect(typingDelayMs("")).toBe(600);
    expect(typingDelayMs("x".repeat(50))).toBe(1500);
    expect(typingDelayMs("x".repeat(1000))).toBe(4500);
  });

  it("strips copied transcript headers and her own name, not ordinary text", () => {
    expect(stripLeadingTranscriptHeader("[14:02 #k3] [14:03 #k4 ↩#a1] hello")).toBe("hello");
    expect(stripCopiedHeader("[14:02 #k3] Aria: hello there", ["Aria"])).toBe("hello there");
    expect(stripCopiedHeader("[14:05] hi", ["Aria"])).toBe("hi");
    expect(stripCopiedHeader("at [14:02] we met", ["Aria"])).toBe("at [14:02] we met");
  });

  it("rejects text that is only tool-call syntax", () => {
    expect(isOnlyToolCallSyntax('{"text":"hi"}')).toBe(true);
    expect(isOnlyToolCallSyntax("<tool_call>send</tool_call>")).toBe(true);
    expect(isOnlyToolCallSyntax('send_message({"text":"hi"})', ["send_message"])).toBe(true);
    expect(isOnlyToolCallSyntax('send_message: {"text":"hi"}', ["send_message"])).toBe(true);
    expect(isOnlyToolCallSyntax("I'll call send_message later")).toBe(false);
    expect(isOnlyToolCallSyntax("{not json")).toBe(false);
    expect(isOnlyToolCallSyntax("")).toBe(false);
  });
});

describe("availability and names", () => {
  it("isAvailable follows the sleep window (across midnight) and busy blocks, in local time", () => {
    const sleeping = { sleep: { enabled: true, start: "23:00", end: "07:00" }, busy: [] };
    expect(isAvailable(sleeping, new Date(2026, 9, 24, 3, 0))).toBe(false);
    expect(isAvailable(sleeping, new Date(2026, 9, 24, 12, 0))).toBe(true);
    expect(isAvailable({ ...sleeping, sleep: { ...sleeping.sleep, enabled: false } }, new Date(2026, 9, 24, 3, 0))).toBe(true);
    const busy = { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [{ start: "11:00", end: "13:00", reason: "work" }] };
    expect(isAvailable(busy, new Date(2026, 9, 24, 12, 0))).toBe(false);
    expect(isAvailable(busy, new Date(2026, 9, 24, 14, 0))).toBe(true);
  });

  it("matches names on word boundaries, case-insensitively", () => {
    expect(normalizeName("  Ária ")).toBe(normalizeName("ária"));
    expect(wordBoundaryIncludes("hey aria, you there?", "aria")).toBe(true);
    expect(wordBoundaryIncludes("mariachi band", "aria")).toBe(false);
  });
});
