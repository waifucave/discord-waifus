# Gateway P3a: ModelPipeline on the Gateway Client (Side-by-Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ONE gateway-backed `ModelPipeline` implementation (MIGRATION_PLAN §7.5) side-by-side with `src/providers/pipelines.ts` — all six methods (`generateWaifu`, `decideOrchestrator`, `decideStageManagerObservations`, `decideDream`, `decideReviewer`, `generatePersonaDigest`) working against fake-transport gateways, with zero call-site changes. P3b (separate plan) does the cutover, the legacy-id shim, the deletions, and the live smoke.

**Architecture:** A `GatewayModelPipeline` class in `src/orchestration/pipeline/` implements the existing `ModelPipeline` interface verbatim. ONE unified message builder replaces the ×4 per-protocol builders: capability-driven branching only (the model's `systemRole`/`multipleSystemMessages` from `gateway.getCapabilities()` decides real `system` turns vs `<system_note>`-wrapped user turns — never `if (provider === ...)`). Tool JSON-Schemas move to `src/orchestration/tools.ts` as the single source (pipelines.ts re-imports them — its wire bodies must not change). Old-shape configs (`ReasoningConfig` + `generation`) map to unified gateway params through a pre-conform step that uses `gateway.validate()` to drop unsupported optional params and to resolve forced-tool×thinking conflicts data-driven. Query logging stays intact via a role-tagging `fetchImpl` wrapper.

**Tech Stack:** TypeScript ESM NodeNext (`.js` on local imports), `@waifucave/gateway` (file: dep, registry at `c279736`), Vitest with `vi.fn` fetch fakes (the sanctioned network seam), zod parsing of tool arguments kept as-is.

**Repo:** `/Users/example/Xcode projects/Discord Waifus` (quote the space). Commit to `main`. Do NOT touch the gateway repo. Baseline: **593 passed | 15 skipped** across 24 files; typecheck clean.

---

## Hard rules

1. **pipelines.ts behavior must not change.** The ONLY edits allowed there are import-shuffles when a function moves to `src/orchestration/` (the function body moves verbatim; pipelines.ts imports it). `tests/pipelines.test.ts` (2918 lines, heavy wire-body goldens) must stay green untouched — it is the proof.
2. **The `ModelPipeline` interface and all request/response types in `src/providers/types.ts` are frozen.** `tests/runtime.test.ts` fakes the pipeline at interface level in 107 places; nothing in this plan may ripple there.
3. **No call-site changes.** `runtime.ts`/`server.ts` keep constructing `createModelPipeline`. The new factory is exported and tested but unused by production code until P3b.
4. **No per-provider branches in the new code.** Branch only on gateway capability data (`wire`, `systemRole`, `multipleSystemMessages`, param descriptors, constraint validation results). One justified exception, marked in Task 1: Google's flattened dream-tool schema, selected by `wire === "google-generative-language"`.
5. **Gateway repo read-only.** A genuine gateway bug is STOP-and-report (then fixed TDD in its repo as a separate decision), not a workaround buried here.
6. Stage only files your task names. Untracked `research/`, `new providers.md` exist — never add them. Run `git status` before each commit.

## Verified facts (audited 2026-06-12, post-W1–W4; app @ `4a6743c`, gateway @ `c279736`)

- `ModelPipeline` + request/response types: `src/providers/types.ts` (112 lines). `ProviderRequest` carries `modelId` but **not** `providerId` — today provider is derived via `getProviderForModel(modelId)` from the catalog. The new factory takes explicit `(providerId, modelId)`; P3b owns resolving these at call sites.
- Tool schema builders live in `pipelines.ts`: `orchestratorToolParameters(availableWaifuIds?, replyRequired, directiveBudgetOpen)` (:1279), `shortTermMemoryToolParameters()` (:1265, tool `add_memory`), `pickNextWaifuToolParameters(availableWaifuIds?)` (:1372, tool `PickNextWaifu`), `dreamToolParameters()` (:1472) + `flatDreamToolParameters()` (:1565, Gemini rejects nested objects under forced tools), `observerToolParameters(availableWaifuIds?)` (:1428, tool `record_observations`), `PERSONA_DIGEST_TOOL_PARAMETERS` (:1405, tool `set_persona_digest`), `REVIEWER_TOOL_PARAMETERS` (:1242, tool `review_message`), plus name consts `ORCHESTRATOR_TOOL_NAME`/`SHORT_TERM_MEMORY_TOOL_NAME`/`PICK_NEXT_WAIFU_TOOL_NAME`/`DREAM_TOOL_NAME`/`OBSERVER_TOOL_NAME` and in-file prompts `DREAM_PROMPT` (:1197), `observerSystemPrompt(custom?)` (:1157 area), `reviewerSystemPrompt(custom?)` (:1221), `PERSONA_DIGEST_PROMPT` (:1403).
- Decision replay: `serializeOrchestratorDecisionArguments` (:915, lossy: intent-only directives, reasoning clipped 160) and `formatDecisionOutcome` (:929, tool-result text: "sent"/"paused Ns"/per-waifu outcomes). Timeline core `buildOrchestratorTimeline` (:884): gap notes ≥15 min, past decisions filtered to ≥ oldest message ts, wake markers; sort by ts then kind rank note<message<decision.
- Waifu context roles: self = `authorKind === "waifu"` && `selfAuthorIds.includes(authorId)` → assistant turn rendered with `formatSelfWaifuContent` (raw body); everything else → user turn via `formatWaifuContextBlock`. `midSystemBlock` injects at `contextLen - 2`; `trailingSystemBlock` after; `retryUserMessage` is a final user turn. Anthropic/Google wrap mid+trailing in `<system_note>…</system_note>` user turns (`systemNoteTurn` :2910); OpenAI-family uses real `system` turns.
- Old config → params: `ReasoningConfig {enabled?, effort? (none|minimal|low|medium|high|max|xhigh), budgetTokens?}`; `generation {temperature?, topP?, maxOutputTokens?}`. Decision methods hardcode `temperature ?? 0.2` (reviewer `?? 0`).
- Gateway surface (from `@waifucave/gateway`): `Gateway`/`createGateway({credentials, fetchImpl, includeRaw, dataDir})`; `gateway.chat({provider, model, messages, tools, toolChoice, params, signal}) → {content: Array<TextBlock|ReasoningBlock|ToolCallBlock>, finishReason, usage {inputTokens, outputTokens, reasoningTokens?, cachedInputTokens?}, warnings}`; `gateway.validate(provider, model, {params, toolChoice}) → {ok, violations[{ruleId?, param, code, ...}], warnings, effectiveParams}`; `gateway.getCapabilities(provider, model) → ResolvedModel {wire, features {tools {toolChoice[]}, systemRole, multipleSystemMessages, structuredOutput, streaming}, params (descriptors incl. maxItems), limits, ...}` or `undefined`. `ChatMessage` roles: system (string content), user (string | Array<TextBlock|ImageBlock>), assistant (string | Array<TextBlock|ReasoningBlock|ToolCallBlock>), tool ({toolCallId, content}). `ToolCallBlock.arguments` is a JSON string. **`ImageBlock` is `{type:"image", mimeType, data}` — base64 only, no URLs**: the unified builder fetches and inlines images (today only the Google path does; its helper logic is the port source).
- DeepSeek thinking defaults ON in registry data; `thinking-no-forced-tools` forbids `toolChoice: required|named` while enabled — `gateway.validate` reports it as `{ruleId:"thinking-no-forced-tools", param:"toolChoice", code:"forbidden_value"}`. Today pipelines.ts forces thinking off for deepseek forced-tool decisions (`openAiChatReasoningForForcedTool`); the new pre-conform generalizes this from validation results, not provider names.
- Pinned P2 golden (re-usable in tests): deepseek-v4-pro chat with `{temperature:0.7, "reasoning.enabled":true}` → body `{"model":"deepseek-v4-pro","thinking":{"type":"enabled"},"reasoning_effort":"high","messages":[...]}` + `param_dropped` warnings for temperature/topP.
- Query log: `recordProviderQuery(role, payload)` / `recordProviderReply(role, payload)` from `src/shared/queryLog.ts`; roles include `"dream"`. Today called inside `postJsonAndExtractText`.
- App timeout: 180 s app-side (`providerRequestSignal`); gateway `timeoutMs` covers time-to-headers only.
- NOT in P3a: call-site wiring, legacy-id mapping (`gpt-4o`→`gpt-5-mini`, `gpt-4o-mini`→`gpt-5-nano`, `glm-5-turbo`→`glm-5`, `gemini-3.5-flash`→`gemini-3-flash-preview`), `/api/models` legacy-field rewire, deletions, frontend `ReasoningControls` literals, live smoke — ALL P3b. Anthropic thinking-block replay in tool loops: NOT needed (audited: no thinking-block replay exists anywhere today; decisions replay as plain tool_use).

## File structure

```
src/orchestration/
├── tools.ts                      # T1 NEW: all tool names + JSON-Schema builders + googleAiStudioSchema sanitizer + static prompts (moved verbatim from pipelines.ts; pipelines.ts re-imports)
└── pipeline/
    ├── params.ts                 # T2 NEW: config→unified-params mapping + preconformRequest() via gateway.validate
    ├── messages.ts               # T3 NEW: unified waifu-context builder (roles, images→base64, capability-driven system placement)
    ├── timeline.ts               # T4 NEW: unified orchestrator timeline (gap notes, wake markers, decision replay as toolCall + tool results)
    └── gatewayPipeline.ts        # T5–T7 NEW: GatewayModelPipeline (6 methods) + createGatewayModelPipeline factory + role-tagged Gateway cache
tests/
├── pipelines.test.ts             # UNTOUCHED (proof of rule 1)
├── orchestrationTools.test.ts    # T1 NEW: schema-identity pins
├── gatewayParams.test.ts         # T2 NEW
├── gatewayMessages.test.ts       # T3 NEW
├── gatewayTimeline.test.ts       # T4 NEW
└── gatewayPipeline.test.ts       # T5–T8 NEW: per-method contracts + cross-wire golden matrix
```

Dependency direction: `gatewayPipeline.ts` → (`params.ts`, `messages.ts`, `timeline.ts`, `tools.ts`, `@waifucave/gateway`, `src/providers/types.ts` [interface only], `src/orchestration/{context,decisions,stageManager,reviewer}.ts`, `src/shared/queryLog.ts`). `pipelines.ts` → `tools.ts` (re-import only).

---

### Task 1: Extract tool schemas + static prompts to `src/orchestration/tools.ts`

Move-verbatim refactor. Every tool name const, every `*ToolParameters` builder, `googleAiStudioSchema` (the Gemini schema sanitizer), and the four in-file prompts (`DREAM_PROMPT`, `observerSystemPrompt`, `reviewerSystemPrompt`, `PERSONA_DIGEST_PROMPT`) move from `pipelines.ts` to the new module; `pipelines.ts` deletes its local copies and imports them. Wire bodies cannot change — the untouched pipelines suite is the referee.

**Files:** Create `src/orchestration/tools.ts`; Modify `src/providers/pipelines.ts` (imports only + deletions of moved code); Test `tests/orchestrationTools.test.ts`.

- [ ] **Step 1: Write the failing identity test**

```ts
// tests/orchestrationTools.test.ts
import { describe, expect, it } from "vitest";
import {
  DREAM_TOOL_NAME, OBSERVER_TOOL_NAME, ORCHESTRATOR_TOOL_NAME,
  PERSONA_DIGEST_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_NAME, REVIEWER_TOOL_NAME,
  SHORT_TERM_MEMORY_TOOL_NAME,
  dreamToolParameters, flatDreamToolParameters, observerToolParameters,
  orchestratorToolParameters, personaDigestToolParameters,
  pickNextWaifuToolParameters, reviewerToolParameters, shortTermMemoryToolParameters,
  googleAiStudioSchema
} from "../src/orchestration/tools.js";
import { ORCHESTRATOR_TOOL_PARAMETERS } from "../src/providers/pipelines.js";

describe("orchestration/tools", () => {
  it("exports the canonical tool names", () => {
    expect(ORCHESTRATOR_TOOL_NAME).toBe("orchestrator_decision");
    expect(SHORT_TERM_MEMORY_TOOL_NAME).toBe("add_memory");
    expect(PICK_NEXT_WAIFU_TOOL_NAME).toBe("PickNextWaifu");
    expect(DREAM_TOOL_NAME).toBe("dream_memories");
    expect(OBSERVER_TOOL_NAME).toBe("record_observations");
    expect(PERSONA_DIGEST_TOOL_NAME).toBe("set_persona_digest");
    expect(REVIEWER_TOOL_NAME).toBe("review_message");
  });

  it("pipelines.ts re-exports the SAME orchestrator schema object (single source)", () => {
    expect(ORCHESTRATOR_TOOL_PARAMETERS).toEqual(orchestratorToolParameters(undefined, false, true));
  });

  it("schema builders produce stable shapes", () => {
    const orch = orchestratorToolParameters(["yuki", "riko"], true, false);
    expect(orch.properties).toHaveProperty("respondingWaifus");
    expect(JSON.stringify(orch)).toContain("yuki");
    expect(pickNextWaifuToolParameters(["a"]).properties).toBeDefined();
    expect(dreamToolParameters().properties).toHaveProperty("ops");
    expect(flatDreamToolParameters()).not.toEqual(dreamToolParameters());
    expect(observerToolParameters(undefined).properties).toHaveProperty("observations");
    expect(shortTermMemoryToolParameters().properties).toBeDefined();
    expect(personaDigestToolParameters().properties).toHaveProperty("voice");
    expect(reviewerToolParameters().properties).toHaveProperty("hallucination");
  });

  it("googleAiStudioSchema strips additionalProperties and anyOf", () => {
    const cleaned = googleAiStudioSchema({
      type: "object",
      additionalProperties: false,
      properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } }
    } as Record<string, unknown>);
    expect(JSON.stringify(cleaned)).not.toContain("additionalProperties");
    expect(JSON.stringify(cleaned)).not.toContain("anyOf");
  });
});
```

NOTE for the implementer: `PERSONA_DIGEST_TOOL_PARAMETERS` and `REVIEWER_TOOL_PARAMETERS` are inline consts today (pipelines.ts:1405, :1242) — in tools.ts wrap them as zero-arg functions `personaDigestToolParameters()` / `reviewerToolParameters()` returning the same object, AND keep exporting the original const names for pipelines.ts compatibility (`export const PERSONA_DIGEST_TOOL_PARAMETERS = personaDigestToolParameters();` etc.). If a pinned assertion above mismatches the actual current schema shape (e.g. property names differ), print the real shape and fix the TEST — the moved code is the authority.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/orchestrationTools.test.ts` → FAIL (module not found).

- [ ] **Step 3: Create `src/orchestration/tools.ts`** — move these from `pipelines.ts` VERBATIM (bodies unchanged): the seven name consts; `orchestratorToolParameters`, `shortTermMemoryToolParameters`, `pickNextWaifuToolParameters`, `dreamToolParameters`, `flatDreamToolParameters`, `observerToolParameters`; the `PERSONA_DIGEST_TOOL_PARAMETERS` / `REVIEWER_TOOL_PARAMETERS` consts (plus the new function wrappers); `googleAiStudioSchema`; `DREAM_PROMPT`, `observerSystemPrompt`, `reviewerSystemPrompt`, `PERSONA_DIGEST_PROMPT`. Bring along any tiny private helpers these functions close over (move, don't duplicate). Then in `pipelines.ts`: delete the moved definitions, add one import block from `../orchestration/tools.js`, and keep its existing re-exports (`ORCHESTRATOR_TOOL_PARAMETERS`, `DREAM_TOOL_PARAMETERS`, `OBSERVER_TOOL_PARAMETERS`) as `export { ... } from "../orchestration/tools.js";` so existing test imports keep working.

- [ ] **Step 4: Verify** — `npx vitest run tests/orchestrationTools.test.ts tests/pipelines.test.ts` → both PASS (pipelines suite green proves wire identity).

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/tools.ts src/providers/pipelines.ts tests/orchestrationTools.test.ts
git commit -m "refactor: move tool schemas and decision prompts to orchestration/tools"
```
Expected: 593+4 = 597 passed | 15 skipped.

---

### Task 2: Params adapter + pre-conform (`src/orchestration/pipeline/params.ts`)

Maps old config shapes to unified gateway params, then pre-conforms via `gateway.validate()`: (a) violating OPTIONAL params (sampling, reasoning knobs, stop sequences) are dropped/truncated; (b) a forced-tool violation caused by reasoning (`forbidden_value` on `toolChoice`) is resolved by disabling reasoning for that call (the data-driven generalization of today's deepseek special-case); (c) anything still violating after that throws `ProviderPipelineError`-equivalent (`GatewayPipelineError`).

**Files:** Create `src/orchestration/pipeline/params.ts`; Test `tests/gatewayParams.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/gatewayParams.test.ts
import { describe, expect, it } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { buildUnifiedParams, preconformRequest } from "../src/orchestration/pipeline/params.js";

const gateway = createGateway({});

describe("buildUnifiedParams", () => {
  it("maps generation + reasoning config to dotted gateway params", () => {
    expect(
      buildUnifiedParams({
        temperature: 0.7, topP: 0.9, maxOutputTokens: 2048,
        reasoning: { enabled: true, effort: "high", budgetTokens: 2000 },
        stopSequences: ["\nA:", "\nB:"]
      })
    ).toEqual({
      temperature: 0.7, topP: 0.9, maxOutputTokens: 2048,
      "reasoning.enabled": true, "reasoning.effort": "high", "reasoning.budgetTokens": 2000,
      stopSequences: ["\nA:", "\nB:"]
    });
  });

  it("omits unset fields and maps effort 'none' to enabled:false", () => {
    expect(buildUnifiedParams({ reasoning: { effort: "none" } })).toEqual({ "reasoning.enabled": false });
    expect(buildUnifiedParams({})).toEqual({});
  });
});

describe("preconformRequest", () => {
  it("resolves forced-tool×thinking conflicts by disabling reasoning (deepseek, thinking default ON)", () => {
    const out = preconformRequest(gateway, "deepseek", "deepseek-v4-pro", {
      params: {}, toolChoice: { name: "orchestrator_decision" }
    });
    expect(out.params["reasoning.enabled"]).toBe(false);
    expect(out.toolChoice).toEqual({ name: "orchestrator_decision" });
    expect(gateway.validate("deepseek", "deepseek-v4-pro", { params: out.params, toolChoice: "named" }).ok).toBe(true);
  });

  it("drops violating optional params instead of failing (unsupported keys on gpt-5.5)", () => {
    const out = preconformRequest(gateway, "openai", "gpt-5.5", {
      params: { temperature: 0.7, topP: 0.9, maxOutputTokens: 512 }
    });
    expect(out.params).toEqual({ maxOutputTokens: 512 });
    expect(out.dropped.map((d) => d.param).sort()).toEqual(["temperature", "topP"]);
  });

  it("truncates stopSequences to the model's maxItems (gemini caps at 5)", () => {
    const out = preconformRequest(gateway, "google-ai-studio", "gemini-2.5-flash", {
      params: { stopSequences: ["a", "b", "c", "d", "e", "f", "g"] }
    });
    expect(out.params.stopSequences).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("throws GatewayPipelineError for an unknown model", () => {
    expect(() => preconformRequest(gateway, "deepseek", "nope", { params: {} })).toThrow(/Unknown model/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `src/orchestration/pipeline/params.ts`**

```ts
import type { Gateway, ToolChoice } from "@waifucave/gateway";
import { ReasoningConfig } from "../../shared/schemas/domain.js";

export class GatewayPipelineError extends Error {}

export type SamplingInputs = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningConfig;
  stopSequences?: string[];
};

/** Old config shapes → unified dotted gateway params. Unset stays absent. */
export function buildUnifiedParams(inputs: SamplingInputs): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (inputs.temperature !== undefined) params.temperature = inputs.temperature;
  if (inputs.topP !== undefined) params.topP = inputs.topP;
  if (inputs.maxOutputTokens !== undefined) params.maxOutputTokens = inputs.maxOutputTokens;
  if (inputs.stopSequences !== undefined && inputs.stopSequences.length > 0) params.stopSequences = inputs.stopSequences;
  const reasoning = inputs.reasoning ?? {};
  if (reasoning.effort === "none") {
    params["reasoning.enabled"] = false;
  } else {
    if (reasoning.enabled !== undefined) params["reasoning.enabled"] = reasoning.enabled;
    if (reasoning.effort !== undefined) params["reasoning.effort"] = reasoning.effort;
    if (reasoning.budgetTokens !== undefined) params["reasoning.budgetTokens"] = reasoning.budgetTokens;
  }
  return params;
}

