# REST API

The complete local HTTP surface (default `http://127.0.0.1:3888`). Everything the dashboard
does goes through these endpoints, so any agent can drive the app with plain HTTP.

## Conventions

- All user-owned resources are revisioned and reads return a `revision`. Waifu writes
  (`PUT`/`DELETE /api/waifus/:id`) REQUIRE the expected `revision` in the body (or an `If-Match`
  header): **428** without it. Every other write accepts it optionally and is last-writer-wins
  when it is omitted. A sent revision that does not match returns **409** — re-read, merge,
  retry. The conflict `latest` object contains only `schemaVersion`, `revision`, and `updatedAt`,
  never the current resource body.
- Validation failures return **400** with a message (zod field errors, or `details.error`
  `model_not_available` / `unsupported_effort` for a model choice, `unknown_provider` for a key).
- `:guildId`/`:channelId`/`:userId` must be Discord snowflakes (17–20 digits); other ids reject
  dot-only values such as `.`/`..`.
- A model is a curated route plus an optional effort: `"model": {"providerId": "anthropic",
  "modelId": "claude-sonnet-5-5", "effort": "high"}` (list them with `GET /api/models`; the effort
  must be one the route lists). `null` unsets it.
- Assistant tool calls inherit the person or paired device that initiated the conversation. Never
  manufacture principal, device, internal-dispatch, browser-session, or CSRF headers.
- Remote unsafe requests require an `Idempotency-Key`: canonical unpadded base64url for exactly 32
  random bytes. Keep the same key for a logical retry. The built-in assistant tool dispatcher does
  this automatically and adds conversation/tool-call provenance to the administrative audit.
- `X-Waifus-Request-ID` identifies a mutation attempt. A `202` response contains only
  `{operationId,status,statusUrl}`; recover through the returned
  `GET /api/admin/operations/:operationId` URL. Never repeat an uncertain non-replayable effect with
  a new key.
- `PUT /api/config` is a partial merge. Omitted fields are preserved; use
  `{"frontend":{"staticDir":null}}` to clear that optional path. Remote callers cannot read or
  write the host bind address or frontend filesystem path.

## Endpoints

Every route with its one-line purpose and the help topic that explains it (`GET /api/help/<topic>`,
`waifus help <topic>`). The table is generated from the route help; details follow below it.

<!-- generated:routes (npm run docs:settings:generate) -->

