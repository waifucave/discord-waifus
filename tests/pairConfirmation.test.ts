import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PairConfirmationV1Schema } from "../src/shared/schemas/remoteAccess.js";
import {
  PairConfirmationSessionV1,
  createPairConfirmationV1,
  parseAndVerifyPairConfirmationV1,
  serializePairConfirmationV1
} from "../src/shared/pairConfirmation.js";
import {
  createPairConfirmationFixtureSet,
  serializePairConfirmationFixture
} from "../src/shared/pairConfirmationContract.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected fixture object.");
  }
  return value as JsonObject;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected fixture string.");
  }
  return value;
}

describe("PairConfirmationV1", () => {
  it("recreates the public fixture byte-for-byte", async () => {
    const fixtures = createPairConfirmationFixtureSet();
    const expected = fixtures.get("fixtures/crypto/pair-confirmation-v1.json");
    expect(expected).toBeDefined();
    const actual = await readFile(path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "pair-confirmation-v1.json"
    ), "utf8");
    expect(actual).toBe(serializePairConfirmationFixture(expected as never));
  });

  it("accepts both roles and pins exact canonical bytes and MACs", () => {
    const fixture = object(createPairConfirmationFixtureSet().values().next().value);
    const records = object(fixture.records);
    const confirmationKey = Buffer.from(string(fixture.confirmationKeyB64), "base64url");
    for (const side of ["host", "remote"]) {
      const vector = object(records[side]);
      const payload = Buffer.from(string(vector.canonicalBytesB64), "base64url");
      const parsed = parseAndVerifyPairConfirmationV1(payload, confirmationKey);
      expect(PairConfirmationV1Schema.parse(parsed)).toEqual(vector.value);
      expect(serializePairConfirmationV1(parsed)).toEqual(payload);
    }
  });

  it("rejects every field/MAC substitution and enforces the raw-byte ceiling first", () => {
    const fixture = object(createPairConfirmationFixtureSet().values().next().value);
    const confirmationKey = Buffer.from(string(fixture.confirmationKeyB64), "base64url");
    for (const raw of fixture.rejections as JsonObject[]) {
      const vector = object(raw);
      const payload = Buffer.from(string(vector.payloadB64), "base64url");
      const vectorKey = vector.keyB64 === undefined
        ? confirmationKey
        : Buffer.from(string(vector.keyB64), "base64url");
      expect(
        () => parseAndVerifyPairConfirmationV1(payload, vectorKey),
        string(vector.name)
      ).toThrow(string(vector.errorCode));
    }
    const boundary = object(fixture.boundary);
    expect(() => parseAndVerifyPairConfirmationV1(
      Buffer.from(string(boundary.atLimitPayloadB64), "base64url"),
      confirmationKey
    )).toThrow("invalid_canonical_payload");
    expect(() => parseAndVerifyPairConfirmationV1(
      Buffer.from(string(boundary.overLimitPayloadB64), "base64url"),
      confirmationKey
    )).toThrow("payload_too_large");
  });

  it("requires publish-local, then verify-peer, then idempotent consume without deadlock", () => {
    const fixture = object(createPairConfirmationFixtureSet().values().next().value);
    const records = object(fixture.records);
    const confirmationKey = Buffer.from(string(fixture.confirmationKeyB64), "base64url");
    const hostValue = PairConfirmationV1Schema.parse(object(records.host).value);
    const remoteValue = PairConfirmationV1Schema.parse(object(records.remote).value);
    const expectedContext = {
      invitationId: hostValue.invitationId,
      invitationGeneration: hostValue.invitationGeneration,
      pairId: hostValue.pairId,
      transcriptHash: hostValue.transcriptHash,
      channelBinding: hostValue.channelBinding,
      hostBundleHash: hostValue.hostBundleHash,
      remoteBundleHash: hostValue.remoteBundleHash,
      approvalContextHash: hostValue.approvalContextHash
    };
    const host = new PairConfirmationSessionV1({
      localSide: 1,
      confirmationKey,
      expectedContext
    });
    const remote = new PairConfirmationSessionV1({
      localSide: 2,
      confirmationKey,
      expectedContext
    });

    expect(() => host.publishLocal(hostValue)).toThrow("invalid_phase");
    host.approve();
    remote.approve();
    expect(() => host.receivePeer({
      recordType: "pair_confirmation",
      payload: serializePairConfirmationV1(remoteValue)
    })).toThrow("local_not_published");

    host.publishLocal(hostValue);
    remote.publishLocal(remoteValue);
    expect(host.publishLocal(hostValue)).toBe(false);
    expect(() => host.consume()).toThrow("peer_not_verified");
    expect(() => host.receivePeer({
      recordType: "noise_transport",
      payload: serializePairConfirmationV1(remoteValue)
    })).toThrow("wrong_record_type");
    const { confirmationMac: _hostMac, ...hostUnsigned } = hostValue;
    const alternateHost = createPairConfirmationV1(confirmationKey, {
      ...hostUnsigned,
      confirmationNonce: Buffer.alloc(16, 0xa1).toString("base64url") as typeof hostValue.confirmationNonce
    });
    expect(() => host.publishLocal(alternateHost)).toThrow("duplicate_confirmation");
    expect(host.receivePeer({
      recordType: "pair_confirmation",
      payload: serializePairConfirmationV1(remoteValue)
    })).toBe(true);
    expect(host.receivePeer({
      recordType: "pair_confirmation",
      payload: serializePairConfirmationV1(remoteValue)
    })).toBe(false);
    const { confirmationMac: _remoteMac, ...remoteUnsigned } = remoteValue;
    const alternateRemote = createPairConfirmationV1(confirmationKey, {
      ...remoteUnsigned,
      confirmationNonce: Buffer.alloc(16, 0xb1).toString("base64url") as typeof remoteValue.confirmationNonce
    });
    expect(() => host.receivePeer({
      recordType: "pair_confirmation",
      payload: serializePairConfirmationV1(alternateRemote)
    })).toThrow("duplicate_confirmation");
    remote.receivePeer({
      recordType: "pair_confirmation",
      payload: serializePairConfirmationV1(hostValue)
    });
    expect(host.consume()).toBe(true);
    expect(remote.consume()).toBe(true);
    expect(host.consume()).toBe(false);
    expect(remote.consume()).toBe(false);
    expect(() => host.publishLocal(hostValue)).toThrow("invalid_phase");
    expect(host.snapshot()).toEqual({
      phase: "consumed",
      localPublished: true,
      peerVerified: true,
      consumeAcknowledged: true
    });

    const cancelled = new PairConfirmationSessionV1({
      localSide: 1,
      confirmationKey,
      expectedContext
    });
    cancelled.approve();
    cancelled.cancel();
    cancelled.cancel();
    expect(() => cancelled.publishLocal(hostValue)).toThrow("invalid_phase");
    expect(() => cancelled.expire()).toThrow("invalid_phase");

    const expired = new PairConfirmationSessionV1({
      localSide: 1,
      confirmationKey,
      expectedContext
    });
    expired.approve();
    expired.expire();
    expired.expire();
    expect(() => expired.publishLocal(hostValue)).toThrow("invalid_phase");
    expect(() => expired.cancel()).toThrow("invalid_phase");
  });
});
