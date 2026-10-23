# Discord Waifus overhaul — design spec

Status: **draft** · Date: 2026-10-23 · Scope: `discord-waifus/app` (+ `discord-waifus/gateway`)

## 1. Request

From the owner, after the 2026-10-23 full-codebase review:

1. Fix every bug the review found and add the improvements it proposed.
2. Evaluate `winter-agent-sdk` (sibling checkout `winter-agent-sdk`, outside this workspace) as a replacement for
   `@waifucave/gateway`.
3. Redesign how waifu models are prompted — and likely the orchestrator and memory prompts too.
4. Add context compaction when a conversation approaches the model's context window.
5. Remove useless/dead code.
6. **No webhook personas** (an early, standing decision — one bot token per character stays).
7. Make **memories global**: one memory space per waifu across every server and DMs.
8. Add per-waifu settings: **Allow DMs** and a **rate limit**.
9. Every setting must be readable/changeable via **CLI and HTTP**, with a **help endpoint** for each.

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | No webhook personas. Remove any notes/docs implying them. |
| D2 | Memories are global per waifu. `guildId` stops being a retrieval filter; it is kept only as provenance (where the memory was learned). |
| D3 | DMs are opt-in per waifu (`allowDms`, default off). |
| D4 | One declarative settings registry generates CLI commands, HTTP help, and assistant-kb docs so they cannot drift. |
| D5 | Remote Access is kept but **decoupled** from the core bot: it may never block boot, auto-update, or a bot-fix release when disabled/unsupported. Not extended further in this program. |
| D6 | Execution: subagent-driven, one `phase-N-<name>` branch per phase, merged to `main` locally, each phase green on `npm run typecheck` + `npm test` before merge. No npm release unless asked. |

## 3. Work items from the review

Baseline at review time: typecheck clean, 1588 tests passing / 16 skipped. Every bug fix lands with a
regression test. IDs are referenced by the phase plan.

### 3.1 Critical / quick fixes

- **B1** `assertSafeId` accepts `.`/`..` → `DELETE /api/servers/..` recursively deletes `user/`
  (`src/api/server.ts:1635`, `:912`). Reject dot-only ids; require Discord snowflakes for guild/channel
  ids; add a containment guard in `resolveDataPath`.
- **B2** Pause is in-memory only; any config save/reload/restart un-pauses (`src/api/server.ts:1072`,
  `src/backend/server.ts:325`). Persist it. Paused runtime must not run restart-resume.
- **B3** One failing bot login (`Promise.all`) takes all bots offline and leaks half-logged-in clients;
  disabled bots still log in (`src/discord/client.ts:248-347`). Per-bot connect with `allSettled`,
  destroy failures, honour `enabled`, surface per-bot errors.
- **B4** Reply lost if the triggering message is deleted (`failIfNotExists` default true,
  `client.ts:562`).
- **B5** Runs keyed per guild (`runtime.ts:4190`): a message in channel B aborts channel A's run and
  A's pending reply is dropped. Keep one-run-per-guild semantics if required by cast sharing, but
  re-queue the preempted channel; otherwise key per channel.
- **B6** Normal restart/update/reload loses in-flight replies — resume only accepts
  `runtime_restarted` (`restartResume.ts:52`).
- **B7** Persisted wake time never cleared → spurious wakes on every boot (`runtime.ts:2742`).
- **B8** Wake marker reports a stale plan; record the scheduling decision id with the timer
  (`runtime.ts:1269`).
- **B9** Crash recovery retries every 180 s forever; add exponential backoff + cap (`runtime.ts:1081`).
- **B10** Other bots counted as humans (`runtime.ts:1252`, `:4381`, `deterministicOrchestrator.ts`).
- **B11** Stage-manager `running` flag persisted and never reset at boot (`runtime.ts:2133`).
- **B12** Dream pass capped at 5 chunks in id order → some waifus never dreamed; memories for
  waifus with no prior memories misattributed (`runtime.ts:2606`, `:2637`, `dream.ts:78`).
- **B13** Restart resume matches responders by array position; breaks after handoffs
  (`restartResume.ts:47`).
- **B14** Chunk > 2000 chars with no split point sent unsplit (`messageSplit.ts:59`).
- **B15** Dashboard memories default to guild `"global"` and are never retrieved
  (`MemoryScreen.tsx:63`) — superseded by D2 but the UI must change accordingly.
- **B16** Settings → App bot-token save creates an orphan bot entry and never links the waifu
  (`SettingsScreen.tsx:298`).
- **B17** Partial PUT bodies re-materialize nested zod defaults (`src/api/server.ts:172-198`);
  assistant `update_server`/`update_waifu` reset unrelated nested settings.
- **B18** Assistant destructive tools (`delete_waifu`, `delete_memory`, `clear_provider_key`) run
  without a confirmation card; Discord-sourced text reaches its context (prompt-injection path).
