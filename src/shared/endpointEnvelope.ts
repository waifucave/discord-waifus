import {
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual
} from "node:crypto";
import {
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  type CanonicalCborValue
} from "./remotePairing.js";
import { UINT64_MAX } from "./schemas/remoteProtocol.js";

export const ENDPOINT_PLAINTEXT_MAX_BYTES = 1_184;
export const ENDPOINT_CIPHERTEXT_MAX_BYTES = 1_200;
export const ENDPOINT_CANDIDATE_MAX_COUNT = 12;

const ENDPOINT_DOMAIN = Buffer.from("waifus-endpoint-envelope/v1", "ascii");
const CHACHA20_POLY1305_TAG_BYTES = 16;

export type EndpointRoleV1 = 1 | 2;
export type EndpointCandidateKindV1 = 1 | 2 | 3;
export type EndpointAddressFamilyV1 = 4 | 6;

export interface EndpointCandidateV1 {
  kind: EndpointCandidateKindV1;
  family: EndpointAddressFamilyV1;
  address: Uint8Array;
  port: number;
  priority: number;
}

export interface EndpointGenerationV1 {
  version: 1;
  endpointEpoch: bigint;
  connectionGeneration: bigint;
  candidates: readonly EndpointCandidateV1[];
}

export interface EndpointEnvelopeContextV1 {
  negotiatedMinor: number;
  pairId: Uint8Array;
  senderRole: EndpointRoleV1;
  receiverRole: EndpointRoleV1;
  hostInstallationBundleHash: Uint8Array;
  remoteInstallationBundleHash: Uint8Array;
  hostTrustEpoch: bigint;
  remoteTrustEpoch: bigint;
  endpointEpoch: bigint;
}

export interface EndpointDirectionKeysV1 {
  hostToRemoteKey: Uint8Array;
  remoteToHostKey: Uint8Array;
}

export type EndpointProtocolErrorCode =
  | "plaintext_too_large"
  | "ciphertext_too_large"
  | "invalid_canonical_cbor"
  | "invalid_endpoint_record"
  | "unsafe_candidate"
  | "duplicate_candidate"
  | "candidates_unsorted"
  | "invalid_context"
  | "unapproved_sender"
  | "aead_authentication_failed"
  | "epoch_mismatch"
  | "epoch_conflict"
  | "epoch_rollback"
  | "invalid_initial_epoch"
  | "no_prepared_endpoint";

export class EndpointProtocolError extends Error {
  constructor(
    readonly code: EndpointProtocolErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "EndpointProtocolError";
  }
}

function fail(code: EndpointProtocolErrorCode, detail: string): never {
  throw new EndpointProtocolError(code, detail);
}

function sha256(...values: readonly Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
  }
  return hash.digest();
}

function fixedBytes(value: Uint8Array, expected: number, name: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== expected) {
    throw new RangeError(`${name} must be exactly ${expected} bytes.`);
  }
  return bytes;
}

function uint16BE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("value must be a uint16 integer.");
  }
  const encoded = Buffer.alloc(2);
  encoded.writeUInt16BE(value);
  return encoded;
}

function uint32BE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be a uint32 integer.");
  }
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(value);
  return encoded;
}

