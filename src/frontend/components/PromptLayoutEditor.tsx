import { useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ChevronUp, ChevronDown, Plus, Ungroup } from "lucide-react";
import type {
  PromptLayoutBlockNode,
  PromptLayoutGroupNode,
  PromptLayoutNode,
  WaifuPromptLayout,
  WaifuToolSettings
} from "../api/types";
import {
  PROMPT_SECTION_LABELS,
  type PromptSectionKey,
  addGroup,
  blockDndId,
  blockLabel,
  blockMeta,
  deleteGroup,
  groupDndId,
  moveBlock,
  moveGroup,
  previewGroupTag,
  resolveTarget,
  sectionDndId,
  setBlockEnabled,
  setGroupEnabled,
  setGroupTag
} from "../utils/promptLayout";
import { Toggle } from "./Toggle";

const SECTIONS: PromptSectionKey[] = ["top", "mid", "trailing"];

// --- Editor ------------------------------------------------------------------------------------

export function PromptLayoutEditor({
  layout,
  tools,
  onLayoutChange,
  onToolsChange,
  waifuName
}: {
  layout: WaifuPromptLayout;
  tools: WaifuToolSettings;
  onLayoutChange: (next: WaifuPromptLayout) => void;
  onToolsChange: (next: WaifuToolSettings) => void;
  waifuName: string;
}) {
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>(undefined);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith("block:")) setActiveBlockId(id.slice("block:".length));
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveBlockId(undefined);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (!activeId.startsWith("block:") || activeId === overId) return;
    const blockId = activeId.slice("block:".length);
    const target = resolveTarget(layout, overId);
    if (!target) return;
    onLayoutChange(moveBlock(layout, blockId, target));
  };

  // Thin handlers over the pure layout helpers (see ../utils/promptLayout).
  const handleBlockEnabled = (blockId: string, enabled: boolean) =>
    onLayoutChange(setBlockEnabled(layout, blockId, enabled));
  const handleGroupEnabled = (groupId: string, enabled: boolean) =>
    onLayoutChange(setGroupEnabled(layout, groupId, enabled));
  const handleGroupTag = (groupId: string, tag: string) => onLayoutChange(setGroupTag(layout, groupId, tag));
  const handleMoveGroup = (groupId: string, direction: -1 | 1) =>
    onLayoutChange(moveGroup(layout, groupId, direction));
  const handleDeleteGroup = (groupId: string) => onLayoutChange(deleteGroup(layout, groupId));
  const handleAddGroup = (section: PromptSectionKey) => onLayoutChange(addGroup(layout, section));

  return (
    <section className="section">
      <div className="section-header">
        <h3 className="section-title">Character prompt layout</h3>
        <span className="section-description">
          Drag blocks to reorder them, move them between the three system messages, or in and out of
          groups. Toggle a block off to drop it from the prompt. Block wording is fixed; you control
          placement and grouping. PickNextWaifu and add_memory availability are server settings.
        </span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveBlockId(undefined)}
      >
        <div className="prompt-layout-lanes">
          {SECTIONS.map((section) => (
            <Lane
              key={section}
              section={section}
              nodes={layout[section]}
              tools={tools}
              waifuName={waifuName}
              onToolsChange={onToolsChange}
              onBlockEnabled={handleBlockEnabled}
              onGroupEnabled={handleGroupEnabled}
              onGroupTag={handleGroupTag}
              onMoveGroup={handleMoveGroup}
              onDeleteGroup={handleDeleteGroup}
              onAddGroup={() => handleAddGroup(section)}
            />
          ))}
        </div>
        <DragOverlay>
          {activeBlockId ? <CardShell label={blockLabel(activeBlockId).replace("{name}", waifuName)} dragging /> : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}

function Lane({
  section,
  nodes,
  tools,
  waifuName,
  onToolsChange,
  onBlockEnabled,
  onGroupEnabled,
  onGroupTag,
  onMoveGroup,
  onDeleteGroup,
  onAddGroup
}: {
  section: PromptSectionKey;
  nodes: PromptLayoutNode[];
  tools: WaifuToolSettings;
  waifuName: string;
  onToolsChange: (next: WaifuToolSettings) => void;
  onBlockEnabled: (blockId: string, enabled: boolean) => void;
  onGroupEnabled: (groupId: string, enabled: boolean) => void;
  onGroupTag: (groupId: string, tag: string) => void;
  onMoveGroup: (groupId: string, direction: -1 | 1) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddGroup: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: sectionDndId(section) });
  const meta = PROMPT_SECTION_LABELS[section];
  const itemIds = nodes.map((node) => (node.kind === "block" ? blockDndId(node.blockId) : groupDndId(node.id)));

  return (
    <div className="prompt-lane">
      <div className="prompt-lane-head">
        <span className="prompt-lane-title">{meta.title}</span>
        <span className="field-hint">{meta.hint}</span>
      </div>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="prompt-lane-body">
          {nodes.map((node, index) =>
            node.kind === "block" ? (
              <BlockCard
                key={node.blockId}
                node={node}
                tools={tools}
                waifuName={waifuName}
                onToolsChange={onToolsChange}
                onEnabled={onBlockEnabled}
              />
            ) : (
              <GroupCard
                key={node.id}
                group={node}
                tools={tools}
                waifuName={waifuName}
                isFirst={index === 0}
                isLast={index === nodes.length - 1}
                onToolsChange={onToolsChange}
                onBlockEnabled={onBlockEnabled}
                onGroupEnabled={onGroupEnabled}
                onGroupTag={onGroupTag}
                onMoveGroup={onMoveGroup}
                onDeleteGroup={onDeleteGroup}
              />
            )
          )}
          {nodes.length === 0 && <div className="prompt-lane-empty">Drop blocks here</div>}
        </div>
      </SortableContext>
      <button type="button" className="btn sm" onClick={onAddGroup}>
        <Plus className="icon" /> Add group
      </button>
    </div>
  );
}

