# W1 — Orchestrator Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the orchestrator from a ghost-writer into a director: typed rate-limited directives instead of freeform sceneDirection, wake-plan-aware idle triggers, deterministic loop detection, sanitized few-shot replay with real outcomes, a rewritten prompt, and full removal of replyStyle and the legacy prompt.

**Architecture:** The decision wire format changes in `src/orchestration/decisions.ts` + `src/shared/schemas/domain.ts` and flows through `src/providers/pipelines.ts` (tool schema, parsing, timeline replay) into `src/orchestration/runtime.ts` (guardrails, wake markers, prompt assembly). New pure modules: `src/orchestration/loopDetector.ts`. Tasks are staged additively so the repo typechecks and tests green at every commit.

**Tech Stack:** TypeScript ESM (NodeNext — local imports need `.js` extensions), Zod, Vitest (`npm run test`, single file via `npx vitest run tests/<name>.test.ts`), `npm run typecheck`.

**Design doc:** `docs/superpowers/plans/2026-06-11-prompting-overhaul/01-orchestrator.md` (read it first; it has the evidence and rationale).

**House rules (from CLAUDE.md):**
- Local imports use `.js` extensions.
- Tests use real temp data roots via `tests/testUtils.ts`, cleaned in `afterEach`.
- Never edit `dist/`. Run `npm run build:backend` only if you need the shipped CLI to pick changes up.
- Two-space indent, double quotes, semicolons.

---

## Task 1: Loop detector module

**Files:**
- Create: `src/orchestration/loopDetector.ts`
- Test: `tests/loopDetector.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/loopDetector.test.ts
import { describe, expect, it } from "vitest";
import { assessLoop } from "../src/orchestration/loopDetector.js";
import { ContextMessage } from "../src/orchestration/context.js";

function msg(id: string, authorKind: "user" | "waifu", authorId: string, content: string): ContextMessage {
  return {
    id,
    channelId: "c1",
    authorKind,
    authorId,
    name: authorId,
    displayName: authorId,
    content,
    timestamp: `2026-06-11T20:00:0${id.length % 10}Z`,
    reactions: []
  };
}

describe("assessLoop", () => {
  it("does not fire on a varied conversation", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "did you see the storm last night?"),
      msg("b", "waifu", "riko", "yeah my power went out for an hour"),
      msg("c", "waifu", "aria", "I just lit candles and read manga"),
      msg("d", "waifu", "riko", "of course you did, total gremlin behavior")
    ]);
    expect(result.suspected).toBe(false);
    expect(result.notice).toBeUndefined();
  });

  it("fires when consecutive waifu messages keep restating the same beat", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "we should totally get matching disaster trio shirts"),
      msg("b", "waifu", "riko", "yes matching disaster shirts to make the trio official"),
      msg("c", "waifu", "aria", "matching shirts for the disaster trio would be so official"),
      msg("d", "waifu", "riko", "official disaster trio matching shirts, I am drafting it")
    ]);
    expect(result.suspected).toBe(true);
    expect(result.notice).toContain("repetitive");
  });

  it("fires on a single near-duplicate pair (similarity above 0.8)", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "the broth defines the entire ramen experience honestly"),
      msg("b", "waifu", "riko", "honestly the broth defines the entire ramen experience")
    ]);
    expect(result.suspected).toBe(true);
  });

  it("ignores user messages when pairing", () => {
    const result = assessLoop([
      msg("a", "waifu", "aria", "we should get matching shirts"),
      msg("b", "user", "kevin", "we should get matching shirts"),
      msg("c", "user", "kevin", "we should get matching shirts")
    ]);
    expect(result.suspected).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/loopDetector.test.ts`
Expected: FAIL — `Cannot find module '../src/orchestration/loopDetector.js'`

- [ ] **Step 3: Implement the module**

