import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDashboardManifest } from "../src/remote/dashboardManifest.js";
import { DashboardCache } from "../src/remote/dashboardCache.js";
import type { DashboardRemoteClient } from "../src/remote/dashboardDownloader.js";
import { RemoteSelectedHostGateway } from "../src/remote/gateway/selectedHost.js";
import {
  startRemoteGateway,
  type RunningRemoteGateway
} from "../src/remote/gateway/server.js";
import type { HelperRemoteRequest } from "../src/remote/helperTypes.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const gateways: RunningRemoteGateway[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const capabilities = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const;
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

function deterministicRandom(start = 1): (size: number) => Uint8Array {
  let value = start;
  return (size) => Buffer.alloc(size, value++);
}

type DashboardFixture = Awaited<ReturnType<typeof dashboardFixture>>;

async function dashboardFixture(marker: string) {
  const root = await makeTempRoot(`waifus-remote-dashboard-${marker}-`);
  roots.push(root);
  const bundleDirectory = path.join(root, "bundle");
  await mkdir(path.join(bundleDirectory, "assets"), { recursive: true });
  await writeFile(
    path.join(bundleDirectory, "index.html"),
    `<!doctype html><script type="module" src="/assets/app.js"></script><main>${marker}</main>`
  );
  await writeFile(path.join(bundleDirectory, "assets", "app.js"), `globalThis.build=${JSON.stringify(marker)};`);
  await writeFile(path.join(bundleDirectory, "assets", "app.js.map"), JSON.stringify({ version: 3, marker }));
  const manifest = await writeDashboardManifest({
    bundleDirectory,
    discordWaifusVersion: "1.5.250",
    minimumHelperVersion: "0.1.0",
    minimumRemoteGatewayVersion: "1.5.203",
    requiredCapabilities: capabilities
  });
  return {
    root,
    bundleDirectory,
    manifest,
    manifestBytes: await readFile(path.join(bundleDirectory, "waifus-dashboard-manifest.json"))
  };
}

function fixtureClient(
  current: () => DashboardFixture,
  requests: HelperRemoteRequest[],
  corruptPath?: () => string | undefined
): DashboardRemoteClient {
  return {
    hello: { componentVersion: "0.1.0" },
    negotiatedProtocol: { major: 1, minor: 0 },
    negotiatedCapabilities: [...capabilities],
    request: vi.fn(async (input: HelperRemoteRequest) => {
      requests.push(input);
      const fixture = current();
      if (input.canonicalTarget === "/api/remote-access/dashboard-manifest") {
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [
            ["content-type", "application/json; charset=utf-8"],
            ["content-length", String(fixture.manifestBytes.byteLength)]
          ],
          body: Readable.from([fixture.manifestBytes]),
          cancel: vi.fn()
        };
      }
      const prefix = `/api/remote-access/dashboard-assets/${fixture.manifest.buildId}/`;
      if (!input.canonicalTarget.startsWith(prefix)) throw new Error("unexpected selected-host target");
      const assetPath = input.canonicalTarget.slice(prefix.length);
      const asset = fixture.manifest.assets.find((candidate) => candidate.path === assetPath);
      if (!asset) throw new Error("undeclared selected-host asset");
      const source = await readFile(path.join(fixture.bundleDirectory, ...asset.path.split("/")));
      const body = corruptPath?.() === asset.path ? Buffer.from(`${source.toString("utf8")}!`) : source;
      return {
        statusCode: 200,
        statusMessage: "OK",
        headers: [
          ["content-type", asset.contentType],
          ["content-length", asset.byteSize]
        ],
        body: Readable.from([body]),
        cancel: vi.fn()
      };
    })
  };
}

type RawResponse = {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
};

