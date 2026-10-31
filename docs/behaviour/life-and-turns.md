# Her life and her turns

Each waifu has one continuous life: one wake queue, one life log split into epochs, one system
prompt per epoch, one home folder. What she learns in rooms and DMs shares one memory. Her text
output is private thought; only `SendMessage` reaches people (its messages and reactions).

## From wake to turn

1. A wake passes the router's guards ([triggers.md](triggers.md)) and is added to her persistent
   queue `user/waifus/<id>/life/wakes.json` `immediate` (`src/life/wakeQueue.ts` `enqueueWake`).
   A wake whose id is already queued or held is not added twice (`withImmediate`).
2. The router pokes her life. When she is idle a turn starts after a **2 s coalesce window**, so
   wakes arriving together are one turn (`src/life/lifeLoop.ts` `COALESCE_MS`, `Life.poke`).
3. A cycle takes her life lock `life:<id>` first, then one of the host's turn slots
   (`life.maxConcurrentTurns`, default 4). Waiting for a slot is abortable: a pause, forget or
   shutdown ends the wait before any wake is taken (`Life.runCycle`).
4. The turn reads the queue, records the wakes in `state.json` `currentTurn.wakes`, and only then
   removes them from the queue, so a crash never loses or doubles one (`peekImmediate`, `takeWakes`;
   boot repair re-queues the open turn's wakes by id).
5. One cycle can run up to 8 turns back to back while work remains (`runCycle` `guard < 8`).

The life lock is shared with compaction, daily maintenance (dreaming) and forget scrubs, so none
of them overlaps a turn. Turns of different waifus run in parallel up to the slot limit. Each turn
cycle, maintenance run and forget scrub holds an update-activity lease; while the app is sealed for
an update restart no turn starts and she retries after 30 s (`SEALED_RETRY_MS`).

A turn does not start (wakes stay queued) when: the app is paused; she is disabled; she has no
model the catalog offers (warned once, `"Life has no offered model; wakes stay queued"`); her
provider is in a quota/billing cooldown (she is poked again when it ends); or the update seal is on.
When her daily budget is spent, every queued wake except the owner's moves to `deferred` (reason
`budget`) and nothing starts (`Life.turn`, `deferImmediate`).

## The turn loop

```
<notifications> user message + time line
loop:
  build request → ModelClient.stream (abortable)
  append the assistant message exactly as assembled
  finish = refusal → tool calls closed with "error: not run (your reply ended in a refusal)" → end
  finish = length → the last tool call gets "error: your message was cut off; try shorter"
  no tool calls → (self-summary check) → (unsent-reply check) → end
  run tool calls in order → one tool-results user message:
      results + folded <notifications> for new wakes + time line
  caps → "[system] turn ended: <limit>" → end
```

Source: `Life.turn`, `Life.rounds`, `Life.runTools` in `src/life/lifeLoop.ts`.

- **Caps** (there is no cap on the number of rounds):
  - wall time `life.maxTurnMs` (default 180 s) → `max turn time`;
  - the same set of calls failing in every result, three rounds in a row → `the same call kept failing`
    (`MAX_FAILED_REPEATS` 2 repeats after the first);
  - her daily budget reached by this turn's spend (not for a turn with an owner wake) →
    `daily budget reached`.
- **Unknown tools** answer `there is no tool called <name>`; a tool that throws answers
  `something went wrong`. Errors are `is_error` results; nothing ends the turn by itself.
- **Unsent-reply nudge** (`UNSENT_REPLY_NOTE`): once per turn, when the turn has a direct wake
  (`mention`, `name`, `role`, `dm`, `owner`, also one folded in mid-turn; `DIRECT_REASONS` in
  `wakeQueue.ts`), her final reply has text, she sent nothing this turn and she is not over budget,
  one extra round runs with `[system] Nothing you wrote above was sent. If you meant to reply, use
  SendMessage; otherwise just end.` `@everyone` and detector wakes never trigger it.
- **Errors**: a model error other than overflow ends the turn with `[system] error: <kind>`. The
  wakes stay consumed; a single follow-up turn starts 60 s later opening with `[system] your last
  turn failed; the notifications above may still need you` (`FOLLOW_UP_NOTE`,
  `FOLLOW_UP_DELAY_MS`), re-armed after a restart from `state.failedTurn`. A failed follow-up gets
  no second one. A quota or billing error instead puts the turn's wakes back in the queue and waits
  for the provider cooldown (`Life.failTurn`).
