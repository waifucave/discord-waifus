import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserSecurity } from "../src/api/browserSecurity.js";
import { getInternalDispatchContext } from "../src/api/internalDispatch.js";
import { installRoutePolicy, type RoutePolicyDefinition } from "../src/api/routePolicy.js";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import {
  REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE,
  RemoteRequestBridge
} from "../src/backend/remoteAccess/requestBridge.js";
import type { RequestPrincipalWire } from "../src/shared/schemas/remoteProtocol.js";
import { WipcParentAuthSession } from "../src/shared/wipcAuthSession.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
// This fixture intentionally models the authenticated helper boundary at a high level. The WIPC
// codec and proof vectors have their own byte-exact contract suites.
// @ts-expect-error JavaScript fixture used by the bridge feasibility spike.
import { FakeTsConnect } from "./fixtures/fakeTsConnect.mjs";

const MIB = 1_024 * 1_024;
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

const manifest: readonly RoutePolicyDefinition[] = [
  { method: "GET", path: "/inspect", remotePolicy: "full_admin" },
  {
    method: "POST",
    path: "/upload",
    remotePolicy: "full_admin",
    retryClass: "non_replayable",
    auditAction: "test.upload"
  },
  { method: "GET", path: "/download", remotePolicy: "full_admin" },
  { method: "GET", path: "/events", remotePolicy: "full_admin" },
  { method: "GET", path: "/cancel", remotePolicy: "full_admin" },
  {
    method: "POST",
    path: "/api/llm/v1/chat",
    remotePolicy: "full_admin",
    retryClass: "non_replayable",
    auditAction: "test.llm.chat"
  }
];

