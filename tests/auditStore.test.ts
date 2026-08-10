import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_AUDIT_RETENTION_SECONDS,
  type AdministrativeAuditRecordV1
} from "../src/shared/schemas/adminOperations.js";
import {
  AuditContentForbiddenError,
  AuditStore,
  AuditStoreCapacityError
} from "../src/storage/auditStore.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots.length = 0;
});

async function makeStore(options: ConstructorParameters<typeof AuditStore>[1] = {}) {
  const root = await makeTempRoot("waifus-audit-store-");
  roots.push(root);
  return { root, store: new AuditStore(root, options) };
}

function record(
  sequence: number,
  overrides: Partial<AdministrativeAuditRecordV1> = {}
): AdministrativeAuditRecordV1 {
  return {
    version: 1,
    eventId: bytes16(sequence),
    timestamp: String(1_000 + sequence),
    actor: { kind: "local", stableId: "local" },
    origin: "local",
    action: "waifu.update",
    resource: { type: "waifu", identifier: `waifu-${sequence}` },
    requestId: bytes16(100 + sequence),
    idempotencyKeyHash: bytes32(0x31),
    operationId: bytes32(0x41 + sequence),
    outcome: "completed",
    ...overrides
  };
}

describe("AuditStore", () => {
  it("persists every administrative outcome with actor, delegation, and revision metadata", async () => {
    const { store } = await makeStore({ now: () => 2_000n });
    const outcomes = [
      "accepted",
      "completed",
      "rejected",
      "conflict",
      "reconciled",
      "unknown"
    ] as const;
    for (const [index, outcome] of outcomes.entries()) {
      await store.append(record(index + 1, outcome === "accepted" ? {
        outcome,
        actor: {
          kind: "remote_device",
          stableId: "remote:travel-mac",
          deviceId: "travel-mac",
          trustEpoch: "9"
        },
        origin: "remote",
        delegation: {
          conversationId: "conversation-1",
          toolCallId: `tool-${index + 1}`,
          pendingActionId: "action-1"
        },
        beforeRevision: "7",
        afterRevision: "8"
      } : { outcome }));
    }

    const records = await store.list();
    expect(records.map((entry) => entry.outcome)).toEqual(outcomes);
    expect(records[0]).toMatchObject({
      actor: { kind: "remote_device", deviceId: "travel-mac", trustEpoch: "9" },
      origin: "remote",
      delegation: {
        conversationId: "conversation-1",
        toolCallId: "tool-1",
        pendingActionId: "action-1"
      },
      beforeRevision: "7",
      afterRevision: "8"
    });
    expect(JSON.stringify(records)).not.toContain("body");
    expect(JSON.stringify(records)).not.toContain("result");
  });

  it("serializes concurrent writers and creates a 0600 ledger", async () => {
    const root = await makeTempRoot("waifus-audit-concurrent-");
    roots.push(root);
    const storage = new StorageService(root);
    const store = new AuditStore(root, { storage, now: () => 5_000n });
    await Promise.all(Array.from({ length: 40 }, (_, index) => store.append(record(index + 1))));
    const records = await store.list();
    expect(records).toHaveLength(40);
    expect(new Set(records.map((entry) => entry.eventId)).size).toBe(40);
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it("removes expired records and rotates oldest prior records without losing the new event", async () => {
    let now = 10_000n;
    const { store } = await makeStore({ now: () => now, maxRecords: 2 });
    await store.append(record(1, { timestamp: "9990" }));
    await store.append(record(2, { timestamp: "9995" }));
    await store.append(record(3, { timestamp: "9980" }));
    expect((await store.list()).map((entry) => entry.eventId)).toEqual([
      bytes16(3),
      bytes16(2)
    ]);

    now += ADMIN_AUDIT_RETENTION_SECONDS;
    expect(await store.list()).toEqual([]);
  });

  it("rejects secret-looking metadata even when it otherwise satisfies the public schema", async () => {
    const { store } = await makeStore({ now: () => 2_000n });
    const forbidden = [
      record(1, { action: "sk-aaaaaaaaaaaaaaaa" }),
      record(2, {
        resource: {
          type: "waifu",
          identifier: `WF1.${"a".repeat(32)}`
        }
      })
    ];
    for (const candidate of forbidden) {
      await expect(store.append(candidate)).rejects.toBeInstanceOf(AuditContentForbiddenError);
    }
    await expect(store.append({
      ...record(3),
      requestBody: { apiKey: "sk-never-store-this-value" }
    } as unknown as AdministrativeAuditRecordV1)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("fails closed when a mandatory record cannot fit", async () => {
    const { store } = await makeStore({ now: () => 2_000n, maxStoreBytes: 64 });
    await expect(store.append(record(1))).rejects.toBeInstanceOf(AuditStoreCapacityError);
    await expect(store.list()).resolves.toEqual([]);
  });
});
