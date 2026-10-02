import { describe, expect, it } from "vitest";
import { validateHelperReleasePins, validateRegistryHelper } from "../scripts/releaseHelperPackages.mjs";

const targets = [
  ["darwin-arm64", "darwin", "arm64"],
  ["win32-x64", "win32", "x64"],
  ["win32-arm64", "win32", "arm64"],
  ["linux-x64", "linux", "x64"],
  ["linux-arm64", "linux", "arm64"]
] as const;
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function fixture() {
  const optionalDependencies: Record<string, string> = {};
  const packages: Record<string, Record<string, unknown>> = {};
  for (const [slug, os, cpu] of targets) {
    const name = `@waifucave/ts-connect-${slug}`;
    optionalDependencies[name] = "0.1.2";
    packages[`node_modules/${name}`] = {
      version: "0.1.2", optional: true, os: [os], cpu: [cpu], integrity,
      resolved: `https://registry.npmjs.org/${name}/-/ts-connect-${slug}-0.1.2.tgz`
    };
  }
  return { pkg: { optionalDependencies }, lock: { packages } };
}

describe("remote helper release pins", () => {
  it("requires every initial target with matching optional lock metadata", () => {
    const { pkg, lock } = fixture();
    expect(validateHelperReleasePins(pkg, lock)).toHaveLength(5);
    for (const [slug] of targets) {
      const missing = structuredClone(pkg);
      delete missing.optionalDependencies[`@waifucave/ts-connect-${slug}`];
      expect(() => validateHelperReleasePins(missing, lock)).toThrow(/exact optional helper/u);
    }
  });

  it("rejects ranges, mixed versions, deferred targets, and changed lock identities", () => {
    const name = "@waifucave/ts-connect-linux-x64";
    for (const version of ["^0.1.2", "latest", "file:../helper", "0.1.3"]) {
      const { pkg, lock } = fixture();
      pkg.optionalDependencies[name] = version;
      expect(() => validateHelperReleasePins(pkg, lock)).toThrow();
    }
    const deferred = fixture();
    deferred.pkg.optionalDependencies["@waifucave/ts-connect-linux-armv7"] = "0.1.2";
    expect(() => validateHelperReleasePins(deferred.pkg, deferred.lock)).toThrow(/unsupported helper/u);
    for (const change of [{ optional: false }, { cpu: ["arm64"] }, { integrity: "sha512-invalid" }]) {
      const { pkg, lock } = fixture();
      Object.assign(lock.packages[`node_modules/${name}`]!, change);
      expect(() => validateHelperReleasePins(pkg, lock)).toThrow(/lock metadata/u);
    }
  });
});

describe("registry helper release metadata", () => {
  it("binds the registry package to its approved target and locked tarball", () => {
    const { pkg, lock } = fixture();
    const [pin] = validateHelperReleasePins(pkg, lock);
    const metadata = {
      name: "@waifucave/ts-connect-darwin-arm64", version: "0.1.2", os: ["darwin"], cpu: ["arm64"],
      license: "SEE LICENSE IN LICENSE.txt", dist: { integrity, tarball: pin.resolved }
    };
    expect(() => validateRegistryHelper(metadata, pin)).not.toThrow();
    for (const change of [
      { name: "unrelated" }, { version: "0.1.3" }, { os: ["linux"] },
      { scripts: { postinstall: "node download.js" } }, { bin: "helper" },
      { dependencies: { surprise: "1.0.0" } },
      { dist: { integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`, tarball: pin.resolved } }
    ]) {
      expect(() => validateRegistryHelper({ ...metadata, ...change }, pin)).toThrow(/registry helper/u);
    }
  });
});
