# Her own computer

Each waifu works in a small isolated machine: two folders of her own, a read-only `/transcripts`,
eleven tools, and a simulated Bash. She never sees a host path.

## Her folders

| Path she sees | What | Backed by |
|---|---|---|
| `/home/<slug>/` (`~`) | Her home and working directory: her notes in any layout, `MEMORY.md`, `~/life/` | `user/waifus/<id>/home/` |
| `/tmp/` | Downloads from `ReadMessages` and scratch files; each file deleted `life.tmp.retentionDays` (7) days after it was last written | `user/waifus/<id>/tmp/` |
| `/transcripts/` | Read-only: everything said where she is, one file per place per day | rendered from `user/transcripts/` |

- `<slug>` is her name lower-cased and ASCII-folded, other characters `-`; `me` when nothing is left
  (`src/life/home/pathRules.ts` `herSlug`).
- Paths are absolute, `~`-based or relative to her home. After normalising they must stay inside
  her home or `/tmp` (or `/transcripts` for reading); `..` that leaves is refused (`resolveHerPath`).
- At most **8** folders deep; each name 1–100 characters, no control characters, no `\`, no NUL, not
  `.`/`..`, not ending in a dot or space, never a Windows device name in any disguise (`con`, `aux.`,
  `COM¹`, `lpt1 .md`).
- Names are compared as a case-insensitive disk does (`collisionKey`: NFC + lower case): `~/Memory.md`
  is `~/MEMORY.md`, `~/Life/Watches.json` is `~/life/watches.json`. Two names in one folder that
  differ only by case are refused when a write would create the second.
- No links: never created (Bash `ln` fails), an existing one on disk is never followed, listed or
  written through.

**Limits** (settings, checked on every write path: her tools, Bash change sets, the API):

| Limit | Default |
|---|---|
| Home size / files / folders | 50 MiB / 2,000 / 500 (`life.home.*`) |
| `/tmp` size / files | 200 MiB / 2,000 (`life.tmp.*`); a download that would overfill `/tmp` deletes the oldest `/tmp` files first |
| One file by `Write`/`Edit`/API `PUT` | 256 KiB (`WRITE_MAX_BYTES`) |
| One Bash change set | 5,000 files and folders, checked within 30 s |

A limit hit is an `is_error` result naming it ("your home is full (50 MiB); delete or shorten
something first"); nothing is written.

## Pre-set files and folders

| Path | Purpose | Format | Written by | She can change it? | Delete? | Checked | On change |
|---|---|---|---|---|---|---|---|
| `~/MEMORY.md` | Index of her notes, one short line per note linking to it | Markdown | Her (and the dream) | Yes | Yes | Path/size rules only | Copy in her prompt updates at the next epoch; stale-copy note in her result |
| `~/` (anything else) | Her notes, any layout | Text or any file | Her (and the dream) | Yes | Yes | Path/size rules | — |
| `~/life/` | Her daily machinery (all files here are private: never attached) | folder | App + her | Its files as below | The folder can't be removed while it holds `places.md` | — | — |
| `~/life/schedule.json` | Her day ([day-and-bed-time.md](day-and-bed-time.md)) | JSON object | Her (each morning) | Yes; Write needs no prior Read | Yes (= no plan) | Strict JSON + field rules, busy not in bed time | Live for routing, Jev and the time line; prompt copy at next compaction |
| `~/life/reminders.json` | Her reminders (`ScheduleWake` appends) | JSON array of `{id?, at, repeat?, note}` | Her + app (fires, removes, moves) | Yes; whole-file Write needs a current Read this turn | Yes (= no reminders) | Strict JSON; `at` local `YYYY-MM-DD HH:MM`, 5 min–30 days ahead (an unchanged past `at` kept), `repeat` daily/weekly, note ≤ 200, ids unique, ≤ 20 | New entries get the next `r<n>` id and the file is rewritten one entry per line |
| `~/life/watches.json` | Her watches (`WatchFor` appends) | JSON array of `{id?, timeout, once?, note, when[]}` | Her + app (match, timeout) | Yes; whole-file Write needs a current Read | Yes (= no watches) | Strict JSON; timeout in the future, ≤ 7 days; ≤ 5 bindings, each `place`/`from`/`words` (1–10, ≤ 60 chars)/`any_message`; names resolvable; ≤ 10 watches; a `once` watch that already matched can't come back | `from` names resolved to user ids in `life/watch-ids.json` |
| `~/life/profile.json` | Her Discord profile: `name` (read-only), `username`, `bio`, `nicknames` keyed by server slug | JSON object | Her + app (rewritten from her config) | Yes, outside sessions; whole-file Write needs a current Read | **No** | Discord username rules, bio ≤ 400, nickname 1–32, known servers, `name` unchanged | Saved to her config, then profile sync runs; the result says when Discord will show it |
| `~/life/places.md` | Her rooms, her servers' emojis and her DMs | Markdown | App only (≤ 1/min, every turn start, when a new place folds in) | **No** (`places.md is kept up to date for you and can't be changed`) | **No** | — | — |
| `/tmp/<place>/<ref>-<name>` | Attachments `ReadMessages` downloaded | the file | App | Yes | Yes | `/tmp` limits | Expire after 7 days |
| `/tmp/dm/<name>/…` | Downloads from a DM | the file | App | Yes | Yes | — | Private (D14) |
| `/transcripts/…` | Transcripts | rendered Markdown | App | **No** (`EROFS: transcripts are read-only`) | **No** | — | `cp` out into her folders works |

