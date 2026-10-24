// `/print life` (Living cast §10.4, D14): the owner sees her last 20 log lines, but nothing a DM
// said: DM tool results and DM send arguments are redacted, and so is every quoted part of a
// notification line about a DM, in a turn's notification block or folded into a tool result.
import { afterEach, describe, expect, it } from "vitest";
import { appendLifeLog, updateLifeState } from "../src/life/lifeStore.js";
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
});
