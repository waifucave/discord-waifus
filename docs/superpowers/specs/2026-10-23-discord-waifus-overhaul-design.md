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
- DM sessions/history stored under `user/dms/<waifuId>/<userId>/…`; covered by GDPR-style
  per-user deletion via CLI/HTTP.
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

Status: **proposed — needs owner review before Phase 4.**

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

### 6.2 Principles

1. **Stable prefix, volatile tail.** Everything that changes per turn goes at the *end*.
   Everything before it is append-only within a compaction epoch, so provider prompt caches hit.
2. **Code owns protocol, the model owns voice.** Reply targets, mentions, splitting, and speaker
   identity are decided/structured by code, not by text conventions the model must emit.
3. **One source per rule.** A single per-waifu `verbosity` setting drives the prompt wording, the
   validator, and the splitter.
4. **Memories are about people.** Global per waifu (D2), keyed by stable Discord user ids, rendered
   with subject + provenance.
5. **Compaction is per conversation, shared.** One rolling summary per channel/DM, written once,
   reused by every waifu and the orchestrator.

### 6.3 Waifu prompt (new layout)

```
[system]  ── cache breakpoint A (static per waifu; changes only when config changes)
  <harness>        ~250 words, shared wording: what this is (live Discord chat with real people
                   and other characters), you write only your own messages, plain chat text,
                   no names/prefixes/narration/meta, how images/replies appear, emoji usage.
  <identity>       name, server-agnostic nickname rules, roster of other characters (ids → names)
  <persona>        user persona text
  <style>          verbosity rule (one sentence generated from `verbosity`), persona digest voice
  <schedule>       sleep/busy routine (static)
  <custom>         optional per-waifu custom instructions (user-written, new field)
[user]    ── cache breakpoint B (changes only on compaction)
  <conversation_summary>  rolling summary of earlier conversation in this channel/DM (if any)
[transcript]  append-only since the compaction cursor ── rolling cache breakpoint C at the last
              fully-stable message
  user turns: consecutive non-own messages merged into ONE user turn; each line
              `[14:02] Kevin (reply to Aria): body` with absolute local times; gap notes
              ("— 3 hours later —") derived from absolute times; images inline only for the newest
              N (OCR text for the rest).
  assistant turns: this waifu's own messages, raw body.
[final user/system note]  ── volatile tail, never cached
  <now>            current local time + waifu's current activity (busy/sleepy/awake)
  <room>           who is present right now, server/channel name, server emojis (or DM context)
  <memories>       retrieved memories (≤ memoryInjectionLimit, pinned capped)
  <direction>      orchestrator directive for this turn (intent + goal), if any
  <turn>           one line: "Write Aria's next message, replying to Kevin's latest." (code-chosen)
```

- **Reply targeting by code**: the orchestrator decision gains `replyToMessageId` per responder
  (defaulting to the newest human message that triggered the turn when not the immediately
  previous message). The waifu never writes `replying to >`; `extractReplyQuote` and its fuzzy
  matching are deleted.
- **Stop sequences** shrink to the generic `\n[` timeline-header guard plus own-name; the
  `Name:` leak/impersonation strippers remain as a safety net but should rarely fire.
