// Rest before her prompt cache goes cold (Living cast spec §25): with a large context and nothing
// going on, the §19 rest turn comes `life.cacheRestLeadMinutes` before her route's cache expires
// (her last request + the route's TTL), started by the scheduler's tick; never for routes without a
// known TTL, with a small context, with a wake queued or a turn running, or asleep near the morning;
// once per epoch; ignored, nothing else happens.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";

const estimate = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("../src/life/request.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/life/request.js")>();
  return { ...real, estimateRequest: (...args: Parameters<typeof real.estimateRequest>) => estimate.value ?? real.estimateRequest(...args) };
});

import { cacheRestDueAt, cacheRestDueFor, cacheRestDueNow, type CacheRestInput } from "../src/life/cacheRest.js";
import { CACHE_REST_NOTICE, REST_NOTICE, REST_REFUSED_RESULT, REST_SUMMARY_FRAME } from "../src/life/lifeLoop.js";
import { readLifeLog, readLifeState } from "../src/life/lifeStore.js";
import { lifeBudget } from "../src/life/request.js";
import { cacheRestIgnoredNote, REST_NOTICE_PREFIX } from "../src/life/rest.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { PROMPT_CACHE_TTL_MS, type CuratedModel } from "../src/models/catalog.js";
import type { LifeState } from "../src/shared/schemas/life.js";
import { textTurn, type ScriptedTurn } from "./modelFakes.js";
import { closeWorlds, lifeWorld, toolTurn, type LifeWorld, type WaifuSeed } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { scriptInput } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  estimate.value = undefined;
  vi.restoreAllMocks();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const MINUTE = 60_000;
const SUMMARY = `Bake Club #general: Kevin asked if I'm coming Saturday; I said yes and that I'd bring lemon tarts. ${"Mina is preheating the oven and we joked about the menace cat again. ".repeat(4)}`;

function play(events: ProviderEvent[]): ScriptedTurn {
  return () => events;
}

function thenSmall(events: ProviderEvent[]): ScriptedTurn {
  return () => {
    estimate.value = undefined;
    return events;
  };
}

function modelOf(w: LifeWorld, modelId = "claude-haiku-5-5"): CuratedModel {
  return w.cast.deps.catalog().models.find((entry) => entry.modelId === modelId)!;
}

/** `share` × her compaction trigger. */
function tokensAt(w: LifeWorld, share: number, modelId?: string): number {
  return Math.round(share * w.config.compaction.triggerRatio * lifeBudget(modelOf(w, modelId), w.config.life.maxContextTokens));
}

async function owner(w: LifeWorld, note: string): Promise<void> {
  await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });
}

/** One ordinary turn at `share` × the trigger, then the scheduler's poke is watched (not run). */
async function quietAfterATurn(w: LifeWorld, share: number, modelId?: string) {
  estimate.value = tokensAt(w, share, modelId);
  await owner(w, "first");
  await w.cast.life("ella").runNow();
  return vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
}

function lastText(request: { messages: Array<{ content: unknown }> }): string {
  return JSON.stringify(request.messages[request.messages.length - 1]!.content);
}

