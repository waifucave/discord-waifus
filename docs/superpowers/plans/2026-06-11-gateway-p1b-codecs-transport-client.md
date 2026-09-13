# Gateway P1b: Codecs + Transport + Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@waifucave/gateway` able to actually talk to providers: four wire codecs (openai-chat, openai-responses, anthropic-messages, google-generative-language), a fetch+SSE transport with retries/timeouts/abort, and a `createGateway` client exposing `chat`/`stream`/`listModels`/`getCapabilities`/`validate` — with golden wire-body tests pinning every constraint quirk.

**Architecture:** Codecs are pure: `(ResolvedModel, CodecRequest, apiKey) → EncodedRequest` and `(ResolvedModel, payload) → ChatResponse`. **Codecs consume ONLY `ResolvedModel` plus `validateRequest(...).effectiveParams` — never raw capability docs.** Per-model deltas come from param descriptors (`wireName`) and constraint rules in the data; codecs handle structural differences only (message shapes, tool formats, streaming framing, auth headers). The transport is a `fetch` wrapper (retries on 429/5xx with jitter + Retry-After, timeout-to-first-byte, AbortSignal) plus an SSE parser. The client composes registry → validation (gating on `ok` — P1a carryover #5) → codec → transport.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Node ≥ 20, Vitest. Zero runtime dependencies (zod stays dev-only and, after Task 1, out of `src/` entirely).

**Repo location:** `/Users/example/Xcode projects/waifucave-gateway`. All commands run from there. Committing directly to `main` is the agreed workflow.

**Context docs:** `Discord Waifus/MIGRATION_PLAN.md` (§4.4–4.5 codecs, unified request/response, streaming, error taxonomy; §4.8 testing), `Discord Waifus/docs/superpowers/plans/2026-06-10-gateway-p1a-registry-validation.md` (execution record lists the 5 P1b carryover items — all are implemented by this plan: #1 `buildUrl` Google seam → Task 4; #2 `schema.js` tarball carve-out → Task 1; #3 pseudo-param force/drop/clamp guard → Task 1; #4 export `ParamType`/`Confidence` → Task 1; #5 client gates on `ok` → Task 9).

---

## Hard rules

1. **Codecs never read raw docs.** Their only inputs are `ResolvedModel` and `effectiveParams` from `validateRequest`. Golden tests must build `effectiveParams` through the real `Registry` + `validateRequest`, not hand-rolled objects (except where a test explicitly unit-tests codec behavior the validator currently forbids — those are marked).
2. **No provider SDKs, no new runtime deps.**
3. **`data/` is authoritative.** If a golden expectation conflicts with what the registry produces, print the data and fix the *test expectation* — never silently edit data. Data edits need a stated reason in the commit message.
4. **Do not loosen P1a behavior** (validator, loader, constraint engine) to make a codec test pass. If a genuine P1a bug is found, fix it with its own test and commit.

## Verified data facts this plan is written against

Audited 2026-06-11 against the live registry (`Registry.load()` + `validateRequest`), so the golden bodies below are exact:

- All 53 OpenRouter routes carry `supportedParameters`; the loader filters params but keeps **native** wireNames in descriptors. Therefore the openai-chat codec needs an explicit OpenRouter dialect table (canonical name → OpenRouter wire name; `reasoning.*` → OpenRouter's normalized `reasoning` object with `budgetTokens` → `reasoning.max_tokens`).
- `reasoning.enabled` wireNames in data: `thinking.type` (19 docs: DeepSeek, Anthropic, Z.AI, MiniMax, Moonshot) — wire value is the **string** `"enabled"`/`"disabled"`; and `enable_thinking` (2 docs: Qwen) — wire value stays boolean. The `thinking.type` boolean→string transform is the only wire-value transform in P1b.
- DeepSeek v4 native, `params: { temperature: 0.7, "reasoning.enabled": true }` → `validateRequest` returns `ok: true`, `effectiveParams = { "reasoning.enabled": true, "reasoning.effort": "high" }`, warnings `temperature:dropped`, `topP:dropped` (defaults merged then dropped by `thinking-drops-sampling`).
- DeepSeek v4 native, `{ temperature: 0.7, "reasoning.enabled": false }` → `effectiveParams = { temperature: 0.7, topP: 1, "reasoning.enabled": false, "reasoning.effort": "high" }`.
- Anthropic `claude-fable-5` native, `{ "reasoning.enabled": true, "reasoning.budgetTokens": 1500, maxOutputTokens: 2048 }` → `effectiveParams` additionally contains `reasoningRoundTrip: true` (forced by `thinking-signature-round-trip`). `reasoningRoundTrip` is a **directive**, not a wire param — codecs must skip it.
- OpenRouter `anthropic/claude-fable-5` surviving params: `maxOutputTokens`, `reasoning.enabled`, `reasoning.budgetTokens`, `reasoning.exclude`.
- OpenRouter `deepseek/deepseek-v4-pro` surviving params: `temperature, topP, maxOutputTokens, stopSequences, logprobs, topLogprobs, reasoning.enabled, reasoning.effort`; constraints still apply (same doc).
- Gemini: descriptors use dotted `generationConfig.*` wireNames; `google.safetySettings` → top-level `safetySettings`; `stopSequences` has `maxItems: 5`; resolved `endpoint` is `":generateContent"`, so `baseUrl + endpoint` is NOT a URL (carryover #1). `gemini-2.5-flash`'s `reasoning.effort` has `values: []` (rejects every value — use `reasoning.budgetTokens` there; `gemini-3-flash-preview` has real effort values `minimal/low/medium/high`).
- OpenAI gpt-5.x: only `maxOutputTokens` (`max_output_tokens`), `reasoning.effort` (`reasoning.effort`), `verbosity` (`text.verbosity`), `responseFormat` (`text.format`) — no temperature (unknown-param rejection already pinned in P1a).
- Native route overrides set `endpoint` explicitly (`/chat/completions`, `/v1/messages`); deepseek baseUrl `https://api.deepseek.com` (no `/v1`).

## Known data gaps — explicitly OUT of P1b scope (flag, don't fix)

These are registry-data refinements, not codec work. Listed so reviewers don't mistake them for plan bugs:

1. Anthropic adaptive thinking (Sonnet 4.6 / Opus 4.7 use `thinking: {type:"adaptive"}` + `output_config.effort` in the current app's `pipelines.ts`) is not representable: data only has boolean `reasoning.enabled` → `enabled`/`disabled`. Needs a `wireValues` descriptor extension or per-model data, in a later data pass.
2. Anthropic thinking×sampling (live API forces `temperature: 1` under thinking in the current app) has no constraint rule in data.
3. DeepSeek `reasoning.effort` default `"high"` merges in even when thinking is disabled, so `reasoning_effort` rides along with `thinking: {type:"disabled"}` (pinned as-is in goldens).
4. Anthropic `reasoning.exclude` → wireName `thinking.redacted` is suspicious (no such request field in Anthropic docs) — codec writes what data says.
5. No live probes in P1b; golden tests pin wire bodies against research data. Live smoke happens in P2/P3.

## File structure

```
waifucave-gateway/
├── src/
│   ├── index.ts                        # modify (Tasks 1, 10)
│   ├── errors.ts                       # new — GatewayError + taxonomy (Task 2)
│   ├── client/
│   │   ├── types.ts                    # new — unified ChatRequest/ChatResponse/StreamEvent/Warning (Task 2)
│   │   └── gateway.ts                  # new — createGateway/Gateway (Task 9)
│   ├── codecs/
│   │   ├── types.ts                    # new — Codec interface, CodecRequest, EncodedRequest (Task 4)
│   │   ├── shared.ts                   # new — setPath, pruneUndefined, param mappers, buildUrl, authHeaders (Task 4)
│   │   ├── openaiChat.ts               # new (Task 5)
│   │   ├── openaiResponses.ts          # new (Task 6)
│   │   ├── anthropicMessages.ts        # new (Task 7)
│   │   ├── googleGenerativeLanguage.ts # new (Task 8)
│   │   └── index.ts                    # new — codecFor (Task 9)
│   └── transport/
│       ├── sse.ts                      # new — parseSse, SseEvent (Task 3)
│       └── http.ts                     # new — fetchWithRetry (Task 3)
├── tests/
│   ├── helpers/capabilityDocSchema.ts  # moved from src/registry/schema.ts (Task 1)
│   ├── registry/pseudoParamGuard.test.ts  # new (Task 1)
│   ├── errors.test.ts                  # new (Task 2)
│   ├── transport/{sse,http}.test.ts    # new (Task 3)
│   ├── codecs/{shared,openaiChat,openaiResponses,anthropicMessages,googleGenerativeLanguage}.test.ts
│   └── client/gateway.test.ts          # new (Task 9)
```

Dependency direction: `client/gateway` → `codecs/*` → (`client/types`, `transport/sse` types, `registry/types`, `errors`). `transport` → `errors`. No cycles (`client/types.ts` imports only `errors.ts`).

---

### Task 1: P1a carryovers — tarball carve-out, exports, pseudo-param guard

Carryover #2 (don't ship `dist/registry/schema.js`/zod import in the tarball), #4 (export `ParamType`/`Confidence`), #3 (guard against constraint rules that force/drop/clamp injected pseudo-params, which shadow-restore would silently discard).

**Files:**
- Move: `src/registry/schema.ts` → `tests/helpers/capabilityDocSchema.ts`
- Modify: `tests/registry/schema.test.ts`, `src/index.ts`, `package.json`
- Test: `tests/registry/pseudoParamGuard.test.ts`

- [ ] **Step 1: Confirm nothing in `src/` imports the schema module**

```bash
grep -rn "registry/schema" src tests
```
Expected: exactly one hit — `tests/registry/schema.test.ts` importing `../../src/registry/schema.js`. If anything under `src/` imports it, STOP and report; the move below would break the build.

- [ ] **Step 2: Move the file and fix the test import**

```bash
mkdir -p tests/helpers
git mv src/registry/schema.ts tests/helpers/capabilityDocSchema.ts
```

In `tests/registry/schema.test.ts` change:

```ts
import { CapabilityDocSchema } from "../../src/registry/schema.js";
```
to:
```ts
import { CapabilityDocSchema } from "../helpers/capabilityDocSchema.js";
```

(`tests/helpers/capabilityDocSchema.ts` imports `zod` and types from `../../src/registry/types.js` — adjust its internal import path if it used `./types.js`: it must become `../../src/registry/types.js`.)

- [ ] **Step 3: Make `build` clean `dist/` first** (a stale `dist/registry/schema.js` from earlier builds would otherwise still ship)

In `package.json` change:

```json
"build": "tsc -p tsconfig.json",
```
to:
```json
"build": "rm -rf dist && tsc -p tsconfig.json",
```

- [ ] **Step 4: Export `ParamType`, `Confidence`, `Pricing`, `ToolFeatures` from the package entry**

In `src/index.ts`, extend the type re-export from `./registry/types.js` to include them:

```ts
export type {
  CapabilityDoc,
  Confidence,
  ConstraintAction,
  ConstraintCondition,
  ConstraintRule,
  Features,
  ParamDescriptor,
  ParamType,
  Pricing,
  ProviderDef,
  RegistryDiagnostic,
  ResolvedModel,
  RouteDef,
  RouteOverrides,
  ToolFeatures,
  WireProtocol
} from "./registry/types.js";
```

(`Pricing` and `ToolFeatures` must also be exported from `src/registry/types.ts` already — they are; no change needed there.)

- [ ] **Step 5: Write the pseudo-param guard test `tests/registry/pseudoParamGuard.test.ts`**

`validateRequest` injects `toolChoice`/`responseFormat` as pseudo-params for rule matching and shadow-restores them afterwards — so a data rule that `force`s/`drop`s/`clamp`s them would be silently discarded (P1a carryover #3). No data rule does this today; this test fails loudly if one ever appears, pointing at the engine extension needed.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PSEUDO_PARAMS = ["toolChoice", "responseFormat"];
const dataDir = join(import.meta.dirname, "../../data");

describe("constraint rules vs injected pseudo-params", () => {
  it("no rule force/drop/clamps toolChoice or responseFormat (shadow-restore would discard it)", () => {
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".json"))) {
      for (const doc of JSON.parse(readFileSync(join(dataDir, file), "utf8"))) {
        for (const rule of doc.constraints ?? []) {
          const touched = [
            ...Object.keys(rule.then.force ?? {}),
            ...(rule.then.drop ?? []),
            ...Object.keys(rule.then.clamp ?? {})
          ].filter((p) => PSEUDO_PARAMS.includes(p));
          expect(
            touched,
            `${file}/${doc.family} rule "${rule.id}" force/drop/clamps ${touched.join(", ")} — ` +
              `validateRequest's shadow-restore discards this; extend the pseudo-param handling in validateRequest.ts before shipping this rule`
          ).toEqual([]);
        }
      }
    }
  });
});
```

- [ ] **Step 6: Run the suite and verify the tarball**

```bash
npm run typecheck && npm test && npm run build
npm pack --dry-run 2>&1 | grep -E "schema|zod" ; echo "grep exit: $?"
grep -rn "from \"zod\"" dist ; echo "grep exit: $?"
node -e 'import("./dist/index.js").then((m) => console.log(typeof m.Registry, m.PROVIDERS.length))'
```
Expected: typecheck clean; all suites PASS (33 tests: 32 + the new guard); both greps find nothing (exit 1); node prints `function 14`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: carve schema/zod out of the build; export ParamType/Confidence; guard pseudo-param rules"
```

---

### Task 2: Unified chat types + GatewayError taxonomy

MIGRATION_PLAN §4.5 (unified request/response, streaming events) and the error taxonomy (`auth | rate_limit | quota | invalid_request | unsupported_parameter | content_filter | timeout | server | network`).

**Files:**
- Create: `src/client/types.ts`, `src/errors.ts`
- Test: `tests/errors.test.ts`

- [ ] **Step 1: Write the failing test `tests/errors.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { GatewayError, extractErrorMessage, kindForStatus } from "../src/errors.js";

describe("kindForStatus", () => {
  it("maps statuses to the taxonomy", () => {
    expect(kindForStatus(400)).toBe("invalid_request");
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(402)).toBe("quota");
    expect(kindForStatus(403)).toBe("auth");
    expect(kindForStatus(404)).toBe("invalid_request");
    expect(kindForStatus(408)).toBe("timeout");
    expect(kindForStatus(422)).toBe("invalid_request");
    expect(kindForStatus(429)).toBe("rate_limit");
    expect(kindForStatus(500)).toBe("server");
    expect(kindForStatus(503)).toBe("server");
  });

  it("upgrades 429 to quota when the provider error code says so", () => {
    expect(kindForStatus(429, { error: { code: "insufficient_quota", message: "x" } })).toBe("quota");
    expect(kindForStatus(429, { error: { type: "quota_exceeded", message: "x" } })).toBe("quota");
    expect(kindForStatus(429, { error: { code: "rate_limit_exceeded", message: "x" } })).toBe("rate_limit");
  });
});

describe("extractErrorMessage", () => {
  it("handles OpenAI, Anthropic, and Google error shapes plus plain text", () => {
    expect(extractErrorMessage({ error: { message: "bad key" } })).toBe("bad key");
    expect(extractErrorMessage({ error: { type: "invalid_request_error", message: "no model" } })).toBe("no model");
    expect(extractErrorMessage({ error: { code: 400, message: "stop limit", status: "INVALID_ARGUMENT" } })).toBe("stop limit");
    expect(extractErrorMessage({ message: "top-level" })).toBe("top-level");
    expect(extractErrorMessage("plain text body")).toBe("plain text body");
    expect(extractErrorMessage("")).toBe("(empty body)");
    expect(extractErrorMessage({ weird: true })).toBe('{"weird":true}');
  });
});

describe("GatewayError", () => {
  it("defaults retryable from kind", () => {
    expect(new GatewayError("rate_limit", "x").retryable).toBe(true);
    expect(new GatewayError("server", "x").retryable).toBe(true);
    expect(new GatewayError("timeout", "x").retryable).toBe(true);
    expect(new GatewayError("network", "x").retryable).toBe(true);
    expect(new GatewayError("auth", "x").retryable).toBe(false);
    expect(new GatewayError("invalid_request", "x").retryable).toBe(false);
    expect(new GatewayError("unsupported_parameter", "x", { retryable: true }).retryable).toBe(true);
  });

  it("fromHttp carries provider, status, raw and an extracted message", () => {
    const error = GatewayError.fromHttp("deepseek", 429, { error: { message: "slow down" } });
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("rate_limit");
    expect(error.provider).toBe("deepseek");
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.raw).toEqual({ error: { message: "slow down" } });
    expect(error.message).toBe("deepseek returned HTTP 429: slow down");
    expect(error.name).toBe("GatewayError");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/errors.test.ts
```
Expected: FAIL — cannot resolve `../src/errors.js`.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
export type GatewayErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "invalid_request"
  | "unsupported_parameter"
  | "content_filter"
  | "timeout"
  | "server"
  | "network";

const RETRYABLE_KINDS: ReadonlySet<GatewayErrorKind> = new Set(["rate_limit", "timeout", "server", "network"]);

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly raw?: unknown;

  constructor(
    kind: GatewayErrorKind,
    message: string,
    opts: { provider?: string; status?: number; raw?: unknown; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GatewayError";
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.raw = opts.raw;
    this.retryable = opts.retryable ?? RETRYABLE_KINDS.has(kind);
  }

  static fromHttp(provider: string, status: number, body: unknown): GatewayError {
    return new GatewayError(kindForStatus(status, body), `${provider} returned HTTP ${status}: ${extractErrorMessage(body)}`, {
      provider,
      status,
      raw: body
    });
  }
}

export function kindForStatus(status: number, body?: unknown): GatewayErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 408) return "timeout";
  if (status === 429) return isQuotaError(body) ? "quota" : "rate_limit";
  if (status >= 500) return "server";
  return "invalid_request";
}

function errorField(body: unknown): Record<string, unknown> | undefined {
  if (body !== null && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (e !== null && typeof e === "object") return e as Record<string, unknown>;
  }
  return undefined;
}

function isQuotaError(body: unknown): boolean {
  const e = errorField(body);
  const code = typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : "";
  return code.includes("quota") || code.includes("insufficient");
}

/** Handles OpenAI `{error:{message}}`, Anthropic `{error:{type,message}}`, Google `{error:{code,message,status}}`, top-level `{message}`, and plain text. */
export function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500) || "(empty body)";
  const e = errorField(body);
  if (e && typeof e.message === "string" && e.message !== "") return e.message;
  if (body !== null && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string") {
    return (body as Record<string, string>).message;
  }
  const serialized = JSON.stringify(body);
  return serialized === undefined ? "(no body)" : serialized.slice(0, 500);
}
```

- [ ] **Step 4: Write `src/client/types.ts`** (no test of its own — it is types only; every later task exercises it)

```ts
import type { GatewayError } from "../errors.js";

