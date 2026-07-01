# Gateway P4 — Storage + Domain Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move stored configs to gateway-native dotted `params`, widen provider ids to the full registry, ship the one-shot storage migration with doctor warnings — per MIGRATION_PLAN §7.2/§7.3 — without breaking the current SPA (frontend rework is P5).

**Architecture:** `reasoning`/`generation` config objects collapse into `params: Record<string, unknown>` (dotted gateway keys) on `AgentConfigSchema` + `WaifuConfigSchema`; a shared `paramsCompat` module converts both directions and powers three consumers: the boot migration, a server-side API compat layer (GET synthesizes legacy views, PUT accepts legacy bodies) so the untouched SPA keeps working, and tests. `ProviderIdSchema` widens to `z.string().min(1)` with registry validation at API boundaries; `CURRENT_SCHEMA_VERSION` bumps 1→2 with a stamp migration across all revisioned files. Write-side param validation goes through `gateway.validate()` → 400 `unsupported_parameter` (reject-on-write; distinct from the chat path's lenient `preconformRequest`).

**Tech Stack:** zod v4, Fastify, `@waifucave/gateway` (file: symlink), Vitest with real temp roots.

**Deliberate deviation from §7.3 (flag at final review):** unmappable model ids are LEFT IN PLACE with a doctor warning — no "conservative substitute". Silently swapping a user's model changes behavior/cost; a loud warning + unchanged config is safer. On-disk reality: nothing in the live data root needs remapping today.

## Global Constraints

- ESM `NodeNext`: local imports use `.js` extensions.
- Baseline suite: **541 passed | 15 skipped**. Full `npm run typecheck && npx vitest run` green at every commit; `npm run build` (frontend included) green at T2 and T7.
- Tests use real temp roots via `makeTempRoot`/`removeTempRoot` from `tests/testUtils.ts`, cleanup in `afterEach`, no mocks for storage.
- **Do not boot the CLI against a real data root until T3 lands** (T2's schema strips legacy fields on parse; T3's migration makes that safe). T7 smokes against a COPY of `~/.dc-waifus` via `DC_WAIFUS_HOME`.
- Never print/log API keys. Never stage `new providers.md` or `research/`.
- Commit to main after each task. `src/frontend/api/types.ts` and all `src/frontend/` form components are UNTOUCHED in P4 (compat layer keeps them working; P5 owns the rework).
- The decision-rationale string field named `reasoning` (`domain.ts:479`, `decisions.ts:68`, `tools.ts` orchestrator schema) is UNRELATED to `ReasoningConfig` — do not touch it.

---

### Task 1: `paramsCompat` — shared legacy↔dotted conversion

**Files:**
- Create: `src/shared/paramsCompat.ts`
- Test: `tests/paramsCompat.test.ts`

**Interfaces (produced, used by T2/T3):**
```ts
export type LegacyReasoning = { enabled?: boolean; effort?: string; budgetTokens?: number };
export type LegacyGeneration = { temperature?: number; topP?: number; maxOutputTokens?: number };
export function legacyToParams(input: { reasoning?: LegacyReasoning; generation?: LegacyGeneration }): Record<string, unknown>;
export function paramsToLegacy(params: Record<string, unknown>): { reasoning: LegacyReasoning; generation: LegacyGeneration };
```

- [ ] **Step 1: failing tests** — pin: generation fields map to `temperature`/`topP`/`maxOutputTokens`; `reasoning.{enabled,effort,budgetTokens}` map to dotted keys; `effort: "none"` maps to ONLY `{"reasoning.enabled": false}` (drops effort/budget — must mirror `buildUnifiedParams` at `src/orchestration/pipeline/params.ts:31-38` exactly); empty inputs → `{}`; `paramsToLegacy` round-trips every key and ignores unknown keys (`stopSequences`, garbage); type-mismatched values (string temperature) are skipped by `paramsToLegacy`.
- [ ] **Step 2: implement** — `legacyToParams` copies each defined field to its dotted key with the `effort === "none"` special case first; `paramsToLegacy` reverses with `typeof` guards. No zod here — pure functions over loose shapes (migration reads raw JSON).
- [ ] **Step 3: verify** — `npx vitest run tests/paramsCompat.test.ts` green; full suite still 541 | 15.
- [ ] **Step 4: commit** — `feat: shared legacy<->gateway params conversion helpers`

### Task 2: params on domain schemas + runtime/pipeline flow + API compat layer

The atomic swap. Everything that compiles against `ReasoningConfig`/`generation` moves in one task so every commit stays green.

**Files:**
- Modify: `src/shared/schemas/domain.ts` (10-16, 235-244, 247-275), `src/providers/types.ts` (1, 47-52), `src/orchestration/pipeline/params.ts` (2, 16-40), `src/orchestration/pipeline/gatewayPipeline.ts` (sampling sites 140, 162, 182, 227, 246, 269), `src/orchestration/runtime.ts` (1117, 1515-1518, 1844, 2056, 2308), `src/api/server.ts` (body schemas 86-97, 126-128; GET/PUT handlers for waifus + the three agents), `src/config/prebuiltWaifus.ts` (4 generation literals)
- Test updates: `tests/gatewayParams.test.ts`, `tests/gatewayPipeline.test.ts`, `tests/runtime.test.ts`, `tests/api.test.ts`, `tests/eval/*.eval.test.ts`, any other `reasoning: {`/`generation: {` config literals (audit table §11 of the P4 scope map — verify per-line; most `reasoning` hits in runtime.test.ts are the rationale string)

**Design (exact):**
- `domain.ts`: DELETE `ReasoningConfigSchema` + `ReasoningEffortSchema` + `ReasoningConfig` type. `AgentConfigSchema`: `reasoning: ReasoningConfigSchema` → `params: z.record(z.string(), z.unknown()).default({})`. `WaifuConfigSchema`: `generation` object + `reasoning` → the same single `params` line. `CURRENT_SCHEMA_VERSION` stays 1 until T3.
- `providers/types.ts`: `ProviderRequest.reasoning?: ReasoningConfig` → `params?: Record<string, unknown>`. Per-call fields (`temperature`, `topP`, `maxOutputTokens`, `stopSequences`) STAY — they are role defaults / per-call plumbing.
- `params.ts`: `SamplingInputs.reasoning` → `params?: Record<string, unknown>`; `buildUnifiedParams` keeps the explicit-field handling, drops the reasoning block, and ends with `return { ...params, ...(inputs.params ?? {}) };` — config params override role defaults. (`effort:"none"` normalization now lives ONLY in `legacyToParams`; dotted params never contain `"none"`.)
- `gatewayPipeline.ts`: every `sampling: { ..., reasoning: request.reasoning }` → `sampling: { ..., params: request.params }`. Role defaults unchanged (orchestrator `temperature ?? 0.2`, reviewer `maxOutputTokens ?? 64`, etc.).
- `runtime.ts`: the five call sites pass `params: config.params` / `params: waifu.params`; the waifu site (1515-1518) drops the `waifu.generation.*` reads entirely.
- `server.ts` compat layer (keeps the SPA alive):
  - Response mapping for waifu GET/list and the three agent GETs: `const withLegacyViews = (c) => ({ ...c, ...paramsToLegacy(c.params ?? {}) });` — adds synthesized `reasoning`/`generation` beside `params`.
  - Body schemas accept `params: z.record(z.string(), z.unknown()).optional()` PLUS loose optional `reasoning`/`generation` records; handlers resolve `const params = body.params ?? legacyToParams(body);`, strip `reasoning`/`generation` before storing, store `params`. PUT responses go through `withLegacyViews` too.
- `prebuiltWaifus.ts`: `generation: {temperature: X, topP: Y}` literals → `params: {temperature: X, topP: Y}`; fix the `PrebuiltWaifu` `Pick<>` type.

- [ ] **Step 1: failing tests first** — api.test.ts: PUT waifu with legacy `{generation:{temperature:0.5}, reasoning:{effort:"high"}}` body stores `params: {temperature:0.5, "reasoning.effort":"high"}` and the GET response carries BOTH `params` and synthesized `reasoning`/`generation`; PUT with native `params` body wins over legacy fields; gatewayParams.test.ts: `buildUnifiedParams({temperature: 0.2, params: {temperature: 0.9, "reasoning.enabled": false}})` → config wins.
- [ ] **Step 2: schema + flow swap** as designed above; sweep test literals (mechanical: `reasoning: {enabled: false}` in request literals → `params: {"reasoning.enabled": false}`; config literals likewise).
- [ ] **Step 3: verify** — `npm run typecheck && npx vitest run` (541 + new, 0 fail) AND `npm run build` (frontend must still compile untouched).
- [ ] **Step 4: commit** — `feat!: unify config sampling/reasoning into gateway params with API legacy compat`

### Task 3: schema v2 + the §7.3 migration step

**Files:**
- Modify: `src/shared/schemas/common.ts:3` (`CURRENT_SCHEMA_VERSION = 2`), `src/backend/migrations.ts`
- Test: `tests/migrations.test.ts`

**Design (exact):**
- New step `migrateConfigsToGatewayParams(dataRoot)` → applied id `"migrate-configs-to-gateway-params"`, mirroring `migrateAgentConfigs` (migrations.ts:270) + `migrateWaifuPromptSections` (382) iteration patterns: for the three agent `config.json`s and every `user/waifus/*/waifu.json`: if `reasoning`/`generation` present → `doc.params = { ...legacyToParams(doc), ...(existing params) }`, delete both legacy fields; model remap: when `modelId` set, `try { const t = resolveModelTarget({providerId: doc.providerId, modelId: doc.modelId}); if (t.remapped) { doc.providerId = t.providerId; doc.modelId = t.modelId; } } catch { /* leave in place; doctor warns (T5) */ }`; write via `atomicWriteJson`.
- New step `stampSchemaVersion2(dataRoot)` → `"stamp-schema-version-2"`: set `schemaVersion: 2` on every persisted revisioned JSON still at 1. Enumerate explicitly from `src/config/layout.ts` (the data-layout authority — read it): root `config.json`, `runtime.json` (if present), `user/providers.json`, `user/discord-bots.json`, the three agent configs, `user/waifus/*/waifu.json`, `user/servers/**/*.json`, `user/memory/**/*.json`, history/session files. EXCLUDE the OCR cache (separate `CACHE_SCHEMA_VERSION` — verify its dir from `src/orchestration/ocr.ts` and skip it). Runs LAST in `runMigrations` so all shape conversions precede the stamp.
- Both steps idempotent (second run applies nothing).

- [ ] **Step 1: failing tests** — seed a temp root with a full v1 fleet: agent config with `reasoning:{effort:"medium"}`, waifu with `generation:{temperature:1.2}, reasoning:{enabled:false}` + one with `modelId:"gpt-4o"`, providers.json, discord-bots.json, a server file, a memory file. Assert after `runMigrations`: params converted exactly (`{"reasoning.effort":"medium"}` / `{temperature:1.2,"reasoning.enabled":false}`), `gpt-4o` → `openai/gpt-5-mini`, an unknown model id (`providerId:"openai", modelId:"bogus-model"`) left untouched, EVERY seeded file at `schemaVersion: 2`, all files parse under the current schemas, and a second `runMigrations` applies `[]`.
- [ ] **Step 2: implement both steps + bump the constant.** The bump ripples `z.literal(2)` everywhere automatically (common.ts:8, layout.ts, backend/runtime.ts, config.ts, session.ts — no edits there).
- [ ] **Step 3: verify** — full suite; grep test fixtures seeding `schemaVersion: 1` files parsed OUTSIDE runMigrations (they now fail `z.literal(2)`) and update them to seed v2 or route through runMigrations, whichever the test intends.
- [ ] **Step 4: commit** — `feat!: schema v2 — migrate stored configs to gateway params with model-id remap`

### Task 4: provider-id widening + registry validation at API boundaries

**Files:**
- Modify: `src/shared/schemas/domain.ts:4` (`ProviderIdSchema = z.string().min(1)`), `src/providers/types.ts` (ProviderId usages), `src/api/server.ts` (credentials PUT 324-349; waifu/agent config PUT handlers)
- Create: `src/api/writeValidation.ts`
- Test: `tests/api.test.ts`

**Design (exact):**
- `writeValidation.ts`: module-level `const validationGateway = createGateway({ credentials: () => undefined });` (validate needs no keys). Export:
  - `assertKnownProvider(providerId: string): void` — checks against the gateway's provider registry (verify the export: `PROVIDERS` map or equivalent in `@waifucave/gateway`; the audit saw 15 ids in `dist/registry/providers.js`); on failure throw the house 400 (`src/api/errors.ts` — use the existing ValidationError/badRequest helper, verify its name) with `{ error: "unknown_provider", providerId }`.
  - `assertKnownModel(providerId, modelId): void` — `resolveModelTarget` try/catch → 400 `{ error: "unknown_model" }`.
  - `assertParamsValid(providerId, modelId, params): void` — `validationGateway.validate(providerId, modelId, { params })`; on `!ok` throw 400 `{ error: "unsupported_parameter", violations: result.violations.map(v => ({ param: v.param, code: v.code, rule: v.ruleId })) }` (per MIGRATION_PLAN §7.2: names the violated rule).
- Credentials PUT: keep `z.object({providerId: ProviderIdSchema})` param parse (now any string) + `assertKnownProvider` → an `openrouter` key becomes storable; `moonshot` etc. too; `"notaprovider"` → 400.
- Waifu/agent config PUT/POST: after resolving `params` (T2 layer), when `modelId` is set call `assertKnownModel` then `assertParamsValid` with the target pair. When no modelId: store params unvalidated (validated at model-assignment time).

- [ ] **Step 1: failing tests** — PUT `/api/providers/openrouter/credentials` with a dummy key → 200 and the entry persists (never a real key in fixtures); PUT `/api/providers/notaprovider/credentials` → 400 `unknown_provider`; waifu PUT with `params: {"reasoning.budgetTokens": 5}` on a model whose registry descriptor forbids it → 400 `unsupported_parameter` naming the param (pick the pair from the registry — e.g. a param out of range on `deepseek-v4-flash`; read the descriptor to choose a genuinely-violating value); waifu PUT with valid params → 200.
- [ ] **Step 2: implement**; keep `legacyCatalog.ts`'s 6-id scoping BY DESIGN (comment there already says so).
- [ ] **Step 3: verify** — full suite + typecheck; confirm `src/frontend` still compiles UNTOUCHED (its 6-literal `ProviderId` union narrows a string — fine).
- [ ] **Step 4: commit** — `feat: widen provider ids to the gateway registry with validated writes`

### Task 5: doctor warnings

**Files:**
- Modify: `src/cli/commands.ts` (doctorCommand 298-339)
- Test: whichever file covers doctor today (grep `doctorCommand` in tests/; add coverage if none)

**Design:** two new result sections, derived read-only (doctor does NOT run migrations):
- `schema: { unstamped: string[] }` — walk the data root's known persisted JSONs (reuse T3's enumeration; exclude OCR cache) listing files with `schemaVersion !== 2`.
- `models: { unresolved: Array<{scope: string; providerId: string | null; modelId: string}> }` — for the three agents + every waifu with a modelId: `resolveModelTarget` try/catch; failures listed. Surface both in the printed JSON; non-empty `models.unresolved` does NOT flip the exit code (informational, per §7.3 doctor-warning intent).

