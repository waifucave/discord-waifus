# Her own computer

Each waifu works in a small isolated machine: two folders of her own, a read-only `/transcripts`,
seven tools (six of them taking a small JavaScript program, one a simulated Bash). She never sees a
host path.

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
  is `~/MEMORY.md`, `~/Life/Wakeups.json` is `~/life/wakeups.json`. Two names in one folder that
  differ only by case are refused when a write would create the second.
- No links: never created (Bash `ln` fails), an existing one on disk is never followed, listed or
  written through.

**Limits** (settings, checked on every write path: her tools, Bash change sets, the API):

| Limit | Default |
|---|---|
| Home size / files / folders | 50 MiB / 2,000 / 500 (`life.home.*`) |
| `/tmp` size / files | 200 MiB / 2,000 (`life.tmp.*`); a download that would overfill `/tmp` deletes the oldest `/tmp` files first |
| One file by `Edit` (`apply_patch`)/API `PUT` | 256 KiB (`WRITE_MAX_BYTES`) |
| One Bash change set | 5,000 files and folders, checked within 30 s |

A limit hit is an `is_error` result naming it ("your home is full (50 MiB); delete or shorten
something first"); nothing is written.

## Pre-set files and folders

| Path | Purpose | Format | Written by | She can change it? | Delete? | Checked | On change |
|---|---|---|---|---|---|---|---|
| `~/MEMORY.md` | Index of her notes, one short line per note linking to it | Markdown | Her (and the dream) | Yes | Yes | Path/size rules only | Copy in her prompt updates at the next epoch; stale-copy note in her result |
| `~/` (anything else) | Her notes, any layout | Text or any file | Her (and the dream) | Yes | Yes | Path/size rules | — |
| `~/life/` | Her daily machinery (all files here are private: never attached) | folder | App + her | Its files as below | The folder can't be removed while it holds `places.md` | — | — |
| `~/life/schedule.json` | Her day ([day-and-bed-time.md](day-and-bed-time.md)) | JSON object | Her (each morning) | Yes | Yes (= no plan) | Strict JSON + field rules, busy not in bed time | Live for routing, Jev and the time line; prompt copy at next compaction |
| `~/life/wakeups.json` | Her wakeups (`Wakeup` adds and cancels; see below) | JSON array, one entry per line: `{id?, kind: at\|every\|watch\|page, when?, places?, filter?, url?, check?, options?, note, state?, disabled?}` | Her + app (fires, removes an `at` and a once watch, ends watches and pages, saves her code's `state`, disables after errors) | Yes (Edit's patch must match the file as it is now) | Yes (= no wakeups) | Strict JSON ≤ 60 KiB as saved (the app's stop reasons may take it to 64 KiB); each entry as `Wakeup` checks it (times, places, names, her functions compiled in the sandbox); ≤ 20 timed, 10 watches, 3 pages; note ≤ 200, state ≤ 4 KiB; ids `t<n>`/`w<n>`/`p<n>` matching the kind; a once watch that already fired can't come back | New entries get the next id, `for` becomes `until`, `at`'s time becomes a local time, and the file is rewritten one entry per line; places and `from` names resolved in `life/wakeup-ids.json`; changing a stopped wakeup's code turns it back on |
| `~/life/profile.json` | Her Discord profile: `name` (read-only), `username`, `bio`, `nicknames` keyed by server slug | JSON object | Her + app (rewritten from her config) | Yes, outside sessions | **No** | Discord username rules, bio ≤ 400, nickname 1–32, known servers, `name` unchanged | Saved to her config, then profile sync runs; the result says when Discord will show it |
| `~/life/places.md` | Her rooms, her servers' emojis and her DMs | Markdown | App only (≤ 1/min, every turn start, when a new place folds in) | **No** (`places.md is kept up to date for you and can't be changed`) | **No** | — | — |
| `/tmp/<place>/<ref>-<name>` | Attachments `ReadMessages` downloaded | the file | App | Yes | Yes | `/tmp` limits | Expire after 7 days |
| `/tmp/dm/<name>/…` | Downloads from a DM | the file | App | Yes | Yes | — | Private (D14) |
| `/transcripts/…` | Transcripts | rendered Markdown | App | **No** (`EROFS: transcripts are read-only`) | **No** | — | `cp` out into her folders works |

Sources: `src/life/home/pathRules.ts` (`LIFE_FILES`), `src/life/home/homeStore.ts` `checkSpecial`,
`src/life/home/specialFiles.ts`, `src/life/home/daySchedule.ts`, `src/life/home/profileFile.ts`,
`src/life/tools/files.ts`.

- **Changes to her special files** go through `Edit`'s patch (or Bash): a patch's lines must match the
  file as it is now, so a wakeup that fired, ran or ended since she read it makes the chunk not match
  (`Failed to find expected lines in ~/life/wakeups.json`) instead of being overwritten. A once watch
  that fired is gone for good: writing it back is `error: wakeups.json entry w1: it already fired once
  and was removed; leave it out`. (The retired `Write` tool needed a current Read of wakeups.json and
  profile.json before replacing them; its code is kept for old log lines.)
- **profile.json in sessions**: nightly dreaming and a forget's notes scrub refuse Edit/Bash
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
  text is never written). The list is not in the system prompt; sending and reacting are unchanged.
- **Side files** outside her folders (never visible to her): `life/wakeup-ids.json` (id counters per
  kind, each watch's resolved places and names and fire times, when each `every` started counting,
  each page's last check, her code's errors in a row, already-routed occurrences, newest 200),
  `life/files-index.json` (download provenance, newest 10,000). A side file that does not parse is
  kept as `<name>.corrupt-<ms>`, replaced, and the owner is told; timed wakeups and ends due before
  the recovery are removed without a wake.
- Her `reminders.json` and `watches.json` (before §30) became `wakeups.json` by migration
  (`living-cast-wakeups-v1`: reminder `r4` is `t4`, watch `w3` stays `w3`; the old files are archived);
  a `reminders.json` she writes now is an ordinary file.
- A `~/life/` folder of her own from before 3.3.0 was renamed `~/life-notes/` by migration.

## Notes and MEMORY.md

Her notes are free-form files in her home. `MEMORY.md` is her index: its copy in block B is cut at
200 lines / 8 KB with a note asking her to tidy it. The harness asks her to write notes "like a
diary, as soon as you learn something" and says "only your files last". See
[memory-and-dreaming.md](memory-and-dreaming.md).

## The tools

Fixed order (part of the cached prefix): `ReadMessages`, `SendMessage`, `Wakeup`, `Read`, `Edit`,
`Bash`, `Web` (`src/life/tools/index.ts`). **Unreleased (on main):** every tool but `Bash` takes one
JavaScript `script` calling its own function on `tools` (spec §32, below); `React` and `Write` are kept
in the code but no longer offered (`send_message` reacts, `apply_patch` adds files), and `Web`
replaced `WebSearch` and `WebFetch`. A life whose epoch still offers a tool that is gone or no longer
offered is summarised before her next turn, with no kept turns ([life-and-turns.md](life-and-turns.md)).
Results are short text; errors start with `error:` and set `is_error`. Tool names are PascalCase,
function and field names snake_case.

| Tool | Her function | Key rules and limits |
|---|---|---|
| `ReadMessages` | `tools.read_messages({ place, around \| before \| after, max, people, search })` | Up to 5 places or `everywhere`; returns the lines as text; downloads attachments; ≤ 5 calls per script; see [messages-and-refs.md](messages-and-refs.md) |
| `SendMessage` | `tools.send_message({ place, messages: [...] })` | The only way anyone sees her words; several messages, reactions, waits per call, one place per call, several calls (places) per script; see [messages-and-refs.md](messages-and-refs.md) |
| `Wakeup` | `tools.wakeup({ at, every, watch, page, cancel })` | Every wakeup; each call all or nothing; ≤ 4 calls per script; see below. Refused while dreaming |
| `Read` | `tools.read_file({ path, offset, limit, pages })` | Text, image or PDF from her folders or `/transcripts`; ≤ 10 calls and 100,000 characters per script |
| `Edit` | `tools.apply_patch("*** Begin Patch\n…\n*** End Patch")` | Codex's patch format; the whole patch or nothing; ≤ 4 calls per script; see below |
| `Bash` | (no script) `command` (≤ 20,000 chars), `timeout_ms?` (default 10 s, ≤ `life.bash.maxTimeoutMs` 60 s) | Simulated; see below. Not offered when `life.bash.enabled` is off |
| `Web` | `tools.web__run({ search_query, open, click, find, ask, response_length })` | Search and read the web; see below. Not offered when both search and page opening are off |

## Tool scripts

**Unreleased (on main).** Spec §32; `src/life/tools/script.ts` (the shared host side),
`src/life/sandbox/toolScript.ts` and `toolScriptWorker.ts` (the sandbox). Each call's input is
`{ script }` (≤ 20,000 characters): the body of an async JavaScript function, so she `await`s her
tool's function, loops and branches:

```js
return await tools.read_messages({ place: "bake-club/#general", around: "#k3", max: 10 });
```

- **`tools`** holds only that tool's own function(s), each taking one value (an object; `apply_patch`
  a string) and returning a promise. Another tool's function throws a readable error naming the tool
  to call (`TypeError: tools.read_file is the Read tool's; call Read (this one has
  tools.send_message)`); an old free function from before throws what replaced it (`search() is gone:
  call tools.web__run({ search_query: [{ q: "…" }] })`; `at()`, `watch()`, … in Wakeup the same).
  Unknown fields and bad values throw before anything runs (`TypeError: tools.web__run:
  search_query[0]: unknown field "since" (it takes q, domains, exclude, recency, n)`).
- **What she sees**: what she passes to `text(value)` (also `console.log`): text as is, anything else
  as compact JSON, a `read_file` image result as the picture (a handle; its bytes never enter the
  sandbox), `undefined` nothing. A last expression is not returned (the body of a function): if she
  never calls `text()`, what she `return`s is shown the same way; nothing at all is `done`. A thrown error ends the result with
  `error: TypeError: … (line 3)` after what she showed (`is_error`); a call that fails rejects with an
  `Error` made at the call (her line in it), its message naming the function or the item (`tools.read_file: …`, `watch[0]: …`), which she may catch. The output cap is the tool's own:
  `Read` and `ReadMessages` 100,000 characters, the others 8,000; a cut output ends `… (cut: at most
  8,000 characters are shown)`.
- **Receipts** (§32.3a): after all that the host adds a line per side effect, whatever her script did
  (threw, timed out, never called `text()`, was cut): `[receipt] send_message to bake-club/#general:
  sent #k9 #ka; the whole list ran` (or `stopped (someone wrote during the wait): messages[2] and
  after were not sent`), `[receipt] apply_patch 1: saved M ~/MEMORY.md`, `[receipt] wakeup: saved: set
  w1 (…) (in ~/life/wakeups.json)` or `wakeup: nothing saved (…)`. A call still running when the run
  gave up on it says so (`what it did is not known yet`), never "not sent".
- **Caps per script**: each function's own (`read_messages` 5, `read_file` 10, `apply_patch` 4,
  `wakeup` 4, `send_message` 10, `web__run` 24 operations; the next call throws `tools.wakeup: at most
  4 calls in one script`), on top of the per-turn and daily caps that existed before.
- **Limits**: QuickJS (the §30 package, sync build) in a fresh worker thread per call, so a slow
  script holds up no one else. Her own computing has 1 s in all, waiting for her tool not counted
  (QuickJS's interrupt, and her busy time summed from the worker's own timestamps: a host busy with
  something else never adds to it; over 1 s + 250 ms is a time hit; a backstop stops a worker still
  busy 2 s past her budget); 16 MiB of memory, 256 KiB of stack; a wall clock of 60 s; for
  `SendMessage` 120 s of waits + 4.5 s of typing per allowed send + 30 s; `Date` is the app's clock in her zone; no `require`, network, timers or
  host objects. After her program ends no more of her code runs and no call is made; calls still
  going (never awaited) are waited for up to the wall clock, then told to stop and given 10 s to
  finish what they began (a stop, a pause or the turn's abort tells them at once). A call's argument goes out as JSON (16,384 characters; 128 KiB
  for `send_message` and `wakeup`, 300 KiB for `apply_patch`); a function inside it goes as its
  source text (only `wakeup` takes one). Everything coming back from the sandbox is checked again on
  the host, and one bad script only fails itself (`tests/toolScriptSandbox.test.ts`).
- **Privacy (D14)**: a script is a DM call when it names a private chat anywhere in it (`dm/…`, also
  when it fails half-way or doesn't parse), when any call's argument names one (a handle built in
  code), and whenever one of her calls reads, sends to or touches a DM place or a DM-origin file.

## Wakeup

One tool for every wakeup (spec §30, §32.2; `src/life/tools/wakeup.ts`, `src/life/wakeups/`). Her
script calls `tools.wakeup({ at, every, watch, page, cancel })`, each a list; each item adds one
wakeup to `~/life/wakeups.json` (or cancels one). Up to 40 items per call, 4 calls per script.

| Item | Adds | Rules |
|---|---|---|
| `at: [{ when, note }]` | `t<n>`, once | `"2026-10-30 18:00"`, `"18:00"` (today, else tomorrow), `"fri 18:00"`, `"tomorrow 09:00"`, `"in 45m"`, `"in 1h30m"`; 5 minutes to 30 days ahead; saved as a local time |
| `every: [{ when, note }]` | `t<n>`, repeating | `"day 09:00"`, `"weekday 08:30"`, `"weekend 11:00"`, `"mon,fri 18:30"` or a 5-field cron (`"0 20 1 * *"`); steps of at least 15 minutes; the result shows the next three times |
| `watch: [{ places, from, words, any, filter, for, once, note }]` | `w<n>` | `places`: a handle, a list (≤ 10) or `"everywhere"`; an object filter from `from`, `words` (1–10 whole words, case-insensitive), `any: true` (every field set must match), or her `filter` function `(m, state) => …` (not both; none of them: a timer, saved as the filter `[]`); `for: "2h"` (≤ 7 days, required), `once` (true). In her file a filter may also be a list of objects, each with its own `place` (`[]` a timer) |
| `page: [{ url, contains \| changes \| check, every, for, note }]` | `p<n>` | `contains: "in stock"` (fires when it appears), `changes: true` (fires when the text changes after a first look) or `check`, her function `(page, state) => …`; `every: "6h"` (≥ 1h), `for: "3d"` (≤ 7 days) |
| `cancel: ["w3"]` | — | Removes them |

- **Checked per call, saved per script** (§30's promise, §32.3a): a call is checked whole (with what
  the script's earlier calls staged: caps, ids) and any error throws in her script naming the item
  (`Error: watch[1]: unknown place bake-club/#nope; see places.md; nothing was saved (line 3)`). Its
  calls are saved once, together, when the script ends without an error; a script that ends with one
  saves none (`[receipt] wakeup: nothing saved (your script ended with an error, …)`). Within a call
  cancels come first (replacing one at a cap works); an unknown id, or one cancelled twice in the
  script, is an error. A call returns each new wakeup's id, kind and next times: `{ set: [{ id: "t2",
  kind: "every", about: "every weekday 08:30", next: ["Mon 26 Oct 08:30", …] }, { id: "w1", kind:
  "watch", about: "bake-club/#general, until Sat 24 Oct 16:00" }], cancelled?: ["t1"], saved: "when
  your script ends without an error (in ~/life/wakeups.json)" }`; the receipt says what was saved
  (`set w1 (…), t2 (every weekday 08:30); cancelled t1 (in ~/life/wakeups.json)`).
