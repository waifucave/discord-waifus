// Watches (Living cast spec §16.5, matching rules from §6.5): her `~/watches.json`, with how each
// binding's place and person resolved kept beside it in `life/watch-ids.json`.
//
// A binding matches when every field it sets matches: place, author id, any of its words
// (case-insensitive, whole word, Unicode-folded) or `any_message`. A binding with only `from` matches
// that person anywhere she can read. Her own messages never match; an empty `when` never matches (a
// timer). `once` watches (the default) go at their first match; others fire at most once per 10
// minutes and `life.maxWatchFiresPerDay` times a day until their timeout. A watch whose timeout has
// passed no longer matches: the scheduler removes it and tells her it timed out.

import { parseLocalDateTime } from "./clock.js";
import type { HomeStore } from "./home/homeStore.js";
import type { ResolvedBinding, WatchEntry } from "./home/specialFiles.js";
import { wordBoundaryIncludes } from "./text.js";

export { MAX_WATCHES as MAX_ACTIVE_WATCHES } from "./home/specialFiles.js";
export const WATCH_MIN_SPACING_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;
const MAX_FIRED = 100;

export type WatchCandidate = {
  placeKey: string;
  authorId: string;
  /** Rendered body (mentions as names); "" for an empty message. */
  text: string;
  /** The message is hers. */
  own: boolean;
  /** When it was posted (catch-up after a restart matches a watch by the message's own time). */
  createdAt?: string;
};

/** What matched: the word, "any message", or the person's name. */
export function bindingMatch(binding: ResolvedBinding, message: WatchCandidate): string | undefined {
  if (binding.placeKey && binding.placeKey !== message.placeKey) return undefined;
  if (binding.fromUserId && binding.fromUserId !== message.authorId) return undefined;
  if (binding.words && binding.words.length > 0) {
    const word = binding.words.find((candidate) => wordBoundaryIncludes(message.text, candidate));
    if (!word) return undefined;
    return word;
  }
  if (binding.anyMessage) return "any message";
  if (binding.fromUserId) return binding.fromName ? `from ${binding.fromName}` : "from them";
  return binding.placeKey ? "any message" : undefined;
}

import { onceKey } from "./home/specialFiles.js";
export { onceKey };

export type FiredWatch = { watch: WatchEntry; matched: string; binding: ResolvedBinding };

/** Watches that fire for this message (her file and side file updated: once-watches removed, fires recorded). */
export async function fireWatches(store: HomeStore, message: WatchCandidate, o: { now: Date; timeZone: string; maxFiresPerDay: number }): Promise<FiredWatch[]> {
  if (message.own) return [];
  const fired: FiredWatch[] = [];
  const nowMs = o.now.getTime();
  const posted = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  // A message from before a watch timed out still matches it, however late it is handled.
  const messageMs = Number.isFinite(posted) ? Math.min(posted, nowMs) : nowMs;
  await store.rewriteWatches(o.timeZone, (entries, ids) => {
    const kept: WatchEntry[] = [];
    const watches = { ...ids.watches };
    const firedKeys = [...ids.fired];
    for (const watch of entries) {
      const ends = parseLocalDateTime(watch.timeout, o.timeZone)?.getTime() ?? 0;
      const side = ids.watches[watch.id];
      if (ends <= messageMs || !side || firedKeys.includes(onceKey(watch))) {
        kept.push(watch);
        continue;
      }
      let hit: { matched: string; binding: ResolvedBinding } | undefined;
      for (const binding of side.bindings) {
        const matched = bindingMatch(binding, message);
        if (matched) {
          hit = { matched, binding };
          break;
        }
      }
      if (!hit) {
        kept.push(watch);
        continue;
      }
      if (watch.once) {
        fired.push({ watch, ...hit });
        delete watches[watch.id];
        firedKeys.push(onceKey(watch));
        continue;
      }
      const fires = side.fires.filter((at) => nowMs - Date.parse(at) < DAY_MS);
      const last = fires.length > 0 ? Date.parse(fires[fires.length - 1]!) : undefined;
      if ((last !== undefined && nowMs - last < WATCH_MIN_SPACING_MS) || fires.length >= o.maxFiresPerDay) {
        kept.push(watch);
        continue;
      }
      watches[watch.id] = { ...side, fires: [...fires, o.now.toISOString()] };
      fired.push({ watch, ...hit });
      kept.push(watch);
    }
    return { entries: kept, ids: { ...ids, watches, fired: firedKeys.slice(-MAX_FIRED) } };
  });
  return fired;
}
