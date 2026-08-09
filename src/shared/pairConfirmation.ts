import { createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  PairConfirmationV1Schema,
  type PairConfirmationV1
} from "./schemas/remoteAccess.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

export const PAIR_CONFIRMATION_PAYLOAD_MAX_BYTES = 1_024;

const CONFIRMATION_MAC_DOMAIN = Buffer.from("waifus/pair-confirmation/v1", "ascii");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type PairConfirmationUnsignedV1 = Omit<PairConfirmationV1, "confirmationMac">;
export type PairConfirmationContextV1 = Omit<
  PairConfirmationUnsignedV1,
  "version" | "side" | "confirmationNonce"
>;

export type PairConfirmationErrorCode =
  | "payload_too_large"
  | "invalid_canonical_payload"
  | "invalid_record"
  | "invalid_mac"
  | "invalid_phase"
  | "wrong_side"
  | "context_mismatch"
  | "local_not_published"
  | "peer_not_verified"
  | "wrong_record_type"
  | "duplicate_confirmation";

export class PairConfirmationProtocolError extends Error {
  constructor(
    readonly code: PairConfirmationErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "PairConfirmationProtocolError";
  }
}

function fail(code: PairConfirmationErrorCode, detail: string): never {
  throw new PairConfirmationProtocolError(code, detail);
}

function fixedBytes(value: string, length: number, name: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || decoded.toString("base64url") !== value) {
    throw new TypeError(`${name} must be canonical base64url for ${length} bytes.`);
  }
  return decoded;
}

function confirmationKeyBytes(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== 32) {
    throw new RangeError("confirmation key must be exactly 32 bytes.");
  }
  return bytes;
}

