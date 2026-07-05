import { describe, expect, it } from "vitest";
import { isPermissionError, PermissionWarningTracker } from "../src/orchestration/permissionWarnings.js";

describe("isPermissionError", () => {
  it("matches discord.js permission error codes", () => {
    expect(isPermissionError(Object.assign(new Error("Missing Access"), { code: 50001 }))).toBe(true);
    expect(isPermissionError(Object.assign(new Error("Missing Permissions"), { code: 50013 }))).toBe(true);
  });

  it("matches by message when the code is lost through wrapping", () => {
    expect(isPermissionError(new Error("Missing Permissions"))).toBe(true);
    expect(isPermissionError(new Error("Missing Access"))).toBe(true);
    expect(isPermissionError(new Error("deepseek returned HTTP 400"))).toBe(false);
  });
});

describe("PermissionWarningTracker", () => {
  it("records a warning per channel and clears it on a later success", () => {
    const tracker = new PermissionWarningTracker();
    tracker.record("g1", "c1", "riko", new Error("Missing Access"));
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]).toContain("riko");
    expect(tracker.list()[0]).toContain("c1");
    expect(tracker.list()[0].toLowerCase()).toContain("permission");

    tracker.resolve("g1", "c1");
    expect(tracker.list()).toHaveLength(0);
  });

  it("keeps one warning per channel (latest wins) and separates channels", () => {
    const tracker = new PermissionWarningTracker();
    tracker.record("g1", "c1", "riko", new Error("Missing Access"));
    tracker.record("g1", "c1", "aria", new Error("Missing Permissions"));
    tracker.record("g1", "c2", "lumi", new Error("Missing Access"));
    expect(tracker.list()).toHaveLength(2);
    expect(tracker.list().find((w) => w.includes("c1"))).toContain("aria");
  });

  it("ignores non-permission errors", () => {
    const tracker = new PermissionWarningTracker();
    tracker.record("g1", "c1", "riko", new Error("model exploded"));
    expect(tracker.list()).toHaveLength(0);
  });
});
