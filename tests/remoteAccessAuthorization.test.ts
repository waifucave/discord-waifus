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

function confirmedPrincipal(method: "POST" | "DELETE", canonicalTarget: string) {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(0x32),
    trustEpoch: "3",
    browserContext: {
      version: 1,
      gatewayLaunchId: bytes32(0x33),
      browserSessionId: bytes32(0x34),
      requestNonce: bytes16(0x35),
      method,
      canonicalTarget,
      csrfValidated: true
    }
  });
}

function fakeService(
  onCreateInvitation?: (actor: unknown, idempotencyKey: string) => void
) {
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
    cancelActivation: async () => {},
    createInvitation: async (actor: unknown, idempotencyKey: string) => {
      onCreateInvitation?.(actor, idempotencyKey);
      return {
        invitationId: bytes16(0x41),
        fullToken: `WF1.${Buffer.alloc(192).toString("base64url")}`,
        shortCode: "01AB-CDEF",
        expiresAt: "1786271130"
      };
    },
    cancelInvitation: async () => {},
    listPairingRequests: async () => ({ version: 1, requests: [] }),
    approvePairingRequest: async () => {},
    rejectPairingRequest: async () => {},
    listDevices: async () => ({ version: 1, devices: [] }),
    renameDevice: async (deviceId: string, input: { displayName: string }) => ({
      version: 1,
      deviceId,
      displayName: input.displayName,
      platform: { os: "darwin", arch: "arm64" },
      installationFingerprint: bytes16(0x42),
      trustEpoch: "3",
      revision: "2",
      pairedAt: "1786000000",
      lastSeenAt: "1786270800",
      connectionState: "direct"
    }),
    revokeDevice: async () => {}
  } as unknown as RemoteAccessService;
}

async function makeApp(
  authorized = true,
  remoteAccess = fakeService()
) {
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
    remoteAccess,
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

  it("exposes redacted pairing requests and trusted devices to a full admin", async () => {
    const app = await makeApp();
    for (const url of [
      "/api/remote-access/pairing-requests",
      "/api/remote-access/devices"
    ]) {
      const response = await dispatchInternal(app, principal(), undefined, {
        method: "GET",
        url
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"], url).toBe("no-store");
      expect(response.json(), url).toMatchObject({ version: 1 });
    }
  });

  it("requires a helper-verified browser context for trust expansion and revocation", async () => {
    const app = await makeApp();
    const invitePath = "/api/remote-access/invitations";
    const withoutBrowser = await dispatchInternal(app, principal(), undefined, {
      method: "POST",
      url: invitePath,
      headers: { "idempotency-key": bytes32(0x62) },
      payload: {}
    });
    expect(withoutBrowser.statusCode).toBe(403);
    expect(withoutBrowser.json()).toMatchObject({ error: "ConfirmedBrowserRequired" });

    const invite = await dispatchInternal(app, confirmedPrincipal("POST", invitePath), undefined, {
      method: "POST",
      url: invitePath,
      headers: { "idempotency-key": bytes32(0x63) },
      payload: {}
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.headers["cache-control"]).toContain("no-store");
    expect(invite.json()).toMatchObject({
      invitationId: bytes16(0x41),
      fullToken: `WF1.${Buffer.alloc(192).toString("base64url")}`,
      shortCode: "01AB-CDEF"
    });

    const revokePath = "/api/remote-access/devices/travel-mac";
    const revoked = await dispatchInternal(
      app,
      confirmedPrincipal("DELETE", revokePath),
      undefined,
      {
        method: "DELETE",
        url: revokePath,
        headers: { "idempotency-key": bytes32(0x64) }
      }
    );
    expect(revoked.statusCode).toBe(202);
    expect(revoked.json()).toMatchObject({ status: "accepted" });
  });

  it("recovers the same helper-held invitation with the same actor, session, key, and body", async () => {
    const calls: Array<{ actor: unknown; idempotencyKey: string }> = [];
    const app = await makeApp(true, fakeService((actor, idempotencyKey) => {
      calls.push({ actor, idempotencyKey });
    }));
    const path = "/api/remote-access/invitations";
    const key = bytes32(0x67);
    const request = {
      method: "POST" as const,
      url: path,
      headers: { "idempotency-key": key },
      payload: {}
    };

    const first = await dispatchInternal(
      app,
      confirmedPrincipal("POST", path),
      undefined,
      request
    );
    const recovered = await dispatchInternal(
      app,
      confirmedPrincipal("POST", path),
      undefined,
      request
    );

    expect(first.statusCode).toBe(201);
    expect(recovered.statusCode).toBe(201);
    expect(recovered.body).toBe(first.body);
    expect(recovered.headers["cache-control"]).toContain("no-store");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  });

  it("validates pairing approval and device rename bodies with strict shared schemas", async () => {
    const app = await makeApp();
    const requestId = bytes16(0x45);
    const approvalPath = `/api/remote-access/pairing-requests/${requestId}/approve`;
    const invalidApproval = await dispatchInternal(
      app,
      confirmedPrincipal("POST", approvalPath),
      undefined,
      {
        method: "POST",
        url: approvalPath,
        headers: { "idempotency-key": bytes32(0x65) },
        payload: { invitationGeneration: "1", sasFingerprint: "a1b2c3d4e5f6" }
      }
    );
    expect(invalidApproval.statusCode).toBe(400);
    expect(invalidApproval.json()).toMatchObject({ error: "ValidationError" });

    const renamed = await dispatchInternal(app, principal(), undefined, {
      method: "PUT",
      url: "/api/remote-access/devices/travel-mac",
      headers: { "idempotency-key": bytes32(0x66) },
      payload: { revision: "1", displayName: "Travel Laptop" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      deviceId: "travel-mac",
      displayName: "Travel Laptop",
      revision: "2"
    });
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
