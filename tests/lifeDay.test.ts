// Her day (Living cast spec §21): the morning wake that asks her to write `~/life/schedule.json`
// and the `day` compaction after it (§21.3), busy holds and the places she keeps chatting in while
// busy (§21.4), the note that her prompt's copy of her day or MEMORY.md is stale (§21.2), dreaming
// leaving `~/life/` alone (§21.6), forget scrubbing her day (§21.6), and her own `<summary>` fresh
// start (§21.6b). Temp data roots, fake Discord and scripted models; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";

/** The request size the life loop sees (a stand-in for a long life). */
const estimate = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("../src/life/request.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/life/request.js")>();
  return { ...real, estimateRequest: (...args: Parameters<typeof real.estimateRequest>) => estimate.value ?? real.estimateRequest(...args) };
});

import { scrubOtherState } from "../src/life/forget.js";
import { readLifeFile, readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { scanDmContent, viewLogLine } from "../src/life/lifeView.js";
import { lifeBudget } from "../src/life/request.js";
import { REST_SUMMARY_FRAME } from "../src/life/rest.js";
import { DREAM_LIFE_REFUSED, promptCopyText } from "../src/life/tools/files.js";
import { PLAN_WAKE_TEXT } from "../src/life/home/daySchedule.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import type { Wake } from "../src/shared/schemas/life.js";
import { textTurn, type ScriptedTurn } from "./modelFakes.js";
import { CHANNEL_2, closeWorlds, dmOf, GUILD, homeOf, KEVIN, lifeWorld, ROOM_KEY, script, toolTurn, writeHerFile, type LifeWorld, type WaifuSeed } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, applyPatch, lineEditPatch, replaceFilePatch, scriptInput, updateFilePatch } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  estimate.value = undefined;
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const SLEEPER: WaifuSeed = { id: "ella", name: "Ella", botId: "ella-bot", availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } } };
const ROOM_2_KEY = conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL_2 });
const at = (iso: string) => Date.parse(iso);
const plan = (date: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ date, mood: "slow morning", busy: [{ from: "12:00", to: "15:30", why: "studio shift" }], phoneChecks: ["13:30"], plans: [{ at: "21:00", what: "movie night" }], ...extra }, null, 2);

function lastText(request: { messages: Array<{ content: unknown }> }): string {
  return JSON.stringify(request.messages[request.messages.length - 1]!.content);
}

/** Her life begins (one turn), so she has a system snapshot and the scheduler's day rules apply. */
async function beginLife(w: LifeWorld): Promise<void> {
  await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "hello", at: w.clock.now().toISOString() });
  await w.cast.life("ella").runNow();
}

async function queue(w: LifeWorld) {
  return readLifeFile(w.storage, "ella", "wakes");
}

