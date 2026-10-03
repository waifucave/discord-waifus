import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { startDirectReadiness } from "../src/remote/gateway/directReadiness.js";
import type { HelperRemoteRequest } from "../src/remote/helperTypes.js";

describe("direct readiness", () => {
  const gatewayLaunchId = Buffer.alloc(32, 9).toString("base64url");
  const launch = () => ({ expiresAt: String(Math.floor(Date.now() / 1000) + 120),
    registerLaunch: vi.fn(async () => undefined), refreshStatus: vi.fn(async () => undefined) });

  it("probes before direct readiness, retries offline, pauses when direct, and resumes after path loss", async () => {
    let direct = false;
    let registered = false;
    const registration = launch();
    registration.registerLaunch.mockImplementation(async () => { registered = true; });
    const request = vi.fn(async (_input: HelperRemoteRequest) => {
      expect(registered).toBe(true);
      if (request.mock.calls.length === 1) throw new Error("offline");
      direct = true;
      return { statusCode: 200, headers: [], body: Readable.from([Buffer.from("{}")]), cancel: vi.fn() };
    });
    const monitor = startDirectReadiness({ ...registration, gatewayLaunchId, isDirect: () => direct, request });
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 4_000 });
      const [first, second] = request.mock.calls.map(([input]) => input);
      expect(first).toMatchObject({ method: "GET", canonicalTarget: "/api/health", browserContext: {
        gatewayLaunchId, method: "GET", canonicalTarget: "/api/health", csrfValidated: true
      } });
      expect(second.browserContext.requestNonce).not.toBe(first.browserContext.requestNonce);
      await delay(2_100);
      expect(request).toHaveBeenCalledTimes(2);
      direct = false;
      registered = false; // A cold helper restart forgets the current launch.
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      expect(registration.registerLaunch).toHaveBeenCalledTimes(3);
    } finally { await monitor.close(); }
    expect(request).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("aborts an outstanding probe on close without leaving a retry", async () => {
    const request = vi.fn((input: HelperRemoteRequest) => new Promise<never>((_resolve, reject) => {
      input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
    }));
    const monitor = startDirectReadiness({ ...launch(), gatewayLaunchId, isDirect: () => false, request });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(1);
    await monitor.close();
    expect(request.mock.calls[0][0].signal!.aborted).toBe(true);
  });

  it("cancels oversized health bodies and does not treat HTTP success as readiness", async () => {
    const cancel = vi.fn();
    const request = vi.fn(async () => ({ statusCode: 200, headers: [],
      body: Readable.from([Buffer.alloc(65 * 1024)]), cancel }));
    const monitor = startDirectReadiness({ ...launch(), gatewayLaunchId, isDirect: () => false, request });
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 4_000 });
      expect(cancel).toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(2);
    } finally { await monitor.close(); }
  });

  it("does not renew or use an expired gateway launch", async () => {
    const registerLaunch = vi.fn(async () => undefined);
    const request = vi.fn();
    const monitor = startDirectReadiness({ ...launch(), gatewayLaunchId, expiresAt: "1", registerLaunch,
      isDirect: () => false, request });
    await monitor.close();
    expect(registerLaunch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