| Method | Path | Purpose | Help topic |
|---|---|---|---|
| GET | `/api/admin/operations/:operationId` | Outcome of a recorded mutation (recovery read). | `runtime` |
| DELETE | `/api/assistant/actions/:actionId` | Cancel a card. | `assistant` |
| GET | `/api/assistant/actions/:actionId` | A confirmation card the assistant raised. | `assistant` |
| POST | `/api/assistant/actions/:actionId/confirm` | Confirm a card (secure dashboard only). | `assistant` |
| GET | `/api/assistant/config` | The assistant's own model. | `assistant` |
| PUT | `/api/assistant/config` | Set or unset the assistant's model. | `assistant` |
| GET | `/api/assistant/conversations` | Your assistant conversations. | `assistant` |
| POST | `/api/assistant/conversations` | Start an assistant conversation. | `assistant` |
| DELETE | `/api/assistant/conversations/:id` | Delete an assistant conversation. | `assistant` |
| GET | `/api/assistant/conversations/:id` | One assistant conversation. | `assistant` |
| POST | `/api/assistant/conversations/:id/messages` | Send the assistant a message. | `assistant` |
| GET | `/api/assistant/conversations/:id/stream` | The conversation's live events (SSE). | `assistant` |
| POST | `/api/cache/ocr/clear` | Clear the OCR cache. | `app.ocr` |
| GET | `/api/client-context` | Establish the dashboard's browser session (never proxied). | `runtime` |
| GET | `/api/config` | The app settings (config.toml). | `app` |
| PUT | `/api/config` | Change app settings (partial patch). | `app` |
| GET | `/api/detector/config` | The detector's global target. | `detector` |
| PUT | `/api/detector/config` | Set the detector's global target ("" turns it off). | `detector` |
| GET | `/api/detector/history` | A server's last 300 detector results (?guildId). | `detector` |
| GET | `/api/detector/models` | The addressee detector's decision models. | `detector` |
| GET | `/api/diagnostics/bundle` | A sanitized diagnostics bundle. | `runtime` |
| GET | `/api/discord-bots` | The House bot and the waifu bots (tokens redacted). | `bot` |
| PUT | `/api/discord-bots` | Change bot entries (merged by id; stored tokens kept). | `bot` |
| GET | `/api/dms` | DM conversations (state and rate limits; never message text). | `forget` |
| GET | `/api/dms/:waifuId/:userId` | One DM conversation's state. | `forget` |
| POST | `/api/dms/:waifuId/:userId/forget` | Forget one waifu's DMs with one user. | `forget` |
| GET | `/api/docs` | The assistant's knowledge base pages. | `runtime` |
| GET | `/api/docs/:slug` | One knowledge base page. | `runtime` |
| GET | `/api/events` | Live events (SSE): runtime, logs, model calls (life calls as metadata only). | `runtime` |
| GET | `/api/health` | Liveness check. | `runtime` |
| GET | `/api/help` | Help index: settings groups, topics, routes and CLI commands. | `help` |
| GET | `/api/help/:topic` | Help for a group, a key, a topic or a command (?format=md for Markdown). | `help` |
| GET | `/api/logs` | Recent host log lines. | `runtime` |
| GET | `/api/models` | The curated model list with prices, efforts and key status. | `app.models` |
| GET | `/api/owner-notices` | What needs the owner's attention (notices, forget jobs, incomplete migrations). | `runtime` |
| POST | `/api/people/:userId/forget` | Forget a Discord user everywhere ({confirm: true, dryRun?}; 202 with pending parts). | `forget` |
| GET | `/api/people/forget-jobs` | Owner forgets that have not finished, part by part. | `forget` |
| GET | `/api/providers` | Provider key status (hints only, never keys). | `provider` |
| DELETE | `/api/providers/:providerId/credentials` | Remove a provider key. | `provider` |
| PUT | `/api/providers/:providerId/credentials` | Save a provider key (write-only). | `provider` |
| GET | `/api/remote-access` | Remote Access configuration and live direct-connection state. | `remote-access` |
| PUT | `/api/remote-access` | Turn Remote Access on or off, or rename this host. | `remote-access` |
| POST | `/api/remote-access/activation` | Start activating this installation (local browser only). | `remote-access` |
| DELETE | `/api/remote-access/activation/:activationOperationId` | Cancel an activation (local only). | `remote-access` |
| GET | `/api/remote-access/activation/:activationOperationId` | Activation progress (local only). | `remote-access` |
| GET | `/api/remote-access/dashboard-assets/:buildId/*` | One declared asset of the bundled dashboard. | `remote-access` |
| GET | `/api/remote-access/dashboard-manifest` | The bundled dashboard's manifest (for the remote gateway). | `remote-access` |
| GET | `/api/remote-access/devices` | Trusted remote devices. | `remote-access` |
| DELETE | `/api/remote-access/devices/:deviceId` | Revoke a trusted device. | `remote-access` |
| PUT | `/api/remote-access/devices/:deviceId` | Rename a trusted device. | `remote-access` |
| GET | `/api/remote-access/diagnostics` | Sanitized direct-connection diagnostics. | `remote-access` |
| POST | `/api/remote-access/invitations` | Create a pairing invitation (secure dashboard only). | `remote-access` |
| DELETE | `/api/remote-access/invitations/:invitationId` | Cancel a pairing invitation. | `remote-access` |
| GET | `/api/remote-access/pairing-requests` | Pending pairing requests. | `remote-access` |
| POST | `/api/remote-access/pairing-requests/:requestId/approve` | Approve a pairing request after comparing its safety phrase. | `remote-access` |
| POST | `/api/remote-access/pairing-requests/:requestId/reject` | Reject a pairing request. | `remote-access` |
| POST | `/api/remote-access/reconnect` | Rediscover a direct path. | `remote-access` |
| POST | `/api/remote-access/reset` | Reset the Remote Access identity (local only; every device pairs again). | `remote-access` |
| GET | `/api/runtime` | Live runtime status: bots, queues, warnings (owner notices), model notices, provider cooldowns. | `runtime` |
| DELETE | `/api/runtime/model-warnings/:scope` | Dismiss a scope's persisted model notices. | `runtime` |
| POST | `/api/runtime/pause` | Pause every life (queues are kept). | `runtime` |
| POST | `/api/runtime/reload` | Rebuild the Discord runtime without restarting HTTP. | `runtime` |
| POST | `/api/runtime/resume` | Resume; what arrived meanwhile is caught up. | `runtime` |
| GET | `/api/search/usage` | Today's web searches, the caps and the newest queries. | `usage` |
| GET | `/api/servers` | Every server with its channels. | `server` |
| DELETE | `/api/servers/:guildId` | Forget a server's configuration. | `server` |
| GET | `/api/servers/:guildId` | One server. | `server` |
| PUT | `/api/servers/:guildId` | Change a server's settings (name, paused, detector override). | `server` |
| DELETE | `/api/servers/:guildId/channels/:channelId` | Remove a channel entry. | `channel` |
| PUT | `/api/servers/:guildId/channels/:channelId` | Change a channel's cast or thread mode. | `channel` |
| GET | `/api/servers/:guildId/emojis` | A server's cached emojis. | `server` |
| POST | `/api/servers/:guildId/emojis/refresh` | Refresh a server's emojis. | `server` |
| GET | `/api/servers/:guildId/members` | A server's cached members. | `server` |
| POST | `/api/servers/:guildId/members/refresh` | Refresh a server's member list. | `server` |
| GET | `/api/servers/:guildId/roles` | A server's cached roles. | `server` |
| POST | `/api/servers/:guildId/roles/refresh` | Refresh a server's roles. | `server` |
| GET | `/api/servers/:guildId/threads` | Threads and forum posts seen in a server. | `channel` |
| GET | `/api/status` | Short status: running, paused, Discord, queues. | `runtime` |
| GET | `/api/updates` | Idle-update status. | `app.updates` |
| GET | `/api/usage` | Model calls and cost by local day (?from&to&groupBy&tz&waifuId&purpose). | `usage` |
| GET | `/api/waifus` | Every waifu. | `waifu` |
| POST | `/api/waifus` | Create a waifu. | `waifu` |
| DELETE | `/api/waifus/:waifuId` | Delete a waifu (revision required). | `waifu` |
| GET | `/api/waifus/:waifuId` | One waifu's settings. | `waifu` |
| PUT | `/api/waifus/:waifuId` | Change a waifu's settings (partial; revision required). | `waifu` |
| POST | `/api/waifus/:waifuId/assets/banner` | Upload her banner image. | `waifu` |
| POST | `/api/waifus/:waifuId/assets/pfp` | Upload her avatar image. | `waifu` |
| GET | `/api/waifus/:waifuId/files` | List a folder of her home or /tmp (?root=home\|tmp&dir; files from private chats are named only with a local includePrivate=1). | `life` |
| DELETE | `/api/waifus/:waifuId/files/*` | Delete one of her files (?expectedHash). | `life` |
| GET | `/api/waifus/:waifuId/files/*` | One of her files: JSON with the text for a text file, ?raw=1 for the bytes (a DM file needs a local includePrivate=1). | `life` |
| PUT | `/api/waifus/:waifuId/files/*` | Write a text file in her folders ({text, expectedHash?}; her Write tool's checks; places.md refused). | `life` |
| GET | `/api/waifus/:waifuId/life` | Her life: status, current turn, queue, epoch, today's cost (?includePrivate=1 locally). | `life` |
| POST | `/api/waifus/:waifuId/life/compact` | Summarise her life now (between turns). | `life` |
| GET | `/api/waifus/:waifuId/life/log` | Her life log, paged (?epoch&before&limit; DM content only with a local includePrivate=1). | `life` |
| GET | `/api/waifus/:waifuId/life/needs-review` | Forget review lines for the owner. | `forget` |
| DELETE | `/api/waifus/:waifuId/life/needs-review/:itemId` | Dismiss a review line. | `forget` |
| POST | `/api/waifus/:waifuId/life/reset` | Reset her short-term memory: a fresh epoch, no summary ({confirm: true}). | `life` |
| POST | `/api/waifus/:waifuId/link-bot` | Create or link her Discord bot entry. | `bot` |
| GET | `/api/waifus/:waifuId/schedule` | Her reminders (~/schedule.json), parsed. | `life` |
| DELETE | `/api/waifus/:waifuId/schedule/:reminderId` | Remove one reminder from her schedule.json. | `life` |
| POST | `/api/waifus/:waifuId/wake` | Wake her now with an optional note (skips sleep and budget). | `life` |
| GET | `/api/waifus/:waifuId/watches` | Her watches (~/watches.json), parsed; a watch bound to a DM is redacted unless a local includePrivate=1. | `life` |
| DELETE | `/api/waifus/:waifuId/watches/:watchId` | Remove one watch from her watches.json. | `life` |

<!-- /generated:routes -->

## Route details

- `GET /api/runtime`: pause state, queues, `discord.warnings` (the owner notices: channel
  permission failures, Living cast notices, forget parts given up), `providerAlerts`
  (`[{providerId, kind: "quota"|"billing", until, lastMessage}]`, cooldowns during which calls fail
  fast) and `models.warnings` (`[{scope, label, code, detail, previous?, dismissible}]`:
  `model_unmapped`, `effort_dropped`, `model_unavailable`, `model_unpriced`); host paths and process
  fields are local-only. `DELETE /api/runtime/model-warnings/:scope` (`waifu:<id>` or `assistant`)
  dismisses the persisted ones.
- `POST /api/runtime/pause` / `resume`: takes effect in memory at once, then is saved as
  `runtime.paused` (a failed save comes back as `warning`).
- `GET /api/providers`: `{catalogVersion, providers}` with credential status (redacted hints only).
  `PUT /api/providers/:id/credentials` `{apiKey, label?}` sets a key (write-only); `DELETE` removes it.
  The `exa` provider's key is the web-search fallback (search also works keyless).
- `GET /api/models`: `{catalogVersion, maxOutputUsdPerMTok, models: [{id, providerId, modelId,
  displayName, efforts, defaultEffort?, pricing?, contributor, imageInput, credentialsConfigured,
  ...}], hidden: [{id, reason}]}`.
- `PUT /api/servers/:guildId`: `paused`, `channels` (replaced whole) and `detector` (`{target}`
  overrides the addressee detector here; `""` = off here, `null` = inherit).
  `PUT /api/servers/:guildId/channels/:channelId` `{enabledWaifuIds?, name?, threads?}` changes one
  channel; `threads` is `"inherit"` (threads and forum posts share its cast) or `"off"`.
- `PUT /api/discord-bots`: `{orchestrator?, waifus?}` (the House bot is stored under
  `orchestrator`); each entry needs `enabled`; a sent `waifus` array replaces the list, omitted
  tokens are kept per id. `POST /api/waifus/:id/link-bot {applicationId?}` ensures her bot entry and
  links it in one call.
- **A waifu's life** (`life` topic): `GET /api/waifus/:id/life` is her status (awake, asleep or
  busy; idle or mid-turn; epoch, queue, today's cost and budget, last compaction, counts of review
  lines and queued forget scrubs). `GET /api/waifus/:id/life/log?epoch&before&limit` pages her life
  log (newest last; default 50, at most 200; old epochs are kept 7 days). Content from private chats
  (DM notifications; every tool call, result and her own text in a turn that touched a DM; a call
  that touched a DM in any other turn; and her summary) is left out unless the request says `includePrivate=1`, which only a request
  on the host itself may do: over Remote Access, and for the assistant, it is refused with 403
  `PrivateContentLocalOnly`. `POST /api/waifus/:id/wake {note?}` wakes her as the owner (skips sleep
  and budget) → `{outcome: queued | deferred | quiet | dropped | queued_offline}` (Discord offline:
  the wake waits in her queue). `POST …/life/compact` summarises her life now (409 without a live
  cast or without a model; after 10 s it answers 202 `{state: "running"}` and finishes on its own).
  `POST …/life/reset {confirm: true}` starts a fresh epoch with no summary (her files and queued
  wakes stay). `GET …/life/needs-review` lists lines a forget could not remove for sure
  (lines from private chats, her summary or her queue read `[private chat redacted]` unless the
  owner reveals them on the host); `DELETE …/life/needs-review/:itemId` dismisses one.
