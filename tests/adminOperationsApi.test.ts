import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import type { AuditActorV1 } from "../src/shared/schemas/adminOperations.js";
import { OperationStore } from "../src/storage/operationStore.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
  await Promise.all(roots.map(removeTempRoot));
  roots.length = 0;
});

function principal(deviceId = "travel-mac", trustEpoch = "5") {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: bytes16(0x21),
    transportSessionId: bytes16(0x22),
    trustEpoch
  });
}

function auditActor(deviceId = "travel-mac", trustEpoch = "5"): AuditActorV1 {
  return {
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    trustEpoch
  };
}

async function makeApp(now: () => bigint, operationStore: OperationStore, storage: StorageService) {
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: storage.dataRoot,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: storage.dataRoot,
    storage,
    runtime,
    remoteTrust: { isAuthorized: () => true },
    administration: { operationStore, now }
  });
  apps.push(app);
  return app;
}

describe("GET /api/admin/operations/:operationId", () => {
  it("returns the exact no-store status only to the owner epoch or a local principal", async () => {
    let now = 1_000n;
    const root = await makeTempRoot("waifus-admin-operation-api-");
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const operationStore = new OperationStore(root, {
      storage,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 0x31)
    });
    const created = await operationStore.reserve({
      actor: auditActor(),
      retryClass: "reconciled",
      method: "POST",
      canonicalTarget: "/api/runtime/pause",
      idempotencyKey: bytes32(0x32),
      bodyBytes: Buffer.from("none\0", "utf8")
    });
    now += 1n;
    const expected = await operationStore.complete(created.operationId, {
      outcome: "succeeded",
      reconciled: true,
      response: {
        statusCode: 200,
        body: JSON.stringify({ accepted: true, token: "must-not-appear" })
      }
    });
    const app = await makeApp(() => now, operationStore, storage);
    const url = `/api/admin/operations/${created.operationId}`;

    const owner = await dispatchInternal(app, principal(), undefined, { method: "GET", url });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["cache-control"]).toBe("no-store");
    expect(owner.json()).toEqual(expected);
    expect(Object.keys(owner.json()).sort()).toEqual([
      "completedAt",
      "createdAt",
      "expiresAt",
      "operationId",
      "outcome",
      "status",
      "statusUrl",
      "updatedAt",
      "version"
    ]);
    expect(owner.body).not.toContain("token");

    const local = await app.inject({ method: "GET", url });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toEqual(expected);
  });

  it("makes wrong-device, stale-epoch, random, malformed, and expired IDs indistinguishable", async () => {
    let now = 2_000n;
    const root = await makeTempRoot("waifus-admin-operation-404-");
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const operationStore = new OperationStore(root, {
      storage,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 0x41)
    });
    const created = await operationStore.reserve({
      actor: auditActor(),
      retryClass: "transactional",
      method: "PUT",
      canonicalTarget: "/api/config",
      idempotencyKey: bytes32(0x42),
      bodyBytes: Buffer.from("{}", "utf8")
    });
    await operationStore.complete(created.operationId, { outcome: "succeeded" });
    const app = await makeApp(() => now, operationStore, storage);
    const ownerUrl = `/api/admin/operations/${created.operationId}`;

    const hidden = await Promise.all([
      dispatchInternal(app, principal("other-mac"), undefined, { method: "GET", url: ownerUrl }),
      dispatchInternal(app, principal("travel-mac", "6"), undefined, { method: "GET", url: ownerUrl }),
      dispatchInternal(app, principal(), undefined, {
        method: "GET",
        url: `/api/admin/operations/${bytes32(0x77)}`
      }),
      dispatchInternal(app, principal(), undefined, {
        method: "GET",
        url: "/api/admin/operations/not-an-operation-id"
      })
    ]);
    for (const response of hidden) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        error: "NotFound",
        message: "Operation was not found."
      });
    }

    now += 86_400n;
    const expired = await dispatchInternal(app, principal(), undefined, {
      method: "GET",
      url: ownerUrl
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toEqual(hidden[0].json());
  });
});
