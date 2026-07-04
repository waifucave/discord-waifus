# REST API

The complete local HTTP surface (default `http://127.0.0.1:3888`). Everything the dashboard
does goes through these endpoints, so any agent can drive the app with plain HTTP.

## Conventions

- All user-owned resources are revisioned. Reads return a `revision`; writes must send the
  expected `revision` in the body (or an `If-Match` header). A mismatch returns **409** —
  re-read, merge, retry.
- Validation failures return **400** with a message (zod field errors, or
  `unsupported_parameter` naming a violated gateway rule).
- Model params are gateway-native dotted keys inside `params`
  (e.g. `{"temperature": 0.9, "reasoning.enabled": false}`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | Liveness. |
| GET | /api/status | Runtime + Discord connection state. |
| GET | /api/runtime | Runtime state incl. data root, pause state, queues. |
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
| PATCH | /api/servers/:guildId/channels/:channelId | `{enabledWaifuIds, ...}` per-channel settings. |
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
| PATCH/DELETE | /api/memories/:memoryId | Edit / remove. |
| GET | /api/logs?limit=N | Recent backend log entries (max 500). |
| GET | /api/docs · /api/docs/:slug | This knowledge base. |
| GET | /api/events | SSE firehose: logs, runtime, captured model queries/replies. |
| GET | /api/config · PUT /api/config | App settings (autoConnectDiscord, ports...). |
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
