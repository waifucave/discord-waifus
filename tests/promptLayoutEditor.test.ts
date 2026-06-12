import { describe, expect, it } from "vitest";
import { defaultWaifuPromptLayout as backendDefaultLayout } from "../src/shared/schemas/domain.js";
import { resolveGroupTag } from "../src/orchestration/promptBlocks.js";
import type { PromptLayoutNode, WaifuPromptLayout } from "../src/frontend/api/types";
import {
  addGroup,
  defaultWaifuPromptLayout,
  deleteGroup,
  findBlock,
  moveBlock,
  previewGroupTag,
  reconcileLayout,
  resolveTarget,
  setBlockEnabled
} from "../src/frontend/utils/promptLayout.js";

const groupChildIds = (layout: WaifuPromptLayout, groupId: string): string[] => {
  const group = [...layout.top, ...layout.mid, ...layout.trailing].find(
    (node): node is Extract<PromptLayoutNode, { kind: "group" }> => node.kind === "group" && node.id === groupId
  );
  return group ? group.children.map((child) => child.blockId) : [];
};

const sectionIds = (nodes: PromptLayoutNode[]): string[] =>
  nodes.map((node) => (node.kind === "block" ? node.blockId : `group:${node.id}`));

describe("prompt layout editor helpers", () => {
  it("keeps the frontend default layout in sync with the backend default", () => {
    expect(defaultWaifuPromptLayout()).toEqual(backendDefaultLayout());
  });

  it("moves a block from the top section into trailing", () => {
    const layout = defaultWaifuPromptLayout();
    const next = moveBlock(layout, "outputContract", resolveTarget(layout, "section:trailing")!);

    expect(findBlock(next, "outputContract")).toMatchObject({ ref: { kind: "section", section: "trailing" } });
    // The original layout is untouched (pure function).
    expect(findBlock(layout, "outputContract")).toMatchObject({ ref: { kind: "section", section: "top" } });
  });

  it("reorders within a section with correct index adjustment", () => {
    const layout = defaultWaifuPromptLayout();
    // Drop identity onto the section drop zone -> append; since it started first, it lands last.
    const next = moveBlock(layout, "identity", resolveTarget(layout, "section:top")!);
    expect(sectionIds(next.top)).toEqual(["persona", "schedule", "ioFormat", "tools", "outputContract", "identity"]);
  });

  it("drops a block into a group when hovering the group", () => {
    const layout: WaifuPromptLayout = {
      top: [
        { kind: "block", blockId: "identity", enabled: true },
        {
          kind: "group",
          id: "behavior",
          tag: "{name}_behavior",
          enabled: true,
          children: [{ kind: "block", blockId: "persona", enabled: true }]
        }
      ],
      mid: [{ kind: "block", blockId: "roomInfo", enabled: true }],
      trailing: []
    };
    const next = moveBlock(layout, "roomInfo", resolveTarget(layout, "group:behavior")!);
    expect(groupChildIds(next, "behavior")).toContain("roomInfo");
    expect(next.mid.some((node) => node.kind === "block" && node.blockId === "roomInfo")).toBe(false);
  });

  it("resolves drop targets from section, group, and block ids", () => {
    const layout = defaultWaifuPromptLayout();
    expect(resolveTarget(layout, "section:mid")).toMatchObject({
      ref: { kind: "section", section: "mid" },
      index: layout.mid.length
    });
    expect(resolveTarget(layout, "block:identity")).toMatchObject({ ref: { kind: "section", section: "top" }, index: 0 });
    expect(resolveTarget(layout, "block:roomInfo")).toMatchObject({ ref: { kind: "section", section: "mid" }, index: 0 });
  });

  it("ungroups children back into the section when a group is deleted", () => {
    // Build a layout with a group in top.
    const layout: WaifuPromptLayout = {
      top: [
        { kind: "block", blockId: "identity", enabled: true },
        {
          kind: "group",
          id: "behavior",
          tag: "{name}_behavior",
          enabled: true,
          children: [
            { kind: "block", blockId: "persona", enabled: true },
            { kind: "block", blockId: "outputContract", enabled: true }
          ]
        }
      ],
      mid: [],
      trailing: []
    };
    const next = deleteGroup(layout, "behavior");
    expect(next.top.some((node) => node.kind === "group")).toBe(false);
    // identity stays first, then the former group children inline.
    expect(next.top[0]).toMatchObject({ kind: "block", blockId: "identity" });
    expect(sectionIds(next.top)).toEqual(["identity", "persona", "outputContract"]);
  });

  it("toggles a top-level block's enabled flag in place", () => {
    const layout = defaultWaifuPromptLayout();
    const next = setBlockEnabled(layout, "outputContract", false);
    const loc = findBlock(next, "outputContract");
    expect(loc?.ref).toMatchObject({ kind: "section", section: "top" });
    const block = next.top.find((node) => node.kind === "block" && node.blockId === "outputContract");
    expect(block?.kind === "block" && block.enabled).toBe(false);
  });

  it("adds an empty custom group to a section", () => {
    const layout = defaultWaifuPromptLayout();
    const next = addGroup(layout, "mid");
    const groups = next.mid.filter((node) => node.kind === "group");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "group", enabled: true, children: [] });
  });

  it("previews a group tag the same way the backend sanitizes it", () => {
    expect(previewGroupTag("My Rules!", "Yuki")).toBe("my_rules");
    expect(previewGroupTag("custom_group", "Yuki")).toBe("custom_group");
    // For tags without {name}, the preview must match the backend's resolveGroupTag exactly.
    expect(previewGroupTag("My Rules!", "yuki")).toBe(resolveGroupTag("My Rules!", "yuki"));
  });

  it("reconciles a partial layout by appending missing blocks (disabled)", () => {
    const partial: WaifuPromptLayout = {
      top: [{ kind: "block", blockId: "identity", enabled: true }],
      mid: [],
      trailing: []
    };
    const reconciled = reconcileLayout(partial);
    const outputContract = reconciled.top.find((node) => node.kind === "block" && node.blockId === "outputContract");
    expect(outputContract).toMatchObject({ enabled: false });
    const directorNote = reconciled.trailing.find(
      (node) => node.kind === "block" && node.blockId === "directorNote"
    );
    expect(directorNote).toMatchObject({ enabled: false });
  });

  it("tools block uses blockId 'tools' (not 'toolUse') — onToolsChange callback contract", () => {
    // BlockCard routes blockId === "tools" through onToolsChange (waifu.tools.toolUse),
    // while every other block flips its own node.enabled. Verify the block id in the default
    // layout and after setBlockEnabled so the routing constant in the component stays in sync.
    const layout = defaultWaifuPromptLayout();
    const toolsBlock = layout.top.find((node) => node.kind === "block" && node.blockId === "tools");
    // The tools block must exist under the id "tools", not "toolUse".
    expect(toolsBlock).toBeDefined();
    expect(toolsBlock).toMatchObject({ kind: "block", blockId: "tools" });
    // setBlockEnabled on "tools" must not throw and must produce a layout that still has the block.
    const next = setBlockEnabled(layout, "tools", false);
    const afterToggle = next.top.find((node) => node.kind === "block" && node.blockId === "tools");
    expect(afterToggle).toMatchObject({ kind: "block", blockId: "tools", enabled: false });
    // Confirm no block with the old stale id "toolUse" exists anywhere in the layout.
    const allBlocks = [...layout.top, ...layout.mid, ...layout.trailing].filter(
      (node): node is Extract<PromptLayoutNode, { kind: "block" }> => node.kind === "block"
    );
    expect(allBlocks.some((node) => node.blockId === "toolUse")).toBe(false);
  });
});
