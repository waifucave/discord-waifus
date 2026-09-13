# Gateway P2: Side-by-Side Mount (/api/llm) + Registry Proxies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MIGRATION_PLAN §8 row P2 — add `@waifucave/gateway` as a `file:../waifucave-gateway` dependency, mount its Fastify plugin at `/api/llm/*` with credentials injected live from the app's storage, and expose the gateway registry on `/api/models` + `/api/providers` as additive sibling fields. Exit criteria: both old and new model lists visible; NO behavior change in chat — `src/providers/pipelines.ts` keeps serving all traffic.

**Architecture:** Strictly additive, app-repo-only. `createApiServer` (src/api/server.ts) registers `gatewayPlugin` from `@waifucave/gateway/fastify` under the `/api/llm` prefix; the plugin is self-encapsulated (own scoped JSON parser, own 404/405/error envelopes). Credentials flow through a new synchronous lookup (`src/api/llmGatewayCredentials.ts`) that re-reads `user/providers.json` on every call — the gateway's credentials hook is sync (`(providerId) => string | undefined`), StorageService is async, and a fresh `readFileSync` gives live key pickup with zero cache-invalidation machinery (storage writes are atomic temp+rename, so a sync read never sees a partial file). The legacy `/api/models` and `/api/providers` payload fields stay byte-identical; new `gatewayModels`/`gatewayProviders` sibling fields are produced by a second `createGatewayHandler` instance invoked with synthetic `Request`s — the proxies exercise the exact public HTTP shapes, not re-derived data.

**Tech Stack:** TypeScript (ESM, NodeNext — local imports need `.js` extensions), Fastify 5, Vitest with real temp data roots (`tests/testUtils.ts`, no mocks for storage), `@waifucave/gateway@0.0.0` consumed as an npm `file:` symlink.

**Repo location:** `/Users/example/Xcode projects/Discord Waifus`. All commands run from there. Commit directly to `main`. The gateway repo (`../waifucave-gateway`) is consumed read-only this round — zero gateway commits planned.

**Context docs:** `MIGRATION_PLAN.md` (§7.4 API server, §8 row P2, §10 concurrent work), `docs/superpowers/plans/2026-06-11-prompting-overhaul/06-gateway-coordination.md` (no P2 overlap; P3 must re-check), P1c plan + execution record (`2026-06-11-gateway-p1c-http-server-sync.md`) — its P2 carryovers #1 (codec TypeErrors for malformed elements), #2 (bare-prefix+query 404 edge), #3 (499 reuses kind "network") are inherited and explicitly NOT fixed here.

---

## Hard rules

1. **Do not touch** `src/providers/`, `src/orchestration/`, or `src/shared/schemas/` — chat behavior must not change; those are P3/P4 and prompting-overhaul (W1–W4) territory. If a task seems to need it, STOP and report.
2. **Do not modify the gateway repo.** P2 consumes `@waifucave/gateway` at commit `27b0def` as-is. A genuine gateway bug found during P2 is a STOP-and-report, not a drive-by fix.
3. **Legacy API shapes are frozen.** `/api/models`.`models` and `/api/providers`.`providers` (and `revision`/`updatedAt`) must stay byte-compatible. New data lands ONLY in new sibling fields.
4. **Gateway `data/` is authoritative.** If a golden below mismatches what the registry actually serves, print the live response and fix the *test expectation* — never the data, never the gateway.
5. **Keys never leave storage.** The lookup reads `user/providers.json` and returns strings; nothing writes keys anywhere else, nothing logs them (assert no key material in error paths).
6. **Stage only the files your task names.** The worktree has unrelated untracked content (`research/`, `new providers.md`, `docs/superpowers/plans/2026-06-11-w1-orchestrator-implementation.md`) — never `git add` it. A parallel workstream commits to this repo: run `git status` before every commit; if a file you must edit changed underneath you, re-read it before editing.

## Verified facts this plan is written against

Audited live 2026-06-11: app repo at `d34d3d3` (369 tests green across 15 files, `npm run typecheck` clean), gateway repo at `27b0def` (P1c sign-off: 224 tests, clean tree, `dist/` built and NEWER than `src/`).

