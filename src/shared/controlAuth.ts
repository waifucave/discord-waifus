import { createHash } from "node:crypto";
import {
  decodeCanonicalCbor,
  deriveEd25519PublicKey,
  encodeCanonicalCbor,
  signEd25519,
  verifyEd25519,
  type CanonicalCborValue
} from "./remotePairing.js";
import { UINT64_MAX } from "./schemas/remoteProtocol.js";

export const ACTIVATION_CERTIFICATE_MAX_BYTES = 384;
export const CONTROL_AUTH_HEADER_VALUES_MAX_BYTES = 1_024;
export const CONTROL_BODY_MAX_BYTES = 2_048;
export const TURNSTILE_COMPLETION_BODY_MAX_BYTES = 4_096;
export const CONTROL_TIMESTAMP_SKEW_SECONDS = 60n;
export const CONTROL_NONCE_RETENTION_SECONDS = 600n;
export const CONTROL_NONCE_MAX_ENTRIES = 1_024;
export const ACTIVATION_CERTIFICATE_LIFETIME_SECONDS = 365n * 24n * 60n * 60n;
export const ACTIVATION_CERTIFICATE_RENEWAL_SECONDS = 30n * 24n * 60n * 60n;

const ACTIVATION_CERTIFICATE_DOMAIN = Buffer.from(
  "waifus/activation-certificate/v1",
  "ascii"
);
const CONTROL_REQUEST_DOMAIN = Buffer.from("waifus/control-request/v1", "ascii");
const ACTIVATION_BEGIN_DOMAIN = Buffer.from("waifus/activation-begin/v1", "ascii");
const ACTIVATION_POLL_DOMAIN = Buffer.from("waifus/activation-poll/v1", "ascii");
const CONTROL_RESPONSE_DOMAIN = Buffer.from("waifus/control-response/v1", "ascii");
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const PROTOCOL_HEADER = "x-waifus-protocol";
const CERTIFICATE_HEADER = "x-waifus-certificate";
const INSTALLATION_KEY_HEADER = "x-waifus-installation-key";
const TIMESTAMP_HEADER = "x-waifus-timestamp";
const REQUEST_NONCE_HEADER = "x-waifus-request-nonce";
const REQUEST_SIGNATURE_HEADER = "x-waifus-request-signature";
const WORKER_KEY_ID_HEADER = "x-waifus-worker-key-id";
const RESPONSE_NONCE_HEADER = "x-waifus-response-nonce";
const RESPONSE_SIGNATURE_HEADER = "x-waifus-response-signature";

const REQUEST_AUTH_HEADERS = new Set([
  PROTOCOL_HEADER,
  CERTIFICATE_HEADER,
  INSTALLATION_KEY_HEADER,
  TIMESTAMP_HEADER,
  REQUEST_NONCE_HEADER,
  REQUEST_SIGNATURE_HEADER
]);
const RESPONSE_AUTH_HEADERS = new Set([
  PROTOCOL_HEADER,
  WORKER_KEY_ID_HEADER,
  TIMESTAMP_HEADER,
  RESPONSE_NONCE_HEADER,
  RESPONSE_SIGNATURE_HEADER
]);
const ALL_AUTH_HEADERS = new Set([...REQUEST_AUTH_HEADERS, ...RESPONSE_AUTH_HEADERS]);
const WORKER_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const METHOD_PATTERN = /^[A-Z]+$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type RawHeaderTupleV1 = readonly [name: string, value: string];
export type HeaderBoundaryV1 = "raw" | "normalized";
export type ControlRequestClassV1 =
  | "certificate"
  | "activation_begin"
  | "activation_poll"
  | "websocket";

export type ControlAuthErrorCode =
  | "invalid_certificate"
  | "invalid_certificate_signature"
  | "unknown_worker_key"
  | "certificate_not_yet_valid"
  | "certificate_expired"
  | "certificate_lifetime"
  | "certificate_revoked"
  | "credential_epoch_rollback"
  | "invalid_header_name"
  | "duplicate_header"
  | "unknown_auth_header"
  | "invalid_header_value"
  | "header_limit"
  | "missing_header"
  | "forbidden_header"
  | "invalid_request"
  | "invalid_signature"
  | "timestamp_out_of_window"
  | "nonce_replay"
  | "nonce_capacity"
  | "invalid_response"
  | "invalid_websocket";

export class ControlAuthProtocolError extends Error {
  constructor(
    readonly code: ControlAuthErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "ControlAuthProtocolError";
  }
}

function fail(code: ControlAuthErrorCode, detail: string): never {
  throw new ControlAuthProtocolError(code, detail);
}

function fixedBytes(
  value: Uint8Array,
  expected: number,
  name: string,
  code: ControlAuthErrorCode = "invalid_request"
): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== expected) {
    return fail(code, `${name} must be exactly ${expected} bytes.`);
  }
  return bytes;
}

function sha256(...values: readonly Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
  }
  return hash.digest();
}

function uint16BE(value: number, name: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError(`${name} must be a uint16 integer.`);
  }
  const encoded = Buffer.alloc(2);
  encoded.writeUInt16BE(value);
  return encoded;
}

