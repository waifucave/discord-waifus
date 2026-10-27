// She summarises herself before her memory fills (Living cast spec §19, owner decisions R1–R4): the
// rest notice comes after the running turn, never mid-turn, and before queued wakes; tools that
// reach people are refused in the rest turn (still offered: the cached prefix holds); an accepted
// summary starts a new epoch from it alone; a short one, a failed rest turn or the switch off leave
// compaction as it was.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";

/** The request size the life loop sees (a stand-in for a long life, which tests cannot afford). */
const estimate = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("../src/life/request.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/life/request.js")>();
  return { ...real, estimateRequest: (...args: Parameters<typeof real.estimateRequest>) => estimate.value ?? real.estimateRequest(...args) };
});

import { autoCompactionRatio, REST_NOTICE, REST_REFUSED_RESULT, REST_SUMMARY_FRAME } from "../src/life/lifeLoop.js";
import { boundaryReasonLabel, lastEpochWord } from "../src/frontend/screens/lifeView.js";
import { AppConfigSchema, DEFAULT_APP_CONFIG } from "../src/shared/schemas/config.js";
import { readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { lifeBudget } from "../src/life/request.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { MEMORY_WARNING } from "../src/life/clock.js";
import { printLifeLines, scanDmContent, viewLogLine } from "../src/life/lifeView.js";
import { restTurnIds } from "../src/life/compaction.js";
import { isRestNotice, LEGACY_REST_NOTICE_PREFIX, REST_NOTICE_PREFIX } from "../src/life/rest.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { errorTurn, hangingTurn, textTurn, type ScriptedTurn } from "./modelFakes.js";
import { closeWorlds, homeOf, lifeWorld, ROOM_KEY, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  estimate.value = undefined;
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const SUMMARY = `Bake Club #general: Kevin asked if I'm coming Saturday; I said yes and that I'd bring lemon tarts. ${"Mina is preheating the oven and we joked about the menace cat again. ".repeat(4)}`;

function play(events: ProviderEvent[]): ScriptedTurn {
  return () => events;
}

/** The call after which her requests are small again (her new epoch). */
function thenSmall(events: ProviderEvent[]): ScriptedTurn {
  return () => {
    estimate.value = undefined;
    return events;
  };
}

/** Before a model call: a wake queued (it must wait for the next turn). */
function queueingWake(w: () => LifeWorld, note: string, events: ProviderEvent[]): ScriptedTurn {
  return () =>
    (async function* () {
      await enqueueWake(w().storage, "ella", { id: newWakeId(), reason: "reminder", note, at: w().clock.now().toISOString() });
      for (const event of events) yield event;
    })();
}

async function owner(w: LifeWorld, note: string): Promise<void> {
  await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });
}

function budgetOf(w: LifeWorld): number {
  const model = w.cast.deps.catalog().models.find((entry) => entry.modelId === "claude-haiku-5-5")!;
  return lifeBudget(model, w.config.life.maxContextTokens);
}

/** 0.8 × her budget: past the rest point (compaction.triggerRatio 0.7), short of the emergency (0.9, §26). */
function nearlyFull(w: LifeWorld): number {
  return Math.round(0.8 * budgetOf(w));
}

function lastText(request: { messages: Array<{ content: unknown }> }): string {
  return JSON.stringify(request.messages[request.messages.length - 1]!.content);
}

