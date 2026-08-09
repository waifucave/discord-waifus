import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENDPOINT_CIPHERTEXT_MAX_BYTES,
  ENDPOINT_PLAINTEXT_MAX_BYTES,
  EndpointReceiveStateV1,
  decodeEndpointAssociatedDataV1,
  decodeEndpointPlaintextV1,
  decryptEndpointAeadPayloadV1,
  decryptEndpointEnvelopeV1,
  encodeEndpointAssociatedDataV1,
  encodeEndpointPlaintextV1,
  encryptEndpointAeadPayloadV1,
  encryptEndpointEnvelopeV1,
  endpointNonceV1,
  type EndpointDirectionKeysV1,
  type EndpointEnvelopeContextV1,
  type EndpointGenerationV1
} from "../src/shared/endpointEnvelope.js";
import {
  createEndpointEnvelopeV1Fixture,
  serializeEndpointEnvelopeFixture
} from "../src/shared/endpointEnvelopeContract.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function text(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

function integer(value: unknown): number {
  expect(typeof value).toBe("number");
  expect(Number.isInteger(value)).toBe(true);
  return value as number;
}

function bytes(value: unknown): Buffer {
  return Buffer.from(text(value), "base64url");
}

function endpointContext(value: JsonRecord): EndpointEnvelopeContextV1 {
  return {
    negotiatedMinor: integer(value.negotiatedMinor),
    pairId: bytes(value.pairIdB64),
    senderRole: integer(value.senderRole) as 1 | 2,
    receiverRole: integer(value.receiverRole) as 1 | 2,
    hostInstallationBundleHash: bytes(value.hostInstallationBundleHashB64),
    remoteInstallationBundleHash: bytes(value.remoteInstallationBundleHashB64),
    hostTrustEpoch: BigInt(text(value.hostTrustEpoch)),
    remoteTrustEpoch: BigInt(text(value.remoteTrustEpoch)),
    endpointEpoch: BigInt(text(value.endpointEpoch))
  };
}

function endpointRecord(value: JsonRecord): EndpointGenerationV1 {
  return {
    version: 1,
    endpointEpoch: BigInt(text(value.endpointEpoch)),
    connectionGeneration: BigInt(text(value.connectionGeneration)),
    candidates: (value.candidates as JsonRecord[]).map((candidate) => ({
      kind: integer(candidate.kind) as 1 | 2 | 3,
      family: integer(candidate.family) as 4 | 6,
      address: bytes(candidate.addressB64),
      port: integer(candidate.port),
      priority: integer(candidate.priority)
    }))
  };
}

function directionKeys(value: JsonRecord): EndpointDirectionKeysV1 {
  return {
    hostToRemoteKey: bytes(value.hostToRemoteKeyB64),
    remoteToHostKey: bytes(value.remoteToHostKeyB64)
  };
}