export type TextBlock = { type: "text"; text: string };

/** `data` is base64-encoded image bytes. */
export type ImageBlock = { type: "image"; mimeType: string; data: string };

/**
 * Opaque reasoning content. `signature` (Anthropic) must round-trip on tool loops;
 * `redacted` + `data` carry Anthropic redacted_thinking blocks.
 */
export type ReasoningBlock = { type: "reasoning"; text: string; signature?: string; redacted?: boolean; data?: string };

/** `arguments` is the raw JSON text of the call arguments (consumers parse it; codecs that need objects parse internally). */
export type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: string };

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<TextBlock | ImageBlock> }
  | { role: "assistant"; content: string | Array<TextBlock | ReasoningBlock | ToolCallBlock> }
  | { role: "tool"; toolCallId: string; content: string };

/** Tools are defined ONCE in JSON Schema; codecs translate per wire. */
export type ToolDef = { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: Record<string, unknown>; strict?: boolean };

export type ChatRequest = {
  provider: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  /** Validated against the capability doc (including provider-scoped dotted keys). */
  params?: Record<string, unknown>;
  /** Merged raw into the wire body, unvalidated; each key emits a warning. */
  passthrough?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export type Warning = {
  code: "param_dropped" | "param_forced" | "param_clamped" | "passthrough" | "unmapped_param";
  param: string;
  ruleId?: string;
  message: string;
};

export type ChatResponse = {
  id: string;
  provider: string;
  model: string;
  content: ContentBlock[];
  finishReason: FinishReason;
  usage: Usage;
  warnings: Warning[];
  /** Original provider payload; attached only when the gateway is created with `includeRaw`. */
  raw?: unknown;
};

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; error: GatewayError };
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npx vitest run tests/errors.test.ts && npm run typecheck
```
Expected: PASS (5 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/client/types.ts tests/errors.test.ts
git commit -m "feat: add unified chat types and GatewayError taxonomy"
```

---

### Task 3: Transport — SSE parser and fetch-with-retry

**Files:**
- Create: `src/transport/sse.ts`, `src/transport/http.ts`
- Test: `tests/transport/sse.test.ts`, `tests/transport/http.test.ts`

- [ ] **Step 1: Write the failing SSE test `tests/transport/sse.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseSse, type SseEvent } from "../../src/transport/sse.js";

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

async function collect(iter: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("parseSse", () => {
  it("parses simple data events", async () => {
    expect(await collect(parseSse(chunks('data: {"a":1}\n\ndata: [DONE]\n\n')))).toEqual([
      { data: '{"a":1}' },
      { data: "[DONE]" }
    ]);
  });

  it("captures event names and joins multi-line data with newlines", async () => {
    expect(await collect(parseSse(chunks("event: message_start\ndata: line1\ndata: line2\n\n")))).toEqual([
      { event: "message_start", data: "line1\nline2" }
    ]);
  });

  it("ignores comment lines and id/retry fields", async () => {
    expect(await collect(parseSse(chunks(": keep-alive\nid: 7\nretry: 100\ndata: x\n\n")))).toEqual([{ data: "x" }]);
  });

  it("handles chunk boundaries mid-line and mid-CRLF", async () => {
    expect(await collect(parseSse(chunks("da", "ta: he", "llo\r", "\n\r\n")))).toEqual([{ data: "hello" }]);
  });

  it("handles CR, LF and CRLF line endings", async () => {
    expect(await collect(parseSse(chunks("data: a\r\rdata: b\r\n\r\ndata: c\n\n")))).toEqual([
      { data: "a" },
      { data: "b" },
      { data: "c" }
    ]);
  });

  it("flushes a trailing event missing the final blank line", async () => {
    expect(await collect(parseSse(chunks("data: tail")))).toEqual([{ data: "tail" }]);
  });

  it("strips only one leading space after the colon", async () => {
    expect(await collect(parseSse(chunks("data:  padded\n\n")))).toEqual([{ data: " padded" }]);
  });

  it("reads from a ReadableStream too", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: rs\n\n"));
        controller.close();
      }
    });
    expect(await collect(parseSse(stream))).toEqual([{ data: "rs" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/transport/sse.test.ts
```
Expected: FAIL — cannot resolve `sse.js`.

- [ ] **Step 3: Write `src/transport/sse.ts`**

```ts
export type SseEvent = { event?: string; data: string };

async function* toByteIterable(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Incremental text/event-stream parser. Handles multi-line `data:` fields,
 * `event:` names, comments, and CR / LF / CRLF line endings split across chunks.
 */
export async function* parseSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  function* flush(): Generator<SseEvent> {
    if (dataLines.length > 0) {
      yield eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
    }
    eventName = undefined;
    dataLines = [];
  }

  function* handleLine(line: string): Generator<SseEvent> {
    if (line === "") {
      yield* flush();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // id and retry are irrelevant for one-shot completion streams
  }

  for await (const chunk of toByteIterable(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) break;
      // a lone CR at the buffer's end may be half of a CRLF split across chunks
      if (match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    for (const line of buffer.split(/\r\n|\n|\r/)) yield* handleLine(line);
  }
  yield* flush();
}
```

- [ ] **Step 4: Run the SSE tests**

```bash
npx vitest run tests/transport/sse.test.ts
```
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing HTTP test `tests/transport/http.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { fetchWithRetry } from "../../src/transport/http.js";

const REQ = { url: "https://api.example.com/chat", headers: { "content-type": "application/json" }, body: { model: "m" } };
const FAST = { maxRetries: 2, retryBaseDelayMs: 1, timeoutMs: 5_000 };

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

describe("fetchWithRetry", () => {
  it("returns the first successful response and sends the JSON body", async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(url).toBe(REQ.url);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ model: "m" });
      return json({ ok: true });
    });
    const response = await fetchWithRetry("deepseek", REQ, { ...FAST, fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 (honoring Retry-After) and 5xx, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: "slow" } }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ error: { message: "boom" } }, 500))
      .mockResolvedValueOnce(json({ ok: true }));
    const response = await fetchWithRetry("deepseek", REQ, { ...FAST, fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws GatewayError rate_limit when retries are exhausted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { message: "slow" } }, 429));
    const error = await fetchWithRetry("deepseek", REQ, { ...FAST, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("rate_limit");
    expect(error.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it("does NOT retry 4xx and extracts the provider message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { message: "bad param" } }, 400));
    const error = await fetchWithRetry("openai", REQ, { ...FAST, fetchImpl }).catch((e) => e);
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toBe("openai returned HTTP 400: bad param");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries network errors, then surfaces GatewayError network", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const error = await fetchWithRetry("xai", REQ, { ...FAST, fetchImpl }).catch((e) => e);
    expect(error.kind).toBe("network");
    expect(error.retryable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("recovers when a network error is followed by success", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({ ok: true }));
    const response = await fetchWithRetry("xai", REQ, { ...FAST, fetchImpl });
    expect(response.status).toBe(200);
  });

  it("aborts with GatewayError timeout when the provider hangs", async () => {
    const fetchImpl = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
        })
    );
    const error = await fetchWithRetry("moonshot", REQ, { fetchImpl, timeoutMs: 20, maxRetries: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("timeout");
  });

  it("propagates the caller's abort as-is (not as timeout)", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("user aborted")));
        })
    );
    setTimeout(() => controller.abort(), 10);
    const error = await fetchWithRetry("zai", REQ, { fetchImpl, timeoutMs: 5_000, signal: controller.signal }).catch((e) => e);
    expect(error).not.toBeInstanceOf(GatewayError);
    expect(error.message).toBe("user aborted");
  });

  it("rejects immediately when called with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const fetchImpl = vi.fn();
    const error = await fetchWithRetry("zai", REQ, { fetchImpl, signal: controller.signal }).catch((e) => e);
    expect(error.message).toBe("pre-aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npx vitest run tests/transport/http.test.ts
```
Expected: FAIL — cannot resolve `http.js`.

- [ ] **Step 7: Write `src/transport/http.ts`**

```ts
import { GatewayError } from "../errors.js";

export type HttpRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

export type HttpOptions = {
  fetchImpl?: typeof fetch;
  /** Time to response HEADERS (not whole stream). Default 120s. */
  timeoutMs?: number;
  /** Retries after the first attempt, on 429/5xx/network errors. Default 2. */
  maxRetries?: number;
  /** Base backoff delay; doubles per attempt, with jitter. Default 500ms (set 1 in tests). */
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, base: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  const exponential = base * 2 ** attempt;
  return Math.min(exponential + Math.random() * exponential, 10_000);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * POST with retries on 429/5xx/network failures. The timeout covers time to
 * response headers only; for streaming, the caller keeps reading the body and
 * the caller's `signal` stays wired to it (we deliberately do not remove the
 * abort listener on the success path).
 */
export async function fetchWithRetry(provider: string, request: HttpRequest, options: HttpOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 2;
  const base = options.retryBaseDelayMs ?? 500;

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error(String(options.signal.reason ?? "aborted"));

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
    } catch (cause) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) throw cause; // user abort wins — propagate untouched
      if (timedOut) throw new GatewayError("timeout", `${provider} did not respond within ${timeoutMs}ms`, { provider, cause });
      if (attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, base));
        continue;
      }
      throw new GatewayError("network", `network error calling ${provider}: ${String(cause)}`, { provider, cause });
    }
    clearTimeout(timer);

    if (response.ok) return response; // keep the user-abort wiring alive for body consumption

    options.signal?.removeEventListener("abort", onAbort);
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      await sleep(retryDelayMs(attempt, base, response));
      continue;
    }
    throw GatewayError.fromHttp(provider, response.status, await parseBody(response));
  }
}
```

- [ ] **Step 8: Run the transport tests and the whole suite**

```bash
npx vitest run tests/transport && npm run typecheck
```
Expected: PASS (8 SSE + 9 HTTP = 17 tests); typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/transport tests/transport
git commit -m "feat: add SSE parser and retrying fetch transport"
```

---

### Task 4: Codec shared infrastructure (incl. `buildUrl` Google seam)

Carryover #1: `baseUrl + endpoint` is not a complete URL for `google-generative-language` — `buildUrl(model, stream)` owns URL assembly for all wires.

**Files:**
- Create: `src/codecs/types.ts`, `src/codecs/shared.ts`
- Test: `tests/codecs/shared.test.ts`

- [ ] **Step 1: Write `src/codecs/types.ts`** (interface only; exercised by every codec task)

```ts
import type { ResolvedModel, WireProtocol } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ResponseFormat, StreamEvent, ToolChoice, ToolDef, Warning } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";

export type CodecRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  /**
   * `validateRequest(...).effectiveParams` — the codec's ONLY parameter source.
   * Callers MUST gate on `ValidationResult.ok` before encoding.
   */
  effectiveParams: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  stream: boolean;
};

export type EncodedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  warnings: Warning[];
};

export interface Codec {
  readonly wire: WireProtocol;
  encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest;
  decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse;
  /** Throws GatewayError on malformed/error frames; ends with a `done` event. */
  decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncIterable<StreamEvent>;
}
```

- [ ] **Step 2: Write the failing test `tests/codecs/shared.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import {
  authHeaders,
  buildUrl,
  mapNativeParams,
  mapOpenRouterParams,
  parseArguments,
  pruneUndefined,
  setPath
} from "../../src/codecs/shared.js";

const registry = Registry.load();

function effective(providerId: string, modelId: string, params: Record<string, unknown>): Record<string, unknown> {
  const model = registry.resolve(providerId, modelId)!;
  const validation = validateRequest(model, { params });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return validation.effectiveParams;
}

describe("setPath", () => {
  it("creates nested objects from dotted paths and merges siblings", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "thinking.type", "enabled");
    setPath(target, "thinking.budget_tokens", 1500);
    setPath(target, "temperature", 0.5);
    expect(target).toEqual({ thinking: { type: "enabled", budget_tokens: 1500 }, temperature: 0.5 });
  });

  it("replaces non-object intermediates instead of crashing", () => {
    const target: Record<string, unknown> = { a: 3 };
    setPath(target, "a.b", 1);
    expect(target).toEqual({ a: { b: 1 } });
  });
});