describe("the rest notice (§19.2, §19.3)", () => {
  it("comes after the running turn, before a wake queued meanwhile; an accepted summary starts a new epoch from it alone", async () => {
    let world: LifeWorld | undefined;
    const w = await lifeWorld(roots, {
      scripts: [
        // Her turn: one tool round, then a reply; a wake arrives while she writes it.
        play(toolTurn([{ name: "Read", input: { file_path: "~/MEMORY.md" } }])),
        queueingWake(() => world!, "second", textTurn("done here")),
        // The rest turn: she saves a note, tries to message someone, then writes her summary.
        play(toolTurn([{ name: "Write", input: { file_path: "~/saturday.md", content: "Saturday: lemon tarts\n" } }, { name: "SendMessage", input: { place: "bake-club/#general", text: "brb" } }])),
        thenSmall(textTurn(SUMMARY)),
        // The wake's turn, in the new epoch.
        play(textTurn("hello again"))
      ]
    });
    world = w;
    await homeOf(w).write("MEMORY.md", "# Memory\n");
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(5);
    // Turn 1 never saw the notice; the rest turn opens with it and with no wake in it.
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("Your memory is almost full");
    expect(lastText(calls[2]!)).toContain(REST_NOTICE.slice(0, 60));
    expect(JSON.stringify(calls[2]!.messages)).not.toContain("second");
    // The cached prefix holds: same system blocks and tools, earlier messages unchanged.
    expect(calls[2]!.system).toEqual(calls[1]!.system);
    expect(calls[2]!.tools).toEqual(calls[1]!.tools);
    expect(JSON.stringify(calls[2]!.messages.slice(0, calls[1]!.messages.length - 1))).toBe(JSON.stringify(calls[1]!.messages.slice(0, -1)));
    // In the rest turn people are out of reach; her files are not.
    expect(JSON.stringify(calls[3]!.messages)).toContain(REST_REFUSED_RESULT);
    expect(w.discord.sent).toEqual([]);
    expect(await homeOf(w).read("saturday.md")).toBe("Saturday: lemon tarts\n");
    // Accepted: a new epoch whose prompt holds only her summary; the wake comes after it.
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe(`${REST_SUMMARY_FRAME}\n${SUMMARY.trim()}`);
    expect(state.lastCompaction).toMatchObject({ reason: "rest", summarized: true, fromEpoch: 1 });
    const log = await readLifeLog(w.storage, "ella", 2);
    expect(log[0]).toMatchObject({ kind: "compaction_boundary", boundary: { reason: "rest", keptTurns: 0 } });
    expect(calls[4]!.system).toContain(REST_SUMMARY_FRAME);
    expect(calls[4]!.messages).toHaveLength(1);
    expect(JSON.stringify(calls[4]!.messages[0]!.content)).toContain("second");
    // No compaction call: she wrote it herself.
    expect(w.ledger.lines.map((line) => line.purpose)).not.toContain("compaction");
  });

  it("her rest summary is private from the owner like <life_so_far> (D14): hidden without includePrivate", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), thenSmall(textTurn(SUMMARY)), play(textTurn("hi"))] });
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    const old = await readLifeLog(w.storage, "ella", 1);
    const scan = scanDmContent(old);
    const shown = JSON.stringify(old.map((line) => viewLogLine(line, scan, { includePrivate: false }).view));
    expect(shown).not.toContain("lemon tarts");
    expect(shown).toContain("Your memory is almost full");
    expect(printLifeLines(old, { private: false })).not.toContain("lemon tarts");
    // Her ordinary turn before it stays visible; the local reveal shows the summary.
    expect(shown).toContain("noted");
    expect(JSON.stringify(old.map((line) => viewLogLine(line, scan, { includePrivate: true }).view))).toContain("lemon tarts");
  });

  it("a summary that is too short means compaction summarises for her, leaving the rest turn out", async () => {
    const w = await lifeWorld(roots, {
      scripts: [play(textTurn("noted")), thenSmall(textTurn("ok")), play(textTurn("We talked about Saturday in Bake Club.")), play(textTurn("hi"))]
    });
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    // Turn 1, the rest turn ("ok"), the compaction summary.
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "life", "compaction"]);
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe("We talked about Saturday in Bake Club.");
    expect(state.lastCompaction).toMatchObject({ reason: "tokens", summarized: true });
    // The rest turn is not one of the turns carried over.
    expect(JSON.stringify(await readLifeLog(w.storage, "ella", 2))).not.toContain("Your memory is almost full");
  });

  it("a failed rest turn means compaction, which falls back to truncation as before if it fails too", async () => {
    const failed = play(errorTurn({ code: "server_error", status: 500, message: "upstream exploded", retryable: false } as never));
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), failed] });
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    // Turn 1, the rest turn (failed), the compaction summary (failed too).
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "life", "compaction"]);
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.lastCompaction).toMatchObject({ reason: "tokens", summarized: false });
    expect(JSON.stringify(await readLifeLog(w.storage, "ella", 2))).not.toContain("Your memory is almost full");
  });

  it("a rest turn whose compaction was interrupted is not given again: the next cycle compacts", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("ok")), hangingTurn(), thenSmall(textTurn("We talked about Saturday.")), play(textTurn("hi"))] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    const running = w.cast.life("ella").runNow();
    for (let tries = 0; w.anthropic.calls.length < 3 && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    w.cast.life("ella").abort("pause");
    await running;
    let state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(1);
    expect(state.restTurn).toMatchObject({ epoch: 1 });
    await owner(w, "second");
    await w.cast.life("ella").runNow();
    state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe("We talked about Saturday.");
    expect(JSON.stringify(await readLifeLog(w.storage, "ella", 2))).not.toContain("Your memory is almost full");
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(calls[4]!.messages)).toContain("second");
    expect(calls.filter((call) => lastText(call).includes("Your memory is almost full"))).toHaveLength(1);
  });

  it("an interrupted rest turn changes nothing and is given again at the next cycle; the wakes wait", async () => {
    let world: LifeWorld | undefined;
    const w = await lifeWorld(roots, {
      scripts: [queueingWake(() => world!, "second", textTurn("noted")), hangingTurn(), thenSmall(textTurn(SUMMARY)), play(textTurn("hello again"))]
    });
    world = w;
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    const running = w.cast.life("ella").runNow();
    for (let tries = 0; w.anthropic.calls.length < 2 && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    w.cast.life("ella").abort("pause");
    await running;
    let state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(1);
    expect(state.restTurn).toBeUndefined();
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(4);
    expect(lastText(calls[2]!)).toContain(REST_NOTICE.slice(0, 60));
    state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.lastCompaction).toMatchObject({ reason: "rest" });
    expect(JSON.stringify(calls[3]!.messages)).toContain("second");
  });

  it("an interrupted rest turn is never carried over by a later compaction", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), hangingTurn(), thenSmall(textTurn("We talked about Saturday.")), play(textTurn("hi"))] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    const running = w.cast.life("ella").runNow();
    for (let tries = 0; w.anthropic.calls.length < 2 && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    w.cast.life("ella").abort("pause");
    await running;
    // Her memory reaches the emergency point: compaction, which keeps her last turns.
    estimate.value = Math.round(w.config.compaction.emergencyRatio * budgetOf(w));
    await updateLifeState(w.storage, "ella", (current) => ({ ...current, lastRequestTokens: estimate.value }));
    await owner(w, "second");
    await w.cast.life("ella").runNow();
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    const kept = JSON.stringify(await readLifeLog(w.storage, "ella", 2));
    expect(kept).toContain("noted");
    expect(kept).not.toContain("Your memory is almost full");
  });

  it("is never given with the switch off: her time line warns her instead, as before", async () => {
    const w = await lifeWorld(roots, {
      config: (config) => ({ ...config, life: { ...config.life, restNotice: false } }),
      scripts: [play(textTurn("noted")), play(textTurn("again"))]
    });
    // Past the old warning point (0.85 × the trigger), short of the trigger, where compaction runs with the notice off.
    estimate.value = Math.round(0.65 * budgetOf(w));
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    await owner(w, "second");
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("Your memory is almost full");
    expect(lastText(calls[1]!)).toContain(MEMORY_WARNING);
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
  });

  it("with the notice on, the time line drops the old warning", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), thenSmall(textTurn(SUMMARY)), play(textTurn("hi"))] });
    estimate.value = nearlyFull(w);
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    expect(JSON.stringify(w.anthropic.calls.map((call) => call.request.messages))).not.toContain(MEMORY_WARNING);
    expect(ROOM_KEY).toMatch(/^g_/u);
  });
});

