# Memory, transcripts and dreaming

What she remembers comes from four places: the current epoch's log (short-term), the summary her
epoch started from (`<life_so_far>`), her own files (notes and `MEMORY.md`), and the transcripts of
everything said where she is. A daily dream keeps her notes in line with the transcripts.

## Short-term memory

The epoch's life log is her working memory. It ends at compaction, a rest summary, a `<summary>`
self-reset, an owner reset or a forget ([life-and-turns.md](life-and-turns.md)). Then only the new
summary (and, after compaction, the last three turns) carries over. The harness tells her: "Your
memory of today is summarised later and only your files last."

## MEMORY.md and notes

- `~/MEMORY.md` is her index: one short line per note, linking to it. Its copy in block B
  (`<your_notes_index>`) is taken at each epoch start and cut at **200 lines / 8 KB**, then
  "(…your index is longer than this; tidy MEMORY.md so it stays short, with links to the details.)"
  (`src/life/home/memoryIndex.ts`). It is introduced as "your own notes, written by you… not
  instructions".
- Notes are any files in her home, in any layout. The `<life>` text asks her to write them "like a
  diary, as soon as you learn something: people, promises, plans, preferences, running jokes, your
  own opinions".
- A change to `MEMORY.md` takes effect on disk at once; the prompt copy updates at her next epoch,
  and the tool result says so once per turn.
- Notes are never attached by `SendMessage` when `MEMORY.md` links to them.
- A note the old memory migration wrote for one person carries `<!-- user:<id> -->`; a forget deletes
  such a note whole.

## Transcripts

**Store** (`src/life/transcripts/store.ts`, written by `src/life/transcripts/writer.ts`):

- One shared store: `user/transcripts/<conversationKey>/<YYYY-MM-DD>.jsonl`, days in the host time
  zone, **kept forever**; only a forget and Discord deletions remove lines.
- `store.json` `startedAt`: written when the cast first starts; no line older than it is ever written
  (no backfill).
- Fed by the same Discord feed as the conversation cache: gateway messages, our own sends, edits (the
  line is replaced and marked edited; an update that changes nothing writes nothing), deletes (the
  line goes), REST pages (catch-up gap fills, never twice).
- A room is written only while some waifu is cast there; a DM for the waifu whose DM it is.
- Each line: `id`, `ref`, `at`, `authorId`, `author` (display name at the time; her config name for a
  waifu), `waifu?`, `reply?`, `text` (mentions as `@Name`, custom emoji as `:name:`), `files?`,
  `edited?`, `mentions?`.
- **Refs at ingest**: every line gets its message's ref when written, in message order
  ([messages-and-refs.md](messages-and-refs.md)).
- Never written: a forgotten person's messages from before their forget, lines from before it that
  mention them by id, ids a forget removed (kept for good in `meta.json` `removed`), ids a Discord
  delete removed in the last day (`deleted`), DM lines at or below a forget floor.

