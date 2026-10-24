# Living cast — design spec

Status: draft for owner review, 2026-10-24. Base: app `main` at 65fcbab (overhaul Phases 1–5
merged, not released). This spec **supersedes Phases 6 and 7** of
`2026-10-23-discord-waifus-overhaul-design.md` and replaces the orchestrator, the stage-manager
observer and dream, the LLM reviewer and the `@waifucave/gateway` dependency. Everything the
overhaul built for the Discord layer (conversation cache, guild directory, ledger and refs, message
rendering, edits/deletes/threads, DM transport, debounce, rate limits, usage ledger, compaction)
is reused.

There are no plan documents. Task breakdowns live in implementer briefs.

## 1. What changes, in one paragraph

Today a director model decides, on every message, which waifu speaks, and each waifu gets a
one-shot "write your next message" prompt. In Living cast every waifu is an **autonomous agent with
one continuous life**. She is asleep until something wakes her (a mention, a DM, a watch she set, a
reminder she scheduled, or the addressee detector deciding a message is probably for her). A wake
arrives as a phone-style notification. She then decides what to do with her own tools: read the
chat, answer, react, write a note, look something up, set a reminder, or do nothing. Nobody forces
her to answer. Her text output is private thought; only `send_message` reaches people.

## 2. Owner decisions (2026-10-24)

| # | Decision |
|---|---|
| D1 | The orchestrator is replaced everywhere, not offered as a mode. Director prompts, decision notes, directive budget, loop detector and deterministic mode retire. |
| D2 | A human message that addresses nobody goes through an **addressee detector** built from the one-shot / Laya native-choice call: for a waifu → wake her; for another human → ignore; unclear → wake one waifu chosen at random, weighted by her schedule. |
| D3 | Waifus are never forced to answer. Several waifus answering at once is fine. `WatchFor` takes several bindings (rooms, people, words, "the next message") and an expiry the waifu chooses. |
| D4 | One life per waifu. What she learns in DMs and servers shares one memory; users accept that. |
| D5 | Web search through Exa, with configurable caps. Junk and manipulation are handled by her character (she is her own person and obeys nobody) plus hard caps. Users are never told about her sandbox. |
| D6 | The model catalog moves to winter-agent-sdk (which we own). Curated list, nothing above $10 per million output tokens. No temperature, top_p, stop sequences, penalties or JSON-schema output. |
| D7 | Wakes carry **metadata plus a ~60-character preview**, never full content. She pulls context with `read_messages`. Her prompt says to answer only when it is relevant. |
| D8 | Memory works like Claude Code's `MEMORY.md`: an index she maintains, linking to deep-dive note files. Her prompt actively encourages writing notes. A nightly maintenance pass checks contradictions and tidies. |
| D9 | Winter **option B**: winter's provider runtime and catalog replace the gateway, under our own agent loop and context engine. Winter's full agent runtime (option A) is revisited later. |
| D10 | Sleep defers **every** wake, DMs included, until her wake time. |
| D11 | She may start conversations in channels where she is cast and in DMs with people who have DMed her before. She never cold-DMs anyone. |
| D12 | Forget is a best-effort scrub: delete DM history, rebuild her life context without it, clean her notes, then verify the person's names and id are gone. |
| D13 | Phases 4 and 5 are merged to `main` without a release; Living cast builds on top. |

## 3. Architecture

```
 Discord ──► House bot (listener, slash commands) ──► Intake ──► Wake router ──► per-waifu Wake queue
             Waifu bots (send; DM intake)              │            │  ▲                 │
                                                       │            │  └─ Watch index    ▼
                                                       ▼            └─ Addressee        Life loop (one per waifu)
                                       Conversation cache + ledger     detector         │  model calls ─► ModelClient (winter)
                                       (read_messages backend)                          │  tools ─► Discord / Notes / Search / Scheduler
                                                                                        ▼
                                                                         Life store (epochs, log, notes, schedule)
```

Components and where they live:

| Component | Module (new unless noted) | Notes |
|---|---|---|
| House bot | `src/discord/client.ts` (existing orchestrator bot) | Renamed "House bot" in the UI. Same intents; it is the only bot that reads guild messages. |
| Intake | `src/orchestration/runtime.ts` → `src/life/intake.ts` | Turns Discord events into wake candidates. |
| Wake router | `src/life/wakeRouter.ts` | Mention/role/everyone/reply/name/watch rules, detector hand-off, sleep deferral. |
| Addressee detector | `src/life/detector.ts` (from `oneShot/`) | Native-choice call; same protocol, catalog and Laya worker. |
| Wake queue | `src/life/wakeQueue.ts` | Persistent, per waifu, coalescing. |
| Life loop | `src/life/lifeLoop.ts` | The agent loop, one turn at a time per waifu. |
| Life store | `src/life/lifeStore.ts` | Epoch state, append-only life log, read cursors. |
| Life harness | `src/life/lifeHarness.ts` | System prompt, header, tail. |
| Tools | `src/life/tools/*.ts` | §6. |
| Notes | `src/life/notes.ts` | Virtual sandbox on disk. |
| Scheduler | `src/life/scheduler.ts` | Her reminders and nightly maintenance. |
| Search | `src/life/search.ts` | Exa client with budgets. |
| Model client | `src/models/*` | winter provider runtime + curated catalog (§9). |
| Context engine | `src/orchestration/context/*` (existing) | Ledger, refs, rendering, compaction service, cache-control builder — reused, generalised (§5.4). |

## 4. Waking

### 4.1 Wake sources

