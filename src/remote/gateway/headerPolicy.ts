import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { RemoteHeaderTuple } from "../../backend/remoteAccess/bridgeProtocol.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const BROWSER_LOCAL_REQUEST = new Set([
  "cookie",
  "host",
  "origin",
  "referer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-waifus-csrf"
]);

const HOST_POLICY_RESPONSE = new Set([
  "accept-ch",
  "alt-svc",
  "cache-control",
  "clear-site-data",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "critical-ch",
  "etag",
  "expires",
  "last-modified",
  "nel",
  "origin-agent-cluster",
  "permissions-policy",
  "referrer-policy",
  "refresh",
  "report-to",
  "reporting-endpoints",
  "service-worker-allowed",
  "set-cookie",
  "vary",
  "x-frame-options"
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/u;

export class RemoteGatewayHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteGatewayHeaderError";
  }
}

function internalHeader(name: string): boolean {
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

function assertHeader(name: string, value: string): void {
  if (!HEADER_NAME_PATTERN.test(name) || !HEADER_VALUE_PATTERN.test(value)) {
    throw new RemoteGatewayHeaderError("Remote HTTP header is invalid.");
  }
}

function connectionHeaderTokens(values: readonly string[]): ReadonlySet<string> {
  const output = new Set<string>();
  for (const value of values) {
    for (const rawToken of value.split(",")) {
      const token = rawToken.trim().toLowerCase();
      if (token.length === 0 || !HEADER_NAME_PATTERN.test(token)) {
        throw new RemoteGatewayHeaderError("HTTP Connection header is invalid.");
      }
      output.add(token);
    }
  }
  return output;
}

export function sanitizeGatewayRequestHeaders(
  headers: IncomingHttpHeaders
): readonly RemoteHeaderTuple[] {
  const output: RemoteHeaderTuple[] = [];
  const connectionValue = headers.connection;
  const connectionTokens = connectionValue === undefined
    ? new Set<string>()
    : connectionHeaderTokens(Array.isArray(connectionValue) ? connectionValue : [connectionValue]);
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (internalHeader(name)) {
      throw new RemoteGatewayHeaderError("Browser-supplied internal headers are forbidden.");
    }
    if (
      HOP_BY_HOP.has(name)
      || connectionTokens.has(name)
      || BROWSER_LOCAL_REQUEST.has(name)
      || name.startsWith("sec-fetch-")
    ) {
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : [String(rawValue)];
    for (const value of values) {
      assertHeader(name, value);
      output.push(Object.freeze([name, value] as const));
    }
  }
  return Object.freeze(output);
}

export type GatewayResponseHeaderPolicy = {
  readonly localOrigin: string;
  readonly upstreamOrigins?: ReadonlySet<string>;
};

function safeLocation(value: string, policy: GatewayResponseHeaderPolicy): string | undefined {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!policy.upstreamOrigins?.has(url.origin) || url.username || url.password) return undefined;
  return `${policy.localOrigin}${url.pathname}${url.search}${url.hash}`;
}

export function sanitizeGatewayResponseHeaders(
  headers: readonly RemoteHeaderTuple[],
  policy: GatewayResponseHeaderPolicy
): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = Object.create(null) as OutgoingHttpHeaders;
  const connectionTokens = connectionHeaderTokens(
    headers
      .filter(([name]) => name.toLowerCase() === "connection")
      .map(([, value]) => value)
  );
  let sawLocation = false;
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    assertHeader(name, value);
    if (
      HOP_BY_HOP.has(name)
      || connectionTokens.has(name)
      || HOST_POLICY_RESPONSE.has(name)
      || internalHeader(name)
      || name.startsWith("access-control-")
    ) {
      continue;
    }
    if (name === "location") {
      if (sawLocation) throw new RemoteGatewayHeaderError("Remote response repeats Location.");
      sawLocation = true;
      const rewritten = safeLocation(value, policy);
      if (rewritten !== undefined) output.location = rewritten;
      continue;
    }
    const existing = output[name];
    if (existing === undefined) output[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else output[name] = [String(existing), value];
  }
  return output;
}
