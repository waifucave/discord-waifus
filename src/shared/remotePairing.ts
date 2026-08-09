import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject
} from "node:crypto";
import { TextDecoder } from "node:util";
import {
  DeviceIdentityBundleSchema,
  UINT64_MAX,
  type DeviceIdentityBundle
} from "./schemas/remoteProtocol.js";
import {
  mapSasIndicesToWordsV1,
  type SasWordsV1
} from "./sasWordlist.js";

export const FULL_PAIR_TOKEN_PREFIX = "WF1.";
export const FULL_PAIR_TOKEN_VERSION = 1;
export const PAIRING_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const PAIRING_MAILBOX_MESSAGE_MAX_BYTES = 1_200;
export const NOISE_XX_PATTERN = "Noise_XX_25519_ChaChaPoly_SHA256";
export const NOISE_XXPSK0_PATTERN = "Noise_XXpsk0_25519_ChaChaPoly_SHA256";
export const PAIR_KEY_LABELS = Object.freeze({
  coordinationHostToRemote: "waifus-coordination-host-to-remote-v1",
  coordinationRemoteToHost: "waifus-coordination-remote-to-host-v1",
  confirmation: "waifus-confirmation-v1",
  revocation: "waifus-revocation-v1"
});

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const IDENTITY_SIGNATURE_DOMAIN = Buffer.from("waifus/identity-bundle/v1", "ascii");
const FULL_TOKEN_SIGNATURE_DOMAIN = Buffer.from("waifus/full-token/v1", "ascii");
const INSTALLATION_FINGERPRINT_DOMAIN = Buffer.from("waifus/install/fingerprint/v1", "ascii");
const PAIR_ROOT_DOMAIN = Buffer.from("waifus-pair-root-v1", "ascii");
const PAIR_KEY_SALT_DOMAIN = Buffer.from("waifus/pair-key-salt/v1", "ascii");
const SAS_DOMAIN = Buffer.from("waifus/sas/v1", "ascii");
const SAS_FINGERPRINT_DOMAIN = Buffer.from("waifus/sas-fingerprint/v1", "ascii");
const NOISE_PSK_INFO = Buffer.from("waifus-noise-xxpsk0-v1", "ascii");
const NOISE_PROLOGUE_PREFIX = Buffer.from("WAIFUS-PAIR", "ascii");
const ZERO_BYTE = Buffer.from([0]);

export type CanonicalCborValue =
  | bigint
  | number
  | string
  | Buffer
  | readonly CanonicalCborValue[]
  | ReadonlyMap<CanonicalCborValue, CanonicalCborValue>;

function assertByteLength(value: Uint8Array, expected: number, name: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== expected) {
    throw new RangeError(`${name} must be exactly ${expected} bytes.`);
  }
  return bytes;
}