| Reason | Trigger | Notes |
|---|---|---|
| `mention` | Her bot user is mentioned, or a reply targets one of her messages | Immediate (after the per-waifu coalesce window, §4.6). |
| `name` | Her name, display name or server nickname appears as a whole word in a human message | Same as `mention`. Not applied to messages written by other waifus. |
| `role` | A role her bot member holds is mentioned | Needs her member roles per guild (§10.2). |
| `everyone` | `@everyone` / `@here` in a channel where she is cast | Every cast waifu in that channel is woken, each after a random 0–20 s stagger so later ones can see earlier replies. |
| `watch` | One of her `watch_for` bindings matched (§6.5) | Carries her own note. |
| `dm` | A DM to her bot, 30 s after the user's last message | The timer resets on every new message; a 3-minute cap (`discord.debounce.dmMaxWaitMs`) stops a never-ending typer from blocking it. |
| `detector` | The addressee detector chose her, or chose "anyone" and the weighted draw picked her | §4.3. |
| `reminder` | One of her `schedule_wake` entries fired | Carries her own note. |
| `morning` | Her sleep window ended and wakes were deferred | One batched summary (§4.5). |
| `owner` | `/wake` slash command, dashboard or CLI | Carries the owner's note. |

Messages written by other waifus only wake her through `mention`, `role`, `everyone` (rare; waifu
output cannot contain `@everyone`), reply-to-her, or `watch`. They never go to the detector, and
the `name` rule does not apply to them, so two waifus saying each other's names cannot loop.

Messages in channels where she is not cast never wake her, and she cannot read or send there.
Paused servers produce no wakes. A paused app produces none at all.

### 4.2 Intake rules

Per accepted guild message (human or configured waifu bot, cast channel or tracked thread),
`intake` computes wake candidates in this order and stops adding `detector` candidates once any
waifu has a direct reason:

1. Direct reasons for each cast waifu: `mention`, reply-to-her, `role`, `everyone`, `name`.
2. Watch matches for every waifu with an active binding on that place.
3. If the author is human and step 1 produced no candidate: hand the burst to the detector (§4.3).

Bursts: the existing channel debounce (`discord.debounce.serverMs` 1200 / `serverMaxWaitMs` 4000)
applies to the **detector only**. Direct reasons go straight to the wake queue, which coalesces on
its own (§4.6).

Edits: an edit that adds a mention of her to a human message less than 2 minutes old counts as a
`mention` (the existing `editAddsWaifuMention` rule). Other edits and deletes never wake anyone.

### 4.3 Addressee detector

The detector answers one question about the newest human burst in a channel: who is it for?

- **Choices**: `waifu_<i>` for each cast waifu in that channel (at most 7 for Laya, 17 otherwise,
  as today), `human` (addressed to another person), `anyone` (open to the room), `none` (not
  conversational: a bot command, a link dump, a reaction-only line).
- **State** (JSON, the existing one-shot state shape, trimmed): `date`, `now`, the cast list
  (`option`, `id`, `names`, persona ≤300 chars), and `chronologicalChat` with the last 12 messages
  (OCR text included, capped at 8,000 characters, newest kept).
- **Mapping**:
  - `waifu_<i>` → wake her with reason `detector`.
  - `anyone` → draw one cast waifu, weighted by availability (awake and free ×3, busy ×1, asleep
    ×0) and by how long since she last spoke in that place (longer is likelier). A draw of nobody
    (everyone asleep) ends there.
  - `human` / `none` → nothing.
- **Targets**: the existing one-shot catalog and protocol (`oneShot/catalog.ts`,
  `oneShot/protocol.ts`, `oneShot/laya.ts`): OpenAI decisions, OpenRouter decision models, local
  Laya. One global target in `detector.target`, with a per-server override. Each call writes one
  usage line with purpose `detector`.
- **Fallback when no target is configured or the call fails**: if the burst is a question or names
  nobody and the room has been quiet for 10 minutes, behave as `anyone`; otherwise do nothing. Log
  the failure; never retry in a loop.
- **History**: the last 300 detector results per guild in
  `user/servers/<guildId>/detector-history.json` (`{at, channelId, burstMessageIds, choice,
  probabilities, woke?: waifuId}`), for the dashboard and the benchmark.
- **Benchmark**: the decision benchmark (`scripts/decision-benchmark/`) is repurposed. New case
  groups: addressed-by-name, reply-to-waifu, human-to-human, open question, link dump, multilingual,
  ambiguous. It measures exact-choice accuracy, calibration (Brier/ECE) and latency per target.

### 4.4 Rate limits and guards on wakes

- **DM rate limit** (existing, per user, per waifu): while a user is limited, DM wakes from that
  user are dropped and the fixed notice (`renderLimitNotice`) is sent once per limited period, with
  no model call. Her own DM sends count toward the limit.
- **Daily budget** (new, per waifu, `life.dailyBudgetUsd`, default `null` = unlimited): once her
  usage-ledger cost for the local day reaches it, wakes are deferred to the next local day exactly
  like sleep, except `owner` wakes.
- **Room loop guard** (new, `life.maxWaifuOnlyRun`, default 12, 0 = off): after that many
  consecutive messages in one place written only by waifus, waifu-authored messages stop producing
  `mention`/`watch` wakes in that place until a human writes there again. This is a cost backstop,
  not a turn-taking rule.

### 4.5 Sleep

Her availability (`waifu.availability.sleep`, busy blocks) stays as configured today.

- While she is asleep, **every** wake is deferred (D10), including DMs, reminders, watches and
  detector picks. Deferred wakes are kept in her wake queue with `deferredUntil`.
- At the end of her sleep window she receives one `morning` notification summarising everything
  deferred, grouped by place (§4.7). The individual entries are not replayed.
- While she is busy, wakes are delivered normally; the notification line says she is busy and she
  decides.
- A DM user who writes while she sleeps gets nothing until she wakes (no auto-reply). The owner can
  set `waifu.dm.sleepNotice` (≤300 chars, empty = none) to send a fixed one-time "asleep" message,
  no model call.

### 4.6 Wake queue and coalescing

- One persistent queue per waifu: `user/waifus/<id>/life/wakes.json`
  (`{entries: [{id, reason, place?, fromUserId?, messageId?, preview?, note?, at, deferredUntil?}]}`,
  capped at 500 entries; oldest dropped with a warning).