describe("the morning wake (§21.3)", () => {
  it("when her bed time ends she is asked to write today's schedule, overnight things follow; after the turn her context is compacted with today's plan", async () => {
    const w = await lifeWorld(roots, {
      waifus: [SLEEPER],
      scripts: script(
        textTurn("hi"),
        toolTurn([{ name: "Edit", input: scriptInput.applyPatch(addFilePatch("~/life/schedule.json", plan("2026-10-24"))) }]),
        textTurn("planned")
      )
    });
    w.clock.ms = at("2026-10-23T20:00:00Z");
    await w.cast.scheduler.tick();
    await beginLife(w);
    // Asleep: a watch that times out is deferred to her morning.
    w.clock.ms = at("2026-10-24T02:00:00Z");
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "watch", places: "everywhere", filter: [], options: { until: "2026-10-24 03:00", once: true }, note: "water the basil" }]));
    w.clock.ms = at("2026-10-24T03:01:00Z");
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate).toEqual([]);
    w.clock.ms = at("2026-10-24T08:29:00Z");
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate).toEqual([]);

    w.clock.ms = at("2026-10-24T08:31:00Z");
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    const morning = (await queue(w)).immediate;
    expect(morning).toHaveLength(1);
    expect(morning[0]).toMatchObject({ id: "w-day-2026-10-24", reason: "morning", day: "2026-10-24" });
    expect(morning[0]!.batch![0]).toBe(
      "[system] Good morning, it's Sat 24 Oct. Before anything else, write today's schedule in ~/life/schedule.json: when you'll be busy and why, when you'll check your phone while busy, your mood, your plans. Plans with a time wake you then. Your day is yours to plan: keep it believable for who you are. Your bed time (00:30–08:30) is fixed. Then deal with what came in overnight."
    );
    expect(morning[0]!.batch!.slice(1)).toEqual(["- during your bed time (00:30–08:30):", '  · watch timed out (Sat 03:00) · your note: "water the basil"']);

    await w.cast.life("ella").runNow();
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(calls).toHaveLength(3);
    expect(lastText(calls[1]!)).toContain("Good morning, it's Sat 24 Oct");
    // Her Write is told that the prompt's copy is old; it updates at the day compaction.
    expect(lastText(calls[2]!)).toContain(promptCopyText("~/life/schedule.json"));
    expect(calls[1]!.system).toContain("No plan for today yet.");
    // Her epoch holds two turns: the day compaction keeps them whole (no summary call) and block A
    // shows today's plan.
    const state = await readLifeState(w.storage, "ella");
    expect(state.lastCompaction).toMatchObject({ reason: "day", summarized: false });
    expect(state.epoch).toBe(2);
    expect(state.dayCompactionDue).toBeUndefined();
    expect(state.systemSnapshot!.harness).toContain("<schedule>\nYour bed time is 00:30–08:30.\nToday (2026-10-24)");
    expect(state.systemSnapshot!.harness).toContain("Busy 12:00–15:30: studio shift");
    expect(state.systemSnapshot!.harness).toContain("Phone checks while busy: 13:30");
    // One morning a day.
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate).toEqual([]);
  }, 30_000);

  it("with no plan written she has none today, and the compaction still runs once", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn("lazy day"), textTurn("hey")) });
    // No sleep window: her day starts at life.dayStartHourLocal (8).
    w.clock.ms = at("2026-10-24T07:00:00Z");
    await w.cast.scheduler.tick();
    await beginLife(w);
    w.clock.ms = at("2026-10-24T07:59:00Z");
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate).toEqual([]);
    w.clock.ms = at("2026-10-24T08:00:00Z");
    await w.cast.scheduler.tick();
    const [morning] = (await queue(w)).immediate;
    // Without a sleep window or anything overnight, the greeting says neither.
    expect(morning!.batch).toEqual([
      "[system] Good morning, it's Sat 24 Oct. Before anything else, write today's schedule in ~/life/schedule.json: when you'll be busy and why, when you'll check your phone while busy, your mood, your plans. Plans with a time wake you then. Your day is yours to plan: keep it believable for who you are."
    ]);
    await w.cast.life("ella").runNow();
    const state = await readLifeState(w.storage, "ella");
    expect(state.lastCompaction).toMatchObject({ reason: "day" });
    expect(state.systemSnapshot!.harness).toContain("No plan for today yet.");
    // A later wake is an ordinary turn: no second compaction.
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "again", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(3);
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(state.epoch);
  }, 30_000);

  it("a short epoch too heavy to keep whole is summarised by the day compaction (nothing is dropped unsummarised)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn(`long thoughts ${"cake ".repeat(14_000)}`), textTurn("my day"), textTurn("Summary: a heavy Saturday.")) });
    w.setConfig((config) => ({ ...config, life: { ...config.life, maxContextTokens: 32_000 } }));
    w.clock.ms = at("2026-10-24T07:00:00Z");
    await w.cast.scheduler.tick();
    await beginLife(w);
    w.clock.ms = at("2026-10-24T08:00:00Z");
    await w.cast.scheduler.tick();
    await w.cast.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).lastCompaction).toMatchObject({ reason: "day", summarized: true });
    expect(w.anthropic.calls).toHaveLength(3);
  });

  it("a longer epoch is summarised by the day compaction; one that began this morning (an upgrade's) is kept, so one compaction serves both", async () => {
    const turns = Array.from({ length: 4 }, (_, index) => textTurn(`turn ${index + 1}`));
    const w = await lifeWorld(roots, { scripts: script(...turns, textTurn("my day"), textTurn("Summary: a long Saturday.")) });
    w.clock.ms = at("2026-10-24T07:00:00Z");
    await w.cast.scheduler.tick();
    for (let index = 0; index < 4; index += 1) await beginLife(w);
    w.clock.ms = at("2026-10-24T08:00:00Z");
    await w.cast.scheduler.tick();
    await w.cast.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).lastCompaction).toMatchObject({ reason: "day", summarized: true });
    expect(w.anthropic.calls).toHaveLength(6);
  }, 30_000);

  it("a host that was down all morning sends it at the first tick after boot, once", async () => {
    const w = await lifeWorld(roots, { waifus: [SLEEPER], scripts: script(textTurn("hi"), textTurn("morning!"), textTurn("Summary: a late Saturday.")) });
    w.clock.ms = at("2026-10-23T20:00:00Z");
    await beginLife(w);
    await w.cast.stop();
    w.clock.ms = at("2026-10-24T14:00:00Z");
    const after = w.restart();
    await after.scheduler.tick();
    await after.scheduler.tick();
    expect((await readLifeState(w.storage, "ella")).lastDayStart).toBe("2026-10-24T08:30:00.000Z");
    // The wake may already be running (the scheduler pokes her life); either way exactly one morning turn.
    await after.life("ella").runNow();
    const mornings = w.anthropic.calls.filter((call) => lastText(call.request).includes("Good morning, it's Sat 24 Oct"));
    expect(mornings).toHaveLength(1);
    expect((await queue(w)).immediate).toEqual([]);
  });

  it("a day wake deferred for her budget comes back as the day wake (greeting first, day kept) once she is under budget again", async () => {
    const { deferImmediate } = await import("../src/life/wakeQueue.js");
    const w = await lifeWorld(roots, { waifus: [SLEEPER] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    w.clock.ms = at("2026-10-24T09:00:00Z");
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, lastDayStart: "2026-10-24T08:30:00.000Z" }));
    await enqueueWake(w.storage, "ella", { id: "w-day-2026-10-24", reason: "morning", day: "2026-10-24", batch: ["[system] Good morning, it's Sat 24 Oct."], at: w.clock.now().toISOString() });
    await deferImmediate(w.storage, "ella", "budget", w.clock.now(), () => false);
    expect((await queue(w)).immediate).toEqual([]);
    // The owner raised her budget (there is none here): the next tick releases it.
    await w.cast.scheduler.tick();
    const [released] = (await queue(w)).immediate;
    expect(released).toMatchObject({ id: "w-day-2026-10-24", reason: "morning", day: "2026-10-24" });
    expect(released!.batch![0]).toBe("[system] Good morning, it's Sat 24 Oct.");
  });

  it("is never folded into a running turn: it opens the next one", async () => {
    let world: LifeWorld | undefined;
    const dayWake: Wake = { id: "w-day-2026-10-24", reason: "morning", day: "2026-10-24", batch: ["[system] Good morning, it's Sat 24 Oct."], at: "2026-10-24T14:00:00.000Z" };
    const queueing = (events: ProviderEvent[]): ScriptedTurn => () =>
      (async function* () {
        await enqueueWake(world!.storage, "ella", dayWake);
        for (const event of events) yield event;
      })();
    const w = await lifeWorld(roots, { scripts: [queueing(toolTurn([{ name: "Read", input: scriptInput.readFile("~/MEMORY.md") }])), () => textTurn("done"), () => textTurn("good morning to me"), () => textTurn("Summary.")] });
    world = w;
    await homeOf(w).write("MEMORY.md", "# Memory\n");
    await beginLife(w);
    const calls = w.anthropic.calls.map((call) => call.request);
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("Good morning");
    expect(lastText(calls[2]!)).toContain("Good morning, it's Sat 24 Oct");
    expect((await readLifeState(w.storage, "ella")).lastCompaction).toMatchObject({ reason: "day" });
  });
});

