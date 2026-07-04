import type {
  PromptLayoutBlockNode,
  PromptLayoutNode,
  WaifuPromptLayout
} from "../api/types";

export type PromptSectionKey = "top" | "mid" | "trailing";

const SECTIONS: PromptSectionKey[] = ["top", "mid", "trailing"];

export const PROMPT_SECTION_LABELS: Record<PromptSectionKey, { title: string; hint: string }> = {
  top: {
    title: "Top system prompt",
    hint: "First system message, before the conversation."
  },
  mid: {
    title: "Mid system block",
    hint: "Injected ten messages before the end of the chat context."
  },
  trailing: {
    title: "Trailing system block",
    hint: "Appended after the conversation, right before the model replies."
  }
};

export type PromptBlockMeta = {
  id: string;
  label: string;
  hint: string;
  defaultSection: PromptSectionKey;
};

// Mirror of the backend block registry (src/orchestration/promptBlocks.ts). Labels use `{name}`
// for tags that embed the waifu's name. `defaultSection` is used to place a block when it is
// missing from a stored layout (reconcile) or restored to its home.
export const PROMPT_BLOCK_META: PromptBlockMeta[] = [
  { id: "identity", label: "<{name}_identity>", hint: "Who the waifu is, the Discord setting, and the cast roster.", defaultSection: "top" },
  { id: "persona", label: "<{name}_persona>", hint: "The persona / character definition (raw, verbatim).", defaultSection: "top" },
  { id: "schedule", label: "<{name}_schedule>", hint: "The configured routine used for energy and timing.", defaultSection: "top" },
  { id: "ioFormat", label: "<io_format>", hint: "Input transcript format, reply-targeting syntax, and ping rules.", defaultSection: "top" },
  { id: "tools", label: "<tools>", hint: "Tool instructions; only rendered when tools are active.", defaultSection: "top" },
  { id: "outputContract", label: "<output_contract>", hint: "Consolidated output rules: length, format, no-meta, no-narration.", defaultSection: "top" },
  { id: "roomInfo", label: "<room_info>", hint: "Active participants and server emojis in one block.", defaultSection: "mid" },
  { id: "relevantMemories", label: "<{name}_relevant_memories>", hint: "Long/short-term memories, when present.", defaultSection: "trailing" },
  { id: "anchor", label: "<{name}_anchor>", hint: "Compact trailing identity anchor (name + mini-contract).", defaultSection: "trailing" },
  { id: "currentlyDoing", label: "<currently_doing>", hint: "Schedule-derived current activity, when active.", defaultSection: "trailing" },
  { id: "directorNote", label: "<director_note>", hint: "Per-turn director note from the orchestrator, when present.", defaultSection: "trailing" }
];

const META_BY_ID = new Map(PROMPT_BLOCK_META.map((meta) => [meta.id, meta]));

export function blockMeta(blockId: string): PromptBlockMeta | undefined {
  return META_BY_ID.get(blockId);
}

export function blockLabel(blockId: string): string {
  return META_BY_ID.get(blockId)?.label ?? `<${blockId}>`;
}

// Mirror of defaultWaifuPromptLayout() in the backend domain schema.
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
    mid: [block("roomInfo")],
    trailing: [
      block("relevantMemories"),
      block("anchor"),
      block("currentlyDoing"),
      block("directorNote")
    ]
  };
}

// --- DnD id encoding + pure layout mutations ---------------------------------------------------
// A block's draggable id is `block:<blockId>` (blockIds are globally unique within a layout). A
// group's id `group:<groupId>` doubles as both its slot in the section and the droppable area for
// its children. Sections are droppables `section:<key>`.
// Mirror of promptTagName + resolveGroupTag in the backend (src/orchestration/promptBlocks.ts):
// shows the user the actual sanitized tag a group will render as. The `{name}` token is shown with
// the waifu's display name (the backend substitutes the sanitized waifu tag, so the leaf differs
// only in casing for that token).
export function previewGroupTag(tag: string, waifuName: string): string {
  const substituted = tag.replace(/\{name\}/g, waifuName);
  const normalized = substituted
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `waifu_${normalized || "unknown"}`;
}