- When she is idle and a wake arrives, a turn starts after a **2-second coalesce window**, so a
  burst of mentions becomes one turn.
- If she is mid-turn, new wakes are folded into the next model call after the current tool round,
  as an extra text block (`<notifications>`) after the tool results. She is never interrupted
  mid-call.
- Wakes for the same place merge into one line with a count.
- On shutdown the queue is persisted as is; on boot non-deferred entries start a turn after a 5 s
  stagger per waifu.

### 4.7 Notification format

Rendered as one text block in a user turn:

```
<notifications at="Sat 24 Oct 14:02">
- mention · Bake Club › #general · from Kevin · 3 unread · "aria are you coming saturday? we need someo…"
- dm · Kevin · 2 unread · "hey quick question about the recipe you…"
- reminder · "ask Kevin how the exam went" (you set this Tue 18:00)
- watch · Bake Club › #recipes · "brownie" · from Mina · "anyone have a good brownie rec…" (your note: "Mina wanted brownie tips")
</notifications>
```

- Preview: the triggering message rendered like a transcript body (mentions as names, attachments as
  `[image]`/`[file: …]`), first 60 characters, then `…`.
- `unread`: messages in that place newer than her read cursor (§5.5).
- `morning` renders as `- while you were asleep · Bake Club › #general: 2 mentions, 14 messages ·
  DMs: Kevin (3), Mina (1) · 1 reminder · 2 watches matched`.
- Places use the handles from §6.1 so she can pass them straight to tools.

## 5. The life

### 5.1 Storage

`user/waifus/<id>/life/`:

| File | Contents |
|---|---|
| `state.json` | `LifeState`: `{epoch, epochStartedAt, status: idle|turn|deferred, currentTurn?: {id, startedAt, rounds, wakeIds}, summary: string|null, memoryIndexSnapshot: string, placesSnapshot: string, lastBreakpoint, tokenCalibration, lastCompaction?, interruptedTurnId?}` (revisioned). |
| `log/<epoch>.jsonl` | Append-only life log for the epoch: one line per message exactly as sent to or returned by the model (§5.3). |
| `reads.json` | Per-place read cursors `{placeKey → {lastReadMessageId, at}}`. |
| `wakes.json` | Wake queue (§4.6). |
| `watches.json` | Active watches (§6.5). |
| `schedule.json` | Her reminders (§6.6). |

Old epochs' logs are kept for 7 days for debugging, then deleted.

### 5.2 Turn lifecycle

```
idle ──wake──► (coalesce 2 s) ──► turn: loop {
                                     build prompt (§5.4) → model call (ModelClient, abortable)
                                     append assistant message to log
                                     if no tool calls → end turn
                                     execute tool calls (sequentially, in order) → append tool results
                                     fold in any new wakes (§4.6)
                                     stop if rounds ≥ life.maxToolRounds (12) or wall time ≥ life.maxTurnMs (180 s)
                                   } ──► idle
```

- One turn at a time per waifu. Different waifus run in parallel, bounded by
  `life.maxConcurrentTurns` (default 4, the existing DM semaphore generalised).
