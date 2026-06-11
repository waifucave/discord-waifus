# Coordination with the Gateway Migration (P2–P6)

Audience: the agent executing `MIGRATION_PLAN.md`. This overhaul (W1–W4, see `00-overview.md`) is
being implemented **against the current `src/providers/` code** while you are in P1c (gateway repo
only — confirmed no overlap). By the time you reach P2/P3 in this repo, the files you plan to
rewrite will have changed. This doc is the reconciliation map; each W-phase also appends a status
line to `MIGRATION_PLAN.md` §10 when it lands.

## 1. Why this doesn't fight your work

Your P3 moves prompts/tool schemas out of `pipelines.ts` into `src/orchestration/` and rebuilds
`ModelPipeline` on the gateway client. This overhaul moves *in the same direction early*: new logic
lands in dedicated `src/orchestration/` modules (`loopDetector.ts`, `memoryRetrieval.ts`,
`dream.ts`, `outputValidator.ts`, rewritten `promptBlocks.ts`) that are **transport-agnostic** —
they neither know nor care whether requests go through `pipelines.ts` or `gateway.chat()`. The
remaining churn inside `pipelines.ts` is deliberately thin (listed below) so your P3 deletion
absorbs it.

## 2. Interface changes you must carry into P3's `ModelPipeline` rewrite

| Change | Where it lives pre-P3 | P3 impact |
|---|---|---|
| `replyStyle` **removed** from `WaifuGenerationRequest` + decision schema | `types.ts`, `pipelines.ts`, `decisions.ts` | drop `replyStyleHint`/`replyStyleMessagesFor*` from your unified message builder entirely |
| `sceneDirection` → typed `directive {intent, goal}` | `decisions.ts`, orchestrator tool schema in `pipelines.ts` | the orchestrator tool JSON schema is now the canonical one you planned to "define once" — take it verbatim from `orchestratorToolParameters()` at cutover time |
| `repleyToMessageIndex` removed from the tool schema | `pipelines.ts` | don't resurrect it from the old schema dump (`docs/old_tool_schema.json`) |
| Past-decision replay sanitized (intent-only directives, clipped reasoning) | `serializeOrchestratorDecisionArguments` | port as-is — it's a behavioral guardrail, not a wire detail |
| `ProviderRequest.decisionMarkers` revived (wake markers) + time-gap markers (`[42m pass]`) | `types.ts`, timeline builders ×4 protocols | becomes ONE timeline builder in your unified layer; markers are plain user-role text items |
| Replayed tool results carry compact outcomes ("sent"/"riko: empty"/"paused 1800s") instead of the constant "ok" | `ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER` call sites ×4 | port as behavior — one formatting helper in the unified builder |
| Observer gets a lean `formatObserverContext`; `renderContext`/`formatContextMessage`/`buildSuffix` deleted | `pipelines.ts` | the lean formatter belongs in `src/orchestration/` with the rest of the prompt code you're moving |
| Tool guidance is schema-first: `add_memory`/`PickNextWaifu`/decision-field rules live in schema `description`s, not prompt prose | tool parameter builders | your "define tool schemas once" goal — the descriptions are part of the canonical schemas, keep them intact |
| Observer tool gains `entities`; librarian call replaced by `decideDream` (new op set) | `types.ts`, `pipelines.ts`, `stageManager.ts` | `decideStageManager` request/response shapes are gone; see `03-memory.md` §5 |
| Anthropic/Google mid+trailing blocks wrapped in `<system_note>` | `pipelines.ts` waifu builders | in gateway terms this is app-side message construction, not a codec concern — keep it in the app layer |
| Corrective retry message carries a violation name | `pipelines.ts` retry plumbing | trivial; stays app-side |

## 3. Schema-version sequencing (interaction with your P4)

W2 (promptLayout reset, `personaDigest`) and W3 (memory store v2) each bump
`CURRENT_SCHEMA_VERSION` with their own `runMigrations` steps. Your P4 migration
(`reasoning`/`generation` → `params`) is independent of both — but version numbers are a single
sequence. Whoever lands second rebases their migration step on the other's version. Memory v2
touches `user/memories.json` + deletes `user/short-term-memories.json`; P4 touches
waifu/agent configs — no shared files.

One P4 note: W1 adds `directiveCooldown` to the orchestrator `AgentConfig` and W1 removes
`useLegacyPrompt`/`clipSceneDirection`. Your migration table for agent configs should treat these
as already-current fields, not legacy ones.

## 4. Frontend overlap (your P5)

W1/W2/W3 touch `OrchestratorView`, `WaifusView`, `MemoriesView`, `StageManagerView`,
`PromptLayoutEditor`, and `frontend/api/types.ts` for their own fields. Your P5 replaces
`ReasoningControls` + sampling fields with `ModelParamsForm` — different components, same views.
Expect textual merge conflicts in the view files and `api/types.ts`, nothing semantic.

## 5. What you can delete with extra confidence at P3

Because this overhaul already removed their reasons to exist:

- `replyStyle` plumbing (all four protocol variants).
- The legacy orchestrator prompt branch (`useLegacyPrompt`, `buildLegacyOrchestratorPrompt`) —
  removed in W1.
- `clipSceneDirectionForWaifu` and its config flag — removed in W1.
- `ShortTermMemoryStore` schemas and the second memory file — removed in W3.

## 6. Status log

Maintained in `MIGRATION_PLAN.md` §10 (one line per landed W-phase, with commit hash). If you reach
P2 before a W-phase lands, check this folder's docs for the not-yet-landed deltas before freezing
your P3 plan.