- **B19** Assistant transcript trimming can orphan tool results → permanent provider rejection; no
  abort/cancel or per-turn cost cap.
- **B20** Character editor drops unsaved draft on any server update; no 409 merge path
  (`CastScreen.tsx:136`). Memory edits use store-wide revision and fail repeatedly while bots are
  active (`MemoryScreen.tsx:54`); delete has no confirmation.
- **B21** No single-instance guard on the data root (two processes → duplicate replies, lost
  writes); stale `pid.json` after crash can make `waifus stop` SIGKILL an unrelated pid.
- **B22** Discord shard handling: the `wasClean === false` branch is unreachable on discord.js 14.27
  and any `ShardError` matching `/socket|network|timeout/` tears down all bots (`server.ts:293`, `:686`).
- **B23** Slash command arriving with no listener is deferred and never answered
  (`client.ts:955`). `/run` has no permission requirement or cooldown and accepts private
  `scene_direction` from any member.
- **B24** Members refresh uses raw `fetch` with no 429 handling and a non-compliant User-Agent
  (`server.ts:836`).
- **B25** Windows: atomic `rename` has no EPERM/EBUSY retry; failed tmp files linger (`atomic.ts:44`).
- **B26** Home status fetched once, never refreshed (`HomeScreen.tsx:39`).
- **B27** Boot fails if `remote-compatibility.json` mismatches even with Remote Access disabled
  (`src/backend/server.ts:116`); auto-update can never apply on platforms without a helper
  (`src/backend/updates/runner.ts:21`); helper supervisor gives up after 10 crashes with no
  auto-recovery; remote browser sessions never expire (cap 1024 → lockout).

### 3.2 Gateway codec bugs (`discord-waifus/gateway`)

- **G1** Anthropic `reasoning.exclude → thinking.redacted` is not a real field; older Claude models
  lack the "drop temperature/top_k when thinking" rule.
- **G2** OpenRouter `reasoning` / `reasoning_details` dropped (`openaiChat.ts:157,202`).
- **G3** `passthrough` can overwrite `model`/`messages` (`shared.ts:153`); `/v1/chat` is exposed.
- **G4** OpenAI Responses streaming ignores `response.incomplete` → reports `error` not `length`.
- **G5** Gemini streaming drops `thoughtSignature` on tool calls.
- **G6** Claude advertises JSON-schema output but the codec throws.
- **G7** Spurious `param_forced` warning on every thinking request.
- **G8** Quota 429s retried.
- **G9** Images not gated by model input modalities.
- **G10** Usage semantics differ per provider (cache tokens, thinking tokens).
- **G11** Possible: streamed tool-call `index ?? 0` merges; no stream idle timeout.
- App side: `gatewayPipeline.ts:223` strips reasoning blocks before tool replay; finish reason
  `length` never checked.

Whether these are fixed in the gateway or obsoleted by a replacement depends on §5.

### 3.3 Improvements

- **I1 Prompt caching**: send `cache_control` / provider cache hints; make the prompt prefix stable
  (no per-message relative ages; window advances in steps). Folded into §6.
- **I2 Debounce** message bursts (0.5–1.5 s) before re-running the orchestrator.
- **I3 Cost visibility**: aggregate per-call usage; compute cost from catalog pricing (or provider
  `usage.cost`); show per waifu / server / day in the dashboard and via CLI/HTTP.
- **I4 "Why didn't she reply"** view from recorded `responderOutcomes`; surface Discord warnings,
  per-bot login errors, and `lastError` in the UI.
- **I5** Detect and handle truncated replies (`finishReason: length`).
- **I6** Image fetch cache + cap + abort; reuse OCR's newest-N budget (`pipeline/messages.ts:34`).
- **I7** Unicode-aware tokenizer for memory retrieval and loop detection; diversity penalty via
  `lastRetrievedAt`; loop detector compares per-author history (A/B/A/B loops).
- **I8** Observer keeps a last-seen cursor; dedupe facts before writing memories.
- **I9** Empty/blocked waifu output must not count as executed and loop the orchestrator.
- **I10** Fetch dedupe: one `fetchFreshContext` per pass shared by orchestrator/waifus/stage manager;
  batch reaction fetches; in-memory invalidated guild cache (members/emojis/roles).
- **I11** Waifu-only clients use `Guilds` intent only.
- **I12** Discord features: react to message edits/deletes; threads inherit parent channel config;
  DMs (per D3); embeds/stickers/polls/forwarded messages normalized into context; `<#channel>` and
  `<t:…>` tokens rendered.
- **I13** Character Card V2 / SillyTavern import & export (PNG + JSON).
- **I14** Dashboard: Rooms controls for server `enabled`, context windows, memory injection limit,
  tools; add/remove channels; memory guild picker removed (D2); bulk ops.
- **I15** Global orchestrator history file → per-guild files (removes global lock).
- **I16** `StorageService.readJson` stops `readdir`-ing on every read.
- **I17** Frontend API types generated from shared zod schemas (`z.output`) instead of hand mirrors.

