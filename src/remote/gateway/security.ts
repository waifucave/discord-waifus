import { timingSafeEqual } from "node:crypto";
import {
  CanonicalTargetSchema,
  HttpMethodSchema,
  type HttpMethod
} from "../../shared/schemas/remoteProtocol.js";
import type { RemoteBrowserSession } from "./session.js";

export type RemoteBrowserRequestHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export type RemoteBrowserRequest = Readonly<{
  method: string;
  canonicalTarget: string;
  headers: RemoteBrowserRequestHeaders;
  body?: unknown;
}>;

export type RemoteBrowserSecurityOptions = Readonly<{
  expectedAuthority: string;
  expectedOrigin: string;
}>;

export type ValidatedRemoteBrowserRequest = Readonly<{
  method: HttpMethod;
  canonicalTarget: string;
  csrfValidated: true;
}>;

export type RemoteBrowserRequestErrorCode =
  | "browser_cookie_invalid"
  | "browser_context_forged"
  | "browser_csrf_invalid"
  | "browser_fetch_metadata_invalid"
  | "browser_header_forged"
  | "browser_host_invalid"
  | "browser_origin_invalid"
  | "browser_request_invalid";

export class RemoteBrowserRequestError extends Error {
  constructor(
    readonly code: RemoteBrowserRequestErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RemoteBrowserRequestError";
  }
}

const SAFE_METHODS = new Set<HttpMethod>(["GET", "HEAD"]);
const FORGED_CONTEXT_BODY_FIELDS = new Set([
  "browserSessionId",
  "csrfValidated",
  "directRequestId",
  "directStreamId",
  "gatewayLaunchId",
  "helperMac",
  "remoteParentStreamId",
  "requestNonce",
  "verifiedBy"
]);
const DASHBOARD_CSP = [
  "sandbox allow-scripts allow-forms allow-same-origin allow-downloads",
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "worker-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");
const SHELL_CSP = DASHBOARD_CSP.replace(
  "sandbox allow-scripts allow-forms allow-same-origin allow-downloads",
  "sandbox allow-scripts allow-forms allow-same-origin allow-downloads allow-popups"
);

const COMMON_SECURITY_HEADERS = {
  "permissions-policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
} as const;

export const DASHBOARD_SECURITY_HEADERS = Object.freeze({
  ...COMMON_SECURITY_HEADERS,
  "content-security-policy": DASHBOARD_CSP
});

export const SHELL_SECURITY_HEADERS = Object.freeze({
  ...COMMON_SECURITY_HEADERS,
  "content-security-policy": SHELL_CSP
});

function fail(code: RemoteBrowserRequestErrorCode, message: string): never {
  throw new RemoteBrowserRequestError(code, message);
}

function normalizedHeaders(headers: RemoteBrowserRequestHeaders): Map<string, readonly string[]> {
  const normalized = new Map<string, readonly string[]>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (normalized.has(name)) {
      return fail("browser_request_invalid", "Browser request repeats a security-sensitive header.");
    }
    normalized.set(name, typeof rawValue === "string" ? [rawValue] : rawValue);
  }
  return normalized;
}

function singleton(
  headers: ReadonlyMap<string, readonly string[]>,
  name: string
): string | undefined {
  const values = headers.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) {
    return fail("browser_request_invalid", `Browser request header ${name} must occur once.`);
  }
  return values[0];
}

function isInternalHeader(name: string): boolean {
  return name.startsWith("x-device-")
    || name.startsWith("x-waifus-principal")
    || name.startsWith("x-waifus-internal")
    || name.startsWith("x-waifus-actor")
    || name.startsWith("x-waifus-browser-context")
    || name.startsWith("x-waifus-helper")
    || name.startsWith("x-waifus-gateway-")
    || name.startsWith("x-waifus-browser-session")
    || name.startsWith("x-waifus-request-nonce");
}

function tokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.byteLength === 32
    && rightBytes.byteLength === 32
    && leftBytes.toString("base64url") === left
    && rightBytes.toString("base64url") === right
    && timingSafeEqual(leftBytes, rightBytes);
}

