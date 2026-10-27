// Her day (Living cast spec §21.2): `~/life/schedule.json`, which she writes every morning and may
// change during the day. A special file like `watches.json`: every write is checked first (strict
// JSON with line and column, then the rules below) and refused with the exact problem.
//
//   {
//     "date": "2026-10-27",
//     "mood": "slow morning, want a quiet day",
//     "busy": [{ "from": "12:00", "to": "15:30", "why": "studio shift" }],
//     "phoneChecks": ["13:30", "14:45"],
//     "plans": [{ "at": "21:00", "what": "movie night" }, { "what": "finish the rain poem" }],
//     "note": "if Kevin asks about saturday: yes"
//   }
//
// A file whose `date` is not today counts as no plan today (no busy blocks); it is never deleted.
// The wake router (busy holds, §21.4), the detector's availability and her time line read it on
// every use; block A's `<schedule>` shows the copy from the start of her epoch.

import { instantOfLocal, localDayKey, minutesOfDay } from "../clock.js";
import { syntaxProblem, type CheckFailure } from "./specialFiles.js";

export const MAX_MOOD_CHARS = 200;
export const MAX_BUSY_BLOCKS = 12;
export const MAX_WHY_CHARS = 120;
export const MAX_PHONE_CHECKS = 24;
export const MAX_PLANS = 20;
export const MAX_PLAN_CHARS = 200;
export const MAX_DAY_NOTE_CHARS = 500;

export type BusyBlock = { from: string; to: string; why: string };
export type DayPlanItem = { at?: string; what: string };
export type DayPlan = { date: string; mood?: string; busy: BusyBlock[]; phoneChecks: string[]; plans: DayPlanItem[]; note?: string };

/** Her bed time as configured (the owner's; busy blocks stay out of it). */
export type BedTimeWindow = { enabled: boolean; start: string; end: string };

export type DayScheduleCheck = { ok: true; plan: DayPlan | undefined } | CheckFailure;