export type PreconformResult = {
  params: Record<string, unknown>;
  toolChoice?: ToolChoice;
  dropped: Array<{ param: string; reason: string }>;
};

const toolChoiceMode = (choice: ToolChoice | undefined) =>
  choice === undefined ? undefined : typeof choice === "object" ? ("named" as const) : choice;

/**
 * Pre-conform an old-shape request against the registry (the sanctioned
 * pattern from MIGRATION_PLAN §11.9: the app conforms via the capability
 * surface; the gateway stays strict). Policy:
 *  - optional value params that violate → dropped (recorded in `dropped`);
 *  - over-long stopSequences → truncated to the descriptor's maxItems;
 *  - a forbidden toolChoice caused by reasoning → reasoning disabled for the
 *    call (decisions NEED their forced tool; reasoning is expendable there);
 *  - anything else still violating → throw (semantics we must not bend).
 */
export function preconformRequest(
  gateway: Gateway,
  providerId: string,
  modelId: string,
  input: { params: Record<string, unknown>; toolChoice?: ToolChoice }
): PreconformResult {
  const model = gateway.getCapabilities(providerId, modelId);
  if (!model) throw new GatewayPipelineError(`Unknown model ${providerId}:${modelId}`);

  const params = { ...input.params };
  const dropped: PreconformResult["dropped"] = [];

  const stop = params.stopSequences;
  const stopDescriptor = model.params["stopSequences"];
  if (Array.isArray(stop) && stopDescriptor?.maxItems !== undefined && stop.length > stopDescriptor.maxItems) {
    params.stopSequences = stop.slice(0, stopDescriptor.maxItems);
    dropped.push({ param: "stopSequences", reason: `truncated to ${stopDescriptor.maxItems}` });
  }

  for (let pass = 0; pass < 4; pass++) {
    const result = gateway.validate(providerId, modelId, {
      params,
      toolChoice: toolChoiceMode(input.toolChoice)
    });
    if (result.ok) return { params, toolChoice: input.toolChoice, dropped };

    let changed = false;
    for (const violation of result.violations) {
      if (violation.param === "toolChoice") {
        // Forced tool collides with a reasoning-state rule; the forced tool is
        // the semantic payload of decision calls — disable reasoning instead.
        if (params["reasoning.enabled"] !== false) {
          params["reasoning.enabled"] = false;
          delete params["reasoning.effort"];
          delete params["reasoning.budgetTokens"];
          dropped.push({ param: "reasoning.enabled", reason: violation.ruleId ?? violation.code });
          changed = true;
        }
        continue;
      }
      if (violation.param in params || violation.param.startsWith("reasoning.")) {
        delete params[violation.param];
        dropped.push({ param: violation.param, reason: violation.code });
        changed = true;
      }
    }
    if (!changed) {
      const detail = result.violations.map((v) => `${v.param}: ${v.code}`).join("; ");
      throw new GatewayPipelineError(`invalid request for ${providerId}:${modelId} — ${detail}`);
    }
  }
  throw new GatewayPipelineError(`pre-conform did not converge for ${providerId}:${modelId}`);
}
```

- [ ] **Step 4: Verify pass** — `npx vitest run tests/gatewayParams.test.ts`. If a pinned expectation mismatches live registry behavior (e.g. gpt-5.5 also rejects another param), print the live `validate()` output and fix the TEST expectation — registry data is authoritative.

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/pipeline/params.ts tests/gatewayParams.test.ts
git commit -m "feat: unified gateway params mapping with registry-driven pre-conform"
```

