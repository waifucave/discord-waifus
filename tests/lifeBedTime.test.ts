// Her bed time (Living cast spec §21.6c): up late while she keeps sending, dozing (like a busy
// block, but the rest waits for the morning), asleep after `life.bedDozeMinutes` (only her reminders
// and the owner's wakes); a send resets the clock; dreaming once she has been asleep 15 minutes, at
// most once per bed time and not on a night she never sleeps; the morning wake at the end of her bed
// time whatever happened. Temp data roots, fake Discord and scripted models; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { availabilityFor } from "../src/life/busy.js";
import { timeLine } from "../src/life/clock.js";
import { readLifeFile, readLifeState, readMaintenanceReports, updateLifeState } from "../src/life/lifeStore.js";
import { settleTranscripts } from "../src/life/transcripts/store.js";
import { newWakeId } from "../src/life/wakeQueue.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import type { Wake } from "../src/shared/schemas/life.js";
import { textTurn } from "./modelFakes.js";
import { CHANNEL_2, closeWorlds, GUILD, KEVIN, lifeWorld, ROOM_KEY, script, seedTranscript, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { scriptInput } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  await settleTranscripts();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const ROOM_2_KEY = conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL_2 });
const DM_KEY = `dm_${KEVIN}_ella`;
const at = (iso: string) => Date.parse(iso);
const SEND = toolTurn([{ name: "SendMessage", input: scriptInput.sendMessage("bake-club/#general", [{ text: "still up, yeah" }]) }]);

async function bedWorld(scripts = script()): Promise<LifeWorld> {
  const w = await lifeWorld(roots, {
    waifus: [
      {
        id: "ella",
        name: "Ella",
        botId: "ella-bot",
        availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } },
        dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "zzz, back in the morning" }
      }
    ],
    scripts
  });
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  return w;
}

function wake(w: LifeWorld, reason: Wake["reason"], o: Partial<Wake> = {}): Wake {
  return { id: newWakeId(), reason, placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: "900000000000000001", preview: "hey", at: w.clock.now().toISOString(), ...o };
}

async function queue(w: LifeWorld) {
  return readLifeFile(w.storage, "ella", "wakes");
}

async function line(w: LifeWorld): Promise<string> {
  const waifu = await readWaifu(w.storage, "ella");
  return timeLine({ now: w.clock.now(), timeZone: "UTC", status: await availabilityFor(w.cast.deps, waifu, w.clock.now()) });
}

/** She sent something at `iso` (what a SendMessage records). */
async function sentAt(w: LifeWorld, iso: string, placeKey = ROOM_KEY): Promise<void> {
  await updateLifeState(w.storage, "ella", (state) => ({ ...state, lastSentAt: iso, recentSends: { [placeKey]: iso } }));
}

describe("dozing (§21.6c)", () => {
  it("people talking to her, her reminders and watches get through; picks, chime-ins, @everyone, roles and follow-ups wait for the morning", async () => {
    const w = await bedWorld();
    w.clock.ms = at("2026-10-25T00:40:00Z");
    expect(await line(w)).toBe("[Sun 25 Oct 00:40 · dozing (bed time)]");
    const through = [
      wake(w, "mention"),
      wake(w, "name"),
      wake(w, "dm", { placeKey: DM_KEY }),
      wake(w, "owner", { placeKey: undefined }),
      wake(w, "reminder", { placeKey: undefined, note: "x" }),
      wake(w, "watch", { note: "x" }),
      wake(w, "watch_timeout", { placeKey: undefined, note: "x" })
    ];
    const waiting = [wake(w, "detector"), wake(w, "detector", { chimeIn: true }), wake(w, "everyone"), wake(w, "role"), wake(w, "followup")];
    for (const entry of through) expect(await w.cast.router.route("ella", entry, entry.reason === "dm" ? { dmUserId: KEVIN } : {}), entry.reason).toBe("queued");
    for (const entry of waiting) expect(await w.cast.router.route("ella", entry), entry.reason).toBe("deferred");
    const q = await queue(w);
    expect(q.immediate.map((entry) => entry.id)).toEqual(through.map((entry) => entry.id));
    expect(q.held).toEqual([]);
    expect(q.deferred.reason).toBe("sleep");
    // Dozing, the DM got through: no sleep notice.
    expect(w.discord.sent).toEqual([]);
  });
});

