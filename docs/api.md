# Discord Waifus Backend API

Base URL defaults to `http://127.0.0.1:3888`.

All frontend code should use this HTTP API. It should not read `~/.dc-waifus` or `DC_WAIFUS_HOME` directly.

## Browser session security

The dashboard establishes a same-origin browser session with `GET /api/client-context`. The
response body is only `{ "mode": "host" }`; the CSRF token is returned in the
`X-Waifus-CSRF` response header and is kept in memory by the frontend. Browser writes must send
that header and the host-only, HttpOnly session cookie. The frontend retries once after a browser
session expires. It never stores the CSRF token in HTML, URLs, cookies, or browser storage.

Loopback command-line clients without browser-origin headers remain compatible and do not need a
browser session. Scripts must not send browser-only `Origin`, `Sec-Fetch-*`, principal, device, or
internal-dispatch headers. The server rejects forged identity headers and browser requests from an
unexpected Host, Origin, or cross-site fetch context.

## Mutation recovery and idempotency

Every unsafe request is recorded before its handler runs. Local callers may omit an idempotency
key; the server generates one internally and returns a 16-byte base64url request identifier in
`X-Waifus-Request-ID`. A remotely authenticated device must send `Idempotency-Key` as canonical,
unpadded base64url encoding of exactly 32 random bytes. Missing remote keys return `428`; malformed
keys return `400`, and neither request starts the effect.

Reusing a key for the same actor, method, concrete target, and canonical body replays the stored,
redacted response without running the effect again. Reusing it for that same target with a changed
body returns `409 IdempotencyConflict`. A different path parameter or mutation-semantic query is a
different operation. Callers must retain the key until the outcome is definitive; they must never
automatically retry a non-replayable operation with a new key after a disconnect.

Invitation creation is the one named exception to ordinary response replay. Its bearer token is
never persisted in the operation ledger. A completed same-actor, same-session, same-key, same-body
retry asks the protected helper to recover the still-active creator-bound invitation; expiry,
cancellation, or a different actor/session cannot retrieve it.

An in-progress or uncertain retry returns only this `202` response:

```json
{
  "operationId": "<32-byte base64url id>",
  "status": "accepted",
  "statusUrl": "/api/admin/operations/<operationId>"
}
```

`GET /api/admin/operations/:operationId` is the authoritative, `no-store` recovery read. A remote
device can read only operations created by that same device at the same trust epoch; local callers
can read every operation in their data root. Missing, expired, malformed, and unauthorized IDs all
return the same `404`. The status resource reports prepared, completed, reconciled, or
`outcome_unknown` state but never includes a stored response body or secret material.

## Runtime

- `GET /api/health`
- `GET /api/status`
- `GET /api/runtime`
- `GET /api/admin/operations/:operationId`
- `POST /api/runtime/pause`
- `POST /api/runtime/resume`
- `POST /api/runtime/reload`
- `GET /api/diagnostics/bundle`
- `GET /api/events`

`/api/events` is an epoch-aware SSE endpoint. A first connection receives a canonical `snapshot`;
live events carry `v1:<128-bit epoch>:<uint64 sequence>` IDs. Reconnects send `Last-Event-ID` and
receive the authorized replay suffix. An epoch mismatch or replay gap emits `snapshot_required`
before a replacement snapshot. Authorization is rechecked for every protected event and heartbeat.

Captured model traffic (`query` and `reply` events, the snapshot's `queries`/`replies`, the
diagnostics bundle) never carries reasoning. A waifu's life, maintenance, compaction and web digest
calls are captured as metadata only (`metadataOnly: true`: `providerId`, `modelId`, `payload`
`{messageCount, toolCount}`; replies `{finishReason, usage, costUsd, durationMs}` or an error's
`{kind, code}`); dashboard assistant and addressee detector calls keep their content.

API responses are marked `Cache-Control: no-store`. Credential material, Discord tokens, private
keys, pairing/internal-capability material, and direct endpoint candidates are scrubbed from
errors, logs, diagnostics, captured model traffic, and event serialization. A remote device gets
the same operational status but not the host process ID, bind port, data root, loopback URL,
absolute host paths, or helper IPC path. Local status/runtime responses retain their intended host
details.

