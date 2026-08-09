import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApplicationSessionAuthenticationV1,
  RemoteBrowserContextReplayGuardV1,
  createApplicationSessionProofsV1,
  decodeApplicationSessionSignedBytesV1,
  decodeCanonicalRemoteBrowserContextV1,
  deriveApprovalContextHashV1,
  deriveRemoteBrowserContextKeyV1,
  deriveRemoteBrowserContextMacV1,
  encodeApplicationSessionSignedBytesV1,
  encodeRemoteBrowserContextMacInputV1,
  serializeRemoteBrowserContextV1,
  verifyApplicationSessionProofsV1,
  verifyRemoteBrowserContextMacV1,
  type ApplicationSessionContextV1
} from "../src/shared/remoteServiceCrypto.js";
import {
  createRemoteServiceSessionV1Fixture,
  serializeRemoteServiceSessionFixture
} from "../src/shared/remoteServiceContract.js";
import {
  RemoteBrowserContextEnvelopeV1Schema,
  type RemoteBrowserContextEnvelopeV1
} from "../src/shared/schemas/remoteProtocol.js";

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

function applicationSessionInput(value: JsonRecord): ApplicationSessionContextV1 {
  return {
    negotiatedMinor: integer(value.negotiatedMinor),
    pairId: bytes(value.pairIdB64),
    serviceId: bytes(value.serviceIdB64),
    hostNonce: bytes(value.hostNonceB64),
    remoteNonce: bytes(value.remoteNonceB64),
    hostInstallationBundleHash: bytes(value.hostInstallationBundleHashB64),
    remoteInstallationBundleHash: bytes(value.remoteInstallationBundleHashB64),
    hostTrustEpoch: BigInt(text(value.hostTrustEpoch)),
    remoteTrustEpoch: BigInt(text(value.remoteTrustEpoch)),
    hostTransportSessionId: bytes(value.hostTransportSessionIdB64),
    remoteTransportSessionId: bytes(value.remoteTransportSessionIdB64)
  };
}

function browserEnvelope(value: unknown): RemoteBrowserContextEnvelopeV1 {
  return RemoteBrowserContextEnvelopeV1Schema.parse(value);
}

function cloneEnvelope(value: RemoteBrowserContextEnvelopeV1): RemoteBrowserContextEnvelopeV1 {
  return structuredClone(value);
}

