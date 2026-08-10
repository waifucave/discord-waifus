import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import {
  canonicalMutationBodyBytes,
  canonicalMutationTarget
} from "../src/api/mutations.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { AuditStore } from "../src/storage/auditStore.js";
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

function remote(deviceId = "travel-mac", trustEpoch = "7") {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: bytes16(0x21),
    transportSessionId: bytes16(0x22),
    trustEpoch
  });
}

function sequentialRandom(): (size: number) => Uint8Array {
  let counter = 1;
  return (size) => {
    const result = Buffer.alloc(size);
    result.writeUInt32BE(counter, size - 4);
    counter += 1;
    return result;
  };
}

async function makeApp() {
  const root = await makeTempRoot("waifus-mutation-policy-");
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const randomBytes = sequentialRandom();
  const operationStore = new OperationStore(root, { storage, randomBytes });
  const auditStore = new AuditStore(root, { storage });
  const calls = { pause: 0, resume: 0, reload: 0 };
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    storage,
    runtime,
    runtimeControl: {
      getOrchestrator: () => undefined,
      pause: async () => { calls.pause += 1; },
      resume: async () => { calls.resume += 1; },
      reload: async () => { calls.reload += 1; }
    },
    remoteTrust: { isAuthorized: () => true },
    administration: { operationStore, auditStore, randomBytes }
  });
  apps.push(app);
  return { app, auditStore, calls, operationStore, root };
}