```ts
// src/orchestration/loopDetector.ts
import { ContextMessage } from "./context.js";

export type LoopAssessment = {
  suspected: boolean;
  notice?: string;
};

const WINDOW = 8;                 // waifu messages considered
const PAIRS_CHECKED = 4;          // adjacent pairs from the tail
const PAIR_THRESHOLD = 0.45;      // similarity that marks a pair repetitive
const HARD_THRESHOLD = 0.8;       // any single pair this similar => loop
const MIN_REPETITIVE_PAIRS = 2;

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "that", "this", "these", "those", "it", "its", "as", "into", "about",
  "i", "you", "he", "she", "they", "we", "them", "his", "her", "their",
  "do", "does", "did", "have", "has", "had", "will", "would", "should", "could", "can",
  "not", "no", "yes", "so", "than", "then", "very", "just", "also", "too"
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

// Deterministic repetition check over the most recent waifu-authored messages.
// Gives a flash-lite-class orchestrator an external loop signal instead of
// asking it to self-diagnose from raw chat.
export function assessLoop(messages: ContextMessage[]): LoopAssessment {
  const waifuMessages = messages.filter((message) => message.authorKind === "waifu").slice(-WINDOW);
  if (waifuMessages.length < 2) return { suspected: false };
  const tokens = waifuMessages.map((message) => tokenSet(message.content));
  const similarities: number[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    similarities.push(jaccard(tokens[i - 1], tokens[i]));
  }
  const tail = similarities.slice(-PAIRS_CHECKED);
  const repetitivePairs = tail.filter((value) => value >= PAIR_THRESHOLD).length;
  const suspected = repetitivePairs >= MIN_REPETITIVE_PAIRS || tail.some((value) => value >= HARD_THRESHOLD);
  if (!suspected) return { suspected: false };
  return {
    suspected: true,
    notice:
      `The last few waifu messages look repetitive (${repetitivePairs} of the latest ${tail.length} adjacent pairs ` +
      "are near-duplicates). Break the pattern: a different speaker, a directive with a concrete new goal, or silence."
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/loopDetector.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/loopDetector.ts tests/loopDetector.test.ts
git commit -m "feat: add deterministic loop detector for orchestrator context"
```

---

## Task 2: Decision schemas — directives + wakePlan (additive; replyStyle becomes optional)

Nothing is removed in this task. `replyStyle` becomes optional-with-default so Task 3 can stop
emitting it without breaking compilation; full removal is Task 6.

**Files:**
- Modify: `src/orchestration/decisions.ts`
- Modify: `src/shared/schemas/domain.ts:431-441` (responder), `:474-487` (history entry), `:463-472` (outcome), `:239-264` (prompt sections + agent config)
- Modify: `src/orchestration/context.ts:42-48` (marker schema)
- Modify: `src/providers/types.ts:41` (marker type), `:46` (budget flag)
- Test: create `tests/decisions.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/decisions.test.ts
import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_GOAL_MAX_CHARS,
  MODEL_DIRECTIVE_INTENTS,
  OrchestratorDecisionSchema,
  RespondingWaifuSchema,
  WAKE_PLAN_MAX_CHARS
} from "../src/orchestration/decisions.js";

describe("RespondingWaifuSchema", () => {
  it("defaults delaySeconds to 0 and accepts a directive", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "break_loop", goal: "land a brand-new topic" }
    });
    expect(parsed.delaySeconds).toBe(0);
    expect(parsed.directive).toEqual({ intent: "break_loop", goal: "land a brand-new topic" });
  });

  it("degrades a malformed directive to undefined instead of failing", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "break_loop" } // missing goal
    });
    expect(parsed.directive).toBeUndefined();
  });

  it("accepts an over-cap goal (cap is a runtime guardrail, not a parse rule)", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "spotlight", goal: "x".repeat(DIRECTIVE_GOAL_MAX_CHARS + 50) }
    });
    expect(parsed.directive?.goal.length).toBe(DIRECTIVE_GOAL_MAX_CHARS + 50);
  });

  it("excludes manual from the model-facing intent list", () => {
    expect(MODEL_DIRECTIVE_INTENTS).not.toContain("manual");
  });
});

describe("OrchestratorDecisionSchema", () => {
  it("clips wakePlan instead of rejecting it", () => {
    const parsed = OrchestratorDecisionSchema.parse({
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 600,
      wakePlan: "y".repeat(WAKE_PLAN_MAX_CHARS + 100),
      reasoning: "quiet room"
    });
    expect(parsed.wakePlan?.length).toBe(WAKE_PLAN_MAX_CHARS);
  });

  it("still enforces the reply/no_reply shape rules", () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        action: "reply",
        respondingWaifus: [],
        reasoning: "broken"
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/decisions.test.ts`
Expected: FAIL — `DIRECTIVE_GOAL_MAX_CHARS` etc. not exported.

- [ ] **Step 3: Rewrite `src/orchestration/decisions.ts`**

Replace the whole file with:

```ts
import { z } from "zod";

// replyStyle is deprecated and removed in Task 6 of the W1 plan; optional here so the
// runtime keeps compiling while the pipelines stop emitting it.
export const REPLY_STYLE_VALUES = ["normal", "short", "long", "sleepy"] as const;
export type ReplyStyle = (typeof REPLY_STYLE_VALUES)[number];
export const ReplyStyleSchema = z.enum(REPLY_STYLE_VALUES);

export const ORCHESTRATOR_ACTION_VALUES = ["reply", "no_reply"] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTION_VALUES)[number];
export const OrchestratorActionSchema = z.enum(ORCHESTRATOR_ACTION_VALUES);

export const RETRIGGER_MIN_SECONDS = 100;
export const RETRIGGER_MAX_SECONDS = 28800;
export const MAX_WAIFU_DELAY_SECONDS = 30;
export const DIRECTIVE_GOAL_MAX_CHARS = 100;
export const WAKE_PLAN_MAX_CHARS = 200;

// "manual" carries /run scene directions; it is never offered to the model and is
// exempt from the runtime directive budget and goal cap.
export const DIRECTIVE_INTENTS = [
  "break_loop",
  "change_topic",
  "include_person",
  "close_beat",
  "interrupt",
  "spotlight",
  "manual"
] as const;
export type DirectiveIntent = (typeof DIRECTIVE_INTENTS)[number];
export const MODEL_DIRECTIVE_INTENTS = DIRECTIVE_INTENTS.filter(
  (intent): intent is Exclude<DirectiveIntent, "manual"> => intent !== "manual"
);

export const DirectiveSchema = z.object({
  intent: z.enum(DIRECTIVE_INTENTS),
  // The goal cap (DIRECTIVE_GOAL_MAX_CHARS) is enforced by the runtime guardrail so an
  // over-cap goal parses and is stripped gracefully instead of failing the whole decision.
  goal: z.string().min(1)
});
export type Directive = z.infer<typeof DirectiveSchema>;

// A malformed directive degrades to undefined — never a failed decision.
const LenientDirectiveSchema = DirectiveSchema.nullish()
  .catch(null)
  .transform((value) => value ?? undefined);

export const RespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  directive: LenientDirectiveSchema.optional(),
  replyToMessageId: z.string().min(1).optional(),
  replyStyle: ReplyStyleSchema.optional()
});
export type RespondingWaifu = z.infer<typeof RespondingWaifuSchema>;

const WakePlanSchema = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, WAKE_PLAN_MAX_CHARS) : undefined;
  });

export const OrchestratorDecisionSchema = z
  .object({
    action: OrchestratorActionSchema,
    respondingWaifus: z.array(RespondingWaifuSchema).default([]),
    retriggerAfterSeconds: z
      .number()
      .min(RETRIGGER_MIN_SECONDS)
      .max(RETRIGGER_MAX_SECONDS)
      .optional(),
    wakePlan: WakePlanSchema.optional(),
    reasoning: z.string().min(1)
  })
  .superRefine((value, ctx) => {
    if (value.action === "reply") {
      if (value.respondingWaifus.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["respondingWaifus"],
          message: "respondingWaifus must be non-empty when action is reply."
        });
      }
      if (value.retriggerAfterSeconds !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retriggerAfterSeconds"],
          message: "retriggerAfterSeconds must be omitted when action is reply."
        });
      }
    } else {
      if (value.respondingWaifus.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["respondingWaifus"],
          message: "respondingWaifus must be empty when action is no_reply."
        });
      }
      if (value.retriggerAfterSeconds === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retriggerAfterSeconds"],
          message: "retriggerAfterSeconds is required when action is no_reply."
        });
      }
    }
  });

export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;
```

- [ ] **Step 4: Update `src/shared/schemas/domain.ts`**

(a) Replace `OrchestratorRespondingWaifuSchema` (keep `OrchestratorReplyStyleSchema` above it for
now — deleted in Task 6):

```ts
export const OrchestratorDirectiveSchema = z.object({
  intent: z.string().min(1),
  // goal is stored in history for the dashboard; it is omitted from few-shot replay.
  goal: z.string().optional()
});
export type OrchestratorDirective = z.infer<typeof OrchestratorDirectiveSchema>;

export const OrchestratorRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  replyStyle: OrchestratorReplyStyleSchema.optional(),
  replyToMessageId: z.string().min(1).optional(),
  sceneDirection: z.string().min(1).optional(),
  directive: OrchestratorDirectiveSchema.optional()
});
```

(b) `OrchestratorResponderOutcomeSchema`: add after `reason`:

```ts
  directiveStripped: z.enum(["cooldown", "over_cap"]).optional(),
```

(c) `OrchestratorDecisionHistoryEntrySchema`: add after `retriggerAfterSeconds`:

```ts
  wakePlan: z.string().optional(),
```

(d) `OrchestratorPromptSectionsSchema` — replace with the new keys (old persisted keys are
unknown-key-stripped by zod, so old configs still parse and get the defaults):

```ts
export const OrchestratorPromptSectionsSchema = z
  .object({
    pausePlanning: z.boolean().default(true),
    messageStructure: z.boolean().default(true)
  })
  .default({
    pausePlanning: true,
    messageStructure: true
  });
```

(e) `AgentConfigSchema`: add after `clipSceneDirection` (which stays until Task 5):

```ts
  directiveCooldown: z.number().int().min(0).max(20).default(3),
```

- [ ] **Step 5: Replace the marker schema in `src/orchestration/context.ts:42-48`**

```ts
export const OrchestratorWakeMarkerSchema = z.object({
  kind: z.literal("wake"),
  timestamp: z.string(),
  scheduledSeconds: z.number().int(),
  wakePlan: z.string().optional()
});
export type OrchestratorWakeMarker = z.infer<typeof OrchestratorWakeMarkerSchema>;
```

Delete `OrchestratorNoReplyMarkerSchema`/`OrchestratorNoReplyMarker`. Fix its references:
- `src/providers/types.ts:2,41` — import/type becomes `OrchestratorWakeMarker`.
- `src/providers/pipelines.ts` — update the import; `renderContext`'s unused `markers` parameter
  and `formatNoReplyMarker` (lines ~766-804): delete the parameter, the `Item` union's marker arm,
  and `formatNoReplyMarker` entirely (dead code; the orchestrator timeline gets real wake handling
  in Task 3).
- `src/orchestration/runtime.ts` — delete the dead method `readRecentNoReplyMarkers`
  (lines ~2952-2983) and the now-unused `OrchestratorNoReplyMarker` import.

- [ ] **Step 6: Add the budget flag to `src/providers/types.ts`**

In `ProviderRequest`, after `replyRequired?: boolean;`:

```ts
  directiveBudgetOpen?: boolean;
```

- [ ] **Step 7: Typecheck and run the suite**

Run: `npm run typecheck && npm run test`
Expected: typecheck PASS. Tests: `tests/decisions.test.ts` PASS. If `tests/runtime.test.ts` or
`tests/pipelines.test.ts` fail on the deleted marker helpers, fix those references only (the marker
path was dead code, so no behavioral assertions should exist).

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -m "feat: add typed directives, wakePlan, and wake-marker schema (additive)"
```

---

## Task 3: Pipelines — tool schema, parsing, sanitized replay, outcomes, gap/wake notes

**Files:**
- Modify: `src/providers/pipelines.ts` (orchestrator tool params ~1272-1339, raw schemas ~1788-1804, `parseDecision` ~1851-1891, `serializeOrchestratorDecisionArguments` ~862-876, `buildOrchestratorTimeline` ~827-860, the four timeline builders ~884-1009, four `decideOrchestrator` bodies)
- Test: `tests/pipelines.test.ts`

- [ ] **Step 1: Write failing tests (append to `tests/pipelines.test.ts`)**

Follow the file's existing fixture helpers for building `OrchestratorDecisionHistoryEntry` /
`ContextMessage` objects. Add:

```ts
describe("orchestrator wire format (W1)", () => {
  it("tool schema requires only waifuId per responder and has no replyStyle/index fields", () => {
    const params = ORCHESTRATOR_TOOL_PARAMETERS as any; // exported in step 2
    const responder = params.properties.respondingWaifus.items;
    expect(responder.required).toEqual(["waifuId"]);
    expect(responder.properties.replyStyle).toBeUndefined();
    expect(responder.properties.repleyToMessageIndex).toBeUndefined();
    expect(responder.properties.directive).toBeDefined();
    expect(params.properties.wakePlan).toBeDefined();
  });

  it("parseDecision normalizes directives and drops unknown intents", () => {
    const decision = parseDecisionForTest(JSON.stringify({
      action: "reply",
      respondingWaifus: [
        { waifuId: "aria", directive: { intent: "change_topic", goal: "bring up the snowstorm" } },
        { waifuId: "riko", directive: { intent: "write_her_reply", goal: "say hi" } }
      ],
      retriggerAfterSeconds: null,
      reasoning: "test"
    }));
    expect(decision.respondingWaifus[0].directive).toEqual({ intent: "change_topic", goal: "bring up the snowstorm" });
    expect(decision.respondingWaifus[0].delaySeconds).toBe(0);
    expect(decision.respondingWaifus[1].directive).toBeUndefined();
  });

  it("replays past decisions with intent-only directives, clipped reasoning, and real outcomes", () => {
    // decision fixture: action reply, one responder with directive {intent:"spotlight", goal:"secret goal text"},
    // reasoning 300 chars, responderOutcomes [{status:"empty", waifuId:"aria", ...}]
    const messages = buildOpenAiChatOrchestratorMessagesForTest(/* fixture */);
    const assistant = messages.find((m: any) => m.tool_calls);
    const args = JSON.parse(assistant.tool_calls[0].function.arguments);
    expect(args.respondingWaifus[0].directive).toEqual({ intent: "spotlight" });
    expect(JSON.stringify(args)).not.toContain("secret goal text");
    expect(args.reasoning.length).toBeLessThanOrEqual(160);
    const toolResult = messages.find((m: any) => m.role === "tool");
    expect(toolResult.content).toContain("aria: empty");
  });

  it("inserts gap notes for >=15min silences and renders a wake marker last", () => {
    // two messages 2h apart + decisionMarkers: [{kind:"wake", scheduledSeconds:1800, wakePlan:"have Lumi answer"}]
    const messages = buildOpenAiChatOrchestratorMessagesForTest(/* fixture */);
    const texts = messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
    expect(texts.some((t: string) => /\[2h pass\]/.test(t))).toBe(true);
    const lastContext = texts[texts.length - 2]; // trailing prompt is last
    expect(lastContext).toContain("[wake:");
    expect(lastContext).toContain("have Lumi answer");
  });
});
```

Testability note: `parseDecision` and `buildOpenAiChatOrchestratorMessages` are module-private.
Export thin test hooks at the bottom of `pipelines.ts` the way the file already exports
`ORCHESTRATOR_TOOL_PARAMETERS`:

```ts
export const __testables = { parseDecision, buildOpenAiChatOrchestratorMessages, formatDecisionOutcome, buildOrchestratorTimeline };
```

In the tests, `parseDecisionForTest(json)` above means `__testables.parseDecision(json)` and
`buildOpenAiChatOrchestratorMessagesForTest(...)` means
`__testables.buildOpenAiChatOrchestratorMessages({ model, systemPrompt: "", messages, decisions,
markers, trailingPrompt: "go" })`. Build the `/* fixture */` inputs with the same literal-object
style the file's existing orchestrator-replay tests use — copy the nearest existing
`OrchestratorDecisionHistoryEntry` fixture and set the fields named in each test comment.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/pipelines.test.ts`
Expected: new tests FAIL (old schema shape / missing exports).

- [ ] **Step 3: Rewrite `orchestratorToolParameters` (~line 1272)**

```ts
function orchestratorToolParameters(
  availableWaifuIds?: string[],
  replyRequired = false,
  directiveBudgetOpen = true
): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: replyRequired ? ["reply"] : ["reply", "no_reply"],
        description: replyRequired
          ? "\"reply\" is required for this manual run."
          : "\"reply\" when at least one waifu should answer; \"no_reply\" when nobody should speak now. no_reply is a normal, frequent choice."
      },
      respondingWaifus: {
        type: "array",
        description:
          "Waifus that will reply, in speaking order. Empty array when action is \"no_reply\". One responder is the normal case; two only when the second has a genuinely distinct reaction.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            waifuId: waifuIdSchema,
            delaySeconds: {
              type: "number",
              minimum: 0,
              maximum: MAX_WAIFU_DELAY_SECONDS,
              description: `Realistic reading/typing delay in seconds before this waifu starts. Defaults to 0 (start immediately); maximum ${MAX_WAIFU_DELAY_SECONDS}.`
            },
            directive: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    intent: {
                      type: "string",
                      enum: [...MODEL_DIRECTIVE_INTENTS],
                      description:
                        "Why this message needs steering: break_loop (recent messages are circling), change_topic (land a new named topic), include_person (pull a named quiet participant in), close_beat (wind the exchange down), interrupt (cut in from a new angle), spotlight (pick up a specific overlooked message)."
                    },
                    goal: {
                      type: "string",
                      maxLength: DIRECTIVE_GOAL_MAX_CHARS,
                      description:
                        "A short GOAL for this one message ('steer toward LTS's car project', 'pull Kevin back in') — never reply content, wording, or anything she would say."
                    }
                  },
                  required: ["intent", "goal"]
                },
                { type: "null" }
              ],
              description: directiveBudgetOpen
                ? "Usually null. Set only for a genuine steering moment; the waifu's persona handles normal flow."
                : "Rate-limited right now: the runtime will reject directives this pass unless the intent is break_loop with strong cause. Prefer null."
            }
          },
          required: ["waifuId"]
        }
      },
      retriggerAfterSeconds: {
        anyOf: [
          { type: "number", minimum: RETRIGGER_MIN_SECONDS, maximum: RETRIGGER_MAX_SECONDS },
          { type: "null" }
        ],
        description: `Only with action \"no_reply\": seconds before you re-check the room (${RETRIGGER_MIN_SECONDS}..${RETRIGGER_MAX_SECONDS}). New human messages wake you regardless, so long pauses cost nothing. Null when replying.`
      },
      wakePlan: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "Required with action \"no_reply\": one sentence on what you intend when the timer fires ('if nobody answered Riko, have Lumi answer it'; 'dead room, just re-check'). Null when replying."
      },
      reasoning: {
        type: "string",
        description: "Brief operational reason for this decision."
      }
    },
    required: ["action", "respondingWaifus", "reasoning"]
  };
}
```

Import `DIRECTIVE_GOAL_MAX_CHARS` and `MODEL_DIRECTIVE_INTENTS` from
`"../orchestration/decisions.js"`. Update `ORCHESTRATOR_TOOL_PARAMETERS = orchestratorToolParameters()`
(unchanged line) and thread the new third argument through the four wrappers
(`openAiChatOrchestratorTool`, `openAiResponsesOrchestratorTool`, `anthropicOrchestratorTool`, and
the Google equivalent at their ~1543-1555 call sites) plus their call sites in the four
`decideOrchestrator` bodies: pass `request.directiveBudgetOpen ?? true`.

- [ ] **Step 4: Rewrite the raw schemas and `parseDecision`**

Replace `RawRespondingWaifuSchema`/`RawOrchestratorDecisionSchema` (~line 1788):

```ts
const RawDirectiveSchema = z.object({
  intent: z.string().min(1),
  goal: z.string().min(1)
});

const RawRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).nullish(),
  directive: RawDirectiveSchema.nullish().catch(null)
});

const RawOrchestratorDecisionSchema = z.object({
  action: OrchestratorActionSchema,
  respondingWaifus: z.array(RawRespondingWaifuSchema).default([]),
  retriggerAfterSeconds: z
    .union([z.number().min(RETRIGGER_MIN_SECONDS).max(RETRIGGER_MAX_SECONDS), z.null()])
    .optional(),
  wakePlan: z.union([z.string(), z.null()]).optional(),
  reasoning: z.string().min(1)
});
```

Replace `parseDecision` and delete `replyToMessageIdForIndex` (~1851-1891):

```ts
function normalizeRawDirective(
  directive: { intent: string; goal: string } | null | undefined
): Directive | undefined {
  if (!directive) return undefined;
  if (!(MODEL_DIRECTIVE_INTENTS as readonly string[]).includes(directive.intent)) return undefined;
  const goal = directive.goal.trim();
  if (!goal) return undefined;
  return { intent: directive.intent as Directive["intent"], goal };
}

function parseDecision(text: string, replyRequired = false): OrchestratorDecision {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const raw = RawOrchestratorDecisionSchema.parse(parsed);
    if (replyRequired && raw.action !== "reply") {
      throw new Error("Manual /run requires action=reply.");
    }
    return OrchestratorDecisionSchema.parse({
      action: raw.action,
      respondingWaifus: raw.respondingWaifus.map((entry) => ({
        waifuId: entry.waifuId,
        delaySeconds: entry.delaySeconds ?? 0,
        directive: normalizeRawDirective(entry.directive)
      })),
      retriggerAfterSeconds:
        raw.retriggerAfterSeconds === null ? undefined : raw.retriggerAfterSeconds,
      wakePlan: raw.wakePlan ?? undefined,
      reasoning: raw.reasoning
    });
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return a valid orchestrator decision.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
```

Import `Directive` from `"../orchestration/decisions.js"`. Update the four call sites from
`parseDecision(text, new Map(), request.replyRequired)` to `parseDecision(text, request.replyRequired)`.

- [ ] **Step 5: Sanitized replay + outcome results + gap/wake notes**

Replace `serializeOrchestratorDecisionArguments` (~line 862):

```ts
function clipReplayText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

// Replay is deliberately lossy: goal text, delays, and full reasoning are omitted so past
// decisions cannot teach the model a directive-writing or scripting habit.
function serializeOrchestratorDecisionArguments(decision: OrchestratorDecisionHistoryEntry): Record<string, unknown> {
  return {
    action: decision.action,
    respondingWaifus: decision.respondingWaifus.map((responder) => ({
      waifuId: responder.waifuId,
      directive: responder.directive ? { intent: responder.directive.intent } : null
    })),
    retriggerAfterSeconds:
      decision.action === "no_reply" ? decision.retriggerAfterSeconds ?? null : null,
    wakePlan: decision.action === "no_reply" ? decision.wakePlan ?? null : null,
    reasoning: clipReplayText(decision.reasoning, 160)
  };
}

function formatDecisionOutcome(decision: OrchestratorDecisionHistoryEntry): string {
  if (decision.action === "no_reply") {
    return `paused ${decision.retriggerAfterSeconds ?? "?"}s`;
  }
  const deviations = decision.responderOutcomes
    .filter((outcome) => outcome.status !== "sent" && outcome.status !== "pending")
    .map((outcome) => `${outcome.waifuId}: ${outcome.status}`);
  if (decision.status === "interrupted") {
    deviations.push("interrupted by new activity");
  }
  return deviations.length ? deviations.join("; ") : "sent";
}
```

Replace `ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER` at its four uses (lines ~910, 934, 974, 1000) with
`formatDecisionOutcome(item.decision)`; delete the constant.

Extend `buildOrchestratorTimeline` (~line 831) with notes:

```ts
type OrchestratorTimelineItem =
  | { kind: "message"; message: ContextMessage; timestamp: string }
  | { kind: "decision"; decision: OrchestratorDecisionHistoryEntry; timestamp: string }
  | { kind: "note"; text: string; timestamp: string };

const GAP_NOTE_MIN_MS = 15 * 60 * 1000;

function formatGapLabel(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 90) return `[${minutes}m pass]`;
  const hours = Math.round(gapMs / 3_600_000);
  return `[${hours}h pass]`;
}