function uint64BE(value: string): Buffer {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new RangeError("invitation generation must be a uint64.");
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

function validateUnsigned(value: PairConfirmationUnsignedV1): PairConfirmationUnsignedV1 {
  const parsed = PairConfirmationV1Schema.parse({
    ...value,
    confirmationMac: Buffer.alloc(32).toString("base64url")
  });
  const { confirmationMac: _confirmationMac, ...unsigned } = parsed;
  return unsigned;
}

export function encodePairConfirmationMacInput(value: PairConfirmationUnsignedV1): Buffer {
  const parsed = validateUnsigned(value);
  return Buffer.concat([
    lengthPrefix(CONFIRMATION_MAC_DOMAIN),
    lengthPrefix(fixedBytes(parsed.invitationId, 16, "invitation ID")),
    lengthPrefix(uint64BE(parsed.invitationGeneration)),
    lengthPrefix(fixedBytes(parsed.pairId, 16, "pair ID")),
    lengthPrefix(Buffer.from([parsed.side])),
    lengthPrefix(fixedBytes(parsed.transcriptHash, 32, "transcript hash")),
    lengthPrefix(fixedBytes(parsed.channelBinding, 32, "channel binding")),
    lengthPrefix(fixedBytes(parsed.hostBundleHash, 32, "host bundle hash")),
    lengthPrefix(fixedBytes(parsed.remoteBundleHash, 32, "remote bundle hash")),
    lengthPrefix(fixedBytes(parsed.approvalContextHash, 32, "approval context hash")),
    lengthPrefix(fixedBytes(parsed.confirmationNonce, 16, "confirmation nonce"))
  ]);
}

export function derivePairConfirmationMac(
  confirmationKey: Uint8Array,
  value: PairConfirmationUnsignedV1
): Buffer {
  return createHmac("sha256", confirmationKeyBytes(confirmationKey))
    .update(encodePairConfirmationMacInput(value))
    .digest();
}

export function createPairConfirmationV1(
  confirmationKey: Uint8Array,
  value: PairConfirmationUnsignedV1
): PairConfirmationV1 {
  const unsigned = validateUnsigned(value);
  return PairConfirmationV1Schema.parse({
    ...unsigned,
    confirmationMac: derivePairConfirmationMac(confirmationKey, unsigned).toString("base64url")
  });
}

export function serializePairConfirmationV1(value: unknown): Buffer {
  const parsed = PairConfirmationV1Schema.parse(value);
  return Buffer.from(
    serializeCanonicalContractJson(parsed as unknown as ContractJson),
    "utf8"
  );
}

export function verifyPairConfirmationV1(
  value: unknown,
  confirmationKey: Uint8Array
): PairConfirmationV1 {
  const parsed = PairConfirmationV1Schema.safeParse(value);
  if (!parsed.success) {
    return fail("invalid_record", "PairConfirmationV1 fields are not exact.");
  }
  const { confirmationMac, ...unsigned } = parsed.data;
  const expected = derivePairConfirmationMac(confirmationKey, unsigned);
  const candidate = fixedBytes(confirmationMac, 32, "confirmation MAC");
  if (!timingSafeEqual(expected, candidate)) {
    return fail("invalid_mac", "confirmation MAC does not match the bound context.");
  }
  return parsed.data;
}

export function parseAndVerifyPairConfirmationV1(
  payload: Uint8Array,
  confirmationKey: Uint8Array
): PairConfirmationV1 {
  const bytes = Buffer.from(payload);
  if (bytes.byteLength > PAIR_CONFIRMATION_PAYLOAD_MAX_BYTES) {
    return fail("payload_too_large", "pair confirmation payload exceeds 1,024 raw bytes.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    return fail("invalid_canonical_payload", "pair confirmation payload is not canonical JSON.");
  }
  const parsed = PairConfirmationV1Schema.safeParse(decoded);
  if (!parsed.success) {
    return fail("invalid_record", "PairConfirmationV1 fields are not exact.");
  }
  const canonical = serializePairConfirmationV1(parsed.data);
  if (!canonical.equals(bytes)) {
    return fail("invalid_canonical_payload", "pair confirmation JSON bytes are not RFC 8785 canonical.");
  }
  return verifyPairConfirmationV1(parsed.data, confirmationKey);
}

export interface PairConfirmationMailboxRecord {
  recordType: string;
  payload: Uint8Array;
}

export interface PairConfirmationSessionOptions {
  localSide: 1 | 2;
  confirmationKey: Uint8Array;
  expectedContext: PairConfirmationContextV1;
}

export interface PairConfirmationSessionSnapshot {
  phase: "pre_approval" | "approved" | "consumed" | "cancelled" | "expired";
  localPublished: boolean;
  peerVerified: boolean;
  consumeAcknowledged: boolean;
}

const CONTEXT_FIELDS = [
  "invitationId",
  "invitationGeneration",
  "pairId",
  "transcriptHash",
  "channelBinding",
  "hostBundleHash",
  "remoteBundleHash",
  "approvalContextHash"
] as const satisfies readonly (keyof PairConfirmationContextV1)[];

export class PairConfirmationSessionV1 {
  private phase: PairConfirmationSessionSnapshot["phase"] = "pre_approval";
  private localPayload: Buffer | undefined;
  private peerPayload: Buffer | undefined;
  private consumeAcknowledged = false;
  private readonly confirmationKey: Buffer;

  constructor(private readonly options: PairConfirmationSessionOptions) {
    this.confirmationKey = confirmationKeyBytes(options.confirmationKey);
    if (options.localSide !== 1 && options.localSide !== 2) {
      throw new RangeError("local side must be host 1 or remote 2.");
    }
  }

  approve(): boolean {
    if (this.phase === "approved") {
      return false;
    }
    if (this.phase !== "pre_approval") {
      return fail("invalid_phase", `cannot approve from ${this.phase}.`);
    }
    this.phase = "approved";
    return true;
  }

  publishLocal(value: unknown): boolean {
    this.requireApproved();
    const parsed = verifyPairConfirmationV1(value, this.confirmationKey);
    if (parsed.side !== this.options.localSide) {
      return fail("wrong_side", "local confirmation uses the peer side.");
    }
    this.requireContext(parsed);
    const payload = serializePairConfirmationV1(parsed);
    if (this.localPayload) {
      if (this.localPayload.equals(payload)) {
        return false;
      }
      return fail("duplicate_confirmation", "local side already published a different confirmation.");
    }
    this.localPayload = payload;
    return true;
  }

  receivePeer(record: PairConfirmationMailboxRecord): boolean {
    this.requireApproved();
    if (!this.localPayload) {
      return fail("local_not_published", "local confirmation must be published before peer verification.");
    }
    if (record.recordType !== "pair_confirmation") {
      return fail("wrong_record_type", "peer confirmation cannot use a Noise transport record.");
    }
    const payload = Buffer.from(record.payload);
    const parsed = parseAndVerifyPairConfirmationV1(payload, this.confirmationKey);
    const expectedPeer = this.options.localSide === 1 ? 2 : 1;
    if (parsed.side !== expectedPeer) {
      return fail("wrong_side", "peer confirmation uses the local side.");
    }
    this.requireContext(parsed);
    if (this.peerPayload) {
      if (this.peerPayload.equals(payload)) {
        return false;
      }
      return fail("duplicate_confirmation", "peer side already supplied a different confirmation.");
    }
    this.peerPayload = payload;
    return true;
  }

  consume(): boolean {
    if (this.phase === "consumed") {
      return false;
    }
    this.requireApproved();
    if (!this.peerPayload) {
      return fail("peer_not_verified", "peer confirmation must be locally verified before consume.");
    }
    this.consumeAcknowledged = true;
    this.phase = "consumed";
    return true;
  }

  cancel(): void {
    if (this.phase === "cancelled") {
      return;
    }
    if (this.phase === "consumed" || this.phase === "expired") {
      return fail("invalid_phase", `cannot cancel a ${this.phase} confirmation session.`);
    }
    this.phase = "cancelled";
  }

  expire(): void {
    if (this.phase === "expired") {
      return;
    }
    if (this.phase === "consumed" || this.phase === "cancelled") {
      return fail("invalid_phase", `cannot expire a ${this.phase} confirmation session.`);
    }
    this.phase = "expired";
  }

  snapshot(): PairConfirmationSessionSnapshot {
    return {
      phase: this.phase,
      localPublished: this.localPayload !== undefined,
      peerVerified: this.peerPayload !== undefined,
      consumeAcknowledged: this.consumeAcknowledged
    };
  }

  private requireApproved(): void {
    if (this.phase !== "approved") {
      return fail("invalid_phase", `pair confirmation is not allowed in ${this.phase}.`);
    }
  }

  private requireContext(value: PairConfirmationV1): void {
    for (const field of CONTEXT_FIELDS) {
      if (value[field] !== this.options.expectedContext[field]) {
        return fail("context_mismatch", `${field} differs from the approved pairing context.`);
      }
    }
  }
}