describe("the rest notice is the norm, auto-compaction the emergency (§26)", () => {
  it("the rest notice comes at compaction.triggerRatio × her budget, not below it", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("again")), play(textTurn("noted")), thenSmall(textTurn(SUMMARY)), play(textTurn("hi"))] });
    estimate.value = Math.round(0.69 * budgetOf(w));
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    await owner(w, "second");
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls.map((call) => lastText(call.request)).join("\n")).not.toContain("Your memory is almost full");
    estimate.value = Math.round(0.7 * budgetOf(w)) + 1;
    await owner(w, "third");
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(lastText(calls[3]!)).toContain(REST_NOTICE.slice(0, 60));
    expect((await readLifeState(w.storage, "ella")).lastCompaction).toMatchObject({ reason: "rest" });
    expect(w.ledger.lines.map((line) => line.purpose)).not.toContain("compaction");
  });

  it("auto-compaction runs between turns only at compaction.emergencyRatio × her budget (no rest turn first)", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), thenSmall(textTurn("We talked about Saturday in Bake Club.")), play(textTurn("hi"))] });
    estimate.value = Math.round(0.9 * budgetOf(w)) + 1;
    await owner(w, "first");
    await w.cast.life("ella").runNow();
    await owner(w, "second");
    await w.cast.life("ella").runNow();
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "compaction", "life"]);
    expect(JSON.stringify(w.anthropic.calls.map((call) => call.request.messages))).not.toContain("Your memory is almost full");
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.lastCompaction).toMatchObject({ reason: "tokens", summarized: true });
  });

  it("with the rest notice off, compaction runs at the trigger as before", () => {
    const config = AppConfigSchema.parse(DEFAULT_APP_CONFIG);
    expect(autoCompactionRatio(config)).toBe(0.9);
    expect(autoCompactionRatio({ ...config, life: { ...config.life, restNotice: false } })).toBe(0.7);
  });

  it("compaction.emergencyRatio defaults to 0.9 and must be greater than compaction.triggerRatio", () => {
    expect(AppConfigSchema.parse({}).compaction).toMatchObject({ triggerRatio: 0.7, emergencyRatio: 0.9 });
    expect(() => AppConfigSchema.parse({ compaction: { triggerRatio: 0.8, emergencyRatio: 0.8 } })).toThrow(/emergencyRatio/u);
    expect(() => AppConfigSchema.parse({ compaction: { emergencyRatio: 0.6 } })).toThrow(/emergencyRatio/u);
    expect(AppConfigSchema.parse({ compaction: { triggerRatio: 0.6, emergencyRatio: 0.95 } }).compaction.emergencyRatio).toBe(0.95);
    expect("restNoticeRatio" in AppConfigSchema.parse({}).life).toBe(false);
  });

  it("the Life screen says rested for her own summaries and emergency summary for auto-compaction", () => {
    expect(boundaryReasonLabel("rest")).toBe("rested (her own summary)");
    expect(boundaryReasonLabel("tokens")).toBe("emergency summary (tokens)");
    expect(boundaryReasonLabel("overflow")).toBe("emergency summary (overflow)");
    expect(boundaryReasonLabel("config")).toBe("config");
    expect(lastEpochWord("rest")).toBe("rested");
    expect(lastEpochWord("cache_rest")).toBe("rested");
    expect(lastEpochWord("self")).toBe("rested");
    expect(lastEpochWord("log_length")).toBe("emergency summary");
    expect(lastEpochWord("day")).toBe("compacted");
  });
});

