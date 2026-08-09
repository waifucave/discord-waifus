import { createHash } from "node:crypto";
import {
  ENDPOINT_PLAINTEXT_MAX_BYTES,
  encodeEndpointAssociatedDataV1,
  encodeEndpointPlaintextV1,
  encryptEndpointAeadPayloadV1,
  encryptEndpointEnvelopeV1,
  endpointNonceV1,
  type EndpointCandidateV1,
  type EndpointDirectionKeysV1,
  type EndpointEnvelopeContextV1,
  type EndpointGenerationV1
} from "./endpointEnvelope.js";
import {
  encodeCanonicalCbor,
  type CanonicalCborValue
} from "./remotePairing.js";
import { createRemotePairingV1Fixture } from "./remotePairingContract.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

type ContractObject = { [key: string]: ContractJson };

function object(value: ContractJson | undefined, name: string): ContractObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a fixture object.`);
  }
  return value;
}

function text(value: ContractJson | undefined, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a fixture string.`);
  }
  return value;
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function cloneContext(value: EndpointEnvelopeContextV1): EndpointEnvelopeContextV1 {
  return {
    ...value,
    pairId: Buffer.from(value.pairId),
    hostInstallationBundleHash: Buffer.from(value.hostInstallationBundleHash),
    remoteInstallationBundleHash: Buffer.from(value.remoteInstallationBundleHash)
  };
}

function mutate(value: Uint8Array): Buffer {
  const result = Buffer.from(value);
  result[0] ^= 1;
  return result;
}

function contextFixture(value: EndpointEnvelopeContextV1): ContractObject {
  return {
    negotiatedMinor: value.negotiatedMinor,
    pairIdB64: b64(value.pairId),
    senderRole: value.senderRole,
    receiverRole: value.receiverRole,
    hostInstallationBundleHashB64: b64(value.hostInstallationBundleHash),
    remoteInstallationBundleHashB64: b64(value.remoteInstallationBundleHash),
    hostTrustEpoch: value.hostTrustEpoch.toString(10),
    remoteTrustEpoch: value.remoteTrustEpoch.toString(10),
    endpointEpoch: value.endpointEpoch.toString(10)
  };
}

function candidateFixture(value: EndpointCandidateV1): ContractObject {
  return {
    kind: value.kind,
    family: value.family,
    addressB64: b64(value.address),
    port: value.port,
    priority: value.priority
  };
}

function valueFixture(value: EndpointGenerationV1): ContractObject {
  return {
    version: 1,
    endpointEpoch: value.endpointEpoch.toString(10),
    connectionGeneration: value.connectionGeneration.toString(10),
    candidates: value.candidates.map(candidateFixture)
  };
}

function candidateCbor(value: {
  kind: bigint;
  family: bigint;
  address: Buffer;
  port: bigint;
  priority: bigint;
  extra?: boolean;
  missingPriority?: boolean;
}): Map<CanonicalCborValue, CanonicalCborValue> {
  const entries: Array<readonly [CanonicalCborValue, CanonicalCborValue]> = [
    [1n, value.kind],
    [2n, value.family],
    [3n, value.address],
    [4n, value.port]
  ];
  if (!value.missingPriority) {
    entries.push([5n, value.priority]);
  }
  if (value.extra) {
    entries.push([6n, 0n]);
  }
  return new Map(entries);
}

function rawEndpointCbor(input: {
  version?: bigint;
  endpointEpoch?: bigint;
  connectionGeneration?: bigint;
  candidates: readonly Map<CanonicalCborValue, CanonicalCborValue>[];
  extra?: boolean;
}): Buffer {
  const entries: Array<readonly [CanonicalCborValue, CanonicalCborValue]> = [
    [1n, input.version ?? 1n],
    [2n, input.endpointEpoch ?? 1n],
    [3n, input.connectionGeneration ?? 1n],
    [4n, input.candidates]
  ];
  if (input.extra) {
    entries.push([5n, 0n]);
  }
  return encodeCanonicalCbor(new Map(entries));
}