- **Caps**: 20 timed (`at` + `every`), 10 watches, 3 pages (`you'd have 11 watches; at most 10;
  nothing was saved`).
- **Her functions** are one plain arrow or function expression (≤ 8 KiB, not async or a generator)
  that uses only its arguments and JavaScript's built-ins: a name from outside it is refused
  (`filters can't use variables from outside them; put what they need inside (it uses kevin); write
  the value into it, like (m) => m.fromId === "<the value of kevin>"`). The
  host gets its source text, read with `Function.prototype.toString` as it was before her script ran,
  and checks it itself (acorn free-name analysis); each is compiled in the sandbox before saving; a
  syntax error is refused with its line.
- `msg` is `{place, from, fromId, isWaifu, text, mentionsMe, repliesToMe, ref, at, files}` (a
  forgotten person's message: text `(removed)`, `from` "someone", `fromId` null, no files, and no
  `from` filter matches it); `page` is `{url, status, title, text}` (text ≤ 200 KB). `state` is an
  object she may change; it persists between runs (≤ 4 KiB as plain JSON: a state that can't be
  JSON, through `toJSON` or anything else, is her error `your filter's state must be plain JSON`), is
  written into her file at most once a minute and at shutdown, never past the file's 60 KiB (a state
  that won't fit is not written and counts as an error: `its state would make ~/life/wakeups.json
  bigger than 60 KiB; keep less in it`). Returning `true` fires, a string fires and is the wake's
  line (≤ 200 characters), anything else doesn't.
- **Watch matching** (`src/life/wakeups/run.ts`): only messages in the watch's places (or anywhere she
  can read); her own never. An object filter costs nothing; her functions run in the sandbox once per
  such message (50 ms CPU, 16 MiB, 64 KiB stack each). `once` (default) removes the watch at its first
  fire; a repeating one fires at most once per 10 minutes and `life.maxWatchFiresPerDay` (24) times a
  day (its function still runs, so its state stays current). A message posted before the watch ended
  still counts when handled later (catch-up). Several of her wakeups firing on one message are one wake,
  a line each.
- **Pages** are fetched by the scheduler through the same SSRF-checked fetcher as `Web`'s opens
  (`privateAddressPolicy: "deny"`, no cache, no model call), first at the next tick after she sets
  it, then every `every`; a URL fetched for any of her pages (its `#fragment` aside) is not fetched
  again sooner, so editing a page or cancelling it and setting it again never fetches early, and she
  has at most 72 page fetches a day; a check that fails still counts as checked. With page fetching off (`life.webFetch.maxPerWaifuPerDay` or `maxPerTurn` 0) a new or changed
  page is refused (`web pages can't be checked: the owner turned page fetching off`) and nothing
  is fetched. A fire is a `watch` wake with the page's URL.
