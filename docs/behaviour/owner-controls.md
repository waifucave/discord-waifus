# Owner controls

Everything the owner can see and change about the waifus: the dashboard, the CLI, HTTP, the
dashboard assistant, Discord slash commands, profile sync and the settings that shape behaviour.
Every setting has an HTTP path, a CLI path and help; the full generated list is
`docs/assistant-kb/settings.md` (`npm run docs:settings:generate`).

## Dashboard

Navigation (`src/frontend/nav.ts`): Home, Cast, Life, Rooms, Activity, Settings.

| Screen | Shows | Owner actions |
|---|---|---|
| **Home** (`HomeScreen.tsx`) | Status (connecting / paused / live / Discord offline), a menu, and a Needs-you bar only when something needs the owner: owner notices, incomplete migrations, unfinished forget parts, unreadable forget-record copies, queued forget scrubs, model warnings | Dismiss dismissible model warnings |
| **Cast** (`CastScreen.tsx`) | Every waifu: avatar, model, own bot or not, ready / no model / no bot / disabled | Edit: name, display name, enabled, persona, custom instructions (≤ 4,000), bot and Discord profile (username, bio, nicknames, avatar, banner), model + effort, daily budget, `scheduleInPrompt`, `wakeOnName`, bed time, DM settings (allow DMs, rate limit, notify when limited, limit notice, sleep notice); delete |
| **Life** (`LifeScreen.tsx`, `LifeFiles.tsx`) | Mosaic of every waifu (state, waiting wakes, today's cost vs budget, last turn, review chip) and recent sends/wakes; per waifu: now (awake / busy / up late / dozing / asleep, idle or mid-turn), queue (now/deferred/quiet), today's cost, epoch, last compaction/rest/dream, live timeline, summary, needs review, web searches today, reminders and watches, her files (home, `/tmp`, `/transcripts`) | **Wake** with a note (≤ 500); **Compact** and **Reset…** (disabled while Discord is offline); "Show private chats" (local only); dismiss review lines; delete a reminder or watch; edit/create/delete her files (same checks as her Write tool, conflict on a stale hash); forget a person (dry run, then a confirm dialog with the limits) |
| **Rooms** (`RoomsScreen.tsx`) | Servers, channels, cast per channel, time of the last detector decision | Server on/off (`paused`), detector override (inherit / off / another target), threads share the cast or stay silent, cast toggles per waifu |
| **Activity** (`ActivityScreen.tsx`) | Logs, model calls and replies (life/maintenance/compaction/web calls metadata only), usage by day/waifu/purpose/model/provider | — |
| **Settings** (`SettingsScreen.tsx`) | Providers, Models, Search, Detector, Life limits (Turns, Sending, Wakes, Her day, Context and images, Rest, Home folder, /tmp, Simulated Bash, Dreaming limits, Dream model, Compaction, Waiting before a wake, After a restart), Assistant, App, Remote Access | Edit; App → Controls: Pause, Resume, Reload Discord, Clear OCR cache, Run setup wizard |

The assistant docks beside the main column (a full-width sheet below 900 px).

## CLI

`waifus <command>` (`src/cli/ownerCommands.ts`, `lifeCommands.ts`, `settingsCommands.ts`; table in
`src/shared/settings/commands.ts`). Global flags `--data-root`, `--json`, `--help`. Secrets never come
from argv (`--from-env`, `--stdin`, `--file`, or a hidden prompt).

| Command | Behaviour |
|---|---|
| `help [topic]` (e.g. `help dreaming`), `list [group]`, `get`, `set`, `unset` | Settings; `app` keys work with the host stopped (written under the host lock; exit 3 while a host holds it); `updates.enabled` only via `waifus update --auto` |
| `wake <waifu> [note…]` | Owner wake (note ≤ 500); prints the outcome (`queued`, `deferred`, `quiet`, `dropped`, `queued_offline`) |
| `life <waifu> [--log] [--limit N] [--private]` | Status, or the log (default 20, ≤ 200 lines) |
| `files <waifu> [path] [--root home\|tmp\|transcripts] [--private]` | List a folder or print a text file |
| `schedule <waifu>`, `watches <waifu> [--private]` | Her reminders / watches |
| `forget <userId> [--yes] [--dry-run]` | Prints the limits and asks for the word `forget` unless `--yes` |
| `usage [--from --to --by --waifu --tz]` | Reads the ledger directly; works with the host stopped |
| `start`, `dev`, `restart`, `stop`, `status`, `doctor`, `clean`, `update`, `remote` | Lifecycle |

Exit codes (`src/cli/cliContext.ts`): 0 ok, 1 failure/5xx, 2 usage, 3 host not running or
unreachable, 4 rejected (400/403/404/428), 5 conflict (409).

## HTTP

Every route is in `ROUTE_POLICY_MANIFEST`; summaries at `GET /api/help`. The life-shaping ones:

| Route | Behaviour |
|---|---|
| `GET /api/waifus/:id/life` | Status, availability with bed phase, queue (first 50), today's cost; summary hidden unless a local `includePrivate=1` |
| `GET /api/waifus/:id/life/log?epoch&before&limit` | Default 50, ≤ 200 lines; old epochs 7 days; D14 redaction |
| `POST /api/waifus/:id/wake {note?}` | Owner wake through the router; with the cast offline or reloading it is queued in `wakes.json` (`queued_offline`) and runs when the cast connects |
| `POST …/life/compact` | Needs the live cast (409 `RuntimeOffline`) and a model (409 `Conflict`, `details.code`); waits up to 10 s, then 202 `{state: "running"}`; a pause/shutdown → `{state: "aborted"}`; a pending epoch start is applied instead of a second summary |
| `POST …/life/reset {confirm: true}` | Aborts her turn; a fresh epoch with no summary and no kept turns; her files, reminders, watches, queue and intake cursors stay; old log kept 7 days. Without a model (or before her life began) the summary is cleared and the epoch starts at her next turn (`deferred: true`) |
| `GET …/life/needs-review`, `DELETE …/life/needs-review/:itemId` | Forget review lines (id = 16 hex chars) |
| `GET /api/waifus/:id/files?root=home\|tmp\|transcripts&dir=`, `GET\|PUT\|DELETE …/files/<path>` | Through her `HomeStore`, held to her Write tool's checks; `PUT {text, expectedHash?}` (`null` = must not exist); `?raw=1` bytes; errors `ReadOnlyFile`, `InvalidFile` (with line/column), `NotTextFile`, `HomeLimit` (413), `NameCollision`, `LinkRefused`, `IsFolder`, 409 on a stale hash; DM files need a local `includePrivate=1` |
| `GET /api/waifus/:id/schedule`, `DELETE …/schedule/:rid`; `GET …/watches`, `DELETE …/watches/:wid` | Her reminders and watches; delete rewrites the file (409 when it does not parse) |
| `GET /api/usage`, `GET /api/search/usage` | Ledger by local day; DM queries redacted |
| `GET\|PUT /api/detector/config`, `GET /api/detector/history?guildId` | Global target (`""` = off), last 300 decisions |
| `POST /api/people/:userId/forget`, `GET /api/people/forget-jobs`, `POST /api/dms/:waifuId/:userId/forget` | See [privacy-and-forget.md](privacy-and-forget.md) |
| `GET /api/owner-notices` | Everything that needs the owner |
| `POST /api/runtime/pause`, `/resume` | Pause/resume the whole cast (saved best-effort to config) |
| `GET /api/waifus/:id/discord-profile`, `POST …/discord-profile/sync` | Profile sync status and a sync now |
| `GET /api/docs[/:slug]` | The assistant's knowledge base (`docs/assistant-kb/`) |

## The dashboard assistant

`src/api/assistant/` — a built-in agent in the dashboard chat. Its tools call the app's own HTTP
routes, so every rule above applies to it, plus:

- **Model**: its own (Settings → Assistant), else an enabled waifu's model that is offered, keyed
  and not a contributor (training) variant; otherwise it does not run and says why.
- **Life tools**: `get_life` (never DM content), `wake_waifu`, `list_files`, `read_file` (text cut at
  20,000 chars), `list_schedule`, `list_watches` (never DM files), `write_file`, `get_usage`,
  `get_setting_help`, `update_app_config`, `forget_person`, `forget_dm`, plus waifu, server, bot,
  provider, runtime, logs, docs and Remote Access tools.
- **Confirmation cards** (server-held; only the owner's click applies them; expire after 5 minutes):
  `write_file` (the exact `PUT` with the current hash, ≤ 16 KB), `forget_person` and `forget_dm` (dry
  run first, the counts and the limits), `update_app_config` for `http.host`, `frontend.staticDir`,
  `updates.*` (other keys apply directly; from a paired remote device these are refused), Remote
  Access enable/disable, invitations, pairing approval and device revocation.
- It never sees DM content: a request with `includePrivate` from it answers 403.

## Discord slash commands

House bot, in servers (`src/discord/client.ts`, `src/discord/applicationOwners.ts`,
`src/orchestration/runtime.ts`):

| Command | Behaviour |
|---|---|
| `/wake waifu:<name> [note]` | Owner wake (note ≤ 500). Only a waifu cast in this server (autocomplete offers this server's cast); else "X isn't cast in this server." Replies "Woke X.", "X's wake is queued." or "X can't be woken right now (paused or disabled)." (also during a reload, where HTTP would queue it) |
| `/print type:<system_prompt\|notes\|life> waifu:<name> [private]` | Her system prompt (summary hidden unless `private:true`), her `MEMORY.md` (unfiltered), or the last 20 life-log lines (DM content hidden unless `private:true`). Over 1,900 characters it is attached as `<type>.md` |

- Only the House bot application's **owner or its team members** may run them; the list is fetched
  when the bot comes online, refreshed every 6 h and re-fetched at run time when older than 10 min; a
  failed fetch keeps the last list; with none, nobody is the owner. Server Administrator is only the
  commands' default visibility. Every reply is ephemeral.
- Retired commands (`/run`, `/stop`, `/review`, `/memories`, `/console`, `/clear`, `/debug`) are
  deleted at registration.
- Waifu bots that take DMs register `/forget conversation|everything` in DMs only
  ([dms.md](dms.md)).

## Discord profile sync

`src/discord/profileSync.ts`, owned by the cast runtime:

- Sets her own bot's username, avatar and banner, her bio (the application description, ≤ 400) and
  per-server nicknames (1–32), only through her bot, never the House bot or a bot two waifus share.
- Only fields that differ are sent; an image only when its hash changed. Rate limits are recorded per
  field with a retry time (`app/discord-profile-sync.json`; a username limit with no time = 1 hour) and
  retried by a timer; nothing is resent before then.
- With no local avatar/banner, the one her bot already shows is imported once per Discord hash and
  recorded as in sync (never uploaded back).
- Triggers: cast start, a waifu bot coming online, a waifu/asset/bot-link write, `POST
  …/discord-profile/sync`, and her own `~/life/profile.json` edits.
- States: `synced`, `pending`, `rate_limited`, `error`, `offline`, `no_bot`, `bot_missing`,
  `shared_bot`; warnings `missing_permission`, `not_in_server`, `username_fallback_invalid`.

## Settings that shape behaviour

Defaults (ranges and every other key: `docs/assistant-kb/settings.md`; schemas
`src/shared/schemas/config.ts`, `domain.ts`, `dm.ts`, `compaction.ts`):

| Area | Key | Default | Effect |
|---|---|---|---|
| Turns | `life.maxConcurrentTurns` | 4 | Host-wide turn slots |
| | `life.maxTurnMs` | 180 s | Turn wall-time cap |
| Sending | `life.maxSendPlacesPerTurn` / `maxSendsPerTurn` | 3 / 8 | Per-turn send caps |
| | `life.send.maxFiles` | 4 | Attachments per message (0 = no `files`) |
| Wakes | `life.maxWakesPerUserPerHour` | 20 | Per-user wake limit |
| | `life.maxWatchFiresPerDay` | 24 | Repeating watch cap |
| | `life.notificationLinesPerPlace` / `morningLinesPerPlace` | 8 / 8 | Lines per place |
| | `life.maxWaifuTriggeredTurns` | 0 (off) | Room loop guard |
| Holds | `discord.debounce.serverMs` / `serverMaxWaitMs` | 1.5 s / 10 s | Room burst |
| | `discord.debounce.dmMs` / `dmMaxWaitMs` | 2.5 s / 60 s | DM burst |
| | `discord.debounce.typingHoldMs` | 6 s | Per typing event |
| | `discord.dm.resumeWindowMinutes` | 60 | Boot catch-up window |
| Her day | `life.dayStartHourLocal` | 8 | Morning without a bed time |
| | `life.busyEngagedMinutes` | 10 | Open place / up late |
| | `life.bedDozeMinutes` | 60 | Dozing before asleep (0 = hard sleep) |
| Context | `life.maxContextTokens` | 96,000 | Budget cap |
| | `compaction.triggerRatio` | 0.7 | The rest point: her rest notice (with `life.restNotice` off, compaction) |
| | `compaction.emergencyRatio` | 0.9 | Emergency summary: auto-compaction between turns (an update must keep it > `triggerRatio`; a stored config with it at or below the trigger loads with it moved to the trigger + 0.04, at most 0.99, and the upgrade writes that for a trigger of 0.9 or more) |
| | `life.maxLogMessages` | 400 | Log-length trigger |
| | `life.maxInlineImagesPerEpoch` / `…BytesPerEpoch` | 8 / 12 MiB | Inline images |
| Rest | `life.restNotice` / `restSummaryMinChars` | true / 200 | Rest turn (`life.restNoticeRatio` was removed in §26) |
| | `life.cacheRestMinRatio` / `cacheRestLeadMinutes` | 0.5 / 10 | Rest before her prompt cache goes cold (§25): from this share of the trigger, this many minutes before the 1-hour cache expires |
| | `life.selfSummaryMinRatio` / `selfSummaryCooldownMinutes` | 0.3 / 120 | `<summary>` guards |
| Dreaming | `life.dreamAfterAsleepMinutes` | 15 | Asleep before the dream |
| | `life.maintenanceHourLocal` | 5 | Dream hour without a bed time |
| | `life.dreamModel` / `dreamMaxRounds` / `dreamWindowMaxChars` | her model / 60 / 200,000 | Dream session |
| Computer | `life.home.*`, `life.tmp.*`, `life.attachments.maxBytes` | 50 MiB, 2,000 files, 500 folders; 200 MiB, 2,000 files, 7 days; 10 MiB | Folder limits |
| | `life.bash.enabled` / `python` / `maxTimeoutMs` / `maxOutputChars` / `maxMemoryMb` | true / true / 60 s / 16,000 / 512 | Bash |
| Web | `search.maxPerSecond` / `maxPerDay` / `maxPerWaifuPerDay` | 2 / 50 / 20 | WebSearch (0 = off) |
| | `life.webFetch.maxPerTurn` / `maxPerWaifuPerDay` / `cacheMinutes` | 3 / 20 / 15 | WebFetch (0 = off) |
| Detector | `detector.target` | `openrouter:typesafe/jev-1.14` | `""` = fallback only |
| Waifu | `wakeOnName` / `scheduleInPrompt` | true / true | |
| | `life.dailyBudgetUsd` | none | Daily budget |
| | `availability.bedTime` | off, 23:00–07:00 | Bed time |
| | `dm.allowDms` / `dm.rateLimit` / `dm.notifyWhenLimited` | false / 30 per 60 min / true | DMs |
| | `dm.limitNotice` / `dm.sleepNotice` | built-in / none | Automatic DMs (≤ 300) |
| | `customInstructions` | "" | Appended after the persona (≤ 4,000) |

## Docs differ

- `CLAUDE.md` and the KB list `/print life|system_prompt`; the code also has `/print notes`, which
  prints `MEMORY.md` without the D14 filter.
- The `files` command's `--root` help names `home|tmp`; the command also accepts `transcripts`.
- The KB says an owner wake "skips her bed time and budget"; it skips guards 3–6 (per-user limit, bed
  time, busy holds, budget, loop guard) but is still dropped while the app is paused or when she is
  disabled or has no bot.
- UI hints say the detector-off fallback "wakes one waifu at random"; it is the weighted draw over
  waifus who are around.