---

### Task 3: Unified waifu-context builder (`src/orchestration/pipeline/messages.ts`)

ONE builder replacing the four `contextTo*ForWaifu` variants. Capability-driven system placement: models whose doc says `multipleSystemMessages: true` get real mid/trailing `system` turns; others get `<system_note>`-wrapped user turns (exactly today's anthropic/google behavior, now decided by data). Images: fetch → base64 `ImageBlock` (port the Google path's fetch+inline approach); on fetch failure, fall back to the OCR text / URL line exactly like today's text-only path.

**Files:** Create `src/orchestration/pipeline/messages.ts`; Test `tests/gatewayMessages.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/gatewayMessages.test.ts
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { buildWaifuMessages } from "../src/orchestration/pipeline/messages.js";
import { ContextMessage } from "../src/orchestration/context.js";
import { formatSelfWaifuContent, formatWaifuContextBlock } from "../src/orchestration/context.js";

const gateway = createGateway({});

const msg = (over: Partial<ContextMessage>): ContextMessage => ({
  id: "m1", channelId: "c", authorKind: "user", authorId: "u1", name: "ann",
  displayName: "Ann", content: "hello", timestamp: "2026-06-12T10:00:00.000Z",
  reactions: [], ...over
});

const base = {
  systemPrompt: "SYSTEM",
  midSystemBlock: "MID",
  trailingSystemBlock: "TRAIL",
  retryUserMessage: undefined as string | undefined,
  selfAuthorIds: ["bot-1"],
  messages: [
    msg({ id: "m1", content: "hi" }),
    msg({ id: "m2", authorKind: "waifu", authorId: "bot-1", name: "yuki", displayName: "Yuki", content: "yo" }),
    msg({ id: "m3", content: "second" }),
    msg({ id: "m4", content: "third" })
  ]
};

describe("buildWaifuMessages", () => {
  it("maps self messages to assistant raw bodies and others to formatted user turns", async () => {
    const model = gateway.getCapabilities("deepseek", "deepseek-v4-flash")!;
    const out = await buildWaifuMessages(model, base);
    const selfTurn = out.find((m) => m.role === "assistant");
    expect(selfTurn?.content).toBe(formatSelfWaifuContent(base.messages[1]));
    const firstUser = out.find((m) => m.role === "user");
    expect(typeof firstUser?.content === "string" ? firstUser.content : "").toContain(
      (formatWaifuContextBlock(base.messages[0]) as string).slice(0, 12)
    );
  });

  it("uses real system turns for multipleSystemMessages models and <system_note> user turns otherwise", async () => {
    const openaiStyle = gateway.getCapabilities("deepseek", "deepseek-v4-flash")!;
    const anthropicStyle = gateway.getCapabilities("anthropic", "claude-haiku-4-5-20251001")!;
    const a = await buildWaifuMessages(openaiStyle, base);
    const b = await buildWaifuMessages(anthropicStyle, base);

    // leading system prompt is always message 0 with role system
    expect(a[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(b[0]).toEqual({ role: "system", content: "SYSTEM" });

    const aMid = a.filter((m) => m.role === "system");
    expect(aMid.length).toBeGreaterThanOrEqual(3); // SYSTEM + MID + TRAIL as real system turns
    const bNotes = b.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<system_note>")
    );
    expect(bNotes).toHaveLength(2); // MID + TRAIL wrapped
    expect(bNotes[0]!.content).toBe("<system_note>\nMID\n</system_note>");
  });

  it("injects the mid block at context length - 2 and retryUserMessage last", async () => {
    const model = gateway.getCapabilities("deepseek", "deepseek-v4-flash")!;
    const out = await buildWaifuMessages(model, { ...base, retryUserMessage: "Yuki:" });
    const last = out[out.length - 1]!;
    expect(last).toEqual({ role: "user", content: "Yuki:" });
    // MID sits before the last two context messages (m3, m4 region)
    const midIndex = out.findIndex((m) => typeof m.content === "string" && m.content.includes("MID"));
    const m3Index = out.findIndex((m) => typeof m.content === "string" && (m.content as string).includes("second"));
    expect(midIndex).toBeGreaterThan(0);
    expect(midIndex).toBeLessThan(m3Index);
  });

  it("inlines images as base64 ImageBlocks and falls back to text on fetch failure", async () => {
    const model = gateway.getCapabilities("anthropic", "claude-haiku-4-5-20251001")!;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const withImage = {
      ...base,
      messages: [msg({ id: "m1", content: "look", images: [{ url: "https://cdn.test/a.png", contentType: "image/png" }] })]
    };
    const out = await buildWaifuMessages(model, withImage, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const userTurn = out.find((m) => m.role === "user" && Array.isArray(m.content));
    const image = (userTurn!.content as Array<{ type: string }>).find((b) => b.type === "image") as {
      type: string; mimeType: string; data: string;
    };
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toBe(png.toString("base64"));

    const failing = vi.fn(async () => new Response("nope", { status: 404 }));
    const fallback = await buildWaifuMessages(model, withImage, { fetchImpl: failing as unknown as typeof fetch });
    expect(fallback.some((m) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === "image"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `src/orchestration/pipeline/messages.ts`**

```ts
import type { ChatMessage, ResolvedModel } from "@waifucave/gateway";
import { ContextMessage, formatSelfWaifuContent, formatWaifuContextBlock } from "../context.js";

