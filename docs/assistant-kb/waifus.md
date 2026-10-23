# Waifus

Everything configurable on a character: persona, style, model, params, schedule, tools.

## Core fields

- `id` — stable identifier (kebab-case), used in URLs and channel enablement lists.
- `name` / `displayName` — how she's shown; the guild nickname can differ per server.
- `persona` — the character definition, free text. This is the soul of the waifu: voice,
  history, relationships, quirks. Keep register/length rules OUT of the persona — message
  length and chat format are enforced by the harness and are not prompt-addressable.
- `enabled` — master switch.
- `providerId` / `modelId` — her model. `params` — dotted gateway params (temperature etc.).
- `contextWindow` — how many recent channel messages she sees (default 50, max 200).
- `botId` — which Discord bot entry (Settings → App → Discord bots) she speaks through.
- `availability` — optional sleep window and busy blocks; the orchestrator treats these as
  soft signals, not hard rules.
- `tools.toolUse` — whether she can call tools (memory notes, pick-next-waifu). Shown in the
  dashboard as "Can save memories while chatting".
- `verbosity` — `terse` (default; one short line), `chatty` (one to three lines) or `expressive`
  (up to a short paragraph). One setting drives the prompt wording, the length validator and the
  message splitter, so use this instead of writing length rules into the persona.
- `customInstructions` — optional free text (max 4000 characters, default empty) appended to her
  prompt after the persona, for extra behaviour rules that don't belong in the character sketch.
- `scheduleInPrompt` — boolean, default true. When false, her schedule (what she is doing right
  now) is left out of the prompt. Shown in the dashboard as "Mention her schedule in the prompt".

## Persona digest

A compressed two-sentence summary (voice + drives) generated automatically from the persona by
the stage-manager model whenever the persona changes (hash-checked). It anchors her voice at
the end of every prompt. Regenerate manually with `POST /api/waifus/:id/digest`.

## Customizing the prompt

The prompt layout editor was removed: the prompt structure is fixed. Customize a waifu through the
persona, `verbosity` and `customInstructions` (plus `scheduleInPrompt`). Existing waifus were
migrated: a disabled schedule block became `scheduleInPrompt: false`, and any other layout choice
was dropped. API clients may still send `promptLayout` for one release; it is ignored.

## Creating a good waifu

Write the persona as a character sketch: who she is, how she talks, what she cares about, her
relationships to the room. Concrete beats abstract ("burns toast, blames the toaster") — the
memory system will grow the rest from live chat. Give each waifu a distinct social role so the
orchestrator has real casting choices.
