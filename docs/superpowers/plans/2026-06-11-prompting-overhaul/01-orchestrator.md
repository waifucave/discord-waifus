# W1 — Orchestrator Redesign

Goal: turn the orchestrator from a ghost-writer into a director. It decides **who speaks and when**;
the waifu models decide **what is said**. Constraints that matter are enforced in code, not prose,
because the orchestrator runs on flash-lite-class models that follow structure better than essays.

Evidence (live, 200 decisions): 100% sceneDirection usage with fully scripted replies, 82% two-waifu
decisions, 9.5% no_reply, retrigger only at round values 600–7200s, replyStyle effectively dead,
past decisions replayed as few-shot examples that reinforce all of the above.

## 1. Decision schema changes (`src/orchestration/decisions.ts`)

```ts
export const DIRECTIVE_INTENTS = [
  "break_loop",     // recent messages are circling; force a pivot
  "change_topic",   // proactively land a new named topic
  "include_person", // pull a named quiet participant back in
  "close_beat",     // wind the current exchange down
  "interrupt",      // cut into the current exchange from a new angle
  "spotlight"       // have this waifu pick up a specific overlooked message/thread
] as const;

export const DirectiveSchema = z.object({
  intent: z.enum(DIRECTIVE_INTENTS),
  goal: z.string().min(1) // length cap (DIRECTIVE_GOAL_MAX_CHARS = 100) enforced by the runtime
                          // guardrail (§2.1), NOT here — an over-cap goal must parse so it can be
                          // stripped gracefully instead of failing the whole decision
});

export const RespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0),
  directive: DirectiveSchema.nullish(),       // replaces sceneDirection
  replyToMessageId: z.string().min(1).optional() // kept for /run + internal use; NOT in the tool schema
});

export const OrchestratorDecisionSchema = z.object({
  action: OrchestratorActionSchema,
  respondingWaifus: z.array(RespondingWaifuSchema).default([]),
  retriggerAfterSeconds: z.number().min(RETRIGGER_MIN_SECONDS).max(RETRIGGER_MAX_SECONDS).optional(),
  wakePlan: z.string().nullish(),             // new: what the orchestrator intends to do when its timer
                                              // fires; clipped to 200 chars in code, never rejected
  reasoning: z.string().min(1)
});
```

Removed: `replyStyle` (everywhere — schema, tool params, prompts, `WaifuGenerationRequest`,
`replyStyleHint`/`replyStyleMessagesFor*` in `pipelines.ts`). Length is now governed by the waifu
harness (`02-waifu-harness.md`).

Removed from the tool schema: `repleyToMessageIndex` (the misspelled field the new-format prompt
already orders the model to always set null — pure dead weight for weak models). The zod
`replyToMessageId` field stays for the `/run` directed path.

**Leniency rule**: every new/changed field is `nullish` in zod with graceful degradation — a
malformed `directive` object is dropped (logged), never a failed decision. Validation strictness
lives in the tool JSON schema (which providers enforce), not in the parse path.

The tool JSON schema (`orchestratorToolParameters` in `pipelines.ts`) is updated to match and stays
the **single canonical definition** — this is the same schema the gateway migration P3 wants to own;
see `06-gateway-coordination.md`.

## 2. Code guardrails (`src/orchestration/runtime.ts`)

### 2.1 Directive budget

A directive is honored only when at least one holds:

- `decisionsSinceLastHonoredDirective >= directiveCooldown` (new `AgentConfig` field, default **3**), or
- the loop detector (2.3) fired for this pass, or
- the decision is a manual `/run` with a user-provided scene direction (override path unchanged).

Otherwise the runtime **strips the directive** before execution, records
`directiveStripped: "cooldown"` on the responder outcome, and proceeds. Over-cap goals
(>100 chars — i.e. a scripted reply) are stripped with `directiveStripped: "over_cap"` rather than
clipped: a truncated script is worse than no directive. Tracked per channel in memory
(`Map<channelKey, number>`), reset on honored directive.

`clipSceneDirection` config + `clipSceneDirectionForWaifu()` are deleted (subsumed). Remove the
toggle from `OrchestratorView`.

### 2.2 Few-shot replay sanitization (`serializeOrchestratorDecisionArguments` in `pipelines.ts`)

Past decisions replayed into the timeline are serialized with:

- `directive`: `{ intent }` only — **goal text omitted**. The model must not see 20 examples of
  goal-writing style; it especially must not see scripted-reply-shaped goals.
- `reasoning`: clipped to 160 chars.
- no `replyStyle`, no `repleyToMessageIndex` (gone from schema).

This kills the self-reinforcement loop observed live (identical scripted directions in consecutive
decisions).

