// TEMPORARY local port (Living cast L2) of winter's page fetch (winter-agent-sdk,
// packages/runtime/src/tools/impl/_web-fetch-net.ts and web/fetchable-url.ts, MIT, ours), shaped
// like the planned `@yanlinglabs/winter-web` `fetchWebPage` so the swap is mechanical. Dropped from
// winter's version: preapproved-host passthrough, site icons, binary saving, the "redirect detected"
// relay (redirects are followed here, every hop checked).
//
// SSRF rules under the "deny" policy (the only policy production uses):
//   - http/https only; `http` is upgraded to `https`; no credentials in the URL; ≤ 2,000 chars.
//   - Every hop (the first request and each redirect) is checked lexically (IP literals in every
//     notation the WHATWG parser accepts, reserved names) and then by DNS: the request's `lookup` is
//     ours, resolves once, refuses when ANY answer is private (mixed answers fail closed) and hands
//     node exactly the addresses it checked, so a rebinding DNS server gets no second query.
//   - After connecting, the socket's actual remote address is classified again and the request is
//     destroyed if it is private (the "address actually connected to" check).
//   - Each request uses a fresh agent with no proxy, so proxy environment variables cannot route
//     around the checks.
// Expected failures are typed results; this module never throws to its caller and never echoes a
// raw exception message (only fixed texts).

import { STATUS_CODES } from "node:http";
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { Socket } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Transform } from "node:stream";
import { classifyAddress, classifyHostLexically } from "./address.js";
import { htmlToText } from "./html.js";
import type { WebFetchCache } from "./cache.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FETCH_MAX_REDIRECTS = 5;
const MAX_URL_CHARS = 2_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** "deny" refuses every non-public address (production). "allow" exists only for loopback tests. */
export type PrivateAddressPolicy = "deny" | "allow";

export type ResolveHost = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export type FetchWebPageOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  privateAddressPolicy?: PrivateAddressPolicy;
  userAgent?: string;
  cache?: WebFetchCache;
  /** Test seam: DNS resolution (default: the system resolver, every answer). */
  resolveHost?: ResolveHost;
  /** Test seam: keep `http` (loopback servers in tests have no TLS). Default true. */
  upgradeHttp?: boolean;
  /**
   * Test seam: the "is this address private" verdict used for literals, DNS answers and the
   * connected socket (default: `classifyAddress`). Tests use it to treat their loopback server as
   * the public internet while every other private address stays refused.
   */
  isPrivateAddress?: (address: string) => boolean;
};

export type WebPage = {
  ok: true;
  finalUrl: string;
  status: number;
  contentType: string;
  kind: "html" | "text" | "binary";
  /** Readable text (HTML converted); "" for binary content. */
  text: string;
  truncated: boolean;
  /** Served from the short-lived cache. */
  cached?: boolean;
};

export type WebFetchFailureCode =
  | "invalid_url"
  | "private_address"
  | "too_many_redirects"
  | "http_error"
  | "timeout"
  | "aborted"
  | "network";

export type WebFetchFailure = { ok: false; code: WebFetchFailureCode; message: string; status?: number };

export type WebFetchOutcome = WebPage | WebFetchFailure;

class PrivateAddressError extends Error {
  override name = "PrivateAddressError";
}

const fail = (code: WebFetchFailureCode, message: string, status?: number): WebFetchFailure => ({ ok: false, code, message, ...(status !== undefined ? { status } : {}) });

const defaultResolveHost: ResolveHost = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });

