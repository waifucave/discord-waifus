import {
  createPairConfirmationV1,
  encodePairConfirmationMacInput,
  serializePairConfirmationV1,
  type PairConfirmationUnsignedV1
} from "./pairConfirmation.js";
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

function sequence(start: number, length: number): Buffer {
  if (start < 0 || start + length > 256) {
    throw new RangeError("Fixture byte sequence exceeds one byte.");
  }
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function mutateBase64Url(value: string, index = 0): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[index] ^= 1;
  return bytes.toString("base64url");
}

function clone(value: ContractObject): ContractObject {
  return JSON.parse(JSON.stringify(value)) as ContractObject;
}

function canonicalPayload(value: ContractJson): Buffer {
  return Buffer.from(serializeCanonicalContractJson(value), "utf8");
}

function rejection(
  name: string,
  value: ContractJson,
  errorCode: string,
  keyB64?: string
): ContractObject {
  return {
    name,
    payloadB64: canonicalPayload(value).toString("base64url"),
    errorCode,
    ...(keyB64 ? { keyB64 } : {})
  };
}

export function createPairConfirmationV1Fixture(): ContractJson {
  const pairing = object(createRemotePairingV1Fixture(), "pairing fixture");
  if (!Array.isArray(pairing.handshakes)) {
    throw new TypeError("Pairing fixture handshakes must be an array.");
  }
  const full = object(
    pairing.handshakes.find((value) => object(value, "handshake").name === "full-token"),
    "full-token handshake"
  );
  const context = object(full.pairContext, "pair context");
  const derived = object(full.derived, "pair derivation");
  const confirmationKeyB64 = text(derived.confirmationKeyB64, "confirmation key");
  const confirmationKey = Buffer.from(confirmationKeyB64, "base64url");
  const common = {
    version: 1 as const,
    invitationId: text(context.invitationIdB64, "invitation ID") as PairConfirmationUnsignedV1["invitationId"],
    invitationGeneration: text(context.invitationGeneration, "invitation generation") as PairConfirmationUnsignedV1["invitationGeneration"],
    pairId: text(context.pairIdB64, "pair ID") as PairConfirmationUnsignedV1["pairId"],
    transcriptHash: text(full.transcriptHashB64, "transcript hash") as PairConfirmationUnsignedV1["transcriptHash"],
    channelBinding: text(full.channelBindingB64, "channel binding") as PairConfirmationUnsignedV1["channelBinding"],
    hostBundleHash: text(context.hostBundleHashB64, "host bundle hash") as PairConfirmationUnsignedV1["hostBundleHash"],
    remoteBundleHash: text(context.remoteBundleHashB64, "remote bundle hash") as PairConfirmationUnsignedV1["remoteBundleHash"],
    approvalContextHash: sequence(0x55, 32).toString("base64url") as PairConfirmationUnsignedV1["approvalContextHash"]
  };
  const hostUnsigned: PairConfirmationUnsignedV1 = {
    ...common,
    side: 1,
    confirmationNonce: sequence(0x61, 16).toString("base64url") as PairConfirmationUnsignedV1["confirmationNonce"]
  };
  const remoteUnsigned: PairConfirmationUnsignedV1 = {
    ...common,
    side: 2,
    confirmationNonce: sequence(0x71, 16).toString("base64url") as PairConfirmationUnsignedV1["confirmationNonce"]
  };
  const host = createPairConfirmationV1(confirmationKey, hostUnsigned);
  const remote = createPairConfirmationV1(confirmationKey, remoteUnsigned);
  const hostObject = host as unknown as ContractObject;
  const remoteObject = remote as unknown as ContractObject;

  const substitutions: Array<readonly [string, keyof ContractObject, ContractJson]> = [
    ["invitation-id", "invitationId", mutateBase64Url(host.invitationId)],
    ["invitation-generation", "invitationGeneration", "2"],
    ["pair-id", "pairId", mutateBase64Url(host.pairId)],
    ["side", "side", 2],
    ["transcript-hash", "transcriptHash", mutateBase64Url(host.transcriptHash)],
    ["channel-binding", "channelBinding", mutateBase64Url(host.channelBinding)],
    ["host-bundle-hash", "hostBundleHash", mutateBase64Url(host.hostBundleHash)],
    ["remote-bundle-hash", "remoteBundleHash", mutateBase64Url(host.remoteBundleHash)],
    ["approval-context-hash", "approvalContextHash", mutateBase64Url(host.approvalContextHash)],
    ["confirmation-nonce", "confirmationNonce", mutateBase64Url(host.confirmationNonce)]
  ];
  const rejections = substitutions.map(([name, field, replacement]) => {
    const substituted = clone(hostObject);
    substituted[field] = replacement;
    return rejection(`substituted-${name}`, substituted, "invalid_mac");
  });

  const wrongMac = clone(hostObject);
  wrongMac.confirmationMac = mutateBase64Url(host.confirmationMac);
  rejections.push(rejection("wrong-mac", wrongMac, "invalid_mac"));

  const extraField = clone(hostObject);
  extraField.recordType = "pair_confirmation";
  rejections.push(rejection("extra-field", extraField, "invalid_record"));

  const missingField = clone(hostObject);
  delete missingField.approvalContextHash;
  rejections.push(rejection("missing-field", missingField, "invalid_record"));

  const numericGeneration = clone(hostObject);
  numericGeneration.invitationGeneration = 1;
  rejections.push(rejection("numeric-generation", numericGeneration, "invalid_record"));

  const selfPair = clone(hostObject);
  selfPair.remoteBundleHash = selfPair.hostBundleHash;
  rejections.push(rejection("identical-bundle-hashes", selfPair, "invalid_record"));

  const wrongKey = sequence(0x91, 32).toString("base64url");
  rejections.push(rejection("wrong-confirmation-key", hostObject, "invalid_mac", wrongKey));

  rejections.push({
    name: "noncanonical-leading-whitespace",
    payloadB64: Buffer.concat([
      Buffer.from(" ", "ascii"),
      serializePairConfirmationV1(host)
    ]).toString("base64url"),
    errorCode: "invalid_canonical_payload"
  });

  return {
    schemaVersion: 1,
    confirmationKeyB64,
    records: {
      host: {
        value: hostObject,
        canonicalBytesB64: serializePairConfirmationV1(host).toString("base64url"),
        macInputB64: encodePairConfirmationMacInput(hostUnsigned).toString("base64url")
      },
      remote: {
        value: remoteObject,
        canonicalBytesB64: serializePairConfirmationV1(remote).toString("base64url"),
        macInputB64: encodePairConfirmationMacInput(remoteUnsigned).toString("base64url")
      }
    },
    rejections,
    boundary: {
      maximumPayloadBytes: 1_024,
      atLimitPayloadB64: Buffer.alloc(1_024, 0x20).toString("base64url"),
      atLimitOutcome: "invalid_canonical_payload",
      overLimitPayloadB64: Buffer.alloc(1_025, 0x20).toString("base64url"),
      overLimitOutcome: "payload_too_large"
    },
    ordering: {
      valid: ["approve", "publish_local", "poll_verify_peer", "consume"],
      idempotent: ["publish_same_local", "verify_same_peer", "consume_same"],
      rejected: [
        "publish_pre_approval",
        "verify_before_local_publish",
        "noise_transport_record_type",
        "consume_before_peer_verify",
        "different_second_confirmation",
        "publish_post_consume",
        "publish_post_cancel",
        "publish_post_expiry"
      ]
    }
  };
}

export function serializePairConfirmationFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}

export function createPairConfirmationFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([
    ["fixtures/crypto/pair-confirmation-v1.json", createPairConfirmationV1Fixture()]
  ]);
}
