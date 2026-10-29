// A plan with a time wakes her (Living cast spec §29): a plan in today's `~/life/schedule.json`
// with `at` fires once at that time as a `plan` wake (several at one tick are one wake), up to 15
// minutes late; one written after its time, or whose time is inside her bed time, stays a note. It
// gets through a busy block and her bed time like a reminder, and a budget pause defers it. Temp
// data roots, fake Discord and scripted models; the scheduler is ticked by hand.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN_WAKE_TEXT, planKey } from "../src/life/home/daySchedule.js";
import { readLifeFile } from "../src/life/lifeStore.js";
import type { LivingCast } from "../src/life/livingCast.js";
import { morningBatch, morningGreeting, renderNotifications } from "../src/life/notifications.js";
import { PLAN_LATE_MS } from "../src/life/scheduler.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import { selfAuthorIds } from "../src/life/people.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { enqueueWake, newWakeId, REMOVED_TEXT, scrubWakeQueue, takeImmediate } from "../src/life/wakeQueue.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import type { Wake } from "../src/shared/schemas/life.js";
import { closeWorlds, homeOf, KEVIN, lifeWorld, writeHerFile, type LifeWorld, type WaifuSeed } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, applyPatch, lineEditPatch, replaceFilePatch } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const at = (iso: string) => Date.parse(iso);
const VIEW = { timeZone: "UTC", handle: (key: string) => key, unread: () => undefined };

async function planWorld(o: { waifu?: Partial<WaifuSeed> } = {}): Promise<LifeWorld> {
  const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", ...o.waifu }] });
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  return w;
}

/** Her day for Sat 24 Oct with these plans (and one without a time, which never wakes her). */
async function writeDay(w: LifeWorld, plans: Array<{ at?: string; what: string }>, extra: Record<string, unknown> = {}): Promise<void> {
  await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-24", plans: [...plans, { what: "finish the rain poem" }], ...extra }, null, 2));
}

async function tickAt(w: LifeWorld, iso: string, cast: LivingCast = w.cast): Promise<void> {
  w.clock.ms = at(iso);
  await cast.scheduler.tick({ waitForMaintenance: false });
}

async function queue(w: LifeWorld) {
  return readLifeFile(w.storage, "ella", "wakes");
}

async function planWakes(w: LifeWorld): Promise<Wake[]> {
  return (await queue(w)).immediate.filter((wake) => wake.reason === "plan");
}

function restarted(w: LifeWorld): LivingCast {
  const after = w.restart();
  vi.spyOn(after.life("ella"), "poke").mockImplementation(() => undefined);
  return after;
}

