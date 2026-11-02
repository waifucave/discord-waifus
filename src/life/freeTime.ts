// Free time (Living cast spec §46, owner request 2026-11-02): a few moments a day each waifu with a
// bot is woken with nothing to answer (`free` wakes), so she can start something of her own: say
// something in a room, write to someone, follow up on her notes or look something up. Before it
// only a message, a watch or a wakeup she set ever woke her, and she set almost none, so she never
// spoke first.
//
// `life.freeTimePerDay` moments (0 = off) fall between FREE_TIME_FROM_HOUR and FREE_TIME_TO_HOUR
// local, one at a random point in each equal part of that window, the same for her all day (a hash
// of her id and the day), so a restart neither adds nor moves one. A moment is skipped when she had
// a turn in the last FREE_TIME_RECENT_TURN_MS (she has been around anyway), has one running or
// queued, is over her daily budget, or the app found it more than FREE_TIME_LATE_MS late (it was
// down). The wake names her rooms and how long each has been quiet; she decides what to do.

import { createHash } from "node:crypto";
import { dayKey } from "../orchestration/context/timeFormat.js";
import type { Wake } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { instantOfLocal, localParts } from "./clock.js";
import { placesWithHandles } from "./places.js";
import { newestTranscriptLine } from "./transcripts/store.js";

export const FREE_TIME_FROM_HOUR = 10;
export const FREE_TIME_TO_HOUR = 23;
export const FREE_TIME_RECENT_TURN_MS = 45 * 60_000;
export const FREE_TIME_LATE_MS = 30 * 60_000;
/** Rooms named in the wake, the most recently active first. */
export const FREE_TIME_MAX_ROOMS = 6;

/** Her free-time moments on the local day of `now`, in order. */
export function freeTimeMoments(waifuId: string, now: Date, perDay: number, timeZone: string): Date[] {
  if (perDay <= 0) return [];
  const p = localParts(now, timeZone);
  const from = instantOfLocal(timeZone, p.year, p.month, p.day, FREE_TIME_FROM_HOUR, 0).getTime();
  const to = instantOfLocal(timeZone, p.year, p.month, p.day, FREE_TIME_TO_HOUR, 0).getTime();
  const part = (to - from) / perDay;
  const day = dayKey(now, timeZone);
  return Array.from({ length: perDay }, (_, index) => {
    const fraction = createHash("sha256").update(`${waifuId}:${day}:${index}`).digest().readUInt32BE(0) / 2 ** 32;
    return new Date(Math.floor(from + (index + fraction) * part));
  });
}

/** "12 min" / "3 h" / "2 days". */
function quietFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * The `free` wake: her rooms (not DMs, so a free-time turn shows nothing private) with how long ago
 * each last had a message, the most recently active first. Paused servers are left out.
 */
export async function freeTimeWake(o: { storage: StorageService; waifuId: string; now: Date; id: string }): Promise<Wake> {
  const places = (await placesWithHandles(o.storage, o.waifuId).catch(() => [])).filter((place) => place.kind !== "dm" && !place.paused);
  const rooms: Array<{ handle: string; at: number }> = [];
  for (const place of places) {
    const newest = await newestTranscriptLine(o.storage.dataRoot, place.placeKey).catch(() => undefined);
    const at = newest ? Date.parse(newest.at) : Number.NaN;
    rooms.push({ handle: place.handle, at: Number.isFinite(at) ? at : 0 });
  }
  rooms.sort((a, b) => b.at - a.at);
  const shown = rooms.slice(0, FREE_TIME_MAX_ROOMS).map((room) => `${room.handle} (${room.at > 0 ? `last message ${quietFor(o.now.getTime() - room.at)} ago` : "no messages yet"})`);
  return { id: o.id, reason: "free", ...(shown.length > 0 ? { note: `your rooms: ${shown.join(", ")}` } : {}), at: o.now.toISOString() };
}
