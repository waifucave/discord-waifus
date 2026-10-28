// The wake router (Living cast spec §4.4, §4.5): every wake candidate passes the guards in order —
//
//   1. paused server or app: drop
//   2. DM rate limit: a limited user's DM wake is dropped; the fixed limit notice goes out once per
//      limited period (no model call)
//   3. per-user wake limit (guilds): past `life.maxWakesPerUserPerHour`, the wake becomes one
//      "+N more from Kevin" line that rides along with her next turn
//   4. bed time (§21.6c): asleep, everything but her reminders, her timed plans (§29) and the
//      owner's wakes is deferred to the morning (DMs get the sleep notice once per bed time per
//      user); up late or dozing, what
//      doesn't talk to her is deferred too, unless she sent in that place in the last
//      `life.busyEngagedMinutes` (`busy.ts`)
//   4b. busy (§21.4): in a busy block of her `~/life/schedule.json`, a wake that doesn't talk to
//      her (detector picks, chime-ins, @everyone and role mentions, follow-ups) is held until her
//      next phone check or the block's end, unless she is chatting in that place (`busy.ts`)
//   5. daily budget: defer to the next local day
//   6. room loop guard (`life.maxWaifuTriggeredTurns`, off by default): waifu-authored messages stop
//      producing wakes in a place after that many since the last human message there
//
// `owner` wakes skip 3–6. Admitted wakes go to her persistent queue and poke her life.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { assessDmLimit, limitNoticeDue, renderLimitNotice } from "../orchestration/dm/rateLimit.js";
import { readDmLimit, updateDmLimit } from "../orchestration/dm/dmStore.js";
import { readWaifu } from "../orchestration/stores/config.js";
import { ServerConfigSchema, type WaifuConfig } from "../shared/schemas/domain.js";
import type { Wake } from "../shared/schemas/life.js";
import { assignConversationRefs } from "../discord/refStore.js";
import type { DailyCost } from "./budget.js";
import type { LifeDeps } from "./deps.js";
import { admitUserWake, deferWake, enqueueWake, holdWake } from "./wakeQueue.js";
import { availabilityFor, getsThroughAsleep, getsThroughBusy, placeOpen, sentRecently } from "./busy.js";
import { busyAt } from "./home/daySchedule.js";
import { dayPlanFor } from "./home/index.js";
import { readLifeState } from "./lifeStore.js";

export const STAGGER_MAX_MS = 20_000;
const MAX_AUTO_IDS = 50;

/** Reasons guard 3 counts (direct and detector wakes from a person). */
const USER_LIMITED = new Set(["mention", "name", "role", "everyone", "detector"]);

export type RouteContext = {
  guildId?: string;
  /** A DM wake: the user and their name. */
  dmUserId?: string;
  /** Delay the wake by a random 0–20 s (several waifus woken by one @everyone / role ping). */
  stagger?: boolean;
};

export type RouteOutcome = "queued" | "deferred" | "held" | "quiet" | "dropped";

/**
 * §4.4 guard 6: waifu-authored messages per place since the last human message there. Each message
 * counts once, however many waifus it wakes (review M16): one exchange between two waifus is one
 * step of the loop, not one per waifu.
 */
export class LoopGuard {
  private readonly messages = new Map<string, Set<string>>();

  human(placeKey: string): void {
    this.messages.delete(placeKey);
  }

  /** May this waifu-authored message still wake someone? (It may when it already counts.) */
  allowed(placeKey: string, max: number, messageId?: string): boolean {
    if (max <= 0) return true;
    const counted = this.messages.get(placeKey);
    if (messageId && counted?.has(messageId)) return true;
    return (counted?.size ?? 0) < max;
  }

  count(placeKey: string, messageId?: string): void {
    let counted = this.messages.get(placeKey);
    if (!counted) this.messages.set(placeKey, (counted = new Set()));
    counted.add(messageId ?? `wake-${counted.size}`);
  }
}