function gapNotes(messages: ContextMessage[]): OrchestratorTimelineItem[] {
  const notes: OrchestratorTimelineItem[] = [];
  for (let i = 1; i < messages.length; i += 1) {
    const gapMs = Date.parse(messages[i].timestamp) - Date.parse(messages[i - 1].timestamp);
    if (gapMs >= GAP_NOTE_MIN_MS) {
      notes.push({ kind: "note", text: formatGapLabel(gapMs), timestamp: messages[i].timestamp });
    }
  }
  return notes;
}

function formatWakeMarker(marker: OrchestratorWakeMarker): string {
  const plan = marker.wakePlan ? ` Your plan was: "${marker.wakePlan}".` : "";
  return (
    `[wake: the ${marker.scheduledSeconds}s pause you scheduled has elapsed with no new messages.${plan}` +
    " Execute the plan now, or if the room state changed, decide fresh. Do not schedule another identical pause — either act, or back off with a longer pause.]"
  );
}

function buildOrchestratorTimeline(
  messages: ContextMessage[],
  decisions: OrchestratorDecisionHistoryEntry[],
  markers: OrchestratorWakeMarker[] = []
): OrchestratorTimelineItem[] {
  const oldestMessageTimestamp = messages.length ? messages[0].timestamp : undefined;
  const kindRank = { note: 0, message: 1, decision: 2 } as const;
  const items: OrchestratorTimelineItem[] = [
    ...messages.map((message): OrchestratorTimelineItem => ({ kind: "message", message, timestamp: message.timestamp })),
    ...gapNotes(messages),
    ...decisions
      .filter((decision) =>
        oldestMessageTimestamp === undefined ? false : decision.createdAt >= oldestMessageTimestamp
      )
      .map((decision): OrchestratorTimelineItem => ({ kind: "decision", decision, timestamp: decision.createdAt })),
    ...markers.map((marker): OrchestratorTimelineItem => ({ kind: "note", text: formatWakeMarker(marker), timestamp: marker.timestamp }))
  ];
  items.sort((a, b) => {
    if (a.timestamp === b.timestamp) return kindRank[a.kind] - kindRank[b.kind];
    return a.timestamp < b.timestamp ? -1 : 1;
  });
  return items;
}
```

In each of the four builders (`buildOpenAiChatOrchestratorMessages`,
`buildOpenAiResponsesOrchestratorInput`, `buildAnthropicOrchestratorMessages`,
`buildGoogleOrchestratorContents`): pass `input.markers ?? []` as the third argument, extend
`OrchestratorQueryInput` with `markers?: OrchestratorWakeMarker[]`, and handle
`item.kind === "note"` exactly like a message whose text is `item.text` (user role / text part /
user block respectively). Each of the four `decideOrchestrator` bodies passes
`markers: request.decisionMarkers` into its builder input.

- [ ] **Step 6: Update existing pipelines tests**

`tests/pipelines.test.ts` has 5 `replyStyle` and 4 `sceneDirection` references. For each:
- Decision fixtures used for *replay* (`OrchestratorDecisionHistoryEntry`): drop `replyStyle`,
  replace `sceneDirection: "..."` with `directive: { intent: "spotlight", goal: "..." }`.
- Assertions on serialized replay args expecting `replyStyle`/`sceneDirection`/`repleyToMessageIndex`:
  update to the new minimal shape from Step 5.
- `generateWaifu` request fixtures with `replyStyle`: leave them (still a valid optional field
  until Task 6).

- [ ] **Step 7: Run the suite and typecheck**

Run: `npm run typecheck && npx vitest run tests/pipelines.test.ts tests/decisions.test.ts tests/runtime.test.ts`
Expected: typecheck PASS; pipelines + decisions PASS. runtime tests may fail where they assert
`sceneDirection` reached the waifu prompt — those flows now no-op until Task 4 wires directives
through the runtime. If runtime failures are exactly of that shape, mark this known and proceed
(Task 4 fixes them); any other runtime failure must be fixed now.

- [ ] **Step 8: Commit**

```bash
git add src/providers tests/pipelines.test.ts
git commit -m "feat: directive tool schema, sanitized replay, outcome results, gap/wake notes"
```

---

## Task 4: Runtime guardrails — budget, wake markers, backoff, directive rendering

**Files:**
- Modify: `src/orchestration/runtime.ts`
- Modify: `src/orchestration/promptBlocks.ts:183-187` (sceneDirection block render)
- Test: `tests/runtime.test.ts`, `tests/promptBlocks.test.ts`

- [ ] **Step 1: Write failing tests (append to `tests/runtime.test.ts`, using its existing fake-pipeline/temp-root harness)**

```ts
describe("directive guardrails", () => {
  it("honors the first directive and strips the next one inside the cooldown window", async () => {
    // Arrange two consecutive orchestrator decisions, each with a directive
    // {intent:"change_topic", goal:"talk about food"}. Default directiveCooldown=3.
    // Assert: decision 1's waifu generateWaifu call received a trailingSystemBlock containing
    // "director_note"; decision 2's did not, and history outcome for decision 2's responder
    // has directiveStripped === "cooldown".
  });

  it("strips an over-cap goal regardless of budget", async () => {
    // directive goal of 150 chars -> generateWaifu receives no director_note;
    // outcome.directiveStripped === "over_cap".
  });

  it("manual /run scene direction bypasses budget and cap", async () => {
    // handleRunCommand with sceneDirection "x".repeat(150) -> rendered to the waifu.
  });
});

