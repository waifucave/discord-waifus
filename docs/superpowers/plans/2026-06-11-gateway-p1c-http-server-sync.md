# Gateway P1c: HTTP Server + Fastify Plugin + Bin + Drift Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@waifucave/gateway` its HTTP surface (MIGRATION_PLAN §4.6: the five `/v1` endpoints as a framework-agnostic `Request → Response` handler, a Fastify plugin, a standalone `gateway serve` bin) and the §4.7 drift check (`gateway sync` against OpenRouter `/models` + native model lists) — completing the P1 exit criteria ("`gateway serve` answers all 5 endpoints").

**Architecture:** The core handler is a plain `(request: Request) => Promise<Response>` built on the existing `Gateway` client (registry → validation → codec → transport, all from P1a/P1b — the handler adds NO model logic of its own). The Fastify plugin and the `node:http` adapter are thin transports around that one handler. Streaming chat probes the generator's first event so pre-I/O failures (validation, credentials, unknown model) map to real HTTP statuses instead of a 200 SSE. `gateway sync` is a read-only reporter: it fetches remote model lists, diffs ids/context/pricing against the registry, prints findings, and never mutates data.

**Tech Stack:** TypeScript (ESM, NodeNext, strict, `noUncheckedIndexedAccess`), Node ≥ 20 (global `fetch`/`Request`/`Response`/`ReadableStream`, `util.parseArgs`, `AbortSignal.timeout`), Vitest. **Zero runtime dependencies** — Fastify becomes an *optional peer* + devDependency; `src/server/fastify.ts` may use only `import type` from fastify.

**Repo location:** `/Users/example/Xcode projects/waifucave-gateway`. All commands run from there. Committing directly to `main` is the agreed workflow; push only after final review.

**Context docs:** `Discord Waifus/MIGRATION_PLAN.md` (§4.6 HTTP API, §4.7 drift sync, §4.5 unified shapes, §5 provider matrix), P1b plan + execution record (`2026-06-11-gateway-p1b-codecs-transport-client.md`) — its carryovers #2 (timeout covers headers only), #3 (chat/stream abort asymmetry), #5 (client-level integration tests for responses/google wires) are addressed by this plan; #1 (Gemini-3 functionCall `thoughtSignature`) and #4 (registry data gaps) are explicitly NOT.

---

## Hard rules

1. **Zero runtime deps stays true.** `package.json` `dependencies` must remain absent. Fastify is `devDependencies` + optional `peerDependencies` only, and `src/server/fastify.ts` must import it with `import type` exclusively — `grep -rn 'from "fastify"' dist` after build must return nothing.
2. **The handler adds no model logic.** Everything model-shaped goes through `Gateway`/`Registry`/`validateRequest`. If an endpoint seems to need new model logic, STOP — that's a P1a/P1b extension with its own test, not handler code.
3. **`data/` is authoritative.** If a golden expectation conflicts with what the registry produces, print the data and fix the *test expectation* — never silently edit data. Data edits need a stated reason in the commit message.
4. **Do not loosen P1a/P1b behavior** (validator, codecs, transport, client) to make a server test pass. The one sanctioned client edit in this plan is additive jsdoc (Task 9). A genuine bug found in earlier layers gets its own test + commit.
5. **Sync never mutates.** `runSync` reads remote lists and reports. No file writes, no registry patches, no "auto-fix" flags.

## Verified facts this plan is written against

Audited 2026-06-11 against the live repo (`npm test`, `Registry.load()`, `validateRequest`, P1b test fixtures), so the goldens below are exact:

- Suite is **155 tests green** across 15 files; build + typecheck clean.
- `Registry.load()`: **100 routes** across **14 providers** (`PROVIDERS.length === 14`); per-provider route counts: openrouter 53, google-ai-studio 9, openai 7, anthropic 6, zai 4, qwen 4, xai 3, xiaomi 3, deepseek 2, minimax 2, moonshot 2, nvidia 2, stepfun 2, mistral 1. `registry.diagnostics()` returns **14 warnings**, all `unmapped supportedParameters entry "max_completion_tokens"`-style.
- OpenRouter model ids contain slashes (`moonshotai/kimi-k2.6`, `anthropic/claude-haiku-4.5`) — `GET /v1/models/:provider/:model` MUST treat everything after the provider segment as the model id.
- `deepseek:deepseek-v4-pro` resolved: family `deepseek-v4-pro`, displayName `DeepSeek V4 Pro`, company `DeepSeek`, wire `openai-chat`, baseUrl `https://api.deepseek.com`, endpoint `/chat/completions`, limits `{contextTokens: 1000000, maxOutputTokens: 384000}`, pricing `{inputPerMTok: 0.435, outputPerMTok: 0.87, cachedInputPerMTok: 0.003625}`, streaming/tools true, `structuredOutput {jsonMode: true, jsonSchema: false, strict: false}`, modalities input `["text"]`, deprecated false, confidence `verified`. **`reasoning.enabled` defaults to TRUE in data**, so validating `{}` already fires the `thinking-drops-sampling` warnings.
- Pinned `validateRequest` outputs on `deepseek:deepseek-v4-pro` (these are the `/v1/validate` goldens):
  - `{ params: { temperature: 99 } }` → `{"ok":false,"violations":[{"param":"temperature","code":"out_of_range","message":"temperature must be in [0, 2]"}],"warnings":[{"ruleId":"thinking-drops-sampling","param":"temperature","code":"dropped"},{"ruleId":"thinking-drops-sampling","param":"topP","code":"dropped"}],"effectiveParams":{"reasoning.enabled":true,"reasoning.effort":"high"}}`
  - `{ params: { "reasoning.enabled": true }, toolChoice: "required" }` → `ok:false` with violation `{"ruleId":"thinking-no-forced-tools","param":"toolChoice","code":"forbidden_value","value":"required"}` (same two warnings).
