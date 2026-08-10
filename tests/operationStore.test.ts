import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETED_OPERATION_RETENTION_SECONDS,
  UNRESOLVED_OPERATION_RETENTION_SECONDS,
  type AuditActorV1
} from "../src/shared/schemas/adminOperations.js";
import { StorageValidationError } from "../src/storage/errors.js";
import {
  OperationIdempotencyConflictError,
  OperationStore,
  OperationStoreCapacityError
} from "../src/storage/operationStore.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");
const localActor: AuditActorV1 = { kind: "local", stableId: "local" };

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots.length = 0;
});

function remoteActor(deviceId = "travel-mac", trustEpoch = "7"): AuditActorV1 {
  return {
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    trustEpoch
  };
}

function sequentialRandom(start = 1): (size: number) => Uint8Array {
  let value = start;
  return (size) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(value, size - 4);
    value += 1;
    return bytes;
  };
}

function intent(overrides: Partial<Parameters<OperationStore["reserve"]>[0]> = {}) {
  return {
    actor: localActor,
    retryClass: "transactional" as const,
    method: "PUT",
    canonicalTarget: "/api/waifus/yuki",
    idempotencyKey: bytes32(0x11),
    bodyBytes: Buffer.from('{"enabled":true}', "utf8"),
    ...overrides
  };
}

async function makeStore(options: ConstructorParameters<typeof OperationStore>[1] = {}) {
  const root = await makeTempRoot("waifus-operation-store-");
  roots.push(root);
  return {
    root,
    store: new OperationStore(root, {
      randomBytes: sequentialRandom(),
      ...options
    })
  };
}

