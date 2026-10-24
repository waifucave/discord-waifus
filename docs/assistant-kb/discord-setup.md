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

Guild data (members, roles, emojis, channels) is kept current from gateway events once
connected; refresh manually via `POST /api/servers/:guildId/members/refresh` (same for
roles/emojis). The dashboard has no button for this; it is API-only. The member list is also
refreshed every `discord.memberListRefreshHours` (default 24, 0 = never). The privileged
Server Members intent is opt-in: set `discord.guildMembersIntent = true` (PUT `/api/config`) after
enabling it in the Developer Portal, otherwise Discord closes the connection with `invalid_intents`.
Without it, member names are learned from messages and mentions, and `GET /api/runtime` reports
`discord.directory` (`memberListAvailable`, `lastRefreshAt`, `warnings`, e.g.
`member_list_unavailable` when Discord refuses the list).

## Enabling channels

Rooms → pick the server → per channel, toggle the waifus that may speak there
(`PUT /api/servers/:guildId/channels/:channelId` with `enabledWaifuIds`; both ids must be
Discord snowflakes). A channel is active exactly when its `enabledWaifuIds` list is non-empty,
and a waifu missing from that list never speaks there, whatever the orchestrator wants. There is no
separate channel or server `enabled` flag: empty the list to silence a channel, or pause the
server with `PUT /api/servers/:guildId {"paused": true}` (Rooms → the server switch).

## Threads and forum posts

A thread (or forum post) under a channel that has waifus enabled inherits that channel's cast and
has its own conversation. Set the parent channel's `threads` to `"off"` (same PUT as above) to keep
waifus out of its threads, or give a thread its own `enabledWaifuIds` to override the parent. An
archived or locked thread stays silent until it is unarchived; a restart only resumes threads that
were active in the last 24 hours. The bot needs "Send Messages in Threads" (and View Channel on the
parent) to reply in a thread; the dashboard shows a permission warning naming it when it is
missing. `GET /api/servers/:guildId/threads` lists the threads the bot has seen.

## Direct messages (DMs)

A waifu answers DMs sent to her own bot when her `dm.allowDms` is on (default off; `PUT
/api/waifus/:id {"dm": {"allowDms": true}}`). A DM is a 1:1 chat with that waifu only: no
orchestrator, no other waifus, but the same prompt rules, model, memories and compaction as in
servers. Requirements: the waifu is enabled, has a model, and is the ONLY enabled waifu linked to
her bot (a shared bot takes no DMs; `GET /api/runtime` → `discord.dm.warnings` shows
`dm_bot_shared:<botId>`, `dm_missing_model:<waifuId>` or `dm_intent_pending_reconnect:<botId>`).
The DM intents (Direct Messages, DM reactions) are not privileged and need no Developer Portal
toggle. They are fixed at login, so saving a waifu change to `dm.allowDms`, `botId` or `enabled`
re-logs only the bots whose intents changed (about 2 seconds offline); other bots keep `[Guilds]`.
A user must share a server with the bot (or have it installed) to DM it, and the bot can't see a
DM sent before its first message to it while the app was down.

Each user gets at most `dm.rateLimit.maxReplies` replies per `windowMinutes` (default 30 per 60
minutes, `null` = unlimited), per waifu. When the limit is hit she stays silent and, if
`dm.notifyWhenLimited` (default on), sends one fixed notice per limited period
(`dm.limitNotice`, tokens `{name}`, `{user}`, `{retryInMinutes}`; empty = "I need a little break —
talk to you in about {retryInMinutes} minutes!"). She answers again once the window frees up and
the user writes again. Counters survive restarts and a user's `/forget`.

In DMs her bot offers `/forget what:<this conversation|everything about me>`, answered privately
with a 30-second Confirm button. "this conversation" deletes the DM transcript; "everything"
also deletes the DM state and her memories about that user. Neither resets the rate limit.
Server slash commands (`/run`, `/print`, …) exist only in servers.

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