- P1b golden wire body, reused for HTTP chat tests — `deepseek:deepseek-v4-pro`, messages `[{role:"user",content:"hi"}]`, params `{temperature:0.7,"reasoning.enabled":true}` encodes to URL `https://api.deepseek.com/chat/completions`, header `authorization: Bearer <key>`, body `{"model":"deepseek-v4-pro","thinking":{"type":"enabled"},"reasoning_effort":"high","messages":[{"role":"user","content":"hi"}]}`; streaming adds `stream:true, stream_options:{include_usage:true}`.
- `openai:gpt-5.5` resolved: family `gpt-5-5`, displayName `GPT-5.5`, baseUrl `https://api.openai.com/v1`, endpoint `/responses`, params only `maxOutputTokens, reasoning.effort, verbosity, responseFormat`, limits `{contextTokens: 1050000, maxOutputTokens: 128000}`, jsonSchema true, image input true. Responses SSE framing uses named events (`event: response.output_text.delta`, `event: response.completed`) — fixture shapes in `tests/codecs/openaiResponses.test.ts:163-196`.
- `google-ai-studio:gemini-2.5-flash` resolved: family `gemini-2-5-flash`, displayName `Gemini 2.5 Flash`, endpoint `:generateContent`; `buildUrl(model, true)` produces `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`; auth header is `x-goog-api-key`. Google SSE frames are plain `data:` lines — fixture shapes in `tests/codecs/googleGenerativeLanguage.test.ts:239-280` (note synthesized tool-call id `call_0`).
- `gateway.stream()` contract (pinned in P1b): pre-I/O failures (unknown model, validation, missing credential) **reject the first `next()`**; transport/decode failures arrive as a final `{type:"error"}` event. `gateway.chat()` throws `GatewayError` for everything except aborts, which propagate as the raw abort reason (carryover #3).
- `fetchWithRetry` `timeoutMs` covers time-to-headers only (carryover #2). The server must NOT try to bound stream duration — it pipes until the generator ends or the client goes away.
- `fetchWithRetry` keeps the caller's `signal` wired to the response body on the success path — aborting the signal after headers kills the body read. This is what makes the server's client-disconnect propagation work.
- Discord Waifus (the P2 consumer) uses `fastify: ^5.8.5` → peer range `^5.0.0`.
- Warning serialization through the client: `{code:"param_dropped",param:"temperature",ruleId:"thinking-drops-sampling",message:"temperature was dropped by constraint rule thinking-drops-sampling"}` (and the `topP` twin). Order: validation warnings first, then codec warnings, then decode warnings.

**NOT live-verified (design defends accordingly):** the remote model-list endpoint shapes for sync are from documented conventions, not live probes (no API keys in this session): OpenRouter `GET /api/v1/models` (public) → `{data:[{id, context_length, pricing:{prompt,completion}}]}` with per-token USD *string* prices; OpenAI-compatible `GET {base}/models` → `{data:[{id}]}`; Anthropic `GET {base}/v1/models?limit=1000` with `x-api-key` + `anthropic-version` → `{data:[{id}]}`; Google `GET {base}/v1beta/models?pageSize=1000` with `x-goog-api-key` → `{models:[{name:"models/<id>"}], nextPageToken?}`. Sync therefore treats every remote failure/shape surprise as a `warning` finding ("model list unavailable"), never a crash. If a later live run reveals a different shape, fix the parser with a fixture — do not weaken the failure tolerance.

## Explicitly OUT of P1c scope (flag, don't fix)

1. Gemini-3 functionCall `thoughtSignature` drop (P1b carryover #1) — revisit in P2/P3 if live tool loops need it.
2. Registry data gaps (P1b carryover #4: Anthropic adaptive thinking, thinking×sampling force, DeepSeek `reasoning_effort` riding along, `thinking.redacted` wireName) — data work, not server work.
3. Scheduled CI for `gateway sync` — MIGRATION_PLAN §8 puts drift-check CI in P6.
4. CORS / auth on the gateway's own HTTP surface — the Fastify mount is same-origin inside the host app; standalone binds `127.0.0.1` by default and is local tooling. Do not add either.
5. Mounting at `/api/llm/*` inside Discord Waifus — that's P2.

## File structure

```
waifucave-gateway/
├── package.json                  # modify: fastify devDep+optional peer (T5), bin (T6), exports subpath (T9)
├── src/
│   ├── index.ts                  # modify (T9): export server/sync public surface (NOT the fastify plugin)
│   ├── client/gateway.ts         # modify (T9): jsdoc only — document abort behavior (carryover #3)
│   ├── server/
│   │   ├── shared.ts             # new (T1): kind→status map, serializeGatewayError, jsonResponse, errorResponse
│   │   ├── env.ts                # new (T2): envCredentials (standalone-mode credential lookup)
│   │   ├── handler.ts            # new (T2, extended T3+T4): createGatewayHandler — the 5 endpoints
│   │   ├── fastify.ts            # new (T5): gatewayPlugin (type-only fastify imports)
│   │   └── node.ts               # new (T6): serve() — node:http ↔ Request/Response adapter
│   ├── sync/
│   │   ├── sync.ts               # new (T7): runSync + SyncFinding/SyncReport/SyncOptions
│   │   └── report.ts             # new (T8): formatSyncReport
│   └── bin/
│       ├── cli.ts                # new (T6, extended T8): runCli (testable, IO injected)
│       └── gateway.ts            # new (T6): #!/usr/bin/env node wrapper
└── tests/
    ├── helpers/http.ts           # new (T3): jsonFetch / sseFetch / parseSseFrames shared fakes
    ├── server/shared.test.ts     # new (T1)
    ├── server/handler.test.ts    # new (T2, extended T3+T4)
    ├── server/fastify.test.ts    # new (T5)
    ├── server/node.test.ts       # new (T6)
    ├── bin/cli.test.ts           # new (T6, extended T8)
    ├── sync/sync.test.ts         # new (T7)
    ├── sync/report.test.ts       # new (T8)
    └── fixtures/sync/registry.json  # new (T7): tiny synthetic registry for sync tests
```

Dependency direction: `bin/cli` → (`server/node`, `sync/*`, `server/env`); `server/node` & `server/fastify` → `server/handler` → (`client/gateway`, `server/shared`, `registry/providers`); `sync/sync` → (`registry/loader`, `registry/providers`). Nothing under `src/server` or `src/sync` is imported by P1a/P1b modules — no cycles.

---

### Task 1: Server shared helpers — error→HTTP mapping + serialization

The HTTP layer needs one place that turns `GatewayError`s into status codes and JSON-safe bodies. `raw`/`cause` are deliberately dropped from serialization (provider bodies can be huge or unserializable — `extractErrorMessage` already mined them for the message).

**Files:**
- Create: `src/server/shared.ts`
- Test: `tests/server/shared.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/shared.test.ts
import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { errorResponse, httpStatusForError, jsonResponse, serializeGatewayError } from "../../src/server/shared.js";

describe("httpStatusForError", () => {
  it("maps every GatewayError kind to a status", () => {
    const expected: Array<[ConstructorParameters<typeof GatewayError>[0], number]> = [
      ["auth", 401],
      ["rate_limit", 429],
      ["quota", 402],
      ["invalid_request", 400],
      ["unsupported_parameter", 400],
      ["content_filter", 422],
      ["timeout", 504],
      ["server", 502],
      ["network", 502]
    ];
    for (const [kind, status] of expected) {
      expect(httpStatusForError(new GatewayError(kind, "x")), kind).toBe(status);
    }
  });
});

describe("serializeGatewayError", () => {
  it("keeps kind/message/provider/status/retryable and drops raw and cause", () => {
    const error = new GatewayError("rate_limit", "slow down", {
      provider: "deepseek",
      status: 429,
      raw: { secret: "do-not-leak" },
      cause: new Error("inner")
    });
    expect(serializeGatewayError(error)).toEqual({
      kind: "rate_limit",
      message: "slow down",
      provider: "deepseek",
      status: 429,
      retryable: true
    });
  });

  it("omits provider/status when absent", () => {
    expect(serializeGatewayError(new GatewayError("invalid_request", "bad"))).toEqual({
      kind: "invalid_request",
      message: "bad",
      retryable: false
    });
  });
});

describe("jsonResponse", () => {
  it("builds a JSON response with the given status", async () => {
    const response = jsonResponse(418, { hello: "world" });
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ hello: "world" });
  });
});

describe("errorResponse", () => {
  it("maps GatewayErrors through the status table", async () => {
    const response = errorResponse(new GatewayError("auth", "no key", { provider: "xai" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { kind: "auth", message: "no key", provider: "xai", retryable: false }
    });
  });

  it("returns 499 network for non-GatewayError failures when the request signal is aborted (carryover #3 normalization)", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client went away"));
    const response = errorResponse(new Error("client went away"), controller.signal);
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({
      error: { kind: "network", message: "client aborted the request", retryable: false }
    });
  });

  it("returns 500 server for unexpected non-GatewayError failures", async () => {
    const response = errorResponse(new TypeError("boom"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe("server");
    expect(body.error.message).toContain("boom");
  });

  it("prefers the GatewayError mapping even when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(errorResponse(new GatewayError("unsupported_parameter", "x"), controller.signal).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server/shared.test.ts`
Expected: FAIL — cannot resolve `../../src/server/shared.js`.

- [ ] **Step 3: Implement `src/server/shared.ts`**

```ts
import { GatewayError, type GatewayErrorKind } from "../errors.js";

/** GatewayError kind → HTTP status for the gateway's own API responses. */
const STATUS_FOR_KIND: Record<GatewayErrorKind, number> = {
  auth: 401,
  rate_limit: 429,
  quota: 402,
  invalid_request: 400,
  unsupported_parameter: 400,
  content_filter: 422,
  timeout: 504,
  server: 502,
  network: 502
};

export function httpStatusForError(error: GatewayError): number {
  return STATUS_FOR_KIND[error.kind];
}

export type SerializedGatewayError = {
  kind: GatewayErrorKind;
  message: string;
  provider?: string;
  status?: number;
  retryable: boolean;
};

/** JSON-safe projection of a GatewayError. Drops raw/cause: provider bodies can be huge or unserializable. */
export function serializeGatewayError(error: GatewayError): SerializedGatewayError {
  const out: SerializedGatewayError = { kind: error.kind, message: error.message, retryable: error.retryable };
  if (error.provider !== undefined) out.provider = error.provider;
  if (error.status !== undefined) out.status = error.status;
  return out;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * One error→Response path for the whole HTTP layer. Carryover #3 normalization:
 * chat() rejects with the RAW abort reason (not a GatewayError) when the caller
 * aborts, and stream()'s first next() does the same pre-I/O — both land here and
 * become a uniform 499 when the request signal is aborted.
 */
export function errorResponse(error: unknown, signal?: AbortSignal): Response {
  if (error instanceof GatewayError) {
    return jsonResponse(httpStatusForError(error), { error: serializeGatewayError(error) });
  }
  if (signal?.aborted) {
    return jsonResponse(499, { error: { kind: "network", message: "client aborted the request", retryable: false } });
  }
  return jsonResponse(500, { error: { kind: "server", message: `unexpected error: ${String(error)}`, retryable: false } });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/server/shared.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/server/shared.ts tests/server/shared.test.ts
git commit -m "feat: add server error mapping and serialization helpers"
```
Expected: typecheck clean; 163 tests green (155 + 8).

---

### Task 2: Handler — routing + the three registry GET endpoints

`createGatewayHandler` owns routing for all five endpoints; this task lands `GET /v1/providers`, `GET /v1/models`, `GET /v1/models/:provider/:model`, plus 404/405 behavior. Model detail must support slash-bearing OpenRouter ids: everything after the provider segment is the model id. Model summaries are computed once at construction (the registry is immutable). Also lands `envCredentials` — the standalone-mode credential lookup the bin will use.

**Files:**
- Create: `src/server/env.ts`
- Create: `src/server/handler.ts`
- Test: `tests/server/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/handler.test.ts
import { describe, expect, it } from "vitest";
import { createGatewayHandler } from "../../src/server/handler.js";
import { envCredentials } from "../../src/server/env.js";

const get = (handler: ReturnType<typeof createGatewayHandler>, path: string, init?: RequestInit) =>
  handler.handle(new Request(`http://gateway.test${path}`, init));

describe("envCredentials", () => {
  it("resolves each provider's documented env var and treats empty as unset", () => {
    const lookup = envCredentials({ DEEPSEEK_API_KEY: "sk-env", ANTHROPIC_API_KEY: "" });
    expect(lookup("deepseek")).toBe("sk-env");
    expect(lookup("anthropic")).toBeUndefined();
    expect(lookup("openrouter")).toBeUndefined();
    expect(lookup("not-a-provider")).toBeUndefined();
  });
});

describe("GET /v1/providers", () => {
  it("lists all 14 providers with credential status", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test", anthropic: "" } });
    const response = await get(handler, "/v1/providers");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Array<Record<string, unknown>> };
    expect(body.providers).toHaveLength(14);
    const deepseek = body.providers.find((p) => p.id === "deepseek");
    expect(deepseek).toEqual({
      id: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      credentialEnv: "DEEPSEEK_API_KEY",
      wire: "openai-chat",
      credentialConfigured: true
    });
    // empty string counts as unconfigured; absent counts as unconfigured
    expect(body.providers.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
    expect(body.providers.find((p) => p.id === "openrouter")?.credentialConfigured).toBe(false);
  });

  it("supports credential lookup functions", async () => {
    const handler = createGatewayHandler({ credentials: (id) => (id === "xai" ? "sk-x" : undefined) });
    const body = (await (await get(handler, "/v1/providers")).json()) as { providers: Array<Record<string, unknown>> };
    expect(body.providers.find((p) => p.id === "xai")?.credentialConfigured).toBe(true);
    expect(body.providers.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(false);
  });
});

describe("GET /v1/models", () => {
  it("returns all 100 routes with summary flags", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models).toHaveLength(100);
    expect(body.models.find((m) => m.providerId === "deepseek" && m.modelId === "deepseek-v4-pro")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      family: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      company: "DeepSeek",
      wire: "openai-chat",
      contextTokens: 1000000,
      maxOutputTokens: 384000,
      streaming: true,
      tools: true,
      reasoning: true,
      jsonMode: true,
      jsonSchema: false,
      imageInput: false,
      deprecated: false,
      confidence: "verified"
    });
    const gpt = body.models.find((m) => m.providerId === "openai" && m.modelId === "gpt-5.5");
    expect(gpt).toMatchObject({
      family: "gpt-5-5",
      displayName: "GPT-5.5",
      wire: "openai-responses",
      contextTokens: 1050000,
      jsonSchema: true,
      imageInput: true,
      reasoning: true
    });
  });
});

describe("GET /v1/models/:provider/:model", () => {
  it("returns the full resolved capability doc", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/deepseek/deepseek-v4-pro");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      wire: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      endpoint: "/chat/completions",
      limits: { contextTokens: 1000000, maxOutputTokens: 384000 }
    });
    expect(body.params).toHaveProperty("temperature");
    expect(Array.isArray(body.constraints)).toBe(true);
  });

  it("joins trailing segments so OpenRouter slash ids resolve", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/openrouter/moonshotai/kimi-k2.6");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providerId: "openrouter",
      modelId: "moonshotai/kimi-k2.6",
      family: "kimi-k2-6",
      displayName: "Kimi K2.6",
      baseUrl: "https://openrouter.ai/api/v1"
    });
  });

  it("404s for unknown models with a serialized error", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/models/deepseek/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { kind: "invalid_request", message: "unknown model deepseek:nope", retryable: false }
    });
  });
});