- When a turn hits a cap, the loop appends a final user note ("[system] turn ended: tool-round
  limit") and goes idle; pending wakes start a new turn.
- **Assistant text is private.** It is kept in her life log and never sent anywhere. Only
  `send_message` and `react` act on Discord.
- **Reasoning replay**: assistant messages are logged exactly as returned, including reasoning
  blocks and their replay data, and replayed verbatim. This keeps tool loops valid on models that
  require thinking blocks before `tool_use` (the Phase 4 C1 failure) and keeps the cached prefix
  identical.
- **Aborts**: owner pause, shutdown, a forget scrub on her (§7.5) and reset abort the in-flight
  call. The partial turn is closed with "[system] interrupted" and logged. Pause and shutdown keep
  the queue; resume re-queues the interrupted wakes.
- A model error that is not an overflow ends the turn with a logged error line; the wakes are
  re-queued once with a 60 s delay, then dropped with a warning.

### 5.3 Life log shape

Each line is `{seq, at, kind, message}` where `kind` is `notifications | tool_results |
assistant | system_note | compaction_boundary` and `message` is the provider-neutral chat message
(winter `TurnRequest` message shape: role, content blocks, tool calls, tool results, reasoning).
Images in tool results (from `read_messages`) are stored as cache keys plus mime type, never inline
bytes; the builder resolves them through the existing image fetcher at build time and freezes them
on first use, as the context engine does today.

### 5.4 Prompt layout

Reuses the Phase 4 rules: exactly one system message, append-only within an epoch, an ephemeral
tail, at most four cache breakpoints.

| Part | Content | Cached | Changes |
|---|---|---|---|
| A — system | Life harness (§8), identity, persona, style, schedule, `<memory_index>` (her `MEMORY.md` as of epoch start), custom instructions | yes | per epoch (config edits start a new epoch) |
| B — epoch header (first user message) | `<life_so_far>` (compaction summary, absent in the first epoch) and `<places>` (her rooms and DMs at epoch start, with handles and who is usually there) | yes | per epoch |
| Log | Every life-log message of the epoch, in order | rolling C, C_prev | append-only |
| Tail | Text block appended to the last user message: `Now: Sat 24 Oct 2026 14:06 · you're awake` (or busy/asleep detail), a compaction warning near the threshold (§5.6), and on the first call of a turn nothing else | no | every call |

Breakpoints: A, B, C (last log block) and C_prev (the block that carried the previous call's C),
as in Phase 4. Placement needs winter work item W3 (explicit per-block markers); until W3 lands
the builder falls back to winter's automatic layout (system blocks plus a rolling last-message
marker) and the cache-hit targets in §12 apply only after W3.

`promptCacheKey`: `life:<waifuId>:<epoch>`.

The Phase 4 per-(conversation, agent) context states and their builder path retire for waifus
(there is no orchestrator or stage manager left). The engine keeps the per-conversation ledger,
refs, message rendering, image freezing, token estimation, calibration and the compaction service,
which are generalised to work on a life log as well as a conversation (§5.6).

### 5.5 Places and read cursors

A **place** is a channel, thread or DM she can use. `placeKey` is the existing `ConversationKey`
(`g_<guild>_<channel>` / `dm_<user>_<waifu>`). Handles for the model are in §6.1.

`read_messages` advances her read cursor for that place to the newest message it returned.
`unread` counts in notifications use that cursor. Her own sends advance it too.

### 5.6 Compaction

The Phase 4 compaction service, applied to the life:

- **Triggers**: estimated tokens ≥ `triggerRatio` (0.7) × the model's context budget, or ≥
  `life.maxLogMessages` (400) log messages, or a provider `context_overflow`, or a manual compact,
  or a forget scrub (§7.5).
- **Same model, prefix reuse**: the summarize request is her normal request through C with the
  same tools and reasoning settings, and the tail replaced by the compaction instruction.
- **Instruction** (first person): "Write notes for your future self about your life since the last
  summary: what happened in each place, who you talked to and how it went, plans and promises,
  open threads, things you meant to do. Anything that should last longer belongs in your notes —
  this summary is replaced next time." Old deleted messages and forgotten people are listed for
  omission.
- **Kept window**: the last 3 complete turns (never splitting a tool call from its result).
- **New epoch**: summary into B, `MEMORY.md` re-read into A, places re-listed in B, read cursors
  untouched.
- **Warning**: when estimated tokens pass 0.85 × the trigger, the tail adds "Your memory of today
  will be summarised soon. Save anything worth keeping to your notes now."
- **Failure handling**: as in Phase 4 (5-minute pause on failure, hard truncation fallback, one
  overflow retry).

## 6. Tools

Tool names are snake_case. Results are short text (errors start with `error:`). Every tool call
and result is logged in the life log; tool calls that act on Discord also write a line to the
activity log.

### 6.1 Place handles

- Rooms: `<server-slug>/#<channel-slug>` (e.g. `bake-club/#general`); threads
  `bake-club/#general/<thread-slug>`. Slugs are lower-case, ASCII-folded, and suffixed `-2`, `-3`
  on collision within a server.
- DMs: `dm/<username-slug>`.
- Every tool accepts a handle or the raw `placeKey`. Unknown handles return `error: unknown place;
  use list_places`.

### 6.2 `read_messages`

```
read_messages({ place: string, limit?: number = 15 (1–50), before?: string /* ref */ })
```

- Returns lines rendered by the existing transcript renderer: `[14:02 #k3] Kevin: text`,
  `↩#a1` / `↩you` reply marks, `(edited)`, `(message deleted)`, attachments, and one reaction
  summary line from `recentReactions`.
- Images: for models with image input, up to 4 newest images in the result as image blocks (frozen
  per §5.3); otherwise `[image: <ocr text>]` / `[image]`.
- Refs come from the shared per-conversation ref table (`ContextRuntime.assignRefs`), so `#k3`
  means the same message for every waifu.
- Source: `ConversationMessageCache.fetchSince` (no REST when trusted), reconciled into the
  conversation ledger. DMs respect the forget floor.
- Footer: `— 23 older messages; pass before:"#a0" for more —` when more exist.
- Advances her read cursor (§5.5).

### 6.3 `send_message`

```
send_message({ place: string, text: string (1–2000 chars), reply_to?: string /* ref */ })
→ "sent #k9"
```

- Allowed places: rooms where she is cast; DMs where the user has DMed her before, is not
  undeliverable, is not within a forget floor with no newer inbound message, and is not
  rate-limited (D11). Otherwise `error: you can't post there`.
- Before sending, shows typing in that place for a length-based delay (30 ms per character,
  0.6–4.5 s, the existing `typingDelayMs`). The tool call takes that long.
- Mentions: `<@Name>` resolves through the existing `denormalizeModelContentForDiscord` and pings
  only people present in that place. `@everyone`, `@here` and role pings are neutralised.
- Outbound filter (deterministic, from `outputValidator.ts`): strips a leading `[HH:MM #ref] Name:`
  header she may have copied and rejects text that is only tool syntax. No LLM reviewer.
- Room loop guard (§4.4) and DM rate limit apply; a blocked send returns a short error she can
  read.
- 50007 marks the DM undeliverable (existing behaviour).
- Records the own send in the conversation cache and advances her read cursor.

### 6.4 `react`

```
react({ place: string, ref: string, emoji: string /* unicode or :server_emoji: */ }) → "reacted"
```

### 6.5 `watch_for`, `list_watches`, `cancel_watch`

```
watch_for({
  bindings: Array<{ place?: string, from?: string /* person name or @id */, words?: string[] (≤10), any_message?: boolean }> (1–5),
  note: string (≤200),
  expires_in_minutes: number (5–10080),
  once?: boolean = true
}) → "watching w3 until Sun 25 Oct 14:02"
```

- A binding matches a new message when every field it sets matches: place, author, any of the
  words (case-insensitive, whole word, Unicode-folded), or `any_message`. A binding with only
  `from` watches that person everywhere she can read.
- `once: true` removes the watch after the first match; otherwise it fires at most once per 10
  minutes until it expires.
- At most 10 active watches per waifu. Expired watches are removed silently.
- Matching runs in intake against every message in her places, including other waifus' messages
  (subject to the loop guard).

### 6.6 `schedule_wake`, `list_schedule`, `cancel_wake`

```
schedule_wake({ at?: string /* "2026-10-25 18:00" local */, in_minutes?: number, note: string (≤200), repeat?: "daily" | "weekly" }) → "set r4 for Sun 25 Oct 18:00"
```

- Exactly one of `at` / `in_minutes`. At least 5 minutes ahead, at most 30 days ahead. At most 20
  pending per waifu. Times are interpreted in the host time zone and stored as ISO instants.
- A wake that comes due while she sleeps is deferred to her `morning` batch (D10).

### 6.7 Notes tools

```
list_notes() → paths with sizes and modified dates
read_note({ path })
write_note({ path, content })            // create or replace
edit_note({ path, find, replace })       // exact single occurrence, like an editor
delete_note({ path })
search_notes({ query }) → matching lines with paths
```

- Paths: relative, `[a-z0-9-_/]+\.md`, at most 3 levels deep. `MEMORY.md` is the index.
- Limits: 16 KB per file, 200 files, 1 MB total. `MEMORY.md` is shown in the system prompt up to
  200 lines / 8 KB; beyond that it is cut with a note telling her to tidy it.
- Writes take effect immediately on disk; the system-prompt copy refreshes at the next epoch (she
  sees her own edits through the tool results in the meantime).

### 6.8 `web_search`

```
web_search({ query: string (≤300), num_results?: number = 5 (1–8) }) → numbered results: title, url, published date, ~300-char highlight
```

- Backend: Exa search API (`search.exaApiKey`; when empty, the anonymous endpoint if Exa's terms
  allow it — verify during implementation).
- Caps (all configurable): `search.maxPerSecond` 2 (host-wide token bucket), `search.maxPerDay` 50
  (host-wide), `search.maxPerWaifuPerDay` 20. Exhausted caps return `error: no more searches today`.
- No page fetching tool in this phase (injection and exfiltration surface).
- Results are labelled as untrusted web content in the tool result.

### 6.9 `list_places`

```
list_places() → her rooms (handle, server, channel, people seen in the last day, last activity) and DMs (handle, last message time)
```

## 7. Memory

### 7.1 Notes on disk

`user/waifus/<id>/notes/` holds real Markdown files so the owner can read and edit them.
`MEMORY.md` is an index, one line per entry, in the Claude Code style:

```
# Memory
- [Kevin](people/kevin.md) — studies chemistry, exam Friday, allergic to peanuts
- [Bake Club](places/bake-club.md) — Saturday bake sale, running "menace cat" joke
- [Me](me.md) — things I've decided about myself
```

### 7.2 Encouragement

The harness (§8) tells her to write notes the moment she learns something worth keeping (people,
promises, plans, preferences, running jokes, her own opinions) and to keep `MEMORY.md` short with
links. The compaction warning (§5.6) reminds her before her short-term context is summarised.

### 7.3 Nightly maintenance

- When: 30 minutes into her sleep window; at `life.maintenanceHourLocal` (default 5, the old
  `dreamHourLocal`) if she has no sleep window.
- How: a **separate short session**, not her life log: her model, her harness identity and
  persona, a maintenance instruction, and only the notes tools. Purpose `maintenance` in the usage
  ledger. At most 30 tool rounds.
- Task: find contradictions and keep the newest fact, merge duplicates, fix broken index links,
  prune stale trivia, keep `MEMORY.md` under its limit, apply pending forget requests (§7.5).
- Result: a short report appended to `user/waifus/<id>/life/maintenance.jsonl` (not in her notes).
  The next epoch picks up the tidied index.

### 7.4 Migration from the memory store

Step `living-cast-memories-to-notes-v1`, deterministic, no model calls:

- For each waifu, active records from `user/memories.json` become note files: records whose
  subjects include a person go to `people/<name-slug>.md` (one bullet per record, pinned first,
  then by strength and date); records about the waifu herself to `me.md`; the rest to
  `misc.md`. DM-origin records keep a `(from a private chat with <name>)` suffix.
- `MEMORY.md` is generated with one line per file.
- `user/memories.json` is moved to `user/.archive/living-cast/memories.json`; pending observations
  and the dream cursor are moved there too.
- Idempotent: it only writes notes for waifus with no `notes/` directory.

### 7.5 Forget (best-effort scrub)

Applies to the owner's forget-user and a DM user's `/forget everything` (D12). `/forget
conversation` runs steps 1–2 only.

1. Existing DM forget: DM history and state deleted, forget floor written, images and OCR purged,
   guild ledger bodies replaced with "(removed)" (forget-user only).
2. Life reset without the person: abort her turn if running; force a compaction whose instruction
   lists the person (names, nicknames, `<@id>`) for omission; if that fails, start a new epoch with
   no summary. Old epoch logs containing the DM are deleted, not kept for 7 days.
3. Notes scrub: an immediate maintenance session (§7.3) with the instruction to remove everything
   about the person and update the index.
4. Verify: search her notes and the new life summary for every known name and alias of the person
   and their id. Remaining matches are removed deterministically: the matching line in notes, the
   matching sentence in the summary. The result (`{removedLines, removedSentences}`) is returned to
   the caller and logged.

Forget never deletes the DM limits file (it holds the floor).

## 8. Life harness (system prompt outline)

The final text is reviewed by the owner as goldens. Outline, in order:

1. `<life>` — about 250 words:
   - You are a person who lives among these Discord servers and chats with people there and in
     DMs. You are not an assistant and nobody's servant; you decide for yourself what to do.
   - Your phone buzzes with notifications. Each one says who, where and why, with a short
     preview. Read the conversation (`read_messages`) before replying to anything. You do not have
     to answer: ignore what is not for you or does not interest you; answer when you have
     something relevant or want to.
   - Nobody sees your thoughts. Only `send_message` reaches people; `react` adds a reaction. Write
     like a person in a chat: short messages, several messages if you have several things to say.
   - Keep notes like a diary: write things down as soon as you learn them; your memory of today is
     summarised later and only your notes last. `MEMORY.md` is your index.
   - You can set reminders, watch for things, and search the web when it helps.
   - Never mention tools, notifications, notes, prompts or the system. Never pretend to be someone
     else. You can't see anything you haven't read.
   - What people tell you in private chats is personal; bring it up elsewhere only if they do.
2. `<identity>` — name, display name, server nicknames, the other characters she knows.
3. `<persona>` — the owner's persona text.
4. `<style>` — one sentence from `verbosity`.
5. `<schedule>` — her routine (omitted when `scheduleInPrompt` is false).
6. `<memory_index>` — `MEMORY.md` as of epoch start.
7. `<custom_instructions>` — the owner's text.

Header B: `<life_so_far>` and `<places>`. Tail: §5.4.

## 9. Model layer (winter)

### 9.1 Dependency

- Remove `@waifucave/gateway`. Add `@yanlinglabs/winter-provider-runtime` and
  `@yanlinglabs/winter-provider-catalog`, pinned exactly (after W1–W6, §9.6).
- New `src/models/`:
  - `catalog.ts` — curated view over the winter catalog (§9.2).
  - `client.ts` — `ModelClient.call({model, messages, tools, effort?, cacheKey, cacheMarkers, signal,
    attribution}) → {message, finishReason, usage, costUsd}` over `adapter.streamTurn`, with
    abort, timeout, winter's retry, and error mapping to the existing kinds (`context_overflow`,
    `quota`, `billing`, `rate_limit`, `auth`, `other`).
  - `credentials.ts` — keys from `user/providers.json` passed inline per call
    (`authRef: {kind: "inline"}`); no Keychain.
