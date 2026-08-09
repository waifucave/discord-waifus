import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdministrativeAuditRecordV1Schema,
  EventCursorSchema,
  OperationAcceptedV1Schema,
  OperationStatusV1Schema,
  StreamSnapshotRequiredV1Schema
} from "../src/shared/schemas/adminOperations.js";
import {
  createRemoteAccessFixtureSet,
  createRemoteAccessJsonSchema
} from "../src/shared/schemas/remoteAccessContract.js";
import {
  createStreamEpoch,
  formatEventCursor,
  nextEventCursor,
  parseEventCursor
} from "../src/shared/eventCursor.js";
import {
  serializeCanonicalContractJson,
  serializeRemoteContractJson,
  type ContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");
const operationId = bytes32(0x21);
const statusUrl = `/api/admin/operations/${operationId}`;

describe("EventCursorSchema", () => {
  it("round-trips an exact 128-bit epoch and canonical uint64 sequence", () => {
    const streamEpoch = bytes16(0x11);
    const cursor = formatEventCursor({
      streamEpoch,
      sequence: "18446744073709551615"
    });
    expect(cursor).toBe(`v1:${streamEpoch}:18446744073709551615`);
    expect(parseEventCursor(cursor)).toEqual({
      streamEpoch,
      sequence: "18446744073709551615"
    });
  });

  it("rejects padding, noncanonical decimals, overflow, and unknown versions", () => {
    const epoch = bytes16(0x12);
    for (const value of [
      `v1:${epoch}=:1`,
      `v1:${epoch}:01`,
      `v1:${epoch}:18446744073709551616`,
      `v2:${epoch}:1`,
      `v1:${Buffer.alloc(15, 0x12).toString("base64url")}:1`
    ]) {
      expect(EventCursorSchema.safeParse(value).success, value).toBe(false);
      expect(() => parseEventCursor(value)).toThrow();
    }
  });

  it("increments without narrowing and closes before uint64 wrap", () => {
    const cursor = formatEventCursor({
      streamEpoch: bytes16(0x13),
      sequence: "9007199254740992"
    });
    expect(nextEventCursor(cursor).endsWith(":9007199254740993")).toBe(true);
    expect(() => nextEventCursor(
      formatEventCursor({
        streamEpoch: bytes16(0x13),
        sequence: "18446744073709551615"
      })
    )).toThrow(/exhausted/i);
  });

  it("creates canonical epochs containing exactly 16 random bytes", () => {
    const epoch = createStreamEpoch();
    expect(Buffer.from(epoch, "base64url")).toHaveLength(16);
    expect(Buffer.from(epoch, "base64url").toString("base64url")).toBe(epoch);
  });
});

describe("operation recovery DTOs", () => {
  const prepared = {
    version: 1,
    operationId,
    status: "prepared",
    statusUrl,
    createdAt: "100",
    updatedAt: "101",
    expiresAt: "2592100"
  };

  it("accepts only the exact three-field 202 acknowledgement", () => {
    expect(OperationAcceptedV1Schema.parse({
      operationId,
      status: "accepted",
      statusUrl
    })).toEqual({ operationId, status: "accepted", statusUrl });
    expect(OperationAcceptedV1Schema.safeParse({
      operationId,
      status: "accepted",
      statusUrl: `/api/admin/operations/${bytes32(0x22)}`
    }).success).toBe(false);
    expect(OperationAcceptedV1Schema.safeParse({
      operationId,
      status: "accepted",
      statusUrl,
      result: { secret: "must-not-appear" }
    }).success).toBe(false);
  });

  it("freezes prepared, completed, reconciled, and unknown representations", () => {
    expect(OperationStatusV1Schema.safeParse(prepared).success).toBe(true);
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      status: "completed",
      updatedAt: "200",
      completedAt: "200",
      expiresAt: "86600",
      outcome: "succeeded"
    }).success).toBe(true);
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      status: "reconciled",
      updatedAt: "200",
      completedAt: "200",
      expiresAt: "86600",
      outcome: "failed",
      errorCode: "helper_unavailable"
    }).success).toBe(true);
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      status: "outcome_unknown",
      updatedAt: "200",
      determinedAt: "200",
      expiresAt: "2592200",
      errorCode: "outcome_unknown"
    }).success).toBe(true);
  });

  it("enforces status discriminators, temporal order, and retention ceilings", () => {
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      expiresAt: "2592101"
    }).success).toBe(false);
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      status: "completed",
      updatedAt: "200",
      completedAt: "200",
      expiresAt: "86601",
      outcome: "succeeded"
    }).success).toBe(false);
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      status: "completed",
      updatedAt: "200",
      completedAt: "200",
      expiresAt: "86600",
      outcome: "failed"
    }).success).toBe(false);
    expect(OperationStatusV1Schema.safeParse({
      ...prepared,
      status: "completed",
      updatedAt: "200",
      completedAt: "200",
      expiresAt: "86600",
      outcome: "succeeded",
      errorCode: "should_not_exist"
    }).success).toBe(false);
  });
});