describe("routing", () => {
  it("404s outside /v1 and for unknown /v1 paths", async () => {
    const handler = createGatewayHandler();
    expect((await get(handler, "/")).status).toBe(404);
    expect((await get(handler, "/api/llm/v1/providers")).status).toBe(404);
    expect((await get(handler, "/v1/nope")).status).toBe(404);
  });

  it("405s wrong methods on known paths with an allow header", async () => {
    const handler = createGatewayHandler();
    const response = await get(handler, "/v1/providers", { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    const chat = await get(handler, "/v1/chat");
    expect(chat.status).toBe(405);
    expect(chat.headers.get("allow")).toBe("POST");
  });

  it("tolerates trailing slashes and URL-encoded segments", async () => {
    const handler = createGatewayHandler();
    expect((await get(handler, "/v1/providers/")).status).toBe(200);
    expect((await get(handler, "/v1/models/deepseek/deepseek-v4-pro/")).status).toBe(200);
    expect((await get(handler, "/v1/models/deepseek/deepseek%2Dv4%2Dpro")).status).toBe(200);
  });
});
```

Note: `/v1/chat` and `/v1/validate` only get their 405 pins here; their POST behavior is Tasks 3–4 (the routing skeleton in this task returns 405 for wrong methods and a `not_implemented` 500 is NOT acceptable — wire the real handlers in as later tasks fill them; until then have the route functions throw `new GatewayError("server", "not implemented")` and do NOT test POST behavior in this task).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server/handler.test.ts`
Expected: FAIL — cannot resolve handler/env modules.

- [ ] **Step 3: Implement `src/server/env.ts`**

```ts
import { PROVIDERS } from "../registry/providers.js";

const ENV_BY_PROVIDER = new Map(PROVIDERS.map((provider) => [provider.id, provider.credentialEnv]));

/** Standalone-mode credentials (§4.6): resolve each provider's documented env var. Empty values count as unset. */
export function envCredentials(env: Record<string, string | undefined> = process.env): (providerId: string) => string | undefined {
  return (providerId) => {
    const name = ENV_BY_PROVIDER.get(providerId);
    const value = name === undefined ? undefined : env[name];
    return value === undefined || value === "" ? undefined : value;
  };
}
```

- [ ] **Step 4: Implement `src/server/handler.ts` (routing + GET endpoints; POST routes stubbed)**

```ts
import { Gateway, type GatewayOptions } from "../client/gateway.js";
import { PROVIDERS } from "../registry/providers.js";
import { GatewayError } from "../errors.js";
import { jsonResponse } from "./shared.js";

export type GatewayHandlerOptions = GatewayOptions;

export type ModelSummary = {
  providerId: string;
  modelId: string;
  family: string;
  displayName: string;
  company: string;
  wire: string;
  contextTokens: number;
  maxOutputTokens: number;
  streaming: boolean;
  tools: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  jsonSchema: boolean;
  imageInput: boolean;
  deprecated: boolean;
  confidence: string;
  routeStatus?: string;
};

export type GatewayHttpHandler = {
  /** Framework-agnostic entry point (§4.6): plain Fetch Request in, Response out. */
  handle: (request: Request) => Promise<Response>;
  gateway: Gateway;
};

const NOT_FOUND_BODY = { error: { kind: "invalid_request", message: "not found", retryable: false } };

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ error: { kind: "invalid_request", message: `method not allowed; use ${allow}`, retryable: false } }),
    { status: 405, headers: { "content-type": "application/json", allow } }
  );
}

function pathSegments(url: string): string[] {
  return new URL(url).pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));
}

function buildCredentialCheck(credentials: GatewayOptions["credentials"]): (providerId: string) => boolean {
  return (providerId) => {
    const value = typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
    return value !== undefined && value !== "";
  };
}

function buildModelSummaries(gateway: Gateway): ModelSummary[] {
  const summaries: ModelSummary[] = [];
  for (const ref of gateway.listModels()) {
    const model = gateway.getCapabilities(ref.providerId, ref.modelId);
    if (!model) continue; // unresolvable route — registry diagnostics cover it
    summaries.push({
      providerId: model.providerId,
      modelId: model.modelId,
      family: model.family,
      displayName: model.displayName,
      company: model.company,
      wire: model.wire,
      contextTokens: model.limits.contextTokens,
      maxOutputTokens: model.limits.maxOutputTokens,
      streaming: model.features.streaming,
      tools: model.features.tools.supported,
      reasoning: Object.keys(model.params).some((name) => name.startsWith("reasoning.")),
      jsonMode: model.features.structuredOutput.jsonMode ?? false,
      jsonSchema: model.features.structuredOutput.jsonSchema ?? false,
      imageInput: model.modalities.input.includes("image"),
      deprecated: model.meta.deprecated ?? false,
      confidence: model.meta.confidence,
      ...(model.meta.routeStatus !== undefined ? { routeStatus: model.meta.routeStatus } : {})
    });
  }
  return summaries;
}

export function createGatewayHandler(options: GatewayHandlerOptions = {}): GatewayHttpHandler {
  const gateway = new Gateway(options);
  const credentialConfigured = buildCredentialCheck(options.credentials);
  const modelSummaries = buildModelSummaries(gateway);

  function handleProviders(): Response {
    return jsonResponse(200, {
      providers: PROVIDERS.map((provider) => ({ ...provider, credentialConfigured: credentialConfigured(provider.id) }))
    });
  }

  function handleModelDetail(provider: string, model: string): Response {
    const resolved = gateway.getCapabilities(provider, model);
    if (!resolved) {
      return jsonResponse(404, { error: { kind: "invalid_request", message: `unknown model ${provider}:${model}`, retryable: false } });
    }
    return jsonResponse(200, resolved);
  }

  async function handleChat(request: Request): Promise<Response> {
    throw new GatewayError("server", `not implemented: ${request.url}`); // Task 3/4
  }

  async function handleValidate(request: Request): Promise<Response> {
    throw new GatewayError("server", `not implemented: ${request.url}`); // Task 3
  }

  async function handle(request: Request): Promise<Response> {
    const segments = pathSegments(request.url);
    if (segments[0] !== "v1") return jsonResponse(404, NOT_FOUND_BODY);
    const route = segments[1];

    if (route === "providers" && segments.length === 2) {
      return request.method === "GET" ? handleProviders() : methodNotAllowed("GET");
    }
    if (route === "models" && segments.length === 2) {
      return request.method === "GET" ? jsonResponse(200, { models: modelSummaries }) : methodNotAllowed("GET");
    }
    if (route === "models" && segments.length >= 4) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return handleModelDetail(segments[2]!, segments.slice(3).join("/"));
    }
    if (route === "chat" && segments.length === 2) {
      return request.method === "POST" ? handleChat(request) : methodNotAllowed("POST");
    }
    if (route === "validate" && segments.length === 2) {
      return request.method === "POST" ? handleValidate(request) : methodNotAllowed("POST");
    }
    return jsonResponse(404, NOT_FOUND_BODY);
  }

  return { handle, gateway };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/server/handler.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/server/env.ts src/server/handler.ts tests/server/handler.test.ts
git commit -m "feat: add gateway HTTP handler with provider/model registry endpoints"
```
Expected: 173 tests green (163 + 10).

---

### Task 3: Handler — POST /v1/validate + POST /v1/chat (non-streaming)

Both POST endpoints parse JSON themselves (the handler is framework-agnostic — no body pre-parsing is assumed), 404 unknown models *before* touching the gateway, and reuse `errorResponse` for everything thrown. `/v1/validate` accepts `responseFormat` as either the ChatRequest object form (`{type:"json_object"}`) or the bare string — the UI sends whichever is handy.

**Files:**
- Create: `tests/helpers/http.ts`
- Modify: `src/server/handler.ts` (replace the two stubs, add body parsing)
- Test: `tests/server/handler.test.ts` (append)

- [ ] **Step 1: Create the shared test helpers `tests/helpers/http.ts`**

```ts
import { vi } from "vitest";

/** fetch fake returning one JSON payload. */
export function jsonFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

/** fetch fake returning an SSE body (joined with \n). */
export function sseFetch(lines: string[], status = 200) {
  return vi.fn(async () => new Response(lines.join("\n"), { status, headers: { "content-type": "text/event-stream" } }));
}

/** Split an SSE body into parsed JSON frames; the [DONE] sentinel stays a string. */
export function parseSseFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => frame.replace(/^data: /, ""))
    .map((data) => (data === "[DONE]" ? "[DONE]" : (JSON.parse(data) as unknown)));
}
```

- [ ] **Step 2: Append the failing tests to `tests/server/handler.test.ts`**

Add the import at the top:

```ts
import { jsonFetch } from "../helpers/http.js";
```

Append:

```ts
const post = (handler: ReturnType<typeof createGatewayHandler>, path: string, body: unknown) =>
  handler.handle(
    new Request(`http://gateway.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );

describe("POST /v1/validate", () => {
  it("returns the pinned ValidationResult for an out-of-range param", async () => {
    const handler = createGatewayHandler();
    const response = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { temperature: 99 }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      violations: [{ param: "temperature", code: "out_of_range", message: "temperature must be in [0, 2]" }],
      warnings: [
        { ruleId: "thinking-drops-sampling", param: "temperature", code: "dropped" },
        { ruleId: "thinking-drops-sampling", param: "topP", code: "dropped" }
      ],
      effectiveParams: { "reasoning.enabled": true, "reasoning.effort": "high" }
    });
  });

  it("reports forbidden tool choice under thinking (UI live-gating contract)", async () => {
    const handler = createGatewayHandler();
    const response = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { "reasoning.enabled": true },
      toolChoice: "required"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; violations: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.violations).toContainEqual({
      ruleId: "thinking-no-forced-tools",
      param: "toolChoice",
      code: "forbidden_value",
      value: "required"
    });
  });

  it("accepts responseFormat as object or string", async () => {
    const handler = createGatewayHandler();
    // gpt-5.5 supports json_schema; deepseek-v4-pro does not
    const objectForm = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { "reasoning.enabled": false },
      responseFormat: { type: "json_schema", schema: {} }
    });
    const stringForm = await post(handler, "/v1/validate", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      params: { "reasoning.enabled": false },
      responseFormat: "json_schema"
    });
    for (const response of [objectForm, stringForm]) {
      const body = (await response.json()) as { ok: boolean; violations: Array<{ code: string }> };
      expect(body.ok).toBe(false);
      expect(body.violations).toContainEqual(expect.objectContaining({ code: "unsupported_response_format" }));
    }
  });

  it("404s unknown models and 400s malformed bodies", async () => {
    const handler = createGatewayHandler();
    expect((await post(handler, "/v1/validate", { provider: "deepseek", model: "nope", params: {} })).status).toBe(404);
    expect((await post(handler, "/v1/validate", { provider: "", model: "x" })).status).toBe(400);
    expect((await post(handler, "/v1/validate", { provider: "deepseek", model: "deepseek-v4-pro", params: 5 })).status).toBe(400);
    expect((await post(handler, "/v1/validate", [1, 2])).status).toBe(400);
    const notJson = await handler.handle(
      new Request("http://gateway.test/v1/validate", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } })
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({
      error: { kind: "invalid_request", message: "request body must be valid JSON", retryable: false }
    });
  });
});

describe("POST /v1/chat (non-streaming)", () => {
  const OK_PAYLOAD = {
    id: "cmpl_1",
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 }
  };

  it("encodes through the real pipeline and returns the normalized ChatResponse", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, "reasoning.enabled": true }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    // P1b golden wire body, verbatim
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "cmpl_1",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1 }
    });
    expect(body.warnings).toEqual([
      {
        code: "param_dropped",
        param: "temperature",
        ruleId: "thinking-drops-sampling",
        message: "temperature was dropped by constraint rule thinking-drops-sampling"
      },
      {
        code: "param_dropped",
        param: "topP",
        ruleId: "thinking-drops-sampling",
        message: "topP was dropped by constraint rule thinking-drops-sampling"
      }
    ]);
    expect(body.raw).toBeUndefined();
  });

  it("maps gateway failures to HTTP statuses: validation 400, missing credential 401, provider 401 → 401", async () => {
    const noCreds = createGatewayHandler({ fetchImpl: jsonFetch(OK_PAYLOAD) });
    const authResponse = await post(noCreds, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(authResponse.status).toBe(401);
    expect(await authResponse.json()).toEqual({
      error: { kind: "auth", message: "no credential configured for provider deepseek", provider: "deepseek", retryable: false }
    });

    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    const validation = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      toolChoice: "required",
      params: { "reasoning.enabled": true }
    });
    expect(validation.status).toBe(400);
    const validationBody = (await validation.json()) as { error: { kind: string } };
    expect(validationBody.error.kind).toBe("unsupported_parameter");

    const upstream401 = createGatewayHandler({
      credentials: { deepseek: "sk-bad" },
      fetchImpl: jsonFetch({ error: { message: "invalid api key" } }, 401)
    });
    const providerError = await post(upstream401, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false }
    });
    expect(providerError.status).toBe(401);
    const providerBody = (await providerError.json()) as { error: { kind: string; status: number } };
    expect(providerBody.error).toMatchObject({ kind: "auth", status: 401, provider: "deepseek" });
  });

  it("404s unknown models and 400s missing messages", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    expect((await post(handler, "/v1/chat", { provider: "deepseek", model: "nope", messages: [] })).status).toBe(404);
    expect((await post(handler, "/v1/chat", { provider: "deepseek", model: "deepseek-v4-pro" })).status).toBe(400);
  });

  it("exposes raw only when the handler was created with includeRaw", async () => {
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD), includeRaw: true });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false }
    });
    expect(((await response.json()) as { raw: unknown }).raw).toEqual(OK_PAYLOAD);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/server/handler.test.ts`
Expected: the new describes FAIL (stubs throw `not implemented`); Task 2 tests still PASS.

- [ ] **Step 4: Replace the stubs in `src/server/handler.ts`**

Add imports at the top of the file:

```ts
import type { ChatMessage, ChatRequest, ResponseFormat, ToolChoice, ToolDef } from "../client/types.js";
import type { ValidateInput } from "../validate/validateRequest.js";
import { errorResponse } from "./shared.js";
```

(merge with the existing `./shared.js` import: `import { errorResponse, jsonResponse } from "./shared.js";` — and remove the now-unused `GatewayError` import if nothing else uses it.)

Add these module-level helpers (below `pathSegments`):

```ts
function badRequest(message: string): Response {
  return jsonResponse(400, { error: { kind: "invalid_request", message, retryable: false } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ParsedBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

async function readJsonBody(request: Request): Promise<ParsedBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, response: badRequest("request body must be valid JSON") };
  }
  if (!isPlainObject(parsed)) return { ok: false, response: badRequest("request body must be a JSON object") };
  return { ok: true, body: parsed };
}

/** /v1/validate takes the object form ({type:"json_schema",...}) or the bare string. */
function responseFormatType(value: unknown): ValidateInput["responseFormat"] {
  const type = isPlainObject(value) ? value.type : value;
  return type === "json_object" || type === "json_schema" ? type : undefined;
}
```

Inside `createGatewayHandler`, add a target resolver and replace both stubs:

```ts
  function resolveTarget(body: Record<string, unknown>): { ok: true; provider: string; model: string } | { ok: false; response: Response } {
    const { provider, model } = body;
    if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
      return { ok: false, response: badRequest("provider and model must be non-empty strings") };
    }
    if (!gateway.getCapabilities(provider, model)) {
      return {
        ok: false,
        response: jsonResponse(404, { error: { kind: "invalid_request", message: `unknown model ${provider}:${model}`, retryable: false } })
      };
    }
    return { ok: true, provider, model };
  }

  async function handleValidate(request: Request): Promise<Response> {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const target = resolveTarget(parsed.body);
    if (!target.ok) return target.response;
    const { params, toolChoice, responseFormat, stream } = parsed.body;
    if (params !== undefined && !isPlainObject(params)) return badRequest("params must be an object");
    try {
      const result = gateway.validate(target.provider, target.model, {
        params: (params as Record<string, unknown> | undefined) ?? {},
        toolChoice: toolChoice as ValidateInput["toolChoice"],
        responseFormat: responseFormatType(responseFormat),
        stream: stream === true
      });
      return jsonResponse(200, result);
    } catch (error) {
      return errorResponse(error, request.signal);
    }
  }

  async function handleChat(request: Request): Promise<Response> {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const target = resolveTarget(parsed.body);
    if (!target.ok) return target.response;
    const body = parsed.body;
    if (!Array.isArray(body.messages)) return badRequest("messages must be an array");
    if (body.params !== undefined && !isPlainObject(body.params)) return badRequest("params must be an object");
    if (body.passthrough !== undefined && !isPlainObject(body.passthrough)) return badRequest("passthrough must be an object");
    const chatRequest: ChatRequest = {
      provider: target.provider,
      model: target.model,
      messages: body.messages as ChatMessage[],
      tools: body.tools as ToolDef[] | undefined,
      toolChoice: body.toolChoice as ToolChoice | undefined,
      responseFormat: body.responseFormat as ResponseFormat | undefined,
      params: body.params as Record<string, unknown> | undefined,
      passthrough: body.passthrough as Record<string, unknown> | undefined,
      signal: request.signal
    };
    if (body.stream === true) return streamingChat(chatRequest, request.signal);
    try {
      return jsonResponse(200, await gateway.chat(chatRequest));
    } catch (error) {
      return errorResponse(error, request.signal);
    }
  }

  async function streamingChat(chatRequest: ChatRequest, requestSignal: AbortSignal): Promise<Response> {
    throw new GatewayError("server", "not implemented: streaming"); // Task 4
  }
