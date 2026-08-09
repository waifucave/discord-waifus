import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  PairControlRecordV1Schema,
  PairControlUnsignedRecordV1Schema,
  PositiveUint64DecimalSchema,
  type PairControlRecordV1,
  type PairControlTypeV1,
  type PairControlUnsignedRecordV1
} from "./schemas/remoteAccess.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema
} from "./schemas/remoteProtocol.js";
import {
  signEd25519,
  verifyEd25519
} from "./remotePairing.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

export const PAIR_CONTROL_RECORD_MAX_BYTES = 2_048;
export const PAIR_CONTROL_TIMESTAMP_SKEW_SECONDS = 60n;

const RECORD_SIGNATURE_DOMAIN = Buffer.from("waifus/pair-control-record/v1", "ascii");
const REVOCATION_MAC_DOMAIN = Buffer.from("waifus/pair-revocation/v1", "ascii");
const REVOCATION_ACK_MAC_DOMAIN = Buffer.from("waifus/pair-revocation-ack/v1", "ascii");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const PAIR_CONTROL_TYPE_NAMES = Object.freeze({
  1: "hello",
  2: "capabilities",
  3: "endpoint_generation",
  4: "endpoint_ack",
  5: "presence",
  6: "reconnect",
  7: "revocation",
  8: "revocation_ack",
  9: "error"
} as const satisfies Record<PairControlTypeV1, string>);

export type PairControlTransportV1 =
  | "websocket"
  | "https_publish"
  | "https_revoke"
  | "https_revocation_ack"
  | "https_poll";

export type PairControlTimestampModeV1 = "worker_ingress" | "durable_delivery";

export type PairControlErrorCode =
  | "payload_too_large"
  | "invalid_canonical_payload"
  | "invalid_record"
  | "invalid_payload_hash"
  | "invalid_signature"
  | "protocol_mismatch"
  | "wrong_pair"
  | "wrong_side"
  | "wrong_transport"
  | "timestamp_out_of_window"
  | "timestamp_in_future"
  | "presence_expired"
  | "invalid_revocation_mac"
  | "stale_generation"
  | "invalid_generation_start"
  | "stale_sequence"
  | "tuple_conflict"
  | "nonce_reused";

export class PairControlProtocolError extends Error {
  constructor(
    readonly code: PairControlErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "PairControlProtocolError";
  }
}

function fail(code: PairControlErrorCode, detail: string): never {
  throw new PairControlProtocolError(code, detail);
}

function sha256(...values: readonly Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
  }
  return hash.digest();
}

function fixedBytes(value: string, length: number, name: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || decoded.toString("base64url") !== value) {
    throw new TypeError(`${name} must be canonical base64url for ${length} bytes.`);
  }
  return decoded;
}

function fixedKey(value: Uint8Array, name: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== 32) {
    throw new RangeError(`${name} must be exactly 32 bytes.`);
  }
  return bytes;
}

function uint16BE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("value must be a uint16.");
  }
  const encoded = Buffer.alloc(2);
  encoded.writeUInt16BE(value);
  return encoded;
}

function uint64BE(value: string): Buffer {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new RangeError("value must be a uint64.");
  }
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(parsed);
  return encoded;
}