describe("pruneUndefined", () => {
  it("removes undefined keys deeply without mutating the input", () => {
    const input = { a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [{ g: undefined, h: 3 }] };
    const out = pruneUndefined(input);
    expect(out).toEqual({ a: 1, c: { e: 2 }, f: [{ h: 3 }] });
    expect(Object.keys(input.c)).toContain("d"); // input untouched
  });
});

describe("mapNativeParams", () => {
  it("maps deepseek thinking via the thinking.type string transform", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const mapped = mapNativeParams(model, effective("deepseek", "deepseek-v4-pro", { temperature: 0.7, "reasoning.enabled": true }));
    expect(mapped.wire).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(mapped.warnings).toEqual([]);
  });

  it("maps reasoning.enabled=false to thinking.type disabled, keeping sampling", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const mapped = mapNativeParams(model, effective("deepseek", "deepseek-v4-pro", { temperature: 0.7, "reasoning.enabled": false }));
    expect(mapped.wire).toEqual({ temperature: 0.7, top_p: 1, thinking: { type: "disabled" }, reasoning_effort: "high" });
  });

  it("keeps qwen enable_thinking a plain boolean (transform is scoped to thinking.type)", () => {
    const model = registry.resolve("qwen", "qwen3.6-flash")!;
    const mapped = mapNativeParams(model, effective("qwen", "qwen3.6-flash", { "reasoning.enabled": true }));
    expect(mapped.wire).toEqual({ enable_thinking: true });
  });

  it("maps gemini dotted generationConfig wireNames and top-level safetySettings", () => {
    const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;
    const mapped = mapNativeParams(
      model,
      effective("google-ai-studio", "gemini-2.5-flash", { temperature: 1.2, "reasoning.budgetTokens": 1024, "google.safetySettings": { x: 1 } })
    );
    expect(mapped.wire).toEqual({
      generationConfig: { temperature: 1.2, thinkingConfig: { thinkingBudget: 1024 } },
      safetySettings: { x: 1 }
    });
  });

  it("skips the reasoningRoundTrip directive and warns on unknown params", () => {
    const model = registry.resolve("anthropic", "claude-fable-5")!;
    const mapped = mapNativeParams(model, { reasoningRoundTrip: true, bogus: 1, "reasoning.budgetTokens": 1500 });
    expect(mapped.wire).toEqual({ thinking: { budget_tokens: 1500 } });
    expect(mapped.warnings).toEqual([
      { code: "unmapped_param", param: "bogus", message: "bogus has no descriptor on anthropic:claude-fable-5; not sent" }
    ]);
  });
});

describe("mapOpenRouterParams", () => {
  it("maps reasoning.* onto OpenRouter's normalized reasoning object", () => {
    const model = registry.resolve("openrouter", "anthropic/claude-fable-5")!;
    const mapped = mapOpenRouterParams(
      model,
      effective("openrouter", "anthropic/claude-fable-5", { "reasoning.enabled": true, "reasoning.budgetTokens": 2000 })
    );
    expect(mapped.wire).toEqual({ reasoning: { enabled: true, max_tokens: 2000 } });
    expect(mapped.warnings).toEqual([]);
  });

  it("uses OpenAI-standard names, never native wireNames", () => {
    const model = registry.resolve("openrouter", "deepseek/deepseek-v4-pro")!;
    const mapped = mapOpenRouterParams(
      model,
      effective("openrouter", "deepseek/deepseek-v4-pro", { temperature: 0.7, "reasoning.enabled": false, maxOutputTokens: 100, stopSequences: ["x"] })
    );
    expect(mapped.wire).toEqual({
      temperature: 0.7,
      top_p: 1,
      max_tokens: 100,
      stop: ["x"],
      reasoning: { enabled: false, effort: "high" }
    });
  });

  it("warns and skips params with no OpenRouter mapping", () => {
    const model = registry.resolve("openrouter", "deepseek/deepseek-v4-pro")!;
    const mapped = mapOpenRouterParams(model, { "google.safetySettings": { x: 1 } });
    expect(mapped.wire).toEqual({});
    expect(mapped.warnings).toHaveLength(1);
    expect(mapped.warnings[0]).toMatchObject({ code: "unmapped_param", param: "google.safetySettings" });
  });
});

describe("buildUrl (carryover #1: google seam)", () => {
  it("builds google generate/stream URLs with the model id in the path", () => {
    const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;
    expect(buildUrl(model, false)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(buildUrl(model, true)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
  });

  it("concatenates baseUrl + endpoint for the other wires", () => {
    expect(buildUrl(registry.resolve("deepseek", "deepseek-v4-pro")!, false)).toBe("https://api.deepseek.com/chat/completions");
    expect(buildUrl(registry.resolve("anthropic", "claude-fable-5")!, true)).toBe("https://api.anthropic.com/v1/messages");
    expect(buildUrl(registry.resolve("openai", "gpt-5.5")!, false)).toBe("https://api.openai.com/v1/responses");
    expect(buildUrl(registry.resolve("openrouter", "deepseek/deepseek-v4-pro")!, false)).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("authHeaders", () => {
  it("emits per-wire auth headers", () => {
    expect(authHeaders(registry.resolve("deepseek", "deepseek-v4-pro")!, "K")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer K"
    });
    expect(authHeaders(registry.resolve("anthropic", "claude-fable-5")!, "K")).toEqual({
      "content-type": "application/json",
      "x-api-key": "K",
      "anthropic-version": "2023-06-01"
    });
    expect(authHeaders(registry.resolve("google-ai-studio", "gemini-2.5-flash")!, "K")).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "K"
    });
  });
});

describe("parseArguments", () => {
  it("parses JSON objects, treats empty as {}, rejects non-objects", () => {
    expect(parseArguments("p", "f", '{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("p", "f", "")).toEqual({});
    expect(() => parseArguments("p", "f", "not json")).toThrow(GatewayError);
    expect(() => parseArguments("p", "f", "[1,2]")).toThrow(GatewayError);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run tests/codecs/shared.test.ts
```
Expected: FAIL — cannot resolve `shared.js`.

- [ ] **Step 4: Write `src/codecs/shared.ts`**

```ts
import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { Warning } from "../client/types.js";

/** Write a dotted wire path ("thinking.budget_tokens") as nested objects, merging siblings. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (next === null || next === undefined || typeof next !== "object" || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** Deep-copy dropping undefined values; never mutates input (bodies may reference caller objects). */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => pruneUndefined(entry)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = pruneUndefined(entry);
    }
    return out as T;
  }
  return value;
}

/** effectiveParams keys that are validation directives, not wire params. */
const DIRECTIVE_PARAMS = new Set(["reasoningRoundTrip"]);

/** `thinking.type` carries "enabled"/"disabled" strings on the wire; the unified param is boolean. */
function wireValue(wireName: string, value: unknown): unknown {
  if (wireName === "thinking.type" && typeof value === "boolean") return value ? "enabled" : "disabled";
  return value;
}

export type MappedParams = { wire: Record<string, unknown>; warnings: Warning[] };

/** Map effectiveParams onto the wire body using each descriptor's native wireName. */
export function mapNativeParams(model: ResolvedModel, effectiveParams: Record<string, unknown>): MappedParams {
  const wire: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const [name, value] of Object.entries(effectiveParams)) {
    if (value === undefined || DIRECTIVE_PARAMS.has(name)) continue;
    const descriptor = model.params[name];
    if (!descriptor) {
      warnings.push({ code: "unmapped_param", param: name, message: `${name} has no descriptor on ${model.providerId}:${model.modelId}; not sent` });
      continue;
    }
    const wireName = descriptor.wireName ?? name;
    setPath(wire, wireName, wireValue(wireName, value));
  }
  return { wire, warnings };
}

/**
 * OpenRouter normalizes parameters across hosts, but descriptors keep NATIVE
 * wireNames (e.g. generationConfig.temperature on a Gemini doc). OpenRouter
 * routes therefore map canonical names through this table instead.
 * reasoning.* nests into OpenRouter's normalized `reasoning` object.
 */
export const OPENROUTER_WIRE_NAMES: Record<string, string> = {
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  minP: "min_p",
  topA: "top_a",
  frequencyPenalty: "frequency_penalty",
  presencePenalty: "presence_penalty",
  repetitionPenalty: "repetition_penalty",
  logitBias: "logit_bias",
  seed: "seed",
  logprobs: "logprobs",
  topLogprobs: "top_logprobs",
  maxOutputTokens: "max_tokens",
  stopSequences: "stop",
  n: "n",
  verbosity: "verbosity",
  "reasoning.enabled": "reasoning.enabled",
  "reasoning.effort": "reasoning.effort",
  "reasoning.budgetTokens": "reasoning.max_tokens",
  "reasoning.exclude": "reasoning.exclude"
};

export function mapOpenRouterParams(model: ResolvedModel, effectiveParams: Record<string, unknown>): MappedParams {
  const wire: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const [name, value] of Object.entries(effectiveParams)) {
    if (value === undefined || DIRECTIVE_PARAMS.has(name)) continue;
    const wireName = OPENROUTER_WIRE_NAMES[name];
    if (wireName === undefined) {
      warnings.push({ code: "unmapped_param", param: name, message: `${name} has no OpenRouter mapping; not sent` });
      continue;
    }
    setPath(wire, wireName, value);
  }
  return { wire, warnings };
}

/**
 * P1a carryover #1: for google-generative-language the model id and :method live
 * in the URL path and streaming switches the method — baseUrl+endpoint alone is
 * not a URL. All codecs build URLs through here.
 */
export function buildUrl(model: ResolvedModel, stream: boolean): string {
  if (model.wire === "google-generative-language") {
    const method = stream ? ":streamGenerateContent?alt=sse" : model.endpoint.startsWith(":") ? model.endpoint : ":generateContent";
    return `${model.baseUrl}/v1beta/models/${model.modelId}${method}`;
  }
  return `${model.baseUrl}${model.endpoint}`;
}

export function authHeaders(model: ResolvedModel, apiKey: string): Record<string, string> {
  switch (model.wire) {
    case "anthropic-messages":
      return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "google-generative-language":
      return { "content-type": "application/json", "x-goog-api-key": apiKey };
    default:
      return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  }
}

/** Tool-call arguments travel as JSON text in the unified shape; some wires need the parsed object. */
export function parseArguments(provider: string, toolName: string, argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.trim() === "") return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the error below
  }
  throw new GatewayError("invalid_request", `tool call "${toolName}" has non-object JSON arguments`, { provider });
}

/** Merge raw passthrough keys into the body, warning per key (MIGRATION_PLAN §4.5). */
export function applyPassthrough(body: Record<string, unknown>, passthrough: Record<string, unknown> | undefined, warnings: Warning[]): void {
  for (const [key, value] of Object.entries(passthrough ?? {})) {
    body[key] = value;
    warnings.push({ code: "passthrough", param: key, message: `${key} sent unvalidated via passthrough` });
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/codecs/shared.test.ts && npm run typecheck
```
Expected: PASS (15 tests); typecheck clean. If a `mapped.wire` assertion fails, print what the registry actually produced (the test failure shows it) and re-check against "Verified data facts" above before touching anything — the mechanism under test is mapping, not the data values.

- [ ] **Step 6: Commit**

```bash
git add src/codecs tests/codecs/shared.test.ts
git commit -m "feat: add codec shared helpers (param mapping, buildUrl, auth headers)"
```

---

### Task 5: openai-chat codec (native + OpenRouter dialects)

Serves 11 native providers + all OpenRouter routes. Golden tests pin the live-validated DeepSeek quirks.

**Files:**
- Create: `src/codecs/openaiChat.ts`
- Test: `tests/codecs/openaiChat.test.ts`

- [ ] **Step 1: Write the failing test `tests/codecs/openaiChat.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { openaiChatCodec } from "../../src/codecs/openaiChat.js";
import type { CodecRequest } from "../../src/codecs/types.js";
import type { ChatMessage } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";
import type { StreamEvent } from "../../src/client/types.js";

const registry = Registry.load();

type GoldenInput = Partial<Omit<CodecRequest, "effectiveParams">> & { params?: Record<string, unknown> };

function goldenEncode(providerId: string, modelId: string, input: GoldenInput) {
  const model = registry.resolve(providerId, modelId)!;
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    responseFormat: input.responseFormat?.type,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return openaiChatCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
      passthrough: input.passthrough,
      effectiveParams: validation.effectiveParams,
      stream: input.stream ?? false
    },
    "TEST_KEY"
  );
}

async function* sse(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const event of events) yield event;
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("openai-chat encode — DeepSeek thinking quirks (live-validated 2026-06-10)", () => {
  it("GOLDEN: thinking drops sampling — no temperature/top_p on the wire", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-pro", {
      params: { temperature: 0.7, "reasoning.enabled": true },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.url).toBe("https://api.deepseek.com/chat/completions");
    expect(encoded.headers).toEqual({ "content-type": "application/json", authorization: "Bearer TEST_KEY" });
  });

  it("GOLDEN: thinking disabled keeps sampling", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { temperature: 0.7, "reasoning.enabled": false }
    });
    expect(encoded.body).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.7,
      top_p: 1,
      thinking: { type: "disabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });
  });

  it("forced tool choice under default-on thinking is rejected upstream by validation (codec never sees it)", () => {
    const model = registry.resolve("deepseek", "deepseek-v4-pro")!;
    const validation = validateRequest(model, { params: {}, toolChoice: "required" });
    expect(validation.ok).toBe(false);
  });
});

