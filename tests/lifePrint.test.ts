// `/print life` and the dashboard view (Living cast §10.4, §14.4, D14): the owner sees her last 20 log
// lines, but nothing from a DM: in a DM turn every tool call, result and her own text is hidden;
// elsewhere a call that resolved to a DM place is hidden; notification lines about a DM lose
// everything from their first quote. The review's repros live here (DM place variants, a quote in a
// sender's name, a note with a line break, list_watches naming a DM, a web search in a DM turn).
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
          { type: "tool_use", id: "c1", name: "ReadMessages", input: { place: "dm/kevin" } },
          { type: "tool_use", id: "c2", name: "SendMessage", input: { place: "bake-club/#general", text: "yes! lemon tarts" } },
          { type: "tool_use", id: "c3", name: "SendMessage", input: { place: "dm/kevin", text: "I'm so sorry about the divorce" } }
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
    await appendLifeLog(w.storage, "aria", 1, [
      { seq: 3, at: AT, kind: "notifications", turnId: "t2", message: { role: "user", content: [{ type: "text", text: '<notifications>\n- mention · bake-club/#general · from Mina · "lemon or chocolate?"\n</notifications>' }] } },
      { seq: 4, at: AT, kind: "assistant", turnId: "t2", message: { role: "assistant", content: [{ type: "tool_use", id: "c4", name: "SendMessage", input: { place: "bake-club/#general", text: "lemon, always" } }] } },
      { seq: 5, at: AT, kind: "tool_results", turnId: "t2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c4", content: "sent #a4" }] } }
    ]);
    const printed = await w.cast.printLife("aria");
    expect(printed).not.toContain("divorce");
    expect(printed).not.toContain("lawyer");
    expect(printed).toContain("dm · dm/kevin · from Kevin · 2 unread");
    expect(printed).toContain('"are you coming saturday?"');
    // A DM turn hides every call, also its room send (spec §14.4).
    expect(printed).not.toContain("yes! lemon tarts");
    expect(printed).toContain("ReadMessages([private chat redacted])");
    expect(printed).toContain("SendMessage([private chat redacted])");
    expect(printed).not.toContain("result: sent #a2");
    // A room-only turn shows everything.
    expect(printed).toContain("lemon, always");
    expect(printed).toContain("result: sent #a4");
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

  it("hides every tool call and result of a DM turn, also a web search and notes (review: DM turns)", () => {
    const lines: LifeLogLine[] = [
      line(0, "notifications", { role: "user", content: [{ type: "text", text: '- dm · dm/kevin · from Kevin · "I failed my exam, dont tell anyone"' }] }),
      line(1, "assistant", { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "WebSearch", input: { query: "how to comfort a friend who failed his exam" } }] }),
      line(2, "tool_results", { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "results: 5 ways to comfort a friend who failed" }] })
    ];
    const scan = scanDmContent(lines);
    const shown = JSON.stringify(lines.map((entry) => viewLogLine(entry, scan, { includePrivate: false }).view));
    expect(shown).not.toContain("failed");
    expect(shown).toContain('"name":"WebSearch"');
  });

  it("decides on what the tools recorded: a recorded DM call is hidden, a recorded room call is shown", () => {
    const lines: LifeLogLine[] = [
      { ...line(0, "notifications", { role: "user", content: [{ type: "text", text: '- mention · bake-club/#general · from Mina · "dm_ me the recipe"' }] }), dmWakes: false },
      line(1, "assistant", { role: "assistant", content: [{ type: "tool_use", id: "a", name: "ReadMessages", input: { place: "bake-club/#general" } }, { type: "tool_use", id: "b", name: "Recall", input: { topic: "Kevin" } }] }),
      { ...line(2, "tool_results", { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "Mina: dm_ me the recipe" }, { type: "tool_result", tool_use_id: "b", content: "Kevin's secret" }] }), dmCalls: ["b"] }
    ];
    const scan = scanDmContent(lines);
    expect([...scan.dmCalls]).toEqual(["b"]);
    // A call that resolved to a DM place makes the whole turn private.
    expect(scan.dmTurns.has("t1")).toBe(true);
    const shown = JSON.stringify(lines.map((entry) => viewLogLine(entry, scan, { includePrivate: false }).view));
    expect(shown).not.toContain("secret");
    const room: LifeLogLine[] = [lines[0]!, { ...lines[1]!, message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "ReadMessages", input: { place: "bake-club/#general" } }] } }, { ...lines[2]!, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "Mina: dm_ me the recipe" }] }, dmCalls: [] }];
    const roomScan = scanDmContent(room);
    expect(roomScan.dmTurns.size).toBe(0);
    expect(JSON.stringify(room.map((entry) => viewLogLine(entry, roomScan, { includePrivate: false }).view))).toContain("Mina: dm_ me the recipe");
  });

  it("an unrecorded call is matched the way resolvePlace reads places: any case, spaces, <…> (review I-1)", () => {
    for (const place of ["dm/kevin", "DM/kevin", "Dm/Kevin", " dm/kevin", "dm/kevin ", "<dm/kevin>", "\ndm/kevin", "dm_300000000000000003_aria"]) {
      const lines: LifeLogLine[] = [
        line(0, "notifications", { role: "user", content: [{ type: "text", text: '<notifications>\n- mention · bake-club/#general · from Mia · "aria??"\n</notifications>' }] }),
        line(1, "assistant", { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "ReadMessages", input: { place } }] }),
        line(2, "tool_results", { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "#k1 Kevin: my HIV test came back positive" }] }),
        line(3, "assistant", { role: "assistant", content: [{ type: "text", text: "Kevin trusted me." }, { type: "tool_use", id: "c2", name: "SendMessage", input: { place, text: "Your secret is safe." } }] })
      ];
      const scan = scanDmContent(lines);
      const shown = JSON.stringify(lines.map((entry) => viewLogLine(entry, scan, { includePrivate: false }).view));
      expect(shown, JSON.stringify(place)).not.toContain("HIV");
      expect(shown, JSON.stringify(place)).not.toContain("secret is safe");
      expect(shown, JSON.stringify(place)).not.toContain("trusted");
    }
  });

  it("a quote in a DM sender's name or a line break in a note never escapes the redaction (review I-2)", async () => {
    const { notificationLines } = await import("../src/life/notifications.js");
    const { redactDmNotifications } = await import("../src/life/lifeView.js");
    const view = { handle: () => "dm/kevin", unread: () => 1, timeZone: "UTC" };
    const rendered = notificationLines(
      [
        { id: "w1", reason: "dm", placeKey: "dm_300000000000000003_aria", fromName: 'Kev"in', preview: "I relapsed last night, please don't tell anyone", at: AT },
        { id: "w2", reason: "watch", placeKey: "dm_300000000000000003_aria", matched: "biopsy", note: "Kevin's biopsy\nresults: malignant", at: AT }
      ] as never,
      view as never
    );
    expect(rendered.join("\n").split("\n")).toHaveLength(1);
    expect(rendered[0]).not.toContain('Kev"in');
    expect(redactDmNotifications(rendered.join("\n"))).not.toMatch(/relapsed|malignant|biopsy/u);
    // An old line (rendered before the fix): an unpaired quote in the name, and a note across lines.
    const old = '- dm · dm/kevin · from Kev"in · "I relapsed last night"\n- watch · dm/kevin · "biopsy" · from Kevin · your note: "Kevin\'s biopsy\nresults: malignant, he is scared"\n- mention · bake-club/#general · from Mina · "cake?"';
    const redacted = redactDmNotifications(old);
    expect(redacted).not.toMatch(/relapsed|malignant|scared|biopsy/u);
    expect(redacted).toContain('"cake?"');
  });

  it("list_watches lines that name a DM place are hidden (review: DM-bound watches)", () => {
    const lines: LifeLogLine[] = [
      line(0, "assistant", { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "list_watches", input: {} }] }),
      line(1, "tool_results", { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: 'w1 · until Sat 18:00 · once · dm/kevin from Kevin words: biopsy · note: "Kevin\'s biopsy results come Friday"' }] })
    ];
    const scan = scanDmContent(lines);
    const shown = JSON.stringify(lines.map((entry) => viewLogLine(entry, scan, { includePrivate: false }).view));
    expect(shown).not.toContain("biopsy");
  });
});
