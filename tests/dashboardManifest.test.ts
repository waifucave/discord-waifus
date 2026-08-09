import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DashboardManifestSchema,
  type DashboardManifest
} from "../src/shared/schemas/remoteAccess.js";
import {
  DASHBOARD_ASSET_MAX_BYTES,
  DASHBOARD_MANIFEST_FILENAME,
  DASHBOARD_MANIFEST_MAX_BYTES,
  createDashboardManifest,
  deriveDashboardBuildId,
  loadBundledDashboardManifest,
  parseDashboardManifestBytes,
  serializeDashboardManifest,
  writeDashboardManifest
} from "../src/remote/dashboardManifest.js";
import { serializeCanonicalContractJson } from "../src/shared/schemas/remoteProtocolContract.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function fixtureBundle(): Promise<{ packageRoot: string; bundleDirectory: string }> {
  const packageRoot = await makeTempRoot("waifus-dashboard-manifest-");
  roots.push(packageRoot);
  const bundleDirectory = path.join(packageRoot, "dist-frontend");
  await mkdir(path.join(bundleDirectory, "assets"), { recursive: true });
  await Promise.all([
    writeFile(path.join(bundleDirectory, "index.html"), "<!doctype html><script type=\"module\" src=\"/assets/app-a1.js\"></script>"),
    writeFile(path.join(bundleDirectory, "assets", "app-a1.js"), "console.log(\"waifus\");\n"),
    writeFile(path.join(bundleDirectory, "assets", "app-a1.css"), ":root{color-scheme:dark}\n"),
    writeFile(path.join(bundleDirectory, "assets", "font-a1.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32])),
    writeFile(path.join(bundleDirectory, "assets", "pixel-a1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  ]);
  return { packageRoot, bundleDirectory };
}

const options = {
  discordWaifusVersion: "1.5.203",
  minimumHelperVersion: "0.1.0",
  minimumRemoteGatewayVersion: "1.5.203"
} as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("dashboard bundle manifest", () => {
  it("accepts the checked-in canonical public dashboard fixture", async () => {
    const encoded = await readFile(path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "valid",
      "dashboard-manifest.json"
    ));
    const manifest = parseDashboardManifestBytes(encoded);
    expect(manifest.buildId).toBe(deriveDashboardBuildId(manifest));
  });

  it("builds a deterministic sorted allowlist with exact hashes and compatibility pins", async () => {
    const { bundleDirectory } = await fixtureBundle();
    const first = await createDashboardManifest({ bundleDirectory, ...options });
    const second = await createDashboardManifest({ bundleDirectory, ...options });

    expect(first).toEqual(second);
    expect(DashboardManifestSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      discordWaifusVersion: "1.5.203",
      apiVersion: { major: 1, minor: 0 },
      transportVersion: { major: 1, minor: 0 },
      minimumHelperVersion: "0.1.0",
      minimumRemoteGatewayVersion: "1.5.203",
      requiredCapabilities: [
        "waifus.browser-context.v1",
        "waifus.dashboard.manifest.v1",
        "waifus.http.v1",
        "waifus.principal.v1",
        "waifus.sse.cursor.v1",
        "waifus.stream.cancel.v1"
      ]
    });
    expect(first.assets.map((asset) => asset.path)).toEqual([
      "assets/app-a1.css",
      "assets/app-a1.js",
      "assets/font-a1.woff2",
      "assets/pixel-a1.png",
      "index.html"
    ]);
    expect(first.assets.find((asset) => asset.path === "assets/app-a1.js")).toEqual({
      path: "assets/app-a1.js",
      byteSize: "23",
      sha256: sha256("console.log(\"waifus\");\n"),
      contentType: "text/javascript; charset=utf-8"
    });
    expect(first.buildId).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(path.join(bundleDirectory, "assets", "app-a1.js"), "console.log(\"changed\");\n");
    const changed = await createDashboardManifest({ bundleDirectory, ...options });
    expect(changed.buildId).not.toBe(first.buildId);
  });

  it("writes compact canonical bytes, excludes itself, and reloads the exact verified build", async () => {
    const { packageRoot, bundleDirectory } = await fixtureBundle();
    const manifest = await writeDashboardManifest({ bundleDirectory, ...options });
    const encoded = await readFile(path.join(bundleDirectory, DASHBOARD_MANIFEST_FILENAME), "utf8");

    expect(encoded).toBe(serializeDashboardManifest(manifest));
    expect(encoded.endsWith("\n")).toBe(false);
    expect(manifest.assets.some((asset) => asset.path === DASHBOARD_MANIFEST_FILENAME)).toBe(false);
    expect(await loadBundledDashboardManifest(packageRoot)).toEqual(manifest);
  });

  it("does not expose an absolute package path when the bundle is unavailable", async () => {
    const packageRoot = await makeTempRoot("waifus-dashboard-missing-");
    roots.push(packageRoot);
    let message = "";
    try {
      await loadBundledDashboardManifest(packageRoot);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("dashboard_asset_not_regular");
    expect(message).not.toContain(packageRoot);
  });

  it("rejects noncanonical bytes, build-ID substitution, traversal, duplicates, and unsorted assets", async () => {
    const { bundleDirectory } = await fixtureBundle();
    const manifest = await createDashboardManifest({ bundleDirectory, ...options });
    expect(() => parseDashboardManifestBytes(Buffer.from(` ${serializeDashboardManifest(manifest)}`))).toThrow(
      "noncanonical_dashboard_manifest"
    );
    const wrongBuildId = {
      ...manifest,
      buildId: "0".repeat(64)
    };
    expect(() => serializeDashboardManifest(wrongBuildId)).toThrow("dashboard_build_id_mismatch");
    expect(() => parseDashboardManifestBytes(Buffer.from(
      serializeCanonicalContractJson(wrongBuildId)
    ))).toThrow("dashboard_build_id_mismatch");
    expect(() => parseDashboardManifestBytes(Buffer.alloc(DASHBOARD_MANIFEST_MAX_BYTES + 1, 0x61)))
      .toThrow("dashboard_manifest_too_large");

    const firstAsset = manifest.assets[0];
    for (const invalidPath of [
      "../index.html",
      "/index.html",
      "assets\\index.js",
      "assets//index.js",
      "assets/./index.js"
    ]) {
      expect(DashboardManifestSchema.safeParse({
        ...manifest,
        assets: [{ ...firstAsset, path: invalidPath }, ...manifest.assets.slice(1)]
      }).success, invalidPath).toBe(false);
    }
    expect(DashboardManifestSchema.safeParse({
      ...manifest,
      assets: [firstAsset, firstAsset, ...manifest.assets.slice(1)]
    }).success).toBe(false);
    expect(DashboardManifestSchema.safeParse({
      ...manifest,
      assets: [...manifest.assets].reverse()
    }).success).toBe(false);
  });

  it("rejects symlinks, unsupported content types, and assets above 16 MiB", async () => {
    const symlinkBundle = await fixtureBundle();
    await symlink(
      path.join(symlinkBundle.bundleDirectory, "index.html"),
      path.join(symlinkBundle.bundleDirectory, "assets", "linked.html")
    );
    await expect(createDashboardManifest({ bundleDirectory: symlinkBundle.bundleDirectory, ...options }))
      .rejects.toThrow("dashboard_asset_symlink");

    const unsupportedBundle = await fixtureBundle();
    await writeFile(path.join(unsupportedBundle.bundleDirectory, "assets", "payload.exe"), "MZ");
    await expect(createDashboardManifest({ bundleDirectory: unsupportedBundle.bundleDirectory, ...options }))
      .rejects.toThrow("dashboard_asset_content_type");

    const oversizedBundle = await fixtureBundle();
    await writeFile(
      path.join(oversizedBundle.bundleDirectory, "assets", "oversized.js"),
      Buffer.alloc(DASHBOARD_ASSET_MAX_BYTES + 1, 0x61)
    );
    await expect(createDashboardManifest({ bundleDirectory: oversizedBundle.bundleDirectory, ...options }))
      .rejects.toThrow("dashboard_asset_too_large");
  });

  it("rejects post-manifest size/hash drift, undeclared output, symlink replacement, and MIME drift", async () => {
    const sizeDrift = await fixtureBundle();
    await writeDashboardManifest({ bundleDirectory: sizeDrift.bundleDirectory, ...options });
    await writeFile(path.join(sizeDrift.bundleDirectory, "assets", "app-a1.js"), "changed");
    await expect(loadBundledDashboardManifest(sizeDrift.packageRoot)).rejects.toThrow(
      "dashboard_asset_size_mismatch"
    );

    const hashDrift = await fixtureBundle();
    await writeDashboardManifest({ bundleDirectory: hashDrift.bundleDirectory, ...options });
    const changedBytes = await readFile(path.join(hashDrift.bundleDirectory, "assets", "app-a1.js"));
    changedBytes[0] ^= 1;
    await writeFile(path.join(hashDrift.bundleDirectory, "assets", "app-a1.js"), changedBytes);
    await expect(loadBundledDashboardManifest(hashDrift.packageRoot)).rejects.toThrow(
      "dashboard_asset_hash_mismatch"
    );

    const undeclared = await fixtureBundle();
    await writeDashboardManifest({ bundleDirectory: undeclared.bundleDirectory, ...options });
    await writeFile(path.join(undeclared.bundleDirectory, "assets", "late.js"), "late");
    await expect(loadBundledDashboardManifest(undeclared.packageRoot)).rejects.toThrow(
      "dashboard_asset_set_mismatch"
    );

    const symlinked = await fixtureBundle();
    await writeDashboardManifest({ bundleDirectory: symlinked.bundleDirectory, ...options });
    await symlink(
      path.join(symlinked.bundleDirectory, "index.html"),
      path.join(symlinked.bundleDirectory, "assets", "late.css")
    );
    await expect(loadBundledDashboardManifest(symlinked.packageRoot)).rejects.toThrow(
      "dashboard_asset_symlink"
    );

    const mimeDrift = await fixtureBundle();
    const manifest = await writeDashboardManifest({ bundleDirectory: mimeDrift.bundleDirectory, ...options });
    const altered: DashboardManifest = {
      ...manifest,
      assets: manifest.assets.map((asset) => asset.path === "assets/app-a1.js"
        ? { ...asset, contentType: "text/css; charset=utf-8" }
        : asset)
    };
    const reidentified = {
      ...altered,
      buildId: deriveDashboardBuildId(altered)
    };
    await writeFile(
      path.join(mimeDrift.bundleDirectory, DASHBOARD_MANIFEST_FILENAME),
      serializeDashboardManifest(reidentified as DashboardManifest)
    );
    await expect(loadBundledDashboardManifest(mimeDrift.packageRoot)).rejects.toThrow(
      "dashboard_asset_content_type_mismatch"
    );
  });
});