### 3.4 Dead / useless code

- Never imported: `src/discord/rateLimit.ts` (unless reused for B24), `src/discord/intents.ts`,
  `src/frontend/components/Empty.tsx`, `Modal.tsx`, `utils/format.ts`, `state/runtimeStore.ts`
  (or wire it in for B26), `DiscordGatewayNotConfigured`, ~65 unused exports (knip).
- Remote "contract"/vector TS only used by tests and the generator (~9.5k LOC) moved out of
  `src/shared` into dev tooling; `contracts/remote/v1` dropped from the npm `files` list if not
  needed at runtime.
- Laya local-Python mode + decision benchmark (~900 LOC, `assets/laya` shipped) — remove unless the
  owner wants it; one-shot mode reviewed in §6.
- Unused routes/client methods: pfp/banner upload, trigger routes writing fake history, unused
  client methods; flags nothing honours (channel `enabled`, server `enabled`) — honour or remove.
- `session.ts` unused fields/handles; `planWaifuReplyChunks` test-only; `reviewer.ts` folded into
  `tools.ts`; triplicated `tokenSet`/`jaccard`; test-only hooks on the production class.
- Legacy migrations (~10 steps re-run every boot) gated behind a schema-version ledger.
- Stale docs: assistant-kb contradictions (PATCH vs PUT, nonexistent toggles, wrong menu paths),
  CLAUDE.md "absent helper packages", `MIGRATION_PLAN.md` (done), `docs/old-orchestrator-prompt.md`
  (shipped in package — verify need).
- Gateway: unused data fields, duplicate Meta family, CI drift-check gaps.
- Structure: split `src/orchestration/runtime.ts` (4.7k lines) into commands / channel runner /
  responder executor / memory jobs / reviewer runner / stores / prompt builders / debug format.

## 4. Per-waifu DM + rate-limit settings

Owner decision (2026-10-23): the rate limit is **per user, DMs only** — servers stay paced by the
orchestrator.

- `WaifuConfig.dm.allowDms: boolean` (default `false`). When false the waifu ignores DMs entirely
  (no reply, no memory capture). When true, a DM to that waifu's bot runs a 1:1 conversation with
  that waifu only — no orchestrator casting, no other waifus, but the same prompt harness, global
  memories (D2), compaction (§6) and model target as in servers.
- `WaifuConfig.dm.rateLimit: { maxReplies: int ≥1, windowMinutes: int ≥1 } | null` (default
  e.g. `{ maxReplies: 30, windowMinutes: 60 }`; `null` = unlimited). Counted per (waifu, Discord
  user) over a sliding window; persisted so a restart does not reset it. When exceeded the waifu
  stays silent (optionally one in-character "talk later" notice per window — configurable flag
  `dm.notifyWhenLimited`, default `true`) and resumes when the window frees up.
- Requires the `DirectMessages` intent + `Partials.Channel` on that waifu's client only.
- DM contexts live under `user/conversations/dm_<userId>_<waifuId>/` (same engine as channels);
  DM-only state (rate-limit counters) under `user/dms/`; covered by per-user deletion via CLI/HTTP.
- Exposed through the settings registry (§7), dashboard Cast editor, CLI, HTTP and help.

## 5. LLM layer: gateway vs winter-agent-sdk

**Decision: keep `@waifucave/gateway`; port winter's fixes into it.** (Evaluation 2026-10-23.)

Why not replace:
- winter's only usable layer is `winter-provider-runtime` + `winter-provider-catalog`
  (`adapter.streamTurn(TurnRequest, ProviderContext)`); `query()` spawns a 72 MB binary agent.
- Its frozen `TurnRequest` has **no temperature/top_p/stop/penalties and no JSON-schema output** —
  the app sends these every turn; mandatory decision calls rely on `json_schema`.
- No per-param descriptors/constraint rules → the dashboard's capability-driven model forms and
  write-side `validate()` would have to be rebuilt; no HTTP surface for `/api/llm/*`.
- 0.0.x with ~55 releases in 7 weeks; ~16 MB dist + a 72 MB optional binary pulled on Apple Silicon.
- Replacing ≈ rewriting the gateway on top of winter (2.5–4k LOC).

What to port from winter (reference implementations in
`winter-agent-sdk/packages/provider-runtime/src/`):
- Anthropic `cache_control` breakpoint placement (system + rolling message breakpoints,
  `adapters/anthropic/messages.ts:489,559`); OpenAI `prompt_cache_key`; OpenRouter cache hints on
  content parts for Anthropic/Gemini routes.
- A single normalized usage convention incl. cache-read/cache-write and reasoning subsets
  (`types.ts:349-382`) → fixes G10; cost via catalog pricing (+ OpenRouter `usage.cost`).
