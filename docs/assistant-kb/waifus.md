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
- `contextWindow` — how many recent channel messages she loads when a conversation starts or
  after downtime (default 50, max 200; a server's `contextWindows.waifu` overrides it). It is only
  that starting window: she keeps seeing everything said since, and long conversations are
  compacted automatically (see "Long conversations").
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
the stage-manager model whenever the persona changes (hash-checked). It feeds the style line of her
system prompt. Regenerate manually with `POST /api/waifus/:id/digest`.

## How her prompt is built

Every reply is one request with exactly ONE system message at the start. Its parts, in order:

1. **System** (stable): the harness rules, who she is and who else is in the cast, her persona,
   a short style line from `verbosity` plus the persona digest, her schedule (unless
   `scheduleInPrompt` is false) and `customInstructions`.
2. **Epoch header** (frozen until the next compaction): the conversation summary, a snapshot of
   her memories, and the place (server and channel, or "Private chat with Kevin"), the people
   present and the server's emoji.
3. **Transcript**: the channel as `[14:02 #k3] Kevin: text` lines (local time, a short message
   ref, the sender), her own earlier messages as plain text, and system notes (`<memory_note>`,
   `<direction>`, `<edit>`, `— 3 hours later —`). It only ever grows: edits and deletes are added
   as notes, never rewritten, which is what keeps the provider's prompt cache valid.
4. **Tail** (per call, never saved): the time now, what she is doing right now, any retry note,
   and the turn instruction. The orchestrator's steering goal for this turn is also in the tail,
   and is kept in the transcript afterwards as a `<direction>` note once she has replied.

Images are frozen at first sight: inline for models that accept images (up to
`memory.maxInlineImagesPerEpoch` per conversation epoch), otherwise as `[image: <ocr text>]` or
`[image]`. A later OCR result never changes what she was already shown.

## Replying to a specific message

She may start a message with `↩#k3 ` (the ref of the message) to reply to it; the app turns that
into a Discord reply. The marker is parsed exactly: case does not matter and a trailing `:` or
`,` is tolerated. An unknown ref is stripped and the message is sent as a plain message, and a
copied header target like `↩you` or `↩Kevin` is stripped too. Without a marker the message is
sent unthreaded, or as a reply to the triggering message when that is not the latest one.

## Long conversations (compaction)

When the transcript passes `compaction.maxMessages` (default 150) or about 70% of the model's
token budget, she summarizes her own conversation with her own model, keeps the newest
`compaction.keepRecent` messages (default 30) verbatim, and starts a new epoch with the summary in
the header. The summary is written from her point of view (people, ongoing threads, promises,
running jokes, how she feels about each person, open questions). The request reuses her cached
prefix, so it costs little. A reply that arrives while she is compacting waits up to
`compaction.waitTimeoutMs` (6 s) and otherwise goes out on a shortened prompt while the compaction
finishes in the background. If compaction fails she keeps replying and tries again after 5 minutes.
Settings: app config `compaction` (`enabled`, `triggerRatio`, `maxMessages`, `keepRecent`,
`waitTimeoutMs`); a server can override any key with `PUT /api/servers/:guildId` `compaction`
(send `null` for a key to inherit again).

## Seeing exactly what she sees

The Discord command `/print` (choose a waifu and "system prompt", "memories" or "personality")
answers privately to whoever ran it. "System prompt" shows the prompt of her last reply in that
channel, captured as sent; before her first reply since the backend started it shows only her
static system prompt. Memories learned in a private chat are counted but never printed. The
dashboard's Activity → Queries shows the raw requests too.

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
