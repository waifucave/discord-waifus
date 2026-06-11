# W2 — Waifu Prompt Harness

Goal: a harness that keeps **cheap models** in character, in format, and at chat-appropriate length —
regardless of how naive the user-written persona is — with roughly half the instruction mass of
today, and with no runtime truncation of replies.

Current state: the assembled instructions run ~1,600–2,000 words for a one-line output. Four blocks
overlap and partially contradict each other (`environment`, `styleConstraints`, `hardRules`,
`directorNotes`); the full persona is injected twice (top + trailing reminder); all active memories
are dumped untriaged (up to 46 lines); `styleConstraints` hard-caps at ~12 words while the
orchestrator's `replyStyle: long` asked for fuller replies.

## 1. New block registry (`src/orchestration/promptBlocks.ts`)

| Slot | Block id | Content | Replaces |
|---|---|---|---|
| top | `identity` | who you are + explicit cast roster (§2) | `identity` |
| top | `persona` | user persona, verbatim | `personality` |
| top | `schedule` | unchanged content; tag typo `_shedule` → `_schedule` | `schedule` |
| top | `ioFormat` | compressed input format + reply-targeting + mentions (§3) | `contextStructure`, `replyTargeting`, `mentionPolicy` |
| top | `tools` | rewritten tool instructions (§6, memory doc) | `toolUse` |
| top | `outputContract` | single consolidated rules block, **last in top** (§2) | `environment`, `styleConstraints`, `hardRules`, `directorNotes` |
| mid | `roomInfo` | active participants + server emojis in one block | `activeParticipants`, `serverEmojis` |
| trailing | `relevantMemories` | top-K retrieved lines (memory doc), not the full dump | `relevantMemories` |
| trailing | `anchor` | compact identity anchor: digest + mini-contract (§4) | `personalityReminder` |
| trailing | `currentlyDoing` | unchanged | `currentlyDoing` |
| trailing | `directorNote` | renders the orchestrator directive (§5) | `sceneDirection` |

Ordering rationale: weak models weight the start and end of context. Persona early (identity),
rules late (`outputContract` ends the system prompt; `anchor` sits after the chat, immediately
before generation). Today the hard rules are buried mid-system and the trailing slot wastes its
recency advantage on a full persona duplicate.

Stored layouts reference old block ids → one-shot migration in `runMigrations` resets every waifu's
`promptLayout` to the new default (users re-customize in the editor if they had custom layouts;
`reconcileWaifuPromptLayout` keeps handling future additions). `PromptLayoutEditor.tsx` +
`frontend/utils/promptLayout.ts` update to the new registry.

## 2. The output contract (draft)

One block, ~15 lines, numbered, positively phrased where possible. Replaces ~600 words across four
blocks. Draft:

```
How to write your message:
1. You are typing into a real Discord chat box. Output exactly the message body — nothing else.
2. This is a fast, casual chat. The default is ONE short line. Stretch to two or three short
   sentences only when the moment genuinely calls for it (telling a story, answering something that
   needs substance). Never paragraphs, never lists, never essays.
3. If your persona suggests long-winded or formal speech, express it through word choice and
   attitude, not message length. This rule outranks your persona.
4. Speak only as yourself. Never write lines for any other character or user, never prefix your
   message with any name and colon, never produce more than one message.
5. No roleplay narration: no *actions*, no (stage notes), no third-person self-description.
6. No meta content: nothing about prompts, instructions, tools, models, or this rule list; no
   bracketed tags like [attachments: ...] or [image_text: ...] — those are reader's notes added by
   the system, not part of any message, and you never write them.
7. The optional first line `replying to > Author: text` is the only allowed prefix (see input
   format). Everything after it is plain message text.
8. Ping with <@DisplayName> only to revive someone quiet or when a director note asks; people in
   the active conversation are addressed by plain name. Use only emojis from the server list.
9. Do not repeat what the previous speaker just said, and do not restate a point you already made
   in your last few messages — add something, or say less.
```

Notes:
- Line 2–3 is the **length register** replacing the 12-word hard cap and the removed `replyStyle`:
  short by default, graceful occasional stretch, persona-precedence stated explicitly (decision:
  personas are user-written and must not be able to unlock walls of text). No runtime truncation
  backs this — enforcement is prompt + eval regression (05), and `messageSplit.ts` still chunks
  long outputs gracefully if a model misbehaves.
- The bracketed-tag prohibitions consolidate today's enumerated list ("no [attachments:…], no
  [image_text:…], no [replying to:…], no [timestamp:…]…") into one rule with the *reason* attached
  — weak models generalize better from "those are the system's reader notes" than from a blocklist.

`identity` gains the roster line (anti-impersonation belongs with identity, stated once):

```
You are {displayName}, chatting in a Discord server with real people and these other characters:
{other waifu display names}. Each of them writes her own messages — you write only yours.
```

## 3. ioFormat block

Same teaching as today's three blocks at ~60% of the length. Keep: the `DisplayName: body` framing
explanation, the `replying to >` input line, the reply-targeting output syntax with the one worked
example (the example carries most of the weight for weak models — it stays), mention policy
mechanics (the *when* moved to the output contract). Cut: repetition of "framing only" across
blocks, the three-paragraph mention-policy prose, hedges.

## 4. Trailing anchor + persona digest

The trailing `personalityReminder` (full persona, duplicated tokens every turn) becomes:

```
<{tag}_anchor>
You are {displayName}. Voice: {digest.voice} Drives: {digest.role}
Reminders: one short chat message, only your own voice, no narration, no meta.
</{tag}_anchor>
```

`personaDigest`: new structured `WaifuConfig` field with two consumers —