describe("OperationStore", () => {
  it("reserves before execution and replays the same completed target/body without storing plaintext intent", async () => {
    const { store } = await makeStore();
    const created = await store.reserve(intent());
    expect(created.kind).toBe("created");
    expect(created.status.status).toBe("prepared");

    const inFlight = await store.reserve(intent());
    expect(inFlight).toMatchObject({
      kind: "pending",
      operationId: created.operationId
    });

    await store.complete(created.operationId, {
      outcome: "succeeded",
      response: {
        statusCode: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true, apiKey: "sk-this-value-must-not-survive" })
      }
    });
    const replay = await store.reserve(intent());
    expect(replay).toMatchObject({
      kind: "replay",
      operationId: created.operationId,
      response: {
        statusCode: 200,
        encoding: "utf8",
        body: JSON.stringify({ ok: true, apiKey: "[REDACTED]" })
      }
    });

    const disk = await readFile(store.filePath, "utf8");
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect(disk).not.toContain("/api/waifus/yuki");
    expect(disk).not.toContain(bytes32(0x11));
    expect(disk).not.toContain("sk-this-value-must-not-survive");
  });

  it("conflicts on a changed body but treats a different concrete target as an independent identity", async () => {
    const { store } = await makeStore();
    const first = await store.reserve(intent());
    await expect(store.reserve(intent({
      bodyBytes: Buffer.from('{"enabled":false}', "utf8")
    }))).rejects.toMatchObject<Partial<OperationIdempotencyConflictError>>({
      operationId: first.operationId
    });

    const otherTarget = await store.reserve(intent({
      canonicalTarget: "/api/waifus/miku"
    }));
    expect(otherTarget.kind).toBe("created");
    expect(otherTarget.operationId).not.toBe(first.operationId);

    const otherQuery = await store.reserve(intent({
      canonicalTarget: "/api/waifus/yuki?mode=force"
    }));
    expect(otherQuery.kind).toBe("created");
    expect(otherQuery.operationId).not.toBe(first.operationId);
  });

  it("isolates lookup and status visibility by actor and exact trust epoch", async () => {
    const { store } = await makeStore();
    const owner = remoteActor();
    const created = await store.reserve(intent({ actor: owner }));
    await store.complete(created.operationId, { outcome: "succeeded" });

    expect(await store.getVisible(created.operationId, owner)).toMatchObject({
      operationId: created.operationId,
      status: "completed"
    });
    expect(await store.getVisible(created.operationId, localActor)).toBeDefined();
    expect(await store.getVisible(created.operationId, remoteActor("other-mac"))).toBeUndefined();
    expect(await store.getVisible(created.operationId, remoteActor("travel-mac", "8"))).toBeUndefined();

    const otherActorReservation = await store.reserve(intent({ actor: remoteActor("other-mac") }));
    expect(otherActorReservation.kind).toBe("created");
    expect(otherActorReservation.operationId).not.toBe(created.operationId);
  });

  it("turns a prepared receipt found after restart into a durable unknown outcome", async () => {
    let now = 10_000n;
    const { root, store } = await makeStore({ now: () => now });
    const created = await store.reserve(intent({ actor: remoteActor() }));

    now += 10n;
    const restarted = new OperationStore(root, {
      now: () => now,
      randomBytes: sequentialRandom(100)
    });
    const status = await restarted.getVisible(created.operationId, remoteActor());
    expect(status).toEqual({
      version: 1,
      operationId: created.operationId,
      statusUrl: `/api/admin/operations/${created.operationId}`,
      status: "outcome_unknown",
      createdAt: "10000",
      updatedAt: "10010",
      expiresAt: (now + UNRESOLVED_OPERATION_RETENTION_SECONDS).toString(),
      determinedAt: "10010",
      errorCode: "outcome_unknown"
    });
    expect((await restarted.reserve(intent({ actor: remoteActor() }))).kind).toBe("pending");
  });

  it("bounds replay results and prunes only TTL-expired receipts", async () => {
    let now = 20_000n;
    const { store } = await makeStore({ now: () => now, maxResultBytes: 8 });
    const created = await store.reserve(intent());
    await store.complete(created.operationId, {
      outcome: "succeeded",
      response: { statusCode: 200, body: "this response is too large" }
    });
    expect((await store.reserve(intent())).kind).toBe("pending");
    expect((await store.getVisible(created.operationId, localActor))?.status).toBe("completed");

    now += COMPLETED_OPERATION_RETENTION_SECONDS;
    expect(await store.getVisible(created.operationId, localActor)).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  it("fails closed on corrupt records", async () => {
    const { store } = await makeStore();
    await mkdir(path.dirname(store.filePath), { recursive: true });
    await writeFile(store.filePath, JSON.stringify({ version: 1, records: [{ secret: "bad" }] }), "utf8");
    await expect(store.count()).rejects.toBeInstanceOf(StorageValidationError);
  });

  it("never evicts unexpired receipts at the count cap and admits work after deterministic expiry", async () => {
    let now = 30_000n;
    const { store } = await makeStore({ now: () => now, maxRecords: 2 });
    const first = await store.reserve(intent({ idempotencyKey: bytes32(0x21) }));
    const second = await store.reserve(intent({ idempotencyKey: bytes32(0x22) }));
    await store.complete(first.operationId, { outcome: "succeeded" });
    await store.markUnknown(second.operationId);

    await expect(store.reserve(intent({ idempotencyKey: bytes32(0x23) })))
      .rejects.toBeInstanceOf(OperationStoreCapacityError);
    expect(await store.count()).toBe(2);

    now += UNRESOLVED_OPERATION_RETENTION_SECONDS + 1n;
    expect((await store.reserve(intent({ idempotencyKey: bytes32(0x23) }))).kind).toBe("created");
    expect(await store.count()).toBe(1);
  });

  it("fails closed at the byte cap without evicting the existing unexpired receipt", async () => {
    let now = 40_000n;
    const baseline = await makeStore({ now: () => now });
    await baseline.store.reserve(intent());
    const firstLedgerBytes = (await stat(baseline.store.filePath)).size;

    const capped = await makeStore({ now: () => now, maxStoreBytes: firstLedgerBytes + 32 });
    await capped.store.reserve(intent());
    await expect(capped.store.reserve(intent({ idempotencyKey: bytes32(0x31) })))
      .rejects.toBeInstanceOf(OperationStoreCapacityError);
    expect(await capped.store.count()).toBe(1);

    now += UNRESOLVED_OPERATION_RETENTION_SECONDS + 1n;
    expect((await capped.store.reserve(intent({ idempotencyKey: bytes32(0x31) }))).kind).toBe("created");
    expect(await capped.store.count()).toBe(1);
  });
});