type ImageBlockOut = { type: "image"; mimeType: string; data: string };
type UserBlock = { type: "text"; text: string } | ImageBlockOut;

export type WaifuMessageInputs = {
  systemPrompt: string;
  midSystemBlock?: string;
  trailingSystemBlock?: string;
  retryUserMessage?: string;
  selfAuthorIds?: string[];
  messages: ContextMessage[];
};

const systemNote = (content: string) => `<system_note>\n${content}\n</system_note>`;

async function inlineImages(
  message: ContextMessage,
  fetchImpl: typeof fetch
): Promise<ImageBlockOut[]> {
  const blocks: ImageBlockOut[] = [];
  for (const image of message.images ?? []) {
    try {
      const response = await fetchImpl(image.url);
      if (!response.ok) continue;
      const mimeType = response.headers.get("content-type")?.split(";")[0] || image.contentType || "image/png";
      const data = Buffer.from(await response.arrayBuffer()).toString("base64");
      blocks.push({ type: "image", mimeType, data });
    } catch {
      // Unreachable image: the textual context (OCR text already rendered by
      // formatWaifuContextBlock) is the fallback — same as today's text-only path.
    }
  }
  return blocks;
}

/**
 * The ONE waifu-context builder (replaces the four per-protocol variants).
 * Role mapping is W2's contract: messages whose author is THIS waifu become
 * assistant turns with the raw body; everything else is a formatted user turn.
 * System placement is capability-driven, never provider-driven.
 */
export async function buildWaifuMessages(
  model: ResolvedModel,
  inputs: WaifuMessageInputs,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<ChatMessage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const selfIds = new Set(inputs.selfAuthorIds ?? []);
  const midAsSystem = model.features.multipleSystemMessages === true;
  const supportsImages = model.modalities.input.includes("image");

  const context: ChatMessage[] = [];
  for (const message of inputs.messages) {
    const isSelf = message.authorKind === "waifu" && selfIds.has(message.authorId);
    if (isSelf) {
      context.push({ role: "assistant", content: formatSelfWaifuContent(message) });
      continue;
    }
    const text = formatWaifuContextBlock(message);
    const images = supportsImages ? await inlineImages(message, fetchImpl) : [];
    context.push(
      images.length > 0
        ? { role: "user", content: [{ type: "text", text }, ...images] as UserBlock[] }
        : { role: "user", content: text }
    );
  }

  const auxTurn = (content: string): ChatMessage =>
    midAsSystem ? { role: "system", content } : { role: "user", content: systemNote(content) };

  // Mid block injects at context length - 2 (same anchor as today's
  // injectMemoriesIntoChatContext); trailing block goes after the context.
  if (inputs.midSystemBlock) {
    const at = Math.max(0, context.length - 2);
    context.splice(at, 0, auxTurn(inputs.midSystemBlock));
  }

  const out: ChatMessage[] = [{ role: "system", content: inputs.systemPrompt }, ...context];
  if (inputs.trailingSystemBlock) out.push(auxTurn(inputs.trailingSystemBlock));
  if (inputs.retryUserMessage) out.push({ role: "user", content: inputs.retryUserMessage });
  return out;
}
```

- [ ] **Step 4: Verify pass.** If `ResolvedModel`'s field names differ from those used here (`features.multipleSystemMessages`, `modalities.input`), check `node_modules/@waifucave/gateway/dist/registry/types.d.ts` and correct the IMPLEMENTATION (the registry types are the authority — do not weaken tests).

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/pipeline/messages.ts tests/gatewayMessages.test.ts
git commit -m "feat: unified capability-driven waifu context builder"
```

---

### Task 4: Unified orchestrator timeline (`src/orchestration/pipeline/timeline.ts`)

ONE timeline builder replacing the four `build*Orchestrator*` variants. Reuses `buildOrchestratorTimeline`'s semantics: chronological messages + gap notes (≥15 min) + wake markers as plain user text + past decisions replayed as assistant `toolCall` blocks (via `serializeOrchestratorDecisionArguments`) each followed by a `role:"tool"` result carrying `formatDecisionOutcome`. To avoid duplicating the core, MOVE `buildOrchestratorTimeline`, `serializeOrchestratorDecisionArguments`, `formatDecisionOutcome`, and the `OrchestratorTimelineItem` type from `pipelines.ts` into this module verbatim, with `pipelines.ts` re-importing them (rule-1 referee applies).

