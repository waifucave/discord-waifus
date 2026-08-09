import { createHmac, timingSafeEqual } from "node:crypto";

export const WIPC_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 } as const);
export const WIPC_HEADER_BYTES = 24;
export const WIPC_CONTROL_PAYLOAD_MAX_BYTES = 32 * 1_024;
export const WIPC_ENCODED_HEADERS_MAX_BYTES = 16 * 1_024;
export const WIPC_DATA_PAYLOAD_MAX_BYTES = 64 * 1_024;
export const WIPC_ABSOLUTE_PAYLOAD_MAX_BYTES = 65_536;
export const WIPC_MAX_CONCURRENT_STREAMS = 128;
export const WIPC_INITIAL_STREAM_CREDIT_BYTES = 1_048_576;
export const WIPC_WINDOW_UPDATE_BYTES = 8;
export const WIPC_AUTH_VALUE_BYTES = 32;
export const WIPC_UINT64_MAX = 18_446_744_073_709_551_615n;

export const WIPC_FRAME_TYPES = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  COMMAND: 0x03,
  RESULT: 0x04,
  EVENT: 0x05,
  REQUEST_START: 0x10,
  REQUEST_CHUNK: 0x11,
  REQUEST_END: 0x12,
  REQUEST_CANCEL: 0x13,
  RESPONSE_START: 0x20,
  RESPONSE_CHUNK: 0x21,
  RESPONSE_END: 0x22,
  RESPONSE_ERROR: 0x23,
  WINDOW_UPDATE: 0x30
} as const);

export type WipcFrameType = typeof WIPC_FRAME_TYPES[keyof typeof WIPC_FRAME_TYPES];
export type WipcStreamCreator = "node" | "helper";
export type WipcWindowDirection = "request" | "response";

export type WipcProtocolErrorCode =
  | "invalid_header_length"
  | "invalid_magic"
  | "unsupported_version"
  | "unknown_frame_type"
  | "reserved_flags"
  | "reserved_bytes"
  | "invalid_header_field"
  | "invalid_stream_id"
  | "payload_too_large"
  | "invalid_control_payload_length"
  | "control_payload_too_large"
  | "invalid_data_payload_length"
  | "invalid_terminal_payload_length"
  | "invalid_window_update_length"
  | "encoded_headers_too_large"
  | "invalid_encoded_headers_length"
  | "invalid_window_direction"
  | "invalid_credit_increment"
  | "stream_id_parity"
  | "stream_id_reused"
  | "stream_id_exhausted"
  | "invalid_auth_width"
  | "invalid_auth_transcript"
  | "frame_before_authentication"
  | "invalid_stream_frame"
  | "unknown_stream"
  | "failed_stream_frame"
  | "flow_control_error"
  | "auth_sequence_error"
  | "invalid_parent_proof"
  | "invalid_helper_proof"
  | "auth_capability_unavailable";

export class WipcProtocolError extends Error {
  readonly code: WipcProtocolErrorCode;

  constructor(code: WipcProtocolErrorCode, message: string) {
    super(message);
    this.name = "WipcProtocolError";
    this.code = code;
  }
}

export interface WipcFrameHeader {
  major: number;
  minor: number;
  frameType: WipcFrameType;
  flags: number;
  streamId: bigint;
  payloadLength: number;
}

export interface WipcWindowUpdate {
  direction: WipcWindowDirection;
  creditIncrement: number;
}

export interface WipcParentProofInput {
  parentCapability: Uint8Array;
  clientNonce: Uint8Array;
  helperNonce: Uint8Array;
  helloBytes: Uint8Array;
  helloAckBytes: Uint8Array;
}

export interface WipcParentProofVerificationInput extends WipcParentProofInput {
  parentProof: Uint8Array;
}

export type WipcHelperProofInput = WipcParentProofVerificationInput;

export interface WipcHelperProofVerificationInput extends WipcHelperProofInput {
  helperProof: Uint8Array;
}