- **Her files** (`life` topic; spec §16.11): her home `/home/<name>` (`~`: notes, `MEMORY.md`,
  `schedule.json`, `watches.json`, the read-only `places.md`) and `/tmp` (downloads, deleted 7 days
  after the last write). `GET /api/waifus/:id/files?root=home|tmp&dir=` lists one folder →
  `{root, dir, display, parent, entries: [{name, path, kind: file|dir, size, modified, private?,
  redacted?}], redacted, usage: {bytes, files, maxBytes, maxFiles?}, includePrivate}` (folders
  first; links never listed). A file's URL is its path without the leading slash
  (`/api/waifus/aria/files/home/aria/people/kevin.md`, `…/files/tmp/x.png`, or `…/files/~/notes.md`):
  `GET` answers JSON `{path, display, kind: text|image|pdf|binary, contentType, size, modified,
  hash, text?, tooLarge?, readOnly?, special?, private?}` (`text` for a UTF-8 file up to 1 MiB);
  `?raw=1` answers the bytes (images by their magic bytes, inline; anything else as an attachment;
  `nosniff`, sandboxed). `PUT {text, expectedHash?}` writes a text file under her Write tool's checks:
  `places.md` 400 `ReadOnlyFile`, a broken `schedule.json`/`watches.json` 400 `InvalidFile` with
  the line and column (nothing saved), over 256 KiB or a full home 413 `HomeLimit`, a binary file
  400 `NotTextFile`, a name differing only by case 409 `NameCollision`; `expectedHash` is the `hash`
  last read (mismatch 409 `Conflict`; `null` = must not exist yet) → `{path, display, hash, size,
  created, rewritten}` (`rewritten`: new reminder or watch entries got their ids). `DELETE
  …/files/<path>?expectedHash=` → `{deleted: true}`. A file from a private chat (a DM download, a
  copy of one by content, anything under `/tmp/dm/`) is listed as `[private chat redacted]`
  without a path, and reading, writing or deleting it (or listing a folder under `/tmp/dm/`) needs
  a local `includePrivate=1` (else 403 `PrivateContentLocalOnly`). The assistant's writes need its
  confirmation card (403 `AssistantConfirmationRequired` otherwise). `GET /api/waifus/:id/schedule`
  → `{timeZone, entries: [{id, at, repeat?, note}], unreadable?}`; `GET …/watches` → `{timeZone,
  entries: [{id, timeout, once, note, when: [{place?, from?, words?, any_message?}], private?}],
  unreadable?, includePrivate}` (a watch bound to a DM reads `[private chat redacted]` unless a local
  `includePrivate=1`). `DELETE …/schedule/:rid` and `…/watches/:wid` remove one entry by rewriting
  the file (404 when absent, 409 when the file does not read cleanly).
