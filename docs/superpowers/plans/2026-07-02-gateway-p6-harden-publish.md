# Gateway P6 — Harden + Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the migration: gateway `0.1.1` published with the DeepSeek data fix + hardening, drift-guard CI so npm can never silently lag main again, the app on a real registry install (stale symlink dead), legacy endpoints slimmed to a credentials-status surface, and the filed write-contract items fixed (MIGRATION_PLAN §8 P6 + P4/P5 filed work items).

**Architecture:** Two repos. Gateway: LICENSE + malformed-element 400s + version 0.1.1 + a CI workflow that runs typecheck/test/build/`gateway sync` and a publish-freshness guard (package version already on npm + tarball shasum differs → fail). App: `/api/models` deleted and `/api/providers` reduced to credentials-status + `gatewayProviders` (docsUrl static map survives); write contracts hardened (explicit-null unset, normalize legacy ids on write, personaDigest omitted on create, DiscordBots `enabled` required in bodies); TagListField draft-flush verified/fixed. Publish is controller-run with explicit user confirmation before triggering the workflow.

**Audit reconciliation (2026-07-02):** npm `0.1.0` = gateway `c1b31ba`; main = `4740540` (deepseek.json fix, pushed, unpublished). App pin `0.1.0` + lock integrity match npm, but `node_modules/@waifucave/gateway` is a stale `file:`-era symlink to the local repo — local dev ≠ fresh install. `check-no-file-deps` passes. App itself publishes as `@waifucave/discord-waifus` via release.mjs → GH workflow.

## Global Constraints

- App baseline: **644 passed | 15 skipped**; gateway baseline: **231 tests / 22 files**. Full `npm run typecheck && npx vitest run` (+ app `npm run build`) green at every commit in the touched repo.
- Commit directly to main in BOTH repos. Gateway pushes authorized; app pushes after final review. **`npm publish`/workflow-trigger requires explicit user confirmation — never trigger it autonomously.**
- App tests currently execute against the SYMLINKED gateway (local main). Task 6 (pin+install) flips them to the published package — sequence gateway-behavior-affecting work BEFORE the publish.
- Never print/log API keys. Never stage `new providers.md` or `research/`. ESM `.js` local imports in backend files.
- lumi (`xai/grok-4-1-fast-non-reasoning`) stays untouched — user decision pending. gemini-2.0-flash registry removal — user decision, out of scope.
- Anthropic responseFormat codec gap stays DEFERRED (no UI consumer exists; YAGNI) — note it in §11, don't implement.

---

### Task 1 (gateway): LICENSE + malformed-element 400 hardening + version 0.1.1

**Files (gateway repo `/Users/example/Xcode projects/waifucave-gateway`):**
- Create: `LICENSE` (MIT, standard text, copyright holder "waifucave")
- Modify: `src/server/handler.ts` (element-level request validation), `package.json` (version 0.1.1)
- Test: `tests/server/handler.test.ts` (or the existing handler test file)

**The P1c carryover being closed:** the HTTP handler validates only top-level shapes (`handler.ts:186-190`); malformed message/tool ELEMENTS (e.g. a message missing `role`, a content block with a bogus `type`, a tool without `name`) reach the codecs, throw raw `TypeError`s, and surface as 500 `{kind:"server"}`. Fix: validate element shapes at the handler boundary → 400 `{kind:"invalid_request"}` naming the bad element index/field. Scope: `/v1/chat` (and `/v1/validate` where applicable). Keep it structural (roles/types/required fields), not semantic — codecs stay the authority on semantics.

