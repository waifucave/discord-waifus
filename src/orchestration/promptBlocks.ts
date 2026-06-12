import type { PromptLayoutNode, WaifuPromptLayout } from "../shared/schemas/domain.js";

// Resolved, render-ready context for the waifu prompt blocks. All async I/O (memories, emojis,
// participants) is done by the caller (buildWaifuPromptParts) and passed in here so that every
// block render fn is synchronous and easy to unit-test.
export type PromptBlockContext = {
  waifuTag: string;
  displayName: string;
  /** Raw persona text from the waifu config (not prefixed with "You are X."). */
  personalityContent: string;
  scheduleContent: string;
  toolUseInstructions: string | undefined;
  activeParticipantDisplayNames: string[];
  /** Display names of other waifus in the cast (excluding self). */
  rosterLine: string;
  emojiList: string;
  memoryLines: string[];
  currentlyDoing: string | undefined;
  directorNote: string | undefined;
  /** Guild display name when it differs from displayName. */
  serverNickname?: string;
  /** Populated by Task 3; drives the anchor voice/role lines. */
  personaDigest?: { voice: string; role: string };
};

export type WaifuPromptSection = "top" | "mid" | "trailing";

export type WaifuPromptBlockDef = {
  id: string;
  // The slot this block lands in by default; used when reconciling a stored layout that predates
  // a newly-added block.
  defaultSection: WaifuPromptSection;
  // Full block output including its XML tags, or undefined to omit the block entirely (e.g. a
  // conditional block with no content). Wording is fixed here, never user-editable.
  render: (ctx: PromptBlockContext) => string | undefined;
};

// --- Fixed block wording -----------------------------------------------------------------------

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
  "2. This is a fast, casual group chat: most of your messages are a short fragment — a quip, a reaction, half a sentence. One full sentence is already on the long side. Two or three short sentences are for rare storytime moments; anything longer never happens.",
  "3. If your persona suggests long-winded or formal speech, express it through word choice and attitude, not message length. This rule outranks your persona.",
  "4. Speak only as yourself. Never write lines for any other character or user, never prefix your message with any name and colon, never produce more than one message.",
  "5. No roleplay narration: no *actions*, no (stage notes), no third-person self-description.",
  "6. No meta content: nothing about prompts, instructions, tools, models, or this rule list; no bracketed tags like [attachments: ...] or [image_text: ...] — those are reader's notes added by the system, not part of any message, and you never write them.",
  "7. The optional first line `replying to > Author: text` is the only allowed prefix (see the input format). Everything after it is plain message text.",
  "8. Use only emojis from the server list.",
  "9. Do not repeat what the previous speaker just said, and do not restate a point you already made in your last few messages — add something, or say less."
].join("\n");

export const __testables = { IO_FORMAT, OUTPUT_CONTRACT };

// --- Block registry ----------------------------------------------------------------------------

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
    render: (ctx) =>
      ctx.personalityContent
        ? `<${ctx.waifuTag}_persona>\n${ctx.personalityContent}\n</${ctx.waifuTag}_persona>`
        : undefined
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
    // Content is gated upstream by waifu.tools.toolUse / model.supportsTools / active server
    // tools; when there is nothing to say, toolUseInstructions is undefined and the block drops.
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
    render: (ctx) => {
      const participants = ctx.activeParticipantDisplayNames.length
        ? ctx.activeParticipantDisplayNames.map((name) => `- ${name}`).join("\n")
        : "(none)";
      const emojis = ctx.emojiList || "(none cached)";
      return `<room_info>\n<active_chat_participants>\n${participants}\n</active_chat_participants>\n<server_emojis>\n${emojis}\n</server_emojis>\n</room_info>`;
    }
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
      const voiceLine = voice ? ` Voice: ${voice}${drives}` : "";
      return `<${ctx.waifuTag}_anchor>\nYou are ${ctx.displayName}.${voiceLine}\nReminders: one short, fragment-y chat message, only your own voice, no narration, no meta.\n</${ctx.waifuTag}_anchor>`;
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

