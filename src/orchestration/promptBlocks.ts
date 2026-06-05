import type { PromptLayoutNode, WaifuPromptLayout } from "../shared/schemas/domain.js";

// Resolved, render-ready context for the waifu prompt blocks. All async I/O (memories, emojis,
// participants) is done by the caller (buildWaifuPromptParts) and passed in here so that every
// block render fn is synchronous and easy to unit-test.
export type PromptBlockContext = {
  waifuTag: string;
  displayName: string;
  personalityContent: string;
  scheduleContent: string;
  toolUseInstructions: string | undefined;
  activeParticipantDisplayNames: string[];
  emojiList: string;
  memoryLines: string[];
  currentlyDoing: string | undefined;
  sceneDirection: string | undefined;
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

// --- Fixed block wording (copied verbatim from the historical buildWaifuPromptParts) ----------

const INPUT_FORMAT = [
  "Each incoming message in this conversation arrives in a chat-transcript shape so you can read Discord context:",
  "An optional `replying to > Author: preview` line appears first when the message is replying to an earlier one. The next line is `DisplayName: <body>` (the body may continue on additional lines). Optional `[attachments: Nx image]` and `[image_text: ...]` lines may follow, one per image with extracted text.",
  "The `replying to > Author: ...` line, the `DisplayName:` prefix, and any bracketed lines are framing only. They are not part of what the speaker actually wrote, and they are not how Discord messages look."
].join("\n");

const REPLY_TARGETING = [
  "To reply to one specific earlier message, you may start your reply with a single `replying to > Author: text-of-that-message` line. Copy the message text as closely as you can (small differences are fine; the runtime fuzzy-matches it). Put your actual reply on the next line.",
  "If you only know the speaker, write `replying to > Author`; the runtime targets that speaker's most recent message.",
  "The `replying to >` line is not sent to Discord; it only tells the runtime which message your reply targets.",
  "Use this instead of pinging when you want to address one specific earlier message. Otherwise omit the quote entirely and just write your reply.",
  "Quote example - to reply specifically to Kevin's earlier `what's the weather like?` message, write:\n  replying to > Kevin: what's the weather like?\n  sunny and warm\nThe runtime consumes the `replying to > Kevin: ...` line to set Discord's reply target; only `sunny and warm` is sent."
].join("\n");

const MENTION_POLICY = [
  "To ping a user, write <@DisplayName> - where `DisplayName` is copied verbatim from the `DisplayName:` prefix on one of their messages. Example: a message that starts with `Kevin: hey` is pinged as <@Kevin>.",
  "Do not ping a user who is already active in the recent chat or who just spoke. Mention their display name in plain text instead.",
  "Only ping when you are reviving an older missed message, pulling back someone who has gone quiet, or a scene_direction explicitly asks for a ping."
].join("\n");

const STYLE_CONSTRAINTS = [
  "Write exactly one short phrase or one very short sentence, usually under 12 words.",
  "Never write a second sentence.",
  "This length rule overrides your persona, reply_style, and scene_direction. Even when asked for a longer or more thoughtful reply, compress it to one tiny conversational beat.",
  "Avoid stacked clauses, multi-line replies, setup-plus-punchline chains, and explanations. A sharp fragment is usually stronger than a complete mini speech."
].join("\n");

const HARD_RULES = [
  "Your reply is the raw message body that will be sent verbatim to Discord.",
  "Your turn is exactly one Discord message body, never a transcript.",
  "Do not write `Name: ...` or `DisplayName: ...` lines for any character, including yourself and every other waifu in the channel.",
  "Do not draft another waifu's reply. If you find yourself doing that, stop and write only your own message.",
  "Do not include bracketed metadata tags: no `[attachments: ...]`, no `[image_text: ...]`, no `[replying to: ...]`, no `[timestamp: ...]`, no `[reactions: ...]`, no `[index: ...]`, no `[scene_direction: ...]`, and no other `[tag: value]` constructions.",
  "Do not begin with your own display name followed by a colon. Other than the optional leading `replying to > Author: ...` reply-targeting line, begin with the first word you are actually saying.",
  "Do not echo or paraphrase any prior message's bracketed framing tags.",
  "Do not output physical actions, roleplay narration, or stage directions. No asterisks-wrapped actions like *smiles* or *waves*, no parenthetical stage notes like (hugs them), and no bracketed cues like [walks over].",
  "The optional leading `replying to > Author: ...` reply-targeting line is the only allowed prefix exception.",
  "Never use raw Discord IDs for pings.",
  "Use only listed server emojis."
].join("\n");

const ENVIRONMENT_RULES = [
  "You are chatting in a live Discord text channel — this is a real chat room with real users, not a roleplay scene, story, or chat fiction.",
  "Write one Discord-safe message per turn.",
  "Reply with only what you would actually type into a chat box — no narration, no meta commentary, no describing yourself in the third person."
].join("\n");

const DIRECTOR_NOTES = [
  "Keep your reply short.",
  "Do not repeat what the previous waifu just said.",
  "Do not repeat a person's name when recent context already makes the target clear.",
  "To pull a quiet person back in, use their <@Name> tag instead of repeating their name; do not tag them again if anyone already tagged them recently."
].join("\n");

// --- Block registry ----------------------------------------------------------------------------

export const WAIFU_PROMPT_BLOCKS: WaifuPromptBlockDef[] = [
  {
    id: "identity",
    defaultSection: "top",
    render: (ctx) =>
      `<${ctx.waifuTag}_identity>\nYou are acting as ${ctx.displayName} in a discord server together with real people and other waifus\n</${ctx.waifuTag}_identity>`
  },
  {
    id: "personality",
    defaultSection: "top",
    render: (ctx) => `<${ctx.waifuTag}_personality>\n${ctx.personalityContent}\n</${ctx.waifuTag}_personality>`
  },
  {
    id: "schedule",
    defaultSection: "top",
    render: (ctx) => `<${ctx.waifuTag}_shedule>\n${ctx.scheduleContent}\n</${ctx.waifuTag}_shedule>`
  },
  {
    id: "contextStructure",
    defaultSection: "top",
    render: () => `<context_message_structure>\n${INPUT_FORMAT}\n</context_message_structure>`
  },
  {
    id: "environment",
    defaultSection: "top",
    render: () => `<environment_instructions>\n${ENVIRONMENT_RULES}\n</environment_instructions>`
  },
  {
    id: "replyTargeting",
    defaultSection: "top",
    render: () => `<replying_to_message>\n${REPLY_TARGETING}\n</replying_to_message>`
  },
  {
    id: "mentionPolicy",
    defaultSection: "top",
    render: () => `<mention_policy>\n${MENTION_POLICY}\n</mention_policy>`
  },
  {
    id: "styleConstraints",
    defaultSection: "top",
    render: () => `<style_constraints>\n${STYLE_CONSTRAINTS}\n</style_constraints>`
  },
  {
    id: "hardRules",
    defaultSection: "top",
    render: () => `<hard_rules>\n${HARD_RULES}\n</hard_rules>`
  },
  {
    id: "toolUse",
    defaultSection: "top",
    // Content is gated upstream by waifu.tools.toolUse / model.supportsTools / active server
    // tools; when there is nothing to say, toolUseInstructions is undefined and the block drops.
    render: (ctx) => (ctx.toolUseInstructions ? `<tool_use>\n${ctx.toolUseInstructions}\n</tool_use>` : undefined)
  },
  {
    id: "directorNotes",
    defaultSection: "mid",
    render: () => `<director_notes>\n${DIRECTOR_NOTES}\n</director_notes>`
  },
  {
    id: "activeParticipants",
    defaultSection: "mid",
    render: (ctx) =>
      `<active_chat_participants>\n${
        ctx.activeParticipantDisplayNames.length
          ? ctx.activeParticipantDisplayNames.map((displayName) => `- ${displayName}`).join("\n")
          : "(none)"
      }\n</active_chat_participants>`
  },
  {
    id: "serverEmojis",
    defaultSection: "mid",
    render: (ctx) => `<server_emojis>\n${ctx.emojiList || "(none cached)"}\n</server_emojis>`
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
    // The optional trailing personality reminder. Distinct id from `personality` so each layout
    // node has exactly one home even though both render the same content.
    id: "personalityReminder",
    defaultSection: "trailing",
    render: (ctx) => `<${ctx.waifuTag}_personality>\n${ctx.personalityContent}\n</${ctx.waifuTag}_personality>`
  },
  {
    id: "currentlyDoing",
    defaultSection: "trailing",
    render: (ctx) => (ctx.currentlyDoing ? `<currently_doing>${ctx.currentlyDoing}</currently_doing>` : undefined)
  },
  {
    id: "sceneDirection",
    defaultSection: "trailing",
    render: (ctx) => (ctx.sceneDirection ? `<scene_direction>${ctx.sceneDirection}</scene_direction>` : undefined)
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
