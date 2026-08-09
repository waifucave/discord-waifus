import { createHash } from "node:crypto";
import {
  HELPER_CONTROL_PROFILES_V1,
  deriveHelperReleaseKeyFingerprintV1,
  type HelperEmbeddedBuildInfoV1,
  type HelperManifestExpectedV1,
  type HelperReleaseTrustEntryV1
} from "./helperManifestTrust.js";
import {
  deriveEd25519PublicKey,
  signEd25519
} from "./remotePairing.js";
import {
  HelperManifestSchema,
  type HelperManifest
} from "./schemas/remoteAccess.js";
import { createHelperManifestFixtureSet } from "./schemas/remoteAccessContract.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

type ContractObject = { [key: string]: ContractJson };

const NEW_KEY_ID = "waifucave-ts-connect-release-test-new";
const OLD_KEY_ID = "waifucave-ts-connect-release-test-old";
const NEW_KEY_SEED = sequence(0x20, 32);
const OLD_KEY_SEED = sequence(0x60, 32);

function sequence(start: number, length: number): Buffer {
  if (start < 0 || start + length > 256) {
    throw new RangeError("Fixture byte sequence exceeds one byte.");
  }
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function hashHex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: ContractJson | undefined, name: string): ContractObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a fixture object.`);
  }
  return value;
}

function baseStructuralManifest(): ContractObject {
  const fixture = createHelperManifestFixtureSet().get(
    "fixtures/helper-manifest/valid/linux-x64.json"
  );
  if (!fixture) {
    throw new Error("Missing generated linux-x64 helper manifest fixture.");
  }
  return clone(fixture);
}

function signaturesFor(
  manifestBytes: Buffer,
  releaseKeyIds: readonly string[]
): ContractObject {
  const result: ContractObject = {};
  for (const keyId of releaseKeyIds) {
    if (keyId === NEW_KEY_ID) {
      result[keyId] = b64(signEd25519(NEW_KEY_SEED, manifestBytes));
    } else if (keyId === OLD_KEY_ID) {
      result[keyId] = b64(signEd25519(OLD_KEY_SEED, manifestBytes));
    } else {
      result[keyId] = b64(Buffer.alloc(64, 0xaa));
    }
  }
  return result;
}

function buildInfo(manifest: HelperManifest): HelperEmbeddedBuildInfoV1 {
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

function inputObject(value: {
  manifestBytes: Buffer;
  signatures: ContractObject;
  trustEntries: readonly HelperReleaseTrustEntryV1[];
  binary: Buffer;
  notices: Buffer;
  expected: HelperManifestExpectedV1;
  embeddedBuildInfo: HelperEmbeddedBuildInfoV1;
}): ContractObject {
  return {
    manifestBytesB64: b64(value.manifestBytes),
    signatures: value.signatures,
    trustEntries: value.trustEntries as unknown as ContractJson,
    binaryB64: b64(value.binary),
    noticesB64: b64(value.notices),
    expected: value.expected as unknown as ContractJson,
    embeddedBuildInfo: value.embeddedBuildInfo as unknown as ContractJson
  };
}

function signedManifestInput(
  base: ContractObject,
  mutate: (value: ContractObject) => void,
  context: {
    trustEntries: readonly HelperReleaseTrustEntryV1[];
    binary: Buffer;
    notices: Buffer;
    expected: HelperManifestExpectedV1;
    embeddedBuildInfo: HelperEmbeddedBuildInfoV1;
  }
): ContractObject {
  const manifest = clone(base);
  mutate(manifest);
  const manifestBytes = Buffer.from(serializeCanonicalContractJson(manifest), "utf8");
  const ids = Array.isArray(manifest.releaseKeyIds)
    ? manifest.releaseKeyIds.map((value) => String(value))
    : [NEW_KEY_ID, OLD_KEY_ID];
  return inputObject({
    manifestBytes,
    signatures: signaturesFor(manifestBytes, ids),
    ...context
  });
}

function rejection(name: string, errorCode: string, input: ContractObject): ContractObject {
  return { name, errorCode, input };
}

export function createHelperManifestTrustV1Fixture(): ContractJson {
  const binary = Buffer.from("ts-connect deterministic test binary v1\n", "utf8");
  const notices = Buffer.from("deterministic test notices v1\n", "utf8");
  const workerTrustRing = Buffer.from("deterministic WORKER_KEYS.lock test bytes v1\n", "utf8");
  const manifestValue = baseStructuralManifest();
  manifestValue.releaseSequence = "42";
  manifestValue.releasedAt = "2026-08-09T10:20:30Z";
  manifestValue.binary = {
    relativePath: "bin/ts-connect",
    byteSize: binary.byteLength.toString(10),
    sha256: hashHex(binary)
  };
  manifestValue.ossNoticeSha256 = hashHex(notices);
  manifestValue.workerTrustRingSha256 = hashHex(workerTrustRing);
  manifestValue.minimumDiscordWaifusVersion = "1.5.200";
  manifestValue.maximumDiscordWaifusVersionExclusive = "1.6.0";
  manifestValue.releaseKeyIds = [NEW_KEY_ID, OLD_KEY_ID];
  const manifest = HelperManifestSchema.parse(manifestValue);
  const manifestBytes = Buffer.from(
    serializeCanonicalContractJson(manifest as unknown as ContractJson),
    "utf8"
  );

  const releaseKeys = [
    { keyId: NEW_KEY_ID, seed: NEW_KEY_SEED },
    { keyId: OLD_KEY_ID, seed: OLD_KEY_SEED }
  ].map(({ keyId, seed }) => {
    const publicKey = deriveEd25519PublicKey(seed);
    return {
      keyId,
      privateSeedB64: b64(seed),
      publicKeyB64: b64(publicKey),
      fingerprint: deriveHelperReleaseKeyFingerprintV1(keyId, publicKey)
    };
  });
  const trustEntries: HelperReleaseTrustEntryV1[] = [
    {
      keyId: NEW_KEY_ID,
      publicKeyB64: releaseKeys[0].publicKeyB64,
      fingerprint: releaseKeys[0].fingerprint,
      sequenceFrom: "42",
      sequenceThrough: "100",
      releasedAtFrom: "2026-08-09T10:20:30Z",
      releasedAtThrough: "2027-12-31T23:59:59Z"
    },
    {
      keyId: OLD_KEY_ID,
      publicKeyB64: releaseKeys[1].publicKeyB64,
      fingerprint: releaseKeys[1].fingerprint,
      sequenceFrom: "1",
      sequenceThrough: "42",
      releasedAtFrom: "2026-01-01T00:00:00Z",
      releasedAtThrough: "2026-08-09T10:20:30Z"
    }
  ];
  const expected: HelperManifestExpectedV1 = {
    packageName: manifest.packageName,
    target: manifest.target,
    appVersion: "1.5.203",
    pinnedHelperVersion: "0.1.0",
    minimumReleaseSequence: "42",
    workerTrustRingSha256: manifest.workerTrustRingSha256,
    protocols: manifest.protocols,
    capabilities: manifest.capabilities
  };
  const embeddedBuildInfo = buildInfo(manifest);
  const context = { trustEntries, binary, notices, expected, embeddedBuildInfo };
  const valid = inputObject({
    manifestBytes,
    signatures: signaturesFor(manifestBytes, manifest.releaseKeyIds),
    ...context
  });

  const withInput = (
    apply: (input: ContractObject) => void
  ): ContractObject => {
    const input = clone(valid);
    apply(input);
    return input;
  };
  const withManifest = (
    apply: (value: ContractObject) => void
  ): ContractObject => signedManifestInput(manifestValue, apply, context);

  const noncanonicalBytes = Buffer.concat([Buffer.from(" "), manifestBytes]);
  const noncanonicalInput = inputObject({
    manifestBytes: noncanonicalBytes,
    signatures: signaturesFor(noncanonicalBytes, manifest.releaseKeyIds),
    ...context
  });
  const oversizedInput = withInput((input) => {
    input.manifestBytesB64 = b64(Buffer.alloc(32_769, 0x61));
  });

  const rejections: ContractObject[] = [
    rejection("manifest-over-limit", "manifest_too_large", oversizedInput),
    rejection("signed-noncanonical-json", "noncanonical_manifest", noncanonicalInput),
    rejection("signed-unknown-manifest-field", "invalid_manifest", withManifest((value) => {
      value.controlUrl = "https://example.invalid";
    })),
    rejection("invalid-new-key-signature", "invalid_signature", withInput((input) => {
      const values = object(input.signatures, "signatures");
      const bytes = Buffer.from(String(values[NEW_KEY_ID]), "base64url");
      bytes[0] ^= 1;
      values[NEW_KEY_ID] = b64(bytes);
    })),
    rejection("missing-overlap-signature", "missing_signature", withInput((input) => {
      delete object(input.signatures, "signatures")[OLD_KEY_ID];
    })),
    rejection("undeclared-extra-signature", "unknown_signature", withInput((input) => {
      object(input.signatures, "signatures")["waifucave-ts-connect-release-test-extra"] = b64(Buffer.alloc(64, 1));
    })),
    rejection("unknown-declared-release-key", "unknown_release_key", withManifest((value) => {
      value.releaseKeyIds = [NEW_KEY_ID, OLD_KEY_ID, "waifucave-ts-connect-release-test-unknown"];
    })),
    rejection("new-key-sequence-window", "key_sequence_out_of_window", withInput((input) => {
      const entries = clone(trustEntries);
      entries[0].sequenceFrom = "43";
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("new-key-time-window", "key_time_out_of_window", withInput((input) => {
      const entries = clone(trustEntries);
      entries[0].releasedAtFrom = "2026-08-09T10:20:31Z";
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("compromise-window-narrowing", "key_sequence_out_of_window", withInput((input) => {
      const entries = clone(trustEntries);
      entries[1].sequenceThrough = "41";
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("release-key-fingerprint", "invalid_release_key_fingerprint", withInput((input) => {
      const entries = clone(trustEntries);
      entries[0].fingerprint = "0".repeat(64);
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("reversed-key-sequence-window", "invalid_trust_ring", withInput((input) => {
      const entries = clone(trustEntries);
      entries[0].sequenceFrom = "101";
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("reversed-key-time-window", "invalid_trust_ring", withInput((input) => {
      const entries = clone(trustEntries);
      entries[0].releasedAtFrom = "2028-01-01T00:00:00Z";
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("duplicate-release-public-key", "invalid_trust_ring", withInput((input) => {
      const entries = clone(trustEntries);
      entries[1].publicKeyB64 = entries[0].publicKeyB64;
      input.trustEntries = entries as unknown as ContractJson;
    })),
    rejection("wrong-signature-width", "invalid_signature", withInput((input) => {
      object(input.signatures, "signatures")[NEW_KEY_ID] = b64(Buffer.alloc(63, 1));
    })),
    rejection("release-sequence-downgrade", "release_sequence_rollback", withInput((input) => {
      object(input.expected, "expected").minimumReleaseSequence = "43";
    })),
    rejection("Worker-trust-ring-mismatch", "worker_trust_ring_mismatch", withInput((input) => {
      object(input.expected, "expected").workerTrustRingSha256 = "0".repeat(64);
    })),
    rejection("package-mismatch", "package_mismatch", withInput((input) => {
      object(input.expected, "expected").packageName = "@waifucave/ts-connect-linux-arm64";
    })),
    rejection("target-mismatch", "target_mismatch", withInput((input) => {
      object(input.expected, "expected").target = { os: "darwin", arch: "arm64" };
    })),
    rejection("helper-version-mismatch", "helper_version_mismatch", withInput((input) => {
      object(input.expected, "expected").pinnedHelperVersion = "0.1.1";
    })),
    rejection("protocol-range-mismatch", "protocol_mismatch", withInput((input) => {
      const protocols = object(object(input.expected, "expected").protocols, "protocols");
      object(protocols.ipc, "IPC range").maximumMinor = 1;
    })),
    rejection("capability-mismatch", "capability_mismatch", withInput((input) => {
      object(input.expected, "expected").capabilities = ["waifus.http.v1"];
    })),
    rejection("app-version-below-minimum", "app_version_incompatible", withInput((input) => {
      object(input.expected, "expected").appVersion = "1.5.199";
    })),
    rejection("app-version-at-exclusive-maximum", "app_version_incompatible", withInput((input) => {
      object(input.expected, "expected").appVersion = "1.6.0";
    })),
    rejection("binary-size-mismatch", "binary_size_mismatch", withInput((input) => {
      input.binaryB64 = b64(Buffer.concat([binary, Buffer.from([0])]));
    })),
    rejection("binary-hash-mismatch", "binary_hash_mismatch", withInput((input) => {
      const changed = Buffer.from(binary);
      changed[0] ^= 1;
      input.binaryB64 = b64(changed);
    })),
    rejection("notices-hash-mismatch", "notices_hash_mismatch", withInput((input) => {
      input.noticesB64 = b64(Buffer.from("changed notices\n"));
    })),
    rejection("embedded-helper-version", "embedded_build_info_mismatch", withInput((input) => {
      object(input.embeddedBuildInfo, "embedded build info").helperVersion = "0.1.1";
    })),
    rejection("embedded-Worker-trust-ring", "embedded_build_info_mismatch", withInput((input) => {
      object(input.embeddedBuildInfo, "embedded build info").workerTrustRingSha256 = "0".repeat(64);
    })),
    rejection("signed-release-time-before-window", "key_time_out_of_window", withManifest((value) => {
      value.releasedAt = "2025-12-31T23:59:59Z";
    })),
    rejection("signed-release-time-after-window", "key_time_out_of_window", withManifest((value) => {
      value.releasedAt = "2028-01-01T00:00:00Z";
    })),
    rejection("signed-release-sequence-before-overlap", "key_sequence_out_of_window", withManifest((value) => {
      value.releaseSequence = "41";
    })),
    rejection("malformed-signed-release-time", "invalid_manifest", withManifest((value) => {
      value.releasedAt = "2026-08-09T10:20:30.000Z";
    })),
    rejection("unsorted-release-key-ids", "invalid_manifest", withManifest((value) => {
      value.releaseKeyIds = [OLD_KEY_ID, NEW_KEY_ID];
    })),
    rejection("wrong-Worker-trust-ring-in-manifest", "worker_trust_ring_mismatch", withManifest((value) => {
      value.workerTrustRingSha256 = "0".repeat(64);
    })),
    rejection("wrong-fork-commit-in-build-info", "embedded_build_info_mismatch", withManifest((value) => {
      value.forkCommit = "7".repeat(40);
    })),
    rejection("wrong-Tailscale-tag", "invalid_manifest", withManifest((value) => {
      object(value.tailscale, "Tailscale").tag = "v1.102.1";
    })),
    rejection("wrong-Go-version", "invalid_manifest", withManifest((value) => {
      value.goVersion = "go1.26.4";
    })),
    rejection("missing-direct-only-tag", "invalid_manifest", withManifest((value) => {
      value.directOnlyBuildTag = "default";
    })),
    rejection("unsorted-manifest-capabilities", "invalid_manifest", withManifest((value) => {
      value.capabilities = ["waifus.stream.cancel.v1", "waifus.http.v1"];
    })),
    rejection("unsafe-binary-path", "invalid_manifest", withManifest((value) => {
      object(value.binary, "binary").relativePath = "../../ts-connect";
    }))
  ];

  return {
    version: 1,
    testOnlyKeys: true,
    releaseKeys: releaseKeys as unknown as ContractJson,
    payloads: {
      binaryB64: b64(binary),
      noticesB64: b64(notices),
      workerTrustRingB64: b64(workerTrustRing)
    },
    valid,
    rejections
  };
}

export function createHelperManifestTrustFixtureSet(): Map<string, ContractJson> {
  return new Map([[
    "fixtures/crypto/helper-manifest-trust-v1.json",
    createHelperManifestTrustV1Fixture()
  ]]);
}

export function serializeHelperManifestTrustFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}
