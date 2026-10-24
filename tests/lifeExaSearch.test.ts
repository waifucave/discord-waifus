// The Exa hosted-MCP search client (Living cast §6.8): a loopback fake MCP server (Streamable HTTP,
// JSON and SSE answers), anonymous first, the 10-minute breaker, key fallback through the
// `x-api-key` header, typed failures and pacing. No live Exa.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createExaSearchClient, createExaSearchState, parseExaResults } from "../src/life/web/exa.js";

type Mode = { anonymous: "ok" | "429" | "rate-text" | "tool-error"; keyed: "ok" | "429" | "quota"; sse: boolean };

type Seen = { method: string; apiKey?: string; session?: string; url: string; args?: Record<string, unknown> };

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const RESULTS_TEXT = [
  "Title: Fudgy Brownies",
  "URL: https://bake.example/brownies",
  "Published: 2026-09-01",
  "Highlights: Use dark chocolate and brown butter.",
  "---",
  "Title: Brownie science",
  "URL: https://science.example/brownies",
  "Published: N/A",
  "Text: Why the crinkle top forms."
].join("\n");

async function fakeExa(mode: Mode): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: Record<string, unknown> } };
      const apiKey = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
      seen.push({ method: message.method, ...(apiKey ? { apiKey } : {}), ...(request.headers["mcp-session-id"] ? { session: String(request.headers["mcp-session-id"]) } : {}), url: request.url ?? "", ...(message.params?.arguments ? { args: message.params.arguments } : {}) });
      const answer = (result: unknown) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (mode.sse) {
          response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" });
          response.end(`event: message\ndata: ${payload}\n\n`);
        } else {
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
          response.end(payload);
        }
      };
      if (message.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-exa" } });
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      const state = apiKey ? mode.keyed : mode.anonymous;
      if (state === "429") {
        response.writeHead(429, { "content-type": "text/plain" });
        response.end("Too Many Requests");
        return;
      }
      if (state === "rate-text") return answer({ isError: true, content: [{ type: "text", text: "You've hit Exa's free rate limit." }] });
      if (state === "tool-error") return answer({ isError: true, content: [{ type: "text", text: "invalid query syntax" }] });
      if (state === "quota") return answer({ isError: true, content: [{ type: "text", text: "Your credits are exhausted." }] });
      return answer({ content: [{ type: "text", text: RESULTS_TEXT }] });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

describe("Exa hosted MCP client", () => {
  it("initializes, keeps the session and parses results (SSE answers)", async () => {
    const { endpoint, seen } = await fakeExa({ anonymous: "ok", keyed: "ok", sse: true });
    const client = createExaSearchClient({ endpoint, state: createExaSearchState(), minIntervalMs: () => 0 });
    const result = await client.search({ query: "best brownies", numResults: 5 });
    expect(result).toMatchObject({ ok: true, tier: "anonymous" });
    if (!result.ok) return;
    expect(result.results).toEqual([
      { url: "https://bake.example/brownies", title: "Fudgy Brownies", publishedDate: "2026-09-01", text: "Use dark chocolate and brown butter." },
      { url: "https://science.example/brownies", title: "Brownie science", text: "Why the crinkle top forms." }
    ]);
    expect(seen.map((entry) => entry.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(seen[2]).toMatchObject({ session: "session-1", args: { query: "best brownies", numResults: 5 } });
    expect(seen[0]!.url).toContain("tools=web_search_exa");
    await client.search({ query: "again" });
    expect(seen.filter((entry) => entry.method === "initialize")).toHaveLength(1);
  });

  it("a 429 on the anonymous tier opens the breaker and falls back to the key, sent as a header only", async () => {
    const { endpoint, seen } = await fakeExa({ anonymous: "429", keyed: "ok", sse: false });
    const state = createExaSearchState();
    let now = 1_000;
    const client = createExaSearchClient({ endpoint, state, resolveKey: () => "exa-secret-key", now: () => now, minIntervalMs: () => 0 });
    const first = await client.search({ query: "q" });
    expect(first).toMatchObject({ ok: true, tier: "key" });
    expect(state.anonymousRateLimitedAt).toBe(1_000);
    const anonymousCalls = () => seen.filter((entry) => entry.method === "tools/call" && !entry.apiKey).length;
    expect(anonymousCalls()).toBe(1);
    // Within the 10-minute cooldown the anonymous tier is not tried again.
    now += 5 * 60_000;
    await client.search({ query: "q2" });
    expect(anonymousCalls()).toBe(1);
    expect(seen.filter((entry) => entry.apiKey === "exa-secret-key").length).toBeGreaterThan(0);
    expect(seen.every((entry) => !entry.url.includes("exa-secret-key"))).toBe(true);
  });

  it("without a key, rate limits are a typed result; tool errors are unavailable with toolError", async () => {
    const limited = await fakeExa({ anonymous: "rate-text", keyed: "ok", sse: false });
    const result = await createExaSearchClient({ endpoint: limited.endpoint, state: createExaSearchState(), minIntervalMs: () => 0 }).search({ query: "q" });
    expect(result).toEqual({ ok: false, code: "rate_limited", message: expect.any(String) });
    const broken = await fakeExa({ anonymous: "tool-error", keyed: "ok", sse: false });
    const failed = await createExaSearchClient({ endpoint: broken.endpoint, state: createExaSearchState(), minIntervalMs: () => 0 }).search({ query: "q" });
    expect(failed).toMatchObject({ ok: false, code: "unavailable", toolError: true });
    const quota = await fakeExa({ anonymous: "429", keyed: "quota", sse: false });
    const exhausted = await createExaSearchClient({ endpoint: quota.endpoint, state: createExaSearchState(), resolveKey: () => "k", minIntervalMs: () => 0 }).search({ query: "q" });
    expect(exhausted).toMatchObject({ ok: false, code: "quota_exhausted" });
    expect(JSON.stringify(exhausted)).not.toContain("\"k\"");
  });

  it("paces anonymous calls through the shared state and reports an unreachable backend", async () => {
    const { endpoint } = await fakeExa({ anonymous: "ok", keyed: "ok", sse: false });
    const waits: number[] = [];
    let now = 0;
    const state = createExaSearchState();
    const client = createExaSearchClient({ endpoint, state, now: () => now, minIntervalMs: () => 500, sleep: async (ms) => void waits.push(ms) });
    await client.search({ query: "a" });
    await client.search({ query: "b" });
    expect(waits).toEqual([500]);
    now = 10_000;
    const down = await createExaSearchClient({ endpoint: "http://127.0.0.1:1/mcp", state: createExaSearchState(), minIntervalMs: () => 0 }).search({ query: "x" });
    expect(down).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("parses Exa's JSON result shape too", () => {
    expect(parseExaResults(JSON.stringify({ results: [{ url: "https://a.example/", title: "A", highlights: ["one", "two"], publishedDate: "2026-01-02" }, { id: "not a url" }] }))).toEqual([
      { url: "https://a.example/", title: "A", text: "one\n…\ntwo", publishedDate: "2026-01-02", highlights: ["one", "two"] }
    ]);
  });
});