**Files:** Create `src/orchestration/pipeline/timeline.ts`; Modify `src/providers/pipelines.ts` (import shuffle); Test `tests/gatewayTimeline.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/gatewayTimeline.test.ts
import { describe, expect, it } from "vitest";
import { buildOrchestratorChatMessages, formatDecisionOutcome, serializeOrchestratorDecisionArguments } from "../src/orchestration/pipeline/timeline.js";
import { ORCHESTRATOR_TOOL_NAME } from "../src/orchestration/tools.js";
import { ContextMessage } from "../src/orchestration/context.js";

const msg = (id: string, ts: string, content: string): ContextMessage => ({
  id, channelId: "c", authorKind: "user", authorId: "u", name: "ann", displayName: "Ann",
  content, timestamp: ts, reactions: []
});

const decision = {
  id: "d1",
  action: "no_reply" as const,
  respondingWaifus: [],
  retriggerAfterSeconds: 600,
  reasoning: "quiet hours, nothing to add — waiting for the humans to come back with something new",
  status: "completed" as const,
  waifuMessageIds: [],
  responderOutcomes: [],
  createdAt: "2026-06-12T10:05:00.000Z"
};

describe("buildOrchestratorChatMessages", () => {
  it("renders messages as user turns, decisions as assistant toolCall + tool result", () => {
    const out = buildOrchestratorChatMessages({
      systemPrompt: "ORCH",
      trailingPrompt: "DECIDE",
      messages: [msg("m1", "2026-06-12T10:00:00.000Z", "hi"), msg("m2", "2026-06-12T10:30:00.000Z", "still here")],
      pastDecisions: [decision],
      decisionMarkers: []
    });

    expect(out[0]).toEqual({ role: "system", content: "ORCH" });
    const assistant = out.find((m) => m.role === "assistant" && Array.isArray(m.content));
    expect(assistant).toBeDefined();
    const call = (assistant!.content as Array<{ type: string; id: string; name: string; arguments: string }>)[0]!;
    expect(call.type).toBe("toolCall");
    expect(call.name).toBe(ORCHESTRATOR_TOOL_NAME);
    expect(JSON.parse(call.arguments)).toEqual(JSON.parse(serializeOrchestratorDecisionArguments(decision)));
    const idx = out.indexOf(assistant!);
    expect(out[idx + 1]).toEqual({ role: "tool", toolCallId: call.id, content: formatDecisionOutcome(decision) });
    expect(out[out.length - 1]).toEqual({ role: "user", content: "DECIDE" });
  });

  it("keeps gap notes and wake markers as user text in chronological order", () => {
    const out = buildOrchestratorChatMessages({
      systemPrompt: "ORCH",
      messages: [msg("m1", "2026-06-12T10:00:00.000Z", "hi"), msg("m2", "2026-06-12T11:00:00.000Z", "back")],
      pastDecisions: [],
      decisionMarkers: [{ kind: "wake", timestamp: "2026-06-12T10:40:00.000Z", scheduledSeconds: 600, wakePlan: "check on Ann" }]
    });
    const texts = out.filter((m) => m.role === "user").map((m) => m.content as string);
    const gapIndex = texts.findIndex((t) => /\[\s*\d+m? .*pass|gap|minutes/i.test(t) || t.includes("m pass"));
    const wakeIndex = texts.findIndex((t) => t.includes("check on Ann"));
    expect(gapIndex).toBeGreaterThanOrEqual(0);
    expect(wakeIndex).toBeGreaterThanOrEqual(0);
  });
});
```

NOTE: the exact gap-note and wake-marker text comes from the moved `buildOrchestratorTimeline` — if the regex pin above misses the real phrasing, print one rendered timeline and tighten the TEST to the actual strings (moved code is authority).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — move `buildOrchestratorTimeline` (+ its `OrchestratorTimelineItem` type and note-formatting helpers), `serializeOrchestratorDecisionArguments`, `formatDecisionOutcome` from `pipelines.ts` verbatim into `timeline.ts`; export them; update `pipelines.ts` to import from `./../orchestration/pipeline/timeline.js`. Then add the unified renderer:

```ts
import type { ChatMessage } from "@waifucave/gateway";
import { ORCHESTRATOR_TOOL_NAME } from "../tools.js";
// ...moved code above...

export type OrchestratorTimelineInputs = {
  systemPrompt?: string;
  trailingPrompt?: string;
  messages: ContextMessage[];
  pastDecisions?: OrchestratorDecisionHistoryEntry[];
  decisionMarkers?: OrchestratorWakeMarker[];
};

/** ONE renderer over the shared timeline: notes/messages → user text; decisions → assistant toolCall + tool result. */
export function buildOrchestratorChatMessages(inputs: OrchestratorTimelineInputs): ChatMessage[] {
  const timeline = buildOrchestratorTimeline(inputs.messages, inputs.pastDecisions ?? [], inputs.decisionMarkers ?? []);
  const out: ChatMessage[] = [];
  if (inputs.systemPrompt) out.push({ role: "system", content: inputs.systemPrompt });
  let callCounter = 0;
  for (const item of timeline) {
    if (item.kind === "decision") {
      const id = `past_decision_${++callCounter}`;
      out.push({
        role: "assistant",
        content: [{ type: "toolCall", id, name: ORCHESTRATOR_TOOL_NAME, arguments: serializeOrchestratorDecisionArguments(item.decision) }]
      });
      out.push({ role: "tool", toolCallId: id, content: formatDecisionOutcome(item.decision) });
    } else {
      out.push({ role: "user", content: item.text });
    }
  }
  if (inputs.trailingPrompt) out.push({ role: "user", content: inputs.trailingPrompt });
  return out;
}
```

(The moved `buildOrchestratorTimeline` returns items whose exact field names the implementer must read at move time — `item.text` vs rendered-on-the-fly via `formatOrchestratorMessageBlock`; adjust the renderer to the real item shape, keeping behavior identical to what `buildOpenAiChatOrchestratorMessages` did. Consecutive-user-turn coalescing is NOT needed — gateway codecs accept consecutive same-role turns; anthropic codec handles its own merging.)

- [ ] **Step 4: Verify pass** — `npx vitest run tests/gatewayTimeline.test.ts tests/pipelines.test.ts` (move must keep the pipelines suite green).

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/pipeline/timeline.ts src/providers/pipelines.ts tests/gatewayTimeline.test.ts
git commit -m "feat: unified orchestrator timeline renderer on gateway message shapes"
```

---

### Task 5: `GatewayModelPipeline` — factory, query-log wiring, `generateWaifu`

The class + factory + the most intricate method. Factory: `createGatewayModelPipeline({ providerId, modelId, queryRole, dataRoot, gateway? })` — production path builds (and caches per `queryRole`) a `Gateway` with `createProviderCredentialsLookup(dataRoot)` (reuse from P2, `src/api/llmGatewayCredentials.ts`) and a fetchImpl wrapper that calls `recordProviderQuery(queryRole, …)` / `recordProviderReply(queryRole, …)`; tests inject `gateway` directly. 180 s app timeout via `AbortSignal.any([request.signal, AbortSignal.timeout(180_000)])` filtered for undefined.

`generateWaifu` contract (mirror of today's): build messages (T3) + params (T2, with `temperature ?? model-default` semantics left to the registry's own defaults — pass only what the request carries); tools array = `add_memory` (if `shortTermMemoryToolEnabled`) + `PickNextWaifu` (if enabled && `availableWaifuIds` non-empty), `toolChoice: "auto"` only when tools exist; response scan: text blocks → `content` (concatenated, trimmed; empty → throw), `add_memory` calls → `shortTermMemoryEntries` (each parsed `{content}` string; malformed entries skipped), `PickNextWaifu` → validated against `availableWaifuIds` → `pickedNextWaifuId` or `rejectedPickNextWaifu {reason: "malformed"|"unavailable_waifu"}`; `usage` → flat record `{inputTokens, outputTokens, reasoningTokens?, cachedInputTokens?}` with undefined fields omitted.

**Files:** Create `src/orchestration/pipeline/gatewayPipeline.ts`; Test `tests/gatewayPipeline.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/gatewayPipeline.test.ts
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { ContextMessage } from "../src/orchestration/context.js";

const msg = (over: Partial<ContextMessage>): ContextMessage => ({
  id: "m1", channelId: "c", authorKind: "user", authorId: "u1", name: "ann",
  displayName: "Ann", content: "hello", timestamp: "2026-06-12T10:00:00.000Z",
  reactions: [], ...over
});

