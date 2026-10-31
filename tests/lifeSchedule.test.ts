// No bed time (Living cast spec §38): every wake reaches her at any hour; the batch of what waited
// while she was over her daily budget (§4.4, §4.7, §23); a queue and a state saved before §38 (wakes
// deferred for her bed time, held for her busy blocks, old state keys) released at the first tick;
// reminders, watch timeouts and maintenance timing (§5.7, §6.6, §7.3, §16.4, §16.5, §30.2).
// Reminders and watches live in her own files. The scheduler is ticked by hand; lives never run here.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, readLifeState } from "../src/life/lifeStore.js";
import { renderNotifications } from "../src/life/notifications.js";
import { maintenanceDue } from "../src/life/scheduler.js";
import { nextOccurrences, parseEvery } from "../src/life/wakeups/when.js";
import { takeImmediate } from "../src/life/wakeQueue.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ELLA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, herEntries, homeOf, KEVIN, lifeWorld, ROOM, ROOM_KEY, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function say(w: LifeWorld, text: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}) {
  const message = w.discord.post(ROOM, text, o);
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
  // A burst nobody was addressed in goes to the detector at this (fake) time, not when the real
  // debounce timer happens to fire after the test has moved the clock.
  w.cast.intake.flushDetector();
  await w.cast.settle();
}

async function quietWorld(o: Parameters<typeof lifeWorld>[1] = {}): Promise<LifeWorld> {
  const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "" } }], ...o });
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  return w;
}

/** Writes one of her life files as an older version saved it (no schema in between). */
async function writeOld(w: LifeWorld, name: string, value: Record<string, unknown>): Promise<void> {
  const file = path.join(w.root, "user", "waifus", "ella", "life", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...createRevisionedBase(), ...value }, null, 2));
}

async function overBudget(w: LifeWorld, iso = w.clock.now().toISOString()): Promise<void> {
  const day = iso.slice(0, 10);
  await mkdir(path.join(w.root, "user/usage"), { recursive: true });
  await appendFile(path.join(w.root, "user/usage", `${day}.jsonl`), `${JSON.stringify({ at: iso, waifuId: "ella", purpose: "life", costUsd: 0.75 })}\n`);
  w.cast.cost.invalidate();
}

describe("no bed time: she is reachable at any hour (§38)", () => {
  it("at 03:00 a mention, a DM, a watch match and a reminder all reach her at once; nothing is deferred or held", async () => {
    const w = await quietWorld();
    w.clock.ms = Date.parse("2026-10-25T03:00:00.000Z");
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "at", when: "2026-10-25 03:05", note: "check the bake sale flyer" }, { kind: "watch", places: "bake-club/#general", filter: { words: ["brownie"] }, options: { until: "2026-10-26 14:00", once: true }, note: "Mina wanted brownie tips" }]));
    await say(w, `<@${ELLA_BOT}> you up?`, { mentions: { [ELLA_BOT]: "Ella" } });
    await say(w, "best brownie recipe anyone?");
    const dm = w.discord.post(dmOf("ella"), "goodnight ella");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    w.clock.advance(10 * 60_000);
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => wake.reason).sort()).toEqual(["dm", "mention", "reminder", "watch"]);
    expect(queue.deferred).toEqual({ places: {}, items: [] });
    expect(queue.held).toBeUndefined();
    // Her time line names only the time (§38: no `awake`, `asleep` or `busy` any more).
    const { timeLine } = await import("../src/life/clock.js");
    expect(timeLine({ now: w.clock.now(), timeZone: "UTC" })).toBe("[Sun 25 Oct 03:10]");
  }, 30_000);
});