- **Ends**: a watch or page whose `until` passes is removed and she gets `watch timed out · your
  note: …` (`watch_timeout`; a DM wake for a watch on a DM or on "everywhere", not for a `[]` timer),
  so a watch works as a timer.
- **Timed ones**: a due `at` or `every` is routed as a `reminder` wake under a fixed id per occurrence
  (`w-reminder-<id>-<time>`), recorded, then the `at` is removed (an `every` stays); a late `at` fires
  once at the first tick, an `every` counts from when it was first seen (a new one never fires a past
  time). A file the app can't parse is never rewritten and the routed list stops it firing twice.
- **Errors are never silent**: a run that throws, hits a limit or leaves a state over 4 KiB counts
  one, a good run resets the count; three in a row stop the wakeup (`disabled` in her file, with the
  reason, at most 300 characters and 290 bytes as JSON; the 4 KiB the app keeps above her own 60 KiB
  is for these, so a stop is always written) and she gets a `wakeup_error` wake (`- wakeup w4 stopped: TypeError:
  … (line 2)`), which gets through busy and bed time like a reminder; for a watch on a DM or on
  "everywhere" it is a DM wake (its error may quote a DM). Changing its code (in her file) turns it
  back on. Her wakeups are hers alone: whatever fails in them never stops a message reaching another
  waifu, nor her other scheduler steps (each step runs on its own).