// ---- busy holds (§21.4) ---------------------------------------------------------------------------

/** Ella, busy 13:00–15:00 today ("studio shift", phone check 14:30), at 14:00. */
async function busyWorld(scripts: ScriptedTurn[] = [], blocks?: Array<{ from: string; to: string; why: string }>): Promise<LifeWorld> {
  const w = await lifeWorld(roots, { scripts });
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-24", busy: blocks ?? [{ from: "13:00", to: "15:00", why: "studio shift" }], phoneChecks: ["14:30"] }));
  return w;
}

function wake(reason: Wake["reason"], o: Partial<Wake> = {}): Wake {
  return { id: newWakeId(), reason, placeKey: ROOM_KEY, fromUserId: "300000000000000003", fromName: "Kevin", messageId: "900000000000000001", preview: "hey", at: new Date(Date.parse("2026-10-24T14:00:00Z")).toISOString(), ...o };
}

describe("busy holds (§21.4, S4)", () => {
  it("DMs, mentions, replies, her name, the owner, reminders and watches get through; picks, chime-ins, @everyone, roles and follow-ups are held", async () => {
    const w = await busyWorld();
    const through = [wake("mention"), wake("name"), wake("dm", { placeKey: "dm_300000000000000003_ella" }), wake("owner", { placeKey: undefined }), wake("reminder", { placeKey: undefined, note: "x" }), wake("watch", { note: "x" }), wake("watch_timeout", { placeKey: undefined, note: "x" }), wake("detector", { reasons: ["detector", "mention"] })];
    const held = [wake("detector"), wake("detector", { chimeIn: true }), wake("detector", { forAll: true }), wake("everyone"), wake("role"), wake("followup")];
    for (const entry of through) expect(await w.cast.router.route("ella", entry), entry.reason).toBe("queued");
    for (const entry of held) expect(await w.cast.router.route("ella", entry), entry.reason).toBe("held");
    const q = await queue(w);
    expect(q.immediate.map((entry) => entry.id)).toEqual(through.map((entry) => entry.id));
    expect(q.held.map((entry) => entry.id)).toEqual(held.map((entry) => entry.id));
    expect(q.held.every((entry) => entry.heldUntil === "2026-10-24T14:30:00.000Z" && entry.heldFor === "studio shift")).toBe(true);
    // Held wakes never start a turn.
    expect(await (await import("../src/life/wakeQueue.js")).pendingWakeCount(w.storage, "ella")).toBe(through.length);
  });

  it("not busy (no plan today, or yesterday's plan), nothing is held", async () => {
    const w = await busyWorld();
    await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-23", busy: [{ from: "13:00", to: "15:00", why: "studio shift" }] }));
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("queued");
  });

  it("held wakes arrive together at her phone check, with one line saying why", async () => {
    const w = await busyWorld(script(textTurn("ok")));
    await w.cast.router.route("ella", wake("detector", { messageId: "900000000000000001", preview: "anyone free?" }));
    await w.cast.router.route("ella", wake("everyone", { placeKey: ROOM_2_KEY, messageId: "900000000000000002", preview: "party tonight" }));
    w.clock.ms = at("2026-10-24T14:29:00Z");
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate).toEqual([]);
    w.clock.ms = at("2026-10-24T14:30:00Z");
    await w.cast.scheduler.tick();
    const q = await queue(w);
    expect(q.held).toEqual([]);
    expect(q.immediate.map((entry) => entry.released)).toEqual([{ kind: "phone", why: "studio shift" }, { kind: "phone", why: "studio shift" }]);
    await w.cast.life("ella").runNow();
    const first = lastText(w.anthropic.calls[0]!.request);
    expect(first).toContain("<notifications>\\n- phone check (busy: studio shift)\\n- maybe for you · bake-club/#general");
    expect(first).toContain("@everyone · bake-club/#recipes");
  });

  it("held after her last phone check, they arrive when the block ends: free again", async () => {
    const w = await busyWorld();
    w.clock.ms = at("2026-10-24T14:40:00Z");
    await w.cast.router.route("ella", wake("detector", { at: "2026-10-24T14:40:00.000Z" }));
    expect((await queue(w)).held[0]!.heldUntil).toBe("2026-10-24T15:00:00.000Z");
    w.clock.ms = at("2026-10-24T15:00:00Z");
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate[0]!.released).toEqual({ kind: "free", why: "studio shift" });
    const { renderNotifications } = await import("../src/life/notifications.js");
    const view = { timeZone: "UTC", handle: () => "bake-club/#general", unread: () => undefined };
    expect(renderNotifications({ wakes: (await queue(w)).immediate }, view)!.split("\n")[1]).toBe("- free again (studio shift is over)");
  });

  it("a phone check she adds after a wake was held releases it then; holds survive a restart", async () => {
    const w = await busyWorld();
    w.clock.ms = at("2026-10-24T14:40:00Z");
    await w.cast.router.route("ella", wake("detector", { at: "2026-10-24T14:40:00.000Z" }));
    await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-24", busy: [{ from: "13:00", to: "15:00", why: "studio shift" }], phoneChecks: ["14:30", "14:50"] }));
    await w.cast.stop();
    const after = w.restart();
    w.clock.ms = at("2026-10-24T14:49:00Z");
    await after.scheduler.tick();
    expect((await queue(w)).held).toHaveLength(1);
    w.clock.ms = at("2026-10-24T14:50:00Z");
    await after.scheduler.tick();
    expect((await queue(w)).immediate.map((entry) => entry.released)).toEqual([{ kind: "phone", why: "studio shift" }]);
  });
});