const WIPC_MAGIC = Buffer.from("WIPC", "ascii");
const WIPC_PARENT_AUTH_DOMAIN = Buffer.from("waifus-ipc-auth-v1", "ascii");
const WIPC_HELPER_AUTH_DOMAIN = Buffer.from("waifus-ipc-helper-v1", "ascii");
const KNOWN_FRAME_TYPES = new Set<number>(Object.values(WIPC_FRAME_TYPES));
const CONNECTION_FRAME_TYPES = new Set<WipcFrameType>([
  WIPC_FRAME_TYPES.HELLO,
  WIPC_FRAME_TYPES.HELLO_ACK,
  WIPC_FRAME_TYPES.COMMAND,
  WIPC_FRAME_TYPES.RESULT,
  WIPC_FRAME_TYPES.EVENT
]);
const DATA_FRAME_TYPES = new Set<WipcFrameType>([
  WIPC_FRAME_TYPES.REQUEST_CHUNK,
  WIPC_FRAME_TYPES.RESPONSE_CHUNK
]);
const TERMINAL_FRAME_TYPES = new Set<WipcFrameType>([
  WIPC_FRAME_TYPES.REQUEST_END,
  WIPC_FRAME_TYPES.RESPONSE_END
]);

function protocolError(code: WipcProtocolErrorCode, message: string): never {
  throw new WipcProtocolError(code, message);
}

function assertUint16(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    protocolError("invalid_header_field", `${field} must be a uint16 integer.`);
  }
}

function assertUint8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    protocolError("invalid_header_field", `${field} must be a uint8 integer.`);
  }
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
    protocolError("invalid_header_field", `${field} must be a uint32 integer.`);
  }
}

function assertSupportedVersion(major: number, minor: number): void {
  assertUint16(major, "major");
  assertUint16(minor, "minor");
  if (major !== WIPC_PROTOCOL_VERSION.major || minor !== WIPC_PROTOCOL_VERSION.minor) {
    protocolError(
      "unsupported_version",
      `Unsupported WIPC version ${major}.${minor}; expected ${WIPC_PROTOCOL_VERSION.major}.${WIPC_PROTOCOL_VERSION.minor}.`
    );
  }
}

function assertFrameType(value: number): asserts value is WipcFrameType {
  assertUint8(value, "frameType");
  if (!KNOWN_FRAME_TYPES.has(value)) {
    protocolError("unknown_frame_type", `Unknown WIPC frame type 0x${value.toString(16)}.`);
  }
}

function assertStreamId(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > WIPC_UINT64_MAX) {
    protocolError("invalid_stream_id", "streamId must be a uint64 bigint.");
  }
}

function assertFrameStreamClass(frameType: WipcFrameType, streamId: bigint): void {
  assertStreamId(streamId);
  const connectionFrame = CONNECTION_FRAME_TYPES.has(frameType);
  if ((connectionFrame && streamId !== 0n) || (!connectionFrame && streamId === 0n)) {
    protocolError(
      "invalid_stream_id",
      connectionFrame
        ? "Connection-control frames require stream ID zero."
        : "Request/response frames require a nonzero stream ID."
    );
  }
}

function assertFramePayloadLength(frameType: WipcFrameType, payloadLength: number): void {
  assertUint32(payloadLength, "payloadLength");
  if (payloadLength > WIPC_ABSOLUTE_PAYLOAD_MAX_BYTES) {
    protocolError("payload_too_large", "WIPC payload length exceeds the decoder ceiling.");
  }
  if (DATA_FRAME_TYPES.has(frameType)) {
    if (payloadLength < 1 || payloadLength > WIPC_DATA_PAYLOAD_MAX_BYTES) {
      protocolError(
        "invalid_data_payload_length",
        "Raw data frames must contain between 1 and 65,536 bytes."
      );
    }
    return;
  }
  if (TERMINAL_FRAME_TYPES.has(frameType)) {
    if (payloadLength !== 0) {
      protocolError(
        "invalid_terminal_payload_length",
        "REQUEST_END and RESPONSE_END carry no payload."
      );
    }
    return;
  }
  if (frameType === WIPC_FRAME_TYPES.WINDOW_UPDATE) {
    if (payloadLength !== WIPC_WINDOW_UPDATE_BYTES) {
      protocolError("invalid_window_update_length", "WINDOW_UPDATE payload must be exactly 8 bytes.");
    }
    return;
  }
  if (payloadLength < 1) {
    protocolError("invalid_control_payload_length", "Canonical JSON control payload cannot be empty.");
  }
  if (payloadLength > WIPC_CONTROL_PAYLOAD_MAX_BYTES) {
    protocolError("control_payload_too_large", "Canonical JSON control payload exceeds 32 KiB.");
  }
}

function validateWipcHeader(header: WipcFrameHeader): void {
  assertSupportedVersion(header.major, header.minor);
  assertFrameType(header.frameType);
  assertUint8(header.flags, "flags");
  if (header.flags !== 0) {
    protocolError("reserved_flags", "All WIPC V1 flag bits are reserved and must be zero.");
  }
  assertFrameStreamClass(header.frameType, header.streamId);
  assertFramePayloadLength(header.frameType, header.payloadLength);
}