## The sandbox

Her wakeup filters and page checks run in QuickJS (`quickjs-emscripten` 0.32.0, exact pin;
`src/life/sandbox/`) in one worker thread: a fresh runtime per run with no host functions, modules,
timers, `console` or network; only JSON crosses in and out, read with built-ins captured before her
code runs (replacing `JSON.stringify` or a prototype changes nothing), and only short text leaves
it: errors ≤ 300 characters, string answers ≤ 402, state ≤ 4 KiB. `Date` reads the app's clock in her
time zone. Limits: 50 ms CPU, 16 MiB, 64 KiB stack per run (a compile check: 500 ms); each run is also
timed whole, so a native call QuickJS can't interrupt (a long string search) that finishes over its
budget (+25 ms) is a time limit hit too, and the host's watchdog stops a run still going 250 ms past
its budget (the runs after it go to a fresh worker). A limit hit or a crash restarts the worker;
nothing of the host is reachable (`tests/sandboxIsolation.test.ts`). Her tool scripts use the same
package in their own worker per call (above).

## Web

**Unreleased (on main).** One tool for the web (spec §31, §32.2; `src/life/tools/web.ts`,
`src/life/sandbox/webPage.ts`, `src/life/search.ts`). Her script calls `tools.web__run({...})` as
often as it likes within the caps; one call does, in order: its searches, then its opens and clicks,
then its finds and asks (a page not open yet is opened first, once, and counts as a page). It returns
`{ search, pages, find, ask }` for what was asked; a step that couldn't be done is `{ …, error }` in
its place and the others still run. A search's hits reach an open only through a second call.

