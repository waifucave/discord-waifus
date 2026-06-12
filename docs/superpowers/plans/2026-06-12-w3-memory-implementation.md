# W3 — Memory v2 + Behavior Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Execute in a fresh worktree (EnterWorktree) — **VERIFY the worktree's base commit contains this plan file before dispatching any task** (a prior phase silently branched from origin/main and lost the plan docs; if the file is missing, abort and re-create the worktree from local HEAD).

**Goal:** Replace the inject-everything three-tier memory system with one unified store + per-turn relevance retrieval + a nightly "dream" consolidation pass, and land a small behavior-tuning task (length register, topic seeding) motivated by live findings.

**Architecture:** Task 0 is prompt-text tuning (independent, ships first). Tasks 1–4 build memory v2 bottom-up: schema+migration (1), retrieval (2), write paths (3), dream pass (4) — each lands green. Task 5 is the dashboard, Task 6 the acceptance gate. The dream pass replaces the librarian; the observer survives with a lean input format and an entities field.

**Tech Stack:** TypeScript ESM (NodeNext — `.js` imports), zod v4, Vitest (real temp data roots via `tests/testUtils.ts`), React 19 manual type mirrors. Two-space indent, double quotes, semicolons.

**Design doc:** `docs/superpowers/plans/2026-06-11-prompting-overhaul/03-memory.md` (authoritative for §1 record schema, §3 scoring, §5 dream ops). Live evidence driving Task 0 and the design: 84/162 active memories mention user K and ALL inject every turn; reply length medians doubled at the W2 boundary; `change_topic` directives used ~once per 40 decisions.

**Migration note (deviation from design §1):** `CURRENT_SCHEMA_VERSION` stays 1 — it is a global `z.literal` shared by every stored file, so bumping it would invalidate all user data at once. W3 migrates `memories.json` by **shape detection** in `runMigrations` (the same pattern the W1/W2 layout/promptSections migrations used). The gateway-migration P4 owns any future version bump.

---

## Task 0: Behavior tuning — length register + topic seeding

**Files:**
- Modify: `src/orchestration/promptBlocks.ts` (OUTPUT_CONTRACT line 2; anchor reminder)
- Modify: `src/orchestration/runtime.ts` (DEFAULT_ORCHESTRATOR_PROMPT directive + cast-autonomy paragraphs; pause_planning text)
- Test: `tests/promptBlocks.test.ts`, `tests/runtime.test.ts` (re-pin changed strings)

- [ ] **Step 1: Harden the length register in `OUTPUT_CONTRACT` (promptBlocks.ts)**

Replace line 2 of the contract (the array element starting `"2. This is a fast, casual chat..."`) with:

```ts
  "2. This is a fast, casual group chat: most of your messages are a short fragment — a quip, a reaction, half a sentence. One full sentence is already on the long side. Two or three short sentences are for rare storytime moments; anything longer never happens.",
```

In the `anchor` block render, change the reminder line from
`Reminders: one short chat message, only your own voice, no narration, no meta.` to
`Reminders: one short, fragment-y chat message, only your own voice, no narration, no meta.`

- [ ] **Step 2: Topic seeding + cast autonomy in the orchestrator prompt (runtime.ts)**

In `DEFAULT_ORCHESTRATOR_PROMPT`:

(a) Replace the cast-autonomy paragraph (`"The cast has its own life. ..."`) with:

```ts
  "The cast has its own life. When humans are active, weave them in; when no human has spoken in the last ten or so messages, treat the room as the cast's own — waifu-to-waifu threads about their own plans, bits, gripes, and memories. Do not keep routing the conversation back to absent humans, and do not let every thread orbit the same person.",
```

(b) Replace the directive paragraph (`"directive is a short GOAL ..."`) with:

```ts
  "directive is a short GOAL for one waifu's next message, never content or wording. Default is null; her persona handles normal flow. But an unused directive budget helps nobody: when the chat keeps orbiting one person or one topic, spend it — change_topic with a NAMED topic is the strongest move you have. When a runtime notice says a loop is forming, that is the moment. When your own wakePlan said you would pivot, execute it with a change_topic directive rather than hoping a waifu pivots on her own.",
```