- Error classification: billing/quota non-retryable (G8), context-overflow kind (new
  `context_overflow` error kind, needed by compaction §6), rate-limit retry-after
  (`errors.ts:140-361`).
- OpenRouter `reasoning` delta handling (G2) and Gemini `thoughtSignature` capture in streaming (G5).
- Stream stall/idle timeout (G11).

Optional later: `gateway sync` cross-checks limits/modalities/pricing against winter's
`catalog.json` to flag drift (reference data only, not a runtime dependency).

Revisit only if winter adds sampling params + output schema to `TurnRequest` and per-param
descriptors to its catalog — and even then keep the gateway's API/HTTP surface on top.

## 6. Prompting, memory, and context compaction redesign

Status: **revised with owner input 2026-10-23** (reply target = waifu; layout editor removed; per-context self-compaction; epoch/append-only context).

### 6.1 Problems with the current design (inventory 2026-10-23)

- **Nothing is cacheable.** The waifu window slides by one message per turn; the memory block sits
  10 messages from the end and changes per turn; the `tools` text toggles; images are re-inlined.
  The orchestrator stamps relative ages (`[47s]`) on every message plus `[now]`/hour/availability.
- **Text protocols layered on chat roles**: `Name: body` transcripts, a `replying to > Author:`
  syntax the model must emit and code fuzzy-matches back, bracket tags, then regex strippers for
  legacy formats, stop sequences per participant (truncated to provider `maxItems` — humans dropped
  first), and impersonation stripping.
- **Contradictory rules**: length is "~10 words" (contract), "<12 words" (retry nudge), 90 chars
  (validator, soft), 280 chars (splitter); "never more than one message" vs "a line break sends
  separate messages". Contract restated in the anchor. ~1,100 words of orchestrator prose whose
  stay-quiet vs keep-casting conflict is resolved by code overrides.
- **Retry nudges impersonate the waifu** (a user turn starting `Aria:`).
- **No sense of time** for waifus (no timestamps, no "now").
- **Ignored config**: orchestrator `prompt` unused in model mode; stage-manager `prompt` never
  passed; `server.contextWindows.waifu` shadowed by `waifu.contextWindow` (`||`), agent
  `contextWindow` shadowed by server values. → fixed as bugs **B28** (custom prompts) and **B29**
  (window precedence) in Phase 4.
- **Memory**: guild-scoped; ASCII-only lexical scorer; lines have no subject (`- (fact) …`);
  pinned memories uncapped; observer never sees existing memories and fast-tracks importance ≥4
  without dedupe; entities are guild display names (not stable identities).
- **No token accounting**: gateway `contextTokens` never read; returned `usage` unused; no
  summary/compaction of any kind.

### 6.2 Principles (revised with owner input 2026-10-23)

1. **Claude-Code-style context.** One static system prompt, an **append-only** transcript, and one
   small ephemeral note at the very end. Nothing is ever inserted *before* existing content
   mid-epoch: no mid-transcript system blocks, no sliding window, no per-turn relative ages. The
   old "sprinkle system blocks around the transcript for adherence" pattern (built for weak cheap
   models) is removed — it invalidates the cache from the moved block onward every turn.
2. **Epochs.** A conversation context lives in epochs. Snapshot content (memories, summary, room
   facts) is computed at epoch start and frozen until the next compaction — like Claude Code's
   memory/CLAUDE.md, which load once per context. Things that become relevant mid-epoch are
   **appended** as inline notes at the point they occur (like system-reminders) and are stored so
   every rebuild of the transcript is byte-identical.
3. **The model owns voice and its reply target.** Owner decision: the waifu decides what it replies
   to, through a clean exact marker (no fuzzy matching).
4. **One source per rule.** A per-waifu `verbosity` setting drives the prompt wording, the
   validator, and the splitter.
5. **Memories are about people.** Global per waifu (D2), keyed by stable Discord user ids, rendered
   with subject + provenance.
6. **Each context compacts itself, with its own model.** Every waifu (and the orchestrator / stage
   manager) has its own context per conversation and its own model; compaction reuses that exact
   cached prefix so the summarization call is mostly cache reads (owner insight).
7. **No user-editable prompt layout.** Owner decision: the layout editor is removed. Customization
   = persona + new `customInstructions` text + `verbosity`.

### 6.3 Waifu context (new layout)

