# Discord Waifus Backend API

Base URL defaults to `http://127.0.0.1:3888`.

All frontend code should use this HTTP API. It should not read `~/.dc-waifus` or `DC_WAIFUS_HOME` directly.

## Runtime

- `GET /api/health`
- `GET /api/status`
- `GET /api/runtime`
- `POST /api/runtime/pause`
- `POST /api/runtime/resume`
- `POST /api/runtime/reload`
- `POST /api/runtime/trigger/orchestrator`
- `POST /api/runtime/trigger/stage-manager`
- `GET /api/diagnostics/bundle`
- `GET /api/events`

`/api/events` is an SSE endpoint. It emits a runtime snapshot and heartbeat events.

When Discord auto-connect is enabled and an orchestrator token is saved, the backend starts the runtime loop:

1. Discord `messageCreate` events discover guilds/channels and trigger enabled channel sessions.
2. The runtime cancels any active orchestrator/waifu request for that channel when a newer message arrives.
3. It fetches fresh Discord history before each orchestrator, waifu, and stage-manager model request.
4. Orchestrator decisions are validated, written to history, and executed.
5. Waifus answer in selected order using their configured model and bot.
6. `no_reply` decisions schedule bounded retriggers.
7. Stage-manager runs are background tasks and write memory/history through the shared memory lock.

`POST /api/runtime/trigger/orchestrator` and `POST /api/runtime/trigger/stage-manager` accept optional JSON bodies with `guildId` and `channelId` to run the real channel pipeline manually. Without a target channel they only record a manual history entry.

Normal configuration changes apply at runtime. `PUT /api/config`, `PUT /api/discord-bots`, and `POST /api/runtime/reload` rebuild Discord clients and the runtime orchestrator in-process without restarting HTTP. Only HTTP host/port changes require the next process start.

## Config

- `GET /api/config`
- `PUT /api/config`
- `POST /api/cache/ocr/clear`
- `GET /api/discord-bots`
- `PUT /api/discord-bots`
- `GET /api/orchestrator/config`
- `PUT /api/orchestrator/config`
- `GET /api/orchestrator/history`
- `GET /api/stage-manager/config`
- `PUT /api/stage-manager/config`
- `GET /api/stage-manager/history`

Config is backed by `config.toml` under the data root. Default config:

```json
{
  "schemaVersion": 1,
  "http": { "host": "127.0.0.1", "port": 3888 },
  "runtime": { "autoConnectDiscord": true, "paused": false },
  "frontend": {},
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

OCR is used only as a fallback for models that are not marked as vision-capable. `engine = "auto"` tries native OS OCR first where supported, then the platform-specific bundled Tesseract package, then an explicit system Tesseract fallback. Valid engine values are `auto`, `apple-vision`, `bundled-tesseract`, and `system-tesseract`; legacy `tesseract` configs load as `system-tesseract`. Temporary image downloads live under `app/tmp/ocr`; cached text results live under `app/cache/ocr` and expire by `cacheTtlHours`. `POST /api/cache/ocr/clear` removes OCR cache and temporary OCR files.

## Providers And Models

- `GET /api/providers`
- `PUT /api/providers/:providerId/credentials`
- `GET /api/models`

Provider IDs are `xai`, `deepseek`, `anthropic`, `openai`, and `zai`.

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
- `POST /api/waifus/:waifuId/assets/pfp`
- `POST /api/waifus/:waifuId/assets/banner`

`PUT` and `DELETE` require either a `revision` body field or an `If-Match` header. Stale writes return `409 Conflict` with the latest server copy.

Asset uploads accept raw `image/png`, `image/jpeg`, `image/webp`, or `image/gif` request bodies up to 8 MB. Files are stored in `user/waifus/<waifu-id>/`.

## Servers

- `GET /api/servers`
- `PUT /api/servers/:guildId`
- `GET /api/servers/:guildId/members`
- `POST /api/servers/:guildId/members/refresh`
- `GET /api/servers/:guildId/emojis`
- `POST /api/servers/:guildId/emojis/refresh`
- `PUT /api/servers/:guildId/channels/:channelId`

Member and emoji refresh endpoints use the configured orchestrator bot token. Member refresh requires Discord permissions/intents that allow member listing. Emoji refresh caches guild custom emojis in `user/servers/<guild-id>/emojis.json`.

## Memories

- `GET /api/memories`
- `POST /api/memories`
- `PUT /api/memories/:memoryId`
- `DELETE /api/memories/:memoryId`

Memory writes use the memory store revision. Stage-manager and UI memory edits must share this same lock and revision flow.

## Conflict Semantics

Editable JSON records include:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "updatedAt": "2026-05-15T00:00:00.000Z"
}
```

Overwriting or destructive requests should send the last seen `revision`. If the record changed, the backend returns:

```json
{
  "error": "Conflict",
  "message": "Record has changed since it was read.",
  "latest": {}
}
```

## Discord Text Contract

Model context must not expose raw Discord IDs.

- Incoming `<@623587468920134>` and `<@!623587468920134>` become `<@DisplayName>`.
- Incoming `<:cutecat:327469812364>` becomes `<:cutecat:>`.
- Incoming `<a:dance:327469812364>` becomes `<a:dance:>`.
- Model output is resolved back to Discord syntax only when the cached member or emoji match is safe.
- Ambiguous user mentions are left unpinged and returned with warnings.
- `allowed_mentions` is restricted to explicitly resolved user IDs. Role, everyone, and here mentions are not enabled by default.
