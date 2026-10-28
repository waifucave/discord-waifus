// Her day file (Living cast spec §21.2): `~/life/schedule.json`'s checks with line and column, the
// plan that counts today, busy blocks and phone checks, and how her availability and time line read
// it. Pure functions only; the life's use of it is in lifeDay.test.ts.
import { describe, expect, it } from "vitest";
import { availabilityAt, bedPhaseAt, timeLine } from "../src/life/clock.js";
import { busyAt, checkDayScheduleText, dayPlanLines, readDayPlan, todaysPlan, type DayPlan } from "../src/life/home/daySchedule.js";

const TZ = "UTC";
const SLEEP = { enabled: true, start: "00:30", end: "08:30" };
const at = (iso: string) => new Date(iso);

const EXAMPLE = {
  date: "2026-10-27",
  mood: "slow morning, want a quiet day",
  busy: [
    { from: "12:00", to: "15:30", why: "studio shift" },
    { from: "19:00", to: "20:30", why: "gym with Mira" }
  ],
  phoneChecks: ["13:30", "14:45"],
  plans: [{ at: "21:00", what: "movie night in kingdom-16062/#general" }, { what: "finish the rain poem for Lianne" }],
  note: "if Kevin asks about saturday: yes"
};

const check = (value: unknown, o: { bedTime?: typeof SLEEP } = { bedTime: SLEEP }) => checkDayScheduleText(typeof value === "string" ? value : JSON.stringify(value, null, 2), o);
const errorOf = (value: unknown, o?: { bedTime?: typeof SLEEP }) => {
  const result = check(value, o);
  return result.ok ? undefined : result.error;
};

describe("~/life/schedule.json checks (§21.2)", () => {
  it("accepts the spec's example and an empty file (no plan)", () => {
    const result = check(EXAMPLE);
    expect(result).toEqual({ ok: true, plan: { ...EXAMPLE } });
    expect(check("")).toEqual({ ok: true, plan: undefined });
    expect(check({ date: "2026-10-27" })).toEqual({ ok: true, plan: { date: "2026-10-27", busy: [], phoneChecks: [], plans: [] } });
  });

  it("refuses broken JSON with its line and column", () => {
    expect(errorOf('{\n  "date": "2026-10-27",\n}')).toBe('error: schedule.json line 3, column 1: expected a field after ",", found "}" (a comma left behind?)');
    expect(errorOf('{"date": "2026-10-27" "mood": "x"}')).toBe('error: schedule.json line 1, column 23: expected "," or "}"');
  });

  it("refuses each broken rule with the exact problem", () => {
    expect(errorOf([EXAMPLE])).toMatch(/^error: schedule\.json: it is one object with your day/u);
    expect(errorOf({ ...EXAMPLE, sleep: "22:00" })).toBe('error: schedule.json: unknown field "sleep" (your day has date, mood, busy, phoneChecks, plans and note)');
    expect(errorOf({ mood: "ok" })).toBe('error: schedule.json: date is required: today\'s date, like "2026-10-27"');
    expect(errorOf({ date: "2026-02-31" })).toMatch(/date is required/u);
    expect(errorOf({ date: "2026-10-27", mood: "x".repeat(201) })).toBe("error: schedule.json: mood can be at most 200 characters");
    expect(errorOf({ date: "2026-10-27", busy: "all day" })).toMatch(/busy is a list of blocks/u);
    expect(errorOf({ date: "2026-10-27", busy: Array.from({ length: 13 }, (_, i) => ({ from: `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`, to: `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "59" : "29"}`, why: "x" })) })).toBe("error: schedule.json: busy has 13 blocks; at most 12");
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "12:00", to: "13:00", why: "x", where: "home" }] })).toBe('error: schedule.json: busy 1: unknown field "where" (blocks have from, to and why)');
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "9:00", to: "13:00", why: "x" }] })).toBe('error: schedule.json: busy 1: from is a local time like "12:00"');
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "12:00", to: "24:00", why: "x" }] })).toBe('error: schedule.json: busy 1: to is a local time like "15:30"');
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "15:00", to: "12:00", why: "x" }] })).toBe("error: schedule.json: busy 1: to must be after from (a block ends the same day)");
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "12:00", to: "13:00" }] })).toBe("error: schedule.json: busy 1: why is required (what keeps you busy)");
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "12:00", to: "13:00", why: "y".repeat(121) }] })).toBe("error: schedule.json: busy 1: why can be at most 120 characters");
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "12:00", to: "14:00", why: "a" }, { from: "13:30", to: "15:00", why: "b" }] })).toBe("error: schedule.json: busy blocks 12:00–14:00 and 13:30–15:00 overlap");
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "08:00", to: "10:00", why: "early class" }] })).toBe(
      "error: schedule.json: busy 08:00–10:00 is in your bed time (00:30–08:30), which is fixed; busy blocks go in your waking hours"
    );
    expect(errorOf({ date: "2026-10-27", phoneChecks: "13:30" })).toMatch(/phoneChecks is a list of local times/u);
    expect(errorOf({ date: "2026-10-27", phoneChecks: ["1:30"] })).toBe('error: schedule.json: phoneChecks: "1:30" is not a local time like "13:30"');
    expect(errorOf({ date: "2026-10-27", phoneChecks: Array.from({ length: 25 }, () => "13:00") })).toBe("error: schedule.json: phoneChecks has 25 times; at most 24");
    expect(errorOf({ date: "2026-10-27", plans: Array.from({ length: 21 }, () => ({ what: "x" })) })).toBe("error: schedule.json: plans has 21 entries; at most 20");
    expect(errorOf({ date: "2026-10-27", plans: [{ at: "21:00" }] })).toBe("error: schedule.json: plans 1: what is required");
    expect(errorOf({ date: "2026-10-27", plans: [{ at: "9pm", what: "x" }] })).toBe('error: schedule.json: plans 1: at is a local time like "21:00" (or left out). Plans with a time wake you then.');
    expect(errorOf({ date: "2026-10-27", plans: [{ what: "z".repeat(201) }] })).toBe("error: schedule.json: plans 1: what can be at most 200 characters");
    expect(errorOf({ date: "2026-10-27", plans: [{ what: "x", who: "Kevin" }] })).toBe('error: schedule.json: plans 1: unknown field "who" (plans have at and what)');
    expect(errorOf({ date: "2026-10-27", note: "n".repeat(501) })).toBe("error: schedule.json: note can be at most 500 characters");
  });

  it("checks waking hours only against her sleep (a window across midnight, or none)", () => {
    const night = { enabled: true, start: "23:00", end: "07:00" };
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "22:30", to: "23:30", why: "late shift" }] }, { bedTime: night })).toMatch(/is in your bed time \(23:00–07:00\)/u);
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "06:00", to: "07:30", why: "run" }] }, { bedTime: night })).toMatch(/is in your bed time/u);
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "07:00", to: "23:00", why: "the whole day" }] }, { bedTime: night })).toBeUndefined();
    expect(errorOf({ date: "2026-10-27", busy: [{ from: "02:00", to: "04:00", why: "night shift" }] }, { bedTime: { enabled: false, start: "23:00", end: "07:00" } })).toBeUndefined();
  });

  it("reads a saved file leniently: a broken one is no plan", () => {
    expect(readDayPlan(JSON.stringify(EXAMPLE))?.date).toBe("2026-10-27");
    expect(readDayPlan("{ nope")).toBeUndefined();
    expect(readDayPlan(undefined)).toBeUndefined();
  });
});