// Several lives, turns and scheduler ticks per case: a 30 s budget under suite load.
describe("the quiet-time rest (§25)", { timeout: 30_000 }, () => {
  it("comes at TTL − lead with a big context, from the tick; accepted, her new epoch starts from her summary", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(toolTurn([{ name: "SendMessage", input: scriptInput.sendMessage("bake-club/#general", [{ text: "brb" }]) }])), thenSmall(textTurn(SUMMARY))] });
    const poke = await quietAfterATurn(w, 0.6);
    const sentAt = Date.parse((await readLifeState(w.storage, "ella")).lastRequestAt!);
    // Not before her cache's expiry − 10 minutes.
    w.clock.ms = sentAt + PROMPT_CACHE_TTL_MS - 10 * MINUTE - 20_000;
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    w.clock.advance(20_000);
    await w.cast.scheduler.tick();
    expect(poke).toHaveBeenCalled();
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(3);
    // The §19 notice plus one sentence; same system blocks and tools (the cache holds).
    expect(lastText(calls[1]!)).toContain(JSON.stringify(CACHE_REST_NOTICE).slice(1, -1));
    expect(CACHE_REST_NOTICE.startsWith(REST_NOTICE)).toBe(true);
    expect(CACHE_REST_NOTICE.startsWith(REST_NOTICE_PREFIX)).toBe(true);
    expect(CACHE_REST_NOTICE).toContain("You've been quiet a while; this is a good moment to rest.");
    expect(calls[1]!.system).toEqual(calls[0]!.system);
    expect(calls[1]!.tools).toEqual(calls[0]!.tools);
    // The same refusals as the §19 rest turn.
    expect(JSON.stringify(calls[2]!.messages)).toContain(REST_REFUSED_RESULT);
    expect(w.discord.sent).toEqual([]);
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe(`${REST_SUMMARY_FRAME}\n${SUMMARY.trim()}`);
    expect(state.lastCompaction).toMatchObject({ reason: "cache_rest", summarized: true, fromEpoch: 1 });
    expect((await readLifeLog(w.storage, "ella", 2))[0]).toMatchObject({ kind: "compaction_boundary", boundary: { reason: "cache_rest", keptTurns: 0 } });
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "life", "life"]);
  });

  it("does not come with a small context", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("again"))] });
    const poke = await quietAfterATurn(w, 0.4);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
  });

  it("does not come once her cache has expired (after downtime)", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("again"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS + MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
  });

  it("never comes on a route without a known cache TTL", async () => {
    const w = await lifeWorld(roots, {
      waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", model: { providerId: "deepseek", modelId: "deepseek-flash" } }],
      scripts: [play(textTurn("noted")), play(textTurn("again"))]
    });
    const poke = await quietAfterATurn(w, 0.6, "deepseek-flash");
    expect(w.chat.calls).toHaveLength(1);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    await w.cast.life("ella").runNow();
    expect(w.chat.calls).toHaveLength(1);
  });

  it("waits while a wake is queued: that turn runs as usual, without the notice", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("hi"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await owner(w, "second");
    await w.cast.scheduler.tick();
    expect(poke.mock.calls.length).toBe(0);
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.messages)).not.toContain(REST_NOTICE_PREFIX);
    expect(lastText(calls[1]!)).toContain("second");
  });

  it("comes at most once per epoch; ignored, nothing else happens (no compaction, the turn stays)", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("ok")), play(textTurn("again"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).toHaveBeenCalledTimes(1);
    await w.cast.life("ella").runNow();
    let state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(1);
    expect(state.cacheRest).toMatchObject({ epoch: 1 });
    expect(state.restTurn).toBeUndefined();
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "life"]);
    expect(JSON.stringify(await readLifeLog(w.storage, "ella", 1))).toContain("You've been quiet a while");
    // Quiet again until her refreshed cache nears expiry: not a second time in this epoch.
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).toHaveBeenCalledTimes(1);
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(2);
    state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(1);
  });

  it("ignored, her next time line says once that her summary was not used and nothing was reset", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("ok")), play(textTurn("hi")), play(textTurn("hi again"))] });
    await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(2);
    await owner(w, "second");
    await w.cast.life("ella").runNow();
    await owner(w, "third");
    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(lastText(calls[2]!)).toContain(cacheRestIgnoredNote("it is shorter than 200 characters"));
    expect(cacheRestIgnoredNote("x")).toBe("(your summary was not used and nothing was reset: x)");
    expect(lastText(calls[3]!)).not.toContain("nothing was reset");
  });

  it("is not started while her provider cools down or her daily budget is spent (no poke every tick)", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    const cooling = vi.spyOn(w.cast.deps.models, "cooldownRemainingMs").mockReturnValue(60_000);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    cooling.mockRestore();
    // Her budget: what the scheduler asks (its spend comes from the usage ledger on disk).
    const { readWaifu } = await import("../src/orchestration/stores/config.js");
    const waifu = await readWaifu(w.storage, "ella");
    const state = await readLifeState(w.storage, "ella");
    expect(await cacheRestDueFor(w.cast.deps, waifu, state)).toBe(true);
    const budgeted = { ...waifu, life: { ...waifu.life, dailyBudgetUsd: 0.5 } };
    expect(await cacheRestDueFor(w.cast.deps, budgeted, state, { spentToday: async () => 0.2 })).toBe(true);
    expect(await cacheRestDueFor(w.cast.deps, budgeted, state, { spentToday: async () => 0.5 })).toBe(false);
  });

  it("reads her route's TTL from the catalog the life is given (deps.catalog())", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    const curated = w.cast.deps.catalog();
    vi.spyOn(w.cast.deps, "catalog").mockReturnValue({ ...curated, models: curated.models.map(({ cacheTtlMs: _ttl, ...model }) => model) });
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
  });

  it("is not given to a waifu without her own bot", async () => {
    const w = await lifeWorld(roots, { scripts: [play(textTurn("noted")), play(textTurn("again"))] });
    const poke = await quietAfterATurn(w, 0.6);
    const { readWaifu } = await import("../src/orchestration/stores/config.js");
    const { writeWaifuConfig } = await import("./lifeFixtures.js");
    const { botId: _botId, ...waifu } = await readWaifu(w.storage, "ella");
    await writeWaifuConfig(w.storage, { ...waifu, id: "ella", name: "Ella" } as WaifuSeed);
    expect((await readWaifu(w.storage, "ella")).botId).toBeUndefined();
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
  });

  it("is never given with life.restNotice off", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, restNotice: false } }), scripts: [play(textTurn("noted")), play(textTurn("again"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
  });

  it("does not come while she is asleep with her bed time ending within the TTL; otherwise it does", async () => {
    // Her bed time starts 30 minutes after her turn; asleep at once (bedDozeMinutes 0).
    const near: WaifuSeed = { id: "ella", name: "Ella", botId: "ella-bot", availability: { bedTime: { enabled: true, start: "14:30", end: "15:30" } } };
    const w = await lifeWorld(roots, { waifus: [near], config: (config) => ({ ...config, life: { ...config.life, bedDozeMinutes: 0, dreamAfterAsleepMinutes: 720 } }), scripts: [play(textTurn("noted"))] });
    const poke = await quietAfterATurn(w, 0.6);
    w.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await w.cast.scheduler.tick();
    expect(poke).not.toHaveBeenCalled();
    const far: WaifuSeed = { ...near, availability: { bedTime: { enabled: true, start: "14:30", end: "22:00" } } };
    const v = await lifeWorld(roots, { waifus: [far], config: (config) => ({ ...config, life: { ...config.life, bedDozeMinutes: 0, dreamAfterAsleepMinutes: 720 } }), scripts: [play(textTurn("noted")), thenSmall(textTurn(SUMMARY))] });
    const vPoke = await quietAfterATurn(v, 0.6);
    v.clock.advance(PROMPT_CACHE_TTL_MS - 5 * MINUTE);
    await v.cast.scheduler.tick();
    expect(vPoke).toHaveBeenCalled();
    await v.cast.life("ella").runNow();
    expect((await readLifeState(v.storage, "ella")).lastCompaction).toMatchObject({ reason: "cache_rest" });
  });
});

