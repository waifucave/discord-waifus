import { once } from "node:events";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { DashboardBuild } from "../src/backend/remoteAccess/dashboardBuild.js";
import { RemoteRequestBridge } from "../src/backend/remoteAccess/requestBridge.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import {
  serializeDashboardManifest,
  writeDashboardManifest
} from "../src/remote/dashboardManifest.js";
import type { RequestPrincipalWire } from "../src/shared/schemas/remoteProtocol.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
// @ts-expect-error JavaScript fixture exercises the authenticated helper boundary.
import { FakeTsConnect } from "./fixtures/fakeTsConnect.mjs";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const bridges: RemoteRequestBridge[] = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function remotePrincipal() {
  return createRemoteRequestPrincipal(remotePrincipalWire());
}

function remotePrincipalWire(): RequestPrincipalWire {
  return {
    kind: "remote_device",
    stableId: "remote:dashboard-client",
    deviceId: "dashboard-client",
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(0x32),
    trustEpoch: "3"
  };
}

function bridgeStart(canonicalTarget: string) {
  return {
    version: 1 as const,
    method: "GET" as const,
    canonicalTarget,
    headers: [] as Array<readonly [string, string]>,
    principal: remotePrincipalWire()
  };
}

type DashboardFixture = {
  readonly packageRoot: string;
  readonly bundleDirectory: string;
  readonly manifest: Awaited<ReturnType<typeof writeDashboardManifest>>;
};

async function dashboardFixture(
  extraAssets: Record<string, Uint8Array | string> = {}
): Promise<DashboardFixture> {
  const packageRoot = await makeTempRoot("waifus-dashboard-api-package-");
  roots.push(packageRoot);
  const bundleDirectory = path.join(packageRoot, "dist-frontend");
  const assets: Record<string, Uint8Array | string> = {
    "assets/app.css": ":root{color-scheme:dark}\n",
    "assets/app.js": "console.log(\"dashboard\");\n",
    "assets/font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32]),
    "assets/pixel.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "index.html": "<!doctype html><script type=\"module\" src=\"/assets/app.js\"></script>",
    ...extraAssets
  };
  await Promise.all(Object.entries(assets).map(async ([relativePath, bytes]) => {
    const destination = path.join(bundleDirectory, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }));
  const manifest = await writeDashboardManifest({
    bundleDirectory,
    discordWaifusVersion: "1.5.203",
    minimumHelperVersion: "0.1.0",
    minimumRemoteGatewayVersion: "1.5.203"
  });
  return { packageRoot, bundleDirectory, manifest };
}

async function makeHarness(options: {
  readonly authorized?: boolean;
  readonly exposeBuild?: boolean;
  readonly fixture?: DashboardFixture;
} = {}) {
  const dataRoot = await makeTempRoot("waifus-dashboard-api-data-");
  roots.push(dataRoot);
  await ensureDataLayout(dataRoot);
  const fixture = options.fixture ?? await dashboardFixture();
  const dashboardBuild = await DashboardBuild.load({
    bundleDirectory: fixture.bundleDirectory,
    expectedBuildId: fixture.manifest.buildId
  });
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date(1_786_270_800_000).toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot,
    runtime,
    storage: new StorageService(dataRoot),
    remoteTrust: { isAuthorized: () => options.authorized ?? true },
    ...(options.exposeBuild === false ? {} : { dashboardBuild }),
    browserSecurity: { listenerHost: "127.0.0.1", port: 3888, mode: "test" }
  });
  apps.push(app);
  return { app, dashboardBuild, fixture };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function closeEvent(stream: Readable): Promise<void> {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => stream.once("close", resolve));
}