describe("held wakes at the edges (§21.4, §21.6c)", () => {
  it("held wakes that come due inside her bed time wait for her morning, not a poke", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", availability: { bedTime: { enabled: true, start: "15:00", end: "20:00" } } }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-24", busy: [{ from: "13:00", to: "15:00", why: "studio shift" }] }));
    w.clock.ms = at("2026-10-24T14:40:00Z");
    expect(await w.cast.router.route("ella", wake("detector", { at: "2026-10-24T14:40:00.000Z" }))).toBe("held");
    // The block ends where her bed time starts (or the host was down until then).
    w.clock.ms = at("2026-10-24T15:01:00Z");
    await w.cast.scheduler.tick();
    let q = await queue(w);
    expect(q.held).toEqual([]);
    expect(q.immediate).toEqual([]);
    expect(q.deferred).toMatchObject({ reason: "sleep", places: { [ROOM_KEY]: { detector: 1 } } });
    w.clock.ms = at("2026-10-24T20:01:00Z");
    await w.cast.scheduler.tick();
    q = await queue(w);
    expect(q.immediate.map((entry) => entry.reason)).toEqual(["morning"]);
    expect(q.immediate[0]!.batch).toContainEqual("- during your bed time (15:00–20:00):");
  });

  it("the held list is capped (a wake joins one of its place, else the oldest goes); a merge keeps why it was released", async () => {
    const { withHeld, withImmediate, MAX_HELD_WAKES, MAX_IMMEDIATE_WAKES } = await import("../src/life/wakeQueue.js");
    const empty = { immediate: [], held: [], quiet: [], deferred: { places: {}, items: [] } } as unknown as Parameters<typeof withHeld>[0];
    let q = empty;
    for (let index = 0; index < MAX_HELD_WAKES; index += 1) q = withHeld(q, wake("detector", { id: `h${index}`, placeKey: `g_1_${index}`, heldUntil: "2026-10-24T15:00:00.000Z" }));
    const joined = withHeld(q, wake("detector", { id: "h-new", placeKey: "g_1_5", heldUntil: "2026-10-24T15:00:00.000Z" }));
    expect(joined.held).toHaveLength(MAX_HELD_WAKES);
    expect(joined.held[5]).toMatchObject({ id: "h5", count: 2 });
    const dropped = withHeld(q, wake("detector", { id: "h-other", placeKey: "g_9_9", heldUntil: "2026-10-24T15:00:00.000Z" }));
    expect(dropped.held).toHaveLength(MAX_HELD_WAKES);
    expect(dropped.held[0]!.id).toBe("h1");
    expect(dropped.held.at(-1)!.id).toBe("h-other");
    let full = { ...empty } as typeof empty;
    for (let index = 0; index < MAX_IMMEDIATE_WAKES; index += 1) full = withImmediate(full, wake("mention", { id: `i${index}`, placeKey: `g_2_${index}` }));
    const merged = withImmediate(full, wake("detector", { id: "late", placeKey: "g_2_7", released: { kind: "phone", why: "studio shift" } }));
    expect(merged.immediate[7]).toMatchObject({ id: "i7", released: { kind: "phone", why: "studio shift" } });
  });
});