describe("cacheRestDueAt / cacheRestDueNow", () => {
  const model = { id: "anthropic/claude-haiku-5-5", providerId: "anthropic", modelId: "claude-haiku-5-5", contextWindow: 200_000 } as CuratedModel;
  const life = { restNotice: true, cacheRestMinRatio: 0.5, cacheRestLeadMinutes: 10, maxContextTokens: 96_000 };
  const at = Date.parse("2026-10-24T14:00:00.000Z");
  const trigger = 0.7 * lifeBudget(model, life.maxContextTokens);
  const state = {
    waifuId: "ella",
    epoch: 3,
    status: "idle",
    systemSnapshot: {},
    lastRequestAt: new Date(at).toISOString(),
    lastRequestTokens: Math.round(0.6 * trigger)
  } as unknown as LifeState;
  const input = (patch: Partial<CacheRestInput> = {}, statePatch: Partial<LifeState> = {}): CacheRestInput => ({
    life,
    triggerRatio: 0.7,
    model,
    ttlMs: PROMPT_CACHE_TTL_MS,
    now: new Date(at + 52 * MINUTE),
    queued: 0,
    ...patch,
    state: { ...state, ...statePatch }
  });

  it("is due at the last request + TTL − lead, until the cache expires", () => {
    expect(cacheRestDueAt(input())).toEqual(new Date(at + 50 * MINUTE));
    expect(cacheRestDueNow(input())).toBe(true);
    expect(cacheRestDueNow(input({ now: new Date(at + 49 * MINUTE) }))).toBe(false);
    expect(cacheRestDueNow(input({ now: new Date(at + 60 * MINUTE) }))).toBe(false);
  });

  it("is not due without a TTL, with a small or full context, a turn running, a wake queued, or a rest already had", () => {
    expect(cacheRestDueNow(input({ ttlMs: undefined }))).toBe(false);
    expect(cacheRestDueNow(input({}, { lastRequestTokens: Math.round(0.4 * trigger) }))).toBe(false);
    expect(cacheRestDueNow(input({}, { lastRequestTokens: Math.round(trigger) }))).toBe(false);
    expect(cacheRestDueNow(input({}, { status: "turn" }))).toBe(false);
    expect(cacheRestDueNow(input({ queued: 1 }))).toBe(false);
    expect(cacheRestDueNow(input({}, { cacheRest: { epoch: 3, turnId: "t" } }))).toBe(false);
    expect(cacheRestDueNow(input({}, { cacheRest: { epoch: 2, turnId: "t" } }))).toBe(true);
    expect(cacheRestDueNow(input({}, { restTurn: { epoch: 3, turnId: "t" } }))).toBe(false);
    expect(cacheRestDueNow(input({}, { dayCompactionDue: true }))).toBe(false);
    expect(cacheRestDueNow(input({}, { pendingEpochStart: true }))).toBe(false);
    expect(cacheRestDueNow(input({}, { compactionPausedUntil: new Date(at + 90 * MINUTE).toISOString() }))).toBe(false);
    expect(cacheRestDueNow(input({ life: { ...life, restNotice: false } }))).toBe(false);
  });

  it("asleep: not when her bed time ends within the TTL; dozing or up late it is due", () => {
    const now = at + 52 * MINUTE;
    expect(cacheRestDueNow(input({ bed: { phase: "asleep", windowEnd: new Date(now + 30 * MINUTE) } }))).toBe(false);
    expect(cacheRestDueNow(input({ bed: { phase: "asleep", windowEnd: new Date(now + 3 * 60 * MINUTE) } }))).toBe(true);
    expect(cacheRestDueNow(input({ bed: { phase: "dozing", windowEnd: new Date(now + 30 * MINUTE) } }))).toBe(true);
  });
});
