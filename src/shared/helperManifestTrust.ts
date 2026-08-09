import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  CanonicalReleasedAtSchema,
  HelperManifestSchema,
  HelperTargetSchema,
  compareSemVer,
  type HelperManifest,
  type HelperTarget
} from "./schemas/remoteAccess.js";
import { verifyEd25519 } from "./remotePairing.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";
import { SemVerSchema, UINT64_MAX } from "./schemas/remoteProtocol.js";

export const HELPER_MANIFEST_MAX_BYTES = 32_768;
export const HELPER_RELEASE_SIGNATURE_BYTES = 64;
export const HELPER_RELEASE_TRUST_MAX_KEYS = 8;

const RELEASE_KEY_FINGERPRINT_DOMAIN = Buffer.from(
  "waifus/helper-release-key/v1",
  "ascii"
);
const ZERO_BYTE = Buffer.from([0]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RELEASE_KEY_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/;
const UINT64_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const HELPER_CONTROL_PROFILES_V1 = Object.freeze([
  Object.freeze({
    controlProfile: 1,
    name: "production",
    httpsOrigin: "https://pair.waifucave.com",
    webSocketOrigin: "wss://pair.waifucave.com",
    workerCertificateKeyId: "waifucave-pair-certificate-2026-01"
  }),
  Object.freeze({
    controlProfile: 2,
    name: "staging",
    httpsOrigin: "https://pair-staging.waifucave.com",
    webSocketOrigin: "wss://pair-staging.waifucave.com",
    workerCertificateKeyId: "waifucave-pair-staging-certificate-2026-01"
  })
]);

export type HelperManifestTrustErrorCode =
  | "manifest_too_large"
  | "invalid_manifest"
  | "noncanonical_manifest"
  | "invalid_trust_ring"
  | "invalid_release_key_fingerprint"
  | "unknown_release_key"
  | "missing_signature"
  | "unknown_signature"
  | "invalid_signature"
  | "key_sequence_out_of_window"
  | "key_time_out_of_window"
  | "package_mismatch"
  | "target_mismatch"
  | "helper_version_mismatch"
  | "release_sequence_rollback"
  | "worker_trust_ring_mismatch"
  | "protocol_mismatch"
  | "capability_mismatch"
  | "app_version_incompatible"
  | "binary_size_mismatch"
  | "binary_hash_mismatch"
  | "notices_hash_mismatch"
  | "embedded_build_info_mismatch";

export class HelperManifestTrustError extends Error {
  constructor(
    readonly code: HelperManifestTrustErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "HelperManifestTrustError";
  }
}

function fail(code: HelperManifestTrustErrorCode, detail: string): never {
  throw new HelperManifestTrustError(code, detail);
}

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function sha256Hex(value: Uint8Array): string {
  return sha256(value).toString("hex");
}

function canonicalUint64(value: string, name: string, positive = false): bigint {
  if (!UINT64_PATTERN.test(value)) {
    return fail("invalid_trust_ring", `${name} is not canonical uint64 decimal.`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || parsed.toString(10) !== value || (positive && parsed === 0n)) {
    return fail("invalid_trust_ring", `${name} is outside its canonical uint64 range.`);
  }
  return parsed;
}

function canonicalBase64Url(value: string, length: number, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) {
    return fail("invalid_trust_ring", `${name} is not canonical unpadded base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || decoded.toString("base64url") !== value) {
    return fail("invalid_trust_ring", `${name} must decode canonically to ${length} bytes.`);
  }
  return decoded;
}

function contractJson(value: unknown): ContractJson {
  return value as ContractJson;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return serializeCanonicalContractJson(contractJson(left))
      === serializeCanonicalContractJson(contractJson(right));
  } catch {
    return false;
  }
}

function targetEqual(left: HelperTarget, right: HelperTarget): boolean {
  return left.os === right.os
    && left.arch === right.arch
    && ("goarm" in left ? left.goarm : undefined) === ("goarm" in right ? right.goarm : undefined);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

export interface HelperReleaseTrustEntryV1 {
  keyId: string;
  publicKeyB64: string;
  fingerprint: string;
  sequenceFrom: string;
  sequenceThrough: string;
  releasedAtFrom: string;
  releasedAtThrough: string;
}

export interface HelperManifestExpectedV1 {
  packageName: HelperManifest["packageName"];
  target: HelperTarget;
  appVersion: string;
  pinnedHelperVersion: string;
  minimumReleaseSequence: string;
  workerTrustRingSha256: string;
  protocols: HelperManifest["protocols"];
  capabilities: readonly string[];
}

export interface HelperEmbeddedBuildInfoV1 {
  schemaVersion: 1;
  helperVersion: string;
  releaseSequence: string;
  releasedAt: string;
  packageName: string;
  target: HelperTarget;
  sourceCommit: string;
  contractCommit: string;
  forkCommit: string;
  workerTrustRingSha256: string;
  tailscale: { tag: string; commit: string };
  goVersion: string;
  directOnlyBuildTag: string;
  protocols: HelperManifest["protocols"];
  capabilities: readonly string[];
  controlProfiles: typeof HELPER_CONTROL_PROFILES_V1;
}

export interface HelperManifestTrustInputV1 {
  manifestBytes: Uint8Array;
  signatures: ReadonlyMap<string, Uint8Array>;
  trustEntries: readonly HelperReleaseTrustEntryV1[];
  binaryBytes: Uint8Array;
  noticesBytes: Uint8Array;
  expected: HelperManifestExpectedV1;
  embeddedBuildInfo: HelperEmbeddedBuildInfoV1;
}

export interface VerifiedHelperManifestV1 {
  manifest: HelperManifest;
  manifestBytes: Buffer;
  verifiedReleaseKeyIds: string[];
}

export function deriveHelperReleaseKeyFingerprintV1(
  keyId: string,
  publicKey: Uint8Array
): string {
  if (!RELEASE_KEY_ID_PATTERN.test(keyId)) {
    return fail("invalid_trust_ring", "release key ID is not canonical.");
  }
  const key = Buffer.from(publicKey);
  if (key.byteLength !== 32) {
    return fail("invalid_trust_ring", "release public key must be exactly 32 raw bytes.");
  }
  return sha256(Buffer.concat([
    RELEASE_KEY_FINGERPRINT_DOMAIN,
    ZERO_BYTE,
    Buffer.from(keyId, "ascii"),
    key
  ])).toString("hex");
}

interface ValidatedTrustEntryV1 {
  value: HelperReleaseTrustEntryV1;
  publicKey: Buffer;
  sequenceFrom: bigint;
  sequenceThrough: bigint;
}

function validateTrustEntries(
  entries: readonly HelperReleaseTrustEntryV1[]
): ReadonlyMap<string, ValidatedTrustEntryV1> {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > HELPER_RELEASE_TRUST_MAX_KEYS) {
    return fail("invalid_trust_ring", "release trust ring must contain 1-8 keys.");
  }
  const result = new Map<string, ValidatedTrustEntryV1>();
  const seenPublicKeys = new Set<string>();
  let previousId: string | undefined;
  for (const raw of entries) {
    if (
      raw === null
      || typeof raw !== "object"
      || !exactKeys(raw, [
        "keyId",
        "publicKeyB64",
        "fingerprint",
        "sequenceFrom",
        "sequenceThrough",
        "releasedAtFrom",
        "releasedAtThrough"
      ])
      || !RELEASE_KEY_ID_PATTERN.test(raw.keyId)
      || (previousId !== undefined && previousId >= raw.keyId)
    ) {
      return fail("invalid_trust_ring", "release trust entries must be strict and key-ID sorted.");
    }
    previousId = raw.keyId;
    const publicKey = canonicalBase64Url(raw.publicKeyB64, 32, "release public key");
    const publicIdentity = publicKey.toString("hex");
    if (seenPublicKeys.has(publicIdentity)) {
      return fail("invalid_trust_ring", "release trust entries cannot reuse a raw public key.");
    }
    seenPublicKeys.add(publicIdentity);
    const expectedFingerprint = deriveHelperReleaseKeyFingerprintV1(raw.keyId, publicKey);
    if (
      !SHA256_HEX_PATTERN.test(raw.fingerprint)
      || raw.fingerprint !== expectedFingerprint
    ) {
      return fail("invalid_release_key_fingerprint", "release-key fingerprint does not match its key and ID.");
    }
    const sequenceFrom = canonicalUint64(raw.sequenceFrom, "release sequence from", true);
    const sequenceThrough = canonicalUint64(raw.sequenceThrough, "release sequence through", true);
    if (sequenceFrom > sequenceThrough) {
      return fail("invalid_trust_ring", "release-key sequence window is reversed.");
    }
    if (
      !CanonicalReleasedAtSchema.safeParse(raw.releasedAtFrom).success
      || !CanonicalReleasedAtSchema.safeParse(raw.releasedAtThrough).success
      || raw.releasedAtFrom > raw.releasedAtThrough
    ) {
      return fail("invalid_trust_ring", "release-key signed-time window is invalid or reversed.");
    }
    result.set(raw.keyId, { value: raw, publicKey, sequenceFrom, sequenceThrough });
  }
  return result;
}

interface ManifestSelectorsV1 {
  parsed: Record<string, unknown>;
  releaseKeyIds: string[];
  releaseSequence: bigint;
  releasedAt: string;
}

function parseManifestSelectors(bytes: Buffer): ManifestSelectorsV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    return fail("invalid_manifest", "helper manifest is not one bounded UTF-8 JSON value.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return fail("invalid_manifest", "helper manifest root must be an object.");
  }
  const parsed = decoded as Record<string, unknown>;
  const ids = parsed.releaseKeyIds;
  if (
    !Array.isArray(ids)
    || ids.length < 1
    || ids.length > HELPER_RELEASE_TRUST_MAX_KEYS
    || !ids.every((id) => typeof id === "string" && RELEASE_KEY_ID_PATTERN.test(id))
    || !ids.every((id, index) => index === 0 || (ids[index - 1] as string) < id)
  ) {
    return fail("invalid_manifest", "manifest releaseKeyIds are not canonical and sorted.");
  }
  const sequenceText = parsed.releaseSequence;
  if (typeof sequenceText !== "string") {
    return fail("invalid_manifest", "manifest release sequence selector is missing.");
  }
  let releaseSequence: bigint;
  try {
    releaseSequence = canonicalUint64(sequenceText, "manifest release sequence", true);
  } catch {
    return fail("invalid_manifest", "manifest release sequence selector is invalid.");
  }
  const releasedAt = parsed.releasedAt;
  if (typeof releasedAt !== "string" || !CanonicalReleasedAtSchema.safeParse(releasedAt).success) {
    return fail("invalid_manifest", "manifest releasedAt selector is invalid.");
  }
  return { parsed, releaseKeyIds: ids as string[], releaseSequence, releasedAt };
}

function verifyManifestSignatures(
  bytes: Buffer,
  selectors: ManifestSelectorsV1,
  signatures: ReadonlyMap<string, Uint8Array>,
  trust: ReadonlyMap<string, ValidatedTrustEntryV1>
): string[] {
  for (const keyId of signatures.keys()) {
    if (!selectors.releaseKeyIds.includes(keyId)) {
      return fail("unknown_signature", `signature for undeclared key ${keyId} is forbidden.`);
    }
  }
  const verified: string[] = [];
  for (const keyId of selectors.releaseKeyIds) {
    const entry = trust.get(keyId);
    if (!entry) {
      return fail("unknown_release_key", `manifest release key ${keyId} is not trusted.`);
    }
    if (
      selectors.releaseSequence < entry.sequenceFrom
      || selectors.releaseSequence > entry.sequenceThrough
    ) {
      return fail("key_sequence_out_of_window", `${keyId} does not cover the signed release sequence.`);
    }
    if (
      selectors.releasedAt < entry.value.releasedAtFrom
      || selectors.releasedAt > entry.value.releasedAtThrough
    ) {
      return fail("key_time_out_of_window", `${keyId} does not cover the signed release time.`);
    }
    const signatureValue = signatures.get(keyId);
    if (!signatureValue) {
      return fail("missing_signature", `manifest is missing declared overlap signature ${keyId}.`);
    }
    const signature = Buffer.from(signatureValue);
    if (signature.byteLength !== HELPER_RELEASE_SIGNATURE_BYTES) {
      return fail("invalid_signature", `${keyId} signature is not exactly 64 raw bytes.`);
    }
    if (!verifyEd25519(entry.publicKey, bytes, signature)) {
      return fail("invalid_signature", `${keyId} signature does not authenticate exact manifest bytes.`);
    }
    verified.push(keyId);
  }
  return verified;
}

function expectedBuildInfo(manifest: HelperManifest): HelperEmbeddedBuildInfoV1 {
  return {
    schemaVersion: 1,
    helperVersion: manifest.helperVersion,
    releaseSequence: manifest.releaseSequence,
    releasedAt: manifest.releasedAt,
    packageName: manifest.packageName,
    target: manifest.target,
    sourceCommit: manifest.sourceCommit,
    contractCommit: manifest.contractCommit,
    forkCommit: manifest.forkCommit,
    workerTrustRingSha256: manifest.workerTrustRingSha256,
    tailscale: manifest.tailscale,
    goVersion: manifest.goVersion,
    directOnlyBuildTag: manifest.directOnlyBuildTag,
    protocols: manifest.protocols,
    capabilities: manifest.capabilities,
    controlProfiles: HELPER_CONTROL_PROFILES_V1
  };
}

function validateExpected(
  manifest: HelperManifest,
  expected: HelperManifestExpectedV1
): void {
  if (
    expected === null
    || typeof expected !== "object"
    || !exactKeys(expected, [
      "packageName",
      "target",
      "appVersion",
      "pinnedHelperVersion",
      "minimumReleaseSequence",
      "workerTrustRingSha256",
      "protocols",
      "capabilities"
    ])
  ) {
    return fail("invalid_manifest", "expected helper compatibility input is not strict.");
  }
  if (
    !HelperTargetSchema.safeParse(expected.target).success
    || !SemVerSchema.safeParse(expected.appVersion).success
  ) {
    return fail("invalid_manifest", "expected helper target or app version is invalid.");
  }
  if (manifest.packageName !== expected.packageName) {
    return fail("package_mismatch", "signed package name does not match the selected package.");
  }
  if (!targetEqual(manifest.target, expected.target)) {
    return fail("target_mismatch", "signed target does not match the selected runtime target.");
  }
  if (manifest.helperVersion !== expected.pinnedHelperVersion) {
    return fail("helper_version_mismatch", "helper version differs from the exact app pin.");
  }
  let minimumSequence: bigint;
  try {
    minimumSequence = canonicalUint64(
      expected.minimumReleaseSequence,
      "minimum release sequence",
      true
    );
  } catch {
    return fail("invalid_manifest", "minimum release sequence input is invalid.");
  }
  if (BigInt(manifest.releaseSequence) < minimumSequence) {
    return fail("release_sequence_rollback", "helper release sequence is below the app floor.");
  }
  if (
    !SHA256_HEX_PATTERN.test(expected.workerTrustRingSha256)
    || manifest.workerTrustRingSha256 !== expected.workerTrustRingSha256
  ) {
    return fail("worker_trust_ring_mismatch", "signed Worker trust-ring hash differs from the app expectation.");
  }
  if (!canonicalEqual(manifest.protocols, expected.protocols)) {
    return fail("protocol_mismatch", "helper protocol ranges differ from app compatibility.");
  }
  if (!canonicalEqual(manifest.capabilities, expected.capabilities)) {
    return fail("capability_mismatch", "helper capabilities differ from app compatibility.");
  }
  if (
    compareSemVer(expected.appVersion, manifest.minimumDiscordWaifusVersion) < 0
    || compareSemVer(expected.appVersion, manifest.maximumDiscordWaifusVersionExclusive) >= 0
  ) {
    return fail("app_version_incompatible", "app version is outside the signed helper interval.");
  }
}

export function verifyHelperManifestTrustV1(
  input: HelperManifestTrustInputV1
): VerifiedHelperManifestV1 {
  const manifestBytes = Buffer.from(input.manifestBytes);
  if (manifestBytes.byteLength < 1 || manifestBytes.byteLength > HELPER_MANIFEST_MAX_BYTES) {
    return fail("manifest_too_large", "helper manifest must contain 1-32,768 raw bytes.");
  }
  const trust = validateTrustEntries(input.trustEntries);
  const selectors = parseManifestSelectors(manifestBytes);
  const verifiedReleaseKeyIds = verifyManifestSignatures(
    manifestBytes,
    selectors,
    input.signatures,
    trust
  );
  const parsed = HelperManifestSchema.safeParse(selectors.parsed);
  if (!parsed.success) {
    return fail("invalid_manifest", "signed helper manifest does not match the strict V1 schema.");
  }
  const canonicalBytes = Buffer.from(
    serializeCanonicalContractJson(parsed.data as unknown as ContractJson),
    "utf8"
  );
  if (!canonicalBytes.equals(manifestBytes)) {
    return fail("noncanonical_manifest", "signed manifest bytes are not RFC 8785 canonical JSON.");
  }
  validateExpected(parsed.data, input.expected);
  const binaryBytes = Buffer.from(input.binaryBytes);
  if (BigInt(parsed.data.binary.byteSize) !== BigInt(binaryBytes.byteLength)) {
    return fail("binary_size_mismatch", "helper binary byte size differs from its signed manifest.");
  }
  if (sha256Hex(binaryBytes) !== parsed.data.binary.sha256) {
    return fail("binary_hash_mismatch", "helper binary hash differs from its signed manifest.");
  }
  if (sha256Hex(Buffer.from(input.noticesBytes)) !== parsed.data.ossNoticeSha256) {
    return fail("notices_hash_mismatch", "notice inventory hash differs from its signed manifest.");
  }
  if (!canonicalEqual(input.embeddedBuildInfo, expectedBuildInfo(parsed.data))) {
    return fail("embedded_build_info_mismatch", "helper version --json metadata differs from the signed manifest.");
  }
  return { manifest: parsed.data, manifestBytes, verifiedReleaseKeyIds };
}