```

(Keep the `GatewayError` import for the remaining stub. Message-shape depth: roles/content are deliberately NOT re-validated here — codecs own the wire mapping and the surface is a local/trusted mount; params get full validation via `gateway.validate` inside `prepare`.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/server/handler.test.ts`
Expected: PASS (18 tests: 10 + 8).

- [ ] **Step 6: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/server/handler.ts tests/server/handler.test.ts tests/helpers/http.ts
git commit -m "feat: add POST /v1/validate and non-streaming POST /v1/chat"
```
Expected: 181 tests green (173 + 8).

---

### Task 4: Handler — POST /v1/chat with `stream: true` (SSE)

The streaming design, in order of importance:

1. **First-event probe.** `gateway.stream()` rejects its first `next()` for pre-I/O failures (P1b pin). The handler awaits that first event *before* committing to an SSE response, so validation/auth/unknown-model map to 400/401/404 — not a 200 SSE with an error frame.
2. **Own AbortController.** The provider fetch runs off a controller the handler owns, linked to the request signal AND to `ReadableStream.cancel()` — so a client that disconnects mid-stream (SSE consumer cancels the body) aborts the upstream provider call (the transport keeps the signal wired to the body on the success path — verified fact).
3. **Wire format:** each `StreamEvent` is one `data: <json>\n\n` frame; `error` events serialize their `GatewayError` via `serializeGatewayError`; the stream always ends with `data: [DONE]\n\n`.
4. **Carryover #2:** `timeoutMs` bounds time-to-headers only. The handler intentionally applies NO duration bound to the body — document, don't "fix".

This task also delivers carryover #5: the openai-responses and google wires get their first client-level integration coverage, exercised through the full handler → gateway → codec → fake-fetch stack.

**Files:**
- Modify: `src/server/handler.ts` (replace `streamingChat` stub)
- Test: `tests/server/handler.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

Extend the helpers import:

```ts
import { jsonFetch, parseSseFrames, sseFetch } from "../helpers/http.js";
```

Append:

```ts
describe("POST /v1/chat (streaming SSE)", () => {
  const DEEPSEEK_SSE = [
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    "",
    "data: [DONE]",
    ""
  ];

  it("streams normalized events as SSE frames ending with [DONE]", async () => {
    const fetchImpl = sseFetch(DEEPSEEK_SSE);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, "reasoning.enabled": true },
      stream: true
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    });

    const frames = parseSseFrames(await response.text());
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "usage",
      "done",
      "[DONE]"
    ]);
    const done = frames[3] as { response: { content: unknown; warnings: Array<{ code: string; param: string }> } };
    expect(done.response.content).toEqual([{ type: "text", text: "hey" }]);
    expect(done.response.warnings.some((w) => w.code === "param_dropped" && w.param === "temperature")).toBe(true);
  });

  it("drives the openai-responses wire end to end (carryover #5)", async () => {
    const completed = {
      id: "resp_2",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi!" }] }],
      usage: { input_tokens: 3, output_tokens: 2 }
    };
    const fetchImpl = sseFetch([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"hi"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"!"}',
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
      ""
    ]);
    const handler = createGatewayHandler({ credentials: { openai: "sk-oai" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    });
    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-oai");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "gpt-5.5", stream: true });

    const frames = parseSseFrames(await response.text());
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "usage",
      "done",
      "[DONE]"
    ]);
    const done = frames[3] as { response: { content: unknown; finishReason: string } };
    expect(done.response.content).toEqual([{ type: "text", text: "hi!" }]);
    expect(done.response.finishReason).toBe("stop");
  });

  it("drives the google wire end to end (carryover #5)", async () => {
    const fetchImpl = sseFetch([
      'data: {"responseId":"r2","candidates":[{"content":{"parts":[{"text":"hm","thought":true}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"llo"},{"functionCall":{"name":"lookup","args":{"q":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}',
      ""
    ]);
    const handler = createGatewayHandler({ credentials: { "google-ai-studio": "sk-goog" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "google-ai-studio",
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
      stream: true
    });
    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-goog");

    const frames = parseSseFrames(await response.text());
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "reasoning-delta",
      "text-delta",
      "text-delta",
      "tool-call-delta",
      "usage",
      "done",
      "[DONE]"
    ]);
    const done = frames[5] as { response: { content: Array<{ type: string }>; finishReason: string } };
    expect(done.response.finishReason).toBe("tool_calls");
    expect(done.response.content).toEqual([
      { type: "reasoning", text: "hm" },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":1}' }
    ]);
  });

  it("maps pre-I/O failures to HTTP statuses instead of a 200 SSE", async () => {
    const fetchImpl = sseFetch(DEEPSEEK_SSE);
    const withCreds = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const validation = await post(withCreds, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      toolChoice: "required",
      params: { "reasoning.enabled": true },
      stream: true
    });
    expect(validation.status).toBe(400);
    expect(validation.headers.get("content-type")).toBe("application/json");
    expect(fetchImpl).not.toHaveBeenCalled();

    const noCreds = createGatewayHandler({ fetchImpl });
    const auth = await post(noCreds, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    });
    expect(auth.status).toBe(401);
  });

  it("delivers mid-stream failures as a serialized error event, then [DONE]", async () => {
    const fetchImpl = sseFetch(["data: {broken", ""]);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false },
      stream: true
    });
    expect(response.status).toBe(200); // headers were already committed by the first event probe? No —
    // the broken frame IS the first event: gateway.stream wraps decode failures as an error event,
    // so the probe yields {type:"error"} and the handler still answers 200 SSE. Pinned on purpose:
    // only pre-I/O throws become HTTP statuses.
    const frames = parseSseFrames(await response.text());
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "error", error: { kind: expect.any(String), retryable: expect.any(Boolean) } });
    expect(frames[1]).toBe("[DONE]");
  });

  it("returns 499 for a request whose signal is already aborted (carryover #3)", async () => {
    const fetchImpl = sseFetch(DEEPSEEK_SSE);
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const controller = new AbortController();
    controller.abort(new Error("client gone"));
    const response = await handler.handle(
      new Request("http://gateway.test/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          params: { "reasoning.enabled": false },
          stream: true
        }),
        signal: controller.signal
      })
    );
    expect(response.status).toBe(499);
  });

  it("aborts the upstream provider fetch when the SSE consumer cancels (client disconnect)", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      const encoder = new TextEncoder();
      // one frame, then the body stays open forever
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n'));
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const handler = createGatewayHandler({ credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await post(handler, "/v1/chat", {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false },
      stream: true
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("text-delta");
    expect(upstreamSignal?.aborted).toBe(false);
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
```

(Also add `vi` to the vitest import in this test file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server/handler.test.ts`
Expected: the new describe FAILS on the `not implemented: streaming` stub; everything else PASSES.

- [ ] **Step 3: Implement streaming in `src/server/handler.ts`**

Add imports:

```ts
import type { StreamEvent } from "../client/types.js";
import { serializeGatewayError } from "./shared.js";
```

(merge into the existing import lines; `GatewayError` can now be dropped if unused.)

Add module-level helpers:

```ts
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };
const DONE_FRAME = "data: [DONE]\n\n";

function sseFrame(event: StreamEvent): string {
  const payload = event.type === "error" ? { type: "error", error: serializeGatewayError(event.error) } : event;
  return `data: ${JSON.stringify(payload)}\n\n`;
}
```

Replace the `streamingChat` stub inside `createGatewayHandler`:

```ts
  /**
   * SSE notes:
   * - First-event probe: gateway.stream() rejects its first next() for pre-I/O
   *   failures (validation, credentials) — probing it BEFORE building the
   *   Response maps those to real HTTP statuses instead of a 200 SSE.
   * - The provider fetch runs off a handler-owned controller linked to BOTH the
   *   request signal and ReadableStream.cancel(), so a vanished client aborts
   *   the upstream call (the transport keeps the signal wired to the body).
   * - timeoutMs bounds time-to-headers only (P1b carryover #2); the body is
   *   deliberately unbounded — streams run until done/error or client cancel.
   */
  async function streamingChat(chatRequest: ChatRequest, requestSignal: AbortSignal): Promise<Response> {
    const upstream = new AbortController();
    const onAbort = () => upstream.abort(requestSignal.reason);
    if (requestSignal.aborted) onAbort();
    else requestSignal.addEventListener("abort", onAbort, { once: true });
    const detach = () => requestSignal.removeEventListener("abort", onAbort);

    const iterator = gateway.stream({ ...chatRequest, signal: upstream.signal });
    let first: IteratorResult<StreamEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      detach();
      return errorResponse(error, requestSignal);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.done) {
          controller.enqueue(encoder.encode(DONE_FRAME));
          controller.close();
          detach();
          return;
        }
        controller.enqueue(encoder.encode(sseFrame(first.value)));
      },
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.enqueue(encoder.encode(DONE_FRAME));
          controller.close();
          detach();
          return;
        }
        controller.enqueue(encoder.encode(sseFrame(next.value)));
      },
      cancel() {
        upstream.abort(new Error("client closed the SSE connection"));
        detach();
        void iterator.return(undefined);
      }
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/server/handler.test.ts`
Expected: PASS (25 tests: 18 + 7).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/server/handler.ts tests/server/handler.test.ts
git commit -m "feat: stream POST /v1/chat as SSE with first-event status probe and disconnect abort"
```
Expected: 188 tests green (181 + 7).

---

### Task 5: Fastify plugin (optional peer)

