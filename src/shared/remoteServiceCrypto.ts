import {
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual
} from "node:crypto";
import { TextDecoder } from "node:util";
import {
  ApprovalReceiptV1Schema,
  type ApprovalReceiptV1
} from "./schemas/remoteAccess.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  DeviceIdSchema,
  HttpMethodSchema,
  RemoteBrowserContextEnvelopeV1Schema,
  RemoteBrowserContextV1Schema,
  UINT64_MAX,
  Uint64DecimalSchema,
  type HttpMethod,
  type RemoteBrowserContextEnvelopeV1,
  type RemoteBrowserContextV1
} from "./schemas/remoteProtocol.js";
import {
  deriveEd25519PublicKey,
  signEd25519,
  verifyEd25519
} from "./remotePairing.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

export const APPLICATION_SESSION_PROTOCOL_MAJOR = 1;
export const APPLICATION_DIRECT_STREAM_ID = 1n;

const APPLICATION_SESSION_DOMAIN = Buffer.from("waifus-app-session-v1", "ascii");
const BROWSER_CONTEXT_KEY_DOMAIN = Buffer.from("waifus/browser-context-key/v1", "ascii");
const BROWSER_CONTEXT_MAC_DOMAIN = Buffer.from("waifus/remote-browser-context/v1", "ascii");
const APPROVAL_RECEIPT_DOMAIN = Buffer.from("waifus/approval-receipt/v1", "ascii");
const ZERO_BYTE = Buffer.from([0]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type RemoteServiceCryptoErrorCode =
  | "invalid_application_session"
  | "auth_sequence_error"
  | "invalid_browser_context"
  | "invalid_browser_context_mac"
  | "wrong_pair"
  | "wrong_remote_device"
  | "wrong_remote_bundle"
  | "wrong_trust_epoch"
  | "wrong_application_session"
  | "stale_gateway_launch"
  | "stale_browser_session"
  | "gateway_launch_expired"
  | "request_binding_mismatch"
  | "replayed_request_nonce"
  | "replayed_direct_request_id"
  | "stale_parent_stream";

export class RemoteServiceCryptoError extends Error {
  constructor(
    readonly code: RemoteServiceCryptoErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "RemoteServiceCryptoError";
  }
}

function fail(code: RemoteServiceCryptoErrorCode, detail: string): never {
  throw new RemoteServiceCryptoError(code, detail);
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

function decodedFixedBytes(value: string, expected: number, name: string): Buffer {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== expected || bytes.toString("base64url") !== value) {
    throw new TypeError(`${name} must be canonical base64url for ${expected} bytes.`);
  }
  return bytes;
}

function assertUint64(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${name} must be a uint64 bigint.`);
  }
  return value;
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

function uint64BE(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(assertUint64(value, "value"));
  return encoded;
}

function lengthPrefix(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32BE(bytes.byteLength), bytes]);
}

export interface ApplicationSessionContextV1 {
  negotiatedMinor: number;
  pairId: Uint8Array;
  serviceId: Uint8Array;
  hostNonce: Uint8Array;
  remoteNonce: Uint8Array;
  hostInstallationBundleHash: Uint8Array;
  remoteInstallationBundleHash: Uint8Array;
  hostTrustEpoch: bigint;
  remoteTrustEpoch: bigint;
  hostTransportSessionId: Uint8Array;
  remoteTransportSessionId: Uint8Array;
}

interface NormalizedApplicationSessionContextV1 {
  negotiatedMinor: number;
  pairId: Buffer;
  serviceId: Buffer;
  hostNonce: Buffer;
  remoteNonce: Buffer;
  hostInstallationBundleHash: Buffer;
  remoteInstallationBundleHash: Buffer;
  hostTrustEpoch: bigint;
  remoteTrustEpoch: bigint;
  hostTransportSessionId: Buffer;
  remoteTransportSessionId: Buffer;
}

function normalizeApplicationSession(
  value: ApplicationSessionContextV1
): NormalizedApplicationSessionContextV1 {
  if (!Number.isInteger(value.negotiatedMinor) || value.negotiatedMinor < 0 || value.negotiatedMinor > 65_535) {
    throw new RangeError("negotiated minor must be a uint16 integer.");
  }
  const normalized = {
    negotiatedMinor: value.negotiatedMinor,
    pairId: fixedBytes(value.pairId, 16, "pair ID"),
    serviceId: fixedBytes(value.serviceId, 16, "service ID"),
    hostNonce: fixedBytes(value.hostNonce, 32, "host nonce"),
    remoteNonce: fixedBytes(value.remoteNonce, 32, "remote nonce"),
    hostInstallationBundleHash: fixedBytes(
      value.hostInstallationBundleHash,
      32,
      "host installation bundle hash"
    ),
    remoteInstallationBundleHash: fixedBytes(
      value.remoteInstallationBundleHash,
      32,
      "remote installation bundle hash"
    ),
    hostTrustEpoch: assertUint64(value.hostTrustEpoch, "host trust epoch"),
    remoteTrustEpoch: assertUint64(value.remoteTrustEpoch, "remote trust epoch"),
    hostTransportSessionId: fixedBytes(value.hostTransportSessionId, 16, "host transport session ID"),
    remoteTransportSessionId: fixedBytes(
      value.remoteTransportSessionId,
      16,
      "remote transport session ID"
    )
  };
  if (timingSafeEqual(
    normalized.hostInstallationBundleHash,
    normalized.remoteInstallationBundleHash
  )) {
    throw new TypeError("Host and remote installation bundle hashes must differ.");
  }
  if (timingSafeEqual(normalized.hostNonce, normalized.remoteNonce)) {
    throw new TypeError("Host and remote nonces must differ.");
  }
  if (timingSafeEqual(
    normalized.hostTransportSessionId,
    normalized.remoteTransportSessionId
  )) {
    throw new TypeError("Host and remote transport session IDs must differ.");
  }
  return normalized;
}

export function encodeApplicationSessionSignedBytesV1(
  value: ApplicationSessionContextV1
): Buffer {
  const context = normalizeApplicationSession(value);
  const protocolBytes = Buffer.concat([
    uint16BE(APPLICATION_SESSION_PROTOCOL_MAJOR),
    uint16BE(context.negotiatedMinor)
  ]);
  return Buffer.concat([
    lengthPrefix(APPLICATION_SESSION_DOMAIN),
    lengthPrefix(protocolBytes),
    lengthPrefix(context.pairId),
    lengthPrefix(context.serviceId),
    lengthPrefix(context.hostNonce),
    lengthPrefix(context.remoteNonce),
    lengthPrefix(context.hostInstallationBundleHash),
    lengthPrefix(context.remoteInstallationBundleHash),
    lengthPrefix(uint64BE(context.hostTrustEpoch)),
    lengthPrefix(uint64BE(context.remoteTrustEpoch)),
    lengthPrefix(context.hostTransportSessionId),
    lengthPrefix(context.remoteTransportSessionId)
  ]);
}

class ApplicationSessionDecoderV1 {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  private read(length: number): Buffer {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
      return fail("invalid_application_session", "application-session bytes are truncated.");
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readLengthPrefixed(expected: number, name: string): Buffer {
    const length = this.read(4).readUInt32BE(0);
    if (length !== expected) {
      return fail("invalid_application_session", `${name} has the wrong encoded width.`);
    }
    return this.read(length);
  }

  decode(expectedMinor?: number): ApplicationSessionContextV1 {
    const domain = this.readLengthPrefixed(APPLICATION_SESSION_DOMAIN.byteLength, "domain");
    if (!domain.equals(APPLICATION_SESSION_DOMAIN)) {
      return fail("invalid_application_session", "application-session domain does not match V1.");
    }
    const protocol = this.readLengthPrefixed(4, "protocol");
    if (protocol.readUInt16BE(0) !== APPLICATION_SESSION_PROTOCOL_MAJOR) {
      return fail("invalid_application_session", "application-session protocol major is unsupported.");
    }
    const negotiatedMinor = protocol.readUInt16BE(2);
    if (expectedMinor !== undefined && negotiatedMinor !== expectedMinor) {
      return fail("invalid_application_session", "application-session minor was not negotiated.");
    }
    const result: ApplicationSessionContextV1 = {
      negotiatedMinor,
      pairId: this.readLengthPrefixed(16, "pair ID"),
      serviceId: this.readLengthPrefixed(16, "service ID"),
      hostNonce: this.readLengthPrefixed(32, "host nonce"),
      remoteNonce: this.readLengthPrefixed(32, "remote nonce"),
      hostInstallationBundleHash: this.readLengthPrefixed(32, "host bundle hash"),
      remoteInstallationBundleHash: this.readLengthPrefixed(32, "remote bundle hash"),
      hostTrustEpoch: this.readLengthPrefixed(8, "host trust epoch").readBigUInt64BE(0),
      remoteTrustEpoch: this.readLengthPrefixed(8, "remote trust epoch").readBigUInt64BE(0),
      hostTransportSessionId: this.readLengthPrefixed(16, "host transport session ID"),
      remoteTransportSessionId: this.readLengthPrefixed(16, "remote transport session ID")
    };
    if (this.offset !== this.bytes.byteLength) {
      return fail("invalid_application_session", "application-session bytes contain trailing data.");
    }
    normalizeApplicationSession(result);
    return result;
  }
}

export function decodeApplicationSessionSignedBytesV1(
  payload: Uint8Array,
  expectedMinor?: number
): ApplicationSessionContextV1 {
  return new ApplicationSessionDecoderV1(Buffer.from(payload)).decode(expectedMinor);
}

export interface ApplicationSessionProofsV1 {
  signedBytes: Buffer;
  digest: Buffer;
  hostSignature: Buffer;
  remoteSignature: Buffer;
  applicationSessionHash: Buffer;
}

export function createApplicationSessionProofsV1(
  context: ApplicationSessionContextV1,
  hostInstallationPrivateKeySeed: Uint8Array,
  remoteInstallationPrivateKeySeed: Uint8Array
): ApplicationSessionProofsV1 {
  const signedBytes = encodeApplicationSessionSignedBytesV1(context);
  const digest = sha256(signedBytes);
  const hostSignature = signEd25519(hostInstallationPrivateKeySeed, digest);
  const remoteSignature = signEd25519(remoteInstallationPrivateKeySeed, digest);
  return {
    signedBytes,
    digest,
    hostSignature,
    remoteSignature,
    applicationSessionHash: sha256(signedBytes, hostSignature, remoteSignature)
  };
}

export interface VerifyApplicationSessionProofsV1Input {
  context: ApplicationSessionContextV1;
  hostInstallationPublicKey: Uint8Array;
  remoteInstallationPublicKey: Uint8Array;
  hostSignature: Uint8Array;
  remoteSignature: Uint8Array;
}

export function verifyApplicationSessionProofsV1(
  input: VerifyApplicationSessionProofsV1Input
): boolean {
  try {
    const digest = sha256(encodeApplicationSessionSignedBytesV1(input.context));
    return verifyEd25519(input.hostInstallationPublicKey, digest, input.hostSignature)
      && verifyEd25519(input.remoteInstallationPublicKey, digest, input.remoteSignature);
  } catch {
    return false;
  }
}

export function deriveApplicationSessionHashV1(
  context: ApplicationSessionContextV1,
  hostSignature: Uint8Array,
  remoteSignature: Uint8Array
): Buffer {
  return sha256(
    encodeApplicationSessionSignedBytesV1(context),
    fixedBytes(hostSignature, 64, "host signature"),
    fixedBytes(remoteSignature, 64, "remote signature")
  );
}

export type ApplicationSessionRoleV1 = "host" | "remote";
export type ApplicationSessionAuthStateV1 =
  | "idle"
  | "hello_sent"
  | "hello_received"
  | "host_authenticated"
  | "hello_ack_sent"
  | "peer_auth_sent"
  | "remote_authenticated"
  | "authenticated";
export type ApplicationSessionAuthEventV1 =
  | "send_hello"
  | "receive_hello"
  | "send_hello_ack"
  | "receive_verified_hello_ack"
  | "send_authenticate_peer"
  | "receive_verified_authenticate_peer"
  | "send_success_result"
  | "receive_success_result";

const AUTH_TRANSITIONS: Readonly<Record<
  ApplicationSessionRoleV1,
  Readonly<Record<string, readonly [ApplicationSessionAuthEventV1, ApplicationSessionAuthStateV1]>>
>> = {
  remote: {
    idle: ["send_hello", "hello_sent"],
    hello_sent: ["receive_verified_hello_ack", "host_authenticated"],
    host_authenticated: ["send_authenticate_peer", "peer_auth_sent"],
    peer_auth_sent: ["receive_success_result", "authenticated"]
  },
  host: {
    idle: ["receive_hello", "hello_received"],
    hello_received: ["send_hello_ack", "hello_ack_sent"],
    hello_ack_sent: ["receive_verified_authenticate_peer", "remote_authenticated"],
    remote_authenticated: ["send_success_result", "authenticated"]
  }
};

export class ApplicationSessionAuthenticationV1 {
  private currentState: ApplicationSessionAuthStateV1 = "idle";

  constructor(readonly role: ApplicationSessionRoleV1) {}

  get state(): ApplicationSessionAuthStateV1 {
    return this.currentState;
  }

  get canAcceptRequestStart(): boolean {
    return this.currentState === "authenticated";
  }

  transition(event: ApplicationSessionAuthEventV1): void {
    const transition = AUTH_TRANSITIONS[this.role][this.currentState];
    if (!transition || transition[0] !== event) {
      return fail(
        "auth_sequence_error",
        `${this.role} cannot ${event} while application authentication is ${this.currentState}.`
      );
    }
    this.currentState = transition[1];
  }
}

export function serializeRemoteBrowserContextV1(value: unknown): Buffer {
  const parsed = RemoteBrowserContextV1Schema.parse(value);
  return Buffer.from(
    serializeCanonicalContractJson(parsed as unknown as ContractJson),
    "utf8"
  );
}

export interface DeriveRemoteBrowserContextKeyV1Input {
  pairRoot: Uint8Array;
  applicationSessionHash: Uint8Array;
  applicationSession: ApplicationSessionContextV1;
}

export function deriveRemoteBrowserContextKeyV1(
  input: DeriveRemoteBrowserContextKeyV1Input
): Buffer {
  const pairRoot = fixedBytes(input.pairRoot, 32, "pair root");
  const applicationSessionHash = fixedBytes(
    input.applicationSessionHash,
    32,
    "application-session hash"
  );
  const session = normalizeApplicationSession(input.applicationSession);
  const info = Buffer.concat([
    BROWSER_CONTEXT_KEY_DOMAIN,
    ZERO_BYTE,
    session.pairId,
    session.serviceId,
    session.hostInstallationBundleHash,
    session.remoteInstallationBundleHash,
    uint64BE(session.hostTrustEpoch),
    uint64BE(session.remoteTrustEpoch),
    session.hostTransportSessionId,
    session.remoteTransportSessionId
  ]);
  return Buffer.from(hkdfSync("sha256", pairRoot, applicationSessionHash, info, 32));
}

function envelopeWithoutMac(value: unknown): RemoteBrowserContextEnvelopeV1 {
  return RemoteBrowserContextEnvelopeV1Schema.parse(value);
}

export function encodeRemoteBrowserContextMacInputV1(value: unknown): Buffer {
  const envelope = envelopeWithoutMac(value);
  return Buffer.concat([
    lengthPrefix(BROWSER_CONTEXT_MAC_DOMAIN),
    lengthPrefix(serializeRemoteBrowserContextV1(envelope.browserContext)),
    lengthPrefix(decodedFixedBytes(envelope.pairId, 16, "pair ID")),
    lengthPrefix(Buffer.from(DeviceIdSchema.parse(envelope.remoteDeviceId), "utf8")),
    lengthPrefix(decodedFixedBytes(
      envelope.remoteInstallationBundleHash,
      32,
      "remote installation bundle hash"
    )),
    lengthPrefix(uint64BE(BigInt(envelope.hostTrustEpoch))),
    lengthPrefix(uint64BE(BigInt(envelope.remoteTrustEpoch))),
    lengthPrefix(decodedFixedBytes(envelope.applicationSessionHash, 32, "application-session hash")),
    lengthPrefix(decodedFixedBytes(envelope.directRequestId, 16, "direct request ID")),
    lengthPrefix(uint64BE(BigInt(envelope.remoteParentStreamId))),
    lengthPrefix(uint64BE(BigInt(envelope.directStreamId)))
  ]);
}

export function deriveRemoteBrowserContextMacV1(
  browserContextKey: Uint8Array,
  envelope: unknown
): Buffer {
  const key = fixedBytes(browserContextKey, 32, "browser-context key");
  return createHmac("sha256", key)
    .update(encodeRemoteBrowserContextMacInputV1(envelope))
    .digest();
}

export function verifyRemoteBrowserContextMacV1(
  browserContextKey: Uint8Array,
  envelope: unknown
): boolean {
  try {
    const parsed = envelopeWithoutMac(envelope);
    const expected = deriveRemoteBrowserContextMacV1(browserContextKey, parsed);
    const actual = decodedFixedBytes(parsed.mac, 32, "browser-context MAC");
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export interface RemoteBrowserContextReplayGuardConfigV1 {
  pairId: string;
  remoteDeviceId: string;
  remoteInstallationBundleHash: string;
  hostTrustEpoch: string;
  remoteTrustEpoch: string;
  gatewayLaunchId: string;
  browserSessionId: string;
  gatewayExpiresAt: string;
}

export interface VerifyAndConsumeRemoteBrowserContextV1Input {
  envelope: unknown;
  browserContextKey: Uint8Array;
  applicationSessionHash: string;
  now: string;
  method: HttpMethod;
  canonicalTarget: string;
}

export class RemoteBrowserContextReplayGuardV1 {
  private readonly expected: RemoteBrowserContextReplayGuardConfigV1;
  private readonly requestNonces = new Set<string>();
  private readonly directRequestIds = new Set<string>();
  private parentStreamHighWater = 0n;

  constructor(config: RemoteBrowserContextReplayGuardConfigV1) {
    this.expected = {
      pairId: Base64Url16BytesSchema.parse(config.pairId),
      remoteDeviceId: DeviceIdSchema.parse(config.remoteDeviceId),
      remoteInstallationBundleHash: Base64Url32BytesSchema.parse(
        config.remoteInstallationBundleHash
      ),
      hostTrustEpoch: Uint64DecimalSchema.parse(config.hostTrustEpoch),
      remoteTrustEpoch: Uint64DecimalSchema.parse(config.remoteTrustEpoch),
      gatewayLaunchId: Base64Url32BytesSchema.parse(config.gatewayLaunchId),
      browserSessionId: Base64Url32BytesSchema.parse(config.browserSessionId),
      gatewayExpiresAt: Uint64DecimalSchema.parse(config.gatewayExpiresAt)
    };
  }

  verifyAndConsume(input: VerifyAndConsumeRemoteBrowserContextV1Input): RemoteBrowserContextV1 {
    const envelope = RemoteBrowserContextEnvelopeV1Schema.safeParse(input.envelope);
    if (!envelope.success) {
      return fail("invalid_browser_context", "remote-browser envelope is not strict V1.");
    }
    const value = envelope.data;
    if (!verifyRemoteBrowserContextMacV1(input.browserContextKey, value)) {
      return fail("invalid_browser_context_mac", "remote-browser context MAC does not verify.");
    }
    if (value.pairId !== this.expected.pairId) {
      return fail("wrong_pair", "remote-browser pair ID does not match current trust.");
    }
    if (value.remoteDeviceId !== this.expected.remoteDeviceId) {
      return fail("wrong_remote_device", "remote-browser device ID does not match current trust.");
    }
    if (value.remoteInstallationBundleHash !== this.expected.remoteInstallationBundleHash) {
      return fail("wrong_remote_bundle", "remote-browser bundle hash does not match current trust.");
    }
    if (
      value.hostTrustEpoch !== this.expected.hostTrustEpoch
      || value.remoteTrustEpoch !== this.expected.remoteTrustEpoch
    ) {
      return fail("wrong_trust_epoch", "remote-browser trust epochs do not match current trust.");
    }
    const expectedApplicationSessionHash = Base64Url32BytesSchema.parse(input.applicationSessionHash);
    if (value.applicationSessionHash !== expectedApplicationSessionHash) {
      return fail("wrong_application_session", "remote-browser proof is bound to another app session.");
    }
    if (value.browserContext.gatewayLaunchId !== this.expected.gatewayLaunchId) {
      return fail("stale_gateway_launch", "remote-browser gateway launch is not current.");
    }
    if (value.browserContext.browserSessionId !== this.expected.browserSessionId) {
      return fail("stale_browser_session", "remote-browser session is not current.");
    }
    const now = BigInt(Uint64DecimalSchema.parse(input.now));
    if (now > BigInt(this.expected.gatewayExpiresAt)) {
      return fail("gateway_launch_expired", "remote-browser gateway launch has expired.");
    }
    const method = HttpMethodSchema.parse(input.method);
    const canonicalTarget = CanonicalTargetSchema.parse(input.canonicalTarget);
    if (
      value.browserContext.method !== method
      || value.browserContext.canonicalTarget !== canonicalTarget
    ) {
      return fail("request_binding_mismatch", "remote-browser method or target does not match REQUEST_START.");
    }
    if (this.requestNonces.has(value.browserContext.requestNonce)) {
      return fail("replayed_request_nonce", "remote-browser request nonce was already consumed.");
    }
    if (this.directRequestIds.has(value.directRequestId)) {
      return fail("replayed_direct_request_id", "direct request ID was already consumed.");
    }
    const parentStreamId = BigInt(value.remoteParentStreamId);
    if (parentStreamId <= this.parentStreamHighWater) {
      return fail("stale_parent_stream", "remote parent stream ID is not above the high-water mark.");
    }

    this.requestNonces.add(value.browserContext.requestNonce);
    this.directRequestIds.add(value.directRequestId);
    this.parentStreamHighWater = parentStreamId;
    return value.browserContext;
  }
}

export interface ApprovalContextHashV1 {
  receipt: ApprovalReceiptV1;
  canonicalBytes: Buffer;
  contextHash: Buffer;
}

export function deriveApprovalContextHashV1(value: unknown): ApprovalContextHashV1 {
  const receipt = ApprovalReceiptV1Schema.parse(value);
  const canonicalBytes = Buffer.from(
    serializeCanonicalContractJson(receipt as unknown as ContractJson),
    "utf8"
  );
  return {
    receipt,
    canonicalBytes,
    contextHash: sha256(APPROVAL_RECEIPT_DOMAIN, canonicalBytes)
  };
}

export function applicationSessionFixturePublicKeys(
  hostSeed: Uint8Array,
  remoteSeed: Uint8Array
): { host: Buffer; remote: Buffer } {
  return {
    host: deriveEd25519PublicKey(hostSeed),
    remote: deriveEd25519PublicKey(remoteSeed)
  };
}

export function decodeCanonicalRemoteBrowserContextV1(payload: Uint8Array): RemoteBrowserContextV1 {
  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(Buffer.from(payload)));
  } catch {
    return fail("invalid_browser_context", "browser context is not valid UTF-8 JSON.");
  }
  const parsed = RemoteBrowserContextV1Schema.safeParse(value);
  if (!parsed.success || !serializeRemoteBrowserContextV1(parsed.data).equals(Buffer.from(payload))) {
    return fail("invalid_browser_context", "browser context is not strict canonical V1 JSON.");
  }
  return parsed.data;
}