describe("wake markers and backoff", () => {
  it("passes a wake marker to the orchestrator on a scheduled retrigger", async () => {
    // Record a completed no_reply decision {retriggerAfterSeconds: 600, wakePlan: "have yuki answer"}.
    // Trigger startChannelRun with trigger "retrigger". Assert the fake pipeline's
    // decideOrchestrator request had decisionMarkers[0].wakePlan === "have yuki answer".
  });

  it("enforces escalating backoff when a timer-fired pass chooses no_reply again", async () => {
    // Previous no_reply 600s; timer-fired run returns no_reply 600s again.
    // Assert scheduled retrigger is >= 900s (use the session file's scheduledRetriggerAt).
  });
});
```

Write these out fully against the existing helpers in `tests/runtime.test.ts` (it already has
fixtures that drive `RuntimeOrchestrator` with a fake Discord facade and `createPipeline` override
— mirror the nearest existing test for each).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/runtime.test.ts -t "directive guardrails"`
Expected: FAIL.

- [ ] **Step 3: Implement runtime changes in `src/orchestration/runtime.ts`**

(a) **Trigger plumbing.** Add to `ChannelRunOptions`:

```ts
  trigger?: "message" | "retrigger" | "manual";
```

Set it at the call sites: `handleDiscordMessage` → `{ trigger: "message" }`; the
`scheduleRetrigger` timer callback's `startChannelRunBackground(..., "scheduled-retrigger")` →
`{ trigger: "retrigger" }`; everywhere else defaults to `"manual"` (no change needed — treat
`undefined` as manual).

(b) **Directive state + guardrail.** Class fields and helper:

```ts
  private readonly directiveDecisionCounts = new Map<string, number>();
```

```ts
  private applyDirectiveGuardrails(input: {
    guildId: string;
    channelId: string;
    decision: OrchestratorDecision;
    directiveCooldown: number;
    loopSuspected: boolean;
  }): { decision: OrchestratorDecision; stripped: Array<{ index: number; reason: "cooldown" | "over_cap" }> } {
    const key = timerKey(input.guildId, input.channelId);
    const current = this.directiveDecisionCounts.get(key) ?? input.directiveCooldown;
    const budgetOpen = input.loopSuspected || current >= input.directiveCooldown;
    const stripped: Array<{ index: number; reason: "cooldown" | "over_cap" }> = [];
    let honored = false;
    const respondingWaifus = input.decision.respondingWaifus.map((responder, index) => {
      const directive = responder.directive;
      if (!directive) return responder;
      if (directive.intent === "manual") {
        honored = true;
        return responder;
      }
      if (directive.goal.length > DIRECTIVE_GOAL_MAX_CHARS) {
        stripped.push({ index, reason: "over_cap" });
        return { ...responder, directive: undefined };
      }
      if (!budgetOpen) {
        stripped.push({ index, reason: "cooldown" });
        return { ...responder, directive: undefined };
      }
      honored = true;
      return responder;
    });
    this.directiveDecisionCounts.set(key, honored ? 0 : Math.min(current + 1, 1000));
    return { decision: { ...input.decision, respondingWaifus }, stripped };
  }
```

Import `DIRECTIVE_GOAL_MAX_CHARS` (and `Directive`) from `./decisions.js`.

(c) **Loop detector + budget in `runChannelLoop`.** After `messages` are fetched and before
`pipeline.decideOrchestrator`:

