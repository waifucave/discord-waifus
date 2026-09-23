import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRemoteCompatibilityV1,
  type RemoteCompatibilityV1
} from "../src/remote/componentCompatibility.js";
import {
  resolveTsConnectBinary,
  supportedHelperTarget
} from "../src/remote/helperBinary.js";
import { verifyHelperPackageManifest } from "../src/remote/helperPackageManifest.js";
import {
  HELPER_CONTROL_PROFILES_V1,
  type HelperEmbeddedBuildInfoV1,
  type HelperReleaseTrustEntryV1
} from "../src/shared/helperManifestTrust.js";
import { signEd25519 } from "../src/shared/remotePairing.js";
import type { HelperManifest } from "../src/shared/schemas/remoteAccess.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

type JsonObject = Record<string, unknown>;

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  return value;
}

async function trustFixture(): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path.join(
    process.cwd(),
    "contracts",
    "remote",
    "v1",
    "fixtures",
    "crypto",
    "helper-manifest-trust-v1.json"
  ), "utf8")), "helper trust fixture");
}

function manifestFrom(value: JsonObject): HelperManifest {
  return JSON.parse(Buffer.from(string(value.manifestBytesB64, "manifest bytes"), "base64url").toString("utf8")) as HelperManifest;
}

function compatibilityFrom(value: JsonObject): RemoteCompatibilityV1 {
  const manifest = manifestFrom(value);
  return parseRemoteCompatibilityV1({
    schemaVersion: 1,
    discordWaifusVersion: "1.5.203",
    helper: {
      minimumVersion: "0.1.0",
      maximumVersionExclusive: "0.2.0",
      minimumReleaseSequence: "42",
      workerTrustRingSha256: manifest.workerTrustRingSha256
    },
    protocols: {
      ...manifest.protocols,
      dashboardManifest: { major: 1, minimumMinor: 0, maximumMinor: 0 }
    },
    requiredCapabilities: manifest.capabilities
  }, "1.5.203");
}

function signaturesFrom(value: JsonObject): ReadonlyMap<string, Buffer> {
  return new Map(Object.entries(object(value.signatures, "signatures")).map(([keyId, signature]) => [
    keyId,
    Buffer.from(string(signature, "signature"), "base64url")
  ]));
}

function buildInfoFrom(manifest: HelperManifest): HelperEmbeddedBuildInfoV1 {
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

async function signedVariant(
  fixture: JsonObject,
  mutate: (manifest: HelperManifest) => void
): Promise<Readonly<{
  manifestBytes: Buffer;
  signatures: ReadonlyMap<string, Buffer>;
  embeddedBuildInfo: HelperEmbeddedBuildInfoV1;
}>> {
  const valid = object(fixture.valid, "valid fixture");
  const manifest = structuredClone(manifestFrom(valid));
  mutate(manifest);
  const manifestBytes = Buffer.from(
    serializeCanonicalContractJson(manifest as unknown as ContractJson),
    "utf8"
  );
  const keys = new Map(
    (fixture.releaseKeys as JsonObject[]).map((raw) => {
      const key = object(raw, "release key");
      return [
        string(key.keyId, "key id"),
        Buffer.from(string(key.privateSeedB64, "test seed"), "base64url")
      ];
    })
  );
  return {
    manifestBytes,
    signatures: new Map(manifest.releaseKeyIds.map((keyId) => [
      keyId,
      signEd25519(keys.get(keyId)!, manifestBytes)
    ])),
    embeddedBuildInfo: buildInfoFrom(manifest)
  };
}

async function createFixturePackage(
  packageRoot: string,
  valid: JsonObject,
  overrides: Readonly<{
    packageJson?: JsonObject;
    binaryBytes?: Buffer;
    manifestBytes?: Buffer;
    signatures?: ReadonlyMap<string, Buffer>;
  }> = {}
): Promise<void> {
  const manifest = overrides.manifestBytes
    ? JSON.parse(overrides.manifestBytes.toString("utf8")) as HelperManifest
    : manifestFrom(valid);
  const packageJson = overrides.packageJson ?? {
    name: manifest.packageName,
    version: manifest.helperVersion,
    os: [manifest.target.os],
    cpu: [manifest.target.arch],
    license: "SEE LICENSE IN LICENSE.txt"
  };
  const signatures = overrides.signatures ?? signaturesFrom(valid);
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "signatures"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    path.join(packageRoot, manifest.binary.relativePath),
    overrides.binaryBytes ?? Buffer.from(string(valid.binaryB64, "binary"), "base64url")
  );
  await chmod(path.join(packageRoot, manifest.binary.relativePath), 0o755);
  await writeFile(
    path.join(packageRoot, "manifest.json"),
    overrides.manifestBytes ?? Buffer.from(string(valid.manifestBytesB64, "manifest"), "base64url")
  );
  for (const [keyId, signature] of signatures) {
    await writeFile(path.join(packageRoot, "signatures", `${keyId}.sig`), signature);
  }
  await writeFile(path.join(packageRoot, "LICENSE.txt"), "test-only package license\n");
  await writeFile(
    path.join(packageRoot, "THIRD_PARTY_NOTICES.txt"),
    Buffer.from(string(valid.noticesB64, "notices"), "base64url")
  );
  await writeFile(path.join(packageRoot, "sbom.spdx.json"), "{}\n");
}

