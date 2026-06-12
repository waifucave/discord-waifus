# W2 — Waifu Prompt Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute in a fresh worktree (EnterWorktree) branched from current local HEAD, like W1.

**Goal:** Restructure the waifu prompt harness so the message structure itself teaches the output format — self-only assistant turns with raw content, self-aliases for guild nicknames, a compact block registry with an output contract — targeting graceful behavior down to <200B MoE / ~20B dense models, and fixing the live Aria dropped-replies bug in Task 1.

**Architecture:** Task 1 changes context construction (per-waifu roles, raw self-content) and the strip pipeline (alias-aware) — the structural fix. Task 2 rewrites the prompt block registry + layout migration. Task 3 adds the persona digest end-to-end (schema → generation → anchor + orchestrator casting cards). Task 4 moves tool guidance into tool JSON schemas. Task 5 is the acceptance gate + bookkeeping. Every task lands with `npm run typecheck && npm run test` green.

**Tech Stack:** TypeScript ESM (NodeNext — `.js` import extensions), zod v4, Vitest, React 19 (frontend mirrors types manually). House style: two-space indent, double quotes, semicolons. Tests use real temp data roots (`tests/testUtils.ts`), cleaned in `afterEach`.

**Design doc:** `docs/superpowers/plans/2026-06-11-prompting-overhaul/02-waifu-harness.md` (amended 2026-06-12 — read §0 and §7 first).

**Post-W1/P2 context:** main already has W1 (typed directives, `director_note` block, casting cards with 200-char persona preview) and P2 (gateway mounted at `/api/llm/*`; `../waifucave-gateway` must be BUILT for tests). `src/providers/pipelines.ts` still serves all chat traffic until P3.

---

## Task 1: Self-aliases + per-waifu roles + raw self-content (fixes the live bug)

**Files:**
- Modify: `src/providers/types.ts` (WaifuGenerationRequest)
- Modify: `src/orchestration/context.ts` (`formatWaifuContextBlock` split)
- Modify: `src/providers/pipelines.ts` (`roleForWaifuContext`, the four `contextTo*ForWaifu` builders)
- Modify: `src/discord/normalization.ts` (`stripLeakedContextHeader` + `stripImpersonationLines` alias support)
- Modify: `src/orchestration/runtime.ts` (alias resolution, request field, strip call sites)
- Test: `tests/pipelines.test.ts`, `tests/discord.test.ts` (normalization tests live there — verify with `grep -l stripLeakedContextHeader tests/`), `tests/runtime.test.ts`

### Background for the implementer

Today `roleForWaifuContext(message)` returns `"assistant"` for ANY waifu-authored message, and
every message — including the waifu's own — is rendered `DisplayName: body` by
`formatWaifuContextBlock`. Result: the model sees assistant turns containing several different
speakers' name-prefixed lines and learns to emit prefixes. Separately, a waifu's Discord guild
nickname (e.g. Aria configured as "Aria" but nicknamed "K的小娇妻") is not known to be HER, so her
self-prefixed replies are dropped as impersonation (9 dropped replies observed live in 4.5h).

End state: only HER OWN messages are `assistant` turns and they contain the raw message body (no
prefix, no reply-quote line, no attachment tags). Everyone else — users and other waifus — is a
`user` turn with the existing `Name: body` framing. The strip pipeline recognizes a set of
self-aliases (configured displayName + configured name + guild nickname + any display name seen on
her own context messages) and strips self-prefixes instead of dropping the line.

- [ ] **Step 1: Write failing pipeline tests (append to `tests/pipelines.test.ts`)**

Mirror the file's existing `ContextMessage` fixture style. The builders are module-private — they
are reachable through `__testables`; extend that export in Step 3 with `contextToChatMessagesForWaifu`.

```ts
describe("per-waifu context roles (W2)", () => {
  const messages: ContextMessage[] = [
    { id: "m1", channelId: "c1", authorKind: "user", authorId: "u1", name: "Kevin", displayName: "Kevin", content: "hey everyone", timestamp: "2026-06-12T10:00:00Z", reactions: [] },
    { id: "m2", channelId: "c1", authorKind: "waifu", authorId: "bot-aria", name: "aria", displayName: "K的小娇妻", content: "hi Kevin", timestamp: "2026-06-12T10:00:05Z", reactions: [], replyTo: { messageId: "m1", authorName: "Kevin", contentPreview: "hey everyone" } },
    { id: "m3", channelId: "c1", authorKind: "waifu", authorId: "bot-riko", name: "riko", displayName: "Riko", content: "yo", timestamp: "2026-06-12T10:00:10Z", reactions: [] }
  ];

  it("marks only the self waifu's messages as assistant", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, ["bot-aria"]);
    expect(result.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("renders self messages as raw content without prefix, quote, or tags", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, ["bot-aria"]);
    expect(result[1].content).toBe("hi Kevin");
    expect(result[2].content).toBe("Riko: yo");
  });

  it("treats other waifus as user turns with name framing", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, ["bot-riko"]);
    expect(result.map((m: any) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(result[1].content).toContain("K的小娇妻: hi Kevin");
    expect(result[1].content).toContain("replying to > Kevin");
    expect(result[2].content).toBe("yo");
  });

  it("falls back to user role for waifu messages when no selfAuthorIds given", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, []);
    expect(result.map((m: any) => m.role)).toEqual(["user", "user", "user"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/pipelines.test.ts -t "per-waifu context roles"`