```
[system]  ── cache breakpoint A: static per waifu (changes only when the waifu config changes)
  harness           ~250 words, shared wording: live Discord chat with real people and other
                    characters; write only your own messages as plain chat text; no names,
                    prefixes, narration or meta; how the transcript, images, replies and time
                    markers look; how to reply to a specific message (marker below); emoji usage.
  identity          name, roster of the other characters
  persona           user persona text
  style             verbosity rule (one sentence from `verbosity`) + persona digest voice/drives
  schedule          sleep/busy routine (static)
  custom            optional per-waifu `customInstructions`
[user] epoch header ── cache breakpoint B: frozen for the whole epoch
  <conversation_summary>   this waifu's own summary of earlier conversation here (if any)
  <memories>               memory snapshot for the people in this conversation at epoch start
  <place>                  server/channel name or "DM with Kevin"; server emoji list
[transcript]  append-only since the epoch cursor ── rolling cache breakpoint C at the last message
  user turns       consecutive non-own messages merged into ONE turn:
                     `[14:02 #k3] Kevin: body` (time HH:MM, local; #ref = short stable message ref;
                     reply context shown as `[14:03 #k4 ↩#a1] Riko: body`)
                   images inline only for the newest N, OCR text for older ones
  assistant turns  this waifu's own messages, raw text
  inline notes     appended where they happen and persisted (never moved):
                     "— 3 hours later —" gap markers (derived from absolute times)
                     <memory_note> newly relevant memories (new participant joined, a memory
                       written mid-epoch, a strongly matching memory not in the snapshot)
                     <direction> an orchestrator directive given for that turn
                     tool calls/results (add_memory) as normal tool turns
[ephemeral tail]  ── never cached, never stored, always last
  one short note: current local time, the waifu's current activity (busy/sleepy/awake), who is
  present if it changed since epoch start, and the turn instruction ("Write Aria's next message.")