describe("the rest notice's wording (owner rewording 2026-10-27)", () => {
  /** A rest turn as logged before the rewording: its notice in the old words, then her summary. */
  const OLD_NOTICE = "[system] Your memory is almost full. When this turn ends, your context will be reset: everything you can see now goes away except the summary you write in this turn.";
  const legacyTurn: LifeLogLine[] = [
    { seq: 0, at: "2026-10-26T10:00:00.000Z", kind: "notifications", turnId: "t-old", message: { role: "user", content: [{ type: "text", text: OLD_NOTICE }, { type: "text", text: "[Mon 26 Oct 10:00 · awake]" }] } },
    { seq: 1, at: "2026-10-26T10:00:05.000Z", kind: "assistant", turnId: "t-old", message: { role: "assistant", content: [{ type: "text", text: "Kevin and the lemon tarts." }] } }
  ] as LifeLogLine[];

  it("today's notice is less prescriptive; logs with the old notice are still read as rest turns", () => {
    expect(REST_NOTICE).toContain("whatever you want to carry forward");
    expect(REST_NOTICE.startsWith(REST_NOTICE_PREFIX)).toBe(true);
    expect(REST_NOTICE_PREFIX).not.toBe(LEGACY_REST_NOTICE_PREFIX);
    expect(OLD_NOTICE.startsWith(LEGACY_REST_NOTICE_PREFIX)).toBe(true);
    expect(isRestNotice(OLD_NOTICE)).toBe(true);
    expect(isRestNotice(REST_NOTICE)).toBe(true);
    expect(isRestNotice("[system] your last turn failed")).toBe(false);
    // Compaction never keeps it; the owner's views hide her summary in it.
    expect([...restTurnIds(legacyTurn)]).toEqual(["t-old"]);
    const scan = scanDmContent(legacyTurn);
    expect(scan.restTurns?.has("t-old")).toBe(true);
    expect(JSON.stringify(legacyTurn.map((line) => viewLogLine(line, scan, { includePrivate: false }).view))).not.toContain("lemon tarts");
  });
});
