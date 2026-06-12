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
    personalityContent: "kind",
    scheduleContent: "schedule-body",
    toolUseInstructions: undefined,
    activeParticipantDisplayNames: ["Kevin"],
    rosterLine: "Aria, Mika",
    emojiList: ":cat:",
    memoryLines: ["- remembers tea"],
    currentlyDoing: undefined,
    directorNote: "answer Kevin",
    ...overrides
  };
}

describe("assembleWaifuPrompt", () => {
  it("renders the default layout into the three slots", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx());

    // top: identity block
    expect(parts.systemPrompt).toMatch(
      /^<yuki_identity>\nYou are Yuki, chatting in a live Discord text channel together with real people and these other characters: Aria, Mika\. Each of them writes her own messages — you write only yours\. This is a real chat room, not a roleplay scene or story\.\n<\/yuki_identity>/
    );
    // top: persona block
    expect(parts.systemPrompt).toContain("<yuki_persona>\nkind\n</yuki_persona>");
    // top: schedule block (tag is now _schedule, not _shedule)
    expect(parts.systemPrompt).toContain("<yuki_schedule>\nschedule-body\n</yuki_schedule>");
    expect(parts.systemPrompt).not.toContain("<yuki_shedule>");
    // top: ioFormat block
    expect(parts.systemPrompt).toContain("<io_format>");
    expect(parts.systemPrompt).toContain("DisplayName: <body>");
    // top: outputContract block (last in top)
    expect(parts.systemPrompt).toContain("<output_contract>");
    expect(parts.systemPrompt).toMatch(/<\/output_contract>$/);
    // toolUse is omitted when there are no instructions.
    expect(parts.systemPrompt).not.toContain("<tool_use>");

    // mid: roomInfo combines participants + emojis
    expect(parts.midSystemBlock).toMatch(
      /^<room_info>\n<active_chat_participants>\n- Kevin\n<\/active_chat_participants>\n<server_emojis>\n:cat:\n<\/server_emojis>\n<\/room_info>$/
    );

    // trailing: memories
    expect(parts.trailingSystemBlock).toContain(
      "<yuki_relevant_memories>\n- remembers tea\n</yuki_relevant_memories>"
    );
    // trailing: anchor (not full persona duplicate)
    expect(parts.trailingSystemBlock).toContain("<yuki_anchor>");
    expect(parts.trailingSystemBlock).toContain("You are Yuki.");
    expect(parts.trailingSystemBlock).not.toContain("<yuki_persona>");
    // trailing: directorNote
    expect(parts.trailingSystemBlock).toContain(
      "<director_note>\nDirector's goal for this one message: answer Kevin\nPursue the goal in your own voice and words; never quote or restate this note.\n</director_note>"
    );
    expect(parts.trailingSystemBlock).not.toContain("<currently_doing>");
  });

  it("includes <tool_use> only when instructions are present", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx({ toolUseInstructions: "use tools" }));
    expect(parts.systemPrompt).toContain("<tool_use>\nuse tools\n</tool_use>");
  });

  it("omits persona block when personalityContent is empty", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx({ personalityContent: "" }));
    expect(parts.systemPrompt).not.toContain("<yuki_persona>");
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
            { kind: "block", blockId: "outputContract", enabled: true },
            { kind: "block", blockId: "ioFormat", enabled: false }
          ]
        }
      ]
    };
    const parts = assembleWaifuPrompt(layout, ctx());

    expect(parts.systemPrompt).toBe(
      "<yuki_identity>\nYou are Yuki, chatting in a live Discord text channel together with real people and these other characters: Aria, Mika. Each of them writes her own messages — you write only yours. This is a real chat room, not a roleplay scene or story.\n</yuki_identity>"
    );
    expect(parts.midSystemBlock).toBe("");
    // outputContract now lives inside the custom <house_rules> group in the trailing slot.
    expect(parts.trailingSystemBlock).toMatch(/^<house_rules>\n<output_contract>[\s\S]*<\/output_contract>\n<\/house_rules>$/);
    // Disabled ioFormat is omitted.
    expect(parts.trailingSystemBlock).not.toContain("<io_format>");
  });

  it("omits an empty group wrapper when every child is disabled", () => {
    const layout: WaifuPromptLayout = {
      top: [
        {
          kind: "group",
          id: "behavior",
          tag: "{name}_behavior",
          enabled: true,
          children: [{ kind: "block", blockId: "outputContract", enabled: false }]
        }
      ],
      mid: [],
      trailing: []
    };
    expect(assembleWaifuPrompt(layout, ctx()).systemPrompt).toBe("");
  });
});

describe("identity block", () => {
  it("includes server nickname clause when serverNickname differs from displayName", () => {
    const parts = assembleWaifuPrompt(
      defaultWaifuPromptLayout(),
      ctx({ serverNickname: "K的小娇妻" })
    );
    expect(parts.systemPrompt).toContain(`— shown in this server as "K的小娇妻"`);
  });

  it("omits server nickname clause when serverNickname is absent", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx());
    expect(parts.systemPrompt).not.toContain("shown in this server");
  });

  it("omits server nickname clause when serverNickname equals displayName", () => {
    const parts = assembleWaifuPrompt(
      defaultWaifuPromptLayout(),
      ctx({ serverNickname: "Yuki" })
    );
    expect(parts.systemPrompt).not.toContain("shown in this server");
  });
});

describe("anchor block", () => {
  it("uses first 200 chars of personalityContent as Voice when personaDigest is absent", () => {
    const longPersona = "A".repeat(250);
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx({ personalityContent: longPersona }));
    expect(parts.trailingSystemBlock).toContain(`Voice: ${"A".repeat(200)}`);
    expect(parts.trailingSystemBlock).not.toContain("A".repeat(201));
  });

  it("uses personaDigest.voice and renders Drives when personaDigest is provided", () => {
    const parts = assembleWaifuPrompt(
      defaultWaifuPromptLayout(),
      ctx({ personaDigest: { voice: "clingy gen-z texting", role: "K's attack dog" } })
    );
    expect(parts.trailingSystemBlock).toContain("Voice: clingy gen-z texting");
    expect(parts.trailingSystemBlock).toContain("Drives: K's attack dog");
  });

  it("omits Drives line when personaDigest has no role", () => {
    const parts = assembleWaifuPrompt(defaultWaifuPromptLayout(), ctx());
    expect(parts.trailingSystemBlock).not.toContain("Drives:");
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

    const outputContract = reconciled.top.find((node) => node.kind === "block" && node.blockId === "outputContract");
    expect(outputContract).toMatchObject({ enabled: false });
    const roomInfo = reconciled.mid.find((node) => node.kind === "block" && node.blockId === "roomInfo");
    expect(roomInfo).toMatchObject({ enabled: false });
    const directorNote = reconciled.trailing.find(
      (node) => node.kind === "block" && node.blockId === "directorNote"
    );
    expect(directorNote).toMatchObject({ enabled: false });

    // The already-present identity block is left untouched (not duplicated, still enabled).
    expect(reconciled.top.filter((node) => node.kind === "block" && node.blockId === "identity")).toHaveLength(1);
  });
});