```

- **Reply marker**: the waifu may start its message with `↩#k3 ` to reply to message `#k3`. Code
  parses it exactly (unknown ref → plain message), strips it, sets Discord's reply reference.
  Refs are short, stable per message (base-36 of a per-conversation counter persisted with the
  epoch), shown only in headers. `extractReplyQuote` fuzzy matching and the `replying to >`
  syntax are deleted. If the waifu omits the marker, the message is sent unthreaded (or to the
  triggering message when it is not the latest one — keeps today's default).
- **Stop sequences** shrink to the header guard (`\n[`) plus the waifu's own name; the existing
  leak/impersonation strippers remain as a safety net.
- **Retry** uses a short system/developer note ("Your last draft was rejected: <reason>. Write it
  again.") — never a user turn with the waifu's name. Retry notes are ephemeral (not stored).
- **Validator** thresholds come from `verbosity` (`terse` ≈ one short line, `chatty` ≈ 1–3 lines,
  `expressive` ≈ up to a paragraph); the splitter uses the same profile; the soft-length bypass is
  removed (trim at a sentence boundary, else retry once).
- **Tools**: `add_memory` (now global) stays; the tool list and its text never toggle per turn
  (suppression handled by ignoring the call), so breakpoint A stays stable.
- **Layout editor removal**: delete `PromptLayout*` schemas, `promptLayout.ts`,
  `PromptLayoutEditor.tsx`, layout reconcile/migrations; migration drops `promptLayout` from
  waifu files (a disabled `persona`/`schedule` block maps to "omit schedule" only if the user had
  it off — schedule is the only block users plausibly disabled; checked at migration).
- **Caching transport** (Phase 3): gateway sends Anthropic `cache_control` at A/B/C, OpenRouter
  cache hints for Anthropic/Gemini routes, OpenAI `prompt_cache_key` = `waifu:<id>:<conversation>`.

### 6.4 Orchestrator and background agents

- **Orchestrator** gets the same shape: static system (concise director rules ~350 words without
  the quiet-vs-cast contradiction — the rules state the cadence policy code enforces; casting cards;
  owner custom `orchestrator.prompt` appended as `<owner_policy>` in model mode too, B28) → epoch
  header (its own summary, roster availability snapshot) → append-only transcript with the same
  `[HH:MM #ref]` headers and its past decisions as compact tool-call turns → ephemeral tail (now,
  current availability, loop/cadence `runtime_notice`, wake marker with the correct scheduling
  source, B8).
- Decision schema unchanged (directives, wakePlan, retrigger); reply targets stay with waifus.
  Deterministic and one-shot modes stay (owner decision) and consume the same context builder;
  one-shot's JSON state uses absolute times.
- **Stage manager / observer** and **reviewer** use the same builder; stage-manager custom prompt
  honoured (B28).

### 6.5 Memory (global)

- **Scope**: `MemoryRecord.guildId` → optional `origin { guildId?, channelId?, dm?: true }`
  (provenance only). Retrieval, dedupe, dream and the API ignore guild for filtering;
  `GET /api/memories?guildId` becomes a provenance filter. Migration keeps each record's guild as
  `origin.guildId`; a conservative one-time dedupe merges cross-guild duplicates (normalized-text
  similarity + same waifu), the first global dream pass does the rest.
- **Subjects**: `subjects: [{ discordUserId?, waifuId?, name }]` replaces display-name `entities`
  (names refreshed at render time from member caches). Rendered as
  `- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)`.
- **Injection follows the epoch model**: the snapshot (≤ `memoryInjectionLimit`, pinned capped at
  `maxPinnedInjected` default 6) is chosen at epoch start for the people present; mid-epoch
  additions are appended `<memory_note>`s (bounded per epoch). Nothing re-ranks the snapshot until
  the next compaction.
- **Retrieval score**: subject match with participants (strong) + Unicode-aware lexical match
  (`\p{L}\p{N}` tokens, CJK bigrams) + recency + strength + small same-origin boost − diversity
  penalty via `lastRetrievedAt`; human lines weigh more than the waifu's own in the query window.
- **Writing**: observer sees existing memories for the participants and emits
  `add | update | merge | expire` ops; one dedupe gate for every writer (normalized similarity +
  same subject); observer keeps a per-conversation last-seen cursor (I8); `context` notes keep the
  72 h TTL.
- **Dream pass**: one global schedule (configurable hour) iterating waifus round-robin with a
  persisted cursor and per-night budget (B12); allowed waifu ids include observation owners.
- **DMs** feed the same global memory.
- **Privacy affordance**: `waifus memory forget-user <discordUserId>` + HTTP equivalent deletes
  memories whose subject is that user and their DM history.

### 6.6 Context compaction (per context, own model)

- **Context key** = `(agent, conversation)` where agent ∈ waifu id | orchestrator | stage-manager
  and conversation = guild channel or DM. Stored in
  `user/conversations/<conversationKey>/contexts/<agent>.json`:
  `{ epoch, cursorMessageId, summary, memorySnapshotIds, notes[] (anchored to message ids),
  refCounter, tokenCalibration, updatedAt, revision }`.
- **Token budget**: estimate prompt tokens (chars/3.5 heuristic, calibrated per model by returned
  `usage.inputTokens` vs estimate, persisted); limit from the gateway registry `contextTokens`;
  budget = `contextTokens × compaction.triggerRatio` (default 0.7) − max output tokens.
- **Trigger** (checked before building a prompt): estimate > budget, or transcript since cursor >
  `compaction.maxMessages` (default 150), or a gateway `context_overflow` error (new kind, §5) →
  compact, then retry once.
- **Compaction call** = the *same* request prefix (system A + epoch header B + transcript up to C,
  identical tool definitions with `tool_choice: none`) + a final instruction: "Summarize the
  conversation so far from your own perspective for your future self: people, ongoing threads,
  promises, running jokes, how you feel about each person, unresolved questions. Keep the last
  `keepRecent` messages out of the summary." → mostly cache reads on providers with caching.
  Output replaces the summary; cursor advances to keep the newest `compaction.keepRecent`
  messages (default 30) verbatim; the memory snapshot is re-selected; notes before the cursor are
  dropped. Facts worth long-term memory are passed to the observer queue, not only the summary.
- **Window semantics**: transcript starts at the cursor and only grows until the next compaction —
  this is what makes breakpoint C cacheable. Discord fetches page back to the cursor (bounded by
  `maxMessages`); the old message-count `contextWindow`s become hard caps.
- **Concurrency**: single-flight per context under its resource lock; a reply never waits longer
  than a timeout — on timeout it proceeds with hard truncation and compaction completes in the
  background.
- **Settings** (registry §7): `compaction.enabled`, `triggerRatio`, `maxMessages`, `keepRecent`;
  per-server override optional. No separate compactor model (each context uses its own model).

### 6.7 Evaluation

- Extend `tests/eval` scenarios with: reply-marker correctness, verbosity adherence, no
  impersonation/name-prefix leaks, memory subject correctness, cross-server memory recall,
  compaction continuity (facts from the summarized part still used), cache-hit ratio on a scripted
  20-turn conversation (fake provider reports cache reads).
- Offline golden tests snapshot the rendered prompts for each layout/mode so prompt changes are
  reviewable diffs.
- Offline cache-hit simulation: a fake transport reports `cacheReadTokens` as the longest common
  block prefix with the previous request of the same `promptCacheKey`; a scripted 20-turn
  conversation must reach ≥ 0.8 cache-read ratio for waifus and the orchestrator.

### 6.8 Implementation decisions (2026-10-23, from code-reality review)

- **Single system message.** The Anthropic/Google codecs hoist every `role:"system"` message into
  the top-level system prompt, so only `messages[0]` may be system. Retry notes, the JSON nudge for
  schema tools, and all notes are user-role content (otherwise they silently rewrite breakpoint A).
- **Images**: each message's image mode (inline vs OCR text) is frozen the first time it renders
  (`maxInlineImagesPerEpoch`, default 8; a failed fetch freezes to text), so aging never rewrites
  the prefix.
- **Merged user turns**: one text block per Discord message inside a merged user turn, so appending
  never changes earlier blocks; the ephemeral tail is an uncached final block.
- **Stable tool schemas**: the orchestrator tool schema is fixed per channel config; "reply
  required" and "directive budget" move to the tail and stay enforced in code. `add_memory` and
  `PickNextWaifu` stay listed; suppression ignores a call instead of removing the tool.
- **Refs**: one ref table per conversation (`user/conversations/<key>/refs.json`) shared by all
  agents; refs are base-36 starting at `a0`.
- **Storage keys**: contexts live in `user/conversations/<key>/contexts/<agent>.json` with keys
  `g_<guild>_<channel>` and `dm_<user>_<waifu>`; `user/dms/` holds DM-only state (rate limits).
- **B29**: `ServerConfig.contextWindows.*` become optional overrides (precedence: explicit server
  override > agent/waifu value); a migration drops server keys equal to the old defaults
  (20/50/80). `contextWindow` max raised to 200; effective compaction trigger =
  `min(compaction.maxMessages, cap)`, `keepRecent` clamped to `floor(cap × 0.6)`.
- **Stage manager** keeps only an observer cursor (no compaction — it is a batch job).
- **One-shot** production state uses absolute `HH:MM` times + `now`; the decision benchmark keeps
  its documented age rendering.
- **Defaults**: `verbosity: "terse"` (matches today's tuning); cache TTL 5m at A/B/C (1h for A/B
  later if cost data supports it); dream hour 5, `maxPinnedInjected` 6,
  `maxMemoryNotesPerEpoch` 6.
- **Observer ops**: update/merge/expire and importance ≥4 adds apply immediately through the dedupe
  gate; lower adds queue for the dream. The dream ignores per-server `stageManagerEnabled` (that
  flag gates observers only).
- **Dedupe gate** is report-only for user-created memories (returns `duplicateOf`, never blocks).
- **forget-user** deletes memories whose subjects include the user (multi-subject memories
  included), their pending observations and DM contexts; guild context summaries keep the user
  until the next compaction (documented limitation). The assistant's `forget_user` tool uses a
  two-step confirmation token until B18's confirmation cards land.
- **Orchestrator `promptSections`**: `pausePlanning` kept; `messageStructure` deprecated/ignored.
- **Layout removal migration**: a disabled `schedule` block → `scheduleInPrompt: false` (new waifu
  field); a disabled persona block is ignored; legacy layout migrations are removed.
- **Usage ledger**: every model call appends one line to `user/usage/YYYY-MM-DD.jsonl` with
  attribution (purpose, waifu/agent, conversation), tokens incl. cache, cost — the data source for
  I3. Quota/billing errors open a per-provider cooldown surfaced in `/api/runtime`.
- **Gateway pin**: Phase 4 develops against the local gateway build (`npm run gateway:local`);
  the phase merges to `main` only after `@waifucave/gateway@0.4.0` is on npm and the pin is bumped.

## 7. Settings registry, CLI, HTTP, and help

### 7.1 Current state (inventory 2026-10-23)

- HTTP covers nearly every setting (all PUT-with-merge; no PATCH). No route returns descriptions or
  schema metadata; `/api/docs` serves hand-written markdown only.
- The CLI changes exactly one setting (`update --auto` → `updates.enabled`). There is one static
  `printHelp()`; `waifus start --help` **starts the app** (flag ignored).
- The CLI never talks to the running host; it reads `app/runtime.json`/`pid.json` and edits files.
  Loopback requests without Origin/Cookie/CSRF/Sec-Fetch headers are already the trusted `local`
  principal (`src/api/browserSecurity.ts:62-68`), so a CLI client needs no token.
- Not settings yet: dream hour (`DREAM_HOUR_LOCAL`), debug log routes (Discord-only), persistent
  pause via runtime routes (B2).
- Gotchas a generated surface must respect: `server.channels`, `discord-bots.waifus[]`,
  `promptLayout`, `availability` replace wholesale; channel PUT body defaults `enabled: true` (fix);
  `params`/`botId`/`providerId`/`modelId` use null-to-unset; waifu + memory writes require
  revision; remote-access revision is a uint64 string; `http.host`, `frontend.staticDir`,
  `updates.*` are local-only; every route must be in `ROUTE_POLICY_MANIFEST`
  (`src/api/routePolicyManifest.ts`) or startup fails.
- zod 4.4.3 is installed; `z.toJSONSchema` / `z.registry` already used in remote contracts.

### 7.2 Design

**Single registry** `src/shared/settings/registry.ts`, one entry per setting group:

```ts
type SettingGroup = {
  id: string;                         // "app.ocr", "app.runtime", "app.updates", "app.http",
                                      // "waifu", "waifu.dm", "waifu.availability", "server",
                                      // "channel", "agent", "bot", "provider", "memory",
                                      // "compaction", "remote-access", ...
  title: string; description: string;
  scope: "global" | "waifu" | "server" | "channel" | "agent" | "provider" | "bot" | "memory" | "remote";
  idParams?: readonly string[];       // e.g. ["waifuId"], ["guildId", "channelId"]
  storage: string;                    // "config.toml", "user/waifus/:waifuId/waifu.json"
  schema: z.ZodType;                  // the existing schema, never a copy
  read:  { method: "GET"; path: string };
  write?: { method: "PUT" | "POST"; path: string;
            revision: "required" | "optional" | "strict-string" | "none" };
  keys?: Record<string, { secret?: true; localOnly?: true; nullUnset?: true;
                          merge?: "params" | "replace"; notes?: string }>;
  notes?: string[];
};
```

- Descriptions/examples live on the zod schemas via `.meta({ description, examples })` so
  `domain.ts`/`config.ts` remain the single source. JSON Schema via
  `z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })`.
- **HTTP**: `GET /api/help` (index: groups, routes, CLI equivalents, plus every non-settings
  endpoint with a one-line description) and `GET /api/help/:topic` (topic = group or dotted key, e.g.
  `waifu.dm.rateLimit`) → description, scope, storage, routes, revision rule, JSON Schema, default,
  `secret`/`localOnly`, notes, CLI example. Both registered `safe()` in the route manifest. Topic
  validated by registry lookup. Gaps closed: `PUT /api/debug/routes` (debug log routes), dream hour
  setting, persistent pause (`POST /api/runtime/pause` persists — B2).
- **CLI** (all commands get real per-command `--help`; `--help`/`-h` never starts anything):
  - `waifus help [topic]` — rendered locally from the registry (works offline).
  - `waifus config list [group]`, `waifus config get <group>[:<id>] [key]`,
    `waifus config set <group>[:<id>] <key> <value> [--json] [--unset]`.
  - Thin per-resource aliases: `waifus waifu list|get|set|create|delete`, `waifus server …`,
    `waifus channel <guildId>/<channelId> …`, `waifus agent <orchestrator|stage-manager|reviewer|assistant> …`,
    `waifus bot …`, `waifus provider set-key <id>` (key from stdin / hidden prompt, never argv),
    `waifus memory list|add|edit|pin|delete`, `waifus runtime pause|resume|reload [--persist]`,
    `waifus usage [--by waifu|server|day]` (I3), `waifus dm forget <waifuId> <userId>`.
  - Transport: loopback HTTP to the running host (port from `runtime.json` after pid-alive check),
    GET → PUT with revision → one retry on 409 (same as assistant `revisionedPut`). Offline, only
    `app.*` keys may be written directly to `config.toml`; `user/*` writes require the running host
    so `validate()`, reloads and digests still run.
  - Value coercion from the key's leaf schema; JSON for objects/arrays; `--unset` → `null` for
    `nullUnset`/`params.*` keys; wholesale-replace fields are rebuilt from the GET result.
  - `--json` output mode on every read command for scripting.
- **Assistant**: generated `docs/assistant-kb/settings.md` (snapshot test fails when stale); new
  read-only `get_setting_help(topic)` tool; new `update_app_config` tool.
- **Drift tests**: every registry route exists in `ROUTE_POLICY_MANIFEST`; every settings write
  route in the manifest is in the registry or explicitly excluded; every leaf key has a
  description; `localOnly` keys match the server's 403 checks; generated KB matches committed.

## 8. Phase plan

| Phase | Branch | Content |
|---|---|---|
| 1 | `phase-1-critical-fixes` | B1–B14, B21–B25, B27 (core bot correctness) |
| 2 | `phase-2-cleanup-structure` | §3.4 dead code, remote decoupling remainder, `runtime.ts` split, docs fixes |
| 3 | `phase-3-llm-layer` | §5 decision; G1–G11; I1 transport side; I3 usage/cost plumbing; I5 |
| 4 | `phase-4-prompting-memory` | §6: new waifu/orchestrator/memory prompts, compaction, global memories (D2), B28–B29, I7–I8 (I9 lands in Phase 1) |
| 5 | `phase-5-discord-features` | §4 DMs + rate limit, I2, I6, I10–I12, I15–I16 |
| 6 | `phase-6-settings-surface` | §7 registry → CLI + HTTP + help; I17 |
| 7 | `phase-7-dashboard` | B15–B20, B26, I3/I4 UI, I13, I14 |

Order rationale: correctness first; the structural split precedes the prompt redesign that edits the
same files; the LLM layer decision precedes caching/compaction, which depend on it; the settings
registry follows the new settings (DMs, rate limit, compaction) so it is generated once.

## 9. Owner answers and open questions

Answered 2026-10-23:
- **Rate limit** → per user, DMs only (§4).
- **Remote Access** → it is a shipped feature (beta since 2.111.x, helpers 0.1.13), not dead code.
  Keep it (D5): decouple from boot/update/release, move the test-vector/contract-only TS out of
  the shipped `src/shared` into dev tooling, fix B27. No removal.
- **Experiments** → keep one-shot mode, Laya local Python, the decision benchmark, and
  deterministic mode. They are excluded from dead-code removal; they get updated to the new prompt
  design (§6) where they share prompt code.
- **winter-agent-sdk** → not a replacement (§5).

Open:
- _none yet_