### 2.3 Loop detector (new `src/orchestration/loopDetector.ts`)

Deterministic, local, cheap — gives the weak model an *external* signal instead of asking it to
self-diagnose:

- Tokenize the last 8 waifu-authored context messages (lowercase, strip punctuation, drop stopwords
  — reuse the stopword set from `runtime.ts` stage-manager helpers).
- Jaccard similarity per adjacent same-channel pair; `loopSuspected` when ≥ 2 of the last 4 pairs
  exceed 0.45, or any pair exceeds 0.8.
- Output is injected as a runtime notice in the trailing prompt (see 3.3) **and** unlocks the
  directive budget for this pass.

Unit-tested with fixture transcripts (eval doc).

### 2.4 Wake markers — make timer wakes legible

Today a timer-fired run is indistinguishable from a message-triggered run, so the model "re-decides"
the same thing. Fixes:

- `wakePlan` (schema §1) is stored on the history entry.
- `runChannelLoop` gains a `trigger` field on `ChannelRunOptions`
  (`"message" | "scheduled-retrigger" | "manual" | ...` — derive from the existing `reason` string).
- On a scheduled-retrigger run, the orchestrator request includes a synthetic timeline tail item
  (rendered as the last user-role line before the trailing prompt):

  ```
  [wake: the Ns pause you scheduled has elapsed with no new messages. Your plan was: "<wakePlan>".
   Execute it now, or if the room state changed, decide fresh. Choosing another identical pause is
   almost always wrong — either act, or back off with a longer pause.]
  ```

- Plumbing: revive the currently dead marker path — `readRecentNoReplyMarkers`,
  `OrchestratorNoReplyMarker`, `formatNoReplyMarker`, and the unused `markers` parameter of
  `renderContext`/`decisionMarkers` on `ProviderRequest`. Extend `buildOrchestratorTimeline` to
  accept marker items (timestamp-sorted like decisions). One marker type for v1: the wake notice.

### 2.5 Escalating backoff (code assist)

If a timer-fired pass again returns `no_reply`, `scheduleRetrigger` enforces
`max(model value, 1.5 × previous interval)` for that channel (cap unchanged at
`RETRIGGER_MAX_SECONDS`). Prevents same-interval grinding even if the prompt fails.

## 3. Prompt rewrite

All orchestrator prompt text in `runtime.ts` (`buildOrchestratorSystemPrompt`,
`buildOrchestratorTrailingPrompt`, `DEFAULT_ORCHESTRATOR_PROMPT`). The legacy-prompt branch
(`useLegacyPrompt`) is **removed** — it documents the old field names and would fight every change
here. Drop the config flag and the `OrchestratorView` toggle; `docs/old-orchestrator-prompt.md`
already archives the historical text.

### 3.1 Principles

- **Who/when, not what.** The orchestrator never writes reply content. Directives carry *goals*
  ("get the topic onto LTS's car"), never lines ("say that the car is…").
- **Distribution over preference.** Replace "prefer a two-waifu chain" with explicit expected
  shape: one responder is the normal case; two when a second has a genuinely distinct reaction;
  three or more only for pile-on moments; zero (no_reply) is a first-class, common answer.
- **The loop is the chain.** State plainly: "after each waifu reply lands you will be consulted
  again — you do not need to pre-plan a scene; plan one beat."
- **Cast autonomy.** Remove the missed-user drumbeat (it appears 3× today). New framing: "The cast
  has its own life. When humans are active, weave them in; when they are not, the waifus pursue
  their own threads and do NOT keep talking about absent users."
- **Pauses are plans.** no_reply requires a `wakePlan`; the prompt explains that the runtime will
  hand the plan back when the timer fires, and that fresh human messages cancel the timer anyway,
  so long pauses are free.

### 3.2 Draft replacement for `DEFAULT_ORCHESTRATOR_PROMPT`

