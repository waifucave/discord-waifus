// Local time for lives (Living cast spec §4.5, §5.4, §6.6, §21.6c): her bed time and day, the time lines,
// local days (budgets, maintenance) and the local "2026-10-25 18:00" times her wakeups take.
// Everything is computed in one IANA zone (the host's, injectable for tests) so wall-clock values
// never depend on the process's TZ.

import type { WaifuAvailability } from "../shared/schemas/domain.js";
import { busyAt, type DayPlan } from "./home/daySchedule.js";

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string };

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23"
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function localParts(date: Date, timeZone: string): Parts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday")
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "14:06". */
export function clockText(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Sat 24 Oct 14:06". */
export function dayTimeText(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.weekday} ${p.day} ${MONTHS[p.month - 1]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Tue 27 Oct" (the morning greeting, §21.3). */
export function dayText(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.weekday} ${p.day} ${MONTHS[p.month - 1]}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A local day key ("2026-11-19") as its calendar day (a UTC midnight); undefined when it isn't one. */
function calendarDay(day: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined;
}

/** "Thu 19 Nov" for a local day key ("2026-11-19"); the key itself when it isn't one. */
export function dayKeyText(day: string): string {
  const date = calendarDay(day);
  return date ? `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}` : day;
}

/** "Thu 2026-11-19": a local day key with its weekday, still one she can pass back as an anchor (§22). */
export function datedDayKey(day: string): string {
  const date = calendarDay(day);
  return date ? `${WEEKDAYS[date.getUTCDay()]} ${day}` : day;
}

/**
 * The calendar her summaries and dreams look dates up in (spec §35.2), so a model never counts days:
 * last week, this week and next week in her zone, Monday first, today marked.
 * "Calendar (look dates up here, don't count): last week Mon 16 Nov · … · Sun 22 Nov; this week Mon 23
 * Nov · … · Thu 26 Nov (today) · … · Sun 29 Nov; next week Mon 30 Nov · … · Sun 6 Dec."
 */
export function calendarStrip(now: Date, timeZone: string): string {
  const p = localParts(now, timeZone);
  const today = Date.UTC(p.year, p.month - 1, p.day);
  // Monday of last week (getUTCDay: Sunday 0).
  const monday = today - (((new Date(today).getUTCDay() + 6) % 7) + 7) * 86_400_000;
  const weeks = ["last week", "this week", "next week"].map((label, week) => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(monday + (week * 7 + index) * 86_400_000);
      const text = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
      return date.getTime() === today ? `${text} (today)` : text;
    });
    return `${label} ${days.join(" · ")}`;
  });
  return `Calendar (look dates up here, don't count): ${weeks.join("; ")}.`;
}

