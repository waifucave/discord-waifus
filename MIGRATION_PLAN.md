# MIGRATION PLAN — Provider System → `@starlight-ai/gateway`

Status: **draft for review** · Date: 2026-06-10

Replace `src/providers/` (static `catalog.ts` + the 2,812-line `pipelines.ts` monolith)
with **`@starlight-ai/gateway`**: a standalone, project-agnostic LLM normalization
layer living in its own repo (`starlight-ai/gateway`, npm `@starlight-ai/gateway`).
Think "local OpenRouter, but better": one unified request/response shape, a
queryable per-model capability registry, declarative quirk handling, and an HTTP
surface of its own. Discord Waifus becomes the gateway's first consumer.

---

## 1. Goals

1. **Full parameter control.** Any parameter a model supports must be reachable
   through the layer — common params normalized, provider-specific params declared
   per-model, plus a raw `passthrough` escape hatch. The layer must never be the
   limiting factor.
2. **Capability-aware gating.** Per-`(provider, model)` capability documents drive
   server-side validation, a queryable HTTP endpoint, and dynamic UI forms — the
   UI shows only what the selected model actually supports.
3. **Quirk handling as data, not code.** "DeepSeek with thinking enabled rejects
   `tool_choice: required`", "Gemini accepts at most 5 stop sequences",
   "OpenAI gpt-5.x reasoning models reject `temperature`/`top_p`" — all expressed
   as declarative constraint rules in the capability doc, enforced once.
4. **Reusability.** Zero runtime dependencies, no Discord Waifus imports, usable
   as a library or over HTTP in any future project.
5. **New catalog.** All models from `new providers.md`, routed via OpenRouter
   (default, carries everything) and direct first-party providers where they exist.

## 2. Non-goals

- Voice (xAI realtime) and moderation-classifier notes in `new providers.md` are
  WaifuCave concerns — out of scope here. This migration covers text chat models.
- Image/audio *generation*, batch APIs, fine-tuning, embeddings: out of scope for v1.
  The capability doc format leaves room for them later.
- Automatic provider fallback chains (explicit per-config routing was chosen instead).

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Normalization model | **Declarative capability docs** (data-driven engine; approach A) |
| Transport | **Direct HTTP** (`fetch` + shared SSE/retry); no provider SDKs |
| Packaging | **Separate repo** `starlight-ai/gateway`, npm `@starlight-ai/gateway`; consumed as `file:../gateway` during migration, pinned npm version after publish |
| HTTP surface | **Mountable framework-agnostic router** + Fastify plugin + standalone `gateway serve` bin; mounted in this app at `/api/llm/*` |
| Capability data | **Curated static registry** inside the package (filled via Codex research, Appendix A) + `gateway sync` drift check against OpenRouter `/models` and provider model lists |
| Routing | **Explicit `(providerId, modelId)` per config**; UI defaults to direct route when a key exists, else OpenRouter |

---

## 4. Gateway design

### 4.1 Repo layout

```
starlight-ai/gateway
├── package.json            # zero runtime deps; dev deps: typescript, vitest, zod (build-time only, see 4.2)
├── src/
│   ├── registry/           # data/*.json capability docs, loader, query API, family inheritance
│   ├── validate/           # request validation + constraint engine
│   ├── codecs/             # unified request ⇄ wire body + response parsing
│   │   ├── openaiChat.ts            # POST {base}/chat/completions
│   │   ├── openaiResponses.ts       # POST {base}/responses
│   │   ├── anthropicMessages.ts     # POST {base}/v1/messages
│   │   └── googleGenerativeLanguage.ts  # POST {base}/v1beta/models/{m}:generateContent|streamGenerateContent
│   ├── transport/          # fetch wrapper: SSE parsing, retries (429/5xx, jittered), timeouts, AbortSignal
│   ├── client/             # createGateway(...): chat(), stream(), listModels(), getCapabilities(), validate()
│   ├── server/             # request handler (Request→Response), fastify plugin, bin/gateway.ts (serve, sync)
│   └── sync/               # drift check vs OpenRouter /models + provider list endpoints
└── tests/
    ├── codecs/             # golden wire-body fixtures (see 4.12)
    ├── validate/           # constraint engine cases
    └── contract/           # recorded provider response fixtures
```

Note on zod: capability docs are validated by a build step in the gateway repo;
the published package ships plain JSON + generated TS types so the runtime stays
dependency-free.

### 4.2 Capability document schema

One doc per **model family**, with per-route overlays — routes genuinely differ
(OpenRouter normalizes some host quirks; native APIs expose more). Stable key:
`(providerId, modelId)`.

