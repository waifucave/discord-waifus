import {
  NOISE_XX_PATTERN,
  NOISE_XXPSK0_PATTERN,
  createFullPairToken,
  createNoisePrologue,
  createSignedDeviceIdentityBundle,
  decodeCanonicalCbor,
  deriveEd25519PublicKey,
  derivePairKeys,
  derivePairingSas,
  deriveX25519PublicKey,
  encodeCanonicalCbor,
  encryptNoiseTransportMessage,
  runNoiseXXHandshake,
  type CanonicalCborValue,
  type UnsignedDeviceIdentityBundle
} from "./remotePairing.js";
import { INITIAL_REQUIRED_CAPABILITIES } from "./schemas/remoteProtocol.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

const ACCEPTED_AT = 1_786_270_800n;
const EXPIRY = ACCEPTED_AT + 300n;

function sequence(start: number, length: number): Buffer {
  if (start < 0 || start + length > 256) {
    throw new RangeError("Fixture byte sequence exceeds one byte.");
  }
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function mutateLastByte(value: Buffer): Buffer {
  const mutated = Buffer.from(value);
  mutated[mutated.byteLength - 1] ^= 1;
  return mutated;
}

function tokenFromCbor(value: Buffer): string {
  return `WF1.${value.toString("base64url")}`;
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function testIdentity(
  role: 1 | 2,
  installationSeed: Buffer,
  nodePrivateKey: Buffer,
  discoveryPrivateKey: Buffer
): UnsignedDeviceIdentityBundle {
  return {
    version: 1,
    deviceId: role === 1 ? "host-device-01" : "remote-device-01",
    role,
    trustEpoch: (role === 1 ? "1" : "2") as UnsignedDeviceIdentityBundle["trustEpoch"],
    installationPublicKey: b64(deriveEd25519PublicKey(installationSeed)) as UnsignedDeviceIdentityBundle["installationPublicKey"],
    nodePublicKey: b64(deriveX25519PublicKey(nodePrivateKey)) as UnsignedDeviceIdentityBundle["nodePublicKey"],
    discoveryPublicKey: b64(deriveX25519PublicKey(discoveryPrivateKey)) as UnsignedDeviceIdentityBundle["discoveryPublicKey"],
    keySequence: 1,
    protocol: { major: 1, minor: 0 },
    capabilities: {
      required: [...INITIAL_REQUIRED_CAPABILITIES],
      optional: []
    }
  };
}

function handshakePayloads(
  hostBundleCbor: Buffer,
  hostBundleHash: Buffer,
  remoteBundleCbor: Buffer,
  remoteBundleHash: Buffer
): readonly [Buffer, Buffer, Buffer] {
  return [
    encodeCanonicalCbor(new Map<CanonicalCborValue, CanonicalCborValue>([
      [1n, 1n],
      [2n, 2n],
      [3n, remoteBundleHash]
    ])),
    encodeCanonicalCbor(new Map<CanonicalCborValue, CanonicalCborValue>([
      [1n, 1n],
      [2n, 1n],
      [3n, hostBundleCbor],
      [4n, remoteBundleHash]
    ])),
    encodeCanonicalCbor(new Map<CanonicalCborValue, CanonicalCborValue>([
      [1n, 1n],
      [2n, 2n],
      [3n, remoteBundleCbor],
      [4n, hostBundleHash]
    ]))
  ];
}

interface HandshakeFixtureInput {
  name: string;
  invitationId: Buffer;
  invitationGeneration: bigint;
  pairId: Buffer;
  hostStaticPrivateKey: Buffer;
  remoteStaticPrivateKey: Buffer;
  hostEphemeralPrivateKey: Buffer;
  remoteEphemeralPrivateKey: Buffer;
  psk?: Buffer;
  hostContribution: Buffer;
  remoteContribution: Buffer;
  hostBundleCbor: Buffer;
  hostBundleHash: Buffer;
  remoteBundleCbor: Buffer;
  remoteBundleHash: Buffer;
  hostInstallationPublicKey: Buffer;
  remoteInstallationPublicKey: Buffer;
}

function createHandshakeFixture(input: HandshakeFixtureInput): ContractJson {
  const prologue = createNoisePrologue(input);
  const payloads = handshakePayloads(
    input.hostBundleCbor,
    input.hostBundleHash,
    input.remoteBundleCbor,
    input.remoteBundleHash
  );
  const handshake = runNoiseXXHandshake({
    prologue,
    psk: input.psk,
    initiatorStaticPrivateKey: input.remoteStaticPrivateKey,
    responderStaticPrivateKey: input.hostStaticPrivateKey,
    initiatorEphemeralPrivateKey: input.remoteEphemeralPrivateKey,
    responderEphemeralPrivateKey: input.hostEphemeralPrivateKey,
    payloads
  });
  const pairKeys = derivePairKeys({
    hostContribution: input.hostContribution,
    remoteContribution: input.remoteContribution,
    channelBinding: handshake.channelBinding,
    invitationId: input.invitationId,
    invitationGeneration: input.invitationGeneration,
    pairId: input.pairId,
    hostBundleHash: input.hostBundleHash,
    remoteBundleHash: input.remoteBundleHash,
    hostInstallationPublicKey: input.hostInstallationPublicKey,
    remoteInstallationPublicKey: input.remoteInstallationPublicKey
  });
  const sas = derivePairingSas({
    channelBinding: handshake.channelBinding,
    pairId: input.pairId,
    hostBundleCbor: input.hostBundleCbor,
    remoteBundleCbor: input.remoteBundleCbor
  });
  return {
    name: input.name,
    pattern: handshake.pattern,
    inputs: {
      prologueB64: b64(prologue),
      pskB64: input.psk ? b64(input.psk) : null,
      initiatorStaticPrivateKeyB64: b64(input.remoteStaticPrivateKey),
      responderStaticPrivateKeyB64: b64(input.hostStaticPrivateKey),
      initiatorEphemeralPrivateKeyB64: b64(input.remoteEphemeralPrivateKey),
      responderEphemeralPrivateKeyB64: b64(input.hostEphemeralPrivateKey),
      initiatorStaticPublicKeyB64: b64(deriveX25519PublicKey(input.remoteStaticPrivateKey)),
      responderStaticPublicKeyB64: b64(deriveX25519PublicKey(input.hostStaticPrivateKey)),
      initiatorEphemeralPublicKeyB64: b64(deriveX25519PublicKey(input.remoteEphemeralPrivateKey)),
      responderEphemeralPublicKeyB64: b64(deriveX25519PublicKey(input.hostEphemeralPrivateKey)),
      payloadsB64: payloads.map(b64)
    },
    messagesB64: handshake.messages.map(b64),
    channelBindingB64: b64(handshake.channelBinding),
    transcriptHashB64: b64(handshake.transcriptHash),
    transport: {
      initiatorToResponderKeyB64: b64(handshake.initiatorToResponderTransportKey),
      responderToInitiatorKeyB64: b64(handshake.responderToInitiatorTransportKey),
      remoteContributionCiphertextB64: b64(encryptNoiseTransportMessage(
        handshake.initiatorToResponderTransportKey,
        input.remoteContribution
      )),
      hostContributionCiphertextB64: b64(encryptNoiseTransportMessage(
        handshake.responderToInitiatorTransportKey,
        input.hostContribution
      ))
    },
    pairContext: {
      invitationIdB64: b64(input.invitationId),
      invitationGeneration: input.invitationGeneration.toString(10),
      pairIdB64: b64(input.pairId),
      hostContributionB64: b64(input.hostContribution),
      remoteContributionB64: b64(input.remoteContribution),
      hostBundleCborB64: b64(input.hostBundleCbor),
      remoteBundleCborB64: b64(input.remoteBundleCbor),
      hostBundleHashB64: b64(input.hostBundleHash),
      remoteBundleHashB64: b64(input.remoteBundleHash),
      hostInstallationPublicKeyB64: b64(input.hostInstallationPublicKey),
      remoteInstallationPublicKeyB64: b64(input.remoteInstallationPublicKey)
    },
    derived: {
      pairRootB64: b64(pairKeys.pairRoot),
      pairKeySaltB64: b64(pairKeys.pairKeySalt),
      coordinationHostToRemoteKeyB64: b64(pairKeys.coordinationHostToRemoteKey),
      coordinationRemoteToHostKeyB64: b64(pairKeys.coordinationRemoteToHostKey),
      confirmationKeyB64: b64(pairKeys.confirmationKey),
      revocationKeyB64: b64(pairKeys.revocationKey),
      canonicalIdentityBundleHashB64: b64(sas.canonicalIdentityBundleHash),
      sasBytesB64: b64(sas.sasBytes),
      sasIndices: [...sas.indices],
      sasWords: [...sas.words],
      sasFingerprint: sas.fingerprint
    }
  };
}

function cloneCborMap(encoded: Buffer): Map<CanonicalCborValue, CanonicalCborValue> {
  const decoded = decodeCanonicalCbor(encoded);
  if (!(decoded instanceof Map)) {
    throw new TypeError("Expected fixture CBOR map.");
  }
  return new Map(decoded);
}

export function createRemotePairingV1Fixture(): ContractJson {
  const hostInstallationSeed = sequence(0x00, 32);
  const remoteInstallationSeed = sequence(0x20, 32);
  const hostIdentity = createSignedDeviceIdentityBundle(
    testIdentity(1, hostInstallationSeed, sequence(0x40, 32), sequence(0x60, 32)),
    hostInstallationSeed
  );
  const remoteIdentity = createSignedDeviceIdentityBundle(
    testIdentity(2, remoteInstallationSeed, sequence(0x80, 32), sequence(0xa0, 32)),
    remoteInstallationSeed
  );

  const fullInvitationId = sequence(0xc0, 16);
  const fullPairId = sequence(0xd0, 16);
  const fullSecret = sequence(0xe0, 32);
  const fullHostStaticPrivateKey = sequence(0x10, 32);
  const fullToken = createFullPairToken({
    invitationId: fullInvitationId,
    expiry: EXPIRY,
    hostInstallationPrivateKeySeed: hostInstallationSeed,
    hostPairingPublicKey: deriveX25519PublicKey(fullHostStaticPrivateKey),
    fullSecret
  });

  const invalidSignatureCbor = mutateLastByte(fullToken.decoded.encodedCbor);
  const invalidFingerprintMap = cloneCborMap(fullToken.decoded.encodedCbor);
  invalidFingerprintMap.set(5n, mutateLastByte(fullToken.decoded.hostInstallationFingerprint));
  const extraTokenFieldMap = cloneCborMap(fullToken.decoded.encodedCbor);
  extraTokenFieldMap.set(9n, 0n);
  const invalidVersionMap = cloneCborMap(fullToken.decoded.encodedCbor);
  invalidVersionMap.set(1n, 2n);
  const tokenBytes = fullToken.decoded.encodedCbor;
  const duplicateKeyCbor = Buffer.concat([
    Buffer.from([0xa9]),
    tokenBytes.subarray(1),
    Buffer.from([0x01, 0x01])
  ]);
  const nonShortestVersionCbor = Buffer.concat([
    tokenBytes.subarray(0, 2),
    Buffer.from([0x18, 0x01]),
    tokenBytes.subarray(3)
  ]);
  const firstPair = tokenBytes.subarray(1, 3);
  const secondPair = tokenBytes.subarray(3, 21);
  const reorderedTokenCbor = Buffer.concat([
    tokenBytes.subarray(0, 1),
    secondPair,
    firstPair,
    tokenBytes.subarray(21)
  ]);

  const invalidHostSignatureMap = cloneCborMap(hostIdentity.bundleCbor);
  invalidHostSignatureMap.set(11n, mutateLastByte(Buffer.from(hostIdentity.bundle.signature, "base64url")));
  const substitutedHostRoleMap = cloneCborMap(hostIdentity.bundleCbor);
  substitutedHostRoleMap.set(3n, 2n);
  const extraIdentityFieldMap = cloneCborMap(remoteIdentity.bundleCbor);
  extraIdentityFieldMap.set(12n, 0n);

  const fullHandshake = createHandshakeFixture({
    name: "full-token",
    invitationId: fullInvitationId,
    invitationGeneration: 1n,
    pairId: fullPairId,
    hostStaticPrivateKey: fullHostStaticPrivateKey,
    remoteStaticPrivateKey: sequence(0x30, 32),
    hostEphemeralPrivateKey: sequence(0x50, 32),
    remoteEphemeralPrivateKey: sequence(0x70, 32),
    psk: fullToken.decoded.psk,
    hostContribution: sequence(0x90, 32),
    remoteContribution: sequence(0xb0, 32),
    hostBundleCbor: hostIdentity.bundleCbor,
    hostBundleHash: hostIdentity.bundleHash,
    remoteBundleCbor: remoteIdentity.bundleCbor,
    remoteBundleHash: remoteIdentity.bundleHash,
    hostInstallationPublicKey: Buffer.from(hostIdentity.bundle.installationPublicKey, "base64url"),
    remoteInstallationPublicKey: Buffer.from(remoteIdentity.bundle.installationPublicKey, "base64url")
  });
  const shortHandshake = createHandshakeFixture({
    name: "short-code",
    invitationId: sequence(0x11, 16),
    invitationGeneration: 1n,
    pairId: sequence(0x21, 16),
    hostStaticPrivateKey: sequence(0x31, 32),
    remoteStaticPrivateKey: sequence(0x51, 32),
    hostEphemeralPrivateKey: sequence(0x71, 32),
    remoteEphemeralPrivateKey: sequence(0x91, 32),
    hostContribution: sequence(0xb1, 32),
    remoteContribution: sequence(0xd1, 32),
    hostBundleCbor: hostIdentity.bundleCbor,
    hostBundleHash: hostIdentity.bundleHash,
    remoteBundleCbor: remoteIdentity.bundleCbor,
    remoteBundleHash: remoteIdentity.bundleHash,
    hostInstallationPublicKey: Buffer.from(hostIdentity.bundle.installationPublicKey, "base64url"),
    remoteInstallationPublicKey: Buffer.from(remoteIdentity.bundle.installationPublicKey, "base64url")
  });

  return {
    schemaVersion: 1,
    implementations: {
      typescript: "node:crypto",
      go: {
        toolchain: "go1.26.5",
        module: "github.com/flynn/noise",
        version: "v1.1.0",
        commit: "4d9f71cd4ba1fe81415efac312664ccc4bc79b46"
      }
    },
    fullToken: {
      acceptedAt: ACCEPTED_AT.toString(10),
      expiry: EXPIRY.toString(10),
      encoded: fullToken.encoded,
      invitationIdB64: b64(fullToken.decoded.invitationId),
      hostInstallationSeedB64: b64(hostInstallationSeed),
      hostInstallationPublicKeyB64: b64(fullToken.decoded.hostInstallationPublicKey),
      fingerprintB64: b64(fullToken.decoded.hostInstallationFingerprint),
      hostPairingPrivateKeyB64: b64(fullHostStaticPrivateKey),
      hostPairingPublicKeyB64: b64(fullToken.decoded.hostPairingPublicKey),
      fullSecretB64: b64(fullSecret),
      unsignedCborB64: b64(fullToken.decoded.unsignedCbor),
      signatureB64: b64(fullToken.decoded.signature),
      encodedCborB64: b64(fullToken.decoded.encodedCbor),
      pskB64: b64(fullToken.decoded.psk)
    },
    identities: {
      host: {
        installationSeedB64: b64(hostInstallationSeed),
        bundle: hostIdentity.bundle as unknown as ContractJson,
        unsignedCborB64: b64(hostIdentity.unsignedCbor),
        bundleCborB64: b64(hostIdentity.bundleCbor),
        bundleHashB64: b64(hostIdentity.bundleHash)
      },
      remote: {
        installationSeedB64: b64(remoteInstallationSeed),
        bundle: remoteIdentity.bundle as unknown as ContractJson,
        unsignedCborB64: b64(remoteIdentity.unsignedCbor),
        bundleCborB64: b64(remoteIdentity.bundleCbor),
        bundleHashB64: b64(remoteIdentity.bundleHash)
      }
    },
    handshakes: [fullHandshake, shortHandshake],
    rejections: {
      canonicalCbor: [
        { name: "indefinite-map", cborB64: b64(Buffer.from("bf0101ff", "hex")) },
        { name: "non-shortest-integer", cborB64: b64(Buffer.from("1817", "hex")) },
        { name: "duplicate-map-key", cborB64: b64(Buffer.from("a201010102", "hex")) },
        { name: "reordered-map-keys", cborB64: b64(Buffer.from("a202000100", "hex")) },
        { name: "negative-integer", cborB64: b64(Buffer.from("20", "hex")) },
        { name: "invalid-utf8", cborB64: b64(Buffer.from("61ff", "hex")) },
        { name: "trailing-value", cborB64: b64(Buffer.from("0101", "hex")) }
      ],
      tokens: [
        { name: "expired", encoded: fullToken.encoded, now: EXPIRY.toString(10) },
        { name: "wrong-prefix", encoded: fullToken.encoded.replace(/^WF1\./, "WF2."), now: ACCEPTED_AT.toString(10) },
        { name: "padded-base64url", encoded: `${fullToken.encoded}=`, now: ACCEPTED_AT.toString(10) },
        { name: "invalid-signature", encoded: tokenFromCbor(invalidSignatureCbor), now: ACCEPTED_AT.toString(10) },
        { name: "invalid-fingerprint", encoded: tokenFromCbor(encodeCanonicalCbor(invalidFingerprintMap)), now: ACCEPTED_AT.toString(10) },
        { name: "extra-field", encoded: tokenFromCbor(encodeCanonicalCbor(extraTokenFieldMap)), now: ACCEPTED_AT.toString(10) },
        { name: "wrong-version", encoded: tokenFromCbor(encodeCanonicalCbor(invalidVersionMap)), now: ACCEPTED_AT.toString(10) },
        { name: "duplicate-key", encoded: tokenFromCbor(duplicateKeyCbor), now: ACCEPTED_AT.toString(10) },
        { name: "non-shortest-version", encoded: tokenFromCbor(nonShortestVersionCbor), now: ACCEPTED_AT.toString(10) },
        { name: "reordered-keys", encoded: tokenFromCbor(reorderedTokenCbor), now: ACCEPTED_AT.toString(10) }
      ],
      identityBundles: [
        { name: "invalid-signature", bundleCborB64: b64(encodeCanonicalCbor(invalidHostSignatureMap)) },
        { name: "substituted-role", bundleCborB64: b64(encodeCanonicalCbor(substitutedHostRoleMap)) },
        { name: "extra-field", bundleCborB64: b64(encodeCanonicalCbor(extraIdentityFieldMap)) }
      ],
      noise: [
        { name: "wrong-invitation", handshake: "full-token", target: "prologue", byteIndex: 16, xor: 1 },
        { name: "wrong-generation", handshake: "full-token", target: "prologue", byteIndex: 39, xor: 1 },
        { name: "wrong-pair-id", handshake: "full-token", target: "prologue", byteIndex: 40, xor: 1 },
        { name: "wrong-role-order", handshake: "full-token", target: "prologue", byteIndex: 56, xor: 3 },
        { name: "wrong-psk", handshake: "full-token", target: "psk", byteIndex: 0, xor: 1 },
        { name: "substituted-initiator-static", handshake: "full-token", target: "initiatorStaticPrivateKey", byteIndex: 1, xor: 1 },
        { name: "substituted-responder-static", handshake: "full-token", target: "responderStaticPrivateKey", byteIndex: 1, xor: 1 },
        { name: "substituted-host-bundle-payload", handshake: "full-token", target: "payload2", byteIndex: 16, xor: 1 },
        { name: "tampered-message-1", handshake: "full-token", target: "message1", byteIndex: 31, xor: 1 },
        { name: "tampered-message-2", handshake: "full-token", target: "message2", byteIndex: 95, xor: 1 },
        { name: "tampered-message-3", handshake: "full-token", target: "message3", byteIndex: 63, xor: 1 },
        { name: "unexpected-short-code-psk", handshake: "short-code", target: "addPsk", byteIndex: 0, xor: 1 }
      ]
    },
    frozenPatterns: [NOISE_XXPSK0_PATTERN, NOISE_XX_PATTERN]
  };
}

export function serializeRemotePairingFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}

export function createRemotePairingFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([
    ["fixtures/crypto/pairing-v1.json", createRemotePairingV1Fixture()]
  ]);
}
