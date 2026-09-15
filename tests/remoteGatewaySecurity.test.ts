import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import { createRemoteBrowserContext } from "../src/remote/gateway/browserContext.js";
import {
  DASHBOARD_SECURITY_HEADERS,
  RemoteBrowserRequestError,
  SHELL_SECURITY_HEADERS,
  dashboardSecurityHeaders,
  frameShellSecurityHeaders,
  validateRemoteBootstrapRequest,
  validateRemoteBrowserRequest
} from "../src/remote/gateway/security.js";
import {
  REMOTE_SESSION_ABSOLUTE_MS,
  REMOTE_SESSION_IDLE_MS,
  RemoteBrowserSessionStore
} from "../src/remote/gateway/session.js";
import {
  REMOTE_SESSION_READY_PATH,
  startRemoteGateway,
  type RunningRemoteGateway
} from "../src/remote/gateway/server.js";
import { RemoteOriginStore } from "../src/remote/gateway/originStore.js";
import { startRemoteGatewayRuntime } from "../src/remote/gateway/runtime.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const gateways: RunningRemoteGateway[] = [];
const roots: string[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(blockers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function deterministicRandom(start = 1): (size: number) => Uint8Array {
  let value = start;
  return (size) => Buffer.alloc(size, value++);
}

function requestInput(
  method: "GET" | "POST" = "GET",
  headers: Record<string, string | string[] | undefined> = {}
) {
  return {
    method,
    canonicalTarget: method === "GET" ? "/api/status" : "/api/config",
    headers: {
      host: "waifus-test.localhost:43123",
      origin: "http://waifus-test.localhost:43123",
      "sec-fetch-site": "same-origin",
      ...headers
    }
  } as const;
}

function browserSession(store: RemoteBrowserSessionStore) {
  const token = store.issueBootstrapToken();
  const session = store.consumeBootstrapToken(token);
  expect(session).toBeDefined();
  return session!;
}

function cookie(store: RemoteBrowserSessionStore, session = browserSession(store)): string {
  return store.sessionCookieHeader(session).split(";", 1)[0];
}

function rawRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
}): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: options.port,
      path: options.path,
      method: options.method ?? "GET",
      headers: options.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function listenBlocker(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  blockers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

describe("remote browser sessions", () => {
  it("uses one-use bootstrap tokens and per-launch 32-byte session and CSRF secrets", () => {
    const first = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom() });
    const bootstrapToken = first.issueBootstrapToken();
    const session = first.consumeBootstrapToken(bootstrapToken);
    expect(session).toBeDefined();
    expect(first.consumeBootstrapToken(bootstrapToken)).toBeUndefined();

    expect(Buffer.from(first.gatewayLaunchId, "base64url")).toHaveLength(32);
    expect(first.sessionCookieName).toMatch(/^waifus_remote_session_[a-f0-9]{32}$/u);
    expect(Buffer.from(session!.browserSessionId, "base64url")).toHaveLength(32);
    expect(Buffer.from(session!.csrfToken, "base64url")).toHaveLength(32);
    expect(session!.browserSessionId).not.toBe(session!.csrfToken);

    const cookieHeader = first.sessionCookieHeader(session!);
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Strict");
    expect(cookieHeader).toContain("Path=/");
    expect(cookieHeader).not.toMatch(/Domain=/iu);
    expect(cookieHeader).not.toMatch(/Secure/iu);

    const second = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom(20) });
    expect(second.gatewayLaunchId).not.toBe(first.gatewayLaunchId);
    expect(second.sessionCookieName).not.toBe(first.sessionCookieName);
    expect(second.sessionFromCookie(cookieHeader)).toBeUndefined();
  });

  it("enforces 30-minute idle and eight-hour absolute expiry without extending the latter", () => {
    let now = 1_800_000_000_000;
    const store = new RemoteBrowserSessionStore({
      now: () => now,
      randomBytes: deterministicRandom()
    });
    const session = browserSession(store);
    const cookieHeader = cookie(store, session);

    now += REMOTE_SESSION_IDLE_MS - 1;
    expect(store.sessionFromCookie(cookieHeader)).toBeDefined();
    expect(store.commitValidated(session)).toBeDefined();
    now += REMOTE_SESSION_IDLE_MS - 1;
    expect(store.sessionFromCookie(cookieHeader)).toBeDefined();
    now = session.createdAt + REMOTE_SESSION_ABSOLUTE_MS;
    expect(store.sessionFromCookie(cookieHeader)).toBeUndefined();
  });

  it("rejects duplicate session cookies and invalid random-source lengths", () => {
    const store = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom() });
    const session = browserSession(store);
    const pair = cookie(store, session);
    expect(store.sessionFromCookie(`${pair}; ${pair}`)).toBeUndefined();
    expect(() => new RemoteBrowserSessionStore({
      randomBytes: (size) => Buffer.alloc(size - 1)
    })).toThrow(/exactly/iu);
  });
});