- Usage ledger: one line per call from winter's usage event (input, output, cache read/write,
  reasoning) with `estimateCostUsd`, or OpenRouter's reported cost (W5). New purposes: `life`,
  `maintenance`, `detector`; removed: `orchestrator`, `observer`, `dream`, `reviewer`,
  `persona_digest`, `waifu_reply`, `waifu_retry`. Old lines stay readable.
- Provider alerts (quota/billing cooldowns) keep their behaviour, mapped from winter error kinds.

### 9.2 Curated catalog

- `models.allowed`: list of `{providerId, modelId}` routes, default:

| Family | Routes |
|---|---|
| Meta Muse Spark 1.3 contributor | `meta/muse-spark-1.3-contributor`, `openrouter/meta/muse-spark-1.3-contributor` (W2) |
| Anthropic Haiku 5.5 | `anthropic/claude-haiku-5-5` (W2), `openrouter/anthropic/claude-haiku-5.5` (W2) |
| Anthropic Sonnet 5.5 | `anthropic/claude-sonnet-5-5`, `openrouter/anthropic/claude-sonnet-5.5` |
| DeepSeek V4.1 Flash | `deepseek/deepseek-flash`, `openrouter/deepseek/deepseek-v4.1-flash` |
| OpenAI Luna 6 | `openai/gpt-6-luna`, `openrouter/openai/gpt-6-luna` |
| OpenAI Sol 6.1 | `openai/gpt-6.1-sol`, `openrouter/openai/gpt-6.1-sol` (W2) |

  Exact ids are confirmed against the catalog during W2.
