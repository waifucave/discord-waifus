# W3 — Memory v2: Unified Store, Retrieval, Dreaming

Goal: one memory store with lifecycle metadata; per-turn **selection** instead of inject-everything;
a scheduled **dream pass** that consolidates, promotes, decays, and repairs — the closest practical
replica of OpenAI-style "dreaming" within this architecture (cheap-model background calls were
approved; per-turn retrieval stays local and free).

Evidence (live): 154 active memories all injected every turn (one waifu carries 46 lines);
concatenation-merges produced a memory repeating the same sentence 4×; importance-1 trivia from
months ago retained; "K will release the update tomorrow" stored as durable fact; short-term store
nearly unused (7 entries) and invisible to the stage manager with no promotion path.

## 1. Unified record (`src/shared/schemas/domain.ts`)

`user/memories.json` keeps its path; `MemoryStore` schema becomes:

```ts
export const MemoryRecordSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  channelId: z.string().optional(),   // origin channel; retrieval boost, NOT a visibility filter
  waifuId: z.string(),
  content: z.string(),
  kind: z.enum(["fact", "preference", "relationship", "event", "commitment", "context"]),
  source: z.enum(["waifu_tool", "stage_manager", "dream", "user"]),
  pinned: z.boolean().default(false), // replaces `permanent`; user-managed; never auto-edited, always injected
  strength: z.number().min(0).max(5), // replaces importance; dream pass decays/reinforces
  entities: z.array(z.string()).default([]), // display names mentioned; retrieval signal
  expiresAt: z.string().optional(),   // hard TTL (waifu notes); absent = durable
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRetrievedAt: z.string().optional(),
  status: z.enum(["active", "archived"])
});
```

The separate `user/short-term-memories.json` store, `ShortTermMemory*` schemas, and the
long/short split in `buildWaifuPromptParts`/`modelVisibleMemoryBlockForPrint` are deleted — a
"short-term memory" is now just a record with `source: "waifu_tool"`, `kind: "context"`, and an
`expiresAt`.

**Migration** (one `runMigrations` step, tests with real temp roots per house style):
long-term → `strength = importance`, `permanent` → `pinned`, `source` inferred
(`permanent → user`, else `stage_manager`); short-term entries → `source: waifu_tool`,
`kind: context`, `strength 2`, keep `expiresAt`; entities extracted by the capitalized-token
heuristic (§3); short-term file removed after merge. Bump `CURRENT_SCHEMA_VERSION` (coordinate the
version number with the gateway migration's P4 bump — see `06-gateway-coordination.md`).

## 2. Write paths

| Path | When | What |
|---|---|---|
| Waifu `add_memory` tool | during her reply | note: `source: waifu_tool`, `kind: context`, `strength 2`, `expiresAt = +72h` (was 24h — survives a weekend), origin `channelId` set, guild-visible |
| Observer | unchanged trigger (1h channel idle or `/memories`) | observations appended to `user/memory/pending-observations.json` (new small revisioned file) instead of feeding the librarian immediately; **fast-track**: importance ≥ 4 observations are added to the store directly (`source: stage_manager`) so critical facts don't wait for the next dream |
| Dream pass | scheduled (§5) | the only writer allowed to update/merge/archive/promote |
| User (dashboard / future) | manual | `pinned` records; only the user can create or edit them |

The waifu tool keeps its name (`add_memory`), single `content` argument, and the
`suppressMemoryToolOnce` tool-only-reply guard. Instructions (harness §6) push toward the
originally-intended heavy usage:

```
add_memory — your personal notepad. The chat history can vanish at any time (channel switch,
cleanup); your notes are what survives. Whenever the conversation produces something you'd want to
still know tomorrow — a plan, a promise, a new fact about someone, the state of a running
joke/argument — save it as one standalone sentence with names spelled out ("Riko owes Ali tacos
since Thursday", not "she owes him"). Up to 5 per reply. Skip pure filler and anything already in
your memories block. Notes expire in ~3 days unless the nightly process deems them keepers.
Always also write your normal message in the same turn — the tool alone leaves the room silent.
```

## 3. Per-turn retrieval (new `src/orchestration/memoryRetrieval.ts`)

Local, deterministic, no API calls. Inputs: the waifu's candidate records
(`guildId` match, `status: active`, not expired, `waifuId` match), the last ~12 context messages,
the current `channelId`.

```
score(m) = 2.0 · lexical(m)        // Jaccard-style overlap: memory tokens+entities vs window tokens (stopword-filtered; reuse stage-manager tokenizer)
         + 1.0 · recency(m)        // exp decay on updatedAt, half-life 7 days
         + 0.6 · strength(m) / 5
         + 0.4 · channelMatch(m)   // 1 if same channel
         + 0.4 · freshNote(m)      // 1 if source=waifu_tool and createdAt within 48h — preserves "chat state" continuity
```

Selection: all `pinned` first (user-managed = always present), then top-K by score with
**K = 12 lines** (new server-config knob `memoryInjectionLimit`, default 12). Ordering inside the
block: pinned → durable → notes, each oldest→newest. Rendering with kind labels:

```
<{tag}_relevant_memories>
- (fact) Kevin is allergic to peanuts.
- (note, 2h ago) LTS has a 1998 Mercedes CLK200 with under 100k miles.
</{tag}_relevant_memories>
```

Relative-age labels only for notes (`2h ago`, `yesterday`) — they signal volatility to the model.
Selected ids get `lastRetrievedAt` stamped (batched, best-effort write; used by dream decay only —
not by `score()`, to avoid a retrieval feedback loop).

Cross-channel continuity (the original goal of short-term memories): notes are guild-visible with a
channel *boost*, so moving the conversation to another channel carries the state over instead of
losing it.

## 4. Observer (unchanged role, two prompt fixes)

The observer prompt (`observerSystemPrompt` in `pipelines.ts`) is already good. Two adjustments:

- **Entities**: each observation adds `entities: string[]` (display names referenced) — feeds §3
  scoring. Tool schema + zod updated (`stageManager.ts`).
- **Time-bound phrasing**: add to the instruction list — "If a fact is time-bound, state the
  absolute resolution time and what becomes true after it ('K plans to release the update on
  2026-06-12'), never bare 'tomorrow'/'tonight'." (Directly fixes the rotting-"tomorrow" memory
  observed live.)

## 5. Dream pass (replaces the librarian; new `src/orchestration/dream.ts`)

**Trigger**: per guild, once per day at a configured local hour (default 05:00, ±15 min jitter),
only when no channel run is active for that guild (defer up to 2h, then run anyway); plus manual
trigger via `/memories` (which now runs observer → fast-track → dream) and a dashboard button.
Scheduling lives next to the stage-manager idle timers in `runtime.ts`.

**Model**: the stage-manager agent config (currently `claude-haiku-4-5` — right tier for this).

**Input** (per call): all active non-pinned records for the guild — chunked by waifu when above the
existing 80-record prompt budget — plus pending observations, plus notes expiring within 24h.
**Output**: one forced tool call (`dream_memories`) with an operations array:

```
{ "op": "add",     "memory": { waifuId, content, kind, strength, entities } }   // from observations
{ "op": "promote", "memoryIndex": n, "patch": { kind?, strength?, content? } }  // note → durable (clears expiresAt)
{ "op": "rewrite", "memoryIndex": n, "content": "...", "entities": [...] }      // repair/condense ONE record
{ "op": "merge",   "memoryIndices": [..], "content": "...", "entities": [...] } // consolidate; sources archived
{ "op": "decay",   "memoryIndex": n, "strength": x }                            // reduce; expire-soon for stale trivia
{ "op": "archive", "memoryIndex": n, "reason": "..." }                          // reason REQUIRED
{ "op": "none" }
```

Prompt principles (full draft to be written at implementation, structured like the librarian's):

- Merge/rewrite produce **one clean sentence or two** — explicitly: "the result must read as a
  single well-written memory, never a concatenation; drop redundant phrasings" (the existing
  "preserve every non-contradicted fact" wording caused the observed 4×-repeated-sentence merge —
  replace it with "preserve every distinct fact").
- Decay policy: trivia (`strength ≤ 2`) untouched-and-unretrieved for 30+ days → decay toward 0;
  `strength 0` → archive. Resolved commitments/events ("the update shipped") → rewrite to the
  outcome or archive.
- Promote policy: a note that captures a durable fact (test: "useful in a month?") → promote with
  proper kind; the rest expire naturally.
- Never touch `pinned`. Cap: ≤ 30 ops per run (runtime-enforced; excess dropped + logged).

**Guardrails (code)**: ops validated like today's librarian calls (index map, guild scope, pinned
skip, history entries per op into `stage-manager/history.json`, debug-route summary). The
`merge_memories`/`update_memory`/`archive_memory` apply-machinery in `runtime.ts`
(`applyStageManagerCalls`) is refactored to the new op set rather than rewritten.

