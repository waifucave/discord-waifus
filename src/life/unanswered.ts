// Her unanswered streak in a place (Living cast spec §34): how many separate sends of hers there
// since anyone else last wrote (in a DM: since the other person did), and when the streak began.
// It is derived from what the app already keeps, never stored: the conversation's latest page (the
// cache's buffer) and, when that holds only her own lines, the place's transcript days, newest first.
//
// A send is one go at writing, not one message: her messages less than `UNANSWERED_SEND_GAP_MS`
// after her previous one there count as the same send (one send_message call with three short
// lines, or two calls in one turn, is one). The line is soft: it is shown to her, it never stops a send.

import { compareIds } from "../discord/rawMessage.js";
import { parseConversationKey } from "../orchestration/context/keys.js";
import { clockText, dayTimeText, localDayKey, localParts } from "./clock.js";
import type { Wake } from "../shared/schemas/life.js";
import type { LifeDeps } from "./deps.js";
import { isDmPlaceKey } from "./dmPlaces.js";
import { handleOf } from "./places.js";
import { listTranscriptDays, readTranscriptDayLite } from "./transcripts/store.js";

/** Her messages closer together than this are one send (a script's typing and waits stay well under it). */
export const UNANSWERED_SEND_GAP_MS = 5 * 60_000;
/** The streak is shown from this many sends (one follow-up is fine; the second unanswered one is the cue). */
export const UNANSWERED_NOTICE_FROM = 2;
/** At most this many transcript days are read looking for someone else's line. */
export const UNANSWERED_MAX_DAYS = 14;
/** The latest page read first (as many as her notifications' refs read). */
const UNANSWERED_PAGE = 50;

export type UnansweredStreak = {
  /** Her separate sends since anyone else last wrote there. */
  sends: number;
  /** Her first message of the streak (ISO). */
  since: string;
};

export type PlaceMessage = { id: string; at: string; self: boolean };

/**
 * The streak at the end of a place's messages (any order; sorted by id here): her sends after the last
 * message from anyone else. Undefined when the newest message is not hers (or there are none).
 */
export function unansweredStreak(messages: readonly PlaceMessage[]): UnansweredStreak | undefined {
  const sorted = [...messages].sort((a, b) => compareIds(a.id, b.id));
  let sends = 0;
  let since: string | undefined;
  let newer: number | undefined;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const message = sorted[index]!;
    if (!message.self) break;
    const at = Date.parse(message.at);
    if (newer === undefined || !Number.isFinite(at) || newer - at >= UNANSWERED_SEND_GAP_MS) sends += 1;
    newer = Number.isFinite(at) ? at : newer;
    since = message.at;
  }
  return sends > 0 && since ? { sends, since } : undefined;
}

/** Whether a streak is long enough to tell her about. */
export function showsUnanswered(streak: UnansweredStreak | undefined): streak is UnansweredStreak {
  return streak !== undefined && streak.sends >= UNANSWERED_NOTICE_FROM;
}

/**
 * Her streak in a place now: the latest page of the conversation first (`readPage`, served from the
 * cache's buffer while the conversation is trusted, where her send is the moment Discord took it), then,
 * when it holds nobody else's message, her transcript days (newest first, at most
 * `UNANSWERED_MAX_DAYS`) until one does. Undefined on any failure: the line is a hint, never an error.
 */
export async function readUnanswered(deps: Pick<LifeDeps, "storage" | "conversations">, selfAuthorIds: readonly string[], placeKey: string): Promise<UnansweredStreak | undefined> {
  try {
    const ref = parseConversationKey(placeKey);
    if (!ref) return undefined;
    const self = new Set(selfAuthorIds);
    const byId = new Map<string, PlaceMessage>();
    const latest = await deps.conversations.readPage({ conversation: ref, limit: UNANSWERED_PAGE }).then(
      (page) => page.messages,
      () => deps.conversations.bufferedMessages(ref)
    );
    for (const message of latest) byId.set(message.id, { id: message.id, at: message.createdAt, self: self.has(message.authorId) });
    const othersIn = () => [...byId.values()].some((message) => !message.self);
    if (!othersIn()) {
      const days = await listTranscriptDays(deps.storage.dataRoot, placeKey);
      for (const day of days.slice(-UNANSWERED_MAX_DAYS).reverse()) {
        const { lines } = await readTranscriptDayLite(deps.storage.dataRoot, placeKey, day);
        for (const line of lines) if (!byId.has(line.id)) byId.set(line.id, { id: line.id, at: line.at, self: self.has(line.authorId) });
        if (othersIn()) break;
      }
    }
    return unansweredStreak([...byId.values()]);
  } catch {
    return undefined;
  }
}

const DAY_MS = 86_400_000;

/** When the streak began, with its weekday: "Tue 21:00" within the last six days, else "Mon 26 Oct 23:50". */
export function sinceText(since: string, now: Date, timeZone: string): string {
  const at = new Date(since);
  const days = (Date.parse(`${localDayKey(now, timeZone)}T00:00:00Z`) - Date.parse(`${localDayKey(at, timeZone)}T00:00:00Z`)) / DAY_MS;
  return days >= 0 && days < 7 ? `${localParts(at, timeZone).weekday} ${clockText(at, timeZone)}` : dayTimeText(at, timeZone);
}

/** "you've written here 3 times since anyone answered (since Tue 21:00)" (a DM: "since they answered"). */
export function unansweredText(streak: UnansweredStreak, o: { dm: boolean; now: Date; timeZone: string; where?: string }): string {
  return `you've written ${o.where ?? "here"} ${streak.sends} times since ${o.dm ? "they" : "anyone"} answered (since ${sinceText(streak.since, o.now, o.timeZone)})`;
}

/**
 * The worded streaks for the places her ended watches named (a notification view's `unanswered`):
 * placeKey → "you've written in <handle> 3 times since anyone answered (since Tue 21:00)", only where
 * the streak is long enough.
 */
export async function unansweredForWakes(
  deps: Pick<LifeDeps, "storage" | "conversations" | "timeZone">,
  o: { waifuId: string; selfAuthorIds: readonly string[]; wakes: readonly Wake[]; now: Date }
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const keys = new Set(o.wakes.flatMap((wake) => (wake.reason === "watch_timeout" ? (wake.watchedPlaces ?? []) : [])));
  for (const key of keys) {
    const streak = await readUnanswered(deps, o.selfAuthorIds, key);
    if (!showsUnanswered(streak)) continue;
    const handle = await handleOf(deps.storage, o.waifuId, key).catch(() => undefined);
    if (!handle) continue;
    out.set(key, unansweredText(streak, { dm: isDmPlaceKey(key), now: o.now, timeZone: deps.timeZone, where: `in ${handle}` }));
  }
  return out;
}

/** The SendMessage receipt's sentence after a send that leaves the streak at `UNANSWERED_NOTICE_FROM` or more. */
export function unansweredReceipt(streak: UnansweredStreak, o: { dm: boolean; now: Date; timeZone: string }): string {
  const since = sinceText(streak.since, o.now, o.timeZone);
  return o.dm
    ? `They haven't answered your last ${streak.sends} here (since ${since}). Let it rest: wait for them to write before you write here again.`
    : `No one has answered your last ${streak.sends} here (since ${since}). Let it rest: wait for someone to write before you write here again.`;
}
