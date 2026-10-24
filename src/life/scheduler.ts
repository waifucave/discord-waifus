// The scheduler (Living cast spec §4.5, §6.5, §6.6, §7.3, §5.7): her reminders, watch expiry, the
// `morning` batch when her sleep (or budget pause) ends, nightly maintenance and pending scrubs.
//
// One periodic tick (default every 15 s) checks every enabled waifu:
// - due reminders fire once (through the router, so one due while she sleeps is deferred to her
//   morning); repeating ones move to their next future occurrence. Late reminders after downtime
//   fire once on the first tick.
// - expired watches are removed silently.
// - deferred wakes become one `morning` notification once she is awake (or, for the budget pause,
//   once her new local day starts under budget).
// - maintenance: 30 minutes into her sleep window, or at `life.maintenanceHourLocal` without one;
//   it takes her life lock, so it never overlaps a turn. Pending scrubs run with it.

import { listWaifus } from "../orchestration/stores/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { Reminder, Wake, WakeQueue } from "../shared/schemas/life.js";
import type { DailyCost } from "./budget.js";
import { availabilityAt, instantOfLocal, localParts, sleepWindowContaining } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { readLifeFile, readLifeState, updateLifeFile, updateLifeState } from "./lifeStore.js";
import { morningBatch, type MorningPlace } from "./notifications.js";
import { lifeLocks } from "./paths.js";
import { collectPlaces, handleOf } from "./places.js";
import type { KeyedMutex } from "./sync.js";
import { pruneExpiredWatches } from "./watches.js";
import { deferForBudget, hasDeferred, newWakeId, takeDeferred } from "./wakeQueue.js";
import type { WakeRouter } from "./wakeRouter.js";
import { parseConversationKey } from "../orchestration/context/keys.js";
import { selfAuthorIds } from "./people.js";

export const DEFAULT_TICK_MS = 15_000;
export const MAINTENANCE_DELAY_INTO_SLEEP_MS = 30 * 60_000;
const DAY_MS = 24 * 3_600_000;

export type SchedulerHooks = {
  poke(waifuId: string): void;
  /** Runs maintenance (and pending scrubs) for her under her life lock; `signal` aborts it. */
  maintain(waifu: WaifuConfig, signal: AbortSignal): Promise<void>;
  /** A lease of busy work for the idle updater; undefined while the app is sealed for an update. */
  begin?(): (() => void) | undefined;
};

/**
 * Maintenance running anywhere in this process, by data root and waifu: a reload's new scheduler
 * never starts one while the old one's is still finishing (review M3).
 */
const RUNNING_MAINTENANCE = new Map<string, Promise<void>>();

/** One wake id per reminder occurrence (its id and due time). */
export function reminderWakeId(reminder: Pick<Reminder, "id" | "dueAt">): string {
  return `w-reminder-${reminder.id}-${Date.parse(reminder.dueAt).toString(36)}`;
}

/** The next future occurrence of a repeating reminder. */
export function nextOccurrence(reminder: Reminder, now: Date): string | undefined {
  if (!reminder.repeat) return undefined;
  const step = reminder.repeat === "daily" ? DAY_MS : 7 * DAY_MS;
  let due = Date.parse(reminder.dueAt);
  while (due <= now.getTime()) due += step;
  return new Date(due).toISOString();
}

