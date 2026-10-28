// Times in her wakeups (Living cast spec §30.2): `at(when)` once, `every(when)` repeating, and the
// durations of `for` and `every` options. All in her (the host's) time zone, whole local minutes.
//
//   at:    "2026-10-30 18:00", "18:00" (today, else tomorrow), "fri 18:00", "tomorrow 09:00",
//          "in 45m", "in 2h", "in 1h30m", "in 3d"
//   every: "day 09:00", "weekday 08:30", "weekend 11:00", "mon,fri 18:30", or a 5-field cron
//          ("0 20 1 * *": minute hour day-of-month month day-of-week) with steps of at least 15 min
//   durations: "45m", "2h", "1h30m", "3d", "1w"

import { dayTimeText, instantOfLocal, localParts, parseLocalDateTime } from "../clock.js";

const MINUTE_MS = 60_000;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const LONG_DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** The shortest step between two times of an `every` (§30.2). */
export const EVERY_MIN_STEP_MINUTES = 15;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const pad = (n: number) => String(n).padStart(2, "0");

/** A local minute as her file writes it: `2026-10-25 18:00`. */
export function localMinute(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "45m", "2h", "1h30m", "3d", "1w" (also "90 minutes", "2 hours") → ms. */
export function parseDuration(text: unknown): Parsed<number> {
  if (typeof text !== "string" || !text.trim()) return fail('a duration is text like "45m", "2h" or "3d"');
  const cleaned = text.trim().toLowerCase();
  const unit: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440, w: 10080, week: 10080, weeks: 10080 };
  let minutes = 0;
  let rest = cleaned;
  let parts = 0;
  while (rest.length > 0) {
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*/u.exec(rest);
    if (!match || unit[match[2]!] === undefined) return fail(`${JSON.stringify(text)} isn't a duration; write it like "45m", "2h" or "3d"`);
    minutes += Number(match[1]) * unit[match[2]!]!;
    rest = rest.slice(match[0].length);
    parts += 1;
  }
  if (parts === 0 || !Number.isFinite(minutes) || minutes <= 0) return fail(`${JSON.stringify(text)} isn't a duration; write it like "45m", "2h" or "3d"`);
  return { ok: true, value: Math.round(minutes) * MINUTE_MS };
}

/** "2h", "6h", "1d 6h" — a duration as words for her results. */
export function durationText(ms: number): string {
  let minutes = Math.round(ms / MINUTE_MS);
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ") || "0m";
}