describe("staying in a conversation while busy (§21.4, owner addition)", () => {
  const SEND = toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "on shift, but sure" } }]);

  /** A mention reaches her while busy and she answers in the room. */
  async function answered(w: LifeWorld): Promise<void> {
    await w.cast.router.route("ella", wake("mention"));
    await w.cast.life("ella").runNow();
    expect(w.discord.sent).toHaveLength(1);
  }

  it("after she answers a mention, a pick there gets through for 10 minutes; other places stay held; after that it is held again", async () => {
    const w = await busyWorld(script(SEND, textTurn("ok")));
    await answered(w);
    expect((await readLifeState(w.storage, "ella")).busyOpen?.[ROOM_KEY]).toMatchObject({ until: expect.stringMatching(/^2026-10-24T14:10/u), blockEnd: "2026-10-24T15:00:00.000Z" });
    w.clock.ms = at("2026-10-24T14:09:00Z");
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("queued");
    expect(await w.cast.router.route("ella", wake("detector", { placeKey: ROOM_2_KEY }))).toBe("held");
    w.clock.ms = at("2026-10-24T14:11:00Z");
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("held");
  });

  it("each send there extends it", async () => {
    const w = await busyWorld(script(SEND, textTurn("ok"), SEND, textTurn("ok")));
    await answered(w);
    // Eight minutes later a pick gets through (the place is open) and she answers again.
    w.clock.ms = at("2026-10-24T14:08:00Z");
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("queued");
    await w.cast.life("ella").runNow();
    w.clock.ms = at("2026-10-24T14:15:00Z");
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("queued");
    w.clock.ms = at("2026-10-24T14:19:00Z");
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("held");
  });

  it("a send without a wake that got through there opens nothing", async () => {
    const w = await busyWorld(script(SEND, textTurn("ok")));
    await w.cast.router.route("ella", wake("reminder", { placeKey: undefined, note: "post the flyer" }));
    await w.cast.life("ella").runNow();
    expect(w.discord.sent).toHaveLength(1);
    expect((await readLifeState(w.storage, "ella")).busyOpen).toBeUndefined();
    expect(await w.cast.router.route("ella", wake("detector"))).toBe("held");
  });

  it("ends with the busy block, and survives a restart", async () => {
    const w = await busyWorld(script(SEND, textTurn("ok")), [
      { from: "13:00", to: "14:05", why: "studio shift" },
      { from: "14:05", to: "16:00", why: "gym" }
    ]);
    await answered(w);
    await w.cast.stop();
    const after = w.restart();
    w.clock.ms = at("2026-10-24T14:04:00Z");
    expect(await after.router.route("ella", wake("detector"))).toBe("queued");
    // A new block: the place is held again, though her ten minutes are not over.
    w.clock.ms = at("2026-10-24T14:06:00Z");
    expect(await after.router.route("ella", wake("detector"))).toBe("held");
  });
});