describe("openai-chat encode — OpenRouter dialect", () => {
  it("GOLDEN: deepseek via OpenRouter uses the normalized reasoning object", () => {
    const encoded = goldenEncode("openrouter", "deepseek/deepseek-v4-pro", {
      params: { temperature: 0.7, "reasoning.enabled": true }
    });
    expect(encoded.body).toEqual({
      model: "deepseek/deepseek-v4-pro",
      reasoning: { enabled: true, effort: "high" },
      messages: [{ role: "user", content: "hi" }]
    });
    expect(encoded.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("GOLDEN: an Anthropic model via OpenRouter maps budgetTokens to reasoning.max_tokens", () => {
    const encoded = goldenEncode("openrouter", "anthropic/claude-fable-5", {
      params: { "reasoning.enabled": true, "reasoning.budgetTokens": 2000 }
    });
    expect(encoded.body).toEqual({
      model: "anthropic/claude-fable-5",
      reasoning: { enabled: true, max_tokens: 2000 },
      messages: [{ role: "user", content: "hi" }]
    });
  });
});

describe("openai-chat encode — structure", () => {
  const TOOLS = [{ name: "pick", description: "pick one", parameters: { type: "object", properties: {} } }];

  it("encodes tools and named tool choice", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      tools: TOOLS,
      toolChoice: { name: "pick" }
    });
    expect(encoded.body.tools).toEqual([
      { type: "function", function: { name: "pick", description: "pick one", parameters: { type: "object", properties: {} } } }
    ]);
    expect(encoded.body.tool_choice).toEqual({ type: "function", function: { name: "pick" } });
  });

  it("encodes assistant tool calls, reasoning round-trip and tool results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thought" },
          { type: "toolCall", id: "call_1", name: "pick", arguments: '{"k":1}' }
        ]
      },
      { role: "tool", toolCallId: "call_1", content: "42" }
    ];
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", { params: { "reasoning.enabled": false }, messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "pick", arguments: '{"k":1}' } }],
        reasoning_content: "thought"
      },
      { role: "tool", tool_call_id: "call_1", content: "42" }
    ]);
  });

  it("omits reasoning_content when the model does not round-trip reasoning", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: [{ type: "reasoning", text: "thought" }, { type: "text", text: "answer" }] }
    ];
    // deepseek-v3.2 (openrouter-only) has reasoningRoundTrip: false
    const encoded = goldenEncode("openrouter", "deepseek/deepseek-v3.2", { messages });
    expect(encoded.body.messages).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("encodes image blocks as data-URL image_url parts", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "AAA=" }] }]
    });
    expect(encoded.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } }
        ]
      }
    ]);
  });

  it("encodes response_format json_object and json_schema", () => {
    const jsonObject = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      responseFormat: { type: "json_object" }
    });
    expect(jsonObject.body.response_format).toEqual({ type: "json_object" });

    const schema = { type: "object", properties: { a: { type: "number" } } };
    const jsonSchema = goldenEncode("openrouter", "deepseek/deepseek-v3.2", {
      responseFormat: { type: "json_schema", name: "out", schema, strict: true }
    });
    expect(jsonSchema.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "out", schema, strict: true } });
  });

  it("sets stream and stream_options only when the model reports streaming usage", () => {
    const withUsage = goldenEncode("deepseek", "deepseek-v4-flash", { params: { "reasoning.enabled": false }, stream: true });
    expect(withUsage.body.stream).toBe(true);
    expect(withUsage.body.stream_options).toEqual({ include_usage: true });

    const withoutUsage = goldenEncode("openrouter", "deepseek/deepseek-v3.2", { stream: true }); // streamingUsage: false
    expect(withoutUsage.body.stream).toBe(true);
    expect(withoutUsage.body).not.toHaveProperty("stream_options");
  });

  it("merges passthrough keys with a warning", () => {
    const encoded = goldenEncode("deepseek", "deepseek-v4-flash", {
      params: { "reasoning.enabled": false },
      passthrough: { service_tier: "flex" }
    });
    expect(encoded.body.service_tier).toBe("flex");
    expect(encoded.warnings).toContainEqual({ code: "passthrough", param: "service_tier", message: "service_tier sent unvalidated via passthrough" });
  });
});

describe("openai-chat decodeResponse", () => {
  const model = registry.resolve("deepseek", "deepseek-v4-pro")!;

  it("decodes reasoning_content, text, tool calls and DeepSeek cache usage", () => {
    const response = openaiChatCodec.decodeResponse(model, {
      id: "cmpl_1",
      choices: [
        {
          message: {
            content: "answer",
            reasoning_content: "thought",
            tool_calls: [{ id: "call_9", function: { name: "pick", arguments: '{"k":1}' } }]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 }, prompt_cache_hit_tokens: 4 }
    });
    expect(response).toEqual({
      id: "cmpl_1",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      content: [
        { type: "reasoning", text: "thought" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_9", name: "pick", arguments: '{"k":1}' }
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cachedInputTokens: 4 },
      warnings: []
    });
  });

  it("maps finish reasons, defaulting unknown ones to error", () => {
    const decode = (finish_reason: string | null) =>
      openaiChatCodec.decodeResponse(model, { choices: [{ message: { content: "x" }, finish_reason }] }).finishReason;
    expect(decode("stop")).toBe("stop");
    expect(decode("length")).toBe("length");
    expect(decode("content_filter")).toBe("content_filter");
    expect(decode("insufficient_system_resource")).toBe("error");
    expect(decode(null)).toBe("error");
  });

  it("throws GatewayError server when choices are missing", () => {
    expect(() => openaiChatCodec.decodeResponse(model, { object: "error" })).toThrow(GatewayError);
  });
});

describe("openai-chat decodeStream", () => {
  const model = registry.resolve("deepseek", "deepseek-v4-pro")!;

  it("yields deltas, usage and an assembled done event", async () => {
    const events = await collect(
      openaiChatCodec.decodeStream(
        model,
        sse([
          { data: '{"id":"c1","choices":[{"delta":{"reasoning_content":"th"}}]}' },
          { data: '{"choices":[{"delta":{"content":"he"}}]}' },
          { data: '{"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}' },
          { data: '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}' },
          { data: "[DONE]" }
        ])
      )
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "th" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } },
      {
        type: "done",
        response: {
          id: "c1",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          content: [
            { type: "reasoning", text: "th" },
            { type: "text", text: "hello" }
          ],
          finishReason: "stop",
          usage: { inputTokens: 7, outputTokens: 2 },
          warnings: []
        }
      }
    ]);
  });

  it("accumulates indexed tool-call deltas", async () => {
    const events = await collect(
      openaiChatCodec.decodeStream(
        model,
        sse([
          { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"pick","arguments":""}}]}}]}' },
          { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"k\\""}}]}}]}' },
          { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}' },
          { data: "[DONE]" }
        ])
      )
    );
    expect(events[0]).toEqual({ type: "tool-call-delta", index: 0, id: "call_1", name: "pick", argumentsDelta: "" });
    expect(events[1]).toEqual({ type: "tool-call-delta", index: 0, argumentsDelta: '{"k"' });
    expect(events[2]).toEqual({ type: "tool-call-delta", index: 0, argumentsDelta: ":1}" });
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.response.content).toEqual([{ type: "toolCall", id: "call_1", name: "pick", arguments: '{"k":1}' }]);
      expect(done.response.finishReason).toBe("tool_calls");
    }
  });

  it("throws GatewayError on malformed chunks", async () => {
    await expect(collect(openaiChatCodec.decodeStream(model, sse([{ data: "{not json" }])))).rejects.toThrow(GatewayError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/codecs/openaiChat.test.ts
```
Expected: FAIL — cannot resolve `openaiChat.js`.

- [ ] **Step 3: Write `src/codecs/openaiChat.ts`**

```ts
import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  FinishReason,
  ReasoningBlock,
  StreamEvent,
  TextBlock,
  ToolCallBlock,
  Usage
} from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, mapOpenRouterParams, pruneUndefined } from "./shared.js";

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter"
};

type WirePayload = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
};

type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek's cache-hit counter. */
  prompt_cache_hit_tokens?: number;
};

function decodeUsage(usage: WireUsage | null | undefined): Usage {
  return pruneUndefined({
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens
  });
}

function encodeMessages(model: ResolvedModel, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
    } else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    } else if (message.role === "user") {
      out.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) =>
                block.type === "text"
                  ? { type: "text", text: block.text }
                  : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
              )
      });
    } else if (typeof message.content === "string") {
      out.push({ role: "assistant", content: message.content });
    } else {
      const text = message.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      const reasoning = message.content.filter((b): b is ReasoningBlock => b.type === "reasoning").map((b) => b.text).join("");
      const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
      out.push(
        pruneUndefined({
          role: "assistant",
          content: text !== "" ? text : null,
          tool_calls: toolCalls.length
            ? toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
            : undefined,
          reasoning_content: reasoning !== "" && model.features.reasoningRoundTrip ? reasoning : undefined
        })
      );
    }
  }
  return out;
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  const mapped = model.providerId === "openrouter" ? mapOpenRouterParams(model, request.effectiveParams) : mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  body.messages = encodeMessages(model, request.messages);
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: pruneUndefined({ name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict })
    }));
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice =
      typeof request.toolChoice === "object" ? { type: "function", function: { name: request.toolChoice.name } } : request.toolChoice;
  }
  if (request.responseFormat) {
    body.response_format =
      request.responseFormat.type === "json_object"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: pruneUndefined({
              name: request.responseFormat.name ?? "response",
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict
            })
          };
  }
  if (request.stream) {
    body.stream = true;
    if (model.features.streamingUsage) body.stream_options = { include_usage: true };
  }
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as WirePayload;
  const choice = wire.choices?.[0];
  if (!choice) {
    throw new GatewayError("server", `${model.providerId} response has no choices`, { provider: model.providerId, raw: payload });
  }
  const message = choice.message ?? {};
  const content: ContentBlock[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content !== "") {
    content.push({ type: "reasoning", text: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  }
  (message.tool_calls ?? []).forEach((call, index) => {
    content.push({ type: "toolCall", id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" });
  });
  return {
    id: wire.id ?? "",
    provider: model.providerId,
    model: model.modelId,
    content,
    finishReason: FINISH_REASONS[choice.finish_reason ?? ""] ?? "error",
    usage: decodeUsage(wire.usage),
    warnings: []
  };
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  let id = "";
  let finishReason: FinishReason = "error";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let text = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for await (const event of events) {
    if (event.data === "[DONE]") break;
    let chunk: WirePayload & { choices?: Array<{ delta?: WirePayload["choices"] extends Array<infer C> ? (C extends { message?: infer M } ? M & { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } : never) : never; finish_reason?: string | null }> };
    try {
      chunk = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    if (chunk.id) id = chunk.id;
    if (chunk.usage) {
      usage = decodeUsage(chunk.usage);
      yield { type: "usage", usage };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = FINISH_REASONS[choice.finish_reason] ?? "error";
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      reasoning += delta.reasoning_content;
      yield { type: "reasoning-delta", text: delta.reasoning_content };
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      text += delta.content;
      yield { type: "text-delta", text: delta.content };
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      while (toolCalls.length <= index) toolCalls.push({ id: "", name: "", arguments: "" });
      const entry = toolCalls[index]!;
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      const argumentsDelta = call.function?.arguments ?? "";
      entry.arguments += argumentsDelta;
      yield {
        type: "tool-call-delta",
        index,
        ...(call.id !== undefined ? { id: call.id } : {}),
        ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
        argumentsDelta
      };
    }
  }

  const content: ContentBlock[] = [];
  if (reasoning !== "") content.push({ type: "reasoning", text: reasoning });
  if (text !== "") content.push({ type: "text", text });
  toolCalls.forEach((call, index) => {
    content.push({ type: "toolCall", id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || "{}" });
  });
  yield {
    type: "done",
    response: { id, provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] }
  };
}

export const openaiChatCodec: Codec = { wire: "openai-chat", encode, decodeResponse, decodeStream };
```

Note: if the inline `chunk` type above fights the compiler, replace it with a dedicated local type — keep it simple:

```ts
type StreamChunk = {
  id?: string;
  usage?: WireUsage | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
};
```
and `const chunk: StreamChunk = JSON.parse(event.data)` (inside the try). The dedicated type is the preferred form.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/codecs/openaiChat.test.ts && npm run typecheck
```
Expected: PASS (18 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/codecs/openaiChat.ts tests/codecs/openaiChat.test.ts
git commit -m "feat: add openai-chat codec with native and OpenRouter dialects"
```

---

### Task 6: openai-responses codec

OpenAI gpt-5.x family only (native route). System messages become `developer` items; tool calls/results are top-level `function_call`/`function_call_output` items; reasoning is server-managed (never re-sent).

**Files:**
- Create: `src/codecs/openaiResponses.ts`
- Test: `tests/codecs/openaiResponses.test.ts`

- [ ] **Step 1: Write the failing test `tests/codecs/openaiResponses.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { openaiResponsesCodec } from "../../src/codecs/openaiResponses.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
const model = registry.resolve("openai", "gpt-5.5")!;

function goldenEncode(input: {
  params?: Record<string, unknown>;
  messages?: ChatMessage[];
  tools?: Parameters<typeof openaiResponsesCodec.encode>[1]["tools"];
  toolChoice?: Parameters<typeof openaiResponsesCodec.encode>[1]["toolChoice"];
  responseFormat?: Parameters<typeof openaiResponsesCodec.encode>[1]["responseFormat"];
  stream?: boolean;
}) {
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    responseFormat: input.responseFormat?.type,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return openaiResponsesCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
      effectiveParams: validation.effectiveParams,
      stream: input.stream ?? false
    },
    "TEST_KEY"
  );
}

async function* sse(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const event of events) yield event;
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("openai-responses encode", () => {
  it("GOLDEN: reasoning effort + verbosity + max_output_tokens with developer role", () => {
    const encoded = goldenEncode({
      params: { "reasoning.effort": "high", verbosity: "low", maxOutputTokens: 4000 },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      model: "gpt-5.5",
      max_output_tokens: 4000,
      reasoning: { effort: "high" },
      text: { verbosity: "low" },
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Be terse." }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] }
      ]
    });
    expect(encoded.url).toBe("https://api.openai.com/v1/responses");
    expect(encoded.headers).toEqual({ "content-type": "application/json", authorization: "Bearer TEST_KEY" });
  });

  it("sampling params stay rejected upstream (P1a pin re-asserted at the codec boundary)", () => {
    expect(validateRequest(model, { params: { temperature: 0.7 } }).ok).toBe(false);
  });

  it("encodes tool history as function_call / function_call_output items and named tool choice", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "calling" },
          { type: "toolCall", id: "call_1", name: "pick", arguments: '{"k":1}' }
        ]
      },
      { role: "tool", toolCallId: "call_1", content: "42" }
    ];
    const encoded = goldenEncode({
      messages,
      tools: [{ name: "pick", description: "pick one", parameters: { type: "object" }, strict: true }],
      toolChoice: { name: "pick" }
    });
    expect(encoded.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "q" }] },
      { role: "assistant", content: [{ type: "output_text", text: "calling" }] }, // reasoning NOT re-sent
      { type: "function_call", call_id: "call_1", name: "pick", arguments: '{"k":1}' },
      { type: "function_call_output", call_id: "call_1", output: "42" }
    ]);
    expect(encoded.body.tools).toEqual([{ type: "function", name: "pick", description: "pick one", parameters: { type: "object" }, strict: true }]);
    expect(encoded.body.tool_choice).toEqual({ type: "function", name: "pick" });
  });

  it("merges responseFormat into text.format alongside verbosity", () => {
    const schema = { type: "object", properties: {} };
    const encoded = goldenEncode({
      params: { verbosity: "low" },
      responseFormat: { type: "json_schema", name: "out", schema, strict: true }
    });
    expect(encoded.body.text).toEqual({ verbosity: "low", format: { type: "json_schema", name: "out", schema, strict: true } });
  });

  it("encodes image input and the stream flag", () => {
    const encoded = goldenEncode({
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA=" }] }],
      stream: true
    });
    expect(encoded.body.input).toEqual([{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAA=" }] }]);
    expect(encoded.body.stream).toBe(true);
  });
});

describe("openai-responses decodeResponse", () => {
  it("decodes reasoning summaries, message text, function calls and usage", () => {
    const response = openaiResponsesCodec.decodeResponse(model, {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call", call_id: "call_2", name: "pick", arguments: "{}" }
      ],
      usage: { input_tokens: 20, output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 }, input_tokens_details: { cached_tokens: 11 } }
    });
    expect(response).toEqual({
      id: "resp_1",
      provider: "openai",
      model: "gpt-5.5",
      content: [
        { type: "reasoning", text: "thought" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_2", name: "pick", arguments: "{}" }
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 20, outputTokens: 9, reasoningTokens: 6, cachedInputTokens: 11 },
      warnings: []
    });
  });

  it("maps statuses to finish reasons", () => {
    const decode = (status: string, reason?: string) =>
      openaiResponsesCodec.decodeResponse(model, { status, incomplete_details: reason ? { reason } : undefined, output: [] }).finishReason;
    expect(decode("completed")).toBe("stop");
    expect(decode("incomplete", "max_output_tokens")).toBe("length");
    expect(decode("incomplete", "content_filter")).toBe("content_filter");
    expect(decode("failed")).toBe("error");
  });
});

