// Busy holds (Living cast spec §21.4, owner decision S4): during a busy block of her day
// (`~/life/schedule.json`), wakes that talk to her get through at once — a DM, a mention or reply,
// her name, the owner's wake, her reminders and timed plans (§29), her watches and their timeouts,
// the morning — and the
// rest (detector picks and chime-ins, `@everyone` and role mentions, follow-ups) are held in her
// queue until her next phone check inside the block, else the block's end, then arrive together.
//
// Staying in a conversation (owner addition 2026-10-27): once a wake that gets through woke her in
// a place and she sends a message there, that place is open for `life.busyEngagedMinutes` after her
// latest send there (each send extends it): held kinds get through there too. The open places are in
// her life state (`busyOpen`, they survive a restart) and end with the busy block.
//
// Her bed time (§21.6c) counts from her last send (`lastSentAt`): up late while it is recent, then
// dozing, then asleep (`clock.ts` `bedPhaseAt`). Up late or dozing, the same kinds get through as
// while busy, and so does anything in a place she sent to in the last `life.busyEngagedMinutes`
// (`recentSends`); the rest waits for the morning.

import type { LifeState, Wake, WakeReason } from "../shared/schemas/life.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeDeps } from "./deps.js";
import { availabilityAt, type AvailabilityNow, type BedContext } from "./clock.js";
import { busyAt } from "./home/daySchedule.js";
import { dayPlanFor } from "./home/index.js";
import { readLifeState, updateLifeState } from "./lifeStore.js";

/** Wake reasons that reach her while she is busy (S4) or up late / dozing in her bed time (§21.6c). */
export const BUSY_THROUGH_REASONS: ReadonlySet<WakeReason> = new Set(["mention", "name", "dm", "owner", "reminder", "plan", "watch", "watch_timeout", "morning", "wakeup_error"]);

/** A wake that reaches her while she is busy: any of its reasons does (a burst with a mention does). */
export function getsThroughBusy(wake: Pick<Wake, "reason" | "reasons">): boolean {
  return [wake.reason, ...(wake.reasons ?? [])].some((reason) => BUSY_THROUGH_REASONS.has(reason));
}

/** Wake reasons that reach her while she is asleep in her bed time (§21.6c): her reminders (her timed wakeups, timed plans §29, a wakeup her errors stopped §30.2) and the owner's wakes. */
export function getsThroughAsleep(wake: Pick<Wake, "reason" | "reasons">): boolean {
  return [wake.reason, ...(wake.reasons ?? [])].some((reason) => reason === "reminder" || reason === "plan" || reason === "owner" || reason === "wakeup_error");
}

/** The place is open for her while busy (§21.4): her latest send there was recent, inside this block. */
export function placeOpen(open: Record<string, { until: string; blockEnd: string }> | undefined, placeKey: string | undefined, now: Date, blockEnd: Date): boolean {
  if (!placeKey) return false;
  const entry = open?.[placeKey];
  if (!entry) return false;
  return Date.parse(entry.until) > now.getTime() && Date.parse(entry.blockEnd) === blockEnd.getTime();
}

/** She sent there in the last `minutes` (§21.6c: open while she is up late or dozing). */
export function sentRecently(recentSends: Record<string, string> | undefined, placeKey: string | undefined, now: Date, minutes: number): boolean {
  if (!placeKey || minutes <= 0) return false;
  const at = recentSends?.[placeKey];
  return at !== undefined && now.getTime() - Date.parse(at) < minutes * 60_000;
}

/** What her bed time phase counts from (§21.6c). */
export function bedContextOf(deps: Pick<LifeDeps, "config">, state: Pick<LifeState, "lastSentAt">): BedContext {
  const life = deps.config().life;
  return { lastSentAt: state.lastSentAt, engagedMinutes: life.busyEngagedMinutes, dozeMinutes: life.bedDozeMinutes };
}