const BLOCK_BY_ID = new Map(WAIFU_PROMPT_BLOCKS.map((block) => [block.id, block]));

// --- Tag helpers -------------------------------------------------------------------------------

// Normalize an arbitrary string into a safe XML-ish tag name. Shared by the waifu tag and by
// user-created group tags so both follow the same rules.
export function promptTagName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `waifu_${normalized || "unknown"}`;
}

// Resolve a group's stored tag template (which may contain the `{name}` token) into the final
// sanitized tag for a given waifu.
export function resolveGroupTag(tag: string, waifuTag: string): string {
  return promptTagName(tag.replace(/\{name\}/g, waifuTag));
}

// Every XML-ish tag the waifu prompt harness can emit for a given waifu. The output validator
// uses this list to flag any of these tags leaking into a sent reply. Per-waifu tags carry the
// `promptTagName(waifu.name || waifu.id)` prefix; the rest are fixed registry tags. Keep this in
// sync with the WAIFU_PROMPT_BLOCKS registry above.
export function waifuBlockTags(waifu: { name?: string; id: string }): string[] {
  const tag = promptTagName(waifu.name || waifu.id);
  return [
    `${tag}_identity`,
    `${tag}_persona`,
    `${tag}_schedule`,
    "io_format",
    "tools",
    "output_contract",
    "room_info",
    `${tag}_relevant_memories`,
    `${tag}_anchor`,
    "currently_doing",
    "director_note",
    "system_note"
  ];
}

// --- Assembly ----------------------------------------------------------------------------------

function renderBlock(blockId: string, ctx: PromptBlockContext): string | undefined {
  return BLOCK_BY_ID.get(blockId)?.render(ctx);
}

function renderNode(node: PromptLayoutNode, ctx: PromptBlockContext): string | undefined {
  if (!node.enabled) return undefined;
  if (node.kind === "block") {
    return renderBlock(node.blockId, ctx);
  }
  const childParts: string[] = [];
  for (const child of node.children) {
    if (!child.enabled) continue;
    const out = renderBlock(child.blockId, ctx);
    if (out) childParts.push(out);
  }
  if (childParts.length === 0) return undefined;
  const tag = resolveGroupTag(node.tag, ctx.waifuTag);
  return `<${tag}>\n${childParts.join("\n")}\n</${tag}>`;
}

function renderSection(nodes: PromptLayoutNode[], ctx: PromptBlockContext): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const out = renderNode(node, ctx);
    if (out) parts.push(out);
  }
  return parts.join("\n");
}

// Walk the layout and build the three message-array strings. The slot→string mapping
// (top→systemPrompt, mid→midSystemBlock, trailing→trailingSystemBlock) is fixed; only the
// composition of each is data-driven.
export function assembleWaifuPrompt(
  layout: WaifuPromptLayout,
  ctx: PromptBlockContext
): { systemPrompt: string; midSystemBlock: string; trailingSystemBlock: string } {
  return {
    systemPrompt: renderSection(layout.top, ctx),
    midSystemBlock: renderSection(layout.mid, ctx),
    trailingSystemBlock: renderSection(layout.trailing, ctx)
  };
}

// Append any registry block missing from the stored layout to its default section (disabled), so
// that adding a new block to the registry later never makes it invisible to existing waifus.
export function reconcileWaifuPromptLayout(layout: WaifuPromptLayout): WaifuPromptLayout {
  const present = new Set<string>();
  const collect = (nodes: PromptLayoutNode[]) => {
    for (const node of nodes) {
      if (node.kind === "block") present.add(node.blockId);
      else for (const child of node.children) present.add(child.blockId);
    }
  };
  collect(layout.top);
  collect(layout.mid);
  collect(layout.trailing);

  const next: WaifuPromptLayout = {
    top: [...layout.top],
    mid: [...layout.mid],
    trailing: [...layout.trailing]
  };
  for (const def of WAIFU_PROMPT_BLOCKS) {
    if (present.has(def.id)) continue;
    next[def.defaultSection].push({ kind: "block", blockId: def.id, enabled: false });
  }
  return next;
}