- `POST /api/people/:userId/forget` `{confirm: true, dryRun?}`: the owner's forget of one Discord
  user, best effort: every DM with them (conversations, DM state, cached DM images; rate-limit
  counters reset to their forget floor), a `forgotten.json` record, server member lists, the Living
  cast archive, their entries in the captured traffic, then each waifu's life scrub (summary, wakes,
  reminders, watches, the text files in her home, the files the person sent her, a new epoch,
  verification). Returns counts (`dmContexts`, `dmStates`,
  `dmLimits`, `cachedImages`, `memberLists`, `archive`) and `lives: [{waifuId, removedLines,
  removedSentences, removedNotes?, removedFiles?, needsReview, queued?}]` (Discord offline: `livesQueued`). A part
  that failed makes it 202 with `pending: [{part, error, failures, retried}]`; unfinished parts
  retry at the next start, at most three tries, then an owner notice lists them
  (`GET /api/people/forget-jobs`). Not covered: Discord history, what she already said, ids in
  usage and log lines, cached guild images and any DM image no image index recorded (until the
  168-hour disk cache expires them), the web page cache (`life.webFetch.cacheMinutes`). Audited `people.forget`.
- `GET /api/dms?waifuId&userId&limit` lists DM conversations (never message text);
  `GET /api/dms/:waifuId/:userId` is one DM's state and rate limit;
  `POST /api/dms/:waifuId/:userId/forget {confirm: true, scope: "conversation" | "all", dryRun?}`
  forgets one waifu's DMs with one person (never resets the rate limit).