function containsForgedContextBodyField(value: unknown): boolean {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return false;
  const pending: object[] = [value];
  const visited = new Set<object>();
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    inspected += 1;
    if (inspected > 10_000) return true;
    for (const [key, nested] of Object.entries(current)) {
      if (FORGED_CONTEXT_BODY_FIELDS.has(key)) return true;
      if (nested !== null && typeof nested === "object" && !(nested instanceof Uint8Array)) {
        pending.push(nested);
      }
    }
  }
  return false;
}

function cookieMatches(cookieHeader: string | undefined, session: RemoteBrowserSession): boolean {
  if (!cookieHeader) return false;
  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === session.sessionCookieName) {
      matches.push(part.slice(separator + 1).trim());
    }
  }
  return matches.length === 1 && tokenEqual(matches[0], session.browserSessionId);
}

function validateEnvelope(
  request: RemoteBrowserRequest,
  options: RemoteBrowserSecurityOptions
): { method: HttpMethod; canonicalTarget: string; headers: Map<string, readonly string[]> } {
  const methodResult = HttpMethodSchema.safeParse(request.method);
  const targetResult = CanonicalTargetSchema.safeParse(request.canonicalTarget);
  if (!methodResult.success || !targetResult.success) {
    return fail("browser_request_invalid", "Browser method or request target is invalid.");
  }
  const headers = normalizedHeaders(request.headers);
  if (containsForgedContextBodyField(request.body)) {
    return fail(
      "browser_context_forged",
      "Browser-supplied internal identity fields are forbidden in request bodies."
    );
  }
  for (const name of headers.keys()) {
    if (isInternalHeader(name)) {
      return fail("browser_header_forged", "Browser-supplied internal identity fields are forbidden.");
    }
  }
  const host = singleton(headers, "host");
  if (!host || host.toLowerCase() !== options.expectedAuthority.toLowerCase()) {
    return fail("browser_host_invalid", "Browser Host does not match the isolated local origin.");
  }
  const origin = singleton(headers, "origin");
  if (origin !== undefined && origin !== options.expectedOrigin) {
    return fail("browser_origin_invalid", "Browser Origin does not match the isolated local origin.");
  }
  const fetchSite = singleton(headers, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return fail("browser_fetch_metadata_invalid", "Cross-site browser requests are forbidden.");
  }
  if (!SAFE_METHODS.has(methodResult.data)) {
    if (origin !== options.expectedOrigin) {
      return fail("browser_origin_invalid", "Browser mutations require the exact isolated origin.");
    }
    if (fetchSite === "none") {
      return fail("browser_fetch_metadata_invalid", "Top-level cross-context mutations are forbidden.");
    }
  }
  return { method: methodResult.data, canonicalTarget: targetResult.data, headers };
}

export function validateRemoteBootstrapRequest(
  request: RemoteBrowserRequest,
  options: RemoteBrowserSecurityOptions
): ValidatedRemoteBrowserRequest {
  const validated = validateEnvelope(request, options);
  if (validated.method !== "GET") {
    return fail("browser_request_invalid", "Remote bootstrap accepts only GET.");
  }
  return Object.freeze({
    method: validated.method,
    canonicalTarget: validated.canonicalTarget,
    csrfValidated: true as const
  });
}

export function validateRemoteBrowserRequest(
  request: RemoteBrowserRequest,
  session: RemoteBrowserSession,
  options: RemoteBrowserSecurityOptions
): ValidatedRemoteBrowserRequest {
  const validated = validateEnvelope(request, options);
  if (!cookieMatches(singleton(validated.headers, "cookie"), session)) {
    return fail("browser_cookie_invalid", "Remote browser session cookie is missing or invalid.");
  }
  if (!SAFE_METHODS.has(validated.method)) {
    const csrf = singleton(validated.headers, "x-waifus-csrf");
    if (!csrf || !tokenEqual(csrf, session.csrfToken)) {
      return fail("browser_csrf_invalid", "Remote browser CSRF validation failed.");
    }
  }
  return Object.freeze({
    method: validated.method,
    canonicalTarget: validated.canonicalTarget,
    csrfValidated: true as const
  });
}