describe("remote browser request validation", () => {
  it("accepts exact Host/origin and produces a fresh immutable helper context", () => {
    const store = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom() });
    const session = browserSession(store);
    const validated = validateRemoteBrowserRequest(
      requestInput("POST", {
        cookie: cookie(store, session),
        "x-waifus-csrf": session.csrfToken
      }),
      session,
      {
        expectedAuthority: "waifus-test.localhost:43123",
        expectedOrigin: "http://waifus-test.localhost:43123"
      }
    );
    const random = deterministicRandom(30);
    const first = createRemoteBrowserContext(session, validated, { randomBytes: random });
    const second = createRemoteBrowserContext(session, validated, { randomBytes: random });
    expect(first).toMatchObject({
      version: 1,
      gatewayLaunchId: store.gatewayLaunchId,
      browserSessionId: session.browserSessionId,
      method: "POST",
      canonicalTarget: "/api/config",
      csrfValidated: true
    });
    expect(Buffer.from(first.requestNonce, "base64url")).toHaveLength(16);
    expect(second.requestNonce).not.toBe(first.requestNonce);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("requires the exact session-bound CSRF token on every mutation", () => {
    const store = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom() });
    const first = browserSession(store);
    const second = browserSession(store);
    for (const csrf of [undefined, "not-a-token", second.csrfToken]) {
      expect(() => validateRemoteBrowserRequest(
        requestInput("POST", {
          cookie: cookie(store, first),
          "x-waifus-csrf": csrf
        }),
        first,
        {
          expectedAuthority: "waifus-test.localhost:43123",
          expectedOrigin: "http://waifus-test.localhost:43123"
        }
      )).toThrowError(RemoteBrowserRequestError);
    }
  });

  it("rejects DNS rebinding, foreign origins, cross-site fetches, and forged internal fields", () => {
    const store = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom() });
    const session = browserSession(store);
    const cookieHeader = cookie(store, session);
    const invalidHeaders: Array<Record<string, string | undefined>> = [
      { host: "evil.example:43123" },
      { origin: "http://evil.example:43123" },
      { "sec-fetch-site": "cross-site" },
      { "x-device-id": "forged" },
      { "x-waifus-internal-principal": "forged" },
      { "x-waifus-browser-context": "forged" },
      { "x-waifus-gateway-launch-id": store.gatewayLaunchId },
      { host: undefined },
      { origin: undefined }
    ];
    for (const headers of invalidHeaders) {
      expect(() => validateRemoteBrowserRequest(
        requestInput("POST", {
          cookie: cookieHeader,
          "x-waifus-csrf": session.csrfToken,
          ...headers
        }),
        session,
        {
          expectedAuthority: "waifus-test.localhost:43123",
          expectedOrigin: "http://waifus-test.localhost:43123"
        }
      ), JSON.stringify(headers)).toThrowError(RemoteBrowserRequestError);
    }
    expect(() => validateRemoteBrowserRequest(
      {
        ...requestInput("POST", {
          cookie: cookieHeader,
          "x-waifus-csrf": session.csrfToken
        }),
        body: { nested: { gatewayLaunchId: store.gatewayLaunchId } }
      },
      session,
      {
        expectedAuthority: "waifus-test.localhost:43123",
        expectedOrigin: "http://waifus-test.localhost:43123"
      }
    )).toThrowError(RemoteBrowserRequestError);
  });

  it("allows an origin-free same-site top-level safe navigation but no unsafe equivalent", () => {
    const store = new RemoteBrowserSessionStore({ randomBytes: deterministicRandom() });
    const session = browserSession(store);
    expect(validateRemoteBrowserRequest(
      requestInput("GET", {
        cookie: cookie(store, session),
        origin: undefined,
        "sec-fetch-site": "none"
      }),
      session,
      {
        expectedAuthority: "waifus-test.localhost:43123",
        expectedOrigin: "http://waifus-test.localhost:43123"
      }
    ).csrfValidated).toBe(true);
    expect(() => validateRemoteBrowserRequest(
      requestInput("POST", {
        cookie: cookie(store, session),
        origin: undefined,
        "sec-fetch-site": "none",
        "x-waifus-csrf": session.csrfToken
      }),
      session,
      {
        expectedAuthority: "waifus-test.localhost:43123",
        expectedOrigin: "http://waifus-test.localhost:43123"
      }
    )).toThrowError(RemoteBrowserRequestError);
  });

  it("allows only document or sandboxed-frame navigation to carry a bootstrap token across isolated localhost sites", () => {
    const options = {
      expectedAuthority: "waifus-test.localhost:43123",
      expectedOrigin: "http://waifus-test.localhost:43123"
    };
    expect(validateRemoteBootstrapRequest({
      method: "GET",
      canonicalTarget: `/_waifus_remote/bootstrap/${Buffer.alloc(32, 0x51).toString("base64url")}`,
      headers: {
        host: options.expectedAuthority,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document"
      }
    }, options).csrfValidated).toBe(true);
    expect(validateRemoteBootstrapRequest({
      method: "GET",
      canonicalTarget: `/_waifus_remote/bootstrap/${Buffer.alloc(32, 0x52).toString("base64url")}`,
      headers: {
        host: options.expectedAuthority,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe"
      }
    }, options).csrfValidated).toBe(true);

    for (const headers of [
      { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", origin: "http://evil.example" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "object" }
    ]) {
      expect(() => validateRemoteBootstrapRequest({
        method: "GET",
        canonicalTarget: "/_waifus_remote/bootstrap/token",
        headers: {
          host: options.expectedAuthority,
          "sec-fetch-site": "cross-site",
          ...headers
        }
      }, options)).toThrowError(RemoteBrowserRequestError);
    }
  });
});