- `GET /api/usage?from&to&groupBy&tz&waifuId&purpose&guildId`: the usage ledger by local day of the
  host's time zone (or `tz`), last 7 days by default; `groupBy` is one or two of `day`, `waifu`,
  `purpose`, `model`, `provider`, `turn`, `place`, `server` → `{from, to, timeZone, groupBy,
  totals, groups: [{key, calls, tokens…, costUsd, unpricedCalls, failedCalls}], skippedLines}`.
  `GET /api/search/usage` is today's web searches and page fetches with the caps (a query from
  a turn that touched a private chat is hidden).
- `GET/PUT /api/detector/config` `{target}`: the app-wide addressee detector (`""` = none);
  `GET /api/detector/history?guildId` its recent decisions in one server.
- `GET /api/owner-notices`: what needs the owner's attention (the notices, unfinished forget jobs,
  migrations that left unreadable data alone, kept copies of unreadable forget records, queued
  forget scrubs, intake pause and marks); `waifus doctor` and `waifus status` show the same.
- `GET /api/help` lists every settings group, topic, command and route; `GET /api/help/:topic`
  explains one (a group, a key such as `app.life.maxSendsPerTurn`, a topic or a command), as JSON or
  with `?format=md` as Markdown. An unknown topic is 404 with `details.suggestions`.