function chatPayload(content: unknown[], finish = "stop") {
  return { id: "r1", choices: [{ message: typeof content === "string" ? { content } : { content: null, ...contentToMessage(content) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}
// helper: openai-chat shape with optional tool_calls
function contentToMessage(blocks: unknown[]) {
  const text = blocks.filter((b: any) => b.kind === "text").map((b: any) => b.text).join("");
  const calls = blocks.filter((b: any) => b.kind === "call").map((b: any, i: number) => ({
    id: `call_${i}`, type: "function", function: { name: b.name, arguments: JSON.stringify(b.args) }
  }));
  return { content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
}
const okFetch = (payload: unknown) => vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

const makePipeline = (fetchImpl: typeof fetch, providerId = "deepseek", modelId = "deepseek-v4-flash") =>
  createGatewayModelPipeline({
    providerId, modelId, queryRole: "waifu",
    gateway: createGateway({ credentials: { deepseek: "sk-t", anthropic: "sk-a", openai: "sk-o", "google-ai-studio": "sk-g" }, fetchImpl })
  });

describe("generateWaifu (gateway)", () => {
  const baseRequest = {
    modelId: "deepseek-v4-flash",
    systemPrompt: "SYS",
    messages: [msg({}), msg({ id: "m2", authorKind: "waifu" as const, authorId: "bot-1", content: "yo" })],
    selfAuthorIds: ["bot-1"],
    temperature: 0.7,
    reasoning: { enabled: false }
  };

  it("returns trimmed text content and flat usage", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "  hey there  " }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu(baseRequest);
    expect(result.content).toBe("hey there");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });

  it("throws on empty content", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "   " }, finish_reason: "stop" }], usage: {} });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu(baseRequest)).rejects.toThrow();
  });

  it("collects add_memory entries and a valid PickNextWaifu handoff", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{
        message: {
          content: "answer text",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "add_memory", arguments: JSON.stringify({ content: "Ann likes tea" }) } },
            { id: "c2", type: "function", function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "riko" }) } }
          ]
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true, pickNextWaifuToolEnabled: true, availableWaifuIds: ["riko"]
    });
    expect(result.content).toBe("answer text");
    expect(result.shortTermMemoryEntries).toEqual(["Ann likes tea"]);
    expect(result.pickedNextWaifuId).toBe("riko");
  });

  it("rejects an unavailable PickNextWaifu target", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: "text", tool_calls: [{ id: "c1", type: "function", function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "ghost" }) } }] }, finish_reason: "stop" }],
      usage: {}
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, pickNextWaifuToolEnabled: true, availableWaifuIds: ["riko"]
    });
    expect(result.pickedNextWaifuId).toBeUndefined();
    expect(result.rejectedPickNextWaifu).toEqual({ reason: "unavailable_waifu", waifuId: "ghost" });
  });

  it("sends tools only when enabled, with auto toolChoice (wire golden)", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: {} });
    await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("add_memory");
    expect(body.tool_choice === undefined || body.tool_choice === "auto").toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});
```

(The exact deepseek `thinking: {type:"disabled"}` wire shape comes from the registry's wireName mapping — if the live golden differs, print the body and pin the REAL shape.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `gatewayPipeline.ts`** (factory + class skeleton + `generateWaifu`):

```ts
import { createGateway, Gateway, type ChatResponse, type ToolDef } from "@waifucave/gateway";
import { createProviderCredentialsLookup } from "../../api/llmGatewayCredentials.js";
import { QueryRole, recordProviderQuery, recordProviderReply } from "../../shared/queryLog.js";
import {
  ModelPipeline, PersonaDigest, PersonaDigestRequest, ProviderRequest,
  StageManagerObserveRequest, DreamRequest, WaifuGenerationRequest, WaifuGenerationResult
} from "../../providers/types.js";
import { OrchestratorDecision, OrchestratorDecisionSchema } from "../decisions.js";
import { DreamOp, DreamOpSchema, StageManagerObservation, StageManagerObservationSchema } from "../stageManager.js";
import { ReviewerDecision, ReviewerDecisionSchema } from "../reviewer.js";
import {
  DREAM_PROMPT, DREAM_TOOL_NAME, OBSERVER_TOOL_NAME, ORCHESTRATOR_TOOL_NAME,
  PERSONA_DIGEST_PROMPT, PERSONA_DIGEST_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_NAME,
  REVIEWER_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_NAME,
  dreamToolParameters, flatDreamToolParameters, observerToolParameters,
  orchestratorToolParameters, personaDigestToolParameters, pickNextWaifuToolParameters,
  reviewerToolParameters, shortTermMemoryToolParameters, observerSystemPrompt, reviewerSystemPrompt
} from "../tools.js";
import { GatewayPipelineError, buildUnifiedParams, preconformRequest } from "./params.js";
import { buildWaifuMessages } from "./messages.js";
import { buildOrchestratorChatMessages } from "./timeline.js";

const REQUEST_TIMEOUT_MS = 180_000;

export type GatewayPipelineOptions = {
  providerId: string;
  modelId: string;
  queryRole: QueryRole;
  dataRoot?: string;        // production: live credentials from user/providers.json
  gateway?: Gateway;        // tests: inject directly
};

const gatewayCache = new Map<string, Gateway>();

