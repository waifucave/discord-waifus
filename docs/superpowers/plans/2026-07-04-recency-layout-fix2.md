# Fix 2 — Recency Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the newest chat messages back the recency position in waifu prompts: move `room_info` and `relevant_memories` to ~10 messages deep, slim the trailing block to anchor + director note, and point the model explicitly at the newest message.

**Architecture:** Waifu prompts are assembled from a per-waifu editable `promptLayout` (top/mid/trailing slots) rendered by `src/orchestration/promptBlocks.ts` and positioned by `src/orchestration/pipeline/messages.ts` (`buildWaifuMessages`: head system → context with mid spliced at a fixed depth → trailing appended after the last message). Layouts are stored per waifu in `waifu.json`, so moving a block requires both a new default AND a startup migration (`src/backend/migrations.ts`, pattern: `migrateWaifuPromptLayoutW2`). The orchestrator's directive `goal` text is defined in the tool schema (`src/orchestration/tools.ts:orchestratorToolParameters`) and flows verbatim into the waifu's `<director_note>`.

**Tech Stack:** TypeScript ESM (NodeNext — local imports need `.js`), Vitest, Zod.

## Global Constraints

- Anchor digest content UNCHANGED: both `Voice:` and `Drives:` sentences stay (Drives-drop is a deferred A/B).
- ESM imports in `.ts` use `.js` extensions.
- Backend tsconfig excludes tests/frontend; run `npm run typecheck` for both.
- Frontend mirrors (`src/frontend/utils/promptLayout.ts`) are maintained MANUALLY — keep in sync with `domain.ts`/`promptBlocks.ts`.
- Never edit `dist/`; Beta deploy is via npm release (`npm run release:beta`), pinned-version install.
- Evidence for this design: live captures 2026-07-03 (Beta, `/api/events`) — see memory note + `docs/superpowers/plans/2026-06-11-prompting-overhaul/` for the workstream.

---

### Task 1: Mid-block depth 2 → 10

**Files:**
- Modify: `src/orchestration/pipeline/messages.ts:105-110`
- Modify: `src/frontend/utils/promptLayout.ts:18` (section hint copy)
- Test: `tests/gatewayMessages.test.ts`

**Interfaces:**
- Produces: `MID_BLOCK_DEPTH = 10` (module const in `messages.ts`, not exported); mid block always has exactly 10 context messages after it (clamped to 0 for short contexts).

- [x] **Step 1: Write the failing test** — in `tests/gatewayMessages.test.ts`, after the existing `"injects the mid block at context length - 2 and retryUserMessage last"` test:

```ts
  it("injects the mid block 10 messages before the end of the context", async () => {
    // deepseek-v4-flash: multipleSystemMessages=false, input=text only
    const model = gateway.getCapabilities("deepseek", "deepseek-v4-flash")!;
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg({ id: `m${i}`, content: `msg-${i}` })
    );
    const out = await buildWaifuMessages(model, { ...base, messages });
    const midIndex = out.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("MID")
    );
    const trailingIndex = out.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("TRAIL")
    );
    expect(midIndex).toBeGreaterThan(0);
    // Exactly 10 conversation messages sit between the mid block and the trailing block.
    expect(trailingIndex - midIndex - 1).toBe(10);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gatewayMessages.test.ts -t "10 messages before"`
Expected: FAIL — with depth 2, `trailingIndex - midIndex - 1` is 2.

- [x] **Step 3: Implement** — in `src/orchestration/pipeline/messages.ts`, replace the splice block:

```ts
// The mid block sits MID_BLOCK_DEPTH messages before the end so the live exchange is never
// split by a system insertion (live capture 2026-07-03: room_info landed between a question
// and its answer at depth 2). Depth 10 keeps the whole recent exchange contiguous while the
// block stays inside every model's close-attention span at these prompt sizes.
const MID_BLOCK_DEPTH = 10;
```

and in `buildWaifuMessages`:

```ts
  if (inputs.midSystemBlock) {
    const at = Math.max(0, context.length - MID_BLOCK_DEPTH);
    context.splice(at, 0, auxTurn(inputs.midSystemBlock));
  }
```

Rename the old test and update its comment (behavior for short contexts is now "clamped to the context start"):

```ts
  it("clamps the mid block to the context start when fewer than 10 messages, retryUserMessage last", async () => {
```

(body unchanged — with 4 messages the mid block clamps to index 0, which still satisfies `midIndex > 0` after the head system message and `midIndex < m3Index`).

