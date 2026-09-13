import { createHash } from "node:crypto";
import {
  access,
  chmod,
  readFile,
  readdir,
  rm,
  stat,
  symlink
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DashboardAsset,
  DashboardManifest
} from "../src/shared/schemas/remoteAccess.js";
import { deriveDashboardBuildId } from "../src/remote/dashboardManifest.js";
import {
  DASHBOARD_BUILD_MAX_BYTES,
  DASHBOARD_BUILDS_PER_HOST,
  DASHBOARD_CACHE_MAX_BYTES,
  DashboardCache,
  type DashboardCacheHostKey,
  type DashboardCacheOptions
} from "../src/remote/dashboardCache.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const host = (value: number, trustEpoch = "1"): DashboardCacheHostKey => ({
  hostId: Buffer.alloc(32, value).toString("base64url") as never,
  trustEpoch: trustEpoch as never
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentType(relativePath: string): DashboardAsset["contentType"] {
  if (relativePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (relativePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (relativePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (relativePath.endsWith(".png")) return "image/png";
  throw new Error(`unsupported test asset: ${relativePath}`);
}

function dashboardFixture(
  marker: string,
  extraAssets: Record<string, Buffer> = {}
): { manifest: DashboardManifest; bodies: Map<string, Buffer> } {
  const bodies = new Map<string, Buffer>(Object.entries({
    ...extraAssets,
    "index.html": Buffer.from(`<main>${marker}</main>`, "utf8")
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const assets = [...bodies].map(([relativePath, bytes]) => ({
    path: relativePath,
    byteSize: bytes.byteLength.toString(10),
    sha256: sha256(bytes),
    contentType: contentType(relativePath)
  })) as DashboardAsset[];
  const input = {
    schemaVersion: 1 as const,
    discordWaifusVersion: "1.5.203",
    apiVersion: { major: 1 as const, minor: 0 as const },
    transportVersion: { major: 1 as const, minor: 0 as const },
    minimumHelperVersion: "0.1.0",
    minimumRemoteGatewayVersion: "1.5.203",
    requiredCapabilities: ["waifus.http.v1"],
    assets
  };
  return {
    manifest: { ...input, buildId: deriveDashboardBuildId(input) },
    bodies
  };
}

function sourceFor(
  bodies: Map<string, Buffer>,
  override: Partial<{ contentType: string; body: Uint8Array }> = {}
) {
  return async (asset: DashboardAsset) => ({
    contentType: override.contentType ?? asset.contentType,
    body: override.body ?? bodies.get(asset.path)!
  });
}

async function cache(options: Omit<DashboardCacheOptions, "dataRoot"> = {}) {
  const dataRoot = await makeTempRoot("waifus-dashboard-cache-");
  roots.push(dataRoot);
  return {
    dataRoot,
    cache: new DashboardCache({ dataRoot, ...options })
  };
}

describe("verified remote dashboard cache", () => {
  it("installs atomically and reopens a complete exact host/build hit", async () => {
    const harness = await cache();
    const key = host(0x41);
    const fixture = dashboardFixture("first", {
      "assets/app.js": Buffer.from("console.log('first')", "utf8")
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const install = harness.cache.install(key, fixture.manifest, async (asset) => ({
      contentType: asset.contentType,
      body: (async function* () {
        const bytes = fixture.bodies.get(asset.path)!;
        yield bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
        if (asset.path === "index.html") {
          started();
          await gate;
        }
        yield bytes.subarray(Math.max(1, Math.floor(bytes.byteLength / 2)));
      })()
    }));
    await startedPromise;
    const finalDirectory = path.join(
      remoteStatePaths(harness.dataRoot).dashboardCacheRoot,
      "hosts",
      key.hostId,
      key.trustEpoch,
      fixture.manifest.buildId
    );
    await expect(access(finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    release();
    const installed = await install;

    expect(installed.directory).toBe(finalDirectory);
    expect(await readFile(path.join(installed.directory, "index.html"), "utf8"))
      .toBe("<main>first</main>");
    await expect(harness.cache.openVerified(key, fixture.manifest)).resolves.toMatchObject({
      directory: finalDirectory,
      manifest: fixture.manifest
    });
  });

  it.each([
    {
      name: "content type",
      override: { contentType: "text/css; charset=utf-8" },
      code: "dashboard_asset_content_type_mismatch"
    },
    {
      name: "size",
      override: { body: Buffer.from("short", "utf8") },
      code: "dashboard_asset_size_mismatch"
    },
    {
      name: "hash",
      override: { body: Buffer.from("<main>other</main>", "utf8") },
      code: "dashboard_asset_hash_mismatch"
    }
  ])("rejects a $name mismatch and removes partial staging", async ({ override, code }) => {
    const harness = await cache();
    const fixture = dashboardFixture("first");
    await expect(harness.cache.install(host(0x42), fixture.manifest, sourceFor(
      fixture.bodies,
      override
    ))).rejects.toMatchObject({ code });
    const entries = await readdir(remoteStatePaths(harness.dataRoot).dashboardCacheRoot);
    expect(entries.some((entry) => entry.startsWith(".staging-"))).toBe(false);
  });

  it("cancels a partial streamed install without promoting it", async () => {
    const harness = await cache();
    const key = host(0x43);
    const fixture = dashboardFixture("cancelled");
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const installing = harness.cache.install(key, fixture.manifest, async (asset) => ({
      contentType: asset.contentType,
      body: (async function* () {
        started();
        yield fixture.bodies.get(asset.path)!.subarray(0, 2);
        await gate;
        yield fixture.bodies.get(asset.path)!.subarray(2);
      })()
    }), { signal: controller.signal });
    await startedPromise;
    controller.abort(new Error("test cancellation"));
    release();

    await expect(installing).rejects.toMatchObject({ code: "dashboard_download_cancelled" });
    await expect(harness.cache.openVerified(key, fixture.manifest)).resolves.toBeNull();
  });

  it("sanitizes asset source failures and removes partial staging", async () => {
    const harness = await cache();
    const fixture = dashboardFixture("stream-failure");
    const secret = "https://pair.example.invalid/private-room-token";

    const installing = harness.cache.install(host(0x4c), fixture.manifest, async (asset) => ({
      contentType: asset.contentType,
      body: (async function* () {
        yield fixture.bodies.get(asset.path)!.subarray(0, 2);
        throw new Error(secret);
      })()
    }));

    await expect(installing).rejects.toMatchObject({
      code: "dashboard_download_failed",
      message: expect.not.stringContaining(secret)
    });
    const entries = await readdir(remoteStatePaths(harness.dataRoot).dashboardCacheRoot);
    expect(entries.some((entry) => entry.startsWith(".staging-"))).toBe(false);
  });

  it("does not tighten permissions on the caller-owned data root", async () => {
    if (typeof process.getuid !== "function") return;
    const harness = await cache();
    await chmod(harness.dataRoot, 0o755);
    const fixture = dashboardFixture("root-mode");

    await harness.cache.install(host(0x4d), fixture.manifest, sourceFor(fixture.bodies));

    expect((await stat(harness.dataRoot)).mode & 0o777).toBe(0o755);
    expect((await stat(remoteStatePaths(harness.dataRoot).dashboardCacheRoot)).mode & 0o777)
      .toBe(0o700);
  });

  it("rejects invalid manifests and a symlink substituted into an installed build", async () => {
    const harness = await cache();
    const key = host(0x44);
    const fixture = dashboardFixture("safe", {
      "assets/app.js": Buffer.from("safe", "utf8")
    });
    const first = fixture.manifest.assets[0]!;
    for (const assets of [
      [{ ...first, path: "../index.html" }, ...fixture.manifest.assets.slice(1)],
      [first, first, ...fixture.manifest.assets.slice(1)]
    ]) {
      await expect(harness.cache.install(
        key,
        { ...fixture.manifest, assets } as DashboardManifest,
        sourceFor(fixture.bodies)
      )).rejects.toThrow();
    }

    const installed = await harness.cache.install(key, fixture.manifest, sourceFor(fixture.bodies));
    const assetPath = path.join(installed.directory, "assets", "app.js");
    await rm(assetPath);
    await symlink(path.join(installed.directory, "index.html"), assetPath);
    await expect(harness.cache.openVerified(key, fixture.manifest))
      .rejects.toMatchObject({ code: "dashboard_asset_symlink" });
  });

  it("enforces the exact fixed caps and testable smaller build limits before reading assets", async () => {
    expect(DASHBOARD_BUILD_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(DASHBOARD_CACHE_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(DASHBOARD_BUILDS_PER_HOST).toBe(2);
    const harness = await cache({ limits: { buildMaxBytes: 10 } });
    const fixture = dashboardFixture("too-large");
    let reads = 0;

    await expect(harness.cache.install(host(0x45), fixture.manifest, async (asset) => {
      reads += 1;
      return sourceFor(fixture.bodies)(asset);
    })).rejects.toMatchObject({ code: "dashboard_build_too_large" });
    expect(reads).toBe(0);
  });

  it("isolates hosts and removes an older trust epoch only for the rotated host", async () => {
    const harness = await cache();
    const firstHostOld = host(0x46, "7");
    const firstHostNew = host(0x46, "8");
    const secondHost = host(0x47, "3");
    const oldBuild = dashboardFixture("old");
    const newBuild = dashboardFixture("new");
    const otherBuild = dashboardFixture("other");
    const old = await harness.cache.install(firstHostOld, oldBuild.manifest, sourceFor(oldBuild.bodies));
    const other = await harness.cache.install(secondHost, otherBuild.manifest, sourceFor(otherBuild.bodies));
    const current = await harness.cache.install(firstHostNew, newBuild.manifest, sourceFor(newBuild.bodies));

    expect(current.directory).not.toBe(old.directory);
    expect(current.directory).not.toBe(other.directory);
    await expect(access(old.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(other.directory)).resolves.toBeUndefined();
    expect(await readFile(path.join(current.directory, "index.html"), "utf8"))
      .toBe("<main>new</main>");
  });

  it("retains only two newest builds per host", async () => {
    let now = 1_000_000;
    const harness = await cache({ now: () => now });
    const key = host(0x48);
    const fixtures = ["one", "two", "three"].map((value) => dashboardFixture(value));
    const directories: string[] = [];
    for (const fixture of fixtures) {
      directories.push((await harness.cache.install(
        key,
        fixture.manifest,
        sourceFor(fixture.bodies)
      )).directory);
      now += 10_000;
    }

    await expect(access(directories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(directories[1]!)).resolves.toBeUndefined();
    await expect(access(directories[2]!)).resolves.toBeUndefined();
  });

  it("evicts the globally least-recently-used build by verified asset bytes", async () => {
    let now = 1_000_000;
    const sample = dashboardFixture("12345678");
    const byteSize = Number(sample.manifest.assets[0]!.byteSize);
    const harness = await cache({
      now: () => now,
      limits: { cacheMaxBytes: byteSize * 2 }
    });
    const keys = [host(0x49), host(0x4a), host(0x4b)];
    const builds = [];
    for (let index = 0; index < keys.length; index += 1) {
      const fixture = dashboardFixture(`1234567${index}`);
      builds.push({
        key: keys[index]!,
        fixture,
        installed: await harness.cache.install(
          keys[index]!,
          fixture.manifest,
          sourceFor(fixture.bodies)
        )
      });
      now += 10_000;
    }

    await expect(access(builds[0]!.installed.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(builds[1]!.installed.directory)).resolves.toBeUndefined();
    await expect(access(builds[2]!.installed.directory)).resolves.toBeUndefined();
  });
});