```jsonc
{
  "schema": "starlight.capability-doc.v1",
  "family": "kimi-k2.6",
  "displayName": "Kimi K2.6",
  "company": "Moonshot AI",
  "routes": [
    { "providerId": "moonshot",   "modelId": "kimi-k2.6",            "wire": "openai-chat", "overrides": {} },
    { "providerId": "openrouter", "modelId": "moonshotai/kimi-k2.6", "wire": "openai-chat", "overrides": {} }
  ],
  "limits": { "contextTokens": 0, "maxOutputTokens": 0 },          // filled by research
  "modalities": { "input": ["text"], "output": ["text"] },
  "features": {
    "streaming": true,
    "streamingUsage": true,                  // usage block in final SSE chunk
    "tools": { "supported": true, "toolChoice": ["auto","none","required","named"], "parallel": true, "parallelDisable": true, "strict": false },
    "structuredOutput": { "jsonMode": true, "jsonSchema": false, "strict": false },
    "promptCaching": { "kind": "implicit" }, // none | implicit | explicit (Anthropic cache_control)
    "assistantPrefill": false,
    "systemRole": "system",                  // system | developer | top-level | systemInstruction
    "multipleSystemMessages": true,
    "reasoningRoundTrip": false              // must opaque reasoning blocks be returned next turn (Anthropic)
  },
  "params": {
    "temperature":            { "type": "number", "min": 0, "max": 2, "step": 0.01, "default": 0.6 },
    "topP":                   { "type": "number", "min": 0, "max": 1 },
    "stopSequences":          { "type": "string[]", "maxItems": 4 },
    "reasoning.enabled":      { "type": "boolean", "default": false },
    "reasoning.effort":       { "type": "enum", "values": ["low","medium","high"], "confidence": "verified" },
    "moonshot.someNativeKnob": { "type": "number", "min": 0, "max": 1 }   // provider-scoped param: declared, validated, shown in UI
  },
  // every param descriptor also carries "wireName" (exact API field) and
  // "confidence": "verified" | "unverified" — unverified params render with a marker and skip enforcement

  "constraints": [
    { "id": "thinking-no-forced-tools",
      "when": { "param": "reasoning.enabled", "eq": true },
      "then": { "forbid": ["toolChoice:required", "toolChoice:named"] } }
  ],
  "meta": {
    "pricing": { "inputPerMTok": 0, "outputPerMTok": 0, "cachedInputPerMTok": 0 },
    "knowledgeCutoff": "",
    "deprecated": false,
    "sources": ["https://..."],
    "verifiedAt": "2026-06-10",
    "confidence": "verified"                 // verified | partial | unverified | conflicting
  }
}
```

**Constraint rule grammar.** `when`: `{param, eq|neq|gt|lt|in}` plus `allOf`/`anyOf`
combinators. `then` actions:

| Action | Behavior |
|---|---|
| `forbid: [param-or-value]` | Reject request with `unsupported_parameter` naming the violated rule |
| `drop: [param]` | Silently remove param, emit warning in response metadata (e.g., DeepSeek ignores `temperature` under thinking — drop instead of erroring) |
| `force: {param: value}` | Overwrite (e.g., Anthropic thinking forces `temperature: 1`) |
| `clamp: {param: {min,max}}` | Narrow a range conditionally |

The same rules run in the gateway (`validate/`) and in the UI (fetched from the
capability endpoint) — single source of truth for gating.

### 4.3 Unified parameter namespace — Table A (capability dimensions)

These are the columns of the research matrix and the canonical request fields.
Per model, research records: supported? range/enum? default? quirks/conditions?

| # | Dimension | Type | Known quirk examples (to verify per model) |
|---|---|---|---|
| 1 | `temperature` | number | Range 0–2 (OpenAI-style) vs 0–1 (Anthropic); **rejected** by OpenAI gpt-5.x reasoning models; **ignored** by DeepSeek when thinking; **forced to 1** by Anthropic extended thinking |
| 2 | `topP` | number | Same rejection/ignore interactions as temperature; Anthropic: use temperature *or* topP, not both |
| 3 | `topK` | int | Anthropic + Google yes; OpenAI no; varies on OpenAI-compatible hosts |
| 4 | `minP` | number | Mostly open-model hosts / OpenRouter; rarely first-party |
| 5 | `topA` | number | OpenRouter-only normalization |
| 6 | `frequencyPenalty` | number | OpenAI-compatible (−2..2); not Anthropic/Google |
| 7 | `presencePenalty` | number | Same as above |
| 8 | `repetitionPenalty` | number | OpenRouter/open-model hosts |
| 9 | `logitBias` | map | OpenAI-compatible only; token-id space differs per tokenizer |
| 10 | `seed` | int | OpenAI/compatible: best-effort determinism; absent elsewhere |
| 11 | `logprobs` / `topLogprobs` | bool/int | Max top-logprobs count varies (0–20 typical); often off for reasoning models |
| 12 | `maxOutputTokens` | int | Cap varies per model **and per route**; wire name differs (`max_tokens`, `max_output_tokens`, `max_completion_tokens`, `generationConfig.maxOutputTokens`) |
| 13 | `stopSequences` | string[] | **Gemini: max 5**; OpenAI chat: max 4; Anthropic: high limit; some reasoning modes ignore stops |
| 14 | `n` (choices) | int | OpenAI-compatible only; usually 1 elsewhere |
| 15 | `verbosity` | enum | OpenAI gpt-5.x only |
| 16 | `assistantPrefill` | bool (feature) | Anthropic: yes (last assistant message); DeepSeek: beta prefix mode; OpenAI: no |
| 17 | `reasoning.enabled` | bool | Toggleable (DeepSeek, Z.AI, Qwen hybrid, Anthropic) vs always-on (OpenAI o/gpt-5.x reasoning) vs unsupported |
| 18 | `reasoning.effort` | enum | Which levels exist (`minimal/low/medium/high/xhigh`…) differs per model; Gemini uses thinking level/budget instead |
| 19 | `reasoning.budgetTokens` | int | Anthropic (min 1024, < maxOutputTokens); Gemini budget ranges per model, −1 = dynamic |
| 20 | `reasoning.exclude` | bool | Hide reasoning from response (OpenRouter normalizes; native support varies) |
| 21 | Reasoning × sampling | constraint | See rows 1–2; record the exact rule per model |
| 22 | Reasoning × tools | constraint | **DeepSeek thinking: no `toolChoice: required`**; others vary |
| 23 | Reasoning round-trip | bool | Anthropic requires returning opaque thinking blocks during tool loops |
| 24 | `tools` (function calling) | bool | Per route: some OpenRouter hosts of open models don't support tools |
| 25 | `toolChoice` modes | enum set | `auto/none/required/named` — named-function and `required` support varies |
| 26 | `parallelToolCalls` | bool | Support + ability to *disable* both vary |
| 27 | Strict tool schemas | bool | OpenAI strict mode; Gemini OpenAPI-subset schemas; constraint quirks |
| 28 | `structuredOutput.jsonMode` | bool | `response_format: json_object` equivalents |
| 29 | `structuredOutput.jsonSchema` | bool | Strict schema mode; subset rules differ (OpenAI strict subset, Gemini responseSchema) |
| 30 | Structured output × tools | constraint | Some providers disallow simultaneously |
| 31 | Modalities: image input | bool | Formats/limits per model |
| 32 | Modalities: audio/video/pdf input | bool | Gemini broadest; Anthropic PDFs; most others text+image only |
| 33 | `streaming` | bool | Plus usage-in-stream support (`stream_options.include_usage` equivalents) |
| 34 | Prompt caching | enum | none / implicit (OpenAI, DeepSeek, Gemini implicit) / explicit (`cache_control`, TTL 5m/1h, min cacheable tokens) |
| 35 | System role handling | enum | `system` vs `developer` vs Anthropic top-level `system` vs Gemini `systemInstruction`; multiple/positional system messages allowed? |
| 36 | Context window / max output | int | Per route — OpenRouter sometimes serves reduced context vs native |
| 37 | Provider-scoped params | list | e.g., `google.safetySettings`, `openai.serviceTier`, `openai.store`, `openai.prediction`, `anthropic.serviceTier`, OpenRouter `transforms`/`provider` preferences |
| 38 | Pricing / deprecation | meta | Informational; drift-checked |

