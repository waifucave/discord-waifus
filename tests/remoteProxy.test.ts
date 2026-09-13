import { request as httpRequest } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperRemoteRequest } from "../src/remote/helperTypes.js";
import type { DashboardRemoteClient } from "../src/remote/dashboardDownloader.js";
import {
  sanitizeGatewayRequestHeaders,
  sanitizeGatewayResponseHeaders
} from "../src/remote/gateway/headerPolicy.js";
import { RemoteSelectedHostProxy } from "../src/remote/gateway/proxy.js";
import {
  startRemoteGateway,
  type RunningRemoteGateway
} from "../src/remote/gateway/server.js";

const gateways: RunningRemoteGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

function deterministicRandom(start = 1): (size: number) => Uint8Array {
  let value = start;
  return (size) => Buffer.alloc(size, value++);
}

type RawResponse = {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
};

function rawRequest(options: {
  readonly gateway: RunningRemoteGateway;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: options.gateway.port,
      path: options.path,
      method: options.method ?? "GET",
      headers: {
        host: `${options.gateway.hostname}:${options.gateway.port}`,
        ...(options.body ? { "content-length": String(options.body.byteLength) } : {}),
        ...options.headers
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
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function bootstrap(gateway: RunningRemoteGateway): Promise<string> {
  const response = await rawRequest({
    gateway,
    path: new URL(gateway.bootstrapUrl).pathname,
    headers: { "sec-fetch-site": "none" }
  });
  expect(response.statusCode).toBe(303);
  return String(response.headers["set-cookie"]).split(";", 1)[0];
}

function fakeClient(
  request: DashboardRemoteClient["request"]
): DashboardRemoteClient {
  return {
    hello: { componentVersion: "0.1.0" },
    negotiatedProtocol: { major: 1, minor: 0 },
    negotiatedCapabilities: [
      "waifus.browser-context.v1",
      "waifus.http.v1",
      "waifus.stream.cancel.v1"
    ],
    request
  };
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

async function proxyGateway(
  request: DashboardRemoteClient["request"],
  options: { readonly upstreamOrigins?: ReadonlySet<string> } = {}
): Promise<RunningRemoteGateway> {
  let proxy: RemoteSelectedHostProxy | undefined;
  const gateway = await startRemoteGateway({
    hostname: "waifus-proxy.localhost",
    port: 0,
    surface: "dashboard",
    randomBytes: deterministicRandom(),
    handleAuthenticatedRequest: (...args) => {
      if (!proxy) throw new Error("proxy was not initialized");
      return proxy.handle(...args);
    }
  });
  proxy = new RemoteSelectedHostProxy({
    client: fakeClient(request),
    selectedHostId: bytes32(0x51),
    connectionShellOrigin: `http://waifus-${"a".repeat(52)}.localhost:49231`,
    localOrigin: gateway.origin,
    connectionState: () => "direct",
    ...options
  });
  gateways.push(gateway);
  return gateway;
}

describe("selected-host remote proxy", () => {
  it("intercepts the remote client context locally and delivers the session CSRF token", async () => {
    const request = vi.fn<DashboardRemoteClient["request"]>();
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);

    const response = await rawRequest({
      gateway,
      path: "/api/client-context",
      headers: {
        cookie,
        origin: gateway.origin,
        "sec-fetch-site": "same-origin"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(String(response.headers["x-waifus-csrf"]), "base64url")).toHaveLength(32);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({
      mode: "remote",
      selectedHostId: bytes32(0x51),
      connectionState: "direct",
      connectionShellOrigin: `http://waifus-${"a".repeat(52)}.localhost:49231`
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards the exact method, target, headers, and raw JSON bytes only to the selected client", async () => {
    let capturedBody = Buffer.alloc(0);
    const request = vi.fn(async (input: HelperRemoteRequest) => {
      if (input.body) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
        capturedBody = Buffer.concat(chunks);
      }
      return {
        statusCode: 202,
        statusMessage: "Accepted",
        headers: [
          ["content-type", "application/json; charset=utf-8"],
          ["x-host-value", "kept"],
          ["set-cookie", "host_session=forbidden"],
          ["access-control-allow-origin", "*"],
          ["content-security-policy", "default-src *"],
          ["cache-control", "public"],
          ["service-worker-allowed", "/"],
          ["alt-svc", "h2=\"evil.example:443\""],
          ["clear-site-data", "\"cookies\""],
          ["refresh", "0;url=https://evil.example/"]
        ] as const,
        body: Readable.from([Buffer.from("{\"accepted\":true}")]),
        cancel: vi.fn()
      };
    });
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);
    const context = await rawRequest({
      gateway,
      path: "/api/client-context",
      headers: { cookie, origin: gateway.origin, "sec-fetch-site": "same-origin" }
    });
    const csrf = String(context.headers["x-waifus-csrf"]);
    const body = Buffer.from("{  \"name\" : \"Miyu\", \"enabled\":true }", "utf8");

    const response = await rawRequest({
      gateway,
      path: "/api/config?kind=one&kind=two",
      method: "PATCH",
      body,
      headers: {
        cookie,
        origin: gateway.origin,
        "sec-fetch-site": "same-origin",
        "x-waifus-csrf": csrf,
        "content-type": "application/json",
        "idempotency-key": bytes32(0x71),
        "x-user-value": "kept",
        "x-forwarded-for": "203.0.113.8"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.body.toString("utf8")).toBe("{\"accepted\":true}");
    expect(response.headers["x-host-value"]).toBe("kept");
    expect(String(response.headers["set-cookie"])).not.toContain("host_session");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["service-worker-allowed"]).toBeUndefined();
    expect(response.headers["alt-svc"]).toBeUndefined();
    expect(response.headers["clear-site-data"]).toBeUndefined();
    expect(response.headers.refresh).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("allow-downloads");
    expect(capturedBody.equals(body)).toBe(true);

    expect(request).toHaveBeenCalledTimes(1);
    const forwarded = request.mock.calls[0][0];
    expect(forwarded.method).toBe("PATCH");
    expect(forwarded.canonicalTarget).toBe("/api/config?kind=one&kind=two");
    expect(forwarded.browserContext).toMatchObject({
      method: "PATCH",
      canonicalTarget: "/api/config?kind=one&kind=two",
      csrfValidated: true
    });
    expect(forwarded.headers).toContainEqual(["idempotency-key", bytes32(0x71)]);
    expect(forwarded.headers).toContainEqual(["x-user-value", "kept"]);
    expect(forwarded.headers.map(([name]) => name)).not.toEqual(expect.arrayContaining([
      "cookie",
      "host",
      "origin",
      "sec-fetch-site",
      "x-forwarded-for",
      "x-waifus-csrf"
    ]));
  });

  it("streams binary responses without buffering and keeps zero-length request bodies absent", async () => {
    const first = Buffer.alloc(128 * 1_024, 0x61);
    const second = Buffer.alloc(96 * 1_024, 0x62);
    const cancel = vi.fn();
    const request = vi.fn(async (input: HelperRemoteRequest) => ({
      statusCode: 206,
      statusMessage: "Partial Content",
      headers: [
        ["content-type", "application/octet-stream"],
        ["content-length", String(first.byteLength + second.byteLength)]
      ] as const,
      body: Readable.from([first, second]),
      cancel
    }));
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);

    const response = await rawRequest({
      gateway,
      path: "/api/files/export",
      method: "POST",
      headers: {
        cookie,
        origin: gateway.origin,
        "sec-fetch-site": "same-origin",
        "x-waifus-csrf": Buffer.alloc(32, 0x04).toString("base64url"),
        "content-length": "0"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(request).not.toHaveBeenCalled();

    const context = await rawRequest({
      gateway,
      path: "/api/client-context",
      headers: { cookie, origin: gateway.origin, "sec-fetch-site": "same-origin" }
    });
    const accepted = await rawRequest({
      gateway,
      path: "/api/files/export",
      method: "POST",
      headers: {
        cookie,
        origin: gateway.origin,
        "sec-fetch-site": "same-origin",
        "x-waifus-csrf": String(context.headers["x-waifus-csrf"]),
        "content-length": "0"
      }
    });
    expect(accepted.statusCode).toBe(206);
    expect(accepted.body.equals(Buffer.concat([first, second]))).toBe(true);
    expect(request.mock.calls[0][0].body).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("fails closed without forwarding non-API routes, forged internal headers, or helper details", async () => {
    const request = vi.fn(async () => {
      throw new Error("secret selected-host transport detail");
    });
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);

    const asset = await rawRequest({ gateway, path: "/assets/unknown.js", headers: { cookie } });
    expect(asset.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();

    const internal = await rawRequest({
      gateway,
      path: "/_waifus_remote/v1/state",
      headers: { cookie }
    });
    expect(internal.statusCode).toBe(404);
    const absolute = await rawRequest({
      gateway,
      path: "http://overlay-peer.invalid/api/status",
      headers: { cookie }
    });
    expect([403, 404]).toContain(absolute.statusCode);
    const connect = await rawRequest({
      gateway,
      path: "overlay-peer.invalid:443",
      method: "CONNECT",
      headers: { cookie }
    }).catch((error: unknown) => error);
    expect(connect instanceof Error || connect.statusCode === 404).toBe(true);
    expect(request).not.toHaveBeenCalled();

    const forged = await rawRequest({
      gateway,
      path: "/api/status",
      headers: { cookie, "x-waifus-principal-id": "forged" }
    });
    expect(forged.statusCode).toBe(403);
    expect(request).not.toHaveBeenCalled();

    const unavailable = await rawRequest({ gateway, path: "/api/status", headers: { cookie } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body.toString("utf8")).toBe("{\"error\":\"DirectUnavailable\"}");
    expect(unavailable.body.toString("utf8")).not.toContain("secret");
  });

  it("preserves SSE framing and cancels the selected helper stream once when the browser leaves", async () => {
    const stream = new PassThrough();
    const cancel = vi.fn(() => stream.destroy());
    const request = vi.fn(async () => ({
      statusCode: 200,
      statusMessage: "OK",
      headers: [
        ["content-type", "text/event-stream"],
        ["cache-control", "host-policy-must-be-removed"]
      ] as const,
      body: stream,
      cancel
    }));
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);
    const firstEvent = new Promise<string>((resolve, reject) => {
      const clientRequest = httpRequest({
        host: "127.0.0.1",
        port: gateway.port,
        path: "/api/events",
        headers: {
          host: `${gateway.hostname}:${gateway.port}`,
          cookie,
          "last-event-id": "7:41"
        }
      }, (response) => {
        response.once("data", (chunk) => {
          resolve(Buffer.from(chunk).toString("utf8"));
          response.destroy();
        });
        response.once("error", () => undefined);
      });
      clientRequest.once("error", reject);
      clientRequest.end();
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    stream.write("id: 7:42\nevent: snapshot\ndata: {\"ok\":true}\n\n");

    await expect(firstEvent).resolves.toBe("id: 7:42\nevent: snapshot\ndata: {\"ok\":true}\n\n");
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0].headers).toContainEqual(["last-event-id", "7:41"]);
  });

  it("aborts an in-flight helper request when a streaming browser upload disconnects", async () => {
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    let reportAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { reportAborted = resolve; });
    const request = vi.fn((input: HelperRemoteRequest) => new Promise<never>((_resolve, reject) => {
      input.body?.resume();
      reportStarted();
      input.signal?.addEventListener("abort", () => {
        reportAborted();
        reject(input.signal?.reason);
      }, { once: true });
    }));
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);
    const context = await rawRequest({
      gateway,
      path: "/api/client-context",
      headers: { cookie, origin: gateway.origin, "sec-fetch-site": "same-origin" }
    });

    const clientFinished = new Promise<void>((resolve) => {
      const clientRequest = httpRequest({
        host: "127.0.0.1",
        port: gateway.port,
        path: "/api/files/import",
        method: "POST",
        headers: {
          host: `${gateway.hostname}:${gateway.port}`,
          cookie,
          origin: gateway.origin,
          "sec-fetch-site": "same-origin",
          "x-waifus-csrf": String(context.headers["x-waifus-csrf"]),
          "content-type": "application/octet-stream",
          "content-length": String(4 * 1_024 * 1_024)
        }
      });
      clientRequest.once("error", () => resolve());
      clientRequest.write(Buffer.alloc(64 * 1_024, 0x41));
      void started.then(() => clientRequest.destroy());
    });

    await started;
    await expect(aborted).resolves.toBeUndefined();
    await clientFinished;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it("cancels a helper response whose headers are invalid and reports only direct unavailability", async () => {
    const cancel = vi.fn();
    const request = vi.fn(async () => ({
      statusCode: 302,
      statusMessage: "Found",
      headers: [
        ["location", "/one"],
        ["location", "/two"]
      ] as const,
      body: new PassThrough(),
      cancel
    }));
    const gateway = await proxyGateway(request);
    const cookie = await bootstrap(gateway);

    const response = await rawRequest({ gateway, path: "/api/status", headers: { cookie } });
    expect(response.statusCode).toBe(503);
    expect(response.body.toString("utf8")).toBe("{\"error\":\"DirectUnavailable\"}");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rewrites only allowlisted same-host redirects and rejects unsafe response metadata", async () => {
    expect(sanitizeGatewayResponseHeaders([
      ["location", "/settings?tab=remote#trusted"],
      ["set-cookie", "host=forbidden"],
      ["x-waifus-internal-secret", "forbidden"]
    ], { localOrigin: "http://waifus-local.localhost:41000" })).toEqual({
      location: "/settings?tab=remote#trusted"
    });
    expect(sanitizeGatewayResponseHeaders([
      ["location", "https://host.overlay.example:8443/activity?view=all"]
    ], {
      localOrigin: "http://waifus-local.localhost:41000",
      upstreamOrigins: new Set(["https://host.overlay.example:8443"])
    })).toEqual({
      location: "http://waifus-local.localhost:41000/activity?view=all"
    });
    expect(sanitizeGatewayResponseHeaders([
      ["location", "https://evil.example/steal"]
    ], { localOrigin: "http://waifus-local.localhost:41000" })).toEqual({});
    expect(() => sanitizeGatewayRequestHeaders({
      "x-waifus-browser-context": "forged"
    })).toThrow(/internal headers/u);
    expect(sanitizeGatewayRequestHeaders({
      connection: "x-remove-me",
      "x-remove-me": "forbidden",
      "x-keep-me": "allowed"
    })).toEqual([["x-keep-me", "allowed"]]);
    expect(sanitizeGatewayResponseHeaders([
      ["connection", "x-remove-me"],
      ["x-remove-me", "forbidden"],
      ["x-keep-me", "allowed"]
    ], { localOrigin: "http://waifus-local.localhost:41000" })).toEqual({
      "x-keep-me": "allowed"
    });
    expect(() => sanitizeGatewayResponseHeaders([
      ["location", "/first"],
      ["location", "/second"]
    ], { localOrigin: "http://waifus-local.localhost:41000" })).toThrow(/repeats Location/u);
  });
});