function assertUint64(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${name} must be a uint64 bigint.`);
  }
  return value;
}

function uint64BE(value: bigint, name: string): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(assertUint64(value, name));
  return encoded;
}

function lengthPrefix(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function protocolBytes(major: number, minor: number): Buffer {
  return Buffer.concat([
    uint16BE(major, "protocol major"),
    uint16BE(minor, "protocol minor")
  ]);
}

function validateWorkerKeyId(value: string, code: ControlAuthErrorCode): string {
  if (!WORKER_KEY_ID_PATTERN.test(value) || Buffer.byteLength(value, "ascii") > 64) {
    return fail(code, "Worker signing-key ID is not canonical printable ASCII.");
  }
  return value;
}

function validateMethod(value: string): string {
  if (!METHOD_PATTERN.test(value) || value.length > 16) {
    return fail("invalid_request", "method must be uppercase ASCII.");
  }
  return value;
}

function validatePathname(value: string): string {
  if (
    value.length < 1
    || value.length > 512
    || value[0] !== "/"
    || value.includes("?")
    || value.includes("#")
    || value.includes("%")
    || value.includes("\\")
    || !/^[\x21-\x7E]+$/.test(value)
  ) {
    return fail(
      "invalid_request",
      "pathname must be an exact concrete printable-ASCII path without query or aliases."
    );
  }
  return value;
}

function validateBody(value: Uint8Array, code: ControlAuthErrorCode): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > CONTROL_BODY_MAX_BYTES) {
    return fail(code, "raw body exceeds 2,048 bytes.");
  }
  return bytes;
}

function exactMap(
  value: CanonicalCborValue,
  keys: readonly bigint[]
): ReadonlyMap<CanonicalCborValue, CanonicalCborValue> {
  if (!(value instanceof Map) || value.size !== keys.length) {
    return fail("invalid_certificate", "activation certificate must be an exact CBOR map.");
  }
  for (const key of keys) {
    if (!value.has(key)) {
      return fail("invalid_certificate", `activation certificate is missing key ${key}.`);
    }
  }
  return value;
}

function cborUint(value: CanonicalCborValue | undefined, name: string): bigint {
  if (typeof value !== "bigint") {
    return fail("invalid_certificate", `${name} must be a CBOR unsigned integer.`);
  }
  return value;
}

function cborBytes(
  value: CanonicalCborValue | undefined,
  length: number,
  name: string
): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== length) {
    return fail("invalid_certificate", `${name} must be a ${length}-byte CBOR byte string.`);
  }
  return Buffer.from(value);
}

function cborText(value: CanonicalCborValue | undefined, name: string): string {
  if (typeof value !== "string") {
    return fail("invalid_certificate", `${name} must be CBOR text.`);
  }
  return value;
}

function cborUint16(value: CanonicalCborValue | undefined, name: string): number {
  const parsed = cborUint(value, name);
  if (parsed > 65_535n) {
    return fail("invalid_certificate", `${name} exceeds uint16.`);
  }
  return Number(parsed);
}

export interface ActivationCertificateUnsignedV1 {
  version: 1;
  serial: Uint8Array;
  installationPublicKey: Uint8Array;
  issuedAt: bigint;
  expiresAt: bigint;
  credentialEpoch: bigint;
  coordinationMajor: number;
  coordinationMinor: number;
  quotaTier: 1;
  workerSigningKeyId: string;
}

export interface ActivationCertificateV1 {
  version: 1;
  serial: Buffer;
  installationPublicKey: Buffer;
  issuedAt: bigint;
  expiresAt: bigint;
  credentialEpoch: bigint;
  coordinationMajor: number;
  coordinationMinor: number;
  quotaTier: 1;
  workerSigningKeyId: string;
  signature: Buffer;
  unsignedCbor: Buffer;
  encodedCbor: Buffer;
}

function normalizeCertificateUnsigned(
  value: ActivationCertificateUnsignedV1
): ActivationCertificateUnsignedV1 & { serial: Buffer; installationPublicKey: Buffer } {
  if (value.version !== 1 || value.quotaTier !== 1) {
    return fail("invalid_certificate", "certificate version and free quota tier must be V1.");
  }
  const issuedAt = assertUint64(value.issuedAt, "certificate issued-at");
  const expiresAt = assertUint64(value.expiresAt, "certificate expires-at");
  const credentialEpoch = assertUint64(value.credentialEpoch, "credential epoch");
  if (credentialEpoch < 1n) {
    return fail("invalid_certificate", "credential epoch must be positive.");
  }
  if (expiresAt <= issuedAt) {
    return fail("invalid_certificate", "certificate expiry must follow issuance.");
  }
  if (expiresAt - issuedAt !== ACTIVATION_CERTIFICATE_LIFETIME_SECONDS) {
    return fail("certificate_lifetime", "activation certificate lifetime must be exactly 365 days.");
  }
  const coordinationMajor = uint16BE(
    value.coordinationMajor,
    "coordination major"
  ).readUInt16BE(0);
  const coordinationMinor = uint16BE(
    value.coordinationMinor,
    "coordination minor"
  ).readUInt16BE(0);
  if (coordinationMajor !== 1 || coordinationMinor !== 0) {
    return fail("invalid_certificate", "V1 certificate coordination protocol must be exactly 1.0.");
  }
  return {
    version: 1,
    serial: fixedBytes(value.serial, 16, "certificate serial", "invalid_certificate"),
    installationPublicKey: fixedBytes(
      value.installationPublicKey,
      32,
      "installation public key",
      "invalid_certificate"
    ),
    issuedAt,
    expiresAt,
    credentialEpoch,
    coordinationMajor,
    coordinationMinor,
    quotaTier: 1,
    workerSigningKeyId: validateWorkerKeyId(value.workerSigningKeyId, "invalid_certificate")
  };
}

function activationCertificateUnsignedMap(
  value: ActivationCertificateUnsignedV1
): Map<CanonicalCborValue, CanonicalCborValue> {
  const parsed = normalizeCertificateUnsigned(value);
  return new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, 1n],
    [2n, parsed.serial],
    [3n, parsed.installationPublicKey],
    [4n, parsed.issuedAt],
    [5n, parsed.expiresAt],
    [6n, parsed.credentialEpoch],
    [7n, BigInt(parsed.coordinationMajor)],
    [8n, BigInt(parsed.coordinationMinor)],
    [9n, 1n],
    [10n, parsed.workerSigningKeyId]
  ]);
}

export function encodeActivationCertificateUnsignedV1(
  value: ActivationCertificateUnsignedV1
): Buffer {
  return encodeCanonicalCbor(activationCertificateUnsignedMap(value));
}

export function encodeActivationCertificateSignatureInputV1(
  value: ActivationCertificateUnsignedV1
): Buffer {
  return Buffer.concat([
    lengthPrefix(ACTIVATION_CERTIFICATE_DOMAIN),
    lengthPrefix(encodeActivationCertificateUnsignedV1(value))
  ]);
}

export function createActivationCertificateV1(
  workerPrivateKeySeed: Uint8Array,
  value: ActivationCertificateUnsignedV1
): ActivationCertificateV1 {
  const parsed = normalizeCertificateUnsigned(value);
  const unsignedCbor = encodeActivationCertificateUnsignedV1(parsed);
  const signature = signEd25519(
    workerPrivateKeySeed,
    Buffer.concat([lengthPrefix(ACTIVATION_CERTIFICATE_DOMAIN), lengthPrefix(unsignedCbor)])
  );
  const signedMap = activationCertificateUnsignedMap(parsed);
  signedMap.set(11n, signature);
  const encodedCbor = encodeCanonicalCbor(signedMap);
  if (encodedCbor.byteLength > ACTIVATION_CERTIFICATE_MAX_BYTES) {
    return fail("invalid_certificate", "activation certificate exceeds 384 bytes.");
  }
  return { ...parsed, signature, unsignedCbor, encodedCbor };
}

export function decodeActivationCertificateV1(payload: Uint8Array): ActivationCertificateV1 {
  const encodedCbor = Buffer.from(payload);
  if (encodedCbor.byteLength < 1 || encodedCbor.byteLength > ACTIVATION_CERTIFICATE_MAX_BYTES) {
    return fail("invalid_certificate", "activation certificate is outside the 1-384 byte limit.");
  }
  let decoded: CanonicalCborValue;
  try {
    decoded = decodeCanonicalCbor(encodedCbor, ACTIVATION_CERTIFICATE_MAX_BYTES);
  } catch {
    return fail("invalid_certificate", "activation certificate is not deterministic RFC 8949 CBOR.");
  }
  const map = exactMap(decoded, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n]);
  const version = cborUint(map.get(1n), "version");
  const quotaTier = cborUint(map.get(9n), "quota tier");
  if (version !== 1n || quotaTier !== 1n) {
    return fail("invalid_certificate", "certificate version or quota tier is unsupported.");
  }
  const unsigned = normalizeCertificateUnsigned({
    version: 1,
    serial: cborBytes(map.get(2n), 16, "serial"),
    installationPublicKey: cborBytes(map.get(3n), 32, "installation public key"),
    issuedAt: cborUint(map.get(4n), "issued-at"),
    expiresAt: cborUint(map.get(5n), "expires-at"),
    credentialEpoch: cborUint(map.get(6n), "credential epoch"),
    coordinationMajor: cborUint16(map.get(7n), "coordination major"),
    coordinationMinor: cborUint16(map.get(8n), "coordination minor"),
    quotaTier: 1,
    workerSigningKeyId: cborText(map.get(10n), "Worker key ID")
  });
  const signature = cborBytes(map.get(11n), 64, "signature");
  const unsignedCbor = encodeActivationCertificateUnsignedV1(unsigned);
  return { ...unsigned, signature, unsignedCbor, encodedCbor };
}

export interface VerifyActivationCertificateOptionsV1 {
  workerKeys: ReadonlyMap<string, Uint8Array>;
  nowSeconds: bigint;
  minimumCredentialEpoch?: bigint;
  revokedSerials?: ReadonlySet<string>;
}

export function verifyActivationCertificateV1(
  payload: Uint8Array,
  options: VerifyActivationCertificateOptionsV1
): ActivationCertificateV1 {
  const certificate = decodeActivationCertificateV1(payload);
  const workerKey = options.workerKeys.get(certificate.workerSigningKeyId);
  if (!workerKey) {
    return fail("unknown_worker_key", "certificate Worker key ID is not pinned.");
  }
  if (!verifyEd25519(
    workerKey,
    Buffer.concat([
      lengthPrefix(ACTIVATION_CERTIFICATE_DOMAIN),
      lengthPrefix(certificate.unsignedCbor)
    ]),
    certificate.signature
  )) {
    return fail("invalid_certificate_signature", "activation certificate signature is invalid.");
  }
  const nowSeconds = assertUint64(options.nowSeconds, "current time");
  if (nowSeconds < certificate.issuedAt) {
    return fail("certificate_not_yet_valid", "activation certificate has not been issued yet.");
  }
  if (nowSeconds >= certificate.expiresAt) {
    return fail("certificate_expired", "activation certificate has expired.");
  }
  const minimumEpoch = options.minimumCredentialEpoch ?? 0n;
  assertUint64(minimumEpoch, "minimum credential epoch");
  if (certificate.credentialEpoch < minimumEpoch) {
    return fail("credential_epoch_rollback", "activation certificate credential epoch rolled back.");
  }
  const serial = certificate.serial.toString("base64url");
  if (options.revokedSerials?.has(serial)) {
    return fail("certificate_revoked", "activation certificate serial is revoked.");
  }
  return certificate;
}

export function activationCertificateRenewalStateV1(
  certificate: ActivationCertificateV1,
  nowSeconds: bigint
): "not_yet_valid" | "valid" | "renewal_due" | "expired" {
  const now = assertUint64(nowSeconds, "current time");
  if (now < certificate.issuedAt) {
    return "not_yet_valid";
  }
  if (now >= certificate.expiresAt) {
    return "expired";
  }
  return certificate.expiresAt - now <= ACTIVATION_CERTIFICATE_RENEWAL_SECONDS
    ? "renewal_due"
    : "valid";
}

function canonicalBase64Url(
  value: string,
  length: number,
  name: string,
  code: ControlAuthErrorCode = "invalid_header_value"
): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.includes("=")) {
    return fail(code, `${name} is not canonical unpadded base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || decoded.toString("base64url") !== value) {
    return fail(code, `${name} must decode canonically to ${length} bytes.`);
  }
  return decoded;
}