function rawCandidate(overrides: Partial<{
  kind: bigint;
  family: bigint;
  address: Buffer;
  port: bigint;
  priority: bigint;
  extra: boolean;
  missingPriority: boolean;
}> = {}): Map<CanonicalCborValue, CanonicalCborValue> {
  return candidateCbor({
    kind: overrides.kind ?? 1n,
    family: overrides.family ?? 4n,
    address: overrides.address ?? Buffer.from([192, 168, 1, 10]),
    port: overrides.port ?? 41_641n,
    priority: overrides.priority ?? 100n,
    extra: overrides.extra,
    missingPriority: overrides.missingPriority
  });
}

function plaintextRejections(validPlaintext: Buffer): ContractJson[] {
  const duplicate = rawCandidate();
  const safeCandidates = Array.from({ length: 13 }, (_, index) => rawCandidate({
    address: Buffer.from([10, 0, 0, index + 1]),
    priority: BigInt(100 - index)
  }));
  const noncanonical = Buffer.concat([
    validPlaintext.subarray(0, 2),
    Buffer.from([0x18, 0x01]),
    validPlaintext.subarray(3)
  ]);
  const cases: Array<readonly [string, Buffer, string]> = [
    ["wrong-version", rawEndpointCbor({ version: 2n, candidates: [rawCandidate()] }), "invalid_endpoint_record"],
    ["zero-endpoint-epoch", rawEndpointCbor({ endpointEpoch: 0n, candidates: [rawCandidate()] }), "invalid_endpoint_record"],
    ["zero-connection-generation", rawEndpointCbor({ connectionGeneration: 0n, candidates: [rawCandidate()] }), "invalid_endpoint_record"],
    ["too-many-candidates", rawEndpointCbor({ candidates: safeCandidates }), "invalid_endpoint_record"],
    ["unsorted-candidates", rawEndpointCbor({ candidates: [
      rawCandidate({ priority: 10n }),
      rawCandidate({ address: Buffer.from([192, 168, 1, 11]), priority: 20n })
    ] }), "candidates_unsorted"],
    ["duplicate-candidate", rawEndpointCbor({ candidates: [duplicate, duplicate] }), "duplicate_candidate"],
    ["relay-kind", rawEndpointCbor({ candidates: [rawCandidate({ kind: 4n })] }), "invalid_endpoint_record"],
    ["wrong-family", rawEndpointCbor({ candidates: [rawCandidate({ family: 5n })] }), "invalid_endpoint_record"],
    ["wrong-address-width", rawEndpointCbor({ candidates: [rawCandidate({ address: Buffer.alloc(5, 1) })] }), "invalid_endpoint_record"],
    ["zero-port", rawEndpointCbor({ candidates: [rawCandidate({ port: 0n })] }), "invalid_endpoint_record"],
    ["port-overflow", rawEndpointCbor({ candidates: [rawCandidate({ port: 65_536n })] }), "invalid_endpoint_record"],
    ["priority-overflow", rawEndpointCbor({ candidates: [rawCandidate({ priority: 4_294_967_296n })] }), "invalid_endpoint_record"],
    ["ipv4-unspecified", rawEndpointCbor({ candidates: [rawCandidate({ address: Buffer.alloc(4) })] }), "unsafe_candidate"],
    ["ipv4-loopback", rawEndpointCbor({ candidates: [rawCandidate({ address: Buffer.from([127, 0, 0, 1]) })] }), "unsafe_candidate"],
    ["ipv4-link-local", rawEndpointCbor({ candidates: [rawCandidate({ address: Buffer.from([169, 254, 1, 2]) })] }), "unsafe_candidate"],
    ["ipv4-multicast", rawEndpointCbor({ candidates: [rawCandidate({ address: Buffer.from([224, 0, 0, 1]) })] }), "unsafe_candidate"],
    ["ipv4-broadcast", rawEndpointCbor({ candidates: [rawCandidate({ address: Buffer.alloc(4, 255) })] }), "unsafe_candidate"],
    ["ipv6-unspecified", rawEndpointCbor({ candidates: [rawCandidate({ family: 6n, address: Buffer.alloc(16) })] }), "unsafe_candidate"],
    ["ipv6-loopback", rawEndpointCbor({ candidates: [rawCandidate({ family: 6n, address: Buffer.concat([Buffer.alloc(15), Buffer.from([1])]) })] }), "unsafe_candidate"],
    ["ipv6-link-local", rawEndpointCbor({ candidates: [rawCandidate({ family: 6n, address: Buffer.from("fe800000000000000000000000000001", "hex") })] }), "unsafe_candidate"],
    ["ipv6-multicast", rawEndpointCbor({ candidates: [rawCandidate({ family: 6n, address: Buffer.from("ff020000000000000000000000000001", "hex") })] }), "unsafe_candidate"],
    ["ipv4-mapped-ipv6", rawEndpointCbor({ candidates: [rawCandidate({ family: 6n, address: Buffer.from("00000000000000000000ffffc0000201", "hex") })] }), "unsafe_candidate"],
    ["extra-record-field", rawEndpointCbor({ candidates: [rawCandidate()], extra: true }), "invalid_endpoint_record"],
    ["missing-candidate-field", rawEndpointCbor({ candidates: [rawCandidate({ missingPriority: true })] }), "invalid_endpoint_record"],
    ["extra-candidate-field", rawEndpointCbor({ candidates: [rawCandidate({ extra: true })] }), "invalid_endpoint_record"],
    ["noncanonical-integer", noncanonical, "invalid_canonical_cbor"],
    ["trailing-cbor", Buffer.concat([validPlaintext, Buffer.from([0])]), "invalid_canonical_cbor"],
    ["plaintext-over-limit", Buffer.alloc(ENDPOINT_PLAINTEXT_MAX_BYTES + 1), "plaintext_too_large"]
  ];
  return cases.map(([name, plaintext, errorCode]) => ({
    name,
    plaintextB64: b64(plaintext),
    errorCode
  }));
}