function assertUint64(value: bigint, name: string): bigint {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${name} must be a uint64.`);
  }
  return value;
}

function uint64BE(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(assertUint64(value, "value"));
  return encoded;
}

function uint16BE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("value must be a uint16.");
  }
  const encoded = Buffer.alloc(2);
  encoded.writeUInt16BE(value);
  return encoded;
}

function uint32BE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be a uint32.");
  }
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(value);
  return encoded;
}

function lengthPrefix32(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32BE(bytes.byteLength), bytes]);
}

function sha256(...values: readonly Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
  }
  return hash.digest();
}

function hmacSha256(key: Uint8Array, ...values: readonly Uint8Array[]): Buffer {
  const hmac = createHmac("sha256", key);
  for (const value of values) {
    hmac.update(value);
  }
  return hmac.digest();
}

function hkdfSha256(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Buffer {
  return Buffer.from(hkdfSync("sha256", inputKeyMaterial, salt, info, length));
}

function encodeCborHead(major: number, value: bigint): Buffer {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError("CBOR unsigned integer is outside uint64.");
  }
  if (value < 24n) {
    return Buffer.from([(major << 5) | Number(value)]);
  }
  if (value <= 0xffn) {
    return Buffer.from([(major << 5) | 24, Number(value)]);
  }
  if (value <= 0xffffn) {
    const encoded = Buffer.alloc(3);
    encoded[0] = (major << 5) | 25;
    encoded.writeUInt16BE(Number(value), 1);
    return encoded;
  }
  if (value <= 0xffff_ffffn) {
    const encoded = Buffer.alloc(5);
    encoded[0] = (major << 5) | 26;
    encoded.writeUInt32BE(Number(value), 1);
    return encoded;
  }
  const encoded = Buffer.alloc(9);
  encoded[0] = (major << 5) | 27;
  encoded.writeBigUInt64BE(value, 1);
  return encoded;
}

function compareCanonicalCborKeys(left: Buffer, right: Buffer): number {
  if (left.byteLength !== right.byteLength) {
    return left.byteLength - right.byteLength;
  }
  return Buffer.compare(left, right);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function encodeCanonicalCbor(value: CanonicalCborValue): Buffer {
  if (typeof value === "bigint") {
    return encodeCborHead(0, value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Canonical CBOR numbers must be nonnegative safe integers.");
    }
    return encodeCborHead(0, BigInt(value));
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([encodeCborHead(2, BigInt(bytes.byteLength)), bytes]);
  }
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) {
      throw new TypeError("Canonical CBOR text must contain valid Unicode scalar values.");
    }
    const encoded = Buffer.from(value, "utf8");
    return Buffer.concat([encodeCborHead(3, BigInt(encoded.byteLength)), encoded]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      encodeCborHead(4, BigInt(value.length)),
      ...value.map((item) => encodeCanonicalCbor(item))
    ]);
  }
  if (value instanceof Map) {
    const entries = [...value].map(([key, entryValue]) => ({
      key: encodeCanonicalCbor(key),
      value: encodeCanonicalCbor(entryValue)
    }));
    entries.sort((left, right) => compareCanonicalCborKeys(left.key, right.key));
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].key.equals(entries[index].key)) {
        throw new TypeError("Canonical CBOR maps cannot contain duplicate encoded keys.");
      }
    }
    return Buffer.concat([
      encodeCborHead(5, BigInt(entries.length)),
      ...entries.flatMap((entry) => [entry.key, entry.value])
    ]);
  }
  throw new TypeError("Unsupported canonical CBOR value.");
}

class CanonicalCborDecoder {
  private offset = 0;
  private items = 0;

  constructor(private readonly encoded: Buffer) {}

  decode(): CanonicalCborValue {
    const value = this.readValue(0);
    if (this.offset !== this.encoded.byteLength) {
      throw new TypeError("Canonical CBOR has trailing bytes.");
    }
    if (!encodeCanonicalCbor(value).equals(this.encoded)) {
      throw new TypeError("CBOR value is not in RFC 8949 deterministic form.");
    }
    return value;
  }

  private readBytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.encoded.byteLength) {
      throw new TypeError("Truncated canonical CBOR value.");
    }
    const value = this.encoded.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readLength(additional: number): bigint {
    if (additional < 24) {
      return BigInt(additional);
    }
    if (additional === 24) {
      const value = BigInt(this.readBytes(1)[0]);
      if (value < 24n) {
        throw new TypeError("CBOR integer or length is not shortest-form.");
      }
      return value;
    }
    if (additional === 25) {
      const value = BigInt(this.readBytes(2).readUInt16BE(0));
      if (value <= 0xffn) {
        throw new TypeError("CBOR integer or length is not shortest-form.");
      }
      return value;
    }
    if (additional === 26) {
      const value = BigInt(this.readBytes(4).readUInt32BE(0));
      if (value <= 0xffffn) {
        throw new TypeError("CBOR integer or length is not shortest-form.");
      }
      return value;
    }
    if (additional === 27) {
      const value = this.readBytes(8).readBigUInt64BE(0);
      if (value <= 0xffff_ffffn) {
        throw new TypeError("CBOR integer or length is not shortest-form.");
      }
      return value;
    }
    throw new TypeError("Indefinite or reserved CBOR lengths are forbidden.");
  }

  private lengthAsNumber(value: bigint): number {
    if (value > BigInt(this.encoded.byteLength) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("Canonical CBOR length exceeds the input bound.");
    }
    return Number(value);
  }

  private readValue(depth: number): CanonicalCborValue {
    this.items += 1;
    if (depth > 16 || this.items > 512) {
      throw new TypeError("Canonical CBOR nesting or item count exceeds the V1 bound.");
    }
    const initial = this.readBytes(1)[0];
    const major = initial >>> 5;
    const additional = initial & 0x1f;
    const length = this.readLength(additional);

    if (major === 0) {
      return length;
    }
    if (major === 2) {
      return Buffer.from(this.readBytes(this.lengthAsNumber(length)));
    }
    if (major === 3) {
      return UTF8_DECODER.decode(this.readBytes(this.lengthAsNumber(length)));
    }
    if (major === 4) {
      return Array.from(
        { length: this.lengthAsNumber(length) },
        () => this.readValue(depth + 1)
      );
    }
    if (major === 5) {
      const result = new Map<CanonicalCborValue, CanonicalCborValue>();
      const seen = new Set<string>();
      let previousKey: Buffer | undefined;
      for (let index = 0; index < this.lengthAsNumber(length); index += 1) {
        const keyStart = this.offset;
        const key = this.readValue(depth + 1);
        const encodedKey = this.encoded.subarray(keyStart, this.offset);
        const keyIdentity = encodedKey.toString("hex");
        if (seen.has(keyIdentity)) {
          throw new TypeError("Canonical CBOR map contains a duplicate key.");
        }
        if (previousKey && compareCanonicalCborKeys(previousKey, encodedKey) >= 0) {
          throw new TypeError("Canonical CBOR map keys are not in deterministic order.");
        }
        seen.add(keyIdentity);
        previousKey = encodedKey;
        result.set(key, this.readValue(depth + 1));
      }
      return result;
    }
    throw new TypeError(`CBOR major type ${major} is forbidden by the pairing V1 contract.`);
  }
}

export function decodeCanonicalCbor(encoded: Uint8Array, maximumBytes = 2_048): CanonicalCborValue {
  const bytes = Buffer.from(encoded);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new RangeError(`Canonical CBOR must contain 1 to ${maximumBytes} bytes.`);
  }
  return new CanonicalCborDecoder(bytes).decode();
}

function keyObjectFromRawPrivate(seed: Uint8Array, prefix: Buffer, name: string): KeyObject {
  const raw = assertByteLength(seed, 32, name);
  return createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "pkcs8"
  });
}

function keyObjectFromRawPublic(rawValue: Uint8Array, prefix: Buffer, name: string): KeyObject {
  const raw = assertByteLength(rawValue, 32, name);
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki"
  });
}

export function deriveEd25519PublicKey(privateKeySeed: Uint8Array): Buffer {
  const privateKey = keyObjectFromRawPrivate(privateKeySeed, ED25519_PKCS8_PREFIX, "Ed25519 seed");
  const encoded = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(encoded).subarray(ED25519_SPKI_PREFIX.byteLength);
}

export function deriveX25519PublicKey(privateKey: Uint8Array): Buffer {
  const key = keyObjectFromRawPrivate(privateKey, X25519_PKCS8_PREFIX, "X25519 private key");
  const encoded = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(encoded).subarray(X25519_SPKI_PREFIX.byteLength);
}

export function signEd25519(privateKeySeed: Uint8Array, message: Uint8Array): Buffer {
  return nodeSign(
    null,
    message,
    keyObjectFromRawPrivate(privateKeySeed, ED25519_PKCS8_PREFIX, "Ed25519 seed")
  );
}

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const signatureBytes = assertByteLength(signature, 64, "Ed25519 signature");
  return nodeVerify(
    null,
    message,
    keyObjectFromRawPublic(publicKey, ED25519_SPKI_PREFIX, "Ed25519 public key"),
    signatureBytes
  );
}

function expectMap(value: CanonicalCborValue, name: string): ReadonlyMap<CanonicalCborValue, CanonicalCborValue> {
  if (!(value instanceof Map)) {
    throw new TypeError(`${name} must be a canonical CBOR map.`);
  }
  return value;
}

function expectExactIntegerKeys(
  value: ReadonlyMap<CanonicalCborValue, CanonicalCborValue>,
  expected: readonly bigint[],
  name: string
): void {
  const keys = [...value.keys()];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => typeof key !== "bigint" || key !== expected[index])
  ) {
    throw new TypeError(`${name} contains missing, extra, or non-integer fields.`);
  }
}

function cborField(
  value: ReadonlyMap<CanonicalCborValue, CanonicalCborValue>,
  key: bigint,
  name: string
): CanonicalCborValue {
  const result = value.get(key);
  if (result === undefined) {
    throw new TypeError(`${name} is missing CBOR field ${key}.`);
  }
  return result;
}

function expectUnsigned(value: CanonicalCborValue, name: string): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${name} must be a CBOR unsigned integer.`);
  }
  return value;
}