### 4.4 Codecs (wire protocols)

Four codecs cover every provider. Each codec is pure: `(unifiedRequest, capabilityDoc, routeConfig) → wire body` and `wire response → unified response`. Per-provider deltas live in the capability docs (params/constraints), **not** in codec branches; codecs only handle structural differences (message shapes, tool formats, streaming framing).

| Wire | Used by |
|---|---|
| `openai-chat` | openrouter, deepseek, xai, zai, moonshot, qwen, minimax (+ mistral/nvidia/stepfun if direct routes confirmed) |
| `openai-responses` | openai (gpt-5.x family) |
| `anthropic-messages` | anthropic |
| `google-generative-language` | google-ai-studio (Gemini + Gemma) |

### 4.5 Unified request / response

```ts
type ChatRequest = {
  provider: string; model: string;
  messages: Message[];                      // roles: system | user | assistant | tool; content blocks: text | image | document
  tools?: ToolDef[];                        // defined ONCE in JSON Schema; codecs translate
  toolChoice?: "auto" | "none" | "required" | { name: string };
  params?: Record<string, unknown>;         // validated against capability doc (incl. provider-scoped keys)
  passthrough?: Record<string, unknown>;    // merged raw into wire body, unvalidated, logged with warning
  stream?: boolean; signal?: AbortSignal;
};

type ChatResponse = {
  id: string; provider: string; model: string;
  content: ContentBlock[];                  // text | toolCall | reasoning (opaque, round-trippable)
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage: { inputTokens; outputTokens; reasoningTokens?; cachedInputTokens?; costUsd? };
  warnings: Warning[];                      // e.g., dropped params from `drop` constraints
  raw?: unknown;                            // original provider payload (debug flag)
};
```

