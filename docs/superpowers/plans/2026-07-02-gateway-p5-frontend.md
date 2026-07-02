# Gateway P5 — Frontend on the Capability Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the SPA's model/param UX from the gateway capability surface — generic `ModelParamsForm` from param descriptors, two-level model→route picker, gateway-backed ProvidersView — then retire the P4 server compat layer (MIGRATION_PLAN §7.6).

**Architecture:** A new `src/frontend/api/llm.ts` client hits `/api/llm/v1/*` (models list, per-model `ResolvedModel` capability doc, `POST /v1/validate`), with gateway types via **type-only imports** from `@waifucave/gateway` (erased at compile time — no bundling risk; NEVER value-import the package client-side, its Registry touches `node:fs`). Pure logic (descriptor→control model, route grouping, violation mapping) lives in `src/frontend/components/modelParams/logic.ts`, unit-tested Node-side (house precedent: `tests/promptLayoutEditor.test.ts`). Live constraint behavior = debounced `POST /v1/validate` (200-with-`ok:false` semantics), not a client-side rule evaluator. Views write native `params` bodies; the P4 compat layer then dies.

**Tech Stack:** React 19, no CSS modules (global `app.css` utility classes), Vite, gateway HTTP API (no auth, same-origin).

## Global Constraints

- Baseline suite: **588 passed | 15 skipped**. `npm run typecheck && npx vitest run && npm run build` green at every commit (typecheck covers `src/frontend/tsconfig.json`).
- No new frontend test infra (no jsdom/@testing-library) — testable logic is EXTRACTED into pure modules under `src/frontend/**` and tested from `tests/*.test.ts` in Node.
- Type-only imports from `@waifucave/gateway` are allowed in frontend code (`import type {...}`); value imports are FORBIDDEN (node:fs). If a needed type (e.g. `ModelSummary`) is not exported from the package's public entry, define it locally in `api/llm.ts` from the observed JSON — do not deep-import `dist/` paths.
- House form idiom: `div.field` > `label.field-label` + control + `span.field-hint`; controls use `.input`/`.select`/`.toggle` classes; sections via `section`/`section-title`. Match `WaifusView.tsx` visually.
- Do NOT add any `responseFormat`/structured-output control anywhere (anthropic codec gap — MIGRATION_PLAN known gap; out of P5 scope).
- The two readiness-only consumers (`DashboardView.tsx:45`, `SetupView.tsx:19`) keep using legacy `api.providers()` — untouched this phase. Legacy `/api/models`+`/api/providers` endpoints and `legacyCatalog.ts` STAY (dropping them is a P6 call).
- `src/shared/paramsCompat.ts` STAYS (the boot migration consumes it) — only the server.ts compat layer dies in T6.
- ESM `.js` local imports in backend files; frontend uses Bundler resolution (extensionless OK, follow existing style).
- Never stage `new providers.md` or `research/`. Commit to main per task. Never print/log API keys.

---

### Task 1: `llm` client + pure param/route logic

**Files:**
- Create: `src/frontend/api/llm.ts`, `src/frontend/components/modelParams/logic.ts`
- Test: `tests/modelParamsLogic.test.ts`

