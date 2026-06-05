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

  it("moves a block from the behavior group into another section", () => {
    const layout = defaultWaifuPromptLayout();
    const next = moveBlock(layout, "hardRules", resolveTarget(layout, "section:trailing")!);

    expect(groupChildIds(next, "behavior")).not.toContain("hardRules");
    expect(findBlock(next, "hardRules")).toMatchObject({ ref: { kind: "section", section: "trailing" } });
    // The original layout is untouched (pure function).
    expect(groupChildIds(layout, "behavior")).toContain("hardRules");
  });

  it("reorders within a section with correct index adjustment", () => {
    const layout = defaultWaifuPromptLayout();
    // Drop identity onto the section drop zone -> append; since it started first, it lands last.
    const next = moveBlock(layout, "identity", resolveTarget(layout, "section:top")!);
    expect(sectionIds(next.top)).toEqual(["group:behavior", "identity"]);
  });

  it("drops a block into a group when hovering the group", () => {
    const layout = defaultWaifuPromptLayout();
    const next = moveBlock(layout, "directorNotes", resolveTarget(layout, "group:behavior")!);
    expect(groupChildIds(next, "behavior")).toContain("directorNotes");
    expect(next.mid.some((node) => node.kind === "block" && node.blockId === "directorNotes")).toBe(false);
  });

  it("resolves drop targets from section, group, and block ids", () => {
    const layout = defaultWaifuPromptLayout();
    expect(resolveTarget(layout, "section:mid")).toMatchObject({
      ref: { kind: "section", section: "mid" },
      index: layout.mid.length
    });
    expect(resolveTarget(layout, "group:behavior")).toMatchObject({ ref: { kind: "group", groupId: "behavior" } });
    expect(resolveTarget(layout, "block:identity")).toMatchObject({ ref: { kind: "section", section: "top" }, index: 0 });
  });

  it("ungroups children back into the section when a group is deleted", () => {
    const layout = defaultWaifuPromptLayout();
    const next = deleteGroup(layout, "behavior");
    expect(next.top.some((node) => node.kind === "group")).toBe(false);
    // identity stays first, then the former group children inline.
    expect(next.top[0]).toMatchObject({ kind: "block", blockId: "identity" });
    expect(sectionIds(next.top)).toEqual([
      "identity",
      "personality",
      "schedule",
      "contextStructure",
      "environment",
      "replyTargeting",
      "mentionPolicy",
      "styleConstraints",
      "hardRules",
      "toolUse"
    ]);
  });

  it("toggles a nested block's enabled flag in place", () => {
    const layout = defaultWaifuPromptLayout();
    const next = setBlockEnabled(layout, "hardRules", false);
    const loc = findBlock(next, "hardRules");
    expect(loc?.ref).toMatchObject({ kind: "group", groupId: "behavior" });
    const group = next.top.find((node) => node.kind === "group");
    const hardRules = group?.kind === "group" ? group.children.find((c) => c.blockId === "hardRules") : undefined;
    expect(hardRules?.enabled).toBe(false);
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
    const hardRules = reconciled.top.find((node) => node.kind === "block" && node.blockId === "hardRules");
    expect(hardRules).toMatchObject({ enabled: false });
    const sceneDirection = reconciled.trailing.find(
      (node) => node.kind === "block" && node.blockId === "sceneDirection"
    );
    expect(sceneDirection).toMatchObject({ enabled: false });
  });
});