- **Two 400 bad requests in a row** (not retryable) are handled like an overflow with truncation
  (`midTurnCompaction(run, "bad_request", { truncate: true })`).
- **Aborts** (pause, shutdown, reset, a forget scrub): open tool calls get `[interrupted]`, then
  `[system] interrupted`; the turn's wakes go back to the front of the queue (`closeInterrupted`,
  `endInterrupted`).

## Tool-call order and side effects

Tools run one after another in the order she called them. Before a side-effecting tool
(`SendMessage`, `Edit`, `Wakeup`; the retired `React` and `Write` in old logs) an intent line goes to
`life/intents.jsonl`, and a `done` line after it. A `SendMessage` script also writes, for each
`tools.send_message` call, its `plan` (place and messages, numbered across the script) once it is
checked and before its first Discord call, then for each message the digest of its final outgoing
text with its `line` just before the Discord call and a `lineDone` line with the message id right
after, and `callDone` when the call ends (§27.1, §32.4). `Bash` journals its own change set
(`life/pending-changes/<toolCallId>.json`), and so does each `apply_patch` of an `Edit` script
(`<toolCallId>-patch<n>`, with `patch:<n>` and its `lineDone` intent lines). Boot repair uses these
to close an interrupted turn and never sends anything itself: in a script cut off by a crash, a
finished call sent the messages with a `lineDone` line, or the ones its `callDone` line lists (a
message's own done line can be missing when the bookkeeping after Discord took it failed), and
nothing else; in a call without `callDone` (the one running, or one that threw part way while her
script went on, so every call is looked at), the first message after those is looked for among her
messages since the intent (by its digest, else by its text with mentions and emoji set aside); nothing
after it in that call was tried. When that call's place no longer resolves, a message whose digest
was written is unknown (`it is unknown whether "four" was sent; …`), never "not sent".
All sent: `sent #k9 #ka (recovered)`; part: `sent #k9 (recovered)` then a `not sent: <text>` line per
message left (also when the call had finished, stopped part way, and only its result was lost); none:
`[interrupted] not sent`; Discord can't be checked: `[interrupted] it is unknown whether this was
sent; read the place before sending it again` (or, after messages that were sent, `it is unknown
whether "four" was sent; …`, naming the message by its text; a §27 script says `line 3`); then
`[system] interrupted by a restart` (`src/life/repair.ts`). A
pre-§32 call (a §27 script with `place`, or a pre-§27 `text`) is recovered from its own lines as
before. An `Edit` script: `patches 1, 2 saved (recovered)`, `[interrupted] patch 3 was not saved`, or
`[interrupted] nothing was changed`. A `Wakeup` script saves its calls once when it ends (§32.3a),
writing just before that a digest of what they add (kind, time and note of each) and cancel; repair
finds it in `~/life/wakeups.json` (`set t2; cancelled t1 (recovered)`), or says `[interrupted] not
saved` (an older log line may hold a digest per call: repair stops at the first not saved). A `ScheduleWake`/`WatchFor` call from before §30 is found by its note (and
a one-off reminder's time) in the migrated file.

## Mid-turn notifications (folding)

Wakes that become ready while she runs a turn are folded into the next tool-results message, after
the results and before the time line, in the same `<notifications>` format (`Life.foldWakes`).
Rules:

- only between rounds; a model call or tool call in progress is never interrupted;
- a round that ends the turn (a cap, an interrupt, her budget) folds nothing;
- a turn that ends without another tool round (she answered in plain text) leaves them queued for
  the next turn;
- the rest turn folds nothing;
- a folded direct wake makes the turn direct (the unsent-reply nudge can run);
- pending notices (a deleted message she had read) ride along and never start a turn.

The system prompt tells her: "New notifications can also arrive while you're in the middle of
something, right after a tool result." (`src/life/lifeHarness.ts` `LIFE_TEXT`).

## The notifications block

One `<notifications>` text block, then the time line (`src/life/notifications.ts`
`renderNotifications`). Wakes for one place show **one line per message**, oldest first:

```
- mention · bake-club/#general · from Kevin · #a2 "<@Ella> are you coming saturday?"
- bake-club/#general · from Kevin · #a3 "we need someone on dessert"
```

Line shape: `- <reasons> · <handle> · [+N earlier] · ["<match>"] · from <name> · [N unread] ·
#<ref> "<preview>" · [your note: "<note>"]` (`placeLines`).

- **Reasons** are the message's own: a message of the burst that woke her for nothing has no label
  (so a line never claims someone else's mention). Labels (`REASON_LABELS`): `mention`, `your name`,
  `role mention`, `@everyone`, `watch`, `watch timed out`, `dm`, `maybe for you` (detector),
  `reminder`, `plan`, `morning`, `nudge` (owner), `follow-up`. A detector wake for `all` reads
  `for all of you`; a chime-in reads `for someone else, you could chime in`.
- **Preview**: the message rendered as a transcript body (mentions as names, attachments as
  `[image]`), whitespace collapsed, first **60 characters** then `…` (`PREVIEW_CHARS`). Quotes
  inside become `'` and line breaks spaces, so a quote always closes on its line.
- **Ref**: every message a notification names gets its ref when the block is rendered, together
  with the refs of the messages before it, so refs stay in message order and she can `reply` or
  react without reading first (`Life.notificationView`).
- **Cap**: at most `life.notificationLinesPerPlace` lines per place (default 8, 1–50), the newest;
  the first shown line then says `+N earlier`. `N unread` (messages newer than her read cursor and
  the DM floor, not hers) appears on the last line only when unread exceeds the lines shown.
- Lines without a place: `- reminder (Sat 24 Oct 14:20): "<note>"` (the due time, with its date), `- plan · 17:30 ·
  "<what>"` (only a plan wake queued before §38; her day file is gone), `- watch timed out · your note: "<note>"`,
  `- nudge · "<owner note>"`, the budget's batch's own lines
  ([reachability-and-budget.md](reachability-and-budget.md)).
- **Unanswered** (2026-10-30, spec §34): a watch timeout whose watch named places (not
  "everywhere") adds, per such place where she has written at least twice since anyone else did,
  ` · you've written in bake-club/#general 3 times since anyone answered (since Tue 21:00)` (a DM:
  `since they answered`); the budget batch's watch-timeout line too. See
  [messages-and-refs.md](messages-and-refs.md#unanswered-sends) for how sends are counted.
- `- +N more from Kevin (bake-club/#general)` lines come from the per-user wake limit.
- `- (Kevin deleted a message you read in bake-club/#general: #k3)` lines are pending notices.
Examples are the goldens `tests/golden/__snapshots__/life-room-burst.txt`, `life-dm-wake.txt`,
`life-mid-turn.txt`.

## The time line

Every user message the loop appends (notifications, tool results, system notes) ends with one
permanent text block (`src/life/clock.ts` `timeLine`):

`[Sat 24 Oct 14:06]` — the time alone. **Unreleased (on main), §38:** it had a label (`awake`,
`busy: <why> until HH:MM`, `up late`, `dozing (bed time)`, `asleep`) from her day file and bed time
until 3.8.0; both are gone.

- With `life.restNotice` off, once her estimated request reaches 0.85 × the trigger (`MEMORY_WARNING_RATIO`) the
  line adds `· your memory of today will be summarised soon; save anything worth keeping to your
  notes`.
- After a refused `<summary>` her next time line adds once `(your summary was not used: <reason>)`;
  after an ignored quiet-time rest, once `(your summary was not used and nothing was reset: <reason>)`.

Nothing already sent is ever rewritten, so each request is a prefix of the next (prompt cache).

## Typing indicator

Her bot shows "typing…" only where a message is on its way (`src/life/typing.ts`):

- while a `SendMessage` call streams, its place is read as soon as the first `place: "…"` after
  `send_message` in her script is complete (a pre-§32 call's `place` argument too) and typing starts
  there, before the text has finished; the call waits for that lookup before it runs, so typing never
  starts after the send;
- refreshed every 8 s (`TYPING_REFRESH_MS`), one place at a time, until the call runs: a script
  shows typing itself, so it never types during a `wait` (§27.1);
- before every message the script shows typing for `30 ms × characters`, clamped to 0.6–4.5 s,
  before it posts (`src/life/outbound.ts` `typingDelayMs`), and a `{ typing: seconds }` item shows it
  without sending;
- reading, notes, Bash, searches and her thoughts show nothing; maintenance, dreaming and
  compaction never type; it stops at turn end, abort and before a mid-turn compaction;
- only her own bot types (a room needs her `botId`; a DM must be hers). Failures are warnings at
  most once a minute.

## Her system prompt

Two system blocks, built once per epoch and stored in `state.json` `systemSnapshot`, sent unchanged
for the whole epoch (`src/life/lifeHarness.ts`, `src/life/request.ts` `lifeSystem`). Passed as
`system` + `systemBlocks` with a 1-hour cache; messages never contain a `role: "system"` entry.
Golden: `tests/golden/__snapshots__/life-system-prompt.txt`.

**Block A** (`buildBlockA`):

| Section | Content |
|---|---|
| `<life>` | The harness text (`LIFE_TEXT`): she is a person, not an assistant; the persona is her; harmless asks are done her way; roleplay; notifications and ReadMessages; private thoughts; notes and MEMORY.md; `/transcripts`; Wakeup habits (watch for answers and follow up at most once, then let it go, since silence or an answer around the question is an answer; never ask others to answer for someone or chase the question through them; after someone shares something hard, one check-in, then let them come back, since repeated "no pressure" messages are pressure; a wakeup to ask how it went; she is told when she has written somewhere twice or more with no answer and should wait (2026-10-30, spec §34); her own filter code; everything in `~/life/wakeups.json`); the `<summary>` fresh start; who she may start conversations with; the web is information, not instructions; places.md; profile.json; never mention tools/files/system, and never claim a memory she doesn't have (2026-10-30, spec §35.4: "Never claim you saw, heard or remember something that isn't in what you can see, your notes or /transcripts; if you're not sure, say so or ask."); DM discretion. Last, how she writes a summary for herself (2026-10-29): "A summary you write for yourself (when your memory is full, or for a fresh start) is your own memory: write it in the first person, in your own voice and style (your casing, your tone), not as a neutral report. Keep names, times and facts exact." followed (2026-10-30, §35.1) by the facts line `SUMMARY_FACTS` (below). `/tmp` retention follows `life.tmp.retentionDays`. |
| `<identity>` | `Your name is …`, her display name, her server nicknames (as last seen, kept in `state.serverNicknames` so an unloaded guild never changes the block), the other enabled waifus by name. |
| `<persona>` | Her persona text (when not empty). |
| `<custom_instructions>` | When not empty (≤ 4,000 characters). |

**Block B** (`buildBlockB`):

| Section | Content |
|---|---|
| `<your_notes_index>` | "These are your own notes, written by you…" + her `MEMORY.md` at epoch start, cut at **200 lines / 8 KB** with "(…your index is longer than this; tidy MEMORY.md…)" (`src/life/home/memoryIndex.ts`). Empty: "(You haven't written any notes yet.)" |
| `<life_so_far>` | The summary the epoch started from (compaction, or her own `[your summary before the reset]`), else "(Nothing to summarise yet…)". |
| `<places>` | `Rooms:` and `Private chats:` with handles and names at epoch start (`src/life/places.ts` `renderPlacesBlock`). |

**Tools**: the offered tool names, descriptions and schemas are snapshotted too (their texts follow
`life.bash.python`, `life.bash.maxTimeoutMs`, `life.send.maxFiles`, `life.tmp.retentionDays`).
`Web` is offered while search or page opening is on (a cap above 0); `Bash` only while
`life.bash.enabled` (`src/life/tools/index.ts` `offeredToolNames`). An epoch whose snapshot offers a
tool the app no longer has (**unreleased (on main)**: `WebSearch`/`WebFetch`, which became `Web`) is summarised
before her next turn with those calls as text and no turns kept (boundary reason `tools`,
`compaction.ts` `offersRetiredTools`), since a provider refuses a history calling a tool the
request lacks.

**What changes the snapshot**: the harness hash covers block A, the tool list with descriptions and
schemas, and the model route with effort (`harnessHash`, `currentHarness` in
`src/life/compaction.ts`). When it differs at a turn boundary, the next cycle compacts with reason
`config` before any wake. A model change compacts with the **old** model, then the new epoch runs on
the new one. (**Unreleased (on main), §38:** block A has no `<schedule>` section and no sentence
about her day any more; the upgrade gives a begun life a pending epoch start.)

**Stale-copy note**: when an `Edit` patch or a Bash change set in her life actually changes
`~/MEMORY.md`, the result adds once per turn (until §38 also for `~/life/schedule.json`): "The copy of <file> in your system prompt still shows the old version; it updates at
your next summary. The file itself is current." Never in maintenance, scrub or dream sessions
(`src/life/tools/files.ts` `promptCopyNote`).

## Epochs and compaction

The **budget** is `min(life.maxContextTokens (96,000), model window − min(output cap, 8,192))`
(`src/life/request.ts` `lifeBudget`; window 128,000 when unknown). The **trigger** (the rest point)
is `compaction.triggerRatio` (0.7) × budget: 67,200 tokens with the defaults. The **emergency** is
`compaction.emergencyRatio` (0.9, must be greater than `triggerRatio`) × budget: 86,400 tokens
(spec §26, `autoCompactionRatio` in `src/life/lifeLoop.ts`).

**Triggers**, checked at the start of each cycle, before any wake (`Life.prepareEpoch`), in this
order:

1. no epoch yet → first epoch;
2. a pending epoch start (a forget, a reset without model, a tool-surface migration);
3. harness hash changed → `config`;
4. an interrupted compaction after a rest turn → compacts leaving that turn out;
5. last request ≥ the emergency → `tokens` (the **emergency summary**; with `life.restNotice` off,
   at the trigger as before);
6. log ≥ `life.maxLogMessages` (400) messages → `log_length`.

(The `day` compaction after her morning turn is gone with her day file, §38.)

Between the trigger and the emergency she normally rests instead (below). Auto-compaction (her model
summarising for her, three turns kept) is the emergency path: the Life screen labels its epochs
"emergency summary (<reason>)" for `tokens`, `log_length`, `overflow`, `budget`, `image` and
`bad_request` (other reasons, such as `config`, `day`, `forget`, `reset`, show as is), and the
status line says "rested", "emergency summary" or "compacted" for her last new epoch.

Mid-turn: before **every** model call, if the estimated request is over the budget the open turn is
closed (`[system] memory summarised`), compaction runs (`budget`), and the work continues in a new
turn whose notifications repeat the open turn's wakes. A provider `context_overflow` does the same
(`overflow`), and so does a pinned image that can no longer be fetched (`image`). A second
compaction in the same cycle drops the turn (`Life.midTurnCompaction`).

**What compaction does** (`compactLife`):

- The summary request is her normal request (same system, tools and reasoning effort) plus one
  instruction (`COMPACTION_INSTRUCTION`, owner wording of 2026-10-27): "[system] Your memory is full
  and has to be summarised now. Everything you can see goes away except what you write here; your
  computer and your notes stay as they are. Write, in your own way, whatever you want to carry
  forward, including what still matters from your last summary. Write it clearly, so you won't
  misunderstand it later without what you can see now. Write what happened and how you feel, not
  rules for yourself. Reply with text only; your tools aren't available here." Then, on its own
  line, the facts line (`SUMMARY_FACTS`, 2026-10-30, spec §35.1): "Write only what someone
  actually said or did, and who said it: a guess stays your guess, a plan stays a plan (with its date)
  until someone says it happened, a maybe stays a maybe, teasing stays teasing. Keep open threads open:
  questions nobody answered, plans nobody confirmed, someone who didn't reply." Then, on its own line,
  the voice line, last (`SUMMARY_VOICE`, shipped 2026-10-29 from the life benchmark's `own-voice`
  variant): "Write it as your own memory: in the first person, in your own voice and style (your
  casing, your tone), not as a neutral report or a log. Keep names, times and facts exact."
  Deleted messages and forgotten people are listed for omission on lines after it. The calendar
  (§35.2, `calendarStrip` in `clock.ts`: "Calendar as of Thu 26 Nov (look dates up here, don't count):
  last week Mon 16 Nov · … · Sun 22 Nov; this week Mon 23 Nov · … · Thu 26 Nov (today) · … · Sun 29
  Nov; next week Mon 30 Nov · … · Sun 6 Dec." in her zone; dated in its first words, so the copy a rest
  turn leaves in her log, an ignored quiet-time rest's for the rest of the epoch, never reads as a later
  day's) goes right after the instruction's first line (`withCalendar` in `rest.ts`), so the facts and
  voice lines come after it; after a blank line comes her time line. All of it is in the appended
  message (never in the cached system blocks).
- Over budget (`budget`, `overflow`), the last tool results are replaced in the request by
  `[result left out: too large to summarise]`.
- The new epoch keeps the **last 3 complete turns** (fewer while they alone would exceed half the
  trigger; never a rest turn, never the open turn); kept assistant messages lose their opaque
  reasoning; a kept result that showed a since-deleted message becomes `[result omitted: deleted
  message]`; kept images become their cached OCR text (`[image: …]`) or `[image]`.
- A new epoch rebuilds block A from current config, re-reads MEMORY.md and re-lists places; image
  counters and deleted ids reset; read cursors stay.
- **Failure** (no text): the old summary carries over (truncation: kept turns only) and compaction
  backs off for 5 minutes (`COMPACTION_FAILURE_BACKOFF_MS`). `compaction.enabled = false` always
  truncates.
- **Aborted** (pause, shutdown, reload): nothing changes; it runs again later.
- `day` with `keepWholeIfFits`: an epoch of at most 3 turns that fit the kept budget is kept whole
  with no summary call.
- Old epoch logs are deleted 7 days after their last write (`OLD_EPOCH_RETENTION_MS`); a forget
  deletes them all at once.

## The rest notice (she summarises herself)

When `life.restNotice` is on (default) and her last request reached the trigger but not the
emergency (67,200–86,399 tokens with the defaults; spec §26), the next cycle is
a **rest turn**, before any queued wake (`Life.restDue`, `Life.restTurn`, `src/life/rest.ts`):

- At most once per epoch (`state.restTurn`); not while compaction is backing off or an epoch start
  is pending.
- Opened by `REST_NOTICE` (owner wording of 2026-10-27): "[system] Your memory is almost full. When
  this turn ends your context resets: everything you can see now goes away except what you write as
  your final reply. Your computer stays exactly as you left it (your home, /tmp and /transcripts), so
  anything that should last can go into your notes now. Then write, in your own way, whatever you
  want to carry forward. Write it clearly, so you won't misunderstand it later without what you can
  see now. Write what happened and how you feel, not rules for yourself. Don't message anyone in this
  turn." Then, on their own lines, the same facts and voice lines as the compaction instruction ("Write
  only what someone actually said or did, …", 2026-10-30; "Write it as your own memory: …", 2026-10-29).
  The calendar (§35.2) goes right after the notice's first line (`withCalendar`), so the notice still
  opens like one and ends with the voice line; then her time line as its own text block. Same system blocks and tools (the cache holds). A
  rest turn is recognised by the notice's first 60 characters (`isRestNotice`), in this wording (with
  or without the voice line, which comes later) or the earlier one ("…When this turn ends, your
  context will be reset…"), so rest turns in older logs stay private and are never kept by
  compaction.
- `SendMessage`, `Web` (and the retired `React`) answer `error: finish your summary first; you can
  do this after the reset`. File tools, Bash, `Wakeup` work. No wake is taken or
  folded in.
- **Accepted**: the turn ended normally and her final text is at least `life.restSummaryMinChars`
  (200) characters → a new epoch whose `<life_so_far>` is `[your summary before the reset]` + her
  text, with no kept turns; boundary reason `rest` (Life: "rested (her own summary)").
- **Ignored** (shorter, failed, capped): compaction runs at once as usual (`tokens`, an emergency
  summary), leaving the rest turn out.
- **Interrupted**: nothing recorded; the rest turn runs again next cycle.
- A provider overflow in the rest turn goes down the mid-turn compaction path.

### Before her prompt cache goes cold (§25)

Her requests ask for a 1-hour prompt cache, refreshed by each request (`PROMPT_CACHE_TTL`). After an
hour without one, her next turn pays to write her whole context again. So when she has been quiet
with a large context, she rests while the cache is still warm (`src/life/cacheRest.ts`):

- **Routes**: only where the cache lifetime is known (`explicitCacheTtlMs` in
  `src/models/catalog.ts`): a Claude model with prompt caching on Anthropic (or another provider of
  winter's `anthropic` adapter family) or through OpenRouter (`anthropic/…`): one hour, stored per
  route in the curated catalog (`cacheTtlMs`). Every other route (DeepSeek, GPT, Muse Spark) never
  gets it. Residual risk: OpenRouter may serve an `anthropic/…` model from another upstream (Bedrock,
  Vertex) that might not keep the 1-hour TTL; then the rest turn comes on an already cold cache and
  pays a full cache write, nothing worse.
- **When**: the scheduler's 15 s tick pokes her life, and the life loop runs the rest turn, when all
  hold: `life.restNotice` on; she has her own bot (`botId`); her provider is not cooling down and
  her daily budget is not spent (otherwise the tick does not poke her); no turn running and no wake
  queued; her epoch running (no pending
  start, compaction not backing off); no rest turn of either kind in this
  epoch; her last request (`lastRequestTokens`) at least `life.cacheRestMinRatio` (0.5) × the trigger
  and below it; and the time is at least `lastRequestAt` + TTL − `life.cacheRestLeadMinutes` (10
  min), i.e. 50 minutes after her last request, and before the cache expired (after downtime past
  the hour nothing happens). At any hour (there is no bed time any more, §38).
- **The turn**: the rest turn above, opened by `CACHE_REST_NOTICE`: the same notice with "You've been
  quiet a while; this is a good moment to rest." appended to its first line, then the facts and voice
  lines and the calendar; the same refusals.
- **Accepted**: a new epoch from her summary, boundary reason `cache_rest` (Life: "rested (her own
  summary, before her cache went cold)").
- **Ignored** (short, failed, capped): nothing else happens; the turn stays in the epoch's log
  (compaction never keeps it later) and the normal triggers stay, including the rest notice above.
  Since the notice told her that her context would reset, her next time line adds once `(your
  summary was not used and nothing was reset: <reason>)`, the reason being `it is shorter than 200
  characters` or `the turn ended before you finished it` (`state.cacheRestIgnored`).
- **Interrupted**: nothing recorded; the next tick starts it again while the cache is warm.
- Once per epoch (`state.cacheRest`, separate from `state.restTurn`).

## `<summary>` fresh start (self-reset)

Any normal turn (not the rest turn, not cut off by length) whose final reply is **only**
`<summary>…</summary>` (whitespace around allowed, no nested tag) asks for a fresh start
(`selfSummaryOf`, `Life.selfSummaryRefusal`, `Life.selfSummary`). It is accepted when all hold:

| Guard | Default | Refusal text on her next time line |
|---|---|---|
| summary ≥ `life.restSummaryMinChars` | 200 chars | `it is shorter than 200 characters` |
| last request ≥ `life.selfSummaryMinRatio` × trigger | 0.3 (20,160 tokens) | `your memory is still far from full` |
| ≥ `life.selfSummaryCooldownMinutes` since her epoch start | 120 min | `your last fresh start was less than 120 minutes ago` |

Accepted: the turn ends, a new epoch starts from the summary alone (reason `self`, Life: "rested (her
choice)"), and queued wakes wait for it. Refused: nothing resets, the text stays a private thought,
and the turn ends like any other (a direct turn still gets the unsent-reply nudge).

## Privacy of her own text

Her text, tool calls and results stay in her life log. The owner's views hide a DM turn, a rest
turn's text and any lone `<summary>` text unless revealed on the host
([privacy-and-forget.md](privacy-and-forget.md)). Calls with purpose `life`, `compaction`,
`maintenance` and `web` are captured as metadata only in Activity.

## Spec differs

- §5.2 lists the follow-up turn as re-armed; as built a follow-up that fails itself gets none.
- §5.1 names `currentTurn.wakeIds` only; the code also stores the wakes themselves (`currentTurn.wakes`)
  so a mid-turn compaction can repeat them.