describe("the life-folder marker (§21.6)", () => {
  it("any write the app makes to her home writes the marker first: an owner's ~/schedule.json or her profile from the dashboard are never migrated", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }, { id: "mina", name: "Mina", botId: "mina-bot" }] });
    const { homeStoreFor } = await import("../src/life/home/index.js");
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { migrateLivingCastLifeFolder } = await import("../src/backend/migrationSteps/livingCastLifeFolder.js");
    // Never run, never ticked: the owner writes a file at the top of her home over the API.
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const target = store.resolve("~/schedule.json");
    if (!target.ok) throw new Error("path");
    await store.writeText(target.path, "my shopping schedule\n", { now: w.clock.now(), timeZone: "UTC", resolvePerson: async () => undefined } as never);
    const marker = (id: string) => readFile(path.join(w.root, "user", "waifus", id, "life", "life-folder-v1.json"), "utf8").catch(() => undefined);
    expect(await marker("ella")).toBeDefined();
    expect(await migrateLivingCastLifeFolder(w.root)).toBeUndefined();
    expect(await homeOf(w).read("schedule.json")).toBe("my shopping schedule\n");
    // The dashboard's profile rewrite (a new or edited waifu) writes it too.
    expect(await marker("mina")).toBeUndefined();
    await homeStoreFor(w.cast.deps, await readWaifu(w.storage, "mina")).writeProfileFromConfig();
    expect(await marker("mina")).toBeDefined();
    expect(await migrateLivingCastLifeFolder(w.root)).toBeUndefined();
  });

  it("a life the app runs gets the marker, so a re-run of the migration leaves her home alone", async () => {
    const w = await lifeWorld(roots);
    await w.cast.scheduler.tick();
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const marker = path.join(w.root, "user", "waifus", "ella", "life", "life-folder-v1.json");
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ version: 1, state: "done" });
    await writeHerFile(w, "schedule.json", JSON.stringify({ date: "2026-10-24", busy: [] }));
    const { migrateLivingCastLifeFolder } = await import("../src/backend/migrationSteps/livingCastLifeFolder.js");
    expect(await migrateLivingCastLifeFolder(w.root)).toBeUndefined();
    expect(await homeOf(w).read("schedule.json")).toContain("2026-10-24");
  });
});

// ---- the prompt's copy and dreaming (§21.2, §21.6) ------------------------------------------------

async function ctxFor(w: LifeWorld, o: Partial<ToolContext> = {}): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps),
    ...o
  };
}

let calls = 0;
const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, { ...ctx, toolCallId: `call_${(calls += 1)}` });
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
const DAY_NOTE = promptCopyText("~/life/schedule.json");
const MEMORY_NOTE = promptCopyText("~/MEMORY.md");

describe("her prompt's copy of her day and MEMORY.md (§21.2)", () => {
  it("Edit and Bash say once per turn that the copy is old; other files and unchanged writes say nothing", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const first = await applyPatch(ctx, addFilePatch("~/life/schedule.json", plan("2026-10-24")));
    // Her day has a plan with a time: the write also says those wake her (§29).
    expect(text(first)).toBe(`Updated: A ~/life/schedule.json\n${DAY_NOTE}\n${PLAN_WAKE_TEXT}`);
    const day = (await homeOf(w).read("life/schedule.json"))!;
    expect(text(await applyPatch(ctx, lineEditPatch("~/life/schedule.json", day, "slow morning", "sleepy")))).toBe("Updated: M ~/life/schedule.json");
    expect(text(await applyPatch(ctx, addFilePatch("~/MEMORY.md", "# Memory\n")))).toContain(MEMORY_NOTE);
    expect(text(await applyPatch(ctx, addFilePatch("~/people/kevin.md", "# Kevin\n")))).not.toContain("system prompt");
    // A new turn: Edit and Bash say it again.
    const next = await ctxFor(w, { turn: { id: "turn-2", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } });
    expect(text(await applyPatch(next, updateFilePatch("~/MEMORY.md", ["# Memory", "# My memory"])))).toBe(`Updated: M ~/MEMORY.md\n${MEMORY_NOTE}`);
    const third = await ctxFor(w, { turn: { id: "turn-3", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } });
    const bash = await run("Bash", { command: "sed -i 's/sleepy/rested/' ~/life/schedule.json && echo '- [Kevin](people/kevin.md)' >> ~/MEMORY.md" }, third);
    expect(text(bash)).toContain(DAY_NOTE);
    expect(text(bash)).toContain(MEMORY_NOTE);
    // Rewriting the same bytes changes nothing to tell.
    const same = await homeOf(w).read("people/kevin.md");
    expect(text(await applyPatch(third, replaceFilePatch("~/people/kevin.md", same!)))).toBe("No change: D ~/people/kevin.md, A ~/people/kevin.md (the files already read like that)");
  });

  it("is never said outside her life (dreaming), and not for her day when it is kept out of her prompt", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", scheduleInPrompt: false }] });
    const ctx = await ctxFor(w);
    expect(text(await applyPatch(ctx, addFilePatch("~/life/schedule.json", plan("2026-10-24"))))).not.toContain("system prompt");
    const dream = await ctxFor(w, { mode: "session", session: "dream" });
    expect(text(await applyPatch(dream, addFilePatch("~/MEMORY.md", "# Memory\n")))).not.toContain("system prompt");
  });
});