describe("openai-responses decodeStream", () => {
  it("yields deltas keyed by output_index and a done decoded from response.completed", async () => {
    const completed = {
      id: "resp_2",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi!" }] }],
      usage: { input_tokens: 3, output_tokens: 2 }
    };
    const events = await collect(
      openaiResponsesCodec.decodeStream(
        model,
        sse([
          { event: "response.output_text.delta", data: '{"type":"response.output_text.delta","output_index":0,"delta":"hi"}' },
          { event: "response.output_text.delta", data: '{"type":"response.output_text.delta","output_index":0,"delta":"!"}' },
          { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: completed }) }
        ])
      )
    );
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "text-delta", text: "!" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
      {
        type: "done",
        response: {
          id: "resp_2",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "hi!" }],
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 2 },
          warnings: []
        }
      }
    ]);
  });

  it("emits tool-call deltas from output_item.added + function_call_arguments.delta", async () => {
    const completed = {
      id: "resp_3",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_7", name: "pick", arguments: '{"k":1}' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    };
    const events = await collect(
      openaiResponsesCodec.decodeStream(
        model,
        sse([
          {
            event: "response.output_item.added",
            data: '{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_7","name":"pick"}}'
          },
          {
            event: "response.function_call_arguments.delta",
            data: '{"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"k\\":1}"}'
          },
          { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: completed }) }
        ])
      )
    );
    expect(events[0]).toEqual({ type: "tool-call-delta", index: 0, id: "call_7", name: "pick", argumentsDelta: "" });
    expect(events[1]).toEqual({ type: "tool-call-delta", index: 0, argumentsDelta: '{"k":1}' });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("throws GatewayError on response.failed and error events", async () => {
    await expect(
      collect(
        openaiResponsesCodec.decodeStream(
          model,
          sse([{ event: "response.failed", data: '{"type":"response.failed","response":{"error":{"message":"boom"}}}' }])
        )
      )
    ).rejects.toThrow(GatewayError);
    await expect(
      collect(openaiResponsesCodec.decodeStream(model, sse([{ event: "error", data: '{"type":"error","message":"bad"}' }])))
    ).rejects.toThrow(GatewayError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/codecs/openaiResponses.test.ts
```
Expected: FAIL — cannot resolve `openaiResponses.js`.

- [ ] **Step 3: Write `src/codecs/openaiResponses.ts`**

```ts
import { GatewayError, extractErrorMessage } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, TextBlock, Usage } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, pruneUndefined, setPath } from "./shared.js";

type ResponsesPayload = {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ type?: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    input_tokens_details?: { cached_tokens?: number };
  };
};

function encodeInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "developer", content: [{ type: "input_text", text: message.content }] });
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    } else if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      input.push({
        role: "user",
        content: blocks.map((block) =>
          block.type === "text"
            ? { type: "input_text", text: block.text }
            : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` }
        )
      });
    } else {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const text = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      if (text !== "") input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const block of blocks) {
        // reasoning blocks are server-managed by OpenAI and never re-sent
        if (block.type === "toolCall") input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments });
      }
    }
  }
  return input;
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  body.input = encodeInput(request.messages);
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) =>
      pruneUndefined({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict })
    );
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice = typeof request.toolChoice === "object" ? { type: "function", name: request.toolChoice.name } : request.toolChoice;
  }
  if (request.responseFormat) {
    setPath(
      body,
      "text.format",
      request.responseFormat.type === "json_object"
        ? { type: "json_object" }
        : pruneUndefined({
            type: "json_schema",
            name: request.responseFormat.name ?? "response",
            schema: request.responseFormat.schema,
            strict: request.responseFormat.strict
          })
    );
  }
  if (request.stream) body.stream = true;
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as ResponsesPayload;
  const content: ContentBlock[] = [];
  let hasToolCalls = false;
  let callIndex = 0;
  for (const item of wire.output ?? []) {
    if (item.type === "reasoning") {
      const text = (item.summary ?? []).map((s) => s.text ?? "").join("");
      if (text !== "") content.push({ type: "reasoning", text });
    } else if (item.type === "message") {
      const text = (item.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
      if (text !== "") content.push({ type: "text", text });
    } else if (item.type === "function_call") {
      hasToolCalls = true;
      content.push({ type: "toolCall", id: item.call_id ?? `call_${callIndex}`, name: item.name ?? "", arguments: item.arguments ?? "{}" });
      callIndex++;
    }
  }
  const finishReason: FinishReason =
    wire.status === "completed"
      ? hasToolCalls
        ? "tool_calls"
        : "stop"
      : wire.status === "incomplete"
        ? wire.incomplete_details?.reason === "max_output_tokens"
          ? "length"
          : wire.incomplete_details?.reason === "content_filter"
            ? "content_filter"
            : "error"
        : "error";
  const usage: Usage = pruneUndefined({
    inputTokens: wire.usage?.input_tokens ?? 0,
    outputTokens: wire.usage?.output_tokens ?? 0,
    reasoningTokens: wire.usage?.output_tokens_details?.reasoning_tokens,
    cachedInputTokens: wire.usage?.input_tokens_details?.cached_tokens
  });
  return { id: wire.id ?? "", provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] };
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  const toolIndexByOutputIndex = new Map<number, number>();
  let nextToolIndex = 0;
  for await (const event of events) {
    let data: Record<string, unknown> & { type?: string };
    try {
      data = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    const type = event.event ?? data.type;
    if (type === "response.output_item.added") {
      const item = data.item as { type?: string; call_id?: string; name?: string } | undefined;
      if (item?.type === "function_call") {
        const index = nextToolIndex++;
        toolIndexByOutputIndex.set(data.output_index as number, index);
        yield {
          type: "tool-call-delta",
          index,
          ...(item.call_id !== undefined ? { id: item.call_id } : {}),
          ...(item.name !== undefined ? { name: item.name } : {}),
          argumentsDelta: ""
        };
      }
    } else if (type === "response.output_text.delta") {
      if (typeof data.delta === "string" && data.delta !== "") yield { type: "text-delta", text: data.delta };
    } else if (type === "response.reasoning_summary_text.delta") {
      if (typeof data.delta === "string" && data.delta !== "") yield { type: "reasoning-delta", text: data.delta };
    } else if (type === "response.function_call_arguments.delta") {
      const index = toolIndexByOutputIndex.get(data.output_index as number) ?? 0;
      if (typeof data.delta === "string") yield { type: "tool-call-delta", index, argumentsDelta: data.delta };
    } else if (type === "response.completed") {
      const response = decodeResponse(model, data.response);
      yield { type: "usage", usage: response.usage };
      yield { type: "done", response };
      return;
    } else if (type === "response.failed" || type === "error") {
      throw new GatewayError("server", extractErrorMessage(data.response ?? data), { provider: model.providerId, raw: data });
    }
    // all other event types (response.created, response.in_progress, …) are ignored
  }
}

export const openaiResponsesCodec: Codec = { wire: "openai-responses", encode, decodeResponse, decodeStream };
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/codecs/openaiResponses.test.ts && npm run typecheck
```
Expected: PASS (10 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/codecs/openaiResponses.ts tests/codecs/openaiResponses.test.ts
git commit -m "feat: add openai-responses codec"
```

---

### Task 7: anthropic-messages codec

The most intricate path (MIGRATION_PLAN §9): thinking payload, signature round-trip on tool loops, top-level system, required `max_tokens`, tool_result-as-user-message with same-role merging.

**Codec-level invariants** (beyond data): Anthropic REQUIRES `max_tokens` — default is `min(limits.maxOutputTokens, 4096)` (4096 if the limit is 0/unknown). `thinking.type === "enabled"` requires `budget_tokens` — default 1024; if `max_tokens <= budget_tokens`, bump `max_tokens` to `budget_tokens + 1024`. `thinking.type === "disabled"` carries no other fields. `responseFormat` throws `invalid_request` (no verified wire field in data — use tools for structured output; see "Known data gaps").

**Files:**
- Create: `src/codecs/anthropicMessages.ts`
- Test: `tests/codecs/anthropicMessages.test.ts`

- [ ] **Step 1: Write the failing test `tests/codecs/anthropicMessages.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { anthropicMessagesCodec } from "../../src/codecs/anthropicMessages.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
const model = registry.resolve("anthropic", "claude-fable-5")!;

function goldenEncode(input: {
  params?: Record<string, unknown>;
  messages?: ChatMessage[];
  tools?: Parameters<typeof anthropicMessagesCodec.encode>[1]["tools"];
  toolChoice?: Parameters<typeof anthropicMessagesCodec.encode>[1]["toolChoice"];
  stream?: boolean;
}) {
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return anthropicMessagesCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      effectiveParams: validation.effectiveParams,
      stream: input.stream ?? false
    },
    "TEST_KEY"
  );
}

async function* sse(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const event of events) yield event;
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("anthropic-messages encode — thinking payload", () => {
  it("GOLDEN: thinking payload with budget, top-level system, reasoningRoundTrip directive skipped", () => {
    const encoded = goldenEncode({
      params: { "reasoning.enabled": true, "reasoning.budgetTokens": 1500, maxOutputTokens: 2048 },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      model: "claude-fable-5",
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 1500 },
      system: "Be terse.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    expect(encoded.body).not.toHaveProperty("reasoningRoundTrip");
    expect(encoded.url).toBe("https://api.anthropic.com/v1/messages");
    expect(encoded.headers).toEqual({ "content-type": "application/json", "x-api-key": "TEST_KEY", "anthropic-version": "2023-06-01" });
  });

  it("defaults max_tokens to 4096 and thinking budget to 1024", () => {
    const encoded = goldenEncode({ params: { "reasoning.enabled": true } });
    expect(encoded.body.max_tokens).toBe(4096);
    expect(encoded.body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("bumps max_tokens above the thinking budget when needed", () => {
    const encoded = goldenEncode({ params: { "reasoning.enabled": true, "reasoning.budgetTokens": 1500, maxOutputTokens: 1024 } });
    expect(encoded.body.max_tokens).toBe(2524); // 1500 + 1024
    expect(encoded.body.thinking).toEqual({ type: "enabled", budget_tokens: 1500 });
  });

  it("normalizes disabled thinking to {type:'disabled'} with no extra fields", () => {
    const encoded = goldenEncode({ params: { "reasoning.enabled": false, "reasoning.budgetTokens": 1500 } });
    expect(encoded.body.thinking).toEqual({ type: "disabled" });
  });
});

describe("anthropic-messages encode — messages & tools", () => {
  it("GOLDEN: reasoning round-trip — thinking block with signature, tool_use, then tool_result as user", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hmm", signature: "sig_abc" },
          { type: "toolCall", id: "toolu_1", name: "lookup", arguments: '{"q":"x"}' }
        ]
      },
      { role: "tool", toolCallId: "toolu_1", content: "42" }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig_abc" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }
        ]
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }
    ]);
  });

  it("encodes redacted thinking blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "reasoning", text: "", redacted: true, data: "OPAQUE" }, { type: "text", text: "ok" }] }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE" }, { type: "text", text: "ok" }] }
    ]);
  });

  it("merges consecutive same-role messages (two tool results → one user message)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "a", arguments: "{}" },
          { type: "toolCall", id: "t2", name: "b", arguments: "{}" }
        ]
      },
      { role: "tool", toolCallId: "t1", content: "1" },
      { role: "tool", toolCallId: "t2", content: "2" }
    ];
    const encoded = goldenEncode({ messages });
    const wireMessages = encoded.body.messages as Array<{ role: string; content: unknown[] }>;
    expect(wireMessages).toHaveLength(3);
    expect(wireMessages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "1" },
        { type: "tool_result", tool_use_id: "t2", content: "2" }
      ]
    });
  });

  it("joins multiple system messages and encodes images", () => {
    const encoded = goldenEncode({
      messages: [
        { role: "system", content: "A." },
        { role: "system", content: "B." },
        { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA=" }] }
      ]
    });
    expect(encoded.body.system).toBe("A.\n\nB.");
    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } }] }
    ]);
  });

  it("maps tools, required→any and named→tool; sets stream flag", () => {
    const encoded = goldenEncode({
      tools: [{ name: "pick", description: "d", parameters: { type: "object" } }],
      toolChoice: "required",
      stream: true
    });
    expect(encoded.body.tools).toEqual([{ name: "pick", description: "d", input_schema: { type: "object" } }]);
    expect(encoded.body.tool_choice).toEqual({ type: "any" });
    expect(encoded.body.stream).toBe(true);

    const named = goldenEncode({ tools: [{ name: "pick", parameters: { type: "object" } }], toolChoice: { name: "pick" } });
    expect(named.body.tool_choice).toEqual({ type: "tool", name: "pick" });
  });

  it("throws invalid_request for responseFormat (not implemented on this wire)", () => {
    expect(() =>
      anthropicMessagesCodec.encode(
        model,
        { messages: [{ role: "user", content: "hi" }], responseFormat: { type: "json_object" }, effectiveParams: {}, stream: false },
        "TEST_KEY"
      )
    ).toThrow(GatewayError);
  });
});

