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
- `botId` — which Discord bot entry (Settings → App → Discord bots) she speaks through.
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

The gateway-era fields `params`, `contextWindow`, `tools.toolUse` and `personaDigest` were removed
at upgrade; writes that still send them are accepted and ignored.

## How she runs

> **Living cast.** She lives one continuous life: wakes (mentions, replies, her name, DMs, her
> reminders and watches, the addressee detector), reads before answering, may stay quiet, keeps
> notes (`user/waifus/<id>/notes/`, `MEMORY.md` as the index) and tidies them nightly. She sleeps in
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