(c) In `buildOrchestratorTrailingPrompt`, extend the `pausePlanning` text: after `"...the runtime shows it back to you when the timer fires."` insert
`" A pivot plan should name the new topic, and when the wake comes you execute it with a change_topic directive — a plan without a directive usually dissolves into the old topic."`

- [ ] **Step 3: Re-pin tests + gate + commit**

Grep tests for the replaced fragments (`"fast, casual chat"`, `"The cast has its own life"`, `"rate-limits directives"`, `"one short chat message"`) and update pinned assertions to the new texts. The word-budget tests must still pass.

Run: `npm run typecheck && npm run test`
```bash
git add src tests && git commit -m "feat: harden length register, seed topics through directives and wake plans"
```

---

## Task 1: Unified memory record — schema + migration (+ all consumers compiling)

**Files:**
- Modify: `src/shared/schemas/domain.ts` (MemoryRecordSchema replaces WaifuMemorySchema; delete ShortTermMemory*; PendingObservationsFileSchema; server `memoryInjectionLimit`)
- Modify: `src/backend/migrations.ts` (shape migration)
- Modify: `src/orchestration/runtime.ts` (every read/write of the two old stores — keep inject-all behavior this task)
- Modify: `src/api/server.ts` (memories CRUD routes)
- Modify: `src/frontend/api/types.ts` (mirror only — view itself is Task 5)
- Test: `tests/migrations.test.ts`, `tests/api.test.ts`, `tests/runtime.test.ts`

- [ ] **Step 1: New schema in `domain.ts`** (replaces `WaifuMemorySchema`/`MemoryImportance…`; design §1 verbatim plus the migration deviation):

```ts
export const MEMORY_KINDS = ["fact", "preference", "relationship", "event", "commitment", "context"] as const;
export const MemoryKindSchema = z.enum(MEMORY_KINDS);

export const MEMORY_SOURCES = ["waifu_tool", "stage_manager", "dream", "user"] as const;

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().optional(),   // origin channel; retrieval boost, NOT a visibility filter
  waifuId: z.string().min(1),
  content: z.string().min(1),
  kind: MemoryKindSchema.default("fact"),
  source: z.enum(MEMORY_SOURCES).default("stage_manager"),
  pinned: z.boolean().default(false), // user-managed; never auto-edited, always injected
  strength: z.number().min(0).max(5).default(3),
  entities: z.array(z.string()).default([]),
  expiresAt: IsoDateStringSchema.optional(), // hard TTL (waifu notes); absent = durable
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  lastRetrievedAt: IsoDateStringSchema.optional(),
  status: z.enum(["active", "archived"]).default("active")
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryStoreSchema = RevisionedRecordSchema.extend({
  memories: z.array(MemoryRecordSchema)
});

export const PendingObservationSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  waifuId: z.string().min(1),
  content: z.string().min(1),
  kind: MemoryKindSchema,
  importance: z.number().int().min(1).max(5),
  entities: z.array(z.string()).default([]),
  createdAt: IsoDateStringSchema
});
export const PendingObservationsFileSchema = RevisionedRecordSchema.extend({
  observations: z.array(PendingObservationSchema)
});
```

Delete `ShortTermMemorySchema`/`ShortTermMemoryStoreSchema` and the old `WaifuMemory` fields (`importance`, `permanent`, `scope`, `sourceMessageIds`). Keep the export name `WaifuMemory` as a deprecated alias ONLY if grep shows >10 call sites; otherwise rename to `MemoryRecord` everywhere. `ServerConfigSchema` gains `memoryInjectionLimit: z.number().int().min(1).max(50).default(12)` next to `contextWindows`.

- [ ] **Step 2: Shape migration in `migrations.ts`** — new step `migrateMemoryStoreV2`:

Detect old shape (`memories[0]` has `importance` or `permanent` key, or `user/short-term-memories.json` exists). Transform each long-term record: `strength = importance`, `pinned = permanent`, `source = permanent ? "user" : "stage_manager"`, `kind` kept if present else "fact", `entities = extractEntities(content)`, drop `scope`/`sourceMessageIds`/`importance`/`permanent`. Each short-term entry → `{ source: "waifu_tool", kind: "context", strength: 2, entities: extractEntities(content), expiresAt: entry.expiresAt, channelId: entry.channelId, ... }` appended to the same store. Delete `user/short-term-memories.json` after merge (use `rm` via `fs/promises` `unlink`, tolerate ENOENT).