## Read-modify-write example

```bash
CUR=$(curl -s http://127.0.0.1:3888/api/waifus/juno)
REV=$(echo "$CUR" | jq .revision)
curl -s -X PUT http://127.0.0.1:3888/api/waifus/juno \
  -H 'content-type: application/json' \
  -d "{\"revision\": $REV, \"displayName\": \"Juno!\"}"
```


## Semantics that matter

- **Revisions**: `PUT/DELETE /api/waifus/:id` REQUIRE `revision` in the body (or If-Match) —
  428 without one, 409 on mismatch. Other writes accept an optional revision; omitting it is
  last-writer-wins.
- **Models**: a waifu's or the assistant's `model` is replaced as a whole; omit it to keep the
  stored one, send `null` to unset it. A stored model is only re-validated when the write changes
  it, so a record whose model is no longer offered can still be edited. Changing the model to an
  offered one clears that scope's persisted `models.warnings`; a save that leaves the model as it was,
  or unsets it, never does. Deleting a waifu clears hers, and
  `DELETE /api/runtime/model-warnings/:scope` (`waifu:<id>` or `assistant`) dismisses them. The
  curated list is `config.toml` `[models]` `allowed` (route keys) filtered by the installed winter
  catalog and `maxOutputUsdPerMTok` (default and maximum 10); an OpenRouter route is hidden only when
  its model keeps reasoning state the installed winter cannot replay through OpenRouter (none is,
  with the installed winter). Contributor (training) variants are only ever an
  explicit choice. Gateway-era `params`, `contextWindow` and `tools` fields are ignored on write.
- **Nested settings merge**: waifu `availability`/`dm` deep-merge. Arrays (e.g.
  `availability.busy`) and server `channels` replace wholesale.
  Waifu `verbosity`, `customInstructions` and `scheduleInPrompt` are plain optional fields: omit
  them and the stored value is kept. A waifu body may still carry `promptLayout`; it is accepted,
  ignored and logged once (the layout editor was removed). A channel PUT that omits a field keeps its current value.
