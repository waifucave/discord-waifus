# Prompting & Orchestration Overhaul — Overview

Status: **plan for review** · Date: 2026-06-11
Scope: orchestrator decision quality, waifu prompt harness, memory system, leak prevention, eval harness.
Implementation target: **current codebase** (`src/providers/pipelines.ts` still in place). The gateway
migration agent is at P1c (gateway repo only); see `06-gateway-coordination.md` for how this work is
reconciled with P2/P3.

## Documents

| Doc | Covers |
|---|---|
| `01-orchestrator.md` | Decision schema (typed directives, wake plans), prompt rewrite, code guardrails, loop detector |
| `02-waifu-harness.md` | Restructured prompt blocks, output contract, length register, persona digest, role-confusion hardening |
| `03-memory.md` | Unified memory store, per-turn retrieval scoring, dream consolidation, migration |
| `04-leak-prevention.md` | Layered output validation before send, echo checks, reviewer's role |
| `05-eval-harness.md` | Offline replay metrics, leak regression suite, live-gated model comparisons |
| `06-gateway-coordination.md` | Exactly what this overhaul touches that the gateway migration (P2–P6) must absorb |

## Why (evidence from the live server, 2026-06-11)

Pulled from `Beta.local:~/.dc-waifus/user/` — 200 orchestrator decisions, 489 memories, 6 waifu configs.

**The orchestrator (gemini-3.1-flash-lite, contextWindow 20) is ghost-writing, not directing.**

- `sceneDirection` was set on **329 of 329 responder entries (100%)**, and the directions are full
  scripted replies: *"Aria laughs, telling Riko that 'salt' is just what people call it when they
  can't handle the truth about K's superiority."* The waifu models (mostly DeepSeek V4 Pro) are
  reduced to paraphrasing a flash-lite-class model's script. This is the root cause of persona
  flattening, loops (identical directions appeared in consecutive decisions), and most repetitive
  behavior.
- **82% of reply decisions select exactly 2 waifus** (148/181; 33 single; zero with 3+). The prompt
  says "prefer a two-waifu chain" in two places — the model obeys it as a constant.
- `no_reply` chosen 19/200 (9.5%); retrigger values only round numbers in {600, 1200, 1800, 3600,
  7200} out of an allowed [100, 28800]. The planned-pause intent never materializes: a fired timer
  just produces another same-shape decision because the orchestrator cannot tell *why* it woke.
- `replyStyle` was only ever `normal` (275) or `short` (54) — a dead dimension.
- **Self-reinforcement**: past decisions are replayed into context as few-shot tool calls, complete
  with scripted sceneDirections. 20 in-context examples of the bad habit beat any instruction text.

**Memory is an unfiltered dump with no lifecycle.**

- 154 active long-term memories are **all injected every turn** (Aria alone: 46 lines).
- Botched merges from the librarian's "preserve every fact" rule: one Lumi memory repeats
  "Lumi values calm and peace…" four times inside one record.
- Importance-1 trivia retained forever (three waifus each remember a cereal-mascot-fight opinion);
  time-bound facts rot ("K is planning to release a new update **tomorrow**").
- Short-term memory: 7 entries total — the intended "waifus heavily note chat state" behavior never
  happened. Stage manager can't see short-term entries; nothing promotes them.

**The waifu harness is ~1,600–2,000 words of rules for a one-line output**, with the full persona
injected twice (top + trailing reminder) and overlapping/contradictory rule blocks
(`styleConstraints` hard-caps at ~12 words while `replyStyle: long` asks for fuller replies).

## Decisions locked with the user

1. **Sequencing**: implement against current `pipelines.ts` now; update `MIGRATION_PLAN.md` after
   each phase lands; a later agent reconciles at P2/P3 (P1c confirmed gateway-repo-only).
2. **Memory**: unified store + retrieval scoring + scheduled "dream" consolidation (closest practical
   replica of OpenAI-style dreaming).
3. **Scene direction**: typed directive (intent enum + capped goal string) with **code-level**
   guardrails (length cap, cooldown budget, stripped from few-shot replay).
4. **Reply length**: `replyStyle` is **removed**. Length is the waifu model's call, governed by the
   harness (not the persona alone — personas are user-written and naive). No runtime truncation of
   replies, ever.
