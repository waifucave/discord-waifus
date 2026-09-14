import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = (value: number) => Buffer.alloc(32, value).toString("base64url");

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function contextResponse(csrf: string): Response {
  return new Response(JSON.stringify({ mode: "host" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-waifus-csrf": csrf
    }
  });
}

describe("frontend browser security bootstrap", () => {
  it("establishes one credentialed client context and keeps CSRF only in request headers", async () => {
    const csrf = token(0x11);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input) === "/api/client-context") return contextResponse(csrf);
      return new Response(JSON.stringify({ paused: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    const { api, loadClientContext } = await import("../src/frontend/api/client.js");
    await api.pause();
    await expect(loadClientContext()).resolves.toEqual({ mode: "host" });

    expect(calls.map(({ url }) => url)).toEqual([
      "/api/client-context",
      "/api/runtime/pause"
    ]);
    expect(calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(calls[1].init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(calls[1].init?.headers).get("x-waifus-csrf")).toBe(csrf);
    expect(new Headers(calls[1].init?.headers).get("idempotency-key"))
      .toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(calls)).not.toContain(`\"body\":\"${csrf}`);
  });

  it("re-establishes the session once after a pre-handler expiry rejection", async () => {
    const first = token(0x21);
    const second = token(0x22);
    const mutationTokens: string[] = [];
    const idempotencyKeys: string[] = [];
    let contextCount = 0;
    let mutationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/client-context") {
        contextCount += 1;
        return contextResponse(contextCount === 1 ? first : second);
      }
      mutationCount += 1;
      mutationTokens.push(new Headers(init?.headers).get("x-waifus-csrf") ?? "");
      idempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (mutationCount === 1) {
        return new Response(JSON.stringify({
          error: "BrowserSessionRequired",
          message: "Browser session is missing or expired."
        }), {
          status: 403,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ paused: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    const { api } = await import("../src/frontend/api/client.js");
    await api.pause();

    expect(contextCount).toBe(2);
    expect(mutationCount).toBe(2);
    expect(mutationTokens).toEqual([first, second]);
    expect(idempotencyKeys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  });

  it("retries a reconciled transport break once with the same logical key", async () => {
    const csrf = token(0x31);
    const keys: string[] = [];
    let mutationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/client-context") return contextResponse(csrf);
      mutationCount += 1;
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (mutationCount === 1) throw new TypeError("direct path changed");
      return new Response(JSON.stringify({ paused: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    const { api } = await import("../src/frontend/api/client.js");
    await expect(api.pause()).resolves.toEqual({ paused: true });

    expect(mutationCount).toBe(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(keys[1]).toBe(keys[0]);
  });

  it("does not replay a non-replayable action after a transport break", async () => {
    const csrf = token(0x41);
    let mutationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/client-context") return contextResponse(csrf);
      mutationCount += 1;
      throw new TypeError("direct path changed");
    }));

    const { api } = await import("../src/frontend/api/client.js");
    const { LogicalMutationOutcomeUnknownError } = await import(
      "../src/frontend/api/logicalMutation.js"
    );
    await expect(api.triggerOrchestrator({ guildId: "1", channelId: "2" }))
      .rejects.toBeInstanceOf(LogicalMutationOutcomeUnknownError);
    expect(mutationCount).toBe(1);
  });
});