**Interfaces (produced; T2/T3/T5 consume):**
```ts
// api/llm.ts — reuse the request<T> pattern from client.ts (same-origin fetch, ApiError on non-OK);
// unwrap the gateway error envelope {error:{kind,message}} into ApiError message.
export type LlmModelSummary = { providerId: string; modelId: string; family: string; displayName: string; company: string; wire: string; contextTokens?: number; maxOutputTokens?: number; streaming: boolean; tools: boolean; reasoning: boolean; jsonMode: boolean; jsonSchema: boolean; imageInput: boolean; deprecated: boolean; confidence: string; routeStatus?: string };
export type { ResolvedModel, ParamDescriptor, ConstraintRule } from "@waifucave/gateway"; // verify public exports; else local defs
export type LlmValidationViolation = { param: string; code: string; ruleId?: string; message?: string };
export type LlmValidationResult = { ok: boolean; violations: LlmValidationViolation[]; warnings: Array<{ code: string; param?: string; message?: string }>; effectiveParams: Record<string, unknown> };
export async function llmModels(): Promise<LlmModelSummary[]>;                       // GET /api/llm/v1/models (module-memoized promise)
export async function llmModel(providerId: string, modelId: string): Promise<ResolvedModel>; // GET /api/llm/v1/models/:p/:m (Map-memoized; modelId may contain "/" — encode path segments individually, the gateway route matches ≥4 segments)
export async function llmValidate(input: { provider: string; model: string; params: Record<string, unknown> }): Promise<LlmValidationResult>; // POST /api/llm/v1/validate — 200 even when ok:false
export async function llmProviders(): Promise<Array<{ id: string; displayName: string; baseUrl: string; credentialConfigured: boolean; wire: string }>>; // GET /api/llm/v1/providers
```
```ts
// components/modelParams/logic.ts — PURE, no React, no fetch.
export type ParamControl = { key: string; descriptor: ParamDescriptor; group: "sampling" | "reasoning" | "other"; unverified: boolean };
export function buildParamControls(doc: Pick<ResolvedModel, "params">): ParamControl[];
// order: sampling group (temperature, topP, maxOutputTokens, stopSequences first, then rest alphabetical),
// then reasoning.* (reasoning.enabled first, then alphabetical), then other alphabetical.
// unverified = descriptor.confidence === "unverified".
export function violationsByParam(violations: LlmValidationViolation[]): Record<string, string>;
// param -> human message: prefer violation.message; else `${code}${ruleId ? ` (rule ${ruleId})` : ""}`.
export type RouteGroup = { key: string; displayName: string; company: string; routes: LlmModelSummary[] };
export function groupModelRoutes(models: LlmModelSummary[]): RouteGroup[];
// group key = `${company}|${displayName}`; exclude deprecated models; sort groups by company then displayName;
// within a group sort routes: non-openrouter first, then openrouter.
export function defaultRoute(group: RouteGroup, configuredProviderIds: Set<string>): LlmModelSummary | undefined;
// first non-openrouter route whose providerId is configured; else openrouter route if configured; else first route.
export function findRoute(models: LlmModelSummary[], providerId: string, modelId: string): { group: RouteGroup; route: LlmModelSummary } | undefined;
// resolves a STORED pair back to its group (for editing an existing config); undefined for unknown ids (caller renders raw id fallback).
```