- [x] **Step 4: Update the dashboard hint** — `src/frontend/utils/promptLayout.ts:18`:

```ts
    hint: "Injected ten messages before the end of the chat context."
```

- [x] **Step 5: Run tests**

Run: `npx vitest run tests/gatewayMessages.test.ts`
Expected: PASS (all).

- [x] **Step 6: Commit**

```bash
git add src/orchestration/pipeline/messages.ts src/frontend/utils/promptLayout.ts tests/gatewayMessages.test.ts
git commit -m "feat: mid system block sits 10 messages deep, never splitting the live exchange"
```

---

### Task 2: `relevantMemories` moves trailing → mid (defaults)

**Files:**
- Modify: `src/orchestration/promptBlocks.ts:124` (defaultSection)
- Modify: `src/shared/schemas/domain.ts:154-173` (`defaultWaifuPromptLayout`)
- Modify: `src/frontend/utils/promptLayout.ts:44,72-74` (metadata + default builder)
- Test: `tests/promptBlocks.test.ts`, `tests/runtime.test.ts`

**Interfaces:**
- Produces: default layout `mid: [roomInfo, relevantMemories]`, `trailing: [anchor, currentlyDoing, directorNote]`. Render order in the mid string: `<room_info>` then `<{name}_relevant_memories>`.

- [x] **Step 1: Write the failing test** — in `tests/promptBlocks.test.ts` (inside the existing top-level describe, after the default-layout test):

```ts
  it("renders relevantMemories in the mid block by default (recency fix)", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx());
    expect(parts.midSystemBlock).toContain("<yuki_relevant_memories>");
    expect(parts.trailingSystemBlock).not.toContain("<yuki_relevant_memories>");
    // trailing now leads with the anchor
    expect(parts.trailingSystemBlock).toMatch(/^<yuki_anchor>/);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/promptBlocks.test.ts -t "recency fix"`
Expected: FAIL — memories render in trailing.

- [x] **Step 3: Implement**

`src/shared/schemas/domain.ts` — replace `defaultWaifuPromptLayout` body (and fix its doc comment):

```ts
// The default arrangement for new waifus: identity, persona, schedule, ioFormat, tools, and
// outputContract in the top slot; roomInfo and relevantMemories in mid (10 messages deep);
// anchor, currentlyDoing, and directorNote in trailing.
export function defaultWaifuPromptLayout(): WaifuPromptLayout {
  const block = (blockId: string): PromptLayoutBlockNode => ({ kind: "block", blockId, enabled: true });
  return {
    top: [
      block("identity"),
      block("persona"),
      block("schedule"),
      block("ioFormat"),
      block("tools"),
      block("outputContract")
    ],
    mid: [block("roomInfo"), block("relevantMemories")],
    trailing: [
      block("anchor"),
      block("currentlyDoing"),
      block("directorNote")
    ]
  };
}
```

`src/orchestration/promptBlocks.ts` — `relevantMemories` block def:

```ts
  {
    id: "relevantMemories",
    defaultSection: "mid",
```

`src/frontend/utils/promptLayout.ts` — line 44 metadata and the default builder:

```ts
  { id: "relevantMemories", label: "<{name}_relevant_memories>", hint: "Long/short-term memories, when present.", defaultSection: "mid" },
```

```ts
    mid: [block("roomInfo"), block("relevantMemories")],
    trailing: [
      block("anchor"),
```

- [x] **Step 4: Update the existing assertions that pin the old placement**

`tests/promptBlocks.test.ts` (~lines 50-59): the default-layout test's mid regex currently ends `<\/room_info>$`; memories assertions expect trailing. Replace those assertions with:

```ts
    // mid: roomInfo, then memories
    expect(parts.midSystemBlock).toMatch(
      /^<room_info>\n<active_chat_participants>\n- Kevin\n<\/active_chat_participants>\n<server_emojis>\n:cat:\n<\/server_emojis>\n<\/room_info>\n<yuki_relevant_memories>\n- remembers tea\n<\/yuki_relevant_memories>$/
    );
    // trailing: anchor (not full persona duplicate), no memories
    expect(parts.trailingSystemBlock).not.toContain("<yuki_relevant_memories>");
    expect(parts.trailingSystemBlock).toContain("<yuki_anchor>");
```

`tests/runtime.test.ts` FakePipeline W2 assertions (~lines 393-403): flip the two memory expectations:

```ts
    expect(request.midSystemBlock).toMatch(
      /<yuki_relevant_memories>\n- \(fact\) Yuki remembers Kevin likes tea\.\n<\/yuki_relevant_memories>/
    );
    expect(request.midSystemBlock).not.toContain("<director_notes>");
    // trailing: anchor (not full persona duplicate), memories now live in mid
    expect(request.trailingSystemBlock).toBeDefined();
    expect(request.trailingSystemBlock).not.toMatch(/<yuki_relevant_memories>/);
```

(keep the surrounding room_info/anchor/director-note assertions; only the memory lines move).

- [x] **Step 5: Run tests**

Run: `npx vitest run tests/promptBlocks.test.ts tests/runtime.test.ts`
Expected: PASS (all).

- [x] **Step 6: Commit**

```bash
git add src/orchestration/promptBlocks.ts src/shared/schemas/domain.ts src/frontend/utils/promptLayout.ts tests/promptBlocks.test.ts tests/runtime.test.ts
git commit -m "feat: relevant memories render in the mid block by default"
```

---

### Task 3: Stored-layout migration (existing waifus)

**Files:**
- Modify: `src/backend/migrations.ts` (new fn + wire into `runMigrations` after `migrateWaifuPromptLayoutW2`)
- Test: `tests/migrations.test.ts`

**Interfaces:**
- Consumes: `readJsonOrUndefined`, `isObject`, `atomicWriteJson` (module-privates already in `migrations.ts`).
- Produces: `migrateWaifuPromptMemoriesToMid(dataRoot: string): Promise<number>` — count of waifu.json files rewritten; applied-tag `migrate-waifu-memories-to-mid-<n>`.

