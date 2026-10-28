// A server's emojis for `~/life/places.md` (Living cast spec §28): the available ones, most used
// first over the server's transcript lines of the last 30 days, then by name, at most 50.
//
// The usage counts are shared by every waifu (they count the server's lines, not hers) and kept in
// memory per data root and server for an hour: places.md is rebuilt at every turn start and at most
// once a minute, and must not re-read 30 days of transcripts each time. The emoji list itself is
// read live from the directory on every rebuild, so an added, removed or renamed emoji shows at
// once (a new name counts as unused until the next recount). The text has no counts or times, so
// places.md changes only when the list or its order does.

import type { GuildEmojiCacheEntry } from "../../shared/schemas/domain.js";
import { listTranscriptConversations, listTranscriptDays, readTranscriptDayLite, transcriptDay } from "../transcripts/store.js";

export const EMOJIS_PER_SERVER = 50;
export const EMOJI_USAGE_DAYS = 30;
export const EMOJI_USAGE_TTL_MS = 3_600_000;

const DAY_MS = 86_400_000;
/** `:name:` as transcripts render custom emoji (Discord names: 2–32 of letters, digits, `_`). */
const EMOJI_TOKEN = /:([A-Za-z0-9_]{2,32}):/gu;

type Usage = { at: number; counts: Promise<Map<string, number>> };
const usageCache = new Map<string, Usage>();

/** Counts `:name:` in the server's transcript lines of the last 30 days (every channel and thread). */
export async function countEmojiUsage(o: { dataRoot: string; timeZone: string; guildId: string; now: Date }): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const sinceMs = o.now.getTime() - EMOJI_USAGE_DAYS * DAY_MS;
  const firstDay = transcriptDay(new Date(sinceMs), o.timeZone);
  const prefix = `g_${o.guildId}_`;
  for (const key of await listTranscriptConversations(o.dataRoot)) {
    if (!key.startsWith(prefix)) continue;
    for (const day of await listTranscriptDays(o.dataRoot, key)) {
      if (day < firstDay) continue;
      for (const line of (await readTranscriptDayLite(o.dataRoot, key, day)).lines) {
        if (!line.text.includes(":") || Date.parse(line.at) < sinceMs) continue;
        for (const match of line.text.matchAll(EMOJI_TOKEN)) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** The server's usage counts, recounted at most once an hour (shared by every waifu). */
export function emojiUsage(o: { dataRoot: string; timeZone: string; guildId: string; now: Date }): Promise<Map<string, number>> {
  const key = `${o.dataRoot}\0${o.guildId}`;
  const nowMs = o.now.getTime();
  const cached = usageCache.get(key);
  if (cached && nowMs >= cached.at && nowMs - cached.at < EMOJI_USAGE_TTL_MS) return cached.counts;
  const counts = countEmojiUsage(o).catch(() => new Map<string, number>());
  usageCache.set(key, { at: nowMs, counts });
  return counts;
}

/** Forgets the cached counts (tests). */
export function clearEmojiUsageCache(): void {
  usageCache.clear();
}

function byName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `:a: :b: (+N more)` for the available emojis (one per name), most used first, then by name;
 * undefined when the server has none. Pure.
 */
export function emojiListText(emojis: readonly Pick<GuildEmojiCacheEntry, "name" | "available">[], counts: ReadonlyMap<string, number>, max = EMOJIS_PER_SERVER): string | undefined {
  const names = [...new Set(emojis.filter((emoji) => emoji.available).map((emoji) => emoji.name))];
  if (names.length === 0) return undefined;
  names.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || byName(a, b));
  const shown = names.slice(0, max).map((name) => `:${name}:`);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(" ")} (+${more} more)` : shown.join(" ");
}
