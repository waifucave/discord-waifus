# W4b — Eval Harness

Goal: prompt changes stop being vibes-based. Two tiers:

- **Tier 1 — deterministic** (`npm run test`, always on): validator rules, retrieval scoring, loop
  detector, prompt-assembly snapshots, schema parsing. Pure functions, no network.
- **Tier 2 — model-in-the-loop** (`WAIFUS_EVAL_LIVE=1 npx vitest run tests/eval`): replays scenario
  fixtures through the real orchestrator/waifu/dream pipelines against live APIs and asserts
  distribution metrics. Costs real tokens; never runs in CI by default.

## 1. Layout

```
tests/eval/
  fixtures/
    synthetic/            # committed — hand-written scenarios, safe for the public repo
    live/                 # GITIGNORED — transcripts/decision logs pulled from the real server
  scenarios.ts            # scenario definitions: context messages + expectations
  orchestrator.eval.test.ts
  waifu.eval.test.ts
  memory.eval.test.ts
  leakCorpus.test.ts      # tier 1 — validator vs corpus (04 §5)
scripts/eval-report.mjs   # tier 2 runner producing a comparison table across models/configs
```

Fixture hygiene: the repo is public. Nothing from the real server (names, message text, memories)
is ever committed. `tests/eval/fixtures/live/` is in `.gitignore`; a `fetch-live-fixtures` script
documents how to repopulate it over SSH for local runs. Synthetic fixtures mirror the same shapes
with invented casts.

## 2. Scenario set (synthetic, ~12 scenarios)

Each scenario = a seeded context window + waifu roster + an expectation record. Core set:

| Scenario | Expects |
|---|---|
| human asks one waifu a direct question | 1 responder, that waifu, no directive |
| two waifus mid-banter, fresh beat available | 1–2 responders, ≤1 directive |
| repetitive volley (4 near-duplicate exchanges seeded) | loop detector fires; directive with `break_loop`/`change_topic` allowed; speaker change |
| beat clearly landed, nothing to add | `no_reply` with `wakePlan`, retrigger ≥ 600s |
| dead room, humans gone for hours | `no_reply`, retrigger ≥ 3600s; reasoning does NOT mention waiting for users as the cast's purpose |
| timer-fired wake with a stated plan, room unchanged | executes the plan OR longer backoff; never an identical re-pause |
| quiet human's message overlooked 10 messages ago | `include_person`/`spotlight` directive or 1 responder targeting it |
| pile-on moment (big announcement) | ≥ 2 responders acceptable, 3 allowed |
| naive long-winded persona fixture, casual ping | reply ≤ 400 chars (length register holds) |
| memory-dependent callback (fact seeded in store, not in window) | retrieval injects it; reply may use it |
| note-worthy info dropped mid-chat | `add_memory` called with a standalone-sentence note |
| channel-switch continuity (note from channel A, scenario in channel B) | retrieval carries it over |

## 3. Metrics asserted (tier 2, over N=3 runs per scenario to absorb sampling noise)

Aggregated across the scenario set, thresholds from `00-overview.md`:

- directive rate ≤ 25% of reply decisions; zero directives whose goal token-overlaps a generated
  reply ≥ 0.6 (echo); zero goals > 100 chars surviving to execution.
- responder-count distribution: mode = 1; two-waifu ≤ 40%; ≥ 1 three-waifu on the pile-on scenario;
  no_reply ≥ 30% on the quiet scenarios.
- retrigger spread: values from ≥ 3 distinct bands ({100–300}, {600–1800}, {3600+}) across the set;
  `wakePlan` non-empty on every no_reply.
- waifu reply lengths: ≥ 80% ≤ 120 chars, max ≤ 400 chars; impersonation/strip/blocked rates
  reported and non-regressing.
- memory: retrieval precision ≥ 0.7 / recall ≥ 0.6 on labeled fixtures (tier 1, deterministic);
  dream-pass repair assertions from `03-memory.md` §8 (tier 2).

`scripts/eval-report.mjs` prints the table per (model, config) — built for exactly the pending
decision "should the orchestrator move off gemini-3.1-flash-lite": run the same set with flash-lite
vs gemini-3-flash vs haiku-4.5 and compare directive discipline, distribution shape, and latency.

## 4. Implementation notes

- The orchestrator/waifu pipelines are already injectable (`createPipeline` option on
  `RuntimeOrchestrator`, `sleep` override, storage on temp roots per house test style) — tier 2
  drives `decideOrchestrator`/`generateWaifu` directly through `createModelPipeline` with fixture
  context, no Discord connection needed.
- Decision/metric extraction reuses the zod schemas; no scraping.
- Keep it small: this is a measuring stick, not a product. ~600 lines total budget including
  fixtures.

## 5. Workflow

Every prompt-affecting PR in W1–W3: tier 1 green locally + CI; tier 2 run manually before merge,
report table pasted into the PR description. After W1 lands, run tier 2 once against the live
config as the baseline snapshot and store the report under `tests/eval/reports/` (gitignored, like
fixtures).