function parseClock(text: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

function dayIndex(name: string): number | undefined {
  const lower = name.toLowerCase();
  const short = DAY_NAMES.indexOf(lower.slice(0, 3) as (typeof DAY_NAMES)[number]);
  if (short < 0) return undefined;
  // "fri", "friday", "fri." are fine; "frx" is not.
  const long = LONG_DAY_NAMES[short]!;
  return lower.replace(/\.$/u, "") === lower.slice(0, 3) || long.startsWith(lower.replace(/\.$/u, "")) ? short : undefined;
}

/** A local date shifted by `days` (calendar arithmetic on the local date). */
function addDays(p: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const AT_EXAMPLE = '"fri 18:00", "2026-10-30 18:00", "18:00", "in 45m" or "in 2h"';

/** `at(when)`: the instant it names (not yet checked against the 5 min – 30 days window). */
export function parseAt(text: unknown, now: Date, timeZone: string): Parsed<Date> {
  if (typeof text !== "string" || !text.trim()) return fail(`when is text like ${AT_EXAMPLE}`);
  const cleaned = text.trim().replace(/\s+/gu, " ");
  const exact = parseLocalDateTime(cleaned, timeZone);
  if (exact) return { ok: true, value: exact };
  const relative = /^in (.+)$/iu.exec(cleaned);
  if (relative) {
    const duration = parseDuration(relative[1]);
    if (!duration.ok) return fail(`${JSON.stringify(text)}: ${duration.error}`);
    // Rounded up to a whole minute, so "in 5m" is never early.
    return { ok: true, value: new Date(Math.ceil((now.getTime() + duration.value) / MINUTE_MS) * MINUTE_MS) };
  }
  const today = localParts(now, timeZone);
  const words = cleaned.split(" ");
  const clock = parseClock(words[words.length - 1]!);
  if (!clock) return fail(`${JSON.stringify(text)} isn't a time; write it like ${AT_EXAMPLE}`);
  const at = (date: { year: number; month: number; day: number }) => instantOfLocal(timeZone, date.year, date.month, date.day, clock.hour, clock.minute);
  if (words.length === 1) {
    const sameDay = at(today);
    return { ok: true, value: sameDay.getTime() > now.getTime() ? sameDay : at(addDays(today, 1)) };
  }
  if (words.length !== 2) return fail(`${JSON.stringify(text)} isn't a time; write it like ${AT_EXAMPLE}`);
  const word = words[0]!.toLowerCase();
  if (word === "today") return { ok: true, value: at(today) };
  if (word === "tomorrow") return { ok: true, value: at(addDays(today, 1)) };
  const target = dayIndex(word);
  if (target === undefined) return fail(`${JSON.stringify(text)} isn't a time; write it like ${AT_EXAMPLE}`);
  const current = DAY_NAMES.indexOf(today.weekday.toLowerCase().slice(0, 3) as (typeof DAY_NAMES)[number]);
  let ahead = (target - current + 7) % 7;
  if (ahead === 0 && at(today).getTime() <= now.getTime()) ahead = 7;
  return { ok: true, value: at(addDays(today, ahead)) };
}

// ---- every ---------------------------------------------------------------------------------------

/** A repeating time: on these local days (0 = Sunday), at these minutes of the day; or a cron. */
export type EverySpec =
  | { kind: "days"; days: number[]; minutes: number[] }
  | { kind: "cron"; minutes: number[]; hours: number[]; daysOfMonth: number[] | "*"; months: number[]; daysOfWeek: number[] | "*" };

const EVERY_EXAMPLE = '"day 09:00", "weekday 08:30", "weekend 11:00", "mon,fri 18:30" or a cron like "0 20 1 * *"';

function cronField(text: string, min: number, max: number, names?: readonly string[]): number[] | undefined {
  const out = new Set<number>();
  const value = (part: string): number | undefined => {
    const lower = part.toLowerCase();
    const named = names ? names.indexOf(lower.slice(0, 3)) : -1;
    if (names && named >= 0 && /^[a-z]+$/u.test(lower)) return named + (names === MONTH_NAMES ? 1 : 0);
    if (!/^\d+$/u.test(part)) return undefined;
    return Number(part);
  };
  for (const item of text.split(",")) {
    const [range, stepText] = item.split("/");
    if (range === undefined || item.split("/").length > 2) return undefined;
    const step = stepText === undefined ? 1 : /^\d+$/u.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return undefined;
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      const start = value(a ?? "");
      const end = value(b ?? "");
      if (start === undefined || end === undefined || start > end) return undefined;
      from = start;
      to = end;
    } else {
      const single = value(range);
      if (single === undefined) return undefined;
      from = single;
      to = stepText === undefined ? single : max;
    }
    if (from < min || to > max) return undefined;
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** The shortest gap, in minutes, between two of these minutes of the day (across midnight too). */
function shortestGap(minutesOfDay: readonly number[]): number {
  if (minutesOfDay.length <= 1) return 1440;
  let gap = 1440 - minutesOfDay[minutesOfDay.length - 1]! + minutesOfDay[0]!;
  for (let i = 1; i < minutesOfDay.length; i += 1) gap = Math.min(gap, minutesOfDay[i]! - minutesOfDay[i - 1]!);
  return gap;
}

/** `every(when)`. */
export function parseEvery(text: unknown): Parsed<EverySpec> {
  if (typeof text !== "string" || !text.trim()) return fail(`when is text like ${EVERY_EXAMPLE}`);
  const cleaned = text.trim().replace(/\s+/gu, " ");
  const fields = cleaned.split(" ");
  if (fields.length === 5) {
    const minutes = cronField(fields[0]!, 0, 59);
    const hours = cronField(fields[1]!, 0, 23);
    const dom = fields[2] === "*" ? "*" : cronField(fields[2]!, 1, 31);
    const months = cronField(fields[3]!, 1, 12, MONTH_NAMES);
    const dowRaw = fields[4] === "*" ? "*" : cronField(fields[4]!, 0, 7, DAY_NAMES);
    if (!minutes || !hours || !dom || !months || !dowRaw) return fail(`${JSON.stringify(text)} isn't a cron I can read; it is "minute hour day-of-month month day-of-week", like "0 20 1 * *"`);
    const daysOfWeek = dowRaw === "*" ? "*" : [...new Set(dowRaw.map((day) => day % 7))].sort((a, b) => a - b);
    const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
    if (shortestGap(times) < EVERY_MIN_STEP_MINUTES) return fail(`${JSON.stringify(text)} repeats too often; steps of at least ${EVERY_MIN_STEP_MINUTES} minutes`);
    return { ok: true, value: { kind: "cron", minutes, hours, daysOfMonth: dom, months, daysOfWeek } };
  }
  if (fields.length !== 2) return fail(`${JSON.stringify(text)} isn't a repeating time; write it like ${EVERY_EXAMPLE}`);
  const clock = parseClock(fields[1]!);
  if (!clock) return fail(`${JSON.stringify(text)} needs a time like 08:30; write it like ${EVERY_EXAMPLE}`);
  const word = fields[0]!.toLowerCase();
  let days: number[];
  if (word === "day" || word === "daily" || word === "everyday") days = [0, 1, 2, 3, 4, 5, 6];
  else if (word === "weekday" || word === "weekdays") days = [1, 2, 3, 4, 5];
  else if (word === "weekend" || word === "weekends") days = [0, 6];
  else {
    const list = word.split(",").map((name) => dayIndex(name));
    if (list.some((day) => day === undefined)) return fail(`${JSON.stringify(text)}: ${JSON.stringify(fields[0])} isn't a day; use day, weekday, weekend or names like mon,fri`);
    days = [...new Set(list as number[])].sort((a, b) => a - b);
  }
  return { ok: true, value: { kind: "days", days, minutes: [clock.hour * 60 + clock.minute] } };
}

const LOOKAHEAD_DAYS = 366 * 5;

/** The next `count` occurrences after `after` (strictly later). */
export function nextOccurrences(spec: EverySpec, after: Date, timeZone: string, count: number): Date[] {
  const out: Date[] = [];
  const start = localParts(after, timeZone);
  for (let offset = 0; offset < LOOKAHEAD_DAYS && out.length < count; offset += 1) {
    const date = addDays(start, offset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    let minutes: number[];
    if (spec.kind === "days") {
      if (!spec.days.includes(weekday)) continue;
      minutes = spec.minutes;
    } else {
      if (!spec.months.includes(date.month)) continue;
      const domOk = spec.daysOfMonth === "*" || spec.daysOfMonth.includes(date.day);
      const dowOk = spec.daysOfWeek === "*" || spec.daysOfWeek.includes(weekday);
      // Cron: with both day fields restricted, either matching is enough.
      const dayOk = spec.daysOfMonth !== "*" && spec.daysOfWeek !== "*" ? domOk || dowOk : domOk && dowOk;
      if (!dayOk) continue;
      minutes = spec.hours.flatMap((hour) => spec.minutes.map((minute) => hour * 60 + minute));
    }
    for (const minute of minutes) {
      const instant = instantOfLocal(timeZone, date.year, date.month, date.day, Math.floor(minute / 60), minute % 60);
      // A wall time a DST change skipped lands on the next existing minute; never twice.
      if (instant.getTime() > after.getTime() && !out.some((existing) => existing.getTime() === instant.getTime())) out.push(instant);
      if (out.length >= count) break;
    }
  }
  return out;
}

/** The latest occurrence in (`after`, `upTo`], if any. */
export function latestOccurrence(spec: EverySpec, after: Date, upTo: Date, timeZone: string): Date | undefined {
  let latest: Date | undefined;
  let cursor = after;
  // At most a few hundred steps: a minimum step of 15 minutes, and callers look back a few days at most.
  for (let guard = 0; guard < 2_000; guard += 1) {
    const [next] = nextOccurrences(spec, cursor, timeZone, 1);
    if (!next || next.getTime() > upTo.getTime()) return latest;
    latest = next;
    cursor = next;
  }
  return latest;
}

/** "Fri 30 Oct 18:30, Mon 2 Nov 08:30, Tue 3 Nov 08:30". */
export function occurrencesText(dates: readonly Date[], timeZone: string): string {
  return dates.map((date) => dayTimeText(date, timeZone)).join(", ");
}