/** The cache key: the (upgraded) URL without its fragment. */
export function normalizeFetchUrl(input: string, o: { upgradeHttp?: boolean } = {}): URL | WebFetchFailure {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return fail("invalid_url", "that is not a valid web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("invalid_url", "only http and https pages can be fetched");
  if (url.username !== "" || url.password !== "") return fail("invalid_url", "web addresses with a username or password are not fetched");
  if (url.protocol === "http:" && o.upgradeHttp !== false) url.protocol = "https:";
  url.hash = "";
  if (url.toString().length > MAX_URL_CHARS) return fail("invalid_url", "that web address is too long");
  return url;
}

function hostOf(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

function networkMessage(error: unknown): { code: WebFetchFailureCode; message: string } {
  if (error instanceof PrivateAddressError) return { code: "private_address", message: "that address is not on the public internet" };
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return { code: "network", message: "that site could not be found" };
  if (code === "ECONNREFUSED") return { code: "network", message: "the site refused the connection" };
  if (code === "ECONNRESET" || code === "EPIPE") return { code: "network", message: "the connection to the site was cut" };
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return { code: "timeout", message: "the site took too long to answer" };
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return { code: "network", message: "the site's certificate could not be verified" };
  if (code === "ABORT_ERR" || (error as Error | undefined)?.name === "AbortError") return { code: "aborted", message: "the fetch was interrupted" };
  return { code: "network", message: "the page could not be fetched" };
}

type HopResult =
  | { kind: "redirect"; location: string | undefined; status: number }
  | { kind: "response"; status: number; contentType: string; body: Buffer; truncated: boolean };

function decoderFor(encoding: string | undefined): Transform | null | undefined {
  const tokens = (encoding ?? "").toLowerCase().split(",").map((token) => token.trim()).filter((token) => token && token !== "identity");
  if (tokens.length === 0) return null;
  if (tokens.length > 1) return undefined;
  if (tokens[0] === "gzip" || tokens[0] === "x-gzip") return createGunzip();
  if (tokens[0] === "deflate") return createInflate();
  if (tokens[0] === "br") return createBrotliDecompress();
  return undefined;
}

function oneHop(
  url: URL,
  o: { policy: PrivateAddressPolicy; isPrivate: (address: string) => boolean; resolveHost: ResolveHost; userAgent: string; maxBytes: number; signal: AbortSignal }
): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const host = hostOf(url);
    const guardedLookup = (
      hostname: string,
      options: { all?: boolean; family?: number },
      callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
    ): void => {
      o.resolveHost(hostname).then(
        (answers) => {
          const usable = answers.filter((answer) => isIP(answer.address) !== 0);
          if (usable.length === 0) return callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
          if (o.policy === "deny" && usable.some((answer) => o.isPrivate(answer.address))) {
            return callback(new PrivateAddressError("private address"), "", 0);
          }
          if (options.all) return callback(null, usable.map((answer) => ({ address: answer.address, family: answer.family })));
          const first = usable.find((answer) => !options.family || answer.family === options.family) ?? usable[0]!;
          callback(null, first.address, first.family);
        },
        (error: unknown) => callback(Object.assign(new Error("lookup failed"), { code: (error as NodeJS.ErrnoException)?.code ?? "ENOTFOUND" }), "", 0)
      );
    };
    const AgentClass = secure ? https.Agent : http.Agent;
    const agent = new AgentClass({ keepAlive: false, maxSockets: 1 });
    const request = (secure ? https : http).request(
      {
        protocol: url.protocol,
        host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent,
        lookup: guardedLookup as never,
        ...(secure && isIP(host) === 0 ? { servername: host.replace(/\.$/, "") } : {}),
        headers: {
          "user-agent": o.userAgent,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en;q=0.9, *;q=0.5"
        },
        signal: o.signal
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECTS.has(status)) {
          response.resume();
          resolve({ kind: "redirect", location: typeof response.headers.location === "string" ? response.headers.location : undefined, status });
          return;
        }
        const decoder = decoderFor(response.headers["content-encoding"]);
        if (decoder === undefined) {
          response.resume();
          reject(Object.assign(new Error("unsupported encoding"), { code: "EUNSUPPORTED_ENCODING" }));
          return;
        }
        const chunks: Buffer[] = [];
        let raw = 0;
        let size = 0;
        let truncated = false;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve({ kind: "response", status, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks), truncated });
        };
        const take = (chunk: Buffer) => {
          if (finished) return;
          const room = o.maxBytes - size;
          if (chunk.length >= room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size = o.maxBytes;
            truncated = true;
            finish();
            response.destroy();
            decoder?.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        };
        // The compressed input is capped too (an endless run of empty deflate blocks has huge input
        // and almost no output).
        response.on("data", (chunk: Buffer) => {
          raw += chunk.length;
          if (raw > o.maxBytes * 2 && decoder) {
            truncated = true;
            finish();
            response.destroy();
            decoder.destroy();
          }
        });
        const onError = (error: unknown) => (finished ? undefined : size > 0 ? (truncated = true, finish()) : reject(error));
        if (decoder) {
          response.pipe(decoder);
          decoder.on("data", take);
          decoder.on("end", finish);
          decoder.on("error", onError);
        } else {
          response.on("data", take);
          response.on("end", finish);
        }
        response.on("error", onError);
        response.on("aborted", () => onError(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
      }
    );
    request.on("socket", (socket: Socket) => {
      const check = () => {
        const remote = socket.remoteAddress;
        if (o.policy === "deny" && (!remote || o.isPrivate(remote))) request.destroy(new PrivateAddressError("private address"));
      };
      if (socket.remoteAddress) check();
      else socket.once("connect", check);
    });
    request.on("error", reject);
    request.end();
  });
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? "utf-8";
}