- **Gateway packaging:** `@waifucave/gateway@0.0.0`, `exports`: `.` → `dist/index.js` and `./fastify` → `dist/server/fastify.js` (types alongside). `files: [dist, data]`. fastify is an optional peer `^5.0.0` (app has `^5.8.5` — satisfied) and `src/server/fastify.ts` imports it type-only. npm `file:` directory deps are **symlinked** (no pack, no `prepare` run) — the gateway must already be built, and it is; after future gateway src changes the workflow is `npm run build` in `../waifucave-gateway` (nothing to re-run in this repo).
- **`GatewayOptions`** (= `GatewayHandlerOptions` = `GatewayPluginOptions`): `credentials?: Record<string,string> | ((providerId: string) => string | undefined)` (SYNC, resolved per request — `/v1/providers` checks it live per call too), `fetchImpl?: typeof fetch`, `timeoutMs`, `maxRetries`, `retryBaseDelayMs`, `dataDir`, `includeRaw`. Empty-string credential counts as unconfigured.
- **`gatewayPlugin`** (default + named export of `@waifucave/gateway/fastify`): registered via `app.register(gatewayPlugin, { prefix: "/api/llm", ...options })`. Adds a *scoped* `application/json` content-type parser (`parseAs: "string"`; handler parses JSON itself) — deliberately not fastify-plugin-wrapped so it stays encapsulated and cannot affect the app's own routes. Catch-all `instance.all("/*")`, strips `instance.prefix` from `request.url`, wires client-disconnect to an AbortController, pipes `Response.body` via `Readable.fromWeb`.
- **Gateway registry:** 100 `(provider, model)` routes, 14 providers. `PROVIDERS` entries are `{id, displayName, baseUrl, credentialEnv, wire}`. The 6 legacy app provider ids (`xai`, `deepseek`, `anthropic`, `openai`, `zai`, `google-ai-studio`) all exist verbatim among the gateway's 14 — the credential lookup is id-passthrough, no mapping table. (Gateway `zai` baseUrl is the general `/api/paas/v4` path vs the old catalog's coding-plan path — intentional Table B correction, visible only on the new surface.)
- **Pinned gateway HTTP goldens** (P1c-verified, registry unchanged since): see exact JSON in Task 3's tests — `/v1/models` count + `deepseek:deepseek-v4-pro` summary, `/v1/models/openrouter/moonshotai/kimi-k2.6` slash-id resolution, `/v1/providers` deepseek entry, `/v1/validate` temperature-99 result, chat 401 envelope, deepseek chat wire body (`thinking: {type:"enabled"}`, `reasoning_effort: "high"`, dropped-sampling warnings; `reasoning.enabled` defaults TRUE in data), gateway 404/405 envelopes.
- **App API server:** `createApiServer` builds the Fastify instance inline and returns it (`startBackend` listens). Root-level error handler + not-found handler exist; the plugin's catch-all owns everything under `/api/llm` so they don't interfere. Old `/api/models` returns `{models: listModels()}` (23 models), `/api/providers` returns `{revision, updatedAt, providers: [...6 entries with credentials status...]}` from `listProviders()` + `user/providers.json`.
- **Credentials storage:** `PUT /api/providers/:providerId/credentials` validates `providerId` against `ProviderIdSchema` (z.enum of the 6 legacy ids — frozen until P4). Consequence, document don't fix: in P2 only those 6 providers can have stored keys, so `/api/llm/v1/chat` is live-usable for their direct routes; the other 8 gateway providers stay `credentialConfigured: false`.
- **Tests:** `app.inject()` (no sockets), real temp roots via `makeTempRoot`/`removeTempRoot`, cleanup in `afterEach`. `tests/api.test.ts` builds apps via a local `makeApp()` helper.
- **Frontend:** `src/frontend/api/client.ts` calls `/api/providers` + `/api/models`; types hand-mirrored in `src/frontend/api/types.ts` (`ProvidersResponse`, `ModelsResponse` at lines ~145–163). Vite dev proxy forwards all `/api` to `127.0.0.1:3888`, so `/api/llm/*` already flows in dev. No frontend *code* change in P2 — types only.
- **Publishing hazard (real):** the app is published (`private: false`, v1.5.155, `release:beta` script). Publishing with a `file:` dep ships `"@waifucave/gateway": "file:../waifucave-gateway"` to the registry and breaks every consumer install. Task 5 adds a `prepublishOnly` guard; publishing stays blocked until P6 swaps to a pinned registry version (MIGRATION_PLAN §3 locked decision).

## Explicitly OUT of P2 scope (flag, don't fix)

