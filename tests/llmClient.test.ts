import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `src/frontend/api/llm.ts` module-memoizes `llmModels()` (a single promise) and `llmModel()`
// (a Map of promises) at module scope. To test the "clear the memo on rejection" behavior for
// more than one scenario per file, each test resets the module registry and re-imports the
// module dynamically so it starts from a clean, un-memoized state.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("llmModels", () => {
  it("clears the memo on a rejected fetch so a later call can succeed", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return jsonResponse({ models: [{ providerId: "openai", modelId: "gpt-5.2" }] });
    }) as unknown as typeof fetch;

    const { llmModels } = await import("../src/frontend/api/llm.js");

    await expect(llmModels()).rejects.toThrow();
    const models = await llmModels();

    expect(models).toEqual([{ providerId: "openai", modelId: "gpt-5.2" }]);
    expect(calls).toBe(2);
  });

  it("still memoizes across concurrent/successive calls once it has resolved", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return jsonResponse({ models: [{ providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" }] });
    }) as unknown as typeof fetch;

    const { llmModels } = await import("../src/frontend/api/llm.js");

    const [first, second] = await Promise.all([llmModels(), llmModels()]);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });
});

describe("llmModel", () => {
  it("clears the cache entry on a rejected fetch so a later call for the same key can succeed", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return jsonResponse({ providerId: "openai", modelId: "gpt-5.2", params: {} });
    }) as unknown as typeof fetch;

    const { llmModel } = await import("../src/frontend/api/llm.js");

    await expect(llmModel("openai", "gpt-5.2")).rejects.toThrow();
    const resolved = await llmModel("openai", "gpt-5.2");

    expect(resolved).toMatchObject({ providerId: "openai", modelId: "gpt-5.2" });
    expect(calls).toBe(2);
  });

  it("encodes each path segment individually for modelIds that contain '/' (e.g. openrouter route ids)", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6", params: {} });
    }) as unknown as typeof fetch;

    const { llmModel } = await import("../src/frontend/api/llm.js");

    await llmModel("openrouter", "moonshotai/kimi-k2.6");

    expect(capturedUrl).toBe("/api/llm/v1/models/openrouter/moonshotai/kimi-k2.6");
  });
});
