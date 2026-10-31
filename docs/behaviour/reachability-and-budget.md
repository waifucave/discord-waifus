# When she is reachable, and the budget's batch

**Unreleased (on main):** spec §38 (owner request, 2026-10-31). She has **no day schedule and no bed
time**: she is reachable at any hour. Only her daily budget makes wakes wait. Until 3.8.0 her own
`~/life/schedule.json` (busy blocks, phone checks, timed plans) and the owner's bed time
(`availability.bedTime`: up late, dozing, asleep) decided when she was reachable; both are gone.

All times are in the host's time zone (`src/life/clock.ts`).

## At any hour

- The wake router has no sleep guard and no busy guard (`src/life/wakeRouter.ts`: paused, DM rate
  limit, per-user wake limit, daily budget, room loop guard; see [triggers.md](triggers.md)). A
  mention at 03:00 wakes her like one at 15:00. Nothing is held, nothing is deferred for the night,
  and no automatic sleep notice is sent.
- Jev (the addressee detector) offers every cast waifu in the place except one over her daily
  budget ([detector.md](detector.md)).
- Her time line names only the time: `[Sat 24 Oct 14:06]` (it said `· awake`, `· busy: …`,
  `· up late`, `· dozing (bed time)` or `· asleep` before).
- Her system prompt has no `<schedule>` section and no sentence about her day; there is no morning
  wake asking her to write a schedule and no `day` compaction after it.
- Dreaming runs once a day at `life.maintenanceHourLocal` (default 05:00) for every waifu
  ([memory-and-dreaming.md](memory-and-dreaming.md)).
- **`~/life/schedule.json` is an ordinary file now.** A file of that name (one she writes after the
  upgrade) is treated like any other file of hers in `~/life/`: no JSON or field checks, no note in
  the tool result, never in her prompt, private (never attached by SendMessage) and left alone by her
  dream. The upgrade archives the old one (below).

## The budget's batch

Over her daily budget (`life.dailyBudgetUsd`, the router's guard 5, and at a turn's start for wakes
queued before it ran out) a wake is **deferred**: kept in `wakes.json` `deferred` (reason `budget`,
`since` its first deferral) as per-place counters with message lines, plus every reminder, watch
match, timeout and owner note with its note (`wakeQueue.ts` `withDeferred`). The owner's wakes are
exempt.

`Scheduler.releaseDeferred` (every 15 s tick) releases it as **one** wake once she is under budget
again (her next local day, or the owner raised or removed the budget): reason `morning` (the name
is kept from when this batch came with her morning), its rendered lines in `batch`, `dm: true` when
anything in it is from a DM (D14: the turn is a DM turn). It is enqueued directly, and folds into a
running turn like any wake. Golden: `tests/golden/__snapshots__/life-budget-batch.txt`,
`life-morning-summary.txt` (the format, `notifications.ts` `morningBatch`).

```
- while you were away (since Sat 24 Oct 14:00):
  · DMs:
    · dm/kevin · Sat 24 Oct 14:00 #a0 "hey"
    · dm/kevin · Sat 24 Oct 14:00 #a1 "are you there?"
  · bake-club/#general: 1 mention, 1 message (Sat 24 Oct 14:00)
    · mention · Sat 24 Oct 14:00 #a0 from Kevin "<@Ella> you around?"
  · watch matched · bake-club/#general · "brownie" · from Mina · Sat 24 Oct 14:00 #a1 · your note: "Mina wanted brownie tips"
  · watch timed out (Sat 24 Oct 14:20) · your note: "check if the bake sale flyer is up"
```

(A watch-timeout line adds ` · you've written in <place> 3 times since anyone answered (since Mon
21:00)` for a place the watch named where she has written twice or more with no answer, spec §34.)

- Header `- while you were away (since HH:MM):`, with the day when the pause began on another day
  than the release's.
- (§23) **DMs** one line per message (time, ref, 60-character preview), oldest first; **rooms** by
  most mentions, a counts line with the span of their messages, then one line per message that
  addressed her (mention or reply, her name, a role, `@everyone`) with reason, time, ref, author and
  preview. Detector picks, chime-ins and ordinary chatter stay counts. At most
  `life.notificationLinesPerPlace` (8) lines per DM or room, the newest, the first saying
  `+N earlier` (`life.morningLinesPerPlace` did this until §38).
- Then watch matches (with the matching message's time and ref; a page's with its URL), watch
  timeouts, her timed wakeups (`reminder`), stopped-wakeup notices (`wakeup_error`), timed plans
  (only one queued before the upgrade), follow-ups and an earlier unread batch.
- Times are `HH:MM`, with the day (`Mon 26 Oct 23:50`) when not on the release's day; a watch
  timeout, a reminder and a plan always carry their day.
- Kept lines per place are the newest 50 (`wakeQueue.ts` `morningLinesOf`). Messages counted come
  from the conversation cache since the pause began (at most 10 minutes earlier, `BATCH_LEAD_MS`).
- Lines at or below a DM's forget floor and lines from a forgotten person are left out; with
  unreadable forget records no line is shown (counts stay) and watch matches keep only her note. A
  forget drops the person's waiting lines at once (`dropDeferredOf`).
- The batch is built from `deferred` as read and taken only if unchanged; it retries up to 5 times
  per tick, else waits for the next tick (no lines lost).

## After the upgrade from 3.8

- The migration `living-cast-no-schedule-v1` archives and drops each waifu's `availability` (her
  bed time), `scheduleInPrompt` and `dm.sleepNotice`, the five `[life]` settings of her day and bed
  time from `config.toml`, archives her `~/life/schedule.json` and deletes `life/plans-fired.json`;
  a life that has begun starts a new epoch before her next turn (summarised, no kept turns). See
  [owner-controls.md](owner-controls.md).
- A queue saved by 3.8 may hold wakes deferred for her bed time (reason `sleep`) and wakes held for
  a busy block (`held`): the first scheduler tick releases the held ones as ordinary wakes and the
  deferred ones as one batch (or keeps them for her budget when she is over it). An old `morning`
  or `plan` wake still in the queue is delivered as it was; old state keys (`lastDayStart`,
  `dayCompactionDue`, `busyOpen`, `lastSentAt`) and wake fields (`day`, `heldUntil`, `heldFor`,
  `released`) are dropped when read.