```ts
// Capitalized-token heuristic: words starting uppercase that are not sentence-initial,
// plus sentence-initial tokens repeated elsewhere in the store run. Cheap, good enough
// for retrieval boosting; the dream pass refines entities over time.
export function extractEntities(content: string): string[] {
  const tokens = content.match(/\b\p{Lu}[\p{L}\p{N}'-]*\b/gu) ?? [];
  const sentenceInitial = new Set<string>();
  for (const match of content.matchAll(/(?:^|[.!?]\s+)(\p{Lu}[\p{L}\p{N}'-]*)/gu)) {
    sentenceInitial.add(match[1]);
  }
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (sentenceInitial.has(token) && tokens.filter((t) => t === token).length < 2) continue;
    entities.push(token);
  }
  return entities.slice(0, 8);
}
```

(Export `extractEntities` from `migrations.ts` or a small shared module — Task 3's write paths reuse it; prefer `src/orchestration/memoryEntities.ts` so orchestration doesn't import from backend.)

Migration tests (real temp roots): seed the CURRENT live shapes (copy field sets from this plan's "old shape" description), run `runMigrations`, assert: strength/pinned/source mapping, short-term merged with expiresAt intact, old file deleted, idempotent on second run, new-shape store untouched.

- [ ] **Step 3: Sweep consumers to compile with inject-all behavior preserved**

`runtime.ts`: `readMemoryStore` (same path/new schema); DELETE `readShortTermMemoryStore`, `emptyShortTermMemoryStore`, `SHORT_TERM_MEMORY_LIFESPAN_MS` consumers — `recordShortTermMemoryEntries` becomes `recordWaifuNotes` writing `MemoryRecord`s (source waifu_tool, kind context, strength 2, `expiresAt = now + NOTE_LIFESPAN_MS` where `const NOTE_LIFESPAN_MS = 72 * 60 * 60 * 1000;`, entities via `extractEntities`, channelId set) into `user/memories.json` with the same per-scope dedupe (normalizeShortTermContent stays, renamed `normalizeNoteContent`). `buildWaifuPromptParts` memory lines: THIS TASK keeps inject-all but reads from the unified store: active + unexpired + guild + waifu match → pinned first, then the rest (Task 2 replaces this with retrieval). `modelVisibleMemoryBlockForPrint` same treatment. `stageManagerMemories`/`applyStageManagerCalls`: update field names minimally (`importance`→`strength`, drop permanent guards→`pinned` guards) so the EXISTING observer→librarian flow keeps working until Task 4 replaces it; the librarian tool schema's `importance` argument maps onto `strength` at apply time.
`pipelines.ts`: in `SHORT_TERM_MEMORY_TOOL_DESCRIPTION`, change "Entries expire after 24 hours." to
"Notes expire after about three days unless the nightly process promotes them." (the note lifespan
is now 72h) — update the pinned test assertion if one matches the old sentence.
`api/server.ts` memories routes: POST creates `{ pinned: true, source: "user", strength: body.strength ?? 5, kind: body.kind ?? "fact", entities: extractEntities(content) }` (user-created = pinned per design); PUT/DELETE operate on the new fields; request body schemas updated.
`frontend/api/types.ts`: mirror `MemoryRecord` (the view still compiles against its own old usage? NO — the view uses `memory.importance`/`permanent` heavily; to keep typecheck green WITHOUT doing Task 5 now, mirror the new type AND do the minimal mechanical rename in `MemoriesView.tsx` (importance→strength, permanent→pinned, labels untouched otherwise). Full UX update is Task 5.)

- [ ] **Step 4: Gate + commit**

`npm run typecheck && npm run test` — green, with runtime tests' memory fixtures updated to the new field names.

```bash
git add src tests && git commit -m "feat: unified memory record store with shape migration (inject-all preserved)"
```

---

## Task 2: Per-turn retrieval

**Files:**
- Create: `src/orchestration/memoryRetrieval.ts`
- Modify: `src/orchestration/runtime.ts` (`buildWaifuPromptParts` swap; lastRetrievedAt stamping)
- Test: `tests/memoryRetrieval.test.ts` (new), `tests/runtime.test.ts`

- [ ] **Step 1: Failing tests for scoring + selection** (`tests/memoryRetrieval.test.ts`)

Cover: (a) lexical overlap ranks a snowstorm memory above a tacos memory when the window discusses snow; (b) pinned records always selected and NOT counted against the limit; (c) `channelMatch` boosts same-channel notes; (d) fresh waifu_tool notes (<48h) get the freshNote boost; (e) expired/archived/foreign-guild/foreign-waifu records excluded; (f) selection caps at `limit` scored records; (g) rendering: kind labels `- (fact) ...`, notes get relative age `- (note, 2h ago) ...`, ordering pinned→durable→notes each oldest→newest; (h) cross-channel continuity: a fresh note created in channel A is selected when retrieving for channel B of the same guild (guild-visible, channel only boosts). Write them fully with literal `MemoryRecord` fixtures.

- [ ] **Step 2: Implement `memoryRetrieval.ts`** (design §3 formula):

```ts
import { MemoryRecord } from "../shared/schemas/domain.js";
import { ContextMessage } from "./context.js";

export type RetrievalInput = {
  records: MemoryRecord[];          // pre-filtered: guild+waifu+active; this module re-checks expiry
  window: ContextMessage[];         // recent context (last ~12 used)
  channelId: string;
  now: Date;
  limit: number;                    // scored-record cap; pinned are extra
};

export type RetrievalResult = {
  selected: MemoryRecord[];         // pinned first, then top-scored
  lines: string[];                  // rendered for the prompt block
};

const WINDOW_MESSAGES = 12;
const RECENCY_HALF_LIFE_DAYS = 7;
const FRESH_NOTE_HOURS = 48;

const STOPWORDS = new Set([/* copy the loopDetector.ts stopword list verbatim */]);

function tokenSet(text: string): Set<string> { /* copy loopDetector.ts tokenSet verbatim */ }

function overlap(memoryTokens: Set<string>, windowTokens: Set<string>): number {
  if (memoryTokens.size === 0 || windowTokens.size === 0) return 0;
  let hits = 0;
  for (const token of memoryTokens) if (windowTokens.has(token)) hits += 1;
  return hits / memoryTokens.size;  // fraction of the memory grounded in the window
}

export function scoreMemory(record: MemoryRecord, windowTokens: Set<string>, channelId: string, now: Date): number {
  const memoryTokens = tokenSet(`${record.content} ${record.entities.join(" ")}`);
  const lexical = overlap(memoryTokens, windowTokens);
  const ageDays = Math.max(0, (now.getTime() - Date.parse(record.updatedAt)) / 86_400_000);
  const recency = Math.exp(-Math.LN2 * (ageDays / RECENCY_HALF_LIFE_DAYS));
  const channelMatch = record.channelId === channelId ? 1 : 0;
  const freshNote =
    record.source === "waifu_tool" &&
    now.getTime() - Date.parse(record.createdAt) < FRESH_NOTE_HOURS * 3_600_000
      ? 1
      : 0;
  return 2.0 * lexical + 1.0 * recency + 0.6 * (record.strength / 5) + 0.4 * channelMatch + 0.4 * freshNote;
}

export function retrieveMemories(input: RetrievalInput): RetrievalResult { /* filter expiry; split pinned;
  score the rest against tokenSet of the last WINDOW_MESSAGES contents joined; sort desc, take limit;
  order pinned→durable→notes (source waifu_tool with expiresAt = note), each oldest→newest by createdAt;
  render lines per design: `- (${kind}) ${content}` and notes `- (note, ${relativeAge(...)}) ${content}` */ }

export function relativeAge(from: string, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
```

Write `retrieveMemories` out fully (the comment block above states the exact contract the tests pin).

- [ ] **Step 3: Wire into `buildWaifuPromptParts`** — replace the Task-1 inject-all lines with `retrieveMemories({ records, window: waifuMessages?…, channelId, now: new Date(), limit: server.memoryInjectionLimit })`. NOTE: `buildWaifuPromptParts` does not currently receive the context messages — extend its options with `contextMessages?: ContextMessage[]` and pass `waifuMessages` from `executeResponderDecision` (the /print path passes none → falls back to recency+strength-only scoring, which the implementation must handle: empty window = lexical 0 for all). Read `server.memoryInjectionLimit` at the existing `ensureServer` call site and thread it through. After selection, stamp `lastRetrievedAt` for selected ids — batched best-effort `updateRevisionedJson` that skips records stamped within the last hour, fire-and-forget with `.catch` + logger.warn.

- [ ] **Step 4: Gate + commit** — also update the runtime test that asserted inject-all (it should now assert the cap + pinned-always).

```bash
git add src tests && git commit -m "feat: per-turn memory retrieval — scored top-K replaces inject-all"
```

---

## Task 3: Write paths — observer queue, fast-track, lean observer input

**Files:**
- Modify: `src/orchestration/runtime.ts` (`runStageManager` split: observer→queue+fast-track; librarian call REMAINS but now drains the queue — fully replaced in Task 4)
- Modify: `src/providers/pipelines.ts` (observer tool schema +entities; observer prompt time-bound rule; `formatObserverContext` replaces `renderContext`)
- Modify: `src/orchestration/stageManager.ts` (observation schema +entities)
- Test: `tests/pipelines.test.ts`, `tests/runtime.test.ts`

- [ ] **Step 1: Observation entities.** `StageManagerObservationSchema` gains `entities: z.array(z.string()).default([])`; observer tool parameters gain `entities: { type: "array", items: { type: "string" }, description: "Display names of every person this observation is about." }` (NOT required — degrade gracefully). Observer instruction list gains one bullet: `"- If a fact is time-bound, state the absolute resolution date and what becomes true after it ('K plans to release the update on 2026-06-12'), never bare 'tomorrow'/'tonight'."`

- [ ] **Step 2: Lean observer input.** New `formatObserverContext(messages: ContextMessage[], now: Date): string` in `src/orchestration/context.ts`: header `Window: <first msg date+time>–<last msg time> UTC (today: YYYY-MM-DD)`, then per message the `replying to > Author` line (when present), `DisplayName: body`, and `[image_text: ...]` lines — NO `[index:]`, NO per-message timestamps, NO `[reactions:]`; insert `[— next day: YYYY-MM-DD —]` between messages that cross midnight. All four `decideStageManagerObservations` bodies switch from `renderContext(...)` to a single user message of `formatObserverContext(request.messages, new Date())`. Then DELETE `renderContext`, `formatContextMessage`, `buildSuffix`, `contextToUserMessage` IF grep shows zero remaining callers (the librarian path may still use renderContext — if so, leave deletion to Task 4 and note it). Update the observer prompt's format paragraph to describe the new shape.

- [ ] **Step 3: Queue + fast-track in `runStageManager`.** After observations return: append ALL allowed observations to `user/memory/pending-observations.json` (`PendingObservationsFileSchema`, resourceKey `memory:pending`); records with `importance >= 4` are ALSO immediately added to the store as `MemoryRecord` (source stage_manager, strength = importance, entities from the observation or `extractEntities`) and removed from the queue entry (mark them or skip queueing). The existing librarian call now receives only what it received before (this task does not change the librarian; it adds the queue alongside so Task 4 can swap cleanly). History entries note `queued: n, fastTracked: m`.

- [ ] **Step 4: Gate + commit**

```bash
git add src tests && git commit -m "feat: observation entities, lean observer input, pending queue with fast-track"
```

---

## Task 4: Dream pass

**Files:**
- Create: `src/orchestration/dream.ts`
- Modify: `src/orchestration/stageManager.ts` (dream op schemas), `src/providers/pipelines.ts` (`decideDream` ×4 replacing `decideStageManager`; DREAM tool + prompt), `src/providers/types.ts`, `src/orchestration/runtime.ts` (scheduling; `/memories` flow; `applyStageManagerCalls` → `applyDreamOps`)
- Test: `tests/dream.test.ts` (new), `tests/runtime.test.ts`, `tests/pipelines.test.ts`

- [ ] **Step 1: Op schemas (`stageManager.ts`)** — replace `StageManagerToolCallSchema`:

```ts
export const DreamOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), memory: z.object({ waifuId: z.string().min(1), content: z.string().min(1), kind: MemoryKindSchema, strength: z.number().min(0).max(5), entities: z.array(z.string()).default([]) }) }),
  z.object({ op: z.literal("promote"), memoryIndex: z.number().int().min(1), patch: z.object({ kind: MemoryKindSchema.optional(), strength: z.number().min(0).max(5).optional(), content: z.string().min(1).optional() }).default({}) }),
  z.object({ op: z.literal("rewrite"), memoryIndex: z.number().int().min(1), content: z.string().min(1), entities: z.array(z.string()).default([]) }),
  z.object({ op: z.literal("merge"), memoryIndices: z.array(z.number().int().min(1)).min(2), content: z.string().min(1), entities: z.array(z.string()).default([]) }),
  z.object({ op: z.literal("decay"), memoryIndex: z.number().int().min(1), strength: z.number().min(0).max(5) }),
  z.object({ op: z.literal("archive"), memoryIndex: z.number().int().min(1), reason: z.string().min(1) }),
  z.object({ op: z.literal("none") })
]);
export type DreamOp = z.infer<typeof DreamOpSchema>;
```

- [ ] **Step 2: `decideDream` ×4 (pipelines.ts)** — tool `dream_memories` (forced, observer pattern), parameters: `{ ops: array of the op grammar above as JSON schema (write it out — discriminated by "op", string enums, additionalProperties false per branch is NOT expressible flatly: use a single object shape with all-optional fields plus required "op" enum and describe the per-op requirements in the description, matching how the old manage_memories schema handled its union) }`. System prompt:

```ts
const DREAM_PROMPT = `You are the nightly memory-consolidation pass for a cast of Discord personas. You receive JSON in user messages:
- memories: active records — memoryIndex, waifuId, content, kind, strength (0-5), ageDays, daysSinceRetrieved, expiresInHours (notes only).
- observations: new durable observations from recent chat — waifuId, content, kind, importance, entities.

Call dream_memories exactly once with an ops array. No assistant text.

Policy:
- add: an observation that is genuinely new. Carry its waifuId, content, kind; strength = its importance.
- If an observation restates an existing memory, do nothing for it; if it strictly refines one, rewrite that memory.
- rewrite and merge produce ONE clean sentence or two — the result must read as a single well-written memory, never a concatenation. Preserve every DISTINCT fact; drop redundant phrasings.
- promote: a note (expiring record) whose fact will still matter in a month gets promoted — give it a proper kind and strength; promotion clears its expiry.
- decay: trivia (strength <= 2) untouched and unretrieved for 30+ days drops toward 0. A resolved commitment or past event gets rewritten to its outcome or archived.
- archive: only when a memory is now false or fully superseded; the reason field is required.
- Balance the cast's memory: if one person dominates the store, prefer decaying their stale trivia over adding more.
- Never invent facts. An empty room is fine: one none op is a valid answer.`;
```

`StageManagerRequest`→ rename/extend in `types.ts`: `DreamRequest = ProviderRequest & { memories: DreamMemoryInput[]; observations: PendingObservation[] }` with `DreamMemoryInput = { memoryIndex, waifuId, content, kind, strength, ageDays, daysSinceRetrieved, expiresInHours? }`. Delete `decideStageManager` + librarian prompt + `manage_memories` schema once nothing references them.

- [ ] **Step 3: `dream.ts`** — exported pieces: `selectDreamInput(records, pendingObservations, now, budget = 80)` (all active non-pinned for the guild; chunk by waifu over budget — return array of chunks), `applyDreamOps(storeMemories, ops, indexMap, { guildId, now, maxOps = 30 })` returning `{ memories, historyEntries, applied, skipped }` with guardrails: pinned untouchable, unknown index skipped, ops beyond maxOps dropped+logged, archive requires reason (schema enforces). Port the structure of `applyStageManagerCalls` (runtime.ts) — then DELETE that function and its history mapping in favor of these.

- [ ] **Step 4: Scheduling + flows (runtime.ts)** — per-guild daily timer: `scheduleDreamRuns()` called from `start()` — for each known guild (readdir `user/servers`), compute next 05:00 LOCAL + jitter `(guildHash % 30) - 15` minutes; `setTimeout` chain that re-arms daily; on fire, if `this.activeRuns` has the guild, defer 15min up to 8 times then run anyway. The dream run: read pending queue + store → chunks → `decideDream` per chunk (stage-manager agent config model) → `applyDreamOps` → clear consumed observations from the queue → history entries + debug-route summary (reuse `sendStageManagerDebugLog` shape with a `[dream]` prefix). `/memories` command + `triggerStageManager` API: now run observer → fast-track → dream (full flow) and report counts. Timers cleared in `pause()`/`stop()` like the stage-manager timers.

- [ ] **Step 5: Tests** — `tests/dream.test.ts`: applyDreamOps unit coverage (each op; pinned skip; op cap; unknown index; merge archives sources and adds one record with entities). Runtime: a dream run end-to-end with a fake pipeline returning canned ops against a seeded store + queue (temp roots), assert store mutations + queue drained + history written. Pipelines: `dream_memories` request shape for OpenAI-chat (forced tool, memories+observations as user JSON blocks).

- [ ] **Step 6: Gate + commit**

```bash
git add src tests && git commit -m "feat: dream consolidation pass replaces librarian — scheduled, guarded, queue-driven"
```

---

## Task 5: Dashboard

**Files:**
- Modify: `src/frontend/views/MemoriesView.tsx`, `src/frontend/views/StageManagerView.tsx`, `src/frontend/api/types.ts`, `src/frontend/api/client.ts`, `src/api/server.ts` (dream trigger route if missing)
- Test: `npm run typecheck` + `npm run build` (no frontend unit tests exist beyond promptLayout)

- [ ] **Step 1: MemoriesView** — columns/filters: importance→strength (`★ n`), permanent→pinned (`📌 Pinned`), add kind + source badges and an expiry countdown for notes; editor: strength input 0–5, pinned toggle (POST creates pinned user memories per the API), kind select. Keep the file's existing table/editor patterns — mechanical remap, no redesign.
- [ ] **Step 2: StageManagerView** — rename user-facing copy from "librarian" to "dream pass" where present; the manual trigger button now reports the full observer→dream counts; history list renders the new op labels (added/promoted/rewritten/merged/decayed/archived).
- [ ] **Step 3: Gate** — `npm run typecheck && npm run build && npm run test`; commit `feat: dashboard for unified memories and dream pass`.

---

## Task 6: Acceptance + bookkeeping

- [ ] **Step 1: Full gate** — `npm run typecheck && npm run test && npm run build:backend && npm run build`.
- [ ] **Step 2: Acceptance greps** — `grep -rn "ShortTermMemory\|short-term-memories" src/ | grep -v migrations` → zero; `grep -rn "decideStageManager\b\|manage_memories\|librarian" src/` → zero (observer keeps `decideStageManagerObservations`).
- [ ] **Step 3: MIGRATION_PLAN.md §10** — append a W3 entry after the W2 line: unified MemoryRecord store + shape migration (no schemaVersion bump — note for P4), retrieval module, observer entities + lean input + pending queue + fast-track, `decideDream` REPLACES `decideStageManager` on ModelPipeline (P3 must carry `generatePersonaDigest`, `decideDream`, observer changes), dashboard remap, plus the Task-0 prompt tuning. Commit `docs: record W3 memory v2 in migration plan status log`.

---

## Post-W3 manual validation (live server)

1. After deploy: `/print memories` for aria — should show ≤12 scored lines + pinned, with kind labels, instead of 46.
2. Trigger `/memories` in a busy channel — observer + fast-track + dream counts in the reply; dashboard history shows dream ops.
3. Next morning: check the dream ran (history), K-trivia strengths decayed, the repeated-sentence Lumi merge artifact got rewritten.
4. Watch the K-fixation signal: share of orchestrator reasonings mentioning K should fall below ~30% within a day or two as memory injection diversifies; reply medians should drop back under ~80 chars from Task 0.
