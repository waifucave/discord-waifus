// Local time-of-day helpers for daily HH:MM intervals (sleep/busy schedules).

import type { WaifuAvailability } from "../shared/schemas/domain.js";

export function localTimeOfDayMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function dailyIntervalContains(currentMinutes: number, interval: { start: string; end: string }): boolean {
  const start = timeOfDayMinutes(interval.start);
  const end = timeOfDayMinutes(interval.end);
  if (start === end) return false;
  if (start < end) return currentMinutes >= start && currentMinutes < end;
  return currentMinutes >= start || currentMinutes < end;
}

function timeOfDayMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * "sleepy" while asleep per her sleep window, else undefined (her busy times are her own
 * `~/life/schedule.json` now, read by the life: spec §21).
 */
export function currentlyDoingForWaifu(waifu: { availability: WaifuAvailability }, now: Date): string | undefined {
  const currentMinutes = localTimeOfDayMinutes(now);
  if (waifu.availability.sleep.enabled && dailyIntervalContains(currentMinutes, waifu.availability.sleep)) {
    return "sleepy";
  }
  return undefined;
}
