// Sleep/busy availability (kept from the retired director; Living cast spec §4.5).

import type { WaifuAvailability } from "../shared/schemas/domain.js";
import { dailyIntervalContains, localTimeOfDayMinutes } from "../orchestration/timeOfDay.js";

/** False while she is asleep or inside a busy block. */
export function isAvailable(availability: WaifuAvailability, now: Date): boolean {
  const minutes = localTimeOfDayMinutes(now);
  if (availability.sleep.enabled && dailyIntervalContains(minutes, availability.sleep)) return false;
  for (const interval of availability.busy) {
    if (dailyIntervalContains(minutes, interval)) return false;
  }
  return true;
}