- [ ] **Step 1: failing tests** (`tests/modelParamsLogic.test.ts`, Node, no DOM): `buildParamControls` ordering + grouping + unverified flag from a hand-built doc fixture containing temperature/topP/stopSequences/reasoning.enabled/reasoning.effort/reasoning.exclude/topK with one `confidence:"unverified"` cell; `violationsByParam` message preference incl. ruleId fallback; `groupModelRoutes` merges a native+openrouter pair of the same `company|displayName`, excludes a `deprecated:true` entry, orders openrouter last; `defaultRoute` all three branches; `findRoute` for stored native, stored openrouter, and unknown ids. ALSO an integration-grade fixture test: load two REAL docs from the registry via a Node-side value import of `@waifucave/gateway` (allowed in tests — Node env) — e.g. resolve `anthropic/claude-haiku-4-5-20251001` and one openrouter route — and assert `buildParamControls`/`groupModelRoutes` don't throw and produce non-empty sensible output (pins the real descriptor shape).
- [ ] **Step 2: implement** both modules per the interfaces. In `llm.ts`, check `@waifucave/gateway`'s package exports for the type names; any not publicly exported → define locally (copy the shape from the audit: ParamDescriptor `{type,min?,max?,step?,values?,maxItems?,default?,wireName?,confidence?}`, ConstraintRule `{id,when,then,source?}`).
- [ ] **Step 3: verify** — `npx vitest run tests/modelParamsLogic.test.ts` green; `npm run typecheck && npm run build` (proves type-only imports don't break the Vite bundle); full suite 588+new.
- [ ] **Step 4: commit** — `feat: llm capability client and model-params logic for the SPA`

### Task 2: `ModelParamsForm` + field primitives

**Files:**
- Create: `src/frontend/components/modelParams/ModelParamsForm.tsx`, `src/frontend/components/modelParams/RangeField.tsx`, `src/frontend/components/modelParams/TagListField.tsx`
- Modify: `src/frontend/styles/app.css` (slider + tag-list styles, follow `tokens.css` vars)

**Interfaces (produced; T3/T4 consume):**
```tsx
export function ModelParamsForm(props: {
  providerId: string | null; modelId: string | null;
  value: Record<string, unknown>;                    // the config's params record
  onChange: (params: Record<string, unknown>) => void;
  onValidity?: (ok: boolean) => void;                // views disable Save on false
}): JSX.Element | null;
```
Behavior (exact):
- No provider/model → render `null`. Fetch doc via `llmModel` (loading → `Skeleton`, 404 → `Notice` "capability doc unavailable for <id>" and render nothing else — the unknown-stored-model case must not crash).
- Render `buildParamControls(doc)` grouped under two `section-title`s ("Sampling", "Reasoning") + "Advanced" for `other`. Control per descriptor.type: `number`/`int` with min+max → `RangeField` (range input + synced number input, step from descriptor, int coerces); without both bounds → plain `.input` number; `boolean` → `Toggle`; `enum` → `.select` over `descriptor.values`; `string[]` → `TagListField` (chips + text entry, enforce `maxItems`); `string` → `.input`; `map` → skip (no UI). Unset params render empty with `descriptor.default` as placeholder — an untouched control stores NO key (absent ≠ default).
- Unverified descriptors get a `Pill` "unverified" and hint "not enforced — probe pending".
- Live validation: on `value` change, debounce 400ms → `llmValidate({provider, model, params: value})`; inline per-field error text from `violationsByParam`; `warnings` (dropped/forced/clamped) as a single `Notice tone="warn"` listing them; call `onValidity(result.ok)`. Fetch failures of validate → do not block editing (log, `onValidity(true)` — server-side write validation is the backstop).
- Clearing a field deletes its key from `value` (never write `undefined`/empty string).

- [ ] **Step 1: extract & test what's pure** — chip-list add/remove/maxItems and range clamping live in `logic.ts` additions (`clampToDescriptor(descriptor, raw): number | undefined`, `addTag(list, raw, maxItems)`) with tests FIRST in `tests/modelParamsLogic.test.ts`.
- [ ] **Step 2: build the components** per above; visual idiom copied from WaifusView fields.
- [ ] **Step 3: verify** — typecheck + build + full suite; manual `npm run dev:frontend` spot-check optional (controller does the real smoke in T7).
- [ ] **Step 4: commit** — `feat: descriptor-driven ModelParamsForm with live gateway validation`

### Task 3: WaifusView on the new surface

**Files:**
- Modify: `src/frontend/views/WaifusView.tsx`, `src/frontend/api/types.ts` (WaifuConfig: `generation`/`reasoning` → `params: Record<string, unknown>`), `src/frontend/api/client.ts` (updateWaifu/createWaifu body types)

**Design (exact):**
- Replace the provider→model selects (556-588) with the two-level picker: select #1 = model (options from `groupModelRoutes(await llmModels())`, label `${company} — ${displayName}`, value = group key; current stored pair resolved via `findRoute`, unknown stored ids render an extra option `"<providerId>/<modelId> (unavailable)"` kept selected — never silently dropped); select #2 = route (visible only when the group has >1 route; label `providerId` + " (no key)" suffix when unconfigured via `llmProviders()`; default from `defaultRoute`). Picking writes BOTH `providerId` and `modelId` on the draft.
- Replace temperature/topP/maxOutputTokens fields (589-636) + `ReasoningControls` (637-641) with `<ModelParamsForm providerId modelId value={draft.params ?? {}} onChange onValidity/>`.
- `persistWaifu` (334-350) sends `params` natively; `generation`/`reasoning` REMOVED from the body and from all draft state (`setGen` dies).
- Save-error surfacing: when `ApiError.body.details?.violations` exists, render each `{param, code, rule}` as its own line in the error Notice (not just the top-line message) — covers both `unsupported_parameter` and lumi's `unknown_model`.
- Waifu table row (89-95) keeps rendering raw `providerId/modelId` text.

- [ ] **Step 1** — no new pure logic expected; if any emerges (e.g. option-building), extract to `logic.ts` with a test first.
- [ ] **Step 2: implement; Step 3: verify** — typecheck + build + full suite (server compat layer still up, so the API accepts the new native-params body already — pinned by P4 tests).
- [ ] **Step 4: commit** — `feat: waifu editor drives gateway params and two-level model picker`

### Task 4: the three agent views

**Files:**
- Modify: `src/frontend/views/OrchestratorView.tsx`, `StageManagerView.tsx`, `ReviewerView.tsx`, `src/frontend/api/types.ts` (AgentConfig: `reasoning` → `params`)

**Design:** same swap as T3 — two-level picker replacing the provider/model selects, `ModelParamsForm` replacing `ReasoningControls` (agents thereby GAIN sampling params; backend already accepts/validates them). PUT bodies become explicit `{expectedRevision, enabled, providerId, modelId, contextWindow, prompt, params, ...view-specific fields}` — the `...remoteConfig.data` full-echo spread DIES (that echo caused P4's worst bug; send only what the view owns). Same violations-detail error rendering as T3.

- [ ] **Step 1-3: implement each view, verify** (typecheck + build + full suite) — one commit is fine.
- [ ] **Step 4: commit** — `feat: agent views on gateway params with explicit write bodies`

### Task 5: ProvidersView on the gateway registry

**Files:**
- Modify: `src/frontend/views/ProvidersView.tsx`, `src/frontend/api/types.ts` (drop `GatewayProviderSummary`/`GatewayModelSummary` mirrors — llm.ts owns those types now)

**Design (exact):**
- Provider list from `llmProviders()` (all 14, `credentialConfigured` flag) merged with legacy `api.providers()` ONLY for `credentials.lastFour`/`updatedAt` display and `docsUrl` (legacy endpoint stays; openrouter/moonshot/etc. rows without a legacy entry render without docsUrl). Credentials modal works for every provider id (P4 made them storable).
- Model grid per provider from `llmModels()` filtered by providerId: pills from summary flags (`tools`/`jsonSchema`/`streaming`/`imageInput`/`reasoning`), `wire` + `contextTokens`, a `deprecated` pill, and the doc-level `confidence` as a pill when ≠ "verified". `ReasoningControlSummary` + `ModelCard`'s legacy-field rendering die.
- Keep the readiness semantics DashboardView/SetupView rely on untouched (they use the legacy endpoint; do not change its server shape).

- [ ] **Step 1-3: implement, verify** (typecheck + build + suite). **Step 4: commit** — `feat: providers view lists the full gateway registry`

### Task 6: purge mirrors + retire the P4 server compat layer

**Files:**
- Delete: `src/frontend/components/ReasoningControls.tsx`
- Modify: `src/frontend/api/types.ts` (delete `ProviderId` union → `type ProviderId = string`, `ReasoningEffort`, `ReasoningConfig`, `ModelCapability`, `ModelsResponse.models` typing to match what remains needed, `WaifuConfig`/`AgentConfig` leftovers), `src/api/server.ts` (remove: paramsCompat imports 61-67, legacy body sub-schemas 98-113, `.extend()` legacy fields on the three body schemas, `withLegacyViews` + all call sites, `resolveParamsPatch` + call sites, POST-waifu legacy destructure — audit §7 of the P5 scope map has exact lines), `tests/api.test.ts` (compat describe block 226-459 → rewritten as native-params pins: PUT `params` stores exactly; GET returns `params` and NO synthesized `reasoning`/`generation`; absent `params` on an unrelated PUT leaves stored params untouched — the PATCH semantic survives natively)
- Verify-only: `src/shared/paramsCompat.ts` stays (grep its remaining consumers — migrations + tests).

- [ ] **Step 1: rewrite the api tests first** (they fail against the still-present compat layer only where behavior changes — GET no longer carries synthesized fields), **Step 2: server + frontend deletions**, **Step 3: verify** — `grep -rn "withLegacyViews\|resolveParamsPatch\|legacyToParams\|paramsToLegacy" src/api/` empty; `grep -rn "ReasoningConfig\|ReasoningControls" src/frontend/` empty; typecheck + build + full suite green.
- [ ] **Step 4: commit** — `feat!: SPA writes gateway params natively; retire the legacy API compat layer`

### Task 7: browser smoke + closeout (controller-run)

- [ ] Boot backend + `npm run dev:frontend` against a COPY of the live data root (`DC_WAIFUS_HOME`); drive Chrome through: waifu editor (picker groups routes, sliders render with real bounds, invalid value shows inline violation, save persists native params), lumi (unknown-model fallback option + save shows unknown_model violation lines), an agent view save (explicit body, params persist), ProvidersView (14 providers, openrouter card, model pills, unverified/deprecated pills where real).
- [ ] `npm run build` + full suite final; MIGRATION_PLAN §8 P5 row + execution record here; commit docs; final whole-branch review; push after user-visible report.

### Final review
Whole-range review (base = T1's parent commit) on the most capable model; include the ledger's deferred-minor list for triage; fix-first.
