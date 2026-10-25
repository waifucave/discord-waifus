// Compaction sizes (Living cast spec §5.6; review M1, M2): the summary request of an over-budget log
// leaves the last tool results out instead of resending what pushed it over, and the kept window
// shrinks when three kept turns alone would start the new epoch over budget. Scripted winter fakes,
// temp data root; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactLife, compactRetiredTools, currentHarness, flattenRetiredCalls, KEPT_TURNS, RESULT_LEFT_OUT, withoutLastResults } from "../src/life/compaction.js";
import { readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { textTurn } from "./modelFakes.js";
import { closeWorlds, lifeWorld, script, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const AT = "2026-10-24T14:00:00.000Z";

/** One complete turn: a wake, a read, its result, a closing text. */
function turn(id: string, result: string): LifeLogLine[] {
  return [
    { seq: 0, at: AT, kind: "notifications", turnId: id, message: { role: "user", content: `<notifications>wake ${id}</notifications>` } },
    { seq: 0, at: AT, kind: "assistant", turnId: id, message: { role: "assistant", content: [{ type: "tool_use", id: `call_${id}`, name: "ReadMessages", input: { place: "bake-club/#general" } }] } },
    { seq: 0, at: AT, kind: "tool_results", turnId: id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `call_${id}`, content: result }] } },
    { seq: 0, at: AT, kind: "assistant", turnId: id, message: { role: "assistant", content: [{ type: "text", text: `done ${id}` }] } }
  ];
}

/** A world after one real turn (so she has a system snapshot), and what compactLife needs. */
async function compactable(w: LifeWorld) {
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "first", at: w.clock.now().toISOString() });
  await w.cast.life("ella").runNow();
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return { deps, waifu, route, state: await readLifeState(w.storage, "ella"), nextHarness: await currentHarness(deps, waifu, route) };
}

describe("compaction sizes", () => {
  it("withoutLastResults replaces only the last tool results, in a copy (M1)", () => {
    const lines = [...turn("t1", "first result"), ...turn("t2", "second result")];
    const copy = withoutLastResults(lines);
    expect(JSON.stringify(copy)).toContain("first result");
    expect(JSON.stringify(copy)).not.toContain("second result");
    expect(JSON.stringify(copy)).toContain(RESULT_LEFT_OUT);
    expect(JSON.stringify(lines)).toContain("second result");
  });

  it("an over-budget log's summary request leaves the last results out (M1)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("ok"), textTurn("Earlier: baking.")) });
    const { deps, waifu, route, state, nextHarness } = await compactable(w);
    const huge = "crumb ".repeat(20_000);
    const calls = w.anthropic.calls.length;
    const outcome = await compactLife(deps, {
      waifu,
      state,
      lines: [...turn("t1", "a short result"), ...turn("t2", huge)],
      summaryRoute: route,
      nextHarness,
      reason: "budget",
      omit: { deleted: [], people: [] },
      shrinkLastResults: true
    });
    expect(outcome.summarized).toBe(true);
    const summaryRequest = JSON.stringify(w.anthropic.calls[calls]!.request.messages);
    expect(summaryRequest).toContain("a short result");
    expect(summaryRequest).toContain(RESULT_LEFT_OUT);
    expect(summaryRequest).not.toContain("crumb crumb");
  });

  it("the kept window shrinks while it alone would take over half the trigger (M2)", async () => {
    const w = await lifeWorld(roots, {
      config: (config) => ({ ...config, compaction: { ...config.compaction, enabled: false }, life: { ...config.life, maxContextTokens: 32_000 } }),
      scripts: script(textTurn("ok"))
    });
    const { deps, waifu, route, state, nextHarness } = await compactable(w);
    const compact = async (result: string) => {
      const current = await readLifeState(w.storage, "ella");
      const outcome = await compactLife(deps, {
        waifu,
        state: { ...state, epoch: current.epoch },
        lines: [...turn("t1", result), ...turn("t2", result), ...turn("t3", result)],
        summaryRoute: route,
        nextHarness,
        reason: "budget",
        omit: { deleted: [], people: [] }
      });
      const log = await readLifeLog(w.storage, "ella", outcome.state.epoch);
      return log[0]!.boundary!.keptTurns;
    };
    // Small turns: all three are kept.
    expect(await compact("a short result")).toBe(KEPT_TURNS);
    // Three turns of ~6,000 tokens against a 32,000-token budget (trigger 0.7, half of it 11,200):
    // two would still be over, one fits.
    expect(await compact("crumb ".repeat(4_000))).toBe(1);
    // One turn alone over the limit: nothing is kept.
    expect(await compact("crumb ".repeat(12_000))).toBe(0);
  });
});

