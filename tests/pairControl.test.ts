import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PairControlRecordV1Schema } from "../src/shared/schemas/remoteAccess.js";
import {
  PAIR_CONTROL_RECORD_MAX_BYTES,
  PairControlIngressStateV1,
  encodePairControlSignatureInputV1,
  pairControlTransportAllows,
  parseAndVerifyPairControlRecordV1,
  serializePairControlPayloadV1,
  serializePairControlRecordV1,
  verifyPairRevocationAckMacV1,
  verifyPairRevocationMacV1,
  type PairControlTransportV1
} from "../src/shared/pairControl.js";
import {
  createPairControlFixtureSet,
  serializePairControlFixture
} from "../src/shared/pairControlContract.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, name = "fixture value"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, name = "fixture value"): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  return value;
}

function string(value: unknown, name = "fixture value"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  return value;
}

function number(value: unknown, name = "fixture value"): number {
  if (typeof value !== "number") {
    throw new TypeError(`${name} must be a number.`);
  }
  return value;
}

function fixture(): JsonObject {
  return object(createPairControlFixtureSet().values().next().value, "pair-control fixture");
}

function recordVectors(value: JsonObject): JsonObject[] {
  return array(value.records, "record vectors").map((record) => object(record, "record vector"));
}

function verificationOptions(value: JsonObject, record: JsonObject) {
  const publicKeys = object(value.installationPublicKeys, "installation public keys");
  const parsed = PairControlRecordV1Schema.parse(record.value);
  return {
    installationPublicKey: Buffer.from(
      string(parsed.side === 1 ? publicKeys.host : publicKeys.remote),
      "base64url"
    ),
    expectedPairId: string(object(value.context).pairId) as typeof parsed.pairId,
    expectedSide: parsed.side,
    nowSeconds: BigInt(string(value.acceptedAt)),
    timestampMode: "worker_ingress" as const,
    transport: string(record.ingressTransport) as PairControlTransportV1
  };
}

