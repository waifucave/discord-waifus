// Helpers kept from the retired reply path for the Living cast (L2 is their caller): outbound
// checks and typing delay, availability, name matching.
import { describe, expect, it } from "vitest";
import { isAvailable } from "../src/life/availability.js";
import { isOnlyToolCallSyntax, stripCopiedHeader, stripLeadingTranscriptHeader, typingDelayMs } from "../src/life/outbound.js";
import { foldName, isWeakName, namesSomeone, normalizeName, wordBoundaryIncludes } from "../src/life/text.js";
import { entryHeader, entryLine, lineMessageOf, type LineMessage } from "../src/life/render.js";
import { EMPTY_GUILD_DIRECTORY } from "../src/orchestration/context/messageRender.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";

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

  it("forget matching folds Latin diacritics both ways and keeps other scripts' marks; weak names are short or generic", () => {
    expect(namesSomeone("jose taught me flan", "José")).toBe(true);
    expect(namesSomeone("José taught me flan", "jose")).toBe(true);
    expect(namesSomeone("Zoë said hi", "zoe")).toBe(true);
    expect(namesSomeone("josefina said hi", "José")).toBe(false);
    expect(foldName("が")).toBe("が");
    expect(namesSomeone("さくらが来た", "さくら")).toBe(true);
    for (const weak of ["Al", "Kev", "user", "Admin", "you", "さ"]) expect(isWeakName(weak), weak).toBe(true);
    for (const strong of ["Kevin", "José", "さくら", "kevbaker"]) expect(isWeakName(strong), strong).toBe(false);
  });

  it("matches names on word boundaries, case-insensitively", () => {
    expect(normalizeName("  Ária ")).toBe(normalizeName("ária"));
    expect(wordBoundaryIncludes("hey aria, you there?", "aria")).toBe(true);
    expect(wordBoundaryIncludes("mariachi band", "aria")).toBe(false);
  });
});

describe("message lines (moved from the context engine's transcript renderer, spec §15)", () => {
  const at = new Date(Date.UTC(2026, 9, 24, 14, 2)).toISOString();
  const SELF = ["aria-bot"];
  const kevin: LineMessage = { id: "1", authorId: "kevin", authorName: "Kevin", at, body: "text" };
  const own: LineMessage = { ...kevin, id: "0", authorId: "aria-bot", authorName: "Aria", body: "hi" };
  const reply: LineMessage = { ...kevin, id: "2", replyToId: "1" };
  const replyToMe: LineMessage = { ...kevin, id: "3", replyToId: "0" };
  const refs = new Map([["1", "k3"], ["2", "k4"], ["3", "k5"], ["0", "a1"]]);
  const byId = new Map([kevin, own, reply, replyToMe].map((message) => [message.id, message]));
  const view = { refs, lookup: (id: string) => byId.get(id), selfAuthorIds: SELF, timeZone: "UTC" };

  it("renders `[14:02 #k3] Kevin: text`", () => {
    expect(entryLine(kevin, view)).toBe("[14:02 #k3] Kevin: text");
    expect(entryLine({ ...kevin, body: "" }, view)).toBe("[14:02 #k3] Kevin:");
    expect(entryLine({ ...kevin, id: "9", authorName: "" }, view)).toBe("[14:02] Unknown: text");
  });

  it("marks replies `↩#ref`, `↩you` and `↩Name`", () => {
    expect(entryHeader(reply, view)).toBe("[14:02 #k4 ↩#k3]");
    expect(entryHeader(replyToMe, view)).toBe("[14:02 #k5 ↩you]");
    const olderKevin: LineMessage = { ...kevin, id: "9", replyToId: "8" };
    const lookupOlder = (id: string) => (id === "8" ? { ...kevin, id: "8" } : byId.get(id));
    expect(entryHeader(olderKevin, { ...view, lookup: lookupOlder })).toBe("[14:02 ↩Kevin]");
    // A reply to something unknown and unreferenced shows no marker.
    expect(entryHeader({ ...kevin, id: "10", replyToId: "404" }, view)).toBe("[14:02]");
  });

  it("works on conversation cache messages, in the owner's time zone", () => {
    const raw: RawDiscordMessage = {
      id: "2",
      channelId: "c",
      authorId: "kevin",
      authorName: "Kevin",
      authorIsBot: false,
      createdAt: at,
      type: 19,
      content: "agreed",
      attachments: [],
      embeds: [],
      stickers: [],
      snapshots: [],
      referenceMessageId: "1",
      mentions: { users: {}, roles: {}, channels: {} }
    };
    const message = lineMessageOf(raw, EMPTY_GUILD_DIRECTORY, "UTC")!;
    expect(message).toEqual({ id: "2", authorId: "kevin", authorName: "Kevin", at, body: "agreed", replyToId: "1" });
    expect(entryLine(message, view)).toBe("[14:02 #k4 ↩#k3] Kevin: agreed");
    expect(entryHeader(message, { ...view, timeZone: "Europe/Berlin" })).toBe("[16:02 #k4 ↩#k3]");
  });
});
