import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalCbor,
  decodeFullPairToken,
  decodeSignedDeviceIdentityBundle,
  derivePairKeys,
  derivePairingSas,
  verifyNoiseXXHandshake
} from "../src/shared/remotePairing.js";
import {
  createRemotePairingV1Fixture,
  serializeRemotePairingFixture
} from "../src/shared/remotePairingContract.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as JsonRecord;
}

function text(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

function strings(value: unknown): string[] {
  expect(Array.isArray(value)).toBe(true);
  return value as string[];
}

describe("remote pairing V1 public crypto vectors", () => {
  it("recreates the committed fixture byte-for-byte", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "pairing-v1.json"
    );
    const actual = await readFile(fixturePath, "utf8");
    expect(actual).toBe(serializeRemotePairingFixture(createRemotePairingV1Fixture()));
  });

  it("strictly verifies the WF1 token and every canonical-CBOR rejection vector", () => {
    const fixture = record(createRemotePairingV1Fixture());
    const token = record(fixture.fullToken);
    const decoded = decodeFullPairToken(text(token.encoded), BigInt(text(token.acceptedAt)));

    expect(decoded.invitationId.toString("base64url")).toBe(text(token.invitationIdB64));
    expect(decoded.hostInstallationFingerprint.toString("base64url")).toBe(text(token.fingerprintB64));
    expect(decoded.hostPairingPublicKey.toString("base64url")).toBe(text(token.hostPairingPublicKeyB64));
    expect(decoded.psk.toString("base64url")).toBe(text(token.pskB64));
    const fullHandshake = record((fixture.handshakes as JsonRecord[]).find(
      (handshake) => handshake.name === "full-token"
    ));
    expect(text(record(fullHandshake.inputs).responderStaticPublicKeyB64)).toBe(
      text(token.hostPairingPublicKeyB64)
    );

    for (const invalid of record(fixture.rejections).tokens as JsonRecord[]) {
      expect(
        () => decodeFullPairToken(text(invalid.encoded), BigInt(text(invalid.now))),
        text(invalid.name)
      ).toThrow();
    }
    for (const invalid of record(fixture.rejections).canonicalCbor as JsonRecord[]) {
      expect(
        () => decodeCanonicalCbor(Buffer.from(text(invalid.cborB64), "base64url")),
        text(invalid.name)
      ).toThrow();
    }
  });

  it("verifies both canonical signed identity bundles and rejects substitution", () => {
    const fixture = record(createRemotePairingV1Fixture());
    const identities = record(fixture.identities);
    const host = record(identities.host);
    const remote = record(identities.remote);

    expect(
      decodeSignedDeviceIdentityBundle(Buffer.from(text(host.bundleCborB64), "base64url")).role
    ).toBe(1);
    expect(
      decodeSignedDeviceIdentityBundle(Buffer.from(text(remote.bundleCborB64), "base64url")).role
    ).toBe(2);
    for (const invalid of record(fixture.rejections).identityBundles as JsonRecord[]) {
      expect(
        () => decodeSignedDeviceIdentityBundle(Buffer.from(text(invalid.bundleCborB64), "base64url")),
        text(invalid.name)
      ).toThrow();
    }
  });

  it("replays both pinned Noise handshakes and derives the frozen persistent keys", () => {
    const fixture = record(createRemotePairingV1Fixture());
    for (const value of fixture.handshakes as JsonRecord[]) {
      const inputs = record(value.inputs);
      const handshakeInput = {
        prologue: Buffer.from(text(inputs.prologueB64), "base64url"),
        psk: inputs.pskB64 === null ? undefined : Buffer.from(text(inputs.pskB64), "base64url"),
        initiatorStaticPrivateKey: Buffer.from(text(inputs.initiatorStaticPrivateKeyB64), "base64url"),
        responderStaticPrivateKey: Buffer.from(text(inputs.responderStaticPrivateKeyB64), "base64url"),
        initiatorEphemeralPrivateKey: Buffer.from(text(inputs.initiatorEphemeralPrivateKeyB64), "base64url"),
        responderEphemeralPrivateKey: Buffer.from(text(inputs.responderEphemeralPrivateKeyB64), "base64url"),
        payloads: strings(inputs.payloadsB64).map((payload) => Buffer.from(payload, "base64url"))
      };
      const replay = verifyNoiseXXHandshake(
        handshakeInput,
        strings(value.messagesB64).map((message) => Buffer.from(message, "base64url"))
      );
      expect(replay.pattern).toBe(text(value.pattern));
      expect(replay.messages.every((message) => message.byteLength <= 1_200)).toBe(true);
      expect(replay.messages.map((message) => message.toString("base64url"))).toEqual(value.messagesB64);
      expect(replay.channelBinding.toString("base64url")).toBe(text(value.channelBindingB64));
      expect(replay.transcriptHash.toString("base64url")).toBe(text(value.transcriptHashB64));

      const context = record(value.pairContext);
      const derived = derivePairKeys({
        hostContribution: Buffer.from(text(context.hostContributionB64), "base64url"),
        remoteContribution: Buffer.from(text(context.remoteContributionB64), "base64url"),
        channelBinding: replay.channelBinding,
        invitationId: Buffer.from(text(context.invitationIdB64), "base64url"),
        invitationGeneration: BigInt(text(context.invitationGeneration)),
        pairId: Buffer.from(text(context.pairIdB64), "base64url"),
        hostBundleHash: Buffer.from(text(context.hostBundleHashB64), "base64url"),
        remoteBundleHash: Buffer.from(text(context.remoteBundleHashB64), "base64url"),
        hostInstallationPublicKey: Buffer.from(text(context.hostInstallationPublicKeyB64), "base64url"),
        remoteInstallationPublicKey: Buffer.from(text(context.remoteInstallationPublicKeyB64), "base64url")
      });
      const expected = record(value.derived);
      expect(derived.pairRoot.toString("base64url")).toBe(text(expected.pairRootB64));
      expect(derived.confirmationKey.toString("base64url")).toBe(text(expected.confirmationKeyB64));
      expect(derived.revocationKey.toString("base64url")).toBe(text(expected.revocationKeyB64));

      const sas = derivePairingSas({
        channelBinding: replay.channelBinding,
        pairId: Buffer.from(text(context.pairIdB64), "base64url"),
        hostBundleCbor: Buffer.from(text(context.hostBundleCborB64), "base64url"),
        remoteBundleCbor: Buffer.from(text(context.remoteBundleCborB64), "base64url")
      });
      expect(sas.indices).toEqual(expected.sasIndices);
      expect(sas.words).toEqual(expected.sasWords);
      expect(sas.fingerprint).toBe(text(expected.sasFingerprint));
    }
  });

  it("binds contribution and role order and refuses self-pairing", () => {
    const fixture = record(createRemotePairingV1Fixture());
    const handshake = record((fixture.handshakes as JsonRecord[])[0]);
    const context = record(handshake.pairContext);
    const common = {
      channelBinding: Buffer.from(text(handshake.channelBindingB64), "base64url"),
      invitationId: Buffer.from(text(context.invitationIdB64), "base64url"),
      invitationGeneration: BigInt(text(context.invitationGeneration)),
      pairId: Buffer.from(text(context.pairIdB64), "base64url"),
      hostBundleHash: Buffer.from(text(context.hostBundleHashB64), "base64url"),
      remoteBundleHash: Buffer.from(text(context.remoteBundleHashB64), "base64url"),
      hostInstallationPublicKey: Buffer.from(text(context.hostInstallationPublicKeyB64), "base64url"),
      remoteInstallationPublicKey: Buffer.from(text(context.remoteInstallationPublicKeyB64), "base64url")
    };
    const hostContribution = Buffer.from(text(context.hostContributionB64), "base64url");
    const remoteContribution = Buffer.from(text(context.remoteContributionB64), "base64url");
    const original = derivePairKeys({ ...common, hostContribution, remoteContribution });
    const reversed = derivePairKeys({
      ...common,
      hostContribution: remoteContribution,
      remoteContribution: hostContribution
    });
    expect(reversed.pairRoot).not.toEqual(original.pairRoot);

    expect(() => derivePairKeys({
      ...common,
      hostContribution,
      remoteContribution,
      remoteInstallationPublicKey: common.hostInstallationPublicKey
    })).toThrow(/self-pair/i);
  });

  it("rejects every pinned Noise transcript or input substitution", () => {
    const fixture = record(createRemotePairingV1Fixture());
    const handshakes = new Map(
      (fixture.handshakes as JsonRecord[]).map((handshake) => [text(handshake.name), handshake])
    );
    for (const vector of record(fixture.rejections).noise as JsonRecord[]) {
      const handshake = handshakes.get(text(vector.handshake));
      expect(handshake, text(vector.name)).toBeDefined();
      const inputs = record(handshake?.inputs);
      const mutable = {
        prologue: Buffer.from(text(inputs.prologueB64), "base64url"),
        psk: inputs.pskB64 === null ? undefined : Buffer.from(text(inputs.pskB64), "base64url"),
        initiatorStaticPrivateKey: Buffer.from(text(inputs.initiatorStaticPrivateKeyB64), "base64url"),
        responderStaticPrivateKey: Buffer.from(text(inputs.responderStaticPrivateKeyB64), "base64url"),
        initiatorEphemeralPrivateKey: Buffer.from(text(inputs.initiatorEphemeralPrivateKeyB64), "base64url"),
        responderEphemeralPrivateKey: Buffer.from(text(inputs.responderEphemeralPrivateKeyB64), "base64url"),
        payloads: strings(inputs.payloadsB64).map((payload) => Buffer.from(payload, "base64url")),
        messages: strings(handshake?.messagesB64).map((message) => Buffer.from(message, "base64url"))
      };
      const target = text(vector.target);
      const byteIndex = vector.byteIndex as number;
      const xor = vector.xor as number;
      const mutableTargets: Record<string, Buffer | undefined> = {
        prologue: mutable.prologue,
        psk: mutable.psk,
        initiatorStaticPrivateKey: mutable.initiatorStaticPrivateKey,
        responderStaticPrivateKey: mutable.responderStaticPrivateKey,
        payload1: mutable.payloads[0],
        payload2: mutable.payloads[1],
        payload3: mutable.payloads[2],
        message1: mutable.messages[0],
        message2: mutable.messages[1],
        message3: mutable.messages[2]
      };
      if (target === "addPsk") {
        mutable.psk = Buffer.alloc(32);
        mutable.psk[byteIndex] ^= xor;
      } else {
        const bytes = mutableTargets[target];
        expect(bytes, text(vector.name)).toBeDefined();
        if (!bytes) {
          throw new Error(`Missing mutation target ${target}.`);
        }
        bytes[byteIndex] ^= xor;
      }
      expect(() => verifyNoiseXXHandshake({
        prologue: mutable.prologue,
        psk: mutable.psk,
        initiatorStaticPrivateKey: mutable.initiatorStaticPrivateKey,
        responderStaticPrivateKey: mutable.responderStaticPrivateKey,
        initiatorEphemeralPrivateKey: mutable.initiatorEphemeralPrivateKey,
        responderEphemeralPrivateKey: mutable.responderEphemeralPrivateKey,
        payloads: mutable.payloads
      }, mutable.messages), text(vector.name)).toThrow();
    }
  });
});
