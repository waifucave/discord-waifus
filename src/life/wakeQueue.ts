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
/** What forget leaves of her own note (a reminder's, a watch's) that named the person. */
export const REMOVED_TEXT = "(removed)";
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
    ...(wake.forAll ? { forAll: true } : {}),
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
  // A `morning` batch deferred again (her budget ran out before she read it) is carried whole.
  const keepsNote = wake.reason === "reminder" || wake.reason === "watch" || wake.reason === "watch_timeout" || wake.reason === "owner" || wake.reason === "followup" || wake.reason === "morning";
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

/**
 * Moves the immediate wakes `keep` rejects into `deferred` (her budget ran out after they were
 * queued, §4.4 guard 5); returns how many immediate wakes remain.
 */
export async function deferImmediate(storage: StorageService, waifuId: string, reason: "sleep" | "budget", now: Date, keep: (wake: Wake) => boolean): Promise<number> {
  let remaining = 0;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const kept = queue.immediate.filter(keep);
    remaining = kept.length;
    if (kept.length === queue.immediate.length) return queue;
    let next: WakeQueue = { ...queue, immediate: kept };
    for (const wake of queue.immediate) if (!keep(wake)) next = withDeferred(next, wake, reason, now);
    // The deferred batch is released by the budget rule (her next local day), whatever paused it first.
    return { ...next, deferred: { ...next.deferred, reason } };
  });
  return remaining;
}

/** Marks the deferred batch as waiting for her budget (it is released on her next local day under budget). */
export async function deferForBudget(storage: StorageService, waifuId: string): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => (queue.deferred.reason === "budget" ? queue : { ...queue, deferred: { ...queue.deferred, reason: "budget" } }));
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

/**
 * The immediate wakes and quiet lines, left in the queue. A turn (its start, or a mid-turn fold)
 * records the wakes in her life state first and only then removes them with `takeWakes`, so a crash
 * between the two leaves them in both places (boot repair re-queues the turn's wakes by id, which
 * adds nothing twice) and never in neither.
 */
export async function peekImmediate(storage: StorageService, waifuId: string): Promise<{ wakes: Wake[]; quiet: WakeQueue["quiet"] }> {
  const queue = await readLifeFile(storage, waifuId, "wakes");
  return { wakes: queue.immediate, quiet: queue.quiet };
}

/**
 * Removes wakes a turn recorded (by id) and the quiet lines it showed (a line that grew since keeps
 * the difference).
 */
export async function takeWakes(storage: StorageService, waifuId: string, wakes: readonly Wake[], quiet: WakeQueue["quiet"]): Promise<void> {
  if (wakes.length === 0 && quiet.length === 0) return;
  const ids = new Set(wakes.map((wake) => wake.id));
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const shown = [...quiet];
    const left = queue.quiet.flatMap((line) => {
      const index = shown.findIndex((seen) => seen.userId === line.userId && seen.placeKey === line.placeKey);
      if (index < 0) return [line];
      const [seen] = shown.splice(index, 1);
      return line.count > seen!.count ? [{ ...line, count: line.count - seen!.count }] : [];
    });
    return { ...queue, immediate: queue.immediate.filter((wake) => !ids.has(wake.id)), quiet: left };
  });
}

/** Takes every immediate wake and quiet line at once. */
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
export async function scrubWakeQueue(
  storage: StorageService,
  waifuId: string,
  o: {
    userId: string;
    placeKeys: ReadonlySet<string>;
    /** Text that names the person for certain (their id or a name only they have). */
    mentions: (text: string) => boolean;
    /** Every text left in place: the caller lists uncertain matches (shared names) for review. */
    review?: (text: string) => void;
  }
): Promise<number> {
  let removed = 0;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    // The person's own wakes (and their DM's) go; someone else's wake that mentions them keeps its
    // place in her queue, and only what it quoted goes (its preview, note, match or batch lines).
    const scrub = (wakes: readonly Wake[]): Wake[] =>
      wakes.flatMap((wake): Wake[] => {
        if (wake.fromUserId === o.userId || (wake.placeKey !== undefined && o.placeKeys.has(wake.placeKey))) {
          removed += 1;
          return [];
        }
        const next: Wake = { ...wake };
        let changed = false;
        for (const field of ["preview", "note", "matched"] as const) {
          const text = next[field];
          if (text === undefined) continue;
          if (o.mentions(text)) {
            // Her note is kept as a marker (a reminder still fires); a quote just goes.
            if (field === "note") next.note = REMOVED_TEXT;
            else delete next[field];
            changed = true;
          } else o.review?.(text);
        }
        if (next.batch) {
          const batch = next.batch.filter((line) => !o.mentions(line));
          if (batch.length !== next.batch.length) {
            next.batch = batch;
            changed = true;
          }
          for (const line of batch) o.review?.(line);
        }
        if (changed) removed += 1;
        return [next];
      });
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
      immediate: scrub(queue.immediate),
      deferred: { ...queue.deferred, places, items: scrub(queue.deferred.items) },
      quiet,
      userWakes
    };
  });
  return removed;
}
