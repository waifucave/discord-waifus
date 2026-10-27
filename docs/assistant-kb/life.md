# A waifu's life

How to see what a waifu is doing, wake her, compact or reset her life, and forget a person.

## What a life is

Each waifu is an autonomous agent with one continuous life. Things that concern her (a mention, a
reply, her name, a DM, one of her reminders or watches, the addressee detector's pick) arrive as
wakes in her queue. She handles them one turn at a time: she reads, decides what to do, and only
what she sends reaches people. Her life is split into epochs: when it grows long, compaction
summarises it into her `<life_so_far>` and a new epoch starts with her last few turns kept.

**Resting.** Before that happens she summarises herself. When her last request reaches
`life.restNoticeRatio` (default 0.85) of the compaction trigger, the turn after the running one is
a rest turn: a notice tells her that her context will be reset to the summary she writes now, that
her home, `/tmp` and `/transcripts` stay as they are, and to write it clearly. In that turn she can
use her files, Bash, reminders and watches, but SendMessage, React, WebSearch and WebFetch answer
"finish your summary first". Queued wakes wait until after it. If her final reply is at least
`life.restSummaryMinChars` (default 200) characters, a new epoch starts from that summary alone
(Life shows "rested (her own summary)"); a shorter reply, a failed turn or a cap means compaction
summarises for her as before. One rest notice per epoch. What she writes in a rest turn is her
summary, so like her `<life_so_far>` it is hidden in the owner's views unless revealed on the host. `life.restNotice = false` turns it off
(her time line then warns her that her memory is nearly full, as before).

**A fresh start of her own.** She can also reset herself: a turn whose final reply is only
`<summary>…</summary>` starts a new epoch from that summary alone (Life shows "rested (her
choice)"; private like a rest summary) when it is at least `life.restSummaryMinChars` long, her last
request was at least `life.selfSummaryMinRatio` (0.3) of the compaction trigger, and her last epoch
began at least `life.selfSummaryCooldownMinutes` (120) ago. Otherwise nothing resets and her next
time line says once why her summary was not used.

**Notifications.** Several messages in one place (a burst, or wakes queued while she was busy)
are one wake and one turn, but she sees one notification line per message, in order, each with
its reason, the place, the sender, its ref and a short preview: a mention, her name, `@everyone`
or a watch match is on the line of the message it belongs to, and a message around it that was
not for her has a line with no reason. At most `life.notificationLinesPerPlace` (default 8)
lines per place, the newest; the first then says `+N earlier`.

## Her day

Every morning she writes her own day in `~/life/schedule.json`: when her bed time ends (or at
`life.dayStartHourLocal`, 8 by default, without one) a morning wake asks her to plan it before
anything else, followed by what waited overnight; after that turn her context is compacted (reason
`day`) so her prompt's `<schedule>` shows today's plan. The file is a JSON object: `date`
(today, YYYY-MM-DD), `mood`, `busy` (blocks `{from, to, why}`, HH:MM, no overlaps, never in her bed
time), `phoneChecks` (HH:MM), `plans` (`{at?, what}`) and `note`; a broken one is refused with its
line and column. She may change it during the day; a Write, Edit or Bash change to it (or to
MEMORY.md) tells her the prompt's copy updates at her next summary.

**Busy.** In a busy block DMs, mentions, replies, her name, the owner's wakes, her reminders and
watches reach her at once; detector picks, chime-ins, `@everyone` and role mentions and follow-ups
are held until her next phone check in the block (else its end) and arrive together with a line
saying why. A place where something that got through woke her and she then sent stays open for
`life.busyEngagedMinutes` (10) after her latest send there.

**Bed time** (`availability.bedTime`, the owner's) is soft. In it she is *up late* while her last
send is under `life.busyEngagedMinutes` old (people talking to her, and places she just sent to,
reach her), then *dozing* until `life.bedDozeMinutes` (60) after the later of the bed time's start
and her last send (like busy, but what waits is kept for the morning), then *asleep*: only her own
reminders and the owner's wakes reach her, a DM gets the sleep notice once per bed time, and
everything else waits for the morning wake at the bed time's end. A send of hers starts the clock
again. The detector counts her up late as awake, dozing as busy and asleep as asleep.

## Seeing it

- Dashboard → Life: her status (awake, busy, up late, dozing or asleep; idle or mid-turn), her queue, today's cost
  against her budget, and a live timeline of her life log.
- `waifus life <id> [--log]`, or `GET /api/waifus/:id/life` and `GET /api/waifus/:id/life/log`.
- `/print life` and `/print system_prompt` (House bot, owner only) in Discord.

Content from private chats is hidden by default everywhere: a DM notification; every tool call,
result and her own text in a turn that touched a DM (a web search or a room send included); a call
that touched a DM in any other turn; and her summary. The owner can
reveal it on the host itself (the Life screen's reveal toggle, `waifus life --private`,
`includePrivate=1`, `/print … private:true`). Over Remote Access, and for the dashboard assistant,
it stays hidden.

## Acting on it

- **Wake**: an owner wake with an optional note she sees. It skips her bed time and budget. With
  Discord offline it waits in her queue.
- **Compact**: summarise her life now and start a new epoch. Needs Discord connected and a model.
- **Reset**: start a fresh epoch with no summary. Her files (notes, reminders and watches) and
  queued wakes stay; the old log is kept for 7 days.
- **Needs review**: after a forget, lines that mention a name someone else also has are listed per
  waifu instead of being removed. Check each one and dismiss it.

## Her own computer: files, reminders and watches

Each waifu has her own small, isolated machine. She works in it with Read, Write, Edit and a
simulated Bash (nothing she runs can reach the host or the network):

- **Her home** `/home/<name>` (`~`): her notes, in any layout she likes; `MEMORY.md` is her index
  (one line per note, copied into her prompt at each epoch start). The files the app reads are in
  `~/life/` (SendMessage never attaches them, like MEMORY.md and her notes; a `~/life/` folder of
  her own from before 3.3.0 was renamed `~/life-notes/`):
  `schedule.json` her day (see "Her day"), `reminders.json` her reminders and `watches.json` her
  watches (she sets them with ScheduleWake and WatchFor and changes or cancels them by editing the
  files); `places.md` lists her rooms and private chats and is kept up to date by the app
  (read-only); `profile.json` is her Discord profile (`name` shown read-only,
  `username`, `bio`, `nicknames` keyed by server as her places name it, like `bake-club`): the
  same values as her waifu config, so her edit changes her config (and her bot), and a dashboard
  edit rewrites the file. A bad edit (Discord's username rules, a bio over 400 characters, a nickname
  over 32, an unknown server, a changed `name`) is refused and nothing changes; it can't be deleted
  and her nightly dream never changes it.
- **`/tmp`**: files people sent (ReadMessages downloads attachments there) and scratch files, each
  deleted `life.tmp.retentionDays` days (7 by default) after it was last written.
- **`/transcripts`** (read-only): everything said where she is, kept forever, one file per place per
  day: `/transcripts/<server>/<room>/<YYYY-MM-DD>.md` (threads in a folder below their room) and her
  private chats under `/transcripts/dm/<name>/`. A line reads like her ReadMessages lines,
  `[14:02 #k5] Kevin ↩#k3: text [file: a.png]` (her own lines as `you`; every message gets its ref
  when it is written, and a ref stays usable for as long as its line exists). She searches it with
  Read and Bash (`grep -r`, `cat`, Python), or with ReadMessages: `people:` and `search:` (one place,
  several, or `everywhere`; newest days first, at most 400 days per place and 32 MiB per call, and
  the reply says which days it searched and, for `everywhere`, which places the limit cut) read it, and `before|after|around` a ref, a time or a day
  jump into a conversation; nothing
  can change it and SendMessage can't attach it. A waifu added to a room later sees only what was
  said after she arrived; one removed from it keeps what she saw. The app writes it (one shared
  store, `user/transcripts/`) from the same Discord feed as everything else, from the first message
  after the upgrade on; only a forget and Discord deletions remove lines.

Limits: her home holds `life.home.maxBytes`, `life.home.maxFiles` files and `life.home.maxFolders`
folders; `/tmp` holds `life.tmp.maxBytes` and `life.tmp.maxFiles` files. One Bash command may save
at most 5,000 files and folders at once, and is stopped (nothing saved) when the host's memory
grows past `life.bash.maxMemoryMb` while it runs. Names are compared as a case-insensitive disk
does: `~/Memory.md` is `~/MEMORY.md`.

To look at them: Dashboard → Life (a file browser for her home, `/tmp` and her transcripts, with a
text editor and image previews, and her reminders and watches with delete buttons), `waifus files
<id> [path] [--root tmp|transcripts]`, `waifus schedule <id>`, `waifus watches <id>`, or the routes `GET /api/waifus/:id/files`,
`GET|PUT|DELETE /api/waifus/:id/files/<path>`, `GET /api/waifus/:id/schedule` (her reminders) and `/watches`. A save
from the dashboard or the API passes the same checks as her own Write tool: `life/places.md` is refused,
`life/schedule.json`, `life/reminders.json`, `life/watches.json` and `life/profile.json` must stay valid (a broken one is refused with its line and
column, and nothing is saved), and a file changed since it was read is a conflict. Transcripts are
read-only there too (`PUT`/`DELETE` answer 400 `ReadOnlyFile`).

Files from private chats (a download from a DM, a copy she made of one, anything under `/tmp/dm/`,
her DM transcripts under `/transcripts/dm/`, and an exact copy of one in her home) are listed as `[private chat redacted]` and open only with the reveal on the host; a watch bound to
a DM is shown without its words, and `watches.json` itself then reads as a redacted, read-only copy
(changing or deleting it needs the reveal on the host). Over Remote Access, and for the dashboard assistant, they stay
hidden. The assistant can list and read her files and propose a write (`write_file`), which only a
click on its secure dashboard card applies.

## Dreaming

Once she has been asleep `life.dreamAfterAsleepMinutes` (15) in her bed time (at most once per bed
time; a night she is never asleep that long has no dream, and the next one covers both days), or at
`life.maintenanceHourLocal` for a waifu with no bed time, her memory is tended by a dream: a separate memory keeper with no life log and no persona, using
`life.dreamModel` when it is set (Settings → Life, "Dream model") and her own model otherwise. It
reads the dream window, everything said in her transcripts since her last dream, then:

- adds memories from that window only (new people, places, facts, plans, how things felt), as her
  notes in her voice, with a line in MEMORY.md for each new note;
- checks every note against the window: a fact the window clearly contradicts is patched (the newest
  wins); a note the window doesn't mention stays exactly as it is. Absence of evidence is never a
  reason to delete or change a note;
- keeps MEMORY.md short with valid links.

Her dream cursor (`life/dream-cursor.json`) moves only when a dream finishes, so a failed or
interrupted one is read again the next night. A long window (over `life.dreamWindowMaxChars`
characters) runs in several sessions, oldest days first; each session has at most
`life.dreamMaxRounds` tool rounds. A night with nothing new calls no model. Each dream adds one
line to her `maintenance.jsonl` (window start, places, lines, sessions, what changed). Queued forget
scrubs still run first (after a bed time without a dream, they run alone when it ends). Dreaming never
changes anything under `~/life/`. `waifus help dreaming` explains it on the command line.

## Forgetting a person

`POST /api/people/:userId/forget`, `waifus forget <userId>` or the Life screen's forget form removes
a Discord user from every DM, the member lists, the archive and every transcript (their lines, the
lines that mention them or a name only they have, and their DM transcripts whole), and scrubs every
waifu's life log, summary, queue and files (her notes and every other text file in her home, her
reminders and watches, and the files the person sent her). A DM user's `/forget conversation`
deletes that DM's transcript; `/forget everything` also removes their lines in the rooms that
waifu can see. Forget is a best-effort scrub:

- Discord history itself is not deleted, and whatever she already said in rooms stays there.
- Usage-ledger lines and app logs stay (they hold ids only, never text).
- Cached guild images, and any DM image no image index recorded, stay until the disk cache expires
  them (`discord.images.diskCacheTtlHours`, 168 hours by default).
- Anything outside this host, and the web page cache (`life.webFetch.cacheMinutes`, 15 minutes by
  default), are not touched.
- Name matching is best effort: a name someone else also has is only listed for review.
- Files she downloaded from them, and exact copies, are deleted; files she made from someone's
  attachment (for example a cropped copy) can't be traced back to them.

A part that fails runs again at the next start, three tries in total (the request's run counts as
the first); then it is given up and shows as an owner notice (Home, `waifus doctor`).

## Costs

Every model call is in the usage ledger. `GET /api/usage`, `waifus usage` and Activity → Usage add
it up by local day, waifu, purpose or model. A waifu's `life.dailyBudgetUsd` holds her ordinary
wakes until the next local day once reached.