function envelopeRejection(
  name: string,
  context: EndpointEnvelopeContextV1,
  ciphertext: Buffer,
  approved: boolean,
  errorCode: string
): ContractObject {
  return { name, context: contextFixture(context), ciphertextB64: b64(ciphertext), approved, errorCode };
}

export function createEndpointEnvelopeV1Fixture(): ContractJson {
  const pairing = object(createRemotePairingV1Fixture(), "pairing fixture");
  const handshake = object((pairing.handshakes as ContractJson[])[0], "full-token handshake");
  const pairContext = object(handshake.pairContext as ContractJson, "pair context");
  const derived = object(handshake.derived as ContractJson, "pair keys");
  const keys: EndpointDirectionKeysV1 = {
    hostToRemoteKey: Buffer.from(text(derived.coordinationHostToRemoteKeyB64, "host key"), "base64url"),
    remoteToHostKey: Buffer.from(text(derived.coordinationRemoteToHostKeyB64, "remote key"), "base64url")
  };
  const baseContext = {
    negotiatedMinor: 0,
    pairId: Buffer.from(text(pairContext.pairIdB64, "pair ID"), "base64url"),
    hostInstallationBundleHash: Buffer.from(text(pairContext.hostBundleHashB64, "host bundle hash"), "base64url"),
    remoteInstallationBundleHash: Buffer.from(text(pairContext.remoteBundleHashB64, "remote bundle hash"), "base64url"),
    hostTrustEpoch: 1n,
    remoteTrustEpoch: 2n,
    endpointEpoch: 1n
  };
  const hostContext: EndpointEnvelopeContextV1 = {
    ...baseContext,
    senderRole: 1,
    receiverRole: 2
  };
  const remoteContext: EndpointEnvelopeContextV1 = {
    ...baseContext,
    senderRole: 2,
    receiverRole: 1
  };
  const hostValue: EndpointGenerationV1 = {
    version: 1,
    endpointEpoch: 1n,
    connectionGeneration: 1n,
    candidates: [
      { kind: 1, family: 4, address: Buffer.from([192, 168, 1, 10]), port: 41_641, priority: 400 },
      { kind: 1, family: 6, address: Buffer.from("fd000000000000000000000000000001", "hex"), port: 41_641, priority: 300 },
      { kind: 2, family: 4, address: Buffer.from([203, 0, 113, 9]), port: 51_234, priority: 200 },
      { kind: 3, family: 4, address: Buffer.from([198, 51, 100, 5]), port: 41_641, priority: 100 }
    ]
  };
  const remoteValue: EndpointGenerationV1 = {
    version: 1,
    endpointEpoch: 1n,
    connectionGeneration: 1n,
    candidates: [
      { kind: 1, family: 6, address: Buffer.from("20010db8000000000000000000000009", "hex"), port: 41_641, priority: 500 },
      { kind: 1, family: 4, address: Buffer.from([10, 0, 0, 8]), port: 41_641, priority: 400 }
    ]
  };
  const maximumContext: EndpointEnvelopeContextV1 = {
    ...cloneContext(hostContext),
    endpointEpoch: 2n
  };
  const maximumValue: EndpointGenerationV1 = {
    version: 1,
    endpointEpoch: 2n,
    connectionGeneration: 1n,
    candidates: Array.from({ length: 12 }, (_, index) => ({
      kind: 1 as const,
      family: 4 as const,
      address: Buffer.from([10, 0, 1, index + 1]),
      port: 41_641 + index,
      priority: 1_000 - index
    }))
  };
  const vectors = [
    ["host-to-remote", hostContext, hostValue],
    ["remote-to-host", remoteContext, remoteValue],
    ["maximum-candidates", maximumContext, maximumValue]
  ] as const;
  const envelopes = vectors.map(([name, context, value]) => {
    const encrypted = encryptEndpointEnvelopeV1({ directionKeys: keys, context, value, approved: true });
    return {
      name,
      context: contextFixture(context),
      value: valueFixture(value),
      plaintextB64: b64(encrypted.plaintext),
      nonceB64: b64(encrypted.nonce),
      associatedDataB64: b64(encrypted.associatedData),
      ciphertextB64: b64(encrypted.ciphertext),
      ciphertextSha256B64: b64(createHash("sha256").update(encrypted.ciphertext).digest())
    };
  });
  const hostEncrypted = encryptEndpointEnvelopeV1({
    directionKeys: keys,
    context: hostContext,
    value: hostValue,
    approved: true
  });
  const tampered = Buffer.from(hostEncrypted.ciphertext);
  tampered[0] ^= 1;
  const wrongDirection = cloneContext(hostContext);
  wrongDirection.senderRole = 2;
  wrongDirection.receiverRole = 1;
  const envelopeRejections: ContractJson[] = [
    envelopeRejection("tampered-ciphertext", hostContext, tampered, true, "aead_authentication_failed"),
    envelopeRejection("wrong-direction", wrongDirection, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-pair", { ...cloneContext(hostContext), pairId: mutate(hostContext.pairId) }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-host-bundle", { ...cloneContext(hostContext), hostInstallationBundleHash: mutate(hostContext.hostInstallationBundleHash) }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-remote-bundle", { ...cloneContext(hostContext), remoteInstallationBundleHash: mutate(hostContext.remoteInstallationBundleHash) }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-host-epoch", { ...cloneContext(hostContext), hostTrustEpoch: 2n }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-remote-epoch", { ...cloneContext(hostContext), remoteTrustEpoch: 3n }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-protocol-minor", { ...cloneContext(hostContext), negotiatedMinor: 1 }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("wrong-endpoint-epoch", { ...cloneContext(hostContext), endpointEpoch: 2n }, hostEncrypted.ciphertext, true, "aead_authentication_failed"),
    envelopeRejection("same-role-context", { ...cloneContext(hostContext), receiverRole: 1 }, hostEncrypted.ciphertext, true, "invalid_context"),
    envelopeRejection("unapproved-sender", hostContext, hostEncrypted.ciphertext, false, "unapproved_sender"),
    envelopeRejection("ciphertext-over-limit", hostContext, Buffer.alloc(1_201), true, "ciphertext_too_large"),
    envelopeRejection("ciphertext-shorter-than-tag", hostContext, Buffer.alloc(15), true, "aead_authentication_failed")
  ];
  const mismatchedPlaintext = rawEndpointCbor({ endpointEpoch: 2n, candidates: [rawCandidate()] });
  envelopeRejections.push(envelopeRejection(
    "authenticated-plaintext-epoch-mismatch",
    hostContext,
    encryptEndpointAeadPayloadV1(
      keys.hostToRemoteKey,
      endpointNonceV1(hostContext.endpointEpoch),
      encodeEndpointAssociatedDataV1(hostContext),
      mismatchedPlaintext
    ),
    true,
    "epoch_mismatch"
  ));
  const advancedContext: EndpointEnvelopeContextV1 = { ...cloneContext(hostContext), endpointEpoch: 3n };
  const advancedValue: EndpointGenerationV1 = {
    version: 1,
    endpointEpoch: 3n,
    connectionGeneration: 2n,
    candidates: [
      { kind: 2, family: 4, address: Buffer.from([203, 0, 113, 10]), port: 52_000, priority: 600 }
    ]
  };
  const advancedEncrypted = encryptEndpointEnvelopeV1({
    directionKeys: keys,
    context: advancedContext,
    value: advancedValue,
    approved: true
  });
  const boundaryPlaintext = Buffer.from(Array.from(
    { length: ENDPOINT_PLAINTEXT_MAX_BYTES },
    (_, index) => index & 0xff
  ));
  const boundaryAssociatedData = encodeEndpointAssociatedDataV1(hostContext);
  const boundaryNonce = endpointNonceV1(hostContext.endpointEpoch);
  const boundaryCiphertext = encryptEndpointAeadPayloadV1(
    keys.hostToRemoteKey,
    boundaryNonce,
    boundaryAssociatedData,
    boundaryPlaintext
  );

  return {
    version: 1,
    roles: { host: 1, remote: 2 },
    limits: { candidates: 12, plaintextBytes: 1_184, ciphertextBytes: 1_200 },
    keys: {
      hostToRemoteKeyB64: b64(keys.hostToRemoteKey),
      remoteToHostKeyB64: b64(keys.remoteToHostKey)
    },
    envelopes,
    epochAdvance: {
      context: contextFixture(advancedContext),
      value: valueFixture(advancedValue),
      ciphertextB64: b64(advancedEncrypted.ciphertext)
    },
    boundary: {
      keyB64: b64(keys.hostToRemoteKey),
      nonceB64: b64(boundaryNonce),
      associatedDataB64: b64(boundaryAssociatedData),
      plaintextB64: b64(boundaryPlaintext),
      ciphertextB64: b64(boundaryCiphertext),
      overLimitPlaintextB64: b64(Buffer.alloc(ENDPOINT_PLAINTEXT_MAX_BYTES + 1)),
      maximumValidRecordBytes: Math.max(...envelopes.map((value) => Buffer.from(value.plaintextB64, "base64url").byteLength))
    },
    rejections: {
      plaintext: plaintextRejections(hostEncrypted.plaintext),
      envelopes: envelopeRejections
    }
  };
}

export function createEndpointEnvelopeFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([
    ["fixtures/crypto/endpoint-envelope-v1.json", createEndpointEnvelopeV1Fixture()]
  ]);
}

export function serializeEndpointEnvelopeFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}
