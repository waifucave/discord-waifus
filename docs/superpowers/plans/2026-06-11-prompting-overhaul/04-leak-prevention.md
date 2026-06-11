# W4a — Leak Prevention

Goal: nothing model-internal ever reaches the Discord chat. LLM output can't be made provably safe,
so the guarantee is **layered**: prompts that make leaks unlikely → a deterministic validator that
catches the known shapes → a bounded retry → the reviewer model as backstop → a regression corpus
so no known leak shape ever ships twice.

## 1. Current state (what already exists and stays)

- `stripLeakedContextHeader` (`src/discord/normalization.ts`): leading/trailing bracket tags, legacy
  index/timestamp headers, sender-prefix strip, inline `[timestamp|sender|index:…]` headers, orphan
  `[replying to|reactions:…]` lines, `<analysis|thinking|reasoning|thought|scratchpad>` blocks,
  draft-marker self-talk, impersonation-line removal with indented-body skipping.
- `extractReplyQuote` consumes the `replying to >` line before send.
- One regeneration retry when cleaning empties the reply; nothing is sent if it empties twice.
- Stop sequences `\n{Name}:` for all participants.
- Mention/emoji denormalization with allow-listed pings, `@everyone`/`@here` defused.
- Reviewer pass (optional, separate model) deletes flagged messages after the fact.

Gaps: tool/JSON fragments aren't matched; our own prompt-block XML tags aren't matched; a
scene-direction echo went out verbatim because directions *were* the content (fixed at the source
by W1's typed directives, but needs a net); checks live scattered in `runtime.ts` with no single
report of what fired.

## 2. New: output validator (new `src/orchestration/outputValidator.ts`)

One pure function the runtime calls on the cleaned candidate reply (after the existing strip path,
before `splitWaifuReply`):

```ts
validateWaifuOutput(text, ctx: {
  selfName: string;
  participantNames: string[];
  directive?: { intent: string; goal: string };
  blockTags: string[];          // every XML-ish tag the harness can emit for this waifu
  toolNames: string[];          // add_memory, PickNextWaifu, orchestrator_decision, ...
}): { verdict: "pass" | "retry" | "block"; violations: Violation[] }
```

Checks, each producing a named violation (all deterministic, unit-tested):

| Check | Catches | Verdict |
|---|---|---|
| `harness-tag` | any `<tag>`/`</tag>` where tag ∈ blockTags or matches `^[a-z_]+_(identity\|anchor\|relevant_memories\|...)$` | retry |
| `tool-fragment` | tool names adjacent to `{`/`(`/`:` ; JSON-shaped lines containing `"content"\|"waifuId"\|"intent"` keys | retry |
| `bracket-tag` | any surviving `[word: …]` metadata shape anywhere (stricter than the strip's leading/trailing scope) | retry |
| `transcript-shape` | ≥ 2 lines matching `^Name:` for *any* known participant (single-line impersonation is already stripped; multi-line means the model wrote a transcript) | retry |
| `directive-echo` | token-overlap(reply, directive.goal) ≥ 0.6 → the waifu pasted the director note | retry |
| `self-talk` | the existing `META_ANALYSIS_LEAK_RE` family re-checked post-strip | retry |
| `mass-ping` | surviving `@everyone`/`@here` (belt + braces; denormalizer also defuses) | block |

Flow in `executeResponderDecision`:

1. attempt 1 → strip path → validator. `pass` → send.
2. `retry` → regenerate once (existing `MAX_GENERATE_ATTEMPTS` retry slot, with the corrective
   `retryUserMessage` extended to name the violation: `"{displayName}: (your previous draft was
   rejected: contained {violation}; write only the plain chat message)"`).
3. second failure or `block` → **do not send**, record outcome `status: "blocked"` with the
   violation list (new `OrchestratorResponderOutcome` reason), log, surface in the decision history
   UI. Silence is always preferable to a leak.

No truncation is introduced anywhere — the validator's only powers are "send as-is", "regenerate",
or "send nothing".

## 3. Reviewer

Stays as the backstop (it judges semantics the regexes can't), with one prompt addition to its
hallucination definition: "a message that primarily restates an instruction or goal it was given
(reads as a directive, not as chat)". Reviewer remains optional/off-by-default per current config.

## 4. Other leak surfaces audited

- **Debug routes** (`/console set`): orchestrator decisions + dream summaries post full reasoning
  and goals to the configured destination channel. That's by design, but the destination must never
  be a cast channel — add a runtime guard: refuse `setDebugRoute` when the destination channel has
  enabled waifus (it's a one-line check against the server config), with a clear error.
- **`/print`** posts system prompts into the invoking channel by explicit user command — acceptable
  (user-initiated, admin tooling), no change beyond noting it here.
- **Typing-indicator orchestrator tell**: the orchestrator bot itself shows "typing…" during
  decisions (`startTypingScope` without `senderBotId`), leaking the machinery's presence into the
  room. Cosmetic, but cheap to fix: drop the typing scope for orchestrator decisions.
- **Memory contents** flow into prompts only — never rendered into Discord except via `/print` and
  `/memories` admin responses. Unchanged.

## 5. Regression corpus

Every leak shape ever observed gets a fixture (gitignored real ones + committed synthetic
equivalents — the repo is public): the live `logs.md` examples, the scripted-direction echoes from
the live history, hand-built tool-JSON and harness-tag leaks. The eval suite (05) asserts the
validator catches 100% of the corpus and passes a clean-reply set with zero false positives ≥ a
fixed sample (false-positive budget: 0 on the clean set — the checks are shaped to be unambiguous).

## 6. Touched files

| File | Change |
|---|---|
| `src/orchestration/outputValidator.ts` | new (§2) |
| `src/orchestration/runtime.ts` | validator hookup in the generate loop, blocked outcome, debug-route guard, orchestrator typing removal |
| `src/shared/schemas/domain.ts` | `responderOutcome.status` + `"blocked"`, violation reasons |
| `src/providers/pipelines.ts` | corrective retry message plumbing (violation name) |
| `src/frontend` (OrchestratorView history) | render blocked outcomes |
| `tests/` + `tests/eval/` | unit checks per rule, corpus regression suite |