function canonicalUint64Decimal(value: string, name: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    return fail("invalid_header_value", `${name} is not canonical uint64 decimal.`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || parsed.toString(10) !== value) {
    return fail("invalid_header_value", `${name} exceeds uint64 or is noncanonical.`);
  }
  return parsed;
}

function validateHeaderValue(value: string): void {
  if (value.length < 1 || !/^[\x21-\x7E]+$/.test(value) || value.includes(",")) {
    return fail(
      "invalid_header_value",
      "authentication header values must be printable non-whitespace ASCII without comma."
    );
  }
}

interface ParsedHeadersV1 {
  all: ReadonlyMap<string, string>;
  auth: ReadonlyMap<string, string>;
  normalizedAuthHeaders: Readonly<Record<string, string>>;
}

function parseHeaders(
  rawHeaders: readonly RawHeaderTupleV1[],
  boundary: HeaderBoundaryV1
): ParsedHeadersV1 {
  const all = new Map<string, string>();
  const auth = new Map<string, string>();
  let authValueBytes = 0;
  for (const tuple of rawHeaders) {
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      return fail("invalid_header_name", "raw header tuple must contain exactly a name and value.");
    }
    const [rawName, rawValue] = tuple;
    if (
      typeof rawName !== "string"
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)
      || typeof rawValue !== "string"
    ) {
      return fail("invalid_header_name", "header name is not an HTTP token.");
    }
    const name = rawName.toLowerCase();
    if (all.has(name)) {
      return fail("duplicate_header", `${name} occurs more than once after case-folding.`);
    }
    all.set(name, rawValue);
    if (!name.startsWith("x-waifus-")) {
      continue;
    }
    if (boundary === "raw" && rawName !== name) {
      return fail("invalid_header_name", "raw application header names must be lower-case.");
    }
    if (!ALL_AUTH_HEADERS.has(name)) {
      return fail("unknown_auth_header", `${name} is not a V1 authentication header.`);
    }
    validateHeaderValue(rawValue);
    authValueBytes += Buffer.byteLength(rawValue, "ascii");
    if (authValueBytes > CONTROL_AUTH_HEADER_VALUES_MAX_BYTES) {
      return fail("header_limit", "aggregate application-auth header values exceed 1,024 bytes.");
    }
    auth.set(name, rawValue);
  }
  return {
    all,
    auth,
    normalizedAuthHeaders: Object.fromEntries([...auth.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };
}

function requireExactAuthHeaders(
  parsed: ParsedHeadersV1,
  required: ReadonlySet<string>
): void {
  for (const name of required) {
    if (!parsed.auth.has(name)) {
      return fail("missing_header", `${name} is required.`);
    }
  }
  for (const name of parsed.auth.keys()) {
    if (!required.has(name)) {
      return fail("forbidden_header", `${name} is forbidden for this envelope class.`);
    }
  }
}

function header(parsed: ParsedHeadersV1, name: string): string {
  const value = parsed.auth.get(name);
  if (value === undefined) {
    return fail("missing_header", `${name} is required.`);
  }
  return value;
}

function requireProtocolHeader(parsed: ParsedHeadersV1): void {
  if (header(parsed, PROTOCOL_HEADER) !== "1.0") {
    return fail("invalid_header_value", "x-waifus-protocol must be exactly 1.0.");
  }
}

function requireContentType(parsed: ParsedHeadersV1): void {
  if (parsed.all.get("content-type") !== "application/json") {
    return fail("invalid_request", "HTTPS JSON requests require exact application/json Content-Type.");
  }
}

function containsHttpToken(value: string | undefined, expected: string): boolean {
  if (value === undefined) {
    return false;
  }
  const tokens = value.split(",").map((token) => token.trim());
  return tokens.length > 0
    && tokens.every((token) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token))
    && tokens.some((token) => token.toLowerCase() === expected.toLowerCase());
}

