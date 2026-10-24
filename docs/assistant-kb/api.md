# REST API

The complete local HTTP surface (default `http://127.0.0.1:3888`). Everything the dashboard
does goes through these endpoints, so any agent can drive the app with plain HTTP.

## Conventions

- All user-owned resources are revisioned and reads return a `revision`. Waifu and memory
  writes (`PUT`/`DELETE /api/waifus/:id`, `PUT`/`DELETE /api/memories/:id`) REQUIRE the expected
  `revision` in the body (or an `If-Match` header): **428** without it. Every other write accepts
  it optionally and is last-writer-wins when it is omitted. A sent revision that does not match
  returns **409** — re-read, merge, retry. The conflict `latest` object contains only
  `schemaVersion`, `revision`, and `updatedAt`, never the current resource body. Memory writes
  prefer the per-record `recordRevision` (each memory's own `revision`) over the store-wide
  `revision`; their 409 additionally carries the current `record`.
- Validation failures return **400** with a message (zod field errors, or
  `unsupported_parameter` naming a violated gateway rule).
- `:guildId`/`:channelId` (and `guildId`/`channelId` in runtime stop/trigger bodies) must be
  Discord snowflakes (17–20 digits); other ids reject dot-only values such as `.`/`..`.
- Model params are gateway-native dotted keys inside `params`
  (e.g. `{"temperature": 0.9, "reasoning.enabled": false}`).
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
| GET | /api/runtime | Runtime state incl. pause state, queues and `providerAlerts` (`[{providerId, kind: "quota"\|"billing", until, lastMessage}]`, active provider cooldowns during which calls fail fast); host paths/process fields are local-only. |
| GET | /api/admin/operations/:operationId | Principal-scoped mutation recovery status; no response body/result. |
| POST | /api/runtime/pause · /resume | Pause/resume all orchestration (takes effect in memory immediately, then persisted as `runtime.paused` in config.toml so it survives reloads/restarts; if that write fails the response carries a `warning`). |
| POST | /api/runtime/reload | Reload configs into the running orchestrator. |
| POST | /api/runtime/stop | Body `{guildId, channelId}` (both required) — abort that channel's run and cancel its wake. |
| POST | /api/runtime/trigger/orchestrator | Body `{guildId, channelId}` — run a decision pass now. Without both ids or a live runtime: `accepted: false`, nothing runs or is recorded. |
| POST | /api/runtime/trigger/stage-manager | Body `{guildId, channelId}` — run an observer pass now (same `accepted: false` rule). |
| GET | /api/updates | Sanitized idle-update status/history (closed enums, versions, timestamps). |
| GET | /api/providers | Credential status per provider (redacted hints only). |
| PUT | /api/providers/:id/credentials | Body `{apiKey}` — set a key (write-only). |
| DELETE | /api/providers/:id/credentials | Remove a key. |
| GET | /api/llm/* | Gateway registry: models, capability docs, validation. |
| GET | /api/waifus | All waifus. |
| POST | /api/waifus | Create (body: id, name, persona, providerId, modelId, ...). |
| GET/PUT/DELETE | /api/waifus/:id | Read / update (revisioned) / delete. |
| POST | /api/waifus/:id/link-bot | Body `{applicationId?}` — ensure her discord-bots entry and set `botId` in one call. |
| POST | /api/waifus/:id/digest | Regenerate the persona digest. |
| POST | /api/waifus/:id/assets/pfp · /banner | Upload raw image bytes (png/jpeg/webp/gif, max 8 MB). Stored under `user/waifus/:id/` only — nothing applies it to the Discord bot or shows it yet. |
| GET | /api/servers | Guilds with channels and their waifu lists. |
| GET | /api/servers/:guildId | One guild. |
| PUT | /api/servers/:guildId | Partial server settings: `paused`, `orchestratorMode`, `oneShot`, `stageManagerEnabled`, `contextWindows`, `compaction`, `memoryInjectionLimit`, `tools`, `channels` (wholesale). |
| DELETE | /api/servers/:guildId | Remove the guild config incl. sessions, rosters and the guild's decision history. |
| PUT | /api/servers/:guildId/channels/:channelId | `{enabledWaifuIds?, name?}` — one channel; omitted fields keep their value. |
| DELETE | /api/servers/:guildId/channels/:channelId | Remove one channel entry. |
| GET/POST | /api/servers/:guildId/members·roles·emojis(/refresh) | Guild caches. |
| GET | /api/discord-bots | Bot entries (tokens redacted). |
| PUT | /api/discord-bots | `{orchestrator?, waifus?}` — each entry needs `enabled`; a sent `waifus` array replaces the list, omitted tokens are kept per id. |
| GET/PUT | /api/orchestrator/config | Director model/prompt/params (revisioned). |
| GET | /api/orchestrator/history | Recent decisions, newest first, merged across guilds (or one guild with `?guildId=`). |
| GET | /api/orchestrator/one-shot/models | Native-choice decision catalog and credential/local-setup presence; no secrets or inference. |
| GET/PUT | /api/stage-manager/config | Observer/librarian agent config. |
| GET | /api/stage-manager/history | Observer history. |
| GET/PUT | /api/reviewer/config · GET /api/reviewer/history | Reviewer. |
| GET/PUT | /api/assistant/config | Dashboard assistant (model falls back to orchestrator). |
| GET | /api/assistant/conversations | Conversation list, most recent first. |
| POST | /api/assistant/conversations | New chat conversation → `{conversationId}`. |
| DELETE | /api/assistant/conversations/:id | Delete a conversation. |
| GET/DELETE | /api/assistant/actions/:actionId · POST …/confirm | Pending confirmation card for a destructive assistant action: read, cancel, or confirm. |
| GET | /api/assistant/conversations/:id | Transcript (messages + events). |
| POST | /api/assistant/conversations/:id/messages | `{content}` → runs a turn → `{reply}`. |
| GET | /api/assistant/conversations/:id/stream | SSE: turn/tool events. |
| GET | /api/memories | Query params: waifuId, q, status, limit, and provenance filters guildId (learned in that server), origin=dm, subjectUserId. |
| POST | /api/memories | Add a memory record (optional guildId/channelId provenance and subjects); reports `duplicateOf` without blocking. |
| PUT/DELETE | /api/memories/:memoryId | Edit / remove; body `recordRevision` (preferred) or legacy `revision`. |
| POST | /api/memories/forget-user | `{discordUserId, confirm: true, dryRun?}` — forget one Discord user: deletes memories about them and their queued observations, replaces their stored messages with `(removed)`; returns counts. |
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

- **Revisions**: `PUT/DELETE /api/waifus/:id` REQUIRE `revision` in the body (or If-Match);
  `PUT/DELETE /api/memories/:id` REQUIRE `recordRevision` (the memory's own `revision`, so edits
  to different memories never conflict) or the legacy store `revision`/If-Match — 428 without
  one, 409 on mismatch (with the current `record`). Other writes accept an optional revision;
  omitting it is last-writer-wins.
- **`params` merge**: config `params` MERGE with the stored object on write; send a key with
  value `null` to unset it. A partial params write never wipes the rest.
- **Nested settings merge**: waifu `availability`/`tools`, server `contextWindows`/`tools` and
  agent `promptSections` deep-merge, so `{"tools": {"pickNextWaifu": true}}` changes only that
  flag. Arrays (e.g. `availability.busy`) and server `channels` replace wholesale.
  Waifu `verbosity`, `customInstructions` and `scheduleInPrompt` are plain optional fields: omit
  them and the stored value is kept. A waifu body may still carry `promptLayout`; it is accepted,
  ignored and logged once (the layout editor was removed). A channel PUT that omits a field keeps its current value.
- **Context windows and compaction (servers)**: `contextWindows.{orchestrator,waifu,stageManager}`
  only set how many recent messages a conversation loads when it starts or after downtime. An
  unset key falls back to the agent's or waifu's own `contextWindow`; `null` removes an override
  (older versions stored the defaults 20 / 50 / 80 explicitly; a migration removed those). Whether and
  when a conversation is summarized is `compaction` (`enabled`, `triggerRatio` 0.3-0.95,
  `maxMessages` 20-200, `keepRecent` 5-120, `waitTimeoutMs` 0-30000), which merges key by key over
  the app-level `compaction` config; send `null` for a key to inherit again. `keepRecent` is capped
  at 60% of `maxMessages`.
- **Image fetching (app config `discord.images`)**: one fetcher downloads Discord images for both
  OCR and inline images. `maxBytes` (default 5 MiB, 64 KiB-20 MiB), `fetchTimeoutMs` (default
  5000, 500-30000), `memoryCacheMb` (64), `diskCacheMb` (256), `diskCacheTtlHours` (168). Set them
  with `PUT /api/config {"discord": {"images": {...}}}`; they apply when the Discord runtime next
  starts (restart to be sure). Whatever `maxBytes` allows, an image is only sent inline when it is
  at most 3.75 MiB (3,932,160 bytes, the most that stays under Anthropic's 5 MB per-image limit
  once base64-encoded); a larger one is shown as its OCR text or `[image]`.
- **Deprecated OCR keys**: `ocr.maxImageBytes` and `ocr.timeoutMs` no longer control fetching. A
  value left at its default (8 MiB / 1500 ms) is ignored; a changed value still raises the fetch
  limit to the larger of it and `discord.images` (a deprecation warning is logged). Move such
  values to `discord.images.maxBytes` / `fetchTimeoutMs`. `ocr.cacheTtlHours` now defaults to 168
  hours; configs that still said 24 (the old default) were moved to 168 once at upgrade, any other
  value was kept.
- **Memory origin**: memory records carry `origin: {guildId?, channelId?, dm?}` (where learned)
  and `subjects` (who it is about); the old top-level `guildId`/`channelId`/`entities` fields no
  longer exist. `POST /api/memories` still accepts `guildId`/`channelId` and stores them as `origin`.
- **Usage ledger**: every model call (including aborted and failed ones) appends one line to
  `user/usage/YYYY-MM-DD.jsonl` (UTC day) with purpose, ids, provider/model, token counts (zero
  with `usageKnown: false` when the provider reported none), cache read/write tokens, cost when
  known and status `ok | aborted | failed`. One-shot orchestrator decisions are logged with purpose
  `one_shot`. There is no HTTP endpoint for it yet.
- **No channel or server `enabled` flag**: a channel is live exactly when its `enabledWaifuIds` is
  non-empty, and `paused` is the server's kill switch (restart catch-up honours it too). The old
  flags were removed; bodies that still send `enabled` are accepted for one release and ignored.
- **Unlink a bot**: `PUT /api/waifus/:id` with `"botId": null`.
- **Link a bot**: `POST /api/waifus/:id/link-bot {applicationId?}` — one call ensures the
  discord-bots entry, sets the application id, and links the waifu's botId.
- **Memory filters**: `GET /api/memories?waifuId=&q=&status=&limit=` plus provenance
  `guildId=` / `origin=dm` / `subjectUserId=`. Memories are global per waifu: `guildId` only
  says where a memory was learned, it never hides it elsewhere.
- **Deletes**: `DELETE /api/servers/:guildId` (whole guild config incl. sessions),
  `DELETE /api/servers/:guildId/channels/:channelId` (one channel entry, body `{revision?}`),
  `DELETE /api/providers/:id/credentials`, `DELETE /api/assistant/conversations/:id`.
- **Errors**: `{error, message, details?}` where `error` is one of BadRequest, NotFound,
  Conflict, PreconditionRequired, ValidationError, InternalServerError.
- **Caching and secrets**: API responses are `no-store`. Logs, diagnostics, errors, captured model
  traffic, and events are serialized through secret redaction; never expect a credential or token
  to be readable after writing it. The only caching exception is a non-HTML asset under the exact
  hash-addressed remote-dashboard build route; it is never a general filesystem endpoint.
- **Runtime stop**: `POST /api/runtime/stop` body `{guildId, channelId}` (both required)
  aborts that channel's in-flight run and cancels its scheduled wake. Response
  `{stoppedRun, clearedRetrigger, activeInAnotherChannel, message}`. Use it to kill a
  runaway cast burst without pausing the whole runtime.
- **Per-server pause**: `ServerConfig.paused` (PUT `/api/servers/:guildId` with
  `{paused: true|false}`). Paused servers still observe messages (sessions stay warm)
  but run no replies, wakes, stage-manager passes, or dreams. Distinct from the global
  `POST /api/runtime/pause` and from a channel's `enabledWaifuIds` list.
- **History filters**: the three history GETs (`/api/orchestrator/history`,
  `/api/stage-manager/history`, `/api/reviewer/history`) accept
  `?guildId=&channelId=&limit=` (limit 1–200). Entries without a guild/channel (written by
  older builds for untargeted manual triggers) never match an explicit filter.
- **Conversations list**: `GET /api/assistant/conversations` returns
  `{conversations: [{id, createdAt, messageCount, preview?}]}`, most recently used first.
  Conversations are in-memory only and evicted LRU past 20.
- **Remote revoke**: always re-read `/api/remote-access/devices` and send that device's current
  `revision`. The host durably rejects the old device epoch before acknowledging, drains the
  accepted response, closes only that device's streams, clears its conversations/actions, and
  reconciles the helper in the background.