- [ ] **Step 1: failing test** — temp root with one waifu at `modelId: "bogus-model"` and one hand-written `schemaVersion: 1` file → doctor JSON contains both warnings; clean root → empty arrays.
- [ ] **Step 2-3: implement, verify** full suite.
- [ ] **Step 4: commit** — `feat: doctor warns on unresolved models and unstamped schema files`

### Task 6: P3b deferred minors (the two app-side ones)

**Files:**
- Modify: `src/api/server.ts` (resolvePersonaDigestPipeline 1518-1540), `src/orchestration/pipeline/params.ts` (GatewayPipelineError, ProviderPipelineError), `src/orchestration/pipeline/gatewayPipeline.ts` (parseForcedCall), `src/orchestration/runtime.ts` (942, 1963, 2366, 3989-3995), `tests/runtime.test.ts` (ProviderPipelineError import site)
- Test: `tests/api.test.ts`, `tests/gatewayPipeline.test.ts`

**Design:**
- Digest credential preflight: in `resolvePersonaDigestPipeline`, after target resolution: `if (!createProviderCredentialsLookup(options.dataRoot)(target.providerId)) return { ok: false, reason: \`Provider ${target.providerId} has no API key configured.\` };` → the POST route's existing `conflict(reason)` produces the 409.
- Error details: `GatewayPipelineError` gains `constructor(message: string, readonly details?: unknown)`; `parseForcedCall` passes `{ text: call.arguments, error: <zod/JSON message> }` as details on parse failures; runtime's three `instanceof ProviderPipelineError` checks switch to `GatewayPipelineError` (summarizer at 3989 reads `.details` — now live again); DELETE `ProviderPipelineError` (only tests throw it — re-point them).

