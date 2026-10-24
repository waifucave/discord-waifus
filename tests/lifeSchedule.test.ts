// Sleep, the morning batch, reminders and maintenance timing (Living cast spec §4.5, §4.7, §5.7,
// §6.6, §7.3). The scheduler is ticked by hand; lives never run here.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, updateLifeFile } from "../src/life/lifeStore.js";
import { maintenanceDue, nextOccurrence } from "../src/life/scheduler.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, ROOM, ROOM_KEY, type LifeWorld } from "./lifeFixtures.js";
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
    const now = w.clock.now();
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({
      ...file,
      reminders: [{ id: "r1", note: "check the bake sale flyer", dueAt: new Date(now.getTime() + 10 * 60_000).toISOString(), createdAt: now.toISOString() }]
    }));
    await updateLifeFile(w.storage, "aria", "watches", (file) => ({
      ...file,
      watches: [{ id: "w1", note: "Mina wanted brownie tips", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), once: true, bindings: [{ placeKey: ROOM_KEY, words: ["brownie"] }], fires: [] }]
    }));
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

describe("reminders (§6.6, §5.7)", () => {
  it("late reminders fire once on the first tick; repeating ones move to their next future time", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const twoDaysAgo = new Date(w.clock.ms - 2 * 86_400_000 + 3_600_000).toISOString();
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({
      ...file,
      reminders: [
        { id: "r1", note: "one-off", dueAt: twoDaysAgo, createdAt: twoDaysAgo },
        { id: "r2", note: "water the plants", dueAt: twoDaysAgo, repeat: "daily", createdAt: twoDaysAgo },
        { id: "r3", note: "later", dueAt: new Date(w.clock.ms + 3_600_000).toISOString(), createdAt: twoDaysAgo }
      ]
    }));
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate.map((wake) => wake.note)).toEqual(["one-off", "water the plants"]);
    expect(queue.immediate[1]).toMatchObject({ reason: "reminder", setAt: twoDaysAgo });
    const schedule = await readLifeFile(w.storage, "aria", "schedule");
    expect(schedule.reminders.map((reminder) => [reminder.id, reminder.dueAt])).toEqual([
      ["r2", "2026-10-24T15:00:00.000Z"],
      ["r3", "2026-10-24T15:00:00.000Z"]
    ]);
    expect(nextOccurrence({ id: "x", note: "", dueAt: "2026-10-20T09:00:00.000Z", repeat: "weekly", createdAt: "2026-10-01T00:00:00.000Z" }, new Date("2026-10-24T14:00:00.000Z"))).toBe("2026-10-27T09:00:00.000Z");
  });

  it("expired watches are removed silently on a tick", async () => {
    const w = await lifeWorld(roots);
    const now = w.clock.now().toISOString();
    await updateLifeFile(w.storage, "aria", "watches", (file) => ({
      ...file,
      watches: [{ id: "w1", note: "n", createdAt: now, expiresAt: new Date(w.clock.ms + 60_000).toISOString(), once: true, bindings: [{ anyMessage: true }], fires: [] }]
    }));
    w.clock.advance(2 * 60_000);
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "aria", "watches")).watches).toEqual([]);
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