/** "2026-10-24": the local day. */
export function localDayKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function minutesOfDay(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

function hhmmMinutes(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/** The zone's offset from UTC at `date`, in minutes (local = utc + offset). */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant of a local wall time (year, month 1-12, day, hour, minute) in `timeZone`. A wall time
 * that occurs twice (DST ends) is its first occurrence. One that does not exist (DST starts) is read
 * with the offset before the gap, so it moves forward by the gap: a midnight skipped to 01:00 is
 * 01:00, and a local day always starts on that day.
 */
export function instantOfLocal(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offsets a day either side: a DST change in between is one of them.
  const before = offsetMinutes(new Date(wall - 86_400_000), timeZone);
  const after = offsetMinutes(new Date(wall + 86_400_000), timeZone);
  const existing = [...new Set([before, after])]
    .map((offset) => wall - offset * 60_000)
    .filter((instant) => offsetMinutes(new Date(instant), timeZone) * 60_000 === wall - instant)
    .sort((a, b) => a - b);
  return new Date(existing[0] ?? wall - before * 60_000);
}

/** Local midnight that starts the day after `date`. */
export function nextLocalMidnight(date: Date, timeZone: string): Date {
  const p = localParts(date, timeZone);
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return instantOfLocal(timeZone, tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 0, 0);
}

/** "2026-10-25 18:00" (or "2026-10-25T18:00") in `timeZone` → instant; undefined when malformed. */
export function parseLocalDateTime(text: string, timeZone: string): Date | undefined {
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const instant = instantOfLocal(timeZone, year, month, day, hour, minute);
  // Reject dates that do not exist (2026-02-31 would roll over).
  const back = localParts(instant, timeZone);
  if (back.year !== year || back.month !== month || back.day !== day) return undefined;
  return instant;
}

function intervalContains(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

type BedTimeOf = Pick<WaifuAvailability, "bedTime">;

/**
 * Where she is in her bed time (§21.6c): `up_late` while her last send is under
 * `engagedMinutes` old, `dozing` until `dozeMinutes` after the later of the bed time's start and her
 * last send, then `asleep` (`asleepAt`: when she fell asleep).
 */
export type BedPhase = { phase: "up_late" | "dozing" | "asleep"; windowStart: Date; windowEnd: Date; asleepAt: Date };

/** What decides her bed time phase: her last send (life state) and the two settings. */
export type BedContext = { lastSentAt?: string | undefined; engagedMinutes: number; dozeMinutes: number };

/** The defaults of `life.busyEngagedMinutes` and `life.bedDozeMinutes`, for views without the app's config. */
export const DEFAULT_BED_CONTEXT: BedContext = { engagedMinutes: 10, dozeMinutes: 60 };

export function bedPhaseAt(availability: BedTimeOf, now: Date, timeZone: string, bed: BedContext = DEFAULT_BED_CONTEXT): BedPhase | undefined {
  const window = bedTimeContaining(availability, now, timeZone);
  if (!window) return undefined;
  const sent = bed.lastSentAt ? Date.parse(bed.lastSentAt) : Number.NaN;
  const lastSent = Number.isFinite(sent) && sent <= now.getTime() ? sent : Number.NEGATIVE_INFINITY;
  const from = Math.max(window.start.getTime(), lastSent);
  const asleepAt = new Date(from + bed.dozeMinutes * 60_000);
  const base = { windowStart: window.start, windowEnd: window.end, asleepAt };
  if (now.getTime() - lastSent < bed.engagedMinutes * 60_000) return { phase: "up_late", ...base };
  if (now.getTime() < asleepAt.getTime()) return { phase: "dozing", ...base };
  return { phase: "asleep", ...base };
}

export type AvailabilityNow =
  | { state: "awake"; bed?: BedPhase }
  | { state: "busy"; reason: string; until: string; bed?: BedPhase }
  | { state: "asleep"; windowStart: Date; windowEnd: Date; bed?: BedPhase };

/** Her day file and her bed time context: what `availabilityAt` reads besides the owner's bed time. */
export type AvailabilityContext = { day?: DayPlan | undefined; bed?: BedContext };

/**
 * Where she is in her day right now: in her bed time (§21.6c) up late (awake), dozing (busy:
 * "dozing (bed time)") or asleep; else busy in a block of today's plan (`day`: her
 * `~/life/schedule.json`, §21.2), else awake.
 */
export function availabilityAt(availability: BedTimeOf, now: Date, timeZone: string, ctx: AvailabilityContext = {}): AvailabilityNow {
  const bed = bedPhaseAt(availability, now, timeZone, ctx.bed);
  if (bed?.phase === "asleep") return { state: "asleep", windowStart: bed.windowStart, windowEnd: bed.windowEnd, bed };
  if (bed?.phase === "dozing") return { state: "busy", reason: DOZING, until: clockText(bed.windowEnd, timeZone), bed };
  if (bed) return { state: "awake", bed };
  const busy = busyAt(ctx.day, now, timeZone);
  if (busy) return { state: "busy", reason: busy.why || "busy", until: busy.until };
  return { state: "awake" };
}

/** The busy reason while she dozes in her bed time (§21.6c). */
export const DOZING = "dozing (bed time)";

/**
 * The start of her current day (§21.3): the latest end of her bed time at or before `now`, or,
 * without a bed time, the latest `hourLocal`:00 at or before `now`.
 */
export function dayStartAt(waifu: { availability: BedTimeOf }, now: Date, timeZone: string, hourLocal: number): Date {
  const bedTime = waifu.availability.bedTime;
  const [hour, minute] = bedTime.enabled ? (bedTime.end.split(":").map(Number) as [number, number]) : [hourLocal, 0];
  const p = localParts(now, timeZone);
  for (const shift of [0, -1, -2]) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + shift));
    const at = instantOfLocal(timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
    if (at.getTime() <= now.getTime()) return at;
  }
  return now;
}

/** The bed time (start, end instants) containing `now`, or undefined outside it. */
export function bedTimeContaining(availability: BedTimeOf, now: Date, timeZone: string): { start: Date; end: Date } | undefined {
  const bedTime = availability.bedTime;
  if (!bedTime.enabled) return undefined;
  const start = hhmmMinutes(bedTime.start);
  const end = hhmmMinutes(bedTime.end);
  const minutes = minutesOfDay(now, timeZone);
  if (!intervalContains(minutes, start, end)) return undefined;
  const p = localParts(now, timeZone);
  const today = (m: number, dayShift: number) => {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift));
    return instantOfLocal(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(m / 60), m % 60);
  };
  if (start < end) return { start: today(start, 0), end: today(end, 0) };
  // Crosses midnight: before midnight → ends tomorrow; after midnight → started yesterday.
  return minutes >= start ? { start: today(start, 0), end: today(end, 1) } : { start: today(start, -1), end: today(end, 0) };
}

/** The bed time that ended last at or before `now` (its start and end), or undefined without one. */
export function lastBedTime(availability: BedTimeOf, now: Date, timeZone: string, hourLocal = 0): { start: Date; end: Date } | undefined {
  if (!availability.bedTime.enabled) return undefined;
  const end = dayStartAt({ availability }, now, timeZone, hourLocal);
  return bedTimeContaining(availability, new Date(end.getTime() - 60_000), timeZone);
}

export const MEMORY_WARNING = "your memory of today will be summarised soon; save anything worth keeping to your notes";

/** The time line's word for where she is: `awake`, `up late`, `dozing (bed time)`, `busy: …`, `asleep`. */
export function availabilityLabel(status: AvailabilityNow): string {
  if (status.state === "busy") return status.bed ? DOZING : `busy: ${status.reason} until ${status.until}`;
  if (status.state === "awake" && status.bed) return "up late";
  return status.state;
}

/** The permanent time line every appended user message ends with (§5.4); `status`: `availabilityAt` now. */
export function timeLine(o: { now: Date; timeZone: string; status: AvailabilityNow; memoryWarning?: boolean }): string {
  return `[${dayTimeText(o.now, o.timeZone)} · ${availabilityLabel(o.status)}${o.memoryWarning ? ` · ${MEMORY_WARNING}` : ""}]`;
}
