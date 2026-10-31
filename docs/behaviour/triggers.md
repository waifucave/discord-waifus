# What wakes her

Every wake has a reason (`WakeReasonSchema` in `src/shared/schemas/life.ts`): `mention`, `name`,
`role`, `everyone`, `watch`, `watch_timeout`, `dm`, `detector`, `reminder`, `plan`, `wakeup_error`, `morning`,
`owner`, `followup`. Wakes are produced by intake (Discord messages), the scheduler (her files) and
the owner, then pass the wake router's guards and land in her queue
([life-and-turns.md](life-and-turns.md)).

## Who can be woken at all

- Only a waifu that is **enabled** and has **her own bot** (`botId`). Without a bot nothing wakes
  her, not even an owner wake (`src/life/intake.ts` `castWaifus`; `src/life/wakeRouter.ts`
  `routeNow`: `if (!waifu?.enabled || !waifu.botId) return "dropped"`).
- Room messages reach intake only from a channel that has an enabled waifu cast (or a thread
  inheriting one), in a server that is not paused, while the app is not paused. Messages from bots
  that are not one of our waifu bots are ignored (`src/orchestration/runtime.ts`
  `handleDiscordMessage`).
- Her own messages never wake her (`selfAuthorIds`: her bot id and its application id).
- A turn needs a model; without one her wakes wait in the queue. The detector also skips cast
  members with no model (`Intake.runDetector`).

## Triggers

