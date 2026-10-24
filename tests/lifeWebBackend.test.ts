// The web adapter over @yanlinglabs/winter-web (Living cast §6.8, §6.9), proved through the app's own
// code path: the SSRF guard under the production "deny" policy (URL forms, resolved answers,
// redirects, IPv4 embedded in IPv6), hostile HTML that must not stall the event loop, compression
// bombs and slow bodies, proxy environment variables that must not route a fetch, and Exa search
// (keyless first, the saved key as an `x-api-key` header, a new client when the key changes). Loopback
// servers, a fake resolver and transport; no live web or Exa calls.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createExaBackendState } from "@yanlinglabs/winter-web";
import { afterEach, describe, expect, it } from "vitest";
import { createWebBackend } from "../src/life/web/index.js";
import { fakeExa, fakeResolver, INVALID_FORMS, loopbackTransport, pageServer, PRIVATE_ANSWERS, PRIVATE_FORMS, type TransportCall } from "./webFakes.js";

const servers: Array<http.Server | net.Server> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const noDns = async (): Promise<readonly string[]> => {
  throw Object.assign(new Error("no live dns in tests"), { code: "ENOTFOUND" });
};

describe("the fetch guard through the adapter (deny)", () => {
  it("refuses every private, loopback, metadata and malformed form before any request, each for its own reason", async () => {
    const calls: TransportCall[] = [];
    const backend = createWebBackend();
    // Each name answers its own private address, so the refusal is the guard's verdict on it.
    const resolveHost = fakeResolver(PRIVATE_ANSWERS);
    for (const form of PRIVATE_FORMS) {
      const result = await backend.fetchPage(form, { privateAddressPolicy: "deny", resolveHost, transport: loopbackTransport(1, calls), timeoutMs: 2_000 });
      expect(result, form).toMatchObject({ ok: false, code: "private_address" });
    }
    for (const form of INVALID_FORMS) {
      const result = await backend.fetchPage(form, { privateAddressPolicy: "deny", resolveHost: noDns, transport: loopbackTransport(1, calls), timeoutMs: 2_000 });
      expect(result, form).toMatchObject({ ok: false, code: "invalid_url" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a name that resolves to ::ffff:0:10.0.0.1 (an IPv4-translated private address), or to any private answer among several", async () => {
    const calls: TransportCall[] = [];
    const backend = createWebBackend();
    const resolveHost = fakeResolver({ "evil.test": ["::ffff:0:10.0.0.1"], "mixed.test": ["93.184.216.34", "10.0.0.7"], "meta.test": ["169.254.169.254"] });
    for (const host of ["evil.test", "mixed.test", "meta.test"]) {
      const result = await backend.fetchPage(`https://${host}/`, { privateAddressPolicy: "deny", resolveHost, transport: loopbackTransport(1, calls) });
      expect(result, host).toMatchObject({ ok: false, code: "private_address" });
    }
    expect(calls).toEqual([]);
  });

  it("re-checks every redirect hop: private targets, other schemes and credentials are refused", async () => {
    const calls: TransportCall[] = [];
    const routes: Record<string, { status: number; type: string; body: string; headers: Record<string, string> }> = {};
    for (const [name, location] of Object.entries({
      ftp: "ftp://public.test/",
      file: "file:///etc/passwd",
      creds: "https://u:p@public.test/",
      inside: "https://inside.test/",
      loop: "https://[::1]/",
      lan: "http://10.0.0.1/"
    })) {
      routes[`/r/${name}`] = { status: 302, type: "text/plain", body: "", headers: { location } };
    }
    const page = await pageServer(routes, servers as http.Server[]);
    const backend = createWebBackend();
    const resolveHost = fakeResolver({ "inside.test": ["10.1.1.1"] });
    for (const name of ["ftp", "file", "creds", "inside", "loop", "lan"]) {
      const result = await backend.fetchPage(`https://public.test/r/${name}`, { privateAddressPolicy: "deny", resolveHost, transport: loopbackTransport(page.port, calls) });
      expect(result.ok, name).toBe(false);
    }
    // Only the first hop of each ever reached the transport.
    expect(calls.every((call) => call.url.includes("/r/"))).toBe(true);
    expect(calls.every((call) => call.address === "93.184.216.34")).toBe(true);
  });
});

describe("hostile pages", () => {
  it("converts 5 MiB of unclosed '<' and unclosed drop-tags well under a second without stalling the event loop", async () => {
    const size = 5 * 1024 * 1024;
    const page = await pageServer(
      {
        "/lt": { body: "<".repeat(size) },
        "/drop": { body: `<p>hello</p>${"<script<style<svg<title<!--".repeat(Math.floor(size / 27))}` }
      },
      servers as http.Server[]
    );
    const backend = createWebBackend();
    for (const route of ["/lt", "/drop"]) {
      // Node's own event-loop delay histogram, sampled every 5 ms: its max is the longest stall.
      const lag = monitorEventLoopDelay({ resolution: 5 });
      lag.enable();
      const started = performance.now();
      const result = await backend.fetchPage(`https://public.test${route}`, {
        privateAddressPolicy: "deny",
        resolveHost: fakeResolver(),
        transport: loopbackTransport(page.port),
        maxBytes: 6 * 1024 * 1024
      });
      const elapsed = performance.now() - started;
      lag.disable();
      expect(result.ok, route).toBe(true);
      expect(elapsed, route).toBeLessThan(1_000);
      expect(lag.max / 1e6, route).toBeLessThan(250);
    }
  });

  it("caps a compression bomb and times out a slow drip", async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const drip = http.createServer((request, response) => {
      if (request.url === "/gz") {
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        response.end(bomb);
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => response.write("a"), 100);
      response.on("close", () => clearInterval(timer));
    });
    servers.push(drip);
    await new Promise<void>((resolve) => drip.listen(0, "127.0.0.1", resolve));
    const port = (drip.address() as net.AddressInfo).port;
    const backend = createWebBackend();
    const options = { privateAddressPolicy: "deny" as const, resolveHost: fakeResolver(), transport: loopbackTransport(port) };
    const capped = await backend.fetchPage("https://public.test/gz", { ...options, maxBytes: 1024 * 1024 });
    if (capped.ok) {
      expect(capped.truncated).toBe(true);
      expect(capped.text.length).toBeLessThanOrEqual(1024 * 1024);
    } else {
      expect(capped.code).toBe("too_large");
    }
    const started = performance.now();
    const slow = await backend.fetchPage("https://public.test/drip", { ...options, timeoutMs: 800 });
    expect(slow).toMatchObject({ ok: false, code: "timeout" });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("proxy environment variables", () => {
  it("never route a page fetch through a proxy (NODE_USE_ENV_PROXY, HTTP(S)_PROXY set)", { timeout: 30_000 }, async () => {
    const proxySeen: string[] = [];
    const proxy = http.createServer((request, response) => {
      proxySeen.push(`${request.method} ${request.url}`);
      response.end("from-proxy");
    });
    proxy.on("connect", (request, socket) => {
      proxySeen.push(`CONNECT ${request.url}`);
      socket.end();
    });
    let originConnections = 0;
    const origin = net.createServer((socket) => {
      originConnections += 1;
      socket.destroy();
    });
    servers.push(proxy, origin);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsx = path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsx, path.join(here, "fixtures", "webProxyChild.ts"), String((origin.address() as net.AddressInfo).port)], {
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" }
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await new Promise((resolve) => child.on("close", resolve));
    const line = output.trim().split("\n").pop() ?? "";
    expect(JSON.parse(line)).toMatchObject({ ok: false });
    expect(proxySeen).toEqual([]);
    expect(originConnections).toBeGreaterThan(0);
  });
});

describe("Exa search through the adapter", () => {
  it("searches keyless first and parses the results", async () => {
    const { endpoint, seen } = await fakeExa({ anonymous: "ok", keyed: "ok", sse: true }, servers as http.Server[]);
    const backend = createWebBackend({ exaEndpoint: endpoint, exaState: createExaBackendState(), resolveExaKey: () => "exa-secret-key", sleep: async () => undefined });
    const result = await backend.search({ query: "best brownies", numResults: 5 });
    expect(result).toMatchObject({ ok: true, tier: "anonymous" });
    if (!result.ok) return;
    expect(result.results.map((hit) => [hit.title, hit.url])).toEqual([
      ["Fudgy Brownies", "https://bake.example/brownies"],
      ["Brownie science", "https://science.example/brownies"]
    ]);
    expect(seen.filter((entry) => entry.method === "tools/call").every((entry) => !entry.apiKey)).toBe(true);
    await backend.close();
  });

  it("falls back to the saved key as an x-api-key header only, and a changed key gets a new client", async () => {
    const { endpoint, seen } = await fakeExa({ anonymous: "429", keyed: "ok", sse: false }, servers as http.Server[]);
    let key = "exa-key-one";
    const backend = createWebBackend({ exaEndpoint: endpoint, exaState: createExaBackendState(), resolveExaKey: () => key, sleep: async () => undefined });
    expect(await backend.search({ query: "q" })).toMatchObject({ ok: true, tier: "key" });
    key = "exa-key-two";
    expect(await backend.search({ query: "q2" })).toMatchObject({ ok: true, tier: "key" });
    const keys = seen.filter((entry) => entry.method === "tools/call" && entry.apiKey).map((entry) => entry.apiKey);
    expect(keys).toEqual(["exa-key-one", "exa-key-two"]);
    expect(seen.every((entry) => !entry.url.includes("exa-key"))).toBe(true);
    await backend.close();
  });

  it("a key change while a search is in flight lets that search finish on the old client (review F15)", async () => {
    const { endpoint, seen } = await fakeExa({ anonymous: "429", keyed: "ok", sse: false, keyedDelayMs: 150 }, servers as http.Server[]);
    let key = "exa-key-one";
    const backend = createWebBackend({ exaEndpoint: endpoint, exaState: createExaBackendState(), resolveExaKey: () => key, sleep: async () => undefined });
    const first = backend.search({ query: "q1" });
    const deadline = Date.now() + 5_000;
    while (!seen.some((entry) => entry.method === "tools/call" && entry.apiKey === "exa-key-one") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    key = "exa-key-two";
    const second = backend.search({ query: "q2" });
    expect(await first).toMatchObject({ ok: true, tier: "key" });
    expect(await second).toMatchObject({ ok: true, tier: "key" });
    await backend.close();
  });

  it("returns typed failures: keyless rate limit without a key, a tool error, an unreachable backend", async () => {
    const limited = await fakeExa({ anonymous: "rate-text", keyed: "ok", sse: false }, servers as http.Server[]);
    const noKey = createWebBackend({ exaEndpoint: limited.endpoint, exaState: createExaBackendState(), sleep: async () => undefined });
    expect(await noKey.search({ query: "q" })).toMatchObject({ ok: false, code: "quota_exhausted" });
    const broken = await fakeExa({ anonymous: "tool-error", keyed: "ok", sse: false }, servers as http.Server[]);
    const failing = createWebBackend({ exaEndpoint: broken.endpoint, exaState: createExaBackendState(), sleep: async () => undefined });
    expect(await failing.search({ query: "q" })).toMatchObject({ ok: false, code: "backend_error" });
    const down = createWebBackend({ exaEndpoint: "http://127.0.0.1:1/mcp", exaState: createExaBackendState(), sleep: async () => undefined });
    const unreachable = await down.search({ query: "x" });
    expect(unreachable.ok).toBe(false);
    await Promise.all([noKey.close(), failing.close(), down.close()]);
  });
});