```ts
      const loop = assessLoop(messages);
      const channelKey = timerKey(guildId, channelId);
      const directiveCount = this.directiveDecisionCounts.get(channelKey) ?? orchestrator.directiveCooldown;
      const directiveBudgetOpen = loop.suspected || directiveCount >= orchestrator.directiveCooldown;
```

Pass `directiveBudgetOpen` on the `decideOrchestrator` request, and `loop.notice` into
`buildOrchestratorTrailingPrompt` (see Task 5 signature — for this task add the parameter and
append `<runtime_notice>${notice}</runtime_notice>` to the trailing prompt when set; the prompt
content rewrite lands in Task 5). Import `assessLoop` from `./loopDetector.js`.

After the decision returns and `capDecisionDelays` runs:

```ts
      const guarded = this.applyDirectiveGuardrails({
        guildId,
        channelId,
        decision,
        directiveCooldown: orchestrator.directiveCooldown,
        loopSuspected: loop.suspected
      });
      decision = guarded.decision;
```

Record history with the **original** decision (so the dashboard shows what the model wanted), then
after `recordOrchestratorDecision` mark stripped outcomes:

```ts
      for (const strippedEntry of guarded.stripped) {
        const outcome = responderOutcomes[strippedEntry.index];
        if (outcome) {
          await this.updateOrchestratorResponderOutcome(decisionId, outcome.id, {
            directiveStripped: strippedEntry.reason
          });
        }
      }
```

Order note: call `applyDirectiveGuardrails` BEFORE `recordOrchestratorDecision` but pass the
original `decision` to `recordOrchestratorDecision` and the guarded one to
`executeResponderDecision`. Extend `updateOrchestratorResponderOutcome`'s patch type with
`directiveStripped`.

(d) **wakePlan persisted.** `appendOrchestratorHistory` entry + `recordOrchestratorDecision` input
gain `wakePlan: input.decision.wakePlan` (entry field added in Task 2).

(e) **Wake marker + backoff.** In `runChannelLoop`, `pastDecisions` is already loaded. Before the
decide call, when this is the first turn of a timer-fired run:

```ts
      let decisionMarkers: OrchestratorWakeMarker[] | undefined;
      const lastNoReply = pastDecisions.find((entry) => entry.action === "no_reply");
      if (turns === 1 && options.trigger === "retrigger" && lastNoReply?.retriggerAfterSeconds) {
        decisionMarkers = [{
          kind: "wake",
          timestamp: formatTimestamp(new Date()),
          scheduledSeconds: lastNoReply.retriggerAfterSeconds,
          wakePlan: lastNoReply.wakePlan
        }];
      }
```

(History file prepends new entries, so `.find` returns the latest no_reply.) Pass
`decisionMarkers` on the request. In the `no_reply` branch:

```ts
      if (decision.action === "no_reply") {
        let seconds = decision.retriggerAfterSeconds ?? RETRIGGER_MIN_SECONDS;
        if (turns === 1 && options.trigger === "retrigger" && lastNoReply?.retriggerAfterSeconds) {
          seconds = Math.max(seconds, Math.ceil(lastNoReply.retriggerAfterSeconds * 1.5));
        }
        await this.scheduleRetrigger(guildId, channelId, seconds);
        return;
      }
```

(f) **Directive rendering to the waifu.** Add:

```ts
function directiveTextForWaifu(directive: Directive | undefined): string | undefined {
  if (!directive) return undefined;
  if (directive.intent === "manual") return directive.goal;
  return `(${directive.intent.replace(/_/g, " ")}) ${directive.goal}`;
}
```

In `executeResponderDecision`: replace `const clippedSceneDirection = sceneDirectionForWaifu(...)`
with `const directiveText = directiveTextForWaifu(responder.directive);` and pass
`sceneDirection: directiveText` to `buildWaifuPromptParts`. Delete `sceneDirectionForWaifu`,
`clipSceneDirectionForWaifu`, `sceneDirectionClippingEnabled`, the
`sceneDirectionClippingEnabled` field of `ExecuteResponderDecisionInput`, and its two call-site
arguments.

(g) **/run manual directives.** In `handleRunCommand` (initialResponders) and
`applyFirstResponderSceneDirectionOverride`: build
`directive: { intent: "manual", goal: event.sceneDirection }` (when set) instead of
`sceneDirection`. Rename the helper to `applyFirstResponderDirectiveOverride`. Drop the
`replyStyle: "normal"` fields here and at the PickNextWaifu handoff (line ~1479) — the schema
defaults them now.

(h) **Debug log.** `formatOrchestratorDebugLog`: replace the sceneDirection display with
`directive` (`- ${name}: (${intent}) ${goal}`), add a `Wake plan:` line for no_reply decisions.

- [ ] **Step 4: Update the director-note block in `src/orchestration/promptBlocks.ts`**

```ts
  {
    id: "sceneDirection",
    defaultSection: "trailing",
    render: (ctx) =>
      ctx.sceneDirection
        ? `<director_note>\nDirector's goal for this one message: ${ctx.sceneDirection}\nPursue it in your own voice and words; never quote or restate this note.\n</director_note>`
        : undefined
  }
```

Update the matching expectation in `tests/promptBlocks.test.ts`.

- [ ] **Step 5: Update existing runtime tests**

`tests/runtime.test.ts` (35 `sceneDirection` refs): decision fixtures
`sceneDirection: "..."` → `directive: { intent: "spotlight", goal: "..." }` (use
`intent: "manual"` for the `/run` override tests at ~953/1206 since those flow through the manual
path). Delete the test `"clips sceneDirection before sending it to the waifu model"` (~line 420) —
clipping no longer exists. Assertions that the waifu prompt contains direction text now expect the
`director_note` rendering from Step 4. Leave `replyStyle` fixture fields in place (Task 6 removes
them).

- [ ] **Step 6: Run suite + typecheck**

Run: `npm run typecheck && npx vitest run tests/runtime.test.ts tests/promptBlocks.test.ts`
Expected: PASS, including Step 1's new tests.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration tests
git commit -m "feat: directive budget, wake markers, retrigger backoff, director-note rendering"
```

---

## Task 5: Prompt rewrite + legacy removal

**Files:**
- Modify: `src/orchestration/runtime.ts` (`buildOrchestratorSystemPrompt`, `buildOrchestratorTrailingPrompt`, `DEFAULT_ORCHESTRATOR_PROMPT`, delete `buildLegacyOrchestratorPrompt` + `formatWaifuAvailabilityForOrchestratorPrompt`)
- Modify: `src/shared/schemas/domain.ts` (`AgentConfigSchema`: delete `useLegacyPrompt`, `clipSceneDirection`)
- Test: `tests/runtime.test.ts`, `tests/api.test.ts:300-306`

- [ ] **Step 1: Replace `DEFAULT_ORCHESTRATOR_PROMPT` (~line 4114)**