- **Image fetching (app config `discord.images`)**: one fetcher downloads Discord images for both
  OCR and inline images. `maxBytes` (default 5 MiB, 64 KiB-20 MiB), `fetchTimeoutMs` (default
  5000, 500-30000), `memoryCacheMb` (64), `diskCacheMb` (256), `diskCacheTtlHours` (168). Set them
  with `PUT /api/config {"discord": {"images": {...}}}`; they apply when the Discord runtime next
  starts (restart to be sure). Whatever `maxBytes` allows, an image is only sent inline when it is
  at most 3.75 MiB (3,932,160 bytes, the most that stays under Anthropic's 5 MB per-image limit
  once base64-encoded); a larger one is shown as its OCR text or `[image]`.
- **Living cast settings**: `discord.debounce` (`dmMs` 15 s quiet timer, `dmMaxWaitMs` 180 s cap
  for DM wakes), `discord.dm.resumeWindowMinutes` (the boot catch-up window), `life.*` (turn,
  context, image, send, wake, watch and maintenance limits; `life.webFetch.*` for page reading),
  `search.*` (web search caps; 0 disables) and `detector.target`. DMs and their rate limit are
  configured per waifu (`dm.*`, waifus.md). `GET /api/runtime` reports `discord.dm`:
  `{eligibleWaifus: [{waifuId, botId, intentActive}], warnings}`.
- **Deprecated OCR keys**: `ocr.maxImageBytes` and `ocr.timeoutMs` no longer control fetching. A
  value left at its default (8 MiB / 1500 ms) is ignored; a changed value still raises the fetch
  limit to the larger of it and `discord.images` (a deprecation warning is logged). Move such
  values to `discord.images.maxBytes` / `fetchTimeoutMs`. `ocr.cacheTtlHours` now defaults to 168
  hours; configs that still said 24 (the old default) were moved to 168 once at upgrade, any other
  value was kept.
- **Usage ledger**: every model call (including aborted and failed ones) appends one line to
  `user/usage/YYYY-MM-DD.jsonl` (UTC day) with purpose, ids, provider/model, token counts (zero
  with `usageKnown: false` when the provider reported none), cache read/write tokens, cost when
  known and status `ok | aborted | failed`. Purposes: `life`, `maintenance`, `detector`,
  `compaction`, `assistant`, `web` (older lines keep their retired purposes). `GET /api/usage`
  and `waifus usage` read it by local day.
- **No channel or server `enabled` flag**: a channel is live exactly when its `enabledWaifuIds` is
  non-empty, and `paused` is the server's kill switch (restart catch-up honours it too). The old
  flags were removed; bodies that still send `enabled` are accepted for one release and ignored.
- **Unlink a bot**: `PUT /api/waifus/:id` with `"botId": null`.
- **Link a bot**: `POST /api/waifus/:id/link-bot {applicationId?}` — one call ensures the
  discord-bots entry, sets the application id, and links the waifu's botId.
- **Deletes**: `DELETE /api/servers/:guildId` (whole guild config),
  `DELETE /api/servers/:guildId/channels/:channelId` (one channel entry, body `{revision?}`),
  `DELETE /api/providers/:id/credentials`, `DELETE /api/assistant/conversations/:id`.
- **Errors**: `{error, message, details?}` where `error` is one of BadRequest, NotFound,
  Conflict, PreconditionRequired, ValidationError, InternalServerError.
- **Caching and secrets**: API responses are `no-store`. Logs, diagnostics, errors, captured model
  traffic, and events are serialized through secret redaction; never expect a credential or token
  to be readable after writing it. The only caching exception is a non-HTML asset under the exact
  hash-addressed remote-dashboard build route; it is never a general filesystem endpoint.
- **Per-server pause**: `ServerConfig.paused` (PUT `/api/servers/:guildId` with
  `{paused: true|false}`). Paused servers still observe messages but nothing replies. Distinct
  from the global `POST /api/runtime/pause` and from a channel's `enabledWaifuIds` list.
- **Conversations list**: `GET /api/assistant/conversations` returns
  `{conversations: [{id, createdAt, messageCount, preview?}]}`, most recently used first.
  Conversations are in-memory only and evicted LRU past 20.
- **Remote revoke**: always re-read `/api/remote-access/devices` and send that device's current
  `revision`. The host durably rejects the old device epoch before acknowledging, drains the
  accepted response, closes only that device's streams, clears its conversations/actions, and
  reconciles the helper in the background.