describe("the budget's batch (§4.4, §4.7, §23)", () => {
  it("a budget pause ends with the next local day: one batch, its lines with their day", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", life: { dailyBudgetUsd: 0.5 } }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await overBudget(w);
    await say(w, `<@${ELLA_BOT}> hi`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.scheduler.tick();
    let queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.reason).toBe("budget");
    // Still over budget later that day: it keeps waiting.
    w.clock.ms = Date.parse("2026-10-24T23:50:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toEqual([]);
    w.clock.ms = Date.parse("2026-10-25T00:05:00.000Z");
    w.cast.cost.invalidate();
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => wake.reason)).toEqual(["morning"]);
    // §23: yesterday's times have their weekday.
    expect(queue.immediate[0]!.batch).toEqual(["- while you were away (since Sat 24 Oct 14:00):", "  · bake-club/#general: 1 mention, 1 message (Sat 24 Oct 14:00)", '    · mention · Sat 24 Oct 14:00 #a0 from Kevin "<@Ella> hi"']);
    expect(queue.deferred).toEqual({ places: {}, items: [] });
    // Rendered, the batch is its own lines.
    expect(renderNotifications({ wakes: queue.immediate }, { timeZone: "UTC", handle: (key) => key, unread: () => undefined })).toBe(`<notifications>\n${queue.immediate[0]!.batch!.join("\n")}\n</notifications>`);
  });
});