Streaming yields normalized events: `text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `done`, `error`.

**Error taxonomy:** `auth | rate_limit | quota | invalid_request | unsupported_parameter | content_filter | timeout | server | network` — each `GatewayError` carries `provider`, `status`, `retryable`, and the raw provider error body.

### 4.6 Gateway HTTP API

Framework-agnostic handler (`(Request) => Promise<Response>`), shipped with a
Fastify plugin and a standalone bin. Mounted in Discord Waifus at `/api/llm/*`.

| Endpoint | Purpose |
|---|---|
| `GET /v1/providers` | Providers + credential-configured status |
| `GET /v1/models` | All `(provider, model)` routes with summary flags |
| `GET /v1/models/:provider/:model` | Full capability doc — **the queryable parameter endpoint**; UI builds forms from this |
| `POST /v1/chat` | Unified completion (`stream: true` for SSE) |
| `POST /v1/validate` | Dry-run validation; returns violations + effective params (UI live-gating) |

Credentials are injected by the host app (this app reads them from `StorageService`);
standalone mode reads env vars. The gateway never persists keys itself.

### 4.7 Drift sync

`gateway sync` fetches OpenRouter `/models` + native model-list endpoints, diffs
against the registry (model ids, context windows, pricing, deprecations), and
prints a report. Runs in gateway-repo CI on a schedule; failures flag stale docs,
they don't auto-mutate.

### 4.8 Gateway testing

- **Golden wire-body tests:** unified request + capability doc → exact expected JSON
  body per codec. Every quirk (dropped `temperature` under DeepSeek thinking,
  Anthropic `thinking` payload + forced sampling, Gemini ≤5 stops) is pinned as a fixture.
- **Constraint engine units:** every rule action (`forbid/drop/force/clamp`) and combinator.
- **Contract tests:** recorded real responses (success, tool calls, reasoning blocks,
  each error class) parsed into unified shape.
- **Registry validation:** CI validates every doc against the schema; ids unique;
  routes reference known providers.

---

## 5. Provider matrix — Table B

| providerId | Wire | Base URL | Credential | Status |
|---|---|---|---|---|
| `openrouter` | openai-chat | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | **Default route; carries all models** |
| `anthropic` | anthropic-messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | Direct |
| `openai` | openai-responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` | Direct |
| `google-ai-studio` | google-generative-language | `https://generativelanguage.googleapis.com` | `GOOGLE_AI_STUDIO_API_KEY` | Direct (Gemini + Gemma) |
| `deepseek` | openai-chat | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | Direct (V4 Flash/Pro only; V3.2 deprecated upstream → OpenRouter-only) |
| `xai` | openai-chat | `https://api.x.ai/v1` | `XAI_API_KEY` | Direct |
| `zai` | openai-chat | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` | Direct — general path confirmed by P0 research; current code's `/api/coding/paas/v4` (coding-plan endpoint) must change |
| `moonshot` | openai-chat | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | Direct |
| `qwen` | openai-chat | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | Direct — 3.6 Flash/Plus + 235B confirmed; Max/3.7-series OpenRouter-only (Table C) |
| `minimax` | openai-chat | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | Direct — confirmed (OpenAI-compatible text API) |
| `mistral` | openai-chat | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | Direct — confirmed (Mistral Small 4; Small 3.2 is OpenRouter-only) |
| `nvidia` | openai-chat | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | Direct — confirmed (NIM) |
| `stepfun` | openai-chat | `https://api.stepfun.ai/v1` | `STEPFUN_API_KEY` | Direct — confirmed intl route (`api.stepfun.com` is the China route) |
| `xiaomi` | openai-chat | TBD — platform.xiaomimimo.com exposes OpenAI- and Anthropic-compatible APIs; confirm exact base in P1 | `XIAOMI_API_KEY` | Direct — added after P0 research |

Resolved **OpenRouter-only** (P0, 2026-06-10): DeepSeek V3.2, Owl Alpha
(`openrouter/owl-alpha`), GPT-OSS 20B/120B (confirmed not served by the OpenAI
API), Arcee Trinity Large (first-party endpoint exists but the model id is
conflicting upstream — revisit post-v1), Mistral Small 3.2 24B (deprecated
upstream 2026-04-30), Qwen3.6 Max / Qwen3.7 Max / Qwen3.7 Plus (no confirmed
native ids). **Native-only** (no OpenRouter route found): Gemini 2.0 Flash.

## 6. Model inventory — Table C

**P0 research complete (2026-06-10).** 54 capability docs with exact slugs and
sources live in `research/p0-capability-docs/` (one JSON per company +
`findings.md`); they move to the gateway's `registry/data/` in P1. Routes below
are the researched reality, with user decisions of 2026-06-10 applied.

| Company | Model | Routes (verified) |
|---|---|---|
| Anthropic | Claude Haiku 4.5 · Sonnet 4.5 · Sonnet 4.6 · Opus 4.6 · Opus 4.7 · Fable 5 | anthropic, openrouter |
| Anthropic | ~~Mythos~~ — research found Fable 5 and Mythos 5 are **separate models**, not aliases; user decided 2026-06-10: catalog keeps Fable 5 only (Mythos 5 is limited-availability; revisit when GA) | — |
| Arcee AI | Trinity Large | **openrouter only** (native id conflicting upstream) |
| DeepSeek | V3.2 | **openrouter only** (`deepseek/deepseek-v3.2`; no native id — confirmed) |
| DeepSeek | V4 Flash · V4 Pro | deepseek, openrouter |
| Google | Gemini 2.0 Flash | **google-ai-studio only** (no OpenRouter route found) |
| Google | Gemini 2.5 Flash Lite · 2.5 Flash · 2.5 Pro · 3.1 Flash Lite | google-ai-studio, openrouter |
| Google | Gemini 3 Flash (`gemini-3-flash-preview`) · Gemini 3.1 Pro (`gemini-3.1-pro-preview`) — preview-only ids; registry tracks previews until stable ids publish | google-ai-studio, openrouter |
| Google | Gemma 4 26B A4B IT · Gemma 4 31B IT (confirmed on Gemini API; several cells unverified) | google-ai-studio, openrouter |
| MiniMax | M2.7 · M3 | minimax, openrouter |
| Mistral AI | Mistral Small 3.2 24B | **openrouter only** (deprecated upstream 2026-04-30; decided 2026-06-10) |
| Mistral AI | Mistral Small 4 (native id conflict: `mistral-small-2603` vs `+1` — flagged) | mistral, openrouter |
| Moonshot AI | Kimi K2.5 · K2.6 | moonshot, openrouter |
| NVIDIA | Nemotron 3 Super · Nemotron 3 Ultra | nvidia, openrouter |
| OpenAI | GPT-5.2 · GPT-5.4 · GPT-5.4 Mini · GPT-5.4 Nano · GPT-5.5 · GPT-5 Mini · GPT-5 Nano | openai, openrouter |
| OpenAI | GPT-OSS 20B · GPT-OSS 120B | **openrouter only** (confirmed not on the OpenAI API) |
| OpenRouter | Owl Alpha (`openrouter/owl-alpha`, ~1M ctx, currently free; alpha churn risk) | **openrouter only** |
| Qwen | Qwen3.6 Flash · Qwen3.6 Plus | qwen, openrouter |
| Qwen | Qwen3.6 Max (`qwen/qwen3.6-max-preview`) · Qwen3.7 Max · Qwen3.7 Plus | **openrouter only** (no confirmed native ids) |
| Qwen | Qwen3 235B A22B 2507 (native splits into `-thinking-` / `-instruct-` ids; one OpenRouter slug) | qwen, openrouter |
| StepFun | Step 3.5 Flash · Step 3.7 Flash | stepfun, openrouter |
| xAI | Grok 4.20 (native reasoning/non-reasoning variant slugs) · Grok 4.3 | xai, openrouter |
| Xiaomi | MiMo V2 Flash · MiMo V2.5 · MiMo V2.5 Pro | xiaomi, openrouter |
| Xiaomi | ~~MiMo V2 Pro~~ — dropped 2026-06-10: native-only, auto-routes to V2.5 since 2026-06-01, deprecates 2026-06-30 | — |
| Z.AI | GLM 4.5 Air · GLM 4.7 · GLM 5 · GLM 5.1 | zai, openrouter |

Catalog count after decisions: **54 models**. Per `new providers.md`: do **not**
add/remove models or write per-model public descriptions without consulting the user.

---

## 7. App migration

### 7.1 Deleted / moved

- **Deleted:** `src/providers/catalog.ts`, `src/providers/pipelines.ts`,
  `src/providers/types.ts` (request/result types move, see 7.5).
- **Moved to `src/orchestration/`:** all prompts, tool schemas (orchestrator
  decision, stage manager, observer, reviewer, PickNextWaifu, add_memory), context
  rendering. Tool schemas are defined **once** in unified JSON Schema form — the
  ~30 per-protocol `openAiChat*/openAiResponses*/anthropic*Tool` functions disappear;
  gateway codecs handle protocol translation.

### 7.2 Domain schema changes (`src/shared/schemas/domain.ts`)

- `ProviderIdSchema`: `z.enum([...6 ids])` → `z.string().min(1)`, validated at API
  boundaries against the gateway registry (adding a provider no longer touches the schema).
- `ReasoningConfigSchema` + `WaifuConfigSchema.generation` → single
  `params: z.record(z.string(), z.unknown()).default({})` on `AgentConfigSchema`
  and `WaifuConfigSchema`. Writes are validated via `gateway.validate()`; invalid
  params are rejected with 400 `unsupported_parameter` naming the violated rule
  (the existing 412 revision-conflict path is unchanged).
- `ProviderCredentialsSchema.providerId` likewise widens to string; new providers
  (openrouter, moonshot, qwen, minimax, …) need no schema edits.
- Bump `CURRENT_SCHEMA_VERSION`; ship migration (7.3).

### 7.3 Storage migration (one `runMigrations` step)

Convert every stored `AgentConfig`/`WaifuConfig`:

`reasoning.{enabled,effort,budgetTokens}` → `params["reasoning.enabled"|"reasoning.effort"|"reasoning.budgetTokens"]`;
`generation.{temperature,topP,maxOutputTokens}` → `params["temperature"|"topP"|"maxOutputTokens"]`.

Model id remap (old `(providerId, modelId)` → new route). Unmappable ids get a
**doctor warning** and a conservative substitute rather than a cleared config:

| Old | New | Note |
|---|---|---|
| `xai/grok-4.3` | `xai/grok-4.3` | verify final native id |
| `xai/grok-4.20-0309-{reasoning,non-reasoning}` | `xai/grok-4.20` | variants collapse into `reasoning.enabled` param (verify) |
| `deepseek/deepseek-v4-{flash,pro}` | same | |
| `anthropic/claude-{opus-4-7,sonnet-4-6,haiku-4-5-20251001}` | same | |
| `openai/gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano` | same | |
| `openai/gpt-4o` | `openai/gpt-5-mini` | not in new catalog; doctor warning |
| `openai/gpt-4o-mini` | `openai/gpt-5-nano` | not in new catalog; doctor warning |
| `zai/glm-{4.7,5,5.1}` | same | |
| `zai/glm-5-turbo` | `zai/glm-5` | not in new catalog; doctor warning |
| `google-ai-studio/gemini-2.5-flash{,-lite}` | same | |
| `google-ai-studio/gemini-3-flash-preview` | same | stable id not yet published |
| `google-ai-studio/gemini-3.5-flash` | `google-ai-studio/gemini-3-flash-preview` | not in new catalog; doctor warning |
| `google-ai-studio/gemini-3.1-flash-lite` | same | |

Migration tests follow house style: real temp data roots, no mocks.

### 7.4 API server (`src/api/server.ts`)

- Mount gateway Fastify plugin at `/api/llm/*` (credentials injected from `StorageService`).
- `/api/models` + provider listing in `/api/...` become thin proxies over the
  gateway registry (kept for frontend compatibility, may be dropped once the
  frontend consumes `/api/llm/*` directly).
- Provider CRUD gains the new provider ids; validation of `(providerId, modelId)`
  pairs and `params` happens through the gateway.

### 7.5 Orchestration rewrite (`src/orchestration/`, `src/providers/types.ts` types)

`ModelPipeline` (generateWaifu / decideOrchestrator / decideStageManagerObservations /
decideStageManager / decideReviewer) survives as an app-side interface with **one**
implementation built on the gateway client: build unified messages + tools + params
→ `gateway.chat()` → parse tool calls from the normalized response. Existing zod
parsing of tool arguments (orchestrator decision, stage manager edits, observations,
reviewer verdict) is kept as-is on top of normalized `toolCall` blocks. Reasoning
round-trip (Anthropic thinking + tools) is handled by passing prior `reasoning`
content blocks back — the gateway makes this transparent.

### 7.6 Frontend

- Delete hand-mirrored capability types in `src/frontend/api/types.ts`; capability
  docs come from `/api/llm/v1/models/:provider/:model`.
- Replace `ReasoningControls.tsx` + per-view sampling fields with a generic
  **`ModelParamsForm`**: renders controls from param descriptors (number → slider/
  input with min/max/step, enum → select, boolean → toggle, string[] → tag input
  with maxItems), applies constraint rules live (disable/forbid/force), uses
  `POST /v1/validate` before save.
- Model picker becomes two-level: model → route (provider), defaulting to direct
  when a key is configured, else OpenRouter.
- Views touched: `ProvidersView`, `WaifusView`, `OrchestratorView`,
  `StageManagerView`, `ReviewerView`.

---

## 8. Phases

| Phase | Work | Exit criteria |
|---|---|---|
| **P0 — Research** ✅ done 2026-06-10 | Appendix A ran in Codex; output validated (55 docs, 0 schema problems), decisions applied (→54 docs), staged in `research/p0-capability-docs/` | Met: every Table C model has a sourced doc; uncertain cells marked `unverified`/`partial`/`conflicting` |
| **P1 — Gateway core** | New repo: registry, validate, codecs, transport, client, server, sync, tests | `npm test` green; `gateway serve` answers all 5 endpoints; golden fixtures cover every quirk in Table A rows 1–35 |
| **P2 — Side-by-side** | Add `file:../gateway` dep; mount `/api/llm/*`; `/api/models` proxies registry. `pipelines.ts` still serves traffic | Both old and new model lists visible; no behavior change in chat |
| **P3 — Orchestration cutover** | Rewrite `ModelPipeline` on gateway client; move prompts/tools; delete `pipelines.ts` + `catalog.ts` | All orchestration tests pass against fake-transport gateway; live smoke test on a dev Discord server |
| **P4 — Storage + domain** | Schema changes (7.2), migration (7.3), doctor warnings | Migration tests green; old configs load and run |
| **P5 — Frontend** | `ModelParamsForm`, dynamic capability fetching, route picker | UI shows only supported params per model; invalid combos blocked client- and server-side |
| **P6 — Harden** | Publish `@starlight-ai/gateway@0.1.0`, switch to pinned version; drift-check CI in gateway repo | App installs from npm; `gateway sync` clean |

Rough dependency: P0 ∥ P1-scaffolding, then P1 → P2 → P3 → P4 → P5 → P6.

## 9. Risks & open questions

- **Research quality:** several catalog models are very new; some cells may be
  unverifiable. Mitigation: `confidence` field; `unverified` params render in UI
  with a marker; constraints only enforced when `verified`.
- **OpenRouter route variance:** the same model can behave differently across
  OpenRouter's underlying hosts (tools/logprobs vary). Mitigation: per-route
  overlays; optionally pin OpenRouter `provider` preferences via provider-scoped params.
- **Anthropic thinking + tool loops** (signature round-trip) is the most intricate
  codec path — covered by dedicated contract fixtures.
- **`file:` dep friction** during P2–P5 (rebuild on change). Acceptable for one
  consumer; publish early once stable.
- **DeepSeek thinking × forced tool choice — validated live 2026-06-10:** P0
  research claimed the restriction was lifted in V4, but a live API test shows
  both V4 Flash and V4 Pro return HTTP 400 ("Thinking mode does not support this
  tool_choice") for `tool_choice: required` and named tool choice while thinking
  is enabled (thinking+auto and no-thinking+required both succeed). The
  `thinking-no-forced-tools` constraint is now in the registry data. Lesson:
  research cells marked `verified` can still be wrong — quirk-critical cells get
  live probes before the registry ships (folded into P1 testing).
- **Open (post-P0):** exact Xiaomi API base URL (resolve in P1); Mistral Small 4
  native id conflict (`mistral-small-2603` vs `+1`); Gemini 3 Flash / 3.1 Pro and
  Qwen3.6 Max are preview-only ids — drift check watches for stable ids;
  per-cell `unverified` items listed in `research/p0-capability-docs/findings.md`
  (notably Moonshot/Z.AI tool-choice details and Gemma output caps).

---

## Appendix A — Codex research prompt

Paste everything in the block below into Codex (GPT-5.5, xhigh). Output lands as
JSON files matching §4.2 plus a findings report.

````markdown
You are coordinating a model-capability research project. Spawn one subagent per
provider listed below (parallel where possible); each subagent researches ONLY its
provider's models and returns structured JSON. You then merge results, cross-check
the OpenRouter rows against first-party rows, and produce the final deliverables.

# Deliverables
1. One JSON file per company, named `<company>.json`, an array of capability docs
   following the schema in "Output schema" below.
2. `findings.md`: every cell you could NOT verify (mark `unverified`), every
   conflict between sources (mark `conflicting`, list both sources), every model
   whose existence/slug you could not confirm, and every first-party endpoint
   whose availability you could not confirm.

# Hard rules
- NEVER guess. A wrong "supported: true" is worse than "unverified".
- Every non-default cell needs at least one source URL (official API docs,
  official model cards, OpenRouter model page). Prefer official docs; use
  OpenRouter pages for OpenRouter slugs/pricing/context.
- Record the EXACT API model id for the native route and the EXACT OpenRouter
  slug separately. Display names are not slugs.
- Check deprecation/availability status for every model.
- Capabilities are PER ROUTE: a model via its creator's API may differ from the
  same model via OpenRouter (context window, tools, logprobs). Record differences
  as route `overrides`.

# Providers and models to research
(native route to verify + openrouter route for every model)
- Anthropic (api.anthropic.com, Messages API): Claude Haiku 4.5; Claude Sonnet 4.5;
  Claude Sonnet 4.6; Claude Opus 4.6; Claude Opus 4.7; Claude Fable 5 (may appear
  under alias "Mythos" — confirm official name and slug)
- Arcee AI (FIRST: does a first-party inference endpoint exist? If yes, which base
  URL/auth?): Trinity Large
- DeepSeek (api.deepseek.com): DeepSeek V3.2 (confirm deprecated upstream →
  OpenRouter-only), DeepSeek V4 Flash, DeepSeek V4 Pro
- Google AI Studio (generativelanguage.googleapis.com): Gemini 2.0 Flash; Gemini
  2.5 Flash Lite; Gemini 2.5 Flash; Gemini 2.5 Pro; Gemini 3 Flash; Gemini 3.1
  Flash Lite; Gemini 3.1 Pro; Gemma 4 26B A4B IT; Gemma 4 31B (confirm Gemma
  availability on the Gemini API)
- MiniMax (confirm current intl base URL + OpenAI-compatible mode): M2.7; M3
- Mistral (api.mistral.ai): Mistral Small 3.2 24B; Mistral Small 4
- Moonshot AI (api.moonshot.ai): Kimi K2.5; Kimi K2.6
- NVIDIA (integrate.api.nvidia.com NIM — confirm availability/limits): Nemotron 3
  Super; Nemotron 3 Ultra
- OpenAI (api.openai.com, Responses API): GPT-5.2; GPT-5.4; GPT-5.4 Mini; GPT-5.4
  Nano; GPT-5.5; GPT-5 Mini; GPT-5 Nano. GPT-OSS 20B and GPT-OSS 120B are
  open-weight: confirm they are NOT on the OpenAI API and find OpenRouter slugs.
- OpenRouter-native: Owl Alpha — identify owner, slug, status (alpha models churn)
- Qwen (DashScope international, compatible-mode): Qwen3.6 Flash; Qwen3.6 Max;
  Qwen3.6 Plus; Qwen3.7 Max; Qwen3.7 Plus; Qwen3 235B A22B 2507
  (qwen/qwen3-235b-a22b-2507 on OpenRouter). Note which are intl-available.
- StepFun (api.stepfun.com — confirm intl signup viability): Step 3.5 Flash;
  Step 3.7 Flash
- xAI (api.x.ai): Grok 4.20 (one model or reasoning/non-reasoning variants?);
  Grok 4.3
- Xiaomi (likely open-weight, OpenRouter-only — confirm): MiMo V2 Flash; MiMo V2
  Pro; MiMo V2.5; MiMo V2.5 Pro
- Z.AI (confirm GENERAL api base path, NOT the coding-plan path
  /api/coding/paas/v4): GLM 4.5 Air; GLM 4.7; GLM 5; GLM 5.1

# Dimensions to fill per model per route
For each, record: supported yes/no/unverified; range or enum values; default;
wire-level parameter name; conditions/quirks.

Sampling: temperature (range! 0–1 vs 0–2), top_p, top_k, min_p, top_a,
frequency_penalty, presence_penalty, repetition_penalty, logit_bias, seed,
logprobs + top_logprobs (max count).
Output: max output tokens (cap + wire name), stop sequences (MAX COUNT — e.g.
Gemini 5, OpenAI chat 4 — and length limits), n choices, verbosity, assistant
prefill / prefix-completion support.
Reasoning: toggleable vs always-on vs none; effort levels (exact enum); budget
tokens (range, dynamic value); can reasoning be excluded from output; sampling
params rejected/ignored/forced when reasoning is on (be exact: rejected-with-error
vs silently-ignored vs forced-to-value); tool_choice restrictions when reasoning
is on (e.g., DeepSeek thinking forbids forced tool choice); must reasoning blocks
be returned in subsequent turns during tool loops (Anthropic signatures).
Tools: function calling supported; tool_choice modes (auto/none/required/named
function); parallel tool calls (+ can it be disabled); strict schema mode; JSON
Schema subset restrictions; max tools limits if documented.
Structured output: json mode; json schema mode; strictness; schema subset rules;
conflicts with tools or streaming.
Modalities: image input (formats, max images/size); audio input; video input;
PDF/document input; anything beyond text out.
Streaming: SSE support; usage reported in stream; tool-call streaming.
Caching: implicit vs explicit prompt caching; min cacheable tokens; TTL options;
cache pricing.
System/roles: system vs developer role; top-level system field vs in-messages;
multiple system messages allowed; strict user/assistant alternation required.
Limits/meta: context window (per route), max output tokens (per route), pricing
per MTok (input/output/cached), knowledge cutoff, deprecation status.
Provider-specific extras worth exposing as namespaced params: e.g. Google
safetySettings, OpenAI service_tier/store/prediction, Anthropic service tiers,
OpenRouter transforms/provider-preferences/reasoning normalization.

# Output schema (per model)
{
  "schema": "starlight.capability-doc.v1",
  "family": "<kebab-id>", "displayName": "", "company": "",
  "routes": [{ "providerId": "", "modelId": "<EXACT id>", "wire":
    "openai-chat|openai-responses|anthropic-messages|google-generative-language",
    "overrides": { /* any field below that differs on this route */ } }],
  "limits": { "contextTokens": 0, "maxOutputTokens": 0 },
  "modalities": { "input": ["text"], "output": ["text"] },
  "features": { "streaming": true, "streamingUsage": true,
    "tools": { "supported": true, "toolChoice": ["auto","none","required","named"],
               "parallel": true, "parallelDisable": true, "strict": false },
    "structuredOutput": { "jsonMode": false, "jsonSchema": false, "strict": false },
    "promptCaching": { "kind": "none|implicit|explicit" },
    "assistantPrefill": false,
    "systemRole": "system|developer|top-level|systemInstruction",
    "multipleSystemMessages": true, "reasoningRoundTrip": false },
  "params": { "<name>": { "type": "number|int|boolean|enum|string|string[]|map",
    "min": 0, "max": 0, "step": 0, "values": [], "maxItems": 0, "default": null,
    "wireName": "<exact api field>", "confidence": "verified|unverified" } },
  "constraints": [{ "id": "", "when": { "param": "", "eq": null },
    "then": { "forbid": [], "drop": [], "force": {}, "clamp": {} },
    "source": "<url>" }],
  "meta": { "pricing": { "inputPerMTok": 0, "outputPerMTok": 0,
    "cachedInputPerMTok": 0 }, "knowledgeCutoff": "", "deprecated": false,
    "sources": [], "verifiedAt": "<ISO date>", "confidence": "verified" }
}