Sources: `src/life/home/pathRules.ts` (`LIFE_FILES`), `src/life/home/homeStore.ts` `checkSpecial`,
`src/life/home/specialFiles.ts`, `src/life/home/daySchedule.ts`, `src/life/home/profileFile.ts`,
`src/life/tools/files.ts`.

- **Read before Write** (reminders, watches, profile): the turn remembers the hash she read; a
  missing file counts as read when she read it missing. Otherwise `error: watches.json already
  exists; Read it first (Write replaces the whole file)` or `error: watches.json changed since you
  read it (a watch matched or timed out); Read it again` (`(a reminder fired)`, `(your profile was
  changed for you)`). `Edit` works on the current file and needs no Read.
- **profile.json in sessions**: nightly dreaming and a forget's notes scrub refuse Write/Edit/Bash
  changes to it (`error: profile.json isn't changed while tidying; leave it as it is`); the forget
  scrub never edits it.
- **Dreaming** refuses every change under `~/life/` (`DREAM_LIFE_REFUSED`).
- **places.md** (`src/life/home/index.ts` `placesFileText`): `Rooms:` (one line per room, see
  [rooms.md](rooms.md)), then `Server emojis:` with one line per server she is cast in that has
  usable emojis, `- bake-club (Bake Club): :kekw: :pepe_cry: :blobheart: (+12 more)` (the server as
  her handles name it; a paused server too), then `Private chats:` (see [dms.md](dms.md)). No server
  with emojis: no `Server emojis:` section. Only `available` emojis, one per name, at most 50; most
  used first, counted as `:name:` in the server's transcript lines (every room and thread, whoever
  wrote them) of the last 30 days, then by name (case-insensitive); animated ones like the others.
  Reactions are not in transcripts, so they don't count. The counts are kept in memory per server
  and recounted at most once an hour (`src/life/home/serverEmojis.ts`); the emoji list itself is read
  from the directory at every refresh, so an added, removed or renamed emoji shows at the next
  refresh (a renamed one counts as unused until the next recount). The emoji lines carry no counts
  or times, so they change the file only when an emoji or the hourly order changes (an unchanged
  text is never written). The list is not in the system prompt; sending and `React` are unchanged.