describe("remote service-session V1 public crypto vectors", () => {
  it("recreates the committed fixture byte-for-byte", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "service-session-v1.json"
    );
    const actual = await readFile(fixturePath, "utf8");
    expect(actual).toBe(serializeRemoteServiceSessionFixture(createRemoteServiceSessionV1Fixture()));
  });

  it("pins host-then-remote application-session bytes, signatures, and hash", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    const session = record(fixture.applicationSession);
    const input = applicationSessionInput(record(session.inputs));
    const proofs = createApplicationSessionProofsV1(
      input,
      bytes(session.hostInstallationSeedB64),
      bytes(session.remoteInstallationSeedB64)
    );

    expect(encodeApplicationSessionSignedBytesV1(input).toString("base64url"))
      .toBe(text(session.signedBytesB64));
    expect(proofs.digest.toString("base64url")).toBe(text(session.digestB64));
    expect(proofs.hostSignature.toString("base64url")).toBe(text(session.hostSignatureB64));
    expect(proofs.remoteSignature.toString("base64url")).toBe(text(session.remoteSignatureB64));
    expect(proofs.applicationSessionHash.toString("base64url"))
      .toBe(text(session.applicationSessionHashB64));
    expect(verifyApplicationSessionProofsV1({
      context: input,
      hostInstallationPublicKey: bytes(session.hostInstallationPublicKeyB64),
      remoteInstallationPublicKey: bytes(session.remoteInstallationPublicKeyB64),
      hostSignature: proofs.hostSignature,
      remoteSignature: proofs.remoteSignature
    })).toBe(true);
    const decoded = decodeApplicationSessionSignedBytesV1(proofs.signedBytes, 0);
    expect(encodeApplicationSessionSignedBytesV1(decoded)).toEqual(proofs.signedBytes);
  });

  it("rejects malformed, noncanonical, trailing, or non-negotiated app-session bytes", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    for (const rejectionValue of record(fixture.rejections).applicationSessionEncoding as JsonRecord[]) {
      const rejection = record(rejectionValue);
      expect(
        () => decodeApplicationSessionSignedBytesV1(
          bytes(rejection.payloadB64),
          integer(rejection.expectedMinor)
        ),
        text(rejection.name)
      ).toThrow(/invalid_application_session/);
    }
  });

  it("rejects every role, protocol, identity, epoch, nonce, and session substitution", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    const session = record(fixture.applicationSession);
    const original = applicationSessionInput(record(session.inputs));
    const hostPublicKey = bytes(session.hostInstallationPublicKeyB64);
    const remotePublicKey = bytes(session.remoteInstallationPublicKeyB64);
    const hostSignature = bytes(session.hostSignatureB64);
    const remoteSignature = bytes(session.remoteSignatureB64);

    for (const rejectionValue of record(fixture.rejections).applicationSession as JsonRecord[]) {
      const rejection = record(rejectionValue);
      const mutated = applicationSessionInput(record(rejection.inputs));
      expect(
        verifyApplicationSessionProofsV1({
          context: mutated,
          hostInstallationPublicKey: hostPublicKey,
          remoteInstallationPublicKey: remotePublicKey,
          hostSignature,
          remoteSignature
        }),
        text(rejection.name)
      ).toBe(false);
      expect(encodeApplicationSessionSignedBytesV1(mutated)).not.toEqual(
        encodeApplicationSessionSignedBytesV1(original)
      );
    }

    const corruptHostSignature = Buffer.from(hostSignature);
    corruptHostSignature[0] ^= 1;
    expect(verifyApplicationSessionProofsV1({
      context: original,
      hostInstallationPublicKey: hostPublicKey,
      remoteInstallationPublicKey: remotePublicKey,
      hostSignature: corruptHostSignature,
      remoteSignature
    })).toBe(false);
  });

  it("requires the exact four-message role-local authentication order", () => {
    const remote = new ApplicationSessionAuthenticationV1("remote");
    expect(remote.canAcceptRequestStart).toBe(false);
    for (const event of [
      "send_hello",
      "receive_verified_hello_ack",
      "send_authenticate_peer",
      "receive_success_result"
    ] as const) {
      remote.transition(event);
    }
    expect(remote.state).toBe("authenticated");
    expect(remote.canAcceptRequestStart).toBe(true);

    const host = new ApplicationSessionAuthenticationV1("host");
    for (const event of [
      "receive_hello",
      "send_hello_ack",
      "receive_verified_authenticate_peer",
      "send_success_result"
    ] as const) {
      host.transition(event);
    }
    expect(host.state).toBe("authenticated");
    expect(host.canAcceptRequestStart).toBe(true);

    const outOfOrder = new ApplicationSessionAuthenticationV1("host");
    expect(() => outOfOrder.transition("receive_verified_authenticate_peer"))
      .toThrow(/auth_sequence_error/);
    expect(outOfOrder.state).toBe("idle");
    expect(outOfOrder.canAcceptRequestStart).toBe(false);
  });

  it("derives and verifies the strict authenticated remote-browser envelope", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    const session = record(fixture.applicationSession);
    const browser = record(fixture.remoteBrowserContext);
    const sessionInput = applicationSessionInput(record(session.inputs));
    const envelope = browserEnvelope(browser.envelope);
    const applicationSessionHash = bytes(session.applicationSessionHashB64);
    const key = deriveRemoteBrowserContextKeyV1({
      pairRoot: bytes(browser.pairRootB64),
      applicationSessionHash,
      applicationSession: sessionInput
    });

    expect(serializeRemoteBrowserContextV1(envelope.browserContext).toString("base64url"))
      .toBe(text(browser.canonicalContextBytesB64));
    expect(decodeCanonicalRemoteBrowserContextV1(bytes(browser.canonicalContextBytesB64)))
      .toEqual(envelope.browserContext);
    expect(key.toString("base64url")).toBe(text(browser.browserContextKeyB64));
    expect(encodeRemoteBrowserContextMacInputV1(envelope).toString("base64url"))
      .toBe(text(browser.macInputB64));
    expect(deriveRemoteBrowserContextMacV1(key, envelope).toString("base64url"))
      .toBe(envelope.mac);
    expect(verifyRemoteBrowserContextMacV1(key, envelope)).toBe(true);
    expect(RemoteBrowserContextEnvelopeV1Schema.safeParse({
      ...envelope,
      forwardedHeaders: { "x-waifus-browser-context": "forged" }
    }).success).toBe(false);
  });

  it("rejects every browser/session/request binding substitution", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    const session = record(fixture.applicationSession);
    const browser = record(fixture.remoteBrowserContext);
    const sessionInput = applicationSessionInput(record(session.inputs));
    const envelope = browserEnvelope(browser.envelope);
    const key = deriveRemoteBrowserContextKeyV1({
      pairRoot: bytes(browser.pairRootB64),
      applicationSessionHash: bytes(session.applicationSessionHashB64),
      applicationSession: sessionInput
    });

    for (const rejectionValue of record(fixture.rejections).remoteBrowserContext as JsonRecord[]) {
      const rejection = record(rejectionValue);
      const mutated = browserEnvelope(rejection.envelope);
      expect(
        verifyRemoteBrowserContextMacV1(key, mutated),
        text(rejection.name)
      ).toBe(false);
    }
    for (const rejectionValue of record(fixture.rejections).remoteBrowserContextStructural as JsonRecord[]) {
      const rejection = record(rejectionValue);
      expect(
        RemoteBrowserContextEnvelopeV1Schema.safeParse(rejection.envelope).success,
        text(rejection.name)
      ).toBe(false);
    }

    const wrongPairRoot = Buffer.from(bytes(browser.pairRootB64));
    wrongPairRoot[0] ^= 1;
    const wrongKey = deriveRemoteBrowserContextKeyV1({
      pairRoot: wrongPairRoot,
      applicationSessionHash: bytes(session.applicationSessionHashB64),
      applicationSession: sessionInput
    });
    expect(verifyRemoteBrowserContextMacV1(wrongKey, envelope)).toBe(false);
  });

  it("checks current launch/session/route state and consumes replay identifiers atomically", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    const browser = record(fixture.remoteBrowserContext);
    const envelope = browserEnvelope(browser.envelope);
    const key = bytes(browser.browserContextKeyB64);
    const guard = new RemoteBrowserContextReplayGuardV1({
      pairId: envelope.pairId,
      remoteDeviceId: envelope.remoteDeviceId,
      remoteInstallationBundleHash: envelope.remoteInstallationBundleHash,
      hostTrustEpoch: envelope.hostTrustEpoch,
      remoteTrustEpoch: envelope.remoteTrustEpoch,
      gatewayLaunchId: envelope.browserContext.gatewayLaunchId,
      browserSessionId: envelope.browserContext.browserSessionId,
      gatewayExpiresAt: text(browser.gatewayExpiresAt)
    });

    guard.verifyAndConsume({
      envelope,
      browserContextKey: key,
      applicationSessionHash: envelope.applicationSessionHash,
      now: text(browser.acceptedAt),
      method: envelope.browserContext.method,
      canonicalTarget: envelope.browserContext.canonicalTarget
    });
    expect(() => guard.verifyAndConsume({
      envelope,
      browserContextKey: key,
      applicationSessionHash: envelope.applicationSessionHash,
      now: text(browser.acceptedAt),
      method: envelope.browserContext.method,
      canonicalTarget: envelope.browserContext.canonicalTarget
    })).toThrow(/replayed_request_nonce/);

    const fresh = cloneEnvelope(envelope);
    fresh.browserContext.requestNonce = Buffer.alloc(16, 0x91).toString("base64url") as typeof fresh.browserContext.requestNonce;
    fresh.directRequestId = Buffer.alloc(16, 0x92).toString("base64url") as typeof fresh.directRequestId;
    fresh.remoteParentStreamId = (BigInt(envelope.remoteParentStreamId) + 2n).toString() as typeof fresh.remoteParentStreamId;
    fresh.mac = deriveRemoteBrowserContextMacV1(key, fresh).toString("base64url") as typeof fresh.mac;
    expect(() => guard.verifyAndConsume({
      envelope: fresh,
      browserContextKey: key,
      applicationSessionHash: fresh.applicationSessionHash,
      now: (BigInt(text(browser.gatewayExpiresAt)) + 1n).toString(),
      method: fresh.browserContext.method,
      canonicalTarget: fresh.browserContext.canonicalTarget
    })).toThrow(/gateway_launch_expired/);

    expect(() => guard.verifyAndConsume({
      envelope: fresh,
      browserContextKey: key,
      applicationSessionHash: fresh.applicationSessionHash,
      now: text(browser.acceptedAt),
      method: "GET",
      canonicalTarget: fresh.browserContext.canonicalTarget
    })).toThrow(/request_binding_mismatch/);
  });

  it("pins canonical local and remote ApprovalReceiptV1 context hashes", () => {
    const fixture = record(createRemoteServiceSessionV1Fixture());
    for (const value of fixture.approvalReceipts as JsonRecord[]) {
      const approval = record(value);
      const derived = deriveApprovalContextHashV1(approval.value);
      expect(derived.canonicalBytes.toString("base64url"))
        .toBe(text(approval.canonicalBytesB64));
      expect(derived.contextHash.toString("base64url"))
        .toBe(text(approval.contextHashB64));
      const receipt = record(approval.value);
      expect(BigInt(text(receipt.expiresAt)) - BigInt(text(receipt.issuedAt))).toBe(120n);
      expect(text(receipt.invitationGeneration)).toBe("1");
    }
  });
});
