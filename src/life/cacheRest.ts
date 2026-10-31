// Rest before her prompt cache goes cold (Living cast spec §25). Her requests ask the provider to
// cache the prompt for an hour, refreshed by every request; after that her next turn writes her whole
// context again. When her context is already large and she has been quiet, the §19 rest turn comes
// shortly before the cache expires, so she summarises herself while the prefix is still cheap to read.
//
// Pure decision here (shared by the scheduler's tick, which pokes her life, and the life loop, which
// runs the turn); the turn itself is `Life.restTurn` with `cache: true`.

import { findCuratedModel, type CuratedModel } from "../models/catalog.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeState } from "../shared/schemas/life.js";
import type { LifeDeps } from "./deps.js";
import { lifeBudget } from "./request.js";
import { pendingWakeCount } from "./wakeQueue.js";

export type CacheRestInput = {
  life: { restNotice: boolean; cacheRestMinRatio: number; cacheRestLeadMinutes: number; maxContextTokens: number };
  triggerRatio: number;
  state: LifeState;
  model: CuratedModel;
  /** Her route's cache lifetime (`CuratedModel.cacheTtlMs`, from `explicitCacheTtlMs`); undefined: nothing happens. */
  ttlMs: number | undefined;
  now: Date;
  /** Wakes waiting in her queue (a turn is coming anyway). */
  queued: number;
};

/**
 * When the quiet-time rest is due, or undefined when it is not due at all in this epoch's current
 * state: her last request + the route's TTL − `life.cacheRestLeadMinutes`. Needs the rest notice on,
 * a running epoch (no pending start, no compaction backing off), no turn running, no rest
 * turn of either kind in this epoch, and her last request at least `life.cacheRestMinRatio` × the
 * compaction trigger (and below it: at the trigger compaction runs anyway).
 */
export function cacheRestDueAt(o: Pick<CacheRestInput, "life" | "triggerRatio" | "state" | "model" | "ttlMs">): Date | undefined {
  const { state, life } = o;
  if (!life.restNotice || o.ttlMs === undefined || !state.systemSnapshot || state.pendingEpochStart) return undefined;
  if (state.status !== "idle" || state.currentTurn) return undefined;
  if (state.restTurn?.epoch === state.epoch || state.cacheRest?.epoch === state.epoch) return undefined;
  const at = state.lastRequestAt ? Date.parse(state.lastRequestAt) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const trigger = o.triggerRatio * lifeBudget(o.model, life.maxContextTokens);
  const tokens = state.lastRequestTokens ?? 0;
  if (tokens < life.cacheRestMinRatio * trigger || tokens >= trigger) return undefined;
  return new Date(at + o.ttlMs - life.cacheRestLeadMinutes * 60_000);
}

/**
 * Whether the quiet-time rest is due now (§25): due by `cacheRestDueAt`, her cache not yet expired,
 * nothing queued and compaction not backing off.
 */
export function cacheRestDueNow(o: CacheRestInput): boolean {
  const due = cacheRestDueAt(o);
  if (!due || o.ttlMs === undefined || o.queued > 0) return false;
  const now = o.now.getTime();
  const expires = Date.parse(o.state.lastRequestAt!) + o.ttlMs;
  if (now < due.getTime() || now >= expires) return false;
  if (o.state.compactionPausedUntil !== undefined && Date.parse(o.state.compactionPausedUntil) > now) return false;
  return true;
}

/** The decision for her, read from her state, queue and route. Never for a waifu without her own bot. */
export async function cacheRestDue(deps: Pick<LifeDeps, "storage" | "config" | "now">, waifu: WaifuConfig, model: CuratedModel, state: LifeState): Promise<boolean> {
  if (!waifu.botId) return false;
  const config = deps.config();
  // From the curated catalog the life was given (deps.catalog()), never a fresh read of winter's.
  const ttlMs = model.cacheTtlMs;
  const base = { life: config.life, triggerRatio: config.compaction.triggerRatio, state, model, ttlMs };
  // Cheap checks first: the scheduler asks at every tick.
  if (!cacheRestDueAt(base)) return false;
  return cacheRestDueNow({ ...base, now: deps.now(), queued: await pendingWakeCount(deps.storage, waifu.id) });
}

/**
 * The scheduler's question (§25): her route from her config, else no. Also no while her provider
 * cools down or her daily budget is spent (the life loop would not run the turn: the tick would only
 * poke her again every 15 s).
 */
export async function cacheRestDueFor(
  deps: Pick<LifeDeps, "storage" | "config" | "now" | "catalog" | "models">,
  waifu: WaifuConfig,
  state: LifeState,
  o: { spentToday?: (waifuId: string, now: Date) => Promise<number> } = {}
): Promise<boolean> {
  const model = waifu.model ? findCuratedModel(waifu.model, deps.catalog()) : undefined;
  if (!model || !(await cacheRestDue(deps, waifu, model, state))) return false;
  if (deps.models.cooldownRemainingMs?.(model.providerId) !== undefined) return false;
  const budget = waifu.life.dailyBudgetUsd;
  if (budget !== null && budget !== undefined && o.spentToday && (await o.spentToday(waifu.id, deps.now())) >= budget) return false;
  return true;
}