describe("a plan with a time wakes her (§29)", () => {
  it("fires once at its time, as a plan wake with the plan's time and text; the record keeps no text", async () => {
    const w = await planWorld();
    await writeDay(w, [{ at: "14:30", what: "send one photo to dm/k if K is around" }]);
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T14:29:45Z");
    expect(await planWakes(w)).toEqual([]);
    await tickAt(w, "2026-10-24T14:30:00Z");
    const [wake] = await planWakes(w);
    expect(wake).toMatchObject({ reason: "plan", plans: [{ at: "14:30", what: "send one photo to dm/k if K is around" }], at: "2026-10-24T14:30:00.000Z" });
    expect(wake!.placeKey).toBeUndefined();
    expect(renderNotifications({ wakes: [wake!] }, VIEW)).toBe('<notifications>\n- plan · 14:30 · "send one photo to dm/k if K is around"\n</notifications>');
    // Taken by her turn, it never comes again: not at the next tick, not after a restart.
    await takeImmediate(w.storage, "ella");
    await tickAt(w, "2026-10-24T14:30:15Z");
    await w.cast.stop();
    const after = restarted(w);
    await tickAt(w, "2026-10-24T14:31:00Z", after);
    expect(await planWakes(w)).toEqual([]);
    const record = await readFile(path.join(w.root, "user/waifus/ella/life/plans-fired.json"), "utf8");
    expect(record).not.toContain("photo");
    expect(JSON.parse(record)).toMatchObject({ date: "2026-10-24", fired: [planKey({ at: "14:30", what: "send one photo to dm/k if K is around" })] });
  });

  it("an edit of the text or the time is a new plan; a plan she edits after its time does not fire again", async () => {
    const w = await planWorld();
    await writeDay(w, [{ at: "14:30", what: "check #secret-room" }, { at: "15:00", what: "call Mira" }]);
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T14:30:00Z");
    expect((await planWakes(w)).map((wake) => wake.plans)).toEqual([[{ at: "14:30", what: "check #secret-room" }]]);
    await takeImmediate(w.storage, "ella");
    // After 14:30 she rewords the first (a new plan, written after its time) and moves the second to 15:10.
    await writeDay(w, [{ at: "14:30", what: "check #secret-room again" }, { at: "15:10", what: "call Mira" }]);
    await tickAt(w, "2026-10-24T14:35:00Z");
    await tickAt(w, "2026-10-24T15:00:00Z");
    expect(await planWakes(w)).toEqual([]);
    await tickAt(w, "2026-10-24T15:10:00Z");
    expect((await planWakes(w)).map((wake) => wake.plans)).toEqual([[{ at: "15:10", what: "call Mira" }]]);
  });

  it("fires up to 15 minutes late (the host was down); later than that it is skipped", async () => {
    const w = await planWorld();
    await writeDay(w, [{ at: "14:30", what: "water the basil" }, { at: "14:40", what: "post the bake sale flyer" }]);
    await tickAt(w, "2026-10-24T14:00:00Z");
    await w.cast.stop();
    const after = restarted(w);
    // Back at 14:50: 14:40 is 10 minutes late, 14:30 is 20.
    await tickAt(w, "2026-10-24T14:50:00Z", after);
    expect((await planWakes(w)).map((wake) => wake.plans)).toEqual([[{ at: "14:40", what: "post the bake sale flyer" }]]);
    expect(PLAN_LATE_MS).toBe(15 * 60_000);
    // Exactly 15 minutes late still fires.
    await writeDay(w, [{ at: "15:00", what: "stretch" }]);
    await tickAt(w, "2026-10-24T14:55:00Z", after);
    await after.stop();
    const again = restarted(w);
    await tickAt(w, "2026-10-24T15:15:00Z", again);
    expect((await planWakes(w)).flatMap((wake) => wake.plans ?? []).map((plan) => plan.what)).toContain("stretch");
  });

  it("a plan written after its time does not fire; one written in the last tick before it does", async () => {
    const w = await planWorld();
    await tickAt(w, "2026-10-24T14:00:00Z");
    await writeDay(w, [{ at: "13:59", what: "too late already" }, { at: "14:00", what: "this minute" }, { at: "14:01", what: "just in time" }]);
    // Written between the 14:00:00 and 14:00:15 ticks: 13:59 and 14:00 were past, 14:01 was not.
    await tickAt(w, "2026-10-24T14:00:15Z");
    expect(await planWakes(w)).toEqual([]);
    await tickAt(w, "2026-10-24T14:00:45Z");
    // Written between the 14:00:45 and 14:01:00 ticks, for 14:01: it counts as written in time.
    await writeDay(w, [{ at: "14:01", what: "just in time" }, { at: "14:01", what: "squeezed in" }]);
    await tickAt(w, "2026-10-24T14:01:00Z");
    expect((await planWakes(w)).map((wake) => wake.plans)).toEqual([[{ at: "14:01", what: "just in time" }, { at: "14:01", what: "squeezed in" }]]);
    // A file the app first sees after a restart counts as written then.
    await w.cast.stop();
    await writeDay(w, [{ at: "14:02", what: "written while the host was down" }]);
    const after = restarted(w);
    await tickAt(w, "2026-10-24T14:05:00Z", after);
    expect((await planWakes(w)).flatMap((wake) => wake.plans ?? []).map((plan) => plan.what)).not.toContain("written while the host was down");
  });

  it("a plan whose time is inside her bed time does not wake her (it stays a note)", async () => {
    const w = await planWorld({ waifu: { availability: { bedTime: { enabled: true, start: "22:00", end: "07:00" } } } });
    await writeDay(w, [{ at: "21:59", what: "brush teeth" }, { at: "22:30", what: "text Mira goodnight" }]);
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T21:59:00Z");
    expect((await planWakes(w)).map((wake) => wake.plans)).toEqual([[{ at: "21:59", what: "brush teeth" }]]);
    await takeImmediate(w.storage, "ella");
    await tickAt(w, "2026-10-24T22:30:00Z");
    await tickAt(w, "2026-10-24T22:31:00Z");
    expect(await planWakes(w)).toEqual([]);
    expect((await queue(w)).deferred.items).toEqual([]);
  });

  it("gets through a busy block and her bed time like a reminder (up late, dozing, asleep)", async () => {
    const w = await planWorld({ waifu: { availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } } } });
    await writeDay(w, [{ at: "14:30", what: "send K the photo" }], { busy: [{ from: "13:00", to: "15:00", why: "studio shift" }], phoneChecks: ["14:45"] });
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T14:30:00Z");
    const q = await queue(w);
    expect(q.held).toEqual([]);
    expect(q.immediate.map((wake) => wake.reason)).toEqual(["plan"]);
    const plan = (iso: string): Wake => ({ id: newWakeId(), reason: "plan", plans: [{ at: "00:20", what: "x" }], at: iso });
    // Dozing (no send for a while, 10 minutes into her bed time) and asleep (two hours in).
    w.clock.ms = at("2026-10-25T00:40:00Z");
    expect(await w.cast.router.route("ella", plan("2026-10-25T00:20:00.000Z"))).toBe("queued");
    w.clock.ms = at("2026-10-25T02:30:00Z");
    expect(await w.cast.router.route("ella", plan("2026-10-25T00:20:00.000Z"))).toBe("queued");
  });

  it("several plans at the same tick are one wake with one line each", async () => {
    const w = await planWorld();
    await writeDay(w, [{ at: "14:30", what: "check #secret-room" }, { at: "14:30", what: "ask Kevin about saturday" }]);
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T14:30:00Z");
    const wakes = await planWakes(w);
    expect(wakes).toHaveLength(1);
    expect(renderNotifications({ wakes }, VIEW)!.split("\n").slice(1, -1)).toEqual(['- plan · 14:30 · "check #secret-room"', '- plan · 14:30 · "ask Kevin about saturday"']);
  });

  it("over her daily budget it is deferred like a reminder, and listed when the batch comes", async () => {
    const w = await planWorld({ waifu: { life: { dailyBudgetUsd: 0.5 } } as Partial<WaifuSeed> });
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", "2026-10-24.jsonl"), `${JSON.stringify({ at: "2026-10-24T13:00:00.000Z", waifuId: "ella", purpose: "life", costUsd: 0.6 })}\n`);
    await writeDay(w, [{ at: "14:30", what: "send K the photo" }]);
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T14:30:00Z");
    const q = await queue(w);
    expect(q.immediate).toEqual([]);
    expect(q.deferred.reason).toBe("budget");
    expect(q.deferred.items).toMatchObject([{ reason: "plan", plans: [{ at: "14:30", what: "send K the photo" }] }]);
    // The same plan is not deferred twice.
    await tickAt(w, "2026-10-24T14:31:00Z");
    expect((await queue(w)).deferred.items).toHaveLength(1);
    const batch = morningBatch({ reason: "budget", since: new Date(at("2026-10-24T14:30:00Z")), until: new Date(at("2026-10-25T08:00:00Z")), places: [], items: q.deferred.items }, VIEW);
    expect(batch).toEqual(["- while you were away (since Sat 14:30):", '  · plan (Sat 14:30): "send K the photo"']);
  });

  it("forget: a queued plan's text that names the person becomes (removed), the plan stays", async () => {
    const w = await planWorld();
    await enqueueWake(w.storage, "ella", { id: "w-plan-x", reason: "plan", plans: [{ at: "14:30", what: "ask Kevin about saturday" }, { at: "14:30", what: "water the basil" }], at: "2026-10-24T14:30:00.000Z" });
    await scrubWakeQueue(w.storage, "ella", { userId: KEVIN, placeKeys: new Set(), mentions: (text) => /kevin/iu.test(text) });
    expect((await queue(w)).immediate[0]!.plans).toEqual([{ at: "14:30", what: REMOVED_TEXT }, { at: "14:30", what: "water the basil" }]);
  });

  it("plans without a time, phone checks and busy blocks never wake her", async () => {
    const w = await planWorld();
    await writeDay(w, [], { busy: [{ from: "14:10", to: "14:20", why: "nap" }], phoneChecks: ["14:15"] });
    await tickAt(w, "2026-10-24T14:00:00Z");
    for (const time of ["14:10", "14:15", "14:20", "14:30"]) await tickAt(w, `2026-10-24T${time}:00Z`);
    expect(await planWakes(w)).toEqual([]);
    // No timed plan: the app keeps no record either.
    await expect(readFile(path.join(w.root, "user/waifus/ella/life/plans-fired.json"), "utf8")).rejects.toThrow();
  });

  it("a plan for another day does not fire today", async () => {
    const w = await planWorld();
    await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-25", plans: [{ at: "14:30", what: "tomorrow's thing" }] }));
    await tickAt(w, "2026-10-24T14:00:00Z");
    await tickAt(w, "2026-10-24T14:30:00Z");
    expect(await planWakes(w)).toEqual([]);
  });
});