A plain async Fastify plugin (no `fastify-plugin` wrapper — encapsulation is wanted) that: keeps request bodies as raw strings via a scoped content-type parser (the handler does its own JSON parsing; scoping keeps the host app's parser untouched), strips the registration prefix, converts Fastify request → Fetch `Request` (with disconnect-abort wiring), and streams the `Response` back via `Readable.fromWeb`. Only `import type` from fastify.

**Files:**
- Modify: `package.json` (fastify devDep + optional peer)
- Create: `src/server/fastify.ts`
- Test: `tests/server/fastify.test.ts`

- [ ] **Step 1: Add fastify as devDependency + optional peer**

```bash
npm install --save-dev fastify@^5.0.0
```

Then edit `package.json` — after `"devDependencies"`, add:

```json
  "peerDependencies": {
    "fastify": "^5.0.0"
  },
  "peerDependenciesMeta": {
    "fastify": {
      "optional": true
    }
  },
```

Verify: `node -e 'console.log(require("./node_modules/fastify/package.json").version)'` prints a 5.x version.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/server/fastify.test.ts
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import gatewayPluginDefault, { gatewayPlugin } from "../../src/server/fastify.js";
import { jsonFetch, parseSseFrames, sseFetch } from "../helpers/http.js";

const OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe("gatewayPlugin", () => {
  it("serves the registry endpoints under a prefix", async () => {
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" } });
    const providers = await app.inject({ method: "GET", url: "/api/llm/v1/providers" });
    expect(providers.statusCode).toBe(200);
    expect((providers.json() as { providers: unknown[] }).providers).toHaveLength(14);

    const detail = await app.inject({ method: "GET", url: "/api/llm/v1/models/openrouter/moonshotai/kimi-k2.6" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6" });

    const missing = await app.inject({ method: "GET", url: "/api/llm/v1/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("posts chat through the raw-string body path", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/v1/chat",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0.7, "reasoning.enabled": true }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(response.json()).toMatchObject({ content: [{ type: "text", text: "hello" }], finishReason: "stop" });
  });

  it("streams SSE chat responses", async () => {
    const fetchImpl = sseFetch([
      'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      ""
    ]);
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" }, fetchImpl });
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/v1/chat",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false },
        stream: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    const frames = parseSseFrames(response.body);
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "done",
      "[DONE]"
    ]);
  });

  it("maps validation failures to 400 (probe works through fastify)", async () => {
    app = fastify();
    await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: { deepseek: "sk-test" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/v1/chat",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        toolChoice: "required",
        params: { "reasoning.enabled": true },
        stream: true
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not hijack the host app's JSON body parsing (scoped content-type parser)", async () => {
    app = fastify();
    app.post("/echo", async (request) => request.body);
    await app.register(gatewayPlugin, { prefix: "/api/llm" });
    const echo = await app.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: { a: 1 } });
    expect(echo.statusCode).toBe(200);
    expect(echo.json()).toEqual({ a: 1 });
  });

  it("works without a prefix and is also the default export", async () => {
    app = fastify();
    await app.register(gatewayPluginDefault);
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { models: unknown[] }).models).toHaveLength(100);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/server/fastify.test.ts`
Expected: FAIL — cannot resolve `../../src/server/fastify.js`.

- [ ] **Step 4: Implement `src/server/fastify.ts`**

```ts
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { createGatewayHandler, type GatewayHandlerOptions } from "./handler.js";

export type GatewayPluginOptions = GatewayHandlerOptions;

/** Headers that don't survive the Node→Fetch Request conversion. */
const SKIP_REQUEST_HEADERS = new Set(["connection", "transfer-encoding", "content-length", "host", "expect", "keep-alive", "upgrade"]);

function toFetchHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (SKIP_REQUEST_HEADERS.has(name)) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

/**
 * Mounts the gateway HTTP API on a Fastify instance (§4.6):
 *
 *   await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: lookupFn });
 *
 * fastify is an OPTIONAL peer dependency: this module only imports its types,
 * so importing `@waifucave/gateway/fastify` adds no runtime dependency.
 * Deliberately NOT wrapped in fastify-plugin — the scoped content-type parser
 * (raw string bodies; the handler parses JSON itself) must stay encapsulated.
 */
export async function gatewayPlugin(instance: FastifyInstance, options: GatewayPluginOptions): Promise<void> {
  const handler = createGatewayHandler(options);
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    done(null, payload);
  });
  instance.all("/*", async (request, reply) => {
    const controller = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) controller.abort(new Error("client closed the connection"));
    });
    const path = request.url.slice(instance.prefix.length) || "/";
    const init: RequestInit = { method: request.method, headers: toFetchHeaders(request.headers), signal: controller.signal };
    if (typeof request.body === "string" && request.body !== "") init.body = request.body;
    const response = await handler.handle(new Request(`http://gateway.internal${path}`, init));
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      reply.header(name, value);
    });
    if (!response.body) return reply.send("");
    return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
  });
}

export default gatewayPlugin;
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/server/fastify.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Verify the build stays fastify-free at runtime**

```bash
npm run build
grep -rn 'from "fastify"' dist ; echo "grep exit: $?"
grep -rn 'require("fastify")' dist ; echo "grep exit: $?"
```
Expected: both greps exit 1 (type-only imports are erased).

- [ ] **Step 7: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add package.json package-lock.json src/server/fastify.ts tests/server/fastify.test.ts
git commit -m "feat: add fastify plugin as optional peer (type-only import, scoped body parser)"
```
Expected: 194 tests green (188 + 6).

---

### Task 6: `node:http` adapter + `gateway` bin with `serve`

`serve()` adapts `node:http` ↔ the Fetch handler: buffer the (JSON) request body, build a `Request` with a disconnect-wired signal, pipe the `Response` body back via `stream/promises.pipeline` (which propagates client disconnects as stream destruction → web-stream cancel → upstream abort, completing the chain from Task 4). The bin is a 5-line shebang wrapper around a testable `runCli(argv, io)` with injected env/log/fetch.

**Files:**
- Create: `src/server/node.ts`
- Create: `src/bin/cli.ts`
- Create: `src/bin/gateway.ts`
- Modify: `package.json` (add `bin`)
- Test: `tests/server/node.test.ts`, `tests/bin/cli.test.ts`

- [ ] **Step 1: Write the failing tests for `serve`**

```ts
// tests/server/node.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { serve, type RunningServer } from "../../src/server/node.js";
import { envCredentials } from "../../src/server/env.js";
import { jsonFetch, parseSseFrames, sseFetch } from "../helpers/http.js";

const OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("serve", () => {
  it("answers /v1/providers over a real socket on an ephemeral port", async () => {
    running = await serve({ port: 0, credentials: envCredentials({ DEEPSEEK_API_KEY: "sk-env" }) });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${running.url}/v1/providers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Array<{ id: string; credentialConfigured: boolean }> };
    expect(body.providers).toHaveLength(14);
    expect(body.providers.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(true);
    expect(body.providers.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
  });

  it("answers non-streaming chat over a real socket", async () => {
    running = await serve({ port: 0, credentials: { deepseek: "sk-test" }, fetchImpl: jsonFetch(OK_PAYLOAD) });
    const response = await fetch(`${running.url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false }
      })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "hello" }], finishReason: "stop" });
  });

  it("streams SSE over a real socket", async () => {
    running = await serve({
      port: 0,
      credentials: { deepseek: "sk-test" },
      fetchImpl: sseFetch([
        'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        ""
      ])
    });
    const response = await fetch(`${running.url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { "reasoning.enabled": false },
        stream: true
      })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = parseSseFrames(await response.text());
    expect(frames.at(-1)).toBe("[DONE]");
    expect(frames.map((f) => (typeof f === "string" ? f : (f as { type: string }).type))).toEqual([
      "text-delta",
      "text-delta",
      "done",
      "[DONE]"
    ]);
  });

  it("404s unknown paths", async () => {
    running = await serve({ port: 0 });
    expect((await fetch(`${running.url}/nope`)).status).toBe(404);
    expect((await fetch(`${running.url}/v1/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Write the failing tests for the CLI (serve half)**

```ts
// tests/bin/cli.test.ts
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/bin/cli.js";
import type { RunningServer } from "../../src/server/node.js";

function io(overrides: Partial<CliIo> = {}): CliIo & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { env: {}, log: (line) => logs.push(line), logError: (line) => errors.push(line), logs, errors, ...overrides };
}

describe("runCli", () => {
  it("prints usage and exits 2 with no command, 0 with --help", async () => {
    const noCommand = io();
    expect(await runCli([], noCommand)).toBe(2);
    expect(noCommand.errors.join("\n")).toContain("usage: gateway");
    const help = io();
    expect(await runCli(["--help"], help)).toBe(0);
    expect(help.logs.join("\n")).toContain("usage: gateway");
  });

  it("rejects unknown commands and bad flags with exit 2", async () => {
    const unknown = io();
    expect(await runCli(["frobnicate"], unknown)).toBe(2);
    expect(unknown.errors.join("\n")).toContain('unknown command "frobnicate"');
    expect(await runCli(["serve", "--port", "not-a-number"], io())).toBe(2);
    expect(await runCli(["serve", "--bogus"], io())).toBe(2);
  });

  it("serve starts a real server with env credentials and reports the url", async () => {
    let captured: RunningServer | undefined;
    const testIo = io({ env: { DEEPSEEK_API_KEY: "sk-env" }, onServer: (server) => (captured = server) });
    expect(await runCli(["serve", "--port", "0"], testIo)).toBe(0);
    expect(captured).toBeDefined();
    expect(testIo.logs.join("\n")).toContain(`gateway listening on ${captured!.url}`);
    const body = (await (await fetch(`${captured!.url}/v1/providers`)).json()) as {
      providers: Array<{ id: string; credentialConfigured: boolean }>;
    };
    expect(body.providers.find((p) => p.id === "deepseek")?.credentialConfigured).toBe(true);
    await captured!.close();
  });

  it("serve returns 1 when the port is unusable", async () => {
    const testIo = io();
    expect(await runCli(["serve", "--port", "0", "--host", "203.0.113.1"], testIo)).toBe(1);
    expect(testIo.errors.join("\n")).toContain("failed to start");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/server/node.test.ts tests/bin/cli.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 4: Implement `src/server/node.ts`**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Gateway } from "../client/gateway.js";
import { createGatewayHandler, type GatewayHandlerOptions } from "./handler.js";

export type ServeOptions = GatewayHandlerOptions & {
  /** Default 8787. Pass 0 for an ephemeral port (tests). */
  port?: number;
  /** Default 127.0.0.1 — the standalone server is local tooling, not a public face. */
  host?: string;
};

export type RunningServer = {
  url: string;
  server: Server;
  gateway: Gateway;
  close: () => Promise<void>;
};

const SKIP_REQUEST_HEADERS = new Set(["connection", "transfer-encoding", "content-length", "host", "expect", "keep-alive", "upgrade"]);

function toFetchHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (SKIP_REQUEST_HEADERS.has(name)) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

async function readBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Standalone `gateway serve` server (§4.6): node:http ↔ the framework-agnostic handler. */
export async function serve(options: ServeOptions = {}): Promise<RunningServer> {
  const { port = 8787, host = "127.0.0.1", ...handlerOptions } = options;
  const handler = createGatewayHandler(handlerOptions);

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new Error("client closed the connection"));
    });
    try {
      const method = request.method ?? "GET";
      const init: RequestInit = { method, headers: toFetchHeaders(request), signal: controller.signal };
      if (method !== "GET" && method !== "HEAD") init.body = await readBody(request);
      const result = await handler.handle(new Request(`http://${request.headers.host ?? "gateway.internal"}${request.url ?? "/"}`, init));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]), response);
      else response.end();
    } catch (error) {
      if (controller.signal.aborted) return; // client went away mid-stream — nothing left to tell it
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { kind: "server", message: `unexpected error: ${String(error)}`, retryable: false } }));
    }
  }

  const server = createServer((request, response) => {
    void dispatch(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    server,
    gateway: handler.gateway,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
```

- [ ] **Step 5: Implement `src/bin/cli.ts` (serve only — sync lands in Task 8)**

```ts
import { parseArgs } from "node:util";
import { envCredentials } from "../server/env.js";
import { serve, type RunningServer } from "../server/node.js";

export type CliIo = {
  env?: Record<string, string | undefined>;
  log: (line: string) => void;
  logError: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Test hook: receives the running server (production leaves it running forever). */
  onServer?: (server: RunningServer) => void;
};

const USAGE = [
  "usage: gateway <command>",
  "",
  "  gateway serve [--port 8787] [--host 127.0.0.1]",
  "      start the standalone HTTP server; credentials come from env vars",
  "      (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ... — see GET /v1/providers)"
].join("\n");

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    io.log(USAGE);
    return 0;
  }
  if (command === "serve") return runServe(rest, io);
  io.logError(command === undefined ? USAGE : `unknown command "${command}"\n${USAGE}`);
  return 2;
}

async function runServe(args: string[], io: CliIo): Promise<number> {
  let values: { port?: string; host?: string };
  try {
    ({ values } = parseArgs({ args, options: { port: { type: "string" }, host: { type: "string" } } }));
  } catch (error) {
    io.logError(`invalid arguments: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const port = values.port === undefined ? 8787 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.logError(`invalid --port "${values.port}"`);
    return 2;
  }
  try {
    const running = await serve({
      port,
      host: values.host ?? "127.0.0.1",
      credentials: envCredentials(io.env ?? process.env),
      ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {})
    });
    io.log(`gateway listening on ${running.url} (endpoints under /v1)`);
    io.onServer?.(running);
    return 0;
  } catch (error) {
    io.logError(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
```

- [ ] **Step 6: Implement `src/bin/gateway.ts` and register the bin**

```ts
#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  log: (line) => console.log(line),
  logError: (line) => console.error(line)
});
```

In `package.json`, after `"types"`, add:

```json
  "bin": {
    "gateway": "dist/bin/gateway.js"
  },
```

- [ ] **Step 7: Run to verify pass, check the shebang survives the build**

```bash
npx vitest run tests/server/node.test.ts tests/bin/cli.test.ts
npm run build && head -1 dist/bin/gateway.js && node dist/bin/gateway.js --help
```
Expected: both files PASS (8 tests); first line of `dist/bin/gateway.js` is `#!/usr/bin/env node`; `--help` prints the usage block and exits 0.

- [ ] **Step 8: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/server/node.ts src/bin tests/server/node.test.ts tests/bin/cli.test.ts package.json
git commit -m "feat: add node:http serve adapter and gateway bin with serve command"
```
Expected: 202 tests green (194 + 8).

---

### Task 7: Drift sync engine (`runSync`)

§4.7: fetch OpenRouter `/models` + native model lists, diff against the registry, report — never mutate. Severity contract: **error** = registry model missing from the remote list (stale id, renamed, removed); **warning** = context/pricing drift on OpenRouter routes, or a provider list that can't be fetched/parsed; **info** = registry diagnostics (surfaced so `gateway sync` doubles as data hygiene) — `ok` means no errors AND no warnings. OpenRouter is checked without credentials (public endpoint); every other provider is skipped with a reason unless its credential is present. Tests run against a tiny synthetic registry via `dataDir` (the established fixture pattern) — never against live endpoints.

**Files:**
- Create: `src/sync/sync.ts`
- Create: `tests/fixtures/sync/registry.json`
- Test: `tests/sync/sync.test.ts`

- [ ] **Step 1: Create the synthetic registry fixture `tests/fixtures/sync/registry.json`**

```json
[
  {
    "schema": "starlight.capability-doc.v1",
    "family": "drift-model",
    "displayName": "Drift Model",
    "company": "Drift Labs",
    "routes": [
      { "providerId": "deepseek", "modelId": "drift-native", "wire": "openai-chat", "overrides": { "endpoint": "/chat/completions" } },
      { "providerId": "openrouter", "modelId": "drift/drift-model", "wire": "openai-chat", "overrides": {} }
    ],
    "limits": { "contextTokens": 100000, "maxOutputTokens": 8192 },
    "modalities": { "input": ["text"], "output": ["text"] },
    "features": { "streaming": true, "tools": { "supported": false }, "structuredOutput": {}, "promptCaching": { "kind": "none" }, "systemRole": "system" },
    "params": { "temperature": { "type": "number", "min": 0, "max": 2 } },
    "constraints": [],
    "meta": { "pricing": { "inputPerMTok": 0.5, "outputPerMTok": 1.5 }, "sources": ["synthetic"], "confidence": "verified" }
  },
  {
    "schema": "starlight.capability-doc.v1",
    "family": "drift-claude",
    "displayName": "Drift Claude",
    "company": "Drift Labs",
    "routes": [
      { "providerId": "anthropic", "modelId": "claude-drift-1", "wire": "anthropic-messages", "overrides": { "endpoint": "/v1/messages" } }
    ],
    "limits": { "contextTokens": 200000, "maxOutputTokens": 8192 },
    "modalities": { "input": ["text"], "output": ["text"] },
    "features": { "streaming": true, "tools": { "supported": false }, "structuredOutput": {}, "promptCaching": { "kind": "none" }, "systemRole": "top-level" },
    "params": { "maxOutputTokens": { "type": "int", "min": 1, "max": 8192, "wireName": "max_tokens" } },
    "constraints": [],
    "meta": { "sources": ["synthetic"], "confidence": "verified" }
  },
  {
    "schema": "starlight.capability-doc.v1",
    "family": "drift-gemini",
    "displayName": "Drift Gemini",
    "company": "Drift Labs",
    "routes": [
      { "providerId": "google-ai-studio", "modelId": "gemini-drift-1", "wire": "google-generative-language", "overrides": {} }
    ],
    "limits": { "contextTokens": 100000, "maxOutputTokens": 8192 },
    "modalities": { "input": ["text"], "output": ["text"] },
    "features": { "streaming": true, "tools": { "supported": false }, "structuredOutput": {}, "promptCaching": { "kind": "none" }, "systemRole": "systemInstruction" },
    "params": { "temperature": { "type": "number", "min": 0, "max": 2, "wireName": "generationConfig.temperature" } },
    "constraints": [],
    "meta": { "sources": ["synthetic"], "confidence": "verified" }
  }
]
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/sync/sync.test.ts
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSync, type SyncReport } from "../../src/sync/sync.js";

const dataDir = join(import.meta.dirname, "../fixtures/sync");

type Responder = (url: string) => unknown | Response;

/** Routes fake fetches by URL substring; unmatched URLs 500. */
function fakeFetch(responders: Record<string, Responder>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [needle, responder] of Object.entries(responders)) {
      if (!url.includes(needle)) continue;
      const result = responder(url);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
}

const OPENROUTER_CLEAN = {
  data: [{ id: "drift/drift-model", context_length: 100000, pricing: { prompt: "0.0000005", completion: "0.0000015" } }]
};
const DEEPSEEK_CLEAN = { data: [{ id: "drift-native" }] };
const ANTHROPIC_CLEAN = { data: [{ id: "claude-drift-1" }] };
const GOOGLE_CLEAN = { models: [{ name: "models/gemini-drift-1" }] };

const ALL_CREDS = { deepseek: "sk-d", anthropic: "sk-a", "google-ai-studio": "sk-g" };

function cleanFetch() {
  return fakeFetch({
    "openrouter.ai": () => OPENROUTER_CLEAN,
    "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
    "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
    "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
  });
}

function levels(report: SyncReport): string[] {
  return report.findings.map((f) => f.level);
}

describe("runSync", () => {
  it("reports clean when every remote list matches (pricing strings round-trip exactly)", async () => {
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl: cleanFetch() });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.providersChecked.sort()).toEqual(["anthropic", "deepseek", "google-ai-studio", "openrouter"]);
    expect(report.providersSkipped).toEqual([]);
  });

  it("flags a registry model missing from the remote list as an error", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => ({ data: [] }),
      "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      {
        level: "error",
        providerId: "openrouter",
        modelId: "drift/drift-model",
        field: "presence",
        message: "openrouter:drift/drift-model is not in the provider model list (renamed, removed, or stale id)"
      }
    ]);
  });

  it("flags OpenRouter context and pricing drift as warnings with both values", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => ({
        data: [{ id: "drift/drift-model", context_length: 65536, pricing: { prompt: "0.0000007", completion: "0.0000015" } }]
      }),
      "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({
      level: "warning",
      providerId: "openrouter",
      modelId: "drift/drift-model",
      field: "contextTokens",
      registryValue: 100000,
      remoteValue: 65536,
      message: "openrouter:drift/drift-model contextTokens drift: registry 100000, OpenRouter 65536"
    });
    expect(report.findings).toContainEqual({
      level: "warning",
      providerId: "openrouter",
      modelId: "drift/drift-model",
      field: "pricing.inputPerMTok",
      registryValue: 0.5,
      remoteValue: 0.7,
      message: "openrouter:drift/drift-model input pricing drift: registry 0.5, OpenRouter 0.7"
    });
    expect(levels(report)).not.toContain("error");
  });

  it("skips providers without credentials but always checks public OpenRouter", async () => {
    const report = await runSync({ dataDir, credentials: {}, fetchImpl: cleanFetch() });
    expect(report.providersChecked).toEqual(["openrouter"]);
    expect(report.providersSkipped).toEqual([
      { providerId: "deepseek", reason: "no credential (DEEPSEEK_API_KEY not set)" },
      { providerId: "anthropic", reason: "no credential (ANTHROPIC_API_KEY not set)" },
      { providerId: "google-ai-studio", reason: "no credential (GOOGLE_AI_STUDIO_API_KEY not set)" }
    ]);
    expect(report.ok).toBe(true);
  });

  it("reports unreachable/broken provider lists as warnings, not crashes", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => new Response("upstream exploded", { status: 503 }),
      "api.deepseek.com/models": () => {
        throw new Error("ECONNREFUSED");
      },
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": () => GOOGLE_CLEAN
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.ok).toBe(false);
    const warningProviders = report.findings.filter((f) => f.field === "model-list").map((f) => f.providerId);
    expect(warningProviders.sort()).toEqual(["deepseek", "openrouter"]);
    expect(report.providersChecked.sort()).toEqual(["anthropic", "google-ai-studio"]);
  });

  it("follows google pagination and strips the models/ prefix", async () => {
    const fetchImpl = fakeFetch({
      "openrouter.ai": () => OPENROUTER_CLEAN,
      "api.deepseek.com/models": () => DEEPSEEK_CLEAN,
      "api.anthropic.com/v1/models": () => ANTHROPIC_CLEAN,
      "generativelanguage.googleapis.com/v1beta/models": (url) =>
        url.includes("pageToken=page2")
          ? { models: [{ name: "models/gemini-drift-1" }] }
          : { models: [{ name: "models/something-else" }], nextPageToken: "page2" }
    });
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl });
    expect(report.findings).toEqual([]);
  });

  it("honors the providers filter without marking the rest skipped", async () => {
    const fetchImpl = cleanFetch();
    const report = await runSync({ dataDir, credentials: ALL_CREDS, fetchImpl, providers: ["openrouter"] });
    expect(report.providersChecked).toEqual(["openrouter"]);
    expect(report.providersSkipped).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces registry diagnostics as info findings that do not fail the check", async () => {
    // the REAL registry has 14 unmapped-supportedParameters diagnostics; run sync
    // against it with no creds and a fake OpenRouter that contains every id
    const { Registry } = await import("../../src/registry/loader.js");
    const ids = Registry.load()
      .listModels()
      .filter((m) => m.providerId === "openrouter")
      .map((m) => ({ id: m.modelId }));
    const fetchImpl = fakeFetch({ "openrouter.ai": () => ({ data: ids }) });
    const report = await runSync({ credentials: {}, fetchImpl, providers: ["openrouter"] });
    const infos = report.findings.filter((f) => f.level === "info" && f.field === "registry-diagnostic");
    expect(infos).toHaveLength(14);
    // ids all match and pricing/context comparisons are skipped (no remote values in this fixture)
    expect(report.findings.filter((f) => f.level !== "info")).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/sync/sync.test.ts`
Expected: FAIL — cannot resolve `../../src/sync/sync.js`.

- [ ] **Step 4: Implement `src/sync/sync.ts`**

```ts
import { Registry, type ModelRef } from "../registry/loader.js";
import { getProvider } from "../registry/providers.js";
import type { ProviderDef } from "../registry/types.js";

export type SyncFinding = {
  level: "error" | "warning" | "info";
  providerId: string;
  modelId?: string;
  field?: string;
  registryValue?: unknown;
  remoteValue?: unknown;
  message: string;
};

export type SyncReport = {
  /** True when there are no error- or warning-level findings (info never fails the check). */
  ok: boolean;
  findings: SyncFinding[];
  providersChecked: string[];
  providersSkipped: Array<{ providerId: string; reason: string }>;
};

export type SyncOptions = {
  dataDir?: string;
  credentials?: Record<string, string> | ((providerId: string) => string | undefined);
  fetchImpl?: typeof fetch;
  /** Limit the check to these provider ids. */
  providers?: string[];
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
};

type RemoteModel = { id: string; contextLength?: number; promptPrice?: number; completionPrice?: number };
type RemoteList = { models: Map<string, RemoteModel> } | { failure: string };

function credentialFor(credentials: SyncOptions["credentials"], providerId: string): string | undefined {
  const value = typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
  return value === undefined || value === "" ? undefined : value;
}

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** OpenRouter pricing is a per-token USD string ("0.0000007") — normalize to per-MTok at 6 decimal places. */
function parsePrice(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const perToken = Number(value);
  if (!Number.isFinite(perToken)) return undefined;
  return Number((perToken * 1_000_000).toFixed(6));
}

function priceDiffers(registryValue: number | null | undefined, remoteValue: number | undefined): boolean {
  if (registryValue === null || registryValue === undefined || remoteValue === undefined) return false;
  return Number(registryValue.toFixed(6)) !== remoteValue;
}

/**
 * Remote list shapes are documented conventions, NOT live-verified (see plan
 * header) — every failure or surprise becomes a `failure`, never a throw.
 */
async function fetchRemoteList(provider: ProviderDef, credential: string | undefined, fetchImpl: typeof fetch, timeoutMs: number): Promise<RemoteList> {
  try {
    if (provider.wire === "anthropic-messages") {
      const payload = (await fetchJson(
        `${provider.baseUrl}/v1/models?limit=1000`,
        { "x-api-key": credential ?? "", "anthropic-version": "2023-06-01" },
        fetchImpl,
        timeoutMs
      )) as { data?: unknown };
      const models = new Map<string, RemoteModel>();
      for (const entry of asArray(payload.data)) {
        const id = (entry as { id?: unknown }).id;
        if (typeof id === "string") models.set(id, { id });
      }
      return { models };
    }
    if (provider.wire === "google-generative-language") {
      const models = new Map<string, RemoteModel>();
      let pageToken: string | undefined;
      do {
        const url = `${provider.baseUrl}/v1beta/models?pageSize=1000${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
        const payload = (await fetchJson(url, { "x-goog-api-key": credential ?? "" }, fetchImpl, timeoutMs)) as {
          models?: unknown;
          nextPageToken?: unknown;
        };
        for (const entry of asArray(payload.models)) {
          const name = (entry as { name?: unknown }).name;
          if (typeof name === "string") {
            const id = name.replace(/^models\//, "");
            models.set(id, { id });
          }
        }
        pageToken = typeof payload.nextPageToken === "string" && payload.nextPageToken !== "" ? payload.nextPageToken : undefined;
      } while (pageToken !== undefined);
      return { models };
    }
    // openai-chat and openai-responses providers both expose GET {base}/models;
    // OpenRouter's variant additionally carries context_length + pricing
    const headers: Record<string, string> = credential === undefined ? {} : { authorization: `Bearer ${credential}` };
    const payload = (await fetchJson(`${provider.baseUrl}/models`, headers, fetchImpl, timeoutMs)) as { data?: unknown };
    const models = new Map<string, RemoteModel>();
    for (const entry of asArray(payload.data)) {
      const record = entry as { id?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
      if (typeof record.id !== "string") continue;
      models.set(record.id, {
        id: record.id,
        contextLength: typeof record.context_length === "number" ? record.context_length : undefined,
        promptPrice: parsePrice(record.pricing?.prompt),
        completionPrice: parsePrice(record.pricing?.completion)
      });
    }
    return { models };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/** §4.7 drift check: diff the registry against remote model lists. Read-only — reports, never mutates. */
export async function runSync(options: SyncOptions = {}): Promise<SyncReport> {
  const registry = Registry.load(options.dataDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const findings: SyncFinding[] = [];
  const providersChecked: string[] = [];
  const providersSkipped: Array<{ providerId: string; reason: string }> = [];

  for (const diagnostic of registry.diagnostics()) {
    findings.push({
      level: "info",
      providerId: diagnostic.providerId,
      field: "registry-diagnostic",
      message: `${diagnostic.family}: ${diagnostic.message}`
    });
  }

  const refsByProvider = new Map<string, ModelRef[]>();
  for (const ref of registry.listModels()) {
    const list = refsByProvider.get(ref.providerId) ?? [];
    list.push(ref);
    refsByProvider.set(ref.providerId, list);
  }

  for (const [providerId, refs] of refsByProvider) {
    if (options.providers !== undefined && !options.providers.includes(providerId)) continue;
    const provider = getProvider(providerId);
    if (!provider) {
      findings.push({ level: "warning", providerId, message: `routes reference unknown provider "${providerId}"` });
      continue;
    }
    const credential = credentialFor(options.credentials, providerId);
    // OpenRouter's /models is public; every other list endpoint needs a key
    if (providerId !== "openrouter" && credential === undefined) {
      providersSkipped.push({ providerId, reason: `no credential (${provider.credentialEnv} not set)` });
      continue;
    }
    const remote = await fetchRemoteList(provider, credential, fetchImpl, timeoutMs);
    if ("failure" in remote) {
      findings.push({ level: "warning", providerId, field: "model-list", message: `model list unavailable: ${remote.failure}` });
      continue;
    }
    providersChecked.push(providerId);
    for (const ref of refs) {
      const remoteModel = remote.models.get(ref.modelId);
      if (remoteModel === undefined) {
        findings.push({
          level: "error",
          providerId,
          modelId: ref.modelId,
          field: "presence",
          message: `${providerId}:${ref.modelId} is not in the provider model list (renamed, removed, or stale id)`
        });
        continue;
      }
      if (providerId !== "openrouter") continue; // only OpenRouter's list carries context/pricing
      const resolved = registry.resolve(providerId, ref.modelId);
      if (!resolved) continue;
      if (remoteModel.contextLength !== undefined && remoteModel.contextLength !== resolved.limits.contextTokens) {
        findings.push({
          level: "warning",
          providerId,
          modelId: ref.modelId,
          field: "contextTokens",
          registryValue: resolved.limits.contextTokens,
          remoteValue: remoteModel.contextLength,
          message: `${providerId}:${ref.modelId} contextTokens drift: registry ${resolved.limits.contextTokens}, OpenRouter ${remoteModel.contextLength}`
        });
      }
      if (priceDiffers(resolved.meta.pricing?.inputPerMTok, remoteModel.promptPrice)) {
        findings.push({
          level: "warning",
          providerId,
          modelId: ref.modelId,
          field: "pricing.inputPerMTok",
          registryValue: resolved.meta.pricing?.inputPerMTok,
          remoteValue: remoteModel.promptPrice,
          message: `${providerId}:${ref.modelId} input pricing drift: registry ${resolved.meta.pricing?.inputPerMTok}, OpenRouter ${remoteModel.promptPrice}`
        });
      }
      if (priceDiffers(resolved.meta.pricing?.outputPerMTok, remoteModel.completionPrice)) {
        findings.push({
          level: "warning",
          providerId,
          modelId: ref.modelId,
          field: "pricing.outputPerMTok",
          registryValue: resolved.meta.pricing?.outputPerMTok,
          remoteValue: remoteModel.completionPrice,
          message: `${providerId}:${ref.modelId} output pricing drift: registry ${resolved.meta.pricing?.outputPerMTok}, OpenRouter ${remoteModel.completionPrice}`
        });
      }
    }
  }

  return { ok: findings.every((finding) => finding.level === "info"), findings, providersChecked, providersSkipped };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/sync/sync.test.ts`
Expected: PASS (8 tests). If the float round-trip test fails (`0.0000005 * 1e6` must equal `0.5` after `toFixed(6)`), the implementation's `parsePrice`/`priceDiffers` rounding is wrong — fix the code, not the test.

- [ ] **Step 6: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/sync/sync.ts tests/sync tests/fixtures/sync
git commit -m "feat: add registry drift sync engine against provider model lists"
```
Expected: 210 tests green (202 + 8).

---

### Task 8: `gateway sync` subcommand + report formatting

Human-readable report + `--json` for machines; exit code 0 clean / 1 drift / 2 usage — so P6's scheduled CI can simply run `gateway sync` and fail on non-zero.

**Files:**
- Create: `src/sync/report.ts`
- Modify: `src/bin/cli.ts` (add sync command + usage line)
- Test: `tests/sync/report.test.ts`, `tests/bin/cli.test.ts` (append)

- [ ] **Step 1: Write the failing report tests**

```ts
// tests/sync/report.test.ts
import { describe, expect, it } from "vitest";
import { formatSyncReport } from "../../src/sync/report.js";
import type { SyncReport } from "../../src/sync/sync.js";

describe("formatSyncReport", () => {
  it("formats findings, checked/skipped lists and a failure summary", () => {
    const report: SyncReport = {
      ok: false,
      findings: [
        { level: "error", providerId: "openrouter", modelId: "a/b", field: "presence", message: "openrouter:a/b is not in the provider model list (renamed, removed, or stale id)" },
        { level: "warning", providerId: "openrouter", modelId: "a/b", field: "contextTokens", registryValue: 1, remoteValue: 2, message: "openrouter:a/b contextTokens drift: registry 1, OpenRouter 2" },
        { level: "info", providerId: "openrouter", field: "registry-diagnostic", message: "fam: unmapped supportedParameters entry \"x\"" }
      ],
      providersChecked: ["openrouter"],
      providersSkipped: [{ providerId: "anthropic", reason: "no credential (ANTHROPIC_API_KEY not set)" }]
    };
    expect(formatSyncReport(report)).toBe(
      [
        "ERROR openrouter:a/b — openrouter:a/b is not in the provider model list (renamed, removed, or stale id)",
        "WARN  openrouter:a/b — openrouter:a/b contextTokens drift: registry 1, OpenRouter 2",
        "info  openrouter — fam: unmapped supportedParameters entry \"x\"",
        "checked: openrouter",
        "skipped: anthropic — no credential (ANTHROPIC_API_KEY not set)",
        "drift check FAILED: 1 error(s), 1 warning(s)"
      ].join("\n")
    );
  });

  it("reports clean runs", () => {
    const report: SyncReport = { ok: true, findings: [], providersChecked: ["openrouter"], providersSkipped: [] };
    expect(formatSyncReport(report)).toBe(["checked: openrouter", "drift check clean"].join("\n"));
  });
});
```

- [ ] **Step 2: Append the failing CLI tests to `tests/bin/cli.test.ts`**

```ts
import { join } from "node:path";

const syncDataDir = join(import.meta.dirname, "../fixtures/sync");

function syncFetch(openrouterData: unknown) {
  return (async (input: string | URL | Request) =>
    String(input).includes("openrouter.ai")
      ? new Response(JSON.stringify(openrouterData), { status: 200 })
      : new Response("{}", { status: 500 })) as typeof fetch;
}

describe("runCli sync", () => {
  const CLEAN = {
    data: [{ id: "drift/drift-model", context_length: 100000, pricing: { prompt: "0.0000005", completion: "0.0000015" } }]
  };

  it("exits 0 and prints a clean report when nothing drifted", async () => {
    const testIo = io({ fetchImpl: syncFetch(CLEAN) });
    expect(await runCli(["sync", "--data-dir", syncDataDir, "--provider", "openrouter"], testIo)).toBe(0);
    expect(testIo.logs.join("\n")).toContain("drift check clean");
  });

  it("exits 1 and prints findings when the registry drifted", async () => {
    const testIo = io({ fetchImpl: syncFetch({ data: [] }) });
    expect(await runCli(["sync", "--data-dir", syncDataDir, "--provider", "openrouter"], testIo)).toBe(1);
    const output = testIo.logs.join("\n");
    expect(output).toContain("ERROR openrouter:drift/drift-model");
    expect(output).toContain("drift check FAILED");
  });

  it("emits machine-readable JSON with --json", async () => {
    const testIo = io({ fetchImpl: syncFetch(CLEAN) });
    expect(await runCli(["sync", "--data-dir", syncDataDir, "--provider", "openrouter", "--json"], testIo)).toBe(0);
    const parsed = JSON.parse(testIo.logs.join("\n")) as { ok: boolean; findings: unknown[]; providersChecked: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.providersChecked).toEqual(["openrouter"]);
  });

  it("rejects unknown sync flags with exit 2", async () => {
    expect(await runCli(["sync", "--bogus"], io())).toBe(2);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/sync/report.test.ts tests/bin/cli.test.ts`
Expected: report tests FAIL on missing module; new CLI tests FAIL with `unknown command "sync"`.

- [ ] **Step 4: Implement `src/sync/report.ts`**

```ts
import type { SyncFinding, SyncReport } from "./sync.js";

const LEVEL_TAG: Record<SyncFinding["level"], string> = { error: "ERROR", warning: "WARN ", info: "info " };

export function formatSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  for (const finding of report.findings) {
    const target = finding.modelId === undefined ? finding.providerId : `${finding.providerId}:${finding.modelId}`;
    lines.push(`${LEVEL_TAG[finding.level]} ${target} — ${finding.message}`);
  }
  if (report.providersChecked.length > 0) lines.push(`checked: ${report.providersChecked.join(", ")}`);
  for (const skipped of report.providersSkipped) lines.push(`skipped: ${skipped.providerId} — ${skipped.reason}`);
  const errors = report.findings.filter((finding) => finding.level === "error").length;
  const warnings = report.findings.filter((finding) => finding.level === "warning").length;
  lines.push(report.ok ? "drift check clean" : `drift check FAILED: ${errors} error(s), ${warnings} warning(s)`);
  return lines.join("\n");
}
```

- [ ] **Step 5: Add the sync command to `src/bin/cli.ts`**

Add imports:

```ts
import { runSync } from "../sync/sync.js";
import { formatSyncReport } from "../sync/report.js";
```

Replace `USAGE` with:

```ts
const USAGE = [
  "usage: gateway <command>",
  "",
  "  gateway serve [--port 8787] [--host 127.0.0.1]",
  "      start the standalone HTTP server; credentials come from env vars",
  "      (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ... — see GET /v1/providers)",
  "",
  "  gateway sync [--provider <id>]... [--json] [--data-dir <path>]",
  "      drift-check the capability registry against OpenRouter /models and",
  "      native provider model lists; exits 1 when drift is found"
].join("\n");
```

Add the dispatch line in `runCli` (after the `serve` line):

```ts
  if (command === "sync") return runSyncCommand(rest, io);
```

Add the command function:

```ts
async function runSyncCommand(args: string[], io: CliIo): Promise<number> {
  let values: { provider?: string[]; json?: boolean; "data-dir"?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        provider: { type: "string", multiple: true },
        json: { type: "boolean" },
        "data-dir": { type: "string" }
      }
    }));
  } catch (error) {
    io.logError(`invalid arguments: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const report = await runSync({
    credentials: envCredentials(io.env ?? process.env),
    ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
    ...(values.provider !== undefined ? { providers: values.provider } : {}),
    ...(values["data-dir"] !== undefined ? { dataDir: values["data-dir"] } : {})
  });
  io.log(values.json === true ? JSON.stringify(report, null, 2) : formatSyncReport(report));
  return report.ok ? 0 : 1;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/sync/report.test.ts tests/bin/cli.test.ts`
Expected: PASS (report 2 + cli 8: the 4 from Task 6 plus 4 new).

- [ ] **Step 7: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/sync/report.ts src/bin/cli.ts tests/sync/report.test.ts tests/bin/cli.test.ts
git commit -m "feat: add gateway sync command with drift report and CI-friendly exit codes"
```
Expected: 216 tests green (210 + 6).

---

### Task 9: Public exports, packaging, docs, abort documentation

Wire the new surface into the package entry (the fastify plugin stays subpath-only so the optional peer is explicit), verify the tarball end to end, document the chat/stream abort asymmetry (carryover #3's "document" half — the 499 normalization was the "normalize" half), and refresh the README.

**Files:**
- Modify: `src/index.ts`, `package.json` (exports), `src/client/gateway.ts` (jsdoc only), `README.md`

- [ ] **Step 1: Extend `src/index.ts`**

Append:

```ts
export {
  errorResponse,
  httpStatusForError,
  jsonResponse,
  serializeGatewayError,
  type SerializedGatewayError
} from "./server/shared.js";
export { createGatewayHandler, type GatewayHandlerOptions, type GatewayHttpHandler, type ModelSummary } from "./server/handler.js";
export { envCredentials } from "./server/env.js";
export { serve, type RunningServer, type ServeOptions } from "./server/node.js";
export { runSync, type SyncFinding, type SyncOptions, type SyncReport } from "./sync/sync.js";
export { formatSyncReport } from "./sync/report.js";
```

(Do NOT export `gatewayPlugin` here — `@waifucave/gateway/fastify` is the only way in, keeping the optional peer boundary visible.)

- [ ] **Step 2: Add the `./fastify` subpath export to `package.json`**

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./fastify": {
      "types": "./dist/server/fastify.d.ts",
      "import": "./dist/server/fastify.js"
    }
  },
```

- [ ] **Step 3: Document the abort contract in `src/client/gateway.ts` (jsdoc only — no behavior change)**

Above `async chat(` add:

```ts
  /**
   * Abort contract (P1b carryover #3): if `request.signal` aborts, chat()
   * rejects with the RAW abort reason, not a GatewayError — user aborts must
   * stay distinguishable from provider failures. stream() differs: mid-stream
   * aborts surface as a final `error` event of kind "network". The HTTP layer
   * normalizes both to a 499 response (server/shared.ts errorResponse).
   */
```

The existing comment above `stream()` gains one line at the end:

```ts
   * Aborts mid-stream surface as an `error` event of kind "network" (see chat()'s abort contract).
```

- [ ] **Step 4: Update `README.md`**

Update the status section to record P1c complete (HTTP server, Fastify plugin, `gateway serve`/`gateway sync` bin). Add an "HTTP API" section documenting: the five endpoints with one-line descriptions; `createGatewayHandler` (framework-agnostic `Request → Response`); the Fastify mount snippet:

```ts
import gatewayPlugin from "@waifucave/gateway/fastify";
await app.register(gatewayPlugin, { prefix: "/api/llm", credentials: (id) => lookupKey(id) });
```

standalone usage (`npx gateway serve`, env-var credentials, never persisted); SSE framing (`data: <StreamEvent JSON>` frames, `error` events carry serialized GatewayErrors, terminated by `data: [DONE]`); the error-status table (auth 401, rate_limit 429, quota 402, invalid_request/unsupported_parameter 400, content_filter 422, timeout 504, server/network 502, client-abort 499); a "Drift sync" section (`npx gateway sync [--json] [--provider id]`, exit codes 0/1/2, OpenRouter checked credential-free, others skipped without keys, read-only). Mention explicitly: streaming responses are NOT bounded by `timeoutMs` (headers-only timeout), and the abort asymmetry note from Step 3.

- [ ] **Step 5: Full verification + tarball smoke**

```bash
npm run typecheck && npm test && npm run build
npm pack --dry-run 2>&1 | grep -E "dist/(bin|server|sync)/" | head -20
grep -rn 'from "fastify"' dist ; echo "fastify grep exit: $?"
grep -rn 'from "zod"' dist ; echo "zod grep exit: $?"
```
Expected: suite green; pack list includes `dist/bin/gateway.js`, `dist/server/{shared,env,handler,fastify,node}.js`, `dist/sync/{sync,report}.js`; both greps exit 1.

```bash
TMP=$(mktemp -d) && npm pack --pack-destination "$TMP" >/dev/null && cd "$TMP" && npm init -y >/dev/null 2>&1 && npm install ./waifucave-gateway-0.0.0.tgz >/dev/null 2>&1 \
  && node -e 'import("@waifucave/gateway").then((m) => console.log("core:", typeof m.createGatewayHandler, typeof m.serve, typeof m.runSync))' \
  && node -e 'import("@waifucave/gateway/fastify").then((m) => console.log("fastify subpath:", typeof m.gatewayPlugin, typeof m.default))' \
  && npx gateway --help && echo "bin exit: $?" \
  && node -e 'import("@waifucave/gateway").then(async (m) => { const s = await m.serve({ port: 0 }); const r = await fetch(s.url + "/v1/models"); const b = await r.json(); console.log("serve smoke:", r.status, b.models.length); await s.close(); })' \
  && cd - && rm -rf "$TMP"
```
Expected: `core: function function function`; `fastify subpath: function function` (no fastify installed in the temp dir — proves the import works without the peer); usage text with `bin exit: 0`; `serve smoke: 200 100`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/client/gateway.ts package.json README.md
git commit -m "feat: export http server and sync surface; document abort contract and http api"
```

- [ ] **Step 7: Final review checkpoint (do not push yet)**

Run `git log --oneline main` and confirm the task commits are all present; leave the push for the final review per the agreed workflow.

---

## Client usage (what P2 will write)

```ts
// Discord Waifus src/api/server.ts (P2, not this plan):
import gatewayPlugin from "@waifucave/gateway/fastify";
await app.register(gatewayPlugin, {
  prefix: "/api/llm",
  credentials: (providerId) => storage.getProviderCredential(providerId)?.apiKey
});
// Frontend then reads capability docs from GET /api/llm/v1/models/:provider/:model
// and live-gates forms via POST /api/llm/v1/validate.
```

## Self-review notes (completed during planning)

- **Spec coverage vs MIGRATION_PLAN §4.6/§4.7 and the P1 exit criteria:** five endpoints ✅ (T2 providers/models/model-detail, T3 validate+chat, T4 chat SSE), framework-agnostic `Request → Response` handler ✅ (T2), Fastify plugin ✅ (T5), standalone `gateway serve` bin ✅ (T6), credentials injected by host / env vars standalone / never persisted ✅ (handler takes `GatewayOptions.credentials`; bin uses `envCredentials`; nothing writes keys), drift sync vs OpenRouter `/models` + provider lists ✅ (T7/T8). P1 exit criterion "`gateway serve` answers all 5 endpoints" pinned by T6 socket tests + T9 serve smoke. P1b carryovers: #2 documented + deliberately unbounded body (T4 jsdoc, README), #3 normalized to 499 + documented (T1 `errorResponse`, T4 test, T9 jsdoc/README), #5 responses+google wires now integration-tested through the full stack (T4).
- **Type consistency spot-checks:** `createGatewayHandler` returns `{handle, gateway}` and T5/T6 adapters only use those two members; `GatewayHandlerOptions = GatewayOptions` so `credentials | fetchImpl | includeRaw | timeoutMs` flow through everywhere (plugin, serve, bin); `serve` destructures `port`/`host` and forwards the REST as handler options — `RunningServer.gateway` is `Gateway` (imported type-only in node.ts); `SyncOptions.credentials` reuses the same record-or-function shape as `GatewayOptions`; `sseFrame` consumes `StreamEvent` and serializes the `error` arm via `serializeGatewayError` whose input is `GatewayError` — matching `StreamEvent`'s `{type:"error"; error: GatewayError}`. CLI `io.fetchImpl` spreads conditionally to satisfy `exactOptionalPropertyTypes`-style strictness under `noUncheckedIndexedAccess`.
- **Judgment calls encoded above:** unknown model is 404 at the HTTP layer (resolved *before* the gateway call) while other gateway errors keep their taxonomy mapping; mid-stream failures stay 200-SSE error events while pre-I/O failures become statuses (the probe boundary is exactly `gateway.stream()`'s throw/yield contract); 499 for client aborts (nginx convention, valid Response status); the fastify plugin is subpath-only to keep the optional peer explicit; sync severity = error (missing id) / warning (drift, unreachable list) / info (registry diagnostics) with `ok` failing on warnings too because §4.7's job is flagging stale docs; google id compare strips the `models/` prefix; OpenRouter pricing compared per-MTok after `toFixed(6)` rounding on both sides.
- **Counts:** expected totals per task are stated in each "Expected" line (155 → ~216 by Task 8). If a count differs by ±1 because vitest groups differently, verify the listed behaviors are all present instead of trusting the number.
- **Subagent execution notes:** include the FULL task text in every subagent prompt; two-stage review per task (spec, then quality); independently verify every implementer report (run the tests yourself — a P1a subagent fabricated a report); fix-first findings get fixed before moving on; commits to `main` directly, push only after final review.

---

## Execution record (2026-06-11)

**P1c COMPLETE and signed off** — 16 commits on `waifucave-gateway` main (`e9a2532` → `27b0def`, pushed to GitHub), **224 tests green** (was 155), typecheck/build clean, tarball install-smoked twice (implementer + controller independently): main entry + `./fastify` subpath import with NO fastify in node_modules, `npx gateway --help` exit 0, packaged `serve({port:0})` answers `/v1/models` with all 100 routes. Final integration review probed all five endpoints live over a socket (200/200/200/200/401-without-creds) plus 404/405/400 envelope consistency and the SSE first-event probe (401 JSON, not a 200 SSE). Executed subagent-driven with two-stage review per task; every implementer report verified independently (no fabrications this round). P1b carryovers #2 (documented, body unbounded), #3 (499 normalization + jsdoc), #5 (responses/google wires now integration-tested through the server) all landed.

The P1 exit criterion from MIGRATION_PLAN §8 — "`gateway serve` answers all 5 endpoints" — is met. **P1 (a+b+c) is done.**

Notable reviewer-driven deviations from this plan:

- **shared:** `errorResponse`'s 500 fallback never throws (try/catch around `String(error)` for pathological objects — matches the `extractErrorMessage` invariant).
- **handler routing:** `pathSegments` try/catches `decodeURIComponent` — malformed percent-encoding (e.g. `%E0%A4%A`) 404s instead of escaping as a raw `URIError` 500 through Fastify/node mounts.
- **handler chat boundary:** two added guards — bare-string `responseFormat` is 400-rejected on `/v1/chat` (it bypassed validation: the gateway checks `responseFormat?.type`, the codec truthy-checks, producing a malformed wire body); non-array `tools` is 400-rejected (raw codec TypeError surfaced as a misleading 500). `/v1/validate` still accepts the string form per plan.
- **streaming 499:** the plan's claim that a pre-aborted signal rejects the first `next()` was WRONG — `fetchWithRetry`'s pre-flight abort throw lands inside `gateway.stream`'s try/catch and becomes an error *event*. Fixed with an explicit pre-abort guard at the top of `streamingChat`. Also pinned: an error event arriving into an orphaned pull after consumer cancel is rejection-free (WHATWG stream machinery absorbs it — reviewer reproduced from first principles).
- **sync:** google pagination is now bounded (50-page cap + repeated-token guard → `failure` → warning). The unbounded version was reproduced as a real OOM crash (~4 GB) under a token-repeating fake. `gateway sync --data-dir <missing>` exits 1 with a clean message instead of an ENOENT stack trace.
- **packaging fact:** `dist/server/fastify.d.ts` legitimately contains the type-only fastify import; the dep-free check greps `--include="*.js"` only.

**P2 / follow-up carryover (from reviews, non-blocking):**
1. Codecs throw raw `TypeError`s (not `GatewayError("invalid_request")`) for malformed message/tool *elements* — the handler guards top-level shapes, but bad elements still surface as 500s. Codec-level hardening is a P1b-layer follow-up.
2. `fastify.ts` prefix strip: a bare-prefix request with a query string (`/api/llm?x=1`) slices to `?x=1` → 404. Harmless (no gateway route lives at the root), noted for completeness.
3. The 499 client-abort body reuses `kind:"network"` — distinguishable from upstream 502s only by status code. Acceptable; revisit only if a consumer needs to branch on kind.
4. `readBody` in node.ts is unbounded (local tooling, 127.0.0.1) and post-listen `server.on("error")` is unhandled — file with P6 hardening if the standalone server ever grows beyond local tooling.
5. `version: "0.0.0"` — bump at P6 publish time (`@waifucave/gateway@0.1.0` per MIGRATION_PLAN §8).
6. Sync's native list-endpoint shapes (Anthropic/Google/openai-compatible) remain not live-verified — first real `gateway sync` run with keys should confirm; parser fixes come with fixtures, never loosened tolerance. Scheduled drift-check CI is P6.