Expected: FAIL (`contextToChatMessagesForWaifu` not exported / wrong arity).

- [ ] **Step 3: Implement context-side changes**

(a) `src/providers/types.ts` — add to `WaifuGenerationRequest`:

```ts
  // Discord author ids that are THIS waifu (bot user id + application id when known).
  // Only these messages become assistant turns; everything else is a user turn.
  selfAuthorIds?: string[];
```

(b) `src/orchestration/context.ts` — add below `formatWaifuContextBlock`:

```ts
// The waifu's own history is rendered as raw message bodies: no name prefix, no reply-quote
// line, no attachment tags. The context itself then demonstrates the output contract —
// "my turns are plain message text" — which holds format on far smaller models than rules do.
export function formatSelfWaifuContent(message: ContextMessage): string {
  return message.content;
}
```

(c) `src/providers/pipelines.ts` — replace `roleForWaifuContext` and update the four builders:

```ts
function roleForWaifuContext(message: ContextMessage, selfAuthorIds: string[]): "assistant" | "user" {
  return message.authorKind === "waifu" && selfAuthorIds.includes(message.authorId)
    ? "assistant"
    : "user";
}
```

In each of `contextToChatMessagesForWaifu`, `contextToResponsesInputForWaifu`,
`contextToAnthropicMessagesForWaifu`, and the Google `contextToGoogleMessagesForWaifu`
(async — read it before editing): add a `selfAuthorIds: string[]` parameter, compute
`const role = roleForWaifuContext(message, selfAuthorIds);` and
`const text = role === "assistant" ? formatSelfWaifuContent(message) : formatWaifuContextBlock(message);`.
Image blocks stay gated on `role === "user"` (unchanged predicate, now self-images are skipped —
intended). Update the four `generateWaifu` bodies to pass `request.selfAuthorIds ?? []`. Add
`contextToChatMessagesForWaifu` to `__testables`. Import `formatSelfWaifuContent` from
`"../orchestration/context.js"`.

- [ ] **Step 4: Run pipeline tests**

Run: `npx vitest run tests/pipelines.test.ts`
Expected: new tests PASS; pre-existing waifu-generation tests may fail if they asserted
assistant-role-for-all-waifus or prefixed self content — update those assertions to the new
behavior (they are testing the OLD bug; do not weaken unrelated assertions).

- [ ] **Step 5: Write failing normalization tests**

Find the test file containing `stripLeakedContextHeader` tests (`grep -rl stripLeakedContextHeader tests/`). Append:

```ts
describe("self-alias stripping (W2)", () => {
  it("strips a self-nickname prefix and keeps the content", () => {
    const result = stripLeakedContextHeader("K的小娇妻: bro really pulled up with a whole gif 💀", {
      selfDisplayNames: ["Aria", "K的小娇妻"],
      participantDisplayNames: ["Aria", "K的小娇妻", "Riko", "Kevin"]
    });
    expect(result).toBe("bro really pulled up with a whole gif 💀");
  });

  it("still drops a genuine other-speaker line", () => {
    const result = stripLeakedContextHeader("Riko: not my line\nactual reply", {
      selfDisplayNames: ["Aria", "K的小娇妻"],
      participantDisplayNames: ["Aria", "K的小娇妻", "Riko", "Kevin"]
    });
    expect(result).toBe("actual reply");
  });

  it("keeps senderDisplayName working as a single-alias equivalent", () => {
    const result = stripLeakedContextHeader("Aria: hey", {
      senderDisplayName: "Aria",
      participantDisplayNames: ["Aria", "Riko"]
    });
    expect(result).toBe("hey");
  });
});
```

- [ ] **Step 6: Implement alias-aware stripping in `src/discord/normalization.ts`**

Extend the options type and normalize internally to a list:

```ts
export function stripLeakedContextHeader(
  content: string,
  options: {
    senderDisplayName?: string;
    selfDisplayNames?: string[];
    participantDisplayNames?: string[];
    stripImpersonation?: boolean;
  } = {}
): string {
```

At the top compute `const selfNames = dedupeNames([...(options.selfDisplayNames ?? []), ...(options.senderDisplayName ? [options.senderDisplayName] : [])]);`
(add a small `dedupeNames(values: string[]): string[]` helper — trim, drop empties, case-insensitive dedupe).
Replace the single `senderPrefixRe` with one regex per self name (same pattern, same escaping) and
include all of them in `leadingPatterns`. Update `stripImpersonationLines(content, selfNames, participantDisplayNames)`:
the self regex set strips-and-keeps (current sender behavior) for EVERY self name; the "other"
regex set excludes all self names case-insensitively (today it only excludes `senderDisplayName`).

- [ ] **Step 7: Run normalization tests**

Run: `npx vitest run tests/discord.test.ts` (or wherever the tests landed)
Expected: PASS, including all pre-existing strip tests.

- [ ] **Step 8: Wire aliases through `src/orchestration/runtime.ts`**

In `executeResponderDecision`, where `participantDisplayNames` and `waifuStopSequences` are built
(search `waifuParticipantDisplayNames`), add:

```ts
          const selfAuthorIds = [waifu.botId];
          const selfDisplayNames = dedupeSelfNames([
            waifu.displayName,
            waifu.name,
            ...waifuMessages
              .filter((message) => message.authorId === waifu.botId)
              .flatMap((message) => [message.displayName, message.name])
          ]);
```

Module-level helper:

```ts
function dedupeSelfNames(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names;
}
```

