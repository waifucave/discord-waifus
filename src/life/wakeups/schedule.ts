// The scheduler's side of her wakeups (Living cast spec §30.2): timed ones come due, watches and pages
// end, and her code's state is saved. Every occurrence is routed first under a wake id fixed by the
// wakeup and its time, then recorded as routed, then removed or moved on in her file: a crash in
// between routes the same wake again, which the queue never adds twice, and a file the app cannot
// rewrite never fires the same occurrence twice.

import type { Wake, WakeupSide } from "../../shared/schemas/life.js";
import { parseLocalDateTime } from "../clock.js";
import { onceKey, type HomeStore } from "../home/homeStore.js";
import { functionSourceOf, untilOf, type WakeupEntry } from "./file.js";
import { markSaved, pendingStates } from "./state.js";
import { latestOccurrence, nextOccurrences, parseEvery } from "./when.js";

/** One wake id per timed occurrence (its id and due time; the `reminder` reason, §30.2). */
export function timedWakeId(id: string, due: Date): string {
  return `w-reminder-${id}-${due.getTime().toString(36)}`;
}

/** One wake id per watch or page end. */
export function endWakeId(id: string, ends: Date): string {
  return `w-timeout-${id}-${ends.getTime().toString(36)}`;
}

export type DueTimed = { entry: WakeupEntry; due: Date; wakeId: string };

/**
 * Timed wakeups due now: an `at` whose time came, an `every` whose latest occurrence since it started
 * counting (or last fired) came. `fresh` are to be routed; `done` are the `at`s to remove (fired now
 * or before, or due before a lost side file was recovered).
 */
export function dueTimed(entries: readonly WakeupEntry[], side: WakeupSide, now: Date, timeZone: string): { fresh: DueTimed[]; done: Set<string> } {
  const fired = new Set(side.fired);
  const lostBefore = side.recoveredAt ? Date.parse(side.recoveredAt) : undefined;
  const fresh: DueTimed[] = [];
  const done = new Set<string>();
  for (const entry of entries) {
    if (entry.disabled !== undefined) continue;
    if (entry.kind === "at") {
      const due = entry.when ? parseLocalDateTime(entry.when, timeZone) : undefined;
      if (!due || due.getTime() > now.getTime()) continue;
      done.add(entry.id);
      const wakeId = timedWakeId(entry.id, due);
      if (fired.has(wakeId) || (lostBefore !== undefined && due.getTime() <= lostBefore)) continue;
      fresh.push({ entry, due, wakeId });
      continue;
    }
    if (entry.kind !== "every") continue;
    const spec = entry.when ? parseEvery(entry.when) : undefined;
    const counting = side.every[entry.id];
    if (!spec?.ok || !counting || counting.when !== entry.when) continue;
    const since = Math.max(Date.parse(counting.since), lostBefore ?? -Infinity);
    const due = latestOccurrence(spec.value, new Date(since), now, timeZone);
    if (!due) continue;
    const wakeId = timedWakeId(entry.id, due);
    if (!fired.has(wakeId)) fresh.push({ entry, due, wakeId });
  }
  return { fresh, done };
}

/** Watches and pages whose end passed (a once watch that fired is gone already). */
export function endedWakeups(entries: readonly WakeupEntry[], side: WakeupSide, now: Date, timeZone: string): Array<{ entry: WakeupEntry; ends: Date; wakeId: string; route: boolean }> {
  const fired = new Set(side.fired);
  const lostBefore = side.recoveredAt ? Date.parse(side.recoveredAt) : undefined;
  return entries.flatMap((entry) => {
    if (entry.kind !== "watch" && entry.kind !== "page") return [];
    const ends = untilOf(entry, timeZone);
    if (!ends || ends.getTime() > now.getTime()) return [];
    const wakeId = endWakeId(entry.id, ends);
    const route = !fired.has(wakeId) && !fired.has(onceKey(entry)) && !(lostBefore !== undefined && ends.getTime() <= lostBefore);
    return [{ entry, ends, wakeId, route }];
  });
}

/** The wake of a timed wakeup (§30.2: it reads like a reminder). */
export function timedWake(item: DueTimed): Wake {
  return { id: item.wakeId, reason: "reminder", watchId: item.entry.id, note: item.entry.note, at: item.due.toISOString() };
}

/** The wake of an ended watch or page (`watch timed out`, as watches always did). */
export function endWake(item: { entry: WakeupEntry; ends: Date; wakeId: string }): Wake {
  return { id: item.wakeId, reason: "watch_timeout", watchId: item.entry.id, note: item.entry.note, at: item.ends.toISOString() };
}

/** The next `count` times of an `every` (her result shows three). */
export function nextTimes(entry: WakeupEntry, after: Date, timeZone: string, count = 3): Date[] {
  const spec = entry.kind === "every" && entry.when ? parseEvery(entry.when) : undefined;
  return spec?.ok ? nextOccurrences(spec.value, after, timeZone, count) : [];
}

/**
 * Writes her code's waiting state into her file: at most once a minute (`nowMs`), or now
 * (`force`, shutdown and forget). Only into the same wakeup with the same code.
 */
export async function saveWakeupStates(store: HomeStore, nowMs: number, o: { force?: boolean } = {}): Promise<boolean> {
  const pending = pendingStates(store.storage.dataRoot, store.waifuId, o.force ? undefined : nowMs);
  if (!pending) return false;
  const clean = await store.rewriteWakeups((entries, side) => ({
    entries: entries.map((entry) => {
      const waiting = pending.get(entry.id);
      return waiting && waiting.source === functionSourceOf(entry) && JSON.stringify(waiting.state) !== JSON.stringify(entry.state ?? {}) ? { ...entry, state: waiting.state } : entry;
    }),
    side
  }));
  if (clean) markSaved(store.storage.dataRoot, store.waifuId, pending, nowMs);
  return clean;
}
