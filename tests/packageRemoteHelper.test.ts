import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditRootPackageInventory } from "../scripts/audit-root-package.mjs";

const requiredPaths = [
  "bin/waifus.mjs",
  "contracts/remote/v1/capabilities.json",
  "contracts/remote/v1/fixtures/crypto/helper-manifest-trust-v1.json",
  "contracts/remote/v1/helper-manifest.schema.json",
  "contracts/remote/v1/protocol.schema.json",
  "contracts/remote/v1/remote-access.schema.json",
  "dist-frontend/index.html",
  "dist-frontend/waifus-dashboard-manifest.json",
  "dist-remote-shell/index.html",
  "dist/remote/helperBinary.js",
  "dist/remote/helperPackageManifest.js",
  "dist/remote/helperReleaseTrust.js",
  "dist/remote/productionHelper.js",
  "dist/shared/helperManifestTrust.js",
  "remote-compatibility.json"
];

function report(paths: readonly string[]) {
  return [{ files: paths.map((packagePath) => ({ path: packagePath })) }];
}

describe("root remote helper package inventory", () => {
  it("requires both dashboards, public contracts, compatibility, and helper trust code", async () => {
    const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(pkg.files).toContain("contracts/remote/v1/");
    expect(() => auditRootPackageInventory(report(requiredPaths))).not.toThrow();

    for (const required of requiredPaths) {
      expect(() => auditRootPackageInventory(report(
        requiredPaths.filter((packagePath) => packagePath !== required)
      )), required).toThrow(/required file is missing|complete file inventory/u);
    }
  });

  it("rejects source, local state, private-helper trees, and secret-shaped files", () => {
    for (const forbidden of [
      "src/remote/helperBinary.ts",
      ".dc-waifus/config.toml",
      ".env.production",
      ".github/workflows/release.yml",
      "research/private-notes.md",
      "ts-connect/internal/control/client.go",
      "keys/private-seed.txt",
      "id_ed25519"
    ]) {
      expect(
        () => auditRootPackageInventory(report([...requiredPaths, forbidden])),
        forbidden
      ).toThrow(/forbidden local, source, or secret-shaped path/u);
    }
  });
});