Use dotted names for reasoning params ("reasoning.enabled", "reasoning.effort",
"reasoning.budgetTokens", "reasoning.exclude") and provider-scoped names for
native extras ("google.safetySettings", "openai.serviceTier", ...).

# Process
1. Spawn one subagent per company above. Each returns its JSON + per-cell sources.
2. Spawn one extra subagent for OpenRouter slugs/pricing/context across ALL models.
3. Merge; where OpenRouter data conflicts with first-party data, keep both as
   route differences if plausible, otherwise mark "conflicting" in findings.md.
4. Validate every JSON doc against the output schema before finishing.
````

## Appendix B — Worked example

A filled doc for one quirk-heavy model (DeepSeek V4 Pro shape, values illustrative —
research replaces them):

```jsonc
{
  "schema": "starlight.capability-doc.v1",
  "family": "deepseek-v4-pro",
  "displayName": "DeepSeek V4 Pro",
  "company": "DeepSeek",
  "routes": [
    { "providerId": "deepseek",   "modelId": "deepseek-v4-pro",          "wire": "openai-chat", "overrides": {} },
    { "providerId": "openrouter", "modelId": "deepseek/deepseek-v4-pro", "wire": "openai-chat", "overrides": {} }
  ],
  "limits": { "contextTokens": 1000000, "maxOutputTokens": 384000 },
  "modalities": { "input": ["text"], "output": ["text"] },
  "features": {
    "streaming": true, "streamingUsage": true,
    "tools": { "supported": true, "toolChoice": ["auto","none","required","named"], "parallel": true, "parallelDisable": true, "strict": false },
    "structuredOutput": { "jsonMode": true, "jsonSchema": false, "strict": false },
    "promptCaching": { "kind": "implicit" },
    "assistantPrefill": true,
    "systemRole": "system", "multipleSystemMessages": true, "reasoningRoundTrip": false
  },
  "params": {
    "temperature": { "type": "number", "min": 0, "max": 2, "default": 1, "wireName": "temperature" },
    "topP": { "type": "number", "min": 0, "max": 1, "wireName": "top_p" },
    "maxOutputTokens": { "type": "int", "min": 1, "max": 384000, "wireName": "max_tokens" },
    "stopSequences": { "type": "string[]", "maxItems": 16, "wireName": "stop" },
    "frequencyPenalty": { "type": "number", "min": -2, "max": 2, "wireName": "frequency_penalty" },
    "presencePenalty": { "type": "number", "min": -2, "max": 2, "wireName": "presence_penalty" },
    "reasoning.enabled": { "type": "boolean", "default": false, "wireName": "thinking" }
  },
  "constraints": [
    { "id": "thinking-ignores-sampling",
      "when": { "param": "reasoning.enabled", "eq": true },
      "then": { "drop": ["temperature", "topP", "frequencyPenalty", "presencePenalty"] },
      "source": "https://api-docs.deepseek.com/..." },
    { "id": "thinking-no-forced-tools",
      "when": { "param": "reasoning.enabled", "eq": true },
      "then": { "forbid": ["toolChoice:required", "toolChoice:named"] },
      "source": "https://api-docs.deepseek.com/..." }
  ],
  "meta": { "pricing": { "inputPerMTok": 0, "outputPerMTok": 0, "cachedInputPerMTok": 0 },
    "knowledgeCutoff": "", "deprecated": false, "sources": [], "verifiedAt": "2026-06-10", "confidence": "unverified" }
}
```