- **Side files** outside her folders (never visible to her): `life/watch-ids.json`,
  `life/schedule-ids.json` (id counters, resolutions, fire times, already-routed occurrences, newest
  100), `life/files-index.json` (download provenance, newest 10,000). A side file that does not parse
  is kept as `<name>.corrupt-<ms>`, replaced, and the owner is told; reminders/timeouts due before the
  recovery are removed without a wake.
- A `~/life/` folder of her own from before 3.3.0 was renamed `~/life-notes/` by migration.

## Notes and MEMORY.md

Her notes are free-form files in her home. `MEMORY.md` is her index: its copy in block B is cut at
200 lines / 8 KB with a note asking her to tidy it. The harness asks her to write notes "like a
diary, as soon as you learn something" and says "only your files last". See
[memory-and-dreaming.md](memory-and-dreaming.md).

## The eleven tools

Fixed order (part of the cached prefix): `ReadMessages`, `SendMessage`, `React`, `WatchFor`,
`ScheduleWake`, `Read`, `Write`, `Edit`, `Bash`, `WebSearch`, `WebFetch` (`src/life/tools/index.ts`).
Results are short text; errors start with `error:` and set `is_error`. Tool names are PascalCase,
parameters snake_case.

| Tool | Parameters | Key rules and limits |
|---|---|---|
| `ReadMessages` | `place`, `query?` | Up to 5 places or `everywhere`; downloads attachments; see [messages-and-refs.md](messages-and-refs.md) |
| `SendMessage` | `place`, `script` (`m:`, `reply`, `attach`, `react`, `wait`, `typing` lines) | The only way anyone sees her words; several messages per call; see [messages-and-refs.md](messages-and-refs.md) |
| `React` | `place`, `ref`, `emoji` | Unicode or `:server_emoji:` |
| `WatchFor` | `when` (0–5 bindings), `note` (≤ 200), `timeout_minutes` (1–10,080), `once?` (true) | Appends to `~/life/watches.json`; ≤ 10 watches; `watching w3 until Sun 25 Oct 14:02 (in ~/life/watches.json)` |
| `ScheduleWake` | `at?` or `in_minutes?` (exactly one), `note` (≤ 200), `repeat?` (`daily`/`weekly`) | 5 min–30 days ahead; ≤ 20; `set r4 for Sun 25 Oct 18:00 (in ~/life/reminders.json)` |
| `Read` | `file_path`, `offset?`, `limit?`, `pages?` | Text, image or PDF from her folders or `/transcripts` |
| `Write` | `file_path`, `content` | Creates/replaces a text file (folders made); ≤ 256 KiB; refuses `places.md`, binary files, `/transcripts` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all?` | `old_string` must occur exactly once unless `replace_all`; non-empty and different |
| `Bash` | `command` (≤ 20,000 chars), `timeout_ms?` (default 10 s, ≤ `life.bash.maxTimeoutMs` 60 s) | Simulated; see below. Not offered when `life.bash.enabled` is off |
| `WebSearch` | `query` (≤ 300), `num_results?` (5, 1–8) | Exa; host-wide 2/s, 50/day, 20 per waifu per day; `error: no more searches today`; not offered when a cap is 0 |
| `WebFetch` | `url`, `prompt` (≤ 500) | One page; ≤ 3 per turn, 20 per waifu per day; pages > 2,000 chars are read by a digest call; SSRF-guarded (no private addresses); cached 15 min; not offered when a cap is 0 |

**Watch matching** (`src/life/watches.ts`): a binding matches when every field it sets matches —
place, author (`from` resolved to an id), any of its `words` (whole word, case-insensitive), or
`any_message`. A binding with only `from` matches that person anywhere she can read. Her own messages
never match; an empty `when` never matches (a timer). `once` (default) removes the watch at its first
match; a repeating watch fires at most once per 10 minutes and `life.maxWatchFiresPerDay` (24) times a
day. A message posted before the timeout still matches when handled later (catch-up).

**Reminders**: due reminders are routed first under a fixed id per occurrence, then removed or moved
to the next daily/weekly occurrence, under her home lock; a file the app can't parse is never
rewritten and the routed list stops it firing twice (`Scheduler.reminders`).

**Read** (`src/life/tools/files.ts`):

- Text: `cat -n`-style lines (6-wide number, tab), the first 2,000 lines by default, lines cut at
  2,000 characters, whole result cut at 100,000 characters with a note; empty file `(empty file)`.
  Files over 10 MiB are refused.
- Images: shown inline only on a route with image input, when the image is ≤ 3.75 MiB, new this
  epoch, and within `life.maxInlineImagesPerEpoch` (8) / `life.maxInlineImageBytesPerEpoch` (12 MiB);
  otherwise `[image: <OCR text>]` or `[image: no text found]`. A picture already shown this epoch:
  `[image: you've already seen this picture; the text in it: …]`. The bytes are cached as
  `file:<sha256>` and pinned for the epoch, so replay never depends on the file. In maintenance and
  dream sessions an image is always its OCR text.
- PDF: text with `--- page N ---` markers, pages 1–20 by default, at most 50 per call; a scanned PDF
  says it has no text. Extraction runs in its own worker (256 MiB, 20 s).
- Anything else: `error: <path> isn't a text file, an image or a PDF`.

## Bash

`src/life/tools/bash.ts`, `src/life/bash/runner.ts`, `src/life/bash/bashWorker.ts`:

- **Engine**: just-bash 3.6.0 (exact pin), a bash interpreter in TypeScript, in a fresh worker
  thread per call (heap 256 MiB old generation, 32 MiB young, 4 MiB stack, empty `process.env`). The
  host's event loop never runs her command. No real process is ever started.
- **Filesystem**: an in-memory copy of her home and `/tmp`, contents loaded lazily over the worker's
  message port by her path only. `/transcripts` is mounted **lazily and read-only**: stat/list/read
  are asked of the host per command, rendered from the store, never copied (16 rendered days kept per
  call). Only `/`, `/home`, `/home/<slug>`, `/tmp`, `/transcripts`, `/dev`, `/dev/null` exist.
- **Commands**: just-bash's built-ins (`ls`, `cat`, `grep`, `rg`, `find`, `sed`, `awk`, `jq`, `yq`,
  `sort`, `head`, `tail`, `wc`, `mv`, `cp`, `rm`, `mkdir`, `date`, `diff`, `gzip`, `base64`, …,
  `BASH_COMMANDS`), the built-in `image` command (`info`, `crop`, `resize`, `rotate`, `flip`,
  `convert` for png/jpeg/webp/gif, ≤ 24 megapixels, first frame of animations), and `python3`
  (CPython 3.13 WebAssembly, standard library only) when `life.bash.python` is on. Not available:
  `curl`, `html-to-markdown`, `js-exec`, `tar`, `sqlite3`, any network, `node`, package managers.
