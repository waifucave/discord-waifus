import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { z } from "zod";
import { createRemoteRequestPrincipal, type RemoteRequestPrincipal } from "../../api/requestPrincipal.js";
import {
  CanonicalTargetSchema,
  HttpMethodSchema,
  RequestPrincipalWireSchema,
  type HttpMethod
} from "../../shared/schemas/remoteProtocol.js";
import { assertWipcEncodedHeadersLength } from "../../shared/wipc.js";

export const REMOTE_BRIDGE_PROTOCOL_VERSION = 1;
export const REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE = 32;
export const REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_CONNECTION = 128;
export const REMOTE_BRIDGE_MAX_QUEUED_BYTES_PER_STREAM = 2 * 1_024 * 1_024;
export const REMOTE_BRIDGE_MAX_QUEUED_BYTES_PER_CONNECTION = 8 * 1_024 * 1_024;

export type RemoteBridgeErrorCode =
  | "bridge_closed"
  | "connection_closed"
  | "connection_id_invalid"
  | "connection_id_reused"
  | "connection_stream_limit"
  | "device_stream_limit"
  | "forbidden_header"
  | "headers_too_large"
  | "invalid_browser_context"
  | "invalid_header"
  | "invalid_request_start"
  | "invalid_stream_id"
  | "stream_id_reused";

export class RemoteBridgeProtocolError extends Error {
  readonly code: RemoteBridgeErrorCode;

  constructor(code: RemoteBridgeErrorCode, message: string) {
    super(message);
    this.name = "RemoteBridgeProtocolError";
    this.code = code;
  }
}

export type RemoteHeaderTuple = readonly [name: string, value: string];

export type RemoteBridgeRequestStart = {
  readonly version: 1;
  readonly method: HttpMethod;
  readonly canonicalTarget: string;
  readonly headers: readonly RemoteHeaderTuple[];
  readonly principal: RemoteRequestPrincipal;
};

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(HEADER_NAME_PATTERN, "Expected an HTTP field name.");
const HeaderValueSchema = z
  .string()
  .max(8_192)
  .regex(/^[\t\x20-\x7E]*$/u, "Expected an ASCII HTTP field value.");
const HeaderTupleSchema = z.tuple([HeaderNameSchema, HeaderValueSchema]);

const RequestStartSchema = z.object({
  version: z.literal(REMOTE_BRIDGE_PROTOCOL_VERSION),
  method: HttpMethodSchema,
  canonicalTarget: CanonicalTargetSchema,
  headers: z.array(HeaderTupleSchema).max(256),
  principal: RequestPrincipalWireSchema
}).strict();

const HOP_BY_HOP_HEADERS = new Set([
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

const BROWSER_ONLY_REQUEST_HEADERS = new Set([
  "cookie",
  "host",
  "origin",
  "referer",
  "x-waifus-csrf"
]);

const SINGLETON_REQUEST_HEADERS = new Set([
  "authorization",
  "content-length",
  "content-type",
  "expect"
]);

function helperInternalHeader(name: string): boolean {
  return name.startsWith("x-device-")
    || name.startsWith("x-waifus-principal")
    || name.startsWith("x-waifus-internal")
    || name.startsWith("x-waifus-actor")
    || name.startsWith("x-waifus-browser-context")
    || name.startsWith("x-waifus-helper");
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      freeze(nested as object);
    }
  }
  return Object.freeze(value);
}

function assertEncodedHeaderLimit(headers: readonly RemoteHeaderTuple[]): void {
  try {
    assertWipcEncodedHeadersLength(Buffer.byteLength(JSON.stringify(headers), "utf8"));
  } catch {
    throw new RemoteBridgeProtocolError("headers_too_large", "Encoded HTTP headers exceed 16 KiB.");
  }
}

function normalizeRequestHeaders(
  headers: readonly RemoteHeaderTuple[]
): { tuples: readonly RemoteHeaderTuple[]; inject: IncomingHttpHeaders } {
  assertEncodedHeaderLimit(headers);
  const retained: RemoteHeaderTuple[] = [];
  const grouped = new Map<string, string[]>();
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (helperInternalHeader(name)) {
      throw new RemoteBridgeProtocolError(
        "forbidden_header",
        "Client-supplied principal or helper metadata is forbidden."
      );
    }
    if (
      HOP_BY_HOP_HEADERS.has(name)
      || BROWSER_ONLY_REQUEST_HEADERS.has(name)
      || name.startsWith("sec-fetch-")
    ) {
      continue;
    }
    retained.push(Object.freeze([name, value] as const));
    const values = grouped.get(name) ?? [];
    values.push(value);
    grouped.set(name, values);
  }
  assertEncodedHeaderLimit(retained);

  const inject: IncomingHttpHeaders = Object.create(null) as IncomingHttpHeaders;
  for (const [name, values] of grouped) {
    if (SINGLETON_REQUEST_HEADERS.has(name) && values.length !== 1) {
      throw new RemoteBridgeProtocolError(
        "invalid_header",
        `Request header ${name} cannot be repeated.`
      );
    }
    inject[name] = values.join(", ");
  }
  return { tuples: Object.freeze(retained), inject };
}

export function parseRemoteBridgeRequestStart(value: unknown): Readonly<{
  start: RemoteBridgeRequestStart;
  injectHeaders: IncomingHttpHeaders;
}> {
  const parsed = RequestStartSchema.safeParse(value);
  if (!parsed.success) {
    throw new RemoteBridgeProtocolError("invalid_request_start", "Remote request metadata is invalid.");
  }
  if (
    parsed.data.principal.browserContext
    && (
      parsed.data.principal.browserContext.method !== parsed.data.method
      || parsed.data.principal.browserContext.canonicalTarget !== parsed.data.canonicalTarget
    )
  ) {
    throw new RemoteBridgeProtocolError(
      "invalid_browser_context",
      "Verified browser context does not match the request method and target."
    );
  }
  const normalized = normalizeRequestHeaders(parsed.data.headers);
  const start = freeze({
    version: 1 as const,
    method: parsed.data.method,
    canonicalTarget: parsed.data.canonicalTarget,
    headers: normalized.tuples,
    principal: createRemoteRequestPrincipal(parsed.data.principal)
  });
  return Object.freeze({ start, injectHeaders: normalized.inject });
}

function forbiddenResponseHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name)
    || helperInternalHeader(name)
    || name === "set-cookie"
    || name === "content-security-policy"
    || name === "content-security-policy-report-only"
    || name === "permissions-policy"
    || name === "referrer-policy"
    || name === "service-worker-allowed"
    || name.startsWith("access-control-");
}

export function sanitizeRemoteResponseHeaders(
  headers: OutgoingHttpHeaders
): readonly RemoteHeaderTuple[] {
  const retained: RemoteHeaderTuple[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined || forbiddenResponseHeader(name)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      retained.push(Object.freeze([name, String(value)] as const));
    }
  }
  assertEncodedHeaderLimit(retained);
  return Object.freeze(retained);
}