function resolverOptions(
  packageRoot: string,
  valid: JsonObject,
  overrides: Record<string, unknown> = {}
) {
  return {
    platform: "linux" as const,
    arch: "x64" as const,
    appVersion: "1.5.203",
    compatibility: compatibilityFrom(valid),
    trustRoots: valid.trustEntries as HelperReleaseTrustEntryV1[],
    resolvePackageJson: async () => path.join(packageRoot, "package.json"),
    probeBinary: async () => valid.embeddedBuildInfo as HelperEmbeddedBuildInfoV1,
    ...overrides
  };
}

describe("ts-connect target selection", () => {
  it("maps exactly the six supported target shapes", () => {
    expect(supportedHelperTarget("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(supportedHelperTarget("win32", "x64")).toEqual({ os: "win32", arch: "x64" });
    expect(supportedHelperTarget("win32", "arm64")).toEqual({ os: "win32", arch: "arm64" });
    expect(supportedHelperTarget("linux", "x64")).toEqual({ os: "linux", arch: "x64" });
    expect(supportedHelperTarget("linux", "arm64")).toEqual({ os: "linux", arch: "arm64" });
    expect(supportedHelperTarget("linux", "arm", 7)).toEqual({ os: "linux", arch: "arm", goarm: 7 });
  });

  it("rejects Intel macOS, ambiguous ARM, and unknown targets without fallback", () => {
    for (const input of [
      ["darwin", "x64"],
      ["linux", "arm"],
      ["linux", "arm", 6],
      ["freebsd", "x64"]
    ] as const) {
      try {
        supportedHelperTarget(input[0] as NodeJS.Platform, input[1] as NodeJS.Architecture, input[2]);
        throw new Error("expected unsupported target");
      } catch (error) {
        expect(error).toMatchObject({ code: "unsupported_platform" });
      }
    }
  });
});

describe("root remote compatibility", () => {
  it("rejects app-version drift, unbounded helper ranges, and unsorted capabilities", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const compatibility = compatibilityFrom(valid);
    expect(() => parseRemoteCompatibilityV1({
      ...compatibility,
      discordWaifusVersion: "1.5.202"
    }, "1.5.203")).toThrow();
    expect(() => parseRemoteCompatibilityV1({
      ...compatibility,
      helper: {
        ...compatibility.helper,
        maximumVersionExclusive: compatibility.helper.minimumVersion
      }
    }, "1.5.203")).toThrow();
    expect(() => parseRemoteCompatibilityV1({
      ...compatibility,
      requiredCapabilities: [...compatibility.requiredCapabilities].reverse()
    }, "1.5.203")).toThrow();
  });
});

describe("signed ts-connect package resolution", () => {
  it("resolves source and installed copies to byte-identical verified helpers", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const root = await makeTempRoot("waifus-helper-package-");
    roots.push(root);
    const source = path.join(root, "source", "node_modules", "@waifucave", "ts-connect-linux-x64");
    const installed = path.join(root, "installed", "node_modules", "@waifucave", "ts-connect-linux-x64");
    await createFixturePackage(source, valid);
    await createFixturePackage(installed, valid);

    const sourceResult = await resolveTsConnectBinary(resolverOptions(source, valid));
    const installedResult = await resolveTsConnectBinary(resolverOptions(installed, valid));
    expect(sourceResult.packageName).toBe("@waifucave/ts-connect-linux-x64");
    expect(sourceResult.binarySha256).toBe(installedResult.binarySha256);
    expect(sourceResult.binarySha256).toBe(
      createHash("sha256").update(await readFile(sourceResult.binaryPath)).digest("hex")
    );
    expect(sourceResult.helperVersion).toBe("0.1.0");
    expect(sourceResult.releaseSequence).toBe("42");
    expect(sourceResult.ipcProtocol).toEqual({
      minimum: { major: 1, minor: 0 },
      maximum: { major: 1, minor: 0 }
    });
  });

  it("resolves synthetic macOS and Windows packages without an OS-signature check", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const root = await makeTempRoot("waifus-helper-unsigned-os-");
    roots.push(root);
    for (const target of [
      { platform: "darwin" as const, arch: "arm64" as const, packageName: "@waifucave/ts-connect-darwin-arm64", binaryPath: "bin/ts-connect" },
      { platform: "win32" as const, arch: "x64" as const, packageName: "@waifucave/ts-connect-win32-x64", binaryPath: "bin/ts-connect.exe" },
      { platform: "win32" as const, arch: "arm64" as const, packageName: "@waifucave/ts-connect-win32-arm64", binaryPath: "bin/ts-connect.exe" }
    ]) {
      const changed = await signedVariant(fixture, (manifest) => {
        manifest.packageName = target.packageName as HelperManifest["packageName"];
        manifest.target = { os: target.platform, arch: target.arch };
        manifest.binary.relativePath = target.binaryPath;
      });
      const packageRoot = path.join(root, `${target.platform}-${target.arch}`);
      await createFixturePackage(packageRoot, valid, {
        manifestBytes: changed.manifestBytes,
        signatures: changed.signatures
      });
      const probeBinary = vi.fn(async () => changed.embeddedBuildInfo);
      const resolved = await resolveTsConnectBinary({
        ...resolverOptions(packageRoot, valid),
        platform: target.platform,
        arch: target.arch,
        probeBinary
      });
      expect(resolved.packageName).toBe(target.packageName);
      expect(probeBinary).toHaveBeenCalledExactlyOnceWith(path.join(packageRoot, target.binaryPath));
    }
  });

  it("reports a missing optional package and never searches PATH", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const resolvePackageJson = vi.fn(async () => {
      const error = new Error("module not found") as NodeJS.ErrnoException;
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });
    await expect(resolveTsConnectBinary({
      ...resolverOptions("/unused", valid),
      resolvePackageJson
    })).rejects.toMatchObject({ code: "helper_missing" });
    expect(resolvePackageJson).toHaveBeenCalledExactlyOnceWith("@waifucave/ts-connect-linux-x64");
  });

  it("rejects wrong npm target metadata before probing the binary", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const root = await makeTempRoot("waifus-helper-package-");
    roots.push(root);
    const packageRoot = path.join(root, "package");
    await createFixturePackage(packageRoot, valid, {
      packageJson: {
        name: "@waifucave/ts-connect-linux-x64",
        version: "0.1.0",
        os: ["linux"],
        cpu: ["arm64"],
        license: "SEE LICENSE IN LICENSE.txt"
      }
    });
    const probeBinary = vi.fn(async () => valid.embeddedBuildInfo as HelperEmbeddedBuildInfoV1);
    await expect(resolveTsConnectBinary({
      ...resolverOptions(packageRoot, valid),
      probeBinary
    })).rejects.toMatchObject({ code: "helper_signature_invalid" });
    expect(probeBinary).not.toHaveBeenCalled();
  });

  it("rejects binary mutation and invalid signatures before executing", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    for (const mutation of ["binary", "signature"] as const) {
      const root = await makeTempRoot(`waifus-helper-${mutation}-`);
      roots.push(root);
      const packageRoot = path.join(root, "package");
      const signatures = new Map(signaturesFrom(valid));
      if (mutation === "signature") signatures.get("waifucave-ts-connect-release-test-new")![0] ^= 1;
      await createFixturePackage(packageRoot, valid, {
        ...(mutation === "binary" ? { binaryBytes: Buffer.from("changed helper bytes\n") } : {}),
        signatures
      });
      const probeBinary = vi.fn(async () => valid.embeddedBuildInfo as HelperEmbeddedBuildInfoV1);
      await expect(resolveTsConnectBinary({
        ...resolverOptions(packageRoot, valid),
        probeBinary
      })).rejects.toMatchObject({ code: "helper_signature_invalid" });
      expect(probeBinary).not.toHaveBeenCalled();
    }
  });

  it("enforces release, Worker, protocol, capability, and both app version bounds", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const compatibility = compatibilityFrom(valid);
    const cases: Array<readonly [string, (manifest: HelperManifest) => void]> = [
      ["release downgrade", (manifest) => { manifest.releaseSequence = "41"; }],
      ["Worker trust", (manifest) => { manifest.workerTrustRingSha256 = "0".repeat(64); }],
      ["protocol", (manifest) => { manifest.protocols.ipc.major = 2; }],
      ["capability", (manifest) => {
        manifest.capabilities = manifest.capabilities.filter((value) => value !== "waifus.http.v1");
      }],
      ["app below", (manifest) => { manifest.minimumDiscordWaifusVersion = "1.5.204"; }],
      ["app upper", (manifest) => { manifest.maximumDiscordWaifusVersionExclusive = "1.5.203"; }]
    ];
    for (const [name, mutate] of cases) {
      const changed = await signedVariant(fixture, mutate);
      const manifest = manifestFrom({ manifestBytesB64: changed.manifestBytes.toString("base64url") });
      expect(
        () => verifyHelperPackageManifest({
          manifestBytes: changed.manifestBytes,
          signatures: changed.signatures,
          binaryBytes: Buffer.from(string(valid.binaryB64, "binary"), "base64url"),
          noticesBytes: Buffer.from(string(valid.noticesB64, "notices"), "base64url"),
          embeddedBuildInfo: changed.embeddedBuildInfo,
          trustRoots: valid.trustEntries as HelperReleaseTrustEntryV1[],
          packageName: manifest.packageName,
          packageVersion: manifest.helperVersion,
          target: { os: "linux", arch: "x64" },
          appVersion: "1.5.203",
          compatibility
        }),
        name
      ).toThrow();
    }
  });

  it("rejects an injected compatibility table for a different app version", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const manifest = manifestFrom(valid);
    const compatibility = {
      ...compatibilityFrom(valid),
      discordWaifusVersion: "1.5.202"
    } as RemoteCompatibilityV1;
    expect(() => verifyHelperPackageManifest({
      manifestBytes: Buffer.from(string(valid.manifestBytesB64, "manifest"), "base64url"),
      signatures: signaturesFrom(valid),
      binaryBytes: Buffer.from(string(valid.binaryB64, "binary"), "base64url"),
      noticesBytes: Buffer.from(string(valid.noticesB64, "notices"), "base64url"),
      embeddedBuildInfo: valid.embeddedBuildInfo as HelperEmbeddedBuildInfoV1,
      trustRoots: valid.trustEntries as HelperReleaseTrustEntryV1[],
      packageName: manifest.packageName,
      packageVersion: manifest.helperVersion,
      target: manifest.target,
      appVersion: "1.5.203",
      compatibility
    })).toThrow();
  });

  it("rejects undeclared files, symlinks, and embedded metadata drift", async () => {
    const fixture = await trustFixture();
    const valid = object(fixture.valid, "valid fixture");
    const root = await makeTempRoot("waifus-helper-inventory-");
    roots.push(root);
    const packageRoot = path.join(root, "package");
    await createFixturePackage(packageRoot, valid);
    await writeFile(path.join(packageRoot, "install.js"), "throw new Error('must not ship');\n");
    await expect(resolveTsConnectBinary(resolverOptions(packageRoot, valid)))
      .rejects.toMatchObject({ code: "helper_signature_invalid" });

    await removeTempRoot(packageRoot);
    await createFixturePackage(packageRoot, valid);
    const manifest = manifestFrom(valid);
    const binaryPath = path.join(packageRoot, manifest.binary.relativePath);
    const linkedBinary = path.join(root, "linked-helper");
    await writeFile(linkedBinary, Buffer.from(string(valid.binaryB64, "binary"), "base64url"));
    await rm(binaryPath);
    await symlink(linkedBinary, binaryPath);
    await expect(resolveTsConnectBinary(resolverOptions(packageRoot, valid)))
      .rejects.toMatchObject({ code: "helper_signature_invalid" });

    await removeTempRoot(packageRoot);
    await createFixturePackage(packageRoot, valid);
    await expect(resolveTsConnectBinary({
      ...resolverOptions(packageRoot, valid),
      probeBinary: async () => ({
        ...valid.embeddedBuildInfo as HelperEmbeddedBuildInfoV1,
        helperVersion: "0.1.1"
      })
    })).rejects.toMatchObject({ code: "helper_signature_invalid" });
  });
});
