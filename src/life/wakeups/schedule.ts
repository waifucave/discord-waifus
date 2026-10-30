// The scheduler's side of her wakeups (Living cast spec §30.2): timed ones come due, watches and pages
// end, and her code's state is saved. Every occurrence is routed first under a wake id fixed by the
// wakeup and its time, then recorded as routed, then removed or moved on in her file: a crash in
// between routes the same wake again, which the queue never adds twice, and a file the app cannot
// rewrite never fires the same occurrence twice.

import type { Wake, WakeupSide } from "../../shared/schemas/life.js";
import { parseLocalDateTime } from "../clock.js";
import { onceKey, type HomeStore } from "../home/homeStore.js";
import { functionSourceOf, MAX_WAKEUPS_FILE_BYTES, untilOf, wakeupsText, type WakeupEntry } from "./file.js";
import { applyRuns, WATCH_MIN_SPACING_MS, type CodeRun } from "./run.js";
import { mayHaveSeenDm } from "./privacy.js";
import { dropState, markSaved, pendingStates } from "./state.js";
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

export type HeldMatch = NonNullable<WakeupSide["watches"][string]["held"]>;

/**
 * Room matches a repeating watch's 10-minute spacing held back (§30.2) that may fire now: the watch
 * still on and not ended (its end wake covers the rest), its last fire 10 minutes ago or more, under
 * the daily cap.
 */
export function dueHeldMatches(entries: readonly WakeupEntry[], side: WakeupSide, now: Date, timeZone: string, maxFiresPerDay: number): Array<{ entry: WakeupEntry; held: HeldMatch }> {
  const nowMs = now.getTime();
  return entries.flatMap((entry) => {
    const watch = side.watches[entry.id];
    if (entry.kind !== "watch" || entry.disabled !== undefined || !watch?.held) return [];
    if ((untilOf(entry, timeZone)?.getTime() ?? 0) <= nowMs) return [];
    const fires = watch.fires.filter((at) => nowMs - Date.parse(at) < 86_400_000);
    const last = fires.length > 0 ? Date.parse(fires[fires.length - 1]!) : undefined;
    if ((last !== undefined && nowMs - last < WATCH_MIN_SPACING_MS) || fires.length >= maxFiresPerDay) return [];
    return [{ entry, held: watch.held }];
  });
}

/** A held match's watch wake, from the message as her transcript has it (deterministic id: once). */
export function heldWake(entry: WakeupEntry, held: HeldMatch, message: { fromName: string; preview: string }): Wake {
  const matched = held.matched !== undefined ? { matched: held.matched } : {};
  return {
    id: `w-held-${entry.id}-${held.messageId}`,
    reason: "watch",
    watchId: entry.id,
    ...matched,
    note: entry.note,
    wakeups: [{ id: entry.id, ...matched, note: entry.note }],
    placeKey: held.placeKey,
    ...(held.fromUserId ? { fromUserId: held.fromUserId } : {}),
    fromName: message.fromName,
    messageId: held.messageId,
    preview: message.preview,
    at: held.at,
    ...(held.waifuAuthored ? { waifuAuthored: true } : {})
  };
}

/** The wake of a timed wakeup (§30.2: it reads like a reminder). */
export function timedWake(item: DueTimed): Wake {
  return { id: item.wakeId, reason: "reminder", watchId: item.entry.id, note: item.entry.note, at: item.due.toISOString() };
}

/**
 * The wake of an ended watch or page (`watch timed out`, as watches always did). A watch on a DM (or
 * on "everywhere") is about a private chat: a DM wake (D14), like its error wake.
 */
export function endWake(item: { entry: WakeupEntry; ends: Date; wakeId: string }, side: WakeupSide): Wake {
  const watched = watchedPlacesOf(item.entry, side);
  return {
    id: item.wakeId,
    reason: "watch_timeout",
    watchId: item.entry.id,
    note: item.entry.note,
    ...(watched.length > 0 ? { watchedPlaces: watched } : {}),
    ...(mayHaveSeenDm(item.entry, side) ? { dm: true } : {}),
    at: item.ends.toISOString()
  };
}

/** The places a watch named (resolved keys of its places and its filters' places; none for "everywhere"), at most 10. */
export function watchedPlacesOf(entry: WakeupEntry, side: WakeupSide): string[] {
  if (entry.kind !== "watch") return [];
  const resolved = side.watches[entry.id];
  const keys = [...(resolved?.placeKeys ?? []), ...(resolved?.filters ?? []).flatMap((filter) => (filter.placeKey ? [filter.placeKey] : []))];
  return [...new Set(keys)].slice(0, 10);
}

/** The next `count` times of an `every` (her result shows three). */
export function nextTimes(entry: WakeupEntry, after: Date, timeZone: string, count = 3): Date[] {
  const spec = entry.kind === "every" && entry.when ? parseEvery(entry.when) : undefined;
  return spec?.ok ? nextOccurrences(spec.value, after, timeZone, count) : [];
}

/** Why a state that won't fit stops counting (§30.6). */
export const STATE_TOO_BIG = `its state would make ~/life/wakeups.json bigger than ${MAX_WAKEUPS_FILE_BYTES / 1024} KiB; keep less in it`;

/**
 * Writes her code's waiting state into her file: at most once a minute (`nowMs`), or now
 * (`force`, shutdown and forget). Only into the same wakeup with the same code. The file never
 * grows past her 60 KiB cap this way: a state that would push it over is not written (the biggest
 * first), counts as that wakeup's error, and a third in a row stops it (the wakes to route come back).
 */
export async function saveWakeupStates(store: HomeStore, nowMs: number, o: { force?: boolean } = {}): Promise<{ saved: boolean; errorWakes: Wake[] }> {
  const dataRoot = store.storage.dataRoot;
  const pending = pendingStates(dataRoot, store.waifuId, o.force ? undefined : nowMs);
  if (!pending) return { saved: false, errorWakes: [] };
  const errorWakes: Wake[] = [];
  const now = new Date(nowMs);
  const { saved } = await store.rewriteWakeups((entries, side) => {
    const changed = new Set<string>();
    let next = entries.map((entry) => {
      const waiting = pending.get(entry.id);
      if (!waiting || waiting.source !== functionSourceOf(entry) || JSON.stringify(waiting.state) === JSON.stringify(entry.state ?? {})) return entry;
      changed.add(entry.id);
      return { ...entry, state: waiting.state };
    });
    const runs = new Map<string, { source: string | undefined; run: CodeRun }>();
    while (Buffer.byteLength(wakeupsText(next), "utf8") > MAX_WAKEUPS_FILE_BYTES && changed.size > 0) {
      const biggest = [...changed].sort((a, b) => JSON.stringify(pending.get(b)!.state).length - JSON.stringify(pending.get(a)!.state).length)[0]!;
      changed.delete(biggest);
      const before = entries.find((entry) => entry.id === biggest)!;
      next = next.map((entry) => (entry.id === biggest ? before : entry));
      dropState(dataRoot, store.waifuId, biggest);
      runs.set(biggest, { source: functionSourceOf(before), run: { ok: false, error: STATE_TOO_BIG } });
    }
    if (runs.size === 0) return { entries: next, side };
    const applied = applyRuns(next, side, runs, { dataRoot, waifuId: store.waifuId, now });
    errorWakes.push(...applied.errorWakes);
    return { entries: applied.entries, side: applied.side };
  });
  if (saved) markSaved(dataRoot, store.waifuId, pending, nowMs);
  // A stop the file didn't take is no stop: no wake for it.
  return { saved, errorWakes: saved ? errorWakes : [] };
}