describe("anthropic-messages decodeResponse", () => {
  it("decodes thinking + text + tool_use with usage and stop_reason", () => {
    const response = anthropicMessagesCodec.decodeResponse(model, {
      id: "msg_1",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig_1" },
        { type: "text", text: "calling" },
        { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "x" } }
      ],
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5 }
    });
    expect(response).toEqual({
      id: "msg_1",
      provider: "anthropic",
      model: "claude-fable-5",
      content: [
        { type: "reasoning", text: "hmm", signature: "sig_1" },
        { type: "text", text: "calling" },
        { type: "toolCall", id: "toolu_9", name: "lookup", arguments: '{"q":"x"}' }
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 5 },
      warnings: []
    });
  });

  it("decodes redacted_thinking and maps stop reasons", () => {
    const response = anthropicMessagesCodec.decodeResponse(model, {
      id: "msg_2",
      stop_reason: "refusal",
      content: [{ type: "redacted_thinking", data: "OPAQUE" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    expect(response.content).toEqual([{ type: "reasoning", text: "", redacted: true, data: "OPAQUE" }]);
    expect(response.finishReason).toBe("content_filter");

    const stop = (stop_reason: string) =>
      anthropicMessagesCodec.decodeResponse(model, { stop_reason, content: [], usage: {} }).finishReason;
    expect(stop("end_turn")).toBe("stop");
    expect(stop("stop_sequence")).toBe("stop");
    expect(stop("max_tokens")).toBe("length");
  });
});

describe("anthropic-messages decodeStream", () => {
  it("assembles thinking + signature + text + tool_use across block events", async () => {
    const events = await collect(
      anthropicMessagesCodec.decodeStream(
        model,
        sse([
          { event: "message_start", data: '{"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":9}}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_z"}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}' },
          { event: "content_block_start", data: '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_5","name":"pick"}}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}' },
          { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}' },
          { event: "message_stop", data: '{"type":"message_stop"}' }
        ])
      )
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "hm" },
      { type: "text-delta", text: "ok" },
      { type: "tool-call-delta", index: 0, id: "toolu_5", name: "pick", argumentsDelta: "" },
      { type: "tool-call-delta", index: 0, argumentsDelta: "{}" },
      { type: "usage", usage: { inputTokens: 9, outputTokens: 6 } },
      {
        type: "done",
        response: {
          id: "msg_3",
          provider: "anthropic",
          model: "claude-fable-5",
          content: [
            { type: "reasoning", text: "hm", signature: "sig_z" },
            { type: "text", text: "ok" },
            { type: "toolCall", id: "toolu_5", name: "pick", arguments: "{}" }
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 9, outputTokens: 6 },
          warnings: []
        }
      }
    ]);
  });

  it("ignores ping and throws on error events", async () => {
    await expect(
      collect(
        anthropicMessagesCodec.decodeStream(
          model,
          sse([
            { event: "ping", data: '{"type":"ping"}' },
            { event: "error", data: '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}' }
          ])
        )
      )
    ).rejects.toThrow(GatewayError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/codecs/anthropicMessages.test.ts
```
Expected: FAIL — cannot resolve `anthropicMessages.js`.

- [ ] **Step 3: Write `src/codecs/anthropicMessages.ts`**

```ts
import { GatewayError, extractErrorMessage } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, Usage } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, parseArguments, pruneUndefined } from "./shared.js";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET = 1024;

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter"
};

type AnthropicPayload = {
  id?: string;
  stop_reason?: string | null;
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
};

function defaultMaxTokens(model: ResolvedModel): number {
  return model.limits.maxOutputTokens > 0 ? Math.min(model.limits.maxOutputTokens, DEFAULT_MAX_TOKENS) : DEFAULT_MAX_TOKENS;
}

type WireMessage = { role: "user" | "assistant"; content: Array<Record<string, unknown>> };

function encodeMessages(model: ResolvedModel, messages: ChatMessage[]): { system?: string; messages: WireMessage[] } {
  const systems: string[] = [];
  const out: WireMessage[] = [];
  const push = (role: "user" | "assistant", blocks: Array<Record<string, unknown>>) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(message.content);
    } else if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]);
    } else if (message.role === "user") {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block) =>
              block.type === "text"
                ? { type: "text", text: block.text }
                : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
            );
      push("user", blocks);
    } else {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block): Record<string, unknown> => {
              if (block.type === "text") return { type: "text", text: block.text };
              if (block.type === "toolCall") {
                return { type: "tool_use", id: block.id, name: block.name, input: parseArguments(model.providerId, block.name, block.arguments) };
              }
              return block.redacted
                ? { type: "redacted_thinking", data: block.data ?? "" }
                : pruneUndefined({ type: "thinking", thinking: block.text, signature: block.signature });
            });
      push("assistant", blocks);
    }
  }
  return { system: systems.length > 0 ? systems.join("\n\n") : undefined, messages: out };
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  if (request.responseFormat) {
    throw new GatewayError(
      "invalid_request",
      "responseFormat is not implemented for the anthropic-messages codec; use tools for structured output",
      { provider: model.providerId }
    );
  }
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { model: model.modelId, ...mapped.wire };
  if (typeof body.max_tokens !== "number") body.max_tokens = defaultMaxTokens(model);
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking) {
    if (thinking.type === "enabled") {
      if (typeof thinking.budget_tokens !== "number") thinking.budget_tokens = DEFAULT_THINKING_BUDGET;
      if ((body.max_tokens as number) <= thinking.budget_tokens) body.max_tokens = thinking.budget_tokens + DEFAULT_THINKING_BUDGET;
    } else {
      body.thinking = { type: "disabled" };
    }
  }
  const { system, messages } = encodeMessages(model, request.messages);
  if (system !== undefined) body.system = system;
  body.messages = messages;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => pruneUndefined({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice =
      typeof request.toolChoice === "object"
        ? { type: "tool", name: request.toolChoice.name }
        : request.toolChoice === "required"
          ? { type: "any" }
          : { type: request.toolChoice };
  }
  if (request.stream) body.stream = true;
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as AnthropicPayload;
  const content: ContentBlock[] = [];
  (wire.content ?? []).forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      content.push(
        block.signature !== undefined
          ? { type: "reasoning", text: block.thinking ?? "", signature: block.signature }
          : { type: "reasoning", text: block.thinking ?? "" }
      );
    } else if (block.type === "redacted_thinking") {
      content.push({ type: "reasoning", text: "", redacted: true, data: block.data ?? "" });
    } else if (block.type === "tool_use") {
      content.push({ type: "toolCall", id: block.id ?? `call_${index}`, name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) });
    }
  });
  const usage: Usage = pruneUndefined({
    inputTokens: wire.usage?.input_tokens ?? 0,
    outputTokens: wire.usage?.output_tokens ?? 0,
    cachedInputTokens: wire.usage?.cache_read_input_tokens
  });
  return {
    id: wire.id ?? "",
    provider: model.providerId,
    model: model.modelId,
    content,
    finishReason: STOP_REASONS[wire.stop_reason ?? ""] ?? "error",
    usage,
    warnings: []
  };
}

type StreamBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; signature?: string; redacted?: boolean; data?: string }
  | { kind: "tool"; toolIndex: number; id: string; name: string; arguments: string };

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  let id = "";
  let finishReason: FinishReason = "error";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | undefined;
  const blocks = new Map<number, StreamBlock>();
  let nextToolIndex = 0;

  for await (const event of events) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    const type = event.event ?? data.type;
    if (type === "message_start") {
      id = data.message?.id ?? "";
      inputTokens = data.message?.usage?.input_tokens ?? 0;
      cachedInputTokens = data.message?.usage?.cache_read_input_tokens;
    } else if (type === "content_block_start") {
      const index = data.index as number;
      const block = data.content_block ?? {};
      if (block.type === "tool_use") {
        const toolIndex = nextToolIndex++;
        blocks.set(index, { kind: "tool", toolIndex, id: block.id ?? `call_${toolIndex}`, name: block.name ?? "", arguments: "" });
        yield {
          type: "tool-call-delta",
          index: toolIndex,
          ...(block.id !== undefined ? { id: block.id } : {}),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: ""
        };
      } else if (block.type === "thinking") {
        blocks.set(index, { kind: "reasoning", text: block.thinking ?? "" });
      } else if (block.type === "redacted_thinking") {
        blocks.set(index, { kind: "reasoning", text: "", redacted: true, data: block.data ?? "" });
      } else {
        blocks.set(index, { kind: "text", text: block.text ?? "" });
      }
    } else if (type === "content_block_delta") {
      const block = blocks.get(data.index as number);
      const delta = data.delta ?? {};
      if (!block) continue;
      if (delta.type === "text_delta" && block.kind === "text" && typeof delta.text === "string" && delta.text !== "") {
        block.text += delta.text;
        yield { type: "text-delta", text: delta.text };
      } else if (delta.type === "thinking_delta" && block.kind === "reasoning" && typeof delta.thinking === "string" && delta.thinking !== "") {
        block.text += delta.thinking;
        yield { type: "reasoning-delta", text: delta.thinking };
      } else if (delta.type === "signature_delta" && block.kind === "reasoning") {
        block.signature = (block.signature ?? "") + (delta.signature ?? "");
      } else if (delta.type === "input_json_delta" && block.kind === "tool") {
        const argumentsDelta = delta.partial_json ?? "";
        block.arguments += argumentsDelta;
        yield { type: "tool-call-delta", index: block.toolIndex, argumentsDelta };
      }
    } else if (type === "message_delta") {
      if (typeof data.delta?.stop_reason === "string") finishReason = STOP_REASONS[data.delta.stop_reason] ?? "error";
      if (typeof data.usage?.output_tokens === "number") outputTokens = data.usage.output_tokens;
    } else if (type === "message_stop") {
      const usage: Usage = pruneUndefined({ inputTokens, outputTokens, cachedInputTokens });
      yield { type: "usage", usage };
      const content: ContentBlock[] = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]): ContentBlock => {
          if (block.kind === "text") return { type: "text", text: block.text };
          if (block.kind === "reasoning") {
            return pruneUndefined({ type: "reasoning", text: block.text, signature: block.signature, redacted: block.redacted, data: block.data });
          }
          return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments || "{}" };
        })
        .filter((block) => !(block.type === "text" && block.text === ""));
      yield {
        type: "done",
        response: { id, provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] }
      };
      return;
    } else if (type === "error") {
      throw new GatewayError("server", extractErrorMessage(data), { provider: model.providerId, raw: data });
    }
    // ping and other event types are ignored
  }
}

export const anthropicMessagesCodec: Codec = { wire: "anthropic-messages", encode, decodeResponse, decodeStream };
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/codecs/anthropicMessages.test.ts && npm run typecheck
```
Expected: PASS (14 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/codecs/anthropicMessages.ts tests/codecs/anthropicMessages.test.ts
git commit -m "feat: add anthropic-messages codec with thinking round-trip"
```

---

### Task 8: google-generative-language codec

