import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import type { RemoteAccessService } from "../src/backend/remoteAccess/remoteAccessService.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function principal() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(0x32),
    trustEpoch: "3"
  });
}

function fakeService() {
  return {
    getStatus: async () => ({
      version: 1,
      config: { revision: "0", enabled: true, displayName: "Host", updatedAt: "1786270800" },
      identity: { deviceId: "host-device-01", installationFingerprint: bytes16(0x41) },
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      helperVersion: "0.1.0",
      helperReleaseSequence: "42",
      protocol: { major: 1, minor: 0 },
      capabilities: [],
      helperState: "ready",
      activationState: "active",
      controlState: "connected",
      directState: "inactive",
      lastDirectAt: null,
      lastErrorCode: null
    }),
    diagnostics: async () => ({
      version: 1,
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      helper: {
        state: "ready",
        version: "0.1.0",
        releaseSequence: "42",
        forkCommit: "0123456789abcdef0123456789abcdef01234567",
        target: { os: "darwin", arch: "arm64" },
        protocol: { major: 1, minor: 0 },
        capabilities: [],
        secretStorage: "keychain"
      },
      controlState: "connected",
      stun: "unknown",
      udp: "unknown",
      portMapping: "unknown",
      directState: "inactive",
      lastTransitionAt: null,
      lastDirectAt: null,
      lastErrorCode: null,
      prohibited: {
        derpRouteSelections: "0",
        derpApplicationBytes: "0",
        peerRelayRouteSelections: "0",
        peerRelayApplicationBytes: "0",
        genericProxyRequests: "0",
        genericProxyBytes: "0"
      }
    }),
    updateConfig: async (input: { revision: string; displayName?: string; enabled?: boolean }) => ({
      revision: "1",
      enabled: input.enabled ?? true,
      displayName: input.displayName ?? "Host",
      updatedAt: "1786270801"
    }),
    reconnect: async () => {},
    beginActivation: async () => ({
      activationOperationId: bytes32(0x51),
      verificationUrl: `https://pair.waifucave.com/activate#${bytes32(0x52)}`,
      expiresAt: "1786271400"
    }),
    getActivation: async () => ({
      activationOperationId: bytes32(0x51),
      state: "pending",
      expiresAt: "1786271400"
    }),
    cancelActivation: async () => {}
  } as unknown as RemoteAccessService;
}

async function makeApp(authorized = true) {
  const root = await makeTempRoot("waifus-remote-authorization-");
  roots.push(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date(1_786_270_800_000).toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    remoteTrust: { isAuthorized: () => authorized },
    remoteAccess: fakeService(),
    browserSecurity: { listenerHost: "127.0.0.1", port: 3888, mode: "test" }
  });
  apps.push(app);
  return app;
}

describe("remote-access route authorization", () => {
  it.each([
    ["/api/remote-access", "GET"],
    ["/api/remote-access/diagnostics", "GET"]
  ] as const)("allows a current trusted full-admin principal to read %s", async (url, method) => {
    const app = await makeApp();
    const response = await dispatchInternal(app, principal(), undefined, { method, url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("allows trusted remote lifecycle mutations only with a canonical idempotency key", async () => {
    const app = await makeApp();
    const missing = await dispatchInternal(app, principal(), undefined, {
      method: "POST",
      url: "/api/remote-access/reconnect"
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ error: "IdempotencyKeyRequired" });

    const accepted = await dispatchInternal(app, principal(), undefined, {
      method: "POST",
      url: "/api/remote-access/reconnect",
      headers: { "idempotency-key": bytes32(0x61) }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ status: "accepted" });
  });

  it("keeps activation local-only and requires a real bound browser session", async () => {
    const app = await makeApp();
    const remote = await dispatchInternal(app, principal(), undefined, {
      method: "POST",
      url: "/api/remote-access/activation"
    });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toMatchObject({ error: "RemoteRouteForbidden" });

    const localAutomation = await app.inject({
      method: "POST",
      url: "/api/remote-access/activation"
    });
    expect(localAutomation.statusCode).toBe(403);
    expect(localAutomation.json()).toMatchObject({ error: "LocalBrowserRequired" });

    const forged = await app.inject({
      method: "POST",
      url: "/api/remote-access/activation",
      headers: { "x-waifus-browser-context": bytes32(0x71) }
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: "BadRequest" });
  });

  it("rejects a stale remote principal before every management handler", async () => {
    const app = await makeApp(false);
    for (const request of [
      { method: "GET" as const, url: "/api/remote-access" },
      { method: "GET" as const, url: "/api/remote-access/diagnostics" },
      {
        method: "PUT" as const,
        url: "/api/remote-access",
        headers: { "idempotency-key": bytes32(0x72) },
        payload: { revision: "0", displayName: "Blocked" }
      }
    ]) {
      const response = await dispatchInternal(app, principal(), undefined, request);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "RemotePrincipalUnauthorized" });
    }
  });

  it("rejects unknown remote-access update fields through the strict shared schema", async () => {
    const app = await makeApp();
    const response = await dispatchInternal(app, principal(), undefined, {
      method: "PUT",
      url: "/api/remote-access",
      headers: { "idempotency-key": bytes32(0x73) },
      payload: { revision: "0", displayName: "Host", frontendStaticDir: "/tmp/other" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "ValidationError" });
  });
});