5. **Cost envelope**: cheap extra model calls are fine (dream pass, persona digest); per-turn
   retrieval stays local/lexical (no embeddings in v1).
6. **Eval harness**: yes — small, with deterministic parts always-on and model-in-the-loop parts
   env-gated.

## Cross-cutting leanness principles

Every model call carries only what that consumer acts on. Applied throughout W1–W3:

1. **State once.** No mechanic explained in more than one prompt section (today the delay/chain
   pacing rules appear three times in the orchestrator prompt). System prompt = stable contract;
   trailing prompt = dynamic state.
2. **Schema-first tool guidance.** Usage detail (argument meaning, format, worked examples) lives in
   the tool JSON schema `description` fields, which providers deliver at call time and models follow
   more reliably than distant prose. Prompt text keeps only usage *policy* (~3 lines per tool).
3. **Per-consumer rendering.** Observer context loses indices/per-message timestamps/reactions
   (keeps a single date-grounding header); orchestrator context loses raw personas (gains casting
   cards + time-gap markers); decision replay loses goal text, delays, and full reasoning.
4. **Outcome-bearing tool results.** Replayed decision results say what actually happened
   ("sent" / "riko: empty" / "paused 1800s") instead of a constant "ok".
5. **No dead surface.** Dead fields and code paths are removed when touched (unused
   `activeWaifusContent` in the system-prompt builder, `renderContext` after the observer gets its
   own formatter, the misspelled index field, legacy prompt branch).

## Implementation phases

Each phase is independently shippable and leaves the app working. Suggested order = impact order.

| Phase | Work | Main files | Depends on |
|---|---|---|---|
| **W1 — Orchestrator** | New decision schema, guardrails, wake markers, loop detector, prompt rewrite | `decisions.ts`, `runtime.ts`, `pipelines.ts`, `OrchestratorView` | — |
| **W2 — Waifu harness** | New block registry, output contract, length register, persona digest, replyStyle removal | `promptBlocks.ts`, `runtime.ts`, `pipelines.ts`, `PromptLayoutEditor` | W1 (replyStyle removal spans both) |
| **W3 — Memory v2** | Unified store, retrieval, dream pass, migration, MemoriesView | `domain.ts`, `runtime.ts`, new `memoryRetrieval.ts`/`dream.ts`, `MemoriesView` | — (can run parallel to W1/W2) |
| **W4 — Leak + eval** | Output validator, eval suite, fixtures, report script | new `outputValidator.ts`, `tests/eval/**` | W1/W2 land first for stable prompts |

After each phase: update `MIGRATION_PLAN.md` §10 (added by this plan) with what changed, so the
gateway migration agent has a single place to check.

## Success criteria (measured by the eval harness, `05-eval-harness.md`)

- Directive rate on replayed scenarios ≤ 25% of decisions (from 100%).
- Waifu-count distribution on the scenario set: 1-waifu is the mode; 2-waifu < 40%; ≥1 scenario
  yields 3 waifus; quiet scenarios yield ≥ 30% no_reply.
- Retrigger values: at least 3 distinct order-of-magnitude bands used across the scenario set;
  timer-fired wakes produce a different decision shape than the prior one (no identical repeats).
- Memory injection capped at 12 scored lines/turn plus user-pinned records (from up to 46
  unfiltered); retrieval precision ≥ 0.7 on labeled fixtures.
- Zero leak-detector hits across the regression fixture set, including known-leak fixtures that the
  validator must catch.
- No truncation of waifu replies anywhere in the send path.

## Risks

- **Weak-model schema compliance**: the new decision tool drops fields (replyStyle, index) and adds
  a nested directive object. Zod stays lenient (nullable/optional) so a sloppy call degrades to "no
  directive" instead of a failed decision.
- **Layout migration**: waifu `promptLayout` stores block ids that W2 renames; a one-shot migration
  resets stored layouts to the new default (documented; the editor still allows re-customizing).
- **Dream pass safety**: a bad consolidation could mangle memories. Guardrails: never touches
  `pinned`, per-run op cap, archives require a stated reason, full history log retained, and the
  store file is revisioned (point-in-time recovery via git-like rollback is out of scope; the op cap
  bounds damage).
- **Public repo**: real chat fixtures must never be committed — eval uses gitignored live fixtures +
  committed synthetic ones.