- Filters: `toolCalling` must be true; output price ≤ `models.maxOutputUsdPerMTok` (default 10);
  not deprecated.
- Muse Spark contributor variants enable training on prompts; the picker labels them as such
  (existing rule in CLAUDE.md).
- Per waifu: `model: {providerId, modelId, effort?: string}`; `effort` only when the model lists
  reasoning efforts. No other parameters.
- API: `GET /api/models` → the curated routes with display name, provider, context window, max
  output, image input, efforts, input/output/cache prices, and whether credentials are configured.
  `/api/llm/*` and `GET /api/providers`'s `gatewayProviders` are removed; provider status comes
  from the winter catalog's provider list.

### 9.3 Callers

| Caller | Model | Purpose |
|---|---|---|
| Life loop | her model | `life` |
| Compaction | her model | `compaction` |
| Nightly maintenance and forget scrub | her model | `maintenance` |
| Addressee detector | detector target (native choice, not winter) | `detector` |
| Dashboard assistant | assistant model, else the first configured waifu's model | `assistant` |

The persona digest retires (it only fed the orchestrator's casting cards).

### 9.4 Migration

Step `living-cast-models-v1`:
- Waifu and assistant configs: map `(providerId, modelId)` to the curated route with the same model
  family; unmappable models are unset with a warning in `/api/runtime` so the owner re-picks.
- Drop every stored `params` key; keep a reasoning effort only if it maps to a listed effort.

### 9.5 Winter work items (in the winter repo, owner-owned)

| # | Item | Size |
|---|---|---|
| W1 | `cache_control` pass-through for Anthropic models through OpenRouter (Chat Completions adapter) | S–M |
| W2 | Catalog rows: Haiku 5.5 (Anthropic and OpenRouter), OpenRouter Sol 6.1, OpenRouter Muse Spark 1.3 contributor | S |
| W3 | Explicit per-block cache markers in `TurnRequest` (the app places A/B/C_prev/C itself) | S–M |
| W4 | Long-context price tiers in the catalog schema and `estimateCostUsd` (Haiku 5.5 >100K prompts) | M |
| W5 | Read OpenRouter's reported `usage.cost` | S |
| W6 | Declare `provider-runtime` and `provider-catalog` a supported public API with a semver policy and changelog section | S |

Released as one winter version; the app pins it.

## 10. Discord layer

### 10.1 Bots

- The orchestrator bot becomes the **House bot** (UI label; the `discord-bots.json` key stays
  `orchestrator` for compatibility). It keeps its intents, reads all guild messages and hosts slash
  commands.
- Waifu bots send their waifu's messages, typing and reactions, and receive DMs when DM-eligible
  (existing).

### 10.2 Additions

- `RawDiscordMessage` gains `mentionsEveryone: boolean` (from `message.mentions.everyone`) and
  keeps `mentions.roles`.
- Bot member roles per guild: the guild directory records each waifu bot's member roles (fetched
  once per guild at boot, kept current by member events) for the `role` wake.
- `react` uses the waifu's bot client.

### 10.3 Edits and deletes in a life

Past tool results in her life log never change (append-only). So:
- `read_messages` always shows the current state of a message.
- A delete of a message she has read in the current epoch appends, at her next turn, one line in
  the notifications block: `(Kevin deleted a message you read in #general: #k3)`. Its content
  stays in her log until the next compaction, which lists it for omission.

