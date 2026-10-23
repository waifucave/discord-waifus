// Absolute time rendering for the context engine (spec 8.3): every time in a transcript is an
// absolute wall-clock value in the context's frozen IANA zone, so rendered text never ages.
// Relative ages ("47s ago") are deliberately absent — they would rewrite the cached prefix.

const GAP_THRESHOLD_MS = 30 * 60 * 1000;

type Formatters = { clock: Intl.DateTimeFormat; day: Intl.DateTimeFormat; dayKey: Intl.DateTimeFormat };
const formatterCache = new Map<string, Formatters>();

function formatters(timeZone: string): Formatters {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = {
      clock: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      day: new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }),
      dayKey: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    };
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** The host's IANA zone (frozen into a context at epoch start). */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True when `timeZone` is a zone Intl accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "14:02" (24-hour) in `timeZone`. */
export function formatClock(value: Date | string | number, timeZone: string): string {
  const parts = formatters(timeZone).clock.formatToParts(toDate(value));
  return `${part(parts, "hour")}:${part(parts, "minute")}`;
}

/** "Tue 24 Oct" in `timeZone`. */
export function formatDayLabel(value: Date | string | number, timeZone: string): string {
  const parts = formatters(timeZone).day.formatToParts(toDate(value));
  return `${part(parts, "weekday")} ${part(parts, "day")} ${part(parts, "month")}`;
}

/** "Tue 24 Oct 2026" in `timeZone`. */
export function formatFullDate(value: Date | string | number, timeZone: string): string {
  const parts = formatters(timeZone).day.formatToParts(toDate(value));
  return `${part(parts, "weekday")} ${part(parts, "day")} ${part(parts, "month")} ${part(parts, "year")}`;
}

/** "2026-10-24": calendar day in `timeZone`, for day-change detection. */
export function dayKey(value: Date | string | number, timeZone: string): string {
  return formatters(timeZone).dayKey.format(toDate(value));
}

/** "45 minutes later" / "3 hours later" / "2 days later" for gaps ≥ 30 min, else undefined. */
export function formatGapLabel(gapMs: number): string | undefined {
  if (!Number.isFinite(gapMs) || gapMs < GAP_THRESHOLD_MS) return undefined;
  const minutes = Math.floor(gapMs / 60_000);
  if (minutes < 60) return `${minutes} minutes later`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour later" : `${hours} hours later`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day later" : `${days} days later`;
}

/**
 * The marker block between two consecutive transcript entries, or undefined when none is due:
 * a gap ≥ 30 min renders "— 3 hours later —"; a day change appends "· Tue 24 Oct". With no
 * previous entry (start of the transcript) the marker names the day of the first entry.
 */
export function transitionMarker(
  previousAt: string | undefined,
  nextAt: string,
  timeZone: string
): string | undefined {
  const day = formatDayLabel(nextAt, timeZone);
  if (previousAt === undefined) return `— ${day} —`;
  const gap = formatGapLabel(Date.parse(nextAt) - Date.parse(previousAt));
  const dayChanged = dayKey(previousAt, timeZone) !== dayKey(nextAt, timeZone) && Date.parse(nextAt) > Date.parse(previousAt);
  if (gap && dayChanged) return `— ${gap} · ${day} —`;
  if (gap) return `— ${gap} —`;
  if (dayChanged) return `— ${day} —`;
  return undefined;
}

/**
 * Discord `<t:unix:style>` → absolute text in `timeZone` (spec 9.5): `t`/`T` "14:02",
 * `d`/`D` "Tue 24 Oct 2026", everything else (incl. `R`, never relative) "Tue 24 Oct 2026 14:02".
 */
export function formatDiscordTimestamp(unixSeconds: number, style: string | undefined, timeZone: string): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "an unknown time";
  if (style === "t" || style === "T") return formatClock(date, timeZone);
  if (style === "d" || style === "D") return formatFullDate(date, timeZone);
  return `${formatFullDate(date, timeZone)} ${formatClock(date, timeZone)}`;
}