function resolveGateway(options: GatewayPipelineOptions): Gateway {
  if (options.gateway) return options.gateway;
  if (!options.dataRoot) throw new GatewayPipelineError("dataRoot or gateway required");
  const key = `${options.dataRoot}:${options.queryRole}`;
  let cached = gatewayCache.get(key);
  if (!cached) {
    const role = options.queryRole;
    const inner = fetch;
    const fetchImpl: typeof fetch = async (input, init) => {
      recordProviderQuery(role, { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const response = await inner(input, init);
      recordProviderReply(role, { status: response.status });
      return response;
    };
    cached = createGateway({ credentials: createProviderCredentialsLookup(options.dataRoot), fetchImpl });
    gatewayCache.set(key, cached);
  }
  return cached;
}

function combinedSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function flatUsage(response: ChatResponse): Record<string, number> | undefined {
  const entries = Object.entries(response.usage).filter(([, v]) => typeof v === "number") as Array<[string, number]>;
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function textContent(response: ChatResponse): string {
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

function toolCalls(response: ChatResponse, name: string) {
  return response.content.filter((b) => b.type === "toolCall" && b.name === name);
}

/** Parse exactly one forced-tool call's arguments through a zod schema. */
function parseForcedCall<T>(response: ChatResponse, toolName: string, parse: (raw: unknown) => T, label: string): T {
  const call = toolCalls(response, toolName)[0];
  if (!call) throw new GatewayPipelineError(`${label}: model did not call ${toolName}`);
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    throw new GatewayPipelineError(`${label}: malformed ${toolName} arguments`);
  }
  return parse(raw);
}

export class GatewayModelPipeline implements ModelPipeline {
  constructor(private readonly options: GatewayPipelineOptions, private readonly gateway: Gateway) {}

  private async chat(request: {
    messages: Parameters<Gateway["chat"]>[0]["messages"];
    tools?: ToolDef[];
    toolChoice?: Parameters<Gateway["chat"]>[0]["toolChoice"];
    sampling: Parameters<typeof buildUnifiedParams>[0];
    signal?: AbortSignal;
  }): Promise<ChatResponse> {
    const { providerId, modelId } = this.options;
    const conformed = preconformRequest(this.gateway, providerId, modelId, {
      params: buildUnifiedParams(request.sampling),
      toolChoice: request.toolChoice
    });
    return this.gateway.chat({
      provider: providerId,
      model: modelId,
      messages: request.messages,
      tools: request.tools,
      toolChoice: conformed.toolChoice,
      params: conformed.params,
      signal: combinedSignal(request.signal)
    });
  }

  private get model() {
    const resolved = this.gateway.getCapabilities(this.options.providerId, this.options.modelId);
    if (!resolved) throw new GatewayPipelineError(`Unknown model ${this.options.providerId}:${this.options.modelId}`);
    return resolved;
  }

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    const tools: ToolDef[] = [];
    if (request.shortTermMemoryToolEnabled) {
      tools.push({ name: SHORT_TERM_MEMORY_TOOL_NAME, parameters: shortTermMemoryToolParameters() });
    }
    if (request.pickNextWaifuToolEnabled && request.availableWaifuIds?.length) {
      tools.push({ name: PICK_NEXT_WAIFU_TOOL_NAME, parameters: pickNextWaifuToolParameters(request.availableWaifuIds) });
    }
    const response = await this.chat({
      messages: await buildWaifuMessages(this.model, request),
      tools: tools.length ? tools : undefined,
      toolChoice: tools.length ? "auto" : undefined,
      sampling: {
        temperature: request.temperature, topP: request.topP, maxOutputTokens: request.maxOutputTokens,
        reasoning: request.reasoning, stopSequences: request.stopSequences
      },
      signal: request.signal
    });

    const content = textContent(response);
    if (!content) throw new GatewayPipelineError("empty waifu response");

    const result: WaifuGenerationResult = { content };
    const usage = flatUsage(response);
    if (usage) result.usage = usage;

    const memoryEntries = toolCalls(response, SHORT_TERM_MEMORY_TOOL_NAME)
      .map((call) => { try { return JSON.parse(call.arguments) as { content?: unknown }; } catch { return undefined; } })
      .map((parsed) => (typeof parsed?.content === "string" && parsed.content.trim() ? parsed.content.trim() : undefined))
      .filter((entry): entry is string => entry !== undefined);
    if (memoryEntries.length) result.shortTermMemoryEntries = memoryEntries;

    const pick = toolCalls(response, PICK_NEXT_WAIFU_TOOL_NAME)[0];
    if (pick) {
      let waifuId: string | undefined;
      try { waifuId = (JSON.parse(pick.arguments) as { waifuId?: unknown }).waifuId as string | undefined; } catch { /* malformed */ }
      if (typeof waifuId !== "string" || !waifuId) {
        result.rejectedPickNextWaifu = { reason: "malformed" };
      } else if (!request.availableWaifuIds?.includes(waifuId)) {
        result.rejectedPickNextWaifu = { reason: "unavailable_waifu", waifuId };
      } else {
        result.pickedNextWaifuId = waifuId;
      }
    }
    return result;
  }

  // decideOrchestrator / decideReviewer: Task 6.
  // decideStageManagerObservations / decideDream / generatePersonaDigest: Task 7.
}

export function createGatewayModelPipeline(options: GatewayPipelineOptions): GatewayModelPipeline {
  return new GatewayModelPipeline(options, resolveGateway(options));
}
```

(Task 5 ships the class with only `generateWaifu`; the other five methods are added in Tasks 6–7 — TypeScript allows it because they're optional on the interface.)

- [ ] **Step 4: Verify pass** — `npx vitest run tests/gatewayPipeline.test.ts`.

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/pipeline/gatewayPipeline.ts tests/gatewayPipeline.test.ts
git commit -m "feat: gateway-backed ModelPipeline — factory, query log, generateWaifu"
```

---

### Task 6: `decideOrchestrator` + `decideReviewer`

Both are forced-tool single-parse methods. Orchestrator: messages from `buildOrchestratorChatMessages` (T4); tool `orchestrator_decision` with `orchestratorToolParameters(request.availableWaifuIds, request.replyRequired ?? false, request.directiveBudgetOpen ?? true)`; `toolChoice: {name: ORCHESTRATOR_TOOL_NAME}`; sampling `temperature: request.temperature ?? 0.2`; parse via `OrchestratorDecisionSchema.parse`. Reviewer: system prompt `reviewerSystemPrompt(request.systemPrompt)`, single user turn carrying the message under review (exactly the content today's `decideReviewer` sends — the implementer reads the current method body at :419-577 region and mirrors the user-turn text construction), tool `review_message` forced, `temperature ?? 0`, parse `ReviewerDecisionSchema`.

**Files:** Modify `src/orchestration/pipeline/gatewayPipeline.ts`; Test `tests/gatewayPipeline.test.ts` (append).

- [ ] **Step 1: Append failing tests**

```ts
describe("decideOrchestrator (gateway)", () => {
  const orchRequest = {
    modelId: "deepseek-v4-flash",
    systemPrompt: "ORCH SYSTEM",
    trailingPrompt: "Decide now.",
    messages: [msg({})],
    availableWaifuIds: ["yuki"],
    replyRequired: false,
    directiveBudgetOpen: true,
    reasoning: { enabled: true, effort: "high" as const }
  };

  it("forces the decision tool, disables thinking via pre-conform, parses the decision", async () => {
    const decision = { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 2, directive: { intent: "spotlight", goal: "greet Ann" } }], reasoning: "Ann said hi" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(decision) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    const parsed = await pipeline.decideOrchestrator!(orchRequest);
    expect(parsed.action).toBe("reply");
    expect(parsed.respondingWaifus[0]).toMatchObject({ waifuId: "yuki", directive: { intent: "spotlight", goal: "greet Ann" } });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "orchestrator_decision" } });
    // deepseek thinking-no-forced-tools: pre-conform must disable thinking
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("rejects a decision violating the zod refinements", async () => {
    const bad = { action: "reply", respondingWaifus: [], reasoning: "contradiction" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(bad) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!(orchRequest)).rejects.toThrow();
  });
});

describe("decideReviewer (gateway)", () => {
  it("forces review_message and parses the verdict", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "review_message", arguments: JSON.stringify({ hallucination: true }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    const verdict = await pipeline.decideReviewer!({ modelId: "deepseek-v4-flash", messages: [msg({})], message: "suspect text" });
    expect(verdict).toEqual({ hallucination: true });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "review_message" } });
    expect(JSON.stringify(body.messages)).toContain("suspect text");
  });
});
```

- [ ] **Step 2: Run to verify failure** (methods undefined).

- [ ] **Step 3: Implement both methods** on the class:

```ts
  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const response = await this.chat({
      messages: buildOrchestratorChatMessages({
        systemPrompt: request.systemPrompt,
        trailingPrompt: request.trailingPrompt,
        messages: request.messages,
        pastDecisions: request.pastDecisions,
        decisionMarkers: request.decisionMarkers
      }),
      tools: [{
        name: ORCHESTRATOR_TOOL_NAME,
        parameters: orchestratorToolParameters(request.availableWaifuIds, request.replyRequired ?? false, request.directiveBudgetOpen ?? true)
      }],
      toolChoice: { name: ORCHESTRATOR_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxOutputTokens, reasoning: request.reasoning },
      signal: request.signal
    });
    return parseForcedCall(response, ORCHESTRATOR_TOOL_NAME, (raw) => OrchestratorDecisionSchema.parse(raw), "decideOrchestrator");
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    const response = await this.chat({
      messages: [
        { role: "system", content: reviewerSystemPrompt(request.systemPrompt) },
        { role: "user", content: request.message }
      ],
      tools: [{ name: REVIEWER_TOOL_NAME, parameters: reviewerToolParameters() }],
      toolChoice: { name: REVIEWER_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0, maxOutputTokens: request.maxOutputTokens, reasoning: request.reasoning },
      signal: request.signal
    });
    return parseForcedCall(response, REVIEWER_TOOL_NAME, (raw) => ReviewerDecisionSchema.parse(raw), "decideReviewer");
  }
```

BEFORE finalizing `decideReviewer`, read today's reviewer method (pipelines.ts `OpenAiCompatibleChatPipeline.decideReviewer`) and mirror its exact user-turn construction (it may wrap `request.message` with context messages or a template — match it; the test's `toContain("suspect text")` holds either way, but behavior parity is the goal).

- [ ] **Step 4: Verify pass.**

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/pipeline/gatewayPipeline.ts tests/gatewayPipeline.test.ts
git commit -m "feat: gateway pipeline orchestrator and reviewer decisions"
```

---

### Task 7: `decideStageManagerObservations`, `decideDream`, `generatePersonaDigest`

Three more forced-tool methods. Observer: system `observerSystemPrompt(request.systemPrompt)`, ONE user turn from `formatObserverContext(request.messages)` (import from `../context.js` — the lean W3 formatter), tool `record_observations` with `observerToolParameters(request.availableWaifuIds)`, parse `z.array(StageManagerObservationSchema)` from the call's `observations` property (read today's parse in pipelines.ts and mirror: the tool args carry `{observations: [...]}`). Dream: system `DREAM_PROMPT` + custom prefix (`request.systemPrompt` prepended exactly as today), user turn = the serialized memories+observations payload — MOVE today's dream-input formatting helper from pipelines.ts if one exists, else mirror its inline construction verbatim; tool `dream_memories` with `wire === "google-generative-language" ? flatDreamToolParameters() : dreamToolParameters()` (the sanctioned exception), parse `z.array(DreamOpSchema)` from args `{ops: [...]}` — and for the google flat shape, reuse today's flat→nested op reconstruction (move it to tools.ts if it's a standalone function). PersonaDigest: system `PERSONA_DIGEST_PROMPT`, user turn `request.personaText`, tool `set_persona_digest`, parse `{voice: string, role: string}` (strings required non-empty; malformed → throw).

**Files:** Modify `src/orchestration/pipeline/gatewayPipeline.ts` (+ `src/orchestration/tools.ts`/`pipelines.ts` only if moving the flat-op reconstruction helper); Test `tests/gatewayPipeline.test.ts` (append).

- [ ] **Step 1: Append failing tests**

```ts
describe("decideStageManagerObservations (gateway)", () => {
  it("forces record_observations and parses entities", async () => {
    const observations = [{ waifuId: "yuki", content: "Ann prefers tea", importance: 3, kind: "preference", entities: ["Ann"] }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "record_observations", arguments: JSON.stringify({ observations }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideStageManagerObservations!({
      modelId: "deepseek-v4-flash", messages: [msg({})], availableWaifuIds: ["yuki"]
    });
    expect(out).toEqual(observations);
  });
});

describe("decideDream (gateway)", () => {
  const dreamRequest = {
    modelId: "deepseek-v4-flash",
    messages: [],
    memories: [{ memoryIndex: 1, waifuId: "yuki", content: "old note", kind: "note" as const, strength: 2, ageDays: 10, daysSinceRetrieved: 5 }],
    observations: [],
    availableWaifuIds: ["yuki"]
  };

  it("forces dream_memories and parses ops", async () => {
    const ops = [{ op: "decay", memoryIndex: 1, strength: 1 }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "dream_memories", arguments: JSON.stringify({ ops }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideDream!(dreamRequest);
    expect(out).toEqual([{ op: "decay", memoryIndex: 1, strength: 1 }]);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body.messages)).toContain("old note");
  });
});

describe("generatePersonaDigest (gateway)", () => {
  it("forces set_persona_digest and returns voice/role", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: JSON.stringify({ voice: "dry wit", role: "older sister" }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).generatePersonaDigest!({
      modelId: "deepseek-v4-flash", messages: [], personaText: "PERSONA TEXT"
    });
    expect(out).toEqual({ voice: "dry wit", role: "older sister" });
  });

  it("throws on malformed digest", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: JSON.stringify({ voice: "" }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).generatePersonaDigest!({
      modelId: "deepseek-v4-flash", messages: [], personaText: "X"
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the three methods.** Read each current implementation in pipelines.ts FIRST and mirror its prompt/user-turn/parse construction exactly (dream-input serialization, observer args shape `{observations}`, dream args `{ops}`, google flat-op reconstruction). Shapes that must hold:

```ts
  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> { /* forced record_observations; z.array(StageManagerObservationSchema).parse(raw.observations) */ }
  async decideDream(request: DreamRequest): Promise<DreamOp[]> { /* forced dream_memories; flat schema iff this.model.wire === "google-generative-language"; z.array(DreamOpSchema) */ }
  async generatePersonaDigest(request: PersonaDigestRequest): Promise<PersonaDigest> { /* forced set_persona_digest; voice/role non-empty strings else throw */ }
```

- [ ] **Step 4: Verify pass.**

- [ ] **Step 5: Full suite + typecheck, commit**

```bash
npm run typecheck && npx vitest run
git add src/orchestration/pipeline/gatewayPipeline.ts src/orchestration/tools.ts src/providers/pipelines.ts tests/gatewayPipeline.test.ts
git commit -m "feat: gateway pipeline observer, dream, and persona digest"
```

---

### Task 8: Cross-wire golden matrix + final verification

One describe pinning the four wires end-to-end through the new pipeline with realistic provider payloads (reusing P1b/P2 fixture shapes): anthropic `generateWaifu` (system top-level, `<system_note>` user turns, `x-api-key` header, anthropic tool shape), openai-responses `decideOrchestrator` (forced tool via responses wire), google `decideDream` (flat schema + sanitized parameters + named function_calling_config), deepseek thinking-drop golden (temperature passed + thinking on → wire carries `thinking {type:"enabled"}` and NO temperature; warnings present on the response object internally — assert via wire body only).

**Files:** Test `tests/gatewayPipeline.test.ts` (append a `describe("cross-wire goldens")`).

- [ ] **Step 1: Write the four golden tests.** Provider payload fixtures: anthropic `{id, content:[{type:"text",text:"…"}], stop_reason:"end_turn", usage:{input_tokens,output_tokens}}`; responses `{id, status:"completed", output:[{type:"function_call", call_id, name, arguments}], usage:{input_tokens,output_tokens}}`; google `{candidates:[{content:{parts:[{functionCall:{name,args}}]},finishReason:"STOP"}], usageMetadata:{promptTokenCount,candidatesTokenCount}}`. For each: assert URL + auth header + the load-bearing body fields (tools shape, tool_choice/tool_config, system placement) and the parsed result. If any fixture shape mismatches the real codec's expectation, run the equivalent through `tests/` in the GATEWAY repo's fixtures (`git -C ../waifucave-gateway grep` for the codec test shapes) and pin the real one.

- [ ] **Step 2–4: fail → implement nothing (tests only) → pass.** Any failure here is a real integration bug in T2–T7 code (or a genuine gateway bug → STOP per rule 5); fix in the task's module, never by weakening the golden.

- [ ] **Step 5: FULL verification + commit**

```bash
npm run typecheck && npx vitest run && npm run build:backend
git add tests/gatewayPipeline.test.ts
git commit -m "test: cross-wire golden matrix for the gateway pipeline"
```
Expected: suite ≥ 620 passed | 15 skipped (count is indicative — verify behaviors, not numbers, if concurrent landings shifted the baseline); typecheck + backend build clean; `tests/pipelines.test.ts` untouched since Task 4.

---

## Final integration review checklist (controller)

1. Re-run `npm run typecheck && npx vitest run && npm run build:backend` independently.
2. `git diff <baseline>..HEAD --stat` — confirm: NO changes outside `src/orchestration/`, `src/providers/pipelines.ts` (import shuffles only — eyeball its diff to be moves/imports, zero logic), and `tests/`. NO gateway-repo changes (`git -C ../waifucave-gateway status --short` empty).
3. Confirm `tests/pipelines.test.ts` and `tests/runtime.test.ts` files are byte-identical to baseline (`git diff <baseline> -- tests/pipelines.test.ts tests/runtime.test.ts` empty).
4. Spot-check rule 4: `grep -n "providerId ===" src/orchestration/pipeline/*.ts` → only the documented google-flat-dream exception (which keys on `wire`, so ideally zero hits).
5. Append the execution record to this plan; update MIGRATION_PLAN §8 P3 row to "P3a done — side-by-side pipeline live in tests; cutover pending P3b".
6. Push per standing rule (app repo pushes are authorized this round; gateway untouched).

## Subagent execution notes

- Full task text in every prompt; two-stage review (spec, then quality); independently verify every implementer report; fix-first findings fixed before moving on.
- The plan pins goldens from the registry at gateway `c279736`. Mismatch → print live output → fix the TEST (registry/data authoritative), record drift.
- Where a step says "read the current implementation and mirror it", the implementer MUST open pipelines.ts at the cited region before writing — behavior parity with today's wire bodies is the contract; the untouched pipelines.test.ts plus the new goldens are the dual referee.
- Concurrent workstreams may land; `git status` before commits; counts are indicative.

---

## Execution record (2026-06-13)

**P3a COMPLETE and signed off** — 7 commits (`eddd5af` → `06112c6`), **631 passed | 15 skipped** (was 593+15), typecheck + `build:backend` clean, gateway repo untouched, `tests/pipelines.test.ts` + `tests/runtime.test.ts` byte-identical throughout (the referee held). All six ModelPipeline methods live on the gateway client behind `createGatewayModelPipeline` (unused by production until P3b). Subagent-driven, two-stage review per task, all implementer reports verified independently.

Reviewer-driven deviations folded into task commits:
- **T2:** pre-conform guard — the reasoning-disable remedy only fires when the model HAS `reasoning.enabled` (prevents loop churn + misleading non-convergence error on models where forced tools are unsupported outright); `import type` consistency; 2 extra policy-edge tests.
- **T3:** registry says deepseek `multipleSystemMessages: false` (verified cell) → the new builder sends `<system_note>` user turns where legacy sends real mid-conversation system turns. Reviewer ruled the NEW behavior more correct than legacy; **P3b cutover smoke must eyeball a live DeepSeek prompt**.
- **T5:** queryLog parity restored (reply bodies via `response.clone()` fire-and-forget; query body top-level so the allowlist captures fields) — without this the dashboard Replies/Queries tabs would have gone blank for gateway calls.
- **T6:** Critical parity catch — the legacy `/run` guard (`replyRequired` ⇒ must reply) was missing; added + ZodError wrapping in `parseForcedCall` + reviewer `maxOutputTokens ?? 64` default. `topP` deliberately NOT added to decision sampling (legacy parity).
- **T6 re-pin:** deepseek emits `reasoning_effort` from the registry DEFAULT even with thinking disabled — known P1b data carryover, harmless (provider ignores it), not a pre-conform bug.
- **Final review (the big catch):** gateway `decideDream` parsed Gemini's FLAT ops with the nested schema — every `add`/`promote`/`merge`/`rewrite` from Gemini would have thrown at P3b cutover. The T8 golden missed it because `decay` is shape-identical flat vs nested. Fixed by moving legacy's `normalizeDreamOp`/`RawDreamOpSchema` (+ raw observation coercion for stringified importance) to tools.ts, used by BOTH pipelines; flat `add`/`promote` goldens added (`06112c6`).

**Found, NOT fixed (out of P3a scope — pre-existing W3 bug in main):** `RawStageManagerObservationSchema` has no `entities` field, and ALL FOUR legacy protocol classes parse observations through it (zod strips unknown keys) → **model-provided observation `entities` are silently discarded in production today**, despite the observer tool schema requesting them (W3 "observer gains entities"). The gateway pipeline mirrors this for parity. One-line fix candidate (add `entities: z.array(z.string()).optional()` to the raw schema in tools.ts) — belongs to the overhaul owner's call since it changes live W3 behavior.

**P3b carryovers:** cutover wiring (call sites construct via providerId+modelId from config + legacy-id map for gpt-4o/gpt-4o-mini/glm-5-turbo/gemini-3.5-flash), /api/models legacy-field rewire, deletions (pipelines.ts, catalog.ts + their tests), frontend ReasoningControls literals, live smoke incl. DeepSeek prompt-shape eyeball + Gemini dream `add` op live.