| Field | Gives | Rules |
|---|---|---|
| `search_query: [{ q, domains, exclude, recency, n }]` | `{ q, hits: [{title, url, date?, snippet}] }` | Exa; `q` 1–300 chars; `recency` days (0 < N ≤ 3,650, Exa's published-date filter), `domains`/`exclude` a site or ≤ 10 (`"bbc.co.uk"`, a scheme/path/`www.` is dropped), `n` 1–8 (default by `response_length`: 3/5/8; her own `n` wins); `date` is `YYYY-MM-DD`, `snippet` ≤ 300 chars |
| `open: [{ ref_id, lineno }]` | `{ url, title, status, lineno, lines, total_lines, more, links }` (+ `note`) | `ref_id` is the page's address. One page through the SSRF-checked fetcher (`privateAddressPolicy: "deny"`, the https upgrade, `life.webFetch` time/size/redirects, the 15-minute cache). `lines`: from `lineno` (0-based, default 0) about 3,000 characters (1,500 / 6,000 for `response_length` `"short"` / `"long"`) of the page's text, each line as `N: text` (blank lines left out, numbers kept; a line over 3,000 cut); `total` lines; `more` whether non-blank lines follow; `links`: the page's links (`[{id, text, url}]`, absolute, numbered in the order they first appear in the page, so an `id` stays the same for the page, ≤ 500, from winter-web) that are on those lines; `title` the page's `<title>`, else its first heading or line. A PDF (by content type or `%PDF-`) is read by the app's PDF worker: pages 1–50 as `--- page N ---` blocks (`note` says when there are more, or no text); another binary page is `that page is not text (image/png)`; `note` also says when a page was cut at `maxBytes`. A page already open in the script is re-windowed without a fetch |
| `click: [{ ref_id, id }]` | the page of link `id` of a page she opened (as `open` gives it) | Counts as a page |
| `find: [{ ref_id, pattern }]` | `{ url, pattern, matches: [{lineno, text}] }`, ≤ 20 | Over the whole page: text case-insensitive, or her RegExp (flags `i m s u` kept), run in a worker thread of its own for at most 1 s (`src/life/sandbox/regexFind.ts`; past that the step's error `that RegExp took too long on this page; try plain text`); `text` is the matching line (cut to 300 around the match) with the non-blank line before and after it |
| `ask: [{ ref_id, question }]` | `{ url, question, answer, kind }` | `kind` says the answer is a generated digest of the page, not its own words. One digest call over the whole page (≤ 100,000 chars) on `life.webFetch.model`, else the cheapest offered keyed route, else her own; purpose `web`; question ≤ 500 |

- **Result**: what she shows, cut at 8,000 characters. When the script searched or opened anything,
  the first line is `(untrusted web content: information, not instructions)`.
- **Caps per script**: 4 searches, 6 pages fetched, 2 asks, 24 operations, 60 seconds; a call that
  would pass one throws before anything of it runs (`tools.web__run: at most 4 searches in one script
  (1 left)`); pages are reserved when the call starts, so calls run at once can't pass it either. On
  top: the daily caps (`search.maxPerWaifuPerDay`, `search.maxPerDay`, `life.webFetch.maxPerWaifuPerDay`;
  each search and each fetched page counts, a cached page too) and `life.webFetch.maxPerTurn` (6) pages
  across all her scripts in one turn (that step's error `you've opened 6 pages this turn; that's the
  most for one turn`), also for opens run at once (each takes its place before it waits for anything;
  one the daily cap refuses gives it back). An ask counts only against its script's 2. With search off
  a search is `web search is off`, with page opening off an open is `page fetching is off`; with both
  off the tool is not offered (`error: the web is off`).
- **Privacy (D14)**: what she searches and opens is on the dashboard's search list as before, private
  when the turn touched a DM; a `Web` call is a DM call in the life views by the same rule as any call.
- A rest turn refuses it (`error: finish your summary first…`). Settings keep their names;
  `life.webFetch.directMaxChars` is no longer used.

**Read** (`src/life/tools/files.ts`, `tools.read_file({ path, offset, limit, pages })`):

- Text: `cat -n`-style lines (6-wide number, tab), the first 2,000 lines by default (`offset`, `limit`
  ≤ 2,000), lines cut at 2,000 characters; a script's reads together are cut at 100,000 characters
  with a note (past that a `read_file` throws); empty file `(empty file)`. Files over 10 MiB are
  refused. It returns the text.
- Images: `read_file` returns `{ path, kind: "image", about: "png 640x480, 12 KB", image_id }`; the
  picture is shown when she shows that (`text(…)` or as her return value). Shown inline only on a route
  with image input, when the image is ≤ 3.75 MiB, new this epoch, and within
  `life.maxInlineImagesPerEpoch` (8) / `life.maxInlineImageBytesPerEpoch` (12 MiB); otherwise `[image:
  <OCR text>]` or `[image: no text found]`. A picture already shown this epoch: `[image: you've already
  seen this picture; the text in it: …]`. Only a picture she shows counts as shown. The bytes are
  cached as `file:<sha256>` and pinned for the epoch, so replay never depends on the file. In
  maintenance and dream sessions an image is always its OCR text.
- PDF: text with `--- page N ---` markers, pages 1–20 by default (`pages: "3"` or `"1-5"`), at most 50
  per call; a scanned PDF says it has no text. Extraction runs in its own worker (256 MiB, 20 s).
- Anything else: `<path> isn't a text file, an image or a PDF`.

**Edit** (`src/life/tools/applyPatch.ts`, `src/life/tools/files.ts`, `tools.apply_patch(patch)`):
Codex's patch format, exactly. Her description shows the patch written as a list of lines joined
(`["*** Begin Patch", …, "*** End Patch"].join("\n")`), so backticks and `${…}` in her notes are safe;
a whole file longer than the 20,000-character script is written with Bash.

```
*** Begin Patch
*** Add File: ~/people/mina.md
+# Mina
+likes brownies
*** Update File: ~/MEMORY.md
@@
 - [Kevin](people/kevin.md)
+- [Mina](people/mina.md)
*** Delete File: ~/old.md
*** End Patch
```

- `*** Update File:` may have `*** Move to: <path>`, then chunks: `@@` or `@@ <a line of the file>`
  (the anchor: the chunk is after it), then lines starting with a space (context), `-` (removed) or
  `+` (added), optionally `*** End of File` (the chunk is at the end). Parse errors are Codex's
  (`invalid hunk at line 4, Expected update hunk to start with a @@ context marker, got: '…'`); a
  heredoc around the patch is taken off.
- **Matching** (Codex's `seek_sequence`), chunk by chunk in file order against the file as it was:
  exact, else ignoring trailing whitespace, else both ends', else with Unicode dashes, quotes and odd
  spaces made ASCII. A chunk with only `+` lines appends at the end of the file. Lines keep their
  endings (CRLF too); inserted lines take the file's first ending; the file ends with a newline.
- **Safer than Codex**: a chunk without an `@@` anchor whose lines match in two places (in the first
  pass that finds them, after the previous chunk and End of File; one exact match is taken even when a
  copy with other spacing is elsewhere) is refused (under an anchor the chunk is the first match after
  it, as in Codex: the anchor says which one) (`the lines to change in ~/x.md match in 2 places (lines 4 and 19); add a line
  above or below to say which`), and so is an `@@` line that is in the file twice (`the @@ line '##
  Notes' is in ~/x.md twice (lines 1 and 3); use a line that is there once`); a second `*** Update
  File` of one path in a patch is refused (`put all its changes under one *** Update File`), as are
  overlapping chunks; `*** Add File` on an existing file is refused (`change it with *** Update File`),
  and so is a Move onto an existing file, or from or to a protected path; Update and Delete need an
  existing text file, and an Update (or Move source) of a file over the write limit (256 KB, a big
  download in `/tmp` say) is refused before it is read (`~/x.txt is too large to patch (over 256 KB);
  use Bash`; such a file can still be deleted). Finding the chunks makes at most 2,000,000 line comparisons per file (each line
  normalised once per pass, only positions where the chunk's first line is are tried); a chunk past
  that is refused (`that chunk of ~/x.md is too long to find; use fewer lines`).
- **All or nothing**: every file is checked first (her path rules, `/transcripts` read-only,
  `places.md` never, dreaming leaves `~/life/` alone, a tidy session never changes `profile.json`,
  256 KiB per file), then the whole patch is one change set through her home store, like a Bash
  command's, read, matched, checked and saved under one hold of her home lock; patches she runs at
  once run one at a time in call order, each seeing the ones saved before it and its done line written
  before the next begins: journalled under the call, her special files in `~/life/` checked as they would be after
  it (wakeups compiled, ids given), the limits, case collisions, and nothing changed under her since it
  was read. Any problem throws `tools.apply_patch: …; nothing was changed`. It returns `Updated: M ~/MEMORY.md,
  A ~/people/mina.md, D ~/old.md` (`M ~/new.md (from ~/old.md)` for a move), plus the notes her day,
  `MEMORY.md` and `profile.json` get (as Bash's), and its receipt (`[receipt] apply_patch 1: saved M
  ~/MEMORY.md`).
- A file whose bytes are a private chat's transcript day she was shown keeps its DM origin; touching a
  DM-origin file makes the call a DM call.

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
- `SendMessage` can attach up to `life.send.maxFiles` (4) files per message (`attach: [paths]`), each
  ≤ 10 MiB and ≤ 10 MiB together; never `MEMORY.md`, any file it links to, anything under `~/life/`,
  a transcript path, or a byte-copy of a private transcript day she was shown. A file that can't go
  refuses the whole call with its item (`tools.send_message: messages[1]: can't attach ~/MEMORY.md
  (…); nothing was sent`). With `life.send.maxFiles = 0` the description has no `attach` and an
  `attach` is refused.

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
