// TEMPORARY local port (Living cast L2) of winter's Exa search client (winter-agent-sdk,
// packages/runtime/src/tools/impl/_exa-client.ts, MIT, ours), shaped like the planned
// `@yanlinglabs/winter-web` `createExaSearchClient` so the swap is mechanical.
//
// Backend: Exa's hosted MCP server (`https://mcp.exa.ai/mcp`, Streamable HTTP), keyless by default.
// This is a small hand-rolled JSON-RPC client (no MCP SDK dependency): `initialize`, the
// `notifications/initialized` notification, then `tools/call` on `web_search_exa`; responses may be
// plain JSON or an SSE stream, and a returned `Mcp-Session-Id` is sent back on later requests.
//
// Anonymous first, key second (winter's logic): the anonymous tier is paced (one call per
// `minIntervalMs`, process-wide through the shared state) and, once it answers 429 or a rate-limit
// error, a breaker keeps it closed for 10 minutes; while it is closed an Exa key (the `exa` provider
// credential, sent as the `x-api-key` header, never in the URL) is used when one is saved. Expected
// failures are typed results (`rate_limited`, `quota_exhausted`, `unavailable`, `aborted`); MCP tool
// errors come back as `unavailable` with `toolError: true`. Nothing here throws to the caller, and
// the key never appears in a message.

export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
export const EXA_SEARCH_TOOL = "web_search_exa";
export const EXA_ADVANCED_SEARCH_TOOL = "web_search_advanced_exa";
export const EXA_API_KEY_HEADER = "x-api-key";
export const EXA_ANONYMOUS_COOLDOWN_MS = 10 * 60_000;
export const EXA_DEFAULT_MIN_INTERVAL_MS = 500;
export const EXA_CALL_TIMEOUT_MS = 25_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const TITLE_MAX = 300;
const URL_MAX = 2_000;
const HIGHLIGHT_MAX = 1_200;

export type ExaSearchParams = {
  query: string;
  numResults?: number;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
};

export type ExaSearchHit = { url: string; title: string; publishedDate?: string; text: string; highlights?: string[] };

export type ExaSearchFailure = {
  ok: false;
  code: "rate_limited" | "quota_exhausted" | "unavailable" | "aborted";
  message: string;
  /** The MCP server answered the call with `isError` (not a transport failure). */
  toolError?: boolean;
};
export type ExaSearchOutcome = { ok: true; results: ExaSearchHit[]; tier: "anonymous" | "key" } | ExaSearchFailure;

/** Breaker and pacer, shared by every client of one process. */
export type ExaSearchState = { anonymousRateLimitedAt?: number; nextAnonymousCallAt: number };

export function createExaSearchState(): ExaSearchState {
  return { nextAnonymousCallAt: 0 };
}

export const sharedExaSearchState: ExaSearchState = createExaSearchState();

export type ExaSearchClientOptions = {
  /** The saved Exa key, read live (undefined: none). */
  resolveKey?: () => string | undefined | Promise<string | undefined>;
  state?: ExaSearchState;
  endpoint?: string;
  /** Anonymous pacing (default 500 ms, 2 calls/s). */
  minIntervalMs?: () => number;
  callTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam (default: global fetch). */
  fetchImpl?: typeof fetch;
  userAgent?: string;
};

export interface ExaSearchClient {
  search(params: ExaSearchParams, opts?: { signal?: AbortSignal }): Promise<ExaSearchOutcome>;
}

const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b/i;
const QUOTA_RE = /quota (?:(?:is|has been) )?(?:exceeded|exhausted|reached|used up)|credits? (?:(?:are|have been|is) )?(?:exhausted|exceeded|depleted|used up)|out of credits|insufficient (?:credits|balance)|payment required|\b402\b/i;
const AUTH_RE = /unauthori[sz]ed|forbidden|invalid api.?key|api.?key (?:is )?(?:invalid|required|missing)/i;

class HttpStatusError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
  }
}