- **Environment**: `HOME=/home/<slug>`, `USER=<slug>`, `PWD` her home, `TZ` the host zone; nothing
  else from the host.
- **Wall clock**: `timeout_ms` (default 10 s, ≤ 60 s) terminates the worker: `error: the command
  took longer than N s and was stopped; nothing was saved`. A pause/stop: `interrupted; nothing was
  saved`. just-bash's own limits (100,000 commands, call depth 100, 1 MiB output) end a command like a
  failed script.
- **Memory watchdog**: the host samples its resident memory every 25 ms; growth past
  `life.bash.maxMemoryMb` (512) terminates the worker: `error: the command used too much memory and
  was stopped; nothing was saved`.
- **Output**: stdout, then stderr, cut at `life.bash.maxOutputChars` (16,000) with `… (output cut)`,
  then `exit N` and one change line (`changed: …; new folders: …; deleted: …`, first 20 of each).
- **All or nothing**: when the command ends the worker posts a change set (writes, deletes, new
  folders; a rename = delete + write). The host checks every path, `places.md`, the special files, the
  limits, case collisions and that nothing changed under her since the command started (`error:
  ~/x changed while the command ran; run it again`). If anything fails, **nothing** is saved and the
  output ends with `error: changes not saved: <first problem>`. A non-empty set is journalled in
  `life/pending-changes/<toolCallId>.json` and finished at boot after a crash.
