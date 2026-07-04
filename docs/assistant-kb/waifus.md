# Waifus

Everything configurable on a character: persona, model, params, schedule, tools, prompt layout.

## Core fields

- `id` — stable identifier (kebab-case), used in URLs and channel enablement lists.
- `name` / `displayName` — how she's shown; the guild nickname can differ per server.
- `persona` — the character definition, free text. This is the soul of the waifu: voice,
  history, relationships, quirks. Keep register/length rules OUT of the persona — message
  length and chat format are enforced by the harness and are not prompt-addressable.
- `enabled` — master switch.
- `providerId` / `modelId` — her model. `params` — dotted gateway params (temperature etc.).
- `contextWindow` — how many recent channel messages she sees (default 50, max 100).
- `botId` — which Discord bot entry (from Settings → Discord bots) she speaks through.
- `availability` — optional sleep window and busy blocks; the orchestrator treats these as
  soft signals, not hard rules.
- `tools.toolUse` — whether she can call tools (memory notes, pick-next-waifu).

## Persona digest

A compressed two-sentence summary (voice + drives) generated automatically from the persona by
the stage-manager model whenever the persona changes (hash-checked). It anchors her voice at
the end of every prompt. Regenerate manually with `POST /api/waifus/:id/digest`.

## Prompt layout

Advanced: each waifu has an editable prompt layout with three slots — top (system prompt),
mid (injected ten messages before the end of chat context: room info + relevant memories), and
trailing (a compact anchor + per-turn director note). Blocks can be reordered, disabled, or
grouped. Defaults are sensible; change them only with a reason.

## Creating a good waifu

Write the persona as a character sketch: who she is, how she talks, what she cares about, her
relationships to the room. Concrete beats abstract ("burns toast, blames the toaster") — the
memory system will grow the rest from live chat. Give each waifu a distinct social role so the
orchestrator has real casting choices.
