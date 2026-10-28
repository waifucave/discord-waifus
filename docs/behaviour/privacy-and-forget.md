# Privacy (D14) and forget

## D14: DM content is hidden from the owner's views

DM content is left out of every owner view unless a request **on the host itself** asks for it.
The rule lives in `src/life/lifeView.ts` (`scanDmContent`, `viewLogLine`, `wakeShowsDm`).

**What counts as DM content**

- A **DM turn**: a turn whose wakes include a DM place (`dmWakes`, also a morning batch that shows
  anything from a DM: `wake.dm`, and a `wakeup_error` or `watch_timeout` wake of a watch on a DM or
  on "everywhere" (not a plain `[]` timer), whose error or note may quote one), or in which any tool call resolved to a DM place (`dmCalls`,
  recorded while the tools ran; a tool script (§32) is also one when it names a DM anywhere in its
  text or in any call's argument, even when it then fails or doesn't parse). Outside DM turns, a single call that touched a DM stays hidden with
  its result. Older lines without the records fall back to matching any string argument that names
  `dm/…` or `dm_…`.
- "Touched a DM" includes reading/sending/reacting in a DM (any call of the script, also one before a later error), reading/writing/attaching a DM-origin file,
  a Bash command that listed, read, moved or named anything under `/tmp/dm/` or `/transcripts/dm/` or
  a DM file's path, an `everywhere` search whose result includes a DM, a `Wakeup` that watches a DM,
  and a `Read` or Bash read of `~/life/wakeups.json` while it holds a wakeup watching a DM (or an
  "everywhere" watch's state or stop reason).
- Hidden in a DM turn: her text, every tool call and result, images. Hidden anywhere: the quoted
  part of a DM notification line (it keeps reason, place and sender up to the first `"`), her
  `<life_so_far>` summary, the text of a rest turn and any lone `<summary>` text.
- Replacement text: `[private chat redacted]`.

**Where it applies**

| View | Without a local reveal | Reveal |
|---|---|---|
| Life API `GET /api/waifus/:id/life`, `…/life/log` | Summary hidden; DM wakes' preview/note hidden (an owner note stays); log redacted; DM-turn lines marked `dm: true` | `includePrivate=1` |
| Life screen | Same; reveal toggle "Show private chats" | Toggle (local only; disabled over Remote Access) |
| `waifus life`, `files`, `wakeups` (and `schedule`, `watches`) | Same | `--private` |
| `/print life`, `/print system_prompt` | DM content and her summary hidden; in the system prompt's copy of `MEMORY.md`, the lines `/print notes` hides, and lines linking to a file that no longer exists (the copy is older than her files) (ephemeral, owner only) | `private:true` |
| `/print notes` | `MEMORY.md` with every line that links to a DM-origin file (files-index provenance, or under `/tmp/dm/`) or names a DM (`dm/…`, `dm_…`, `/tmp/dm/…`, `/transcripts/dm/…`, a migrated "(from a private chat…)" suffix) shown as `[private chat redacted]` (indent and list marker kept) and a footer counting them; a `MEMORY.md` whose own bytes came from a DM is not shown ("…Run /print notes private:true to see it, or open Life → Files on the host."); ephemeral, owner only | `private:true` |
| Files API / Life → Files | A DM-origin file is listed as `[private chat redacted]` with no path; reading, writing, deleting it or listing a DM folder → 403; `/transcripts/dm/…` likewise; `wakeups.json` with a wakeup watching a DM (or an "everywhere" watch with a `state`) reads as a redacted, read-only copy (that entry's note, places and filter, and the state, `[private chat redacted]`), and can't be replaced or deleted without the reveal; one that does not parse and may hold a DM → 403; a notes file (`.md`) whose lines link to a DM-origin file or name a DM reads as a read-only copy with those lines `[private chat redacted]` (`hash` is the real file's; PUT/DELETE → 403) | `includePrivate=1` |
| Web searches (`GET /api/search/usage`, Life "Web searches today") | A DM turn's queries (`dm: true`, also marked later by turn id) shown as `[private chat redacted]` | `includePrivate=1` |
| Wakeups API (`GET /api/waifus/:id/wakeups`), Life → Plans, `waifus wakeups`, the assistant's `list_wakeups` | Each wakeup with its source (her filter or check code); one watching a DM (a DM among its places or its filters' places) is a private entry: `private: true`, note, places, filter, state and why it stopped `[private chat redacted]`; an "everywhere" watch's state and stop reason likewise (they may hold a DM's words) | `includePrivate=1` |
| Needs-review lines | A line from her summary or queue, a wakeup watching a DM, or naming a DM place reads redacted (same id); the forget response always redacts them | `includePrivate=1` |
| Dashboard assistant | Never; its tools say DM content stays redacted | Refused: 403 `PrivateContentLocalOnly` ("DM content never goes to the dashboard assistant.") |
| Remote Access | Never | Refused: 403 `PrivateContentLocalOnly` |
| Activity (captured traffic) | Life, maintenance, compaction and web calls are metadata only (never content) | — |

**What "local" means** (`src/api/lifeRoutes.ts` `includePrivateOf`, `src/api/routePolicy.ts`): a
request that came in directly over loopback (`127.x`, `::1`) gets the local principal. A request
dispatched by the Remote Access bridge or by the assistant carries that dispatch's principal and
cannot reveal; `includePrivate` from it answers 403 `PrivateContentLocalOnly` ("DM content is only
shown on the host itself (D14). Open the dashboard on that computer to reveal it.").

The note-line rule is one module (`src/life/notesPrivacy.ts`, `lifeView.ts` `redactNotesLines`) used
by `/print notes`, `/print system_prompt` and the files API. A line she wrote herself about a DM,
without linking a DM file or naming a DM, cannot be attributed and is shown.

The Life view is keyed per waifu and per reveal state; a response whose `includePrivate` does not
match the toggle is dropped (`LifeScreen.tsx` `matchingReveal`).

## Forget paths

| Path | Who | Scope |
|---|---|---|
| `POST /api/people/:userId/forget {confirm: true, dryRun?}` | Owner (dashboard Life → forget form, `waifus forget <userId>`, assistant `forget_person` card) | The person everywhere |
| `POST /api/dms/:waifuId/:userId/forget {confirm, scope: conversation\|all, dryRun?}` | Owner (assistant `forget_dm` card) | One DM; `all` also queues that waifu's full life scrub (`owner_forget`); not rate-limited |
| `/forget conversation` | The person, in a DM with a waifu's bot | That DM |
| `/forget everything` | The person, in a DM | That DM + everything that waifu remembers of them |

**Before anything is removed** (step 0): the person's names are collected (conversation cache
authors, guild directory, DM state, watches, her handles) and split into **unique** names (only they
have them) and **shared/weak** names (someone else has them, ≤ 3 characters, common words, or a
script without word boundaries). Only the id and unique names remove text; shared and weak matches
go to **needs review**. The life scrub is queued durably in `life/pending-scrubs.json` with the names
and the hashes of her files from the person.

### The owner's forget-user

A durable job in `user/people/forget-jobs.json`, written before anything is removed
(`src/orchestration/dm/forgetUser.ts`). Parts, in order (`FORGET_JOB_PARTS`):

| Part | Removes |
|---|---|
| `record` | Adds `{userId, at}` to `user/people/forgotten.json`: their messages at or before `at` render as `someone: (removed)` everywhere (ReadMessages, previews, detector, watch matching) |
| `floors` | Writes or raises a forget floor in every DM with them (never lowered) |
| `dms` | Their DM conversations at or below the floor: refs, image index, cached images and OCR, DM transcripts, archived contexts |
| `dm-directory` | Everything in `user/dms/<userId>/` except `limits/`, whose files are reset to the floor alone |
| `member-lists` | Them from `members.json` and active-chat participant lists |
| `archive` | Their records in `user/.archive/living-cast/` (never `providers.json` or `models/`) |
| `transcripts` | In every room: their own lines at or before `at`, and lines mentioning their id or a unique name |
| `record-copies` | Them from kept copies of unreadable forget records |

Then for **every waifu with a life or a home**, the life scrub (`src/life/forget.ts` `scrubPerson`):

1. **Files**: every file in her home and `/tmp` whose hash the provenance index has from them (their
   DM downloads, their attachments in rooms, exact copies), and `/tmp/dm/<handle>/`; run again under
   her life lock after her turn is aborted, with the hashes kept as tombstones.
2. **Summary**: her turn is aborted; her summary is rewritten without them (no kept turns) on the
   route her epoch ran on, else her model, else `life.dreamModel` (`forget.ts`
   `summaryWithoutPerson`, `scrubModelOf`); the new epoch waits (`pendingEpochStart`). Her summary is
   **never emptied** for want of a model: with **no model at all**, or a summary call that **fails or
   is aborted** (its 5-minute compaction backoff is set), her summary and her epoch (log included)
   stay as they are and the step is left pending (report `summaryScrub: "pending"`). Only
   `compaction.enabled = false` (the owner's choice of no summaries) still empties it.

   **Pending model steps.** Steps 2 and 4 are the only ones that need a model. When either could not
   run (no model) or failed, every other step still runs (step 5 checks her files only while step 2
   waits) and the queued scrub is kept for those steps alone (`pendingSteps: ["summary", "notes"]` in
   `pending-scrubs.json`). They run again at the next scrub run (her nightly maintenance, an owner
   scrub at start) and before her next turn (`LivingCast.summaryStepsBeforeTurn`, after the
   compaction backoff); a run with no model changes and reports nothing. When the summary step runs
   the epoch starts and the summary is checked (`summaryScrub: "done"`); when only the notes session
   runs, her epoch goes on and the prompt's copy of `MEMORY.md` is refreshed from the scrubbed notes
   (`notesScrub: "done"`). The entry is cleared only when no step is left. A new forget of the same
   person queues the whole scrub again.
3. **Other state**: their wakes (and their DM's), their lines in someone else's wake (a quote naming
   them becomes `(removed)`), pending notices, every wakeup in `~/life/wakeups.json` watching their DM,
   with a filter resolved to them, or whose note, code, state, page URL or stop reason names them →
   removed whole (her
   code's waiting state is saved first so it is checked too; a watch word that is only part of one of
   their names is listed for review), a
   queued or deferred `plan` wake's plan texts naming them → `(removed)`, her day file texts, open places, her DM read cursor and handle, `maintenance.jsonl` lines, earlier review
   lines, the host's recent web queries naming them, her archive slice, her transcripts' DM and her
   dream cursor's DM entry.
4. **Notes scrub**: a session with her identity and persona (30 rounds) removes everything about
   them from her notes and fixes the index, on her model, else on `life.dreamModel` (report
   `notesModel: "dream"`). Fails, or neither model is offered → pending (see step 2;
   `notesScrub: "pending"`); without a model one review line says so ("no notes session has run
   yet…"), and meanwhile step 5's line and sentence removal is what her notes get. A queued DM scrub
   runs at nightly maintenance with or without a model (also after a bed time she stayed up
   through): everything but the pending model steps is done that night. A waifu who never gets a
   model again keeps those steps queued (Home lists queued forget scrubs).
5. **Verify and start the epoch**: a note marked as theirs (`<!-- user:<id> -->`) or a `people/` note
   headed by a unique name is deleted whole with its MEMORY.md links; every home text file (not the
   `~/life/` special files) loses lines with the id, list items/headings naming them, and sentences in
   prose naming them; the new epoch starts with **every old epoch log deleted**; the snapshot is
   checked. Review lines go to `life/needs-review.json` (newest 200; Life → Needs review, dismiss
   each).

- Every forget also drops the captured model traffic and `/api/events` replay records that carry the
  person (`forgetCapturedTraffic`, `personMatcher`), and the person's intake marks.
- A part that fails is retried at the next start (before Discord connects), **3 tries in all**; then
  it is given up with an owner notice ("…could not finish its "<part>" part after N tries…"). A
  failed part makes the route answer **202** with `pending`; the life scrubs still run.
- Without a running cast the job runs and the life scrubs are queued (`livesQueued`), each running
  when that life next starts.
- Each part removes only data at or below the job's floor and time: a chat they start after the
  forget stays.

### A person's `/forget`

- `conversation`: the DM data at once (DM conversation, refs, images and OCR, DM transcript at or
  below the floor, archived context; the floor is raised first; rate-limit counters stay), her files
  from that DM, the DM's deferred morning lines and intake mark; then her summary without the DM,
  the DM's wakes, her wakeups watching it, her read cursor at the floor, her dream-cursor DM entry, and
  the epoch starts at once (old log gone). Without a model for the summary (or a failed call), the
  summary and epoch wait as in step 2 (`pendingSteps: ["summary"]`).
- `everything`: the same DM data plus the DM state file, then the full life scrub (steps 1–5) for
  that waifu, including their lines in the rooms she can see. Not added to `forgotten.json` (other
  waifus are untouched).
- **6-hour window**: a person's `/forget` (either scope) runs the life scrub at most once per 6 hours
  (`DM_SCRUB_RATE_MS`). Inside the window the DM data and files still go at once; the life scrub waits
  for her nightly maintenance and her turn is not aborted.
- Neither scope resets the rate-limit counters; floors only go up.

### Floors

Every forget writes a floor message id (`floorMessageId`, the smallest snowflake at the forget's
time) into that person's limits file. The conversation cache (`setFloor`), ReadMessages, the
transcript writer, catch-up, previews and the morning summary never show anything at or below it.

## What forget does not remove

The dashboard, CLI and assistant card state these limits (`FORGET_LIMITS` in
`src/shared/constants/forget.ts`):

1. Discord history itself is not deleted (the bot can't delete other people's messages), and whatever
   she already said in rooms stays there.
2. Usage-ledger lines and app logs stay (they hold ids only, never text).
3. Cached guild images, and any DM image no image index recorded, stay until the disk cache expires
   them (`discord.images.diskCacheTtlHours`, 168 hours by default).
4. Anything outside this host, and the web page cache (`life.webFetch.cacheMinutes`, 15 minutes by
   default), are not touched.
5. Name matching is best effort: a name someone else also has is only listed for review, never
   removed.
6. Files she downloaded from them, and exact copies, are deleted; files she made from someone's
   attachment (for example a cropped copy) can't be traced back to them.

## Unreadable forget records

Only a missing `forgotten.json` reads as empty. An unreadable one fails closed
(`ForgetRecordCorruptError`): human messages' previews and names are hidden (rooms, DMs, edit
mentions), the detector is off, `ReadMessages` answers `error: messages can't be read right now`, and
the owner sees "user/people/forgotten.json is unreadable: message previews are hidden and the
addressee detector is off until it is repaired…". The next forget keeps a `<name>.corrupt-<time>` copy
(deleted after 7 days) and carries over every entry it can still read. A torn `pending-scrubs.json`
is salvaged on read.

## Spec differs

- §18.5 "their whole DM transcripts" is done as "everything at or below the floor at the forget's
  time".