function rawRequest(
  gateway: RunningRemoteGateway,
  requestPath: string,
  cookie?: string,
  method = "GET",
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: gateway.port,
      path: requestPath,
      method,
      headers: {
        host: `${gateway.hostname}:${gateway.port}`,
        ...(cookie ? { cookie } : {}),
        ...headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers as RawResponse["headers"],
        body: Buffer.concat(chunks)
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function bootstrap(gateway: RunningRemoteGateway): Promise<string> {
  const response = await rawRequest(gateway, new URL(gateway.bootstrapUrl).pathname);
  expect(response.statusCode).toBe(303);
  return String(response.headers["set-cookie"]).split(";", 1)[0];
}

async function selectedGateway(options: {
  readonly dataRoot: string;
  readonly client: DashboardRemoteClient;
  readonly incomingContexts?: unknown[];
}): Promise<RunningRemoteGateway> {
  let selected: RemoteSelectedHostGateway | undefined;
  const gateway = await startRemoteGateway({
    hostname: "waifus-dashboard.localhost",
    port: 0,
    surface: "dashboard",
    randomBytes: deterministicRandom(1),
    handleAuthenticatedRequest: (request, reply, context, security) => {
      options.incomingContexts?.push(context);
      if (!selected) throw new Error("selected host was not initialized");
      return selected.handle(request, reply, context, security);
    }
  });
  selected = new RemoteSelectedHostGateway({
    cache: new DashboardCache({ dataRoot: options.dataRoot }),
    client: options.client,
    hostKey: { hostId: bytes32(0x51) as never, trustEpoch: "7" as never },
    remoteGatewayVersion: "1.5.203",
    connectionShellOrigin: `http://waifus-${"a".repeat(52)}.localhost:49231`,
    localOrigin: gateway.origin,
    connectionState: () => "direct",
    randomBytes: deterministicRandom(0x61)
  });
  gateways.push(gateway);
  return gateway;
}

describe("verified selected-host dashboard serving", () => {
  it("installs the complete host build before serving HTML and owns all browser cache policy", async () => {
    const fixture = await dashboardFixture("first");
    const requests: HelperRemoteRequest[] = [];
    const incomingContexts: unknown[] = [];
    const gateway = await selectedGateway({
      dataRoot: fixture.root,
      client: fixtureClient(() => fixture, requests),
      incomingContexts
    });
    const cookie = await bootstrap(gateway);

    const index = await rawRequest(gateway, "/", cookie);
    expect(index.statusCode).toBe(200);
    expect(index.body.toString("utf8")).toContain("<main>first</main>");
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["cache-control"]).toBe("no-store");
    expect(index.headers.etag).toBeUndefined();
    expect(index.headers["content-security-policy"]).toContain("sandbox allow-scripts");

    expect(requests.map((request) => request.canonicalTarget)).toEqual([
      "/api/remote-access/dashboard-manifest",
      ...fixture.manifest.assets.map(
        (asset) => `/api/remote-access/dashboard-assets/${fixture.manifest.buildId}/${asset.path}`
      )
    ]);
    expect(new Set(requests.map((request) => request.browserContext.requestNonce)).size)
      .toBe(requests.length);
    const incoming = incomingContexts[0] as { gatewayLaunchId: string; browserSessionId: string };
    expect(requests.every((request) => (
      request.browserContext.gatewayLaunchId === incoming.gatewayLaunchId
      && request.browserContext.browserSessionId === incoming.browserSessionId
      && request.browserContext.method === "GET"
      && request.browserContext.canonicalTarget === request.canonicalTarget
    ))).toBe(true);

    const scriptAsset = fixture.manifest.assets.find((asset) => asset.path === "assets/app.js")!;
    const script = await rawRequest(gateway, "/assets/app.js?build=ignored", cookie);
    expect(script.statusCode).toBe(200);
    expect(script.body.toString("utf8")).toContain("first");
    expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(script.headers.etag).toBe(`"${scriptAsset.sha256}"`);
    expect(requests).toHaveLength(1 + fixture.manifest.assets.length);

    const sourceMap = await rawRequest(gateway, "/assets/app.js.map", cookie);
    expect(sourceMap.statusCode).toBe(200);
    expect(JSON.parse(sourceMap.body.toString("utf8"))).toMatchObject({ marker: "first" });
    const head = await rawRequest(gateway, "/assets/app.js", cookie, "HEAD");
    expect(head.statusCode).toBe(200);
    expect(head.body).toHaveLength(0);
    expect(head.headers["content-length"]).toBe(scriptAsset.byteSize);

    const spaNavigation = await rawRequest(gateway, "/settings/remote-access", cookie, "GET", {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin"
    });
    expect(spaNavigation.statusCode).toBe(200);
    expect(spaNavigation.body.toString("utf8")).toContain("<main>first</main>");
    expect(spaNavigation.headers["cache-control"]).toBe("no-store");

    const unknown = await rawRequest(gateway, "/assets/not-declared.js", cookie);
    expect(unknown.statusCode).toBe(404);
    const unknownNavigation = await rawRequest(
      gateway,
      "/assets/not-declared.js",
      cookie,
      "GET",
      { accept: "text/html" }
    );
    expect(unknownNavigation.statusCode).toBe(404);
    const traversal = await rawRequest(gateway, "/assets/../index.html", cookie);
    expect([403, 404]).toContain(traversal.statusCode);
    expect(requests).toHaveLength(1 + fixture.manifest.assets.length);
  });

  it("never exposes a partial build and retries cleanly after a failed full install", async () => {
    const fixture = await dashboardFixture("retry");
    const requests: HelperRemoteRequest[] = [];
    let corrupt: string | undefined = "assets/app.js.map";
    const gateway = await selectedGateway({
      dataRoot: fixture.root,
      client: fixtureClient(() => fixture, requests, () => corrupt)
    });
    const cookie = await bootstrap(gateway);

    const rejected = await rawRequest(gateway, "/", cookie);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.body.toString("utf8")).not.toContain("retry");
    const cacheRoot = remoteStatePaths(fixture.root).dashboardCacheRoot;
    expect((await readdir(cacheRoot)).some((entry) => entry.startsWith(".staging-"))).toBe(false);

    corrupt = undefined;
    const recovered = await rawRequest(gateway, "/", cookie);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body.toString("utf8")).toContain("<main>retry</main>");
  });

  it("pins one verified build for a gateway lifetime and changes builds only on a new gateway", async () => {
    const first = await dashboardFixture("old");
    const second = await dashboardFixture("new");
    let current = first;
    const requests: HelperRemoteRequest[] = [];
    const client = fixtureClient(() => current, requests);
    const oldGateway = await selectedGateway({ dataRoot: first.root, client });
    const oldCookie = await bootstrap(oldGateway);
    expect((await rawRequest(oldGateway, "/", oldCookie)).body.toString("utf8")).toContain("old");

    current = second;
    expect((await rawRequest(oldGateway, "/assets/app.js", oldCookie)).body.toString("utf8"))
      .toContain("old");

    const newGateway = await selectedGateway({ dataRoot: first.root, client });
    const newCookie = await bootstrap(newGateway);
    expect((await rawRequest(newGateway, "/", newCookie)).body.toString("utf8")).toContain("new");
  });

  it("proxies API requests without downloading or exposing the dashboard manifest first", async () => {
    const fixture = await dashboardFixture("api");
    const requests: HelperRemoteRequest[] = [];
    const client = fixtureClient(() => fixture, requests);
    client.request = vi.fn(async (input: HelperRemoteRequest) => {
      requests.push(input);
      return {
        statusCode: 200,
        statusMessage: "OK",
        headers: [["content-type", "application/json; charset=utf-8"]],
        body: Readable.from([Buffer.from("{\"ok\":true}")]),
        cancel: vi.fn()
      };
    });
    const gateway = await selectedGateway({ dataRoot: fixture.root, client });
    const cookie = await bootstrap(gateway);

    const response = await rawRequest(gateway, "/api/status?detail=1", cookie);
    expect(response.statusCode).toBe(200);
    expect(response.body.toString("utf8")).toBe("{\"ok\":true}");
    expect(requests.map((request) => request.canonicalTarget)).toEqual(["/api/status?detail=1"]);
  });
});