- [ ] **Step 1: failing tests** — digest POST for a waifu whose stage-manager provider has no stored key → 409 with the reason; parseForcedCall failure surfaces `details.text` (assert via the thrown error object in gatewayPipeline.test.ts).
- [ ] **Step 2-3: implement, verify** full suite.
- [ ] **Step 4: commit** — `feat: digest credential preflight and gateway error details; drop ProviderPipelineError`

### Task 7: migration + API smoke on a copy of the live data root (controller-run)

Controller (not a subagent) runs this — it touches a copy of real user data.

- [ ] Copy `~/.dc-waifus` → temp dir; `DC_WAIFUS_HOME=<copy> npm run waifus -- start`; confirm boot log, then: all user files at `schemaVersion: 2`; agent configs show `params: {"reasoning.effort":"medium"}` etc. with legacy fields gone; the 5 waifus converted (`aria`: `params: {temperature: 1.2, "reasoning.enabled": false}`).
- [ ] `GET /api/waifus` → entries carry `params` AND synthesized `reasoning`/`generation`; `PUT` one waifu with a legacy-shape body → 200, params stored; `PUT` with an out-of-range param → 400 `unsupported_parameter`.
- [ ] `PUT /api/providers/openrouter/credentials` with a dummy key → 200; `waifus doctor` on the copy → no unresolved models, no unstamped files; stop server; delete the copy.
- [ ] `npm run build` full; final suite; update MIGRATION_PLAN §8 P4 row + execution record here; commit docs.
- [ ] Warn the user: their real `~/.dc-waifus` migrates (irreversibly reshapes configs) on the next real `waifus start`; the SPA keeps working unchanged.

### Final review
Full-range integration review (start commit = T1's parent) with the §7.3 substitute-deviation called out; fix-first; push after user-visible report.
