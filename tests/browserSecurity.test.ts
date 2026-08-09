import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fastify from "fastify";
import { createApiServer } from "../src/api/server.js";
import { BrowserSecurity } from "../src/api/browserSecurity.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { installRoutePolicy, type RoutePolicyDefinition } from "../src/api/routePolicy.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
  await Promise.all(roots.map(removeTempRoot));
  roots.length = 0;
});

async function makeApp(options: {
  root?: string;
  mode?: "start" | "dev" | "test";
  now?: () => number;
} = {}) {
  const root = options.root ?? await makeTempRoot("waifus-browser-security-");
  if (!options.root) roots.push(root);
  await ensureDataLayout(root);
  const mode = options.mode ?? "test";
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode,
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    browserSecurity: {
      listenerHost: "127.0.0.1",
      mode,
      now: options.now
    },
    remoteTrust: { isAuthorized: () => true }
  });
  apps.push(app);
  return { app, root };
}

function browserHeaders(origin = "http://127.0.0.1:3888") {
  return {
    host: "127.0.0.1:3888",
    origin,
    "sec-fetch-site": "same-origin"
  };
}

async function browserSession(app: Awaited<ReturnType<typeof makeApp>>["app"], origin?: string) {
  const response = await app.inject({
    method: "GET",
    url: "/api/client-context",
    headers: browserHeaders(origin)
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: String(response.headers["set-cookie"]),
    csrf: String(response.headers["x-waifus-csrf"]),
    response
  };
}

function remote() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(0x32),
    trustEpoch: "3"
  });
}

describe("host browser session and CSRF", () => {
  it("returns a header-only 32-byte token and a host-only hardened session cookie", async () => {
    const { app } = await makeApp();
    const { cookie, csrf, response } = await browserSession(app);
    expect(response.json()).toEqual({ mode: "host" });
    expect(Buffer.from(csrf, "base64url")).toHaveLength(32);
    expect(csrf).toHaveLength(43);
    expect(response.body).not.toContain(csrf);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toMatch(/Domain=/i);
    const sessionId = cookie.split(";", 1)[0].split("=", 2)[1];
    expect(Buffer.from(sessionId, "base64url")).toHaveLength(32);

    const security = new BrowserSecurity({
      listenerHost: "127.0.0.1",
      port: 3888,
      mode: "test"
    });
    expect(Buffer.from(security.hostServerLaunchId, "base64url")).toHaveLength(32);
  });

  it("attaches immutable launch, session, nonce, target, and CSRF results to browser principals", async () => {
    const app = fastify({ logger: false });
    apps.push(app);
    const security = new BrowserSecurity({
      listenerHost: "127.0.0.1",
      port: 3888,
      mode: "test"
    });
    const manifest: readonly RoutePolicyDefinition[] = [
      { method: "GET", path: "/context", remotePolicy: "never_proxy" },
      { method: "GET", path: "/who", remotePolicy: "full_admin" },
      {
        method: "POST",
        path: "/mutate",
        remotePolicy: "full_admin",
        retryClass: "transactional",
        auditAction: "test.mutate"
      }
    ];
    const policies = installRoutePolicy(app, { manifest, browserSecurity: security });
    app.get("/context", async (request, reply) => {
      request.principal = security.establishClientContext(request, reply);
      return { ok: true };
    });
    app.get("/who", async (request) => request.principal);
    app.post("/mutate", async (request) => request.principal);
    policies.assertComplete();

    const context = await app.inject({
      method: "GET",
      url: "/context",
      headers: browserHeaders()
    });
    const cookie = String(context.headers["set-cookie"]);
    const csrf = String(context.headers["x-waifus-csrf"]);
    const safe = await app.inject({
      method: "GET",
      url: "/who",
      headers: { ...browserHeaders(), cookie }
    });
    expect(safe.statusCode).toBe(200);
    const safeContext = safe.json().browserContext as Record<string, unknown>;
    expect(safeContext).toMatchObject({
      verifiedBy: "host_server",
      method: "GET",
      canonicalTarget: "/who",
      csrfValidated: false
    });
    expect(Buffer.from(String(safeContext.hostServerLaunchId), "base64url")).toHaveLength(32);
    expect(Buffer.from(String(safeContext.browserSessionId), "base64url")).toHaveLength(32);
    expect(Buffer.from(String(safeContext.requestNonce), "base64url")).toHaveLength(16);

    const unsafe = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { ...browserHeaders(), cookie, "x-waifus-csrf": csrf }
    });
    expect(unsafe.statusCode).toBe(200);
    expect(unsafe.json().browserContext).toMatchObject({
      method: "POST",
      canonicalTarget: "/mutate",
      csrfValidated: true
    });
  });

  it("requires the exact cookie and CSRF token before unsafe browser handlers run", async () => {
    const { app } = await makeApp();
    const { cookie, csrf } = await browserSession(app);
    const payload = { runtime: { paused: true } };
    for (const headers of [
      browserHeaders(),
      { ...browserHeaders(), cookie },
      { ...browserHeaders(), cookie, "x-waifus-csrf": bytes16(0x41) }
    ]) {
      const response = await app.inject({ method: "PUT", url: "/api/config", headers, payload });
      expect(response.statusCode).toBe(403);
    }
    const accepted = await app.inject({
      method: "PUT",
      url: "/api/config",
      headers: { ...browserHeaders(), cookie, "x-waifus-csrf": csrf },
      payload
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().runtime.paused).toBe(true);
    expect(accepted.headers["set-cookie"]).toContain("HttpOnly");
  });

  it("rejects DNS rebinding, foreign origins, and cross-site fetches", async () => {
    const { app } = await makeApp();
    for (const headers of [
      { ...browserHeaders(), host: "evil.example:3888" },
      browserHeaders("http://evil.example:3888"),
      { ...browserHeaders(), "sec-fetch-site": "cross-site" }
    ]) {
      const response = await app.inject({ method: "GET", url: "/api/client-context", headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(403);
      expect(response.headers["x-waifus-csrf"]).toBeUndefined();
    }
  });

  it("keeps loopback command-line automation compatible without Origin", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      // Node's built-in fetch emits this header even though it is not a browser context.
      headers: { "sec-fetch-mode": "cors" },
      payload: { runtime: { paused: true } }
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects expired sessions and sessions from a previous server launch", async () => {
    let now = 1_800_000_000_000;
    const firstRoot = await makeTempRoot("waifus-browser-restart-");
    roots.push(firstRoot);
    const first = await makeApp({ root: firstRoot, now: () => now });
    const initial = await browserSession(first.app);
    now += 30 * 60 * 1000 + 1;
    const expired = await first.app.inject({
      method: "PUT",
      url: "/api/config",
      headers: {
        ...browserHeaders(),
        cookie: initial.cookie,
        "x-waifus-csrf": initial.csrf
      },
      payload: { runtime: { paused: true } }
    });
    expect(expired.statusCode).toBe(403);

    const second = await makeApp({ root: firstRoot, now: () => now });
    const staleLaunch = await second.app.inject({
      method: "PUT",
      url: "/api/config",
      headers: {
        ...browserHeaders(),
        cookie: initial.cookie,
        "x-waifus-csrf": initial.csrf
      },
      payload: { runtime: { paused: false } }
    });
    expect(staleLaunch.statusCode).toBe(403);
  });

  it("allows only the two explicit Vite origins in dev mode", async () => {
    const dev = await makeApp({ mode: "dev" });
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173"]) {
      expect((await browserSession(dev.app, origin)).response.statusCode).toBe(200);
    }
    const production = await makeApp({ mode: "start" });
    const rejected = await production.app.inject({
      method: "GET",
      url: "/api/client-context",
      headers: browserHeaders("http://localhost:5173")
    });
    expect(rejected.statusCode).toBe(403);
  });
});