function expectText(value: CanonicalCborValue, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a CBOR text string.`);
  }
  return value;
}

function expectBytes(value: CanonicalCborValue, length: number, name: string): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${name} must be a CBOR byte string.`);
  }
  return assertByteLength(value, length, name);
}

function expectTextArray(value: CanonicalCborValue, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be a CBOR array of text strings.`);
  }
  return [...value] as string[];
}

function canonicalBase64UrlDecode(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${name} must use unpadded base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) {
    throw new TypeError(`${name} is not canonical unpadded base64url.`);
  }
  return decoded;
}

export function deriveInstallationFingerprint(installationPublicKey: Uint8Array): Buffer {
  return sha256(
    INSTALLATION_FINGERPRINT_DOMAIN,
    assertByteLength(installationPublicKey, 32, "installation public key")
  ).subarray(0, 16);
}

export function deriveFullTokenPsk(fullSecret: Uint8Array, invitationId: Uint8Array): Buffer {
  return hkdfSha256(
    assertByteLength(fullSecret, 32, "full token secret"),
    assertByteLength(invitationId, 16, "invitation ID"),
    NOISE_PSK_INFO,
    32
  );
}

export interface CreateFullPairTokenInput {
  invitationId: Uint8Array;
  expiry: bigint;
  hostInstallationPrivateKeySeed: Uint8Array;
  hostPairingPublicKey: Uint8Array;
  fullSecret: Uint8Array;
}

export interface DecodedFullPairToken {
  version: 1;
  invitationId: Buffer;
  expiry: bigint;
  hostInstallationPublicKey: Buffer;
  hostInstallationFingerprint: Buffer;
  hostPairingPublicKey: Buffer;
  fullSecret: Buffer;
  signature: Buffer;
  unsignedCbor: Buffer;
  encodedCbor: Buffer;
  psk: Buffer;
}

function fullTokenUnsignedMap(fields: {
  invitationId: Uint8Array;
  expiry: bigint;
  hostInstallationPublicKey: Uint8Array;
  hostInstallationFingerprint: Uint8Array;
  hostPairingPublicKey: Uint8Array;
  fullSecret: Uint8Array;
}): Map<CanonicalCborValue, CanonicalCborValue> {
  return new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, 1n],
    [2n, assertByteLength(fields.invitationId, 16, "invitation ID")],
    [3n, assertUint64(fields.expiry, "token expiry")],
    [4n, assertByteLength(fields.hostInstallationPublicKey, 32, "host installation public key")],
    [5n, assertByteLength(fields.hostInstallationFingerprint, 16, "host installation fingerprint")],
    [6n, assertByteLength(fields.hostPairingPublicKey, 32, "host pairing public key")],
    [7n, assertByteLength(fields.fullSecret, 32, "full token secret")]
  ]);
}

export function createFullPairToken(input: CreateFullPairTokenInput): {
  encoded: string;
  decoded: DecodedFullPairToken;
} {
  const hostInstallationPublicKey = deriveEd25519PublicKey(input.hostInstallationPrivateKeySeed);
  const fingerprint = deriveInstallationFingerprint(hostInstallationPublicKey);
  const unsignedMap = fullTokenUnsignedMap({
    ...input,
    hostInstallationPublicKey,
    hostInstallationFingerprint: fingerprint
  });
  const unsignedCbor = encodeCanonicalCbor(unsignedMap);
  const signature = signEd25519(
    input.hostInstallationPrivateKeySeed,
    Buffer.concat([FULL_TOKEN_SIGNATURE_DOMAIN, unsignedCbor])
  );
  const signedMap = new Map(unsignedMap);
  signedMap.set(8n, signature);
  const encodedCbor = encodeCanonicalCbor(signedMap);
  const encoded = `${FULL_PAIR_TOKEN_PREFIX}${encodedCbor.toString("base64url")}`;
  return {
    encoded,
    decoded: {
      version: 1,
      invitationId: assertByteLength(input.invitationId, 16, "invitation ID"),
      expiry: assertUint64(input.expiry, "token expiry"),
      hostInstallationPublicKey,
      hostInstallationFingerprint: fingerprint,
      hostPairingPublicKey: assertByteLength(input.hostPairingPublicKey, 32, "host pairing public key"),
      fullSecret: assertByteLength(input.fullSecret, 32, "full token secret"),
      signature,
      unsignedCbor,
      encodedCbor,
      psk: deriveFullTokenPsk(input.fullSecret, input.invitationId)
    }
  };
}

export function decodeFullPairToken(encoded: string, nowSeconds: bigint): DecodedFullPairToken {
  assertUint64(nowSeconds, "current Unix time");
  if (!encoded.startsWith(FULL_PAIR_TOKEN_PREFIX) || encoded.length > 1_024) {
    throw new TypeError("Full pair token has the wrong prefix or exceeds the V1 bound.");
  }
  const encodedCbor = canonicalBase64UrlDecode(encoded.slice(FULL_PAIR_TOKEN_PREFIX.length), "full pair token");
  const map = expectMap(decodeCanonicalCbor(encodedCbor, 768), "full pair token");
  expectExactIntegerKeys(map, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n], "full pair token");
  if (expectUnsigned(cborField(map, 1n, "full pair token"), "token version") !== 1n) {
    throw new TypeError("Unsupported full pair token version.");
  }
  const invitationId = expectBytes(cborField(map, 2n, "full pair token"), 16, "invitation ID");
  const expiry = expectUnsigned(cborField(map, 3n, "full pair token"), "token expiry");
  const hostInstallationPublicKey = expectBytes(
    cborField(map, 4n, "full pair token"),
    32,
    "host installation public key"
  );
  const fingerprint = expectBytes(cborField(map, 5n, "full pair token"), 16, "host installation fingerprint");
  const hostPairingPublicKey = expectBytes(cborField(map, 6n, "full pair token"), 32, "host pairing public key");
  const fullSecret = expectBytes(cborField(map, 7n, "full pair token"), 32, "full token secret");
  const signature = expectBytes(cborField(map, 8n, "full pair token"), 64, "host signature");
  const expectedFingerprint = deriveInstallationFingerprint(hostInstallationPublicKey);
  if (!timingSafeEqual(fingerprint, expectedFingerprint)) {
    throw new TypeError("Full pair token installation fingerprint is invalid.");
  }
  const unsignedCbor = encodeCanonicalCbor(fullTokenUnsignedMap({
    invitationId,
    expiry,
    hostInstallationPublicKey,
    hostInstallationFingerprint: fingerprint,
    hostPairingPublicKey,
    fullSecret
  }));
  if (!verifyEd25519(
    hostInstallationPublicKey,
    Buffer.concat([FULL_TOKEN_SIGNATURE_DOMAIN, unsignedCbor]),
    signature
  )) {
    throw new TypeError("Full pair token signature is invalid.");
  }
  if (expiry <= nowSeconds) {
    throw new TypeError("Full pair token has expired.");
  }
  return {
    version: 1,
    invitationId,
    expiry,
    hostInstallationPublicKey,
    hostInstallationFingerprint: fingerprint,
    hostPairingPublicKey,
    fullSecret,
    signature,
    unsignedCbor,
    encodedCbor,
    psk: deriveFullTokenPsk(fullSecret, invitationId)
  };
}

export type UnsignedDeviceIdentityBundle = Omit<DeviceIdentityBundle, "signature">;

function protocolMap(protocol: DeviceIdentityBundle["protocol"]): Map<CanonicalCborValue, CanonicalCborValue> {
  return new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, protocol.major],
    [2n, protocol.minor]
  ]);
}

function capabilitiesMap(
  capabilities: DeviceIdentityBundle["capabilities"]
): Map<CanonicalCborValue, CanonicalCborValue> {
  return new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, capabilities.required],
    [2n, capabilities.optional]
  ]);
}

function unsignedIdentityMap(
  bundle: UnsignedDeviceIdentityBundle
): Map<CanonicalCborValue, CanonicalCborValue> {
  return new Map<CanonicalCborValue, CanonicalCborValue>([
    [1n, bundle.version],
    [2n, bundle.deviceId],
    [3n, bundle.role],
    [4n, BigInt(bundle.trustEpoch)],
    [5n, Buffer.from(bundle.installationPublicKey, "base64url")],
    [6n, Buffer.from(bundle.nodePublicKey, "base64url")],
    [7n, Buffer.from(bundle.discoveryPublicKey, "base64url")],
    [8n, bundle.keySequence],
    [9n, protocolMap(bundle.protocol)],
    [10n, capabilitiesMap(bundle.capabilities)]
  ]);
}

export function encodeUnsignedDeviceIdentityBundle(bundle: UnsignedDeviceIdentityBundle): Buffer {
  const structural = DeviceIdentityBundleSchema.parse({
    ...bundle,
    signature: Buffer.alloc(64).toString("base64url")
  });
  const { signature: _signature, ...unsigned } = structural;
  return encodeCanonicalCbor(unsignedIdentityMap(unsigned));
}

export function createSignedDeviceIdentityBundle(
  bundle: UnsignedDeviceIdentityBundle,
  installationPrivateKeySeed: Uint8Array
): { bundle: DeviceIdentityBundle; unsignedCbor: Buffer; bundleCbor: Buffer; bundleHash: Buffer } {
  const expectedPublicKey = deriveEd25519PublicKey(installationPrivateKeySeed).toString("base64url");
  if (bundle.installationPublicKey !== expectedPublicKey) {
    throw new TypeError("Identity bundle installation public key does not match the signing seed.");
  }
  const unsignedCbor = encodeUnsignedDeviceIdentityBundle(bundle);
  const signature = signEd25519(
    installationPrivateKeySeed,
    Buffer.concat([IDENTITY_SIGNATURE_DOMAIN, unsignedCbor])
  );
  const signed = DeviceIdentityBundleSchema.parse({
    ...bundle,
    signature: signature.toString("base64url")
  });
  const signedMap = new Map(unsignedIdentityMap(bundle));
  signedMap.set(11n, signature);
  const bundleCbor = encodeCanonicalCbor(signedMap);
  return { bundle: signed, unsignedCbor, bundleCbor, bundleHash: sha256(bundleCbor) };
}

export function decodeSignedDeviceIdentityBundle(encoded: Uint8Array): DeviceIdentityBundle {
  const encodedBytes = Buffer.from(encoded);
  const map = expectMap(decodeCanonicalCbor(encodedBytes, 1_200), "device identity bundle");
  expectExactIntegerKeys(map, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n], "device identity bundle");
  const protocol = expectMap(cborField(map, 9n, "device identity bundle"), "identity protocol");
  expectExactIntegerKeys(protocol, [1n, 2n], "identity protocol");
  const capabilities = expectMap(cborField(map, 10n, "device identity bundle"), "identity capabilities");
  expectExactIntegerKeys(capabilities, [1n, 2n], "identity capabilities");
  const signature = expectBytes(cborField(map, 11n, "device identity bundle"), 64, "identity signature");
  const parsed = DeviceIdentityBundleSchema.parse({
    version: Number(expectUnsigned(cborField(map, 1n, "device identity bundle"), "identity version")),
    deviceId: expectText(cborField(map, 2n, "device identity bundle"), "device ID"),
    role: Number(expectUnsigned(cborField(map, 3n, "device identity bundle"), "device role")),
    trustEpoch: expectUnsigned(cborField(map, 4n, "device identity bundle"), "trust epoch").toString(10),
    installationPublicKey: expectBytes(
      cborField(map, 5n, "device identity bundle"),
      32,
      "installation public key"
    ).toString("base64url"),
    nodePublicKey: expectBytes(cborField(map, 6n, "device identity bundle"), 32, "node public key").toString("base64url"),
    discoveryPublicKey: expectBytes(
      cborField(map, 7n, "device identity bundle"),
      32,
      "discovery public key"
    ).toString("base64url"),
    keySequence: Number(expectUnsigned(cborField(map, 8n, "device identity bundle"), "key sequence")),
    protocol: {
      major: Number(expectUnsigned(cborField(protocol, 1n, "identity protocol"), "protocol major")),
      minor: Number(expectUnsigned(cborField(protocol, 2n, "identity protocol"), "protocol minor"))
    },
    capabilities: {
      required: expectTextArray(cborField(capabilities, 1n, "identity capabilities"), "required capabilities"),
      optional: expectTextArray(cborField(capabilities, 2n, "identity capabilities"), "optional capabilities")
    },
    signature: signature.toString("base64url")
  });
  const { signature: _signature, ...unsigned } = parsed;
  const unsignedCbor = encodeUnsignedDeviceIdentityBundle(unsigned);
  if (!verifyEd25519(
    Buffer.from(parsed.installationPublicKey, "base64url"),
    Buffer.concat([IDENTITY_SIGNATURE_DOMAIN, unsignedCbor]),
    signature
  )) {
    throw new TypeError("Device identity bundle signature is invalid.");
  }
  return parsed;
}

export interface NoisePrologueInput {
  invitationId: Uint8Array;
  invitationGeneration: bigint;
  pairId: Uint8Array;
}

export function createNoisePrologue(input: NoisePrologueInput): Buffer {
  return Buffer.concat([
    NOISE_PROLOGUE_PREFIX,
    ZERO_BYTE,
    uint16BE(PAIRING_PROTOCOL_VERSION.major),
    uint16BE(PAIRING_PROTOCOL_VERSION.minor),
    assertByteLength(input.invitationId, 16, "invitation ID"),
    uint64BE(input.invitationGeneration),
    assertByteLength(input.pairId, 16, "pair ID"),
    Buffer.from([2, 1])
  ]);
}

function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  return diffieHellman({
    privateKey: keyObjectFromRawPrivate(privateKey, X25519_PKCS8_PREFIX, "X25519 private key"),
    publicKey: keyObjectFromRawPublic(publicKey, X25519_SPKI_PREFIX, "X25519 public key")
  });
}

function noiseHkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 2 | 3): Buffer[] {
  const temporaryKey = hmacSha256(chainingKey, inputKeyMaterial);
  const first = hmacSha256(temporaryKey, Buffer.from([1]));
  const second = hmacSha256(temporaryKey, first, Buffer.from([2]));
  if (outputs === 2) {
    return [first, second];
  }
  return [first, second, hmacSha256(temporaryKey, second, Buffer.from([3]))];
}

function noiseNonce(value: bigint): Buffer {
  if (value < 0n || value >= UINT64_MAX) {
    throw new RangeError("Noise nonce is exhausted.");
  }
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(value, 4);
  return nonce;
}

function noiseEncrypt(key: Uint8Array, nonce: bigint, associatedData: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv(
    "chacha20-poly1305",
    assertByteLength(key, 32, "Noise cipher key"),
    noiseNonce(nonce),
    { authTagLength: 16 }
  );
  cipher.setAAD(associatedData, { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function noiseDecrypt(key: Uint8Array, nonce: bigint, associatedData: Uint8Array, ciphertext: Uint8Array): Buffer {
  const encoded = Buffer.from(ciphertext);
  if (encoded.byteLength < 16) {
    throw new TypeError("Noise ciphertext is shorter than its authentication tag.");
  }
  const body = encoded.subarray(0, -16);
  const tag = encoded.subarray(-16);
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    assertByteLength(key, 32, "Noise cipher key"),
    noiseNonce(nonce),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(tag);
  decipher.setAAD(associatedData, { plaintextLength: body.byteLength });
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

class NoiseSymmetricState {
  private chainingKey: Buffer;
  private handshakeHash: Buffer;
  private cipherKey: Buffer | undefined;
  private nonce = 0n;

  constructor(handshakeName: string, prologue: Uint8Array) {
    const name = Buffer.from(handshakeName, "ascii");
    if (name.byteLength <= 32) {
      this.handshakeHash = Buffer.alloc(32);
      name.copy(this.handshakeHash);
    } else {
      this.handshakeHash = sha256(name);
    }
    this.chainingKey = Buffer.from(this.handshakeHash);
    this.mixHash(prologue);
  }

  get hasKey(): boolean {
    return this.cipherKey !== undefined;
  }

  mixHash(value: Uint8Array): void {
    this.handshakeHash = sha256(this.handshakeHash, value);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, cipherKey] = noiseHkdf(this.chainingKey, inputKeyMaterial, 2);
    this.chainingKey = chainingKey;
    this.cipherKey = cipherKey;
    this.nonce = 0n;
  }

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, temporaryHash, cipherKey] = noiseHkdf(
      this.chainingKey,
      inputKeyMaterial,
      3
    );
    this.chainingKey = chainingKey;
    this.mixHash(temporaryHash);
    this.cipherKey = cipherKey;
    this.nonce = 0n;
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ciphertext = this.cipherKey
      ? noiseEncrypt(this.cipherKey, this.nonce++, this.handshakeHash, plaintext)
      : Buffer.from(plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const plaintext = this.cipherKey
      ? noiseDecrypt(this.cipherKey, this.nonce++, this.handshakeHash, ciphertext)
      : Buffer.from(ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): readonly [Buffer, Buffer] {
    const [first, second] = noiseHkdf(this.chainingKey, Buffer.alloc(0), 2);
    return [first, second];
  }

  channelBinding(): Buffer {
    return Buffer.from(this.handshakeHash);
  }
}

type NoiseToken = "psk" | "e" | "s" | "ee" | "es" | "se";
const NOISE_XX_MESSAGES: readonly (readonly NoiseToken[])[] = [
  ["e"],
  ["e", "ee", "s", "es"],
  ["s", "se"]
];

function assertNoiseMailboxMessageSize(value: Uint8Array): void {
  if (value.byteLength > PAIRING_MAILBOX_MESSAGE_MAX_BYTES) {
    throw new RangeError("Noise handshake message exceeds the 1,200-byte mailbox limit.");
  }
}

class NoiseXXState {
  private readonly symmetric: NoiseSymmetricState;
  private readonly localStaticPrivateKey: Buffer;
  private readonly localStaticPublicKey: Buffer;
  private readonly localEphemeralPrivateKey: Buffer;
  private readonly localEphemeralPublicKey: Buffer;
  private remoteStaticPublicKey: Buffer | undefined;
  private remoteEphemeralPublicKey: Buffer | undefined;

  constructor(
    private readonly initiator: boolean,
    private readonly psk: Buffer | undefined,
    prologue: Uint8Array,
    staticPrivateKey: Uint8Array,
    ephemeralPrivateKey: Uint8Array
  ) {
    this.localStaticPrivateKey = assertByteLength(staticPrivateKey, 32, "Noise static private key");
    this.localStaticPublicKey = deriveX25519PublicKey(this.localStaticPrivateKey);
    this.localEphemeralPrivateKey = assertByteLength(ephemeralPrivateKey, 32, "Noise ephemeral private key");
    this.localEphemeralPublicKey = deriveX25519PublicKey(this.localEphemeralPrivateKey);
    if (psk) {
      assertByteLength(psk, 32, "Noise PSK");
    }
    this.symmetric = new NoiseSymmetricState(
      psk ? NOISE_XXPSK0_PATTERN : NOISE_XX_PATTERN,
      prologue
    );
  }

  write(messageIndex: number, payload: Uint8Array): Buffer {
    const output: Buffer[] = [];
    for (const token of this.tokens(messageIndex)) {
      if (token === "psk") {
        this.symmetric.mixKeyAndHash(this.requiredPsk());
      } else if (token === "e") {
        output.push(this.localEphemeralPublicKey);
        this.symmetric.mixHash(this.localEphemeralPublicKey);
        if (this.psk) {
          this.symmetric.mixKey(this.localEphemeralPublicKey);
        }
      } else if (token === "s") {
        output.push(this.symmetric.encryptAndHash(this.localStaticPublicKey));
      } else {
        this.processDh(token);
      }
    }
    output.push(this.symmetric.encryptAndHash(payload));
    const message = Buffer.concat(output);
    assertNoiseMailboxMessageSize(message);
    return message;
  }

  read(messageIndex: number, message: Uint8Array): Buffer {
    assertNoiseMailboxMessageSize(message);
    const encoded = Buffer.from(message);
    let offset = 0;
    for (const token of this.tokens(messageIndex)) {
      if (token === "psk") {
        this.symmetric.mixKeyAndHash(this.requiredPsk());
      } else if (token === "e") {
        if (offset + 32 > encoded.byteLength) {
          throw new TypeError("Noise message is missing its ephemeral key.");
        }
        this.remoteEphemeralPublicKey = Buffer.from(encoded.subarray(offset, offset + 32));
        offset += 32;
        this.symmetric.mixHash(this.remoteEphemeralPublicKey);
        if (this.psk) {
          this.symmetric.mixKey(this.remoteEphemeralPublicKey);
        }
      } else if (token === "s") {
        const length = this.symmetric.hasKey ? 48 : 32;
        if (offset + length > encoded.byteLength) {
          throw new TypeError("Noise message is missing its static key.");
        }
        const staticKey = this.symmetric.decryptAndHash(encoded.subarray(offset, offset + length));
        this.remoteStaticPublicKey = assertByteLength(staticKey, 32, "remote Noise static public key");
        offset += length;
      } else {
        this.processDh(token);
      }
    }
    return this.symmetric.decryptAndHash(encoded.subarray(offset));
  }

  split(): readonly [Buffer, Buffer] {
    return this.symmetric.split();
  }

  channelBinding(): Buffer {
    return this.symmetric.channelBinding();
  }

  private tokens(messageIndex: number): readonly NoiseToken[] {
    const base = NOISE_XX_MESSAGES[messageIndex];
    if (!base) {
      throw new RangeError("Noise XX has exactly three handshake messages.");
    }
    return this.psk && messageIndex === 0 ? ["psk", ...base] : base;
  }

  private requiredPsk(): Buffer {
    if (!this.psk) {
      throw new TypeError("Noise psk0 token is missing its PSK.");
    }
    return this.psk;
  }

  private processDh(token: Exclude<NoiseToken, "psk" | "e" | "s">): void {
    let privateKey: Buffer;
    let publicKey: Buffer | undefined;
    if (token === "ee") {
      privateKey = this.localEphemeralPrivateKey;
      publicKey = this.remoteEphemeralPublicKey;
    } else if (token === "es") {
      privateKey = this.initiator ? this.localEphemeralPrivateKey : this.localStaticPrivateKey;
      publicKey = this.initiator ? this.remoteStaticPublicKey : this.remoteEphemeralPublicKey;
    } else {
      privateKey = this.initiator ? this.localStaticPrivateKey : this.localEphemeralPrivateKey;
      publicKey = this.initiator ? this.remoteEphemeralPublicKey : this.remoteStaticPublicKey;
    }
    if (!publicKey) {
      throw new TypeError(`Noise ${token} token is missing the remote key.`);
    }
    this.symmetric.mixKey(x25519SharedSecret(privateKey, publicKey));
  }
}

export interface RunNoiseXXHandshakeInput {
  prologue: Uint8Array;
  psk?: Uint8Array;
  initiatorStaticPrivateKey: Uint8Array;
  responderStaticPrivateKey: Uint8Array;
  initiatorEphemeralPrivateKey: Uint8Array;
  responderEphemeralPrivateKey: Uint8Array;
  payloads: readonly [Uint8Array, Uint8Array, Uint8Array] | readonly Uint8Array[];
}

export interface NoiseXXHandshakeResult {
  pattern: typeof NOISE_XX_PATTERN | typeof NOISE_XXPSK0_PATTERN;
  messages: readonly [Buffer, Buffer, Buffer];
  channelBinding: Buffer;
  transcriptHash: Buffer;
  initiatorToResponderTransportKey: Buffer;
  responderToInitiatorTransportKey: Buffer;
}

export function runNoiseXXHandshake(input: RunNoiseXXHandshakeInput): NoiseXXHandshakeResult {
  if (input.payloads.length !== 3) {
    throw new RangeError("Noise XX requires exactly three handshake payloads.");
  }
  const psk = input.psk ? assertByteLength(input.psk, 32, "Noise PSK") : undefined;
  const initiator = new NoiseXXState(
    true,
    psk,
    input.prologue,
    input.initiatorStaticPrivateKey,
    input.initiatorEphemeralPrivateKey
  );
  const responder = new NoiseXXState(
    false,
    psk,
    input.prologue,
    input.responderStaticPrivateKey,
    input.responderEphemeralPrivateKey
  );
  const first = initiator.write(0, input.payloads[0]);
  if (!responder.read(0, first).equals(input.payloads[0])) {
    throw new TypeError("Noise responder recovered a different first payload.");
  }
  const second = responder.write(1, input.payloads[1]);
  if (!initiator.read(1, second).equals(input.payloads[1])) {
    throw new TypeError("Noise initiator recovered a different second payload.");
  }
  const third = initiator.write(2, input.payloads[2]);
  if (!responder.read(2, third).equals(input.payloads[2])) {
    throw new TypeError("Noise responder recovered a different third payload.");
  }
  const initiatorBinding = initiator.channelBinding();
  const responderBinding = responder.channelBinding();
  if (!timingSafeEqual(initiatorBinding, responderBinding)) {
    throw new TypeError("Noise peers derived different channel bindings.");
  }
  const [initiatorToResponderTransportKey, responderToInitiatorTransportKey] = initiator.split();
  const [responderFirst, responderSecond] = responder.split();
  if (
    !timingSafeEqual(initiatorToResponderTransportKey, responderFirst)
    || !timingSafeEqual(responderToInitiatorTransportKey, responderSecond)
  ) {
    throw new TypeError("Noise peers derived different transport keys.");
  }
  const messages = [first, second, third] as const;
  return {
    pattern: psk ? NOISE_XXPSK0_PATTERN : NOISE_XX_PATTERN,
    messages,
    channelBinding: initiatorBinding,
    transcriptHash: sha256(...messages.map(lengthPrefix32)),
    initiatorToResponderTransportKey,
    responderToInitiatorTransportKey
  };
}

export function verifyNoiseXXHandshake(
  input: RunNoiseXXHandshakeInput,
  messages: readonly Uint8Array[]
): NoiseXXHandshakeResult {
  if (messages.length !== 3) {
    throw new RangeError("Noise XX verification requires exactly three messages.");
  }
  for (const message of messages) {
    assertNoiseMailboxMessageSize(message);
  }
  const replay = runNoiseXXHandshake(input);
  for (let index = 0; index < replay.messages.length; index += 1) {
    const candidate = Buffer.from(messages[index]);
    if (
      candidate.byteLength !== replay.messages[index].byteLength
      || !timingSafeEqual(candidate, replay.messages[index])
    ) {
      throw new TypeError(`Noise transcript message ${index + 1} does not match its bound inputs.`);
    }
  }
  return replay;
}

export function encryptNoiseTransportMessage(
  transportKey: Uint8Array,
  plaintext: Uint8Array,
  nonce = 0n
): Buffer {
  return noiseEncrypt(transportKey, nonce, Buffer.alloc(0), plaintext);
}

export interface DerivePairKeysInput {
  hostContribution: Uint8Array;
  remoteContribution: Uint8Array;
  channelBinding: Uint8Array;
  invitationId: Uint8Array;
  invitationGeneration: bigint;
  pairId: Uint8Array;
  hostBundleHash: Uint8Array;
  remoteBundleHash: Uint8Array;
  hostInstallationPublicKey: Uint8Array;
  remoteInstallationPublicKey: Uint8Array;
}

export interface PairKeys {
  pairRoot: Buffer;
  pairKeySalt: Buffer;
  coordinationHostToRemoteKey: Buffer;
  coordinationRemoteToHostKey: Buffer;
  confirmationKey: Buffer;
  revocationKey: Buffer;
}

export function derivePairKeys(input: DerivePairKeysInput): PairKeys {
  const hostContribution = assertByteLength(input.hostContribution, 32, "host pair contribution");
  const remoteContribution = assertByteLength(input.remoteContribution, 32, "remote pair contribution");
  const channelBinding = assertByteLength(input.channelBinding, 32, "Noise channel binding");
  const invitationId = assertByteLength(input.invitationId, 16, "invitation ID");
  const pairId = assertByteLength(input.pairId, 16, "pair ID");
  const hostBundleHash = assertByteLength(input.hostBundleHash, 32, "host bundle hash");
  const remoteBundleHash = assertByteLength(input.remoteBundleHash, 32, "remote bundle hash");
  const hostInstallationPublicKey = assertByteLength(
    input.hostInstallationPublicKey,
    32,
    "host installation public key"
  );
  const remoteInstallationPublicKey = assertByteLength(
    input.remoteInstallationPublicKey,
    32,
    "remote installation public key"
  );
  if (
    timingSafeEqual(hostBundleHash, remoteBundleHash)
    || timingSafeEqual(hostInstallationPublicKey, remoteInstallationPublicKey)
  ) {
    throw new TypeError("Self-pairing with one installation identity is forbidden.");
  }
  const generation = uint64BE(input.invitationGeneration);
  const context = Buffer.concat([
    invitationId,
    generation,
    pairId,
    hostBundleHash,
    remoteBundleHash
  ]);
  const pairRoot = hkdfSha256(
    Buffer.concat([hostContribution, remoteContribution]),
    channelBinding,
    Buffer.concat([PAIR_ROOT_DOMAIN, ZERO_BYTE, context]),
    32
  );
  const pairKeySalt = sha256(PAIR_KEY_SALT_DOMAIN, ZERO_BYTE, channelBinding, pairId);
  const derive = (label: string): Buffer => hkdfSha256(
    pairRoot,
    pairKeySalt,
    Buffer.concat([Buffer.from(label, "ascii"), ZERO_BYTE, context]),
    32
  );
  return {
    pairRoot,
    pairKeySalt,
    coordinationHostToRemoteKey: derive(PAIR_KEY_LABELS.coordinationHostToRemote),
    coordinationRemoteToHostKey: derive(PAIR_KEY_LABELS.coordinationRemoteToHost),
    confirmationKey: derive(PAIR_KEY_LABELS.confirmation),
    revocationKey: derive(PAIR_KEY_LABELS.revocation)
  };
}

export interface DerivePairingSasInput {
  channelBinding: Uint8Array;
  pairId: Uint8Array;
  hostBundleCbor: Uint8Array;
  remoteBundleCbor: Uint8Array;
}

export interface PairingSas {
  canonicalIdentityBundleHash: Buffer;
  sasBytes: Buffer;
  indices: readonly [number, number, number, number, number];
  words: SasWordsV1;
  fingerprint: string;
}

export function derivePairingSas(input: DerivePairingSasInput): PairingSas {
  const hostBundleCbor = Buffer.from(input.hostBundleCbor);
  const remoteBundleCbor = Buffer.from(input.remoteBundleCbor);
  const host = decodeSignedDeviceIdentityBundle(hostBundleCbor);
  const remote = decodeSignedDeviceIdentityBundle(remoteBundleCbor);
  if (host.role !== 1 || remote.role !== 2) {
    throw new TypeError("SAS identity bundles must be ordered host then remote.");
  }
  const hostInstallationKey = Buffer.from(host.installationPublicKey, "base64url");
  const remoteInstallationKey = Buffer.from(remote.installationPublicKey, "base64url");
  if (timingSafeEqual(hostInstallationKey, remoteInstallationKey)) {
    throw new TypeError("Self-pairing with one installation identity is forbidden.");
  }
  const channelBinding = assertByteLength(input.channelBinding, 32, "Noise channel binding");
  const pairId = assertByteLength(input.pairId, 16, "pair ID");
  const canonicalIdentityBundleHash = sha256(hostBundleCbor, remoteBundleCbor);
  const sasBytes = hkdfSha256(
    channelBinding,
    pairId,
    Buffer.concat([SAS_DOMAIN, canonicalIdentityBundleHash]),
    7
  );
  let firstFiftyBits = 0n;
  for (const byte of sasBytes) {
    firstFiftyBits = (firstFiftyBits << 8n) | BigInt(byte);
  }
  firstFiftyBits >>= 6n;
  const indices = Array.from({ length: 5 }, (_, index) => Number(
    (firstFiftyBits >> BigInt((4 - index) * 10)) & 0x3ffn
  )) as [number, number, number, number, number];
  const fingerprint = sha256(
    SAS_FINGERPRINT_DOMAIN,
    pairId,
    channelBinding,
    canonicalIdentityBundleHash
  ).subarray(0, 6).toString("hex");
  const words = mapSasIndicesToWordsV1(indices);
  return { canonicalIdentityBundleHash, sasBytes, indices, words, fingerprint };
}