function requireJsonResponseContentType(parsed: ParsedHeadersV1): void {
  if (parsed.all.get("content-type") !== "application/json") {
    return fail("invalid_response", "signed JSON responses require exact application/json Content-Type.");
  }
}

function standardBase64(value: string, length: number, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return fail("invalid_websocket", `${name} is not canonical standard base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== length || decoded.toString("base64") !== value) {
    return fail("invalid_websocket", `${name} must canonically decode to ${length} bytes.`);
  }
  return decoded;
}

function requireWebSocketRequestHeaders(parsed: ParsedHeadersV1): string {
  if (parsed.all.has("content-type") || parsed.all.has("sec-websocket-extensions")) {
    return fail("invalid_websocket", "WebSocket request forbids body Content-Type and extensions.");
  }
  if (!containsHttpToken(parsed.all.get("connection"), "upgrade")) {
    return fail("invalid_websocket", "Connection must contain the Upgrade token.");
  }
  if (parsed.all.get("upgrade")?.toLowerCase() !== "websocket") {
    return fail("invalid_websocket", "Upgrade must be exactly websocket.");
  }
  if (parsed.all.get("sec-websocket-version") !== "13") {
    return fail("invalid_websocket", "Sec-WebSocket-Version must be 13.");
  }
  if (parsed.all.get("sec-websocket-protocol") !== "waifus-control-v1") {
    return fail("invalid_websocket", "Sec-WebSocket-Protocol must be waifus-control-v1.");
  }
  const key = parsed.all.get("sec-websocket-key");
  if (!key) {
    return fail("invalid_websocket", "Sec-WebSocket-Key is required.");
  }
  standardBase64(key, 16, "Sec-WebSocket-Key");
  return key;
}

function webSocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`, "ascii").digest("base64");
}

function requireWebSocketResponseHeaders(
  parsed: ParsedHeadersV1,
  expectedKey: string
): void {
  standardBase64(expectedKey, 16, "expected Sec-WebSocket-Key");
  if (parsed.all.has("content-type") || parsed.all.has("sec-websocket-extensions")) {
    return fail("invalid_websocket", "WebSocket response forbids Content-Type and extensions.");
  }
  if (
    !containsHttpToken(parsed.all.get("connection"), "upgrade")
    || parsed.all.get("upgrade")?.toLowerCase() !== "websocket"
    || parsed.all.get("sec-websocket-protocol") !== "waifus-control-v1"
    || parsed.all.get("sec-websocket-accept") !== webSocketAccept(expectedKey)
  ) {
    return fail("invalid_websocket", "WebSocket 101 transport headers are invalid.");
  }
}

