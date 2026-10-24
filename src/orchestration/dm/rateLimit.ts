// Per-user DM rate limit (spec 4, 9.1.1): pure math over the stored reply timestamps.
//
// The window is (now − windowMinutes, now]. A reply is one run that sent at least one chunk.
// Limited = used ≥ maxReplies; `freesAt` is when the oldest counted reply leaves the window. Stale
// timestamps are pruned on every write, and config edits apply immediately because nothing about
// the limit is stored with the timestamps.

import type { DmRateLimit } from "../../shared/schemas/dm.js";

export type DmLimitAssessment = {
  limited: boolean;
  used: number;
  freesAt?: string;
  /** The timestamps still inside the window (oldest first); what a write should keep. */
  pruned: string[];
};

/** Upper bound on stored timestamps (DmLimitStateSchema max). */
export const MAX_REPLY_TIMESTAMPS = 1000;

export function assessDmLimit(ts: readonly string[], limit: DmRateLimit | null, now: Date): DmLimitAssessment {
  const nowMs = now.getTime();
  const valid = ts
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.ms) && entry.ms <= nowMs)
    .sort((a, b) => a.ms - b.ms);
  if (!limit) {
    // Unlimited: nothing needs keeping beyond a day (a later limit starts from a clean slate).
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;
    const pruned = valid.filter((entry) => entry.ms > dayAgo).map((entry) => entry.value).slice(-MAX_REPLY_TIMESTAMPS);
    return { limited: false, used: pruned.length, pruned };
  }
  const windowMs = limit.windowMinutes * 60_000;
  const inWindow = valid.filter((entry) => entry.ms > nowMs - windowMs);
  const pruned = inWindow.map((entry) => entry.value).slice(-MAX_REPLY_TIMESTAMPS);
  const used = inWindow.length;
  const limited = used >= limit.maxReplies;
  if (!limited) return { limited, used, pruned };
  // Replies must drop until used < maxReplies: the (used − maxReplies + 1)-th oldest leaving frees one.
  const freeing = inWindow[used - limit.maxReplies]!;
  return { limited, used, freesAt: new Date(freeing.ms + windowMs).toISOString(), pruned };
}

/**
 * Whether the limit notice is due (spec 9.1.1): at most one per limited period. A period starts
 * with the reply that filled the window (the newest counted reply), so a notice sent at or after
 * that reply belongs to the current period.
 */
export function limitNoticeDue(a: DmLimitAssessment, limitNoticeSentAt: string | undefined): boolean {
  if (!a.limited) return false;
  if (!limitNoticeSentAt) return true;
  const newest = a.pruned[a.pruned.length - 1];
  if (!newest) return true;
  return Date.parse(limitNoticeSentAt) < Date.parse(newest);
}

export const DEFAULT_LIMIT_NOTICE = "I need a little break — talk to you in about {retryInMinutes} minutes!";

/** The fixed per-waifu notice (O6, no model call). Tokens: {name}, {user}, {retryInMinutes}. */
export function renderLimitNotice(
  template: string,
  o: { name: string; user: string; freesAt: string | undefined; now: Date }
): string {
  const text = template.trim() || DEFAULT_LIMIT_NOTICE;
  const minutes = o.freesAt ? Math.max(1, Math.ceil((Date.parse(o.freesAt) - o.now.getTime()) / 60_000)) : 1;
  return text
    .replaceAll("{name}", o.name)
    .replaceAll("{user}", o.user)
    .replaceAll("{retryInMinutes}", String(minutes))
    .slice(0, 2000);
}
