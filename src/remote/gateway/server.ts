import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { BrowserPersistence } from "./browserPersistence.js";
import { BrowserProofStore, BrowserPublicKeySchema } from "./browserProof.js";
import { ResourceLockManager } from "../../storage/locks.js";
import { z } from "zod";
import fastify, {
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import type { RemoteBrowserContextV1 } from "../../shared/schemas/remoteProtocol.js";
import { installUpdateActivity, type UpdateActivity } from "../../backend/updates/activity.js";
import { createRemoteBrowserContext } from "./browserContext.js";
import {
  DASHBOARD_SECURITY_HEADERS,
  RemoteBrowserRequestError,
  SHELL_SECURITY_HEADERS,
  dashboardSecurityHeaders,
  frameShellSecurityHeaders,
  validateRemoteBootstrapRequest,
  validateRemoteBrowserRequest,
  validateRemoteBrowserRecoveryRequest,
  type RemoteBrowserRequest
} from "./security.js";
import {
  RemoteBrowserSessionStore,
  REMOTE_SESSION_LIFETIME_SENTINEL_MS,
  type RemoteBrowserSession,
  type RemoteBrowserSessionStoreOptions
} from "./session.js";

export type RemoteGatewaySurface = "dashboard" | "frame_shell" | "shell";
export const REMOTE_SESSION_READY_PATH = "/_waifus_remote/session-ready";

export type RemoteGatewayHandlerSecurity = Readonly<{
  session: Readonly<{
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  }>;
  responseSecurityHeaders: Readonly<Record<string, string>>;
  deliverCsrf: () => void;
}>;

type RemoteGatewayOriginSelection =
  | {
      readonly hostname: string;
      readonly resolveHostnameAfterBind?: never;
    }
  | {
      readonly hostname?: never;
      readonly resolveHostnameAfterBind: (port: number) => string | Promise<string>;
    };

export type StartRemoteGatewayOptions = RemoteBrowserSessionStoreOptions & RemoteGatewayOriginSelection & {
  readonly updateActivity?: UpdateActivity;
  readonly port: number;
  readonly surface?: RemoteGatewaySurface;
  readonly frameAncestorOrigin?: string | (() => string | undefined);
  readonly frameChildOrigin?: string;
  readonly bootstrapRedirectPath?: string;
  readonly browserPersistence?: BrowserPersistence;
  /** Static trusted frame HTML/JS only; never host data or credentials. */
  readonly handlePublicFrameRequest?: (target: string) => Readonly<{ type: string; body: string }>;
  readonly launcher?: Readonly<{ token: string; open: (setup: boolean) => string }>;
  readonly beforeExpose?: (launch: Readonly<{
    hostname: string;
    port: number;
    gatewayLaunchId: string;
    expiresAt: string;
  }>) => void | Promise<void>;
  readonly handleAuthenticatedRequest?: (
    request: FastifyRequest,
    reply: FastifyReply,
    browserContext: RemoteBrowserContextV1,
    security: RemoteGatewayHandlerSecurity
  ) => unknown | Promise<unknown>;
};

export type RunningRemoteGateway = Readonly<{
  hostname: string;
  port: number;
  origin: string;
  bootstrapUrl: string;
  gatewayLaunchId: string;
  expiresAt: string;
  address: AddressInfo;
  issueBootstrapUrl: (redirectPath?: string) => string;
  invalidateBrowserSessions: () => Promise<void>;
  close: () => Promise<void>;
}>;

function browserRequest(request: FastifyRequest): RemoteBrowserRequest {
  return {
    method: request.method,
    canonicalTarget: request.raw.url ?? request.url,
    headers: request.headers,
    body: request.body
  };
}

function validateHostname(hostname: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/u.test(hostname)) {
    throw new TypeError("Remote gateway hostname must be one lowercase .localhost name.");
  }
  return hostname;
}

function removeHostControlledSecurityHeaders(reply: FastifyReply): void {
  for (const name of Object.keys(reply.getHeaders())) {
    const normalized = name.toLowerCase();
    if (
      normalized === "content-security-policy"
      || normalized === "content-security-policy-report-only"
      || normalized === "permissions-policy"
      || normalized === "referrer-policy"
      || normalized === "service-worker-allowed"
      || normalized.startsWith("access-control-")
    ) {
      reply.removeHeader(name);
    }
  }
}

