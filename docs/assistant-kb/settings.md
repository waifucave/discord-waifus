# Settings, help and the CLI

Every setting, with its type, default and what it does; generated from the settings registry (do not edit by hand: run `npm run docs:settings:generate`). Read and write any of them over HTTP (the routes below) or with `waifus get|set|unset`; `GET /api/help/<topic>` and `waifus help <topic>` show the same help.

Targets: `app`, `assistant`, `remote-access`, `waifu:<id>`, `server:<guildId>`, `channel:<guildId>/<channelId>`, `bot:<house|id>`, `provider:<id>`. Secrets (`apiKey`, `token`) are write-only and never go on the command line.

## App (`app`)

The host's config.toml. GET /api/config reads it and PUT /api/config takes a partial patch (omitted keys keep their values); the host then reloads its Discord runtime unless only `updates` changed. With the host stopped, `waifus set app …` writes config.toml directly.

Target `app` · stored in `config.toml` · writes: revision none.

- `GET /api/config` — The app settings (config.toml).
- `PUT /api/config` — Change app settings (partial patch).

| Key | Type | Default | What it does |
|---|---|---|---|
| `http.host` | string | `127.0.0.1` | The interface the dashboard and API listen on. Keep it on loopback (127.0.0.1); Remote Access never needs it changed. (local-only write; next start) |
| `http.port` | integer 1–65535 | `3888` | The dashboard and API port. (next start) |
| `runtime.autoConnectDiscord` | boolean | `true` | Connect the Discord bots when the host starts. |
| `runtime.paused` | boolean | `false` | Pause every life: no wakes are routed and no turn starts; queues are kept and catch up on resume. `waifus set app runtime.paused true` is the same as Pause in the dashboard. |
| `frontend.staticDir` | string |  | Serve the dashboard from this folder instead of the bundled build (development only). The dashboard on this computer uses it at once; Remote Access's copy at the next start. (local-only write) |
| `ocr.enabled` | boolean | `true` | Read text out of images for models without image input. |
| `ocr.engine` | one of auto \| apple-vision \| bundled-tesseract \| system-tesseract | `auto` | OCR engine: auto (Apple Vision on macOS, else the bundled Tesseract), apple-vision, bundled-tesseract or system-tesseract. |
| `ocr.cacheTtlHours` | integer 1–720 [hours] | `168` | How long OCR results are cached. |
| `ocr.timeoutMs` | integer 250–30000 [ms] | `1500` | Time limit for one image's OCR. |
| `ocr.maxImageBytes` | integer 1024–33554432 [bytes] | `8388608` | Images larger than this are not read. |
| `ocr.maxImagesPerModelCall` | integer 0–20 | `4` | At most this many images are read for one model call. |
| `ocr.maxTextCharsPerImage` | integer 100–10000 [characters] | `1500` | OCR text kept per image. |
| `compaction.enabled` | boolean | `true` | Summarise her life when it gets long (off: truncate at the same points, with no summary). |
| `compaction.triggerRatio` | number 0.3–0.95 | `0.7` | Compact when her prompt reaches this share of her context budget (life.maxContextTokens or the model's window). |
| `compaction.maxMessages` | integer 20–200 | `150` | Kept for older conversation uses; lives use life.maxLogMessages instead. |
| `compaction.keepRecent` | integer 5–120 | `30` | Kept for older conversation uses; lives keep their last three complete turns instead. |
| `compaction.waitTimeoutMs` | integer 0–30000 [ms] | `6000` | How long a caller waits for a running compaction before moving on. |
| `discord.images.maxBytes` | integer 65536–20971520 [bytes] | `5242880` | Largest Discord image downloaded. |
| `discord.images.fetchTimeoutMs` | integer 500–30000 [ms] | `5000` | Time limit for one image download. |
| `discord.images.memoryCacheMb` | integer 0–512 [MB] | `64` | In-memory image cache size. |
| `discord.images.diskCacheMb` | integer 0–2048 [MB] | `256` | On-disk image cache size. |
| `discord.images.diskCacheTtlHours` | integer 1–720 [hours] | `168` | How long downloaded images are kept on disk (a forget cannot remove a cached guild image, or a DM image no image index recorded, before this). |
| `discord.guildMembersIntent` | boolean | `false` | Use Discord's privileged Server Members intent for full member lists. Enable it in the Developer Portal first; changing it re-logs the House bot. |
| `discord.memberListRefreshHours` | integer 0–168 [hours] | `24` | How often full member lists are refreshed (0 = never). |
| `discord.debounce.serverMs` | integer 0–30000 [ms] | `1200` | Quiet time before a burst of server messages goes to the addressee detector. |
| `discord.debounce.serverMaxWaitMs` | integer 0–120000 [ms] | `4000` | A burst goes to the detector after at most this long. |
| `discord.debounce.dmMs` | integer 0–120000 [ms] | `30000` | A DM wakes her this long after the person's last message (each message restarts the timer). |
| `discord.debounce.dmMaxWaitMs` | integer 0–300000 [ms] | `180000` | A DM wakes her after at most this long, however often the person keeps writing. |
| `discord.dm.resumeWindowMinutes` | integer 0–1440 [minutes] | `60` | At start, messages that arrived while the host was down wake her only when they are at most this old (older ones stay readable). |
| `models.allowed` | list of strings | `["meta/muse-spark-1.3-contributor","openrouter/meta/muse-spark-1.3-contributor","anthropic/claude-haiku-5-5","openrouter/anthropic/claude-haiku-5.5","anthropic/claude-sonnet-5-5","openrouter/anthropic/claude-sonnet-5.5","deepseek/deepseek-flash","openrouter/deepseek/deepseek-v4.1-flash","openai/gpt-6-luna","openrouter/openai/gpt-6-luna","openai/gpt-6.1-sol","openrouter/openai/gpt-6.1-sol"]` | The curated model routes waifus and the assistant may use (winter route keys such as anthropic/claude-sonnet-5-5). Routes the installed catalog lacks are hidden. |
| `models.maxOutputUsdPerMTok` | number >0–10 [USD] | `10` | Routes above this output price per million tokens are hidden (at most 10). |
| `life.maxConcurrentTurns` | integer 1–16 | `4` | How many lives may run a turn at the same time on this host. |
| `life.maxToolRounds` | integer 1–30 | `12` | A turn ends after this many model calls. |
| `life.maxTurnMs` | integer 30000–600000 [ms] | `180000` | A turn ends after this long. |
| `life.maxLogMessages` | integer 50–2000 | `400` | Compact her life when its log reaches this many messages. |
| `life.maxContextTokens` | integer 32000–100000 [tokens] | `96000` | Her context budget: compaction keeps every request under this (and under the model's window), below long-context price tiers. |
| `life.maxInlineImagesPerEpoch` | integer 0–20 | `8` | Images shown to her as images per epoch; later ones are described by their OCR text. |
| `life.maxInlineImageBytesPerEpoch` | integer 0–20971520 [bytes] | `12582912` | Image bytes shown to her as images per epoch. |
| `life.maxSendPlacesPerTurn` | integer 1–10 | `3` | Distinct places she may send to in one turn. |
| `life.maxSendsPerTurn` | integer 1–50 | `8` | Messages she may send in one turn. |
| `life.maxWakesPerUserPerHour` | integer 1–200 | `20` | Direct or detector wakes one person may cause her per hour in servers; the rest are merged into one line. |
| `life.maxWatchFiresPerDay` | integer 1–100 | `24` | How often one of her repeating watches may fire per day. |
| `life.maxWaifuTriggeredTurns` | integer 0–100 | `0` | Room loop guard: after this many waifu-written messages woke someone in a place since the last human message there, further waifu messages wake nobody (0 = off). |
| `life.maintenanceHourLocal` | integer 0–23 [hour 0–23] | `5` | Local hour of nightly maintenance for a waifu with no sleep window (with one, it runs 30 minutes into her sleep). |
| `life.webFetch.model` | string | `""` | Route for reading long web pages ("" = the cheapest offered route with a key; name a contributor route here to allow one). |
| `life.webFetch.maxPerWaifuPerDay` | integer 0–500 | `20` | Pages one waifu may fetch per day (0 = no WebFetch). |
| `life.webFetch.maxPerTurn` | integer 0–20 | `3` | Pages she may fetch in one turn (0 = no WebFetch). |
| `life.webFetch.directMaxChars` | integer 0–20000 [characters] | `2000` | A page this short is given to her as is; longer ones are read by one digest call. |
| `life.webFetch.maxBytes` | integer 65536–10485760 [bytes] | `5242880` | Largest page downloaded. |
| `life.webFetch.timeoutMs` | integer 2000–60000 [ms] | `20000` | Time limit for one page. |
| `life.webFetch.maxRedirects` | integer 0–10 | `5` | Redirects followed (each hop is checked against private addresses). |
| `life.webFetch.cacheMinutes` | integer 0–1440 [minutes] | `15` | Fetched pages are cached this long. |
| `life.home.maxBytes` | integer 1048576–1073741824 [bytes] | `52428800` | Her home folder (her notes, reminders, watches and anything she keeps) may hold at most this much; a write past it is refused. |
| `life.home.maxFiles` | integer 10–20000 | `2000` | Files her home folder may hold. |
| `life.home.maxFolders` | integer 10–5000 | `500` | Folders her home folder may hold. |
| `life.tmp.maxBytes` | integer 1048576–2147483648 [bytes] | `209715200` | Her /tmp (downloads and scratch files) may hold at most this much; the oldest files there are deleted when a download would not fit. |
| `life.tmp.maxFiles` | integer 10–20000 | `2000` | Files her /tmp may hold; a Bash command or a write past it is refused, and a download deletes the oldest files first. |
| `life.tmp.retentionDays` | integer 1–90 [days] | `7` | Files in her /tmp are deleted this many days after they were last written (her home is never touched). |
| `life.attachments.maxBytes` | integer 65536–52428800 [bytes] | `10485760` | Largest attachment ReadMessages downloads into her /tmp (images, PDFs and text files; larger ones are only listed). |
| `life.send.maxFiles` | integer 0–10 | `4` | Files she may attach to one message (0 = none). |
| `life.bash.enabled` | boolean | `true` | Offer her the simulated Bash (just-bash over a copy of her two folders; never a real program, no network). Off: the tool is not offered. |
| `life.bash.python` | boolean | `true` | Let her Bash run python3 (CPython compiled to WebAssembly, inside the same isolation). |
| `life.bash.maxTimeoutMs` | integer 1000–300000 [ms] | `60000` | The longest one Bash command may run (she asks for up to this; the default is 10 seconds). The worker is terminated at the limit and nothing is saved. |
| `life.bash.maxOutputChars` | integer 1000–100000 [characters] | `16000` | Bash output she sees (the rest is cut). |
| `life.bash.maxMemoryMb` | integer 128–4096 [MiB] | `512` | How much the host process may grow while one Bash command runs (its WebAssembly Python memory included). Past it the command is stopped and nothing is saved. |
| `search.maxPerSecond` | integer 0–10 | `2` | Web searches started per second, host-wide (paced, not refused; 0 = no WebSearch). |
| `search.maxPerDay` | integer 0–10000 | `50` | Web searches per day, host-wide (0 = no WebSearch). The optional Exa key is the `exa` provider credential, not config. |
| `search.maxPerWaifuPerDay` | integer 0–10000 | `20` | Web searches one waifu may make per day (0 = no WebSearch). |
| `detector.target` | string | `openrouter:cloudflare/clef` | The addressee detector (who is an unaddressed message for?): a native-choice decision model such as openrouter:cloudflare/clef, openai:gpt-6-luna or laya:english; "" turns it off (then a first message in 10 minutes or a question wakes one waifu at random). Also GET/PUT /api/detector/config. |
| `updates.enabled` | boolean | `false` | Install newer patch releases automatically when every managed process is idle (global npm installs only). (local-only write) |
| `updates.checkIntervalMinutes` | integer 15–1440 [minutes] | `60` | How often npm is checked for a newer patch release. (local-only write) |
| `updates.idleMinutes` | integer 1–120 [minutes] | `5` | How long everything must be quiet before an update installs. (local-only write) |

CLI: `waifus get app [KEY]`, `waifus set app KEY VALUE`, `waifus unset app KEY`.

## Waifu (`waifu`)

`user/waifus/<id>/waifu.json`. Writes are partial and need the revision you read (the CLI sends it; a stale one is a 409). Changes to what her prompt contains take effect at her next turn through a compaction.

Target `waifu:<waifuId>` (e.g. `waifu:aria`) · stored in `user/waifus/<waifuId>/waifu.json` · writes: revision required.

- `GET /api/waifus` — Every waifu.
- `GET /api/waifus/:waifuId` — One waifu's settings.
- `PUT /api/waifus/:waifuId` — Change a waifu's settings (partial; revision required).

| Key | Type | Default | What it does |
|---|---|---|---|
| `id` | string |  | Her id (the folder name; fixed when she is created). (read-only) |
| `name` | string |  | Her name (also a wake word when wakeOnName is on). |
| `displayName` | string |  | The name shown in the dashboard and her prompt. |
| `enabled` | boolean | `true` | In the cast (off: she is benched and never wakes). |
| `persona` | string | `""` | Who she is: voice, history, quirks, relationships. |
| `model` | JSON or null |  | Her model: {providerId, modelId, effort?} from GET /api/models (or `provider/model[@effort]` on the command line). Contributor variants share prompts for training; pick one only on purpose. |
| `botId` | string or null |  | Her own Discord bot (a discord-bots entry id). Without one she cannot post or receive DMs. |
| `availability.sleep.enabled` | boolean | `false` | She sleeps every day in this window: every wake but the owner's waits for the morning. |
| `availability.sleep.start` | string [HH:mm] | `23:00` | When her sleep starts (local time). |
| `availability.sleep.end` | string [HH:mm] | `07:00` | When her sleep ends (local time). |
| `availability.busy` | JSON | `[]` | Daily busy blocks [{start, end, reason}] (HH:mm, local). Wakes still reach her; she knows she is busy. |
| `verbosity` | one of terse \| chatty \| expressive | `terse` | How long her messages are: terse, chatty or expressive. |
| `customInstructions` | string | `""` | Extra instructions added to her prompt (at most 4000 characters). |
| `scheduleInPrompt` | boolean | `true` | Tell her about her schedule (sleep and busy blocks) in her prompt. |
| `wakeOnName` | boolean | `true` | Her name, display name or server nickname in a message wakes her (turn off for names that are common words). |
| `life.dailyBudgetUsd` | number >0–10000 or null [USD] | `null` | Her spending limit per local day in USD; when reached, wakes wait for the next day (the owner's wakes still go through). null = no budget. |
| `dm.allowDms` | boolean | `false` | Accept DMs on her own bot (she must be the only enabled waifu on it and have a model). |
| `dm.rateLimit` | JSON or null | `{"maxReplies":30,"windowMinutes":60}` | Replies per person per window: {maxReplies, windowMinutes}; null = unlimited. |
| `dm.notifyWhenLimited` | boolean | `true` | Send the limit notice once when a person reaches the limit. |
| `dm.limitNotice` | string | `""` | The limit notice ("" = the built-in one; at most 300 characters). |
| `dm.sleepNotice` | string | `""` | Sent once per sleep window when someone DMs her while she sleeps ("" = none; no model call). |

CLI: `waifus get waifu:aria [KEY]`, `waifus set waifu:aria KEY VALUE`, `waifus unset waifu:aria KEY`.

## Server (`server`)

`user/servers/<guildId>/server.json`. A server is live unless paused; a channel is live when it has an enabled waifu (see the channel group).

Target `server:<guildId>` (e.g. `server:100000000000000001`) · stored in `user/servers/<guildId>/server.json` · writes: revision optional.

- `GET /api/servers` — Every server with its channels.
- `GET /api/servers/:guildId` — One server.
- `PUT /api/servers/:guildId` — Change a server's settings (name, paused, detector override).

| Key | Type | Default | What it does |
|---|---|---|---|
| `guildId` | string |  | The server's Discord id. (read-only) |
| `name` | string |  | The server's name (refreshed from Discord). |
| `paused` | boolean | `false` | The server's kill switch: messages are observed but wake nobody until it is switched back on. |
| `detector.target` | string |  | This server's addressee detector target, overriding the app's detector.target ("" = no detector here). Unset to inherit. |

CLI: `waifus get server:100000000000000001 [KEY]`, `waifus set server:100000000000000001 KEY VALUE`, `waifus unset server:100000000000000001 KEY`.
Not here: `channels` — Edit channels with the channel group (`waifus set channel:<guild>/<channel> …`).

## Channel (`channel`)

Stored inside the server's server.json. Target it as `channel:<guildId>/<channelId>`.

Target `channel:<guildId/channelId>` (e.g. `channel:100000000000000001/200000000000000002`) · stored in `user/servers/<guildId>/server.json (channels.<channelId>)` · writes: revision optional.

- `GET /api/servers/:guildId` — One server.
- `PUT /api/servers/:guildId/channels/:channelId` — Change a channel's cast or thread mode.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channelId` | string |  | The channel's Discord id. (read-only) |
| `name` | string |  | The channel's name (refreshed from Discord). |
| `enabledWaifuIds` | list of strings | `[]` | The waifus cast in this channel (a JSON list of ids, or ids separated by commas). Empty = silent. |
| `threads` | one of inherit \| off |  | Threads and forum posts under this channel inherit its cast (inherit) or stay silent (off). |

CLI: `waifus get channel:100000000000000001/200000000000000002 [KEY]`, `waifus set channel:100000000000000001/200000000000000002 KEY VALUE`, `waifus unset channel:100000000000000001/200000000000000002 KEY`.
Not here: `thread` — Runtime-only overlay for threads; never stored.

## Assistant (`assistant`)

`user/assistant/config.json`. Unset, the assistant borrows a waifu's model (an offered, non-contributor model whose provider has a key).

Target `assistant` · stored in `user/assistant/config.json` · writes: revision optional.

- `GET /api/assistant/config` — The assistant's own model.
- `PUT /api/assistant/config` — Set or unset the assistant's model.

| Key | Type | Default | What it does |
|---|---|---|---|
| `model` | JSON or null |  | The assistant's model: {providerId, modelId, effort?} from GET /api/models (or `provider/model[@effort]`). |

CLI: `waifus get assistant [KEY]`, `waifus set assistant KEY VALUE`, `waifus unset assistant KEY`.

## Discord bot (`bot`)

`user/discord-bots.json`. The House bot reads every server message and hosts /wake and /print (stored under the `orchestrator` key); each waifu posts through her own bot. Writes merge by id and keep stored tokens; the runtime reloads to reconnect.

Target `bot:<botId>` (e.g. `bot:house`) · stored in `user/discord-bots.json` · writes: revision optional.

- `GET /api/discord-bots` — The House bot and the waifu bots (tokens redacted).
- `PUT /api/discord-bots` — Change bot entries (merged by id; stored tokens kept).

| Key | Type | Default | What it does |
|---|---|---|---|
| `id` | string |  | The bot entry's id (`house` for the House bot; a waifu's bot usually has her id). (read-only) |
| `displayName` | string |  | Name shown in the dashboard. |
| `applicationId` | string |  | The Discord application id (not secret; from the Developer Portal). |
| `token` | string |  | The bot token. Never on the command line: `waifus set bot:<id> token --from-env VAR` or pipe it on stdin. Never shown again. (secret, write-only) |
| `enabled` | boolean | `true` | Log this bot in (off keeps it offline). |

CLI: `waifus get bot:house [KEY]`, `waifus set bot:house KEY VALUE`, `waifus unset bot:house KEY`.

## Provider key (`provider`)

`user/providers.json`. Keys are write-only: reads show a hint of the last characters. Saving a key clears a quota or billing cooldown for that provider.

Target `provider:<providerId>` (e.g. `provider:anthropic`) · stored in `user/providers.json` · writes: revision optional.

- `GET /api/providers` — Provider key status (hints only, never keys).
- `PUT /api/providers/:providerId/credentials` — Save a provider key (write-only).

| Key | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | string |  | The API key. Never on the command line: `waifus set provider:<id> apiKey --from-env VAR` or pipe it on stdin. `waifus unset provider:<id> apiKey` removes it. (secret, write-only) |
| `label` | string |  | A label for the key. Setting it re-sends the key, so give the key too (--from-env or stdin). |

CLI: `waifus get provider:anthropic [KEY]`, `waifus set provider:anthropic KEY VALUE`, `waifus unset provider:anthropic KEY`.
Not here: `providerId` — The target id.
Not here: `createdAt` — Set by the app.

## Remote Access (`remote-access`)

Managed by the Remote Access helper. Enabling needs an activated installation (428 ActivationRequired until then); pairing and devices are in Settings → Remote Access.

Target `remote-access` · stored in `app/remote-access/ (helper-owned)` · writes: revision uint64-string.

- `GET /api/remote-access` — Remote Access configuration and live direct-connection state.
- `PUT /api/remote-access` — Turn Remote Access on or off, or rename this host.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean |  | Remote Access on this host (direct connections only; never relayed). |
| `displayName` | string |  | The name paired devices see (1–80 characters). |

CLI: `waifus get remote-access [KEY]`, `waifus set remote-access KEY VALUE`, `waifus unset remote-access KEY`.

## Topics

### A waifu's life (`life`)

Each waifu is an autonomous agent with one continuous life: wakes arrive as notifications, she decides what to do with her tools, and only her sends reach people. The life log hides DM content unless a local request reveals it (includePrivate=1; never over Remote Access). Compact summarises her life now; reset starts a fresh epoch with no summary (her files and queued wakes stay). Each waifu has her own computer: her home /home/<name> (her notes in any layout, MEMORY.md her index, schedule.json her reminders, watches.json her watches, places.md kept by the app) and /tmp (files people sent, deleted 7 days after the last write). The files routes list, read, write and delete them under the same checks as her Write tool (places.md refused, the JSON files checked with line and column; revision by content hash, expectedHash). A file from a private chat is listed as [private chat redacted] and opens only with a local includePrivate=1; a watch bound to a DM is redacted the same way.

- `GET /api/waifus/:waifuId/life` — Her life: status, current turn, queue, epoch, today's cost (?includePrivate=1 locally).
- `GET /api/waifus/:waifuId/life/log` — Her life log, paged (?epoch&before&limit; DM content only with a local includePrivate=1).
- `POST /api/waifus/:waifuId/wake` — Wake her now with an optional note (skips sleep and budget).
- `POST /api/waifus/:waifuId/life/compact` — Summarise her life now (between turns).
- `POST /api/waifus/:waifuId/life/reset` — Reset her short-term memory: a fresh epoch, no summary ({confirm: true}).
- `GET /api/waifus/:waifuId/life/needs-review` — Forget review lines for the owner.
- `DELETE /api/waifus/:waifuId/life/needs-review/:itemId` — Dismiss a review line.
- `GET /api/waifus/:waifuId/files` — List a folder of her home or /tmp (?root=home|tmp&dir; files from private chats are named only with a local includePrivate=1).
- `GET /api/waifus/:waifuId/files/*` — One of her files: JSON with the text for a text file, ?raw=1 for the bytes (a DM file needs a local includePrivate=1).
- `PUT /api/waifus/:waifuId/files/*` — Write a text file in her folders ({text, expectedHash?}; her Write tool's checks; places.md refused).
- `DELETE /api/waifus/:waifuId/files/*` — Delete one of her files (?expectedHash).
- `GET /api/waifus/:waifuId/schedule` — Her reminders (~/schedule.json), parsed.
- `DELETE /api/waifus/:waifuId/schedule/:reminderId` — Remove one reminder from her schedule.json.
- `GET /api/waifus/:waifuId/watches` — Her watches (~/watches.json), parsed; a watch bound to a DM is redacted unless a local includePrivate=1.
- `DELETE /api/waifus/:waifuId/watches/:watchId` — Remove one watch from her watches.json.

- `waifus life <waifu> [--log] [--private]`
- `waifus wake <waifu> [note]`
- `waifus files <waifu> [path] [--root tmp] [--private]`
- `waifus schedule <waifu>`
- `waifus watches <waifu> [--private]`

### Forget a person (`forget`)

POST /api/people/:userId/forget {confirm: true, dryRun?} deletes the person's DMs with every waifu, removes them from member lists and the archive, and scrubs every life (her summary, queued wakes, her reminders and watches, and every text file in her home, then a verification pass; her downloads of the person's files and copies of them are deleted). A part that fails answers 202 with `pending` and runs again at the next start (given up after 3 tries, with an owner notice). Review lines (names someone else shares) are kept per waifu for the owner.

- `POST /api/people/:userId/forget` — Forget a Discord user everywhere ({confirm: true, dryRun?}; 202 with pending parts).
- `GET /api/people/forget-jobs` — Owner forgets that have not finished, part by part.
- `GET /api/owner-notices` — What needs the owner's attention (notices, forget jobs, incomplete migrations).

- `waifus forget <userId> [--yes] [--dry-run]`

### Usage and cost (`usage`)

GET /api/usage?from&to&groupBy&tz reads user/usage/*.jsonl (one line per model call) with local-day boundaries; GET /api/search/usage shows today's web searches and the newest queries.

- `GET /api/usage` — Model calls and cost by local day (?from&to&groupBy&tz&waifuId&purpose).
- `GET /api/search/usage` — Today's web searches, the caps and the newest queries.

- `waifus usage [--from DAY] [--to DAY] [--by KEY[,KEY]] [--waifu ID] [--tz ZONE]`

### Addressee detector (`detector`)

GET/PUT /api/detector/config is the app's detector.target; GET /api/detector/models lists the decision models; GET /api/detector/history?guildId shows a server's last 300 results. A server may override the target (server group, detector.target).

- `GET /api/detector/config` — The detector's global target.
- `PUT /api/detector/config` — Set the detector's global target ("" turns it off).
- `GET /api/detector/models` — The addressee detector's decision models.
- `GET /api/detector/history` — A server's last 300 detector results (?guildId).

- `waifus get app detector.target`
- `waifus set app detector.target <target>`

### Runtime (`runtime`)

GET /api/runtime is the live status (bots, queues, warnings, model notices); pause stops every life without losing queues; reload rebuilds the Discord runtime.

- `GET /api/runtime` — Live runtime status: bots, queues, warnings (owner notices), model notices, provider cooldowns.
- `POST /api/runtime/pause` — Pause every life (queues are kept).
- `POST /api/runtime/resume` — Resume; what arrived meanwhile is caught up.
- `POST /api/runtime/reload` — Rebuild the Discord runtime without restarting HTTP.
- `GET /api/owner-notices` — What needs the owner's attention (notices, forget jobs, incomplete migrations).
- `GET /api/diagnostics/bundle` — A sanitized diagnostics bundle.

- `waifus status`
- `waifus doctor`
- `waifus set app runtime.paused true`

### Environment variables (`environment`)

DC_WAIFUS_HOME overrides the data root (default ~/.dc-waifus). DC_WAIFUS_LAYA_PYTHON points the local Laya detector at a Python with its packages (host only; never accepted through the API).


- `DC_WAIFUS_HOME=PATH waifus start`

## Commands

- `waifus help [TOPIC]` — Help for a command, a settings group, a key or a topic (works offline).
- `waifus list [GROUP]` — List the settings groups, or one group's keys with type, default and help (and its targets when the host runs).
- `waifus get TARGET [KEY]` · `waifus get app.life.maxSendsPerTurn` · `waifus get app.search` — Read settings: a whole target, a part of one (app.search) or one key.
- `waifus set TARGET KEY VALUE` · `waifus set TARGET KEY=VALUE [KEY=VALUE…]` · `waifus set app.life.maxSendsPerTurn 6` · `waifus set provider:anthropic apiKey --from-env ANTHROPIC_KEY` — Change settings: one key, or several KEY=VALUE pairs in one write.
- `waifus unset TARGET KEY [KEY…] [--yes]` · `waifus unset waifu:aria life.dailyBudgetUsd` — Reset keys: a key that takes null is cleared, any other key goes back to its default.
- `waifus wake WAIFU [NOTE…]` — Wake a waifu now, with an optional note she sees (an owner wake skips sleep and budget).
- `waifus life WAIFU [--log] [--limit N] [--private]` — A waifu's life: status, queue and today's cost; --log adds the recent life log.
- `waifus files WAIFU [PATH] [--root tmp] [--private]` · `waifus files aria people/kevin.md` · `waifus files aria --root tmp` — Her files: list a folder of her home or /tmp, or print a text file.
- `waifus schedule WAIFU` — Her reminders (~/schedule.json), in the host's time zone.
- `waifus watches WAIFU [--private]` — Her watches (~/watches.json): what each waits for and when it times out.
- `waifus forget USER_ID [--yes] [--dry-run]` — Forget a Discord user everywhere (best-effort scrub); asks for confirmation unless --yes.
- `waifus usage [--from DAY] [--to DAY] [--by KEY[,KEY]] [--waifu ID] [--tz ZONE]` — Model calls and cost from the usage ledger, by local day (or another grouping).
- `waifus start [--host 127.0.0.1] [--port 3888] [--data-root PATH]` — Start the host in the background (dashboard, API and Discord).
- `waifus dev [--host 127.0.0.1] [--port 3888] [--data-root PATH]` — Run the host in the foreground for development.
- `waifus stop [--data-root PATH]` — Stop the host.
- `waifus restart [--host 127.0.0.1] [--port 3888] [--data-root PATH]` — Stop, then start the host.
- `waifus status [--data-root PATH]` — Whether the host and the remote gateway run, plus the Living cast's state that needs attention (JSON).
- `waifus doctor [--data-root PATH]` — Check the install and the data root (read-only; JSON).
- `waifus clean [--force] [--include-logs] [--data-root PATH]` — Delete ordinary user data (keeps Remote Access pairing).
- `waifus update [--npm | --github]` · `waifus update --auto on|off|status [--data-root PATH]` — Update the installed package, or turn idle updates on or off.
- `waifus remote [--setup] [--foreground] [--no-open] [--host ID_OR_NAME] [--port PORT] [--data-root PATH]` · `waifus remote status [--data-root PATH]` · `waifus remote stop [--data-root PATH]` — Run the Remote Access gateway on this device, or check or stop it.
