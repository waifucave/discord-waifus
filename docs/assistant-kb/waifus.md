# Waifus

Everything configurable on a character: persona, style, model, schedule, DMs.

## Core fields

- `id` — stable identifier (kebab-case), used in URLs and channel enablement lists.
- `name` / `displayName` — how she's shown; the guild nickname can differ per server.
- `persona` — the character definition, free text. This is the soul of the waifu: voice,
  history, relationships, quirks. Keep register/length rules OUT of the persona — message
  length and chat format are enforced by the harness and are not prompt-addressable.
- `enabled` — master switch.
- `model` — `{providerId, modelId, effort?}`, a route from the curated list (`GET /api/models`);
  `effort` must be one the route lists. `null` unsets it.
- `botId` — which Discord bot entry (Settings → App → Discord bots) she posts with (without one she cannot post).
- `username`, `bio`, `nicknames` — her own bot's Discord profile (see "Discord profile" below).
- `availability` — optional sleep window and busy blocks.
- `verbosity` — `terse` (default; one short line), `chatty` (one to three lines) or `expressive`
  (up to a short paragraph). One setting drives the prompt wording, the length validator and the
  message splitter, so use this instead of writing length rules into the persona.
- `customInstructions` — optional free text (max 4000 characters, default empty) appended to her
  prompt after the persona, for extra behaviour rules that don't belong in the character sketch.
- `scheduleInPrompt` — boolean, default true. When false, her schedule (what she is doing right
  now) is left out of the prompt. Shown in the dashboard as "Mention her schedule in the prompt".
- `dm` — private chats with her own bot (see discord-setup.md "Direct messages"):
  `allowDms` (default false), `rateLimit` (`{maxReplies, windowMinutes}`, default 30 per 60, `null`
  = unlimited, counted per Discord user), `notifyWhenLimited` (default true) and `limitNotice` (max
  300 characters, "" = the built-in notice).

## Discord profile

The app sets her own bot's profile from her config, through her bot (never the House bot, never a
bot two waifus share, never a waifu without her own connected bot): when the bot connects and after
every change to these fields, her images or her bot link.

- `username` — her bot's Discord username: 2–32 characters (trimmed), no `@`, `#`, `:` or
  ` ``` `, and not containing "discord" or "clyde". Unset: her `displayName`, then her `name`
  (whichever Discord accepts). It is only her account name: her `name` stays what she is called in
  prompts, wake on name and the detector. Discord allows about two username changes an hour.
- `bio` — her About Me: synced to the bot application's description (at most 400 characters; some
  Discord views show only the first ~190). Unset: the description is left alone.
- `nicknames` — `{ "<guildId>": "<nickname>" }` (1–32 characters each), replaced whole on write.
  Needs the Change Nickname permission in that server (else a warning); removing an entry clears the
  nickname the app set there.
- Avatar and banner: `POST /api/waifus/:id/assets/pfp|banner` with the raw image bytes and their
  `content-type` (PNG, JPEG, WebP or GIF, at most 8 MB; the bytes must be that type). An unchanged
  image is never uploaded again. Without an uploaded one, the avatar or banner her bot already has
  on Discord is downloaded once and kept as hers (not uploaded back); uploading replaces it.

She can change her own `username`, `bio` and `nicknames` too: they are also her file
`~/profile.json` (see life.md); her edit becomes these fields, and changing them here rewrites it.

`null` unsets each field. Only fields that differ from what her bot shows are sent. A rate limit is
recorded with its retry time and retried by the app; nothing is sent again before then.
`GET /api/waifus/:id/discord-profile` shows `state` (`synced`, `pending`, `rate_limited`, `error`,
`offline`, `no_bot`, `bot_missing`, `shared_bot`), `pendingFields`, `retryAfter`,
`lastSyncedAt`, `lastError` and `warnings` (`missing_permission`, `not_in_server`,
`username_fallback_invalid`); `POST /api/waifus/:id/discord-profile/sync` syncs now (rate-limited
fields still wait). The dashboard shows it on her Cast page under "Discord profile".

The gateway-era fields `params`, `contextWindow`, `tools.toolUse` and `personaDigest` were removed
at upgrade; writes that still send them are accepted and ignored.

## How she runs

> **Living cast.** She lives one continuous life: wakes (mentions, replies, her name, DMs, her
> reminders and watches, the addressee detector), reads before answering, may stay quiet, and keeps
> notes in her own folder (her home `/home/<name>`, backed by `user/waifus/<id>/home/`, with
> `MEMORY.md` as the index and her reminders and watches in `schedule.json` and `watches.json`;
> files people send land in her `/tmp`), tidying them nightly. See the life doc. She sleeps in
> her sleep window (wakes are held for a morning summary), stops at her daily budget
> (`life.dailyBudgetUsd`) and can search and read the web.

Images are fetched with the app config `discord.images` limits; only images up to 3.75 MiB are
ever sent inline, larger ones become their OCR text or `[image]`.

## Customizing the prompt

The prompt layout editor was removed: the prompt structure is fixed. Customize a waifu through the
persona, `verbosity` and `customInstructions` (plus `scheduleInPrompt`). Existing waifus were
migrated: a disabled schedule block became `scheduleInPrompt: false`, and any other layout choice
was dropped. API clients may still send `promptLayout` for one release; it is ignored.

## Creating a good waifu

Write the persona as a character sketch: who she is, how she talks, what she cares about, her
relationships to the room. Concrete beats abstract ("burns toast, blames the toaster") — the
rest grows from live chat. Give each waifu a distinct social role so the room has distinct
voices.
