import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { BrowserSecurity } from "../src/api/browserSecurity.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import {
  getRegisteredRoutePolicyInventory,
  installRoutePolicy
} from "../src/api/routePolicy.js";
import {
  EXPECTED_ROUTE_POLICY_INVENTORY,
  ROUTE_POLICY_MANIFEST
} from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
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

function remote() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x21),
    transportSessionId: bytes16(0x22),
    trustEpoch: "9"
  });
}

async function makeApp() {
  const root = await makeTempRoot("waifus-route-policy-");
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
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    remoteTrust: { isAuthorized: () => true }
  });
  apps.push(app);
  return app;
}

describe("route policy inventory", () => {
  it("matches every registered route, automatic HEAD route, gateway wildcard, and not-found policy", async () => {
    const app = await makeApp();
    expect(getRegisteredRoutePolicyInventory(app)).toEqual(EXPECTED_ROUTE_POLICY_INVENTORY);
  });

  it("throws immediately when a route is registered without reviewed policy", async () => {
    const app = fastify({ logger: false });
    apps.push(app);
    installRoutePolicy(app, {
      manifest: ROUTE_POLICY_MANIFEST,
      browserSecurity: new BrowserSecurity({
        listenerHost: "127.0.0.1",
        port: 3888,
        mode: "test"
      })
    });
    expect(() => app.get("/test-only-unclassified", async () => ({ ok: true }))).toThrow(
      /unclassified/i
    );
  });
});

describe("remote route authorization", () => {
  it("allows reviewed APIs but denies local static routes and never-proxy client context", async () => {
    const app = await makeApp();
    const actor = remote();
    const health = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/api/health"
    });
    expect(health.statusCode).toBe(200);

    const root = await dispatchInternal(app, actor, undefined, { method: "GET", url: "/" });
    expect(root.statusCode).toBe(403);
    const context = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/api/client-context"
    });
    expect(context.statusCode).toBe(403);
  });

  it("applies the exact five-route semantic allowlist inside the gateway wildcard", async () => {
    const app = await makeApp();
    const actor = remote();
    for (const url of [
      "/api/llm/v1/providers",
      "/api/llm/v1/models",
      "/api/llm/v1/models/deepseek/deepseek-v4-pro"
    ]) {
      const response = await dispatchInternal(app, actor, undefined, { method: "GET", url });
      expect(response.statusCode, url).not.toBe(403);
    }
    for (const [method, url] of [
      ["GET", "/api/llm/v1/sync"],
      ["DELETE", "/api/llm/v1/models"],
      ["POST", "/api/llm/v1/providers"]
    ] as const) {
      const response = await dispatchInternal(app, actor, undefined, { method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