describe("asleep (§21.6c)", () => {
  it("only her reminders and the owner's wakes get through; a DM gets the sleep notice once per bed time", async () => {
    const w = await bedWorld();
    w.clock.ms = at("2026-10-25T01:31:00Z");
    expect(await line(w)).toBe("[Sun 25 Oct 01:31 · asleep]");
    expect(await w.cast.router.route("ella", wake(w, "reminder", { placeKey: undefined, note: "water the basil" }))).toBe("queued");
    expect(await w.cast.router.route("ella", wake(w, "owner", { placeKey: undefined }))).toBe("queued");
    for (const reason of ["mention", "name", "watch", "watch_timeout", "detector"] as const) expect(await w.cast.router.route("ella", wake(w, reason)), reason).toBe("deferred");
    expect(await w.cast.router.route("ella", wake(w, "dm", { placeKey: DM_KEY }), { dmUserId: KEVIN })).toBe("deferred");
    expect(await w.cast.router.route("ella", wake(w, "dm", { placeKey: DM_KEY }), { dmUserId: KEVIN })).toBe("deferred");
    expect(w.discord.sent.map((sent) => sent.content)).toEqual(["zzz, back in the morning"]);
    expect((await queue(w)).immediate.map((entry) => entry.reason)).toEqual(["reminder", "owner"]);
  });
});

describe("a send resets her clock (§21.6c)", () => {
  it("a reminder wakes her and she answers: up late (that place stays open), dozing for an hour, then asleep", async () => {
    const w = await bedWorld(script(SEND, textTurn("night")));
    w.clock.ms = at("2026-10-25T03:00:00Z");
    expect(await w.cast.router.route("ella", wake(w, "reminder", { placeKey: undefined, note: "tell Bake Club about the oven" }))).toBe("queued");
    await w.cast.life("ella").runNow();
    expect(w.discord.sent).toHaveLength(1);
    const state = await readLifeState(w.storage, "ella");
    expect(state.lastSentAt).toMatch(/^2026-10-25T03:00/u);
    expect(Object.keys(state.recentSends ?? {})).toEqual([ROOM_KEY]);

    w.clock.ms = at("2026-10-25T03:05:00Z");
    expect(await line(w)).toBe("[Sun 25 Oct 03:05 · up late]");
    expect(await w.cast.router.route("ella", wake(w, "detector"))).toBe("queued");
    expect(await w.cast.router.route("ella", wake(w, "detector", { placeKey: ROOM_2_KEY }))).toBe("deferred");
    expect(await w.cast.router.route("ella", wake(w, "mention", { placeKey: ROOM_2_KEY }))).toBe("queued");

    w.clock.ms = at("2026-10-25T03:11:00Z");
    expect(await line(w)).toBe("[Sun 25 Oct 03:11 · dozing (bed time)]");
    expect(await w.cast.router.route("ella", wake(w, "detector"))).toBe("deferred");
    expect(await w.cast.router.route("ella", wake(w, "mention"))).toBe("queued");

    w.clock.ms = at("2026-10-25T04:01:00Z");
    expect(await line(w)).toBe("[Sun 25 Oct 04:01 · asleep]");
    expect(await w.cast.router.route("ella", wake(w, "mention"))).toBe("deferred");
  });

  it("a turn while asleep that sends nothing leaves her asleep", async () => {
    const w = await bedWorld(script(textTurn("(back to sleep)")));
    w.clock.ms = at("2026-10-25T03:00:00Z");
    await w.cast.router.route("ella", wake(w, "reminder", { placeKey: undefined, note: "nothing" }));
    await w.cast.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).lastSentAt).toBeUndefined();
    w.clock.ms = at("2026-10-25T03:05:00Z");
    expect(await line(w)).toBe("[Sun 25 Oct 03:05 · asleep]");
  });
});