export async function startRemoteGateway(
  options: StartRemoteGatewayOptions
): Promise<RunningRemoteGateway> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError("Remote gateway port must be an integer from 0 through 65535.");
  }
  if (options.surface === "frame_shell" && options.frameChildOrigin === undefined) {
    throw new TypeError("A dashboard frame shell requires one exact dashboard origin.");
  }
  if (options.surface !== "frame_shell" && options.frameChildOrigin !== undefined) {
    throw new TypeError("Only a dashboard frame shell may declare a child frame origin.");
  }
  if (options.hostname !== undefined) validateHostname(options.hostname);
  const redirectPath = options.bootstrapRedirectPath ?? REMOTE_SESSION_READY_PATH;
  if (!redirectPath.startsWith("/") || redirectPath.startsWith("//")) {
    throw new TypeError("Remote gateway bootstrap redirect must be an origin-form path.");
  }

  const sessions = new RemoteBrowserSessionStore(options);
  const proofs = new BrowserProofStore(options.now);
  const proofLock = new ResourceLockManager();
  const bootstrapRedirects = new Map<string, { path: string; expires: number }>();
  const app = fastify({ logger: false, forceCloseConnections: true });
  if (options.updateActivity) installUpdateActivity(app, options.updateActivity);
  if (options.surface === undefined || options.surface === "dashboard") {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
  }
  let securityOptions: { expectedAuthority: string; expectedOrigin: string } | undefined;
  let expose!: () => void;
  let rejectExposure!: (error: Error) => void;
  const exposure = new Promise<void>((resolve, reject) => {
    expose = resolve;
    rejectExposure = reject;
  });
  void exposure.catch(() => undefined);
  const refreshedSessions = new WeakMap<FastifyRequest, RemoteBrowserSession>();
  const responsePolicy = (): Readonly<Record<string, string>> => {
    const frameAncestorOrigin = typeof options.frameAncestorOrigin === "function"
      ? options.frameAncestorOrigin()
      : options.frameAncestorOrigin;
    if (options.surface === "shell") return SHELL_SECURITY_HEADERS;
    if (options.surface === "frame_shell") {
      if (!securityOptions) throw new Error("Dashboard frame shell origin is unavailable.");
      return frameShellSecurityHeaders(options.frameChildOrigin!, securityOptions.expectedOrigin);
    }
    if (!frameAncestorOrigin) return DASHBOARD_SECURITY_HEADERS;
    if (!securityOptions) throw new Error("Dashboard gateway origin is unavailable.");
    return dashboardSecurityHeaders(frameAncestorOrigin, securityOptions.expectedOrigin);
  };

  app.addHook("onRequest", async () => exposure);

  app.addHook("onSend", async (request, reply, payload) => {
    removeHostControlledSecurityHeaders(reply);
    const policy = responsePolicy();
    for (const [name, value] of Object.entries(policy)) reply.header(name, value);
    if (reply.getHeader("cache-control") === undefined) reply.header("cache-control", "no-store");
    const session = refreshedSessions.get(request);
    const cookie = session ? sessions.sessionCookieHeaderIfActive(session) : undefined;
    if (cookie) reply.header("set-cookie", cookie);
    return payload;
  });

  const bootstrapPrefix = "/_waifus_remote/bootstrap/";
  if (options.launcher && options.surface === "shell") app.post("/_waifus_remote/launcher", async (request, reply) => {
    const token = request.headers["x-waifus-launcher"];
    const expected = Buffer.from(options.launcher!.token);
    const supplied = typeof token === "string" ? Buffer.from(token) : Buffer.alloc(0);
    if (!securityOptions || request.headers.host !== securityOptions.expectedAuthority
      || request.headers.origin !== undefined || request.headers.referer !== undefined
      || request.headers["sec-fetch-site"] !== undefined || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)) return reply.code(403).send({ error: "Forbidden" });
    const body = request.body as { setup?: unknown } | null;
    if (!body || Object.keys(body).join(",") !== "setup" || typeof body.setup !== "boolean") {
      return reply.code(400).send({ error: "InvalidRequest" });
    }
    return reply.header("cache-control", "no-store").send({ url: options.launcher!.open(body.setup) });
  });
  app.get(`${bootstrapPrefix}:token`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!securityOptions) return reply.code(503).send({ error: "Unavailable" });
    try {
      validateRemoteBootstrapRequest(browserRequest(request), securityOptions);
    } catch {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const token = (request.params as { token?: string }).token ?? "";
    const session = sessions.consumeBootstrapToken(token);
    if (!session) return reply.code(404).send({ error: "Not Found" });
    reply.header("set-cookie", sessions.sessionCookieHeader(session));
    const destination = bootstrapRedirects.get(token)?.path ?? redirectPath;
    bootstrapRedirects.delete(token);
    return reply.code(303).header("location", destination).send();
  });

  if (options.browserPersistence) {
    app.get("/_waifus_remote/browser-challenge/:keyId", async (request, reply) => {
      if (!securityOptions) return reply.code(503).send({ error: "Unavailable" });
      try { validateRemoteBrowserRecoveryRequest(browserRequest(request), securityOptions); }
      catch { return reply.code(403).send({ error: "Forbidden" }); }
      const keyId = (request.params as { keyId: string }).keyId;
      const challenge = /^[a-f0-9]{64}$/u.test(keyId) ? proofs.challenge(keyId) : undefined;
      return challenge ? reply.send({ challenge }) : reply.code(403).send({ error: "Forbidden" });
    });
    app.post("/_waifus_remote/browser-resume", async (request, reply) => {
      if (!securityOptions) return reply.code(503).send({ error: "Unavailable" });
      try { validateRemoteBrowserRecoveryRequest(browserRequest(request), securityOptions); }
      catch { return reply.code(403).send({ error: "Forbidden" }); }
      if (!proofs.consume(request.body)) return reply.code(403).send({ error: "Forbidden" });
      const session = sessions.consumeBootstrapToken(sessions.issueBootstrapToken());
      if (!session) return reply.code(503).send({ error: "Unavailable" });
      return reply.header("set-cookie", sessions.sessionCookieHeader(session)).code(204).send();
    });
  }
  if (options.surface === "frame_shell" && options.handlePublicFrameRequest) {
    for (const target of ["/", "/_waifus_remote/frame-session.js"]) app.get(target, async (request, reply) => {
      if (!securityOptions) return reply.code(503).send({ error: "Unavailable" });
      try {
        if (target === "/") validateRemoteBootstrapRequest(browserRequest(request), securityOptions);
        else validateRemoteBrowserRecoveryRequest(browserRequest(request), securityOptions);
      } catch { return reply.code(403).send({ error: "Forbidden" }); }
      const staticContent = options.handlePublicFrameRequest!(target);
      return reply.type(staticContent.type).send(staticContent.body);
    });
  }

  app.get(REMOTE_SESSION_READY_PATH, async (request, reply) => {
    if (!securityOptions) return reply.code(503).send({ error: "Unavailable" });
    try {
      validateRemoteBootstrapRequest(browserRequest(request), securityOptions);
    } catch {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("cache-control", "no-store");
    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("refresh", "0;url=/");
    return reply.send(
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url=/\"><title>Opening Waifus</title></head><body></body></html>"
    );
  });

  app.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    handler: async (request, reply) => {
      if (!securityOptions) return reply.code(503).send({ error: "Unavailable" });
      const session = sessions.sessionFromCookie(
        typeof request.headers.cookie === "string" ? request.headers.cookie : undefined
      );
      if (!session) return reply.code(403).send({ error: "Forbidden" });
      if (
        options.surface !== "shell"
        && (request.raw.url ?? request.url).split("?", 1)[0].startsWith("/_waifus_remote/v1/")
      ) {
        return reply.code(404).send({ error: "NotFound" });
      }
      try {
        const validated = validateRemoteBrowserRequest(
          browserRequest(request),
          session,
          securityOptions
        );
        const refreshed = sessions.commitValidated(session);
        if (!refreshed) return reply.code(403).send({ error: "Forbidden" });
        refreshedSessions.set(request, refreshed);
        const context = createRemoteBrowserContext(refreshed, validated, {
          randomBytes: options.randomBytes
        });
        const handlerSecurity: RemoteGatewayHandlerSecurity = Object.freeze({
          session: Object.freeze({
            idleExpiresAt: BigInt(Math.floor(refreshed.idleExpiresAt / 1_000)).toString(),
            absoluteExpiresAt: BigInt(Math.floor(refreshed.absoluteExpiresAt / 1_000)).toString()
          }),
          responseSecurityHeaders: Object.freeze({ ...responsePolicy() }),
          deliverCsrf: () => {
            reply.header("x-waifus-csrf", refreshed.csrfToken);
          }
        });
        if (options.browserPersistence && request.method === "POST" && request.url === "/_waifus_remote/browser-register") {
          const parsed = z.object({ publicKey: BrowserPublicKeySchema }).strict().safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ error: "InvalidRequest" });
          return proofLock.withLock("browser-keys", async () => {
            if (!sessions.sessionCookieHeaderIfActive(refreshed)) return reply.code(403).send({ error: "Forbidden" });
            const previous = proofs.snapshot();
            try {
              const keyId = proofs.register(parsed.data.publicKey);
              await options.browserPersistence!.save(securityOptions!.expectedOrigin, proofs.snapshot());
              return reply.send({ keyId });
            } catch {
              proofs.restore(previous);
              return reply.code(503).send({ error: "Unavailable" });
            }
          });
        }
        const refreshedCookie = sessions.sessionCookieHeaderIfActive(refreshed);
        if (refreshedCookie) reply.header("set-cookie", refreshedCookie);
        const result = options.handleAuthenticatedRequest
          ? await options.handleAuthenticatedRequest(request, reply, context, handlerSecurity)
          : undefined;
        if (reply.sent) return;
        if (result === undefined) return reply.code(404).send({ error: "Not Found" });
        return reply.send(result);
      } catch (error) {
        if (error instanceof RemoteBrowserRequestError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw error;
      }
    }
  });

  try {
    await app.listen({ host: "127.0.0.1", port: options.port });
  } catch (error) {
    sessions.close();
    await app.close().catch(() => undefined);
    throw error;
  }
  const address = app.server.address();
  if (!address || typeof address === "string") {
    sessions.close();
    await app.close();
    throw new Error("Remote gateway did not expose an IPv4 loopback address.");
  }
  const port = address.port;
  let hostname: string;
  try {
    hostname = validateHostname(
      options.hostname ?? await options.resolveHostnameAfterBind(port)
    );
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectExposure(failure);
    sessions.close();
    await app.close();
    throw failure;
  }
  const expectedAuthority = `${hostname}:${port}`;
  const origin = `http://${expectedAuthority}`;
  securityOptions = { expectedAuthority, expectedOrigin: origin };
  const expiresAt = BigInt(Math.floor(
    REMOTE_SESSION_LIFETIME_SENTINEL_MS / 1_000
  )).toString();
  let bootstrapToken: string;
  try {
    const saved = await options.browserPersistence?.load(origin);
    if (saved) proofs.restore(saved);
    await options.beforeExpose?.({
      hostname,
      port,
      gatewayLaunchId: sessions.gatewayLaunchId,
      expiresAt
    });
    bootstrapToken = sessions.issueBootstrapToken();
    expose();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectExposure(failure);
    sessions.close();
    await app.close();
    throw failure;
  }
  let closed = false;
  return Object.freeze({
    hostname,
    port,
    origin,
    bootstrapUrl: `${origin}${bootstrapPrefix}${bootstrapToken}`,
    gatewayLaunchId: sessions.gatewayLaunchId,
    expiresAt,
    address: Object.freeze({ ...address }),
    issueBootstrapUrl: (destination = redirectPath) => {
      if (closed) throw new Error("Remote gateway is closed.");
      if (destination !== redirectPath && destination !== "/#setup" && destination !== "/_waifus_remote/launch") {
        throw new TypeError("Unsupported browser launch destination.");
      }
      const now = (options.now ?? Date.now)();
      for (const [key, value] of bootstrapRedirects) if (value.expires <= now) bootstrapRedirects.delete(key);
      const token = sessions.issueBootstrapToken();
      bootstrapRedirects.set(token, { path: destination, expires: now + 5 * 60_000 });
      return `${origin}${bootstrapPrefix}${token}`;
    },
    invalidateBrowserSessions: async () => {
      await proofLock.withLock("browser-keys", async () => {
        sessions.invalidateAll();
        proofs.clear();
        await options.browserPersistence?.clear(origin);
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      sessions.close();
      await app.close();
    }
  });
}
