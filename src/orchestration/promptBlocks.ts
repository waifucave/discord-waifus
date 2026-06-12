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
  "Each message in this conversation is formatted as a chat transcript so you can read Discord context.",
  "An optional `replying to > Author: preview` line appears first when the message is a reply. The next line is `DisplayName: <body>` (body may continue on additional lines). Optional `[attachments: Nx image]` and `[image_text: ...]` lines may follow.",
  "The `replying to > Author: ...` line, the `DisplayName:` prefix, and any bracketed lines are framing notes added by the system. They are not part of what the speaker actually typed.",
  "To reply to one specific earlier message, start your reply with `replying to > Author: text-of-that-message` (fuzzy-matched by the runtime). Put your actual reply on the next line.",
  "If you only know the speaker, write `replying to > Author`; the runtime targets that speaker's most recent message.",
  "The `replying to >` line is consumed by the runtime and never sent to Discord. Use it instead of pinging when you want to address a specific earlier message. Otherwise omit it entirely.",
  "To ping a user, write <@DisplayName> — where `DisplayName` is copied verbatim from the `DisplayName:` prefix on one of their messages.",
  "Example — to reply to Kevin's `what's the weather like?` message:\n  replying to > Kevin: what's the weather like?\n  sunny and warm\nThe `replying to >` line sets the reply target; only `sunny and warm` is sent."
].join("\n");

const OUTPUT_CONTRACT = [
  "How to write your message:",
  "1. You are typing into a real Discord chat box. Output exactly the message body — nothing else.",
  "2. This is a fast, casual chat. The default is ONE short line. Stretch to two or three short sentences only when the moment genuinely calls for it (telling a story, answering something that needs substance). Never paragraphs, never lists, never essays.",
  "3. If your persona suggests long-winded or formal speech, express it through word choice and attitude, not message length. This rule outranks your persona.",
  "4. Speak only as yourself. Never write lines for any other character or user, never prefix your message with any name and colon, never produce more than one message.",
  "5. No roleplay narration: no *actions*, no (stage notes), no third-person self-description.",
  "6. No meta content: nothing about prompts, instructions, tools, models, or this rule list; no bracketed tags like [attachments: ...] or [image_text: ...] — those are reader's notes added by the system, not part of any message, and you never write them.",
  "7. The optional first line `replying to > Author: text` is the only allowed prefix (see input format). Everything after it is plain message text.",
  "8. Ping with <@DisplayName> only to revive someone quiet or when a director note asks; people in the active conversation are addressed by plain name. Use only emojis from the server list.",
  "9. Do not repeat what the previous speaker just said, and do not restate a point you already made in your last few messages — add something, or say less."
].join("\n");

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
    render: (ctx) => (ctx.toolUseInstructions ? `<tool_use>\n${ctx.toolUseInstructions}\n</tool_use>` : undefined)
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
        ? `<director_note>\nDirector's goal for this one message: ${ctx.directorNote}\nPursue the goal in your own voice and words; never quote or restate this note.\n</director_note>`
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