Gemini + Gemma. Dotted `generationConfig.*` wireNames come straight from descriptors via `mapNativeParams`; system → `systemInstruction`; assistant role is `model`; tool results are `functionResponse` parts matched by NAME (codec keeps an id→name map from prior toolCall blocks). The stream method lives in the URL (Task 4's `buildUrl`).

**Files:**
- Create: `src/codecs/googleGenerativeLanguage.ts`
- Test: `tests/codecs/googleGenerativeLanguage.test.ts`

- [ ] **Step 1: Write the failing test `tests/codecs/googleGenerativeLanguage.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry/loader.js";
import { validateRequest } from "../../src/validate/validateRequest.js";
import { GatewayError } from "../../src/errors.js";
import { googleGenerativeLanguageCodec } from "../../src/codecs/googleGenerativeLanguage.js";
import type { ChatMessage, StreamEvent } from "../../src/client/types.js";
import type { SseEvent } from "../../src/transport/sse.js";

const registry = Registry.load();
const model = registry.resolve("google-ai-studio", "gemini-2.5-flash")!;

function goldenEncode(input: {
  params?: Record<string, unknown>;
  messages?: ChatMessage[];
  tools?: Parameters<typeof googleGenerativeLanguageCodec.encode>[1]["tools"];
  toolChoice?: Parameters<typeof googleGenerativeLanguageCodec.encode>[1]["toolChoice"];
  responseFormat?: Parameters<typeof googleGenerativeLanguageCodec.encode>[1]["responseFormat"];
  stream?: boolean;
}) {
  const validation = validateRequest(model, {
    params: input.params ?? {},
    toolChoice: input.toolChoice,
    responseFormat: input.responseFormat?.type,
    stream: input.stream ?? false
  });
  expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  return googleGenerativeLanguageCodec.encode(
    model,
    {
      messages: input.messages ?? [{ role: "user", content: "hi" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
      effectiveParams: validation.effectiveParams,
      stream: input.stream ?? false
    },
    "TEST_KEY"
  );
}

async function* sse(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const event of events) yield event;
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("google encode — generationConfig & quirks", () => {
  it("GOLDEN: ≤5 stop sequences nest under generationConfig; safetySettings top-level; systemInstruction", () => {
    const encoded = goldenEncode({
      params: { stopSequences: ["a", "b", "c", "d", "e"], temperature: 1.2, "google.safetySettings": { x: 1 } },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" }
      ]
    });
    expect(encoded.body).toEqual({
      generationConfig: { temperature: 1.2, stopSequences: ["a", "b", "c", "d", "e"] },
      safetySettings: { x: 1 },
      systemInstruction: { parts: [{ text: "Be terse." }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }]
    });
    expect(encoded.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(encoded.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": "TEST_KEY" });
  });

  it("a 6th stop sequence is rejected upstream by validation (Gemini cap, Table A row 13)", () => {
    const validation = validateRequest(model, { params: { stopSequences: ["a", "b", "c", "d", "e", "f"] } });
    expect(validation.ok).toBe(false);
    expect(validation.violations.some((v) => v.code === "max_items" && v.param === "stopSequences")).toBe(true);
  });

  it("maps thinking budget and (on gemini-3) thinking level into thinkingConfig", () => {
    const budget = goldenEncode({ params: { "reasoning.budgetTokens": 1024 } });
    expect(budget.body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 1024 } });

    const g3 = registry.resolve("google-ai-studio", "gemini-3-flash-preview")!;
    const validation = validateRequest(g3, { params: { "reasoning.effort": "low" } });
    expect(validation.ok).toBe(true);
    const encoded = googleGenerativeLanguageCodec.encode(
      g3,
      { messages: [{ role: "user", content: "hi" }], effectiveParams: validation.effectiveParams, stream: false },
      "TEST_KEY"
    );
    expect(encoded.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
  });

  it("the stream method lives in the URL, not the body", () => {
    const encoded = goldenEncode({ stream: true });
    expect(encoded.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(encoded.body).not.toHaveProperty("stream");
  });
});

describe("google encode — contents & tools", () => {
  it("encodes a tool loop: model functionCall, then functionResponse matched by NAME", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":"x"}' }] },
      { role: "tool", toolCallId: "call_0", content: '{"answer":42}' }
    ];
    const encoded = goldenEncode({ messages, tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }] });
    expect(encoded.body.contents).toEqual([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: { answer: 42 } } }] }
    ]);
    expect(encoded.body.tools).toEqual([{ functionDeclarations: [{ name: "lookup", description: "d", parameters: { type: "object" } }] }]);
  });

  it("wraps non-JSON tool results as {result} and throws on unknown toolCallId", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "lookup", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_0", content: "plain text" }
    ];
    const encoded = goldenEncode({ messages });
    const contents = encoded.body.contents as Array<{ parts: unknown[] }>;
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "lookup", response: { result: "plain text" } } }]);

    expect(() => goldenEncode({ messages: [{ role: "tool", toolCallId: "ghost", content: "x" }] })).toThrow(GatewayError);
  });

  it("encodes reasoning blocks as thought parts with thoughtSignature, images as inlineData, merges same-role turns", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "look:" }] },
      { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA=" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "hm", signature: "ts_1" }, { type: "text", text: "ok" }] }
    ];
    const encoded = goldenEncode({ messages });
    expect(encoded.body.contents).toEqual([
      { role: "user", parts: [{ text: "look:" }, { inlineData: { mimeType: "image/png", data: "AAA=" } }] },
      { role: "model", parts: [{ text: "hm", thought: true, thoughtSignature: "ts_1" }, { text: "ok" }] }
    ]);
  });

  it("maps toolChoice auto→AUTO and (unit-level) required/named→ANY", () => {
    const auto = goldenEncode({ toolChoice: "auto", tools: [{ name: "f", parameters: { type: "object" } }] });
    expect(auto.body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });

    // features.toolChoice for Gemini is [auto, none], so required/named are validator-rejected today;
    // the codec mapping is still pinned (unit-level, bypassing validation) for when data evolves.
    const named = googleGenerativeLanguageCodec.encode(
      model,
      { messages: [{ role: "user", content: "hi" }], toolChoice: { name: "f" }, effectiveParams: {}, stream: false },
      "TEST_KEY"
    );
    expect(named.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } });
    const required = googleGenerativeLanguageCodec.encode(
      model,
      { messages: [{ role: "user", content: "hi" }], toolChoice: "required", effectiveParams: {}, stream: false },
      "TEST_KEY"
    );
    expect(required.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  it("maps responseFormat to responseMimeType (+ responseJsonSchema for schemas)", () => {
    const schema = { type: "object", properties: {} };
    const encoded = goldenEncode({ responseFormat: { type: "json_schema", schema } });
    expect(encoded.body.generationConfig).toEqual({ responseMimeType: "application/json", responseJsonSchema: schema });

    const jsonObject = goldenEncode({ responseFormat: { type: "json_object" } });
    expect(jsonObject.body.generationConfig).toEqual({ responseMimeType: "application/json" });
  });
});

describe("google decodeResponse", () => {
  it("decodes thought parts, text, functionCall (synthesized ids) and usageMetadata", () => {
    const response = googleGenerativeLanguageCodec.decodeResponse(model, {
      responseId: "r1",
      candidates: [
        {
          content: {
            parts: [
              { text: "hm", thought: true, thoughtSignature: "ts_9" },
              { text: "calling" },
              { functionCall: { name: "lookup", args: { q: "x" } } }
            ]
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3 }
    });
    expect(response).toEqual({
      id: "r1",
      provider: "google-ai-studio",
      model: "gemini-2.5-flash",
      content: [
        { type: "reasoning", text: "hm", signature: "ts_9" },
        { type: "text", text: "calling" },
        { type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":"x"}' }
      ],
      finishReason: "tool_calls", // STOP + functionCall present
      usage: { inputTokens: 8, outputTokens: 4, reasoningTokens: 2, cachedInputTokens: 3 },
      warnings: []
    });
  });

  it("maps finish reasons", () => {
    const decode = (finishReason: string) =>
      googleGenerativeLanguageCodec.decodeResponse(model, { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }] }).finishReason;
    expect(decode("STOP")).toBe("stop");
    expect(decode("MAX_TOKENS")).toBe("length");
    expect(decode("SAFETY")).toBe("content_filter");
    expect(decode("MALFORMED_FUNCTION_CALL")).toBe("error");
  });

  it("throws GatewayError server when candidates are missing", () => {
    expect(() => googleGenerativeLanguageCodec.decodeResponse(model, { promptFeedback: {} })).toThrow(GatewayError);
  });
});

describe("google decodeStream", () => {
  it("yields deltas per chunk and assembles done from the final chunk", async () => {
    const events = await collect(
      googleGenerativeLanguageCodec.decodeStream(
        model,
        sse([
          { data: '{"responseId":"r2","candidates":[{"content":{"parts":[{"text":"hm","thought":true}]}}]}' },
          { data: '{"candidates":[{"content":{"parts":[{"text":"he"}]}}]}' },
          {
            data: '{"candidates":[{"content":{"parts":[{"text":"llo"},{"functionCall":{"name":"lookup","args":{"q":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}'
          }
        ])
      )
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "hm" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "tool-call-delta", index: 0, id: "call_0", name: "lookup", argumentsDelta: '{"q":1}' },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
      {
        type: "done",
        response: {
          id: "r2",
          provider: "google-ai-studio",
          model: "gemini-2.5-flash",
          content: [
            { type: "reasoning", text: "hm" },
            { type: "text", text: "hello" },
            { type: "toolCall", id: "call_0", name: "lookup", arguments: '{"q":1}' }
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 5, outputTokens: 3 },
          warnings: []
        }
      }
    ]);
  });

  it("throws GatewayError on malformed chunks", async () => {
    await expect(collect(googleGenerativeLanguageCodec.decodeStream(model, sse([{ data: "{bad" }])))).rejects.toThrow(GatewayError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/codecs/googleGenerativeLanguage.test.ts
```
Expected: FAIL — cannot resolve `googleGenerativeLanguage.js`.

- [ ] **Step 3: Write `src/codecs/googleGenerativeLanguage.ts`**

```ts
import { GatewayError } from "../errors.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ChatMessage, ChatResponse, ContentBlock, FinishReason, StreamEvent, Usage } from "../client/types.js";
import type { SseEvent } from "../transport/sse.js";
import type { Codec, CodecRequest, EncodedRequest } from "./types.js";
import { applyPassthrough, authHeaders, buildUrl, mapNativeParams, parseArguments, pruneUndefined, setPath } from "./shared.js";

const FINISH_REASONS: Record<string, FinishReason> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  BLOCKLIST: "content_filter",
  RECITATION: "content_filter",
  SPII: "content_filter"
};

type GooglePayload = {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<GooglePart> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
};

type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
};

type WireContent = { role: "user" | "model"; parts: Array<Record<string, unknown>> };

function encodeContents(model: ResolvedModel, messages: ChatMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: WireContent[] } {
  const systems: string[] = [];
  const contents: WireContent[] = [];
  const toolNameById = new Map<string, string>();
  const push = (role: "user" | "model", parts: Array<Record<string, unknown>>) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(message.content);
    } else if (message.role === "tool") {
      const name = toolNameById.get(message.toolCallId);
      if (name === undefined) {
        throw new GatewayError("invalid_request", `tool result "${message.toolCallId}" has no matching toolCall earlier in the conversation`, {
          provider: model.providerId
        });
      }
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(message.content) as unknown;
        response = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: parsed };
      } catch {
        response = { result: message.content };
      }
      push("user", [{ functionResponse: { name, response } }]);
    } else if (message.role === "user") {
      const parts =
        typeof message.content === "string"
          ? [{ text: message.content }]
          : message.content.map((block) =>
              block.type === "text" ? { text: block.text } : { inlineData: { mimeType: block.mimeType, data: block.data } }
            );
      push("user", parts);
    } else {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      const parts = blocks.map((block): Record<string, unknown> => {
        if (block.type === "text") return { text: block.text };
        if (block.type === "toolCall") {
          toolNameById.set(block.id, block.name);
          return { functionCall: { name: block.name, args: parseArguments(model.providerId, block.name, block.arguments) } };
        }
        return pruneUndefined({ text: block.text, thought: true, thoughtSignature: block.signature });
      });
      push("model", parts);
    }
  }
  return { systemInstruction: systems.length > 0 ? { parts: [{ text: systems.join("\n\n") }] } : undefined, contents };
}

function encode(model: ResolvedModel, request: CodecRequest, apiKey: string): EncodedRequest {
  const mapped = mapNativeParams(model, request.effectiveParams);
  const warnings = [...mapped.warnings];
  const body: Record<string, unknown> = { ...mapped.wire }; // model id lives in the URL, not the body
  const { systemInstruction, contents } = encodeContents(model, request.messages);
  if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
  body.contents = contents;
  if (request.tools?.length) {
    body.tools = [
      { functionDeclarations: request.tools.map((tool) => pruneUndefined({ name: tool.name, description: tool.description, parameters: tool.parameters })) }
    ];
  }
  if (request.toolChoice !== undefined) {
    const mode = request.toolChoice === "auto" ? "AUTO" : request.toolChoice === "none" ? "NONE" : "ANY";
    setPath(
      body,
      "toolConfig.functionCallingConfig",
      pruneUndefined({ mode, allowedFunctionNames: typeof request.toolChoice === "object" ? [request.toolChoice.name] : undefined })
    );
  }
  if (request.responseFormat) {
    setPath(body, "generationConfig.responseMimeType", "application/json");
    if (request.responseFormat.type === "json_schema") setPath(body, "generationConfig.responseJsonSchema", request.responseFormat.schema);
  }
  // streaming is selected via the URL (:streamGenerateContent?alt=sse); no body flag
  applyPassthrough(body, request.passthrough, warnings);
  return { url: buildUrl(model, request.stream), headers: authHeaders(model, apiKey), body: pruneUndefined(body), warnings };
}

function decodeParts(parts: GooglePart[], toolStartIndex: number): { blocks: ContentBlock[]; toolCount: number } {
  const blocks: ContentBlock[] = [];
  let toolCount = 0;
  for (const part of parts) {
    if (part.functionCall) {
      blocks.push({
        type: "toolCall",
        id: part.functionCall.id ?? `call_${toolStartIndex + toolCount}`,
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {})
      });
      toolCount++;
    } else if (part.thought === true) {
      blocks.push(
        part.thoughtSignature !== undefined
          ? { type: "reasoning", text: part.text ?? "", signature: part.thoughtSignature }
          : { type: "reasoning", text: part.text ?? "" }
      );
    } else if (typeof part.text === "string" && part.text !== "") {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return { blocks, toolCount };
}

function decodeUsage(meta: GooglePayload["usageMetadata"]): Usage {
  return pruneUndefined({
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
    reasoningTokens: meta?.thoughtsTokenCount,
    cachedInputTokens: meta?.cachedContentTokenCount
  });
}

function decodeResponse(model: ResolvedModel, payload: unknown): ChatResponse {
  const wire = payload as GooglePayload;
  const candidate = wire.candidates?.[0];
  if (!candidate) {
    throw new GatewayError("server", `${model.providerId} response has no candidates`, { provider: model.providerId, raw: payload });
  }
  const { blocks, toolCount } = decodeParts(candidate.content?.parts ?? [], 0);
  const rawFinish = FINISH_REASONS[candidate.finishReason ?? ""] ?? "error";
  return {
    id: wire.responseId ?? "",
    provider: model.providerId,
    model: model.modelId,
    content: blocks,
    finishReason: rawFinish === "stop" && toolCount > 0 ? "tool_calls" : rawFinish,
    usage: decodeUsage(wire.usageMetadata),
    warnings: []
  };
}

async function* decodeStream(model: ResolvedModel, events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
  let id = "";
  let finishReason: FinishReason = "error";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let text = "";
  let reasoning = "";
  let reasoningSignature: string | undefined;
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for await (const event of events) {
    let chunk: GooglePayload;
    try {
      chunk = JSON.parse(event.data);
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} sent a malformed SSE chunk`, { provider: model.providerId, raw: event.data, cause });
    }
    if (chunk.responseId) id = chunk.responseId;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const index = toolCalls.length;
        const call = {
          id: part.functionCall.id ?? `call_${index}`,
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {})
        };
        toolCalls.push(call);
        yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: call.arguments };
      } else if (part.thought === true) {
        reasoning += part.text ?? "";
        if (part.thoughtSignature !== undefined) reasoningSignature = part.thoughtSignature;
        if (part.text) yield { type: "reasoning-delta", text: part.text };
      } else if (typeof part.text === "string" && part.text !== "") {
        text += part.text;
        yield { type: "text-delta", text: part.text };
      }
    }
    if (candidate?.finishReason) {
      const mapped = FINISH_REASONS[candidate.finishReason] ?? "error";
      finishReason = mapped === "stop" && toolCalls.length > 0 ? "tool_calls" : mapped;
    }
    if (chunk.usageMetadata) {
      usage = decodeUsage(chunk.usageMetadata);
      sawUsage = true;
    }
  }

  if (sawUsage) yield { type: "usage", usage };
  const content: ContentBlock[] = [];
  if (reasoning !== "") {
    content.push(reasoningSignature !== undefined ? { type: "reasoning", text: reasoning, signature: reasoningSignature } : { type: "reasoning", text: reasoning });
  }
  if (text !== "") content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  yield {
    type: "done",
    response: { id, provider: model.providerId, model: model.modelId, content, finishReason, usage, warnings: [] }
  };
}

export const googleGenerativeLanguageCodec: Codec = { wire: "google-generative-language", encode, decodeResponse, decodeStream };
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/codecs/googleGenerativeLanguage.test.ts && npm run typecheck
```
Expected: PASS (14 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/codecs/googleGenerativeLanguage.ts tests/codecs/googleGenerativeLanguage.test.ts
git commit -m "feat: add google-generative-language codec"
```

---

### Task 9: Gateway client (`createGateway`)

Composes registry → validation → codec → transport. Carryover #5: the client gates on `ValidationResult.ok` BEFORE consuming `effectiveParams` — a rejected request must never reach a codec or the network.

**Error contract:** `chat()`/`stream()` THROW `GatewayError` for caller mistakes detectable before I/O (unknown model → `invalid_request`, validation failure → `unsupported_parameter`, missing credential → `auth`). Network/provider/decode failures: `chat()` throws; `stream()` yields a final `{type:"error"}` event instead.

**Files:**
- Create: `src/codecs/index.ts`, `src/client/gateway.ts`
- Test: `tests/client/gateway.test.ts`

- [ ] **Step 1: Write the failing test `tests/client/gateway.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../../src/client/gateway.js";
import { GatewayError } from "../../src/errors.js";
import type { StreamEvent } from "../../src/client/types.js";

const OK_PAYLOAD = {
  id: "cmpl_1",
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 }
};

function jsonFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

const CREDS = { credentials: { deepseek: "sk-test", openrouter: "sk-or" } };

describe("gateway.chat", () => {
  it("sends the encoded body and returns the normalized response with merged warnings", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const response = await gateway.chat({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.7, "reasoning.enabled": true }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.finishReason).toBe("stop");
    // the DeepSeek sampling-drop quirk surfaces as warnings end to end
    expect(response.warnings).toContainEqual({
      code: "param_dropped",
      param: "temperature",
      ruleId: "thinking-drops-sampling",
      message: "temperature was dropped by constraint rule thinking-drops-sampling"
    });
    expect(response.raw).toBeUndefined();
  });

  it("gates on validation BEFORE any I/O (carryover #5)", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const error = await gateway
      .chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], toolChoice: "required" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.kind).toBe("unsupported_parameter");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws invalid_request for unknown models and auth for missing credentials", async () => {
    const gateway = createGateway({ ...CREDS, fetchImpl: jsonFetch(OK_PAYLOAD) });
    await expect(gateway.chat({ provider: "deepseek", model: "nope", messages: [] })).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(
      gateway.chat({ provider: "anthropic", model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("supports credential lookup functions and includeRaw", async () => {
    const fetchImpl = jsonFetch(OK_PAYLOAD);
    const gateway = createGateway({ credentials: (id) => (id === "deepseek" ? "sk-fn" : undefined), fetchImpl, includeRaw: true });
    const response = await gateway.chat({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      params: { "reasoning.enabled": false }
    });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-fn" });
    expect(response.raw).toEqual(OK_PAYLOAD);
  });

  it("maps provider HTTP errors through the taxonomy", async () => {
    const fetchImpl = jsonFetch({ error: { message: "invalid api key" } }, 401);
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      gateway.chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("throws server for non-JSON success bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      gateway.chat({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    ).rejects.toMatchObject({ kind: "server" });
  });
});

describe("gateway.stream", () => {
  const SSE_BODY = [
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"y"},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n");

  it("streams normalized events; done carries merged warnings", async () => {
    const fetchImpl = vi.fn(async () => new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const events = await collect(
      gateway.stream({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0.7, "reasoning.enabled": true }
      })
    );
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "usage", "done"]);
    const done = events.at(-1)!;
    if (done.type === "done") {
      expect(done.response.content).toEqual([{ type: "text", text: "hey" }]);
      expect(done.response.warnings.some((w) => w.code === "param_dropped" && w.param === "temperature")).toBe(true);
    }
  });

  it("yields an error event for mid-stream failures instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("data: {broken\n\n", { status: 200 }));
    const gateway = createGateway({ ...CREDS, fetchImpl });
    const events = await collect(
      gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], params: { "reasoning.enabled": false } })
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    if (events[0]!.type === "error") expect(events[0]!.error).toBeInstanceOf(GatewayError);
  });

  it("throws (does not yield) for validation failures", async () => {
    const fetchImpl = vi.fn();
    const gateway = createGateway({ ...CREDS, fetchImpl });
    await expect(
      collect(gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [], toolChoice: "required" }))
    ).rejects.toMatchObject({ kind: "unsupported_parameter" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("gateway registry surface", () => {
  it("exposes listModels, getCapabilities and validate", () => {
    const gateway = createGateway();
    expect(gateway.listModels().length).toBeGreaterThan(54);
    expect(gateway.getCapabilities("deepseek", "deepseek-v4-pro")?.wire).toBe("openai-chat");
    expect(gateway.getCapabilities("deepseek", "nope")).toBeUndefined();
    expect(gateway.validate("deepseek", "deepseek-v4-pro", { params: { temperature: 99 } }).ok).toBe(false);
    expect(() => gateway.validate("deepseek", "nope", { params: {} })).toThrow(GatewayError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/client/gateway.test.ts
```
Expected: FAIL — cannot resolve `gateway.js`.

