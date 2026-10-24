import { describe, expect, it } from "vitest";
import { assignRefsTo, encodeRef, pruneRefs, REF_COUNTER_START } from "../src/discord/refStore.js";
import {
  dayKey,
  formatClock,
  formatDayLabel,
  formatDiscordTimestamp,
  formatFullDate,
  formatGapLabel,
  transitionMarker
} from "../src/orchestration/context/timeFormat.js";
import { ConversationRefsSchema } from "../src/shared/schemas/context.js";

const refsFile = () =>
  ConversationRefsSchema.parse({ schemaVersion: 2, revision: 0, updatedAt: "2026-10-24T00:00:00.000Z", conversationKey: "g_1_2" });

describe("timeFormat", () => {
  it("formats 24-hour clocks in the given zone", () => {
    expect(formatClock("2026-10-24T14:02:59.000Z", "UTC")).toBe("14:02");
    expect(formatClock("2026-10-24T00:05:00.000Z", "UTC")).toBe("00:05");
    expect(formatClock("2026-10-24T14:02:00.000Z", "America/New_York")).toBe("10:02");
    expect(formatClock("2026-10-24T14:02:00.000Z", "Asia/Tokyo")).toBe("23:02");
  });

  it("formats day labels and keys in the given zone", () => {
    expect(formatDayLabel("2026-10-24T14:00:00.000Z", "UTC")).toBe("Sat 24 Oct");
    expect(formatFullDate("2026-10-24T14:00:00.000Z", "UTC")).toBe("Sat 24 Oct 2026");
    expect(dayKey("2026-10-24T23:30:00.000Z", "UTC")).toBe("2026-10-24");
    expect(dayKey("2026-10-24T23:30:00.000Z", "Asia/Tokyo")).toBe("2026-10-25");
  });

  it.each([
    [29 * 60_000, undefined],
    [30 * 60_000, "30 minutes later"],
    [59 * 60_000, "59 minutes later"],
    [60 * 60_000, "1 hour later"],
    [3 * 3_600_000 + 59 * 60_000, "3 hours later"],
    [24 * 3_600_000, "1 day later"],
    [50 * 3_600_000, "2 days later"]
  ])("gap of %d ms → %s", (ms, label) => {
    expect(formatGapLabel(ms)).toBe(label);
  });

  it("builds transition markers: first entry day, gaps, day changes", () => {
    expect(transitionMarker(undefined, "2026-10-24T14:00:00.000Z", "UTC")).toBe("— Sat 24 Oct —");
    expect(transitionMarker("2026-10-24T14:00:00.000Z", "2026-10-24T14:10:00.000Z", "UTC")).toBeUndefined();
    expect(transitionMarker("2026-10-24T14:00:00.000Z", "2026-10-24T17:00:00.000Z", "UTC")).toBe("— 3 hours later —");
    expect(transitionMarker("2026-10-24T23:50:00.000Z", "2026-10-25T00:05:00.000Z", "UTC")).toBe("— Sun 25 Oct —");
    expect(transitionMarker("2026-10-24T20:00:00.000Z", "2026-10-25T09:00:00.000Z", "UTC")).toBe(
      "— 13 hours later · Sun 25 Oct —"
    );
    // A late arrival (earlier timestamp) never produces a marker.
    expect(transitionMarker("2026-10-25T09:00:00.000Z", "2026-10-24T09:00:00.000Z", "UTC")).toBeUndefined();
  });

  it("renders Discord timestamps absolutely, never relative", () => {
    const unix = Date.parse("2026-10-24T14:02:00.000Z") / 1000;
    expect(formatDiscordTimestamp(unix, "t", "UTC")).toBe("14:02");
    expect(formatDiscordTimestamp(unix, "D", "UTC")).toBe("Sat 24 Oct 2026");
    expect(formatDiscordTimestamp(unix, "R", "UTC")).toBe("Sat 24 Oct 2026 14:02");
    expect(formatDiscordTimestamp(unix, undefined, "UTC")).toBe("Sat 24 Oct 2026 14:02");
  });
});

describe("refs", () => {
  it("encodes base-36 starting at a0", () => {
    expect(REF_COUNTER_START).toBe(360);
    expect(encodeRef(360)).toBe("a0");
    expect(encodeRef(361)).toBe("a1");
    expect(encodeRef(395)).toBe("az");
    expect(encodeRef(396)).toBe("b0");
    expect(encodeRef(1295)).toBe("zz");
    expect(encodeRef(1296)).toBe("100");
  });

  it("assigns refs in the given order, once, never reusing a counter", () => {
    const first = assignRefsTo(refsFile(), ["m1", "m2"])!;
    expect(first.refs).toEqual({ m1: "a0", m2: "a1" });
    expect(first.counter).toBe(362);
    expect(assignRefsTo(first, ["m1", "m2"])).toBeUndefined();
    const second = assignRefsTo(first, ["m2", "m3", "m3"])!;
    expect(second.refs).toEqual({ m1: "a0", m2: "a1", m3: "a2" });
    const pruned = pruneRefs(second, ["m1", "m2"])!;
    expect(pruned.refs).toEqual({ m3: "a2" });
    expect(pruned.counter).toBe(363);
    expect(assignRefsTo(pruned, ["m4"])!.refs.m4).toBe("a3");
    expect(pruneRefs(pruned, ["m1", "m2"])).toBeUndefined();
  });
});
