// Busy holds (Living cast spec §21.4, owner decision S4): during a busy block of her day
// (`~/life/schedule.json`), wakes that talk to her get through at once — a DM, a mention or reply,
// her name, the owner's wake, her reminders, her watches and their timeouts, the morning — and the
// rest (detector picks and chime-ins, `@everyone` and role mentions, follow-ups) are held in her
// queue until her next phone check inside the block, else the block's end, then arrive together.
//
// Staying in a conversation (owner addition 2026-10-27): once a wake that gets through woke her in
// a place and she sends a message there, that place is open for `life.busyEngagedMinutes` after her
// latest send there (each send extends it): held kinds get through there too. The open places are in
// her life state (`busyOpen`, they survive a restart) and end with the busy block.

import type { Wake, WakeReason } from "../shared/schemas/life.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeDeps } from "./deps.js";
import { busyAt } from "./home/daySchedule.js";
import { dayPlanFor } from "./home/index.js";
import { readLifeState, updateLifeState } from "./lifeStore.js";

/** Wake reasons that reach her while she is busy (S4). */
export const BUSY_THROUGH_REASONS: ReadonlySet<WakeReason> = new Set(["mention", "name", "dm", "owner", "reminder", "watch", "watch_timeout", "morning"]);

/** A wake that reaches her while she is busy: any of its reasons does (a burst with a mention does). */
export function getsThroughBusy(wake: Pick<Wake, "reason" | "reasons">): boolean {
  return [wake.reason, ...(wake.reasons ?? [])].some((reason) => BUSY_THROUGH_REASONS.has(reason));
}

/** The place is open for her while busy (§21.4): her latest send there was recent, inside this block. */
export function placeOpen(open: Record<string, { until: string; blockEnd: string }> | undefined, placeKey: string | undefined, now: Date, blockEnd: Date): boolean {
  if (!placeKey) return false;
  const entry = open?.[placeKey];
  if (!entry) return false;
  return Date.parse(entry.until) > now.getTime() && Date.parse(entry.blockEnd) === blockEnd.getTime();
}

/**
 * She sent a message in a place (§21.4): while she is busy, the place opens (or stays open) for
 * `life.busyEngagedMinutes` when a wake that got through woke her there (`wakes`: her turn's), or it
 * was open already. Entries of other blocks and lapsed ones are dropped.
 */
export async function noteBusySend(deps: LifeDeps, waifu: WaifuConfig, placeKey: string, wakes: readonly Wake[]): Promise<void> {
  const minutes = deps.config().life.busyEngagedMinutes;
  if (minutes <= 0) return;
  const now = deps.now();
  const busy = busyAt(await dayPlanFor(deps, waifu), now, deps.timeZone);
  if (!busy) return;
  const state = await readLifeState(deps.storage, waifu.id);
  const reached = wakes.some((wake) => wake.placeKey === placeKey && getsThroughBusy(wake));
  if (!reached && !placeOpen(state.busyOpen, placeKey, now, busy.end)) return;
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  const blockEnd = busy.end.toISOString();
  await updateLifeState(deps.storage, waifu.id, (current) => {
    const kept = Object.fromEntries(Object.entries(current.busyOpen ?? {}).filter(([, entry]) => entry.blockEnd === blockEnd && Date.parse(entry.until) > now.getTime()));
    return { ...current, busyOpen: { ...kept, [placeKey]: { until, blockEnd } } };
  });
}