/** When her maintenance is due next after `lastAt` (the start of the window it belongs to). */
export function maintenanceDue(waifu: WaifuConfig, now: Date, timeZone: string, hourLocal: number, lastAt: string | undefined): boolean {
  const last = lastAt ? Date.parse(lastAt) : 0;
  if (waifu.availability.sleep.enabled) {
    const window = sleepWindowContaining(waifu.availability, now, timeZone);
    if (!window) return false;
    const at = window.start.getTime() + MAINTENANCE_DELAY_INTO_SLEEP_MS;
    return now.getTime() >= at && now.getTime() < window.end.getTime() && last < window.start.getTime();
  }
  const p = localParts(now, timeZone);
  const at = instantOfLocal(timeZone, p.year, p.month, p.day, hourLocal, 0).getTime();
  return now.getTime() >= at && last < at;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  /** Maintenance runs in the background (a tick never waits for one): abortable, awaited by stop(). */
  private readonly maintenanceRuns = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly o: {
      deps: LifeDeps;
      router: WakeRouter;
      cost: DailyCost;
      mutex: KeyedMutex;
      hooks: SchedulerHooks;
      tickMs?: number;
    }
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick({ waitForMaintenance: false }), this.o.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref?.();
  }

  /** Stops the timer, aborts running maintenance and waits for it to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abortMaintenance();
    await this.settle();
  }

  /** After stop() no maintenance starts (a tick already under way may still reach it). */
  private stopped = false;

  /** Pause: running maintenance is aborted (it runs again at its next window). */
  abortMaintenance(): void {
    for (const run of this.maintenanceRuns.values()) run.controller.abort(new Error("stop"));
  }

  /** Waits for the maintenance runs started so far. */
  async settle(): Promise<void> {
    while (this.maintenanceRuns.size > 0) await Promise.allSettled([...this.maintenanceRuns.values()].map((run) => run.done));
  }

  /**
   * One pass. Overlapping ticks join the running one. The periodic tick never waits for the
   * maintenance it starts; a direct call (tests) does unless told not to.
   */
  async tick(o: { waitForMaintenance?: boolean } = {}): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = undefined;
    });
    await this.ticking;
    if (o.waitForMaintenance !== false) await this.settle();
  }

  private async runTick(): Promise<void> {
    const deps = this.o.deps;
    if (deps.isPaused()) return;
    const waifus = (await listWaifus(deps.storage).catch(() => [])).filter((waifu) => waifu.enabled);
    for (const waifu of waifus) {
      try {
        await this.reminders(waifu);
        await pruneExpiredWatches(deps.storage, waifu.id, deps.now());
        await this.morning(waifu);
        await this.maintenance(waifu);
      } catch (error) {
        deps.logger.warn("Life scheduler tick failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Due reminders are routed first, under a wake id made from the reminder and its due time, and
   * only then removed (or moved to their next occurrence): a crash in between routes the same wake
   * again, which the queue does not add twice (review M4).
   */
  private async reminders(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const now = deps.now();
    const file = await readLifeFile(deps.storage, waifu.id, "schedule");
    const due = file.reminders.filter((reminder) => Date.parse(reminder.dueAt) <= now.getTime());
    if (due.length === 0) return;
    for (const reminder of due) {
      const wake: Wake = { id: reminderWakeId(reminder), reason: "reminder", note: reminder.note, setAt: reminder.createdAt, at: reminder.dueAt };
      await this.o.router.route(waifu.id, wake);
    }
    const fired = new Set(due.map((reminder) => `${reminder.id}\0${reminder.dueAt}`));
    await updateLifeFile(deps.storage, waifu.id, "schedule", (current) => ({
      ...current,
      reminders: current.reminders.flatMap((reminder): Reminder[] => {
        if (!fired.has(`${reminder.id}\0${reminder.dueAt}`)) return [reminder];
        const next = nextOccurrence(reminder, now);
        return next ? [{ ...reminder, dueAt: next }] : [];
      })
    }));
  }

  /** Deferred wakes → one `morning` wake when she is awake (and, for a budget pause, under budget again). */
  private async morning(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const now = deps.now();
    const queue = await readLifeFile(deps.storage, waifu.id, "wakes");
    if (!hasDeferred(queue) && !queue.deferred.reason) return;
    const availability = availabilityAt(waifu.availability, now, deps.timeZone);
    if (availability.state === "asleep") return;
    // Never released over her daily budget, whatever deferred it: a batch held for sleep that she
    // wakes up to over budget waits for her next local day instead.
    const budget = waifu.life.dailyBudgetUsd;
    if (budget !== null && budget !== undefined && (await this.o.cost.today(waifu.id, now)) >= budget) {
      if (queue.deferred.reason !== "budget") await deferForBudget(deps.storage, waifu.id);
      return;
    }
    const places = await this.morningPlaces(waifu, queue.deferred);
    const handles = new Map<string, string>();
    for (const key of [...places.map((place) => place.placeKey), ...queue.deferred.items.flatMap((item) => (item.placeKey ? [item.placeKey] : []))]) {
      handles.set(key, await handleOf(deps.storage, waifu.id, key));
    }
    const view = { timeZone: deps.timeZone, handle: (key: string) => handles.get(key) ?? key, unread: () => undefined };
    const released = await takeDeferred(deps.storage, waifu.id, (deferred) => {
      const since = deferred.since ? new Date(deferred.since) : now;
      const sleep = waifu.availability.sleep;
      const header =
        deferred.reason === "budget"
          ? morningBatch({ reason: "budget", since, until: now, places, items: deferred.items }, view)
          : morningBatch({ reason: "sleep", since, until: now, places, items: deferred.items }, view).map((line, index) =>
              index === 0 && sleep.enabled ? `- while you were asleep (${sleep.start}–${sleep.end}):` : line
            );
      if (header.length <= 1) return undefined;
      return { id: newWakeId(), reason: "morning", batch: header, at: now.toISOString() };
    });
    if (released) {
      deps.logger.info("Life morning batch queued", { category: "life", waifuId: waifu.id, lines: released.batch?.length ?? 0 });
      this.o.hooks.poke(waifu.id);
    }
  }

  /** Per place: mentions from the deferred counters, messages counted from the conversation cache since the pause began. */
  private async morningPlaces(waifu: WaifuConfig, deferred: WakeQueue["deferred"]): Promise<MorningPlace[]> {
    const deps = this.o.deps;
    const since = deferred.since ? Date.parse(deferred.since) : deps.now().getTime();
    const self = new Set(await selfAuthorIds(deps.storage, waifu));
    const out: MorningPlace[] = [];
    const places = await collectPlaces(deps.storage, waifu.id);
    const keys = new Set([...Object.keys(deferred.places), ...places.filter((place) => place.kind !== "dm").map((place) => place.placeKey)]);
    for (const key of keys) {
      const ref = parseConversationKey(key);
      if (!ref) continue;
      const counters = deferred.places[key];
      const messages = deps.conversations.bufferedMessages(ref).filter((message) => !self.has(message.authorId) && Date.parse(message.createdAt) >= since).length;
      const place = places.find((candidate) => candidate.placeKey === key);
      if (ref.kind === "dm") {
        const count = Math.max(counters?.dms ?? 0, messages);
        if (count > 0) out.push({ placeKey: key, kind: "dm", ...(place?.userName ? { name: place.userName } : {}), mentions: 0, messages: count });
        continue;
      }
      const mentions = counters?.mentions ?? 0;
      const total = Math.max(messages, mentions + (counters?.detector ?? 0));
      if (mentions > 0 || total > 0) out.push({ placeKey: key, kind: place?.kind ?? "room", mentions, messages: total });
    }
    return out;
  }

  /** Starts her maintenance in the background when it is due (one per waifu in the whole process). */
  private async maintenance(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const key = `${deps.storage.dataRoot}\0${waifu.id}`;
    if (this.maintenanceRuns.has(waifu.id) || RUNNING_MAINTENANCE.has(key)) return;
    const state = await readLifeState(deps.storage, waifu.id);
    const due = maintenanceDue(waifu, deps.now(), deps.timeZone, deps.config().life.maintenanceHourLocal, state.lastMaintenanceAt);
    if (!due || this.stopped || this.maintenanceRuns.has(waifu.id) || RUNNING_MAINTENANCE.has(key)) return;
    const lease = this.o.hooks.begin?.();
    if (this.o.hooks.begin && !lease) return;
    const controller = new AbortController();
    const done = (async () => {
      try {
        // Aborted while it waited for her life lock (stop, pause, reload): it never starts (N1).
        await this.o.mutex.run(lifeLocks.life(waifu.id), async () => {
          if (!controller.signal.aborted) await this.o.hooks.maintain(waifu, controller.signal);
        });
        // An aborted run (pause, shutdown, reload) runs again at its next chance.
        if (!controller.signal.aborted) await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, lastMaintenanceAt: deps.now().toISOString() }));
      } catch (error) {
        deps.logger.warn("Life maintenance failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
      } finally {
        lease?.();
        this.maintenanceRuns.delete(waifu.id);
        RUNNING_MAINTENANCE.delete(key);
      }
    })();
    this.maintenanceRuns.set(waifu.id, { controller, done });
    RUNNING_MAINTENANCE.set(key, done);
  }
}
