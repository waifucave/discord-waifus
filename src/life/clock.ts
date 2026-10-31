// Local time for lives (Living cast spec §5.4, §6.6): the time lines, local days (budgets,
// maintenance) and the local "2026-10-25 18:00" times her wakeups take. Everything is computed in one
// IANA zone (the host's, injectable for tests) so wall-clock values never depend on the process's TZ.

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

/** "Tue 27 Oct". */
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
 * "Calendar as of Thu 26 Nov (look dates up here, don't count): last week Mon 16 Nov · … · Sun 22 Nov;
 * this week Mon 23 Nov · … · Thu 26 Nov (today) · … · Sun 29 Nov; next week Mon 30 Nov · … · Sun 6 Dec."
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
  // Dated in its first words: a copy left in her log (a rest turn's) never passes for a later day's.
  return `Calendar as of ${dayText(now, timeZone)} (look dates up here, don't count): ${weeks.join("; ")}.`;
}

/** "2026-10-24": the local day. */
export function localDayKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
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

export const MEMORY_WARNING = "your memory of today will be summarised soon; save anything worth keeping to your notes";

/**
 * The permanent time line every appended user message ends with (§5.4): `[Sat 24 Oct 14:06]`. It
 * named where she was (`awake`, `busy: …`, `asleep`) until her day and bed time went (§38).
 */
export function timeLine(o: { now: Date; timeZone: string; memoryWarning?: boolean }): string {
  return `[${dayTimeText(o.now, o.timeZone)}${o.memoryWarning ? ` · ${MEMORY_WARNING}` : ""}]`;
}
