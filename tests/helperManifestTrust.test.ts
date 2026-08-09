import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveHelperReleaseKeyFingerprintV1,
  verifyHelperManifestTrustV1,
  type HelperManifestTrustInputV1
} from "../src/shared/helperManifestTrust.js";
import {
  createHelperManifestTrustFixtureSet,
  serializeHelperManifestTrustFixture
} from "../src/shared/helperManifestTrustContract.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, name = "fixture value"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, name = "fixture value"): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  return value;
}

function string(value: unknown, name = "fixture value"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  return value;
}

function fixture(): JsonObject {
  return object(
    createHelperManifestTrustFixtureSet().values().next().value,
    "helper manifest trust fixture"
  );
}

function signatures(value: unknown): ReadonlyMap<string, Buffer> {
  return new Map(Object.entries(object(value, "signatures")).map(([keyId, signature]) => [
    keyId,
    Buffer.from(string(signature, "signature"), "base64url")
  ]));
}

function trustInput(value: JsonObject): HelperManifestTrustInputV1 {
  return {
    manifestBytes: Buffer.from(string(value.manifestBytesB64), "base64url"),
    signatures: signatures(value.signatures),
    trustEntries: array(value.trustEntries, "trust entries") as never,
    binaryBytes: Buffer.from(string(value.binaryB64), "base64url"),
    noticesBytes: Buffer.from(string(value.noticesB64), "base64url"),
    expected: object(value.expected, "expected verification") as never,
    embeddedBuildInfo: object(value.embeddedBuildInfo, "embedded build info") as never
  };
}

describe("signed helper manifest trust", () => {
  it("recreates the public trust fixture byte-for-byte", async () => {
    const fixtures = createHelperManifestTrustFixtureSet();
    const expected = fixtures.get("fixtures/crypto/helper-manifest-trust-v1.json");
    expect(expected).toBeDefined();
    const actual = await readFile(path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "helper-manifest-trust-v1.json"
    ), "utf8");
    expect(actual).toBe(serializeHelperManifestTrustFixture(expected as never));
  });

  it("verifies every declared overlap signature and historical trust window", () => {
    const value = fixture();
    const valid = object(value.valid, "valid trust case");
    const result = verifyHelperManifestTrustV1(trustInput(valid));
    expect(result.manifest.releaseSequence).toBe("42");
    expect(result.verifiedReleaseKeyIds).toEqual([
      "waifucave-ts-connect-release-test-new",
      "waifucave-ts-connect-release-test-old"
    ]);
    expect(result.manifestBytes).toEqual(
      Buffer.from(string(valid.manifestBytesB64), "base64url")
    );
  });

  it("derives the domain-separated public release-key fingerprints", () => {
    const value = fixture();
    for (const raw of array(value.releaseKeys, "release keys")) {
      const key = object(raw, "release key");
      expect(deriveHelperReleaseKeyFingerprintV1(
        string(key.keyId),
        Buffer.from(string(key.publicKeyB64), "base64url")
      )).toBe(string(key.fingerprint));
    }
  });

  it("rejects every signature, trust-window, downgrade, hash, compatibility, and build-info failure", () => {
    const value = fixture();
    for (const raw of array(value.rejections, "trust rejections")) {
      const rejection = object(raw, "trust rejection");
      expect(
        () => verifyHelperManifestTrustV1(trustInput(object(rejection.input, "rejection input"))),
        string(rejection.name)
      ).toThrow(string(rejection.errorCode));
    }
  });
});
