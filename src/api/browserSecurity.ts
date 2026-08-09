import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  HttpMethodSchema
} from "../shared/schemas/remoteProtocol.js";
import { ApiError } from "./errors.js";
import {
  createLocalRequestPrincipal,
  parseRequestPrincipal,
  remoteBrowserContextWire,
  type LocalRequestPrincipal,
  type RequestPrincipal
} from "./requestPrincipal.js";

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const MAX_BROWSER_SESSIONS = 1_024;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

type BrowserMode = "start" | "dev" | "test";

export type BrowserSecurityOptions = {
  listenerHost: string;
  port: number;
  mode: BrowserMode;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
};

type BrowserSession = {
  readonly id: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
};

function forbidden(code: string, message: string): ApiError {
  return new ApiError(403, message, undefined, code);
}

function authority(host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${normalizedHost}:${port}`).host;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function isCanonicalToken(value: string): boolean {
  return Base64Url32BytesSchema.safeParse(value).success;
}

function requestTarget(request: FastifyRequest): string {
  return CanonicalTargetSchema.parse(request.raw.url ?? request.url);
}

function isBrowserSignal(request: FastifyRequest): boolean {
  return request.headers.origin !== undefined
    || request.headers.cookie !== undefined
    || request.headers["x-waifus-csrf"] !== undefined
    // Node's built-in fetch also sends Sec-Fetch-Mode. Sec-Fetch-Site is the browser signal
    // needed for same-origin enforcement without breaking legitimate loopback automation.
    || request.headers["sec-fetch-site"] !== undefined;
}

export class BrowserSecurity {
  readonly hostServerLaunchId: string;
  readonly sessionCookieName: string;
  readonly expectedAuthority: string;
  readonly allowedOrigins: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(options: BrowserSecurityOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? randomBytes;
    this.hostServerLaunchId = Buffer.from(this.random(32)).toString("base64url");
    this.sessionCookieName = `waifus_host_session_${Buffer.from(this.random(8)).toString("hex")}`;
    this.expectedAuthority = authority(options.listenerHost, options.port);
    const effectiveOrigin = `http://${this.expectedAuthority}`;
    this.allowedOrigins = new Set([
      effectiveOrigin,
      ...(options.mode === "dev"
        ? ["http://127.0.0.1:5173", "http://localhost:5173"]
        : [])
    ]);
    Base64Url32BytesSchema.parse(this.hostServerLaunchId);
  }

  authenticateRequest(
    request: FastifyRequest,
    principalInput: RequestPrincipal,
    internal: boolean
  ): RequestPrincipal {
    const principal = parseRequestPrincipal(principalInput);
    if (principal.browserContext) {
      const context = principal.kind === "remote_device"
        ? remoteBrowserContextWire(principal.browserContext)
        : principal.browserContext;
      if (context.method !== request.method || context.canonicalTarget !== requestTarget(request)) {
        throw forbidden("BrowserContextMismatch", "Browser request context does not match the request.");
      }
      if (!SAFE_METHODS.has(request.method) && !context.csrfValidated) {
        throw forbidden("CsrfInvalid", "Unsafe browser request was not CSRF validated.");
      }
      return principal;
    }

    if (internal) {
      if (isBrowserSignal(request)) {
        throw forbidden("BrowserContextRequired", "Forwarded browser request lacks verified context.");
      }
      return principal;
    }
    if (principal.kind !== "local" || !isBrowserSignal(request)) return principal;

    this.validateBrowserHeaders(request);
    const session = this.currentSession(request);
    if (!SAFE_METHODS.has(request.method)) {
      if (!session) {
        throw forbidden("BrowserSessionRequired", "Browser session is missing or expired.");
      }
      const suppliedCsrf = headerValue(request, "x-waifus-csrf");
      if (!suppliedCsrf || !isCanonicalToken(suppliedCsrf) || !this.matchesToken(session.csrfToken, suppliedCsrf)) {
        throw forbidden("CsrfInvalid", "CSRF validation failed.");
      }
      this.refresh(session);
      return this.localBrowserPrincipal(request, session, true);
    }
    if (!session) return principal;
    this.refresh(session);
    return this.localBrowserPrincipal(request, session, false);
  }

  establishClientContext(request: FastifyRequest, reply: FastifyReply): LocalRequestPrincipal {
    if (isBrowserSignal(request)) this.validateBrowserHeaders(request);
    const session = this.currentSession(request) ?? this.createSession();
    this.refresh(session);
    const remainingSeconds = Math.max(
      1,
      Math.floor((Math.min(session.idleExpiresAt, session.absoluteExpiresAt) - this.now()) / 1000)
    );
    reply.header(
      "set-cookie",
      `${this.sessionCookieName}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remainingSeconds}`
    );
    reply.header("x-waifus-csrf", session.csrfToken);
    reply.header("cache-control", "no-store");
    return this.localBrowserPrincipal(request, session, false);
  }

  refreshResponseCookie(
    request: FastifyRequest,
    reply: FastifyReply,
    principal: RequestPrincipal | undefined
  ): void {
    if (reply.hasHeader("set-cookie") || principal?.kind !== "local" || !principal.browserContext) {
      return;
    }
    const session = this.sessions.get(principal.browserContext.browserSessionId);
    if (!session || !this.currentSession(request)) return;
    const remainingSeconds = Math.max(
      1,
      Math.floor((Math.min(session.idleExpiresAt, session.absoluteExpiresAt) - this.now()) / 1000)
    );
    reply.header(
      "set-cookie",
      `${this.sessionCookieName}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remainingSeconds}`
    );
  }

  private validateBrowserHeaders(request: FastifyRequest): void {
    const host = headerValue(request, "host")?.toLowerCase();
    if (host !== this.expectedAuthority.toLowerCase()) {
      throw forbidden("BrowserHostInvalid", "Browser Host is not the effective loopback authority.");
    }
    const origin = headerValue(request, "origin");
    if (origin !== undefined && !this.allowedOrigins.has(origin)) {
      throw forbidden("BrowserOriginInvalid", "Browser Origin is not allowed.");
    }
    const fetchSite = headerValue(request, "sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw forbidden("CrossSiteRequest", "Cross-site browser requests are forbidden.");
    }
  }

  private createSession(): BrowserSession {
    this.pruneExpired();
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new ApiError(503, "Browser session capacity is exhausted.", undefined, "BrowserSessionCapacity");
    }
    const createdAt = this.now();
    const session = {
      id: Buffer.from(this.random(32)).toString("base64url"),
      csrfToken: Buffer.from(this.random(32)).toString("base64url"),
      createdAt,
      idleExpiresAt: createdAt + SESSION_IDLE_MS,
      absoluteExpiresAt: createdAt + SESSION_ABSOLUTE_MS
    };
    Base64Url32BytesSchema.parse(session.id);
    Base64Url32BytesSchema.parse(session.csrfToken);
    this.sessions.set(session.id, session);
    return session;
  }

  private currentSession(request: FastifyRequest): BrowserSession | undefined {
    const ids = this.cookieValues(headerValue(request, "cookie"));
    if (ids.length !== 1 || !isCanonicalToken(ids[0])) return undefined;
    const session = this.sessions.get(ids[0]);
    if (!session) return undefined;
    const now = this.now();
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      this.sessions.delete(session.id);
      return undefined;
    }
    return session;
  }

  private cookieValues(cookieHeader: string | undefined): string[] {
    if (!cookieHeader) return [];
    const values: string[] = [];
    for (const part of cookieHeader.split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1) continue;
      const name = part.slice(0, separator).trim();
      if (name === this.sessionCookieName) values.push(part.slice(separator + 1).trim());
    }
    return values;
  }

  private refresh(session: BrowserSession): void {
    session.idleExpiresAt = Math.min(this.now() + SESSION_IDLE_MS, session.absoluteExpiresAt);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
        this.sessions.delete(id);
      }
    }
  }

  private matchesToken(expected: string, supplied: string): boolean {
    const expectedBytes = Buffer.from(expected, "base64url");
    const suppliedBytes = Buffer.from(supplied, "base64url");
    return expectedBytes.byteLength === suppliedBytes.byteLength
      && timingSafeEqual(expectedBytes, suppliedBytes);
  }

  private localBrowserPrincipal(
    request: FastifyRequest,
    session: BrowserSession,
    csrfValidated: boolean
  ): LocalRequestPrincipal {
    return createLocalRequestPrincipal({
      verifiedBy: "host_server",
      hostServerLaunchId: Base64Url32BytesSchema.parse(this.hostServerLaunchId),
      browserSessionId: Base64Url32BytesSchema.parse(session.id),
      requestNonce: Buffer.from(this.random(16)).toString("base64url") as never,
      method: HttpMethodSchema.parse(request.method),
      canonicalTarget: CanonicalTargetSchema.parse(requestTarget(request)),
      csrfValidated
    });
  }
}