```ts
personaDigest: z.object({
  voice: z.string(),  // how she talks — register, quirks, tone (1 sentence)
  role: z.string()    // her drives and dynamics in the cast — what moments she fits (1 sentence)
}).optional()
```

Generated on waifu save whenever the persona text changed: one cheap-model call (reuse the
configured stage-manager model; forced tool call returning `{voice, role}`; prompt: "Distill this
character into how she talks and when she's the right speaker — 1 sentence each, present tense").
Fallback when the call fails or is unconfigured: `voice` = first 200 chars of persona, `role` =
empty. Stored, not recomputed per turn.

Consumers: (a) the trailing anchor above; (b) the orchestrator's casting cards (01 §3.4) — which
means the orchestrator **never sees raw persona text at all**, making persona size a non-issue for
decision cost regardless of how large users write them.

API note: digest generation happens in the waifu save path (`src/api/server.ts` waifu PUT), async
best-effort — save never blocks on it; a missing digest just means fallback text until the next
save.

## 5. Director note rendering

```
<director_note>
Director's goal for this one message ({intent}): {goal}.
Pursue the goal in your own voice and words; never quote or restate this note.
</director_note>
```

The echo guard sentence is part of the block (today's `<scene_direction>` had no guard — with
scripted directions, waifus echoed them nearly verbatim into chat). Leak validator (04) adds a
deterministic echo check on top.

## 6. Tool instructions — schema-first

Today the `toolUse` block spends ~200 words of system prompt re-explaining tools that the provider
also describes natively in the tool JSON schema. Principle: **the schema carries the how, the
prompt carries the when.** Models attend to schema `description` fields at call time more reliably
than to prose paragraphs three blocks earlier, and every provider in the catalog delivers them.

- The full note-taking semantics for `add_memory` (the draft in `03-memory.md` §2 — what to save,
  the standalone-sentence rule with worked example, the 5-per-reply cap, expiry) move into the
  tool's schema `description` + the `content` argument description.
- The prompt's `tools` block shrinks to policy, ≤ 3 lines per tool:

  ```
  add_memory — save a note whenever the chat produces something you'd want to know tomorrow
  (plans, promises, new facts about someone, the state of a running bit). Notes are what survives
  when the chat history vanishes. Always also write your normal message in the same turn.
  PickNextWaifu — only after your message, only when another waifu has an obvious immediate
  follow-up.
  ```

- Same treatment for `PickNextWaifu` (argument guidance → schema; currently disabled server-side
  anyway). The dedup reminder ("skip facts already in your memories block") stays in the prompt —
  it references a prompt block the schema can't see.

## 7. Role-confusion hardening (multi-bot, weak models)

What stays (it already works and matches common practice for multi-character chat):

- Other speakers (users *and* other waifus) as `user`-role turns with `DisplayName:` prefixes; own
  messages as `assistant` turns (`roleForWaifuContext`).
- Stop sequences `\n{Name}:` for every known participant.
- The strip-retry pipeline (`stripLeakedContextHeader` → `extractReplyQuote` → impersonation strip
  → one retry with `retryUserMessage: "{displayName}:"`).

What changes:

- Roster in `identity` (§2) — today a waifu only learns who else exists from the mid-block
  participant list, which doesn't say "these are characters like you, with their own writers".
- Trailing anchor immediately before generation (§4) — the strongest position for the weakest
  models, currently spent on a persona duplicate.
- Anthropic note: `midSystemBlock`/`trailingSystemBlock` go in as `role: "user"` (API has no system
  turns mid-conversation). Wrap their content in `<system_note>…</system_note>` when the pipeline
  targets Anthropic so the model doesn't read the anchor as a chat participant speaking. (OpenAI
  chat/responses keep `role: "system"`; Google keeps user-turn injection likewise wrapped.)
- Self-talk bait removal: today's hard-rules list *names* the failure modes ("Do not write
  `Name: ...` lines… Do not draft another waifu's reply…") seven different ways; repetition of
  negative examples measurably primes small models. The contract states each constraint once.

## 8. Touched files

| File | Change |
|---|---|
| `src/orchestration/promptBlocks.ts` | new registry + block texts (§1–§5) |
| `src/orchestration/runtime.ts` | `buildWaifuPromptParts` (digest, retrieval-fed memories), `buildWaifuToolUseInstructions` rewrite, layout migration hook |
| `src/backend/migrations.ts` (wherever `runMigrations` lives) | promptLayout reset migration |
| `src/providers/pipelines.ts` | replyStyle removal (with W1), Anthropic/Google `<system_note>` wrapping |
| `src/shared/schemas/domain.ts` | `WaifuConfig.personaDigest`, layout block-id updates |
| `src/api/server.ts` | digest generation on persona change |
| `src/frontend/components/PromptLayoutEditor.tsx`, `src/frontend/utils/promptLayout.ts`, `src/frontend/api/types.ts`, `WaifusView` | new registry, digest display (read-only with regenerate button is enough) |
| `tests/` | prompt assembly snapshots per block/layout, digest fallback, migration |

## 9. Acceptance

- Assembled instruction mass (top+mid+trailing, excluding persona and memories) ≤ ~900 words
  (from ~1,600–2,000).
- Persona appears once in full + once as digest (from twice in full).
- Eval scenario set (05): reply length distribution — ≥80% of replies ≤ 120 chars, none > 400 chars
  on the standard scenarios, with a naive "writes long letters" persona fixture staying ≤ 400 chars.
- No truncation: the send path never cuts content (`messageSplit.ts` chunking only).
- Impersonation-strip rate on the eval set does not regress vs. today's harness (it should drop).