1. P1c carryover #1: codecs throw raw `TypeError`s for malformed message/tool *elements* — through the mount these surface as 500s. Gateway-layer follow-up.
2. P1c carryover #2: `/api/llm?x=1` (bare prefix + query) 404s oddly. Harmless, no gateway route at the root.
3. P1c carryover #3: client-abort 499 body reuses `kind: "network"`.
4. Widening `ProviderIdSchema` / storing keys for the 8 new providers — P4.
5. Frontend UI consuming `gatewayModels`/`gatewayProviders` — P5.
6. Streaming chat through the app mount is not unit-tested here — the SSE path (first-event probe, disconnect abort) is fully covered by gateway-repo tests; the app adds no logic to it.
7. Live `gateway sync` run with real keys (P1c carryover #6) — separate errand, CI in P6.

## File structure

```
Discord Waifus/
├── package.json                          # modify: T1 (file dep), T5 (prepublishOnly guard)
├── package-lock.json                     # modify: T1 (generated by npm)
├── CLAUDE.md                             # modify: T5 (gateway dep workflow section)
├── MIGRATION_PLAN.md                     # modify: execution wrap-up (§8 P2 row status)
├── scripts/
│   └── check-no-file-deps.mjs            # new: T5 (publish guard)
├── src/
│   ├── api/
│   │   ├── llmGatewayCredentials.ts      # new: T2 (sync live key lookup)
│   │   └── server.ts                     # modify: T3 (mount + llmGateway test option), T4 (registry proxies)
│   └── frontend/api/types.ts             # modify: T4 (gateway summary type mirrors)
└── tests/
    ├── llmGatewayCredentials.test.ts     # new: T2
    └── api.test.ts                       # modify: T3 + T4 (makeApp llmFetch param, appended describes)
```

Dependency direction: `server.ts` → (`llmGatewayCredentials.ts`, `@waifucave/gateway`, `@waifucave/gateway/fastify`). Nothing imports the new module except `server.ts` and its test. No existing module's imports change.

---

### Task 1: Add the `file:` dependency and verify resolution

No test-first here — this is dependency plumbing; the verification IS the smoke commands. The gateway's `dist/` is already built (verified fact), so the symlink resolves immediately.

**Files:**
- Modify: `package.json` (via npm, not by hand)
- Modify: `package-lock.json` (generated)

- [ ] **Step 1: Install the dependency**

```bash
npm install "../waifucave-gateway"
```

Expected: exits 0; `package.json` `dependencies` gains `"@waifucave/gateway": "file:../waifucave-gateway"` (npm sorts keys — it lands first alphabetically); `node_modules/@waifucave/gateway` is a symlink.

- [ ] **Step 2: Smoke both entry points and the symlink**

```bash
node -e "console.log('symlink:', require('node:fs').lstatSync('node_modules/@waifucave/gateway').isSymbolicLink())"
node -e "import('@waifucave/gateway').then((m) => console.log('main:', typeof m.createGatewayHandler, m.PROVIDERS.length))"
node -e "import('@waifucave/gateway/fastify').then((m) => console.log('fastify:', typeof m.default))"
```

Expected output, exactly:
```
symlink: true
main: function 14
fastify: function
```

- [ ] **Step 3: Full baseline still green**

```bash
npm run typecheck && npx vitest run
```

Expected: typecheck clean; 369 tests green (15 files). The dep is not imported anywhere yet — any failure here is environmental; STOP and report rather than "fixing" unrelated code.

- [ ] **Step 4: Commit (check `git status` first; stage ONLY these two files)**

```bash
git add package.json package-lock.json
git commit -m "feat: add @waifucave/gateway as file: dependency (P2 side-by-side)"
```

---

### Task 2: Synchronous live credentials lookup

The gateway's credentials hook is sync; `StorageService.readJson` is async. This module does a fresh `readFileSync` of `user/providers.json` per call: live pickup of `PUT /api/providers/:id/credentials` with no cache to invalidate. It deliberately does NOT use `ProviderCredentialsFileSchema`: the hot path must tolerate a malformed file (return `undefined`, never throw) and stay forward-compatible with P4 widening the stored provider ids — it only cares about `providers[id].apiKey` being a non-empty string.

**Files:**
- Create: `src/api/llmGatewayCredentials.ts`
- Test: `tests/llmGatewayCredentials.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/llmGatewayCredentials.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderCredentialsLookup } from "../src/api/llmGatewayCredentials.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  return root;
}

async function writeProvidersFile(root: string, contents: string): Promise<void> {
  await mkdir(path.join(root, "user"), { recursive: true });
  await writeFile(path.join(root, "user", "providers.json"), contents, "utf8");
}

describe("createProviderCredentialsLookup", () => {
  it("returns undefined when the providers file does not exist yet", async () => {
    const lookup = createProviderCredentialsLookup(await makeRoot());
    expect(lookup("deepseek")).toBeUndefined();
  });

  it("returns the stored key and undefined for providers without one", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    await writeProvidersFile(
      root,
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        updatedAt: "2026-06-11T00:00:00.000Z",
        providers: {
          deepseek: {
            providerId: "deepseek",
            apiKey: "sk-deep",
            createdAt: "2026-06-11T00:00:00.000Z",
            updatedAt: "2026-06-11T00:00:00.000Z"
          }
        }
      })
    );
    expect(lookup("deepseek")).toBe("sk-deep");
    expect(lookup("openrouter")).toBeUndefined();
  });

  it("re-reads the file on every call so key updates apply without a restart", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "sk-1" } } }));
    expect(lookup("deepseek")).toBe("sk-1");
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "sk-2" } } }));
    expect(lookup("deepseek")).toBe("sk-2");
  });

  it("never throws: corrupt JSON, wrong shapes, and empty keys all yield undefined", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    await writeProvidersFile(root, "{not json");
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify([1, 2]));
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "" } } }));
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: "nope" } }));
    expect(lookup("deepseek")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/llmGatewayCredentials.test.ts`
Expected: FAIL — cannot resolve `../src/api/llmGatewayCredentials.js`.

- [ ] **Step 3: Implement `src/api/llmGatewayCredentials.ts`**

```ts
import { readFileSync } from "node:fs";
import { resolveDataPath } from "../config/paths.js";

/**
 * Synchronous provider-key lookup for the mounted LLM gateway, whose
 * credentials hook is sync. Reads user/providers.json fresh on every call so
 * key updates via PUT /api/providers/:providerId/credentials apply without a
 * restart (storage writes are atomic temp+rename, so a sync read never sees a
 * partial file). Shape-tolerant by design — a malformed file or a future
 * schema change must degrade to "no credential", never throw on the chat path.
 */
export function createProviderCredentialsLookup(
  dataRoot: string
): (providerId: string) => string | undefined {
  const filePath = resolveDataPath(dataRoot, "user", "providers.json");
  return (providerId) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed === null || typeof parsed !== "object") return undefined;
      const providers = (parsed as { providers?: unknown }).providers;
      if (providers === null || typeof providers !== "object") return undefined;
      const entry = (providers as Record<string, unknown>)[providerId];
      if (entry === null || typeof entry !== "object") return undefined;
      const apiKey = (entry as { apiKey?: unknown }).apiKey;
      return typeof apiKey === "string" && apiKey !== "" ? apiKey : undefined;
    } catch {
      return undefined;
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/llmGatewayCredentials.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
npm run typecheck && npx vitest run
git add src/api/llmGatewayCredentials.ts tests/llmGatewayCredentials.test.ts
git commit -m "feat: add live sync provider-credentials lookup for the llm gateway"
```
Expected: typecheck clean; 373 tests green (369 + 4).

---

### Task 3: Mount the gateway plugin at `/api/llm`

`createApiServer` registers `gatewayPlugin` with the credentials lookup and gains a test-only `llmGateway.fetchImpl` passthrough — the one new option that lets tests pin the credential→wire flow without real network. Registration goes right after the error handler, before any routes (order is cosmetic pre-listen, but keep the gateway block in one place).

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api.test.ts` (extend `makeApp`, append a describe)

- [ ] **Step 1: Extend `makeApp` and append the failing tests**

In `tests/api.test.ts`, change the vitest import to include `vi`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
```

Replace the `makeApp` signature/body so callers can inject the gateway fetch (keep everything else identical):

```ts
async function makeApp(extra: { llmFetch?: typeof fetch } = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: {
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: []
    },
    queues: {
      active: 0,
      configuredGuilds: 0
    }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    ...(extra.llmFetch ? { llmGateway: { fetchImpl: extra.llmFetch } } : {})
  });
  return { app, root };
}
```

Append at the end of the file:

```ts
const LLM_CHAT_OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

describe("LLM gateway mount (/api/llm)", () => {
  it("serves the gateway model registry through the mount", async () => {
    const { app } = await makeApp();
    try {
      const models = await app.inject({ method: "GET", url: "/api/llm/v1/models" });
      expect(models.statusCode).toBe(200);
      const body = models.json() as { models: Array<Record<string, unknown>> };
      expect(body.models).toHaveLength(100);
      expect(
        body.models.find((m) => m.providerId === "deepseek" && m.modelId === "deepseek-v4-pro")
      ).toEqual({
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

      const detail = await app.inject({
        method: "GET",
        url: "/api/llm/v1/models/openrouter/moonshotai/kimi-k2.6"
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        providerId: "openrouter",
        modelId: "moonshotai/kimi-k2.6",
        family: "kimi-k2-6",
        displayName: "Kimi K2.6",
        baseUrl: "https://openrouter.ai/api/v1"
      });
    } finally {
      await app.close();
    }
  });

  it("reflects StorageService credentials live in /v1/providers", async () => {
    const { app } = await makeApp();
    try {
      const before = await app.inject({ method: "GET", url: "/api/llm/v1/providers" });
      expect(before.statusCode).toBe(200);
      const beforeBody = before.json() as {
        providers: Array<{ id: string; credentialConfigured: boolean }>;
      };
      expect(beforeBody.providers).toHaveLength(14);
      expect(beforeBody.providers.every((p) => p.credentialConfigured === false)).toBe(true);

      const put = await app.inject({
        method: "PUT",
        url: "/api/providers/deepseek/credentials",
        payload: { apiKey: "sk-live-key" }
      });
      expect(put.statusCode).toBe(200);

      const after = await app.inject({ method: "GET", url: "/api/llm/v1/providers" });
      const afterBody = after.json() as { providers: Array<Record<string, unknown>> };
      expect(afterBody.providers.find((p) => p.id === "deepseek")).toEqual({
        id: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        credentialEnv: "DEEPSEEK_API_KEY",
        wire: "openai-chat",
        credentialConfigured: true
      });
      expect(afterBody.providers.find((p) => p.id === "anthropic")?.credentialConfigured).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns the gateway 401 envelope for chat without a stored credential", async () => {
    const { app } = await makeApp();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/llm/v1/chat",
        payload: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }]
        }
      });
      expect(chat.statusCode).toBe(401);
      expect(chat.json()).toEqual({
        error: {
          kind: "auth",
          message: "no credential configured for provider deepseek",
          provider: "deepseek",
          retryable: false
        }
      });
    } finally {
      await app.close();
    }
  });

  it("flows a stored key onto the provider wire for chat", async () => {
    const llmFetch = vi.fn(
      async () => new Response(JSON.stringify(LLM_CHAT_OK_PAYLOAD), { status: 200 })
    );
    const { app } = await makeApp({ llmFetch: llmFetch as unknown as typeof fetch });
    try {
      await app.inject({
        method: "PUT",
        url: "/api/providers/deepseek/credentials",
        payload: { apiKey: "sk-live-key" }
      });
      const chat = await app.inject({
        method: "POST",
        url: "/api/llm/v1/chat",
        payload: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          params: { temperature: 0.7, "reasoning.enabled": true }
        }
      });
      expect(chat.statusCode).toBe(200);

      // P1b/P1c golden wire body, verbatim — proves the stored key reached the wire
      const [url, init] = llmFetch.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-live-key");
      expect(JSON.parse(init.body as string)).toEqual({
        model: "deepseek-v4-pro",
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }]
      });

      const body = chat.json() as Record<string, unknown>;
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
    } finally {
      await app.close();
    }
  });

  it("answers /v1/validate with the pinned validation result", async () => {
    const { app } = await makeApp();
    try {
      const validate = await app.inject({
        method: "POST",
        url: "/api/llm/v1/validate",
        payload: { provider: "deepseek", model: "deepseek-v4-pro", params: { temperature: 99 } }
      });
      expect(validate.statusCode).toBe(200);
      expect(validate.json()).toEqual({
        ok: false,
        violations: [
          { param: "temperature", code: "out_of_range", message: "temperature must be in [0, 2]" }
        ],
        warnings: [
          { ruleId: "thinking-drops-sampling", param: "temperature", code: "dropped" },
          { ruleId: "thinking-drops-sampling", param: "topP", code: "dropped" }
        ],
        effectiveParams: { "reasoning.enabled": true, "reasoning.effort": "high" }
      });
    } finally {
      await app.close();
    }
  });

  it("keeps gateway and app error envelopes separate", async () => {
    const { app } = await makeApp();
    try {
      const gateway404 = await app.inject({ method: "GET", url: "/api/llm/v1/nope" });
      expect(gateway404.statusCode).toBe(404);
      expect(gateway404.json()).toEqual({
        error: { kind: "invalid_request", message: "not found", retryable: false }
      });

      const method405 = await app.inject({
        method: "POST",
        url: "/api/llm/v1/providers",
        payload: {}
      });
      expect(method405.statusCode).toBe(405);
      expect(method405.headers.allow).toBe("GET");

      const app404 = await app.inject({ method: "GET", url: "/api/nope" });
      expect(app404.statusCode).toBe(404);
      expect(app404.json()).toEqual({
        error: "NotFound",
        message: "GET /api/nope was not found."
      });
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api.test.ts`
Expected: the new describe FAILS (all `/api/llm/*` requests hit the app's NotFound handler → status 404 with the app envelope; the chat/validate/providers expectations all mismatch). All pre-existing tests still PASS. If anything pre-existing fails, STOP — that's a regression in the `makeApp` edit.

- [ ] **Step 3: Mount the plugin in `src/api/server.ts`**

Add imports (with the other imports at the top; package imports take no `.js` suffix):

```ts
import { type GatewayHandlerOptions } from "@waifucave/gateway";
import gatewayPlugin from "@waifucave/gateway/fastify";
import { createProviderCredentialsLookup } from "./llmGatewayCredentials.js";
```

Extend `ApiServerOptions` (after the `logger?: Logger;` member):

```ts
  /** Test hook: overrides the fetch the mounted LLM gateway uses for provider calls. */
  llmGateway?: {
    fetchImpl?: typeof fetch;
  };
```

Inside `createApiServer`, immediately after the `app.setErrorHandler(...)` block and before `app.get("/", ...)`:

```ts
  // P2 (MIGRATION_PLAN §7.4/§8): the gateway HTTP API rides at /api/llm/* with
  // keys read live from user/providers.json. The plugin is self-encapsulated —
  // own JSON parsing, own error envelopes; pipelines.ts chat traffic is untouched.
  const llmGatewayOptions: GatewayHandlerOptions = {
    credentials: createProviderCredentialsLookup(options.dataRoot),
    ...(options.llmGateway?.fetchImpl ? { fetchImpl: options.llmGateway.fetchImpl } : {})
  };
  await app.register(gatewayPlugin, { prefix: "/api/llm", ...llmGatewayOptions });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS (all pre-existing + 6 new).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
npm run typecheck && npx vitest run
git add src/api/server.ts tests/api.test.ts
git commit -m "feat: mount gateway http api at /api/llm with storage-backed credentials"
```
Expected: typecheck clean; 379 tests green (373 + 6).

---

### Task 4: Registry proxies on `/api/models` + `/api/providers` and frontend type mirrors

The legacy fields stay byte-identical; new sibling fields carry the gateway listings. The proxies call a dedicated `createGatewayHandler` instance with synthetic `Request`s so they serve the exact public `/v1/models` / `/v1/providers` shapes (same data path the mount serves) instead of re-deriving them. Both endpoints are static-registry GETs — a non-200 from them means the gateway itself is broken, so the proxy throws (app 500) rather than silently omitting the field.

**Files:**
- Modify: `src/api/server.ts`
- Modify: `src/frontend/api/types.ts`
- Test: `tests/api.test.ts` (append a sibling describe)

- [ ] **Step 1: Append the failing tests to `tests/api.test.ts`**

```ts
describe("Gateway registry proxies (/api/models, /api/providers)", () => {
  it("exposes both the legacy and gateway model lists on /api/models", async () => {
    const { app } = await makeApp();
    try {
      const models = await app.inject({ method: "GET", url: "/api/models" });
      expect(models.statusCode).toBe(200);
      const body = models.json() as {
        models: Array<{ modelId: string }>;
        gatewayModels: Array<{ providerId: string; modelId: string }>;
      };
      // legacy list byte-untouched: still 23 catalog models, including old-only ids
      expect(body.models).toHaveLength(23);
      expect(body.models.map((m) => m.modelId)).toContain("grok-4.3");
      expect(body.models.map((m) => m.modelId)).toContain("gpt-4o");
      // new list rides alongside
      expect(body.gatewayModels).toHaveLength(100);
      expect(
        body.gatewayModels.some(
          (m) => m.providerId === "openrouter" && m.modelId === "moonshotai/kimi-k2.6"
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("exposes both provider listings on /api/providers", async () => {
    const { app } = await makeApp();
    try {
      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.statusCode).toBe(200);
      const body = providers.json() as {
        providers: Array<{ id: string; credentials: { configured: boolean } }>;
        gatewayProviders: Array<{ id: string; credentialConfigured: boolean }>;
      };
      expect(body.providers).toHaveLength(6);
      expect(body.providers.every((p) => p.credentials.configured === false)).toBe(true);
      expect(body.gatewayProviders).toHaveLength(14);
      expect(body.gatewayProviders.map((p) => p.id)).toContain("openrouter");
      expect(body.gatewayProviders.every((p) => p.credentialConfigured === false)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api.test.ts`
Expected: the two new tests FAIL (`gatewayModels`/`gatewayProviders` undefined); everything else PASSES.

- [ ] **Step 3: Implement the proxies in `src/api/server.ts`**

Extend the gateway import added in Task 3:

```ts
import { createGatewayHandler, type GatewayHandlerOptions, type ModelSummary } from "@waifucave/gateway";
```

Below the `app.register(gatewayPlugin, ...)` line from Task 3, add:

```ts
  // Registry proxies (§7.4): /api/models and /api/providers carry the gateway
  // listings as additive sibling fields. A second handler instance (the plugin
  // builds its own internally) serves the exact public /v1 shapes; both
  // endpoints are static-registry GETs, so a non-200 is a gateway defect → 500.
  const llmProxy = createGatewayHandler(llmGatewayOptions);
  async function llmRegistryJson(path: "/v1/models" | "/v1/providers"): Promise<unknown> {
    const response = await llmProxy.handle(new Request(`http://gateway.internal${path}`));
    if (response.status !== 200) {
      throw new Error(`gateway registry endpoint ${path} returned ${response.status}`);
    }
    return response.json();
  }
```

Add this local type next to the other module-level helpers (bottom half of the file):

```ts
type GatewayProviderListing = {
  id: string;
  displayName: string;
  baseUrl: string;
  credentialEnv: string;
  wire: string;
  credentialConfigured: boolean;
};
```

Replace the `/api/models` route:

```ts
  app.get("/api/models", async () => {
    const gatewayList = (await llmRegistryJson("/v1/models")) as { models: ModelSummary[] };
    return { models: listModels(), gatewayModels: gatewayList.models };
  });
```

Replace the `/api/providers` route body (only the data sourcing changes; the legacy mapping is verbatim):

```ts
  app.get("/api/providers", async () => {
    const [credentials, gatewayList] = await Promise.all([
      readProviderCredentials(storage),
      llmRegistryJson("/v1/providers") as Promise<{ providers: GatewayProviderListing[] }>
    ]);
    return {
      revision: credentials.revision,
      updatedAt: credentials.updatedAt,
      providers: listProviders().map((provider) => {
        const saved = credentials.providers[provider.id];
        return {
          ...provider,
          credentials: saved
            ? {
                configured: true,
                label: saved.label,
                updatedAt: saved.updatedAt,
                keyHint: keyHint(saved.apiKey)
              }
            : {
                configured: false
              }
        };
      }),
      gatewayProviders: gatewayList.providers
    };
  });
```

- [ ] **Step 4: Mirror the new fields in `src/frontend/api/types.ts`**

(Manual sync convention — frontend code does not consume these until P5.) Insert above `ProvidersResponse`:

```ts
export type GatewayProviderSummary = {
  id: string;
  displayName: string;
  baseUrl: string;
  credentialEnv: string;
  wire: string;
  credentialConfigured: boolean;
};

export type GatewayModelSummary = {
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
```

Then extend the two response types:

```ts
export type ProvidersResponse = {
  revision: number;
  updatedAt: string;
  providers: ProviderMetadata[];
  gatewayProviders: GatewayProviderSummary[];
};

export type ModelsResponse = {
  models: ModelCapability[];
  gatewayModels: GatewayModelSummary[];
};
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS (Task 3's 6 + these 2, plus all pre-existing — note the pre-existing "serves health, status, providers, and model catalog endpoints" test keeps passing untouched: it only does contains-checks on the legacy fields).

- [ ] **Step 6: Full suite + typecheck (both tsconfigs), then commit**

```bash
npm run typecheck && npx vitest run
git add src/api/server.ts src/frontend/api/types.ts tests/api.test.ts
git commit -m "feat: expose gateway registry listings on /api/models and /api/providers"
```
Expected: typecheck clean (backend + frontend configs); 381 tests green (379 + 2).

---

### Task 5: Publish guard, docs, and final verification

The app publishes betas; a `file:` dep reaching the registry breaks every consumer install. Tiny guard script, wired before test+build in `prepublishOnly`. No vitest test for the guard (deliberate: a test pinning "exit 1" inverts at P6 when the dep moves to a registry version; the verification step below proves it live). Also documents the rebuild-on-change workflow where future sessions will see it (CLAUDE.md), and prepares the backend dist per house rules.

**Files:**
- Create: `scripts/check-no-file-deps.mjs`
- Modify: `package.json` (`prepublishOnly` only)
- Modify: `CLAUDE.md` (new section)

- [ ] **Step 1: Create `scripts/check-no-file-deps.mjs`**

```js
#!/usr/bin/env node
// Blocks publishing while any dependency is a file: spec — a published file:
// dep is unresolvable for consumers. P6 swaps @waifucave/gateway to a pinned
// registry version (MIGRATION_PLAN §8), after which this passes again.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const offenders = Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter(
  ([, spec]) => typeof spec === "string" && spec.startsWith("file:")
);
if (offenders.length > 0) {
  console.error(
    `Refusing to publish with file: dependencies: ${offenders
      .map(([name, spec]) => `${name}@${spec}`)
      .join(", ")}`
  );
  console.error("Swap to a pinned registry version (MIGRATION_PLAN §8 P6) before publishing.");
  process.exit(1);
}
```

- [ ] **Step 2: Wire it into `prepublishOnly` in `package.json`**

```json
    "prepublishOnly": "node ./scripts/check-no-file-deps.mjs && npm run test && npm run build",
```

- [ ] **Step 3: Verify the guard fires right now**

```bash
node ./scripts/check-no-file-deps.mjs; echo "EXIT: $?"
```

Expected: the two error lines naming `@waifucave/gateway@file:../waifucave-gateway`, then `EXIT: 1`.

- [ ] **Step 4: Document the dep workflow in `CLAUDE.md`**

Append this section after `## Conventions`:

```markdown
## Gateway dependency (migration window, P2–P5)

- `@waifucave/gateway` is consumed as `file:../waifucave-gateway` (npm symlink). The sibling repo must be cloned **and built** — the package resolves from its `dist/`, so a missing/stale build breaks `src/api/server.ts` imports and every test that touches the API server.
- After changing gateway source: run `npm run build` in `../waifucave-gateway`. Nothing to re-run here (symlink); restart `waifus`/vitest to pick it up.
- The gateway HTTP API is mounted at `/api/llm/*` (`src/api/server.ts`); provider keys are read live per request from `user/providers.json` by `src/api/llmGatewayCredentials.ts` — the gateway never stores keys. `/api/models` and `/api/providers` carry the gateway registry as additive `gatewayModels`/`gatewayProviders` fields; the legacy fields still come from `src/providers/catalog.ts` and all chat traffic still goes through `src/providers/pipelines.ts` (until P3).
- Publishing is blocked while the `file:` dep exists (`scripts/check-no-file-deps.mjs` in `prepublishOnly`); P6 swaps to a pinned registry version.
```

- [ ] **Step 5: Build the backend dist (house rule after backend changes) and run everything**

```bash
npm run build:backend
npm run typecheck && npx vitest run
```

Expected: build clean (dist/ now contains `dist/api/llmGatewayCredentials.js` and the updated `dist/api/server.js`); typecheck clean; 381 tests green.

- [ ] **Step 6: Commit (stage only these three files)**

```bash
git add scripts/check-no-file-deps.mjs package.json CLAUDE.md
git commit -m "chore: block publishing with file: deps; document gateway dep workflow"
```

---

## Final integration review checklist (controller, after all tasks)

1. Independently re-run: `npm run typecheck && npx vitest run` (381 green) and `npm run build:backend`.
2. Probe the mount through a real built server if cheap (optional): `node -e` against `dist/` or rely on inject coverage — the exit criteria are pinned by tests: `/api/llm/v1/models` (100), `/api/models` (23 + 100), `/api/providers` (6 + 14), chat 401/credential-flow goldens.
3. Confirm NO diffs under `src/providers/`, `src/orchestration/`, `src/shared/schemas/` (review the 5 commits' file lists).
4. Confirm the gateway repo has zero new commits/dirty files (`git -C ../waifucave-gateway status --short` empty).
5. Update `MIGRATION_PLAN.md` §8 P2 row to `✅ done 2026-06-11` with a pointer to this plan's execution record; append the execution record to this document; commit as `docs: record gateway P2 execution outcome`.
6. Do NOT push — ask the user before pushing the app repo (standing rule).

## Subagent execution notes

- Include the FULL task text in every subagent prompt; two-stage review per task (spec compliance, then code quality); independently verify every implementer report (run the tests yourself — a P1a subagent once fabricated a report); fix-first findings get fixed before moving on.
- Test-count expectations (369 → 373 → 379 → 381) assume no concurrent landings; the prompting-overhaul workstream commits to this repo. If counts drift, verify the listed behaviors are present instead of trusting numbers, and check `git log` for what landed.
- The goldens in Tasks 3–4 are P1c-pinned against gateway `27b0def`. If one mismatches, print the live response: registry data is authoritative — fix the expectation, never the data, and record the drift in your report.

---

## Execution record (2026-06-12)

**P2 COMPLETE and signed off** — 5 implementation commits on app-repo `main` (`fa87860` → `7ba5444`), **382 tests green** (was 369), both tsconfigs + `build:backend` clean, gateway repo untouched at `27b0def`, zero diffs under `src/providers/`/`src/orchestration/`/`src/shared/schemas/`. Exit criteria pinned by tests: `/api/llm/v1/models` serves all 100 registry routes through the mount; `/api/models` carries 23 legacy + 100 gateway models; `/api/providers` carries 6 legacy + 14 gateway providers; chat traffic untouched (pipelines/runtime tests unchanged and green). Executed subagent-driven with two-stage review per task; every implementer report verified independently (no fabrications; all five reported accurately). Not all P1c goldens needed adjustment — zero drift against `27b0def`.

Reviewer-driven deviations from this plan (all folded into the task commits):

- **Task 2 (quality):** lookup uses the dedicated `userDataPath` helper instead of `resolveDataPath(dataRoot, "user", ...)`; added a 5th test pinning that `__proto__`/`constructor`/`toString` lookups don't resolve prototype-chain properties as credentials (verified harmless by review, now regression-pinned). Suite totals shifted +1 vs the plan (374/380/382).
- **Task 4 (quality):** `GatewayProviderListing` is now `ProviderDef & { credentialConfigured: boolean }` reusing the gateway's exported type (was a hand-redeclared 6-field type); `llmRegistryJson`'s parameter renamed `path` → `endpoint` (shadowed the `node:path` module import); the providers-proxy test now also pins credential LIVENESS through `/api/providers`' `gatewayProviders` (PUT key → `credentialConfigured: true` on the proxy's own handler instance, not just the plugin's).
- **Task 5 (quality, Important — the one real catch):** the plan wired the publish guard only into `prepublishOnly`, but the repo's actual release path (`release:beta` → `validateAndPack` `npm pack` → workflow `npm publish <tarball>`, `.github/workflows/npm-root-package.yml:73`) never runs `prepublishOnly` — `npm pack` triggers prepack/prepare only, and publishing a pre-built tarball runs no lifecycle scripts. Fixed: `scripts/release.mjs` `validateAndPack()` now invokes the guard first (its `run()` throws on exit 1), with `prepublishOnly` kept as the manual-publish backstop; CLAUDE.md corrected to match. Re-review verified cwd/ordering/throw semantics.
- **Final integration review (SHIP):** guard spread extended with `...pkg.peerDependencies` (blind-spot completeness; folded into the docs commit).

### Post-P2 live smoke addendum (2026-06-12)

First live traffic through the mount (local keys: deepseek, xai) found and fixed **two real gateway bugs** — exactly what the smoke was for. Both fixed TDD in the gateway repo (`2639986`, `577b14d`, `6259b28` — 230 tests green, dist rebuilt; unpushed pending review):

1. **Fastify plugin self-aborted every real chat POST** (499 "client aborted the request" in ~2ms). Root cause: disconnect detection listened on `request.raw` — Node ≥16 fires IncomingMessage `'close'` when the request *message* is consumed (every parsed body), not on disconnect. Fixed to `reply.raw` (ServerResponse) + the existing `writableEnded` guard, matching `node.ts`'s already-correct pattern. Escaped P1c because `inject()` can't reproduce real socket close timing and the live probes were instant-response cases; two real-socket regression tests added (slow upstream → 200; true client abort → upstream signal aborted).
2. **`maxOutputTokens` was un-settable on 21 routes** ("must be in [-inf, 0]"). Two stacked causes: the validator enforced ranges unconditionally, deviating from MIGRATION_PLAN §4.2 ("unverified params … skip enforcement"), and P0 research placeholders (`max: 0`) survived into the registry — 6 of them wrongly marked `verified`. Fixed: validator skips range/enum/maxItems for `unverified` descriptors (type checks stay); Sonnet 4.5's native cap filled with its documented 64000 (sibling docs + its own OpenRouter route override corroborate); Gemma caps flipped to `unverified` per P0 findings.md. Post-fix sweep: 0 of 100 routes reject a sane cap.

Smoke outcome: full pipeline verified live — stored key → sync lookup → plugin → codec wire body → real provider → error taxonomy → HTTP envelope. Initially blocked at the provider boundary by dead local keys (invalid DeepSeek key; xAI team out of credits — the 401/403 mapped correctly through the taxonomy). Registry GETs, `/api/models` (23+100), `/api/providers` (6+14), and live credentialConfigured flips all verified against the running server.

**Tool smoke (2026-06-12, after the gateway push):** live tool-call + full round-trip (toolCall → `role:"tool"` result → grounded final answer) verified on all four keyed providers through the mount — including DeepSeek with thinking riding along the replay, and **Anthropic thinking+tools with the reasoning-signature round-trip** (the §9 "most intricate codec path") accepted live. DeepSeek's `thinking-no-forced-tools` constraint fired pre-flight on `toolChoice: required`. One more registry data error found and fixed (gateway `c279736`, 231 tests, pushed): all google docs claimed toolChoice `[auto, none]` (verified) while the codec fully implements required/named — live probes (`mode: ANY` ± `allowedFunctionNames`) forced calls on 4 Gemini + 2 Gemma models, those six docs now carry all four modes; gemini-2.5-pro probed and deliberately left conservative (accepts ANY, doesn't force); gemini-3.1-pro unprobed (price bar); OpenRouter routes share the family cells unprobed (RouteOverrides can't scope tool features — possible P6 registry-engine extension). Bonus confirmation: `gemini-2.0-flash` now 404s upstream, exactly as its doc's recorded June 1 2026 shutdown predicted — catalog removal is a user decision for P4/P6. **Capability battery (2026-06-12, completing the live coverage):** all remaining surfaces tested live through the mount, targeted by the registry's own capability flags. Structured outputs: `json_object` valid JSON on deepseek/openai/google (3/3); `json_schema` schema-conforming output on openai/google (2/2); both unsupported combos 400'd pre-flight from the validator. Vision: a programmatically generated 16×16 red PNG identified as \"Red\" on anthropic/openai/google — three distinct image wire encodings (3/3). Parallel tool calls: deepseek/anthropic/google each emitted both `get_weather` calls in one turn and grounded BOTH injected results through the multi-result round trip (3/3). Streaming tool calls: deepseek (10 `tool-call-delta` frames interleaved with reasoning deltas) and google both aggregated to a complete final `toolCall` with id, `finishReason: tool_calls` (2/2). Zero new bugs this round. One known gap recorded (not a bug): the anthropic-messages codec deliberately defers `responseFormat` (clean 400 \"use tools for structured output\") while the registry truthfully says Haiku/Sonnet support `json_schema` upstream — P1b deferral; P5's UI must not offer the toggle for anthropic routes until the codec implements `output_config.format`, and P3 is unaffected (orchestration uses tools).

**Smoke COMPLETED with fresh keys (2026-06-12, same day):** the user supplied working keys; deepseek/anthropic/openai/google-ai-studio stored via `PUT /api/providers/...` (picked up live, no restart). Four real 200 completions through `/api/llm/v1/chat` — `deepseek-v4-flash` (thinking default-on live: 44 reasoning tokens + `param_dropped` temperature/topP from the constraint engine against the real API), `claude-haiku-4-5-20251001`, `gpt-5.4-nano`, `gemini-2.5-flash-lite` — every one returned the exact requested marker text. Real SSE streaming through the mount verified (`deepseek-v4-flash`: 39 reasoning-delta + 7 text-delta frames, usage, done, `[DONE]` — multi-second stream, i.e. the pre-fix 499 case). OpenRouter key verified in-process via the gateway library (`openrouter:deepseek/deepseek-v4-flash` → 200); it cannot be STORED until P4 widens `ProviderIdSchema`. xAI remains credit-blocked account-side. **P2 exit criteria now proven against live providers, not just goldens.**

**P3 / follow-up carryovers (from reviews, non-blocking):**
1. Dual registry load at startup: the plugin builds its own handler and the proxies build a second (`createGatewayHandler` ×2 → `Registry.load()` ×2). Conscious P2 trade; when P3 routes real chat through the gateway, consider one shared instance (e.g., a gateway option to pass a pre-built handler to the plugin).
2. Deep-equal goldens + hardcoded counts (100/14/23/6) in `tests/api.test.ts` break on every gateway registry change — accepted house tradeoff (data drift SHOULD draw eyes), noted so the breakage is unsurprising.
3. `file:` symlink fragility: P3's runtime dependence on the gateway raises the cost of a stale `../waifucave-gateway/dist` — workflow documented in CLAUDE.md.
4. P1c carryovers #1 (codec TypeErrors → 500s through the mount for malformed message elements), #2 (bare-prefix+query 404), #3 (499 reuses kind "network"), #6 (sync list-endpoint shapes not live-verified) remain open, unchanged by P2.
5. In P2 only the 6 legacy provider ids can hold stored keys (`ProviderIdSchema` frozen until P4), so `/api/llm/v1/chat` is live-usable for those 6 direct routes; the other 8 gateway providers stay `credentialConfigured: false` until P4.