export const blockDndId = (blockId: string) => `block:${blockId}`;
export const groupDndId = (groupId: string) => `group:${groupId}`;
export const sectionDndId = (section: PromptSectionKey) => `section:${section}`;

export type ContainerRef = { kind: "section"; section: PromptSectionKey } | { kind: "group"; groupId: string };
export type BlockLocation = { ref: ContainerRef; index: number };

type GroupNode = Extract<PromptLayoutNode, { kind: "group" }>;

export function cloneLayout(layout: WaifuPromptLayout): WaifuPromptLayout {
  const cloneNode = (node: PromptLayoutNode): PromptLayoutNode =>
    node.kind === "block" ? { ...node } : { ...node, children: node.children.map((child) => ({ ...child })) };
  return {
    top: layout.top.map(cloneNode),
    mid: layout.mid.map(cloneNode),
    trailing: layout.trailing.map(cloneNode)
  };
}

export function findGroupLocation(
  layout: WaifuPromptLayout,
  groupId: string
): { section: PromptSectionKey; index: number } | undefined {
  for (const section of SECTIONS) {
    const index = layout[section].findIndex((node) => node.kind === "group" && node.id === groupId);
    if (index >= 0) return { section, index };
  }
  return undefined;
}

export function findBlock(layout: WaifuPromptLayout, blockId: string): BlockLocation | undefined {
  for (const section of SECTIONS) {
    const list = layout[section];
    for (let i = 0; i < list.length; i += 1) {
      const node = list[i];
      if (node.kind === "block" && node.blockId === blockId) {
        return { ref: { kind: "section", section }, index: i };
      }
      if (node.kind === "group") {
        const childIndex = node.children.findIndex((child) => child.blockId === blockId);
        if (childIndex >= 0) return { ref: { kind: "group", groupId: node.id }, index: childIndex };
      }
    }
  }
  return undefined;
}

function sameRef(a: ContainerRef, b: ContainerRef): boolean {
  if (a.kind === "section" && b.kind === "section") return a.section === b.section;
  if (a.kind === "group" && b.kind === "group") return a.groupId === b.groupId;
  return false;
}

function removeBlockAt(layout: WaifuPromptLayout, loc: BlockLocation): PromptLayoutBlockNode {
  if (loc.ref.kind === "section") {
    return layout[loc.ref.section].splice(loc.index, 1)[0] as PromptLayoutBlockNode;
  }
  const groupLoc = findGroupLocation(layout, loc.ref.groupId)!;
  const group = layout[groupLoc.section][groupLoc.index] as GroupNode;
  return group.children.splice(loc.index, 1)[0];
}

function insertBlockAt(
  layout: WaifuPromptLayout,
  ref: ContainerRef,
  index: number,
  node: PromptLayoutBlockNode
): void {
  if (ref.kind === "section") {
    layout[ref.section].splice(index, 0, node);
    return;
  }
  const groupLoc = findGroupLocation(layout, ref.groupId);
  if (!groupLoc) return;
  (layout[groupLoc.section][groupLoc.index] as GroupNode).children.splice(index, 0, node);
}

// Resolve a drop destination from the id of whatever the cursor is over (a block, a group, or a
// section). Returns the target container and the index to insert at.
export function resolveTarget(layout: WaifuPromptLayout, overId: string): BlockLocation | undefined {
  if (overId.startsWith("section:")) {
    const section = overId.slice("section:".length) as PromptSectionKey;
    return { ref: { kind: "section", section }, index: layout[section].length };
  }
  if (overId.startsWith("group:")) {
    const groupId = overId.slice("group:".length);
    const loc = findGroupLocation(layout, groupId);
    if (!loc) return undefined;
    const group = layout[loc.section][loc.index] as GroupNode;
    return { ref: { kind: "group", groupId }, index: group.children.length };
  }
  if (overId.startsWith("block:")) {
    return findBlock(layout, overId.slice("block:".length));
  }
  return undefined;
}