/** Where she is now: her bed time phase (from her life state), else her day's busy blocks, else awake. */
export async function availabilityFor(deps: Pick<LifeDeps, "storage" | "config" | "timeZone">, waifu: WaifuConfig, now: Date, state?: Pick<LifeState, "lastSentAt">): Promise<AvailabilityNow> {
  const current = state ?? (await readLifeState(deps.storage, waifu.id));
  return availabilityAt(waifu.availability, now, deps.timeZone, { day: await dayPlanFor(deps, waifu), bed: bedContextOf(deps, current) });
}

/** Why the detector leaves her out of a place (§24): busy, in her bed time (up late or dozing), asleep. */
export type NotAroundReason = "busy" | "bed time" | "asleep";

/**
 * Is she around in this place for the addressee detector (§24)? Awake (no busy block, outside her
 * bed time) she is; busy, only where the place is open for her (`busyOpen`, as the router reads it,
 * §21.4); up late or dozing in her bed time, only where she sent in the last
 * `life.busyEngagedMinutes` (§21.6c); asleep, never.
 */
export async function aroundIn(deps: Pick<LifeDeps, "storage" | "config" | "timeZone">, waifu: WaifuConfig, placeKey: string, now: Date): Promise<{ around: true } | { around: false; why: NotAroundReason }> {
  const state = await readLifeState(deps.storage, waifu.id);
  const day = await dayPlanFor(deps, waifu);
  const availability = availabilityAt(waifu.availability, now, deps.timeZone, { day, bed: bedContextOf(deps, state) });
  if (availability.state === "asleep") return { around: false, why: "asleep" };
  if (availability.bed) return sentRecently(state.recentSends, placeKey, now, deps.config().life.busyEngagedMinutes) ? { around: true } : { around: false, why: "bed time" };
  if (availability.state === "busy") {
    const busy = busyAt(day, now, deps.timeZone);
    return busy && placeOpen(state.busyOpen, placeKey, now, busy.end) ? { around: true } : { around: false, why: "busy" };
  }
  return { around: true };
}

/**
 * She sent a message in a place: her last send (`lastSentAt`, her bed time's clock, §21.6c) and the
 * place's latest send (`recentSends`, kept for `life.busyEngagedMinutes`) are recorded. While she is
 * busy (§21.4) the place opens (or stays open) for `life.busyEngagedMinutes` when a wake that got
 * through woke her there (`wakes`: her turn's), or it was open already. Entries of other blocks and
 * lapsed ones are dropped.
 */
export async function noteSend(deps: LifeDeps, waifu: WaifuConfig, placeKey: string, wakes: readonly Wake[]): Promise<void> {
  const minutes = deps.config().life.busyEngagedMinutes;
  const now = deps.now();
  const nowIso = now.toISOString();
  const busy = minutes > 0 ? busyAt(await dayPlanFor(deps, waifu), now, deps.timeZone) : undefined;
  const state = await readLifeState(deps.storage, waifu.id);
  const reached = wakes.some((wake) => wake.placeKey === placeKey && getsThroughBusy(wake));
  const opens = busy !== undefined && (reached || placeOpen(state.busyOpen, placeKey, now, busy.end));
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  await updateLifeState(deps.storage, waifu.id, (current) => {
    const recent = Object.fromEntries(Object.entries(current.recentSends ?? {}).filter(([, at]) => now.getTime() - Date.parse(at) < minutes * 60_000));
    const next: LifeState = { ...current, lastSentAt: nowIso, recentSends: minutes > 0 ? { ...recent, [placeKey]: nowIso } : {} };
    if (!opens) return next;
    const blockEnd = busy.end.toISOString();
    const kept = Object.fromEntries(Object.entries(current.busyOpen ?? {}).filter(([, entry]) => entry.blockEnd === blockEnd && Date.parse(entry.until) > now.getTime()));
    return { ...next, busyOpen: { ...kept, [placeKey]: { until, blockEnd } } };
  });
}