```ts
const DEFAULT_ORCHESTRATOR_PROMPT = [
  "You watch one Discord channel and direct a small cast of waifu personas. Each pass, decide who (if anyone) speaks next. You choose speakers and timing; each waifu writes her own words — never write or paraphrase a reply for her.",
  "",
  "Most of the time the right answer is one waifu, or nobody. Pick the persona whose voice fits the moment. Two waifus only when the second has a clearly distinct reaction of her own; three or more only for rare pile-on moments. You are consulted again after each reply lands, so plan one beat, not a scene.",
  "",
  "no_reply is a normal, frequent choice. Real group chats are mostly silence. If the beat has landed, or another bot message would add noise, choose no_reply.",
  "",
  "The cast has its own life. When humans are active, weave them in; when they are not, the waifus pursue their own threads — do not keep steering them back to absent users.",
  "",
  "directive is a short GOAL for one waifu's next message, never content or wording. Default is null; her persona handles normal flow. The runtime rate-limits directives — they are for steering moments: breaking a loop, landing a new named topic, pulling a named quiet person back in, closing a beat. When a runtime notice says a loop is forming, that is the moment to use one.",
  "",
  `delaySeconds is a realistic reading/typing delay (0–${MAX_WAIFU_DELAY_SECONDS}); it defaults to 0.`,
  "",
  "Watch the recent speaker pattern. If the same waifu or the same pair has carried several beats, switch speakers, go quiet, or pivot with a directive — do not let two waifus volley restatements of the same mood."
].join("\n");
```

- [ ] **Step 2: Rewrite `buildOrchestratorSystemPrompt`**

Delete the `useLegacyPrompt` branch, the dead `activeWaifusContent` computation, and the old
`hardRules`/`loopBreaking`/`retriggerPacing`/`toolUse` section strings. New body:

```ts
  private buildOrchestratorSystemPrompt(
    orchestrator: AgentConfig,
    server: ServerConfig,
    replyRequired = false
  ): string {
    const identity = replyRequired
      ? "You are the director of a multi-character Discord bot. This manual /run requires you to choose at least one waifu to reply now."
      : "You are the director of a multi-character Discord bot. On each pass you decide who (if anyone) speaks next and how the room is paced.";

    const rules = [
      "- Every respondingWaifus[].waifuId must be copied verbatim from the IDs in <active_waifus>.",
      replyRequired
        ? "- action must be \"reply\" for this manual /run, with at least one responding waifu and retriggerAfterSeconds null."
        : "- action \"reply\": respondingWaifus non-empty, retriggerAfterSeconds and wakePlan null. action \"no_reply\": respondingWaifus empty, retriggerAfterSeconds and wakePlan set.",
      "- Runtime pacing: when a human spoke within the last four chat messages, the first waifu starts immediately and later delays count from this decision; otherwise each delay counts after the previous waifu finishes. Any new chat message cancels the remaining chain.",
      "- Your own past orchestrator_decision tool calls appear in the conversation with their real outcomes; nobody else sees them. Lines like [12m pass] and [wake: ...] are runtime annotations, not chat messages.",
      "- Availability lines in <active_waifus> are soft signals, not rules — a sleeping waifu can still answer when the moment justifies it."
    ].join("\n");

    const messageStructure = [
      "Each Discord message is its own user turn: an optional `replying to > Author: preview` line, then `DisplayName: <body>`, optionally followed by `[attachments: Nx image]` and `[image_text: ...]` lines."
    ].join("\n");

    return [
      `<orchestrator_identity>\n${identity}\n</orchestrator_identity>`,
      `<orchestrator_rules>\n${rules}\n</orchestrator_rules>`,
      orchestrator.promptSections.messageStructure
        ? `<chat_message_structure>\n${messageStructure}\n</chat_message_structure>`
        : null,
      `<discord_server_information>\n${server.name ?? server.guildId}\n</discord_server_information>`
    ].filter(Boolean).join("\n");
  }
```

Note the signature loses `availableWaifus` (it was only feeding the dead computation) — update the
call site.

- [ ] **Step 3: Rewrite `buildOrchestratorTrailingPrompt` with casting cards + pause planning + notices**

```ts
  private buildOrchestratorTrailingPrompt(
    orchestrator: AgentConfig,
    availableWaifus: WaifuConfig[],
    replyRequired = false,
    loopNotice?: string
  ): string {
    const now = new Date();
    const activeWaifusContent = availableWaifus.length
      ? availableWaifus.map((waifu) => castingCard(waifu, now)).join("\n")
      : "No waifus are currently enabled for this channel.";

    const pausePlanning = [
      "When you choose no_reply, retriggerAfterSeconds is a planned pause before YOU re-check the room — any new human message wakes you regardless, so long pauses cost nothing. wakePlan is one sentence on what you intend at wake; the runtime shows it back to you when the timer fires. Use the whole range: 100–300s when you expect a beat to need a nudge soon; 600–1800s for a cooling room with a planned revival; 3600s+ when you are mostly waiting for humans. Repeated quiet checks must back off to longer pauses."
    ].join("\n");

    const task = replyRequired
      ? `${DEFAULT_ORCHESTRATOR_PROMPT}\n\n${manualRunReplyRequiredInstruction()}`
      : DEFAULT_ORCHESTRATOR_PROMPT;

    return [
      `<task_instructions>\n${task}\n</task_instructions>`,
      orchestrator.promptSections.pausePlanning && !replyRequired
        ? `<pause_planning>\n${pausePlanning}\n</pause_planning>`
        : null,
      `<active_waifus>\n${activeWaifusContent}\n</active_waifus>`,
      `<current_time>\n${formatPromptCurrentHour(new Date())}\n</current_time>`,
      loopNotice ? `<runtime_notice>\n${loopNotice}\n</runtime_notice>` : null
    ].filter(Boolean).join("\n");
  }
```

Casting card helpers (module level; W2 swaps the persona preview for the generated digest):

```ts
function castingCard(waifu: WaifuConfig, now: Date): string {
  const tagName = promptTagName(waifu.name || waifu.id);
  const displayName = waifu.displayName || waifu.name;
  const preview = waifu.persona.trim().replace(/\s+/g, " ").slice(0, 200);
  return [
    `<${tagName}>`,
    `ID: ${waifu.id} · ${displayName}`,
    `About: ${preview || "(no persona configured)"}`,
    `Now: ${castingAvailabilityLine(waifu, now)}`,
    `</${tagName}>`
  ].join("\n");
}

function castingAvailabilityLine(waifu: WaifuConfig, now: Date): string {
  const minutes = localTimeOfDayMinutes(now);
  const parts: string[] = [];
  const sleep = waifu.availability.sleep;
  if (sleep.enabled && dailyIntervalContains(minutes, sleep)) {
    parts.push(`likely asleep (sleep ${sleep.start}–${sleep.end})`);
  } else {
    parts.push("awake");
  }
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(minutes, interval)) {
      parts.push(`busy: ${interval.reason}`);
    }
  }
  return parts.join(" · ");
}
```