describe("remote gateway response policy", () => {
  it("pins a sandboxed same-origin dashboard policy that cannot be weakened by host headers", () => {
    expect(DASHBOARD_SECURITY_HEADERS["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-forms allow-same-origin allow-downloads"
    );
    for (const required of [
      "default-src 'self'",
      "connect-src 'self'",
      "worker-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ]) {
      expect(DASHBOARD_SECURITY_HEADERS["content-security-policy"]).toContain(required);
    }
    expect(DASHBOARD_SECURITY_HEADERS["content-security-policy"]).not.toContain("allow-popups");
    expect(DASHBOARD_SECURITY_HEADERS["content-security-policy"]).not.toContain("top-navigation");
    expect(DASHBOARD_SECURITY_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(DASHBOARD_SECURITY_HEADERS["permissions-policy"]).toBeTruthy();
    expect(Object.isFrozen(DASHBOARD_SECURITY_HEADERS)).toBe(true);
  });

  it("allows popups only in the installed shell sandbox without escape or top navigation", () => {
    const policy = SHELL_SECURITY_HEADERS["content-security-policy"];
    expect(policy).toContain(
      "sandbox allow-scripts allow-forms allow-same-origin allow-downloads allow-popups"
    );
    expect(policy).not.toContain("allow-popups-to-escape-sandbox");
    expect(policy).not.toContain("top-navigation");
    expect(policy).toContain("frame-src 'none'");
  });

  it("pins an embedded dashboard to one exact validated shell origin", () => {
    const hostname = `waifus-${"z".repeat(52)}.localhost`;
    const shellOrigin = `http://${hostname}:43124`;
    const dashboardOrigin = `http://${hostname}:43125`;
    const policy = dashboardSecurityHeaders(
      shellOrigin,
      dashboardOrigin
    )["content-security-policy"];
    expect(policy).toContain(`frame-ancestors ${shellOrigin}`);
    expect(policy).not.toContain("frame-ancestors 'none'");
    for (const invalid of [
      "https://waifus-example.localhost:43124",
      "http://evil.localhost:43124",
      `http://waifus-${"z".repeat(52)}.localhost:43124/path`,
      "http://example.invalid"
    ]) {
      expect(() => dashboardSecurityHeaders(invalid, dashboardOrigin)).toThrow(TypeError);
    }
    expect(() => dashboardSecurityHeaders(
      `http://waifus-${"y".repeat(52)}.localhost:43124`,
      dashboardOrigin
    )).toThrow(TypeError);
    expect(() => dashboardSecurityHeaders(dashboardOrigin, dashboardOrigin)).toThrow(TypeError);
  });

  it("pins a trusted frame shell to one same-host dashboard origin", () => {
    const hostname = `waifus-${"z".repeat(52)}.localhost`;
    const frameShellOrigin = `http://${hostname}:43124`;
    const dashboardOrigin = `http://${hostname}:43125`;
    const policy = frameShellSecurityHeaders(
      dashboardOrigin,
      frameShellOrigin
    )["content-security-policy"];
    expect(policy.split(";").map((value) => value.trim())[0]).toBe(
      "sandbox allow-scripts allow-forms allow-same-origin allow-downloads"
    );
    expect(policy).toContain(`frame-src 'self' ${dashboardOrigin}`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("allow-popups");
    expect(policy).not.toContain("top-navigation");

    for (const invalid of [
      ["http://example.invalid", frameShellOrigin],
      [`http://waifus-${"y".repeat(52)}.localhost:43125`, frameShellOrigin],
      [frameShellOrigin, frameShellOrigin]
    ] as const) {
      expect(() => frameShellSecurityHeaders(...invalid)).toThrow(TypeError);
    }
  });
});

describe("remote gateway listener", () => {
  it("binds loopback, consumes bootstrap once, redirects token-free, and protects all other routes", async () => {
    let capturedContext: unknown;
    const gateway = await startRemoteGateway({
      hostname: "waifus-test.localhost",
      port: 0,
      randomBytes: deterministicRandom(),
      handleAuthenticatedRequest: async (_request, reply, context) => {
        capturedContext = context;
        reply.header("content-security-policy", "default-src *; sandbox allow-popups");
        reply.header("access-control-allow-origin", "*");
        await reply.send({ ok: true });
      }
    });
    gateways.push(gateway);
    expect((gateway.address as AddressInfo).address).toBe("127.0.0.1");
    const bootstrapPath = new URL(gateway.bootstrapUrl).pathname;
    const expectedHost = `waifus-test.localhost:${gateway.port}`;

    const unauthenticated = await rawRequest({
      port: gateway.port,
      path: "/api/status",
      headers: { host: expectedHost }
    });
    expect(unauthenticated.statusCode).toBe(403);

    const bootstrap = await rawRequest({
      port: gateway.port,
      path: bootstrapPath,
      headers: { host: expectedHost, "sec-fetch-site": "none" }
    });
    expect(bootstrap.statusCode).toBe(303);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(bootstrap.headers.location).toBe(REMOTE_SESSION_READY_PATH);
    expect(bootstrap.headers.location).not.toContain(bootstrapPath);
    expect(bootstrap.headers["x-waifus-csrf"]).toBeUndefined();
    const setCookie = String(bootstrap.headers["set-cookie"]);

    const ready = await rawRequest({
      port: gateway.port,
      path: REMOTE_SESSION_READY_PATH,
      headers: {
        host: expectedHost,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document"
      }
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect(ready.headers.refresh).toBe("0;url=/");
    expect(ready.body).not.toContain(bootstrapPath);

    const replay = await rawRequest({
      port: gateway.port,
      path: bootstrapPath,
      headers: { host: expectedHost, "sec-fetch-site": "none" }
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.headers["cache-control"]).toBe("no-store");

    const authenticated = await rawRequest({
      port: gateway.port,
      path: "/api/status",
      headers: {
        host: expectedHost,
        origin: gateway.origin,
        "sec-fetch-site": "same-origin",
        cookie: setCookie.split(";", 1)[0]
      }
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.headers["access-control-allow-origin"]).toBeUndefined();
    expect(authenticated.headers["content-security-policy"]).toContain("allow-downloads");
    expect(authenticated.headers["content-security-policy"]).not.toContain("allow-popups");
    expect(String(authenticated.headers["set-cookie"])).toContain("SameSite=Strict");
    expect(authenticated.body).not.toContain(gateway.gatewayLaunchId);
    expect(capturedContext).toMatchObject({
      gatewayLaunchId: gateway.gatewayLaunchId,
      method: "GET",
      canonicalTarget: "/api/status",
      csrfValidated: true
    });

    const rebound = await rawRequest({
      port: gateway.port,
      path: "/api/status",
      headers: { host: `evil.example:${gateway.port}`, cookie: setCookie.split(";", 1)[0] }
    });
    expect(rebound.statusCode).toBe(403);
  });

  it("binds without answering until the final hostname and launch registration are ready", async () => {
    let boundPort!: number;
    let reportBound!: () => void;
    const didBind = new Promise<void>((resolve) => {
      reportBound = resolve;
    });
    let releaseHostname!: () => void;
    const hostnameReady = new Promise<void>((resolve) => {
      releaseHostname = resolve;
    });
    const starting = startRemoteGateway({
      port: 0,
      resolveHostnameAfterBind: async (port) => {
        boundPort = port;
        reportBound();
        await hostnameReady;
        return "waifus-staged.localhost";
      }
    });
    await didBind;
    const earlyRequest = rawRequest({
      port: boundPort,
      path: "/api/status",
      headers: { host: `waifus-staged.localhost:${boundPort}` }
    });
    expect(await Promise.race([
      earlyRequest.then(() => "answered"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 30))
    ])).toBe("pending");

    releaseHostname();
    const gateway = await starting;
    gateways.push(gateway);
    expect((await earlyRequest).statusCode).toBe(403);
  });
});

describe("remote gateway origin runtime", () => {
  it("reuses the persisted origin while rotating the launch and session namespace", async () => {
    const root = await makeTempRoot("waifus-gateway-runtime-reuse-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const reservation = await listenBlocker();
    const preferredPort = reservation.port;
    await new Promise<void>((resolve, reject) => {
      reservation.server.close((error) => error ? reject(error) : resolve());
    });
    blockers.splice(blockers.indexOf(reservation.server), 1);
    const hostId = Buffer.alloc(32, 0x71).toString("base64url");
    const store = new RemoteOriginStore(root);
    await store.initializePreferredPort(preferredPort);
    const registrations: Array<{ id: string; expiresAt: string }> = [];
    const start = () => startRemoteGatewayRuntime({
      dataRoot: root,
      pinnedHostId: hostId,
      hostTrustEpoch: "4",
      registerGatewayLaunch: async (id, expiresAt) => {
        registrations.push({ id, expiresAt });
      }
    });

    const first = await start();
    gateways.push(first);
    const firstOrigin = first.origin;
    const firstLaunch = first.gatewayLaunchId;
    await first.close();
    gateways.splice(gateways.indexOf(first), 1);

    const second = await start();
    gateways.push(second);
    expect(second.origin).toBe(firstOrigin);
    expect(second.originBinding.localOriginEpoch).toBe("1");
    expect(second.gatewayLaunchId).not.toBe(firstLaunch);
    expect(registrations).toHaveLength(2);
    expect(registrations[0].id).toBe(firstLaunch);
    expect(registrations[1].id).toBe(second.gatewayLaunchId);
  });

  it("rotates the origin only after a replacement listener binds when the preferred port is busy", async () => {
    const root = await makeTempRoot("waifus-gateway-runtime-failover-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const blocked = await listenBlocker();
    const hostId = Buffer.alloc(32, 0x72).toString("base64url");
    const store = new RemoteOriginStore(root);
    await store.initializePreferredPort(blocked.port);
    let registered = false;
    const gateway = await startRemoteGatewayRuntime({
      dataRoot: root,
      pinnedHostId: hostId,
      hostTrustEpoch: "5",
      registerGatewayLaunch: async (gatewayLaunchId, expiresAt) => {
        expect(Buffer.from(gatewayLaunchId, "base64url")).toHaveLength(32);
        expect(BigInt(expiresAt)).toBeGreaterThan(0n);
        registered = true;
      }
    });
    gateways.push(gateway);

    expect(registered).toBe(true);
    expect(gateway.port).not.toBe(blocked.port);
    expect(gateway.originBinding).toMatchObject({
      pinnedHostId: hostId,
      hostTrustEpoch: "5",
      localOriginEpoch: "2",
      port: gateway.port,
      hostname: gateway.hostname,
      origin: gateway.origin
    });
    expect(await store.getState()).toMatchObject({
      originEpochHighWater: "2",
      preferredPort: gateway.port
    });
  });
});