describe("dreaming leaves ~/life/ alone (§21.6)", () => {
  it("Edit and Bash refuse to change anything there; notes and MEMORY.md are fine", async () => {
    const w = await lifeWorld(roots);
    await writeHerFile(w, "life/schedule.json", plan("2026-10-24"));
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "at", when: "2026-10-24 18:00", note: "flyer" }]));
    const dream = await ctxFor(w, { mode: "session", session: "dream" });
    const refused = { content: `error: Error: apply_patch: ${DREAM_LIFE_REFUSED.replace(/^error:\s*/u, "")}; nothing was changed (line 1)`, isError: true };
    expect(await applyPatch(dream, replaceFilePatch("~/life/schedule.json", plan("2026-10-25")))).toEqual(refused);
    const wakeups = (await homeOf(w).read("life/wakeups.json"))!;
    expect(await applyPatch(dream, lineEditPatch("~/Life/Wakeups.json", wakeups, "flyer", "poster"))).toEqual(refused);
    expect(await applyPatch(dream, addFilePatch("~/life/new-note.md", "x"))).toEqual(refused);
    // The same patch adding a note outside ~/life/ too: all or nothing.
    expect(await applyPatch(dream, `${addFilePatch("~/ok.md", "fine").replace("\n*** End Patch", "")}\n*** Add File: ~/life/x.md\n+x\n*** End Patch`)).toEqual(refused);
    expect(await homeOf(w).read("ok.md")).toBeUndefined();
    // The retired Write still refuses too.
    expect(await run("Write", { file_path: "~/life/schedule.json", content: plan("2026-10-25") }, dream)).toEqual({ content: DREAM_LIFE_REFUSED, isError: true });
    const bash = await run("Bash", { command: "rm ~/life/wakeups.json" }, dream);
    expect(text(bash)).toContain(`error: changes not saved: ${DREAM_LIFE_REFUSED.replace(/^error:\s*/u, "")}`);
    expect(await homeOf(w).read("life/wakeups.json")).toContain("flyer");
    expect(text(await applyPatch(dream, addFilePatch("~/MEMORY.md", "# Memory\n")))).toBe("Updated: A ~/MEMORY.md");
    // A forget's notes scrub (another session) may still tidy her wakeups.
    const scrub = await ctxFor(w, { mode: "session", session: "scrub" });
    expect(text(await applyPatch(scrub, lineEditPatch("~/life/wakeups.json", (await homeOf(w).read("life/wakeups.json"))!, "flyer", "poster")))).toBe("Updated: M ~/life/wakeups.json");
  });
});

describe("forget and her day (§21.6)", () => {
  it("a text field of her day that names the person becomes (removed); the rest stays", async () => {
    const w = await lifeWorld(roots);
    await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-24", mood: "good", busy: [{ from: "12:00", to: "13:00", why: "lunch with Quillon" }], plans: [{ what: "call Quillon back" }, { what: "bake" }], note: "nothing" }));
    const deps = w.cast.deps;
    await scrubOtherState(deps, { id: "ella", name: "Ella", displayName: "Ella" } as never, { userId: "300000000000000003", names: ["Quillon"], sharedNames: [] });
    const day = JSON.parse((await homeOf(w).read("life/schedule.json"))!) as Record<string, unknown>;
    expect(day).toEqual({ date: "2026-10-24", mood: "good", busy: [{ from: "12:00", to: "13:00", why: "(removed)" }], phoneChecks: [], plans: [{ what: "(removed)" }, { what: "bake" }], note: "nothing" });
  });
});

// ---- her own fresh start (§21.6b) -----------------------------------------------------------------

const SUMMARY = `Bake Club #general: Kevin is coming Saturday and I promised lemon tarts. ${"Mina and I joked about the menace cat and planned a bake-off for next week. ".repeat(3)}`;

/** 0.5 × her compaction trigger: past selfSummaryMinRatio (0.3), short of the rest notice. */
function halfFull(w: LifeWorld): number {
  const model = w.cast.deps.catalog().models.find((entry) => entry.modelId === "claude-haiku-5-5")!;
  return Math.round(0.5 * w.config.compaction.triggerRatio * lifeBudget(model, w.config.life.maxContextTokens));
}