class RpcError extends Error {
  constructor(readonly rpcCode: number | undefined, readonly detail: string) {
    super("rpc error");
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function linkable(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= URL_MAX;
}

function highlightsFrom(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return [];
}

function hitFromRecord(record: Record<string, unknown>): ExaSearchHit | undefined {
  const url = [record["url"], record["id"]].map((value) => (typeof value === "string" ? value.trim() : "")).find(linkable);
  if (!url) return undefined;
  const title = typeof record["title"] === "string" && record["title"].trim() ? record["title"].trim() : url;
  const highlights = highlightsFrom(record["highlights"]);
  const text = typeof record["text"] === "string" ? record["text"] : typeof record["summary"] === "string" ? record["summary"] : highlights.join("\n…\n");
  const published = typeof record["publishedDate"] === "string" && record["publishedDate"] ? record["publishedDate"] : undefined;
  return {
    url,
    title: cap(title, TITLE_MAX),
    text: cap(text.trim(), HIGHLIGHT_MAX),
    ...(published ? { publishedDate: published } : {}),
    ...(highlights.length > 0 ? { highlights: highlights.map((h) => cap(h, HIGHLIGHT_MAX)) } : {})
  };
}

const FIELD_LINE = /^(Title|URL|Published(?: Date)?|Author|Highlights|Text|Summary|Content):[ \t]*(.*)$/i;

function hitsFromPlainText(text: string): ExaSearchHit[] {
  const hits: ExaSearchHit[] = [];
  for (const block of text.split(/\n[ \t]*-{3,}[ \t]*\n/)) {
    let title: string | undefined;
    let url: string | undefined;
    let published: string | undefined;
    let body: string[] | undefined;
    for (const line of block.split("\n")) {
      const field = body === undefined ? FIELD_LINE.exec(line) : null;
      if (!field) {
        body?.push(line);
        continue;
      }
      const name = field[1]!.toLowerCase();
      const value = field[2]!.trim();
      if (name === "title") title = value;
      else if (name === "url") url = value;
      else if (name.startsWith("published")) published = value;
      else if (name !== "author") body = value ? [value] : [];
    }
    if (!url || !linkable(url)) continue;
    const content = (body ?? []).join("\n").trim();
    hits.push({
      url,
      title: cap(title || url, TITLE_MAX),
      text: cap(content, HIGHLIGHT_MAX),
      ...(published && published.toUpperCase() !== "N/A" ? { publishedDate: published } : {})
    });
  }
  return hits;
}

/** Exa's MCP answer text (JSON `{results}` or `Title:/URL:` records separated by `---`) → hits. */
export function parseExaResults(text: string): ExaSearchHit[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const results = Array.isArray(parsed) ? parsed : (parsed as { results?: unknown } | null)?.results;
      if (Array.isArray(results)) {
        return results.flatMap((row) => {
          const hit = row && typeof row === "object" ? hitFromRecord(row as Record<string, unknown>) : undefined;
          return hit ? [hit] : [];
        });
      }
    } catch {
      // not JSON: the text form
    }
  }
  return hitsFromPlainText(trimmed);
}

/** One JSON-RPC message out of a JSON or SSE body, matched by id. */
function rpcMessageFrom(body: string, contentType: string, id: number): Record<string, unknown> | undefined {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // skip a malformed event
      }
    }
  } else if (body.trim()) {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      return undefined;
    }
  }
  for (const candidate of candidates.flatMap((value) => (Array.isArray(value) ? value : [value]))) {
    if (candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === id) return candidate as Record<string, unknown>;
  }
  return undefined;
}

type Session = { id?: string; protocolVersion: string };

