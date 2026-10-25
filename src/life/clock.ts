// Local time for lives (Living cast spec §4.5, §5.4, §6.6): her schedule, the permanent time lines,
// local days (budgets, maintenance) and the local "2026-10-25 18:00" times `ScheduleWake` takes.
// Everything is computed in one IANA zone (the host's, injectable for tests) so wall-clock values
// never depend on the process's TZ.

import type { WaifuAvailability } from "../shared/schemas/domain.js";

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

/** "Tue 18:00" (the reminder line's "you set this …"). */
export function weekdayTimeText(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.weekday} ${pad(p.hour)}:${pad(p.minute)}`;
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

export type AvailabilityNow =
  | { state: "awake" }
  | { state: "busy"; reason: string; until: string }
  | { state: "asleep"; windowStart: Date; windowEnd: Date };

/** Where she is in her schedule right now (sleep first, then busy blocks). */
export function availabilityAt(availability: WaifuAvailability, now: Date, timeZone: string): AvailabilityNow {
  const minutes = minutesOfDay(now, timeZone);
  const sleep = availability.sleep;
  if (sleep.enabled) {
    const start = hhmmMinutes(sleep.start);
    const end = hhmmMinutes(sleep.end);
    if (intervalContains(minutes, start, end)) {
      const window = sleepWindowContaining(availability, now, timeZone)!;
      return { state: "asleep", windowStart: window.start, windowEnd: window.end };
    }
  }
  for (const interval of availability.busy) {
    if (intervalContains(minutes, hhmmMinutes(interval.start), hhmmMinutes(interval.end))) {
      return { state: "busy", reason: interval.reason.trim() || "busy", until: interval.end };
    }
  }
  return { state: "awake" };
}

/** The sleep window (start, end instants) containing `now`, or undefined when she is awake. */
export function sleepWindowContaining(availability: WaifuAvailability, now: Date, timeZone: string): { start: Date; end: Date } | undefined {
  const sleep = availability.sleep;
  if (!sleep.enabled) return undefined;
  const start = hhmmMinutes(sleep.start);
  const end = hhmmMinutes(sleep.end);
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

export const MEMORY_WARNING = "your memory of today will be summarised soon; save anything worth keeping to your notes";

/** The permanent time line every appended user message ends with (§5.4). */
export function timeLine(o: { now: Date; timeZone: string; availability: WaifuAvailability; memoryWarning?: boolean }): string {
  const status = availabilityAt(o.availability, o.now, o.timeZone);
  const label = status.state === "busy" ? `busy: ${status.reason} until ${status.until}` : status.state;
  return `[${dayTimeText(o.now, o.timeZone)} · ${label}${o.memoryWarning ? ` · ${MEMORY_WARNING}` : ""}]`;
}
