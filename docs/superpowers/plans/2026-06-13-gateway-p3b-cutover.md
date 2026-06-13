# Gateway P3b: Orchestration Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete MIGRATION_PLAN §8 P3 — switch all production traffic to the gateway-backed `ModelPipeline` (built in P3a), delete `src/providers/pipelines.ts` + `src/providers/catalog.ts` + their tests, rewire the legacy `/api/models`//`/api/providers` fields off the catalog, and live-smoke the cutover.

**Architecture:** A new resolver (`resolveModelTarget`) turns stored config `(providerId?, modelId)` into a gateway `(providerId, modelId)` pair — applying the §7.3 legacy-id map for the four ids the registry doesn't carry, deriving the provider from the registry for modelId-only configs (native routes preferred over openrouter). `runtime.ts`'s `createPipeline` DI seam changes signature to take `{providerId, modelId, queryRole}`; its 107 test fakes are mostly zero-arg closures and survive structurally. Capability checks that used `getModel` (OCR image gating, tools-supported gating, max-output validation) move to `gateway.getCapabilities`. The API's legacy `models`/`providers` fields are synthesized from the registry (legacy 6 providers only; new providers stay in `gatewayModels`/`gatewayProviders` until P5). Then the two big files and their 2,918-line test die.

**Tech Stack:** as P3a. Baseline: **631 passed | 15 skipped**, HEAD `7751e4b` (includes the entities fix), typecheck/build clean.

---

## Hard rules

1. `tests/runtime.test.ts` fakes stay interface-level — edits there are limited to: the `createPipeline` seam's new signature where a fake actually takes arguments, and removed imports. NO behavioral test rewrites.
2. The gateway repo is read-only EXCEPT if the in-flight DeepSeek research verdict (running concurrently) flips `multipleSystemMessages` — that lands as its own gateway data commit + app test re-pin, coordinated by the controller, not by task implementers.
3. Deletions happen LAST (Task 6), only after all consumers are off the catalog and the suite is green without it.
4. Frontend: only `src/frontend/components/ReasoningControls.tsx` literals + `api/types.ts` if strictly needed; no view redesigns (P5).
5. Stage only named files; untracked `research/`, `new providers.md` exist.

## Verified facts (carried from the P3a audit + P2; re-verify only what a task touches)