/** A turn of the L2 surface: `read_note` and its result, then a closing text. */
function retiredTurn(id: string): LifeLogLine[] {
  return [
    { seq: 0, at: AT, kind: "notifications", turnId: id, message: { role: "user", content: `<notifications>wake ${id}</notifications>` } },
    { seq: 0, at: AT, kind: "assistant", turnId: id, message: { role: "assistant", content: [{ type: "tool_use", id: `call_${id}`, name: "read_note", input: { path: "people/kevin.md" } }] } },
    { seq: 0, at: AT, kind: "tool_results", turnId: id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `call_${id}`, content: "Kevin likes lemon tart" }] } },
    { seq: 0, at: AT, kind: "assistant", turnId: id, message: { role: "assistant", content: [{ type: "text", text: `done ${id}` }] } }
  ];
}

describe("a tool-surface change (§16.13, review B4)", () => {
  it("flattenRetiredCalls turns calls of tools that are gone, and their results, into text; current tools stay", () => {
    const flat = flattenRetiredCalls([...retiredTurn("t1"), ...turn("t2", "kept as is")]);
    const json = JSON.stringify(flat);
    expect(json).toContain("[used read_note people/kevin.md]");
    expect(json).toContain("[read_note result: Kevin likes lemon tart]");
    expect(json).not.toContain('"name":"read_note"');
    expect(json).toContain('"name":"ReadMessages"');
    expect(json).toContain('"tool_use_id":"call_t2"');
  });

  it("summarises her epoch with the old calls as text and keeps no turns", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("ok"), textTurn("Earlier: Kevin likes lemon tart.")) });
    const { deps, waifu, route, state, nextHarness } = await compactable(w);
    const calls = w.anthropic.calls.length;
    const outcome = await compactRetiredTools(deps, { waifu, state, lines: [...retiredTurn("t1"), ...retiredTurn("t2")], summaryRoute: route, nextHarness, omit: { deleted: [], people: [] } });
    expect(outcome.summarized).toBe(true);
    const request = JSON.stringify(w.anthropic.calls[calls]!.request.messages);
    expect(request).toContain("[used read_note people/kevin.md]");
    expect(request).not.toContain('"name":"read_note"');
    const after = await readLifeState(w.storage, "ella");
    expect(after).toMatchObject({ summary: "Earlier: Kevin likes lemon tart.", pendingEpochStart: false });
    const log = await readLifeLog(w.storage, "ella", after.epoch);
    expect(log[0]!.boundary).toMatchObject({ reason: "tools", keptTurns: 0 });
  });

  it("the migration's pending `tools` epoch is summarised before her next turn", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("ok"), textTurn("Summary after the move."), textTurn("hello again")) });
    const { state } = await compactable(w);
    await updateLifeState(w.storage, "ella", (current) => ({ ...current, pendingEpochStart: true, pendingEpochReason: "tools" as const }));
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "second", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    const after = await readLifeState(w.storage, "ella");
    expect(after.epoch).toBe(state.epoch + 1);
    expect(after.summary).toBe("Summary after the move.");
    expect((await readLifeLog(w.storage, "ella", after.epoch))[0]!.boundary).toMatchObject({ reason: "tools", keptTurns: 0 });
  });

  it("a failed summary falls back to the reset: her old summary carries over and the epoch starts", async () => {
    const w = await lifeWorld(roots, {
      scripts: [
        ...script(textTurn("ok")),
        () => {
          throw new Error("provider down");
        }
      ]
    });
    const { deps, waifu, route, state, nextHarness } = await compactable(w);
    const outcome = await compactRetiredTools(deps, { waifu, state: { ...state, summary: "old summary" }, lines: retiredTurn("t1"), summaryRoute: route, nextHarness, omit: { deleted: [], people: [] } });
    expect(outcome.summarized).toBe(false);
    const after = await readLifeState(w.storage, "ella");
    expect(after.epoch).toBe(state.epoch + 1);
    expect(after.summary).toBe("old summary");
    expect(after.pendingEpochStart).toBe(false);
  });
});