(Context-derived aliases are the primary source — they are exactly the names the model just saw.
The member-cache read for the identity block is Task 2's job; Task 1 needs no extra I/O.)

Then: pass `selfAuthorIds` on the `generateWaifu` request; replace BOTH
`stripLeakedContextHeader(...)` call sites' `senderDisplayName: waifu.displayName` with
`selfDisplayNames` (keep `participantDisplayNames` as-is — it may contain the nickname; the
self-exclusion now happens inside the strip via the alias set); the retry message
`retryUserMessage: attempt === 2 ? \`${waifu.displayName}:\` : undefined` stays as-is.

- [ ] **Step 9: Write a runtime integration test (append to `tests/runtime.test.ts`)**

Using the file's existing fake-discord + fake-pipeline harness: configure a waifu with
`displayName: "Aria"`, context containing her own prior message under `displayName: "K的小娇妻"`
(same authorId as her botId), and a fake `generateWaifu` returning `"K的小娇妻: my actual reply"`.
Assert the sent Discord message content is `"my actual reply"` (not dropped, prefix stripped), and
that the `generateWaifu` request carried `selfAuthorIds` containing her botId. Write it fully,
mirroring the nearest existing send-path test.

- [ ] **Step 10: Wrap injected blocks as system notes on user-role protocols**

Design §7: Anthropic (and Google) inject `midSystemBlock`/`trailingSystemBlock` as `role: "user"`
turns — with other waifus now ALSO user-role, the model must not read injected blocks as a chat
participant speaking. In the Anthropic `generateWaifu` body and the Google `generateWaifu` body
(`googleUserTurn(...)` call sites for mid/trailing), wrap the block content:

```ts
function systemNoteTurn(content: string): string {
  return `<system_note>\n${content}\n</system_note>`;
}
```

Apply to `request.midSystemBlock` and `request.trailingSystemBlock` ONLY (not `retryUserMessage`),
only in the Anthropic and Google builders (OpenAI chat/responses keep `role: "system"` injection,
unwrapped). Add one assertion each to the existing Anthropic/Google generateWaifu request-shape
tests in `tests/pipelines.test.ts` (`content` starts with `<system_note>`).

- [ ] **Step 11: Full gate + commit**

Run: `npm run typecheck && npm run test`
Expected: all green.

```bash
git add src tests
git commit -m "feat: per-waifu context roles, raw self-content, self-alias stripping"
```

---

## Task 2: Block registry rewrite + layout migration

**Files:**
- Modify: `src/orchestration/promptBlocks.ts` (registry + texts)
- Modify: `src/shared/schemas/domain.ts` (`defaultWaifuPromptLayout`, ~line 165)
- Modify: `src/orchestration/runtime.ts` (`buildWaifuPromptParts` context fields, member-cache read)
- Modify: `src/backend/migrations.ts` (layout reset step)
- Modify: `src/frontend/utils/promptLayout.ts` (`PROMPT_BLOCK_META`), `src/frontend/api/types.ts` if block-id unions exist there
- Test: `tests/promptBlocks.test.ts` (rewrite), `tests/migrations.test.ts`, `tests/promptLayoutEditor.test.ts`, `tests/runtime.test.ts`

### New registry (design §1)

| Slot | id | replaces |
|---|---|---|
| top | `identity` | identity (gains roster + nickname) |
| top | `persona` | personality |
| top | `schedule` | schedule (tag typo `_shedule` → `_schedule`) |
| top | `ioFormat` | contextStructure + replyTargeting + mentionPolicy |
| top | `tools` | toolUse |
| top | `outputContract` (LAST in top) | environment + styleConstraints + hardRules + directorNotes |
| mid | `roomInfo` | activeParticipants + serverEmojis |
| trailing | `relevantMemories` | relevantMemories (unchanged content until W3) |
| trailing | `anchor` | personalityReminder |
| trailing | `currentlyDoing` | currentlyDoing |
| trailing | `directorNote` | sceneDirection (W1's render text, new id) |

- [ ] **Step 1: Write the new block texts as constants in `promptBlocks.ts`**

Replace `INPUT_FORMAT`, `REPLY_TARGETING`, `MENTION_POLICY`, `STYLE_CONSTRAINTS`, `HARD_RULES`,
`ENVIRONMENT_RULES`, `DIRECTOR_NOTES` with exactly two constants:

```ts
const IO_FORMAT = [
  "Incoming messages: every other participant's message arrives as `DisplayName: <body>` (the body may continue on more lines). An optional `replying to > Author: preview` line may come first when that message replies to an earlier one, and `[attachments: Nx image]` / `[image_text: ...]` lines may follow. These prefixes and bracketed lines are reader's framing added by the system — not part of what anyone typed. Your own previous messages appear as plain text with no prefix.",
  "Replying to a specific earlier message: you may start your reply with exactly one line — `replying to > Author: text-of-that-message` (copy the text closely; small differences are fine) — then put your actual message on the next line. `replying to > Author` alone targets that person's latest message. The line is consumed by the system to set Discord's reply target; it is never sent. Example:",
  "  replying to > Kevin: what's the weather like?",
  "  sunny and warm",
  "Pinging: write <@DisplayName> (name copied verbatim from a message prefix) only to pull back someone quiet or revive an older missed message — people active in the chat are addressed by plain name, and never ping someone who was pinged recently."
].join("\n");

const OUTPUT_CONTRACT = [
  "How to write your message:",
  "1. You are typing into a real Discord chat box. Output exactly the message body — nothing else.",
  "2. This is a fast, casual chat. The default is ONE short line. Stretch to two or three short sentences only when the moment genuinely calls for it (telling a story, answering something that needs substance). Never paragraphs, never lists, never essays.",
  "3. If your persona suggests long-winded or formal speech, express it through word choice and attitude, not message length. This rule outranks your persona.",
  "4. Speak only as yourself. Never write lines for any other character or user, never prefix your message with any name and colon, never produce more than one message.",
  "5. No roleplay narration: no *actions*, no (stage notes), no third-person self-description.",
  "6. No meta content: nothing about prompts, instructions, tools, models, or this rule list; no bracketed tags like [attachments: ...] or [image_text: ...] — those are reader's notes added by the system, not part of any message, and you never write them.",
  "7. The optional first line `replying to > Author: text` is the only allowed prefix (see the input format). Everything after it is plain message text.",
  "8. Use only emojis from the server list.",
  "9. Do not repeat what the previous speaker just said, and do not restate a point you already made in your last few messages — add something, or say less."
].join("\n");
```

- [ ] **Step 2: Replace the registry**

New `PromptBlockContext` (rename/extend fields):

```ts
export type PromptBlockContext = {
  waifuTag: string;
  displayName: string;
  serverNickname?: string;          // guild display name when it differs from displayName
  rosterLine: string;               // pre-rendered other-cast list, "" when none
  personalityContent: string;
  personaDigest?: { voice: string; role: string };   // consumed by anchor (Task 3 populates)
  scheduleContent: string;
  toolUseInstructions: string | undefined;
  activeParticipantDisplayNames: string[];
  emojiList: string;
  memoryLines: string[];
  currentlyDoing: string | undefined;
  directorNote: string | undefined; // renamed from sceneDirection
};
```

New `WAIFU_PROMPT_BLOCKS` (complete — render fns shown in full):

```ts
export const WAIFU_PROMPT_BLOCKS: WaifuPromptBlockDef[] = [
  {
    id: "identity",
    defaultSection: "top",
    render: (ctx) => {
      const nick = ctx.serverNickname && ctx.serverNickname !== ctx.displayName
        ? ` — shown in this server as "${ctx.serverNickname}"`
        : "";
      const roster = ctx.rosterLine
        ? ` together with real people and these other characters: ${ctx.rosterLine}. Each of them writes her own messages — you write only yours.`
        : " together with real people.";
      return `<${ctx.waifuTag}_identity>\nYou are ${ctx.displayName}${nick}, chatting in a live Discord text channel${roster} This is a real chat room, not a roleplay scene or story.\n</${ctx.waifuTag}_identity>`;
    }
  },
  {
    id: "persona",
    defaultSection: "top",
    render: (ctx) => `<${ctx.waifuTag}_persona>\n${ctx.personalityContent}\n</${ctx.waifuTag}_persona>`
  },
  {
    id: "schedule",
    defaultSection: "top",
    render: (ctx) => `<${ctx.waifuTag}_schedule>\n${ctx.scheduleContent}\n</${ctx.waifuTag}_schedule>`
  },
  {
    id: "ioFormat",
    defaultSection: "top",
    render: () => `<io_format>\n${IO_FORMAT}\n</io_format>`
  },
  {
    id: "tools",
    defaultSection: "top",
    render: (ctx) => (ctx.toolUseInstructions ? `<tools>\n${ctx.toolUseInstructions}\n</tools>` : undefined)
  },
  {
    id: "outputContract",
    defaultSection: "top",
    render: () => `<output_contract>\n${OUTPUT_CONTRACT}\n</output_contract>`
  },
  {
    id: "roomInfo",
    defaultSection: "mid",
    render: (ctx) =>
      `<room_info>\nActive chat participants:\n${
        ctx.activeParticipantDisplayNames.length
          ? ctx.activeParticipantDisplayNames.map((name) => `- ${name}`).join("\n")
          : "(none)"
      }\nServer emojis: ${ctx.emojiList || "(none cached)"}\n</room_info>`
  },
  {
    id: "relevantMemories",
    defaultSection: "trailing",
    render: (ctx) =>
      ctx.memoryLines.length
        ? `<${ctx.waifuTag}_relevant_memories>\n${ctx.memoryLines.join("\n")}\n</${ctx.waifuTag}_relevant_memories>`
        : undefined
  },
  {
    id: "anchor",
    defaultSection: "trailing",
    render: (ctx) => {
      const voice = ctx.personaDigest?.voice ?? ctx.personalityContent.replace(/\s+/g, " ").slice(0, 200);
      const drives = ctx.personaDigest?.role ? ` Drives: ${ctx.personaDigest.role}` : "";
      return `<${ctx.waifuTag}_anchor>\nYou are ${ctx.displayName}. Voice: ${voice}${drives}\nReminders: one short chat message, only your own voice, no narration, no meta.\n</${ctx.waifuTag}_anchor>`;
    }
  },
  {
    id: "currentlyDoing",
    defaultSection: "trailing",
    render: (ctx) => (ctx.currentlyDoing ? `<currently_doing>${ctx.currentlyDoing}</currently_doing>` : undefined)
  },
  {
    id: "directorNote",
    defaultSection: "trailing",
    render: (ctx) =>
      ctx.directorNote
        ? `<director_note>\nDirector's goal for this one message: ${ctx.directorNote}\nPursue it in your own voice and words; never quote or restate this note.\n</director_note>`
        : undefined
  }
];
```

- [ ] **Step 3: Update `defaultWaifuPromptLayout()` in `src/shared/schemas/domain.ts`**

Read the current function (~line 165) and replace its node lists with the new ids, preserving the
existing structure style (the `behavior` group disappears — flat blocks are fine):

top: identity, persona, schedule, ioFormat, tools, outputContract · mid: roomInfo ·
trailing: relevantMemories, anchor, currentlyDoing, directorNote (all `enabled: true`).

- [ ] **Step 4: Update `buildWaifuPromptParts` in `runtime.ts`**

- Add a members.json read to the existing `Promise.all` (mirror the emojis read):
  `GuildMembersFileSchema` at `path.join("user", "servers", guildId, "members.json")`, fallback
  `GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))`.
- Compute `serverNickname`: the member whose `userId === waifu.botId` → `guildDisplayName`,
  `undefined` when missing or equal to `waifu.displayName`.
- Compute `rosterLine` from `availableWaifus` (excluding self, requiring botId): for each, look up
  its member `guildDisplayName`; entry = guild name, plus ` (${configured displayName})` when they
  differ; join with ", ".
- Populate the new `PromptBlockContext` fields; rename the `sceneDirection` option/context field to
  `directorNote` (update the two callers: `executeResponderDecision`, `formatPrintCommandMessages`).
- `personalityContent` simplifies to `waifu.persona.trim() || "(no persona configured)"` — the
  "You are X. Stay in character." sentence moves into identity/anchor (no duplication).

- [ ] **Step 5: Layout migration in `src/backend/migrations.ts`**

Add a step alongside `migrateAgentConfigs` (mirror its read/scan/write pattern):

```ts
const LEGACY_WAIFU_BLOCK_IDS = new Set([
  "personality", "contextStructure", "environment", "replyTargeting", "mentionPolicy",
  "styleConstraints", "hardRules", "toolUse", "directorNotes", "activeParticipants",
  "serverEmojis", "personalityReminder", "sceneDirection"
]);
```

For each `user/waifus/*/waifu.json`: if `promptLayout` exists and any node (or group child)
references a legacy block id, replace the whole `promptLayout` with the JSON of
`defaultWaifuPromptLayout()` and write back. Wire the step into `runMigrations` next to the other
steps and add a `tests/migrations.test.ts` case: seed a waifu file with the OLD default layout,
run migrations, assert the layout now contains `outputContract` and not `hardRules`.

- [ ] **Step 6: Frontend block meta**

`src/frontend/utils/promptLayout.ts` `PROMPT_BLOCK_META`: replace entries to match the new
registry ids/labels/sections one-for-one, e.g.
`{ id: "outputContract", label: "<output_contract>", hint: "The one rules block: format, length register, no impersonation/meta.", defaultSection: "top" }`,
`{ id: "anchor", label: "<{name}_anchor>", hint: "Compact identity + voice reminder right before the reply.", defaultSection: "trailing" }`, etc.
Fix the `_shedule` label typo. Update `tests/promptLayoutEditor.test.ts` expectations.

- [ ] **Step 7: Update tests**

- `tests/promptBlocks.test.ts`: rewrite block-id/render expectations for the new registry
  (assert identity contains the nickname clause when `serverNickname` differs; anchor fallback
  uses the persona slice; `directorNote` render text unchanged from W1).
- `tests/runtime.test.ts`: prompt-content assertions referencing old tags
  (`<hard_rules>`, `<context_message_structure>`, `<style_constraints>`, `<director_notes>`,
  `<active_chat_participants>`, `<server_emojis>`, personality-reminder duplication, `_shedule`)
  update to the new tags; the `expectedDirectorNote` helper keeps working as-is.
- Add a word-budget guard test in `tests/promptBlocks.test.ts`:

```ts
  it("keeps the fixed instruction mass under 900 words", () => {
    const fixed = [__testables.IO_FORMAT, __testables.OUTPUT_CONTRACT].join(" ");
    const words = fixed.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(900);
  });
```

(Export `export const __testables = { IO_FORMAT, OUTPUT_CONTRACT };` from `promptBlocks.ts` and
import it in the test.)

- [ ] **Step 8: Full gate + commit**

Run: `npm run typecheck && npm run test`

```bash
git add src tests
git commit -m "feat: new waifu prompt block registry — io format, output contract, anchor, roster"
```

---

## Task 3: Persona digest end-to-end

**Files:**
- Modify: `src/shared/schemas/domain.ts` (WaifuConfigSchema)
- Modify: `src/providers/types.ts` + `src/providers/pipelines.ts` (`generatePersonaDigest` ×4 protocols)
- Modify: `src/api/server.ts` (digest generation on persona change + regenerate endpoint)
- Modify: `src/orchestration/runtime.ts` (anchor consumption via PromptBlockContext; orchestrator `castingCard` swap)
- Modify: `src/frontend/api/types.ts`, `src/frontend/views/WaifusView.tsx` (read-only display + regenerate button)
- Test: `tests/pipelines.test.ts`, `tests/api.test.ts`, `tests/runtime.test.ts`

- [ ] **Step 1: Schema**

`WaifuConfigSchema` gains:

```ts
  personaDigest: z
    .object({
      voice: z.string(),   // how she talks — register, quirks, tone (1 sentence)
      role: z.string(),    // her drives and dynamics in the cast (1 sentence)
      personaHash: z.string()  // sha256 of the persona text the digest was generated from
    })
    .optional(),
```

`personaHash` is how the save path knows the digest is stale (compare against
`createHash("sha256").update(persona).digest("hex")` — `node:crypto`).

- [ ] **Step 2: Pipeline method**

`ModelPipeline` gains `generatePersonaDigest?(request: PersonaDigestRequest): Promise<PersonaDigest>;`
with types in `types.ts`:

```ts
export type PersonaDigest = { voice: string; role: string };
export type PersonaDigestRequest = ProviderRequest & { personaText: string };
```

In `pipelines.ts`, follow the observer forced-tool pattern exactly (one implementation per
protocol class — copy the corresponding `decideStageManagerObservations` body shape):
tool name `set_persona_digest`, description "Distill the character sheet into a casting digest.",
parameters:

```ts
{
  type: "object",
  additionalProperties: false,
  properties: {
    voice: { type: "string", description: "How she talks — register, quirks, tone. One sentence, present tense." },
    role: { type: "string", description: "Her drives and dynamics in the cast — what moments she fits. One sentence, present tense." }
  },
  required: ["voice", "role"]
}
```

System prompt constant:

```ts
const PERSONA_DIGEST_PROMPT =
  "You compress a character sheet for a Discord persona into a two-line casting digest. Call set_persona_digest exactly once. No name repetition, no lists, one sentence per field.";
```

User content: `request.personaText`. Parse with a zod
`z.object({ voice: z.string().min(1), role: z.string().min(1) })` and wrap errors in
`ProviderPipelineError` like the observer parser does.

- [ ] **Step 3: Generation on save (`src/api/server.ts`)**

After the waifu PUT's `updateRevisionedJson` resolves (route at ~line 389), fire-and-forget:
if `persona` changed (hash mismatch vs stored `personaDigest?.personaHash`) and the stage-manager
agent config (`user/stage-manager/config.json`) has a modelId + provider credentials: build the
pipeline (reuse the same helper pattern the runtime uses — extract or replicate `pipelineFor`),
call `generatePersonaDigest`, then `updateRevisionedJson` the waifu with the new digest. Wrap in
try/catch → `logger.warn` on failure; the save itself never blocks or fails on digest errors.
Add `POST /api/waifus/:waifuId/digest` doing the same synchronously and returning the updated
waifu (404 unknown id, 409 no stage-manager model configured — follow the file's error helpers).

- [ ] **Step 4: Consumption**

- `buildWaifuPromptParts`: pass `personaDigest: waifu.personaDigest` into the block context
  (anchor block from Task 2 already renders it).
- `castingCard` in runtime.ts: when `waifu.personaDigest` present, replace the `About:` line with
  two lines `Voice: ${digest.voice}` and `Cast her when: ${digest.role}`; otherwise keep the
  200-char preview. Update the W1 casting-card test accordingly and add the digest-path case.

- [ ] **Step 5: Frontend**

Mirror `personaDigest` in `src/frontend/api/types.ts` (with `personaHash`). In `WaifusView.tsx`,
under the persona editor, show the digest read-only (`Voice: … / Drives: …`, or "(not generated
yet)") with a "Regenerate digest" button calling the new endpoint and refreshing the waifu —
follow the view's existing button/async patterns.

- [ ] **Step 6: Tests**

- `tests/pipelines.test.ts`: one test per protocol is overkill — test the OpenAI-chat
  implementation end-to-end against the file's fake-fetch harness (request body has the forced
  tool + persona text as user content; response parses to `{voice, role}`).
- `tests/api.test.ts`: PUT a waifu with a new persona while stage-manager is UNCONFIGURED →
  save succeeds, no digest (the graceful path); POST `/digest` with stage-manager unconfigured →
  409. (Live-model generation is not tested here.)
- `tests/runtime.test.ts`: castingCard digest path (Voice/Cast-her-when lines present, raw persona
  absent).

- [ ] **Step 7: Full gate + commit**

```bash
git add src tests
git commit -m "feat: persona digest — generation on save, anchor + casting card consumption"
```

---

## Task 4: Schema-first tool instructions

**Files:**
- Modify: `src/providers/pipelines.ts` (`SHORT_TERM_MEMORY_TOOL_DESCRIPTION`, `shortTermMemoryToolParameters`, `PICK_NEXT_WAIFU_TOOL_DESCRIPTION`)
- Modify: `src/orchestration/runtime.ts` (`buildWaifuToolUseInstructions`)
- Test: `tests/pipelines.test.ts`, `tests/runtime.test.ts`

- [ ] **Step 1: Move the "how" into the tool schemas (`pipelines.ts`)**

```ts
const SHORT_TERM_MEMORY_TOOL_DESCRIPTION =
  "Your personal notepad. The chat history can vanish at any time (channel switch, cleanup); your notes are what survives. Save one short standalone sentence whenever the conversation produces something you'd want to still know tomorrow: a plan, a promise, a new fact about someone, the state of a running joke or argument. Spell names out ('Riko owes Ali tacos since Thursday', never 'she owes him'). Up to 5 calls per reply. Skip pure filler and anything already shown in your memories block. Entries expire after 24 hours. Calling this tool does NOT replace your message — always also write your normal reply in the same turn.";
```

`shortTermMemoryToolParameters` content description becomes:
`"One standalone sentence with names spelled out, understandable with zero chat context."`

```ts
const PICK_NEXT_WAIFU_TOOL_DESCRIPTION =
  "Hand the next turn directly to another waifu without waiting for the director. Call at most once, after writing your own reply, and only when she has an obvious immediate follow-up to what you just said.";
```

- [ ] **Step 2: Shrink `buildWaifuToolUseInstructions` (`runtime.ts`) to policy only**

Replace the two `sections.push` bodies so the whole block becomes:

```ts
  const sections: string[] = [];
  if (activeTools.pickNextWaifu && candidates.length > 0) {
    sections.push(
      [
        "PickNextWaifu — only after your message, only when another waifu has an obvious immediate follow-up. Available:",
        ...candidates.map((candidate) => `- ${candidate}`)
      ].join("\n")
    );
  }
  if (activeTools.shortTermMemory) {
    sections.push(
      `add_memory — save a note whenever the chat produces something you'd want to know tomorrow (plans, promises, new facts about someone, the state of a running bit). Notes are what survives when the chat history vanishes. Skip facts already shown in <${promptTagName(waifu.name || waifu.id)}_relevant_memories>. Always also write your normal message in the same turn.`
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
```

(The intro sentence "You have access to the following tools…" is dropped — the provider already
delivers the tool list.)

- [ ] **Step 3: Tests**

- `tests/pipelines.test.ts`: assert the add_memory tool description (grab the tools array from a
  captured `generateWaifu` request body) contains "personal notepad" and "always also write" —
  update any existing assertion pinned to the old description.
- `tests/runtime.test.ts`: update any assertion matching the old toolUse block text
  (grep the test file for "scratchpad to remember" / "handoff tool").

- [ ] **Step 4: Full gate + commit**

```bash
git add src tests
git commit -m "feat: schema-first tool guidance — descriptions carry the how, prompt keeps policy"
```

---

## Task 5: Acceptance gate + bookkeeping

**Files:**
- Modify: `MIGRATION_PLAN.md` (§10 status log)

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run test && npm run build:backend && npm run build`
Expected: all green (frontend vite build included — WaifusView changed).

- [ ] **Step 2: Acceptance greps**

- `grep -rn "personalityReminder\|directorNotes\|styleConstraints\|hardRules\|contextStructure\|mentionPolicy\|replyTargeting" src/ | grep -v migrations` → only `LEGACY_WAIFU_BLOCK_IDS` hits in migrations.ts.
- `grep -n "_shedule" src/ tests/ -r` → zero.
- Word budget test green (Task 2 Step 7).

- [ ] **Step 3: MIGRATION_PLAN.md §10**

Append under the W1 line:

```md
- **W2 (waifu harness)** — landed <date>, merge commit `<hash>`. Per-waifu context roles (only the
  self waifu's messages are assistant turns, rendered as raw bodies); self-alias sets cover guild
  nicknames in identity + impersonation-strip (fixes the live dropped-replies bug); new block
  registry (ioFormat, outputContract with length register, roomInfo, anchor, directorNote);
  persona digest generated on save (stage-manager model), consumed by the anchor and orchestrator
  casting cards (raw personas no longer reach the orchestrator); schema-first tool descriptions;
  stored prompt layouts migrated to the new default. P3 note: `generatePersonaDigest` is a new
  ModelPipeline method; `WaifuGenerationRequest.selfAuthorIds` is new; the four context builders
  now take selfAuthorIds.
```

- [ ] **Step 4: Commit**

```bash
git add MIGRATION_PLAN.md
git commit -m "docs: record W2 waifu harness in migration plan status log"
```

---

## Post-W2 manual validation (live server)

1. Deploy to Beta, restart, set Aria's case as the canary: watch for `Stripped leaked context
   header` / `empty after cleaning` log lines mentioning her — the dropped-reply rate should go to
   ~zero, and self-prefix generations should drop sharply within a day (the context no longer
   teaches them).
2. `/print system prompt` for one waifu — verify the new block set, the nickname clause, and that
   the assembled non-persona instruction mass is roughly half of pre-W2.
3. Edit a persona in the dashboard → digest appears; check the orchestrator debug route shows
   casting cards with Voice/Cast-her-when lines.