export type WakeRouterOptions = {
  deps: LifeDeps;
  cost: DailyCost;
  poke: (waifuId: string) => void;
  loopGuard?: LoopGuard;
};

export class WakeRouter {
  readonly loopGuard: LoopGuard;
  /** Staggered wakes waiting on their timers, with the resolver that ends them on close. */
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private closed = false;

  constructor(private readonly o: WakeRouterOptions) {
    this.loopGuard = o.loopGuard ?? new LoopGuard();
  }

  close(): void {
    this.closed = true;
    for (const [timer, drop] of this.timers) {
      clearTimeout(timer);
      drop();
    }
    this.timers.clear();
  }

  /** Routes one wake for one waifu; with `stagger`, after a random 0–20 s delay. */
  route(waifuId: string, wake: Wake, context: RouteContext = {}): Promise<RouteOutcome> {
    if (context.stagger) {
      const delay = Math.floor(this.o.deps.random() * STAGGER_MAX_MS);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          if (this.closed) return resolve("dropped");
          this.routeNow(waifuId, wake, context).then(resolve, () => resolve("dropped"));
        }, delay);
        timer.unref?.();
        this.timers.set(timer, () => resolve("dropped"));
      });
    }
    return this.routeNow(waifuId, wake, context);
  }

  private async serverPaused(guildId: string): Promise<boolean> {
    try {
      const raw = await readFile(this.o.deps.storage.dataPath(path.join("user", "servers", guildId, "server.json")), "utf8");
      return ServerConfigSchema.parse(JSON.parse(raw)).paused;
    } catch {
      return false;
    }
  }

  async routeNow(waifuId: string, wake: Wake, context: RouteContext = {}): Promise<RouteOutcome> {
    const deps = this.o.deps;
    const now = deps.now();
    // 1. paused
    if (deps.isPaused()) return "dropped";
    if (context.guildId && (await this.serverPaused(context.guildId))) return "dropped";
    const waifu = await readWaifu(deps.storage, waifuId).catch(() => undefined);
    if (!waifu?.enabled || !waifu.botId) return "dropped";
    // 2. DM rate limit
    if (wake.reason === "dm" && context.dmUserId) {
      const limits = await readDmLimit(deps.storage, context.dmUserId, waifuId);
      const assessment = assessDmLimit(limits.replyTimestamps, waifu.dm.rateLimit, now);
      if (assessment.limited) {
        if (waifu.dm.notifyWhenLimited && limitNoticeDue(assessment, limits.limitNoticeSentAt)) {
          const text = renderLimitNotice(waifu.dm.limitNotice, { name: waifu.name, user: wake.fromName ?? "you", freesAt: assessment.freesAt, now });
          await this.sendAutoNotice(waifu, context.dmUserId, text, (current, messageId) => ({
            ...current,
            limitNoticeSentAt: now.toISOString(),
            autoMessageIds: [...current.autoMessageIds, messageId].slice(-MAX_AUTO_IDS)
          }));
        }
        return "dropped";
      }
    }
    if (wake.reason === "owner") return this.admit(waifuId, wake);
    // 3. per-user wake limit (guilds)
    if (context.guildId && wake.fromUserId && USER_LIMITED.has(wake.reason)) {
      const admitted = await admitUserWake(deps.storage, waifuId, {
        userId: wake.fromUserId,
        name: wake.fromName ?? "someone",
        ...(wake.placeKey ? { placeKey: wake.placeKey } : {}),
        max: deps.config().life.maxWakesPerUserPerHour,
        now
      });
      if (!admitted) return "quiet";
    }
    // 4. bed time (§21.6c): asleep, only her reminders and plans get through (the owner's already did); up late
    // or dozing, what doesn't talk to her waits for the morning unless she was just chatting there.
    const state = await readLifeState(deps.storage, waifuId);
    const availability = await availabilityFor(deps, waifu, now, state);
    if (availability.state === "asleep" && !getsThroughAsleep(wake)) {
      await deferWake(deps.storage, waifuId, wake, "sleep", now);
      if (wake.reason === "dm" && context.dmUserId && waifu.dm.sleepNotice.trim()) await this.maybeSleepNotice(waifu, context.dmUserId, availability.windowStart);
      return "deferred";
    }
    if (availability.bed && availability.bed.phase !== "asleep" && !getsThroughBusy(wake) && !sentRecently(state.recentSends, wake.placeKey, now, deps.config().life.busyEngagedMinutes)) {
      await deferWake(deps.storage, waifuId, wake, "sleep", now);
      return "deferred";
    }
    // 4b. busy (§21.4, S4): in a busy block of her day, what doesn't talk to her waits for her next
    // phone check (else the block's end), unless she is chatting in that place right now.
    if (!getsThroughBusy(wake) && !availability.bed) {
      const busy = busyAt(await dayPlanFor(deps, waifu), now, deps.timeZone);
      if (busy && !placeOpen(state.busyOpen, wake.placeKey, now, busy.end)) {
        await holdWake(deps.storage, waifuId, { ...wake, heldUntil: busy.release.toISOString(), heldFor: busy.why });
        return "held";
      }
    }
    // 5. daily budget
    const budget = waifu.life.dailyBudgetUsd;
    if (budget !== null && budget !== undefined && (await this.o.cost.today(waifuId, now)) >= budget) {
      await deferWake(deps.storage, waifuId, wake, "budget", now);
      return "deferred";
    }
    // 6. room loop guard
    if (wake.waifuAuthored && wake.placeKey) {
      const max = deps.config().life.maxWaifuTriggeredTurns;
      if (!this.loopGuard.allowed(wake.placeKey, max, wake.messageId)) return "dropped";
      if (max > 0) this.loopGuard.count(wake.placeKey, wake.messageId);
    }
    return this.admit(waifuId, wake);
  }

  private async admit(waifuId: string, wake: Wake): Promise<RouteOutcome> {
    await enqueueWake(this.o.deps.storage, waifuId, wake);
    this.o.poke(waifuId);
    return "queued";
  }

  private async maybeSleepNotice(waifu: WaifuConfig, userId: string, windowStart: Date): Promise<void> {
    const limits = await readDmLimit(this.o.deps.storage, userId, waifu.id);
    const window = windowStart.toISOString();
    if (limits.sleepNoticeSentFor === window) return;
    await this.sendAutoNotice(waifu, userId, waifu.dm.sleepNotice.trim().slice(0, 300), (current, messageId) => ({
      ...current,
      sleepNoticeSentFor: window,
      autoMessageIds: [...current.autoMessageIds, messageId].slice(-MAX_AUTO_IDS)
    }));
  }

  /** A fixed automatic DM (no model call, not counted by the rate limit), rendered `[auto] …` for her. */
  private async sendAutoNotice(
    waifu: WaifuConfig,
    userId: string,
    text: string,
    record: (current: Awaited<ReturnType<typeof readDmLimit>>, messageId: string) => Awaited<ReturnType<typeof readDmLimit>>
  ): Promise<void> {
    const deps = this.o.deps;
    const discord = deps.discord();
    if (!discord?.sendDirectMessage || !text) return;
    try {
      const { messageId } = await discord.sendDirectMessage({ waifuId: waifu.id, userId, content: text });
      await updateDmLimit(deps.storage, userId, waifu.id, (current) => record(current, messageId));
      await assignConversationRefs(deps.storage, `dm_${userId}_${waifu.id}` as never, [messageId], deps.now()).catch(() => undefined);
      deps.logger.info("Life automatic DM notice sent", { category: "life", waifuId: waifu.id });
    } catch (error) {
      deps.logger.warn("Life automatic DM notice failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