describe("a queue and a state saved before §38", () => {
  const oldQueue = (o: { since: string; messageId: string }) => ({
    immediate: [{ id: "w-day-2026-10-24", reason: "morning", day: "2026-10-24", batch: ["[system] Good morning, it's Sat 24 Oct. Before anything else, write today's schedule in ~/life/schedule.json."], at: "2026-10-24T08:30:00.000Z" }],
    held: [{ id: "w-held-1", reason: "detector", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: o.messageId, preview: "anyone baking today?", heldUntil: "2026-10-24T15:30:00.000Z", heldFor: "studio shift", at: "2026-10-24T13:40:00.000Z" }],
    deferred: {
      reason: "sleep",
      since: o.since,
      places: { [ROOM_KEY]: { mentions: 1, messages: 0, dms: 0, detector: 0, fromUserIds: [KEVIN], names: { [KEVIN]: "Kevin" }, lines: [{ id: o.messageId, fromUserId: KEVIN, fromName: "Kevin", preview: "<@Ella> you up?", reasons: ["mention"] }] } },
      items: [{ id: "w-plan-old", reason: "plan", plans: [{ at: "13:00", what: "bake bread" }], at: "2026-10-24T13:00:00.000Z" }]
    }
  });

  it("parses, and the first tick releases what was held (as ordinary wakes) and what waited for her morning (one batch)", async () => {
    const w = await quietWorld();
    const message = w.discord.post(ROOM, "<@Ella> you up?", { mentions: { [ELLA_BOT]: "Ella" } });
    await writeOld(w, "wakes.json", oldQueue({ since: "2026-10-24T13:30:00.000Z", messageId: message.id }));
    await writeOld(w, "state.json", {
      waifuId: "ella", epoch: 1, epochStartedAt: "2026-10-24T08:00:00.000Z", status: "idle", summary: null, systemSnapshot: null, modelRoute: null,
      inlineImageCount: 0, inlineImageBytes: 0, shownImageKeys: [], readMessageIds: [], pendingNotices: [], deletedReadIds: [], scrubbedAt: {},
      lastDayStart: "2026-10-24T08:30:00.000Z", dayCompactionDue: true, busyOpen: { [ROOM_KEY]: { until: "2026-10-24T14:10:00.000Z", blockEnd: "2026-10-24T15:30:00.000Z" } },
      lastSentAt: "2026-10-24T13:55:00.000Z", recentSends: { [ROOM_KEY]: "2026-10-24T13:55:00.000Z" }
    });
    // Read before any tick: the old fields are tolerated (the bed time's reason reads as none).
    const before = await readLifeFile(w.storage, "ella", "wakes");
    expect(before.deferred.reason).toBeUndefined();
    expect(before.immediate[0]).not.toHaveProperty("day");
    expect(before.held).toHaveLength(1);
    const state = await readLifeState(w.storage, "ella");
    for (const key of ["lastDayStart", "dayCompactionDue", "busyOpen", "lastSentAt"]) expect(state).not.toHaveProperty(key);
    expect(state.recentSends).toEqual({ [ROOM_KEY]: "2026-10-24T13:55:00.000Z" });

    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.held).toBeUndefined();
    expect(queue.deferred).toEqual({ places: {}, items: [] });
    expect(queue.immediate.map((wake) => wake.id)).toEqual(["w-day-2026-10-24", "w-held-1", expect.stringMatching(/^w/u)]);
    expect(queue.immediate[1]).toEqual({ id: "w-held-1", reason: "detector", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: message.id, preview: "anyone baking today?", at: "2026-10-24T13:40:00.000Z" });
    const batch = queue.immediate[2]!;
    expect(batch.reason).toBe("morning");
    expect(batch.batch![0]).toBe("- while you were away (since 13:30):");
    expect(batch.batch).toContain('    · mention · 14:00 #a0 from Kevin "<@Ella> you up?"');
    expect(batch.batch).toContain('  · plan (Sat 24 Oct 13:00): "bake bread"');
    // The file on disk no longer has the old fields once written.
    const raw = JSON.parse(await readFile(path.join(w.root, "user", "waifus", "ella", "life", "wakes.json"), "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("held");
    expect(JSON.stringify(raw)).not.toContain("heldUntil");
    // Nothing more at the next tick.
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toHaveLength(3);
  });

  it("a batch that waited for her morning, found over budget, waits for her next local day", async () => {
    const w = await quietWorld({ waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", life: { dailyBudgetUsd: 0.5 } }] });
    const message = w.discord.post(ROOM, "<@Ella> you up?", { mentions: { [ELLA_BOT]: "Ella" } });
    const { held: _held, ...queue } = oldQueue({ since: "2026-10-24T13:30:00.000Z", messageId: message.id });
    await writeOld(w, "wakes.json", { ...queue, immediate: [] });
    await overBudget(w, "2026-10-24T09:00:00.000Z");
    await w.cast.scheduler.tick();
    let saved = await readLifeFile(w.storage, "ella", "wakes");
    expect(saved.immediate).toEqual([]);
    expect(saved.deferred.reason).toBe("budget");
    w.clock.ms = Date.parse("2026-10-25T00:05:00.000Z");
    w.cast.cost.invalidate();
    await w.cast.scheduler.tick();
    saved = await readLifeFile(w.storage, "ella", "wakes");
    expect(saved.immediate.map((wake) => wake.reason)).toEqual(["morning"]);
    expect(saved.immediate[0]!.batch![0]).toBe("- while you were away (since Sat 24 Oct 13:30):");
  });
});

describe("timed wakeups and watch ends (§6.6, §5.7, §16.4, §16.5, §30.2)", () => {
  it("a late `at` fires once on the first tick; an `every` counts from when it is first seen and stays", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    // Written on disk while the app was down (no checks): t1 is two days late.
    await homeOf(w).write(
      "life/wakeups.json", JSON.stringify([{ id: "t1", kind: "at", when: "2026-10-22 15:00", note: "one-off" }, { id: "t2", kind: "every", when: "day 15:00", note: "water the plants" }, { id: "t3", kind: "at", when: "2026-10-24 15:00", note: "later" }])
    );
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => wake.note)).toEqual(["one-off"]);
    expect(queue.immediate[0]).toMatchObject({ reason: "reminder", at: "2026-10-22T15:00:00.000Z" });
    expect((await herEntries(w)).map((entry) => entry["id"])).toEqual(["t2", "t3"]);
    // At 15:00 the every fires (and stays) and t3 fires (and goes); each once.
    w.clock.ms = Date.parse("2026-10-24T15:01:00.000Z");
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    const later = await readLifeFile(w.storage, "ella", "wakes");
    expect(later.immediate.map((wake) => wake.note)).toEqual(["one-off", "water the plants", "later"]);
    expect((await herEntries(w)).map((entry) => [entry["id"], entry["when"]])).toEqual([["t2", "day 15:00"]]);
    const weekly = parseEvery("tue 09:00");
    expect(weekly.ok && nextOccurrences(weekly.value, new Date("2026-10-24T14:00:00.000Z"), "UTC", 1).map((date) => date.toISOString())).toEqual(["2026-10-27T09:00:00.000Z"]);
  });

  it("editing a reminder's time in her file moves it", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "at", when: "2026-10-24 18:00", note: "call the bakery" }]));
    const text = (await homeOf(w).read("life/wakeups.json"))!;
    await writeHerFile(w, "life/wakeups.json", text.replace("2026-10-24 18:00", "2026-10-24 14:10"));
    w.clock.ms = Date.parse("2026-10-24T14:11:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toMatchObject([{ reason: "reminder", note: "call the bakery", at: "2026-10-24T14:10:00.000Z" }]);
    expect(await herEntries(w)).toEqual([]);
    // Nothing is left for the old time.
    w.clock.ms = Date.parse("2026-10-24T18:01:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toHaveLength(1);
  });

  it("a watch that times out is removed and she is told, also a timer with an empty `when`; a once watch that matched never times out", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await writeHerFile(
      w,
      "life/wakeups.json", JSON.stringify([{ kind: "watch", places: "everywhere", filter: [], options: { until: "2026-10-24 14:05", once: true }, note: "tea's ready" }, { kind: "watch", places: "bake-club/#general", filter: { words: ["exam"] }, options: { until: "2026-10-24 14:30", once: true }, note: "Kevin's answer" }, { kind: "watch", places: "everywhere", filter: { words: ["cake"] }, options: { until: "2026-10-25 14:00", once: true }, note: "later" }])
    );
    w.clock.ms = Date.parse("2026-10-24T14:06:00.000Z");
    await w.cast.scheduler.tick();
    let queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate).toMatchObject([{ reason: "watch_timeout", watchId: "w1", note: "tea's ready", at: "2026-10-24T14:05:00.000Z" }]);
    expect((await herEntries(w)).map((watch) => watch["id"])).toEqual(["w2", "w3"]);
    expect(renderNotifications({ wakes: queue.immediate, quiet: [], notices: [] }, { timeZone: "UTC" } as never)).toContain('- watch timed out · your note: "tea\'s ready"');
    // w2 matches first (a once watch goes at its first match): no timeout later.
    const message = w.discord.post(ROOM, "the exam went fine");
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
    await w.cast.settle();
    // Her wake waits for the burst's quiet time (§4.2): fire it now.
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect((await herEntries(w)).map((watch) => watch["id"])).toEqual(["w3"]);
    w.clock.ms = Date.parse("2026-10-24T14:31:00.000Z");
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => wake.reason)).toEqual(["watch_timeout", "watch"]);
  });
});