export function createExaSearchClient(options: ExaSearchClientOptions = {}): ExaSearchClient {
  const state = options.state ?? sharedExaSearchState;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = (() => {
    const base = options.endpoint ?? EXA_MCP_ENDPOINT;
    return `${base}${base.includes("?") ? "&" : "?"}tools=${EXA_SEARCH_TOOL},${EXA_ADVANCED_SEARCH_TOOL}`;
  })();
  const sessions: Partial<Record<"anonymous" | "key", Session>> = {};
  let nextId = 1;

  const post = async (body: unknown, o: { apiKey?: string; session?: Session; signal: AbortSignal }): Promise<{ status: number; text: string; contentType: string; sessionId?: string }> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": options.userAgent ?? "discord-waifus"
    };
    if (o.apiKey) headers[EXA_API_KEY_HEADER] = o.apiKey;
    if (o.session?.id) headers["mcp-session-id"] = o.session.id;
    if (o.session) headers["mcp-protocol-version"] = o.session.protocolVersion;
    const response = await doFetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: o.signal, redirect: "error" });
    const text = await response.text();
    return { status: response.status, text, contentType: response.headers.get("content-type") ?? "", sessionId: response.headers.get("mcp-session-id") ?? undefined };
  };

  const request = async (method: string, params: unknown, o: { apiKey?: string; session?: Session; signal: AbortSignal }): Promise<{ result: Record<string, unknown>; sessionId?: string }> => {
    const id = nextId++;
    const reply = await post({ jsonrpc: "2.0", id, method, params }, o);
    if (reply.status < 200 || reply.status >= 300) throw new HttpStatusError(reply.status, cap(reply.text, 300));
    const message = rpcMessageFrom(reply.text, reply.contentType, id);
    if (!message) throw new RpcError(undefined, "no answer");
    const error = message["error"] as { code?: unknown; message?: unknown } | undefined;
    if (error) throw new RpcError(typeof error.code === "number" ? error.code : undefined, typeof error.message === "string" ? cap(error.message, 300) : "error");
    const result = message["result"];
    return { result: result && typeof result === "object" ? (result as Record<string, unknown>) : {}, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  };

  const open = async (tier: "anonymous" | "key", apiKey: string | undefined, signal: AbortSignal): Promise<Session> => {
    const existing = sessions[tier];
    if (existing) return existing;
    const init = await request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "discord-waifus", version: "1" } },
      { ...(apiKey ? { apiKey } : {}), signal }
    );
    const version = typeof init.result["protocolVersion"] === "string" ? init.result["protocolVersion"] : MCP_PROTOCOL_VERSION;
    const session: Session = { protocolVersion: version, ...(init.sessionId ? { id: init.sessionId } : {}) };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...(apiKey ? { apiKey } : {}), session, signal }).catch(() => undefined);
    sessions[tier] = session;
    return session;
  };

  type Attempt = { kind: "ok"; text: string } | { kind: "rate" | "quota" | "auth" | "tool" | "failed" | "timeout" | "aborted"; detail: string };

  const call = async (tier: "anonymous" | "key", apiKey: string | undefined, args: Record<string, unknown>, tool: string, signal: AbortSignal | undefined): Promise<Attempt> => {
    const timeoutMs = options.callTimeoutMs ?? EXA_CALL_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const scrub = (text: string) => (apiKey ? text.split(apiKey).join("***") : text);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await open(tier, apiKey, combined);
        const { result } = await request("tools/call", { name: tool, arguments: args }, { ...(apiKey ? { apiKey } : {}), session, signal: combined });
        const content = Array.isArray(result["content"]) ? (result["content"] as Array<{ type?: unknown; text?: unknown }>) : [];
        const text = content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).filter(Boolean).join("\n\n");
        if (result["isError"] === true) {
          const about = text.split(String(args["query"] ?? "\u0000")).join(" ");
          if (QUOTA_RE.test(about)) return { kind: "quota", detail: scrub(cap(text, 200)) };
          if (RATE_LIMIT_RE.test(about)) return { kind: "rate", detail: scrub(cap(text, 200)) };
          if (AUTH_RE.test(about)) return { kind: "auth", detail: scrub(cap(text, 200)) };
          return { kind: "tool", detail: scrub(cap(text, 200)) };
        }
        return { kind: "ok", text };
      } catch (error) {
        delete sessions[tier];
        if (signal?.aborted) return { kind: "aborted", detail: "" };
        if (timeout.aborted) return { kind: "timeout", detail: "" };
        if (error instanceof HttpStatusError) {
          if (error.status === 404 && attempt === 0) continue; // the session expired: open a new one
          if (error.status === 429) return { kind: "rate", detail: "" };
          if (error.status === 402) return { kind: "quota", detail: "" };
          if (error.status === 401 || error.status === 403) return { kind: "auth", detail: "" };
          if (QUOTA_RE.test(error.body)) return { kind: "quota", detail: "" };
          if (RATE_LIMIT_RE.test(error.body)) return { kind: "rate", detail: "" };
          return { kind: "failed", detail: `HTTP ${error.status}` };
        }
        if (error instanceof RpcError) {
          if (QUOTA_RE.test(error.detail)) return { kind: "quota", detail: "" };
          if (RATE_LIMIT_RE.test(error.detail)) return { kind: "rate", detail: "" };
          return { kind: "failed", detail: "the search backend answered with an error" };
        }
        return { kind: "failed", detail: "the search backend could not be reached" };
      }
    }
    return { kind: "failed", detail: "the search backend could not be reached" };
  };

  const pace = async (signal: AbortSignal | undefined): Promise<void> => {
    const interval = Math.max(0, options.minIntervalMs?.() ?? EXA_DEFAULT_MIN_INTERVAL_MS);
    const at = now();
    const start = Math.max(at, state.nextAnonymousCallAt);
    state.nextAnonymousCallAt = start + interval;
    if (start > at) await sleep(start - at, signal);
  };

  const failure = (attempt: Exclude<Attempt, { kind: "ok" }>): ExaSearchFailure => {
    switch (attempt.kind) {
      case "rate":
        return { ok: false, code: "rate_limited", message: "web search is rate-limited right now" };
      case "quota":
        return { ok: false, code: "quota_exhausted", message: "the web search quota is used up for now" };
      case "aborted":
        return { ok: false, code: "aborted", message: "the search was interrupted" };
      case "timeout":
        return { ok: false, code: "unavailable", message: "the search backend did not answer in time" };
      case "auth":
        return { ok: false, code: "unavailable", message: "the search backend refused access" };
      case "tool":
        return { ok: false, code: "unavailable", message: `the search failed${attempt.detail ? `: ${attempt.detail}` : ""}`, toolError: true };
      default:
        return { ok: false, code: "unavailable", message: attempt.detail || "the search backend could not be reached" };
    }
  };

  return {
    async search(params, opts = {}): Promise<ExaSearchOutcome> {
      const signal = opts.signal;
      if (signal?.aborted) return { ok: false, code: "aborted", message: "the search was interrupted" };
      const numResults = Math.min(20, Math.max(1, Math.floor(params.numResults ?? 5)));
      const include = (params.includeDomains ?? []).filter((domain) => domain.trim());
      const exclude = (params.excludeDomains ?? []).filter((domain) => domain.trim());
      const filtered = include.length > 0 || exclude.length > 0;
      const tool = filtered ? EXA_ADVANCED_SEARCH_TOOL : EXA_SEARCH_TOOL;
      const args: Record<string, unknown> = filtered
        ? {
            query: params.query,
            numResults,
            enableHighlights: true,
            highlightsMaxCharacters: HIGHLIGHT_MAX,
            ...(include.length > 0 ? { includeDomains: include } : { excludeDomains: exclude })
          }
        : { query: params.query, objective: params.query, numResults };
      const done = (tier: "anonymous" | "key", text: string): ExaSearchOutcome => ({ ok: true, tier, results: parseExaResults(text).slice(0, numResults) });

      const breakerOpen = state.anonymousRateLimitedAt !== undefined && now() - state.anonymousRateLimitedAt < EXA_ANONYMOUS_COOLDOWN_MS;
      let anonymous: Exclude<Attempt, { kind: "ok" }> | undefined;
      if (!breakerOpen) {
        await pace(signal);
        const outcome = await call("anonymous", undefined, args, tool, signal);
        if (outcome.kind === "ok") {
          delete state.anonymousRateLimitedAt;
          return done("anonymous", outcome.text);
        }
        if (outcome.kind !== "rate" && outcome.kind !== "quota" && outcome.kind !== "auth") return failure(outcome);
        state.anonymousRateLimitedAt = now();
        anonymous = outcome;
      }
      let key: string | undefined;
      try {
        key = (await options.resolveKey?.())?.trim() || undefined;
      } catch {
        key = undefined;
      }
      if (!key) return failure(anonymous ?? { kind: "rate", detail: "" });
      const outcome = await call("key", key, args, tool, signal);
      return outcome.kind === "ok" ? done("key", outcome.text) : failure(outcome);
    }
  };
}