| Reason | When exactly | Routed | Source |
|---|---|---|---|
| `mention` | Her bot user is @mentioned, or a message replies to one of her messages. From a person or another waifu. | Person: when the burst fires. Waifu author: at once. | `Intake.routeGuildMessage` |
| `mention` (edit) | A person edits a message **under 2 minutes old** so that it newly mentions her; once per message per waifu. Other edits and deletes wake nobody. | At once | `Intake.onEdit`, `EDIT_MENTION_WINDOW_MS` |
| `role` | A role her bot member holds is mentioned (person or waifu author). Roles are fetched per guild and kept current from member/role events. | Person: with the burst. Waifu: at once. | `routeGuildMessage`, `src/life/botRoles.ts` |
| `everyone` | `@everyone`/`@here` in a person's message in a channel where she is cast. Never from a waifu's message. | With the burst | `routeGuildMessage` |
| `name` | Her name, display name or server nickname (each ≥ 3 characters) appears as a whole word in a **person's** message, and `wakeOnName` is on (default). Not counted when the same message already mentions her. Never for waifu-written messages. | With the burst | `namesOf`, `wordBoundaryIncludes` |
| `dm` | A person's DM to her bot (she must be DM-eligible: [dms.md](dms.md)). | When the DM burst fires | `Intake.onDirectMessage`, `fireDm` |
| `watch` | One of her watches (in `~/life/wakeups.json`, set with `Wakeup`) passes its filter for a message: an object filter, or her own function returning `true` or a line to show ([her-computer.md](her-computer.md#wakeupscript)). In a room: at once. In a DM: rides on the `dm` wake after the DM hold. Several of her wakeups on one message are one wake, a line each. Also a page wakeup whose check fired (the line names the page's URL). | See left | `src/life/wakeups/run.ts` `fireWakeupWatches`, `checkPages` |
| `watch_timeout` | A watch's or page's `until` passed (scheduler tick, every 15 s). A `once` watch that already fired never times out. | Scheduler | `Scheduler.wakeups` |
| `reminder` | A timed wakeup (`at` or `every` in `~/life/wakeups.json`) came due (scheduler tick). Routed under a fixed id per occurrence, then an `at` is removed (an `every` stays). A late `at` after downtime fires once at the first tick; an `every` fires its latest occurrence since it started counting. | Scheduler | `Scheduler.wakeups` |
| `wakeup_error` | Her code (a watch's filter or a page's check) failed three times in a row: the wakeup is stopped (`disabled` in her file) and she is told `- wakeup w4 stopped: TypeError: … (line 2)`. | At once | `src/life/wakeups/run.ts` `applyRuns` |
| `plan` | **Unreleased (on main), §38: no longer produced.** Her day file's timed plans woke her until 3.8.0; a `plan` wake queued or deferred before the upgrade is still delivered, one line per plan: `- plan · 17:30 · "<what>"`. | — | `notifications.ts` `soloLine` |
| `detector` | Jev picked her for a burst nobody was addressed in (`waifu_<i>`, the `anyone` draw, `all`), or picked her to chime in. See [detector.md](detector.md). | After the burst and the detector call | `Intake.runDetector` |
| `morning` | The batch of what waited while she was over her daily budget, released once she is under it again (the reason kept its name from her morning, §38); also releases what a 3.8 queue deferred for her bed time, at the first tick. Enqueued directly, not through the router. See [reachability-and-budget.md](reachability-and-budget.md). | Scheduler | `Scheduler.releaseDeferred` |
| `owner` | `/wake` (Discord), the dashboard's Wake button, `waifus wake`, `POST /api/waifus/:id/wake`, the assistant's `wake_waifu`. Note ≤ 500 characters, shown as `- nudge · "<note>"`. | At once | `LivingCast.ownerWake` |
| follow-up | Not a queued wake: a turn that failed with a model error gets one follow-up turn 60 s later. | Life loop | `Life.failTurn` |

There are no proactive wakes besides these: she starts conversations only from inside a turn she
already has (her wakeups are how she plans ahead).

### Staggering

When one person's message (or burst) wakes **two or more** waifus only through `@everyone` or a
shared role (no mention, no name for that waifu), each of those wakes is routed after a random
**0–20 s** delay so later ones can see earlier replies (`STAGGER_MAX_MS`, `Intake.routeDirect`,
`isShared`). Detector `all` wakes for several waifus are staggered the same way.

## Intake holds (bursts and typing)

Room bursts, DM bursts and a waifu's own bursts are held by a typing-aware timer
(`src/life/intakeHold.ts` `TypingHolds`). A burst fires at

`min(first + max(quiet, cap), max(last message + quiet, latest typing event + typingHold))`

| | Quiet after the last message | Cap from the first message | Typing holds it? |
|---|---|---|---|
| Room burst (people) | `discord.debounce.serverMs` 1.5 s | `serverMaxWaitMs` 10 s | Yes |
| DM burst | `dmMs` 2.5 s | `dmMaxWaitMs` 60 s | Yes |
| A waifu's own lines in a place | `serverMs` 1.5 s | `serverMaxWaitMs` 10 s | Never |

- A typing event counts as "still typing" for `typingHoldMs` (**6 s**), or until a message from
  that person arrives. Only typing by a person **with a message in the pending burst**, in that same
  channel/thread/DM, holds it. Bots and other people never hold anything (`TypingHolds.typing`,
  `Intake.onTyping`). Typing comes from the House bot's and DM bots' raw `TYPING_START` packets.
- **One room burst per place**: every person's message joins it, direct or not. A burst is "direct"
  when any message in it produced a direct reason for anyone; a direct burst never reaches the
  detector.
- **Waifu bursts** are per place **and author**; her direct wakes (mention, role, reply) route at
  once, and the burst only exists to ask the detector who speaks next when none of her lines was
  direct.
- **Not held**: room watches, a waifu's direct wakes, edit mentions, and catch-up after a restart or
  resume (a place's caught-up bursts fire right after its messages are taken).

## What gets merged

- **A person's direct wakes in a burst** become **one wake per waifu** when the burst fires: reasons
  merged in the order `mention, role, everyone, name` (a mention drops `name`), every message of the
  burst kept as its own line (up to 50, older ones counted as `earlier`), each with the reasons it
  gave her; the preview and ref point at the newest message by the person who woke her
  (`Intake.mergeHeld`, `src/life/wakeMessages.ts`). So "@Lumi" then "what do you think about…" is
  one notification whose last line is the question.
- **A DM burst** is one `dm` wake with one line per message. Her wakeups that fire for a message
  ride on that message's line (`dm, watch · … · "match" · … · your note: …`; a second one on the same
  message gets its own `- watch · …` line under it). If the DM wake is dropped (rate limit), each
  message's wakeups still reach her as a plain `watch` wake (`Intake.fireDm`).
- **One wake per message (D-c)**: a waifu whose watch fired for a message in a burst is skipped by
  the detector for that burst. A burst whose whole candidate cast was woken by watches never reaches
  the detector.
- **Queued wakes for one place** render as one group of lines in the next turn (joined by message
  id, reasons merged; [life-and-turns.md](life-and-turns.md)). Past 200 queued wakes, a new wake for a
  place that already has one is merged into it as a counter (`MAX_IMMEDIATE_WAKES`, `mergeInto`).
- A wake whose id is already queued or deferred is never added again (catch-up, a re-routed
  reminder, a re-queued turn).

## The wake router's guards, in order

`src/life/wakeRouter.ts` `WakeRouter.routeNow`. Outcomes: `queued`, `deferred`, `quiet`,
`dropped`. **Unreleased (on main), §38:** there is no sleep guard (4, 4a) and no busy guard (4b)
any more; she is reachable at any hour ([reachability-and-budget.md](reachability-and-budget.md)).

| # | Guard | Effect | Applies to owner wakes? |
|---|---|---|---|
| 1 | **Paused** app, or the room wake's server `paused`, or she is disabled / has no bot | `dropped` | Yes |
| 2 | **DM rate limit** (`dm` wakes): `dm.rateLimit` per person per waifu (default 30 replies per 60 min) | `dropped`; the limit notice is sent once per limited period when `dm.notifyWhenLimited` (no model call) | n/a |
| 3 | **Per-user wake limit** (rooms; reasons `mention`, `name`, `role`, `everyone`, `detector`): more than `life.maxWakesPerUserPerHour` (20) wakes from one person to one waifu in the last hour | `quiet`: becomes a `- +N more from <name> (<place>)` line that rides on her next turn and never starts one (`admitUserWake`) | Skipped |
| 5 | **Daily budget** `life.dailyBudgetUsd` (default none) reached for the local day | `deferred` (reason `budget`) until she is under budget again (her next local day), then released as one batch | Skipped |
| 6 | **Room loop guard** `life.maxWaifuTriggeredTurns` (default 0 = off): waifu-authored wakes in a place after that many waifu messages have woken someone since the last person's message there; each message counts once however many it wakes | `dropped` (it never blocks a send) | Skipped |

Then the wake is queued and her life is poked.

Details:

- The owner's wake still passes guard 1, so it is dropped while the app is paused or when she is
  disabled or has no bot (it carries no server, so a paused server does not stop it). The HTTP wake route queues an `owner` wake directly in
  `wakes.json` (`outcome: "queued_offline"`) when the cast is offline or reloading; Discord's
  `/wake` does the same during a reload and says so (`wakeQueue.ts` `queueOwnerWakeOffline`,
  [owner-controls.md](owner-controls.md)).
- Guard 5 is checked again when a turn starts (queued wakes from before the budget ran out move to
  `deferred`, except the owner's) and after every model call of a running turn (the turn ends with
  `[system] turn ended: daily budget reached`, unless it has an owner wake). Her spend counts every
  ledger line with her waifu id (life, compaction, dream/maintenance, web digests) for the host's
  local day; detector calls are not hers (`src/life/budget.ts` `DailyCost`).
- A deferred batch is never released while she is over budget (`Scheduler.releaseDeferred`); one a
  3.8 queue deferred for her bed time waits for her budget the same way.
- Guard 3 is per room wake only (`context.guildId`); DMs have their own rate limit (guard 2).

## Catch-up after downtime, pause and reload

- At boot, messages newer than each place's intake high-water mark (`app/intake-marks.json`), her
  read cursor and the DM forget floor, and at most `discord.dm.resumeWindowMinutes` (60) old, are
  fed through intake as if live. Older ones wake nobody but stay readable (`LivingCast.catchUpAndResume`).
- After an explicit pause, the resume catch-up starts at the pause start (kept in
  `intake-marks.json` `pausedAt`, so a restart while paused still catches up from it). Messages that
  arrive while paused are not routed live; the DM state is still updated.
- A message intake already handled (even one it decided to ignore) never wakes anyone again: the mark
  moves only once a message's routing has resolved and never past a message still held (a
  staggered wake, a debouncing burst, a running detector call) (`src/life/intakeMarks.ts`,
  `Intake.mark`).
- Rooms in a paused server are skipped by catch-up.

## Spec differs

- §4.4 guard 4 (sleep) and §4.5 are superseded by §38: there is no sleep (or busy) guard.
- §4.4 lists guard 1 as "paused server or app"; the code also drops every wake (owner included) for
  a disabled waifu or one without her own bot.
- §4.1 calls the follow-up a wake reason; as built a failed turn's follow-up is a turn with no wakes
  (`FOLLOW_UP_NOTE`), and `followup` only appears in deferred-batch rendering.