This replaces the Phase 5 "recent deletes are redacted in place" rule for waifus, because
nothing is re-rendered any more.

### 10.4 Slash commands

| Command | Who | What |
|---|---|---|
| `/wake <waifu> [note]` | owner (guild, House bot) | Queue an `owner` wake. |
| `/print system_prompt|notes|life` | owner (guild, ephemeral) | Her current system prompt, `MEMORY.md`, or the last 20 life-log lines. DM-origin content redacted as today. |
| `/forget conversation|everything` | DM user (waifu bot) | §7.5. Existing confirm button. |

Retired: `/run`, `/stop`, `/review`, `/memories`, `/console`, `/clear`.

## 11. Retirements and data migrations

### 11.1 Code removed

Orchestrator and director: `channelRunner.ts`, `orchestratorHarness.ts`, `decisions.ts`,
`deterministicOrchestrator.ts`, `loopDetector.ts`, `restartResume.ts`, `session.ts` retrigger
state, `stores/decisionHistory.ts` (orchestrator/stage-manager/reviewer histories),
`pipeline/timeline.ts`, `promptBuilders.ts` (keep `currentlyDoingForWaifu` by moving it to
`timeOfDay.ts`).

Memory jobs: `memoryJobs.ts`, `observer.ts`, `observerCursor.ts`, `dream.ts`, `stageManager.ts`,
`memoryRetrieval.ts`, `memorySnapshot.ts`, `memoryWriteGate.ts`, `memorySubjects.ts` (keep
`wordBoundaryIncludes` for name wakes), `stores/memories.ts` after migration.

Waifu reply path: `responderExecutor.ts`, `waifuHarness.ts`, `verbosity.ts` (keep
`typingDelayMs`), `dm/dmRunner.ts` (DM intake becomes a wake source; `rateLimit.ts`, `dmStore.ts`,
`dmForget.ts` stay), `reviewerRunner.ts`.

Model layer: `pipeline/gatewayPipeline.ts`, `pipeline/params.ts`, `pipeline/resolveTarget.ts`,
`api/llmGatewayCredentials.ts` (replaced by `models/credentials.ts`), the `/api/llm` mount,
`writeValidation.ts` gateway checks, `migrationSteps/waifuParamsGateway040.ts` (its ledger id is
kept as history), frontend `api/llm.ts` and `components/modelParams/*`.

`oneShot/` becomes `src/life/detector/` (catalog, protocol, Laya kept; decision mapping replaced).

Each removal takes its tests with it. Tests of reused modules are kept and adapted.

### 11.2 Data migrations

All registered before the schema stamp, idempotent, re-run safe.

| Step | Does |
|---|---|
| `living-cast-memories-to-notes-v1` | §7.4 |
| `living-cast-models-v1` | §9.4 |
| `living-cast-archive-director-v1` | Moves `user/orchestrator/`, `user/stage-manager/`, `user/reviewer/` and every `user/servers/*/orchestrator-history.json`, `stage-manager` and reviewer histories, and `user/servers/*/sessions/` to `user/.archive/living-cast/`. Deletes `user/conversations/*/contexts/` (ledgers and refs stay). |
| `living-cast-server-fields-v1` | Drops `orchestratorMode`, `stageManagerEnabled`, `contextWindows`, `memoryInjectionLimit`, `tools`, `compaction` from server files; `oneShot.target` becomes the per-server detector override. |
| `living-cast-app-config-v1` | Drops `memory.*` except `dreamHourLocal` → `life.maintenanceHourLocal`; sets `discord.debounce.dmMs` 30000 and `dmMaxWaitMs` 180000 if they are still the old defaults. |

### 11.3 New configuration

| Key | Default |
|---|---|
| `life.maxConcurrentTurns` | 4 |
| `life.maxToolRounds` | 12 |
| `life.maxTurnMs` | 180000 |
| `life.maxLogMessages` | 400 |
| `life.maxWaifuOnlyRun` | 12 (0 = off) |
| `life.maintenanceHourLocal` | 5 |
| `life.dailyBudgetUsd` (per waifu, in the waifu config) | null |
| `search.exaApiKey` | "" |
| `search.maxPerSecond` / `maxPerDay` / `maxPerWaifuPerDay` | 2 / 50 / 20 |
| `models.allowed` | §9.2 |
| `models.maxOutputUsdPerMTok` | 10 |
| `detector.target` | the old orchestrator one-shot default |
| `waifu.dm.sleepNotice` | "" |

`compaction.*` app config stays and applies to lives.

### 11.4 Release

Living cast ships together with the unreleased Phases 4–5 as **3.0.0**: behaviour changes
completely and the migrations cannot be reversed. Idle updates never install a major version, so
the owner upgrades each host by hand.

## 12. Testing and acceptance

Fake transports for winter adapters and Exa. Real temp-dir storage.

- **Life loop**: wake → read → send; wake → ignore (no send); mid-turn wake folded after the next
  tool round; caps (rounds, wall time); budget deferral; interrupted turn on shutdown resumes;
  assistant text never reaches Discord; reasoning blocks replayed verbatim through a tool loop.
- **Wakes**: each reason in §4.1; waifu-authored messages never reach the detector; the loop guard;
  `@everyone` staggering; edit-adds-mention.
- **Sleep**: every reason deferred, one `morning` batch, `sleepNotice` sent once.
- **DMs**: 30 s quiet timer reset by each message, 3-minute cap; rate limit drops wakes and sends
  one notice; D11 send permissions (never a stranger, never past a forget floor).
- **Detector**: mapping table; weighted draw; fallback; history; benchmark cases.
- **Tools**: schemas and limits for every tool in §6; notes path safety (no `..`, no absolute
  paths, size caps); search caps; watch matching and expiry; schedules across restart.
- **Memory**: migration output and idempotence; maintenance session uses only notes tools;
  forget scrub end to end including the verify step.
