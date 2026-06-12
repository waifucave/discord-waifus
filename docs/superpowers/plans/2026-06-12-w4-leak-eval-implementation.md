# W4 — Leak Validator + Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Execute in a worktree created MANUALLY from local HEAD (`git worktree add .claude/worktrees/w4-leak-eval -b worktree-w4-leak-eval main` then EnterWorktree by path) — EnterWorktree's default base loses local-only commits; VERIFY this plan file exists in the worktree before dispatching.

**Goal:** A deterministic output validator that guarantees no model-internal content reaches Discord (pass/retry/block before send), plus a two-tier eval harness so future prompt changes are measured.

**Architecture:** Task 1 builds the pure validator module + its corpus tests. Task 2 wires it into the waifu send path (blocked outcomes, violation-named retry), adds the reviewer prompt line, the debug-route guard, and removes the orchestrator typing tell. Task 3 builds `tests/eval/` (tier 1 always-on corpus suite; tier 2 live-gated scenario replays + report script). Task 4 is the gate.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), zod v4, Vitest. Two-space indent, double quotes, semicolons. Repo is PUBLIC: no real chat content in committed fixtures.

**Design docs (authoritative):** `docs/superpowers/plans/2026-06-11-prompting-overhaul/04-leak-prevention.md` (§2 check table, §4 surfaces) and `05-eval-harness.md` (layout, scenarios, metrics). Current-code adjustments: directives are typed `{intent, goal}` (W1); block tags are the W2 registry (`{tag}_identity`, `{tag}_persona`, `{tag}_schedule`, `io_format`, `tools`, `output_contract`, `room_info`, `{tag}_relevant_memories`, `{tag}_anchor`, `currently_doing`, `director_note`, `system_note`); tool names now include `dream_memories` and `set_persona_digest` (W3/W2).

---

## Task 1: `outputValidator.ts` + corpus tests

**Files:**
- Create: `src/orchestration/outputValidator.ts`
- Test: `tests/outputValidator.test.ts`

- [ ] **Step 1: Write the failing tests** — one describe per check, synthetic fixtures only:

| Check | retry-fixture (must flag) | pass-fixture (must NOT flag) |
|---|---|---|
| `harness-tag` | `"<director_note>\ngo</director_note>\nhi"`, `"<yuki_anchor>You are Yuki</yuki_anchor>"` | `"i love <3 you"`, `"a < b and b > c"` |
| `tool-fragment` | `"add_memory({\"content\": \"x\"})"`, `"{\"waifuId\": \"aria\", \"intent\": \"spotlight\"}"` | `"i should remember that"`, `"my memory is bad lol"` |
| `bracket-tag` | `"sure [image_text: hello] ok"`, `"[timestamp: 2026] hi"` | `"[citation needed] energy"` → assess: matches `^[A-Za-z_]+:` shape? "citation needed" has a space and no colon → must pass; `"arrays[0]: fine"` must pass |
| `transcript-shape` | `"Riko: hey\nAria: hi"` (2+ participant lines) | single impersonation line (strip's job, not the validator's), `"PS: anyway"` (PS not a participant) |
| `directive-echo` | reply ≈ goal: goal `"bring up the snowstorm from last week"`, reply `"hey did you all see the snowstorm last week??"` (overlap ≥0.6) | goal `"change the subject"`, reply `"so anyway, who won the game"` |
| `self-talk` | `"analysis: the user wants..."`, `"<thinking>hmm</thinking>ok"` | `"in my analysis era"` (no leading-colon shape) |
| `mass-ping` | `"@everyone wake up"` → verdict BLOCK | `"everyone is here"` |

