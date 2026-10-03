import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNativeHelperState, assertSameIdentity, closeNativeHelper, nativeSmokeDiagnostic } from "../scripts/smoke-remote-helper.mjs";

afterEach(() => vi.useRealTimers());

function fixture() {
  const identity = { activationState: "activation_required", deviceId: "private-id",
    installationFingerprint: "private-fingerprint", secretStorage: "secret_service" };
  const snapshot = { state: "ready", target: { os: "linux", arch: "arm64" }, helperVersion: "0.1.2",
    lastErrorCode: null, restartScheduled: false,
    runtimeStatus: { activationState: "activation_required", controlState: "inactive", directState: "inactive" } };
  return { identity, snapshot, supervisor: { identityStatus: () => identity, snapshot: () => snapshot } };
}

describe("native release helper gate", () => {
  it("reports only fixed native diagnostic phases and states, never private values", () => {
    expect(nativeSmokeDiagnostic("first_start", { state: "degraded", lastErrorCode: "helper_unavailable" }))
      .toEqual({ phase: "first_start", state: "degraded", code: "helper_unavailable" });
    const report = nativeSmokeDiagnostic("private-path", { state: "private-id", lastErrorCode: "private-token", dataRoot: "private-path" });
    expect(report).toEqual({ phase: "unknown", state: "unknown", code: "unknown" });
  });
  it("accepts bounded intentional parent-close 70, while rejecting unrelated or forced exits", async () => {
    const supervisor = { close: async () => {}, snapshot: () => ({ state: "disabled", restartScheduled: false }) };
    const exit = { code: 70, signal: null, intentionalClose: true, closeElapsedMs: 1 };
    for (const code of [0, 70]) {
      await expect(closeNativeHelper(supervisor, { forced: false, closeRequestedAt: null, exited: Promise.resolve({ ...exit, code }) })).resolves.toBeUndefined();
    }
    for (const change of [
      { code: 1 }, { code: 64 }, { signal: "SIGTERM" }, { intentionalClose: false }, { closeElapsedMs: 5_001 }
    ]) {
      await expect(closeNativeHelper(supervisor, { forced: false, closeRequestedAt: null, exited: Promise.resolve({ ...exit, ...change }) })).rejects.toThrow();
    }
    await expect(closeNativeHelper(supervisor, { forced: true, closeRequestedAt: null, exited: Promise.resolve(exit) })).rejects.toThrow();
    await expect(closeNativeHelper({ ...supervisor, snapshot: () => ({ state: "disabled", restartScheduled: true }) },
      { forced: false, closeRequestedAt: null, exited: Promise.resolve(exit) })).rejects.toThrow();
  });

  it("fails within five seconds if parent close leaves a live helper", async () => {
    vi.useFakeTimers();
    const supervisor = { close: async () => {}, snapshot: () => ({ state: "disabled", restartScheduled: false }) };
    const closing = closeNativeHelper(supervisor, { forced: false, closeRequestedAt: null, exited: new Promise(() => {}) });
    const rejected = expect(closing).rejects.toThrow("Remote helper native smoke failed.");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires real native storage, ready target, exact version, and inactive network", () => {
    expect(assertNativeHelperState(fixture().supervisor, "linux", "arm64", "0.1.2").secretStorage).toBe("secret_service");
    for (const storage of ["protected_file_fallback", "unavailable", "keychain"]) {
      const test = fixture();
      test.identity.secretStorage = storage;
      expect(() => assertNativeHelperState(test.supervisor, "linux", "arm64", "0.1.2")).toThrow();
    }
    for (const change of [
      { state: "degraded" }, { target: { os: "linux", arch: "x64" } }, { helperVersion: "0.1.3" },
      { lastErrorCode: "helper_unavailable" }, { restartScheduled: true },
      { runtimeStatus: { activationState: "active", controlState: "connected", directState: "direct" } }
    ]) {
      const test = fixture();
      Object.assign(test.snapshot, change);
      expect(() => assertNativeHelperState(test.supervisor, "linux", "arm64", "0.1.2")).toThrow();
    }
  });

  it("fails cold restart if either installation or device identity changes", () => {
    const first = fixture().identity;
    expect(() => assertSameIdentity(first, { ...first })).not.toThrow();
    for (const key of ["deviceId", "installationFingerprint", "secretStorage"]) {
      expect(() => assertSameIdentity(first, { ...first, [key]: "changed" })).toThrow();
    }
  });

  it("rejects an architecture mismatch before import with a fixed sanitized error", () => {
    const result = spawnSync(process.execPath, ["scripts/smoke-remote-helper.mjs", "/secret-path/private-id", "invalid", "arm64"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Remote helper native smoke failed.\n");
  });
});