// Move a block to a new container/index, returning a new layout (input is not mutated). Adjusts
// the index when reordering within the same container so the block lands where the cursor is.
export function moveBlock(layout: WaifuPromptLayout, blockId: string, target: BlockLocation): WaifuPromptLayout {
  const next = cloneLayout(layout);
  const source = findBlock(next, blockId);
  if (!source) return layout;
  const node = removeBlockAt(next, source);
  let index = target.index;
  if (sameRef(source.ref, target.ref) && source.index < target.index) index -= 1;
  insertBlockAt(next, target.ref, index, node);
  return next;
}

export function setBlockEnabled(layout: WaifuPromptLayout, blockId: string, enabled: boolean): WaifuPromptLayout {
  const next = cloneLayout(layout);
  const loc = findBlock(next, blockId);
  if (!loc) return layout;
  if (loc.ref.kind === "section") {
    (next[loc.ref.section][loc.index] as PromptLayoutBlockNode).enabled = enabled;
  } else {
    const groupLoc = findGroupLocation(next, loc.ref.groupId)!;
    (next[groupLoc.section][groupLoc.index] as GroupNode).children[loc.index].enabled = enabled;
  }
  return next;
}

export function setGroupEnabled(layout: WaifuPromptLayout, groupId: string, enabled: boolean): WaifuPromptLayout {
  const next = cloneLayout(layout);
  const loc = findGroupLocation(next, groupId);
  if (!loc) return layout;
  (next[loc.section][loc.index] as GroupNode).enabled = enabled;
  return next;
}

export function setGroupTag(layout: WaifuPromptLayout, groupId: string, tag: string): WaifuPromptLayout {
  const next = cloneLayout(layout);
  const loc = findGroupLocation(next, groupId);
  if (!loc) return layout;
  (next[loc.section][loc.index] as GroupNode).tag = tag;
  return next;
}

export function moveGroup(layout: WaifuPromptLayout, groupId: string, direction: -1 | 1): WaifuPromptLayout {
  const loc = findGroupLocation(layout, groupId);
  if (!loc) return layout;
  const target = loc.index + direction;
  if (target < 0 || target >= layout[loc.section].length) return layout;
  const next = cloneLayout(layout);
  const arr = next[loc.section];
  [arr[loc.index], arr[target]] = [arr[target], arr[loc.index]];
  return next;
}

// Remove a group and drop its children back into the section at the group's position, so no blocks
// are lost when a group is dissolved.
export function deleteGroup(layout: WaifuPromptLayout, groupId: string): WaifuPromptLayout {
  const loc = findGroupLocation(layout, groupId);
  if (!loc) return layout;
  const next = cloneLayout(layout);
  const group = next[loc.section][loc.index] as GroupNode;
  next[loc.section].splice(loc.index, 1, ...group.children);
  return next;
}

export function addGroup(layout: WaifuPromptLayout, section: PromptSectionKey): WaifuPromptLayout {
  const groupId = `custom-${Math.random().toString(36).slice(2, 8)}`;
  const next = cloneLayout(layout);
  next[section].push({ kind: "group", id: groupId, tag: "custom_group", enabled: true, children: [] });
  return next;
}

// Append any registry block missing from the layout (disabled) to its default section, so newly
// added blocks always show up in the editor. Mirrors reconcileWaifuPromptLayout() on the backend.
export function reconcileLayout(layout: WaifuPromptLayout): WaifuPromptLayout {
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
  for (const meta of PROMPT_BLOCK_META) {
    if (present.has(meta.id)) continue;
    next[meta.defaultSection].push({ kind: "block", blockId: meta.id, enabled: false });
  }
  return next;
}