describe("a fresh start when she wants one (§21.6b)", () => {
  async function selfWorld(reply: string, o: { oldEpoch?: boolean } = {}) {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn(reply), textTurn("hello again")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    if (o.oldEpoch !== false) w.clock.advance(3 * 3_600_000);
    estimate.value = halfFull(w);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "go", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    return w;
  }

  it("a reply that is only <summary>…</summary> starts a new epoch from it alone; queued wakes wait for it; the owner sees it only locally", async () => {
    const w = await selfWorld(`\n  <summary>\n${SUMMARY}\n</summary>  \n`);
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe(`${REST_SUMMARY_FRAME}\n${SUMMARY.trim()}`);
    expect(state.lastCompaction).toMatchObject({ reason: "self", summarized: true, fromEpoch: 1 });
    expect((await readLifeLog(w.storage, "ella", 2))[0]).toMatchObject({ kind: "compaction_boundary", boundary: { reason: "self", keptTurns: 0 } });
    expect(w.ledger.lines.map((line) => line.purpose)).not.toContain("compaction");
    // Private like the rest turn's summary.
    const lines = await readLifeLog(w.storage, "ella", 1);
    const scan = scanDmContent(lines);
    const views = lines.map((line) => viewLogLine(line, scan, { includePrivate: false }).view);
    expect(JSON.stringify(views)).not.toContain("lemon tarts");
    expect(JSON.stringify(lines.map((line) => viewLogLine(line, scan, { includePrivate: true }).view))).toContain("lemon tarts");
    // Her next turn is in the new epoch.
    estimate.value = undefined;
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "next", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    const last = w.anthropic.calls[w.anthropic.calls.length - 1]!.request;
    expect(last.system).toContain(REST_SUMMARY_FRAME);
    expect(last.messages).toHaveLength(1);
  });

  it("text outside the tag is an ordinary reply: nothing resets", async () => {
    const w = await selfWorld(`ok then <summary>${SUMMARY}</summary>`);
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
    expect((await readLifeState(w.storage, "ella")).selfSummaryRefused).toBeUndefined();
  });

  it.each([
    ["too short", "<summary>short</summary>", {}, "it is shorter than 200 characters"],
    ["memory far from full", `<summary>${SUMMARY}</summary>`, { small: true }, "your memory is still far from full"],
    ["too soon after her last epoch start", `<summary>${SUMMARY}</summary>`, { oldEpoch: false }, "your last fresh start was less than 120 minutes ago"]
  ])("a failed guard (%s) resets nothing and her next time line says why, once", async (_name, reply, o: { small?: boolean; oldEpoch?: boolean }, reason) => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn(reply), textTurn("hm"), textTurn("hm")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    if (o.oldEpoch !== false) w.clock.advance(3 * 3_600_000);
    estimate.value = o.small ? 10 : halfFull(w);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "go", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
    expect((await readLifeState(w.storage, "ella")).selfSummaryRefused).toBe(reason);
    for (const note of ["one", "two"]) {
      await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });
      await w.cast.life("ella").runNow();
    }
    const [third, fourth] = w.anthropic.calls.slice(2).map((call) => lastText(call.request));
    expect(third).toContain(`(your summary was not used: ${reason})`);
    expect(fourth).not.toContain("your summary was not used");
  });

  it("a refused summary in a DM turn still gets the unsent-reply nudge, which says why it was not used", async () => {
    const { UNSENT_REPLY_NOTE } = await import("../src/life/lifeLoop.js");
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn("<summary>short</summary>"), textTurn("(nothing to add)")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    const dm = w.discord.post(dmOf("ella"), "are you there?");
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "dm", placeKey: `dm_${KEVIN}_ella`, fromUserId: KEVIN, fromName: "Kevin", messageId: dm.id, preview: "are you there?", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    const nudge = lastText(w.anthropic.calls[2]!.request);
    expect(nudge).toContain(UNSENT_REPLY_NOTE.slice(0, 40));
    expect(nudge).toContain("(your summary was not used: it is shorter than 200 characters)");
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
  });

  it("the cooldown counts from her last epoch start, across a restart", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn(`<summary>${SUMMARY}</summary>`)) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, epochStartedAt: new Date(w.clock.ms - 60 * 60_000).toISOString() }));
    await w.cast.stop();
    const after = w.restart();
    vi.spyOn(after.life("ella"), "poke").mockImplementation(() => undefined);
    estimate.value = halfFull(w);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "go", at: w.clock.now().toISOString() });
    await after.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).selfSummaryRefused).toBe("your last fresh start was less than 120 minutes ago");
  });
});