function BlockCard({
  node,
  tools,
  waifuName,
  onToolsChange,
  onEnabled
}: {
  node: PromptLayoutBlockNode;
  tools: WaifuToolSettings;
  waifuName: string;
  onToolsChange: (next: WaifuToolSettings) => void;
  onEnabled: (blockId: string, enabled: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: blockDndId(node.blockId)
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const meta = blockMeta(node.blockId);
  const label = (meta?.label ?? `<${node.blockId}>`).replace("{name}", waifuName);

  // The tool-use block's real on/off lives in waifu.tools.toolUse (it gates the instruction text);
  // its layout node is positional only. Every other block toggles its own node.enabled.
  const isToolUse = node.blockId === "tools";
  const checked = isToolUse ? tools.toolUse : node.enabled;
  const onCheckedChange = (value: boolean) =>
    isToolUse ? onToolsChange({ ...tools, toolUse: value }) : onEnabled(node.blockId, value);

  return (
    <div ref={setNodeRef} style={style} className={`prompt-card${checked ? "" : " is-disabled"}`}>
      <button type="button" className="prompt-drag" {...attributes} {...listeners} aria-label="Drag block">
        <GripVertical className="icon" />
      </button>
      <div className="prompt-card-main">
        <code className="prompt-card-label">{label}</code>
        {meta?.hint && <span className="field-hint">{meta.hint}</span>}
      </div>
      <Toggle checked={checked} onChange={onCheckedChange} label="" />
    </div>
  );
}

function GroupCard({
  group,
  tools,
  waifuName,
  isFirst,
  isLast,
  onToolsChange,
  onBlockEnabled,
  onGroupEnabled,
  onGroupTag,
  onMoveGroup,
  onDeleteGroup
}: {
  group: PromptLayoutGroupNode;
  tools: WaifuToolSettings;
  waifuName: string;
  isFirst: boolean;
  isLast: boolean;
  onToolsChange: (next: WaifuToolSettings) => void;
  onBlockEnabled: (blockId: string, enabled: boolean) => void;
  onGroupEnabled: (groupId: string, enabled: boolean) => void;
  onGroupTag: (groupId: string, tag: string) => void;
  onMoveGroup: (groupId: string, direction: -1 | 1) => void;
  onDeleteGroup: (groupId: string) => void;
}) {
  // The group is a non-draggable sortable slot; its id doubles as the droppable for its children.
  const { setNodeRef, transform, transition } = useSortable({ id: groupDndId(group.id) });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const childIds = group.children.map((child) => blockDndId(child.blockId));
  const resolvedTag = previewGroupTag(group.tag, waifuName);

  // Keep the tag editable freely while typing, but commit a non-empty value on blur — the schema
  // requires a non-empty group tag, so an empty input would otherwise fail to save.
  const [tagDraft, setTagDraft] = useState(group.tag);
  useEffect(() => setTagDraft(group.tag), [group.tag]);
  const commitTag = () => {
    const next = tagDraft.trim() || "custom_group";
    if (next !== group.tag) onGroupTag(group.id, next);
    setTagDraft(next);
  };

  return (
    <div ref={setNodeRef} style={style} className={`prompt-group${group.enabled ? "" : " is-disabled"}`}>
      <div className="prompt-group-head">
        <code className="prompt-group-tag-prefix">&lt;</code>
        <input
          className="input prompt-group-tag-input"
          value={tagDraft}
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={commitTag}
          aria-label="Group tag"
          spellCheck={false}
        />
        <code className="prompt-group-tag-prefix">&gt;</code>
        <div className="prompt-group-actions">
          <button type="button" className="btn icon-btn" disabled={isFirst} onClick={() => onMoveGroup(group.id, -1)} aria-label="Move group up">
            <ChevronUp className="icon" />
          </button>
          <button type="button" className="btn icon-btn" disabled={isLast} onClick={() => onMoveGroup(group.id, 1)} aria-label="Move group down">
            <ChevronDown className="icon" />
          </button>
          <button type="button" className="btn danger icon-btn" onClick={() => onDeleteGroup(group.id)} aria-label="Ungroup">
            <Ungroup className="icon" />
          </button>
          <Toggle checked={group.enabled} onChange={(value) => onGroupEnabled(group.id, value)} label="" />
        </div>
      </div>
      <span className="field-hint">
        Renders as &lt;{resolvedTag}&gt;
        {group.tag.includes("{name}") && (
          <>
            {" "}
            (the <code>{"{name}"}</code> token becomes the character tag)
          </>
        )}
      </span>
      <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
        <div className="prompt-group-body">
          {group.children.map((child) => (
            <BlockCard
              key={child.blockId}
              node={child}
              tools={tools}
              waifuName={waifuName}
              onToolsChange={onToolsChange}
              onEnabled={onBlockEnabled}
            />
          ))}
          {group.children.length === 0 && <div className="prompt-lane-empty">Drop blocks into this group</div>}
        </div>
      </SortableContext>
    </div>
  );
}

function CardShell({ label, dragging }: { label: string; dragging?: boolean }) {
  return (
    <div className={`prompt-card${dragging ? " is-dragging" : ""}`}>
      <span className="prompt-drag">
        <GripVertical className="icon" />
      </span>
      <div className="prompt-card-main">
        <code className="prompt-card-label">{label}</code>
      </div>
    </div>
  );
}