describe("dreaming and the morning (§21.6c)", () => {
  it("she dreams once she has been asleep 15 minutes, at most once per bed time", async () => {
    const w = await bedWorld();
    // Asleep at 01:30 (no send since her bed time began); the dream at 01:45.
    w.clock.ms = at("2026-10-25T01:44:00Z");
    await w.cast.scheduler.tick();
    expect(await readMaintenanceReports(w.storage, "ella")).toEqual([]);
    w.clock.ms = at("2026-10-25T01:45:00Z");
    await w.cast.scheduler.tick();
    expect(await readMaintenanceReports(w.storage, "ella")).toHaveLength(1);
    expect((await readLifeState(w.storage, "ella")).lastMaintenanceAt).toBe("2026-10-25T01:45:00.000Z");
    // Up again at 03:00 and asleep from 04:00: no second dream this bed time.
    await sentAt(w, "2026-10-25T03:00:00.000Z");
    w.clock.ms = at("2026-10-25T04:30:00Z");
    await w.cast.scheduler.tick();
    expect(await readMaintenanceReports(w.storage, "ella")).toHaveLength(1);
    // The next night again.
    w.clock.ms = at("2026-10-26T01:45:00Z");
    await w.cast.scheduler.tick();
    expect(await readMaintenanceReports(w.storage, "ella")).toHaveLength(2);
  });

  it("up all night: no dream that night, the morning wake still comes at the end of her bed time, and the next dream covers both days", async () => {
    const w = await bedWorld(script(textTurn("hi"), textTurn("noted both days")));
    // Her life has begun (the evening before), so her mornings count.
    w.clock.ms = at("2026-10-24T20:00:00Z");
    await w.cast.router.route("ella", wake(w, "reminder", { placeKey: undefined, note: "evening" }));
    await w.cast.life("ella").runNow();
    await seedTranscript(w, [{ text: "saturday: the oven is fixed", minutesAgo: 5 }]);
    // She keeps sending every 40 minutes: never dozing an hour, never asleep.
    for (let minute = 30; minute <= 8 * 60 + 20; minute += 40) {
      const now = at("2026-10-25T00:00:00Z") + minute * 60_000;
      await sentAt(w, new Date(now).toISOString());
      w.clock.ms = now + 30 * 60_000;
      await w.cast.scheduler.tick();
    }
    expect(await readMaintenanceReports(w.storage, "ella")).toEqual([]);
    // Up late at 08:29: a pick elsewhere waits for the morning.
    w.clock.ms = at("2026-10-25T08:29:00Z");
    await sentAt(w, "2026-10-25T08:25:00.000Z");
    expect(await line(w)).toBe("[Sun 25 Oct 08:29 · up late]");
    expect(await w.cast.router.route("ella", wake(w, "detector", { placeKey: ROOM_2_KEY }))).toBe("deferred");
    await w.cast.scheduler.tick();
    expect((await queue(w)).immediate).toEqual([]);
    w.clock.ms = at("2026-10-25T08:31:00Z");
    await w.cast.scheduler.tick();
    const [morning] = (await queue(w)).immediate;
    expect(morning).toMatchObject({ id: "w-day-2026-10-25", reason: "morning" });
    expect(morning!.batch![1]).toBe("- during your bed time (00:30–08:30):");
    expect((await queue(w)).deferred.items).toEqual([]);

    // Sunday: something new is said; that night she sleeps and dreams over both days.
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, lastDayStart: "2026-10-25T08:30:00.000Z" }));
    w.clock.ms = at("2026-10-25T20:00:00Z");
    await seedTranscript(w, [{ text: "sunday: bread came out great", minutesAgo: 5 }]);
    w.clock.ms = at("2026-10-26T01:45:00Z");
    await w.cast.scheduler.tick();
    const reports = await readMaintenanceReports(w.storage, "ella");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, lines: 2 });
    const dream = JSON.stringify(w.anthropic.calls[w.anthropic.calls.length - 1]!.request.messages[0]!.content);
    expect(dream).toContain("2026-10-24.md");
    expect(dream).toContain("2026-10-25.md");
  }, 30_000);
});