Update the call in `runChannelLoop` to pass `loop.notice` (replacing Task 4's interim append).
Delete `buildLegacyOrchestratorPrompt` and `formatWaifuAvailabilityForOrchestratorPrompt`.

- [ ] **Step 4: Remove the legacy/clip config fields**

In `src/shared/schemas/domain.ts` `AgentConfigSchema`: delete the `useLegacyPrompt` and
`clipSceneDirection` lines (old stored configs parse fine — unknown keys are stripped). Grep for
remaining references and delete their code paths:

Run: `grep -rn "useLegacyPrompt\|clipSceneDirection" src/ tests/`
Expected after cleanup: zero hits outside `src/frontend/` (frontend is Task 7).

In `tests/api.test.ts:295-306`, replace the `clipSceneDirection: true` round-trip with
`directiveCooldown: 5` and assert `config.json().directiveCooldown` is `5`.

Also bump the orchestrator's default context window (design §4): both
`readAgentConfig("orchestrator", 20)` call sites in `runtime.ts` (~lines 909, 960) become
`readAgentConfig("orchestrator", 40)`. Stored configs keep their persisted value — this only
affects fresh installs; the live server should be bumped via the dashboard after deploy.

- [ ] **Step 5: Update runtime tests for prompt content**

Any `tests/runtime.test.ts` assertions matching old prompt strings (grep for `loop_breaking`,
`retrigger_pacing`, `task_instructions`, `active_waifus`, `Persona:`) update to the new blocks:
casting cards contain `About:` and `Now:`, trailing prompt contains `<pause_planning>` by default.
Add one new test: a waifu with persona > 200 chars yields a casting card with no more than 200
persona chars and the orchestrator system prompt does NOT contain the raw persona.

- [ ] **Step 6: Run suite + typecheck**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "feat: rewrite orchestrator prompts (casting cards, pause planning, state-once rules)"
```

---

## Task 6: Remove replyStyle everywhere

**Files:**
- Modify: `src/orchestration/decisions.ts`, `src/shared/schemas/domain.ts`, `src/providers/types.ts`, `src/providers/pipelines.ts`, `src/orchestration/runtime.ts`
- Test: `tests/runtime.test.ts`, `tests/pipelines.test.ts`

- [ ] **Step 1: Delete schema fields and types**

- `decisions.ts`: delete `REPLY_STYLE_VALUES`, `ReplyStyle`, `ReplyStyleSchema`, and the
  `replyStyle` field on `RespondingWaifuSchema`.
- `domain.ts`: delete `OrchestratorReplyStyleSchema`/`OrchestratorReplyStyle` and the `replyStyle`
  field on `OrchestratorRespondingWaifuSchema`. Also delete the now-dead `sceneDirection` field
  there (runtime writes `directive` since Task 4).
- `providers/types.ts`: delete `replyStyle?: ReplyStyle;` from `WaifuGenerationRequest` and the
  `ReplyStyle` import.

- [ ] **Step 2: Delete pipeline plumbing**

In `pipelines.ts` delete: `replyStyleHint`, `replyStyleMessagesForChat`,
`replyStyleMessagesForAnthropic`, the Google `replyHint` lines (~526, 531), and every
`...replyStyleMessagesFor*(request.replyStyle)` spread in the four `generateWaifu` bodies
(lines ~90, ~248, ~393). Remove the `REPLY_STYLE_VALUES`/`ReplyStyle` imports.

- [ ] **Step 3: Delete runtime references**

`runtime.ts`: remove `replyStyle: responder.replyStyle` from the generate call (~1300) and the log
context (~1243). Confirm the `/run` and handoff sites were already cleaned in Task 4 (g).

Run: `grep -rn "replyStyle" src/`
Expected: zero hits outside `src/frontend/` (Task 7).

- [ ] **Step 4: Clean the test fixtures**

```bash
sed -i '' -E 's/replyStyle: "(normal|short|long|sleepy)",[[:space:]]*//g' tests/runtime.test.ts tests/pipelines.test.ts
```

Then fix the survivors by hand: `grep -n "replyStyle" tests/` — assertions like
`expect(request.replyStyle).toBe("normal")` (runtime.test.ts ~797) are deleted; fixtures where
`replyStyle` was the trailing property (no comma after) need manual removal.

- [ ] **Step 5: Run suite + typecheck**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "feat: remove replyStyle — length is governed by the waifu harness"
```

---

## Task 7: Frontend — OrchestratorView + type mirrors

**Files:**
- Modify: `src/frontend/api/types.ts:108-118` (agent config), `:166-176` (responder/history types)
- Modify: `src/frontend/views/OrchestratorView.tsx`

The frontend mirrors `domain.ts` manually (no codegen). Read the whole view first; follow its
existing input/toggle component patterns.

- [ ] **Step 1: Update `src/frontend/api/types.ts`**

- Agent config type: delete `useLegacyPrompt: boolean;` and `clipSceneDirection: boolean;`; add
  `directiveCooldown: number;`. `OrchestratorPromptSections` becomes
  `{ pausePlanning: boolean; messageStructure: boolean }`.
- Responder type (~166-176): delete `replyStyle` and `sceneDirection`; add
  `directive?: { intent: string; goal?: string };`.
- History entry type: add `wakePlan?: string;`; outcome type: add
  `directiveStripped?: "cooldown" | "over_cap";`.

- [ ] **Step 2: Update `OrchestratorView.tsx`**

- Delete the `useLegacyPrompt` and `clipSceneDirection` state, load/save wiring (~47-48, 62-64,
  91-93), and their toggle JSX (~308-316).
- `SECTION_OPTIONS` (~25-26) becomes:

```ts
const SECTION_OPTIONS: Array<{ key: keyof OrchestratorPromptSections; label: string }> = [
  { key: "pausePlanning", label: "<pause_planning>" },
  { key: "messageStructure", label: "<chat_message_structure>" }
];
```

  and the `promptSections` initial state matches the two new keys.
- Add a `directiveCooldown` number input next to the context-window input (same component pattern),
  min 0 max 20, saved with the config payload.
- Decision-history local type (~357-362): swap `replyStyle`/`sceneDirection` for
  `directive: { intent: string; goal?: string } | null` and render directives in the history list
  as `(${intent}) ${goal}`; show a `wake plan: …` line on no_reply entries; show a small
  `directive stripped (${reason})` tag on outcomes that carry `directiveStripped`.
- Update the explanatory `<pre>` block (~368-369) to the new tool shape (action, respondingWaifus
  [waifuId, delaySeconds, directive], retriggerAfterSeconds, wakePlan, reasoning).

- [ ] **Step 3: Typecheck + spot-check the dashboard**

Run: `npm run typecheck`
Expected: PASS (both backend and frontend configs).

Optional manual check: `npm run dev:frontend` + `npm run waifus -- dev`, open the Orchestrator
view, confirm config saves and history renders.

- [ ] **Step 4: Commit**

```bash
git add src/frontend
git commit -m "feat: orchestrator dashboard — directives, wake plans, cooldown setting"
```

---

## Task 8: Full verification + coordination bookkeeping

**Files:**
- Modify: `MIGRATION_PLAN.md` (§10 status log)
- Modify: `docs/superpowers/plans/2026-06-11-prompting-overhaul/00-overview.md` (phase table, optional)

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run test && npm run build:backend`
Expected: all PASS. Also `grep -rn "sceneDirection\|replyStyle\|useLegacyPrompt\|clipSceneDirection" src/ | grep -v frontend` — expected: only the `promptBlocks.ts` block id `"sceneDirection"` (kept until W2's registry rename) and the `ctx.sceneDirection` field it renders.

- [ ] **Step 2: Update MIGRATION_PLAN.md §10**

Replace the `- _none landed yet — plan committed 2026-06-11_` line with:

```md
- W1 (orchestrator: typed directives + guardrails, wake plans, loop detector, sanitized replay,
  outcome results, prompt rewrite, replyStyle removed, legacy prompt removed) — landed <commit hash>.
```

- [ ] **Step 3: Commit**

```bash
git add MIGRATION_PLAN.md docs
git commit -m "docs: record W1 orchestrator overhaul in migration plan status log"
```

---

## Post-W1 manual validation (live server, not part of the automated plan)

1. Deploy to the server Mac (`Beta`), restart, watch a busy channel.
2. After ~50 decisions, pull `~/.dc-waifus/user/orchestrator/history.json` and recompute the Task-0
   baselines: directive rate (target trending toward ≤ 25%), responder-count distribution (mode 1),
   retrigger spread, wake-plan presence.
3. If directive rate is still high, raise `directiveCooldown` in the dashboard — the guardrail
   makes the ceiling deterministic regardless of model behavior.