function assertUint64(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${name} must be a uint64 bigint.`);
  }
  return value;
}

function uint64BE(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(assertUint64(value, "value"));
  return encoded;
}

function lengthPrefix(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32BE(bytes.byteLength), bytes]);
}

function isAll(value: Buffer, byte: number): boolean {
  return value.every((candidate) => candidate === byte);
}

function isUnsafeAddress(family: EndpointAddressFamilyV1, address: Buffer): boolean {
  if (family === 4) {
    return isAll(address, 0)
      || address[0] === 127
      || (address[0] === 169 && address[1] === 254)
      || (address[0] >= 224 && address[0] <= 239)
      || isAll(address, 255);
  }
  return isAll(address, 0)
    || (address.subarray(0, 15).every((value) => value === 0) && address[15] === 1)
    || (address[0] === 0xfe && (address[1] & 0xc0) === 0x80)
    || address[0] === 0xff
    || (address.subarray(0, 10).every((value) => value === 0)
      && address[10] === 0xff
      && address[11] === 0xff);
}

function candidateIdentity(value: EndpointCandidateV1): string {
  return `${value.kind}:${value.family}:${Buffer.from(value.address).toString("hex")}:${value.port}`;
}

function compareCandidates(left: EndpointCandidateV1, right: EndpointCandidateV1): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  if (left.kind !== right.kind) {
    return left.kind - right.kind;
  }
  if (left.family !== right.family) {
    return left.family - right.family;
  }
  const addressOrder = Buffer.compare(Buffer.from(left.address), Buffer.from(right.address));
  return addressOrder !== 0 ? addressOrder : left.port - right.port;
}

function validateCandidate(value: EndpointCandidateV1, index: number): EndpointCandidateV1 {
  if (value.kind !== 1 && value.kind !== 2 && value.kind !== 3) {
    return fail("invalid_endpoint_record", `candidate ${index} has an unknown or relay kind.`);
  }
  if (value.family !== 4 && value.family !== 6) {
    return fail("invalid_endpoint_record", `candidate ${index} has an unknown address family.`);
  }
  const address = Buffer.from(value.address);
  const expectedAddressBytes = value.family === 4 ? 4 : 16;
  if (address.byteLength !== expectedAddressBytes) {
    return fail(
      "invalid_endpoint_record",
      `candidate ${index} address must be exactly ${expectedAddressBytes} bytes.`
    );
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
    return fail("invalid_endpoint_record", `candidate ${index} port is outside 1-65535.`);
  }
  if (!Number.isInteger(value.priority) || value.priority < 0 || value.priority > 0xffff_ffff) {
    return fail("invalid_endpoint_record", `candidate ${index} priority is not a uint32.`);
  }
  if (isUnsafeAddress(value.family, address)) {
    return fail("unsafe_candidate", `candidate ${index} is not a probe-safe unicast address.`);
  }
  return {
    kind: value.kind,
    family: value.family,
    address,
    port: value.port,
    priority: value.priority
  };
}

function validateEndpointGeneration(value: EndpointGenerationV1): EndpointGenerationV1 {
  if (value.version !== 1) {
    return fail("invalid_endpoint_record", "endpoint record version must be 1.");
  }
  const endpointEpoch = assertUint64(value.endpointEpoch, "endpoint epoch");
  const connectionGeneration = assertUint64(value.connectionGeneration, "connection generation");
  if (endpointEpoch < 1n || connectionGeneration < 1n) {
    return fail("invalid_endpoint_record", "endpoint epoch and connection generation must be positive.");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > ENDPOINT_CANDIDATE_MAX_COUNT) {
    return fail("invalid_endpoint_record", "endpoint record contains more than 12 candidates.");
  }
  const candidates = value.candidates.map(validateCandidate);
  const identities = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const identity = candidateIdentity(candidates[index]);
    if (identities.has(identity)) {
      return fail("duplicate_candidate", `candidate ${index} duplicates an earlier endpoint.`);
    }
    identities.add(identity);
    if (index > 0 && compareCandidates(candidates[index - 1], candidates[index]) > 0) {
      return fail("candidates_unsorted", "endpoint candidates are not in deterministic order.");
    }
  }
  return { version: 1, endpointEpoch, connectionGeneration, candidates };
}

function candidateCbor(value: EndpointCandidateV1): Map<CanonicalCborValue, CanonicalCborValue> {
  return new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, BigInt(value.kind)],
    [2n, BigInt(value.family)],
    [3n, Buffer.from(value.address)],
    [4n, BigInt(value.port)],
    [5n, BigInt(value.priority)]
  ]);
}

export function encodeEndpointPlaintextV1(value: EndpointGenerationV1): Buffer {
  const parsed = validateEndpointGeneration(value);
  const encoded = encodeCanonicalCbor(new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, 1n],
    [2n, parsed.endpointEpoch],
    [3n, parsed.connectionGeneration],
    [4n, parsed.candidates.map(candidateCbor)]
  ]));
  if (encoded.byteLength > ENDPOINT_PLAINTEXT_MAX_BYTES) {
    return fail("plaintext_too_large", "canonical endpoint plaintext exceeds 1,184 bytes.");
  }
  return encoded;
}

function exactMap(
  value: CanonicalCborValue,
  keys: readonly bigint[],
  name: string
): ReadonlyMap<CanonicalCborValue, CanonicalCborValue> {
  if (!(value instanceof Map) || value.size !== keys.length) {
    return fail("invalid_endpoint_record", `${name} must be an exact canonical CBOR map.`);
  }
  for (const key of keys) {
    if (!value.has(key)) {
      return fail("invalid_endpoint_record", `${name} is missing integer key ${key}.`);
    }
  }
  return value;
}

function cborUint(value: CanonicalCborValue | undefined, name: string): bigint {
  if (typeof value !== "bigint") {
    return fail("invalid_endpoint_record", `${name} must be a CBOR unsigned integer.`);
  }
  return value;
}

function numberFromUint(value: bigint, maximum: number, name: string): number {
  if (value > BigInt(maximum)) {
    return fail("invalid_endpoint_record", `${name} exceeds its integer range.`);
  }
  return Number(value);
}

export function decodeEndpointPlaintextV1(payload: Uint8Array): EndpointGenerationV1 {
  const bytes = Buffer.from(payload);
  if (bytes.byteLength > ENDPOINT_PLAINTEXT_MAX_BYTES) {
    return fail("plaintext_too_large", "endpoint plaintext exceeds 1,184 bytes.");
  }
  let decoded: CanonicalCborValue;
  try {
    decoded = decodeCanonicalCbor(bytes, ENDPOINT_PLAINTEXT_MAX_BYTES);
  } catch {
    return fail("invalid_canonical_cbor", "endpoint plaintext is not deterministic RFC 8949 CBOR.");
  }
  const map = exactMap(decoded, [1n, 2n, 3n, 4n], "endpoint record");
  const version = cborUint(map.get(1n), "endpoint version");
  if (version !== 1n) {
    return fail("invalid_endpoint_record", "endpoint record version must be 1.");
  }
  const candidatesValue = map.get(4n);
  if (!Array.isArray(candidatesValue)) {
    return fail("invalid_endpoint_record", "endpoint candidates must be a CBOR array.");
  }
  const candidates = candidatesValue.map((candidateValue, index): EndpointCandidateV1 => {
    const candidate = exactMap(candidateValue, [1n, 2n, 3n, 4n, 5n], `candidate ${index}`);
    const address = candidate.get(3n);
    if (!Buffer.isBuffer(address)) {
      return fail("invalid_endpoint_record", `candidate ${index} address must be CBOR bytes.`);
    }
    return {
      kind: numberFromUint(cborUint(candidate.get(1n), "candidate kind"), 255, "candidate kind") as EndpointCandidateKindV1,
      family: numberFromUint(cborUint(candidate.get(2n), "candidate family"), 255, "candidate family") as EndpointAddressFamilyV1,
      address,
      port: numberFromUint(cborUint(candidate.get(4n), "candidate port"), 65_535, "candidate port"),
      priority: numberFromUint(cborUint(candidate.get(5n), "candidate priority"), 0xffff_ffff, "candidate priority")
    };
  });
  return validateEndpointGeneration({
    version: 1,
    endpointEpoch: cborUint(map.get(2n), "endpoint epoch"),
    connectionGeneration: cborUint(map.get(3n), "connection generation"),
    candidates
  });
}

function validateContext(value: EndpointEnvelopeContextV1): EndpointEnvelopeContextV1 {
  if (!Number.isInteger(value.negotiatedMinor) || value.negotiatedMinor < 0 || value.negotiatedMinor > 65_535) {
    return fail("invalid_context", "negotiated minor must be a uint16.");
  }
  if (
    (value.senderRole !== 1 && value.senderRole !== 2)
    || (value.receiverRole !== 1 && value.receiverRole !== 2)
    || value.senderRole === value.receiverRole
  ) {
    return fail("invalid_context", "sender and receiver must be distinct host/remote roles.");
  }
  const pairId = fixedBytes(value.pairId, 16, "pair ID");
  const hostInstallationBundleHash = fixedBytes(
    value.hostInstallationBundleHash,
    32,
    "host installation bundle hash"
  );
  const remoteInstallationBundleHash = fixedBytes(
    value.remoteInstallationBundleHash,
    32,
    "remote installation bundle hash"
  );
  if (timingSafeEqual(hostInstallationBundleHash, remoteInstallationBundleHash)) {
    return fail("invalid_context", "host and remote bundle hashes must differ.");
  }
  const endpointEpoch = assertUint64(value.endpointEpoch, "endpoint epoch");
  if (endpointEpoch < 1n) {
    return fail("invalid_context", "endpoint epoch must be positive.");
  }
  return {
    negotiatedMinor: value.negotiatedMinor,
    pairId,
    senderRole: value.senderRole,
    receiverRole: value.receiverRole,
    hostInstallationBundleHash,
    remoteInstallationBundleHash,
    hostTrustEpoch: assertUint64(value.hostTrustEpoch, "host trust epoch"),
    remoteTrustEpoch: assertUint64(value.remoteTrustEpoch, "remote trust epoch"),
    endpointEpoch
  };
}

export function encodeEndpointAssociatedDataV1(value: EndpointEnvelopeContextV1): Buffer {
  const context = validateContext(value);
  return Buffer.concat([
    lengthPrefix(ENDPOINT_DOMAIN),
    lengthPrefix(Buffer.concat([uint16BE(1), uint16BE(context.negotiatedMinor)])),
    lengthPrefix(context.pairId),
    lengthPrefix(Buffer.from([context.senderRole])),
    lengthPrefix(Buffer.from([context.receiverRole])),
    lengthPrefix(context.hostInstallationBundleHash),
    lengthPrefix(context.remoteInstallationBundleHash),
    lengthPrefix(uint64BE(context.hostTrustEpoch)),
    lengthPrefix(uint64BE(context.remoteTrustEpoch)),
    lengthPrefix(uint64BE(context.endpointEpoch))
  ]);
}

class AssociatedDataDecoderV1 {
  private offset = 0;

  constructor(private readonly payload: Buffer) {}

  private read(length: number): Buffer {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.payload.byteLength) {
      return fail("invalid_context", "endpoint associated data is truncated.");
    }
    const value = this.payload.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private lp(length: number, name: string): Buffer {
    const actualLength = this.read(4).readUInt32BE(0);
    if (actualLength !== length) {
      return fail("invalid_context", `${name} has the wrong associated-data width.`);
    }
    return this.read(length);
  }

  decode(expectedMinor?: number): EndpointEnvelopeContextV1 {
    const domain = this.lp(ENDPOINT_DOMAIN.byteLength, "domain");
    if (!domain.equals(ENDPOINT_DOMAIN)) {
      return fail("invalid_context", "endpoint associated-data domain is wrong.");
    }
    const protocol = this.lp(4, "protocol");
    if (protocol.readUInt16BE(0) !== 1) {
      return fail("invalid_context", "endpoint protocol major is unsupported.");
    }
    const negotiatedMinor = protocol.readUInt16BE(2);
    if (expectedMinor !== undefined && negotiatedMinor !== expectedMinor) {
      return fail("invalid_context", "endpoint protocol minor was not negotiated.");
    }
    const value: EndpointEnvelopeContextV1 = {
      negotiatedMinor,
      pairId: this.lp(16, "pair ID"),
      senderRole: this.lp(1, "sender role")[0] as EndpointRoleV1,
      receiverRole: this.lp(1, "receiver role")[0] as EndpointRoleV1,
      hostInstallationBundleHash: this.lp(32, "host bundle hash"),
      remoteInstallationBundleHash: this.lp(32, "remote bundle hash"),
      hostTrustEpoch: this.lp(8, "host trust epoch").readBigUInt64BE(0),
      remoteTrustEpoch: this.lp(8, "remote trust epoch").readBigUInt64BE(0),
      endpointEpoch: this.lp(8, "endpoint epoch").readBigUInt64BE(0)
    };
    if (this.offset !== this.payload.byteLength) {
      return fail("invalid_context", "endpoint associated data contains trailing bytes.");
    }
    return validateContext(value);
  }
}

export function decodeEndpointAssociatedDataV1(
  payload: Uint8Array,
  expectedMinor?: number
): EndpointEnvelopeContextV1 {
  return new AssociatedDataDecoderV1(Buffer.from(payload)).decode(expectedMinor);
}

export function endpointNonceV1(endpointEpoch: bigint): Buffer {
  const epoch = assertUint64(endpointEpoch, "endpoint epoch");
  if (epoch < 1n) {
    throw new RangeError("endpoint epoch must be positive.");
  }
  return Buffer.concat([Buffer.alloc(4), uint64BE(epoch)]);
}

export function encryptEndpointAeadPayloadV1(
  keyValue: Uint8Array,
  nonceValue: Uint8Array,
  associatedDataValue: Uint8Array,
  plaintextValue: Uint8Array
): Buffer {
  const key = fixedBytes(keyValue, 32, "endpoint key");
  const nonce = fixedBytes(nonceValue, 12, "endpoint nonce");
  const associatedData = Buffer.from(associatedDataValue);
  const plaintext = Buffer.from(plaintextValue);
  if (plaintext.byteLength > ENDPOINT_PLAINTEXT_MAX_BYTES) {
    return fail("plaintext_too_large", "endpoint AEAD plaintext exceeds 1,184 bytes.");
  }
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: CHACHA20_POLY1305_TAG_BYTES });
  cipher.setAAD(associatedData, { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  if (ciphertext.byteLength > ENDPOINT_CIPHERTEXT_MAX_BYTES) {
    return fail("ciphertext_too_large", "endpoint AEAD ciphertext exceeds 1,200 bytes.");
  }
  return ciphertext;
}

export function decryptEndpointAeadPayloadV1(
  keyValue: Uint8Array,
  nonceValue: Uint8Array,
  associatedDataValue: Uint8Array,
  ciphertextValue: Uint8Array
): Buffer {
  const key = fixedBytes(keyValue, 32, "endpoint key");
  const nonce = fixedBytes(nonceValue, 12, "endpoint nonce");
  const associatedData = Buffer.from(associatedDataValue);
  const ciphertext = Buffer.from(ciphertextValue);
  if (ciphertext.byteLength > ENDPOINT_CIPHERTEXT_MAX_BYTES) {
    return fail("ciphertext_too_large", "endpoint AEAD ciphertext exceeds 1,200 bytes.");
  }
  if (ciphertext.byteLength < CHACHA20_POLY1305_TAG_BYTES) {
    return fail("aead_authentication_failed", "endpoint ciphertext is shorter than its authentication tag.");
  }
  const encrypted = ciphertext.subarray(0, -CHACHA20_POLY1305_TAG_BYTES);
  const tag = ciphertext.subarray(-CHACHA20_POLY1305_TAG_BYTES);
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: CHACHA20_POLY1305_TAG_BYTES });
    decipher.setAAD(associatedData, { plaintextLength: encrypted.byteLength });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return fail("aead_authentication_failed", "endpoint ciphertext authentication failed.");
  }
}

function directionKey(keys: EndpointDirectionKeysV1, sender: EndpointRoleV1): Buffer {
  return fixedBytes(
    sender === 1 ? keys.hostToRemoteKey : keys.remoteToHostKey,
    32,
    sender === 1 ? "host-to-remote endpoint key" : "remote-to-host endpoint key"
  );
}

export interface EncryptEndpointEnvelopeV1Input {
  directionKeys: EndpointDirectionKeysV1;
  context: EndpointEnvelopeContextV1;
  value: EndpointGenerationV1;
  approved: boolean;
}

export interface EncryptedEndpointEnvelopeV1 {
  plaintext: Buffer;
  nonce: Buffer;
  associatedData: Buffer;
  ciphertext: Buffer;
}

export function encryptEndpointEnvelopeV1(
  input: EncryptEndpointEnvelopeV1Input
): EncryptedEndpointEnvelopeV1 {
  if (input.approved !== true) {
    return fail("unapproved_sender", "endpoint exchange is forbidden before exact approval.");
  }
  const context = validateContext(input.context);
  const value = validateEndpointGeneration(input.value);
  if (value.endpointEpoch !== context.endpointEpoch) {
    return fail("epoch_mismatch", "endpoint plaintext epoch does not match nonce/associated data.");
  }
  const plaintext = encodeEndpointPlaintextV1(value);
  const nonce = endpointNonceV1(context.endpointEpoch);
  const associatedData = encodeEndpointAssociatedDataV1(context);
  return {
    plaintext,
    nonce,
    associatedData,
    ciphertext: encryptEndpointAeadPayloadV1(
      directionKey(input.directionKeys, context.senderRole),
      nonce,
      associatedData,
      plaintext
    )
  };
}

export interface DecryptEndpointEnvelopeV1Input {
  directionKeys: EndpointDirectionKeysV1;
  context: EndpointEnvelopeContextV1;
  ciphertext: Uint8Array;
  approved: boolean;
}

export function decryptEndpointEnvelopeV1(
  input: DecryptEndpointEnvelopeV1Input
): EndpointGenerationV1 {
  if (input.approved !== true) {
    return fail("unapproved_sender", "endpoint exchange is forbidden before exact approval.");
  }
  const context = validateContext(input.context);
  const plaintext = decryptEndpointAeadPayloadV1(
    directionKey(input.directionKeys, context.senderRole),
    endpointNonceV1(context.endpointEpoch),
    encodeEndpointAssociatedDataV1(context),
    input.ciphertext
  );
  const value = decodeEndpointPlaintextV1(plaintext);
  if (value.endpointEpoch !== context.endpointEpoch) {
    return fail("epoch_mismatch", "endpoint plaintext epoch does not match nonce/associated data.");
  }
  return value;
}

export type EndpointReceivePhaseV1 = "empty" | "prepared" | "applied";

export interface EndpointReceiveSnapshotV1 {
  version: 1;
  phase: EndpointReceivePhaseV1;
  endpointEpoch?: bigint;
  ciphertextSha256?: Buffer;
  ciphertext?: Buffer;
  value?: EndpointGenerationV1;
}

export type EndpointPrepareStatusV1 = "prepared" | "resume_prepared" | "already_applied";

export interface EndpointPrepareResultV1 {
  status: EndpointPrepareStatusV1;
  value: EndpointGenerationV1;
  ciphertextSha256: Buffer;
}

function cloneCandidate(value: EndpointCandidateV1): EndpointCandidateV1 {
  return { ...value, address: Buffer.from(value.address) };
}

function cloneGeneration(value: EndpointGenerationV1): EndpointGenerationV1 {
  return { ...value, candidates: value.candidates.map(cloneCandidate) };
}

function cloneSnapshot(value: EndpointReceiveSnapshotV1): EndpointReceiveSnapshotV1 {
  return {
    version: 1,
    phase: value.phase,
    ...(value.endpointEpoch === undefined ? {} : { endpointEpoch: value.endpointEpoch }),
    ...(value.ciphertextSha256 === undefined ? {} : { ciphertextSha256: Buffer.from(value.ciphertextSha256) }),
    ...(value.ciphertext === undefined ? {} : { ciphertext: Buffer.from(value.ciphertext) }),
    ...(value.value === undefined ? {} : { value: cloneGeneration(value.value) })
  };
}

function validateSnapshot(value: EndpointReceiveSnapshotV1): EndpointReceiveSnapshotV1 {
  if (value.version !== 1 || !["empty", "prepared", "applied"].includes(value.phase)) {
    throw new TypeError("endpoint receive snapshot is not V1.");
  }
  if (value.phase === "empty") {
    if (
      value.endpointEpoch !== undefined
      || value.ciphertextSha256 !== undefined
      || value.ciphertext !== undefined
      || value.value !== undefined
    ) {
      throw new TypeError("empty endpoint snapshot cannot contain receive state.");
    }
    return cloneSnapshot(value);
  }
  if (
    value.endpointEpoch === undefined
    || value.ciphertextSha256 === undefined
    || value.ciphertext === undefined
    || value.value === undefined
  ) {
    throw new TypeError("prepared/applied endpoint snapshot is incomplete.");
  }
  assertUint64(value.endpointEpoch, "snapshot endpoint epoch");
  fixedBytes(value.ciphertextSha256, 32, "snapshot ciphertext hash");
  if (value.ciphertext.byteLength > ENDPOINT_CIPHERTEXT_MAX_BYTES) {
    throw new TypeError("snapshot endpoint ciphertext exceeds 1,200 bytes.");
  }
  const parsed = validateEndpointGeneration(value.value);
  if (parsed.endpointEpoch !== value.endpointEpoch) {
    throw new TypeError("snapshot endpoint value has another epoch.");
  }
  if (!timingSafeEqual(sha256(value.ciphertext), value.ciphertextSha256)) {
    throw new TypeError("snapshot endpoint ciphertext hash does not match.");
  }
  return cloneSnapshot({ ...value, value: parsed });
}

export class EndpointReceiveStateV1 {
  private current: EndpointReceiveSnapshotV1;

  constructor(snapshot: EndpointReceiveSnapshotV1 = { version: 1, phase: "empty" }) {
    this.current = validateSnapshot(snapshot);
  }

  snapshot(): EndpointReceiveSnapshotV1 {
    return cloneSnapshot(this.current);
  }

  prepare(input: DecryptEndpointEnvelopeV1Input): EndpointPrepareResultV1 {
    if (input.approved !== true) {
      return fail("unapproved_sender", "endpoint exchange is forbidden before exact approval.");
    }
    const context = validateContext(input.context);
    const ciphertext = Buffer.from(input.ciphertext);
    const ciphertextSha256 = sha256(ciphertext);
    if (this.current.phase === "empty") {
      if (context.endpointEpoch !== 1n) {
        return fail("invalid_initial_epoch", "first received endpoint epoch must be 1.");
      }
    } else {
      const currentEpoch = this.current.endpointEpoch as bigint;
      if (context.endpointEpoch < currentEpoch) {
        return fail("epoch_rollback", "endpoint epoch is below the durable receive high-water mark.");
      }
      if (context.endpointEpoch === currentEpoch) {
        const currentHash = this.current.ciphertextSha256 as Buffer;
        if (!timingSafeEqual(ciphertextSha256, currentHash)) {
          return fail("epoch_conflict", "same endpoint epoch carries different ciphertext bytes.");
        }
        decryptEndpointEnvelopeV1({ ...input, context, ciphertext });
        return {
          status: this.current.phase === "prepared" ? "resume_prepared" : "already_applied",
          value: cloneGeneration(this.current.value as EndpointGenerationV1),
          ciphertextSha256
        };
      }
    }
    const value = decryptEndpointEnvelopeV1({ ...input, context, ciphertext });
    this.current = validateSnapshot({
      version: 1,
      phase: "prepared",
      endpointEpoch: context.endpointEpoch,
      ciphertextSha256,
      ciphertext,
      value
    });
    return { status: "prepared", value: cloneGeneration(value), ciphertextSha256: Buffer.from(ciphertextSha256) };
  }

  markApplied(endpointEpoch: bigint, ciphertextSha256: Uint8Array): void {
    if (this.current.phase !== "prepared") {
      return fail("no_prepared_endpoint", "no prepared endpoint record is waiting for application.");
    }
    const expectedHash = this.current.ciphertextSha256 as Buffer;
    if (
      endpointEpoch !== this.current.endpointEpoch
      || !timingSafeEqual(fixedBytes(ciphertextSha256, 32, "ciphertext hash"), expectedHash)
    ) {
      return fail("epoch_conflict", "applied endpoint receipt does not match the prepared record.");
    }
    this.current = { ...this.current, phase: "applied" };
  }
}