export function encodeWipcHeader(header: WipcFrameHeader): Buffer {
  validateWipcHeader(header);
  const encoded = Buffer.alloc(WIPC_HEADER_BYTES);
  WIPC_MAGIC.copy(encoded, 0);
  encoded.writeUInt16BE(header.major, 4);
  encoded.writeUInt16BE(header.minor, 6);
  encoded.writeUInt8(header.frameType, 8);
  encoded.writeUInt8(header.flags, 9);
  encoded.writeUInt16BE(0, 10);
  encoded.writeBigUInt64BE(header.streamId, 12);
  encoded.writeUInt32BE(header.payloadLength, 20);
  return encoded;
}

export function decodeWipcHeader(bytes: Uint8Array): WipcFrameHeader {
  if (bytes.byteLength !== WIPC_HEADER_BYTES) {
    protocolError("invalid_header_length", "WIPC header must be exactly 24 bytes.");
  }
  const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!encoded.subarray(0, WIPC_MAGIC.byteLength).equals(WIPC_MAGIC)) {
    protocolError("invalid_magic", "WIPC header has invalid magic bytes.");
  }
  if (encoded.readUInt16BE(10) !== 0) {
    protocolError("reserved_bytes", "WIPC reserved header bytes must be zero.");
  }
  const frameType = encoded.readUInt8(8);
  assertFrameType(frameType);
  const header: WipcFrameHeader = {
    major: encoded.readUInt16BE(4),
    minor: encoded.readUInt16BE(6),
    frameType,
    flags: encoded.readUInt8(9),
    streamId: encoded.readBigUInt64BE(12),
    payloadLength: encoded.readUInt32BE(20)
  };
  validateWipcHeader(header);
  return header;
}

export function assertWipcEncodedHeadersLength(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    protocolError(
      "invalid_encoded_headers_length",
      "Encoded HTTP header length must be a nonnegative integer."
    );
  }
  if (byteLength > WIPC_ENCODED_HEADERS_MAX_BYTES) {
    protocolError("encoded_headers_too_large", "Encoded HTTP headers exceed 16 KiB.");
  }
}

function directionByte(direction: WipcWindowDirection): number {
  if (direction === "request") {
    return 1;
  }
  if (direction === "response") {
    return 2;
  }
  protocolError("invalid_window_direction", "WINDOW_UPDATE direction must be request or response.");
}

function assertCreditIncrement(creditIncrement: number): void {
  if (
    !Number.isInteger(creditIncrement)
    || creditIncrement < 1
    || creditIncrement > WIPC_INITIAL_STREAM_CREDIT_BYTES
  ) {
    protocolError(
      "invalid_credit_increment",
      "WINDOW_UPDATE credit increment must be between 1 and 1,048,576 bytes."
    );
  }
}

export function encodeWipcWindowUpdate(update: WipcWindowUpdate): Buffer {
  const encodedDirection = directionByte(update.direction);
  assertCreditIncrement(update.creditIncrement);
  const encoded = Buffer.alloc(WIPC_WINDOW_UPDATE_BYTES);
  encoded.writeUInt8(encodedDirection, 0);
  encoded.writeUInt32BE(update.creditIncrement, 4);
  return encoded;
}

export function decodeWipcWindowUpdate(bytes: Uint8Array): WipcWindowUpdate {
  if (bytes.byteLength !== WIPC_WINDOW_UPDATE_BYTES) {
    protocolError("invalid_window_update_length", "WINDOW_UPDATE payload must be exactly 8 bytes.");
  }
  const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directionValue = encoded.readUInt8(0);
  const direction: WipcWindowDirection = directionValue === 1
    ? "request"
    : directionValue === 2
      ? "response"
      : protocolError(
          "invalid_window_direction",
          "WINDOW_UPDATE direction byte must be 1 or 2."
        );
  if (encoded.readUIntBE(1, 3) !== 0) {
    protocolError("reserved_bytes", "WINDOW_UPDATE reserved bytes must be zero.");
  }
  const creditIncrement = encoded.readUInt32BE(4);
  assertCreditIncrement(creditIncrement);
  return { direction, creditIncrement };
}

function expectedParity(creator: WipcStreamCreator): bigint {
  if (creator === "node") {
    return 1n;
  }
  if (creator === "helper") {
    return 0n;
  }
  protocolError("stream_id_parity", "Unknown stream creator.");
}

