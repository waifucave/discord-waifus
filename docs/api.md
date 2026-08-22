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
- `POST /api/runtime/trigger/orchestrator`
- `POST /api/runtime/trigger/stage-manager`
- `GET /api/diagnostics/bundle`
- `GET /api/events`

`/api/events` is an epoch-aware SSE endpoint. A first connection receives a canonical `snapshot`;
live events carry `v1:<128-bit epoch>:<uint64 sequence>` IDs. Reconnects send `Last-Event-ID` and
receive the authorized replay suffix. An epoch mismatch or replay gap emits `snapshot_required`
before a replacement snapshot. Authorization is rechecked for every protected event and heartbeat.

API responses are marked `Cache-Control: no-store`. Credential material, Discord tokens, private
keys, pairing/internal-capability material, and direct endpoint candidates are scrubbed from
errors, logs, diagnostics, captured model traffic, and event serialization. A remote device gets
the same operational status but not the host process ID, bind port, data root, loopback URL,
absolute host paths, or helper IPC path. Local status/runtime responses retain their intended host
details.

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

During startup, HTTP binds before Discord auto-connect completes. `/api/status` and `/api/runtime` set optional `discord.connecting` while Discord login is in progress. If Discord auto-connect fails with a transient DNS or network error, the backend keeps Discord offline and retries automatically. Retry metadata is optional: `retrying`, `retryAttempt`, `nextRetryAt`, `lastError`, and `lastErrorAt`.

## Remote state and clean

Remote identity/trust metadata is partitioned from ordinary user data under
`app/remote-access/` (host role) and `app/remote-gateway/` (remote role). Verified dashboard
bundles live only under `app/cache/remote-dashboard/`; live host/remote helper state lives under
the separate `app/tmp/remote-host/` and `app/tmp/remote-gateway/` trees. Private identity, pair,
node, and discovery keys remain helper-owned in the OS vault and are never stored in these Node
JSON trees.

`waifus clean` refuses before mutation while the host daemon, host remote helper, or remote gateway
is live. Once stopped, clean removes ordinary user/config/cache data and transient role runtime
state while preserving remote enabled/settings state, the opaque installation/activation
references, trust and deny epochs, pair metadata, remembered hosts, operation receipts, and the
administrative audit. `--include-logs` removes ordinary role diagnostics but never the audit.

Full identity reset is deliberately not an alias for clean or per-device revoke/forget. Its path
ownership is data-root-wide: the current local host daemon is the executor, and a separately live
remote gateway/helper must produce `SiblingDaemonRunning` before any mutation. After helper-owned
vault rotation is implemented, the typed flow will be exposed only by local Settings → Remote
Access through `POST /api/remote-access/reset`; it will clear both roles' identity/trust/origin and
dashboard-cache state while retaining operation receipts, audit, and the monotonic reset tombstone.

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
  "schemaVersion": 2,
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

`PUT /api/config` is a partial update: omitted fields retain their stored values, and the merged
configuration is validated before it is saved. Send `{"frontend":{"staticDir":null}}` to clear an
explicit static directory. A remotely authenticated device receives a redacted config and cannot
read or write the host bind address or frontend filesystem path; those settings remain local-only.

OCR is used only as a fallback for models that are not marked as vision-capable. `engine = "auto"` tries native OS OCR first where supported (Apple Vision on macOS), then the bundled WebAssembly Tesseract (`tesseract.js`, shipped with the package and working offline on every platform), then an explicit system Tesseract fallback. Valid engine values are `auto`, `apple-vision`, `bundled-tesseract`, and `system-tesseract`; legacy `tesseract` configs load as `system-tesseract`. Temporary image downloads live under `app/tmp/ocr`; cached text results live under `app/cache/ocr` and expire by `cacheTtlHours`. `POST /api/cache/ocr/clear` removes OCR cache and temporary OCR files.

## Providers And Models

- `GET /api/providers`
- `PUT /api/providers/:providerId/credentials`

`GET /api/providers` returns `{ revision, updatedAt, providers, gatewayProviders }`. `providers` covers every provider id the `@waifucave/gateway` registry knows (14, e.g. `xai`, `deepseek`, `anthropic`, `openai`, `google-ai-studio`, `zai`, `openrouter`, ...) as `{ id, displayName, docsUrl?, credentials }`; `gatewayProviders` is the raw gateway `/v1/providers` listing (adds `baseUrl`, `wire`, `credentialEnv`, `credentialConfigured`).

Model listings live entirely under the gateway mount: `GET /api/llm/v1/models`, `GET /api/llm/v1/models/:provider/:model`, `POST /api/llm/v1/validate` (see `src/frontend/api/llm.ts`). There is no `/api/models` route.

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

`PUT` and `DELETE` require either a `revision` body field or an `If-Match` header. Stale writes
return `409 Conflict` with only the latest revision metadata; callers re-read the resource before
merging and retrying.

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

## Discord Text Contract

Model context must not expose raw Discord IDs.

- Incoming `<@623587468920134>` and `<@!623587468920134>` become `<@DisplayName>`.
- Incoming `<:cutecat:327469812364>` becomes `<:cutecat:>`.
- Incoming `<a:dance:327469812364>` becomes `<a:dance:>`.
- Model output is resolved back to Discord syntax only when the cached member or emoji match is safe.
- Ambiguous user mentions are left unpinged and returned with warnings.
- `allowed_mentions` is restricted to explicitly resolved user IDs. Role, everyone, and here mentions are not enabled by default.