- [ ] **Step 3: Write `src/codecs/index.ts`**

```ts
import type { WireProtocol } from "../registry/types.js";
import type { Codec } from "./types.js";
import { openaiChatCodec } from "./openaiChat.js";
import { openaiResponsesCodec } from "./openaiResponses.js";
import { anthropicMessagesCodec } from "./anthropicMessages.js";
import { googleGenerativeLanguageCodec } from "./googleGenerativeLanguage.js";

const CODECS: Record<WireProtocol, Codec> = {
  "openai-chat": openaiChatCodec,
  "openai-responses": openaiResponsesCodec,
  "anthropic-messages": anthropicMessagesCodec,
  "google-generative-language": googleGenerativeLanguageCodec
};

export function codecFor(wire: WireProtocol): Codec {
  return CODECS[wire];
}
```

- [ ] **Step 4: Write `src/client/gateway.ts`**

```ts
import { Registry, type ModelRef } from "../registry/loader.js";
import { validateRequest, type ValidateInput, type ValidationResult } from "../validate/validateRequest.js";
import type { ResolvedModel } from "../registry/types.js";
import type { ConstraintWarning } from "../validate/constraints.js";
import { codecFor } from "../codecs/index.js";
import type { EncodedRequest } from "../codecs/types.js";
import { fetchWithRetry } from "../transport/http.js";
import { parseSse } from "../transport/sse.js";
import { GatewayError } from "../errors.js";
import type { ChatRequest, ChatResponse, StreamEvent, Warning } from "./types.js";

export type GatewayOptions = {
  /** providerId → API key, or a lookup function. The gateway never persists keys. */
  credentials?: Record<string, string> | ((providerId: string) => string | undefined);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Override the capability-data directory (tests). */
  dataDir?: string;
  /** Attach the raw provider payload to ChatResponse.raw (non-streaming only). */
  includeRaw?: boolean;
};

const WARNING_CODES = { dropped: "param_dropped", forced: "param_forced", clamped: "param_clamped" } as const;

function toWarnings(warnings: ConstraintWarning[]): Warning[] {
  return warnings.map((warning) => ({
    code: WARNING_CODES[warning.code],
    param: warning.param,
    ruleId: warning.ruleId,
    message: `${warning.param} was ${warning.code} by constraint rule ${warning.ruleId}`
  }));
}

function violationSummary(result: ValidationResult): string {
  return result.violations
    .map((violation) => ("message" in violation && violation.message !== undefined ? `${violation.param}: ${violation.message}` : `${violation.param}: ${violation.code} (rule ${violation.ruleId})`))
    .join("; ");
}

export class Gateway {
  readonly registry: Registry;
  private readonly options: GatewayOptions;

  constructor(options: GatewayOptions = {}) {
    this.options = options;
    this.registry = Registry.load(options.dataDir);
  }

  listModels(): ModelRef[] {
    return this.registry.listModels();
  }

  getCapabilities(provider: string, model: string): ResolvedModel | undefined {
    return this.registry.resolve(provider, model);
  }

  validate(provider: string, model: string, input: ValidateInput): ValidationResult {
    return validateRequest(this.resolveOrThrow(provider, model), input);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { model, encoded, warnings } = this.prepare(request, false);
    const response = await fetchWithRetry(model.providerId, encoded, this.transportOptions(request.signal));
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new GatewayError("server", `${model.providerId} returned a non-JSON response body`, { provider: model.providerId, cause });
    }
    const decoded = codecFor(model.wire).decodeResponse(model, payload);
    decoded.warnings = [...warnings, ...decoded.warnings];
    if (this.options.includeRaw) decoded.raw = payload;
    return decoded;
  }

  /**
   * Pre-I/O failures (unknown model, validation, credentials) THROW;
   * transport/provider/decode failures arrive as a final `error` event.
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, encoded, warnings } = this.prepare(request, true);
    try {
      const response = await fetchWithRetry(model.providerId, encoded, this.transportOptions(request.signal));
      if (!response.body) throw new GatewayError("server", `${model.providerId} returned no response body`, { provider: model.providerId });
      for await (const event of codecFor(model.wire).decodeStream(model, parseSse(response.body))) {
        if (event.type === "done") event.response.warnings = [...warnings, ...event.response.warnings];
        yield event;
      }
    } catch (cause) {
      yield {
        type: "error",
        error: cause instanceof GatewayError ? cause : new GatewayError("network", `stream failed: ${String(cause)}`, { provider: model.providerId, cause })
      };
    }
  }

  private prepare(request: ChatRequest, stream: boolean): { model: ResolvedModel; encoded: EncodedRequest; warnings: Warning[] } {
    const model = this.resolveOrThrow(request.provider, request.model);
    const validation = validateRequest(model, {
      params: request.params ?? {},
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat?.type,
      stream
    });
    // carryover #5: effectiveParams is only meaningful when ok — never encode a rejected request
    if (!validation.ok) {
      throw new GatewayError("unsupported_parameter", `invalid request for ${model.providerId}:${model.modelId} — ${violationSummary(validation)}`, {
        provider: model.providerId,
        raw: validation.violations
      });
    }
    const apiKey = this.credentialFor(model.providerId);
    if (apiKey === undefined || apiKey === "") {
      throw new GatewayError("auth", `no credential configured for provider ${model.providerId}`, { provider: model.providerId });
    }
    const encoded = codecFor(model.wire).encode(
      model,
      {
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        responseFormat: request.responseFormat,
        effectiveParams: validation.effectiveParams,
        passthrough: request.passthrough,
        stream
      },
      apiKey
    );
    return { model, encoded, warnings: [...toWarnings(validation.warnings), ...encoded.warnings] };
  }

  private resolveOrThrow(provider: string, model: string): ResolvedModel {
    const resolved = this.registry.resolve(provider, model);
    if (!resolved) throw new GatewayError("invalid_request", `unknown model ${provider}:${model}`, { provider });
    return resolved;
  }

  private credentialFor(providerId: string): string | undefined {
    const credentials = this.options.credentials;
    return typeof credentials === "function" ? credentials(providerId) : credentials?.[providerId];
  }

  private transportOptions(signal?: AbortSignal) {
    return {
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      retryBaseDelayMs: this.options.retryBaseDelayMs,
      signal
    };
  }
}

export function createGateway(options: GatewayOptions = {}): Gateway {
  return new Gateway(options);
}
```

- [ ] **Step 5: Run the tests and the full suite**

```bash
npx vitest run tests/client/gateway.test.ts && npm test && npm run typecheck
```
Expected: client suite PASS (10 tests); full suite green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/codecs/index.ts src/client/gateway.ts tests/client/gateway.test.ts
git commit -m "feat: add Gateway client composing validation, codecs and transport"
```

---

### Task 10: Public exports, packaging verification, README

**Files:**
- Modify: `src/index.ts`, `README.md`

- [ ] **Step 1: Extend `src/index.ts`** — append after the existing exports:

```ts
export { GatewayError, extractErrorMessage, kindForStatus, type GatewayErrorKind } from "./errors.js";
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  FinishReason,
  ImageBlock,
  ReasoningBlock,
  ResponseFormat,
  StreamEvent,
  TextBlock,
  ToolCallBlock,
  ToolChoice,
  ToolDef,
  Usage,
  Warning
} from "./client/types.js";
export { Gateway, createGateway, type GatewayOptions } from "./client/gateway.js";
export { codecFor } from "./codecs/index.js";
export { openaiChatCodec } from "./codecs/openaiChat.js";
export { openaiResponsesCodec } from "./codecs/openaiResponses.js";
export { anthropicMessagesCodec } from "./codecs/anthropicMessages.js";
export { googleGenerativeLanguageCodec } from "./codecs/googleGenerativeLanguage.js";
export type { Codec, CodecRequest, EncodedRequest } from "./codecs/types.js";
export { authHeaders, buildUrl } from "./codecs/shared.js";
export { parseSse, type SseEvent } from "./transport/sse.js";
export { fetchWithRetry, type HttpOptions, type HttpRequest } from "./transport/http.js";
```

- [ ] **Step 2: Add a client usage section to `README.md`** (after the existing install/registry content):

```markdown
## Client usage

\`\`\`ts
import { createGateway } from "@waifucave/gateway";

const gateway = createGateway({
  credentials: { deepseek: process.env.DEEPSEEK_API_KEY! }
});

const response = await gateway.chat({
  provider: "deepseek",
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "hi" }],
  params: { "reasoning.enabled": true }
});
console.log(response.content, response.usage, response.warnings);

for await (const event of gateway.stream({ provider: "deepseek", model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] })) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
\`\`\`

Validation runs before any network call: unsupported parameters throw
`GatewayError("unsupported_parameter")` naming the violated rule; constraint
`drop`/`force`/`clamp` adjustments surface as `response.warnings`.
```

(Remove the backslashes before the backticks — they are heredoc escapes in this plan, not part of the README.)

- [ ] **Step 3: Full verification**

```bash
npm run typecheck && npm test && npm run build
npm pack --dry-run 2>&1 | grep -E "schema|zod"; echo "schema/zod grep exit: $?"
npm pack --dry-run 2>&1 | grep -c "dist/codecs"
node -e '
import("./dist/index.js").then(({ createGateway, codecFor }) => {
  const gateway = createGateway();
  const families = new Set(gateway.listModels().map((m) => m.family));
  const model = gateway.getCapabilities("deepseek", "deepseek-v4-pro");
  console.log(families.size, "families;", model.constraints.length, "constraints;", typeof codecFor("openai-chat").encode);
});'
```
Expected: all green; schema/zod grep exits 1; `dist/codecs` count ≥ 10 (js + d.ts per codec file); node prints `54 families; 2 constraints; function`.

- [ ] **Step 4: Commit and push**

```bash
git add src/index.ts README.md
git commit -m "feat: export client, codecs and transport from the package entry"
git push origin main
```

---

## Self-review notes (completed during planning)

- **Spec coverage vs MIGRATION_PLAN §4.4–4.5 and the P1 exit criteria:** codecs ✅ (Tasks 5–8, all four wires), unified request/response ✅ (Task 2), streaming events ✅ (`text-delta`/`reasoning-delta`/`tool-call-delta`/`usage`/`done`/`error`, Tasks 5–9), error taxonomy ✅ (Task 2, all nine kinds), transport with SSE/retries/timeouts/abort ✅ (Task 3), client `chat`/`stream`/`listModels`/`getCapabilities`/`validate` ✅ (Task 9). Golden quirk fixtures: DeepSeek thinking sampling-drop ✅ (Task 5 + end-to-end in Task 9), Anthropic thinking payload + reasoning round-trip ✅ (Task 7), Gemini ≤5 stops ✅ (Task 8). All five P1a carryovers covered (Tasks 1, 4, 9). `gateway serve` endpoints are P1c, not here.
- **Type consistency spot-checks:** `EncodedRequest` carries `warnings: Warning[]` (Task 4) and every codec `encode` returns it; `fetchWithRetry(provider, request, options)` matches `HttpRequest`'s `{url, headers, body}` which is structurally satisfied by `EncodedRequest` (extra `warnings` key is fine for TS structural typing — the client passes `encoded` directly); `decodeStream` is an `AsyncGenerator` satisfying the `AsyncIterable` interface member; `toWarnings` maps `ConstraintWarning.code` (`dropped|forced|clamped`) exhaustively; `validateRequest` is called with `responseFormat: request.responseFormat?.type` matching its `"json_object" | "json_schema" | undefined` input.
- **Judgment calls encoded above:** OpenRouter dialect table lives in `shared.ts` (structural property of the route surface, not a codec branch per model); `thinking.type` boolean→string transform keyed on the wireName, scoped so qwen's `enable_thinking` stays boolean; Anthropic `responseFormat` throws rather than guessing an unverified wire field; Anthropic `max_tokens` defaults to `min(limit, 4096)` and thinking budget to 1024 with a max_tokens bump (documented invariants, pinned by tests); Google `functionResponse` matches by name via an id→name map built from prior toolCall blocks, erroring on unknown ids; synthesized tool-call ids are deterministic (`call_<ordinal>`).
- **Subagent execution notes:** include the FULL task text in every subagent prompt; two-stage review per task; independently verify every implementer report (run the tests yourself — a P1a subagent fabricated a report). Tests count per task is stated in each "Expected" line; if a count differs by ±1 because vitest groups differently, verify the listed behaviors are all present instead of trusting the number.

---

## Execution record (2026-06-11)

**P1b COMPLETE and signed off** — 20 commits on `waifucave-gateway` main (`8f41a2e` → `66b1617`, pushed to GitHub), **155 tests green**, typecheck/build clean, tarball verified zod-free with a real install-and-import smoke. Executed subagent-driven with two-stage review per task; every implementer report verified independently (no fabrications this round). All 5 P1a carryovers landed (Tasks 1, 4, 9).

Notable reviewer-driven deviations from this plan:

- **errors:** `extractErrorMessage` never throws (try/catch around `JSON.stringify` for unserializable bodies) + strictness fix for `noUncheckedIndexedAccess`.
- **transport:** retryable 429/5xx response bodies are now `cancel()`ed before retrying (undici socket leak); backoff sleep is abort-aware; Retry-After empty/negative guards.
- **shared:** `setPath` throws on `__proto__`/`constructor`/`prototype` path segments (wireNames are registry-controlled; 4× codec blast radius); `applyPassthrough` pinned by tests.
- **openai-chat:** assistant messages without `tool_calls` keep string content (`""`), never `content:null` (OpenAI/DeepSeek 400 on null-without-tools).
- **openai-responses:** truncated streams (no `response.completed`) synthesize a `done` event with `finishReason:"error"` (Codec contract).
- **anthropic-messages:** empty text blocks/turns dropped (Anthropic 400s on empty content); truncation trusts a `stop_reason` captured from `message_delta` (message_stop is just the envelope).
- **google:** unconditional thought re-encode documented (Gemini 3 signature round-trip, intentionally not gated on `reasoningRoundTrip`); `thoughtSignature` on functionCall parts is DROPPED (ToolCallBlock has no signature field) — pinned as a known-lossy test.
- **client:** `chat()` guards against literal JSON `null`/scalar bodies (raw TypeError escaped the taxonomy); anthropic-wire integration test added.

**P1c / app-integration carryover (from final review, non-blocking):**
1. Gemini 3 functionCall `thoughtSignature` drop — if live tool loops need it, `ToolCallBlock` gains a `signature` field (P2/P3).
2. `fetchWithRetry` `timeoutMs` covers time-to-headers only — the P1c HTTP server must not assume it bounds a whole stream.
3. chat/stream abort asymmetry: pre-aborted `chat()` rejects with the raw abort reason; `stream()` wraps aborts as `error` events of kind `network`. Normalize or document in P1c.
4. Known data gaps from the plan header (Anthropic adaptive thinking, thinking×sampling force, DeepSeek `reasoning_effort` riding along when thinking disabled, `thinking.redacted` suspicious wireName) remain registry-data follow-ups, not code.
5. Client-level integration tests cover openai-chat + anthropic wires; responses/google are unit-tested only — add when the P1c server exercises them.