function validateTimestamp(timestamp: bigint, nowSeconds: bigint): void {
  const now = assertUint64(nowSeconds, "current time");
  const lower = now >= CONTROL_TIMESTAMP_SKEW_SECONDS
    ? now - CONTROL_TIMESTAMP_SKEW_SECONDS
    : 0n;
  const upper = now > UINT64_MAX - CONTROL_TIMESTAMP_SKEW_SECONDS
    ? UINT64_MAX
    : now + CONTROL_TIMESTAMP_SKEW_SECONDS;
  if (timestamp < lower || timestamp > upper) {
    return fail("timestamp_out_of_window", "signed timestamp is outside plus/minus 60 seconds.");
  }
}

function certificateRequestInput(
  method: string,
  pathname: string,
  rawBody: Uint8Array,
  certificate: ActivationCertificateV1,
  timestamp: bigint,
  requestNonce: Uint8Array
): Buffer {
  return Buffer.concat([
    lengthPrefix(CONTROL_REQUEST_DOMAIN),
    lengthPrefix(Buffer.from(validateMethod(method), "ascii")),
    lengthPrefix(Buffer.from(validatePathname(pathname), "ascii")),
    lengthPrefix(sha256(rawBody)),
    lengthPrefix(protocolBytes(certificate.coordinationMajor, certificate.coordinationMinor)),
    lengthPrefix(sha256(certificate.encodedCbor)),
    lengthPrefix(certificate.serial),
    lengthPrefix(uint64BE(certificate.credentialEpoch, "credential epoch")),
    lengthPrefix(certificate.installationPublicKey),
    lengthPrefix(Buffer.from(certificate.workerSigningKeyId, "ascii")),
    lengthPrefix(uint64BE(timestamp, "request timestamp")),
    lengthPrefix(fixedBytes(requestNonce, 16, "request nonce"))
  ]);
}

function activationRequestInput(
  requestClass: "activation_begin" | "activation_poll",
  method: string,
  pathname: string,
  rawBody: Uint8Array,
  installationPublicKey: Uint8Array,
  timestamp: bigint,
  requestNonce: Uint8Array
): Buffer {
  const expectedPath = requestClass === "activation_begin"
    ? "/v1/activation/challenges"
    : "/v1/activation/poll";
  if (method !== "POST" || pathname !== expectedPath) {
    return fail("invalid_request", `${requestClass} must use POST ${expectedPath}.`);
  }
  const domain = requestClass === "activation_begin"
    ? ACTIVATION_BEGIN_DOMAIN
    : ACTIVATION_POLL_DOMAIN;
  return Buffer.concat([
    lengthPrefix(domain),
    lengthPrefix(Buffer.from(method, "ascii")),
    lengthPrefix(Buffer.from(pathname, "ascii")),
    lengthPrefix(sha256(rawBody)),
    lengthPrefix(protocolBytes(1, 0)),
    lengthPrefix(fixedBytes(installationPublicKey, 32, "installation public key")),
    lengthPrefix(uint64BE(timestamp, "request timestamp")),
    lengthPrefix(fixedBytes(requestNonce, 16, "request nonce"))
  ]);
}

export function encodeCertificateControlRequestInputV1(input: {
  method: string;
  pathname: string;
  rawBody: Uint8Array;
  certificate: ActivationCertificateV1;
  timestamp: bigint;
  requestNonce: Uint8Array;
}): Buffer {
  return certificateRequestInput(
    input.method,
    input.pathname,
    validateBody(input.rawBody, "invalid_request"),
    input.certificate,
    input.timestamp,
    input.requestNonce
  );
}

export function encodeActivationControlRequestInputV1(input: {
  requestClass: "activation_begin" | "activation_poll";
  method: string;
  pathname: string;
  rawBody: Uint8Array;
  installationPublicKey: Uint8Array;
  timestamp: bigint;
  requestNonce: Uint8Array;
}): Buffer {
  return activationRequestInput(
    input.requestClass,
    input.method,
    input.pathname,
    validateBody(input.rawBody, "invalid_request"),
    input.installationPublicKey,
    input.timestamp,
    input.requestNonce
  );
}

export interface CreateControlRequestEnvelopeInputV1 {
  requestClass: ControlRequestClassV1;
  method: string;
  pathname: string;
  rawBody: Uint8Array;
  timestamp: bigint;
  requestNonce: Uint8Array;
  installationPrivateKeySeed: Uint8Array;
  certificateBytes?: Uint8Array;
  webSocketKey?: string;
}

export interface CreatedControlRequestEnvelopeV1 {
  rawHeaders: RawHeaderTupleV1[];
  normalizedAuthHeaders: Readonly<Record<string, string>>;
  signingInput: Buffer;
  signature: Buffer;
  requestBindingHash: Buffer;
}

