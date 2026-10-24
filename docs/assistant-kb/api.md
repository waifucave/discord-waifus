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

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | Liveness. |
| GET | /api/status | Runtime + Discord connection state. |
| GET | /api/runtime | Runtime state incl. pause state, queues, `providerAlerts` (`[{providerId, kind: "quota"\|"billing", until, lastMessage}]`, active provider cooldowns during which calls fail fast) and `models.warnings` (`[{scope, label, code, detail, previous?, dismissible}]`: `model_unmapped`, `effort_dropped`, `model_unavailable`, `model_unpriced`); host paths/process fields are local-only. |
| DELETE | /api/runtime/model-warnings/:scope | Dismiss the persisted model notices of `waifu:<id>` or `assistant` → `{scope, dismissed}`. Live notices stay while their cause holds. |
| GET | /api/admin/operations/:operationId | Principal-scoped mutation recovery status; no response body/result. |
| POST | /api/runtime/pause · /resume | Pause/resume the cast (takes effect in memory immediately, then persisted as `runtime.paused` in config.toml so it survives reloads/restarts; if that write fails the response carries a `warning`). |
| POST | /api/runtime/reload | Reload configs into the running runtime. |
| GET | /api/updates | Sanitized idle-update status/history (closed enums, versions, timestamps). |
| GET | /api/providers | `{catalogVersion, providers}`: credential status (redacted hints only) for the providers serving curated routes, the detector's providers, and any provider with a stored key. |
| PUT | /api/providers/:id/credentials | Body `{apiKey}` — set a key (write-only). |
| DELETE | /api/providers/:id/credentials | Remove a key. |
| GET | /api/models | The curated model list: `{catalogVersion, maxOutputUsdPerMTok, models: [{id, providerId, modelId, displayName, providerDisplayName, efforts, defaultEffort?, pricing?, contributor, imageInput, credentialsConfigured, ...}], hidden: [{id, reason}]}`. |
| GET | /api/detector/models | Native-choice decision model catalog for the addressee detector, with credential/local-setup presence; no secrets or inference. |
| GET | /api/waifus | All waifus. |
| POST | /api/waifus | Create (body: id, name, persona, model?, ...). |
| GET/PUT/DELETE | /api/waifus/:id | Read / update (revisioned) / delete. |
| POST | /api/waifus/:id/link-bot | Body `{applicationId?}` — ensure her discord-bots entry and set `botId` in one call. |
| POST | /api/waifus/:id/assets/pfp · /banner | Upload raw image bytes (png/jpeg/webp/gif, max 8 MB). Stored under `user/waifus/:id/` only — nothing applies it to the Discord bot or shows it yet. |
| GET | /api/servers | Guilds with channels and their waifu lists. |
| GET | /api/servers/:guildId | One guild. |
| PUT | /api/servers/:guildId | Partial server settings: `paused`, `channels` (wholesale) and `detector` (`{target}` override of the addressee detector; `""` = off here, `null` = inherit). The director-era fields were removed by a migration and are ignored if sent. |
| DELETE | /api/servers/:guildId | Remove the guild config incl. rosters. |
| PUT | /api/servers/:guildId/channels/:channelId | `{enabledWaifuIds?, name?, threads?}` — one channel; omitted fields keep their value. `threads` is `"inherit"` (default: threads and forum posts under it share its cast) or `"off"`. |
| GET | /api/servers/:guildId/threads | The threads and forum posts the bot has seen (`threadId`, `parentId`, `name`, `kind`, `archived`, `locked`, `lastActivityAt`); guild id must be a snowflake. |
| DELETE | /api/servers/:guildId/channels/:channelId | Remove one channel entry. |
| GET/POST | /api/servers/:guildId/members·roles·emojis(/refresh) | Guild caches. |
| GET | /api/discord-bots | Bot entries (tokens redacted). |
| PUT | /api/discord-bots | `{orchestrator?, waifus?}` — each entry needs `enabled`; a sent `waifus` array replaces the list, omitted tokens are kept per id. |
| GET/PUT | /api/assistant/config | The assistant's own `model` (unset: a waifu's model that is offered, has a key and is not a contributor variant; none → the assistant does not run). |
| GET | /api/assistant/conversations | Conversation list, most recent first. |
| POST | /api/assistant/conversations | New chat conversation → `{conversationId}`. |
| DELETE | /api/assistant/conversations/:id | Delete a conversation. |
| GET/DELETE | /api/assistant/actions/:actionId · POST …/confirm | Pending confirmation card for a destructive assistant action: read, cancel, or confirm. |
| GET | /api/assistant/conversations/:id | Transcript (messages + events). |
| POST | /api/assistant/conversations/:id/messages | `{content}` → runs a turn → `{reply}`. |
| GET | /api/assistant/conversations/:id/stream | SSE: turn/tool events and live `text_delta` fragments of the reply (never stored). |
| POST | /api/people/:userId/forget | `{confirm: true, dryRun?}` — the owner's forget of one Discord user. Today it deletes every DM with them (`user/dms/<userId>/` incl. rate-limit counters, conversations, cached DM images) and returns counts (`dmContexts`, `dmStates`, `dmLimits`, `cachedImages`). Audited `people.forget`. |
| GET | /api/dms | DM conversations, newest first: `?waifuId&userId&limit≤200` → `{conversations: [{conversationKey, waifuId, userId, userDisplayName?, lastInboundAt?, lastReplyAt?, rateLimit: {used, max, windowMinutes, limited, freesAt?} \| null, lastRun?}]}`. Never message text. |
| GET | /api/dms/:waifuId/:userId | `{state, rateLimit}`: DM state (the `living-cast-dm-state-v1` migration dropped the old `recentRuns` and `pending*` fields). 404 when there is no DM. |
| POST | /api/dms/:waifuId/:userId/forget | `{confirm: true, scope: "conversation" \| "all", dryRun?}` → `{dryRun, scope, deleted: {dmContexts, dmStates, recentRuns, cachedImages}}`. Never resets the rate limit. Audited `dm.forget`. |
| GET | /api/logs?limit=N | Recent backend log entries (max 500). |
| GET | /api/docs · /api/docs/:slug | This knowledge base. |
| GET | /api/events | SSE firehose: logs, runtime, captured model queries/replies. |
| GET | /api/config · PUT /api/config | App settings (`runtime.autoConnectDiscord`, ports, updates...). |
| GET | /api/client-context | Dashboard-only browser-session bootstrap; never call from assistant tools. |
| GET | /api/diagnostics/bundle | One-shot diagnostic snapshot. |
| POST | /api/cache/ocr/clear | Clear the OCR cache. |
| GET/PUT | /api/remote-access | Remote-access status and revisioned settings. |
| POST · GET/DELETE | /api/remote-access/activation(/:activationOperationId) | Start, poll, or cancel installation activation. |
| POST | /api/remote-access/reconnect | Reconnect the direct-only remote runtime. |
| GET | /api/remote-access/diagnostics | Sanitized helper/control/direct-network diagnostics. |
| POST/DELETE | /api/remote-access/invitations(/:invitationId) | Create or cancel an attended pairing invitation. |
| GET | /api/remote-access/pairing-requests | Pending attended pairing requests. |
| POST | /api/remote-access/pairing-requests/:requestId/approve·reject | Decide a pending request; approval uses the secure comparison surface. |
| GET | /api/remote-access/devices | Trusted devices with current revision and direct state. |
| PUT | /api/remote-access/devices/:deviceId | Rename with `{revision,displayName}`. |
| DELETE | /api/remote-access/devices/:deviceId | Revoke with `{revision}` through a confirmed browser action. |
| GET | /api/remote-access/dashboard-manifest | Canonical pinned host dashboard manifest (transport use). |
| GET | /api/remote-access/dashboard-assets/:buildId/* | One allowlisted immutable host dashboard asset (transport use). |

## Read-modify-write example

```bash
CUR=$(curl -s http://127.0.0.1:3888/api/waifus/riko)
REV=$(echo "$CUR" | jq .revision)
curl -s -X PUT http://127.0.0.1:3888/api/waifus/riko \
  -H 'content-type: application/json' \
  -d "{\"revision\": $REV, \"displayName\": \"Riko!\"}"
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
- **Living cast settings**: `discord.debounce` (`dmMs` 30 s quiet timer, `dmMaxWaitMs` 180 s cap
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
  `compaction`, `assistant` (older lines keep their retired purposes). There is no HTTP endpoint
  for it yet.
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