- **Retry** uses a system/developer note ("Your last draft was rejected: <reason>. Write it
  again.") — never a user turn with the waifu's name.
- **Validator** thresholds come from `verbosity` (`terse` ≈ 1 short line, `chatty` ≈ 1–3 lines,
  `expressive` ≈ up to a paragraph); the splitter uses the same profile; the soft-length bypass is
  removed (length violations either trim at a sentence boundary or retry once).
- **Tools**: `add_memory` stays (now global); tool list and `<tools>` text no longer toggle per
  turn (suppression handled by ignoring the tool call instead), so the system prompt stays stable.
- **Prompt layout editor**: keeps per-waifu reorder/enable/group within the **static zone** only;
  volatile blocks are fixed in the tail zone (UI shows "cached" vs "live" zones). Migration maps
  old block ids 1:1 where they exist (`identity`, `persona`, `schedule` → static; `roomInfo`,
  `relevantMemories`, `currentlyDoing`, `directorNote` → tail; `ioFormat`, `outputContract`,
  `tools`, `anchor` → folded into `harness`/`style`); user groups inside the static zone preserved;
  anything unmappable resets to default (precedent: `migrateWaifuPromptLayoutW2`).
- **Caching transport** (Phase 3): gateway sends Anthropic `cache_control` at breakpoints A/B/C,
  OpenRouter cache hints for Anthropic/Gemini routes, OpenAI `prompt_cache_key` = waifu+channel.

### 6.4 Orchestrator prompt (model + one-shot modes)

- **System (static, cached)**: concise director rules (~350 words, rewritten without the
  quiet-vs-cast contradiction — the rules state the cadence policy that code enforces), casting
  cards (id, digest voice, "cast her when"), decision schema guidance. Custom `orchestrator.prompt`
  is appended as `<owner_policy>` in model mode too (B28).
- **Summary + transcript**: same compaction summary and append-only absolute-time transcript as
  waifus; past decisions replayed as compact tool calls (unchanged idea, but without per-message
  ages). Each message line carries its Discord message id (short ref) so the decision can set
  `replyToMessageId`.
- **Volatile tail**: `[now]`, hour, availability of each waifu, loop/cadence `runtime_notice`, wake
  marker (with the correct scheduling source, B8).
- **Decision schema**: adds `respondingWaifus[].replyToMessageId?`; otherwise unchanged
  (directives, wakePlan, retrigger). Deterministic and one-shot modes stay (owner decision) and
  consume the same context builder; one-shot's JSON state uses absolute times too.
- Stage manager / observer and reviewer get the same stable-system + transcript + tail shape; the
  stage-manager custom prompt is honoured (B28).

### 6.5 Memory (global)

- **Scope**: `MemoryRecord.guildId` → optional `origin { guildId?, channelId?, dm?: true }`
  (provenance only). Retrieval, dedupe, dream, and the API ignore guild for filtering.
  `GET /api/memories?guildId` becomes a provenance filter. Migration: existing records keep their
  guild as `origin.guildId`; cross-guild duplicates merged by the first global dream pass (and a
  one-time dedupe at migration using normalized-text similarity, conservative threshold).
- **Subjects**: `subjects: [{ discordUserId?, waifuId?, name }]` replaces display-name `entities`
  (names refreshed at render time from the member cache). Rendered as
  `- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)`.
- **Retrieval score**: subject match with people present in the conversation (strong boost) +
  Unicode-aware lexical match (`\p{L}\p{N}` tokenizer, CJK bigrams) + recency + strength +
  same-origin-channel small boost − diversity penalty (recently injected, via `lastRetrievedAt`).
  Pinned memories capped (`maxPinnedInjected`, default 6, ranked by score). Waifu's own lines get
  lower weight in the query window than human lines.
- **Writing**: the observer sees the existing memories for the current participants and emits
  ops (`add | update | merge | expire`) instead of blind adds; everything goes through one
  dedupe gate (normalized similarity + same subject). Observer keeps a last-seen message cursor
  per conversation (I8). `add_memory` tool notes keep the 72 h TTL for `context` notes.
- **Dream pass**: one global schedule (configurable hour, new setting) iterating waifus
  round-robin with a persisted cursor and per-night budget (fixes B12), allowed waifu ids include
  observation owners.
- **DMs**: DM conversations feed the same global memory (owner: "global across everywhere").
- **Privacy affordance**: `waifus memory forget-user <discordUserId>` / HTTP equivalent deletes all
  memories whose subject is that user (plus DM history) — needed once memories span servers.

### 6.6 Context compaction

- **Per conversation** (channel or DM) store `user/conversations/<key>/summary.json`:
  `{ summary, cursorMessageId, cursorAt, coveredMessages, model, updatedAt, revision }`.
- **Token budget**: estimate prompt tokens (chars/3.5 heuristic, calibrated per model by the ratio
  of returned `usage.inputTokens` to the estimate, persisted). `contextTokens` from the gateway
  registry; budget = `contextTokens × compaction.triggerRatio` (default 0.7) minus max output.
- **Trigger**: before building any prompt for that conversation, if estimate > budget **or**
  transcript since cursor > `compaction.maxMessages` (default 120) → compact. Also on a gateway
  `context_overflow` error (new error kind, §5): compact then retry once.
- **Compaction**: summarize everything before the newest `compaction.keepRecent` messages (default
  30) into an updated neutral, third-person summary (who's who, ongoing threads, promises, running
  jokes, relationship shifts, unresolved questions) via the configurable `compactor` agent
  (defaults to the stage-manager target, else the cheapest configured model); advance the cursor.
  Facts worth keeping long-term are handed to the memory observer, not kept only in the summary.
- **Window semantics**: the transcript starts at the cursor (append-only until the next
  compaction) — this is what makes breakpoint C cacheable. Discord fetches page back to the cursor
  (bounded by `maxMessages`); message-count `contextWindow`s become caps, not the primary limit.
- **Concurrency**: compaction runs under the conversation's resource lock, is single-flight per
  conversation, and never blocks a reply for longer than a timeout — on timeout the turn proceeds
  with hard truncation and compaction finishes in the background.
- **Settings** (registry §7): `compaction.enabled`, `triggerRatio`, `maxMessages`, `keepRecent`,
  `compactor` target; per-server override optional.

### 6.7 Evaluation

- Extend `tests/eval` scenarios with: reply-target correctness, verbosity adherence, no
  impersonation/name-prefix leaks, memory subject correctness, cross-server memory recall,
  compaction continuity (facts from the summarized part still used), cache-hit ratio on a scripted
  20-turn conversation (fake provider reports cache reads).
- Offline golden tests snapshot the rendered prompts for each layout/mode so prompt changes are
  reviewable diffs.

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