- [ ] **Step 1: failing tests** — POST /v1/chat with: message missing `role`; content block with unknown `type`; tool missing `name`; toolCall block missing `id` — each → 400 `invalid_request` with a message naming the offending index, NOT 500. Plus a control: a valid request still reaches the codec (existing tests cover).
- [ ] **Step 2: implement** the element validation (small hand-rolled checks or a zod-lite structural pass — match the handler's existing top-level validation style).
- [ ] **Step 3: LICENSE + `"version": "0.1.1"`.** Verify `npm pack --dry-run` includes LICENSE (npm auto-includes it) and file count is sane.
- [ ] **Step 4: verify** — gateway `npm run typecheck && npm test && npm run build` (expect 231+new).
- [ ] **Step 5: commit** — `feat: 400 on malformed request elements; ship LICENSE; v0.1.1`

### Task 2 (gateway): drift-guard CI

**Files (gateway repo):**
- Create: `.github/workflows/ci.yml`

**Design (exact):**
- Triggers: `push` to main, `pull_request`, `schedule` (weekly).
- Job `test`: checkout, node 20, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- Job `drift`: after test — `node dist/bin/gateway.js sync` with provider keys from repo secrets IF configured (`env: OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}` etc. for the credentialEnv names in `src/registry/providers.ts` — list them; missing secrets simply skip those providers by design). `continue-on-error: false` on push/PR, and on `schedule` file an issue or just fail (keep simple: fail).
- Job `publish-freshness` (push to main only): `PUBLISHED=$(npm view @waifucave/gateway version)`; if `PUBLISHED == package.json version`, run `npm pack --dry-run --json`, compare its `shasum` against `npm view @waifucave/gateway dist.shasum` — mismatch → exit 1 with "package.json version ${PUBLISHED} is already published with different contents — bump the version". This is the guard that would have caught the `4740540` drift.
- [ ] **Step 1: write the workflow; Step 2: validate syntax** (`node -e` YAML parse or `gh workflow view` after push — at minimum a YAML lint via node/python one-liner). CI can't run locally — the controller verifies the run on push in Task 7.
- [ ] **Step 3: commit** — `ci: test + live drift check + publish-freshness guard`

### Task 3 (app): legacy endpoint slim-down

**Files (app repo):**
- Modify: `src/api/server.ts` (`/api/models` route DELETED; `/api/providers` response rebuilt), `src/api/legacyCatalog.ts` (shrinks to the docsUrl map + credentials-status assembly — `legacyModels()` and the model synthesis DIE; rename the file `src/api/providerStatus.ts` if cleaner), `src/frontend/api/client.ts` (`api.models()` deleted), `src/frontend/api/types.ts` (`ModelsResponse`/`LegacyModelSummary` deleted; `ProviderMetadata` reshaped), `src/frontend/views/DashboardView.tsx`, `SetupView.tsx`, `ProvidersView.tsx` (consume the new shape)
- Test: `tests/api.test.ts` (legacy-shape pins rewritten)

**New `/api/providers` response (exact):**
```ts
{ revision, updatedAt, providers: Array<{ id: string; displayName: string; docsUrl?: string; credentials: { configured: boolean; label?: string; updatedAt?: string; keyHint?: string } }>, gatewayProviders }
```
- `providers` now covers ALL stored credentials + the 14 registry providers (union by id: registry providers always listed; a stored credential for each gets its status attached) — Dashboard's configured-count and keyHint, Setup's `some(configured)`, ProvidersView's keyHint/updatedAt/docsUrl all keep working, now for all providers (an openrouter key finally shows its `****hint`). `docsUrl` from the static map (extend it with best-known URLs for the 8 non-native providers or leave absent — implementer judgment, absent is fine).
- `models` field and `/api/models` route: GONE. `gatewayModels` field on the old models route: GONE with it (the SPA uses `/api/llm/v1/models`).
- Frontend: DashboardView drops `p.models.length` usages (reshape to provider count only or use gatewayModels count via llm client — simplest that keeps the UI sensible); ProvidersView's merge simplifies (one endpoint now carries credentials for all 14 — the `mergeProviders` legacy-lookup shrinks).

- [ ] **Step 1: failing tests** — new `/api/providers` shape pins (openrouter WITH stored dummy key shows `configured: true` + keyHint; native provider shows docsUrl; `gatewayProviders` still present); `/api/models` → 404.
- [ ] **Step 2: implement** backend then frontend; delete dead types/methods.
- [ ] **Step 3: verify** — `grep -rn "api.models\|ModelsResponse\|LegacyModelSummary\|legacyModels" src/` empty; typecheck + suite + build green.
- [ ] **Step 4: commit** — `feat!: drop /api/models; /api/providers becomes credentials-status over the full registry`

### Task 4 (app): write-contract hardening bundle

**Files:** `src/shared/schemas/domain.ts`, `src/api/server.ts`, `src/api/writeValidation.ts`, `src/frontend/views/WaifusView.tsx` + agent views, `src/frontend/api/types.ts` (body types), `tests/api.test.ts`

Four contracts, TDD each:
1. **Explicit-null unset**: `WaifuConfigSchema.providerId/modelId` accept `null` (mirror AgentConfig's union+transform); BOTH merge transforms (`server.ts` waifu PUT ~439-449, agent ~847-851) treat an explicitly-present null/undefined-valued key as DELETE (remove the key from the stored object, not store undefined); views send `null` on unset (`WaifusView.tsx:361` → `set({providerId: null, modelId: null})` shape, `OrchestratorView.tsx:146-147` → `providerId || null`). Pins: PUT `{modelId: null, providerId: null}` → stored config has NO model keys and GET reflects it; absent keys still preserve.
2. **Normalize legacy ids on write**: `assertKnownModel`/`assertModelWriteValid` return the resolved target; the three persist sites (`server.ts` POST waifu ~419, waifu transform ~448, agent transform ~850) store `target.providerId/modelId`. Pin: PUT `modelId: "gpt-4o"` → stored `openai/gpt-5-mini`; response reflects the normalized pair. (Deliberate supersession of P4's store-literal deviation — record in the §8 row.)
3. **personaDigest on create**: `CreateWaifuBodySchema` gains `.omit({personaDigest: true})`. Pin: POST with a personaDigest → 400 or stripped (match the schema idiom — `.omit` makes it an unknown key → stripped; pin stripped-not-stored).
4. **DiscordBots `enabled` required in bodies**: in the discord-bots write path, re-declare bot objects with `enabled: z.boolean()` (required — all clients send it; loud failure beats silent false). Pin: bot body missing `enabled` → 400; existing client shape (with enabled) → 200.

- [ ] **Steps: failing tests per contract → implement → full verify → commit** — `feat!: explicit-null unset, id normalization on write, create/bots body hardening`

### Task 5 (app): TagListField draft-flush

**Files:** `src/frontend/components/modelParams/TagListField.tsx` (+ `ModelParamsForm.tsx`/`logic.ts` if the fix lifts state), `tests/modelParamsLogic.test.ts` for any pure extraction

- [ ] **Step 1: REPRODUCE first** — build a minimal Node simulation or reason through React 19's discrete-event flushing with an actual trace (blur setState flush vs click closure). If React 19 flushes blur updates before click dispatch (likely), the reviewer's flagged race may be a NON-BUG: document the proof in the report and close as no-change-needed.
- [ ] **Step 2 (only if real): fix** — smallest surface: commit the draft synchronously in a `onMouseDown`-capture on the form container, or lift draft into ModelParamsForm so Save handlers see it. Acceptance: a typed-but-unEntered chip is included in an immediately-following save.
- [ ] **Step 3: verify + commit** — `fix: tag draft flushes before save` (or report no-change).

### Task 6 (controller + USER): publish 0.1.1 + real install

- [ ] Push gateway commits; verify the new CI workflow runs green on push (drift job: openrouter-only without secrets).
- [ ] **ASK THE USER to confirm the publish** (workflow_dispatch `npm-package.yml` with release_tag v0.1.1 — same flow they used for 0.1.0). After confirmation: trigger, watch, `npm view @waifucave/gateway version` → 0.1.1; shasum recorded.
- [ ] App: `package.json` dep → `"0.1.1"`; `rm -rf node_modules package-lock`? NO — `npm install @waifucave/gateway@0.1.1` then a full `npm ci` from the updated lock (kills the stale symlink); verify `node_modules/@waifucave/gateway` is a REAL directory at 0.1.1; `ls -la` proof.
- [ ] Full app suite + typecheck + build against the real package (expect green — the published 0.1.1 == local main + T1 hardening).
- [ ] Commit — `chore: pin @waifucave/gateway 0.1.1 — app runs on the published package`

### Task 7 (controller): sync verify + smoke + closeout

- [ ] `gateway sync` locally with the real provider keys exported from `user/providers.json` env-style (never printed) — the P1c #6 "sync shapes live-verified" closure; fix-first any shape bug found (gateway repo).
- [ ] Headless app smoke on a COPY of the live root: new `/api/providers` shape, `/api/models` 404, SPA served, one native waifu PUT round-trip, null-unset round-trip, normalized-id write.
- [ ] Docs: MIGRATION_PLAN §8 P6 row → done (+ note the supersession of the P4 store-literal deviation; §11 note for the deferred anthropic responseFormat); CLAUDE.md "Gateway dependency (migration window, P2–P5)" section REWRITTEN (no more file: dep / sibling-build requirement; document the pinned-registry reality + how to do gateway dev when needed via npm link); execution record here.
- [ ] Final whole-range review (both repos) on the most capable model; fix-first; push app; update memory; report (publish confirmation already obtained in T6).

### Final review
Whole-range, both repos, base = this plan's parent commit (app) and pre-T1 HEAD (gateway); ledger Minors triaged; the §7.3-supersession + endpoint-removal breaking changes called out for sign-off.

---

## Execution record (2026-07-02)

**Status: complete.** Gateway `4740540`→`fa6c4c1` (pushed, v0.1.1 published — user-confirmed trigger of the npm-package workflow, run 28586654506 success, `npm view` shows 0.1.0+0.1.1). App `88102b1`→`bdd3378` + docs.

- **T1 (gateway)** `61038aa` + fix `33606d8` — malformed-element 400s (review upgraded the premise: most cases were silently mis-encoded 200s, not 500s; review also caught that block validation had to be ROLE-scoped — user+toolCall / assistant+image were still mis-encoding, reproduced live and fixed), LICENSE, v0.1.1. 247 gateway tests.
- **T2 (gateway)** `0a6cd2a` + fix `662314c` — CI: test / live drift (14 credentialEnv secrets mapped, keyless runs check openrouter only) / publish-freshness guard (all three branches locally exercised; review's diagnostics minor fixed with guarded network/parse steps).
- **Data** `fa6c4c1` — the CI's FIRST live run failed its drift job legitimately: 2 stale openrouter routes (owl-alpha, xiaomi/mimo-v2-flash gone upstream — verified against the live list) removed; 14 pricing cells synced to live values (incl. 6 the initial truncated output hid). Second CI run: all three jobs green.
- **T3 (app)** `88102b1` — `/api/models` deleted; `/api/providers` = credentials-status over all 14 registry providers (byte-identical keyHint redaction, docsUrl static map) + `gatewayProviders`; `legacyCatalog.ts` → `providerStatus.ts`; Dashboard/Setup/Providers views adjusted. Review PASS (security trace: no full key reaches any response).
- **T4 (app)** `765e0d4` — four write contracts: explicit-null unset (schemas + shallow `pruneUndefined` in both merges + views send null), normalize-legacy-ids-on-write (all three persist sites store the resolved target — deliberate supersession of P4's store-literal deviation), personaDigest omitted on create, DiscordBots `enabled` required. Review: zero findings (empirical probes incl. the null+normalize interaction).
- **T5 (app)** `76b431a` — TagListField blur/save race PROVEN NON-BUG by tracing shipped react-dom 19.2.6: blur and click are both discrete-priority; blur's updates flush synchronously before click dispatches and React reads handlers off the updated fiber. Comment-only.
- **T6** publish + pin: user confirmed; workflow success; app pin `2788ad6` → real `npm ci` install (symlink DEAD, `check-no-file-deps` passes); one count pin updated (`bdd3378` — registry 100→98 after the stale-route removal); **653 passed | 15 skipped against the published package**.
- **T7** live `gateway sync` with real keys (anthropic/openai/google/deepseek/xai): shapes parsed clean on every reachable provider — P1c #6 closed; xai /models 403 (account-side, warning only). Headless smoke on a live-root copy: `/api/models` 404, 14-provider credentials-status, SPA served, normalize-on-write (gpt-4o → openai/gpt-5-mini), null-unset round-trip. Smoke also confirmed BY DESIGN: switching a config's model 400s when stored params don't fit the new model (strict §11.9 write validation; the SPA's live-validate gating walks users through clearing them) — raw API callers must clear params in the same PUT.
- CLAUDE.md gateway section rewritten for the post-migration reality (pinned registry dep, npm link for local gateway dev, PATCH-schema rule, CI expectations).

**The migration (P0–P6) is COMPLETE.** Remaining known items, all user-decision or account-side: lumi's unresolvable model; gemini-2.0-flash catalog removal; anthropic responseFormat codec gap (no UI consumer; §11); xai /models 403; deepseek balance; SPA visual pass (P5) still pending.