const apps: FastifyInstance[] = [];
const bridges: RemoteRequestBridge[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function principal(deviceId: string, trustEpoch = "7"): RequestPrincipalWire {
  return {
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: bytes16(0x21),
    transportSessionId: bytes16(0x22),
    trustEpoch: trustEpoch as RequestPrincipalWire["trustEpoch"]
  };
}

function start(
  deviceId: string,
  method: "GET" | "POST",
  canonicalTarget: string,
  headers: Array<readonly [string, string]> = []
) {
  return {
    version: 1 as const,
    method,
    canonicalTarget,
    headers,
    principal: principal(deviceId)
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function waitForClose(stream: Readable): Promise<void> {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => stream.once("close", resolve));
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function readEvents(stream: Readable, count: number): Promise<string[]> {
  let pending = "";
  const events: string[] = [];
  for await (const chunk of stream) {
    pending += Buffer.from(chunk).toString("utf8");
    let boundary = pending.indexOf("\n\n");
    while (boundary !== -1) {
      events.push(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
      if (events.length === count) return events;
      boundary = pending.indexOf("\n\n");
    }
  }
  throw new Error(`Stream ended after ${events.length} of ${count} events.`);
}

function writeHead(reply: FastifyReply, statusCode: number, headers: Record<string, string>): void {
  reply.hijack();
  reply.raw.writeHead(statusCode, headers);
}

async function makeApp(options: {
  authorize?: (value: RequestPrincipalWire) => boolean;
} = {}) {
  const observations = {
    cancelled: new Set<string>(),
    eventStableIdAfterYield: null as string | null
  };
  const app = fastify({ logger: false, bodyLimit: 10 * MIB });
  apps.push(app);
  const policies = installRoutePolicy(app, {
    manifest,
    browserSecurity: new BrowserSecurity({
      listenerHost: "127.0.0.1",
      port: 3888,
      mode: "test"
    }),
    authorizeRemotePrincipal: (value) => options.authorize?.(value) ?? true
  });

  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.get("/inspect", async (request, reply) => {
    reply.code(207).header("x-host-safe", "present");
    return {
      query: request.query,
      repeated: request.headers["x-repeat"],
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      csrf: request.headers["x-waifus-csrf"],
      secFetchSite: request.headers["sec-fetch-site"],
      principal: request.principal,
      principalFrozen: Object.isFrozen(request.principal),
      browserContextFrozen: request.principal.browserContext
        ? Object.isFrozen(request.principal.browserContext)
        : null,
      internalStableId: getInternalDispatchContext()?.principal.stableId ?? null
    };
  });

  app.post("/upload", async (request) => {
    let byteLength = 0;
    const hash = createHash("sha256");
    for await (const chunk of request.body as Readable) {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.byteLength;
      hash.update(bytes);
    }
    return { byteLength, sha256: hash.digest("hex") };
  });

  app.get("/download", async (request, reply) => {
    request.raw.once("close", () => observations.cancelled.add("download"));
    writeHead(reply, 206, {
      "content-type": "application/octet-stream",
      "set-cookie": "must-not-cross=1",
      "x-host-safe": "present"
    });
    const chunk = Buffer.alloc(64 * 1_024, 0x5a);
    for (let index = 0; index < 512; index += 1) {
      if (!reply.raw.write(chunk)) await once(reply.raw, "drain");
    }
    reply.raw.end();
  });

  app.get("/events", async (request, reply) => {
    writeHead(reply, 200, { "content-type": "text/event-stream" });
    reply.raw.write("event: tick\ndata: 1\n\n");
    for (let index = 2; index <= 100; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      reply.raw.write(`event: tick\ndata: ${index}\n\n`);
    }
    observations.eventStableIdAfterYield = getInternalDispatchContext()?.principal.stableId ?? null;
    await once(request.raw, "close");
    observations.cancelled.add("events");
  });

  app.get("/cancel", async (request, reply) => {
    writeHead(reply, 200, { "content-type": "application/octet-stream" });
    reply.raw.write(Buffer.alloc(64 * 1_024, 0x33));
    await once(request.raw, "close");
    observations.cancelled.add("cancel");
  });

  app.post("/api/llm/v1/chat", async (request, reply) => {
    writeHead(reply, 200, { "content-type": "text/event-stream" });
    reply.raw.write("data: {\"type\":\"token\"}\n\n");
    await new Promise<void>((resolve) => reply.raw.once("close", resolve));
    observations.cancelled.add("llm");
  });

  policies.assertComplete();
  const bridge = new RemoteRequestBridge(app);
  bridges.push(bridge);
  return { app, bridge, observations };
}

async function makeRealApiApp(fetchImpl: typeof fetch) {
  const root = await makeTempRoot("waifus-remote-bridge-");
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: {
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: []
    },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    llmGateway: { fetchImpl },
    remoteTrust: { isAuthorized: () => true }
  });
  apps.push(app);
  const bridge = new RemoteRequestBridge(app);
  bridges.push(bridge);
  return { app, bridge, root };
}

describe("authenticated remote request bridge", () => {
  it("preserves HTTP semantics and attaches the actor outside HTTP headers", async () => {
    const { bridge } = await makeApp();
    const helper = new FakeTsConnect(bridge);
    const response = await helper.request(start(
      "travel-mac",
      "GET",
      "/inspect?mode=full&mode=delta",
      [["x-repeat", "first"], ["x-repeat", "second"]]
    ));

    expect(response.statusCode).toBe(207);
    expect(response.headers).toContainEqual(["x-host-safe", "present"]);
    const body = JSON.parse((await readAll(response.body)).toString("utf8"));
    expect(body).toMatchObject({
      query: { mode: ["full", "delta"] },
      repeated: "first, second",
      principal: {
        kind: "remote_device",
        stableId: "remote:travel-mac",
        deviceId: "travel-mac",
        trustEpoch: "7"
      },
      internalStableId: "remote:travel-mac"
    });
  });

  it("streams an 8 MiB upload and 32 MiB download without whole-body buffering", async () => {
    const { bridge } = await makeApp();
    const helper = new FakeTsConnect(bridge);
    const uploadChunk = Buffer.alloc(64 * 1_024, 0xa5);
    const expectedUploadHash = createHash("sha256");
    for (let index = 0; index < 128; index += 1) expectedUploadHash.update(uploadChunk);
    const upload = Readable.from((async function* () {
      for (let index = 0; index < 128; index += 1) yield uploadChunk;
    })());
    const uploaded = await helper.request(
      start("travel-mac", "POST", "/upload", [["content-type", "application/octet-stream"]]),
      { body: upload }
    );
    expect(JSON.parse((await readAll(uploaded.body)).toString("utf8"))).toEqual({
      byteLength: 8 * MIB,
      sha256: expectedUploadHash.digest("hex")
    });

    const downloaded = await helper.request(start("travel-mac", "GET", "/download"));
    expect(downloaded.statusCode).toBe(206);
    expect(downloaded.headers.some(([name]) => name === "set-cookie")).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(downloaded.body.readableLength).toBeLessThanOrEqual(2 * MIB);
    let downloadedBytes = 0;
    for await (const chunk of downloaded.body) downloadedBytes += Buffer.byteLength(chunk);
    expect(downloadedBytes).toBe(32 * MIB);
  });

  it("delivers the first SSE event before completion and cancels within one second", async () => {
    const { bridge, observations } = await makeApp();
    const helper = new FakeTsConnect(bridge);
    const controller = new AbortController();
    const response = await helper.request(start("travel-mac", "GET", "/events"), {
      signal: controller.signal
    });
    const events = await readEvents(response.body, 100);
    expect(events[0]).toContain("data: 1");
    expect(events[99]).toContain("data: 100");
    expect(observations.eventStableIdAfterYield).toBe("remote:travel-mac");
    const closed = waitForClose(response.body);
    const startedAt = performance.now();
    controller.abort();
    await closed;
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await waitFor(() => observations.cancelled.has("events"), "SSE handler cancellation");
  });

  it("requires completed WIPC parent authentication before opening the bridge", async () => {
    const { app, bridge } = await makeApp();
    const unauthenticated = new WipcParentAuthSession({
      parentCapability: Buffer.alloc(32, 0x41),
      clientNonce: Buffer.alloc(32, 0x42),
      helloBytes: Buffer.from("unauthenticated-parent")
    });
    expect(() => bridge.openAuthenticatedConnection("socket-race", unauthenticated))
      .toThrow(expect.objectContaining({ code: "frame_before_authentication" }));

    const helper = new FakeTsConnect(bridge, "authenticated-helper");
    const accepted = await helper.request(start("travel-mac", "GET", "/inspect"));
    expect(accepted.statusCode).toBe(207);
    await readAll(accepted.body);

    await app.close();
    expect(() => new FakeTsConnect(bridge, "after-fastify-close"))
      .toThrow(expect.objectContaining({ code: "bridge_closed" }));
  });

  it("accepts only helper-verified immutable browser metadata bound to method and target", async () => {
    const { bridge } = await makeApp();
    const helper = new FakeTsConnect(bridge);
    const browserPrincipal: RequestPrincipalWire = {
      ...principal("travel-mac"),
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x31).toString("base64url") as never,
        browserSessionId: Buffer.alloc(32, 0x32).toString("base64url") as never,
        requestNonce: bytes16(0x33) as never,
        method: "GET",
        canonicalTarget: "/inspect",
        csrfValidated: true
      }
    };
    const requestStart = {
      version: 1,
      method: "GET",
      canonicalTarget: "/inspect",
      headers: [
        ["cookie", "gateway-secret=must-not-cross"],
        ["origin", "http://remote.waifus.localhost"],
        ["sec-fetch-site", "same-origin"],
        ["x-waifus-csrf", Buffer.alloc(32, 0x44).toString("base64url")]
      ],
      principal: browserPrincipal
    };
    const response = await helper.request(requestStart);
    browserPrincipal.trustEpoch = "999" as never;
    const body = JSON.parse((await readAll(response.body)).toString("utf8"));
    expect(body).toMatchObject({
      principal: {
        trustEpoch: "7",
        browserContext: {
          verifiedBy: "host_helper",
          method: "GET",
          canonicalTarget: "/inspect"
        }
      },
      principalFrozen: true,
      browserContextFrozen: true
    });
    expect(body).not.toHaveProperty("cookie");
    expect(body).not.toHaveProperty("origin");
    expect(body).not.toHaveProperty("csrf");
    expect(body).not.toHaveProperty("secFetchSite");

    await expect(helper.request({
      ...requestStart,
      principal: {
        ...principal("travel-mac"),
        browserContext: {
          ...requestStart.principal.browserContext,
          canonicalTarget: "/other"
        }
      }
    })).rejects.toMatchObject({ code: "invalid_browser_context" });
    await expect(helper.request({
      ...requestStart,
      headers: [["x-first", "a".repeat(8_192)], ["x-second", "b".repeat(8_192)]],
      principal: principal("travel-mac")
    })).rejects.toMatchObject({ code: "headers_too_large" });
  });

  it("propagates upload, download, and LLM cancellation to handlers within one second", async () => {
    const { bridge, observations } = await makeApp();
    const helper = new FakeTsConnect(bridge);

    const uploadController = new AbortController();
    const upload = Readable.from((async function* () {
      while (true) {
        yield Buffer.alloc(64 * 1_024, 0x61);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })());
    upload.on("error", () => {});
    const uploadClosed = waitForClose(upload);
    const uploadPending = helper.request(
      start("travel-mac", "POST", "/upload", [["content-type", "application/octet-stream"]]),
      { body: upload, signal: uploadController.signal }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const uploadStartedAt = performance.now();
    uploadController.abort();
    await expect(uploadPending).rejects.toMatchObject({ name: "AbortError" });
    await uploadClosed;
    expect(performance.now() - uploadStartedAt).toBeLessThan(1_000);

    const downloadController = new AbortController();
    const download = await helper.request(start("travel-mac", "GET", "/download"), {
      signal: downloadController.signal
    });
    const downloadClosed = waitForClose(download.body);
    const downloadStartedAt = performance.now();
    downloadController.abort();
    await downloadClosed;
    await waitFor(() => observations.cancelled.has("download"), "download handler cancellation");
    expect(performance.now() - downloadStartedAt).toBeLessThan(1_000);

    const llmController = new AbortController();
    const llm = await helper.request(start("travel-mac", "POST", "/api/llm/v1/chat"), {
      signal: llmController.signal
    });
    const llmClosed = waitForClose(llm.body);
    const llmStartedAt = performance.now();
    llmController.abort();
    await llmClosed;
    await waitFor(() => observations.cancelled.has("llm"), "LLM handler cancellation");
    expect(performance.now() - llmStartedAt).toBeLessThan(1_000);
  });

  it("aborts the real /api/llm/v1/chat provider fetch before response headers", async () => {
    let providerSignal: AbortSignal | undefined;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        providerSignal = init?.signal ?? undefined;
        providerStarted();
        providerSignal?.addEventListener("abort", () => {
          reject(providerSignal?.reason ?? new Error("provider request aborted"));
        }, { once: true });
      })) as typeof fetch;
    const { app, bridge, root } = await makeRealApiApp(fetchImpl);
    const credential = await app.inject({
      method: "PUT",
      url: "/api/providers/deepseek/credentials",
      payload: { apiKey: "sk-bridge-test" }
    });
    expect(credential.statusCode).toBe(200);

    const helper = new FakeTsConnect(bridge);
    const controller = new AbortController();
    const pending = helper.request(
      start(
        "travel-mac",
        "POST",
        "/api/llm/v1/chat",
        [
          ["content-type", "application/json"],
          ["idempotency-key", Buffer.alloc(32, 0x51).toString("base64url")]
        ]
      ),
      {
        body: Readable.from([JSON.stringify({
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "keep waiting" }]
        })]),
        signal: controller.signal
      }
    );
    await started;
    const startedAt = performance.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await waitForAsync(async () => {
      try {
        const [ledger, audit] = await Promise.all([
          readFile(
            path.join(root, "app", "remote-access", "operations", "ledger.json"),
            "utf8"
          ).then((value) => JSON.parse(value) as { records?: Array<{ status?: string }> }),
          readFile(
            path.join(root, "app", "remote-access", "audit", "ledger.json"),
            "utf8"
          ).then((value) => JSON.parse(value) as { records?: Array<{ outcome?: string }> })
        ]);
        return Boolean(
          ledger.records?.some((record) => record.status === "outcome_unknown")
          && ledger.records.every((record) => record.status !== "prepared")
          && audit.records?.some((record) => record.outcome === "unknown")
        );
      } catch {
        return false;
      }
    }, "cancelled LLM operation durability");
  });

  it("rejects forged metadata and stale trust epochs", async () => {
    const { bridge } = await makeApp({ authorize: (value) => value.trustEpoch === "8" });
    const helper = new FakeTsConnect(bridge);
    await expect(helper.request(start(
      "travel-mac",
      "GET",
      "/inspect",
      [["x-device-id", "forged"]]
    ))).rejects.toMatchObject({ code: "forbidden_header" });

    const stale = await helper.request(start("travel-mac", "GET", "/inspect"));
    expect(stale.statusCode).toBe(403);
    expect((await readAll(stale.body)).toString("utf8")).not.toContain("travel-mac");
  });

  it("enforces stream high-water marks, per-device limits, and device isolation", async () => {
    const { bridge } = await makeApp();
    const helper = new FakeTsConnect(bridge);
    const controllers = Array.from(
      { length: REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE },
      () => new AbortController()
    );
    const active = await Promise.all(controllers.map((controller, index) => helper.request(
      start("first-mac", "GET", "/cancel"),
      { signal: controller.signal, streamId: BigInt(2 + index * 2) }
    )));

    await expect(helper.request(start("first-mac", "GET", "/cancel"), {
      streamId: 66n
    })).rejects.toMatchObject({ code: "device_stream_limit" });
    const otherController = new AbortController();
    const other = await helper.request(start("second-mac", "GET", "/cancel"), {
      signal: otherController.signal,
      streamId: 68n
    });
    await expect(helper.request(start("second-mac", "GET", "/cancel"), {
      streamId: 68n
    })).rejects.toMatchObject({ code: "stream_id_reused" });

    const closed = Promise.all([...active, other].map((response) => waitForClose(response.body)));
    for (const controller of controllers) controller.abort();
    otherController.abort();
    await closed;
  });

  it("caps one helper connection at 128 backpressured streams and 8 MiB queued", async () => {
    const { bridge } = await makeApp();
    const helper = new FakeTsConnect(bridge);
    const controllers = Array.from(
      { length: REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_CONNECTION },
      () => new AbortController()
    );
    const active = await Promise.all(controllers.map((controller, index) => helper.request(
      start(`device-${Math.floor(index / REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE)}`, "GET", "/cancel"),
      { signal: controller.signal, streamId: BigInt(2 + index * 2) }
    )));
    expect(active.reduce((sum, response) => sum + response.body.readableLength, 0))
      .toBeLessThanOrEqual(8 * MIB);
    await expect(helper.request(start("device-overflow", "GET", "/cancel"), {
      streamId: 258n
    })).rejects.toMatchObject({ code: "connection_stream_limit" });

    const closed = Promise.all(active.map((response) => waitForClose(response.body)));
    for (const controller of controllers) controller.abort();
    await closed;
  });

  it.each(Array.from({ length: 10 }, (_value, index) => index))(
    "cancels every helper-owned request on disconnect without affecting local traffic (race %i)",
    async () => {
      const { app, bridge, observations } = await makeApp();
      const helper = new FakeTsConnect(bridge);
      const first = await helper.request(start("first-mac", "GET", "/cancel"));
      const second = await helper.request(start("second-mac", "GET", "/cancel"));
      const closed = Promise.all([waitForClose(first.body), waitForClose(second.body)]);
      helper.close(new Error("fake helper disconnected"));
      await closed;
      await waitFor(() => observations.cancelled.has("cancel"), "helper-owned handler cancellation");
      const local = await app.inject({ method: "GET", url: "/inspect" });
      expect(local.statusCode).toBe(207);
    }
  );
});
