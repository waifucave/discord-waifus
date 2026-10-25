// Sleep, the morning batch, reminders, watch timeouts and maintenance timing (Living cast spec §4.5,
// §4.7, §5.7, §6.6, §7.3, §16.4, §16.5). Reminders and watches live in her own files. The scheduler
// is ticked by hand; lives never run here.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile } from "../src/life/lifeStore.js";
import { renderNotifications } from "../src/life/notifications.js";
import { maintenanceDue, nextOccurrence } from "../src/life/scheduler.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, herEntries, homeOf, KEVIN, lifeWorld, ROOM, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const ASLEEP_13_15 = { sleep: { enabled: true, start: "13:00", end: "15:00" }, busy: [] };

async function sleepyWorld(o: Parameters<typeof lifeWorld>[1] = {}): Promise<LifeWorld> {
  const w = await lifeWorld(roots, {
    waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", availability: ASLEEP_13_15, dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }],
    ...o
  });
  vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
  return w;
}

async function say(w: LifeWorld, text: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}) {
  const message = w.discord.post(ROOM, text, o);
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
  // A burst nobody was addressed in goes to the detector at this (fake) time, not when the real
  // debounce timer happens to fire after the test has moved the clock.
  w.cast.intake.flushDetector();
  await w.cast.settle();
}

describe("sleep and the morning batch (§4.5, §4.7)", () => {
  it("defers mentions, DMs, reminders and watch matches while she sleeps, then releases one morning batch", async () => {
    const w = await sleepyWorld();
    await writeHerFile(w, "schedule.json", JSON.stringify([{ at: "2026-10-24 14:10", note: "check the bake sale flyer" }]));
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: true, note: "Mina wanted brownie tips", when: [{ place: "bake-club/#general", words: ["brownie"] }] }]));
    await say(w, `<@${ARIA_BOT}> you up?`, { mentions: { [ARIA_BOT]: "Aria" } });
    await say(w, "best brownie recipe anyone?");
    const dm = w.discord.post(dmOf("aria"), "goodnight aria");
    await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    w.clock.advance(15 * 60_000);
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    let queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.items.map((item) => item.reason)).toEqual(["watch", "reminder"]);

    // Still asleep at 14:59: nothing. Awake at 15:01: one morning wake, once.
    w.clock.ms = Date.parse("2026-10-24T14:59:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([]);
    w.clock.ms = Date.parse("2026-10-24T15:01:00.000Z");
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate).toHaveLength(1);
    const morning = queue.immediate[0]!;
    expect(morning.reason).toBe("morning");
    expect(morning.batch![0]).toBe("- while you were asleep (13:00–15:00):");
    expect(morning.batch).toContainEqual(expect.stringMatching(/^ {2}· bake-club\/#general: 1 mention, \d+ messages?$/u));
    expect(morning.batch).toContain("  · DMs: Kevin (1 message)");
    expect(morning.batch).toContain('  · reminder (Sat 14:10): "check the bake sale flyer"');
    expect(morning.batch).toContain('  · watch matched · bake-club/#general · "brownie" · from Kevin · your note: "Mina wanted brownie tips"');
    expect(queue.deferred.items).toEqual([]);
    expect(queue.deferred.reason).toBeUndefined();
  });

  it("a budget pause ends with the next local day", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", life: { dailyBudgetUsd: 0.5 } }] });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const day = w.clock.now().toISOString().slice(0, 10);
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${day}.jsonl`), `${JSON.stringify({ at: w.clock.now().toISOString(), waifuId: "aria", purpose: "life", costUsd: 0.75 })}\n`);
    await say(w, `<@${ARIA_BOT}> hi`, { mentions: { [ARIA_BOT]: "Aria" } });
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([]);
    w.clock.ms = Date.parse("2026-10-25T00:05:00.000Z");
    w.cast.cost.invalidate();
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate.map((wake) => wake.reason)).toEqual(["morning"]);
    expect(queue.immediate[0]!.batch![0]).toBe("- while you were away (since 14:00):");
  });

  it("a sleep batch she wakes up to over budget waits for her next local day", async () => {
    const w = await sleepyWorld({
      waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", availability: ASLEEP_13_15, life: { dailyBudgetUsd: 0.5 }, dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }]
    });
    await say(w, `<@${ARIA_BOT}> you up?`, { mentions: { [ARIA_BOT]: "Aria" } });
    expect((await readLifeFile(w.storage, "aria", "wakes")).deferred.reason).toBe("sleep");
    // She spent her budget before her nap (14:00 is inside it; the line is from this morning).
    const day = w.clock.now().toISOString().slice(0, 10);
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${day}.jsonl`), `${JSON.stringify({ at: "2026-10-24T09:00:00.000Z", waifuId: "aria", purpose: "life", costUsd: 0.75 })}\n`);
    w.cast.cost.invalidate();
    w.clock.ms = Date.parse("2026-10-24T15:01:00.000Z");
    await w.cast.scheduler.tick();
    let queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.reason).toBe("budget");
    w.clock.ms = Date.parse("2026-10-25T00:05:00.000Z");
    w.cast.cost.invalidate();
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate.map((wake) => wake.reason)).toEqual(["morning"]);
  });
});

