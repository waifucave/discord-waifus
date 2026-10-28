# Her day and her bed time

Two things shape when she is reachable: her own day plan (`~/life/schedule.json`, which she writes)
and the owner's bed time (`availability.bedTime`). There are no owner-set busy blocks.

All times are in the host's time zone (`src/life/clock.ts`).

## Her day file `~/life/schedule.json`

```json
{
  "date": "2026-10-27",
  "mood": "slow morning, want a quiet day",
  "busy": [{ "from": "12:00", "to": "15:30", "why": "studio shift" }],
  "phoneChecks": ["13:30", "14:45"],
  "plans": [{ "at": "21:00", "what": "movie night" }, { "what": "finish the rain poem" }],
  "note": "if Kevin asks about saturday: yes"
}
```

Checked on every write (her Write/Edit/Bash, the API), refused with the exact problem and nothing
saved (`src/life/home/daySchedule.ts` `checkDayScheduleText`):

| Field | Rule |
|---|---|
| `date` | Required, a real `YYYY-MM-DD` |
| `mood` | Text ≤ 200 characters |
| `busy` | ≤ 12 blocks `{from, to, why}`; `HH:MM`; `to` after `from` on the same day; `why` required, ≤ 120; no overlaps; **not inside her bed time** (checked against the current bed time on write, not when reading a saved file) |
| `phoneChecks` | ≤ 24 `HH:MM` times; only those strictly inside a busy block matter |
| `plans` | ≤ 20 `{at?, what}`; `what` required, ≤ 200; a plan with `at` wakes her then ([Timed plans](#timed-plans)); one without is a note |
| `note` | Text ≤ 500 |
| anything else | Refused ("unknown field") |

- Strict JSON with line and column errors. An empty file is "no plan". A file whose `date` is not
  today counts as **no plan today** (no busy blocks); it is never deleted, she overwrites it.
- A saved file that fails the checks reads as no plan (`readDayPlan`).
- She may delete it (no plan). Unlike wakeups.json and profile.json, a `Write` needs no earlier `Read`;
  if she did read it this turn, a stale Write is refused ("changed since you read it (it was changed
  for you)").
- **Live readers**: the wake router (busy holds), Jev's "around" check and her time line read the
  file on every use. The `<schedule>` copy in her system prompt is from her epoch start and
  refreshes at the next compaction; a midday edit never forces one (the harness hash leaves the plan
  out). A Write/Edit/Bash change in her life adds the stale-copy note when `scheduleInPrompt` is on,
  and, once per turn when the saved file has a plan with `at`, "Plans with a time wake you then."
  (`tools/files.ts` `planWakeNote`). The errors for the `plans` field end with the same sentence.
- The scheduler reads it every tick for her timed plans (below).
- Dreaming never changes it. A forget scrubs its `mood`, `why`, `what` and `note` texts that name the
  person to `(removed)` (a rewritten timed plan is a new plan, written then: one whose time passed
  does not fire again).

## Timed plans

`Scheduler.plans` in `src/life/scheduler.ts`, every 15 s tick (spec §29):

- A plan with `at` in **today's** file (its `date` is today) wakes her once at that time with a
  `plan` wake. Plans without `at`, phone checks and busy blocks never wake her.
- Each plan is decided once, by its key `<at> <first 16 hex of sha256(what)>`, in
  `user/waifus/<id>/life/plans-fired.json` (`seen`: when each key was first seen, `fired`,
  `skipped`; no plan text). An edit of the text or the time is a new key, a new plan; the same key
  never fires twice. The record of a past day is dropped (reset to today) the next time she has a
  timed plan.
- **Written after its time**: the first tick that sees a key records the previous tick's time as
  when it was written (the first tick after a start records its own time). A plan whose `at` is at
  or before that never fires. So a plan written in the 15 s before its time still fires; one written
  after its time does not; one the app first sees after a restart counts as written then.
- **Late**: a plan fires up to 15 minutes late (`PLAN_LATE_MS`: host down, app paused); later it is
  skipped (logged "Life plan skipped: too late"). Her wakeups (`Wakeup`) are for what must happen.
- **Bed time**: a plan whose `at` falls inside her bed time never fires (it stays a note). A plan
  just before her bed time that fires late in it gets through like a reminder.
- **One wake per tick**: all plans that fire at one tick are one wake (`plans: [{at, what}]`, id
  `w-plan-<date>-<hash of the keys>`, routed before they are recorded as fired, like reminders). It
  has no place: she decides where (if anywhere) to act.
- **Routing**: `plan` is in the busy set (gets through a busy block, and up late or dozing) and gets
  through while asleep, like `reminder`. Over her daily budget it is deferred (reason `budget`) and
  listed in the batch as `  · plan (Sat 17:30): "<what>"`.
- **Notification**: one line per plan, `- plan · 17:30 · "send one photo to dm/k if K is around"`
  (golden `life-plan.txt`). It folds into a running turn like any other wake.
- An unreadable `plans-fired.json` is replaced; plans already due then count as fired (never twice).

## The morning wake

`Scheduler.morning` in `src/life/scheduler.ts`, every 15 s tick, per enabled waifu, outside her bed
time:

- **Her day start** is the latest end of her bed time at or before now, or without a bed time the
  latest `life.dayStartHourLocal`:00 (default 08:00) (`clock.ts` `dayStartAt`). When it is later
  than `state.lastDayStart`, a day wake is due.
- The day wake has id `w-day-<local date>`, reason `morning`, a `day` field, and its batch opens with
  the greeting (`notifications.ts` `morningGreeting`):

  > [system] Good morning, it's Tue 27 Oct. Before anything else, write today's schedule in
  > ~/life/schedule.json: when you'll be busy and why, when you'll check your phone while busy, your
  > mood, your plans. Plans with a time wake you then. Your day is yours to plan: keep it believable
  > for who you are. Your bed time (00:30–08:30) is fixed. Then deal with what came in overnight.

  The bed time sentence is left out without a bed time; "Then deal with…" only when something waited.
- It is followed by the overnight batch (below), is enqueued directly (not through the router), is
  never folded into a running turn, and comes at the end of her bed time whatever happened in it.
- A life that has not begun yet records the day start without a wake (her first morning is the next
  one); a life's first epoch records it too. A day whose start passed while the host was down or
  paused gets its morning at the first tick after.
- Over her daily budget the morning (and any deferred batch) waits for her next local day under
  budget; today's day wake deferred for budget comes back as itself (greeting first) later.
- **After the morning turn** ends (not interrupted, not cut by a compaction), `dayCompactionDue` is
  set and the next cycle compacts with reason `day`, so block A's `<schedule>` shows today's plan,
  written or not. An epoch of at most 3 turns that fit the kept budget is kept whole with no summary
  call (`Life.prepareEpoch`, `compactLife` `keepWholeIfFits`).
- Without `scheduleInPrompt` the file still works; it just is not in her prompt.

## The morning summary (overnight batch)

Built when her bed time ends (or a budget pause lifts) from `wakes.json` `deferred`
(`notifications.ts` `morningBatch`, `Scheduler.morningView`/`morningPlaces`). Golden:
`tests/golden/__snapshots__/life-morning-summary.txt`, `life-morning.txt`, `life-day-morning.txt`.

```
- during your bed time (00:30–08:30):
  · DMs:
    · dm/kevin · 02:14 #d3 "you up? need a hand with the essay tmrw"
    · dm/kevin · 02:15 #d4 "nvm going to sleep"
  · kingdom-16062/#general: 2 mentions, 31 messages (01:50–07:58)
    · mention · 03:02 #c41 from Lianne "@Lumi the cat did the thing again"
  · winter-s-secret-room/#general: 4 messages (06:10–06:30)
  · watch matched · kingdom-16062/#general · "sushi" · from Lianne · 05:12 #c55 · your note: "…"
  · watch timed out (Tue 04:00) · your note: "…"
```

- Header: `- during your bed time (<start>–<end>):` for a sleep batch with a bed time; `- while you
  were asleep (HH:MM–HH:MM):` without one; `- while you were away (since HH:MM):` for a budget pause.
- (§23) **DMs** one line per message (time, ref, 60-char preview), oldest
  first; **rooms** by most mentions, a counts line with the night's time span, then one line per
  message that addressed her (mention or reply, her name, a role, `@everyone`) with reason, time,
  ref, author and preview. Ordinary chatter, detector picks and chime-ins stay counts. At most
  `life.morningLinesPerPlace` (8) lines per DM or room, the newest, the first saying `+N earlier`.
  In 3.3.0 DMs and rooms were counts only.
- Then watch matches (with the matching message's time and ref; a page's with its URL), watch
  timeouts, her timed wakeups (`reminder`), stopped-wakeup notices (`wakeup_error`) and timed plans
  (only a budget pause defers them), follow-ups and an earlier unread batch.
- Times are `HH:MM`, with the weekday when not on the morning's day.
- Kept lines per place are the newest 50 (`wakeQueue.ts` `morningLinesOf`). Messages counted come
  from the conversation cache since the pause began (at most 10 minutes earlier, `NIGHT_LEAD_MS`).
- Lines at or below a DM's forget floor and lines from a forgotten person are left out; with
  unreadable forget records no line is shown (counts stay) and watch matches keep only her note.
- A batch that shows anything from a DM makes the wake `dm: true`, so the whole turn is a DM turn
  (private in owner views, D14).
- The batch is built from `deferred` as read and taken only if unchanged; it retries up to 5 times
  per tick, else waits for the next tick (no lines lost).

## Busy blocks

During a busy block of today's plan (and only outside her bed time) the router holds what does not
talk to her (`src/life/wakeRouter.ts` guard 4b, `src/life/busy.ts`):

| Gets through at once | Held |
|---|---|
| `dm`, `mention` (incl. replies to her), `name`, `owner`, `reminder`, `plan`, `watch`, `watch_timeout`, `wakeup_error`, `morning` | `detector` picks and chime-ins, `@everyone`, `role` mentions, anything else |

- A merged wake gets through when any of its reasons does (a burst with a mention in it).
- **Held wakes** go to `wakes.json` `held` with `heldUntil` = her next phone check strictly inside
  the block, else the block's end, and `heldFor` = the block's `why`. They never start a turn. At
  most 200 (a new one merges into one for its place, else the oldest goes).
- **Release** (`Scheduler.releaseHeld`, every tick): when she is no longer busy, everything held
  comes back as one notification opening `- free again (<why> is over)`; while still busy, wakes
  whose phone check (as the file says now, so a check she added later counts) has passed come back
  opening `- phone check (busy: <why>)`. Held wakes that come due inside her bed time are deferred to
  the morning instead.
- **Staying in a conversation**: when a wake that got through woke her in a place and she sends
  there, the place is open (`state.busyOpen`) for `life.busyEngagedMinutes` (10 min) after her
  latest send, never past the block's end; held kinds get through there too. Every send there
  extends it; a new block closes it (`noteSend`, `placeOpen`).
- The time line reads `busy: <why> until HH:MM`; Jev leaves her out unless the place is open.

## Bed time

`availability.bedTime` `{enabled, start, end}` (owner-set, `HH:MM` local, may cross midnight;
default disabled 23:00–07:00). Inside it she is in one of three phases, from her last successful
send anywhere (`state.lastSentAt`) (`src/life/clock.ts` `bedPhaseAt`):

| Phase | Exactly when | Time line | What reaches her |
|---|---|---|---|
| **Up late** | Her last send is under `life.busyEngagedMinutes` (10 min) old | `up late` | The busy set (DMs, mentions, replies, her name, owner, her timed wakeups, timed plans, watches, timeouts, stopped-wakeup notices) and anything in a place she sent to in the last 10 min. The rest is deferred to the morning. |
| **Dozing** | Not up late, and less than `life.bedDozeMinutes` (60 min) since the later of the bed time's start and her last send | `dozing (bed time)` | Same as up late. |
| **Asleep** | 60 min or more since the later of the start and her last send | `asleep` | Only her own **timed wakeups** and stopped-wakeup notices (and timed plans that fire late into it) and the **owner's** wakes. Everything else is deferred to the morning. |

- A send of hers starts the clock again (up late, then dozing for another hour). A turn she has
  while asleep (a reminder) does not count unless she sends.
- What waits while up late or dozing is **deferred** (reason `sleep`), never held, and no sleep
  notice goes out (DMs get through then).
- Asleep, a deferred `dm` wake triggers `dm.sleepNotice` (if set, ≤ 300 chars) once per bed time per
  person, sent as an automatic DM (no model call, not rate-counted, `[auto]` in her ReadMessages;
  recorded as `sleepNoticeSentFor` in that person's limits file) (`WakeRouter.maybeSleepNotice`).
- `life.bedDozeMinutes = 0` means asleep as soon as she is not up late (the old hard sleep).
- Busy blocks never apply inside a bed time (they cannot overlap it).
- Jev: up late or dozing she is offered only where she sent in the last 10 min; asleep never.
- The quiet-time rest before her prompt cache goes cold (spec §25,
  [life-and-turns.md](life-and-turns.md)) does not come while she is asleep and her bed time ends
  within the cache TTL (one hour): the morning's `day` compaction resets her anyway. Up late, dozing,
  or asleep with more than an hour of bed time left, it can come (a quiet harness turn nobody sees).
- The status API and Life screen show `Up late` / `Dozing` (`GET /api/waifus/:id/life`
  `availability.bed`).

Example (golden `life-bed-time.txt`, bed time 00:30–08:30, last send 00:28): 00:20 `awake`, 00:35
`up late`, 01:00 `dozing (bed time)`, 01:40 `asleep` (asleep from 01:30).

## Dreaming in the night

Dreaming runs once she has been asleep `life.dreamAfterAsleepMinutes` (15 min) in a bed time that
has had none; a bed time with no such stretch has no dream (pending forget scrubs then run alone when
it ends). See [memory-and-dreaming.md](memory-and-dreaming.md).

## Spec differs

- §21.6c "exactly like the busy rule" for up late: as built any place she sent to in the last
  `busyEngagedMinutes` is open whatever woke her there.
