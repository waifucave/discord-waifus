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

/** What she is doing now per her schedule: a busy block's reason, "sleepy" while asleep, else undefined. */
export function currentlyDoingForWaifu(waifu: { availability: WaifuAvailability }, now: Date): string | undefined {
  const currentMinutes = localTimeOfDayMinutes(now);
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(currentMinutes, interval)) {
      const reason = interval.reason.trim();
      if (reason) return reason;
    }
  }
  if (waifu.availability.sleep.enabled && dailyIntervalContains(currentMinutes, waifu.availability.sleep)) {
    return "sleepy";
  }
  return undefined;
}