describe("authenticated host dashboard manifest API", () => {
  it("returns the exact canonical manifest only to a current full-admin principal", async () => {
    const harness = await makeHarness();
    const response = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "GET",
      url: "/api/remote-access/dashboard-manifest"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.payload).toBe(serializeDashboardManifest(harness.fixture.manifest));

    const stale = await makeHarness({ authorized: false });
    const rejected = await dispatchInternal(stale.app, remotePrincipal(), undefined, {
      method: "GET",
      url: "/api/remote-access/dashboard-manifest"
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ error: "RemotePrincipalUnauthorized" });

    const unavailable = await makeHarness({ exposeBuild: false });
    const missing = await dispatchInternal(unavailable.app, remotePrincipal(), undefined, {
      method: "GET",
      url: "/api/remote-access/dashboard-manifest"
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ error: "RemoteDashboardUnavailable" });
  });

  it("serves only declared current-build assets with fixed MIME, caching, length, and ETag", async () => {
    const harness = await makeHarness();
    for (const asset of harness.fixture.manifest.assets) {
      const response = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
        method: "GET",
        url: `/api/remote-access/dashboard-assets/${harness.fixture.manifest.buildId}/${asset.path}`
      });
      expect(response.statusCode, asset.path).toBe(200);
      expect(response.headers["content-type"], asset.path).toBe(asset.contentType);
      expect(response.headers["content-length"], asset.path).toBe(asset.byteSize);
      expect(response.headers["x-content-type-options"], asset.path).toBe("nosniff");
      expect(response.rawPayload, asset.path).toEqual(await readFile(path.join(
        harness.fixture.bundleDirectory,
        ...asset.path.split("/")
      )));
      if (asset.path === "index.html") {
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.etag).toBeUndefined();
      } else {
        expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(response.headers.etag).toBe(`"${asset.sha256}"`);
      }
    }

    const script = harness.fixture.manifest.assets.find((asset) => asset.path === "assets/app.js")!;
    const head = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "HEAD",
      url: `/api/remote-access/dashboard-assets/${harness.fixture.manifest.buildId}/${script.path}`
    });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.byteLength).toBe(0);
    expect(head.headers["content-length"]).toBe(script.byteSize);
  });

  it.each([
    (buildId: string) => `/api/remote-access/dashboard-assets/${"0".repeat(64)}/index.html`,
    (buildId: string) => `/api/remote-access/dashboard-assets/${buildId}/assets/not-declared.js`,
    (buildId: string) => `/api/remote-access/dashboard-assets/${buildId}/..%2Fpackage.json`,
    (buildId: string) => `/api/remote-access/dashboard-assets/${buildId}/%2Fetc%2Fpasswd`,
    (buildId: string) => `/api/remote-access/dashboard-assets/${buildId}/assets%5Capp.js`
  ])("rejects stale, undeclared, absolute, traversal, and non-normal paths", async (target) => {
    const harness = await makeHarness();
    const response = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "GET",
      url: target(harness.fixture.manifest.buildId)
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(harness.fixture.bundleDirectory);
  });

  it("fails closed if a validated asset changes or becomes a symlink", async () => {
    const changed = await makeHarness();
    await writeFile(path.join(changed.fixture.bundleDirectory, "assets", "app.js"), "changed bytes");
    const changedResponse = await dispatchInternal(changed.app, remotePrincipal(), undefined, {
      method: "GET",
      url: `/api/remote-access/dashboard-assets/${changed.fixture.manifest.buildId}/assets/app.js`
    });
    expect(changedResponse.statusCode).toBe(503);
    expect(changedResponse.json()).toMatchObject({ error: "RemoteDashboardChanged" });
    expect(changedResponse.body).not.toContain(changed.fixture.bundleDirectory);

    const linked = await makeHarness();
    const assetPath = path.join(linked.fixture.bundleDirectory, "assets", "app.js");
    await rm(assetPath);
    await symlink(path.join(linked.fixture.bundleDirectory, "index.html"), assetPath);
    const linkedResponse = await dispatchInternal(linked.app, remotePrincipal(), undefined, {
      method: "GET",
      url: `/api/remote-access/dashboard-assets/${linked.fixture.manifest.buildId}/assets/app.js`
    });
    expect(linkedResponse.statusCode).toBe(503);
    expect(linkedResponse.json()).toMatchObject({ error: "RemoteDashboardChanged" });
  });

  it("fails closed if the pinned canonical manifest changes after startup", async () => {
    const harness = await makeHarness();
    const manifestPath = path.join(
      harness.fixture.bundleDirectory,
      "waifus-dashboard-manifest.json"
    );
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")} `);

    const response = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "GET",
      url: "/api/remote-access/dashboard-manifest"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "RemoteDashboardChanged" });
    expect(response.body).not.toContain(harness.fixture.bundleDirectory);

    const assetResponse = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "GET",
      url: `/api/remote-access/dashboard-assets/${harness.fixture.manifest.buildId}/index.html`
    });
    expect(assetResponse.statusCode).toBe(503);
    expect(assetResponse.json()).toMatchObject({ error: "RemoteDashboardChanged" });
  });

  it("streams a multi-megabyte asset before completion and cancels through the helper bridge", async () => {
    const largeBytes = Buffer.alloc(3 * 1024 * 1024, 0xa5);
    const fixture = await dashboardFixture({ "assets/model.wasm": largeBytes });
    const harness = await makeHarness({ fixture });
    const bridge = new RemoteRequestBridge(harness.app);
    bridges.push(bridge);
    const helper = new FakeTsConnect(bridge, "dashboard-stream-helper");
    const target = `/api/remote-access/dashboard-assets/${fixture.manifest.buildId}/assets/model.wasm`;

    const complete = await helper.request(bridgeStart(target));
    expect(complete.statusCode).toBe(200);
    expect(complete.body.readableLength).toBeLessThan(largeBytes.byteLength);
    if (complete.body.readableLength === 0) await once(complete.body, "readable");
    const first = complete.body.read() as Buffer;
    expect(first.byteLength).toBeGreaterThan(0);
    expect(first.byteLength).toBeLessThan(largeBytes.byteLength);
    const remainder = await readAll(complete.body);
    expect(Buffer.concat([first, remainder])).toEqual(largeBytes);

    const controller = new AbortController();
    const cancelled = await helper.request(bridgeStart(target), { signal: controller.signal });
    cancelled.body.on("error", () => {});
    if (cancelled.body.readableLength === 0) await once(cancelled.body, "readable");
    expect((cancelled.body.read() as Buffer).byteLength).toBeGreaterThan(0);
    const closed = closeEvent(cancelled.body);
    const startedAt = performance.now();
    controller.abort(new Error("dashboard download cancelled"));
    await closed;
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(bridge.activeStreamCount("dashboard-client")).toBe(0);
  });
});
