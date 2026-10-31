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
| **Cast** (`CastScreen.tsx`) | Every waifu: avatar, model, own bot or not, ready / no model / no bot / disabled | Edit: name, display name, enabled, persona, custom instructions (≤ 4,000), bot and Discord profile (username, bio, nicknames, avatar, banner), model + effort, daily budget, `wakeOnName`, DM settings (allow DMs, rate limit, notify when limited, limit notice); delete (§38: no bed time, no `scheduleInPrompt`, no sleep notice) |
| **Life** (`LifeScreen.tsx`, `LifeFiles.tsx`) | Mosaic of every waifu (state, waiting wakes, today's cost vs budget, last turn, review chip) and recent sends/wakes; per waifu: now (idle or mid-turn; no sleep states since §38), queue (now/deferred/quiet), today's cost, epoch, last compaction/rest/dream, live timeline, summary, needs review, web searches today, her wakeups (timed, watches and pages, each with its code, state and why it stopped; delete one), her files (home, `/tmp`, `/transcripts`) | **Wake** with a note (≤ 500); **Compact** and **Reset…** (disabled while Discord is offline); "Show private chats" (local only); dismiss review lines; delete a reminder or watch; edit/create/delete her files (same checks as her Edit tool, conflict on a stale hash); forget a person (dry run, then a confirm dialog with the limits) |
| **Rooms** (`RoomsScreen.tsx`) | Servers, channels, cast per channel, time of the last detector decision | Server on/off (`paused`), detector override (inherit / off / another target), threads share the cast or stay silent, cast toggles per waifu |
| **Activity** (`ActivityScreen.tsx`) | Logs, model calls and replies (life/maintenance/compaction/web calls metadata only), usage by day/waifu/purpose/model/provider | — |
| **Settings** (`SettingsScreen.tsx`) | Providers, Models, Search, Detector, Life limits (Turns, Sending, Wakes, Context and images, Rest, Home folder, /tmp, Simulated Bash, Dreaming limits, Dream model, Compaction, Waiting before a wake, After a restart), Assistant, Permissions (who can use `/norma`: Discord user IDs), App, Remote Access | Edit; App → Controls: Pause, Resume, Reload Discord, Clear OCR cache, Run setup wizard |

The assistant docks beside the main column (a full-width sheet below 900 px).

## CLI

`waifus <command>` (`src/cli/ownerCommands.ts`, `lifeCommands.ts`, `settingsCommands.ts`; table in
`src/shared/settings/commands.ts`). Global flags `--data-root`, `--json`, `--help`. Secrets never come
from argv (`--from-env`, `--stdin`, `--file`, or a hidden prompt).

| Command | Behaviour |
|---|---|
| `help [topic]` (e.g. `help dreaming`), `list [group]`, `get`, `set`, `unset` | Settings; `app` keys work with the host stopped (written under the host lock; exit 3 while a host holds it); `updates.enabled` only via `waifus update --auto`; `set app remoteAccess.helperDebugLog true` turns on the local helper debug log for this data root's host and `waifus remote` helpers from their next start ([remote-access.md](remote-access.md#diagnostics)) |
| `wake <waifu> [note…]` | Owner wake (note ≤ 500); prints the outcome (`queued`, `deferred`, `quiet`, `dropped`, `queued_offline`) |
| `life <waifu> [--log] [--limit N] [--private]` | Status, or the log (default 20, ≤ 200 lines) |
| `files <waifu> [path] [--root home\|tmp\|transcripts] [--private]` | List a folder or print a text file |
| `wakeups <waifu> [--private]` (`schedule`: only timed ones, `watches`: only watches and pages) | Her wakeups with their sources |
| `forget <userId> [--yes] [--dry-run]` | Prints the limits and asks for the word `forget` unless `--yes` |
| `usage [--from --to --by --waifu --tz]` | Reads the ledger directly; works with the host stopped |
| `start`, `dev`, `restart`, `stop`, `status`, `doctor`, `clean`, `update`, `remote` | Lifecycle |

Exit codes (`src/cli/cliContext.ts`): 0 ok, 1 failure/5xx, 2 usage, 3 host not running or
unreachable, 4 rejected (400/403/404/428), 5 conflict (409).

## HTTP

Every route is in `ROUTE_POLICY_MANIFEST`; summaries at `GET /api/help`. The life-shaping ones:

| Route | Behaviour |
|---|---|
| `GET /api/waifus/:id/life` | Status, queue (first 50), today's cost; summary hidden unless a local `includePrivate=1` |
| `GET /api/waifus/:id/life/log?epoch&before&limit` | Default 50, ≤ 200 lines; old epochs 7 days; D14 redaction |
| `POST /api/waifus/:id/wake {note?}` | Owner wake through the router; with the cast offline or reloading it is queued in `wakes.json` (`queued_offline`) and runs when the cast connects |
| `POST …/life/compact` | Needs the live cast (409 `RuntimeOffline`) and a model (409 `Conflict`, `details.code`); waits up to 10 s, then 202 `{state: "running"}`; a pause/shutdown → `{state: "aborted"}`; a pending epoch start is applied instead of a second summary |
| `POST …/life/reset {confirm: true}` | Aborts her turn; a fresh epoch with no summary and no kept turns; her files, wakeups, queue and intake cursors stay; old log kept 7 days. Without a model (or before her life began) the summary is cleared and the epoch starts at her next turn (`deferred: true`) |
| `GET …/life/needs-review`, `DELETE …/life/needs-review/:itemId` | Forget review lines (id = 16 hex chars) |
| `GET /api/waifus/:id/files?root=home\|tmp\|transcripts&dir=`, `GET\|PUT\|DELETE …/files/<path>` | Through her `HomeStore`, held to her Edit tool's checks; `PUT {text, expectedHash?}` (`null` = must not exist); `?raw=1` bytes; errors `ReadOnlyFile`, `InvalidFile` (with line/column), `NotTextFile`, `HomeLimit` (413), `NameCollision`, `LinkRefused`, `IsFolder`, 409 on a stale hash; DM files need a local `includePrivate=1` |
| `GET /api/waifus/:id/wakeups`, `DELETE …/wakeups/:wakeupId` | Her wakeups with their sources (D14: one watching a DM redacted without a local `includePrivate=1`); delete rewrites the file (409 when it does not parse); she is not told |
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
  20,000 chars), `list_wakeups` (never DM content), `write_file`, `get_usage`,
  `get_setting_help`, `update_app_config`, `forget_person`, `forget_dm`, plus waifu, server, bot,
  provider, runtime, logs, docs and Remote Access tools.