describe("endpoint envelope V1 public crypto vectors", () => {
  it("recreates the committed fixture byte-for-byte", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "endpoint-envelope-v1.json"
    );
    const actual = await readFile(fixturePath, "utf8");
    expect(actual).toBe(serializeEndpointEnvelopeFixture(createEndpointEnvelopeV1Fixture()));
  });

  it("pins canonical endpoint CBOR, nonce, associated data, and both direction keys", () => {
    const fixture = record(createEndpointEnvelopeV1Fixture());
    const keys = directionKeys(record(fixture.keys));
    for (const vectorValue of fixture.envelopes as JsonRecord[]) {
      const vector = record(vectorValue);
      const context = endpointContext(record(vector.context));
      const value = endpointRecord(record(vector.value));
      const encrypted = encryptEndpointEnvelopeV1({
        directionKeys: keys,
        context,
        value,
        approved: true
      });

      expect(encodeEndpointPlaintextV1(value).toString("base64url"))
        .toBe(text(vector.plaintextB64));
      expect(endpointNonceV1(context.endpointEpoch).toString("base64url"))
        .toBe(text(vector.nonceB64));
      expect(encodeEndpointAssociatedDataV1(context).toString("base64url"))
        .toBe(text(vector.associatedDataB64));
      expect(encrypted.ciphertext.toString("base64url")).toBe(text(vector.ciphertextB64));
      expect(decodeEndpointPlaintextV1(encrypted.plaintext)).toEqual(value);
      expect(decodeEndpointAssociatedDataV1(encrypted.associatedData, context.negotiatedMinor))
        .toEqual(context);
      expect(decryptEndpointEnvelopeV1({
        directionKeys: keys,
        context,
        ciphertext: encrypted.ciphertext,
        approved: true
      })).toEqual(value);
    }
  });

  it("rejects malformed, unsafe, duplicate, or unsorted candidate records", () => {
    const fixture = record(createEndpointEnvelopeV1Fixture());
    for (const rejectionValue of record(fixture.rejections).plaintext as JsonRecord[]) {
      const rejection = record(rejectionValue);
      expect(
        () => decodeEndpointPlaintextV1(bytes(rejection.plaintextB64)),
        text(rejection.name)
      ).toThrow(new RegExp(text(rejection.errorCode)));
    }
  });

  it("rejects tamper, wrong direction, context substitution, and unapproved exchange", () => {
    const fixture = record(createEndpointEnvelopeV1Fixture());
    const keys = directionKeys(record(fixture.keys));
    for (const rejectionValue of record(fixture.rejections).envelopes as JsonRecord[]) {
      const rejection = record(rejectionValue);
      expect(() => decryptEndpointEnvelopeV1({
        directionKeys: keys,
        context: endpointContext(record(rejection.context)),
        ciphertext: bytes(rejection.ciphertextB64),
        approved: rejection.approved as boolean
      }), text(rejection.name)).toThrow(new RegExp(text(rejection.errorCode)));
    }
  });

  it("pins the raw AEAD 1,184/1,200-byte ceiling without treating padding as endpoint CBOR", () => {
    const fixture = record(createEndpointEnvelopeV1Fixture());
    const boundary = record(fixture.boundary);
    const key = bytes(boundary.keyB64);
    const nonce = bytes(boundary.nonceB64);
    const associatedData = bytes(boundary.associatedDataB64);
    const plaintext = bytes(boundary.plaintextB64);
    const ciphertext = encryptEndpointAeadPayloadV1(key, nonce, associatedData, plaintext);

    expect(plaintext).toHaveLength(ENDPOINT_PLAINTEXT_MAX_BYTES);
    expect(ciphertext).toHaveLength(ENDPOINT_CIPHERTEXT_MAX_BYTES);
    expect(ciphertext.toString("base64url")).toBe(text(boundary.ciphertextB64));
    expect(decryptEndpointAeadPayloadV1(key, nonce, associatedData, ciphertext)).toEqual(plaintext);
    expect(() => encryptEndpointAeadPayloadV1(
      key,
      nonce,
      associatedData,
      Buffer.alloc(ENDPOINT_PLAINTEXT_MAX_BYTES + 1)
    )).toThrow(/plaintext_too_large/);
    expect(() => decodeEndpointPlaintextV1(plaintext)).toThrow(/invalid_canonical_cbor/);
  });

  it("persists prepared/applied receive state and rejects conflict or rollback", () => {
    const fixture = record(createEndpointEnvelopeV1Fixture());
    const keys = directionKeys(record(fixture.keys));
    const first = record((fixture.envelopes as JsonRecord[])[0]);
    const context = endpointContext(record(first.context));
    const ciphertext = bytes(first.ciphertextB64);
    const state = new EndpointReceiveStateV1();

    const prepared = state.prepare({
      directionKeys: keys,
      context,
      ciphertext,
      approved: true
    });
    expect(prepared.status).toBe("prepared");
    expect(state.snapshot().phase).toBe("prepared");

    const resumed = new EndpointReceiveStateV1(state.snapshot()).prepare({
      directionKeys: keys,
      context,
      ciphertext,
      approved: true
    });
    expect(resumed.status).toBe("resume_prepared");
    state.markApplied(context.endpointEpoch, prepared.ciphertextSha256);
    expect(state.snapshot().phase).toBe("applied");
    expect(state.prepare({ directionKeys: keys, context, ciphertext, approved: true }).status)
      .toBe("already_applied");
    expect(() => state.prepare({
      directionKeys: keys,
      context,
      ciphertext,
      approved: false
    })).toThrow(/unapproved_sender/);

    const conflict = Buffer.from(ciphertext);
    conflict[0] ^= 1;
    expect(() => state.prepare({
      directionKeys: keys,
      context,
      ciphertext: conflict,
      approved: true
    })).toThrow(/epoch_conflict/);

    const advanced = record(fixture.epochAdvance);
    const advancedResult = state.prepare({
      directionKeys: keys,
      context: endpointContext(record(advanced.context)),
      ciphertext: bytes(advanced.ciphertextB64),
      approved: true
    });
    expect(advancedResult.status).toBe("prepared");
    expect(() => state.prepare({
      directionKeys: keys,
      context,
      ciphertext,
      approved: true
    })).toThrow(/epoch_rollback/);
  });
});
