// The per-waifu wake queue (Living cast spec §4.6): `user/waifus/<id>/life/wakes.json`.
//
// - `immediate`: wakes waiting for her next turn (≤ 200 entries; beyond that, a wake for a place
//   that already has an entry merges into it as a counter).
// - `deferred`: what arrived while she slept or was over her daily budget: per-place counters plus
//   every reminder and watch match with its note. Never dropped; released as one `morning` wake.
// - `userWakes`: the per-user wake limit's last-hour timestamps (§4.4 guard 3); `quiet`: the
//   "+N more from Kevin" lines that ride along with the next turn without starting one.

import { randomBytes } from "node:crypto";
import type { DeferredPlace, Wake, WakeQueue, WakeReason } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { readLifeFile, updateLifeFile } from "./lifeStore.js";

export const MAX_IMMEDIATE_WAKES = 200;
const HOUR_MS = 3_600_000;

/** Wake reasons that count as direct mentions in the morning batch. */
export const MENTION_REASONS: ReadonlySet<WakeReason> = new Set(["mention", "name", "role", "everyone"]);
/** Direct wakes (§5.2 unsent-reply check). */
export const DIRECT_REASONS: ReadonlySet<WakeReason> = new Set(["mention", "name", "role", "dm", "owner"]);

export function newWakeId(): string {
  return `w${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function mergeInto(existing: Wake, wake: Wake): Wake {
  const reasons = [...(existing.reasons ?? [existing.reason])];
  if (!reasons.includes(wake.reason)) reasons.push(wake.reason);
  return {
    ...existing,
    reasons,
    count: (existing.count ?? 1) + (wake.count ?? 1),
    ...(wake.messageId ? { messageId: wake.messageId } : {}),
    ...(wake.preview ? { preview: wake.preview } : {}),
    ...(wake.fromUserId ? { fromUserId: wake.fromUserId } : {}),
    ...(wake.fromName ? { fromName: wake.fromName } : {}),
    at: wake.at
  };
}

/** Adds a wake to `immediate` (pure); a wake whose id is already queued is not added twice. */
export function withImmediate(queue: WakeQueue, wake: Wake): WakeQueue {
  if (queue.immediate.some((entry) => entry.id === wake.id)) return queue;
  if (queue.immediate.length >= MAX_IMMEDIATE_WAKES) {
    const index = queue.immediate.findIndex((entry) => entry.placeKey !== undefined && entry.placeKey === wake.placeKey);
    if (index >= 0) {
      const immediate = [...queue.immediate];
      immediate[index] = mergeInto(immediate[index]!, wake);
      return { ...queue, immediate };
    }
  }
  return { ...queue, immediate: [...queue.immediate, wake] };
}

export async function enqueueWake(storage: StorageService, waifuId: string, wake: Wake): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => withImmediate(queue, wake));
}

/**
 * A turn's wakes go back in front of the queue (it was interrupted, compacted away or never got to
 * answer them); ids already queued are not added twice.
 */
export async function requeueWakes(storage: StorageService, waifuId: string, wakes: readonly Wake[]): Promise<void> {
  if (wakes.length === 0) return;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const queued = new Set(queue.immediate.map((wake) => wake.id));
    let next: WakeQueue = { ...queue, immediate: [] };
    const seen = new Set<string>();
    for (const wake of [...wakes.filter((wake) => !queued.has(wake.id)), ...queue.immediate]) {
      if (seen.has(wake.id)) continue;
      seen.add(wake.id);
      next = withImmediate(next, wake);
    }
    return next;
  });
}

function emptyPlace(): DeferredPlace {
  return { mentions: 0, messages: 0, dms: 0, detector: 0, fromUserIds: [], names: {} };
}

/** Adds a wake to `deferred` (pure): counters for message wakes, the full entry for notes. */
export function withDeferred(queue: WakeQueue, wake: Wake, reason: "sleep" | "budget", now: Date): WakeQueue {
  if (queue.deferred.items.some((item) => item.id === wake.id)) return queue;
  const deferred = {
    ...queue.deferred,
    reason: queue.deferred.reason ?? reason,
    since: queue.deferred.since ?? now.toISOString(),
    places: { ...queue.deferred.places },
    items: [...queue.deferred.items]
  };
  const keepsNote = wake.reason === "reminder" || wake.reason === "watch" || wake.reason === "owner" || wake.reason === "followup";
  if (keepsNote) deferred.items.push(wake);
  if (wake.placeKey && (wake.reason !== "reminder" && wake.reason !== "followup")) {
    const place = { ...(deferred.places[wake.placeKey] ?? emptyPlace()) };
    const count = wake.count ?? 1;
    if (MENTION_REASONS.has(wake.reason)) place.mentions += count;
    else if (wake.reason === "dm") place.dms += count;
    else if (wake.reason === "detector") place.detector += count;
    if (wake.fromUserId && !place.fromUserIds.includes(wake.fromUserId)) place.fromUserIds = [...place.fromUserIds, wake.fromUserId];
    if (wake.fromUserId && wake.fromName) place.names = { ...place.names, [wake.fromUserId]: wake.fromName };
    deferred.places[wake.placeKey] = place;
  }
  return { ...queue, deferred };
}

export async function deferWake(storage: StorageService, waifuId: string, wake: Wake, reason: "sleep" | "budget", now: Date): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => withDeferred(queue, wake, reason, now));
}

export function hasDeferred(queue: WakeQueue): boolean {
  return queue.deferred.items.length > 0 || Object.keys(queue.deferred.places).length > 0;
}

/** Moves the deferred batch out (the caller turns it into a `morning` wake). */
export async function takeDeferred(
  storage: StorageService,
  waifuId: string,
  toWake: (deferred: WakeQueue["deferred"]) => Wake | undefined
): Promise<Wake | undefined> {
  let released: Wake | undefined;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    if (!hasDeferred(queue)) {
      if (queue.deferred.reason === undefined && queue.deferred.since === undefined) return queue;
      return { ...queue, deferred: { places: {}, items: [] } };
    }
    released = toWake(queue.deferred);
    const cleared = { ...queue, deferred: { places: {}, items: [] } };
    return released ? withImmediate(cleared, released) : cleared;
  });
  return released;
}

/** Takes every immediate wake and quiet line (the start of a turn, or a fold mid-turn). */
export async function takeImmediate(storage: StorageService, waifuId: string): Promise<{ wakes: Wake[]; quiet: WakeQueue["quiet"] }> {
  let wakes: Wake[] = [];
  let quiet: WakeQueue["quiet"] = [];
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    wakes = queue.immediate;
    quiet = queue.quiet;
    if (wakes.length === 0 && quiet.length === 0) return queue;
    return { ...queue, immediate: [], quiet: [] };
  });
  return { wakes, quiet };
}

export async function pendingWakeCount(storage: StorageService, waifuId: string): Promise<number> {
  return (await readLifeFile(storage, waifuId, "wakes")).immediate.length;
}

/**
 * §4.4 guard 3: records a direct/detector wake from `userId` unless the last hour already holds
 * `max` of them, in which case the wake becomes a "+N more" line. Returns whether it may start a turn.
 */
export async function admitUserWake(
  storage: StorageService,
  waifuId: string,
  o: { userId: string; name: string; placeKey?: string; max: number; now: Date }
): Promise<boolean> {
  let admitted = true;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const cutoff = o.now.getTime() - HOUR_MS;
    const userWakes: Record<string, string[]> = {};
    for (const [user, times] of Object.entries(queue.userWakes)) {
      const recent = times.filter((time) => Date.parse(time) > cutoff);
      if (recent.length > 0) userWakes[user] = recent;
    }
    const recent = userWakes[o.userId] ?? [];
    if (recent.length >= o.max) {
      admitted = false;
      const quiet = [...queue.quiet];
      const index = quiet.findIndex((line) => line.userId === o.userId && line.placeKey === o.placeKey);
      if (index >= 0) quiet[index] = { ...quiet[index]!, count: quiet[index]!.count + 1, name: o.name || quiet[index]!.name };
      else quiet.push({ userId: o.userId, name: o.name || "someone", count: 1, ...(o.placeKey ? { placeKey: o.placeKey } : {}) });
      return { ...queue, userWakes, quiet };
    }
    userWakes[o.userId] = [...recent, o.now.toISOString()];
    return { ...queue, userWakes };
  });
  return admitted;
}

/** Forget (§7.5 step 3): the person's wakes, previews, counters and quiet lines go. Returns how many entries changed. */
export async function scrubWakeQueue(storage: StorageService, waifuId: string, o: { userId: string; placeKeys: ReadonlySet<string>; mentions: (text: string) => boolean }): Promise<number> {
  let removed = 0;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const keep = (wake: Wake) => {
      const drop =
        wake.fromUserId === o.userId ||
        (wake.placeKey !== undefined && o.placeKeys.has(wake.placeKey)) ||
        (wake.note !== undefined && o.mentions(wake.note)) ||
        (wake.preview !== undefined && o.mentions(wake.preview)) ||
        (wake.batch ?? []).some((line) => o.mentions(line));
      if (drop) removed += 1;
      return !drop;
    };
    const places: Record<string, DeferredPlace> = {};
    for (const [key, place] of Object.entries(queue.deferred.places)) {
      if (o.placeKeys.has(key)) {
        removed += 1;
        continue;
      }
      const names = { ...place.names };
      delete names[o.userId];
      places[key] = { ...place, fromUserIds: place.fromUserIds.filter((id) => id !== o.userId), names };
    }
    const quiet = queue.quiet.filter((line) => {
      const drop = line.userId === o.userId || (line.placeKey !== undefined && o.placeKeys.has(line.placeKey));
      if (drop) removed += 1;
      return !drop;
    });
    const userWakes = { ...queue.userWakes };
    delete userWakes[o.userId];
    return {
      ...queue,
      immediate: queue.immediate.filter(keep),
      deferred: { ...queue.deferred, places, items: queue.deferred.items.filter(keep) },
      quiet,
      userWakes
    };
  });
  return removed;
}
