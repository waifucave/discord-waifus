import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserSecurity } from "../src/api/browserSecurity.js";
import {
  dispatchInternal,
  getInternalDispatchContext
} from "../src/api/internalDispatch.js";
import {
  createRemoteRequestPrincipal,
  type RequestPrincipal
} from "../src/api/requestPrincipal.js";
import {
  installRoutePolicy,
  type RoutePolicyDefinition
} from "../src/api/routePolicy.js";

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

const testManifest: readonly RoutePolicyDefinition[] = [
  {
    method: "GET",
    path: "/who",
    remotePolicy: "full_admin"
  }
];

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

function remote(deviceId: string, trustEpoch = "7") {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: bytes16(0x11),
    transportSessionId: bytes16(0x12),
    trustEpoch
  });
}

async function principalApp(options: {
  authorize?: (principal: Extract<RequestPrincipal, { kind: "remote_device" }>) => boolean;
} = {}) {
  const app = fastify({ logger: false });
  apps.push(app);
  const policies = installRoutePolicy(app, {
    manifest: testManifest,
    browserSecurity: new BrowserSecurity({
      listenerHost: "127.0.0.1",
      port: 3888,
      mode: "test"
    }),
    authorizeRemotePrincipal: options.authorize
  });
  app.get("/who", async (request) => {
    await new Promise((resolve) => setTimeout(resolve, request.principal.kind === "local" ? 4 : 1));
    return {
      principal: request.principal,
      delegation: request.assistantDelegation ?? null,
      internalStableId: getInternalDispatchContext()?.principal.stableId ?? null
    };
  });
  policies.assertComplete();
  return app;
}

describe("request principals and internal dispatch", () => {
  it("derives ordinary loopback requests as local without trusting headers", async () => {
    const app = await principalApp();
    const response = await app.inject({ method: "GET", url: "/who" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { kind: "local", stableId: "local" },
      delegation: null,
      internalStableId: null
    });
  });

  it("accepts an explicit trusted internal remote actor and preserves delegation", async () => {
    const app = await principalApp({ authorize: (principal) => principal.trustEpoch === "7" });
    const actor = remote("travel-mac");
    const response = await dispatchInternal(
      app,
      actor,
      { conversationId: "conversation-1", toolCallId: "tool-1" },
      { method: "GET", url: "/who" }
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: {
        kind: "remote_device",
        stableId: "remote:travel-mac",
        deviceId: "travel-mac",
        trustEpoch: "7"
      },
      delegation: { conversationId: "conversation-1", toolCallId: "tool-1" },
      internalStableId: "remote:travel-mac"
    });
  });

  it("fails closed for missing actors, stale epochs, and revoked devices", async () => {
    const app = await principalApp({ authorize: (principal) => principal.trustEpoch === "8" });
    await expect(dispatchInternal(
      app,
      undefined as never,
      undefined,
      { method: "GET", url: "/who" }
    )).rejects.toThrow(/principal/i);

    const stale = await dispatchInternal(app, remote("travel-mac", "7"), undefined, {
      method: "GET",
      url: "/who"
    });
    expect(stale.statusCode).toBe(403);

    const revokedApp = await principalApp({ authorize: () => false });
    const revoked = await dispatchInternal(revokedApp, remote("revoked-mac"), undefined, {
      method: "GET",
      url: "/who"
    });
    expect(revoked.statusCode).toBe(403);
  });

  it("refuses internal dispatch before the authenticated receiver hook is installed", async () => {
    const app = fastify({ logger: false });
    apps.push(app);
    app.get("/unprotected", async () => ({ reached: true }));
    await expect(dispatchInternal(
      app,
      remote("travel-mac"),
      undefined,
      { method: "GET", url: "/unprotected" }
    )).rejects.toThrow(/authenticated principal receiver/i);
  });

  it("rejects forged principal and helper-capability headers", async () => {
    const app = await principalApp();
    for (const headers of [
      { "x-device-id": "forged" },
      { "x-waifus-principal": "remote:forged" },
      { "x-waifus-internal-capability": "forged" },
      { "x-waifus-browser-context": "forged" }
    ]) {
      const response = await app.inject({ method: "GET", url: "/who", headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(400);
      expect(response.body).not.toContain("forged");
    }
  });

  it("rejects a non-loopback transport peer instead of deriving local authority", async () => {
    const app = await principalApp();
    const response = await app.inject({
      method: "GET",
      url: "/who",
      remoteAddress: "192.0.2.44"
    });
    expect(response.statusCode).toBe(403);
  });

  it("binds helper-verified browser context to the exact method and target", async () => {
    const app = await principalApp({ authorize: () => true });
    const actor = createRemoteRequestPrincipal({
      ...remote("travel-mac"),
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x31).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x32).toString("base64url"),
        requestNonce: bytes16(0x33),
        method: "GET",
        canonicalTarget: "/who",
        csrfValidated: true
      }
    });
    const accepted = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/who"
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().principal.browserContext.verifiedBy).toBe("host_helper");

    const wrongMethod = await dispatchInternal(app, actor, undefined, {
      method: "HEAD",
      url: "/who"
    });
    expect(wrongMethod.statusCode).toBe(403);
  });

  it("keeps concurrent internal actors isolated", async () => {
    const app = await principalApp({ authorize: () => true });
    const [first, second, local] = await Promise.all([
      dispatchInternal(app, remote("first"), undefined, { method: "GET", url: "/who" }),
      dispatchInternal(app, remote("second"), undefined, { method: "GET", url: "/who" }),
      app.inject({ method: "GET", url: "/who" })
    ]);
    expect(first.json().internalStableId).toBe("remote:first");
    expect(second.json().internalStableId).toBe("remote:second");
    expect(local.json().internalStableId).toBeNull();
  });
});