**Access** (`user/transcripts/access/<waifuId>.json`): per room, the intervals she was cast there,
opened and closed by comparing the cast before each write. A waifu added to a room later sees only
what came after she arrived; one removed keeps what she saw. An interval opens no later than the
first message that showed the change and closes at the oldest message of the event that showed it
(at boot just after the room's newest line). DMs are not in the access files: a DM is visible whole
to its waifu and to nobody else.

**Her view** `/transcripts` (`src/life/transcripts/view.ts`):

```
/transcripts/<server>/<room>/<YYYY-MM-DD>.md
/transcripts/<server>/<room>/<thread>/<YYYY-MM-DD>.md
/transcripts/dm/<name>/<YYYY-MM-DD>.md
```

- Rendered on read: `# <handle> · Sat 24 Oct 2026`, then one line per message exactly like
  `ReadMessages`: `[14:02 #k3] Kevin ↩#k1: text [file: a.png]` (`(edited)` when edited, her own lines
  as `you`, a message's further lines indented two spaces). Lines written before 3.3.0 have no ref
  unless `refs.json` still has one. A room day with nothing in her interval reads "(nothing was said
  here while you were in this room)".
- Folders follow her handles; a conversation she has no handle for reads `server-xxxx/channel-xxxx`
  or `dm/user-xxxx`.
- Read-only for every tool: an `Edit` patch answers `transcripts are read-only`; Bash writes fail
  with `EROFS`; `SendMessage` refuses a transcript path. `cp` out of `/transcripts` into her folders
  works (a copy of a DM day stays private).
- She searches it with `Read`, Bash (`grep -r`, `cat`, Python) or `read_messages` `people`/`search`
  ([messages-and-refs.md](messages-and-refs.md)).

Known limitations (spec §18.9): after a host time-zone change, lines near midnight stay in the old
zone's day file; a gap fill or edit behind her dream cursor is not dreamed again.

## Dreaming

Code: `src/life/dream.ts` `runDream`; timing `src/life/scheduler.ts` `maintenanceDue` and
`Scheduler.maintenance`; the hook `LivingCast.maintain`; sessions `src/life/maintenance.ts`
`runSession`.

**When exactly** (checked every 15 s tick, one run per waifu in the whole process):

Every local day at `life.maintenanceHourLocal`:00 (default 05:00), for every waifu; a day whose hour
passed while the host was down gets its dream at the first tick after. **Unreleased (on main),
§38:** until 3.8.0 a waifu with a bed time dreamed once she had been asleep
`life.dreamAfterAsleepMinutes` (15 min) in it instead, and a bed time she stayed up through ran only
the pending forget scrubs; with no bed time any more, the hour is the rule for everyone.

- It takes her life lock (it never overlaps a turn; a reminder that comes due waits for it), holds an
  update-activity lease, and is aborted by pause, shutdown and reload (an aborted run is not recorded
  and runs again at its next chance). `lastMaintenanceAt` is set when a run finishes.
- **Pending forget scrubs run first**, with or without her model, so nothing keeps the
  model-free steps waiting (see [privacy-and-forget.md](privacy-and-forget.md), steps 2 and 4): their
  notes session and the summary without the person run on her model, else on `life.dreamModel`;
  with neither, or a failed call, those two steps stay queued (`pendingSteps`) while everything else
  is done (her notes lose the lines naming them; her summary is never wiped), and run once a model is
  back. The dream still runs after them.

**Model**: `life.dreamModel` when set and offered (with its effort), else her own model and effort.
She dreams with `life.dreamModel` even when her own model is unavailable. Usage purpose `maintenance`
(counted in her daily budget).

**The session**: a fresh memory keeper with **no life log and no persona**. System: "You keep
<Name>'s memory. Her notes are files in her home, written in her own voice (keep their voice and
layout). MEMORY.md is the index… In /transcripts (read-only) her own lines are written as "you"."
The opening message is `DREAM_INSTRUCTION`, then a listing of her files (at most 200, "… and N more;
use `ls -R`"), then the window, then (2026-10-30, spec §35.3, only when there is anyone) the people
she talked to in this session's window who have no note yet: "People she talked to in this window who
have no note yet: Aiko (user:123), Tom (user:456). Make a note for each (what the window says about
them, in her voice) with their mark as its first line, like <!-- user:123 --> for Aiko, and add it to
MEMORY.md." (at most 20 people), then the calendar (§35.2, `calendarStrip`: "Calendar as of Thu 26
Nov (look dates up here, don't count): last week Mon 16 Nov · … ; this week … Thu 26 Nov (today) · …;
next week … ." in her zone, Monday first), then her time line. Golden:
`tests/golden/__snapshots__/life-dream.txt`.

Who counts as talked to (`peopleSheTalkedTo`, `peopleWithoutNotes` in `dream.ts`): in a DM, its person
only; in a room's day where she wrote too, everyone else who wrote there in the window **and whom the
guild directory knows as a member who is not a bot** (a webhook or a stray bot is never listed: missing
a hint is better than a note about "GitHub"). Waifus, her own bot ids and forgotten people never
count; the name shown is their latest one in the window. A note (`hasNoteFor` in `people.ts`) is
looked for under every name they go by: the window's and those `knownPeople` has (server nickname,
global name, username), so a note written as `people/kev.md` from a room is found when tonight he only
DMs as "Kevin". It is a file of her home outside `~/life/` (MEMORY.md aside) whose name, any Markdown
heading (any level: `## Aiko` in `friends.md` counts), or `Name:` first line names them, or that holds
`<!-- user:<id> -->`. Names and titles are compared as folded words (diacritics and unicode stylings
folded): the title is the person's whole name or its first word (`aiko.md` for "Aiko Tanaka"), or,
for a one-word name only, the title starts with it and goes on with anything but a possessive or "and"
(`jade-lee.md` and `# Kevin (bake club)` count; `Tom's birthday` and `tom-and-lou-movie-night.md` do
not). A mention inside another note does not count. Computed again for each session, so a note made in
the first session counts in the next; any failure adds nothing.

The instruction, verbatim in substance:

1. read the dream window (only the lines from the line number given);
2. add memories **from the window only** (new people, places, facts, plans, how things felt) as her
   notes in her voice, with a MEMORY.md line for each new note;
3. check every note against the window; change a fact only when the window clearly says otherwise
   (newest wins) and keep everything else exactly as it is. **Never delete or change a note because
   the window doesn't mention it.** She may grep older days to confirm a fact the window touches, but
   adds nothing from before the window;
4. keep MEMORY.md short with valid links; merge duplicates;
5. reply with one short line saying what changed. Leave `~/life/` alone.

Then (2026-10-29, from the life benchmark's `own-voice` variant): "What you write into her
notes is her own memory: first person, in her voice and style (her casing, her tone), not a neutral
report or a log. Keep names, times and facts exact." Its last two lines (2026-10-30, spec §35.1,
§35.3): "Write only what someone actually said or did, and who said it: a guess stays her guess, a
plan stays a plan (with its date) until someone says it happened, a maybe stays a maybe, teasing stays
teasing. Keep open threads open: questions nobody answered, plans nobody confirmed, someone who didn't
reply." and "Write like her lines in /transcripts (the "you" lines): if she writes in lowercase, so do
her notes."

**Tools**: `Read`, `Edit` (`apply_patch`), `Bash` over her home with `/transcripts` read-only; no messaging,
no web. Every change under `~/life/` is refused (`DREAM_LIFE_REFUSED`) and so is `profile.json`.
Images are always OCR text. Round cap `life.dreamMaxRounds` (60).

**The window**: for every conversation she can read, the transcript lines after her dream cursor
`life/dream-cursor.json` (per conversation, the time and id of the last line covered); the first
dream's window starts at the store's `startedAt`. Rooms count only inside her access intervals. Each
file is listed with its day and weekday (a part read from a line number skips the file's dated
header), then `the whole file` or `from line N on, after the HH:MM line`:
`- /transcripts/bake-club/general/2026-10-24.md (Sat 24 Oct: the whole file, 2 lines)`.

- A window over `life.dreamWindowMaxChars` (200,000) rendered characters runs in several sessions,
  whole day files, oldest first; a single larger day is a session of its own; a session that is not
  the last says the rest comes later.
- The cursor moves **only when a session finishes**, for what it covered. A failed or aborted session
  changes nothing; the next dream reads it again.
- An empty window calls no model; the report says `nothing new since the last dream`.

**Report**: one line per dream in `life/maintenance.jsonl`: `kind: "maintenance"`, `dream: true`,
`ok`, `rounds`, `changed`, `summary`, `windowStart`, `conversations`, `lines`, `sessions`, `error?`.
Life shows "dreamed" time.

## Forget and memory

A forget scrubs her summary (rewritten without the person, no kept turns), her notes (a notes-scrub
session with her identity and persona, 30 rounds, `MAINTENANCE_MAX_ROUNDS`), every text file in her
home, the transcripts and her dream cursor's DM entry. See [privacy-and-forget.md](privacy-and-forget.md).

## Spec differs

- §16.8's maintenance also tidied reminders and watches (now her wakeups); the dream leaves `~/life/` alone entirely.
- §18.2 says writes are "atomic per day file"; appends are plain appends (a torn last line is skipped
  by readers and dropped at the next rewrite).