describe("what she is told about timed plans (§29)", () => {
  it("the morning greeting says plans with a time wake her", () => {
    expect(morningGreeting({ now: new Date(at("2026-10-24T08:30:00Z")), timeZone: "UTC", overnight: false })).toContain(`your mood, your plans. ${PLAN_WAKE_TEXT} Your day is yours to plan`);
  });

  let calls = 0;
  async function ctxFor(w: LifeWorld, turn = "turn-1"): Promise<ToolContext> {
    const deps = w.cast.deps;
    const waifu = await readWaifu(w.storage, "ella");
    const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
    return {
      deps,
      waifu,
      route,
      turn: { id: turn, sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
      signal: new AbortController().signal,
      toolCallId: "call_1",
      selfAuthorIds: await selfAuthorIds(w.storage, waifu),
      toolNames: offeredToolNames(deps)
    };
  }
  const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, { ...ctx, toolCallId: `call_${(calls += 1)}` });
  const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));

  it("a schedule write with a timed plan says so once per turn (Edit, Bash); without one it does not; the plans field's help says it", async () => {
    const w = await planWorld();
    const untimed = JSON.stringify({ date: "2026-10-24", plans: [{ what: "finish the rain poem" }] });
    expect(text(await applyPatch(await ctxFor(w), addFilePatch("~/life/schedule.json", untimed)))).not.toContain(PLAN_WAKE_TEXT);
    const ctx = await ctxFor(w, "turn-2");
    const timed = JSON.stringify({ date: "2026-10-24", plans: [{ at: "21:00", what: "movie night" }] });
    expect(text(await applyPatch(ctx, replaceFilePatch("~/life/schedule.json", timed)))).toContain(`\n${PLAN_WAKE_TEXT}`);
    const day = async () => (await homeOf(w).read("life/schedule.json"))!;
    expect(text(await applyPatch(ctx, lineEditPatch("~/life/schedule.json", await day(), "movie night", "movie night!")))).not.toContain(PLAN_WAKE_TEXT);
    expect(text(await applyPatch(await ctxFor(w, "turn-3"), lineEditPatch("~/life/schedule.json", await day(), "movie night!", "movie night")))).toContain(PLAN_WAKE_TEXT);
    expect(text(await run("Bash", { command: "sed -i 's/movie/film/' ~/life/schedule.json" }, await ctxFor(w, "turn-4")))).toContain(PLAN_WAKE_TEXT);
    // Other files never say it.
    expect(text(await applyPatch(await ctxFor(w, "turn-5"), addFilePatch("~/plans.md", "21:00 movie night\n")))).not.toContain(PLAN_WAKE_TEXT);
    const bad = await applyPatch(await ctxFor(w, "turn-6"), replaceFilePatch("~/life/schedule.json", JSON.stringify({ date: "2026-10-24", plans: [{ at: "9pm", what: "movie night" }] })));
    expect(text(bad)).toContain(`at is a local time like "21:00" (or left out). ${PLAN_WAKE_TEXT}`);
    expect(await homeOf(w).read("life/schedule.json")).toContain("film night");
  }, 30_000);
});