- [x] **Step 1: Write the failing tests** — in `tests/migrations.test.ts` (uses the file's existing `writeJson` helper and `makeTempRoot`/`roots`):

```ts
  it("moves a stored relevantMemories block from trailing to mid", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: "2026-07-01T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      enabled: true,
      persona: "kind",
      promptLayout: {
        top: [{ kind: "block", blockId: "identity", enabled: true }],
        mid: [{ kind: "block", blockId: "roomInfo", enabled: true }],
        trailing: [
          { kind: "block", blockId: "relevantMemories", enabled: false },
          { kind: "block", blockId: "anchor", enabled: true }
        ]
      }
    });

    const first = await runMigrations(root);
    expect(first.applied).toContain("migrate-waifu-memories-to-mid-1");

    const raw = JSON.parse(await readFile(path.join(root, "user/waifus/yuki/waifu.json"), "utf8"));
    expect(raw.promptLayout.mid).toEqual([
      { kind: "block", blockId: "roomInfo", enabled: true },
      { kind: "block", blockId: "relevantMemories", enabled: false }
    ]);
    expect(raw.promptLayout.trailing).toEqual([{ kind: "block", blockId: "anchor", enabled: true }]);

    // Idempotent: a second run finds nothing to move.
    const second = await runMigrations(root);
    expect(second.applied.filter((tag) => tag.startsWith("migrate-waifu-memories-to-mid"))).toEqual([]);
  });

  it("leaves relevantMemories alone when the user moved it into a custom group", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const layout = {
      top: [{ kind: "block", blockId: "identity", enabled: true }],
      mid: [{ kind: "block", blockId: "roomInfo", enabled: true }],
      trailing: [
        {
          kind: "group",
          id: "g1",
          tag: "{name}_extras",
          enabled: true,
          children: [{ kind: "block", blockId: "relevantMemories", enabled: true }]
        }
      ]
    };
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: "2026-07-01T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      enabled: true,
      persona: "kind",
      promptLayout: layout
    });

    const result = await runMigrations(root);
    expect(result.applied.filter((tag) => tag.startsWith("migrate-waifu-memories-to-mid"))).toEqual([]);
    const raw = JSON.parse(await readFile(path.join(root, "user/waifus/yuki/waifu.json"), "utf8"));
    expect(raw.promptLayout.trailing).toEqual(layout.trailing);
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/migrations.test.ts -t "relevantMemories"`
Expected: FAIL — `migrate-waifu-memories-to-mid-1` never applied.

- [x] **Step 3: Implement** — in `src/backend/migrations.ts`, after `migrateWaifuPromptLayoutW2`:

```ts
// Fix-2 (recency layout): relevantMemories moved from the trailing slot to the mid slot so the
// newest messages keep the final prompt positions. Moves the top-level trailing node (keeping
// its enabled flag) to the end of mid. A node the user placed inside a custom group stays put —
// that arrangement was deliberate.
async function migrateWaifuPromptMemoriesToMid(dataRoot: string): Promise<number> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(waifusRoot, entry, "waifu.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data) || !isObject(data.promptLayout)) continue;
    const layout = data.promptLayout as { mid?: unknown; trailing?: unknown };
    if (!Array.isArray(layout.mid) || !Array.isArray(layout.trailing)) continue;
    const index = layout.trailing.findIndex(
      (node) => isObject(node) && node.kind === "block" && node.blockId === "relevantMemories"
    );
    if (index < 0) continue;
    const [node] = layout.trailing.splice(index, 1);
    layout.mid.push(node);
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}
```

Wire into `runMigrations` directly after the `migrateWaifuPromptLayoutW2` step:

```ts
  const memoriesMoved = await migrateWaifuPromptMemoriesToMid(dataRoot);
  if (memoriesMoved > 0) {
    applied.push(`migrate-waifu-memories-to-mid-${memoriesMoved}`);
  }
```

- [x] **Step 4: Run tests**

Run: `npx vitest run tests/migrations.test.ts`
Expected: PASS (all).

- [x] **Step 5: Commit**

```bash
git add src/backend/migrations.ts tests/migrations.test.ts
git commit -m "feat: migrate stored waifu layouts — relevantMemories trailing to mid"
```

---

### Task 4: Anchor reply-target line

**Files:**
- Modify: `src/orchestration/promptBlocks.ts:130-139` (anchor render)
- Test: `tests/promptBlocks.test.ts`

**Interfaces:**
- Produces: anchor Reminders line ends with `React to the newest message above.` (no director note) or `React to the newest message above unless your director note points elsewhere.` (with one). Digest `Voice:`/`Drives:` sentences byte-identical to today.

- [x] **Step 1: Write the failing tests** — in `tests/promptBlocks.test.ts`, inside `describe("anchor block", ...)`:

```ts
  it("tells the waifu to react to the newest message", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx());
    expect(parts.trailingSystemBlock).toContain(
      "no narration, no meta. React to the newest message above."
    );
  });

  it("defers the reply target to the director note when one is present", () => {
    const parts = assembleWaifuPrompt(
      defaultWaifuPromptLayout(),
      ctx({ directorNote: "steer toward weekend plans" })
    );
    expect(parts.trailingSystemBlock).toContain(
      "React to the newest message above unless your director note points elsewhere."
    );
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/promptBlocks.test.ts -t "newest message"`
Expected: FAIL — Reminders line ends at "no meta.".

- [x] **Step 3: Implement** — anchor render in `src/orchestration/promptBlocks.ts`:

```ts
  {
    id: "anchor",
    defaultSection: "trailing",
    render: (ctx) => {
      const voice = ctx.personaDigest?.voice ?? ctx.personalityContent.replace(/\s+/g, " ").slice(0, 200);
      const drives = ctx.personaDigest?.role ? ` Drives: ${ctx.personaDigest.role}` : "";
      const voiceLine = voice ? ` Voice: ${voice}${drives}` : "";
      // The reply target is the one recency instruction left after the memories moved to mid:
      // it re-points a reasoning-off model at the conversation the trailing block displaced.
      const replyTarget = ctx.directorNote
        ? " React to the newest message above unless your director note points elsewhere."
        : " React to the newest message above.";
      return `<${ctx.waifuTag}_anchor>\nYou are ${ctx.displayName}.${voiceLine}\nReminders: one short, fragment-y chat message, only your own voice, no narration, no meta.${replyTarget}\n</${ctx.waifuTag}_anchor>`;
    }
  },
```

- [x] **Step 4: Run tests**

Run: `npx vitest run tests/promptBlocks.test.ts tests/runtime.test.ts tests/outputValidator.test.ts`
Expected: PASS (word-budget test gains ~12 words — the 900-word ceiling holds; leak-tag list unchanged).

- [x] **Step 5: Commit**

```bash
git add src/orchestration/promptBlocks.ts tests/promptBlocks.test.ts
git commit -m "feat: anchor points the waifu at the newest message"
```

---

### Task 5: Directive goals are destination-only

**Files:**
- Modify: `src/orchestration/tools.ts:182-187` (goal description in `orchestratorToolParameters`)
- Test: `tests/orchestrationTools.test.ts`

**Interfaces:**
- Consumes: `orchestratorToolParameters(directiveBudgetOpen: boolean, availableWaifuIds?: string[])` — existing builder; the prebuilt-const test (`"the pre-built orchestrator schema const matches a fresh build (single source)"`) guards drift, so edit the builder text only.

- [x] **Step 1: Write the failing test** — in `tests/orchestrationTools.test.ts`:

```ts
  it("directive goal description demands destination-only phrasing", () => {
    const schema = JSON.stringify(orchestratorToolParameters(true));
    expect(schema).toContain("Never name the topic being left behind");
  });
```

(match the import style already used at the top of the file for `orchestratorToolParameters`; add it to the import list if absent.)

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrationTools.test.ts -t "destination-only"`
Expected: FAIL.

- [x] **Step 3: Implement** — `src/orchestration/tools.ts` goal description:

```ts
                    goal: {
                      type: "string",
                      maxLength: DIRECTIVE_GOAL_MAX_CHARS,
                      description:
                        "A short GOAL for this one message ('steer toward LTS's car project', 'pull Kevin back in') — never reply content, wording, or anything she would say. Name only the destination — what to move TO. Never name the topic being left behind ('pivot to weekend plans', never 'pivot away from the toast talk'): any topic this goal mentions tends to reappear in her message."
                    }
```

- [x] **Step 4: Run tests**

Run: `npx vitest run tests/orchestrationTools.test.ts`
Expected: PASS (incl. the prebuilt-const single-source test).

- [x] **Step 5: Commit**

```bash
git add src/orchestration/tools.ts tests/orchestrationTools.test.ts
git commit -m "feat: directive goals name only the destination topic"
```

---

### Task 6: Validate, release 1.5.175, deploy to Beta

**Files:** none new (release + ops).

- [x] **Step 1: Full local validation**

Run: `npm run typecheck` then `npm run test` (NEVER pipe test output through grep — the release script's internal gate is authoritative).
Expected: both clean, 690+ tests passing.

- [x] **Step 2: Fix-1 soak check on Beta (gate)** — over SSH (`<remote-user>@<tailscale-ip>`):
  - `grep -c '"level":"error"' ~/.dc-waifus/app/logs/backend.log` scoped to since the 1.5.174 restart (2026-07-03 ~12:10Z) — expect no new error burst.
  - Dump `/api/events` (`curl -sN -m 6 http://127.0.0.1:3888/api/events`) and confirm recent waifu queries still show assistant self-turns.
  - Skim the newest orchestrator decisions for misattribution-style reasonings.
  If fix-1 regressions appear: STOP, report, do not deploy fix 2.

- [x] **Step 3: Push and release**

```bash
git push origin main
npm run release:beta -- 1.5.175 --yes --message "feat: recency layout — memories+room_info 10 deep, reply-target anchor, destination-only directives"
```

- [x] **Step 4: Deploy Beta pinned + restart**

```bash
ssh <remote-user>@<tailscale-ip> 'export PATH="$PATH:/opt/homebrew/bin"; npm install -g @waifucave/discord-waifus@1.5.175 && waifus restart'
```

- [x] **Step 5: Verify live**
  - Backend log shows `migrate-waifu-memories-to-mid-5` (or count of waifus with stored layouts) in the migrations line at boot.
  - After the next waifu generation (watch `Generating waifu reply` in backend.log): dump `/api/events`; confirm in the captured request: memories inside the mid system message ~10 back, trailing block = anchor(+director note) only, `React to the newest message above` present, last real message is 2nd-from-last overall.
  - Confirm reply quality anecdotally; note read-outs for the soak (reply relevance to newest message, directive adherence on change_topic).

- [x] **Step 6: Update memory** (`live-server-access.md`): fix 2 shipped in 1.5.175, scope as implemented, Drives-drop A/B still open.

---

## Self-Review

- Spec coverage: depth 10 (T1), memories→mid default (T2), stored-layout migration (T3), reply-target line conditional on director note (T4), destination-only directive rule (T5), anchor digest untouched (T4 keeps Voice/Drives byte-identical), soak-gated release+deploy (T6). ✓
- No placeholders: every code step shows the code; commands include expected outcomes. ✓
- Type consistency: `migrateWaifuPromptMemoriesToMid` name used consistently; `MID_BLOCK_DEPTH` module-private; no cross-task signature drift. ✓