describe("maintenance timing (§7.3, §38)", () => {
  it("runs once a day at life.maintenanceHourLocal, for every waifu", () => {
    expect(maintenanceDue(new Date("2026-10-24T04:59:00.000Z"), "UTC", 5, undefined)).toBe(false);
    expect(maintenanceDue(new Date("2026-10-24T05:01:00.000Z"), "UTC", 5, undefined)).toBe(true);
    expect(maintenanceDue(new Date("2026-10-24T18:00:00.000Z"), "UTC", 5, "2026-10-24T05:01:00.000Z")).toBe(false);
    // Missed while the host was down: at the first tick after, once.
    expect(maintenanceDue(new Date("2026-10-25T13:00:00.000Z"), "UTC", 5, "2026-10-24T05:01:00.000Z")).toBe(true);
    expect(maintenanceDue(new Date("2026-10-25T23:00:00.000Z"), "UTC", 5, "2026-10-25T13:00:00.000Z")).toBe(false);
    // In her zone: 05:00 in Tokyo is 20:00 UTC the day before.
    expect(maintenanceDue(new Date("2026-10-24T20:01:00.000Z"), "Asia/Tokyo", 5, "2026-10-24T05:00:00.000Z")).toBe(true);
  });

  it("a waifu whose saved config still has a bed time dreams at the maintenance hour like the rest", async () => {
    const w = await quietWorld();
    // Her waifu.json as 3.8 wrote it: a bed time from 00:30 to 08:30 (stripped when read, §38).
    const file = path.join(w.root, "user", "waifus", "ella", "waifu.json");
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...saved, availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } }, scheduleInPrompt: true }, null, 2));
    w.clock.ms = Date.parse("2026-10-25T04:59:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeState(w.storage, "ella")).lastMaintenanceAt).toBeUndefined();
    w.clock.ms = Date.parse("2026-10-25T05:00:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeState(w.storage, "ella")).lastMaintenanceAt).toBe("2026-10-25T05:00:00.000Z");
    // Once a day.
    w.clock.ms = Date.parse("2026-10-25T07:00:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeState(w.storage, "ella")).lastMaintenanceAt).toBe("2026-10-25T05:00:00.000Z");
  }, 30_000);
});