function decodeText(body: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function kindOf(contentType: string, body: Buffer): WebPage["kind"] {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/") || /[/+](json|xml|javascript|csv|yaml|x-yaml)$/.test(type)) return "text";
  if (!type) {
    const head = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
    if (!body.subarray(0, 512).includes(0)) return "text";
  }
  return "binary";
}

/**
 * Fetches one web page and returns its readable text. Never throws; refusals and failures come
 * back as `{ ok: false, code, message }` with a safe message.
 */
export async function fetchWebPage(input: string, options: FetchWebPageOptions = {}): Promise<WebFetchOutcome> {
  try {
    return await fetchWebPageUnsafe(input, options);
  } catch {
    return fail("network", "the page could not be fetched");
  }
}

async function fetchWebPageUnsafe(input: string, options: FetchWebPageOptions): Promise<WebFetchOutcome> {
  const policy = options.privateAddressPolicy ?? "deny";
  const first = normalizeFetchUrl(input, options);
  if (!(first instanceof URL)) return first;
  const cacheKey = first.toString();
  const hit = options.cache?.get(cacheKey);
  if (hit) return { ...hit, cached: true };
  if (options.signal?.aborted) return fail("aborted", "the fetch was interrupted");
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const maxRedirects = options.maxRedirects ?? DEFAULT_FETCH_MAX_REDIRECTS;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const isPrivate = options.isPrivateAddress ?? ((address: string) => classifyAddress(address).private);
  let current = first;
  for (let hop = 0; ; hop += 1) {
    if (policy === "deny") {
      const host = hostOf(current);
      const lexical = isIP(host) !== 0 ? { private: isPrivate(host) } : classifyHostLexically(current.hostname);
      if (lexical?.private) return fail("private_address", "that address is not on the public internet");
    }
    let result: HopResult;
    try {
      result = await oneHop(current, {
        policy,
        isPrivate,
        resolveHost,
        userAgent: options.userAgent ?? "Mozilla/5.0 (compatible; DiscordWaifus)",
        maxBytes: options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES,
        signal
      });
    } catch (error) {
      if (options.signal?.aborted) return fail("aborted", "the fetch was interrupted");
      if (timeout.aborted) return fail("timeout", `the page did not load within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds`);
      const mapped = networkMessage(error);
      return fail(mapped.code, mapped.message);
    }
    if (result.kind === "redirect") {
      if (hop >= maxRedirects) return fail("too_many_redirects", "the page redirected too many times");
      if (!result.location) return fail("http_error", `the site answered ${result.status} ${STATUS_CODES[result.status] ?? ""}`.trim(), result.status);
      let next: URL | WebFetchFailure;
      try {
        next = normalizeFetchUrl(new URL(result.location, current).toString(), options);
      } catch {
        next = fail("invalid_url", "the page redirected to an invalid address");
      }
      if (!(next instanceof URL)) return next;
      current = next;
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      return fail("http_error", `the site answered ${result.status} ${STATUS_CODES[result.status] ?? ""}`.trim(), result.status);
    }
    const kind = kindOf(result.contentType, result.body);
    const raw = kind === "binary" ? "" : decodeText(result.body, result.contentType);
    const page: WebPage = {
      ok: true,
      finalUrl: current.toString(),
      status: result.status,
      contentType: result.contentType.split(";")[0]!.trim().toLowerCase(),
      kind,
      text: kind === "html" ? htmlToText(raw, current.toString()) : raw.trim(),
      truncated: result.truncated
    };
    options.cache?.set(cacheKey, page);
    return page;
  }
}