export function createControlRequestEnvelopeV1(
  input: CreateControlRequestEnvelopeInputV1
): CreatedControlRequestEnvelopeV1 {
  const rawBody = validateBody(input.rawBody, "invalid_request");
  const installationPublicKey = deriveEd25519PublicKey(input.installationPrivateKeySeed);
  const requestNonce = fixedBytes(input.requestNonce, 16, "request nonce");
  const timestamp = assertUint64(input.timestamp, "request timestamp");
  let signingInput: Buffer;
  let authHeaders: RawHeaderTupleV1[];
  if (input.requestClass === "certificate" || input.requestClass === "websocket") {
    if (!input.certificateBytes) {
      return fail("invalid_request", "certificate-authenticated request requires a certificate.");
    }
    const certificate = decodeActivationCertificateV1(input.certificateBytes);
    if (!certificate.installationPublicKey.equals(installationPublicKey)) {
      return fail("invalid_request", "certificate is bound to a different installation key.");
    }
    if (input.requestClass === "websocket" && rawBody.byteLength !== 0) {
      return fail("invalid_websocket", "WebSocket upgrade body must be empty.");
    }
    signingInput = certificateRequestInput(
      input.method,
      input.pathname,
      rawBody,
      certificate,
      timestamp,
      requestNonce
    );
    const signature = signEd25519(input.installationPrivateKeySeed, signingInput);
    authHeaders = [
      [PROTOCOL_HEADER, "1.0"],
      [CERTIFICATE_HEADER, certificate.encodedCbor.toString("base64url")],
      [TIMESTAMP_HEADER, timestamp.toString(10)],
      [REQUEST_NONCE_HEADER, requestNonce.toString("base64url")],
      [REQUEST_SIGNATURE_HEADER, signature.toString("base64url")]
    ];
  } else {
    signingInput = activationRequestInput(
      input.requestClass,
      input.method,
      input.pathname,
      rawBody,
      installationPublicKey,
      timestamp,
      requestNonce
    );
    const signature = signEd25519(input.installationPrivateKeySeed, signingInput);
    authHeaders = [
      [PROTOCOL_HEADER, "1.0"],
      [INSTALLATION_KEY_HEADER, installationPublicKey.toString("base64url")],
      [TIMESTAMP_HEADER, timestamp.toString(10)],
      [REQUEST_NONCE_HEADER, requestNonce.toString("base64url")],
      [REQUEST_SIGNATURE_HEADER, signature.toString("base64url")]
    ];
  }
  const signature = Buffer.from(authHeaders[4][1], "base64url");
  const rawHeaders = [...authHeaders];
  if (input.requestClass === "websocket") {
    if (!input.webSocketKey) {
      return fail("invalid_websocket", "WebSocket request requires Sec-WebSocket-Key.");
    }
    standardBase64(input.webSocketKey, 16, "Sec-WebSocket-Key");
    rawHeaders.push(
      ["connection", "Upgrade"],
      ["upgrade", "websocket"],
      ["sec-websocket-key", input.webSocketKey],
      ["sec-websocket-version", "13"],
      ["sec-websocket-protocol", "waifus-control-v1"]
    );
  } else {
    rawHeaders.push(["content-type", "application/json"]);
  }
  return {
    rawHeaders,
    normalizedAuthHeaders: parseHeaders(rawHeaders, "raw").normalizedAuthHeaders,
    signingInput,
    signature,
    requestBindingHash: sha256(signingInput, signature)
  };
}

export interface ControlNonceWindowSnapshotV1 {
  entries: Array<{ identity: string; nonce: string; acceptedAt: string }>;
}

export class ControlNonceWindowV1 {
  private readonly entries = new Map<string, bigint>();

  constructor(snapshot?: ControlNonceWindowSnapshotV1) {
    if (!snapshot) {
      return;
    }
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > CONTROL_NONCE_MAX_ENTRIES) {
      return fail("nonce_capacity", "nonce snapshot exceeds its fixed entry limit.");
    }
    for (const entry of snapshot.entries) {
      const acceptedAt = canonicalUint64Decimal(entry.acceptedAt, "nonce accepted-at");
      const nonce = canonicalBase64Url(entry.nonce, 16, "replay nonce").toString("base64url");
      const key = `${entry.identity}:${nonce}`;
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(entry.identity) || this.entries.has(key)) {
        return fail("nonce_replay", "nonce snapshot is noncanonical or duplicated.");
      }
      this.entries.set(key, acceptedAt);
    }
  }

  accept(identity: string, nonceValue: Uint8Array, nowSeconds: bigint): void {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(identity)) {
      return fail("invalid_request", "nonce identity is not canonical.");
    }
    const now = assertUint64(nowSeconds, "nonce acceptance time");
    for (const [key, acceptedAt] of this.entries) {
      if (acceptedAt <= now && now - acceptedAt >= CONTROL_NONCE_RETENTION_SECONDS) {
        this.entries.delete(key);
      }
    }
    const nonce = fixedBytes(nonceValue, 16, "replay nonce").toString("base64url");
    const key = `${identity}:${nonce}`;
    if (this.entries.has(key)) {
      return fail("nonce_replay", "request or response nonce was already accepted.");
    }
    if (this.entries.size >= CONTROL_NONCE_MAX_ENTRIES) {
      return fail("nonce_capacity", "nonce replay window is at capacity.");
    }
    this.entries.set(key, now);
  }

  snapshot(): ControlNonceWindowSnapshotV1 {
    const entries = [...this.entries].map(([key, acceptedAt]) => {
      const separator = key.lastIndexOf(":");
      return {
        identity: key.slice(0, separator),
        nonce: key.slice(separator + 1),
        acceptedAt: acceptedAt.toString(10)
      };
    }).sort((left, right) => left.identity.localeCompare(right.identity) || left.nonce.localeCompare(right.nonce));
    return { entries };
  }
}

export interface VerifyControlRequestEnvelopeInputV1 {
  requestClass: ControlRequestClassV1;
  method: string;
  pathname: string;
  rawBody: Uint8Array;
  rawHeaders: readonly RawHeaderTupleV1[];
  workerKeys: ReadonlyMap<string, Uint8Array>;
  nowSeconds: bigint;
  headerBoundary: HeaderBoundaryV1;
  minimumCredentialEpoch?: bigint;
  revokedSerials?: ReadonlySet<string>;
  nonceWindow?: ControlNonceWindowV1;
}

export interface VerifiedControlRequestEnvelopeV1 {
  installationPublicKey: Buffer;
  certificate?: ActivationCertificateV1;
  timestamp: bigint;
  requestNonce: Buffer;
  signature: Buffer;
  signingInput: Buffer;
  requestBindingHash: Buffer;
  normalizedAuthHeaders: Readonly<Record<string, string>>;
  webSocketKey?: string;
}

