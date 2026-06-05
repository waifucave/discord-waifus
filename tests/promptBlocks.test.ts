import { describe, expect, it } from "vitest";
import {
  PromptBlockContext,
  assembleWaifuPrompt,
  reconcileWaifuPromptLayout,
  resolveGroupTag
} from "../src/orchestration/promptBlocks.js";
import { WaifuPromptLayout, defaultWaifuPromptLayout } from "../src/shared/schemas/domain.js";

function ctx(overrides: Partial<PromptBlockContext> = {}): PromptBlockContext {
  return {
    waifuTag: "yuki",
    displayName: "Yuki",
    personalityContent: "You are Yuki. Stay in character.\nkind",
    scheduleContent: "schedule-body",
    toolUseInstructions: undefined,
    activeParticipantDisplayNames: ["Kevin"],
    emojiList: ":cat:",
    memoryLines: ["- remembers tea"],
    currentlyDoing: undefined,
    sceneDirection: "answer Kevin",
    ...overrides
  };
}

describe("assembleWaifuPrompt", () => {
  it("renders the default layout into the three slots with the behavior group", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx());

    // top: identity, then a <yuki_behavior> group whose first children are personality + schedule.
    expect(parts.systemPrompt).toMatch(
      /^<yuki_identity>\nYou are acting as Yuki[\s\S]*<\/yuki_identity>\n<yuki_behavior>\n<yuki_personality>[\s\S]*<\/yuki_personality>\n<yuki_shedule>\nschedule-body\n<\/yuki_shedule>/
    );
    expect(parts.systemPrompt).toMatch(/<\/yuki_behavior>$/);
    // toolUse is omitted when there are no instructions.
    expect(parts.systemPrompt).not.toContain("<tool_use>");

    expect(parts.midSystemBlock).toMatch(
      /^<director_notes>[\s\S]*<\/director_notes>\n<active_chat_participants>\n- Kevin\n<\/active_chat_participants>\n<server_emojis>\n:cat:\n<\/server_emojis>$/
    );

    expect(parts.trailingSystemBlock).toContain(
      "<yuki_relevant_memories>\n- remembers tea\n</yuki_relevant_memories>"
    );
    expect(parts.trailingSystemBlock).toContain("<yuki_personality>");
    expect(parts.trailingSystemBlock).toContain("<scene_direction>answer Kevin</scene_direction>");
    expect(parts.trailingSystemBlock).not.toContain("<currently_doing>");
  });

  it("includes <tool_use> only when instructions are present", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx({ toolUseInstructions: "use tools" }));
    expect(parts.systemPrompt).toContain("<tool_use>\nuse tools\n</tool_use>");
  });

  it("lets a block move into another section inside a custom group, and skips disabled blocks", () => {
    const layout: WaifuPromptLayout = {
      top: [{ kind: "block", blockId: "identity", enabled: true }],
      mid: [],
      trailing: [
        {
          kind: "group",
          id: "rules",
          tag: "house_rules",
          enabled: true,
          children: [
            { kind: "block", blockId: "hardRules", enabled: true },
            { kind: "block", blockId: "mentionPolicy", enabled: false }
          ]
        }
      ]
    };
    const parts = assembleWaifuPrompt(layout, ctx());

    expect(parts.systemPrompt).toBe(
      "<yuki_identity>\nYou are acting as Yuki in a discord server together with real people and other waifus\n</yuki_identity>"
    );
    expect(parts.midSystemBlock).toBe("");
    // hard_rules now lives inside the custom <house_rules> group in the trailing slot.
    expect(parts.trailingSystemBlock).toMatch(/^<house_rules>\n<hard_rules>[\s\S]*<\/hard_rules>\n<\/house_rules>$/);
    // Disabled mention_policy is omitted.
    expect(parts.trailingSystemBlock).not.toContain("<mention_policy>");
  });

  it("omits an empty group wrapper when every child is disabled", () => {
    const layout: WaifuPromptLayout = {
      top: [
        {
          kind: "group",
          id: "behavior",
          tag: "{name}_behavior",
          enabled: true,
          children: [{ kind: "block", blockId: "hardRules", enabled: false }]
        }
      ],
      mid: [],
      trailing: []
    };
    expect(assembleWaifuPrompt(layout, ctx()).systemPrompt).toBe("");
  });
});

describe("resolveGroupTag", () => {
  it("substitutes {name} and sanitizes user-entered tags", () => {
    expect(resolveGroupTag("{name}_behavior", "yuki")).toBe("yuki_behavior");
    expect(resolveGroupTag("My Custom Group!", "yuki")).toBe("my_custom_group");
  });
});

describe("reconcileWaifuPromptLayout", () => {
  it("appends missing registry blocks (disabled) to their default section", () => {
    const layout: WaifuPromptLayout = {
      top: [{ kind: "block", blockId: "identity", enabled: true }],
      mid: [],
      trailing: []
    };
    const reconciled = reconcileWaifuPromptLayout(layout);

    const hardRules = reconciled.top.find((node) => node.kind === "block" && node.blockId === "hardRules");
    expect(hardRules).toMatchObject({ enabled: false });
    const directorNotes = reconciled.mid.find((node) => node.kind === "block" && node.blockId === "directorNotes");
    expect(directorNotes).toMatchObject({ enabled: false });
    const sceneDirection = reconciled.trailing.find(
      (node) => node.kind === "block" && node.blockId === "sceneDirection"
    );
    expect(sceneDirection).toMatchObject({ enabled: false });

    // The already-present identity block is left untouched (not duplicated, still enabled).
    expect(reconciled.top.filter((node) => node.kind === "block" && node.blockId === "identity")).toHaveLength(1);
  });
});
