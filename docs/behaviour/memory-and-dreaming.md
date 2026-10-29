# Memory, transcripts and dreaming

What she remembers comes from four places: the current epoch's log (short-term), the summary her
epoch started from (`<life_so_far>`), her own files (notes and `MEMORY.md`), and the transcripts of
everything said where she is. A nightly dream keeps her notes in line with the transcripts.

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

| Her setup | When the dream runs |
|---|---|
| Bed time on | Once she has been **asleep** for `life.dreamAfterAsleepMinutes` (15 min) in a bed time that has had no maintenance yet (at most once per bed time) |
| Bed time on, never asleep that long (up all night) | No dream that night. When that bed time ends, pending forget scrubs run alone (only if some wait). The next dream's window covers both days. |
| No bed time | Every local day at `life.maintenanceHourLocal`:00 (05:00) |

- It takes her life lock (it never overlaps a turn; a reminder that comes due waits for it), holds an
  update-activity lease, and is aborted by pause, shutdown and reload (an aborted run is not recorded
  and runs again at its next chance). `lastMaintenanceAt` is set when a run finishes.
- **Pending forget scrubs run first**, with or without her model, so no night or bed time keeps the
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
use `ls -R`"), then the window, then her time line. Golden: `tests/golden/__snapshots__/life-dream.txt`.

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

**Tools**: `Read`, `Edit` (`apply_patch`), `Bash` over her home with `/transcripts` read-only; no messaging,
no web. Every change under `~/life/` is refused (`DREAM_LIFE_REFUSED`) and so is `profile.json`.
Images are always OCR text. Round cap `life.dreamMaxRounds` (60).

**The window**: for every conversation she can read, the transcript lines after her dream cursor
`life/dream-cursor.json` (per conversation, the time and id of the last line covered); the first
dream's window starts at the store's `startedAt`. Rooms count only inside her access intervals. Each
file is listed as `the whole file` or `from line N on, after the HH:MM line`.

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
