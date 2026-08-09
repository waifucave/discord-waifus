import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELPER_PACKAGE_TARGETS,
  HelperManifestSchema,
  type HelperManifestInput
} from "../src/shared/schemas/remoteAccess.js";
import {
  createHelperManifestFixtureSet,
  createHelperManifestJsonSchema
} from "../src/shared/schemas/remoteAccessContract.js";
import {
  serializeCanonicalContractJson,
  serializeRemoteContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";

const hash = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function helperManifest(packageName = "@waifucave/ts-connect-linux-x64"): HelperManifestInput {
  const packageTarget = HELPER_PACKAGE_TARGETS.find((entry) => entry.packageName === packageName);
  if (!packageTarget) {
    throw new Error(`Unknown test package ${packageName}`);
  }
  return {
    schemaVersion: 1,
    helperVersion: "0.1.0",
    releaseSequence: "1",
    releasedAt: "2026-08-09T10:20:30Z",
    packageName: packageTarget.packageName,
    target: packageTarget.target,
    binary: {
      relativePath: packageTarget.target.os === "win32"
        ? "bin/ts-connect.exe"
        : "bin/ts-connect",
      byteSize: "9007199254740992",
      sha256: hash("1")
    },
    protocols: {
      ipc: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      coordination: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      directService: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      helperManifest: { major: 1, minimumMinor: 0, maximumMinor: 0 }
    },
    capabilities: [
      "waifus.browser-context.v1",
      "waifus.dashboard.manifest.v1",
      "waifus.http.v1",
      "waifus.principal.v1",
      "waifus.sse.cursor.v1",
      "waifus.stream.cancel.v1"
    ],
    minimumDiscordWaifusVersion: "1.5.203",
    maximumDiscordWaifusVersionExclusive: "1.6.0",
    sourceCommit: commit("2"),
    contractCommit: commit("3"),
    forkCommit: commit("4"),
    workerTrustRingSha256: hash("5"),
    tailscale: {
      tag: "v1.102.2",
      commit: "eb67e5dcbe145d63e1128b9b4b630f8a82da101f"
    },
    goVersion: "go1.26.5",
    directOnlyBuildTag: "waifus_direct_only",
    ossNoticeSha256: hash("6"),
    releaseKeyIds: ["waifucave-ts-connect-release-2026-01"]
  };
}

describe("HelperManifestSchema", () => {
  it("accepts every locked V1 package/target pairing", () => {
    for (const packageTarget of HELPER_PACKAGE_TARGETS) {
      expect(HelperManifestSchema.parse(helperManifest(packageTarget.packageName))).toMatchObject({
        packageName: packageTarget.packageName,
        target: packageTarget.target
      });
    }
  });

  it("rejects target/package/binary substitutions and unknown fields", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      packageName: "@waifucave/ts-connect-darwin-arm64"
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      binary: { ...manifest.binary, relativePath: "../../ts-connect" }
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, activationCredential: "secret" }).success).toBe(false);
  });

  it("keeps every uint64 JSON value canonical and lossless", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      releaseSequence: "18446744073709551615",
      binary: { ...manifest.binary, byteSize: "18446744073709551615" }
    }).success).toBe(true);
    expect(HelperManifestSchema.safeParse({ ...manifest, releaseSequence: 1 }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, releaseSequence: "01" }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, releaseSequence: "0" }).success).toBe(false);
  });

  it("requires whole-second UTC release time and an ordered app compatibility range", () => {
    const manifest = helperManifest();
    for (const releasedAt of [
      "2026-08-09T10:20:30.000Z",
      "2026-08-09T10:20:30+00:00",
      "2026-02-30T10:20:30Z"
    ]) {
      expect(HelperManifestSchema.safeParse({ ...manifest, releasedAt }).success).toBe(false);
    }
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      maximumDiscordWaifusVersionExclusive: manifest.minimumDiscordWaifusVersion
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      minimumDiscordWaifusVersion: "2.0.0",
      maximumDiscordWaifusVersionExclusive: "1.9.0"
    }).success).toBe(false);
  });

  it("requires ordered protocol ranges and sorted unique public identifiers", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      protocols: {
        ...manifest.protocols,
        ipc: { major: 1, minimumMinor: 2, maximumMinor: 1 }
      }
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      capabilities: ["waifus.stream.cancel.v1", "waifus.http.v1"]
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      releaseKeyIds: ["z-key", "a-key"]
    }).success).toBe(false);
  });

  it("pins the fork baseline, Go toolchain, direct-only tag, and trust-ring hash", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({ ...manifest, goVersion: "go1.26.4" }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, directOnlyBuildTag: "default" }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      tailscale: { ...manifest.tailscale, tag: "v1.102.1" }
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, workerTrustRingSha256: hash("G") }).success).toBe(false);
  });
});

describe("checked-in helper manifest contract", () => {
  it("matches the generated schema and every generated fixture byte-for-byte", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    const schemaBytes = await readFile(path.join(contractRoot, "helper-manifest.schema.json"), "utf8");
    expect(schemaBytes).toBe(serializeRemoteContractJson(createHelperManifestJsonSchema()));

    for (const [relativePath, value] of createHelperManifestFixtureSet()) {
      const actual = await readFile(path.join(contractRoot, relativePath), "utf8");
      expect(actual).toBe(serializeCanonicalContractJson(value));
      const expectedValid = relativePath.includes("/valid/");
      expect(HelperManifestSchema.safeParse(value).success, relativePath).toBe(expectedValid);
    }
  });

  it("publishes bounded hashes, paths, ranges, and compatibility fields", () => {
    const schema = createHelperManifestJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.HelperManifest).toMatchObject({
      type: "object",
      additionalProperties: false
    });
    expect(schema.$defs.HelperManifest).toHaveProperty("allOf");
    expect(schema.$defs.PositiveUint64Decimal).toHaveProperty("not", { const: "0" });
    expect(schema.$defs.CanonicalReleasedAt).toHaveProperty(
      "format",
      "waifus-rfc3339-whole-second"
    );
  });
});
