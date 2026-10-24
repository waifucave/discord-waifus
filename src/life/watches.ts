// Watches (Living cast spec §6.5): matching a message against her `watch_for` bindings.
//
// A binding matches when every field it sets matches: place, author id, any of its words
// (case-insensitive, whole word, Unicode-folded) or `any_message`. A binding with only `from` matches
// that person anywhere she can read. Her own messages never match. `once` watches go at the first
// match; others fire at most once per 10 minutes and `life.maxWatchFiresPerDay` times a day, until
// they expire. Expired watches are removed silently.

import type { Watch, WatchBinding, WatchesFile } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { updateLifeFile } from "./lifeStore.js";
import { wordBoundaryIncludes } from "./text.js";

export const MAX_ACTIVE_WATCHES = 10;
export const WATCH_MIN_SPACING_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;

export type WatchCandidate = {
  placeKey: string;
  authorId: string;
  /** Rendered body (mentions as names); "" for an empty message. */
  text: string;
  /** The message is hers. */
  own: boolean;
};

/** What matched: the word, "any message", or the person's name. */
export function bindingMatch(binding: WatchBinding, message: WatchCandidate): string | undefined {
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

export function activeWatches(file: WatchesFile, now: Date): Watch[] {
  return file.watches.filter((watch) => Date.parse(watch.expiresAt) > now.getTime());
}

/** Watches that fire for this message (state updated: once-watches removed, fires recorded). */
export async function fireWatches(
  storage: StorageService,
  waifuId: string,
  message: WatchCandidate,
  o: { now: Date; maxFiresPerDay: number }
): Promise<Array<{ watch: Watch; matched: string; binding: WatchBinding }>> {
  if (message.own) return [];
  const fired: Array<{ watch: Watch; matched: string; binding: WatchBinding }> = [];
  await updateLifeFile(storage, waifuId, "watches", (file) => {
    const nowMs = o.now.getTime();
    const kept: Watch[] = [];
    let changed = false;
    for (const watch of file.watches) {
      if (Date.parse(watch.expiresAt) <= nowMs) {
        changed = true;
        continue;
      }
      let hit: { matched: string; binding: WatchBinding } | undefined;
      for (const binding of watch.bindings) {
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
        changed = true;
        continue;
      }
      const fires = watch.fires.filter((at) => nowMs - Date.parse(at) < DAY_MS);
      const last = fires.length > 0 ? Date.parse(fires[fires.length - 1]!) : undefined;
      if ((last !== undefined && nowMs - last < WATCH_MIN_SPACING_MS) || fires.length >= o.maxFiresPerDay) {
        kept.push(watch);
        continue;
      }
      const updated = { ...watch, fires: [...fires, o.now.toISOString()] };
      fired.push({ watch: updated, ...hit });
      kept.push(updated);
      changed = true;
    }
    return changed ? { ...file, watches: kept } : file;
  });
  return fired;
}

/** Drops expired watches (the scheduler's sweep). Returns how many went. */
export async function pruneExpiredWatches(storage: StorageService, waifuId: string, now: Date): Promise<number> {
  let removed = 0;
  await updateLifeFile(storage, waifuId, "watches", (file) => {
    const kept = activeWatches(file, now);
    removed = file.watches.length - kept.length;
    return removed > 0 ? { ...file, watches: kept } : file;
  });
  return removed;
}