- **Confirmation cards** (server-held; only the owner's click applies them; expire after 5 minutes):
  `write_file` (the exact `PUT` with the current hash, ≤ 16 KB), `forget_person` and `forget_dm` (dry
  run first, the counts and the limits), `update_app_config` for `http.host`, `frontend.staticDir`,
  `updates.*`, `remoteAccess.*` (the helper debug log), `permissions.*` (who can use `/norma`; other
  keys apply directly; from a paired remote device these are refused), Remote
  Access enable/disable, invitations, pairing approval and device revocation.
- It never sees DM content: a request with `includePrivate` from it answers 403.

## Discord slash commands

House bot, in servers (`src/discord/client.ts`, `src/discord/applicationOwners.ts`,
`src/orchestration/runtime.ts`):

| Command | Behaviour |
|---|---|
| `/wake waifu:<name> [note]` | Owner wake (note ≤ 500). Only a waifu cast in this server (autocomplete offers this server's cast); else "X isn't cast in this server." Replies "Woke X.", "X's wake is queued." (deferred or merged), "X can't be woken right now (paused or disabled)." or, while the cast reloads, "X's wake is queued: the cast is reloading, and it runs once the cast is back." (queued in `wakes.json` like HTTP's `queued_offline`) |
| `/norma text:<text>` | Asks Norma, the dashboard assistant (spec §36, `src/api/assistant/discordNorma.ts`); her final answer is the reply (over 1,900 characters attached as `norma.md`). Not an owner command: anyone listed in `permissions.norma` (Settings → Permissions) may use it, whatever their roles in the server, and nobody else ("You can't use /norma. …"). The list is read at every turn and at every tool call, so a removal stops a turn at its next tool call. One conversation per Discord user, started over after 30 minutes without a message. She runs as the host itself, with every tool the dashboard has, but every change that needs a confirmation card is refused from Discord (her tool gets the refusal and she says so), and `PUT /api/config` refuses her any change to `permissions.*` without a confirmed card |
| `/print type:<system_prompt\|notes\|life> waifu:<name> [private]` | Her system prompt (summary and the index lines from private chats hidden unless `private:true`), her `MEMORY.md` (lines that link to a file from a private chat or name a DM hidden, an index from a private chat not shown, unless `private:true`; [privacy-and-forget.md](privacy-and-forget.md)), or the last 20 life-log lines (DM content hidden unless `private:true`). Over 1,900 characters it is attached as `<type>.md` |

- Only the House bot application's **owner or its team members** may run `/wake` and `/print`; the list is fetched
  when the bot comes online, refreshed every 6 h and re-fetched at run time when older than 10 min; a
  failed fetch keeps the last list; with none, nobody is the owner. Server Administrator is only the
  commands' default visibility. `/norma` is shown to everyone (no default permission) and checked
  against `permissions.norma`. Every reply is ephemeral.
- Retired commands (`/run`, `/stop`, `/review`, `/memories`, `/console`, `/clear`, `/debug`) are
  deleted at registration.
- Waifu bots that take DMs register `/forget conversation|everything` in DMs only
  ([dms.md](dms.md)).

## The waifu role

`src/discord/waifuRole.ts`, `DiscordJsGateway.ensureWaifuRoles` (spec §37): the House bot gives every
waifu bot the role named `discord.waifuRole` (default `waifu`; `""` turns it off) in each server they
share. It looks the role up by name (case-insensitive) and creates it, mentionable, when the server
has none. It runs in the background when the House bot connects (every waifu bot), when a waifu bot
connects (that bot), when a waifu bot joins a server (that bot there) and when the House bot joins one
(every waifu bot there); one pass at a time per server. A bot that has the role is left alone; it is
never removed, and the House bot and people are never touched. It needs Manage Roles and the role
below the House bot's own (its Administrator invite gives the first; a role it creates is at the
bottom); a failure is logged once per server (`Could not give the waifu role`) and tried again at the
next connect or join. The role reaches the life as the bot's member update, so mentioning it wakes
every waifu there (`role`, [triggers.md](triggers.md)).

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
| Sending | `life.maxSendPlacesPerTurn` / `maxSendsPerTurn` | 3 / 15 | Per-turn send caps (each `m:` line counts one) |
| | `life.send.maxFiles` | 4 | Attachments per message (0 = no `attach` lines) |
| Wakes | `life.maxWakesPerUserPerHour` | 20 | Per-user wake limit |
| | `life.maxWatchFiresPerDay` | 24 | Repeating watch cap |
| | `life.notificationLinesPerPlace` | 8 | Lines per place (also in the budget batch) |
| | `life.maxWaifuTriggeredTurns` | 0 (off) | Room loop guard |
| Holds | `discord.debounce.serverMs` / `serverMaxWaitMs` | 1.5 s / 10 s | Room burst |
| | `discord.debounce.dmMs` / `dmMaxWaitMs` | 2.5 s / 60 s | DM burst |
| | `discord.debounce.typingHoldMs` | 6 s | Per typing event |
| | `discord.dm.resumeWindowMinutes` | 60 | Boot catch-up window |
| Context | `life.maxContextTokens` | 96,000 | Budget cap |
| | `compaction.triggerRatio` | 0.7 | The rest point: her rest notice (with `life.restNotice` off, compaction) |
| | `compaction.emergencyRatio` | 0.9 | Emergency summary: auto-compaction between turns (an update must keep it > `triggerRatio`; a stored config with it at or below the trigger loads with it moved to the trigger + 0.04, at most 0.99, and the upgrade writes that for a trigger of 0.9 or more) |
| | `life.maxLogMessages` | 400 | Log-length trigger |
| | `life.maxInlineImagesPerEpoch` / `…BytesPerEpoch` | 8 / 12 MiB | Inline images |
| Rest | `life.restNotice` / `restSummaryMinChars` | true / 200 | Rest turn (`life.restNoticeRatio` was removed in §26) |
| | `life.cacheRestMinRatio` / `cacheRestLeadMinutes` | 0.5 / 10 | Rest before her prompt cache goes cold (§25): from this share of the trigger, this many minutes before the 1-hour cache expires |
| | `life.selfSummaryMinRatio` / `selfSummaryCooldownMinutes` | 0.3 / 120 | `<summary>` guards |
| Dreaming | `life.maintenanceHourLocal` | 5 | Dream hour (every waifu, daily) |
| | `life.dreamModel` / `dreamMaxRounds` / `dreamWindowMaxChars` | her model / 60 / 200,000 | Dream session |
| Computer | `life.home.*`, `life.tmp.*`, `life.attachments.maxBytes` | 50 MiB, 2,000 files, 500 folders; 200 MiB, 2,000 files, 7 days; 10 MiB | Folder limits |
| | `life.bash.enabled` / `python` / `maxTimeoutMs` / `maxOutputChars` / `maxMemoryMb` | true / true / 60 s / 16,000 / 512 | Bash |
| Web | `search.maxPerSecond` / `maxPerDay` / `maxPerWaifuPerDay` | 2 / 50 / 20 | searches in her Web scripts (`search_query`; 0 = off) |
| | `life.webFetch.maxPerTurn` / `maxPerWaifuPerDay` / `cacheMinutes` | 6 / 20 / 15 | pages in her Web scripts (`open`, `click`, `find`/`ask` on a new page; 0 = off; both off: no Web tool); `life.webFetch.model` answers `ask`; `directMaxChars` is no longer used |
| Detector | `detector.target` | `openrouter:typesafe/jev-1.14` | `""` = fallback only |
| Waifu | `wakeOnName` | true | |
| | `life.dailyBudgetUsd` | none | Daily budget |
| | `dm.allowDms` / `dm.rateLimit` / `dm.notifyWhenLimited` | false / 30 per 60 min / true | DMs |
| | `dm.limitNotice` | built-in | Automatic DM (≤ 300) |
| | `customInstructions` | "" | Appended after the persona (≤ 4,000) |