describe("app config field policy", () => {
  it("merges partial updates before validation and preserves omitted local-only fields", async () => {
    const { app, root } = await makeApp();
    const seeded = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        http: { host: "localhost", port: 4999 },
        frontend: { staticDir: path.join(root, "custom-dashboard") },
        runtime: { autoConnectDiscord: false, paused: false },
        ocr: { enabled: false }
      }
    });
    expect(seeded.statusCode).toBe(200);
    const before = await readFile(path.join(root, "config.toml"), "utf8");

    const response = await dispatchInternal(app, remote(), undefined, {
      method: "PUT",
      url: "/api/config",
      payload: { runtime: { paused: true } }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ http: { port: 4999 }, frontend: {} });
    expect(response.body).not.toContain("localhost");
    expect(response.body).not.toContain("custom-dashboard");
    const saved = await loadAppConfig(root);
    expect(saved.http).toEqual({ host: "localhost", port: 4999 });
    expect(saved.frontend.staticDir).toBe(path.join(root, "custom-dashboard"));
    expect(saved.runtime).toEqual({ autoConnectDiscord: false, paused: true });
    expect(saved.ocr.enabled).toBe(false);
    expect(await readFile(path.join(root, "config.toml"), "utf8")).not.toBe(before);

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { frontend: { staticDir: null } }
    });
    expect(cleared.statusCode).toBe(200);
    expect((await loadAppConfig(root)).frontend.staticDir).toBeUndefined();
  });

  it("rejects remote attempts to supply host bind or filesystem-serving fields", async () => {
    const { app } = await makeApp();
    for (const payload of [
      { http: { host: "127.0.0.1" } },
      { frontend: { staticDir: "/tmp/remote-controlled" } }
    ]) {
      const response = await dispatchInternal(app, remote(), undefined, {
        method: "PUT",
        url: "/api/config",
        payload
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("redacts host bind and filesystem-serving fields from remote reads", async () => {
    const { app, root } = await makeApp();
    await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        http: { host: "localhost", port: 4999 },
        frontend: { staticDir: path.join(root, "private-dashboard") }
      }
    });
    const response = await dispatchInternal(app, remote(), undefined, {
      method: "GET",
      url: "/api/config"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ http: { port: 4999 }, frontend: {} });
    expect(response.body).not.toContain("localhost");
    expect(response.body).not.toContain("private-dashboard");
  });
});
