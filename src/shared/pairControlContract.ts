import { createHash } from "node:crypto";
import {
  PairControlRecordV1Schema,
  PairControlUnsignedRecordV1Schema,
  type PairControlRecordV1,
  type PairControlTypeV1,
  type PairControlUnsignedRecordV1
} from "./schemas/remoteAccess.js";
import {
  createPairControlRecordV1,
  derivePairRevocationAckMacV1,
  derivePairRevocationMacV1,
  encodePairControlSignatureInputV1,
  encodePairRevocationAckMacInputV1,
  encodePairRevocationMacInputV1,
  serializePairControlPayloadV1,
  serializePairControlRecordV1,
  type PairControlTransportV1,
  type PairRevocationContextV1
} from "./pairControl.js";
import {
  deriveEd25519PublicKey,
  signEd25519
} from "./remotePairing.js";
import { createRemotePairingV1Fixture } from "./remotePairingContract.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

type ContractObject = { [key: string]: ContractJson };

const ACCEPTED_AT = 1_786_270_830n;
const DELAYED_AT = ACCEPTED_AT + 600n;

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

function integer(value: ContractJson | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be a fixture integer.`);
  }
  return value;
}

function sequence(start: number, length: number): Buffer {
  if (start < 0 || start + length > 256) {
    throw new RangeError("Fixture byte sequence exceeds one byte.");
  }
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function hash(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function clone(value: unknown): ContractObject {
  return JSON.parse(JSON.stringify(value)) as ContractObject;
}

function mutateBase64Url(value: string, index = 0): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[index] ^= 1;
  return bytes.toString("base64url");
}

function unsignedRecord(value: ContractObject): PairControlUnsignedRecordV1 {
  const candidate = clone(value);
  delete candidate.signature;
  return PairControlUnsignedRecordV1Schema.parse(candidate);
}

function signStructurallyValidRecord(
  seed: Buffer,
  value: PairControlUnsignedRecordV1
): PairControlRecordV1 {
  return PairControlRecordV1Schema.parse({
    ...value,
    signature: signEd25519(seed, encodePairControlSignatureInputV1(value)).toString("base64url")
  });
}

function recordVector(
  name: string,
  ingressTransport: PairControlTransportV1,
  value: PairControlRecordV1
): ContractObject {
  return {
    name,
    typeName: [
      "",
      "hello",
      "capabilities",
      "endpoint_generation",
      "endpoint_ack",
      "presence",
      "reconnect",
      "revocation",
      "revocation_ack",
      "error"
    ][value.type],
    typeByte: value.type,
    ingressTransport,
    value: value as unknown as ContractJson,
    canonicalBytesB64: serializePairControlRecordV1(value).toString("base64url"),
    payloadBytesB64: serializePairControlPayloadV1(value).toString("base64url"),
    payloadSha256B64: hash(serializePairControlPayloadV1(value)).toString("base64url"),
    signatureInputB64: encodePairControlSignatureInputV1(value).toString("base64url")
  };
}

function rejection(
  name: string,
  payload: Buffer,
  errorCode: string,
  side = 1
): ContractObject {
  return {
    name,
    payloadB64: payload.toString("base64url"),
    errorCode,
    side
  };
}

function stateRejection(
  name: string,
  record: PairControlRecordV1,
  transport: PairControlTransportV1,
  errorCode: string
): ContractObject {
  return {
    name,
    payloadB64: serializePairControlRecordV1(record).toString("base64url"),
    transport,
    errorCode
  };
}

function createUnsignedRecord(
  pairId: string,
  type: PairControlTypeV1,
  side: 1 | 2,
  sequenceValue: number,
  nonceStart: number,
  payload: ContractObject,
  overrides: Partial<{
    protocolMajor: number;
    protocolMinor: number;
    connectionGeneration: string;
    timestamp: string;
    nonce: string;
  }> = {}
): PairControlUnsignedRecordV1 {
  return PairControlUnsignedRecordV1Schema.parse({
    version: 1,
    protocolMajor: overrides.protocolMajor ?? 1,
    protocolMinor: overrides.protocolMinor ?? 0,
    pairId,
    type,
    side,
    connectionGeneration: overrides.connectionGeneration ?? "1",
    sequence: sequenceValue.toString(10),
    timestamp: overrides.timestamp ?? ACCEPTED_AT.toString(10),
    nonce: overrides.nonce ?? sequence(nonceStart, 16).toString("base64url"),
    payload
  });
}

function withRevocationMac(
  seed: Buffer,
  key: Buffer,
  context: PairRevocationContextV1,
  unsigned: PairControlUnsignedRecordV1
): PairControlRecordV1 {
  const placeholder = PairControlRecordV1Schema.parse({
    ...unsigned,
    signature: Buffer.alloc(64).toString("base64url")
  });
  if (placeholder.type !== 7 && placeholder.type !== 8) {
    throw new TypeError("Expected revocation record.");
  }
  const revocationMac = placeholder.type === 7
    ? derivePairRevocationMacV1(key, placeholder, context)
    : derivePairRevocationAckMacV1(key, placeholder, context);
  return createPairControlRecordV1(seed, PairControlUnsignedRecordV1Schema.parse({
    ...unsigned,
    payload: {
      ...unsigned.payload,
      revocationMac: revocationMac.toString("base64url")
    }
  }));
}

export function createPairControlV1Fixture(): ContractJson {
  const pairing = object(createRemotePairingV1Fixture(), "pairing fixture");
  const identities = object(pairing.identities, "pairing identities");
  const hostIdentity = object(identities.host, "host identity");
  const remoteIdentity = object(identities.remote, "remote identity");
  const hostBundle = object(hostIdentity.bundle, "host bundle");
  const remoteBundle = object(remoteIdentity.bundle, "remote bundle");
  if (!Array.isArray(pairing.handshakes)) {
    throw new TypeError("Pairing handshakes must be an array.");
  }
  const full = object(
    pairing.handshakes.find((value) => object(value, "handshake").name === "full-token"),
    "full-token handshake"
  );
  const pairContext = object(full.pairContext, "pair context");
  const derived = object(full.derived, "derived keys");
  const pairId = text(pairContext.pairIdB64, "pair ID");
  const hostSeed = Buffer.from(text(hostIdentity.installationSeedB64, "host installation seed"), "base64url");
  const remoteSeed = Buffer.from(text(remoteIdentity.installationSeedB64, "remote installation seed"), "base64url");
  const revocationKey = Buffer.from(text(derived.revocationKeyB64, "revocation key"), "base64url");
  const confirmationKey = Buffer.from(text(derived.confirmationKeyB64, "confirmation key"), "base64url");
  const revocationContext = {
    pairId,
    hostBundleHash: text(pairContext.hostBundleHashB64, "host bundle hash"),
    remoteBundleHash: text(pairContext.remoteBundleHashB64, "remote bundle hash"),
    hostTrustEpoch: text(hostBundle.trustEpoch, "host trust epoch"),
    remoteTrustEpoch: text(remoteBundle.trustEpoch, "remote trust epoch")
  } as PairRevocationContextV1;
  const endpointCiphertext = sequence(0xb0, 32);
  const endpointHash = hash(endpointCiphertext).toString("base64url");
  const capabilitiesHash = hash(Buffer.from("waifus-capabilities-v1", "ascii")).toString("base64url");
  const revocationNonce = sequence(0x77, 16).toString("base64url");

  const unsignedRecords = [
    createUnsignedRecord(pairId, 1, 1, 1, 0x11, {
      resumeConnectionGeneration: "0",
      resumeSequence: "0"
    }),
    createUnsignedRecord(pairId, 2, 1, 2, 0x22, {
      capabilitiesSha256: capabilitiesHash,
      coordinationMinor: 0
    }),
    createUnsignedRecord(pairId, 3, 1, 3, 0x33, {
      endpointEpoch: "1",
      ciphertext: endpointCiphertext.toString("base64url"),
      ciphertextSha256: endpointHash
    }),
    createUnsignedRecord(pairId, 4, 1, 4, 0x44, {
      endpointEpoch: "1",
      ciphertextSha256: endpointHash
    }),
    createUnsignedRecord(pairId, 5, 1, 5, 0x55, {
      state: "online",
      validUntil: (ACCEPTED_AT + 300n).toString(10)
    }),
    createUnsignedRecord(pairId, 6, 1, 6, 0x66, {
      lastReceivedConnectionGeneration: "1",
      lastReceivedSequence: "4"
    }),
    createUnsignedRecord(pairId, 7, 1, 7, 0x77, {
      revocationEpoch: "3",
      reason: "user_revoked",
      revocationMac: Buffer.alloc(32).toString("base64url")
    }, { nonce: revocationNonce }),
    createUnsignedRecord(pairId, 8, 2, 1, 0x77, {
      revocationEpoch: "3",
      revocationMac: Buffer.alloc(32).toString("base64url")
    }, { nonce: revocationNonce }),
    createUnsignedRecord(pairId, 9, 2, 2, 0x99, {
      code: "resync_required",
      forConnectionGeneration: "1",
      forSequence: "7"
    })
  ] as const;

  const records: PairControlRecordV1[] = unsignedRecords.map((unsigned, index) => {
    const seed = unsigned.side === 1 ? hostSeed : remoteSeed;
    if (index === 6 || index === 7) {
      return withRevocationMac(seed, revocationKey, revocationContext, unsigned);
    }
    return createPairControlRecordV1(seed, unsigned);
  });
  const ingressTransports: PairControlTransportV1[] = [
    "https_publish",
    "https_publish",
    "https_publish",
    "https_publish",
    "websocket",
    "websocket",
    "https_revoke",
    "https_revocation_ack",
    "https_publish"
  ];
  const recordNames = [
    "hello",
    "capabilities",
    "endpoint-generation",
    "endpoint-ack",
    "presence",
    "reconnect",
    "revocation",
    "revocation-ack",
    "error"
  ];
  const vectors = records.map((record, index) => recordVector(
    recordNames[index],
    ingressTransports[index],
    record
  ));

  const rejections: ContractObject[] = [];
  const helloObject = clone(records[0]);
  const invalidSignature = clone(helloObject);
  invalidSignature.signature = mutateBase64Url(text(invalidSignature.signature, "signature"));
  rejections.push(rejection(
    "invalid-signature",
    Buffer.from(serializeCanonicalContractJson(invalidSignature), "utf8"),
    "invalid_signature"
  ));

  const typePayloadMismatch = clone(helloObject);
  typePayloadMismatch.type = 2;
  rejections.push(rejection(
    "type-payload-mismatch",
    Buffer.from(serializeCanonicalContractJson(typePayloadMismatch), "utf8"),
    "invalid_record"
  ));

  const payloadSubstitution = clone(helloObject);
  object(payloadSubstitution.payload, "hello payload").resumeSequence = "1";
  rejections.push(rejection(
    "payload-substitution",
    Buffer.from(serializeCanonicalContractJson(payloadSubstitution), "utf8"),
    "invalid_signature"
  ));

  const sideSubstitution = clone(helloObject);
  sideSubstitution.side = 2;
  rejections.push(rejection(
    "side-substitution",
    Buffer.from(serializeCanonicalContractJson(sideSubstitution), "utf8"),
    "invalid_signature",
    2
  ));

  const nonceSubstitution = clone(helloObject);
  nonceSubstitution.nonce = sequence(0xf0, 16).toString("base64url");
  rejections.push(rejection(
    "nonce-substitution",
    Buffer.from(serializeCanonicalContractJson(nonceSubstitution), "utf8"),
    "invalid_signature"
  ));

  rejections.push({
    name: "wrong-authenticated-side",
    payloadB64: serializePairControlRecordV1(records[0]).toString("base64url"),
    errorCode: "wrong_side",
    keySide: 1,
    expectedSide: 2
  });
  rejections.push({
    name: "wrong-installation-key",
    payloadB64: serializePairControlRecordV1(records[0]).toString("base64url"),
    errorCode: "invalid_signature",
    keySide: 2,
    expectedSide: 1
  });

  const extraField = clone(helloObject);
  extraField.recordType = "hello";
  rejections.push(rejection(
    "extra-field",
    Buffer.from(serializeCanonicalContractJson(extraField), "utf8"),
    "invalid_record"
  ));

  const missingSignature = clone(helloObject);
  delete missingSignature.signature;
  rejections.push(rejection(
    "missing-signature",
    Buffer.from(serializeCanonicalContractJson(missingSignature), "utf8"),
    "invalid_record"
  ));

  rejections.push(rejection(
    "noncanonical-leading-whitespace",
    Buffer.concat([Buffer.from(" ", "ascii"), serializePairControlRecordV1(records[0])]),
    "invalid_canonical_payload"
  ));

  const wrongPairObject = clone(helloObject);
  wrongPairObject.pairId = mutateBase64Url(pairId);
  const wrongPair = signStructurallyValidRecord(hostSeed, unsignedRecord(wrongPairObject));
  rejections.push(rejection(
    "wrong-pair",
    serializePairControlRecordV1(wrongPair),
    "wrong_pair"
  ));

  const wrongProtocolObject = clone(helloObject);
  wrongProtocolObject.protocolMinor = 1;
  const wrongProtocol = signStructurallyValidRecord(hostSeed, unsignedRecord(wrongProtocolObject));
  rejections.push(rejection(
    "protocol-mismatch",
    serializePairControlRecordV1(wrongProtocol),
    "protocol_mismatch"
  ));

  const staleTimestampObject = clone(helloObject);
  staleTimestampObject.timestamp = (ACCEPTED_AT - 61n).toString(10);
  const staleTimestamp = signStructurallyValidRecord(hostSeed, unsignedRecord(staleTimestampObject));
  rejections.push(rejection(
    "stale-first-ingress-timestamp",
    serializePairControlRecordV1(staleTimestamp),
    "timestamp_out_of_window"
  ));

  const futureTimestampObject = clone(helloObject);
  futureTimestampObject.timestamp = (ACCEPTED_AT + 61n).toString(10);
  const futureTimestamp = signStructurallyValidRecord(hostSeed, unsignedRecord(futureTimestampObject));
  rejections.push(rejection(
    "future-first-ingress-timestamp",
    serializePairControlRecordV1(futureTimestamp),
    "timestamp_out_of_window"
  ));

  const badEndpointHashObject = clone(records[2]);
  const badEndpointPayload = object(badEndpointHashObject.payload, "endpoint payload");
  badEndpointPayload.ciphertextSha256 = mutateBase64Url(text(badEndpointPayload.ciphertextSha256, "ciphertext hash"));
  badEndpointHashObject.payload = badEndpointPayload;
  const badEndpointHash = signStructurallyValidRecord(hostSeed, unsignedRecord(badEndpointHashObject));
  rejections.push(rejection(
    "endpoint-ciphertext-hash-mismatch",
    serializePairControlRecordV1(badEndpointHash),
    "invalid_payload_hash"
  ));

  const oversizedCiphertextRecord = clone(records[2]);
  const oversizedCiphertextPayload = object(oversizedCiphertextRecord.payload, "endpoint payload");
  const oversizedCiphertext = Buffer.alloc(1_201, 0xa6);
  oversizedCiphertextPayload.ciphertext = oversizedCiphertext.toString("base64url");
  oversizedCiphertextPayload.ciphertextSha256 = hash(oversizedCiphertext).toString("base64url");
  oversizedCiphertextRecord.payload = oversizedCiphertextPayload;
  rejections.push(rejection(
    "endpoint-ciphertext-1201-bytes",
    Buffer.from(serializeCanonicalContractJson(oversizedCiphertextRecord), "utf8"),
    "invalid_record"
  ));

  const missingMacObject = clone(records[6]);
  const missingMacPayload = object(missingMacObject.payload, "revocation payload");
  delete missingMacPayload.revocationMac;
  missingMacObject.payload = missingMacPayload;
  rejections.push(rejection(
    "missing-revocation-mac",
    Buffer.from(serializeCanonicalContractJson(missingMacObject), "utf8"),
    "invalid_record"
  ));

  const maximumCiphertext = Buffer.alloc(1_200, 0xa5);
  const maximumUnsigned = createUnsignedRecord(pairId, 3, 1, 1, 0xa1, {
    endpointEpoch: "1",
    ciphertext: maximumCiphertext.toString("base64url"),
    ciphertextSha256: hash(maximumCiphertext).toString("base64url")
  });
  const maximumRecord = createPairControlRecordV1(hostSeed, maximumUnsigned);
  const maximumRecordBytes = serializePairControlRecordV1(maximumRecord);

  const tupleConflictObject = clone(records[8]);
  const tupleConflictPayload = object(tupleConflictObject.payload, "error payload");
  tupleConflictPayload.code = "revoked";
  tupleConflictObject.payload = tupleConflictPayload;
  const tupleConflict = signStructurallyValidRecord(remoteSeed, unsignedRecord(tupleConflictObject));

  const nonceReuse = createPairControlRecordV1(hostSeed, createUnsignedRecord(
    pairId,
    1,
    1,
    8,
    0x11,
    { resumeConnectionGeneration: "1", resumeSequence: "7" },
    { nonce: records[0].nonce }
  ));
  const badGenerationStart = createPairControlRecordV1(hostSeed, createUnsignedRecord(
    pairId,
    1,
    1,
    2,
    0xc1,
    { resumeConnectionGeneration: "1", resumeSequence: "7" },
    { connectionGeneration: "2" }
  ));
  const generationAdvance = createPairControlRecordV1(hostSeed, createUnsignedRecord(
    pairId,
    1,
    1,
    1,
    0xc2,
    { resumeConnectionGeneration: "1", resumeSequence: "7" },
    { connectionGeneration: "2" }
  ));
  const staleGeneration = createPairControlRecordV1(hostSeed, createUnsignedRecord(
    pairId,
    1,
    1,
    8,
    0xd2,
    { resumeConnectionGeneration: "1", resumeSequence: "7" }
  ));

  const wrongMacObject = clone(records[6]);
  const wrongMacPayload = object(wrongMacObject.payload, "wrong revocation payload");
  wrongMacPayload.revocationMac = mutateBase64Url(text(wrongMacPayload.revocationMac, "revocation MAC"));
  wrongMacObject.payload = wrongMacPayload;
  const workerOpaqueWrongMac = signStructurallyValidRecord(hostSeed, unsignedRecord(wrongMacObject));

  const revocationRejections: ContractObject[] = [];
  function addRevocationRejection(
    name: string,
    record: PairControlRecordV1,
    options: { key?: Buffer; context?: PairRevocationContextV1 } = {}
  ): void {
    revocationRejections.push({
      name,
      value: record as unknown as ContractJson,
      ...(options.key ? { keyB64: options.key.toString("base64url") } : {}),
      ...(options.context ? { context: options.context as unknown as ContractJson } : {})
    });
  }

  addRevocationRejection("wrong-mac", workerOpaqueWrongMac);
  addRevocationRejection("confirmation-key-reuse", records[6], { key: confirmationKey });

  for (const [name, mutate] of [
    ["revocation-epoch", (value: ContractObject) => {
      object(value.payload, "revocation payload").revocationEpoch = "4";
    }],
    ["revocation-reason", (value: ContractObject) => {
      object(value.payload, "revocation payload").reason = "identity_reset";
    }],
    ["revocation-nonce", (value: ContractObject) => {
      value.nonce = sequence(0xd1, 16).toString("base64url");
    }],
    ["revocation-side", (value: ContractObject) => {
      value.side = 2;
    }]
  ] as Array<readonly [string, (value: ContractObject) => void]>) {
    const substituted = clone(records[6]);
    mutate(substituted);
    const seed = integer(substituted.side, "revocation side") === 1 ? hostSeed : remoteSeed;
    addRevocationRejection(name, signStructurallyValidRecord(seed, unsignedRecord(substituted)));
  }

  for (const [name, field, replacement] of [
    ["context-pair", "pairId", mutateBase64Url(revocationContext.pairId)],
    ["context-host-bundle", "hostBundleHash", mutateBase64Url(revocationContext.hostBundleHash)],
    ["context-remote-bundle", "remoteBundleHash", mutateBase64Url(revocationContext.remoteBundleHash)],
    ["context-host-trust-epoch", "hostTrustEpoch", "3"],
    ["context-remote-trust-epoch", "remoteTrustEpoch", "4"]
  ] as Array<readonly [string, keyof PairRevocationContextV1, string]>) {
    addRevocationRejection(name, records[6], {
      context: { ...revocationContext, [field]: replacement }
    });
  }

  const ackEpoch = clone(records[7]);
  object(ackEpoch.payload, "ack payload").revocationEpoch = "4";
  addRevocationRejection(
    "ack-revocation-epoch",
    signStructurallyValidRecord(remoteSeed, unsignedRecord(ackEpoch))
  );
  const ackNonce = clone(records[7]);
  ackNonce.nonce = sequence(0xe1, 16).toString("base64url");
  addRevocationRejection(
    "ack-record-nonce",
    signStructurallyValidRecord(remoteSeed, unsignedRecord(ackNonce))
  );

  const revocationRecord = records[6];
  const revocationAck = records[7];
  if (revocationRecord.type !== 7 || revocationAck.type !== 8) {
    throw new TypeError("Expected typed revocation records.");
  }

  return {
    schemaVersion: 1,
    acceptedAt: ACCEPTED_AT.toString(10),
    delayedAt: DELAYED_AT.toString(10),
    installationSeeds: {
      host: hostSeed.toString("base64url"),
      remote: remoteSeed.toString("base64url")
    },
    installationPublicKeys: {
      host: deriveEd25519PublicKey(hostSeed).toString("base64url"),
      remote: deriveEd25519PublicKey(remoteSeed).toString("base64url")
    },
    context: {
      pairId,
      protocolMajor: 1,
      protocolMinor: 0
    },
    records: vectors,
    transportMatrix: {
      websocket: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      https_publish: [1, 2, 3, 4, 5, 6, 9],
      https_revoke: [7],
      https_revocation_ack: [8],
      https_poll: [1, 2, 3, 4, 5, 6, 7, 8, 9]
    },
    rejections,
    stateRejections: [
      stateRejection("stale-sequence", records[5], "websocket", "stale_sequence"),
      stateRejection("same-tuple-different-bytes", tupleConflict, "https_publish", "tuple_conflict"),
      stateRejection("reused-side-nonce", nonceReuse, "websocket", "nonce_reused"),
      stateRejection("higher-generation-not-sequence-one", badGenerationStart, "websocket", "invalid_generation_start"),
      stateRejection("poll-is-delivery-only", records[8], "https_poll", "wrong_transport")
    ],
    generationTransition: {
      advancePayloadB64: serializePairControlRecordV1(generationAdvance).toString("base64url"),
      stalePayloadB64: serializePairControlRecordV1(staleGeneration).toString("base64url")
    },
    boundary: {
      maximumDecodedCiphertextBytes: 1_200,
      maximumRecordBytes: maximumRecordBytes.byteLength,
      maximumRecordB64: maximumRecordBytes.toString("base64url"),
      maximumRecord: maximumRecord as unknown as ContractJson,
      rawRecordLimit: 2_048,
      overLimitPayloadB64: Buffer.alloc(2_049, 0x20).toString("base64url")
    },
    revocation: {
      revocationKeyB64: revocationKey.toString("base64url"),
      confirmationKeyB64: confirmationKey.toString("base64url"),
      context: revocationContext as unknown as ContractJson,
      revocationMacInputB64: encodePairRevocationMacInputV1(
        revocationRecord,
        revocationContext
      ).toString("base64url"),
      revocationAckMacInputB64: encodePairRevocationAckMacInputV1(
        revocationAck,
        revocationContext
      ).toString("base64url"),
      rejections: revocationRejections,
      workerOpaqueWrongMac: recordVector(
        "worker-opaque-wrong-revocation-mac",
        "https_revoke",
        workerOpaqueWrongMac
      )
    }
  };
}

export function serializePairControlFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}

export function createPairControlFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([
    ["fixtures/crypto/pair-control-record-v1.json", createPairControlV1Fixture()]
  ]);
}
