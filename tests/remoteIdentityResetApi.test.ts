import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import type { RemoteAccessService } from "../src/backend/remoteAccess/remoteAccessService.js";
import { IdentityResetSiblingDaemonRunningError } from "../src/backend/remoteAccess/identityResetState.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function browserHeaders() {
  return {
    host: "127.0.0.1:3888",
    origin: "http://127.0.0.1:3888",
    "sec-fetch-site": "same-origin"
  };
}

async function makeHarness(remoteAccess: RemoteAccessService) {
  const root = await makeTempRoot("waifus-identity-reset-api-");
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: "2026-08-06T00:00:00.000Z",
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
    browserSecurity: { listenerHost: "127.0.0.1", port: 3888, mode: "test" },
    remoteTrust: { isAuthorized: () => true },
    remoteAccess
  });
  apps.push(app);
  const session = await app.inject({
    method: "GET",
    url: "/api/client-context",
    headers: browserHeaders()
  });
  return {
    app,
    root,
    headers: {
      ...browserHeaders(),
      cookie: String(session.headers["set-cookie"]),
      "x-waifus-csrf": String(session.headers["x-waifus-csrf"])
    }
  };
}

function remotePrincipal() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(0x32),
    trustEpoch: "7"
  });
}

describe("local-only identity reset API", () => {
  it("returns SiblingDaemonRunning before reserving an operation or audit entry", async () => {
    const assertNoLiveRemoteSibling = vi.fn(async () => {
      throw new IdentityResetSiblingDaemonRunningError();
    });
    const resetIdentity = vi.fn();
    const harness = await makeHarness({
      assertNoLiveRemoteSibling,
      resetIdentity
    } as unknown as RemoteAccessService);
    const paths = remoteStatePaths(harness.root);
    const beforeOperations = await readdir(paths.operationsRoot);
    const beforeAudit = await readdir(paths.auditRoot);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/remote-access/reset",
      headers: harness.headers,
      payload: { confirmation: "RESET REMOTE ACCESS" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "SiblingDaemonRunning",
      message: "A remote gateway for this data root is still running."
    });
    expect(assertNoLiveRemoteSibling).toHaveBeenCalledTimes(1);
    expect(resetIdentity).not.toHaveBeenCalled();
    expect(await readdir(paths.operationsRoot)).toEqual(beforeOperations);
    expect(await readdir(paths.auditRoot)).toEqual(beforeAudit);
  });

  it("accepts the exact typed local confirmation and never grants the route to a remote", async () => {
    const assertNoLiveRemoteSibling = vi.fn(async () => undefined);
    const resetIdentity = vi.fn(async () => undefined);
    const harness = await makeHarness({
      assertNoLiveRemoteSibling,
      resetIdentity
    } as unknown as RemoteAccessService);

    const local = await harness.app.inject({
      method: "POST",
      url: "/api/remote-access/reset",
      headers: harness.headers,
      payload: { confirmation: "RESET REMOTE ACCESS" }
    });
    expect(local.statusCode).toBe(202);
    expect(local.json()).toMatchObject({
      status: "accepted",
      statusUrl: expect.stringMatching(/^\/api\/admin\/operations\/[A-Za-z0-9_-]{43}$/u)
    });
    expect(resetIdentity).toHaveBeenCalledTimes(1);

    const remote = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "POST",
      url: "/api/remote-access/reset",
      headers: { "idempotency-key": Buffer.alloc(32, 0x71).toString("base64url") },
      payload: { confirmation: "RESET REMOTE ACCESS" }
    });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toMatchObject({ error: "RemoteRouteForbidden" });
    expect(resetIdentity).toHaveBeenCalledTimes(1);
  });
});