```
You watch one Discord channel and direct a small cast of waifu personas. Each pass, decide who (if
anyone) speaks next. You choose speakers and timing; each waifu writes her own words — never write
or paraphrase a reply for her.

Decision shape:
- Most of the time the right answer is one waifu, or nobody. Pick the persona whose voice fits the
  moment. Two waifus only when the second has a clearly distinct reaction of her own; three or more
  only for rare pile-on moments. You are consulted again after each reply lands, so plan one beat,
  not a scene.
- no_reply is a normal, frequent choice. Real group chats are mostly silence. If the beat has
  landed, or another bot message would add noise, choose no_reply.

directive (optional, rate-limited by the runtime):
- A directive is a short GOAL for that waifu's next message, not content. Good: {intent:
  "change_topic", goal: "steer toward LTS's car project"}. Bad: anything that reads like a line she
  would say. The runtime rejects directives most of the time; they are for steering moments —
  breaking a loop, pulling in a named quiet person, closing a beat, landing a new topic. When the
  runtime tells you a loop is forming, that is the moment to use one.
- Default is null. The waifu's persona handles normal flow without your help.

no_reply + retriggerAfterSeconds + wakePlan:
- retriggerAfterSeconds is a planned pause before YOU re-check the room — any new human message
  wakes you regardless, so long pauses cost nothing.
- wakePlan: one sentence on what you intend at wake ("if nobody replied to Riko's question, have
  Lumi answer it"; "room is dead, just re-check"). When your timer fires, the runtime shows your
  plan back to you: execute it or re-decide — do not schedule the same pause again.
- Use the whole range: 100–300s when you expect a reaction to need a nudge soon; 600–1800s for a
  cooling room with a planned revival; 3600s+ when you are mostly waiting for humans. Repeated
  quiet checks should back off to longer pauses.

delaySeconds is a realistic reading/typing delay (0–30). When a human spoke in the last few
messages, the first waifu starts immediately and later delays count from this decision; otherwise
each delay counts after the previous waifu finishes. Any new message cancels the remaining chain.

Watch the recent speaker pattern. If the same waifu or the same pair has carried several beats,
switch speakers, go quiet, or use a directive to pivot — do not let two waifus volley each other
with restatements of the same mood.
```

The `<hard_rules>` block shrinks to the structural facts (verbatim waifu IDs, field requirements,
the runtime pacing note). The `<loop_breaking>` section is replaced by the runtime notice (3.3) plus
two sentences in the task prompt. The retrigger-pacing section folds into the draft above
(`promptSections` toggles update accordingly: `loopBreaking` → removed, `retriggerPacing` →
`pausePlanning`; reflect in `OrchestratorView` and `frontend/api/types.ts`).

### 3.3 Runtime notices (trailing prompt)

Appended after `<active_waifus>` and `<current_time>` when applicable:

- Loop: `<runtime_notice>The last N waifu messages look repetitive (similarity HIGH). Break the
  pattern: different speaker, a directive with a concrete new goal, or silence.</runtime_notice>`
- Directive budget: when the budget is closed, the tool schema description for `directive` says
  "directives are currently rate-limited; null unless intent is break_loop with strong cause" —
  cheaper than re-rendering prompt text, and models reliably read tool descriptions.

### 3.4 Active-waifus block

Today each waifu's **full persona** is embedded in the trailing prompt (up to 2.6k chars each × 5).
Replace with the persona digest (`02-waifu-harness.md` §4): 1–2 lines per waifu + availability.
Shrinks the orchestrator prompt by ~8–10k chars, which matters at a 20–40 message context and for
decision latency.

## 4. Config & defaults

- `AgentConfig` (orchestrator): + `directiveCooldown: number` (default 3). Remove
  `clipSceneDirection`, `useLegacyPrompt`. `promptSections` keys updated (3.2).
- Default orchestrator `contextWindow`: 20 → **40** (loop detection and pacing need span; messages
  are one-liners). `server.contextWindows.orchestrator` override unchanged.
- Recommendation (not enforced): orchestrator model one tier up from flash-lite (e.g.
  `gemini-3-flash-preview` or `claude-haiku-4-5`) — the eval harness (05) includes a comparison
  runner to make this an evidence-based choice.

## 5. Touched files

| File | Change |
|---|---|
| `src/orchestration/decisions.ts` | schema §1 |
| `src/orchestration/runtime.ts` | guardrails §2, prompts §3, config §4, legacy-prompt removal |
| `src/orchestration/loopDetector.ts` | new |
| `src/providers/pipelines.ts` | tool schema, replay sanitization, replyStyle removal, marker timeline items, `parseDecision` |
| `src/providers/types.ts` | `ProviderRequest.decisionMarkers` revived; `WaifuGenerationRequest.replyStyle` removed |
| `src/shared/schemas/domain.ts` | `AgentConfig` fields; `OrchestratorRespondingWaifu` (directive replaces sceneDirection/replyStyle); history entry + `wakePlan`, `directiveStripped` outcome reason |
| `src/frontend/views/OrchestratorView.tsx`, `src/frontend/api/types.ts` | config fields, decision-history rendering (directive display) |
| `tests/` | decisions schema, loop detector, budget/strip behavior, wake-marker plumbing, backoff |

Storage note: orchestrator history entries gain/lose fields → lenient zod (`.nullish()`) so old
entries still parse; no migration needed (history is a rolling 200-entry log).
