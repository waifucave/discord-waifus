import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HELPER_RELEASE_TRUST_ROOTS } from "../src/remote/helperReleaseTrust.js";
import { verifyHelperManifestTrustV1, type HelperManifestTrustInputV1 } from "../src/shared/helperManifestTrust.js";
import { createHelperManifestTrustFixtureSet } from "../src/shared/helperManifestTrustContract.js";

type PublicTrustFixture = Readonly<{
  valid: Readonly<{
    manifestBytesB64: string;
    signatures: Readonly<Record<string, string>>;
    binaryB64: string;
    noticesB64: string;
    expected: HelperManifestTrustInputV1["expected"];
    embeddedBuildInfo: HelperManifestTrustInputV1["embeddedBuildInfo"];
  }>;
}>;

describe("production helper release trust", () => {
  it("pins the independently reviewed public key and binds its fingerprint to the key ID", () => {
    const key = HELPER_RELEASE_TRUST_ROOTS.find((entry) => entry.keyId === "waifucave-ts-connect-release-2026-01");
    expect(key).toBeDefined();
    if (!key) throw new Error("Initial helper release trust is missing.");
    const publicKey = Buffer.from(key.publicKeyB64, "base64url");
    expect(publicKey.byteLength).toBe(32);
    expect(publicKey.toString("base64url")).toBe(key.publicKeyB64);
    expect(createHash("sha256")
      .update("waifus/helper-release-key/v1", "ascii")
      .update(Buffer.from([0]))
      .update(key.keyId, "ascii")
      .update(publicKey)
      .digest("hex")).toBe("6a0fdc6a96cb180a5e823a3e43cdcafe9cd2b65b22298965b42aa965fb82a381");
    expect(key.fingerprint).toBe("6a0fdc6a96cb180a5e823a3e43cdcafe9cd2b65b22298965b42aa965fb82a381");
    expect(key).toMatchObject({
      sequenceFrom: "13", sequenceThrough: "13",
      releasedAtFrom: "2026-10-10T22:07:21Z", releasedAtThrough: "2026-10-10T22:07:21Z"
    });
    expect(Object.isFrozen(HELPER_RELEASE_TRUST_ROOTS)).toBe(true);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("keeps publicly available fixture signing keys untrusted in production", () => {
    const fixture = createHelperManifestTrustFixtureSet().get("fixtures/crypto/helper-manifest-trust-v1.json") as unknown as PublicTrustFixture;
    const valid = fixture.valid;
    expect(() => verifyHelperManifestTrustV1({
      manifestBytes: Buffer.from(valid.manifestBytesB64, "base64url"),
      signatures: new Map(Object.entries(valid.signatures).map(([id, signature]) => [id, Buffer.from(signature, "base64url")])),
      trustEntries: HELPER_RELEASE_TRUST_ROOTS,
      binaryBytes: Buffer.from(valid.binaryB64, "base64url"),
      noticesBytes: Buffer.from(valid.noticesB64, "base64url"),
      expected: valid.expected,
      embeddedBuildInfo: valid.embeddedBuildInfo
    })).toThrow("unknown_release_key");
  });
});