export function verifyControlRequestEnvelopeV1(
  input: VerifyControlRequestEnvelopeInputV1
): VerifiedControlRequestEnvelopeV1 {
  const method = validateMethod(input.method);
  const pathname = validatePathname(input.pathname);
  const rawBody = validateBody(input.rawBody, "invalid_request");
  const parsed = parseHeaders(input.rawHeaders, input.headerBoundary);
  const certificateClass = input.requestClass === "certificate" || input.requestClass === "websocket";
  const required = certificateClass
    ? new Set([PROTOCOL_HEADER, CERTIFICATE_HEADER, TIMESTAMP_HEADER, REQUEST_NONCE_HEADER, REQUEST_SIGNATURE_HEADER])
    : new Set([PROTOCOL_HEADER, INSTALLATION_KEY_HEADER, TIMESTAMP_HEADER, REQUEST_NONCE_HEADER, REQUEST_SIGNATURE_HEADER]);
  requireExactAuthHeaders(parsed, required);
  requireProtocolHeader(parsed);
  let webSocketKeyValue: string | undefined;
  if (input.requestClass === "websocket") {
    if (method !== "GET" || rawBody.byteLength !== 0) {
      return fail("invalid_websocket", "pair-control WebSocket upgrade must be a bodyless GET.");
    }
    webSocketKeyValue = requireWebSocketRequestHeaders(parsed);
  } else {
    requireContentType(parsed);
  }
  const timestamp = canonicalUint64Decimal(header(parsed, TIMESTAMP_HEADER), "request timestamp");
  validateTimestamp(timestamp, input.nowSeconds);
  const requestNonce = canonicalBase64Url(header(parsed, REQUEST_NONCE_HEADER), 16, "request nonce");
  const signature = canonicalBase64Url(
    header(parsed, REQUEST_SIGNATURE_HEADER),
    64,
    "request signature"
  );
  let installationPublicKey: Buffer;
  let certificate: ActivationCertificateV1 | undefined;
  let signingInput: Buffer;
  if (certificateClass) {
    const certificateText = header(parsed, CERTIFICATE_HEADER);
    if (certificateText.length > 512 || !BASE64URL_PATTERN.test(certificateText)) {
      return fail("invalid_header_value", "certificate header is not canonical or exceeds 512 characters.");
    }
    const certificateBytes = Buffer.from(certificateText, "base64url");
    if (
      certificateBytes.byteLength > ACTIVATION_CERTIFICATE_MAX_BYTES
      || certificateBytes.toString("base64url") !== certificateText
    ) {
      return fail("invalid_header_value", "certificate header does not encode one canonical certificate.");
    }
    certificate = verifyActivationCertificateV1(certificateBytes, {
      workerKeys: input.workerKeys,
      nowSeconds: input.nowSeconds,
      minimumCredentialEpoch: input.minimumCredentialEpoch,
      revokedSerials: input.revokedSerials
    });
    installationPublicKey = certificate.installationPublicKey;
    signingInput = certificateRequestInput(
      method,
      pathname,
      rawBody,
      certificate,
      timestamp,
      requestNonce
    );
  } else {
    if (input.requestClass !== "activation_begin" && input.requestClass !== "activation_poll") {
      return fail("invalid_request", "pre-certificate request class is unsupported.");
    }
    installationPublicKey = canonicalBase64Url(
      header(parsed, INSTALLATION_KEY_HEADER),
      32,
      "installation key"
    );
    signingInput = activationRequestInput(
      input.requestClass,
      method,
      pathname,
      rawBody,
      installationPublicKey,
      timestamp,
      requestNonce
    );
  }
  if (!verifyEd25519(installationPublicKey, signingInput, signature)) {
    return fail("invalid_signature", "installation request signature is invalid.");
  }
  input.nonceWindow?.accept(
    `request:${installationPublicKey.toString("base64url")}`,
    requestNonce,
    input.nowSeconds
  );
  return {
    installationPublicKey,
    certificate,
    timestamp,
    requestNonce,
    signature,
    signingInput,
    requestBindingHash: sha256(signingInput, signature),
    normalizedAuthHeaders: parsed.normalizedAuthHeaders,
    webSocketKey: webSocketKeyValue
  };
}

export function encodeControlResponseInputV1(input: {
  pathname: string;
  status: number;
  rawBody: Uint8Array;
  protocolMajor: number;
  protocolMinor: number;
  workerSigningKeyId: string;
  timestamp: bigint;
  responseNonce: Uint8Array;
  requestBindingHash: Uint8Array;
}): Buffer {
  const rawBody = validateBody(input.rawBody, "invalid_response");
  if (input.status < 100 || input.status > 599) {
    return fail("invalid_response", "HTTP status must be between 100 and 599.");
  }
  if (input.protocolMajor !== 1 || input.protocolMinor !== 0) {
    return fail("invalid_response", "V1 response protocol must be exactly 1.0.");
  }
  return Buffer.concat([
    lengthPrefix(CONTROL_RESPONSE_DOMAIN),
    lengthPrefix(Buffer.from(validatePathname(input.pathname), "ascii")),
    lengthPrefix(uint16BE(input.status, "HTTP status")),
    lengthPrefix(sha256(rawBody)),
    lengthPrefix(protocolBytes(input.protocolMajor, input.protocolMinor)),
    lengthPrefix(Buffer.from(validateWorkerKeyId(input.workerSigningKeyId, "invalid_response"), "ascii")),
    lengthPrefix(uint64BE(input.timestamp, "response timestamp")),
    lengthPrefix(fixedBytes(input.responseNonce, 16, "response nonce", "invalid_response")),
    lengthPrefix(fixedBytes(input.requestBindingHash, 32, "request binding hash", "invalid_response"))
  ]);
}

export interface VerifyBrowserControlExceptionInputV1 {
  method: string;
  pathname: "/activate" | "/v1/activation/complete";
  rawBody: Uint8Array;
  rawHeaders: readonly RawHeaderTupleV1[];
  headerBoundary: HeaderBoundaryV1;
}

export function verifyBrowserControlExceptionV1(
  input: VerifyBrowserControlExceptionInputV1
): void {
  const parsed = parseHeaders(input.rawHeaders, input.headerBoundary);
  if (parsed.auth.size !== 0) {
    return fail("forbidden_header", "browser activation routes forbid every x-waifus-* header.");
  }
  if (input.pathname === "/activate") {
    if (input.method !== "GET" || input.rawBody.byteLength !== 0 || parsed.all.has("content-type")) {
      return fail("invalid_request", "browser activation document must be a bodyless GET.");
    }
    return;
  }
  if (
    input.pathname !== "/v1/activation/complete"
    || input.method !== "POST"
    || input.rawBody.byteLength > TURNSTILE_COMPLETION_BODY_MAX_BYTES
    || parsed.all.get("content-type") !== "application/json"
  ) {
    return fail(
      "invalid_request",
      "browser activation completion must be a JSON POST within 4,096 raw bytes."
    );
  }
}