- `pipelineFor(modelId)` at `runtime.ts:2531` derives provider via `getModel`, reads `user/providers.json` itself, calls `this.createPipeline(modelId, {apiKey})`; seam declared ~`runtime.ts:208` (`options.createPipeline ?? createModelPipeline`). Call sites pass `queryRole`-equivalent context implicitly per method — the new factory needs explicit `queryRole`: orchestrator→"orchestrator", waifu→"waifu", observer→(today's role used by pipelines: "stage_manager_observer"), dream→"dream", reviewer→(check `queryRole:` strings in pipelines.ts decideReviewer), personaDigest→(check; server.ts:1519 path).
- Other catalog consumers: `messagesForModel` (`runtime.ts:2547`, OCR gating via `supportsImageInput`), `buildWaifuToolUseInstructions` (`runtime.ts:3686`, `supportsTools`), `validateMaxOutputTokens` (inside pipelines.ts — dies with it; the gateway pre-flight validates instead), `server.ts` legacy fields (:295-353) + persona-digest resolver (:1519-1555), eval tier-2 wrappers (`tests/eval/*.eval.test.ts`, live-gated).
- Legacy-id map (§7.3 + registry diff): `gpt-4o`→`openai/gpt-5-mini`, `gpt-4o-mini`→`openai/gpt-5-nano`, `glm-5-turbo`→`zai/glm-5`, `gemini-3.5-flash`→`google-ai-studio/gemini-3-flash-preview`. All other current catalog ids exist verbatim in the registry under the same provider (xai keeps its three variant slugs; `claude-haiku-4-5-20251001`, `gemini-3.1-flash-lite`, etc.).
- Frontend reads from legacy `ModelCapability`: `modelId`, `providerId`, `displayName`, `reasoningControls` (string[] — legacy uses `reasoning.budget_tokens` SNAKE for the budget control; registry params use `reasoning.budgetTokens` — synthesis must emit the legacy snake name), `defaultTemperature`, `defaultTopP`, `maxOutputTokens`; cosmetically (ProvidersView pills): `client`, `endpoint`, `supportsTools/StructuredOutput/Streaming/ImageInput`, `safeDefaultRoles`. `ReasoningControls.tsx:7-26` hard-branches on provider+model literals — new registry-only ids fall back to generic low/medium/high (acceptable pre-P5); the four REMAPPED ids must keep working (they map to registry models with reasoning controls).
- `gemini-2.0-flash` is dead upstream (404, doc records the shutdown) — EXCLUDE it from the synthesized legacy list (and it has no legacy stored-config equivalent).
- Registry summary fields available for synthesis via `createGatewayHandler`'s ModelSummary or directly via `Registry`/`getCapabilities` (limits, params with defaults, features, modalities, wire). `defaultTemperature`/`defaultTopP` = registry param descriptor `default` if present, else omit (placeholders vanish — cosmetic).
- P3a smoke items to verify live in Task 7: DeepSeek prompt shape (system_note vs system turns — pending research verdict), Gemini dream `add` op end-to-end, one full orchestrator decision + waifu generation on real providers (cheap models only: deepseek-v4-flash, gemini-2.5-flash-lite, claude-haiku, gpt-5.4-nano; respect the no->$10/MTok rule).

## File structure

```
src/orchestration/pipeline/
└── resolveTarget.ts            # T1 NEW: LEGACY_MODEL_MAP + resolveModelTarget(config) + registryCapabilities helpers
src/orchestration/runtime.ts    # T2-T3: pipelineFor → new factory; OCR/tools gating via registry
src/api/server.ts               # T4: legacy fields synthesized from registry; persona-digest resolver on new factory
src/frontend/components/ReasoningControls.tsx  # T4: only if a remapped id breaks a branch (verify, minimal)
tests/eval/*.eval.test.ts       # T5: wrap new factory
src/providers/pipelines.ts      # T6 DELETE
src/providers/catalog.ts        # T6 DELETE
tests/pipelines.test.ts         # T6 DELETE
src/providers/types.ts          # T6: remove ModelCapabilityMetadata/ProviderMetadata if unreferenced after T4 (interface types STAY — deviation from §7.1's "move types", justified: avoids pure-churn import rewrites across runtime.ts + runtime.test.ts)
tests/resolveTarget.test.ts     # T1 NEW
tests/runtime.test.ts           # T2: seam-signature touches only
```

---

### Task 1: `resolveModelTarget` + legacy-id map

**Files:** Create `src/orchestration/pipeline/resolveTarget.ts`; Test `tests/resolveTarget.test.ts`.

- [ ] **Step 1: failing tests**

```ts
// tests/resolveTarget.test.ts
import { describe, expect, it } from "vitest";
import { LEGACY_MODEL_MAP, resolveModelTarget } from "../src/orchestration/pipeline/resolveTarget.js";

describe("resolveModelTarget", () => {
  it("maps the four retired catalog ids per MIGRATION_PLAN §7.3", () => {
    expect(resolveModelTarget({ modelId: "gpt-4o" })).toEqual({ providerId: "openai", modelId: "gpt-5-mini", remapped: true });
    expect(resolveModelTarget({ modelId: "gpt-4o-mini" })).toEqual({ providerId: "openai", modelId: "gpt-5-nano", remapped: true });
    expect(resolveModelTarget({ modelId: "glm-5-turbo" })).toEqual({ providerId: "zai", modelId: "glm-5", remapped: true });
    expect(resolveModelTarget({ modelId: "gemini-3.5-flash" })).toEqual({ providerId: "google-ai-studio", modelId: "gemini-3-flash-preview", remapped: true });
    expect(Object.keys(LEGACY_MODEL_MAP)).toHaveLength(4);
  });

  it("passes through ids that exist in the registry, deriving the native provider", () => {
    expect(resolveModelTarget({ modelId: "deepseek-v4-flash" })).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash", remapped: false });
    expect(resolveModelTarget({ modelId: "claude-haiku-4-5-20251001" })).toEqual({ providerId: "anthropic", modelId: "claude-haiku-4-5-20251001", remapped: false });
  });

  it("honors an explicit providerId when the pair exists", () => {
    expect(resolveModelTarget({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6" })).toEqual({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6", remapped: false });
  });

  it("throws a clear error for unknown ids", () => {
    expect(() => resolveModelTarget({ modelId: "totally-unknown" })).toThrow(/Unknown model/);
  });
});
```

- [ ] **Step 2: fail.** **Step 3: implement**

```ts
import { Registry } from "@waifucave/gateway";
import { GatewayPipelineError } from "./params.js";

/** §7.3: stored ids whose models left the catalog — conservative substitutes. */
export const LEGACY_MODEL_MAP: Record<string, { providerId: string; modelId: string }> = {
  "gpt-4o": { providerId: "openai", modelId: "gpt-5-mini" },
  "gpt-4o-mini": { providerId: "openai", modelId: "gpt-5-nano" },
  "glm-5-turbo": { providerId: "zai", modelId: "glm-5" },
  "gemini-3.5-flash": { providerId: "google-ai-studio", modelId: "gemini-3-flash-preview" }
};

let registry: Registry | undefined;
export function sharedRegistry(): Registry {
  registry ??= Registry.load();
  return registry;
}

export type ModelTarget = { providerId: string; modelId: string; remapped: boolean };

/**
 * Stored config → gateway route. Explicit (providerId, modelId) wins when the
 * pair resolves; bare modelId derives its provider from the registry with
 * native routes preferred over openrouter; retired ids remap per §7.3 (callers
 * should log when `remapped` — P4 migrates storage and removes this shim).
 */
export function resolveModelTarget(config: { providerId?: string; modelId: string }): ModelTarget {
  const mapped = LEGACY_MODEL_MAP[config.modelId];
  if (mapped) return { ...mapped, remapped: true };
  const reg = sharedRegistry();
  if (config.providerId && reg.resolve(config.providerId, config.modelId)) {
    return { providerId: config.providerId, modelId: config.modelId, remapped: false };
  }
  const candidates = reg.listModels().filter((ref) => ref.modelId === config.modelId);
  const preferred = candidates.find((ref) => ref.providerId !== "openrouter") ?? candidates[0];
  if (!preferred) throw new GatewayPipelineError(`Unknown model ${config.modelId}`);
  return { providerId: preferred.providerId, modelId: preferred.modelId, remapped: false };
}
```

(Verify `Registry.load()`/`resolve`/`listModels` signatures against the gateway d.ts; adapt and report.)

- [ ] **Step 4-5: pass; full suite; commit** `feat: model target resolver with §7.3 legacy-id map`.

---

### Task 2: Cut `runtime.ts` over to the gateway pipeline

**Files:** Modify `src/orchestration/runtime.ts`; Modify `tests/runtime.test.ts` (seam signature only); Test: existing suite is the referee.

- [ ] **Step 1:** Read `runtime.ts:200-215` (seam type), `pipelineFor` (:2531-2545), `readProviderCredentials` usage (:2562), every `pipelineFor(`/`createPipeline` call site, and each method call's surrounding context to capture today's queryRole per call (grep `queryRole` in pipelines.ts for the role strings each method passes: decideOrchestrator→"orchestrator", generateWaifu→"waifu", observations→"stage_manager_observer", decideDream→"dream", decideReviewer→<read it>, generatePersonaDigest→<read it>).
- [ ] **Step 2:** Change the seam: `createPipeline?: (target: { providerId: string; modelId: string; queryRole: QueryRole }) => ModelPipeline` defaulting to `(target) => createGatewayModelPipeline({ ...target, dataRoot: this.dataRoot-equivalent })` (find where runtime gets its data root — StorageService `storage.dataRoot`). `pipelineFor(modelId, queryRole)` becomes: `resolveModelTarget({ providerId: configProviderId, modelId })` (thread the config's providerId where available at call sites) → log a warning when `remapped` (`logger.warn("Legacy model id remapped", {from, to})`) → `this.createPipeline({providerId, modelId, queryRole})`. DELETE the in-runtime credentials read (the gateway resolves keys live). Update all call sites to pass queryRole + config providerId.
- [ ] **Step 3:** Replace remaining catalog uses in runtime.ts: `messagesForModel` gates OCR on `sharedRegistry().resolve(target.providerId, target.modelId)?.modalities.input.includes("image")`; `buildWaifuToolUseInstructions` gates on `...features.tools.supported`. Remove the `getModel` import. The call sites must have a resolved target in scope — thread it or resolve locally (keep minimal; mirror existing structure).
- [ ] **Step 4:** `npx vitest run tests/runtime.test.ts` — fix ONLY seam-signature fallout in fakes (zero-arg closures need nothing; `(modelId) =>` fakes become `({modelId}) =>` etc.). Behavioral assertions untouched. Then full suite + typecheck.
- [ ] **Step 5:** Commit `feat: cut runtime orchestration over to the gateway pipeline`.

---

### Task 3: Persona digest + remaining server-side construction

**Files:** Modify `src/api/server.ts` (`resolvePersonaDigestPipeline` :1519-1555 region only).

- [ ] Replace `createModelPipeline(modelId, {apiKey})` with `resolveModelTarget` + `createGatewayModelPipeline({..., queryRole: <today's role>, dataRoot: options.dataRoot})`; drop the local credentials read. Existing api tests must stay green (digest tests fake at HTTP/fetch level? — read tests/api.test.ts digest coverage first; if it stubs createModelPipeline via DI, mirror). Full suite; commit `feat: persona digest on the gateway pipeline`.

---

### Task 4: Legacy API fields synthesized from the registry

**Files:** Modify `src/api/server.ts` (/api/models + /api/providers legacy fields, getModel import gone); possibly `src/frontend/components/ReasoningControls.tsx`; Test `tests/api.test.ts` (adjust ONLY the legacy-field pins).

- [ ] **Step 1:** Write the synthesizer in server.ts (or a small `src/api/legacyCatalog.ts`): for the six legacy provider ids, list their NATIVE registry routes (exclude `gemini-2.0-flash`, exclude openrouter), mapping each `ResolvedModel` → legacy `ModelCapabilityMetadata` shape: `providerId`, `modelId`, `displayName`, `endpoint` (resolved endpoint), `client` (wire → legacy client-name map: openai-chat→"openai-compatible-chat", openai-responses→"openai-responses", anthropic-messages→"anthropic-messages", google-generative-language→"google-generative-language"), `supportedRoles` (synthesize from systemRole/wire — cosmetic), `supportsTools/StructuredOutput/Streaming/ImageInput` from features/modalities, `reasoningControls` (registry `reasoning.*` param keys present, with `reasoning.budgetTokens` renamed to `reasoning.budget_tokens`), `maxContextTokens`/`maxOutputTokens` from limits (omit zeros), `defaultTemperature`/`defaultTopP` from param defaults (omit when absent), `safeDefaultRoles` = all four (legacy cosmetic). Providers legacy field: keep id/displayName/credentialName(=credentialEnv)/baseUrl/docsUrl(=keep a small static map or reuse baseUrl)/models.
- [ ] **Step 2:** Update the `tests/api.test.ts` legacy pins: counts change (23 → the new count — compute it; assert the presence of `deepseek-v4-flash` and `claude-haiku-4-5-20251001`, absence of `gpt-4o` and `gemini-2.0-flash`, and one full synthesized entry golden). gatewayModels/gatewayProviders unchanged.
- [ ] **Step 3:** Check `ReasoningControls.tsx` literals against the new id set: every literal it branches on must still exist (they do — registry kept claude-opus-4-7/grok-4.3/gemini-3* ids) — if a branch references a REMOVED id (gemini-3.5-flash), update that literal to the remapped id. Frontend typecheck.
- [ ] **Step 4-5:** Full suite; commit `feat: synthesize legacy model catalog fields from the gateway registry`.

---

### Task 5: Eval harness onto the factory

**Files:** Modify `tests/eval/orchestrator.eval.test.ts`, `tests/eval/waifu.eval.test.ts`.

- [ ] Swap their `createModelPipeline` wrapping to `createGatewayModelPipeline` + `resolveModelTarget` (they're `describe.skip` unless `WAIFUS_EVAL_LIVE=1` — ensure they still COMPILE and the skip path runs; don't run live). Full suite; commit `chore: eval harness drives the gateway pipeline`.

---

### Task 6: Deletions

**Files:** Delete `src/providers/pipelines.ts`, `src/providers/catalog.ts`, `tests/pipelines.test.ts`; Modify `src/providers/types.ts` (drop now-unreferenced catalog types + the `ModelCapabilityMetadata`-typed imports), any straggler imports (`grep -rn "providers/pipelines\|providers/catalog" src/ tests/` must end empty).

- [ ] Delete; fix stragglers; `npm run typecheck && npx vitest run && npm run build:backend` all green (suite count drops by pipelines.test.ts's ~100). Commit `feat!: delete legacy provider pipeline and catalog — gateway serves all traffic`.

---

### Task 7: Live smoke (controller-run, not subagent)

- [ ] `npm run waifus -- start`; via `/api/llm` AND through a node script driving `createGatewayModelPipeline` with real keys (cheap models only): one decideOrchestrator (deepseek), one generateWaifu (anthropic haiku, eyeball the wire body via query log for system_note placement per the research verdict), one decideDream against gemini-2.5-flash-lite with a real flat `add` op, one generatePersonaDigest (any). Verify `/api/models` serves the synthesized list; dashboard Queries/Replies tabs populate. Stop server. Record results in the execution record. Discord-server-level smoke is handed to the user (their dev server/bots).

---

## Final review checklist
Full-implementation reviewer over `7751e4b..HEAD`; §8 P3 row → done; execution record; push after user-visible report. The DeepSeek research verdict lands wherever it lands: if `multipleSystemMessages` flips to true, gateway data commit + `tests/gatewayMessages.test.ts` re-pin (deepseek moves to the system-turns branch) + rebuild — controller coordinates.

## Subagent notes
Full task text per prompt; two-stage review (combined acceptable for small tasks); verify reports independently; fix-first. Counts indicative; concurrent landings possible.