function assertCreatorStreamId(creator: WipcStreamCreator, streamId: bigint): void {
  assertStreamId(streamId);
  if (streamId === 0n) {
    protocolError("invalid_stream_id", "Stream ID zero is reserved for connection control.");
  }
  if ((streamId & 1n) !== expectedParity(creator)) {
    protocolError(
      "stream_id_parity",
      creator === "node" ? "Node-created stream IDs must be odd." : "Helper-created stream IDs must be even."
    );
  }
}

export function nextWipcStreamId(creator: WipcStreamCreator, highestStreamId: bigint): bigint {
  assertStreamId(highestStreamId);
  if (highestStreamId !== 0n) {
    assertCreatorStreamId(creator, highestStreamId);
  }
  const first = creator === "node" ? 1n : 2n;
  if (highestStreamId === 0n) {
    return first;
  }
  if (highestStreamId > WIPC_UINT64_MAX - 2n) {
    protocolError("stream_id_exhausted", "WIPC stream ID space is exhausted before wraparound.");
  }
  return highestStreamId + 2n;
}

export function acceptWipcStreamId(
  creator: WipcStreamCreator,
  highestStreamId: bigint,
  streamId: bigint
): bigint {
  assertStreamId(highestStreamId);
  if (highestStreamId !== 0n) {
    assertCreatorStreamId(creator, highestStreamId);
  }
  assertCreatorStreamId(creator, streamId);
  if (streamId <= highestStreamId) {
    protocolError(
      "stream_id_reused",
      "REQUEST_START stream ID must be strictly greater than its creator's high-water mark."
    );
  }
  return streamId;
}

export class WipcStreamHighWater {
  #highestNodeStreamId = 0n;
  #highestHelperStreamId = 0n;

  accept(creator: WipcStreamCreator, streamId: bigint): void {
    const highest = creator === "node"
      ? this.#highestNodeStreamId
      : this.#highestHelperStreamId;
    const accepted = acceptWipcStreamId(creator, highest, streamId);
    if (creator === "node") {
      this.#highestNodeStreamId = accepted;
    } else {
      this.#highestHelperStreamId = accepted;
    }
  }

  snapshot(): Readonly<{
    highestNodeStreamId: bigint;
    highestHelperStreamId: bigint;
  }> {
    return Object.freeze({
      highestNodeStreamId: this.#highestNodeStreamId,
      highestHelperStreamId: this.#highestHelperStreamId
    });
  }
}

function assertExactWidth(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== WIPC_AUTH_VALUE_BYTES) {
    protocolError("invalid_auth_width", `${name} must contain exactly 32 bytes.`);
  }
}

function assertAuthTranscript(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    protocolError("invalid_auth_transcript", `${name} cannot be empty.`);
  }
  if (value.byteLength > WIPC_CONTROL_PAYLOAD_MAX_BYTES) {
    protocolError("invalid_auth_transcript", `${name} exceeds the canonical control payload limit.`);
  }
}

function updateParentTranscript(
  input: WipcParentProofInput,
  domain: Uint8Array
): ReturnType<typeof createHmac> {
  assertExactWidth(input.parentCapability, "parentCapability");
  assertExactWidth(input.clientNonce, "clientNonce");
  assertExactWidth(input.helperNonce, "helperNonce");
  assertAuthTranscript(input.helloBytes, "helloBytes");
  assertAuthTranscript(input.helloAckBytes, "helloAckBytes");
  return createHmac("sha256", input.parentCapability)
    .update(domain)
    .update(input.clientNonce)
    .update(input.helperNonce)
    .update(input.helloBytes)
    .update(input.helloAckBytes);
}

export function deriveWipcParentProof(input: WipcParentProofInput): Buffer {
  return updateParentTranscript(input, WIPC_PARENT_AUTH_DOMAIN).digest();
}

export function deriveWipcHelperProof(input: WipcHelperProofInput): Buffer {
  assertExactWidth(input.parentProof, "parentProof");
  return updateParentTranscript(input, WIPC_HELPER_AUTH_DOMAIN)
    .update(input.parentProof)
    .digest();
}

export function verifyWipcParentProof(input: WipcParentProofVerificationInput): boolean {
  assertExactWidth(input.parentProof, "parentProof");
  const expected = deriveWipcParentProof(input);
  return timingSafeEqual(expected, input.parentProof);
}

export function verifyWipcHelperProof(input: WipcHelperProofVerificationInput): boolean {
  assertExactWidth(input.helperProof, "helperProof");
  const expected = deriveWipcHelperProof(input);
  return timingSafeEqual(expected, input.helperProof);
}
