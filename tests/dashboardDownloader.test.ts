import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeDashboardManifest
} from "../src/remote/dashboardManifest.js";
import { DashboardCache } from "../src/remote/dashboardCache.js";
import {
  DashboardDownloader,
  type DashboardRemoteClient
} from "../src/remote/dashboardDownloader.js";
import type { HelperRemoteRequest } from "../src/remote/helperTypes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

const defaultCapabilities = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const;

function hostKey() {
  return {
    hostId: Buffer.alloc(32, 0x51).toString("base64url") as never,
    trustEpoch: "7" as never
  };
}

function browserContextFactory() {
  let nonce = 0;
  return (method: HelperRemoteRequest["method"], canonicalTarget: string) => ({
    version: 1 as const,
    gatewayLaunchId: Buffer.alloc(32, 0x41).toString("base64url") as never,
    browserSessionId: Buffer.alloc(32, 0x42).toString("base64url") as never,
    requestNonce: Buffer.alloc(16, ++nonce).toString("base64url") as never,
    method,
    canonicalTarget,
    csrfValidated: true as const
  });
}

async function manifestFixture(options: {
  minimumHelperVersion?: string;
  minimumRemoteGatewayVersion?: string;
  requiredCapabilities?: readonly string[];
} = {}) {
  const root = await makeTempRoot("waifus-dashboard-downloader-fixture-");
  roots.push(root);
  const source = path.join(root, "host-dashboard");
  await mkdir(source, { recursive: true });
  const index = Buffer.from("<!doctype html><title>Waifus</title>");
  await writeFile(path.join(source, "index.html"), index);
  const manifest = await writeDashboardManifest({
    bundleDirectory: source,
    discordWaifusVersion: "1.5.250",
    minimumHelperVersion: options.minimumHelperVersion ?? "0.1.0",
    minimumRemoteGatewayVersion: options.minimumRemoteGatewayVersion ?? "1.5.200",
    requiredCapabilities: options.requiredCapabilities ?? defaultCapabilities
  });
  return {
    root,
    index,
    manifest,
    manifestBytes: await readFile(path.join(source, "waifus-dashboard-manifest.json"))
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("verified remote dashboard downloader", () => {
  it("cancels a rejected manifest response exactly once and downloads no assets", async () => {
    const root = await makeTempRoot("waifus-dashboard-downloader-rejected-");
    roots.push(root);
    const cancel = vi.fn();
    const request = vi.fn(async () => ({
      statusCode: 503,
      statusMessage: "Service Unavailable",
      headers: [] as const,
      body: Readable.from([Buffer.from("unavailable")]),
      cancel
    }));
    const downloader = new DashboardDownloader({
      cache: new DashboardCache({ dataRoot: root }),
      client: {
        hello: { componentVersion: "0.1.0" },
        negotiatedProtocol: { major: 1, minor: 0 },
        negotiatedCapabilities: [],
        request
      },
      remoteGatewayVersion: "1.5.203",
      createBrowserContext: (method, canonicalTarget) => ({
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x41).toString("base64url") as never,
        browserSessionId: Buffer.alloc(32, 0x42).toString("base64url") as never,
        requestNonce: Buffer.alloc(16, 0x43).toString("base64url") as never,
        method,
        canonicalTarget,
        csrfValidated: true
      })
    });

    await expect(downloader.download({
      hostId: Buffer.alloc(32, 0x51).toString("base64url") as never,
      trustEpoch: "7" as never
    })).rejects.toMatchObject({
      code: "dashboard_manifest_response_invalid"
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels an overlong manifest body exactly once", async () => {
    const root = await makeTempRoot("waifus-dashboard-downloader-overlong-");
    roots.push(root);
    const cancel = vi.fn();
    const request = vi.fn(async () => ({
      statusCode: 200,
      statusMessage: "OK",
      headers: [
        ["content-type", "application/json; charset=utf-8"],
        ["content-length", "1"]
      ] as const,
      body: Readable.from([Buffer.from("too-long")]),
      cancel
    }));
    const downloader = new DashboardDownloader({
      cache: new DashboardCache({ dataRoot: root }),
      client: {
        hello: { componentVersion: "0.1.0" },
        negotiatedProtocol: { major: 1, minor: 0 },
        negotiatedCapabilities: [],
        request
      },
      remoteGatewayVersion: "1.5.203",
      createBrowserContext: (method, canonicalTarget) => ({
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x41).toString("base64url") as never,
        browserSessionId: Buffer.alloc(32, 0x42).toString("base64url") as never,
        requestNonce: Buffer.alloc(16, 0x44).toString("base64url") as never,
        method,
        canonicalTarget,
        csrfValidated: true
      })
    });

    await expect(downloader.download({
      hostId: Buffer.alloc(32, 0x51).toString("base64url") as never,
      trustEpoch: "7" as never
    })).rejects.toMatchObject({
      code: "dashboard_manifest_response_invalid"
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses dashboards that require newer components or unavailable capabilities", async () => {
    const cases = [
      {
        fixture: { minimumHelperVersion: "0.2.0" },
        helperVersion: "0.1.0",
        gatewayVersion: "1.5.203",
        capabilities: [...defaultCapabilities]
      },
      {
        fixture: { minimumRemoteGatewayVersion: "1.6.0" },
        helperVersion: "0.1.0",
        gatewayVersion: "1.5.203",
        capabilities: [...defaultCapabilities]
      },
      {
        fixture: { requiredCapabilities: ["waifus.future.v1"] },
        helperVersion: "0.1.0",
        gatewayVersion: "1.5.203",
        capabilities: []
      }
    ] as const;

    for (const testCase of cases) {
      const fixture = await manifestFixture(testCase.fixture);
      const request = vi.fn(async (input: HelperRemoteRequest) => {
        if (input.canonicalTarget !== "/api/remote-access/dashboard-manifest") {
          throw new Error("incompatible dashboard must not request assets");
        }
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [
            ["content-type", "application/json; charset=utf-8"],
            ["content-length", fixture.manifestBytes.byteLength.toString(10)]
          ] as const,
          body: Readable.from([fixture.manifestBytes]),
          cancel: vi.fn()
        };
      });
      const downloader = new DashboardDownloader({
        cache: new DashboardCache({ dataRoot: fixture.root }),
        client: {
          hello: { componentVersion: testCase.helperVersion },
          negotiatedProtocol: { major: 1, minor: 0 },
          negotiatedCapabilities: [...testCase.capabilities],
          request
        },
        remoteGatewayVersion: testCase.gatewayVersion,
        createBrowserContext: browserContextFactory()
      });

      await expect(downloader.download(hostKey())).rejects.toMatchObject({
        code: "dashboard_component_incompatible"
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects ambiguous manifest metadata and exact-length mismatches before cache install", async () => {
    const fixture = await manifestFixture();
    const exactLength = fixture.manifestBytes.byteLength.toString(10);
    const cases = [
      {
        headers: [
          ["content-type", "application/json"],
          ["content-length", exactLength]
        ] as const,
        expectedCancels: 1
      },
      {
        headers: [
          ["content-type", "application/json; charset=utf-8"],
          ["Content-Type", "application/json; charset=utf-8"],
          ["content-length", exactLength]
        ] as const,
        expectedCancels: 1
      },
      {
        headers: [
          ["content-type", "application/json; charset=utf-8"],
          ["content-length", `0${exactLength}`]
        ] as const,
        expectedCancels: 1
      },
      {
        headers: [
          ["content-type", "application/json; charset=utf-8"],
          ["content-length", (fixture.manifestBytes.byteLength + 1).toString(10)]
        ] as const,
        expectedCancels: 0
      }
    ];

    for (const testCase of cases) {
      const cancel = vi.fn();
      const request = vi.fn(async () => ({
        statusCode: 200,
        statusMessage: "OK",
        headers: testCase.headers,
        body: Readable.from([fixture.manifestBytes]),
        cancel
      }));
      const downloader = new DashboardDownloader({
        cache: new DashboardCache({ dataRoot: fixture.root }),
        client: {
          hello: { componentVersion: "0.1.0" },
          negotiatedProtocol: { major: 1, minor: 0 },
          negotiatedCapabilities: [...defaultCapabilities],
          request
        },
        remoteGatewayVersion: "1.5.203",
        createBrowserContext: browserContextFactory()
      });

      await expect(downloader.download(hostKey())).rejects.toMatchObject({
        code: "dashboard_manifest_response_invalid"
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(testCase.expectedCancels);
    }
  });

  it("never promotes assets with rejected HTTP metadata or an invalid digest", async () => {
    const cases = [
      {
        kind: "status" as const,
        expectedCode: "dashboard_download_failed",
        expectedCancels: 1
      },
      {
        kind: "content-type" as const,
        expectedCode: "dashboard_download_failed",
        expectedCancels: 1
      },
      {
        kind: "content-length" as const,
        expectedCode: "dashboard_download_failed",
        expectedCancels: 1
      },
      {
        kind: "digest" as const,
        expectedCode: "dashboard_asset_hash_mismatch",
        expectedCancels: 0
      }
    ];

    for (const testCase of cases) {
      const fixture = await manifestFixture();
      const cache = new DashboardCache({ dataRoot: fixture.root });
      const assetCancel = vi.fn();
      let requestNumber = 0;
      const request = vi.fn(async () => {
        requestNumber += 1;
        if (requestNumber === 1) {
          return {
            statusCode: 200,
            statusMessage: "OK",
            headers: [
              ["content-type", "application/json; charset=utf-8"],
              ["content-length", fixture.manifestBytes.byteLength.toString(10)]
            ] as const,
            body: Readable.from([fixture.manifestBytes]),
            cancel: vi.fn()
          };
        }
        const responseBytes = testCase.kind === "digest"
          ? Buffer.alloc(fixture.index.byteLength, 0x78)
          : fixture.index;
        return {
          statusCode: testCase.kind === "status" ? 404 : 200,
          statusMessage: testCase.kind === "status" ? "Not Found" : "OK",
          headers: [
            [
              "content-type",
              testCase.kind === "content-type"
                ? "application/octet-stream"
                : "text/html; charset=utf-8"
            ],
            [
              "content-length",
              testCase.kind === "content-length"
                ? (fixture.index.byteLength + 1).toString(10)
                : fixture.index.byteLength.toString(10)
            ]
          ] as const,
          body: Readable.from([responseBytes]),
          cancel: assetCancel
        };
      });
      const downloader = new DashboardDownloader({
        cache,
        client: {
          hello: { componentVersion: "0.1.0" },
          negotiatedProtocol: { major: 1, minor: 0 },
          negotiatedCapabilities: [...defaultCapabilities],
          request
        },
        remoteGatewayVersion: "1.5.203",
        createBrowserContext: browserContextFactory()
      });

      await expect(downloader.download(hostKey())).rejects.toMatchObject({
        code: testCase.expectedCode
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(assetCancel).toHaveBeenCalledTimes(testCase.expectedCancels);
      await expect(cache.openVerified(hostKey(), fixture.manifest)).resolves.toBeNull();
    }
  });

  it("downloads one authenticated build and reuses its verified cache on the next manifest check", async () => {
    const root = await makeTempRoot("waifus-dashboard-downloader-");
    roots.push(root);
    const source = path.join(root, "host-dashboard");
    await mkdir(path.join(source, "assets"), { recursive: true });
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("<!doctype html><script src=/assets/app.js></script>")],
      ["assets/app.js", Buffer.from("globalThis.waifusRemote = true;")],
      ["assets/app.css", Buffer.from("body{color:#fff}")]
    ]);
    for (const [relativePath, bytes] of files) {
      await writeFile(path.join(source, ...relativePath.split("/")), bytes);
    }
    const manifest = await writeDashboardManifest({
      bundleDirectory: source,
      discordWaifusVersion: "1.5.250",
      minimumHelperVersion: "0.1.0",
      minimumRemoteGatewayVersion: "1.5.200"
    });
    const manifestBytes = await readFile(path.join(source, "waifus-dashboard-manifest.json"));
    let requestNumber = 0;
    const requests: HelperRemoteRequest[] = [];
    const request = vi.fn(async (input: HelperRemoteRequest) => {
      requests.push(input);
      requestNumber += 1;
      const manifestTarget = "/api/remote-access/dashboard-manifest";
      const assetPrefix = `/api/remote-access/dashboard-assets/${manifest.buildId}/`;
      const relativePath = input.canonicalTarget.startsWith(assetPrefix)
        ? input.canonicalTarget.slice(assetPrefix.length)
        : undefined;
      const bytes = input.canonicalTarget === manifestTarget
        ? manifestBytes
        : relativePath === undefined
          ? undefined
          : files.get(relativePath);
      if (!bytes) throw new Error(`unexpected downloader target ${input.canonicalTarget}`);
      const asset = relativePath === undefined
        ? undefined
        : manifest.assets.find((candidate) => candidate.path === relativePath);
      return {
        statusCode: 200,
        statusMessage: "OK",
        headers: [
          ["content-type", asset?.contentType ?? "application/json; charset=utf-8"],
          ["content-length", bytes.byteLength.toString(10)]
        ] as const,
        body: Readable.from([bytes]),
        cancel: vi.fn()
      };
    });
    const client: DashboardRemoteClient = {
      hello: { componentVersion: "0.1.0" },
      negotiatedProtocol: { major: 1, minor: 0 },
      negotiatedCapabilities: [...manifest.requiredCapabilities],
      request
    };
    const downloader = new DashboardDownloader({
      cache: new DashboardCache({ dataRoot: root }),
      client,
      remoteGatewayVersion: "1.5.203",
      createBrowserContext: (method, canonicalTarget) => ({
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x41).toString("base64url") as never,
        browserSessionId: Buffer.alloc(32, 0x42).toString("base64url") as never,
        requestNonce: Buffer.alloc(16, requestNumber + 1).toString("base64url") as never,
        method,
        canonicalTarget,
        csrfValidated: true
      })
    });
    const hostKey = {
      hostId: Buffer.alloc(32, 0x51).toString("base64url") as never,
      trustEpoch: "7" as never
    };

    const installed = await downloader.download(hostKey);
    for (const [relativePath, expected] of files) {
      await expect(readFile(path.join(installed.directory, ...relativePath.split("/"))))
        .resolves.toEqual(expected);
    }
    const reused = await downloader.download(hostKey);
    expect(reused.directory).toBe(installed.directory);

    const targets = requests.map((value) => value.canonicalTarget);
    expect(targets).toEqual([
      "/api/remote-access/dashboard-manifest",
      ...manifest.assets.map((asset) => (
        `/api/remote-access/dashboard-assets/${manifest.buildId}/${asset.path}`
      )),
      "/api/remote-access/dashboard-manifest"
    ]);
    expect(request).toHaveBeenCalledTimes(manifest.assets.length + 2);
    for (const remoteRequest of requests) {
      expect(remoteRequest).toMatchObject({
        method: "GET",
        headers: [["accept", remoteRequest.canonicalTarget.endsWith("dashboard-manifest")
          ? "application/json"
          : "*/*"]]
      });
      expect(remoteRequest.browserContext).toMatchObject({
        method: "GET",
        canonicalTarget: remoteRequest.canonicalTarget,
        csrfValidated: true
      });
    }
  });
});
