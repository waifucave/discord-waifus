// `/print life` (Living cast §10.4, D14): the owner sees her last 20 log lines, but nothing a DM
// said: DM tool results and DM send arguments are redacted, and so is every quoted part of a
// notification line about a DM, in a turn's notification block or folded into a tool result.
import { afterEach, describe, expect, it } from "vitest";
import { appendLifeLog, updateLifeState } from "../src/life/lifeStore.js";
import { printSystemPromptText, scanDmContent, viewLogLine } from "../src/life/lifeView.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { closeWorlds, lifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const AT = "2026-10-24T14:00:00.000Z";
const line = (seq: number, kind: LifeLogLine["kind"], message: Record<string, unknown>): LifeLogLine => ({ seq, at: AT, kind, turnId: "t1", message });

describe("/print life", () => {
  it("redacts DM previews, DM reads and DM sends, and keeps room content", async () => {
    const w = await lifeWorld(roots, {});
    await updateLifeState(w.storage, "aria", (state) => ({ ...state, epoch: 1 }));
    await appendLifeLog(w.storage, "aria", 1, [
      line(0, "notifications", {
        role: "user",
        content: [
          {
            type: "text",
            text: '<notifications>\n- dm · dm/kevin · from Kevin · 2 unread · "my divorce papers came today"\n- mention · bake-club/#general · from Mina · "are you coming saturday?"\n- +3 more from Kevin (dm/kevin)\n</notifications>'
          }
        ]
      }),
      line(1, "assistant", {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "read_messages", input: { place: "dm/kevin" } },
          { type: "tool_use", id: "c2", name: "send_message", input: { place: "bake-club/#general", text: "yes! lemon tarts" } },
          { type: "tool_use", id: "c3", name: "send_message", input: { place: "dm/kevin", text: "I'm so sorry about the divorce" } }
        ]
      }),
      line(2, "tool_results", {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "dm/kevin (DM with Kevin)\n[14:00 #a0] Kevin: my divorce papers came today" },
          { type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: 'sent #a2\n<notifications>\n- dm · dm/kevin · from Kevin · "also my lawyer called"\n</notifications>' }] },
          { type: "tool_result", tool_use_id: "c3", content: "sent #a3" }
        ]
      })
    ]);
    const printed = await w.cast.printLife("aria");
    expect(printed).not.toContain("divorce");
    expect(printed).not.toContain("lawyer");
    expect(printed).toContain("dm · dm/kevin · from Kevin · 2 unread");
    expect(printed).toContain('"are you coming saturday?"');
    expect(printed).toContain("yes! lemon tarts");
    expect(printed).toContain("read_messages([private chat redacted])");
    expect(printed).toContain("send_message([private chat redacted])");
    expect(printed).toContain("result: sent #a2");
  });

  it("redacts her own text in a turn that touched a DM, and shows everything with private", async () => {
    const w = await lifeWorld(roots, {});
    await updateLifeState(w.storage, "aria", (state) => ({ ...state, epoch: 1 }));
    await appendLifeLog(w.storage, "aria", 1, [
      line(0, "notifications", { role: "user", content: [{ type: "text", text: '<notifications>\n- dm · dm/kevin · from Kevin · "my exam is tomorrow"\n</notifications>' }] }),
      line(1, "assistant", {
        role: "assistant",
        content: [
          { type: "text", text: "Kevin is nervous about the exam, I should cheer him up" },
          { type: "tool_use", id: "c1", name: "SomeFutureTool", input: { target: { where: "dm/kevin" }, body: "good luck tomorrow!" } }
        ]
      }),
      line(2, "tool_results", { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] }),
      { seq: 3, at: AT, kind: "notifications", turnId: "t2", message: { role: "user", content: [{ type: "text", text: '- mention · bake-club/#general · from Mina · "cake?"' }] } },
      { seq: 4, at: AT, kind: "assistant", turnId: "t2", message: { role: "assistant", content: [{ type: "text", text: "Mina wants cake" }] } }
    ]);
    const printed = await w.cast.printLife("aria");
    expect(printed).not.toContain("nervous");
    expect(printed).not.toContain("good luck");
    expect(printed).not.toContain("exam");
    expect(printed).toContain("SomeFutureTool([private chat redacted])");
    expect(printed).toContain("Mina wants cake");
    const open = await w.cast.printLife("aria", { private: true });
    expect(open).toContain("Kevin is nervous about the exam");
    expect(open).toContain("good luck tomorrow!");
    expect(open).toContain('"my exam is tomorrow"');
  });

  it("hides her summary in /print system_prompt unless private", async () => {
    const w = await lifeWorld(roots, {});
    const state = await updateLifeState(w.storage, "aria", (current) => ({
      ...current,
      summary: "Kevin told me in DMs about his divorce.",
      systemSnapshot: { harnessHash: "h", harness: "<life>block A</life>", memoryIndex: "# Memory", places: "- bake-club/#general", tools: [] }
    }));
    const hidden = printSystemPromptText(state, { private: false });
    expect(hidden).toContain("<life>block A</life>");
    expect(hidden).not.toContain("divorce");
    expect(hidden).toContain("[private chat redacted]");
    expect(await w.cast.printSystemPrompt("aria")).toBe(hidden);
    expect(await w.cast.printSystemPrompt("aria", { private: true })).toContain("divorce");
  });

  it("the dashboard view marks DM turns and counts what it left out", () => {
    const lines: LifeLogLine[] = [
      line(0, "assistant", { role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" }, { type: "tool_use", id: "r1", name: "read", input: { place: "dm_300000000000000003_aria" } }] }),
      line(1, "tool_results", { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "Kevin: hi" }] })
    ];
    const scan = scanDmContent(lines);
    const first = viewLogLine(lines[0]!, scan, { includePrivate: false });
    expect(first.view.dm).toBe(true);
    expect(first.view.blocks).toEqual([{ type: "reasoning" }, { type: "tool_use", id: "r1", name: "read", redacted: true }]);
    expect(JSON.stringify(first.view)).not.toContain("sig");
    const second = viewLogLine(lines[1]!, scan, { includePrivate: false });
    expect(second.redacted).toBe(1);
    expect(viewLogLine(lines[1]!, scan, { includePrivate: true }).view.blocks[0]).toMatchObject({ text: "Kevin: hi" });
  });
});