describe("PairControlRecordV1", () => {
  it("recreates the public fixture byte-for-byte", async () => {
    const fixtures = createPairControlFixtureSet();
    const expected = fixtures.get("fixtures/crypto/pair-control-record-v1.json");
    expect(expected).toBeDefined();
    const actual = await readFile(path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "pair-control-record-v1.json"
    ), "utf8");
    expect(actual).toBe(serializePairControlFixture(expected as never));
  });

  it("accepts all nine exact signed records and pins payload/signature bytes", () => {
    const value = fixture();
    const records = recordVectors(value);
    expect(records.map((record) => number(record.typeByte))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const vector of records) {
      const payload = Buffer.from(string(vector.canonicalBytesB64), "base64url");
      const parsed = parseAndVerifyPairControlRecordV1(
        payload,
        verificationOptions(value, vector)
      );
      expect(parsed).toEqual(PairControlRecordV1Schema.parse(vector.value));
      expect(serializePairControlRecordV1(parsed)).toEqual(payload);
      expect(serializePairControlPayloadV1(parsed)).toEqual(
        Buffer.from(string(vector.payloadBytesB64), "base64url")
      );
      expect(encodePairControlSignatureInputV1(parsed)).toEqual(
        Buffer.from(string(vector.signatureInputB64), "base64url")
      );
    }
  });

  it("rejects structural, canonical, signature, context, hash, and size substitutions", () => {
    const value = fixture();
    const records = recordVectors(value);
    const baseOptions = verificationOptions(value, records[0]);
    for (const raw of array(value.rejections, "rejections")) {
      const vector = object(raw, "rejection");
      const keySide = number(vector.keySide ?? vector.side ?? 1) as 1 | 2;
      const expectedSide = number(vector.expectedSide ?? vector.side ?? 1) as 1 | 2;
      const options = {
        ...baseOptions,
        installationPublicKey: Buffer.from(
          string(object(value.installationPublicKeys)[keySide === 1 ? "host" : "remote"]),
          "base64url"
        ),
        expectedSide
      };
      expect(
        () => parseAndVerifyPairControlRecordV1(
          Buffer.from(string(vector.payloadB64), "base64url"),
          options
        ),
        string(vector.name)
      ).toThrow(string(vector.errorCode));
    }
    const boundary = object(value.boundary, "boundary");
    const maximum = Buffer.from(string(boundary.maximumRecordB64), "base64url");
    expect(maximum.byteLength).toBe(number(boundary.maximumRecordBytes));
    expect(maximum.byteLength).toBeLessThanOrEqual(PAIR_CONTROL_RECORD_MAX_BYTES);
    expect(() => parseAndVerifyPairControlRecordV1(
      maximum,
      {
        ...baseOptions,
        installationPublicKey: Buffer.from(
          string(object(value.installationPublicKeys).host),
          "base64url"
        ),
        expectedSide: 1,
        transport: "websocket"
      }
    )).not.toThrow();
    expect(() => parseAndVerifyPairControlRecordV1(
      Buffer.from(string(boundary.overLimitPayloadB64), "base64url"),
      baseOptions
    )).toThrow("payload_too_large");
  });

  it("enforces the closed WebSocket, publish, revoke, ack, and poll matrix", () => {
    const expected: Record<PairControlTransportV1, number[]> = {
      websocket: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      https_publish: [1, 2, 3, 4, 5, 6, 9],
      https_revoke: [7],
      https_revocation_ack: [8],
      https_poll: [1, 2, 3, 4, 5, 6, 7, 8, 9]
    };
    for (const [transport, allowedTypes] of Object.entries(expected) as Array<[
      PairControlTransportV1,
      number[]
    ]>) {
      for (let type = 1; type <= 9; type += 1) {
        expect(pairControlTransportAllows(transport, type as never)).toBe(allowedTypes.includes(type));
      }
    }
    expect(fixture().transportMatrix).toEqual(expected);
  });

  it("shares per-side high-water and replay state across transports and restart", () => {
    const value = fixture();
    const records = recordVectors(value);
    const publicKeys = object(value.installationPublicKeys);
    const stateOptions = {
      expectedPairId: string(object(value.context).pairId) as never,
      hostInstallationPublicKey: Buffer.from(string(publicKeys.host), "base64url"),
      remoteInstallationPublicKey: Buffer.from(string(publicKeys.remote), "base64url")
    };
    let state = new PairControlIngressStateV1(stateOptions);
    const nowSeconds = BigInt(string(value.acceptedAt));

    for (const vector of records.slice(0, 6)) {
      expect(state.accept(
        Buffer.from(string(vector.canonicalBytesB64), "base64url"),
        string(vector.ingressTransport) as PairControlTransportV1,
        nowSeconds
      )).toBe("accepted");
    }
    const revocation = records[6];
    expect(() => state.accept(
      Buffer.from(string(revocation.canonicalBytesB64), "base64url"),
      "https_publish",
      nowSeconds
    )).toThrow("wrong_transport");
    expect(state.accept(
      Buffer.from(string(revocation.canonicalBytesB64), "base64url"),
      "https_revoke",
      nowSeconds
    )).toBe("accepted");
    const acknowledgement = records[7];
    expect(state.accept(
      Buffer.from(string(acknowledgement.canonicalBytesB64), "base64url"),
      "https_revocation_ack",
      nowSeconds
    )).toBe("accepted");

    state = new PairControlIngressStateV1(stateOptions, state.snapshot());
    const errorRecord = records[8];
    const errorBytes = Buffer.from(string(errorRecord.canonicalBytesB64), "base64url");
    expect(state.accept(errorBytes, "https_publish", nowSeconds)).toBe("accepted");
    expect(state.accept(errorBytes, "websocket", nowSeconds)).toBe("idempotent");

    for (const raw of array(value.stateRejections, "state rejections")) {
      const vector = object(raw, "state rejection");
      expect(() => state.accept(
        Buffer.from(string(vector.payloadB64), "base64url"),
        string(vector.transport) as PairControlTransportV1,
        nowSeconds
      ), string(vector.name)).toThrow(string(vector.errorCode));
    }

    const transition = object(value.generationTransition, "generation transition");
    const advanceBytes = Buffer.from(string(transition.advancePayloadB64), "base64url");
    expect(state.accept(advanceBytes, "websocket", nowSeconds)).toBe("accepted");
    expect(state.accept(advanceBytes, "https_publish", nowSeconds)).toBe("idempotent");
    expect(() => state.accept(
      Buffer.from(string(transition.stalePayloadB64), "base64url"),
      "websocket",
      nowSeconds
    )).toThrow("stale_generation");
  });

  it("distinguishes first-ingress freshness from delayed durable delivery", () => {
    const value = fixture();
    const records = recordVectors(value);
    const capabilities = records[1];
    const capabilitiesBytes = Buffer.from(string(capabilities.canonicalBytesB64), "base64url");
    const options = verificationOptions(value, capabilities);
    const delayedAt = BigInt(string(value.delayedAt));
    expect(() => parseAndVerifyPairControlRecordV1(capabilitiesBytes, {
      ...options,
      nowSeconds: delayedAt
    })).toThrow("timestamp_out_of_window");
    expect(() => parseAndVerifyPairControlRecordV1(capabilitiesBytes, {
      ...options,
      nowSeconds: delayedAt,
      timestampMode: "durable_delivery",
      transport: "https_poll"
    })).not.toThrow();

    const presence = records[4];
    expect(() => parseAndVerifyPairControlRecordV1(
      Buffer.from(string(presence.canonicalBytesB64), "base64url"),
      {
        ...verificationOptions(value, presence),
        nowSeconds: delayedAt,
        timestampMode: "durable_delivery",
        transport: "https_poll"
      }
    )).toThrow("presence_expired");
  });

  it("verifies domain-separated revocation and acknowledgement MACs only at helpers", () => {
    const value = fixture();
    const revocation = object(value.revocation, "revocation fixture");
    const context = object(revocation.context, "revocation context");
    const key = Buffer.from(string(revocation.revocationKeyB64), "base64url");
    const records = recordVectors(value);
    const revokeRecord = PairControlRecordV1Schema.parse(records[6].value);
    const acknowledgement = PairControlRecordV1Schema.parse(records[7].value);
    expect(verifyPairRevocationMacV1(key, revokeRecord, context as never)).toBe(true);
    expect(verifyPairRevocationAckMacV1(key, acknowledgement, context as never)).toBe(true);

    for (const raw of array(revocation.rejections, "revocation rejections")) {
      const vector = object(raw, "revocation rejection");
      const record = PairControlRecordV1Schema.parse(vector.value);
      const vectorKey = Buffer.from(
        string(vector.keyB64 ?? revocation.revocationKeyB64),
        "base64url"
      );
      const vectorContext = object(vector.context ?? context, "revocation vector context");
      const verified = record.type === 7
        ? verifyPairRevocationMacV1(vectorKey, record, vectorContext as never)
        : verifyPairRevocationAckMacV1(vectorKey, record, vectorContext as never);
      expect(verified, string(vector.name)).toBe(false);
    }

    const wrongMac = object(revocation.workerOpaqueWrongMac, "opaque wrong MAC");
    const wrongMacRecord = PairControlRecordV1Schema.parse(wrongMac.value);
    const wrongMacBytes = Buffer.from(string(wrongMac.canonicalBytesB64), "base64url");
    expect(() => parseAndVerifyPairControlRecordV1(
      wrongMacBytes,
      verificationOptions(value, {
        ...records[6],
        value: wrongMacRecord
      })
    )).not.toThrow();
    expect(() => parseAndVerifyPairControlRecordV1(wrongMacBytes, {
      ...verificationOptions(value, {
        ...records[6],
        value: wrongMacRecord
      }),
      revocation: { key, context: context as never }
    })).toThrow("invalid_revocation_mac");
  });
});