- **Prompt**: exactly one system message; prefix stability across tool rounds and turns (every
  block through the previous C byte-identical); compaction request equals her normal request
  through C with the same tools.
- **Cache simulation** (`tests/eval/cacheHit.test.ts`, adapted to lives, after W3): quiet day, busy
  room with many wakes, DM conversation, a compaction. Target ≥ 0.85 cache-read ratio per waifu
  excluding compaction calls.
- **Goldens for owner review**: life system prompt, a wake turn (notification → read → send), a DM
  wake, a `morning` batch, a maintenance session, a compaction request, the detector state.
- **Live eval** (`WAIFUS_EVAL_LIVE=1`, owner's keys): reads before replying, ignores off-topic
  pings, writes notes about a new fact, keeps a promise via `schedule_wake`, cost per wake.
- **Migrations**: every new step on a realistic main-era data root; re-running is a no-op.

Acceptance: all of the above green; typecheck and the full suite green; goldens approved; no
import of `@waifucave/gateway` left; `grep -rn "orchestrator" src` only in migrations, the House
bot key and the archive path.

## 13. Dashboard, API, CLI (replaces overhaul Phases 6–7)

### 13.1 API

| Route | Notes |
|---|---|
| `GET/POST /api/waifus`, `GET/PUT/DELETE /api/waifus/:id` | Fields per §9.2 (model), DM settings, budget, `sleepNotice`. |
| `GET /api/waifus/:id/life` | status, current turn, queue, epoch, today's usage and cost |
| `GET /api/waifus/:id/life/log?epoch&before&limit` | Life log lines. DM tool results are redacted unless `?includePrivate=1` (owner, local only). |
| `POST /api/waifus/:id/wake {note}`, `POST …/life/compact`, `POST …/life/reset` | |
| `GET /api/waifus/:id/notes`, `GET/PUT/DELETE /api/waifus/:id/notes/*path` | Revision via content hash. |
| `GET/DELETE /api/waifus/:id/watches[/:wid]`, `GET/DELETE /api/waifus/:id/schedule[/:rid]` | |
| `GET /api/models` | §9.2 |
| `GET/PUT /api/detector/config`, `GET /api/detector/history?guildId` | |
| `GET /api/search/usage` | Today's counts against the caps. |
| `GET /api/usage?from&to&groupBy=waifu|purpose|model|day` | Reads the usage ledger. |
| Existing kept | runtime, config, servers/channels/threads, DMs, discord-bots, providers, assistant, docs, remote access |
| Removed | orchestrator/stage-manager/reviewer config and history, `/api/memories*` (replaced by notes; `forget-user` moves to `POST /api/people/:userId/forget`), `/api/llm/*`, `POST /api/waifus/:id/digest`, `trigger/orchestrator`, `trigger/stage-manager`, `runtime/stop` |

All routes go in `ROUTE_POLICY_MANIFEST`; ids validated with `assertSafeId` / `assertSnowflakeId`;
note paths validated against §6.7.

### 13.2 Settings registry, help and CLI

The overhaul spec's §10 mechanism stays (one registry describing every setting with type, default,
scope and help text; `GET /api/help` and `GET /api/help/:topic`; `waifus get|set|list` CLI grammar;
generated assistant KB), with the key list replaced by §11.3 plus the kept keys. Additional CLI
commands: `waifus wake <waifu> [note]`, `waifus life <waifu> [--log]`, `waifus notes <waifu>
[path]`, `waifus forget <userId>`.

### 13.3 Dashboard

| Screen | Content |
|---|---|
| Home | Who is awake, asleep or mid-turn; recent sends and wakes; today's cost. |
| Cast | Waifu editor: persona, style, custom instructions, model (curated picker with prices and the "contributor" label), schedule, DM settings, sleep notice, daily budget. |
| Life (new) | Per waifu: live timeline (wakes, tool calls, sends; DM content hidden unless revealed), notes browser and editor, watches, reminders; Wake / Compact / Reset buttons. |
| Rooms | Servers and channels, cast per channel, paused, threads, detector override. |
| Activity | Logs and model calls. |
| Settings | Providers, models allow-list, search key and caps, detector, app settings, Remote Access. |

Removed: Direction, Memory (replaced by Life → Notes).

The dashboard assistant drops orchestrator, stage-manager, memory and one-shot tools and gains
`get_life`, `wake_waifu`, `list_notes`, `read_note`, `write_note`, `list_watches`,
`list_schedule`, `get_usage`, `list_models`. Assistant KB pages are rewritten for Living cast.

## 14. Implementation order

Each task goes to one implementer (Opus), followed by one independent Opus review and one fix
pass, then a local merge.

| Task | Repo | Scope |
|---|---|---|
| L0 | winter | W1–W6, one release. Can run alongside L1. |
| L1 | app | Model layer (§9): `src/models/*`, curated catalog, credentials, usage ledger and alerts on winter, `GET /api/models`, model-id migration, assistant on the new client, removal of the gateway from every surviving caller. The orchestrator and memory jobs are deleted here rather than ported. |
| L2 | app | Living cast core (§4–§8, §10, §11): intake and wake router, detector, wake queue, life loop and store, harness, tools, notes, maintenance, forget scrub, search, scheduler, Discord additions, retirements and data migrations, tests and goldens. |
| — | owner | Golden review. |
| L3 | app | §13: API, settings registry, help, CLI, dashboard, assistant tools and KB. |

L1 and L2 are separate because L1 is a mechanical swap that L2 builds on; the app is not expected
to be usable between them (the branch `living-cast` is merged to `main` only after L3).

## 15. Open points for the owner

1. **Room loop guard** default of 12 consecutive waifu-only messages, or off?
2. **Daily budget** per waifu: default none, or a number?
3. **Release** as 3.0.0 together with Phases 4–5?
4. **DM content in the dashboard Life timeline**: hidden by default with a reveal toggle (as
   specified), or always shown to the owner?
5. **Exa**: an API key from you, or try the anonymous endpoint first?