## 6. Cost estimate

Dream: 1 call/guild/day on a haiku-class model with ≤ ~80 records + observations ≈ well under a
cent/day per guild. Observer cadence unchanged. Retrieval: free. Persona digest (W2): 1 call per
persona edit.

## 7. Touched files

| File | Change |
|---|---|
| `src/shared/schemas/domain.ts` | `MemoryRecordSchema`, store schema, pending-observations file schema, server `memoryInjectionLimit` |
| `src/backend` migrations | store migration §1 |
| `src/orchestration/memoryRetrieval.ts` | new — scoring + selection (§3) |
| `src/orchestration/dream.ts` | new — scheduling, chunking, op application (§5) |
| `src/orchestration/runtime.ts` | `buildWaifuPromptParts` retrieval hookup, `recordShortTermMemoryEntries` → note creation, observer queue + fast-track, dream scheduler, `/memories` flow |
| `src/orchestration/stageManager.ts` | observation `entities`, dream op schemas |
| `src/providers/pipelines.ts` + `types.ts` | observer tool schema (+entities), `decideStageManager` → `decideDream` request/op shapes |
| `src/frontend/views/MemoriesView.tsx`, `StageManagerView.tsx`, `api/types.ts` | unified store columns (kind/source/strength/expiry/pinned), dream trigger button, history rendering |
| `tests/` | migration, retrieval scoring (labeled fixtures), dream op application + guardrails, expiry |

## 8. Acceptance

- Injection ≤ `memoryInjectionLimit` lines per turn (from up to 46); pinned always present.
- Retrieval precision ≥ 0.7 on the labeled fixture set (05).
- A seeded store containing the live data's pathologies (4×-repeated merge artifact, "tomorrow"
  commitment, 30-day-old trivia) comes out of one dream pass repaired: rewritten, resolved/dated,
  decayed respectively — asserted via live-gated eval.
- A note created in channel A is retrievable in channel B of the same guild (continuity test).
- `/memories`, dashboard memory CRUD, and `/print memories` keep working against the unified store.