describe("today's plan, busy blocks and phone checks (§21.2, §21.4)", () => {
  const plan = readDayPlan(JSON.stringify(EXAMPLE))!;

  it("counts only a plan for today (her local date)", () => {
    expect(todaysPlan(plan, at("2026-10-27T10:00:00Z"), TZ)).toBe(plan);
    expect(todaysPlan(plan, at("2026-10-28T10:00:00Z"), TZ)).toBeUndefined();
    expect(busyAt(plan, at("2026-10-28T13:00:00Z"), TZ)).toBeUndefined();
  });

  it("knows the block she is in and when a held wake is released", () => {
    expect(busyAt(plan, at("2026-10-27T11:59:00Z"), TZ)).toBeUndefined();
    const early = busyAt(plan, at("2026-10-27T12:10:00Z"), TZ)!;
    expect(early).toMatchObject({ why: "studio shift", until: "15:30", releaseKind: "phone" });
    expect(early.release.toISOString()).toBe("2026-10-27T13:30:00.000Z");
    expect(busyAt(plan, at("2026-10-27T13:40:00Z"), TZ)!.release.toISOString()).toBe("2026-10-27T14:45:00.000Z");
    const late = busyAt(plan, at("2026-10-27T15:00:00Z"), TZ)!;
    expect(late).toMatchObject({ releaseKind: "free" });
    expect(late.release.toISOString()).toBe("2026-10-27T15:30:00.000Z");
    // A phone check outside every block changes nothing.
    const gym = busyAt(plan, at("2026-10-27T19:10:00Z"), TZ)!;
    expect(gym).toMatchObject({ why: "gym with Mira", releaseKind: "free" });
    expect(busyAt(plan, at("2026-10-27T15:30:00Z"), TZ)).toBeUndefined();
  });

  it("feeds her availability and time line (bed time first; availability.busy is gone)", () => {
    const bed = { bedTime: SLEEP };
    expect(availabilityAt(bed, at("2026-10-27T13:00:00Z"), TZ, { day: plan })).toEqual({ state: "busy", reason: "studio shift", until: "15:30" });
    expect(availabilityAt(bed, at("2026-10-27T16:00:00Z"), TZ, { day: plan })).toEqual({ state: "awake" });
    expect(availabilityAt(bed, at("2026-10-27T13:00:00Z"), TZ)).toEqual({ state: "awake" });
    expect(availabilityAt(bed, at("2026-10-27T02:00:00Z"), TZ, { day: plan }).state).toBe("asleep");
    expect(timeLine({ now: at("2026-10-27T13:00:00Z"), timeZone: TZ, status: availabilityAt(bed, at("2026-10-27T13:00:00Z"), TZ, { day: plan }) })).toBe("[Tue 27 Oct 13:00 · busy: studio shift until 15:30]");
    expect(timeLine({ now: at("2026-10-28T13:00:00Z"), timeZone: TZ, status: availabilityAt(bed, at("2026-10-28T13:00:00Z"), TZ, { day: plan }) })).toBe("[Wed 28 Oct 13:00 · awake]");
  });

  it("reads her bed time as up late, dozing or asleep from her last send (§21.6c)", () => {
    const bed = { bedTime: SLEEP };
    const ctx = (lastSentAt?: string) => ({ bed: { lastSentAt, engagedMinutes: 10, dozeMinutes: 60 } });
    const line = (iso: string, lastSentAt?: string) => timeLine({ now: at(iso), timeZone: TZ, status: availabilityAt(bed, at(iso), TZ, ctx(lastSentAt)) });
    // No send: dozing for an hour from the start, then asleep.
    expect(bedPhaseAt(bed, at("2026-10-27T00:40:00Z"), TZ, ctx().bed)).toMatchObject({ phase: "dozing", asleepAt: at("2026-10-27T01:30:00Z") });
    expect(line("2026-10-27T00:40:00Z")).toBe("[Tue 27 Oct 00:40 · dozing (bed time)]");
    expect(availabilityAt(bed, at("2026-10-27T00:40:00Z"), TZ, ctx())).toMatchObject({ state: "busy", reason: "dozing (bed time)", until: "08:30" });
    expect(line("2026-10-27T01:30:00Z")).toBe("[Tue 27 Oct 01:30 · asleep]");
    // A send just before bed: up late for 10 minutes after it, then dozing an hour from the send.
    expect(line("2026-10-27T00:31:00Z", "2026-10-27T00:25:00Z")).toBe("[Tue 27 Oct 00:31 · up late]");
    expect(availabilityAt(bed, at("2026-10-27T00:31:00Z"), TZ, ctx("2026-10-27T00:25:00Z")).state).toBe("awake");
    expect(line("2026-10-27T01:20:00Z", "2026-10-27T00:25:00Z")).toBe("[Tue 27 Oct 01:20 · dozing (bed time)]");
    expect(line("2026-10-27T01:31:00Z", "2026-10-27T00:25:00Z")).toBe("[Tue 27 Oct 01:31 · asleep]");
    // A send at 03:00 (a reminder woke her): up late, dozing until 04:00, asleep after.
    expect(line("2026-10-27T03:05:00Z", "2026-10-27T03:00:00Z")).toBe("[Tue 27 Oct 03:05 · up late]");
    expect(line("2026-10-27T03:59:00Z", "2026-10-27T03:00:00Z")).toBe("[Tue 27 Oct 03:59 · dozing (bed time)]");
    expect(bedPhaseAt(bed, at("2026-10-27T04:00:00Z"), TZ, ctx("2026-10-27T03:00:00Z").bed)).toMatchObject({ phase: "asleep", asleepAt: at("2026-10-27T04:00:00Z") });
    // Outside her bed time there is no phase; doze 0 is asleep at once.
    expect(bedPhaseAt(bed, at("2026-10-27T09:00:00Z"), TZ, ctx().bed)).toBeUndefined();
    expect(bedPhaseAt(bed, at("2026-10-27T00:30:00Z"), TZ, { engagedMinutes: 10, dozeMinutes: 0 })?.phase).toBe("asleep");
  });

  it("renders the plan for <schedule>, or that there is none", () => {
    expect(dayPlanLines(plan)).toEqual([
      "Today (2026-10-27), as you planned it in ~/life/schedule.json:",
      "Mood: slow morning, want a quiet day",
      "Busy 12:00–15:30: studio shift",
      "Busy 19:00–20:30: gym with Mira",
      "Phone checks while busy: 13:30, 14:45",
      "Plan 21:00: movie night in kingdom-16062/#general",
      "Plan: finish the rain poem for Lianne",
      "Note: if Kevin asks about saturday: yes"
    ]);
    expect(dayPlanLines(undefined as DayPlan | undefined)).toEqual(["No plan for today yet."]);
  });
});
