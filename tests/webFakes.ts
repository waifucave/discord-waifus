// Loopback fakes for the web adapter (src/life/web/): a winter-web transport that sends every
// validated request to a local HTTP server, a resolver that answers public-looking addresses, and a
// fake Exa hosted-MCP server. The production SSRF guard (`privateAddressPolicy: "deny"`) stays on:
// the resolver's answers are what it judges, and the transport is only ever handed validated
// addresses. Not a test file.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebFetchTransport } from "@yanlinglabs/winter-web";

export type TransportCall = { address: string; url: string; host: string | undefined };

/** Sends each request to `127.0.0.1:<port>` over plain HTTP, keeping its path and headers. */
export function loopbackTransport(port: number, calls: TransportCall[] = []): WebFetchTransport {
  return (request) =>
    new Promise((resolve, reject) => {
      calls.push({ address: request.address, url: request.url.href, host: request.headers["host"] ?? request.headers["Host"] });
      const outgoing = http.request(
        { host: "127.0.0.1", port, method: "GET", path: `${request.url.pathname}${request.url.search}`, headers: request.headers, signal: request.signal },
        (response) =>
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get: (name: string) => {
                const value = response.headers[name.toLowerCase()];
                return value === undefined ? null : Array.isArray(value) ? value.join(", ") : String(value);
              }
            },
            body: response,
            cancel: () => response.destroy()
          })
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
}

/** Every name resolves to a public documentation-free address unless mapped. */
export function fakeResolver(map: Record<string, string[]> = {}): (host: string) => Promise<readonly string[]> {
  return async (host) => map[host] ?? ["93.184.216.34"];
}

/**
 * Each name the SSRF tables use, mapped to its own non-public answer: a refusal is then the guard
 * judging that answer, never a resolver failure.
 */
export const PRIVATE_ANSWERS: Record<string, string[]> = {
  "localhost.": ["127.0.0.1"],
  "foo.localhost": ["127.0.0.1"],
  "metadata.google.internal": ["169.254.169.254"],
  "printer.local": ["192.168.1.20"],
  "loop6.test": ["::1"],
  "unspecified6.test": ["::"],
  "mapped.test": ["::ffff:7f00:1"],
  "translated.test": ["::ffff:0:10.0.0.1"],
  "nat64.test": ["64:ff9b::7f00:1"],
  "sixtofour.test": ["2002:7f00:1::"],
  "linklocal6.test": ["fe80::1"],
  "ula.test": ["fd00::1"],
  "mixed.test": ["93.184.216.34", "10.0.0.7"],
  "cgnat.test": ["100.64.0.1"]
};

/** URLs the guard must refuse as `private_address`: IPv4 literals in every spelling, and names with a private answer. */
export const PRIVATE_FORMS = [
  "http://127.0.0.1:3888/api/runtime",
  "http://0.0.0.0/",
  "http://0/",
  "http://100.64.0.1/",
  "http://169.254.169.254/",
  "http://0251.0376.0251.0376/",
  "http://0xa9fea9fe/",
  "http://2852039166/",
  "http://169.254.43518/",
  "http://127.000.000.001/",
  "http://127.1/",
  "http://0x7f000001/",
  ...Object.keys(PRIVATE_ANSWERS).map((host) => `https://${host}/`)
];

/**
 * URLs refused as `invalid_url` before any lookup: other schemes, embedded credentials, and every
 * bracketed IPv6 literal (winter-web refuses a single-label hostname, which an IPv6 literal is).
 */
export const INVALID_FORMS = [
  "http://[::]/",
  "http://[::1]:3888/",
  "http://[::ffff:7f00:1]/",
  "http://[::ffff:0:7f00:1]/",
  "http://[::ffff:0:10.0.0.1]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[2002:7f00:1::]/",
  "http://[fe80::1]/",
  "http://[fd00::1]/",
  "https://example.com@127.0.0.1/",
  "https://user@example.com/",
  "file:///etc/passwd",
  "gopher://127.0.0.1/",
  "data:text/html,hi"
];

export type PageRoute = { status?: number; type?: string; body: string | Buffer; headers?: Record<string, string> };

export async function pageServer(routes: Record<string, PageRoute>, servers: http.Server[]): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? "");
    const route = routes[request.url ?? ""] ?? { status: 404, type: "text/plain", body: "not found" };
    response.writeHead(route.status ?? 200, { "content-type": route.type ?? "text/html", ...route.headers });
    response.end(route.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

export type ExaMode = {
  anonymous: "ok" | "429" | "rate-text" | "tool-error";
  keyed: "ok" | "429" | "quota";
  sse: boolean;
  /** Keyed searches answer this late (an in-flight search while the key changes). */
  keyedDelayMs?: number;
};
export type ExaSeen = { method: string; apiKey?: string; session?: string; url: string; args?: Record<string, unknown> };

export const EXA_RESULTS_TEXT = [
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

/** A Streamable-HTTP MCP server speaking just enough of Exa's hosted endpoint. */
export async function fakeExa(mode: ExaMode, servers: http.Server[]): Promise<{ endpoint: string; seen: ExaSeen[] }> {
  const seen: ExaSeen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !body) {
        response.writeHead(request.method === "DELETE" ? 200 : 405);
        response.end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: Record<string, unknown> } };
      const apiKey = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
      seen.push({
        method: message.method,
        ...(apiKey ? { apiKey } : {}),
        ...(request.headers["mcp-session-id"] ? { session: String(request.headers["mcp-session-id"]) } : {}),
        url: request.url ?? "",
        ...(message.params?.arguments ? { args: message.params.arguments } : {})
      });
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
      if (message.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-exa", version: "1" } });
      if (message.method.startsWith("notifications/")) {
        response.writeHead(202);
        response.end();
        return;
      }
      const state = apiKey ? mode.keyed : mode.anonymous;
      if (apiKey && mode.keyedDelayMs && state === "ok") {
        setTimeout(() => answer({ content: [{ type: "text", text: EXA_RESULTS_TEXT }] }), mode.keyedDelayMs);
        return;
      }
      if (state === "429") {
        response.writeHead(429, { "content-type": "text/plain" });
        response.end("Too Many Requests");
        return;
      }
      if (state === "rate-text") return answer({ isError: true, content: [{ type: "text", text: "You've hit Exa's free rate limit. Please try again later." }] });
      if (state === "tool-error") return answer({ isError: true, content: [{ type: "text", text: "invalid query syntax" }] });
      if (state === "quota") return answer({ isError: true, content: [{ type: "text", text: "Your credits are exhausted: rate limit exceeded." }] });
      return answer({ content: [{ type: "text", text: EXA_RESULTS_TEXT }] });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}