**Living cast.** Each waifu is an autonomous agent with her own life (spec
`docs/specs/2026-10-24-living-cast-design.md`). The director, stage manager, reviewer, memory store
and their routes (`/api/orchestrator/*`, `/api/stage-manager/*`, `/api/reviewer/*`,
`/api/memories*`, `/api/runtime/trigger/*`, `/api/runtime/stop`, `/api/waifus/:id/digest`,
`/api/llm/*`) were removed. Each life has its own routes (status, log, wake, compact, reset, review
lines; see Lives below), and the House bot keeps `/wake` and `/print` for the application's owner.

`GET /api/runtime` adds `models.warnings`: `{scope, label, code, detail, at?, previous?, dismissible}`
entries (`label` is the waifu's name, `previous` the model before) for model choices that need
attention (`model_unmapped`, `effort_dropped` from the upgrade and boot checks, `dismissible: true`;
`model_unavailable` and `model_unpriced` computed live, shown while their cause holds). A scope's
persisted notices clear when its model is changed to an offered one, when the waifu is deleted, or
with `DELETE /api/runtime/model-warnings/:scope` (`waifu:<id>` or `assistant`, URL-encoded) →
`{scope, dismissed}`. A save that leaves the model as it was never clears them.

`GET /api/runtime` → `discord.warnings` holds the owner notices: channel permission failures, Living
cast notices (an unreadable forget record), forget parts given up after three tries, and a waifu
linked to a bot that is missing, turned off or has no token. `GET /api/owner-notices` returns them
with the Living cast's own state: `{notices, forgetJobs, incompleteMigrations, corruptForgetCopies,
pendingScrubs, intake: {paused, pausedAt, marks}, waifusWithoutBot}` (`waifus doctor` and
`waifus status` report the same).

Normal configuration changes apply at runtime. `PUT /api/config`, `PUT /api/discord-bots`, and `POST /api/runtime/reload` rebuild Discord clients and the cast runtime in-process without restarting HTTP. Only HTTP host/port changes require the next process start.

During startup, HTTP binds before Discord auto-connect completes. `/api/status` and `/api/runtime` set optional `discord.connecting` while Discord login is in progress. If Discord auto-connect fails with a transient DNS or network error, the backend keeps Discord offline and retries automatically. Retry metadata is optional: `retrying`, `retryAttempt`, `nextRetryAt`, `lastError`, and `lastErrorAt`.

Each configured bot logs in independently, so one bad waifu token no longer takes the others offline. `discord.houseConnected` says whether the House bot (stored under the `orchestrator` key of `discord-bots.json`) is online. `discord.bots` (optional) lists every configured bot as `{ botId, displayName, kind: "house" | "waifu", state: "connected" | "connecting" | "error" | "disabled" | "missing_token", errorCode?, error?, closeCode?, nextRetryAt?, updatedAt }`. `errorCode` is one of `invalid_token`, `disallowed_intents`, `invalid_intents`, `gateway_rejected`, `network`, `house_unavailable`, or `unknown`. Bots with `enabled: false` never log in. The House bot is required: if it cannot log in (or Discord later ends its session with an unrecoverable close code such as 4004 or 4014), every waifu client is disconnected too. Waifu bots that fail on a network error retry on their own; resumable gateway errors are left to discord.js and no longer restart every bot.

## Remote state and clean

Host remote-access management uses these loopback API routes. The same routes are available to a
currently trusted remote `full_admin` principal through the authenticated direct helper bridge:

- `GET /api/remote-access` — sanitized configuration, identity fingerprint, compatibility, and
  live direct/control state.
- `PUT /api/remote-access` — update the display name or enable/disable remote access.
- `POST /api/remote-access/reconnect` — reconnect the direct runtime.
- `GET /api/remote-access/diagnostics` — sanitized direct-network and helper diagnostics.
- `POST/GET/DELETE /api/remote-access/activation...` — local bound-browser-only activation flow.
- `POST/DELETE /api/remote-access/invitations...` — create or cancel an attended invitation;
  creation and cross-creator cancellation require a confirmed browser context.
- `GET /api/remote-access/pairing-requests` and
  `POST /api/remote-access/pairing-requests/:requestId/approve|reject` — list and decide pending
  attended pairings; approval requires a confirmed browser context and the complete comparison.
- `GET/PUT/DELETE /api/remote-access/devices...` — list, rename, or revoke trusted devices.
  Rename sends `{revision,displayName}` and revoke sends `{revision}` from the latest device list;
  revocation also requires a confirmed browser context.
- `GET /api/remote-access/dashboard-manifest` — the exact canonical manifest for the host's pinned
  bundled dashboard.
- `GET /api/remote-access/dashboard-assets/:buildId/*` — only a declared asset from that exact
  current build; this is not a general filesystem route.

The manifest is always `no-store`. `index.html` is also `no-store`; hash-addressed non-HTML assets
use a one-year immutable cache and an ETag equal to their declared SHA-256. The host verifies the
complete bundled build at startup and fails closed if its manifest, asset identity, size, hash, or
content type changes. Dashboard assets are the sole `/api` caching exception.

Remote identity/trust metadata is partitioned from ordinary user data under
`app/remote-access/` (host role) and `app/remote-gateway/` (remote role). Verified dashboard
bundles live only under `app/cache/remote-dashboard/`; live host/remote helper state lives under
the separate `app/tmp/remote-host/` and `app/tmp/remote-gateway/` trees. Private identity, pair,
node, and discovery keys remain helper-owned in the OS vault and are never stored in these Node
JSON trees.

Per-device revoke is fail closed and restart safe. The host first persists a Node-owned local deny
cutoff, so new requests and assistant actions from that device epoch are rejected even if the helper
or coordination service is temporarily unavailable. Only after the accepted response has drained
does it close that device's existing streams and ask the helper to persist and publish the
cryptographic revocation. An unfinished helper step is retried from the durable cutoff on helper
reconnect or host restart; another device's streams and assistant state are not affected.

`waifus clean` refuses before mutation while the host daemon, host remote helper, or remote gateway
is live. Once stopped, clean removes ordinary user/config/cache data and transient role runtime
state while preserving remote enabled/settings state, the opaque installation/activation
references, trust and deny epochs, pair metadata, remembered hosts, operation receipts, and the
administrative audit. `--include-logs` removes ordinary role diagnostics but never the audit.

Full identity reset is deliberately not an alias for clean or per-device revoke/forget. Its path
ownership is data-root-wide: the current local host daemon is the executor, and a separately live
remote gateway/helper must produce `SiblingDaemonRunning` before any mutation. After helper-owned
vault rotation, the typed flow is exposed only by local Settings → Remote Access through
`POST /api/remote-access/reset` with the exact confirmation `RESET REMOTE ACCESS`. It clears both
roles' old identity/trust/origin state, remembered hosts, and dashboard cache while retaining
operation receipts, audit, the monotonic reset tombstone, and the helper's freshly generated role
metadata. The replacement identity is verified unactivated before the reset is finalized, so every
device must be activated and paired again.

## Config

- `GET /api/config`
- `PUT /api/config`
- `POST /api/cache/ocr/clear`
- `GET /api/discord-bots`
- `PUT /api/discord-bots`
- `GET /api/detector/models` — the addressee detector's native-choice decision model catalog
  (renamed from `/api/orchestrator/one-shot/models`), provider/local setup status and upstream
  availability. Safe read, available to authorized paired remotes; never returns keys. These are
  decision-only models, never offered as waifu models.
- `GET /api/assistant/config`
- `PUT /api/assistant/config` — `{ "model": { "providerId", "modelId", "effort"? } | null }`, the
  dashboard assistant's model (unset: a waifu's model that is offered, has a key and is not a contributor variant; none → the assistant does not run).

`GET /api/discord-bots` returns `{ orchestrator, waifus }`: the `orchestrator` key holds the House
bot (the key name is kept for stored data), `waifus` the waifu bots.

`PUT /api/config` also takes the Living cast sections: `life` (turn, context, image, send, wake,
watch and maintenance limits, and `life.webFetch`), `search` (web search caps; 0 disables) and
`detector` (`target`, "" for none). Bounds are in spec §11.3. The optional Exa key for web search
is a provider credential (`PUT /api/providers/exa/credentials`), not config.

The `living-cast-server-fields-v1` migration removed the server fields the director used
(mode, one-shot target, context windows, tools, compaction, memory limit); a server keeps only an
optional `detector: { target }` override (absent inherits, "" turns the detector off there,
`null` in a `PUT` removes it).

Config is backed by `config.toml` under the data root. Default config:

```json
{
  "schemaVersion": 2,
  "http": { "host": "127.0.0.1", "port": 3888 },
  "runtime": { "autoConnectDiscord": true, "paused": false },
  "frontend": {},
  "updates": { "enabled": false, "checkIntervalMinutes": 60, "idleMinutes": 5 },
  "ocr": {
    "enabled": true,
    "engine": "auto",
    "cacheTtlHours": 24,
    "timeoutMs": 1500,
    "maxImageBytes": 8388608,
    "maxImagesPerModelCall": 4,
    "maxTextCharsPerImage": 1500
  }
}
```

`PUT /api/config` is a partial update: omitted fields retain their stored values, and the merged
configuration is validated before it is saved. Send `{"frontend":{"staticDir":null}}` to clear an
explicit static directory. A remotely authenticated device receives a redacted config and cannot
read or write the host bind address or frontend filesystem path; those settings remain local-only.
Changes to `updates` are also local-only because they authorize future process restarts. A remote
client may resend unchanged update settings with an unrelated config edit. Updates default off;
check intervals accept 15–1440 minutes and quiet windows accept 1–120 minutes. Omitted nested
fields retain their values. `GET /api/updates` is a full-admin read-only endpoint returning
`state`, `currentVersion`, `candidateVersion`, `lastCheckAt` and a closed diagnostic `reason`;
it never exposes local control ports, capabilities, filesystem paths or installer output.
See the README's automatic-update section for installation eligibility, maintenance admission,
rollback limits and browser-session behavior. It is not an API for starting arbitrary commands.

OCR is used only as a fallback for models that are not marked as vision-capable. `engine = "auto"` tries native OS OCR first where supported (Apple Vision on macOS), then the bundled WebAssembly Tesseract (`tesseract.js`, shipped with the package and working offline on every platform), then an explicit system Tesseract fallback. Valid engine values are `auto`, `apple-vision`, `bundled-tesseract`, and `system-tesseract`; legacy `tesseract` configs load as `system-tesseract`. Temporary image downloads live under `app/tmp/ocr`; cached text results live under `app/cache/ocr` and expire by `cacheTtlHours`. `POST /api/cache/ocr/clear` removes OCR cache and temporary OCR files.

## Providers And Models

- `GET /api/providers`
- `PUT /api/providers/:providerId/credentials`

- `GET /api/models`

`GET /api/providers` returns `{ revision, updatedAt, catalogVersion, providers }`. `providers`
lists, as `{ id, displayName, docsUrl?, credentials }`, every provider that serves a curated route
in the installed winter catalog, the detector's decision providers (`openai`, `openrouter`), `exa`
(an optional key for web search; search works without one) and any provider that already has a
stored key. `catalogVersion` is the installed
`@yanlinglabs/winter-provider-catalog` version.

`GET /api/models` returns the curated model list (Living cast spec 9.2):
`{ catalogVersion, maxOutputUsdPerMTok, models, hidden }`. Each model is
`{ id: "<providerId>/<modelId>", providerId, modelId, displayName, providerDisplayName, family,
contextWindow?, maxOutputTokens?, imageInput, efforts, defaultEffort?, pricing?, contributor,
promptCaching, credentialsConfigured }`. `hidden` lists allowed routes that are not offered, as
`{ id, reason }` with `reason` one of `not_in_catalog`, `provider_blocked`, `deprecated`,
`no_tool_calling`, `over_price_cap` (`config.toml` `[models] maxOutputUsdPerMTok`, default and
maximum 10) or `openrouter_reasoning_replay` (the family keeps reasoning state the installed winter
cannot replay through OpenRouter). Waifu and assistant writes accept only offered routes
(`400 model_not_available`) and only efforts the route lists (`400 unsupported_effort`); a stored
model is only re-validated when the write changes it. `defaultEffort` is the effort a model with no `effort` runs at:
the app's own default for the family where it has one (Sonnet 5.5: `medium`), else the vendor's.

Credential writes accept:

```json
{
  "revision": 0,
  "apiKey": "secret",
  "label": "optional label"
}
```

Responses never include raw API keys. They include `configured`, optional `label`, `updatedAt`, and `keyHint`.

Discord bot config responses never include raw bot tokens. They include `tokenConfigured` and `tokenHint`. Sending a bot update without a `token` preserves the saved token.

## Waifus

- `GET /api/waifus`
- `POST /api/waifus`
- `GET /api/waifus/:waifuId`
- `PUT /api/waifus/:waifuId`
- `DELETE /api/waifus/:waifuId`
- `POST /api/waifus/:waifuId/link-bot`
- `POST /api/waifus/:waifuId/assets/pfp`
- `POST /api/waifus/:waifuId/assets/banner`

`PUT` and `DELETE` require either a `revision` body field or an `If-Match` header. Stale writes
return `409 Conflict` with only the latest revision metadata; callers re-read the resource before
merging and retrying.

A waifu's model is `model: { providerId, modelId, effort? }` (or `null`). A `PUT` that sends
`model` replaces it; omitting it keeps it. The gateway-era `params`, `contextWindow`,
`tools.toolUse` and `personaDigest` fields were removed by the `living-cast-models-v1` migration;
request bodies that still carry them are accepted and the fields are ignored.

A `PUT` is partial: omitted fields keep their stored values. The nested settings `dm` and `life`
(`dailyBudgetUsd`, `null` = no budget) are merged key by key; `wakeOnName` is a plain boolean.
Since §38 (no day schedule, no bed time) `availability`, `scheduleInPrompt` and `dm.sleepNotice`
are no longer fields: a body that still carries them is accepted and they are ignored.

Asset uploads accept raw `image/png`, `image/jpeg`, `image/webp`, or `image/gif` request bodies up to 8 MB. Files are stored in `user/waifus/<waifu-id>/`. Nothing reads them yet: they are not applied to the Discord bot's avatar/banner and the dashboard neither uploads nor displays them.

## Servers

- `GET /api/servers`
- `GET /api/servers/:guildId`
- `PUT /api/servers/:guildId`
- `DELETE /api/servers/:guildId`
- `GET /api/servers/:guildId/members`
- `POST /api/servers/:guildId/members/refresh`
- `GET /api/servers/:guildId/emojis`
- `POST /api/servers/:guildId/emojis/refresh`
- `GET /api/servers/:guildId/roles`
- `POST /api/servers/:guildId/roles/refresh`
- `PUT /api/servers/:guildId/channels/:channelId`
- `DELETE /api/servers/:guildId/channels/:channelId`

`:guildId` and `:channelId` must be Discord snowflakes (17–20 digits). A channel is active when its `enabledWaifuIds` list is non-empty; a server is live unless its `paused` flag is set, and restart catch-up skips paused servers and channels without waifus. The old server and channel `enabled` flags were removed; request bodies may still carry them for one release, where they are ignored (and logged). Use the server's `paused` flag to silence a whole guild.

Member and emoji refresh endpoints use the configured House bot token. Member refresh requires Discord permissions/intents that allow member listing. Emoji refresh caches guild custom emojis in `user/servers/<guild-id>/emojis.json`.

## People

- `POST /api/people/:userId/forget` — `{ "confirm": true, "dryRun"?: boolean }`. Forgets one
  Discord user (spec §7.5), best effort. First every waifu with a life folder or notes gets a
  queued scrub carrying the names collected now. Then a durable job in
  `user/people/forget-jobs.json` whose parts each run on their own: a record in
  `user/people/forgotten.json`, the DM floor message ids written or raised first (never lowered, so
  old messages stay out of context), the DM part (DM history and state, cached images and OCR text;
  the rate-limit counters are reset and `dmLimits` counts the limits files that now keep only their
  floor), the user's removal from every server's
  member and active-chat participant lists (`memberLists`), a scrub of the whole Living cast
  archive under `user/.archive/living-cast/` (`archive: { files, removed, unreadable, skipped }`;
  keys and model choices are never touched), and the in-memory captured traffic (Activity, the
  `/api/events` replay) loses every entry carrying the user's id or a name only they have (other
  people's entries stay). A part that fails (`record`, `floors`, `dms`, `dm-directory`,
  `member-lists`, `archive`, `transcripts` or `record-copies`; the DM parts wait for the floors) never stops the
  rest: the response is **202** with `pending: [{ part, error, failures, retried }]` (`error` is an
  error code such as `EACCES`, never a path or message). Its unfinished parts run again at the next
  start, before Discord connects; finished parts never run twice, and a resumed part removes only
  what is at or below the forget's floor and time (a chat he started since stays). After three
  failures a part is given up (`retried: false`) and `GET /api/runtime` lists an owner notice in
  `discord.warnings` until he is forgotten again. If the job cannot even be saved, every part is
  listed with `retried: false`. Then each life's scrub (also when a part failed): her files from him
  deleted by content hash (his downloads in her `/tmp`, copies she moved or made with `cp`, and his
  DM's download folder), her summary rewritten without him, his wakes and watches removed (her
  reminders naming him keep their time with the note `(removed)`), DM cursor and handle removed,
  every text file of her home cleaned by a notes session, notes that are his deleted whole, a new
  epoch, then a verification pass. The response adds
  `lives`: `[{ waifuId, removedLines, removedSentences, removedNotes?, removedFiles?, needsReview: [{ where, line,
  private? }], queued? }]`; review lines are also kept in `user/waifus/<id>/life/needs-review.json`.
  A private review line (D14: from her summary or queue, a watch bound to a DM, or naming a DM
  place) is always `[private chat redacted]` in this response; read it with
  `GET …/life/needs-review?includePrivate=1` on the host. A scrub
  whose notes session failed stays queued (`queued: true`) and runs again at her next start or
  daily maintenance. With Discord offline (no cast runtime) the scrubs are queued and run when
  each life next starts; the response then lists those waifus in `livesQueued`. `dryRun` reports
  the DM counts without deleting or scrubbing. Not covered: Discord history itself, what she
  already said in rooms, usage-ledger lines and app logs (ids only), cached guild images, and any
  DM image no image index recorded, until the disk cache expires them (168 hours by default), data
  outside this host, the web page cache (`life.webFetch.cacheMinutes`, 15 minutes by default), and
  files she made from his attachments (a cropped copy), which can't be traced back to him.

- `GET /api/people/forget-jobs` — `{jobs: [{userId, at, pending: [{part, error?, failures, retried}]}]}`:
  owner forgets with parts still to run (or given up).

## Lives

Every route validates `:waifuId` (`assertSafeId`); an unknown waifu is 404.

- `GET /api/waifus/:waifuId/life[?includePrivate=1]` — her status: `runtime` (`running`: Discord connected and her
  life hosted; `busy`; `paused`), `status` (`idle | turn`), `currentTurn`, `epoch`,
  `epochStartedAt`, `logLines`, `lastTurnEndedAt`, `lastCompaction`, `lastMaintenanceAt`,
  `failedTurnAt`, `queue` (`immediate`, `deferred`, `quiet`, the first 50 `wakes`), `today` (`day`,
  `costUsd`, `calls`, `budgetUsd`, `searches`, `fetches`), `summary` (`{text, hidden}`) and
  `counts` (`needsReview`, `pendingScrubs`).
- `GET /api/waifus/:waifuId/life/log?epoch&before&limit&includePrivate` — her life log, newest
  last (`limit` default 50, at most 200; `before` pages back by `seq`; old epochs are kept 7 days,
  404 after). Lines carry `{seq, at, kind, turnId?, role?, blocks, dm, origin?, boundary?}`; blocks
  are `text`, `tool_use` (`id`, `name`, `input`), `tool_result` (`toolUseId`, `isError?`, `text`),
  `image`, `reasoning` (only that it exists) and `other`. `nativeState` is never returned.
- **DM content (D14)** is left out unless `includePrivate=1`. In a DM turn (its wakes include a DM,
  or one of its calls resolved to a DM place) every tool call's input, every result and her own
  text; in any other turn a call that resolved to a DM place and its result; DM notification lines
  from their first quote; DM wake previews and notes; and her summary. The decision uses the places
  the tools resolved, recorded when they ran (`dmCalls`, `dmWakes` on the log line); older lines
  fall back to matching `dm/…` or `dm_…` in any case. A redacted block keeps its type (and a
  call its name) with `redacted: true`; `redactedBlocks` counts them. `includePrivate=1` works only
  for a request on the host itself: over Remote Access, and for the dashboard assistant, it is
  **403** `PrivateContentLocalOnly`.
- `POST /api/waifus/:waifuId/wake` `{note?}` (≤ 500 characters) — an owner wake (skips her budget
  and per-user wake limit) → `{waifuId, outcome: queued | deferred | quiet | dropped | queued_offline, wakeId?}`;
  with Discord offline, or while the cast is stopping for a reload, the wake waits in her queue
  (`queued_offline`).
- `POST /api/waifus/:waifuId/life/compact` — summarise her life now and start a new epoch → `{state:
  "done", epoch, summarized}`, `{state: "aborted"}` when a pause or a shutdown stopped it (nothing
  changed), or **202** `{state: "running"}` after 10 seconds (it finishes on its own). An epoch a
  forget or a deferred reset left pending starts instead, with nothing summarised. **409** without a
  live cast or while it is stopping (`RuntimeOffline`), without a model or before her life started.
- `POST /api/waifus/:waifuId/life/reset` `{confirm: true}` — a fresh epoch with no summary (her
  files, queued wakes and intake cursors stay; the old log is kept 7 days) → `{epoch, deferred}`
  (`deferred`: she has no model now; the epoch starts at her next turn, as a reset). **409** without a
  live cast or while it is stopping (`RuntimeOffline`).
- `GET /api/waifus/:waifuId/life/needs-review[?includePrivate=1]` → `{waifuId, includePrivate,
  items: [{id, at, source, where, line, private?}]}`: lines a forget only listed (a name someone
  else also has). A private line (her summary or queue, a watch bound to a DM, a DM place) reads
  `[private chat redacted]` unless the request is local and says `includePrivate=1` (403
  `PrivateContentLocalOnly` over Remote Access and for the assistant); its `id` is the same either
  way. `DELETE …/needs-review/:itemId` dismisses one → `{waifuId, dismissed}`.

## Her files, reminders and watches

Each waifu has her own folders (spec §16): her home `/home/<slug>` (`~`; on disk
`user/waifus/<id>/home/`: her notes, `MEMORY.md` and `life/` with `wakeups.json`, `profile.json` and
the read-only `places.md` the app keeps; a `life/schedule.json` is an ordinary file since §38) and `/tmp` (`user/waifus/<id>/tmp/`: downloads and scratch files, each
deleted 7 days after it was last written). Paths are her paths, never host paths; links are never
listed, read or written through. Every write passes the same path rules, limits and checks as her
Write tool.

- `GET /api/waifus/:waifuId/files?root=home|tmp&dir=&includePrivate` — one folder (`dir` is below
  the root, or a full `/home/…`, `/tmp/…` or `~/…` path) → `{waifuId, root, dir, display, parent,
  entries: [{name, path?, kind: "file" | "dir", size, modified, private?, redacted?}], redacted,
  usage: {bytes, files, maxBytes, maxFiles?}, includePrivate}`, folders first.
- `GET /api/waifus/:waifuId/files/<path>` — the URL carries her path without its leading slash
  (`…/files/home/aria/people/kevin.md`, `…/files/tmp/bake-club/general/k3-cake.png`, or
  `…/files/~/plans.md`) → `{waifuId, path, display, kind: "text" | "image" | "pdf" | "binary",
  contentType, size, modified, hash, text?, tooLarge?, readOnly?, special?, private?,
  includePrivate}`. `text` is set for a UTF-8 text file up to 1 MiB; `hash` (sha256) is the
  revision. With `?raw=1` it answers the bytes instead: images (PNG, JPEG, GIF, WebP, recognised by
  their first bytes, never by name) inline with their type, anything else as an
  `application/octet-stream` attachment, always with `X-Content-Type-Options: nosniff` and a
  sandboxing `Content-Security-Policy`. A folder is 400 `IsFolder`.
- `PUT /api/waifus/:waifuId/files/<path>` `{text, expectedHash?}` — creates or replaces a text file
  (folders made as needed). `expectedHash` is the `hash` last read (409 `Conflict` when the file
  changed; `null` = it must not exist yet; left out = last writer wins) → `{waifuId, path, display,
  hash, size, created, rewritten}`. Refusals carry her store's own message: `places.md` 400
  `ReadOnlyFile`; a `wakeups.json` or `profile.json` that fails its check 400 `InvalidFile`
  (`watches.json line 7, column 3: expected "," or "]"`, `watches.json entry w3: timeout is in the
  past`; nothing is saved); over 256 KiB or a full home/`/tmp` 413 `HomeLimit`; replacing a binary
  file 400 `NotTextFile`; a name that differs from another only by case 409 `NameCollision`.
  `rewritten`: new reminder or watch entries got their ids. A request from the dashboard assistant
  is refused (403 `AssistantConfirmationRequired`) unless it carries the pending action id of the
  owner's click on its confirmation card.
- `DELETE /api/waifus/:waifuId/files/<path>?expectedHash=` — removes one file (folders are 400) →
  `{waifuId, deleted: true}` (no path: Remote Access keeps mutation answers a day); 404 when it
  does not exist; same assistant rule as `PUT`.
- **DM files (D14)**: a file downloaded from a DM, a copy of one (same content), and anything under
  `/tmp/dm/` is private. A listing keeps the entry with `private: true, redacted: true`, the name
  `[private chat redacted]` and no `path`; reading, writing or deleting it, or listing a folder under
  `/tmp/dm/<handle>/`, needs `includePrivate=1`, which only a request on the host itself may send
  (otherwise **403** `PrivateContentLocalOnly`; always for Remote Access and the assistant).
- `GET /api/waifus/:waifuId/schedule` → `{waifuId, timeZone, entries: [{id, at, repeat?, note}],
  unreadable?}` (`at` local time in the host's zone; `unreadable`: the file does not parse whole).
  `DELETE /api/waifus/:waifuId/schedule/:reminderId` → `{waifuId, removed}` (404 when absent, 409
  when the file does not read cleanly).
- `GET /api/waifus/:waifuId/watches[?includePrivate=1]` → `{waifuId, timeZone, includePrivate,
  entries: [{id, timeout, once, note, when: [{place?, from?, words?, any_message?}], private?}],
  unreadable?}`. A watch bound to a DM (a binding resolved to a DM place, or naming one) is
  `private: true` and its note, places, names and words read `[private chat redacted]` without a
  local reveal. `DELETE /api/waifus/:waifuId/watches/:watchId` → `{waifuId, removed}`.

## Usage, search and the detector

- `GET /api/usage?from&to&groupBy&tz&waifuId&purpose&guildId` — the usage ledger by local day of
  the host's time zone (or `tz`, an IANA zone); default the last 7 days, at most 366. `groupBy` is
  one or two of `day`, `waifu`, `purpose`, `model`, `provider`, `turn`, `place`, `server` →
  `{from, to, timeZone, groupBy, totals, groups: [{key, label?, calls, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, reasoningTokens, costUsd, costKnownCalls, unpricedCalls,
  failedCalls}], skippedLines, groupsCapped?}`. At most 1000 groups: further keys are added up in
  one `(other)` group and `groupsCapped: true` says so. `groupBy=turn` covers at most 31 days
  (400 otherwise). The ledger is streamed line by line, so a long range costs time, not memory.
- `GET /api/search/usage[?includePrivate=1]` — today's web searches and page fetches, the caps,
  whether an Exa key is saved, and the newest queries (`recent`, newest first). A query made in a DM
  turn (`dm: true`, D14) reads `[private chat redacted]` unless the request is local and says
  `includePrivate=1` (403 `PrivateContentLocalOnly` over Remote Access and for the assistant).
- `GET /api/detector/config` → `{target, default}`; `PUT /api/detector/config` `{target}` sets the
  app-wide addressee detector (`""` = none; a server overrides it with `PUT /api/servers/:guildId`
  `{detector}`). `GET /api/detector/history?guildId` — the detector's recent decisions there,
  newest first. `GET /api/detector/models` — its decision models.

## Help

- `GET /api/help` — every settings group, topic and command, and every route of the policy manifest
  with a one-line summary and its help topic.
- `GET /api/help/:topic` — one group (`app`, `waifu`, `server`, `channel`, `assistant`, `bot`,
  `provider`, `remote-access`), part of one (`app.life`), a key (`app.life.maxSendsPerTurn`, or
  `life.maxSendsPerTurn` for app keys), a topic (`life`, `forget`, `usage`, `detector`, `runtime`,
  `environment`) or a command (`cli.wake`): each key with its type, bounds, default, help and CLI
  lines. `?format=md` (or `Accept: text/markdown`) answers Markdown. An unknown topic is **404**
  with `details.suggestions`. `waifus help <topic>` prints the same help offline.

## Conflict Semantics

Editable JSON records include:

```json
{
  "schemaVersion": 2,
  "revision": 0,
  "updatedAt": "2026-05-15T00:00:00.000Z"
}
```

Overwriting or destructive requests should send the last seen `revision`. If the record changed, the backend returns:

```json
{
  "error": "Conflict",
  "message": "Record has changed since it was read.",
  "latest": {
    "schemaVersion": 2,
    "revision": 1,
    "updatedAt": "2026-05-15T00:01:00.000Z"
  }
}
```

`latest` never contains resource-specific fields. In particular, stale credential or Discord-bot
writes cannot return stored API keys or bot tokens.

A write that changes nothing (the same content apart from `revision` and `updatedAt`) is not
stored: the response carries the unchanged record and its current `revision`.

## Discord Text Contract

Model context must not expose raw Discord IDs.

- Incoming `<@623587468920134>` and `<@!623587468920134>` become `<@DisplayName>`.
- Incoming `<:cutecat:327469812364>` becomes `<:cutecat:>`.
- Incoming `<a:dance:327469812364>` becomes `<a:dance:>`.
- Model output is resolved back to Discord syntax only when the cached member or emoji match is safe.
- Ambiguous user mentions are left unpinged and returned with warnings.
- `allowed_mentions` is restricted to explicitly resolved user IDs. Role, everyone, and here mentions are not enabled by default.