Plus: clean replies (incl. emoji/unicode/multiline) → `pass` with zero violations; multiple violations accumulate; `verdict` precedence block > retry > pass.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/outputValidator.test.ts` → module not found.

- [ ] **Step 3: Implement** per design §2:

```ts
export type ValidationVerdict = "pass" | "retry" | "block";
export type Violation = { check: string; detail: string };
export type ValidationContext = {
  selfNames: string[];          // all self-aliases (display name, configured name, guild nickname)
  participantNames: string[];   // every known participant incl. self aliases
  directive?: { intent: string; goal: string };
  blockTags: string[];          // every XML-ish tag the harness can emit for this waifu
  toolNames: string[];
};
export function validateWaifuOutput(text: string, ctx: ValidationContext): { verdict: ValidationVerdict; violations: Violation[] };
```

Checks (each a small pure function returning `Violation | undefined`):
- harness-tag: `</?TAG[ >]` for each blockTag (case-insensitive, escaped) OR generic `/<\/?[a-z][a-z0-9_]*_(identity|persona|schedule|anchor|relevant_memories)>/i`.
- tool-fragment: any toolName adjacent to `(`/`{`/`:` (`new RegExp(\`\\b${name}\\s*[({:]\`)`), or a line that parses as JSON containing keys `content|waifuId|intent|goal|ops`.
- bracket-tag: `/\[[A-Za-z_][A-Za-z0-9_ -]*:\s[^\]]*\]/` anywhere (the strip already handles leading/trailing; this is the stricter net) — single-word-no-colon brackets pass.
- transcript-shape: count lines matching `^\s*(NAME)\s*:` for participantNames EXCLUDING selfNames; flag when ≥2 (single line = strip's territory).
- directive-echo: stopword-filtered token overlap (copy the loopDetector tokenSet/STOPWORDS pattern verbatim — keep decoupled): `|reply∩goal| / |goal|` ≥ 0.6 with |goal tokens| ≥ 3.
- self-talk: `/^\s*(analysis|reasoning|thoughts?|scratchpad|response draft|draft reply|final answer|message to send)\s*:/i` or any `<(analysis|thinking|reasoning|thought|scratchpad)\b/i`.
- mass-ping: `/@everyone|@here/` → block.

- [ ] **Step 4: Tests pass; commit** `feat: deterministic waifu output validator`

---

## Task 2: Runtime integration + surfaces

**Files:**
- Modify: `src/orchestration/runtime.ts` (generate loop in `executeResponderDecision`; `DEFAULT_REVIEWER_PROMPT`; `setDebugRoute`; orchestrator typing scope)
- Modify: `src/shared/schemas/domain.ts` (`OrchestratorResponderOutcomeStatusSchema` + `"blocked"`)
- Modify: `src/api/server.ts` ONLY if the debug-route guard needs server config access there (it does not — `setDebugRoute` lives in runtime)
- Modify: `src/frontend/api/types.ts`, `src/frontend/views/OrchestratorView.tsx` (render blocked outcomes)
- Test: `tests/runtime.test.ts`

- [ ] **Step 1: Read the current generate loop** (search `MAX_GENERATE_ATTEMPTS` in runtime.ts). Current flow per attempt: generate → metadata strip → reply-quote extract → impersonation strip → `chunks = splitWaifuReply(strippedContent)` → retry once if cleaning emptied it. INSERT the validator after `strippedContent` is final, before chunking:

```ts
            const validation = validateWaifuOutput(strippedContent, {
              selfNames: allSelfDisplayNames,
              participantNames: participantDisplayNames,
              directive: responder.directive && responder.directive.intent !== "manual"
                ? { intent: responder.directive.intent, goal: responder.directive.goal }
                : undefined,
              blockTags: waifuBlockTags(waifu),
              toolNames: ["add_memory", "PickNextWaifu", "orchestrator_decision", "dream_memories", "set_persona_digest"]
            });
```

(`waifuBlockTags(waifu)`: module helper returning the W2 registry tags with `promptTagName(waifu.name || waifu.id)` substituted.) Flow:
- `pass` → proceed to chunking as today.
- `retry` on attempt 1 → log warn with violations, set the NEXT attempt's retry message to
  `` `${waifu.displayName}: (your previous draft was rejected: contained ${violations.map(v => v.check).join(", ")}; write only the plain chat message)` ``
  and continue the loop (reuse/replace the existing attempt-2 `retryUserMessage` mechanism — make the retry reason a `let` that the cleaning-empty path and the validator path both set).
- `retry` on the final attempt, or `block` on any attempt → set `chunks = []` and a `blockedViolations` variable; after the loop, when `blockedViolations` is set: record outcome `status: "blocked"`, `reason: violations.map(v => v.check).join(", ")`, log, send NOTHING. (Mirror how the `empty` outcome is recorded — search `"empty_after_cleaning"`.)

NO truncation anywhere — verify the only powers are send-as-is / regenerate / send-nothing.

- [ ] **Step 2: domain + frontend** — add `"blocked"` to `OrchestratorResponderOutcomeStatusSchema`; mirror in `frontend/api/types.ts`; `OrchestratorView`'s outcome rendering shows blocked like other deviation statuses (it already prints `waifuId: status` — verify and add a tone/label if the view maps statuses). The replay tool-result `formatDecisionOutcome` in pipelines.ts already surfaces any non-sent status (`"aria: blocked"`) — verify, no change expected.

- [ ] **Step 3: Reviewer prompt line** — in `DEFAULT_REVIEWER_PROMPT` (runtime.ts), add to the hallucination=true list: `"- a message that primarily restates an instruction or goal it was given (reads as a directive, not as chat)"`.

- [ ] **Step 4: Debug-route guard** — in `setDebugRoute`, before writing: read the destination guild's server config; if `destinationChannelId` has enabled waifus (`channels[destinationChannelId]?.enabledWaifuIds?.length`), throw `new Error("Refusing to route debug logs into a channel with active waifus — pick a private channel.")`. (Destination guild id is available on the input; read the server file the same way `ensureServer` does, but read-only via `storage.readJson`.)

- [ ] **Step 5: Orchestrator typing removal** — in `runChannelLoop`, delete the `startTypingScope(...)` wrapping the `decideOrchestrator` call (the scope WITHOUT `senderBotId` — the waifu typing scopes stay). Remove the now-unused try/finally if trivial.

- [ ] **Step 6: Tests** (runtime.test.ts, full code mirroring existing harness):
  - blocked path: fake pipeline returns `"<director_note>goal</director_note>"` on BOTH attempts → nothing sent, outcome `status: "blocked"` with reason containing "harness-tag", retry message of attempt 2 contains "rejected".
  - recovered path: violation on attempt 1, clean on attempt 2 → sent, status "sent".
  - mass-ping block: single attempt, `"@everyone hi"` → blocked immediately (no retry — verdict block).
  - debug-route guard: setDebugRoute to a waifu-enabled channel rejects; to a clean channel succeeds.
  - reviewer prompt: assert the new line present in the reviewer system prompt request (existing reviewer test pattern).

- [ ] **Step 7: Gate + commit** `feat: validator in the send path — blocked outcomes, guarded debug routes`

---

## Task 3: Eval harness

**Files:**
- Create: `tests/eval/leakCorpus.test.ts`, `tests/eval/scenarios.ts`, `tests/eval/orchestrator.eval.test.ts`, `tests/eval/waifu.eval.test.ts`, `tests/eval/fixtures/synthetic/corpus.ts`, `tests/eval/fixtures/live/.gitkeep` (no memory eval file: retrieval precision is already unit-tested deterministically in `tests/memoryRetrieval.test.ts`; dream-repair quality is post-deploy validation)
- Create: `scripts/eval-report.mjs`
- Modify: `.gitignore` (+`tests/eval/fixtures/live/*` except .gitkeep, +`tests/eval/reports/`)
- Modify: `vitest.config.ts` ONLY if tests/eval isn't matched by the include glob (`tests/**/*.test.ts` matches — verify, expect no change)

- [ ] **Step 1: Corpus + tier-1 suite.** `fixtures/synthetic/corpus.ts` exports `LEAK_CORPUS: Array<{name, text, expectVerdict, ctx?}>` (≥20 entries: every Task-1 check ×2-3 synthetic variants — INVENTED casts only: Yuki/Mika/Kevin) and `CLEAN_CORPUS` (≥15 realistic clean replies: fragments, emoji, code-ish text, brackets-without-colons, names mid-sentence). `leakCorpus.test.ts` (tier 1, always on): every LEAK_CORPUS entry flags with the expected verdict; every CLEAN_CORPUS entry passes with zero violations (false-positive budget 0).

- [ ] **Step 2: Scenario definitions.** `scenarios.ts` exports the 12 scenarios from design 05 §2 as data: `{key, description, messages: ContextMessage[], roster: {id, displayName, persona}[], expect: {...}}` — write all 12 with compact synthetic content (each context 4-8 messages). Expectations are per-scenario records consumed by the tier-2 tests (e.g. `{maxResponders: 1, directiveAllowed: false}`, `{action: "no_reply", minRetrigger: 600}`, `{maxReplyChars: 400}`).

- [ ] **Step 3: Tier-2 gated tests.** Both eval test files start:

```ts
const LIVE = process.env.WAIFUS_EVAL_LIVE === "1";
const describeLive = LIVE ? describe : describe.skip;
```

`orchestrator.eval.test.ts`: for each orchestrator scenario, build a real pipeline via `createModelPipeline(modelId, { apiKey })` with `modelId = process.env.WAIFUS_EVAL_MODEL ?? "gemini-3.1-flash-lite"` and `apiKey = process.env.WAIFUS_EVAL_API_KEY` (fail fast with a clear message if unset), call `decideOrchestrator` with the scenario context + a trailing/system prompt built via the REAL runtime builders — the builders are private methods: instantiate them through the same path the runtime tests use OR export small wrappers; CHECK how tests/runtime.test.ts accesses prompts today and reuse that approach. Run each scenario `N = Number(process.env.WAIFUS_EVAL_RUNS ?? 1)` times; assert the scenario's expectations; collect aggregate metrics (directive rate, responder-count distribution, no_reply rate, retrigger spread) and `console.log` a summary table. `waifu.eval.test.ts`: the naive-long-persona scenario + a clean-reply scenario through `generateWaifu` with the real W2 harness blocks (use `buildWaifuPromptParts` via a seeded temp-root RuntimeOrchestrator like runtime tests do, or assemble via promptBlocks directly — pick the cheaper faithful path); assert length ≤ maxReplyChars and validator pass.

- [ ] **Step 4: `scripts/eval-report.mjs`** — node script: `node scripts/eval-report.mjs --models gemini-3.1-flash-lite,claude-haiku-4-5-20251001` runs `WAIFUS_EVAL_LIVE=1 WAIFUS_EVAL_MODEL=<m> npx vitest run tests/eval/orchestrator.eval.test.ts` per model (API key from `WAIFUS_EVAL_API_KEY` or per-model `WAIFUS_EVAL_API_KEY_<PROVIDER>`), captures the logged summary lines, prints a side-by-side table. Keep it ~80 lines; it shells out, no imports from src.

- [ ] **Step 5: Tier 1 in the normal gate** — `npm run test` now includes leakCorpus (deterministic, no network) and SKIPS tier-2 (describeLive). Verify `npm run test` runs offline-green. Commit `feat: eval harness — leak corpus tier 1, live-gated scenario tier 2`.

---

## Task 4: Acceptance

- [ ] `npm run typecheck && npm run test && npm run build:backend && npm run build` all green; `npx vitest run tests/eval` green offline (tier 2 skipped).
- [ ] `git grep -n "WAIFUS_EVAL_LIVE" src/` → zero (eval env never read by runtime code).
- [ ] Validator never truncates: grep outputValidator + the integration diff for `slice`/`substring` on the reply text → only analysis, never reassignment of sent content.
- [ ] MIGRATION_PLAN.md §10 W4 entry happens POST-MERGE on main (established pattern).