export interface CreateControlResponseEnvelopeInputV1 {
  pathname: string;
  status: number;
  rawBody: Uint8Array;
  protocolMajor: number;
  protocolMinor: number;
  workerSigningKeyId: string;
  timestamp: bigint;
  responseNonce: Uint8Array;
  requestBindingHash: Uint8Array;
  workerPrivateKeySeed: Uint8Array;
  webSocketKey?: string;
}

export interface CreatedControlResponseEnvelopeV1 {
  rawHeaders: RawHeaderTupleV1[];
  normalizedAuthHeaders: Readonly<Record<string, string>>;
  signingInput: Buffer;
  signature: Buffer;
}

export function createControlResponseEnvelopeV1(
  input: CreateControlResponseEnvelopeInputV1
): CreatedControlResponseEnvelopeV1 {
  if ((input.status === 101) !== (input.webSocketKey !== undefined)) {
    return fail("invalid_response", "only a WebSocket 101 response may carry a WebSocket key.");
  }
  const rawBody = validateBody(input.rawBody, "invalid_response");
  if (input.status === 101 && rawBody.byteLength !== 0) {
    return fail("invalid_websocket", "WebSocket 101 response body must be empty.");
  }
  const signingInput = encodeControlResponseInputV1(input);
  const signature = signEd25519(input.workerPrivateKeySeed, signingInput);
  const authHeaders: RawHeaderTupleV1[] = [
    [PROTOCOL_HEADER, `${input.protocolMajor}.${input.protocolMinor}`],
    [WORKER_KEY_ID_HEADER, input.workerSigningKeyId],
    [TIMESTAMP_HEADER, input.timestamp.toString(10)],
    [RESPONSE_NONCE_HEADER, Buffer.from(input.responseNonce).toString("base64url")],
    [RESPONSE_SIGNATURE_HEADER, signature.toString("base64url")]
  ];
  const rawHeaders = [...authHeaders];
  if (input.status === 101) {
    const key = input.webSocketKey as string;
    standardBase64(key, 16, "Sec-WebSocket-Key");
    rawHeaders.push(
      ["connection", "Upgrade"],
      ["upgrade", "websocket"],
      ["sec-websocket-accept", webSocketAccept(key)],
      ["sec-websocket-protocol", "waifus-control-v1"]
    );
  } else {
    rawHeaders.push(["content-type", "application/json"]);
  }
  return {
    rawHeaders,
    normalizedAuthHeaders: parseHeaders(rawHeaders, "raw").normalizedAuthHeaders,
    signingInput,
    signature
  };
}

export interface VerifyControlResponseEnvelopeInputV1 {
  pathname: string;
  status: number;
  rawBody: Uint8Array;
  rawHeaders: readonly RawHeaderTupleV1[];
  requestBindingHash: Uint8Array;
  workerKeys: ReadonlyMap<string, Uint8Array>;
  nowSeconds: bigint;
  headerBoundary: HeaderBoundaryV1;
  expectedWebSocketKey?: string;
  nonceWindow?: ControlNonceWindowV1;
}

export interface VerifiedControlResponseEnvelopeV1 {
  workerSigningKeyId: string;
  timestamp: bigint;
  responseNonce: Buffer;
  signature: Buffer;
  signingInput: Buffer;
  normalizedAuthHeaders: Readonly<Record<string, string>>;
}

export function verifyControlResponseEnvelopeV1(
  input: VerifyControlResponseEnvelopeInputV1
): VerifiedControlResponseEnvelopeV1 {
  const pathname = validatePathname(input.pathname);
  const rawBody = validateBody(input.rawBody, "invalid_response");
  const parsed = parseHeaders(input.rawHeaders, input.headerBoundary);
  requireExactAuthHeaders(parsed, new Set([
    PROTOCOL_HEADER,
    WORKER_KEY_ID_HEADER,
    TIMESTAMP_HEADER,
    RESPONSE_NONCE_HEADER,
    RESPONSE_SIGNATURE_HEADER
  ]));
  requireProtocolHeader(parsed);
  if (input.status === 101) {
    if (!input.expectedWebSocketKey || rawBody.byteLength !== 0) {
      return fail("invalid_websocket", "signed 101 requires the request WebSocket key and empty body.");
    }
    requireWebSocketResponseHeaders(parsed, input.expectedWebSocketKey);
  } else {
    if (input.expectedWebSocketKey !== undefined) {
      return fail("invalid_response", "non-101 response cannot be accepted as a WebSocket response.");
    }
    requireJsonResponseContentType(parsed);
  }
  const workerSigningKeyId = validateWorkerKeyId(
    header(parsed, WORKER_KEY_ID_HEADER),
    "invalid_header_value"
  );
  const workerKey = input.workerKeys.get(workerSigningKeyId);
  if (!workerKey) {
    return fail("unknown_worker_key", "response Worker key ID is not pinned.");
  }
  const timestamp = canonicalUint64Decimal(header(parsed, TIMESTAMP_HEADER), "response timestamp");
  validateTimestamp(timestamp, input.nowSeconds);
  const responseNonce = canonicalBase64Url(
    header(parsed, RESPONSE_NONCE_HEADER),
    16,
    "response nonce"
  );
  const signature = canonicalBase64Url(
    header(parsed, RESPONSE_SIGNATURE_HEADER),
    64,
    "response signature"
  );
  const signingInput = encodeControlResponseInputV1({
    pathname,
    status: input.status,
    rawBody,
    protocolMajor: 1,
    protocolMinor: 0,
    workerSigningKeyId,
    timestamp,
    responseNonce,
    requestBindingHash: input.requestBindingHash
  });
  if (!verifyEd25519(workerKey, signingInput, signature)) {
    return fail("invalid_signature", "Worker response signature is invalid.");
  }
  input.nonceWindow?.accept(
    `response:${workerSigningKeyId}`,
    responseNonce,
    input.nowSeconds
  );
  return {
    workerSigningKeyId,
    timestamp,
    responseNonce,
    signature,
    signingInput,
    normalizedAuthHeaders: parsed.normalizedAuthHeaders
  };
}
