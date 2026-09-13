import type { AddressInfo } from "node:net";
import fastify, {
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import type { RemoteBrowserContextV1 } from "../../shared/schemas/remoteProtocol.js";
import { createRemoteBrowserContext } from "./browserContext.js";
import {
  DASHBOARD_SECURITY_HEADERS,
  RemoteBrowserRequestError,
  SHELL_SECURITY_HEADERS,
  validateRemoteBootstrapRequest,
  validateRemoteBrowserRequest,
  type RemoteBrowserRequest
} from "./security.js";
import {
  RemoteBrowserSessionStore,
  type RemoteBrowserSession,
  type RemoteBrowserSessionStoreOptions
} from "./session.js";

export type RemoteGatewaySurface = "dashboard" | "shell";

export type RemoteGatewayHandlerSecurity = Readonly<{
  session: Readonly<{
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  }>;
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
  readonly port: number;
  readonly surface?: RemoteGatewaySurface;
  readonly bootstrapRedirectPath?: string;
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
  if (options.hostname !== undefined) validateHostname(options.hostname);
  const redirectPath = options.bootstrapRedirectPath ?? "/";
  if (!redirectPath.startsWith("/") || redirectPath.startsWith("//")) {
    throw new TypeError("Remote gateway bootstrap redirect must be an origin-form path.");
  }

  const sessions = new RemoteBrowserSessionStore(options);
  const app = fastify({ logger: false });
  let securityOptions: { expectedAuthority: string; expectedOrigin: string } | undefined;
  let expose!: () => void;
  let rejectExposure!: (error: Error) => void;
  const exposure = new Promise<void>((resolve, reject) => {
    expose = resolve;
    rejectExposure = reject;
  });
  void exposure.catch(() => undefined);
  const policy = options.surface === "shell" ? SHELL_SECURITY_HEADERS : DASHBOARD_SECURITY_HEADERS;
  const refreshedSessions = new WeakMap<FastifyRequest, RemoteBrowserSession>();

  app.addHook("onRequest", async () => exposure);

  app.addHook("onSend", async (request, reply, payload) => {
    removeHostControlledSecurityHeaders(reply);
    for (const [name, value] of Object.entries(policy)) reply.header(name, value);
    const session = refreshedSessions.get(request);
    const cookie = session ? sessions.sessionCookieHeaderIfActive(session) : undefined;
    if (cookie) reply.header("set-cookie", cookie);
    return payload;
  });

  const bootstrapPrefix = "/_waifus_remote/bootstrap/";
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
    return reply.code(303).header("location", redirectPath).send();
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
          deliverCsrf: () => {
            reply.header("x-waifus-csrf", refreshed.csrfToken);
          }
        });
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
    ((options.now?.() ?? Date.now()) + 8 * 60 * 60 * 1_000) / 1_000
  )).toString();
  let bootstrapToken: string;
  try {
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
    close: async () => {
      if (closed) return;
      closed = true;
      sessions.close();
      await app.close();
    }
  });
}