describe("administrative mutation policy", () => {
  it("requires a canonical remote idempotency key and audits rejected attempts before effects", async () => {
    const { app, auditStore, calls } = await makeApp();
    const missing = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/pause"
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ error: "IdempotencyKeyRequired" });

    const invalid = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/pause",
      headers: { "idempotency-key": "not-canonical" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "IdempotencyKeyInvalid" });
    expect(calls.pause).toBe(0);
    expect((await auditStore.list()).map((entry) => entry.outcome)).toEqual([
      "rejected",
      "rejected"
    ]);
  });

  it("replays the exact response for the same canonical JSON and rejects key reuse with a changed body", async () => {
    const { app, auditStore, calls } = await makeApp();
    const key = bytes32(0x31);
    const first = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/config",
      headers: { "idempotency-key": key },
      payload: { runtime: { paused: true }, ocr: { enabled: false } }
    });
    expect(first.statusCode).toBe(200);
    expect(Buffer.from(String(first.headers["x-waifus-request-id"]), "base64url")).toHaveLength(16);

    const replay = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/config",
      headers: { "idempotency-key": key },
      payload: { ocr: { enabled: false }, runtime: { paused: true } }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(replay.headers["x-waifus-request-id"]).toBe(first.headers["x-waifus-request-id"]);
    expect(calls.reload).toBe(1);

    const conflict = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/config",
      headers: { "idempotency-key": key },
      payload: { runtime: { paused: false }, ocr: { enabled: false } }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "IdempotencyConflict" });
    expect(calls.reload).toBe(1);
    expect((await auditStore.list()).map((entry) => entry.outcome)).toEqual([
      "accepted",
      "reconciled",
      "conflict"
    ]);
  });

  it("uses the concrete method/target as part of identity and canonicalizes semantic query order", async () => {
    const { app, calls } = await makeApp();
    const key = bytes32(0x41);
    const pause = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/pause",
      headers: { "idempotency-key": key }
    });
    const resume = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/resume",
      headers: { "idempotency-key": key }
    });
    expect(pause.statusCode).toBe(200);
    expect(resume.statusCode).toBe(200);
    expect(calls).toMatchObject({ pause: 1, resume: 1 });
    expect(canonicalMutationTarget("/api/example?z=3&a=2&a=1")).toBe(
      "/api/example?a=2&a=1&z=3"
    );
    expect(canonicalMutationBodyBytes({ z: 1, a: 2 })).toEqual(
      canonicalMutationBodyBytes({ a: 2, z: 1 })
    );
  });

  it("streams raw mutation hashing and never reruns a replayed binary upload", async () => {
    const { app, root } = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/waifus",
      payload: { id: "yuki", name: "Yuki", displayName: "Yuki" }
    });
    expect(created.statusCode).toBe(201);
    const key = bytes32(0x49);
    const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    const first = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/waifus/yuki/assets/pfp",
      headers: {
        "content-type": "image/png",
        "idempotency-key": key
      },
      payload: firstBytes
    });
    expect(first.statusCode).toBe(201);

    const replay = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/waifus/yuki/assets/pfp",
      headers: {
        "content-type": "image/png",
        "idempotency-key": key
      },
      payload: Buffer.from(firstBytes)
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);

    const changed = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/waifus/yuki/assets/pfp",
      headers: {
        "content-type": "image/png",
        "idempotency-key": key
      },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02])
    });
    expect(changed.statusCode).toBe(409);
    const changedMediaType = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/waifus/yuki/assets/pfp",
      headers: {
        "content-type": "image/jpeg",
        "idempotency-key": key
      },
      payload: Buffer.from(firstBytes)
    });
    expect(changedMediaType.statusCode).toBe(409);
    expect(await readFile(path.join(root, "user", "waifus", "yuki", "pfp.png"))).toEqual(firstBytes);
  });

  it("includes conditional mutation headers in the request fingerprint", async () => {
    const { app, auditStore } = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/waifus",
      payload: { id: "miku", name: "Miku", displayName: "Miku" }
    });
    expect(created.statusCode).toBe(201);
    const key = bytes32(0x4a);
    const first = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/waifus/miku",
      headers: { "idempotency-key": key, "if-match": "\"0\"" },
      payload: { displayName: "Miku!" }
    });
    expect(first.statusCode).toBe(200);

    const replay = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/waifus/miku",
      headers: { "idempotency-key": key, "if-match": "W/\"0\"" },
      payload: { displayName: "Miku!" }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);

    const changedCondition = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/waifus/miku",
      headers: { "idempotency-key": key, "if-match": "\"1\"" },
      payload: { displayName: "Miku!" }
    });
    expect(changedCondition.statusCode).toBe(409);
    expect(changedCondition.json()).toMatchObject({ error: "IdempotencyConflict" });
    const updates = (await auditStore.list()).filter((entry) => entry.action === "waifu.update");
    expect(updates.slice(0, 2)).toMatchObject([
      { outcome: "accepted", beforeRevision: "0" },
      { outcome: "completed", beforeRevision: "0", afterRevision: "1" }
    ]);
    expect(updates.at(-1)).toMatchObject({ outcome: "conflict", beforeRevision: "1" });
  });

  it("returns the strict addressable 202 DTO while an identical operation is already prepared", async () => {
    const { app, operationStore, calls } = await makeApp();
    const key = bytes32(0x51);
    const prepared = await operationStore.reserve({
      actor: {
        kind: "remote_device",
        stableId: "remote:travel-mac",
        deviceId: "travel-mac",
        trustEpoch: "7"
      },
      retryClass: "reconciled",
      method: "POST",
      canonicalTarget: "/api/runtime/pause",
      idempotencyKey: key,
      bodyBytes: canonicalMutationBodyBytes(undefined)
    });
    const response = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/pause",
      headers: { "idempotency-key": key }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      operationId: prepared.operationId,
      status: "accepted",
      statusUrl: `/api/admin/operations/${prepared.operationId}`
    });
    expect(calls.pause).toBe(0);
    const status = await dispatchInternal(app, remote(), undefined, {
      method: "GET",
      url: `/api/admin/operations/${prepared.operationId}`
    });
    expect(status.json()).toMatchObject({ status: "prepared" });
  });

  it("records an unknown outcome instead of repeating an effect when terminal durability fails", async () => {
    const { app, operationStore, auditStore, calls } = await makeApp();
    operationStore.complete = async () => {
      throw new Error("simulated completion write failure");
    };
    const key = bytes32(0x59);
    const response = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/reload",
      headers: { "idempotency-key": key }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "MutationDurabilityFailure" });
    expect(calls.reload).toBe(1);

    const retry = await dispatchInternal(app, remote(), undefined, {
      method: "POST",
      url: "/api/runtime/reload",
      headers: { "idempotency-key": key }
    });
    expect(retry.statusCode).toBe(202);
    expect(calls.reload).toBe(1);
    const status = await dispatchInternal(app, remote(), undefined, {
      method: "GET",
      url: retry.json().statusUrl
    });
    expect(status.json()).toMatchObject({
      status: "outcome_unknown",
      errorCode: "outcome_unknown"
    });
    expect((await auditStore.list()).map((entry) => entry.outcome)).toEqual([
      "accepted",
      "reconciled",
      "unknown"
    ]);
  });

  it("keeps local callers backward compatible while assigning request IDs and audit receipts", async () => {
    const { app, auditStore, calls } = await makeApp();
    const response = await app.inject({ method: "POST", url: "/api/runtime/reload" });
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(String(response.headers["x-waifus-request-id"]), "base64url")).toHaveLength(16);
    expect(calls.reload).toBe(1);
    const audit = await auditStore.list();
    expect(audit.map((entry) => entry.outcome)).toEqual(["accepted", "reconciled"]);
    expect(audit.every((entry) => entry.actor.kind === "local")).toBe(true);
    expect(audit.every((entry) => entry.idempotencyKeyHash !== undefined)).toBe(true);
  });

  it("layers assistant delegation onto the initiating remote actor", async () => {
    const { app, auditStore } = await makeApp();
    const response = await dispatchInternal(
      app,
      remote(),
      {
        conversationId: "conversation-1",
        toolCallId: "tool-1",
        pendingActionId: "action-1"
      },
      {
        method: "POST",
        url: "/api/runtime/reload",
        headers: { "idempotency-key": bytes32(0x61) }
      }
    );
    expect(response.statusCode).toBe(200);
    const records = await auditStore.list();
    expect(records).toHaveLength(2);
    expect(records.every((entry) => entry.actor.kind === "remote_device")).toBe(true);
    expect(records.every((entry) => entry.actor.stableId === "remote:travel-mac")).toBe(true);
    expect(records.every((entry) => entry.delegation?.conversationId === "conversation-1")).toBe(true);
    expect(records.every((entry) => entry.delegation?.toolCallId === "tool-1")).toBe(true);
    expect(records.every((entry) => entry.delegation?.pendingActionId === "action-1")).toBe(true);
  });

  it("classifies every unsafe route and gateway semantic mutation with retry and audit metadata", () => {
    for (const definition of ROUTE_POLICY_MANIFEST) {
      if (definition.synthetic || definition.method === "GET") continue;
      if (definition.method === "*") {
        expect(definition.gatewaySemanticRoutes?.length).toBeGreaterThan(0);
        for (const semantic of definition.gatewaySemanticRoutes ?? []) {
          if (semantic.retryClass === "safe") continue;
          expect(semantic.auditAction, `${semantic.method} ${semantic.path}`).toBeTruthy();
        }
        continue;
      }
      expect(definition.retryClass, `${definition.method} ${definition.path}`).toBeTruthy();
      expect(definition.auditAction, `${definition.method} ${definition.path}`).toBeTruthy();
    }
  });
});