- Writes to `/transcripts` fail with `EROFS: transcripts are read-only`.
- The escape suite is `tests/bashIsolation.test.ts`.

## Attachments

- `ReadMessages` downloads, for the newest messages first, at most **10** attachments per call:
  png/jpeg/gif/webp images, PDFs and text files (by MIME type or a fixed extension list), each ≤
  `life.attachments.maxBytes` (10 MiB), through the Discord-CDN-only attachment fetcher. Saved as
  `/tmp/<handle without #>/<ref>-<file name>` (`-2`, `-3` for repeats; DMs `/tmp/dm/<name>/`). An
  attachment already downloaded with the same bytes is not fetched again.
- The line shows the path: `[image: /tmp/bake-club/general/k3-cake.png · "SALE 50%"]` (OCR hint ≤ 40
  chars when cached), `[file: /tmp/dm/kevin/a7-menu.pdf · 1.2 MB]`. Others: `[video: clip.mp4 · 1.9 MB ·
  not downloaded]`, `[file: x · 2 KB · not downloaded (too many in one read; read fewer)]`. Voice
  messages keep `[voice message · 0:12]`.
- A forgotten person's old messages show `(removed)` and their attachments are never downloaded.
- Every download is recorded in `life/files-index.json` (hash, place, message, author, attachment,
  path, size) for forget, the DM redaction and the dedupe.
- `SendMessage` can attach up to `life.send.maxFiles` (4) files per message (`attach` lines), each
  ≤ 10 MiB and ≤ 10 MiB together; never `MEMORY.md`, any file it links to, anything under `~/life/`,
  a transcript path, or a byte-copy of a private transcript day she was shown. A file that can't go
  refuses the whole script with its line (`error: line 2: can't attach ~/MEMORY.md (…); nothing was
  sent`). With `life.send.maxFiles = 0` the description has no `attach` line and an `attach` is a
  parse error.

## Private (DM-origin) files

A file counts as **from a DM** when it is under `/tmp/dm/` (any spelling), or its hash was downloaded
from a DM place, or it is an exact copy of a DM transcript day she was served (`HomeStore.dmOrigin`,
`recordTranscriptCopies`). Touching one in any tool marks the call as a DM call, so the owner's views
hide it (D14). In the dashboard/API such a file is listed as `[private chat redacted]` without a path
and opens only with a local reveal; a note's line that links to one (or names a DM) reads
`[private chat redacted]` in a read-only copy of that note ([privacy-and-forget.md](privacy-and-forget.md)). A copy she changed (an excerpt, her own words) no longer matches
and is hers.

## `/tmp` expiry

First scheduler tick after start, then hourly: files whose mtime is older than
`life.tmp.retentionDays` (7) are deleted, empty folders too; her home is never touched
(`HomeStore.expireTmp`, `Scheduler.housekeeping`).

## profile.json sync

Her `~/life/profile.json` and her config's `username`, `bio`, `nicknames` are one source of truth:

- her valid write is saved to her config (home lock, then waifu lock; a Bash change set journals it)
  and the profile sync runs; the result says what happens next from the live sync status ("saved;
  Discord will show the new username shortly", "…Discord allows only about 2 username changes an
  hour…", "saved; Discord shows it once you're back online", or that she has no account of her own);
- a dashboard/CLI/HTTP edit rewrites the file; the turn start and the scheduler's housekeeping
  rewrite it when it is missing or disagrees, keeping her layout while it agrees;
- nickname keys are servers as her places name them (`bake-club`), else a server name or id; an
  unknown server is refused with examples.

Sync details are in [owner-controls.md](owner-controls.md).