describe("AdministrativeAuditRecordV1Schema", () => {
  const localRecord = {
    version: 1,
    eventId: bytes16(0x31),
    timestamp: "1786270830",
    actor: { kind: "local", stableId: "local" },
    origin: "local",
    action: "remote.device.rename",
    resource: { type: "remote_device", identifier: "remote-device-01" },
    requestId: bytes16(0x32),
    idempotencyKeyHash: bytes32(0x33),
    operationId,
    beforeRevision: "7",
    afterRevision: "8",
    outcome: "completed"
  };

  it("accepts bounded local and delegated remote audit records", () => {
    expect(AdministrativeAuditRecordV1Schema.safeParse(localRecord).success).toBe(true);
    expect(AdministrativeAuditRecordV1Schema.safeParse({
      ...localRecord,
      eventId: bytes16(0x34),
      actor: {
        kind: "remote_device",
        stableId: "remote:remote-device-01",
        deviceId: "remote-device-01",
        trustEpoch: "9"
      },
      origin: "remote",
      delegation: {
        conversationId: "conversation-1",
        toolCallId: "tool-1",
        pendingActionId: "action-1"
      },
      outcome: "accepted"
    }).success).toBe(true);
  });

  it("rejects origin substitution, derived-ID mismatch, bodies, results, and messages", () => {
    expect(AdministrativeAuditRecordV1Schema.safeParse({
      ...localRecord,
      origin: "remote"
    }).success).toBe(false);
    expect(AdministrativeAuditRecordV1Schema.safeParse({
      ...localRecord,
      actor: {
        kind: "remote_device",
        stableId: "remote:another-device",
        deviceId: "remote-device-01",
        trustEpoch: "9"
      },
      origin: "remote"
    }).success).toBe(false);
    for (const forbidden of [
      { requestBody: { activationCredential: "secret" } },
      { result: { token: "secret" } },
      { message: "endpoint or secret-shaped free text" }
    ]) {
      expect(AdministrativeAuditRecordV1Schema.safeParse({
        ...localRecord,
        ...forbidden
      }).success).toBe(false);
    }
  });

  it.each(["accepted", "completed", "rejected", "conflict", "reconciled", "unknown"])(
    "accepts the locked %s outcome",
    (outcome) => {
      expect(AdministrativeAuditRecordV1Schema.safeParse({ ...localRecord, outcome }).success).toBe(true);
    }
  );
});

describe("stream recovery DTO", () => {
  it("exposes only the current cursor boundary and a closed reset reason", () => {
    const value = {
      version: 1,
      type: "snapshot_required",
      reason: "epoch_mismatch",
      streamEpoch: bytes16(0x41),
      latestSequence: "9007199254740992"
    };
    expect(StreamSnapshotRequiredV1Schema.parse(value)).toEqual(value);
    expect(StreamSnapshotRequiredV1Schema.safeParse({
      ...value,
      reason: "server_error"
    }).success).toBe(false);
    expect(StreamSnapshotRequiredV1Schema.safeParse({
      ...value,
      requestedCursor: `v1:${bytes16(0x42)}:1`
    }).success).toBe(false);
  });
});

function fixtureSchema(relativePath: string) {
  if (relativePath.includes("operation-accepted")) return OperationAcceptedV1Schema;
  if (relativePath.includes("operation-status")) return OperationStatusV1Schema;
  if (relativePath.includes("admin-audit")) return AdministrativeAuditRecordV1Schema;
  if (relativePath.includes("event-cursor")) return EventCursorSchema;
  if (relativePath.includes("snapshot-required")) return StreamSnapshotRequiredV1Schema;
  return undefined;
}

describe("checked-in operational remote-access contract", () => {
  it("matches generated bytes and accepts/rejects every operational fixture", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    const schemaBytes = await readFile(path.join(contractRoot, "remote-access.schema.json"), "utf8");
    expect(schemaBytes).toBe(serializeRemoteContractJson(createRemoteAccessJsonSchema()));

    for (const [relativePath, value] of createRemoteAccessFixtureSet()) {
      const schema = fixtureSchema(relativePath);
      if (!schema) continue;
      const actual = await readFile(path.join(contractRoot, relativePath), "utf8");
      expect(actual).toBe(serializeCanonicalContractJson(value as ContractJson));
      expect(schema.safeParse(value).success, relativePath).toBe(relativePath.includes("/valid/"));
    }
  });

  it("publishes the derivation, retention, and redaction invariants", () => {
    const schema = createRemoteAccessJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.EventCursorV1).toMatchObject({
      format: "waifus-event-cursor-v1",
      "x-waifus-stream-epoch-bytes": 16
    });
    expect(schema.$defs.OperationAcceptedV1).toHaveProperty(
      "x-waifus-status-url-derived-from",
      "operationId"
    );
    expect(schema.$defs.OperationStatusV1).toMatchObject({
      "x-waifus-completed-retention-seconds": 86_400,
      "x-waifus-unresolved-retention-seconds": 2_592_000
    });
    expect(schema.$defs.AdministrativeAuditRecordV1).toMatchObject({
      "x-waifus-forbidden-content": ["request_body", "response_body", "result", "secret_free_text"],
      "x-waifus-maximum-raw-bytes": 65_536
    });
  });
});
