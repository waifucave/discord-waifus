import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRemoteCompatibilityV1,
  parseRemoteCompatibilityV1
} from "../src/remote/componentCompatibility.js";
import { INITIAL_REQUIRED_CAPABILITIES } from "../src/shared/schemas/remoteProtocol.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("shipped remote compatibility table", () => {
  it("matches the running root version and the closed initial helper/Worker window", async () => {
    const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
      files: string[];
    };
    const compatibility = await loadRemoteCompatibilityV1(pkg.version);
    expect(pkg.files).toContain("remote-compatibility.json");
    expect(compatibility).toMatchObject({
      schemaVersion: 1,
      discordWaifusVersion: pkg.version,
      helper: {
        minimumVersion: "0.1.0",
        maximumVersionExclusive: "0.2.0",
        minimumReleaseSequence: "1",
        workerTrustRingSha256: "26d6afdf3ccb12a14a06c7a5edf61221b3db3255b814926d7fe006cdb9ced245"
      }
    });
    expect(compatibility.requiredCapabilities).toEqual(INITIAL_REQUIRED_CAPABILITIES);
    const driftedVersion = pkg.version.replace(/([0-9]+)$/u, (last) => String(Number(last) + 1));
    await expect(loadRemoteCompatibilityV1(driftedVersion)).rejects.toThrow(/version/u);
  });

  it("rejects noncanonical, symlinked, incomplete, and version-drifted metadata", async () => {
    const dataRoot = await makeTempRoot("waifus-compatibility-file-");
    roots.push(dataRoot);
    const original = await readFile(path.join(process.cwd(), "remote-compatibility.json"), "utf8");
    const value = JSON.parse(original) as Record<string, unknown>;
    const version = String(value.discordWaifusVersion);
    const driftedVersion = version.replace(/([0-9]+)$/u, (last) => String(Number(last) + 1));
    const filePath = path.join(dataRoot, "compatibility.json");
    await writeFile(filePath, JSON.stringify(value, null, 2));
    await expect(loadRemoteCompatibilityV1(version, filePath))
      .rejects.toThrow(/canonical/u);
    await writeFile(filePath, original.replace(version, driftedVersion));
    await expect(loadRemoteCompatibilityV1(version, filePath))
      .rejects.toThrow(/version/u);
    const incomplete = { ...value, requiredCapabilities: ["waifus.http.v1"] };
    expect(() => parseRemoteCompatibilityV1(incomplete, version))
      .toThrow(/invalid/u);
    await writeFile(filePath, original);
    const linkPath = path.join(dataRoot, "link.json");
    await symlink(filePath, linkPath);
    await expect(loadRemoteCompatibilityV1(version, linkPath))
      .rejects.toThrow(/regular file/u);
  });
});
