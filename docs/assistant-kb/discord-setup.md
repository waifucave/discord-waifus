# Discord Setup

Creating the bot applications and wiring them to your server.

## Why several bots

The orchestrator and every waifu each run as their own Discord bot application. That's what
gives each character her own name, avatar, and presence. For a five-waifu cast you create six
applications total (1 orchestrator + 5 waifus).

## Per application (Discord Developer Portal)

1. https://discord.com/developers/applications → New Application (name it for the character).
2. Bot tab → enable **Message Content Intent** (required) and **Server Members Intent**.
3. Reset Token → copy it. Tokens are shown once by Discord and stored write-only here.
4. Copy the **Application ID** as well.
5. Invite: OAuth2 → URL Generator → scope `bot`, permissions: View Channels, Send Messages,
   Read Message History, Add Reactions, Use External Emojis, Manage Messages (orchestrator
   only, for the reviewer's deletes). Open the generated URL and add it to your server.

## In the app

Settings → Discord bots (or `PUT /api/discord-bots`): the orchestrator entry plus a `waifus`
array of entries — each `{id, displayName, applicationId, token, enabled}`. Then link each
waifu to her bot by setting the waifu's `botId` to the bot entry's `id`.

Guild data (members, roles, emojis) syncs automatically once connected; refresh manually via
`POST /api/servers/:guildId/members/refresh` (same for roles/emojis).

## Enabling channels

Rooms → pick the server → per channel, toggle the waifus that may speak there
(`PATCH /api/servers/:guildId/channels/:channelId` with `enabledWaifuIds`). A waifu missing
from a channel's list never speaks there, whatever the orchestrator wants.

## Connection

The app connects on start when `runtime.autoConnectDiscord` is on (Settings → App). Check
`GET /api/status` → `discord.connected` / `orchestratorConnected` / `waifuBotCount`; warnings
list bots that failed (bad token, missing intents).