const FILE = "schedule.json";
const FIELDS = ["date", "mood", "busy", "phoneChecks", "plans", "note"] as const;
const BLOCK_FIELDS = ["from", "to", "why"] as const;
const PLAN_FIELDS = ["at", "what"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

export const DAY_SCHEDULE_EXAMPLE = '{"date": "2026-10-27", "busy": [{"from": "12:00", "to": "15:30", "why": "studio shift"}], "phoneChecks": ["13:30"]}';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const chars = (text: string) => [...text].length;

/** "12:30" → 750. */
export function hhmmToMinutes(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/** The minute ranges of her bed time within one day (one across midnight is two). */
function bedRanges(sleep: BedTimeWindow): Array<[number, number]> {
  if (!sleep.enabled) return [];
  const start = hhmmToMinutes(sleep.start);
  const end = hhmmToMinutes(sleep.end);
  if (start === end) return [];
  return start < end ? [[start, end]] : [[start, 24 * 60], [0, end]];
}

function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Checks her day file. An empty file is no plan. `bedTime`: her bed time (busy blocks must be in
 * her waking hours); left out, that rule is not checked (reading a saved file).
 */
export function checkDayScheduleText(text: string, ctx: { bedTime?: BedTimeWindow } = {}): DayScheduleCheck {
  if (text.trim() === "") return { ok: true, plan: undefined };
  const parsed = syntaxProblem(FILE, text);
  if (!parsed.ok) return parsed;
  const fail = (problem: string): CheckFailure => ({ ok: false, error: `error: ${FILE}: ${problem}` });
  const value = parsed.value;
  if (!isRecord(value)) return fail(`it is one object with your day, like ${DAY_SCHEDULE_EXAMPLE}`);
  const extra = Object.keys(value).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return fail(`unknown field "${extra}" (your day has date, mood, busy, phoneChecks, plans and note)`);
  const date = value["date"];
  if (typeof date !== "string" || !validDate(date)) return fail('date is required: today\'s date, like "2026-10-27"');
  const plan: DayPlan = { date, busy: [], phoneChecks: [], plans: [] };
  if (value["mood"] !== undefined) {
    if (typeof value["mood"] !== "string") return fail("mood is text");
    if (chars(value["mood"]) > MAX_MOOD_CHARS) return fail(`mood can be at most ${MAX_MOOD_CHARS} characters`);
    if (value["mood"].trim()) plan.mood = value["mood"];
  }
  if (value["busy"] !== undefined) {
    const busy = value["busy"];
    if (!Array.isArray(busy)) return fail('busy is a list of blocks, like [{"from": "12:00", "to": "15:30", "why": "studio shift"}]');
    if (busy.length > MAX_BUSY_BLOCKS) return fail(`busy has ${busy.length} blocks; at most ${MAX_BUSY_BLOCKS}`);
    for (let index = 0; index < busy.length; index += 1) {
      const block = busy[index];
      const where = `busy ${index + 1}`;
      if (!isRecord(block)) return fail(`${where}: each block is {"from": "HH:MM", "to": "HH:MM", "why": "…"}`);
      const unknown = Object.keys(block).find((key) => !(BLOCK_FIELDS as readonly string[]).includes(key));
      if (unknown !== undefined) return fail(`${where}: unknown field "${unknown}" (blocks have from, to and why)`);
      const { from, to, why } = block;
      if (typeof from !== "string" || !HHMM.test(from)) return fail(`${where}: from is a local time like "12:00"`);
      if (typeof to !== "string" || !HHMM.test(to)) return fail(`${where}: to is a local time like "15:30"`);
      if (hhmmToMinutes(to) <= hhmmToMinutes(from)) return fail(`${where}: to must be after from (a block ends the same day)`);
      if (typeof why !== "string" || !why.trim()) return fail(`${where}: why is required (what keeps you busy)`);
      if (chars(why) > MAX_WHY_CHARS) return fail(`${where}: why can be at most ${MAX_WHY_CHARS} characters`);
      plan.busy.push({ from, to, why });
    }
    const sorted = [...plan.busy].sort((a, b) => hhmmToMinutes(a.from) - hhmmToMinutes(b.from));
    for (let index = 1; index < sorted.length; index += 1) {
      const before = sorted[index - 1]!;
      const block = sorted[index]!;
      if (hhmmToMinutes(block.from) < hhmmToMinutes(before.to)) return fail(`busy blocks ${before.from}–${before.to} and ${block.from}–${block.to} overlap`);
    }
    if (ctx.bedTime) {
      for (const block of plan.busy) {
        const [from, to] = [hhmmToMinutes(block.from), hhmmToMinutes(block.to)];
        if (bedRanges(ctx.bedTime).some(([start, end]) => Math.max(from, start) < Math.min(to, end))) {
          return fail(`busy ${block.from}–${block.to} is in your bed time (${ctx.bedTime.start}–${ctx.bedTime.end}), which is fixed; busy blocks go in your waking hours`);
        }
      }
    }
  }
  if (value["phoneChecks"] !== undefined) {
    const checks = value["phoneChecks"];
    if (!Array.isArray(checks)) return fail('phoneChecks is a list of local times, like ["13:30", "14:45"]');
    if (checks.length > MAX_PHONE_CHECKS) return fail(`phoneChecks has ${checks.length} times; at most ${MAX_PHONE_CHECKS}`);
    for (const check of checks) {
      if (typeof check !== "string" || !HHMM.test(check)) return fail(`phoneChecks: ${JSON.stringify(check)} is not a local time like "13:30"`);
      plan.phoneChecks.push(check);
    }
  }
  if (value["plans"] !== undefined) {
    const plans = value["plans"];
    if (!Array.isArray(plans)) return fail('plans is a list, like [{"at": "21:00", "what": "movie night"}, {"what": "finish the poem"}]');
    if (plans.length > MAX_PLANS) return fail(`plans has ${plans.length} entries; at most ${MAX_PLANS}`);
    for (let index = 0; index < plans.length; index += 1) {
      const item = plans[index];
      const where = `plans ${index + 1}`;
      if (!isRecord(item)) return fail(`${where}: each plan is {"at": "HH:MM", "what": "…"} (at is optional)`);
      const unknown = Object.keys(item).find((key) => !(PLAN_FIELDS as readonly string[]).includes(key));
      if (unknown !== undefined) return fail(`${where}: unknown field "${unknown}" (plans have at and what)`);
      if (item["at"] !== undefined && (typeof item["at"] !== "string" || !HHMM.test(item["at"]))) return fail(`${where}: at is a local time like "21:00" (or left out)`);
      if (typeof item["what"] !== "string" || !item["what"].trim()) return fail(`${where}: what is required`);
      if (chars(item["what"]) > MAX_PLAN_CHARS) return fail(`${where}: what can be at most ${MAX_PLAN_CHARS} characters`);
      plan.plans.push({ ...(typeof item["at"] === "string" ? { at: item["at"] } : {}), what: item["what"] });
    }
  }
  if (value["note"] !== undefined) {
    if (typeof value["note"] !== "string") return fail("note is text");
    if (chars(value["note"]) > MAX_DAY_NOTE_CHARS) return fail(`note can be at most ${MAX_DAY_NOTE_CHARS} characters`);
    if (value["note"].trim()) plan.note = value["note"];
  }
  return { ok: true, plan };
}

/** Her saved day, read leniently: a file that does not pass the checks counts as no plan. */
export function readDayPlan(text: string | undefined): DayPlan | undefined {
  if (!text?.trim()) return undefined;
  const checked = checkDayScheduleText(text);
  return checked.ok ? checked.plan : undefined;
}

/** The plan when it is for today (her local date), else undefined (no plan today). */
export function todaysPlan(plan: DayPlan | undefined, now: Date, timeZone: string): DayPlan | undefined {
  return plan && plan.date === localDayKey(now, timeZone) ? plan : undefined;
}

/** A local time of the plan's day as an instant. */
function instantOn(date: string, hhmm: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const minutes = hhmmToMinutes(hhmm);
  return instantOf(timeZone, year, month, day, minutes);
}

function instantOf(timeZone: string, year: number, month: number, day: number, minutes: number): Date {
  return instantOfLocal(timeZone, year, month, day, Math.floor(minutes / 60), minutes % 60);
}

export type BusyNow = {
  why: string;
  from: string;
  /** "15:30". */
  until: string;
  start: Date;
  end: Date;
  /** When a wake held now is released: her next phone check inside the block, else its end (§21.4). */
  release: Date;
  /** `phone`: at a phone check; `free`: at the block's end. */
  releaseKind: "phone" | "free";
};

/** Her busy block at `now` from today's plan, or undefined (free, or no plan today). */
export function busyAt(plan: DayPlan | undefined, now: Date, timeZone: string): BusyNow | undefined {
  const today = todaysPlan(plan, now, timeZone);
  if (!today) return undefined;
  const minutes = minutesOfDay(now, timeZone);
  const block = today.busy.find((candidate) => hhmmToMinutes(candidate.from) <= minutes && minutes < hhmmToMinutes(candidate.to));
  if (!block) return undefined;
  const start = instantOn(today.date, block.from, timeZone);
  const end = instantOn(today.date, block.to, timeZone);
  const checks = today.phoneChecks
    .filter((check) => hhmmToMinutes(check) > hhmmToMinutes(block.from) && hhmmToMinutes(check) < hhmmToMinutes(block.to))
    .map((check) => instantOn(today.date, check, timeZone))
    .filter((at) => at.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  const next = checks[0];
  return { why: block.why.trim(), from: block.from, until: block.to, start, end, release: next ?? end, releaseKind: next ? "phone" : "free" };
}

/** The `<schedule>` section's plan lines (§21.5): her day as she wrote it, or that there is none. */
export function dayPlanLines(plan: DayPlan | undefined): string[] {
  if (!plan) return ["No plan for today yet."];
  const lines = [`Today (${plan.date}), as you planned it in ~/life/schedule.json:`];
  if (plan.mood) lines.push(`Mood: ${plan.mood}`);
  for (const block of [...plan.busy].sort((a, b) => hhmmToMinutes(a.from) - hhmmToMinutes(b.from))) lines.push(`Busy ${block.from}–${block.to}: ${block.why}`);
  if (plan.phoneChecks.length > 0) lines.push(`Phone checks while busy: ${[...plan.phoneChecks].sort().join(", ")}`);
  for (const item of plan.plans) lines.push(`Plan${item.at ? ` ${item.at}` : ""}: ${item.what}`);
  if (plan.note) lines.push(`Note: ${plan.note}`);
  return lines;
}
