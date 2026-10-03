import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INITIAL_HELPER_TARGETS } from "../scripts/releaseHelperPackages.mjs";
import {
  nativeCandidateInputs, nativeCandidatePackages, selectNativeCandidateDraft,
  validateNativeCandidateApp, verifyNativeCandidateBytes
} from "../scripts/prepare-native-candidate.mjs";

const bytes = Buffer.from("reviewed candidate bytes");
const hash = (algorithm: string, encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const input = () => nativeCandidateInputs("v1.5.204", "0.1.5", "a".repeat(40), "b".repeat(64), "c".repeat(64));
const packageSet = () => ({ schemaVersion: 1, packages: INITIAL_HELPER_TARGETS.map(target => ({
  ...target, version: "0.1.5", byteSize: bytes.length, filename: `waifucave-${target.name.slice("@waifucave/".length)}-0.1.5.tgz`,
  sha256: hash("sha256"), shasum: hash("sha1"), integrity: `sha512-${hash("sha512", "base64")}`
})) });
const draft = () => ({ tag_name: "v1.5.204", draft: true, target_commitish: "a".repeat(40), assets: [
  "package-set.json", input().appAsset, ...packageSet().packages.map(pkg => pkg.filename)
].map((name, index) => ({ name, id: index + 1, state: "uploaded", size: 100 })) });

describe("public native candidate preparation", () => {
  it("requires canonical versions, a full source commit and both reviewed hashes", () => {
    expect(input().appVersion).toBe("1.5.204");
    for (const tag of ["main", "v01.5.204", "v1.5.204-beta", "v1.5.204\n"]) {
      expect(() => nativeCandidateInputs(tag, "0.1.5", "a".repeat(40), "b".repeat(64), "c".repeat(64))).toThrow();
    }
    expect(() => nativeCandidateInputs("v1.5.204", "latest", "a".repeat(40), "b".repeat(64), "c".repeat(64))).toThrow();
    expect(() => nativeCandidateInputs("v1.5.204", "0.1.5", "main", "b".repeat(64), "c".repeat(64))).toThrow();
    expect(() => nativeCandidateInputs("v1.5.204", "0.1.5", "a".repeat(40), "bad", "c".repeat(64))).toThrow();
  });

  it("accepts exactly the five reviewed package identities and checks every digest", () => {
    const approved = nativeCandidatePackages(packageSet(), "0.1.5");
    expect(approved).toHaveLength(5);
    for (const pkg of approved) expect(() => verifyNativeCandidateBytes(bytes, pkg)).not.toThrow();
    expect(() => verifyNativeCandidateBytes(Buffer.from("tampered"), approved[0])).toThrow();
    for (const field of ["sha256", "shasum", "integrity"] as const) {
      expect(() => verifyNativeCandidateBytes(bytes, { ...approved[0], [field]: "changed" })).toThrow();
    }
    for (const mutation of [
      (set: ReturnType<typeof packageSet>) => { set.packages.pop(); },
      (set: ReturnType<typeof packageSet>) => { set.packages[1] = set.packages[0]!; },
      (set: ReturnType<typeof packageSet>) => { set.packages[0]!.cpu = "x64"; },
      (set: ReturnType<typeof packageSet>) => { set.packages[0]!.version = "0.1.4"; },
      (set: ReturnType<typeof packageSet>) => { set.packages[0]!.filename = "../unreviewed.tgz"; }
    ]) {
      const set = packageSet(); mutation(set);
      expect(() => nativeCandidatePackages(set, "0.1.5")).toThrow();
    }
  });

  it("requires one unpublished draft at the reviewed source with no extra assets", () => {
    expect(selectNativeCandidateDraft([draft()], input()).draft).toBe(true);
    for (const releases of [[], [draft(), draft()], [{ ...draft(), draft: false }],
      [{ ...draft(), target_commitish: "main" }], [{ ...draft(), assets: draft().assets.slice(1) }],
      [{ ...draft(), assets: [...draft().assets, { id: 9, name: "source.zip", state: "uploaded", size: 10 }] }]]) {
      expect(() => selectNativeCandidateDraft(releases, input())).toThrow();
    }
  });

  it("requires the new app version and exact native optional dependencies", () => {
    const pkg = { name: "@waifucave/discord-waifus", version: "1.5.204", private: false,
      optionalDependencies: Object.fromEntries(INITIAL_HELPER_TARGETS.map(target => [target.name, "0.1.5"])) };
    expect(() => validateNativeCandidateApp(pkg, "1.5.204", "0.1.5")).not.toThrow();
    expect(() => validateNativeCandidateApp({ ...pkg, private: true }, "1.5.204", "0.1.5")).toThrow();
    expect(() => validateNativeCandidateApp(pkg, "1.5.203", "0.1.5")).toThrow();
    expect(() => validateNativeCandidateApp(pkg, "1.5.204", "0.1.6")).toThrow();
    expect(() => validateNativeCandidateApp({ ...pkg, dependencies: { "@waifucave/ts-connect-darwin-arm64": "0.1.5" } }, "1.5.204", "0.1.5")).toThrow();
    expect(() => validateNativeCandidateApp({ ...pkg, optionalDependencies: { ...pkg.optionalDependencies, "@waifucave/ts-connect-linux-armv7": "0.1.5" } }, "1.5.204", "0.1.5")).toThrow();
  });
});
