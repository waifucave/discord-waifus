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

Settings → App, "Discord bots" section (or `PUT /api/discord-bots`): the orchestrator entry plus
a `waifus` array of entries — each `{id, displayName, applicationId, token, enabled}`. Then link
each waifu to her bot by setting the waifu's `botId` to the bot entry's `id` (or use
`POST /api/waifus/:id/link-bot`, below).

Guild data (members, roles, emojis) syncs automatically once connected; refresh manually via
`POST /api/servers/:guildId/members/refresh` (same for roles/emojis). The dashboard has no
button for this; it is API-only.

## Enabling channels

Rooms → pick the server → per channel, toggle the waifus that may speak there
(`PUT /api/servers/:guildId/channels/:channelId` with `enabledWaifuIds`; both ids must be
Discord snowflakes). A channel is active exactly when its `enabledWaifuIds` list is non-empty,
and a waifu missing from that list never speaks there, whatever the orchestrator wants. The
channel's `enabled` flag is stored (the dashboard mirrors it from the list) but the runtime does
not read it, so setting `enabled: false` with waifus still listed does not silence the channel —
empty the list instead (or pause the server with `PUT /api/servers/:guildId {"paused": true}`).

## Threads and forum posts

A thread (or forum post) under a channel that has waifus enabled inherits that channel's cast and
has its own conversation. Set the parent channel's `threads` to `"off"` (same PUT as above) to keep
waifus out of its threads, or give a thread its own `enabledWaifuIds` to override the parent. An
archived or locked thread stays silent until it is unarchived; a restart only resumes threads that
were active in the last 24 hours. The bot needs "Send Messages in Threads" (and View Channel on the
parent) to reply in a thread; the dashboard shows a permission warning naming it when it is
missing. `GET /api/servers/:guildId/threads` lists the threads the bot has seen.

## Connection

The app connects on start when `runtime.autoConnectDiscord` is on (default `true`). There is no
dashboard toggle for it yet: set it in `config.toml` under `[runtime]` or with
`PUT /api/config {"runtime": {"autoConnectDiscord": false}}`. Check
`GET /api/status` → `discord.connected` / `orchestratorConnected` / `waifuBotCount`; warnings
list bots that failed (bad token, missing intents).

## Wiring a character's bot (canonical flow)

1. `link_waifu_bot(waifuId, applicationId)` — creates/updates the discord-bots entry with
   id = waifuId, stores the application id, and sets the waifu's `botId`. One call, all links.
2. `request_secret(purpose: bot_token, botId: waifuId)` — the user pastes the token into a
   secure form; it never enters the conversation. A `[secure-form]` receipt confirms it.
3. `runtime_reload` — connects the new bot.

Application IDs are not secret. Only the token goes through the secure form.
`update_discord_bots` merges entries BY ID: bots you do not mention are untouched, and stored
tokens are preserved when omitted from an entry you do mention.