function lengthPrefix(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function unsignedRecord(value: unknown): PairControlUnsignedRecordV1 {
  const unsigned = PairControlUnsignedRecordV1Schema.safeParse(value);
  if (unsigned.success) {
    return unsigned.data;
  }
  const signed = PairControlRecordV1Schema.parse(value);
  const { signature: _signature, ...candidate } = signed;
  return PairControlUnsignedRecordV1Schema.parse(candidate);
}

function payloadJson(value: PairControlUnsignedRecordV1 | PairControlRecordV1): ContractJson {
  return value.payload as unknown as ContractJson;
}

function validatePayloadHash(value: PairControlUnsignedRecordV1 | PairControlRecordV1): void {
  if (value.type !== 3) {
    return;
  }
  const ciphertext = Buffer.from(value.payload.ciphertext, "base64url");
  const expected = sha256(ciphertext).toString("base64url");
  if (value.payload.ciphertextSha256 !== expected) {
    return fail("invalid_payload_hash", "endpoint ciphertext hash does not match its decoded bytes.");
  }
}

function parseCanonicalRecord(payload: Uint8Array): PairControlRecordV1 {
  const bytes = Buffer.from(payload);
  if (bytes.byteLength > PAIR_CONTROL_RECORD_MAX_BYTES) {
    return fail("payload_too_large", "pair control record exceeds 2,048 raw bytes.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    return fail("invalid_canonical_payload", "pair control record is not canonical JSON.");
  }
  const parsed = PairControlRecordV1Schema.safeParse(decoded);
  if (!parsed.success) {
    return fail("invalid_record", "PairControlRecordV1 fields are not exact.");
  }
  const canonical = serializePairControlRecordV1(parsed.data);
  if (!canonical.equals(bytes)) {
    return fail("invalid_canonical_payload", "pair control JSON bytes are not RFC 8785 canonical.");
  }
  validatePayloadHash(parsed.data);
  return parsed.data;
}

export function serializePairControlPayloadV1(value: unknown): Buffer {
  const parsed = unsignedRecord(value);
  return Buffer.from(serializeCanonicalContractJson(payloadJson(parsed)), "utf8");
}

export function encodePairControlSignatureInputV1(value: unknown): Buffer {
  const parsed = unsignedRecord(value);
  const protocol = Buffer.concat([
    uint16BE(parsed.protocolMajor),
    uint16BE(parsed.protocolMinor)
  ]);
  const payloadHash = sha256(serializePairControlPayloadV1(parsed));
  return Buffer.concat([
    lengthPrefix(RECORD_SIGNATURE_DOMAIN),
    lengthPrefix(protocol),
    lengthPrefix(fixedBytes(parsed.pairId, 16, "pair ID")),
    lengthPrefix(Buffer.from([parsed.type])),
    lengthPrefix(Buffer.from([parsed.side])),
    lengthPrefix(uint64BE(parsed.connectionGeneration)),
    lengthPrefix(uint64BE(parsed.sequence)),
    lengthPrefix(uint64BE(parsed.timestamp)),
    lengthPrefix(fixedBytes(parsed.nonce, 16, "record nonce")),
    lengthPrefix(payloadHash)
  ]);
}

export function createPairControlRecordV1(
  installationPrivateKeySeed: Uint8Array,
  value: PairControlUnsignedRecordV1
): PairControlRecordV1 {
  const parsed = PairControlUnsignedRecordV1Schema.parse(value);
  validatePayloadHash(parsed);
  const signed = PairControlRecordV1Schema.parse({
    ...parsed,
    signature: signEd25519(
      installationPrivateKeySeed,
      encodePairControlSignatureInputV1(parsed)
    ).toString("base64url")
  });
  if (serializePairControlRecordV1(signed).byteLength > PAIR_CONTROL_RECORD_MAX_BYTES) {
    return fail("payload_too_large", "signed pair control record exceeds 2,048 raw bytes.");
  }
  return signed;
}

export function serializePairControlRecordV1(value: unknown): Buffer {
  const parsed = PairControlRecordV1Schema.parse(value);
  return Buffer.from(
    serializeCanonicalContractJson(parsed as unknown as ContractJson),
    "utf8"
  );
}

export function pairControlTransportAllows(
  transport: PairControlTransportV1,
  type: PairControlTypeV1
): boolean {
  if (transport === "websocket" || transport === "https_poll") {
    return type >= 1 && type <= 9;
  }
  if (transport === "https_publish") {
    return (type >= 1 && type <= 6) || type === 9;
  }
  if (transport === "https_revoke") {
    return type === 7;
  }
  return transport === "https_revocation_ack" && type === 8;
}

export interface PairRevocationContextV1 {
  pairId: PairControlRecordV1["pairId"];
  hostBundleHash: string;
  remoteBundleHash: string;
  hostTrustEpoch: string;
  remoteTrustEpoch: string;
}

function encodeRevocationMacInput(
  domain: Buffer,
  record: Extract<PairControlRecordV1, { type: 7 | 8 }>,
  context: PairRevocationContextV1
): Buffer {
  const common = [
    lengthPrefix(domain),
    lengthPrefix(fixedBytes(record.pairId, 16, "pair ID")),
    lengthPrefix(Buffer.from([record.side])),
    lengthPrefix(uint64BE(record.payload.revocationEpoch))
  ];
  if (record.type === 7) {
    common.push(lengthPrefix(Buffer.from(record.payload.reason, "ascii")));
  }
  common.push(
    lengthPrefix(fixedBytes(context.hostBundleHash, 32, "host bundle hash")),
    lengthPrefix(fixedBytes(context.remoteBundleHash, 32, "remote bundle hash")),
    lengthPrefix(uint64BE(context.hostTrustEpoch)),
    lengthPrefix(uint64BE(context.remoteTrustEpoch)),
    lengthPrefix(fixedBytes(record.nonce, 16, "record nonce"))
  );
  return Buffer.concat(common);
}

function contextMatchesRecord(
  record: Extract<PairControlRecordV1, { type: 7 | 8 }>,
  context: PairRevocationContextV1
): boolean {
  return record.pairId === context.pairId
    && context.hostBundleHash !== context.remoteBundleHash;
}

export function derivePairRevocationMacV1(
  key: Uint8Array,
  record: Extract<PairControlRecordV1, { type: 7 }>,
  context: PairRevocationContextV1
): Buffer {
  return createHmac("sha256", fixedKey(key, "revocation key"))
    .update(encodeRevocationMacInput(REVOCATION_MAC_DOMAIN, record, context))
    .digest();
}

export function derivePairRevocationAckMacV1(
  key: Uint8Array,
  record: Extract<PairControlRecordV1, { type: 8 }>,
  context: PairRevocationContextV1
): Buffer {
  return createHmac("sha256", fixedKey(key, "revocation key"))
    .update(encodeRevocationMacInput(REVOCATION_ACK_MAC_DOMAIN, record, context))
    .digest();
}

export function encodePairRevocationMacInputV1(
  record: Extract<PairControlRecordV1, { type: 7 }>,
  context: PairRevocationContextV1
): Buffer {
  return encodeRevocationMacInput(REVOCATION_MAC_DOMAIN, record, context);
}

export function encodePairRevocationAckMacInputV1(
  record: Extract<PairControlRecordV1, { type: 8 }>,
  context: PairRevocationContextV1
): Buffer {
  return encodeRevocationMacInput(REVOCATION_ACK_MAC_DOMAIN, record, context);
}

export function verifyPairRevocationMacV1(
  key: Uint8Array,
  record: PairControlRecordV1,
  context: PairRevocationContextV1
): boolean {
  if (record.type !== 7 || !contextMatchesRecord(record, context)) {
    return false;
  }
  try {
    const candidate = fixedBytes(record.payload.revocationMac, 32, "revocation MAC");
    return timingSafeEqual(candidate, derivePairRevocationMacV1(key, record, context));
  } catch {
    return false;
  }
}

export function verifyPairRevocationAckMacV1(
  key: Uint8Array,
  record: PairControlRecordV1,
  context: PairRevocationContextV1
): boolean {
  if (record.type !== 8 || !contextMatchesRecord(record, context)) {
    return false;
  }
  try {
    const candidate = fixedBytes(record.payload.revocationMac, 32, "revocation acknowledgement MAC");
    return timingSafeEqual(candidate, derivePairRevocationAckMacV1(key, record, context));
  } catch {
    return false;
  }
}

export interface PairControlVerificationOptionsV1 {
  installationPublicKey: Uint8Array;
  expectedPairId: PairControlRecordV1["pairId"];
  expectedSide: 1 | 2;
  nowSeconds: bigint;
  timestampMode: PairControlTimestampModeV1;
  transport: PairControlTransportV1;
  expectedProtocol?: Readonly<{ major: number; minor: number }>;
  revocation?: Readonly<{
    key: Uint8Array;
    context: PairRevocationContextV1;
  }>;
}

function validateTimestamp(
  record: PairControlRecordV1,
  nowSeconds: bigint,
  mode: PairControlTimestampModeV1
): void {
  const timestamp = BigInt(record.timestamp);
  if (mode === "worker_ingress") {
    if (
      timestamp > nowSeconds + PAIR_CONTROL_TIMESTAMP_SKEW_SECONDS
      || timestamp + PAIR_CONTROL_TIMESTAMP_SKEW_SECONDS < nowSeconds
    ) {
      return fail("timestamp_out_of_window", "first ingress timestamp is outside plus or minus 60 seconds.");
    }
  } else if (timestamp > nowSeconds + PAIR_CONTROL_TIMESTAMP_SKEW_SECONDS) {
    return fail("timestamp_in_future", "durably delivered record timestamp is too far in the future.");
  }
  if (record.type === 5 && BigInt(record.payload.validUntil) < nowSeconds) {
    return fail("presence_expired", "presence validity has elapsed.");
  }
}

export function parseAndVerifyPairControlRecordV1(
  payload: Uint8Array,
  options: PairControlVerificationOptionsV1
): PairControlRecordV1 {
  const record = parseCanonicalRecord(payload);
  if (!pairControlTransportAllows(options.transport, record.type)) {
    return fail("wrong_transport", `record type ${record.type} is forbidden on ${options.transport}.`);
  }
  if (!verifyEd25519(
    options.installationPublicKey,
    encodePairControlSignatureInputV1(record),
    fixedBytes(record.signature, 64, "record signature")
  )) {
    return fail("invalid_signature", "record signature does not match the sender installation key.");
  }
  const protocol = options.expectedProtocol ?? { major: 1, minor: 0 };
  if (record.protocolMajor !== protocol.major || record.protocolMinor !== protocol.minor) {
    return fail("protocol_mismatch", "record protocol does not match the authenticated session.");
  }
  if (record.pairId !== options.expectedPairId) {
    return fail("wrong_pair", "record pair ID differs from the authenticated pair.");
  }
  if (record.side !== options.expectedSide) {
    return fail("wrong_side", "record sender role differs from the authenticated pair side.");
  }
  validateTimestamp(record, options.nowSeconds, options.timestampMode);
  if (options.revocation && record.type === 7 && !verifyPairRevocationMacV1(
    options.revocation.key,
    record,
    options.revocation.context
  )) {
    return fail("invalid_revocation_mac", "peer revocation MAC does not match the pair context.");
  }
  if (options.revocation && record.type === 8 && !verifyPairRevocationAckMacV1(
    options.revocation.key,
    record,
    options.revocation.context
  )) {
    return fail("invalid_revocation_mac", "peer revocation acknowledgement MAC does not match the pair context.");
  }
  return record;
}

interface PairControlSideStateV1 {
  connectionGeneration: string;
  sequence: string;
  recordHash: string;
}

function restoreSideState(value: PairControlSideStateV1 | undefined): PairControlSideStateV1 | undefined {
  if (!value) {
    return undefined;
  }
  return {
    connectionGeneration: PositiveUint64DecimalSchema.parse(value.connectionGeneration),
    sequence: PositiveUint64DecimalSchema.parse(value.sequence),
    recordHash: Base64Url32BytesSchema.parse(value.recordHash)
  };
}

function restoreNonces(values: readonly string[], name: string): Set<string> {
  const result = new Set<string>();
  let previous: string | undefined;
  for (const value of values) {
    const nonce = Base64Url16BytesSchema.parse(value);
    if (previous !== undefined && previous >= nonce) {
      throw new TypeError(`${name} replay nonces must be sorted and unique.`);
    }
    result.add(nonce);
    previous = nonce;
  }
  return result;
}

export interface PairControlIngressSnapshotV1 {
  version: 1;
  host?: PairControlSideStateV1;
  remote?: PairControlSideStateV1;
  hostNonces: string[];
  remoteNonces: string[];
}

export interface PairControlIngressOptionsV1 {
  expectedPairId: PairControlRecordV1["pairId"];
  hostInstallationPublicKey: Uint8Array;
  remoteInstallationPublicKey: Uint8Array;
  expectedProtocol?: Readonly<{ major: number; minor: number }>;
}

export type PairControlIngressOutcomeV1 = "accepted" | "idempotent";

export class PairControlIngressStateV1 {
  private host: PairControlSideStateV1 | undefined;
  private remote: PairControlSideStateV1 | undefined;
  private readonly hostNonces: Set<string>;
  private readonly remoteNonces: Set<string>;
  private readonly hostPublicKey: Buffer;
  private readonly remotePublicKey: Buffer;

  constructor(
    private readonly options: PairControlIngressOptionsV1,
    snapshot?: PairControlIngressSnapshotV1
  ) {
    this.hostPublicKey = fixedKey(options.hostInstallationPublicKey, "host installation public key");
    this.remotePublicKey = fixedKey(options.remoteInstallationPublicKey, "remote installation public key");
    fixedBytes(options.expectedPairId, 16, "expected pair ID");
    const protocol = options.expectedProtocol ?? { major: 1, minor: 0 };
    uint16BE(protocol.major);
    uint16BE(protocol.minor);
    if (snapshot) {
      if (snapshot.version !== 1) {
        throw new TypeError("unsupported pair control ingress snapshot version.");
      }
      this.host = restoreSideState(snapshot.host);
      this.remote = restoreSideState(snapshot.remote);
      this.hostNonces = restoreNonces(snapshot.hostNonces, "host");
      this.remoteNonces = restoreNonces(snapshot.remoteNonces, "remote");
      if ((!this.host && this.hostNonces.size > 0) || (!this.remote && this.remoteNonces.size > 0)) {
        throw new TypeError("replay nonces require a matching side high-water.");
      }
    } else {
      this.hostNonces = new Set();
      this.remoteNonces = new Set();
    }
  }

  accept(
    payload: Uint8Array,
    transport: Exclude<PairControlTransportV1, "https_poll">,
    nowSeconds: bigint
  ): PairControlIngressOutcomeV1 {
    if ((transport as PairControlTransportV1) === "https_poll") {
      return fail("wrong_transport", "HTTPS poll is delivery-only and cannot enter ingress state.");
    }
    const candidate = parseCanonicalRecord(payload);
    const publicKey = candidate.side === 1 ? this.hostPublicKey : this.remotePublicKey;
    const record = parseAndVerifyPairControlRecordV1(payload, {
      installationPublicKey: publicKey,
      expectedPairId: this.options.expectedPairId,
      expectedSide: candidate.side,
      nowSeconds,
      timestampMode: "worker_ingress",
      transport,
      expectedProtocol: this.options.expectedProtocol
    });
    const current = record.side === 1 ? this.host : this.remote;
    const nonces = record.side === 1 ? this.hostNonces : this.remoteNonces;
    const generation = BigInt(record.connectionGeneration);
    const sequence = BigInt(record.sequence);
    const recordHash = sha256(payload).toString("base64url");

    if (!current) {
      if (generation !== 1n || sequence !== 1n) {
        return fail("invalid_generation_start", "a side must begin at generation 1 sequence 1.");
      }
    } else {
      const currentGeneration = BigInt(current.connectionGeneration);
      const currentSequence = BigInt(current.sequence);
      if (generation < currentGeneration) {
        return fail("stale_generation", "record generation is below the accepted high-water.");
      }
      if (generation === currentGeneration) {
        if (sequence < currentSequence) {
          return fail("stale_sequence", "record sequence is below the accepted high-water.");
        }
        if (sequence === currentSequence) {
          if (recordHash === current.recordHash) {
            return "idempotent";
          }
          return fail("tuple_conflict", "same generation and sequence carry different bytes.");
        }
      } else if (sequence !== 1n) {
        return fail("invalid_generation_start", "a higher generation must begin at sequence 1.");
      }
    }
    if (nonces.has(record.nonce)) {
      return fail("nonce_reused", "record nonce was already accepted for this side.");
    }
    const next: PairControlSideStateV1 = {
      connectionGeneration: record.connectionGeneration,
      sequence: record.sequence,
      recordHash
    };
    nonces.add(record.nonce);
    if (record.side === 1) {
      this.host = next;
    } else {
      this.remote = next;
    }
    return "accepted";
  }

  snapshot(): PairControlIngressSnapshotV1 {
    return {
      version: 1,
      ...(this.host ? { host: { ...this.host } } : {}),
      ...(this.remote ? { remote: { ...this.remote } } : {}),
      hostNonces: [...this.hostNonces].sort(),
      remoteNonces: [...this.remoteNonces].sort()
    };
  }
}