describe("reminders and watch timeouts (§6.6, §5.7, §16.4, §16.5)", () => {
  it("late reminders fire once on the first tick; repeating ones move to their next future time", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    // Written on disk while the app was down (no checks): two of them are two days late.
    await homeOf(w).write(
      "schedule.json",
      JSON.stringify([
        { id: "r1", at: "2026-10-22 15:00", note: "one-off" },
        { id: "r2", at: "2026-10-22 15:00", repeat: "daily", note: "water the plants" },
        { id: "r3", at: "2026-10-24 15:00", note: "later" }
      ])
    );
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate.map((wake) => wake.note)).toEqual(["one-off", "water the plants"]);
    expect(queue.immediate[1]).toMatchObject({ reason: "reminder", at: "2026-10-22T15:00:00.000Z" });
    expect((await herEntries(w, "schedule.json")).map((reminder) => [reminder["id"], reminder["at"]])).toEqual([
      ["r2", "2026-10-24 15:00"],
      ["r3", "2026-10-24 15:00"]
    ]);
    expect(nextOccurrence({ at: "2026-10-20 09:00", repeat: "weekly" }, new Date("2026-10-24T14:00:00.000Z"), "UTC")).toBe("2026-10-27 09:00");
    expect(nextOccurrence({ at: "2026-10-20 09:00" }, new Date("2026-10-24T14:00:00.000Z"), "UTC")).toBeUndefined();
  });

  it("editing a reminder's time in her file moves it", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await writeHerFile(w, "schedule.json", JSON.stringify([{ at: "2026-10-24 18:00", note: "call the bakery" }]));
    const text = (await homeOf(w).read("schedule.json"))!;
    await writeHerFile(w, "schedule.json", text.replace("2026-10-24 18:00", "2026-10-24 14:10"));
    w.clock.ms = Date.parse("2026-10-24T14:11:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toMatchObject([{ reason: "reminder", note: "call the bakery", at: "2026-10-24T14:10:00.000Z" }]);
    expect(await herEntries(w, "schedule.json")).toEqual([]);
    // Nothing is left for the old time.
    w.clock.ms = Date.parse("2026-10-24T18:01:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toHaveLength(1);
  });

  it("a watch that times out is removed and she is told, also a timer with an empty `when`; a once watch that matched never times out", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await writeHerFile(
      w,
      "watches.json",
      JSON.stringify([
        { timeout: "2026-10-24 14:05", once: true, note: "tea's ready", when: [] },
        { timeout: "2026-10-24 14:30", once: true, note: "Kevin's answer", when: [{ place: "bake-club/#general", words: ["exam"] }] },
        { timeout: "2026-10-25 14:00", once: true, note: "later", when: [{ words: ["cake"] }] }
      ])
    );
    w.clock.ms = Date.parse("2026-10-24T14:06:00.000Z");
    await w.cast.scheduler.tick();
    let queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate).toMatchObject([{ reason: "watch_timeout", watchId: "w1", note: "tea's ready", at: "2026-10-24T14:05:00.000Z" }]);
    expect((await herEntries(w, "watches.json")).map((watch) => watch["id"])).toEqual(["w2", "w3"]);
    expect(renderNotifications({ wakes: queue.immediate, quiet: [], notices: [] }, { timeZone: "UTC" } as never)).toContain('- watch timed out · your note: "tea\'s ready"');
    // w2 matches first (a once watch goes at its first match): no timeout later.
    const message = w.discord.post(ROOM, "the exam went fine");
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
    await w.cast.settle();
    // Her wake waits for the burst's quiet time (§4.2): fire it now.
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect((await herEntries(w, "watches.json")).map((watch) => watch["id"])).toEqual(["w3"]);
    w.clock.ms = Date.parse("2026-10-24T14:31:00.000Z");
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate.map((wake) => wake.reason)).toEqual(["watch_timeout", "watch"]);
  });
});

describe("maintenance timing (§7.3)", () => {
  const waifu = (sleep: { enabled: boolean; start: string; end: string }) =>
    WaifuConfigSchema.parse({ ...createRevisionedBase(), id: "aria", name: "Aria", displayName: "Aria", availability: { sleep, busy: [] } });

  it("runs 30 minutes into her sleep window, once per window", () => {
    const sleeper = waifu({ enabled: true, start: "23:00", end: "07:00" });
    const at = (iso: string) => new Date(iso);
    expect(maintenanceDue(sleeper, at("2026-10-24T23:20:00.000Z"), "UTC", 5, undefined)).toBe(false);
    expect(maintenanceDue(sleeper, at("2026-10-24T23:31:00.000Z"), "UTC", 5, undefined)).toBe(true);
    expect(maintenanceDue(sleeper, at("2026-10-25T02:00:00.000Z"), "UTC", 5, "2026-10-24T23:31:00.000Z")).toBe(false);
    expect(maintenanceDue(sleeper, at("2026-10-25T23:31:00.000Z"), "UTC", 5, "2026-10-24T23:31:00.000Z")).toBe(true);
    expect(maintenanceDue(sleeper, at("2026-10-25T12:00:00.000Z"), "UTC", 5, undefined)).toBe(false);
  });

  it("runs at life.maintenanceHourLocal without a sleep window", () => {
    const awake = waifu({ enabled: false, start: "23:00", end: "07:00" });
    expect(maintenanceDue(awake, new Date("2026-10-24T04:59:00.000Z"), "UTC", 5, undefined)).toBe(false);
    expect(maintenanceDue(awake, new Date("2026-10-24T05:01:00.000Z"), "UTC", 5, undefined)).toBe(true);
    expect(maintenanceDue(awake, new Date("2026-10-24T18:00:00.000Z"), "UTC", 5, "2026-10-24T05:01:00.000Z")).toBe(false);
  });
});
