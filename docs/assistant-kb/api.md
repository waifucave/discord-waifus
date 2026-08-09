# REST API

The complete local HTTP surface (default `http://127.0.0.1:3888`). Everything the dashboard
does goes through these endpoints, so any agent can drive the app with plain HTTP.

## Conventions

- All user-owned resources are revisioned. Reads return a `revision`; writes must send the
  expected `revision` in the body (or an `If-Match` header). A mismatch returns **409** —
  re-read, merge, retry. The conflict `latest` object contains only `schemaVersion`, `revision`,
  and `updatedAt`, never the current resource body.
- Validation failures return **400** with a message (zod field errors, or
  `unsupported_parameter` naming a violated gateway rule).
- Model params are gateway-native dotted keys inside `params`
  (e.g. `{"temperature": 0.9, "reasoning.enabled": false}`).
- Assistant tool calls inherit the person or paired device that initiated the conversation. Never
  manufacture principal, device, internal-dispatch, browser-session, or CSRF headers.
- `PUT /api/config` is a partial merge. Omitted fields are preserved; use
  `{"frontend":{"staticDir":null}}` to clear that optional path. Remote callers cannot read or
  write the host bind address or frontend filesystem path.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | Liveness. |
| GET | /api/status | Runtime + Discord connection state. |
| GET | /api/runtime | Runtime state incl. pause state and queues; host paths/process fields are local-only. |
| POST | /api/runtime/pause · /resume | Pause/resume all orchestration. |
| POST | /api/runtime/reload | Reload configs into the running orchestrator. |
| POST | /api/runtime/trigger/orchestrator | Body `{guildId, channelId}` — run a decision pass now. |
| POST | /api/runtime/trigger/stage-manager | Body `{guildId, channelId}` — run an observer pass now. |
| GET | /api/providers | Credential status per provider (redacted hints only). |
| PUT | /api/providers/:id/credentials | Body `{apiKey}` — set a key (write-only). |
| DELETE | /api/providers/:id/credentials | Remove a key. |
| GET | /api/llm/* | Gateway registry: models, capability docs, validation. |
| GET | /api/waifus | All waifus. |
| POST | /api/waifus | Create (body: id, name, persona, providerId, modelId, ...). |
| GET/PUT/DELETE | /api/waifus/:id | Read / update (revisioned) / delete. |
| POST | /api/waifus/:id/digest | Regenerate the persona digest. |
| POST | /api/waifus/:id/assets/pfp · /banner | Upload art. |
| GET | /api/servers | Guilds with channels and enablement. |
| GET | /api/servers/:guildId | One guild. |
| PUT | /api/servers/:guildId/channels/:channelId | `{enabledWaifuIds, ...}` per-channel settings. |
| GET/POST | /api/servers/:guildId/members·roles·emojis(/refresh) | Guild caches. |
| GET | /api/discord-bots | Bot entries (tokens redacted). |
| PUT | /api/discord-bots | Replace orchestrator + waifus bot entries (revisioned). |
| GET/PUT | /api/orchestrator/config | Director model/prompt/params (revisioned). |
| GET | /api/orchestrator/history | Recent decisions, newest first. |
| GET/PUT | /api/stage-manager/config | Observer/librarian agent config. |
| GET | /api/stage-manager/history | Observer history. |
| GET/PUT | /api/reviewer/config · GET /api/reviewer/history | Reviewer. |
| GET/PUT | /api/assistant/config | Dashboard assistant (model falls back to orchestrator). |
| POST | /api/assistant/conversations | New chat conversation → `{conversationId}`. |
| GET | /api/assistant/conversations/:id | Transcript (messages + events). |
| POST | /api/assistant/conversations/:id/messages | `{content}` → runs a turn → `{reply}`. |
| GET | /api/assistant/conversations/:id/stream | SSE: turn/tool events. |
| GET | /api/memories | Query params: guildId, waifuId, q. |
| POST | /api/memories | Add a memory record. |
| PUT/DELETE | /api/memories/:memoryId | Edit / remove. |
| GET | /api/logs?limit=N | Recent backend log entries (max 500). |
| GET | /api/docs · /api/docs/:slug | This knowledge base. |
| GET | /api/events | SSE firehose: logs, runtime, captured model queries/replies. |
| GET | /api/config · PUT /api/config | App settings (autoConnectDiscord, ports...). |
| GET | /api/client-context | Dashboard-only browser-session bootstrap; never call from assistant tools. |
| GET | /api/diagnostics/bundle | One-shot diagnostic snapshot. |
| POST | /api/cache/ocr/clear | Clear the OCR cache. |

## Read-modify-write example

```bash
CUR=$(curl -s http://127.0.0.1:3888/api/waifus/riko)
REV=$(echo "$CUR" | jq .revision)
curl -s -X PUT http://127.0.0.1:3888/api/waifus/riko \
  -H 'content-type: application/json' \
  -d "{\"revision\": $REV, \"displayName\": \"Riko!\"}"
```


## Semantics that matter

- **Revisions**: `PUT/DELETE /api/waifus/:id` and `PUT/DELETE /api/memories/:id` REQUIRE
  `revision` in the body (or If-Match) — 428 without it, 409 on mismatch. Other writes accept
  an optional revision; omitting it is last-writer-wins.
- **`params` merge**: config `params` MERGE with the stored object on write; send a key with
  value `null` to unset it. A partial params write never wipes the rest.
- **Unlink a bot**: `PUT /api/waifus/:id` with `"botId": null`.
- **Link a bot**: `POST /api/waifus/:id/link-bot {applicationId?}` — one call ensures the
  discord-bots entry, sets the application id, and links the waifu's botId.
- **Memory filters**: `GET /api/memories?guildId=&waifuId=&q=&status=&limit=`.
- **Deletes**: `DELETE /api/servers/:guildId` (whole guild config incl. sessions),
  `DELETE /api/servers/:guildId/channels/:channelId` (one channel entry, body `{revision?}`),
  `DELETE /api/providers/:id/credentials`, `DELETE /api/assistant/conversations/:id`.
- **Errors**: `{error, message, details?}` where `error` is one of BadRequest, NotFound,
  Conflict, PreconditionRequired, ValidationError, InternalServerError.
- **Caching and secrets**: API responses are `no-store`. Logs, diagnostics, errors, captured model
  traffic, and events are serialized through secret redaction; never expect a credential or token
  to be readable after writing it.
- **Runtime stop**: `POST /api/runtime/stop` body `{guildId, channelId}` (both required)
  aborts that channel's in-flight run and cancels its scheduled wake. Response
  `{stoppedRun, clearedRetrigger, activeInAnotherChannel, message}`. Use it to kill a
  runaway cast burst without pausing the whole runtime.
- **Per-server pause**: `ServerConfig.paused` (PUT `/api/servers/:guildId` with
  `{paused: true|false}`). Paused servers still observe messages (sessions stay warm)
  but run no replies, wakes, stage-manager passes, or dreams. Distinct from the global
  `POST /api/runtime/pause` and from per-channel enable flags.
- **History filters**: the three history GETs (`/api/orchestrator/history`,
  `/api/stage-manager/history`, `/api/reviewer/history`) accept
  `?guildId=&channelId=&limit=` (limit 1–200). Entries recorded without a guild/channel
  (untargeted manual triggers) never match an explicit filter.
- **Conversations list**: `GET /api/assistant/conversations` returns
  `{conversations: [{id, createdAt, messageCount, preview?}]}`, most recently used first.
  Conversations are in-memory only and evicted LRU past 20.
