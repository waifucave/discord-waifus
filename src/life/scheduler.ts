// The scheduler (Living cast spec §4.5, §7.3, §5.7, §16.4–§16.6, §16.9): her reminders and watch
// timeouts (from her own files), the `morning` batch when her sleep (or budget pause) ends, nightly
// maintenance and pending scrubs, `~/places.md` and `/tmp` expiry.
//
// One periodic tick (default every 15 s) checks every enabled waifu:
// - due reminders in `~/schedule.json` fire once (through the router, so one due while she sleeps
//   is deferred to her morning); repeating ones move to their next local occurrence. Late reminders
//   after downtime fire once on the first tick.
// - a watch whose timeout passed is removed from `~/watches.json` and she is told it timed out (a
//   `watch_timeout` wake, so an empty watch works as a timer).
// - `~/places.md` is rewritten when it would change, at most once a minute; `/tmp` files older than
//   `life.tmp.retentionDays` go at the first tick and hourly after.
// - deferred wakes become one `morning` notification once she is awake (or, for the budget pause,
//   once her new local day starts under budget).
// - maintenance: 30 minutes into her sleep window, or at `life.maintenanceHourLocal` without one;
//   it takes her life lock, so it never overlaps a turn. Pending scrubs run with it.

import { listWaifus } from "../orchestration/stores/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { Wake, WakeQueue } from "../shared/schemas/life.js";
import type { DailyCost } from "./budget.js";
import { availabilityAt, instantOfLocal, localParts, parseLocalDateTime, sleepWindowContaining } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { readLifeFile, readLifeState, updateLifeState } from "./lifeStore.js";
import { checkEnvFor, homeStoreFor, refreshPlacesFile } from "./home/index.js";
import { onceKey, type ReminderEntry, type WatchEntry } from "./home/specialFiles.js";
import { morningBatch, type MorningPlace } from "./notifications.js";
import { lifeLocks } from "./paths.js";
import { collectPlaces, handleOf } from "./places.js";
import type { KeyedMutex } from "./sync.js";
import { deferForBudget, hasDeferred, newWakeId, takeDeferred } from "./wakeQueue.js";
import type { WakeRouter } from "./wakeRouter.js";
import { parseConversationKey } from "../orchestration/context/keys.js";
import { selfAuthorIds } from "./people.js";

export const DEFAULT_TICK_MS = 15_000;
export const MAINTENANCE_DELAY_INTO_SLEEP_MS = 30 * 60_000;
/** `~/places.md` is rewritten at most this often (§16.6; also at every turn start). */
export const PLACES_REFRESH_MS = 60_000;
/** `/tmp` expiry runs at the first tick and then this often (§16.9). */
export const TMP_SWEEP_MS = 3_600_000;

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

/** One wake id per reminder occurrence (its id and local due time). */
export function reminderWakeId(reminder: Pick<ReminderEntry, "id" | "at">, timeZone: string): string {
  const due = parseLocalDateTime(reminder.at, timeZone)?.getTime() ?? 0;
  return `w-reminder-${reminder.id}-${due.toString(36)}`;
}

/** One wake id per watch timeout (its id and local timeout). */
export function watchTimeoutWakeId(watch: Pick<WatchEntry, "id" | "timeout">, timeZone: string): string {
  const ends = parseLocalDateTime(watch.timeout, timeZone)?.getTime() ?? 0;
  return `w-timeout-${watch.id}-${ends.toString(36)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The next local occurrence of a repeating reminder after `now` (same local time, next day or week). */
export function nextOccurrence(reminder: Pick<ReminderEntry, "at" | "repeat">, now: Date, timeZone: string): string | undefined {
  if (!reminder.repeat) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(reminder.at);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const step = reminder.repeat === "daily" ? 1 : 7;
  for (let n = 1; n <= 400; n += 1) {
    const date = new Date(Date.UTC(year, month - 1, day + n * step));
    const text = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${match[4]}:${match[5]}`;
    const at = parseLocalDateTime(text, timeZone);
    if (at && at.getTime() > now.getTime()) return text;
  }
  return undefined;
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
  /** Per waifu: when `~/places.md` and `/tmp` were last looked after (in memory: a restart does both again). */
  private readonly placesAt = new Map<string, number>();
  private readonly tmpAt = new Map<string, number>();
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
        await this.watchTimeouts(waifu);
        await this.morning(waifu);
        await this.maintenance(waifu);
        await this.housekeeping(waifu);
      } catch (error) {
        deps.logger.warn("Life scheduler tick failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Due reminders are routed first, under a wake id made from the reminder and its due time, and
   * only then removed from her file (or moved to their next occurrence): a crash in between routes
   * the same wake again, which the queue does not add twice (review M4). The fired list keeps a file
   * the app cannot rewrite (she broke it by hand outside the app) from firing it at every tick.
   */
  private async reminders(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const now = deps.now();
    const store = homeStoreFor(deps, waifu);
    const entries = await store.readSchedule(deps.timeZone);
    const ids = await store.readScheduleIds();
    const fired = new Set(ids.fired);
    const due = entries.filter((entry) => (parseLocalDateTime(entry.at, deps.timeZone)?.getTime() ?? Infinity) <= now.getTime());
    if (due.length === 0) return;
    // An occurrence already routed (a crash before its removal) is removed now, never routed again.
    // After the fired list was lost (a corrupt side file, kept aside), an occurrence due before the
    // loss may have fired already: it is removed without firing rather than risk a second wake.
    const lostBefore = ids.recoveredAt ? Date.parse(ids.recoveredAt) : undefined;
    const fresh = due.filter(
      (reminder) =>
        !fired.has(reminderWakeId(reminder, deps.timeZone)) &&
        !(lostBefore !== undefined && parseLocalDateTime(reminder.at, deps.timeZone)!.getTime() <= lostBefore)
    );
    for (const reminder of fresh) {
      const at = parseLocalDateTime(reminder.at, deps.timeZone)!;
      const wake: Wake = { id: reminderWakeId(reminder, deps.timeZone), reason: "reminder", note: reminder.note, at: at.toISOString() };
      await this.o.router.route(waifu.id, wake);
    }
    if (fresh.length > 0) await store.markFired("schedule", fresh.map((reminder) => reminderWakeId(reminder, deps.timeZone)));
    const done = new Set(due.map((reminder) => `${reminder.id}\0${reminder.at}`));
    await store.rewriteSchedule(deps.timeZone, (current) =>
      current.flatMap((reminder): ReminderEntry[] => {
        if (!done.has(`${reminder.id}\0${reminder.at}`)) return [reminder];
        const next = nextOccurrence(reminder, now, deps.timeZone);
        return next ? [{ ...reminder, at: next }] : [];
      })
    );
  }

  /** A watch whose timeout passed (§16.5): routed as `watch_timeout`, then removed from her file. */
  private async watchTimeouts(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const now = deps.now();
    const store = homeStoreFor(deps, waifu);
    const { entries, ids } = await store.readWatches(deps.timeZone);
    const fired = new Set(ids.fired);
    const due = entries.filter((entry) => (parseLocalDateTime(entry.timeout, deps.timeZone)?.getTime() ?? Infinity) <= now.getTime());
    if (due.length === 0) return;
    // A once watch that already matched never also times out; after a lost fired list (see reminders)
    // a timeout due before the loss is dropped without a wake.
    const lostBefore = ids.recoveredAt ? Date.parse(ids.recoveredAt) : undefined;
    const fresh = due.filter(
      (watch) =>
        !fired.has(watchTimeoutWakeId(watch, deps.timeZone)) &&
        !fired.has(onceKey(watch)) &&
        !(lostBefore !== undefined && parseLocalDateTime(watch.timeout, deps.timeZone)!.getTime() <= lostBefore)
    );
    for (const watch of fresh) {
      const at = parseLocalDateTime(watch.timeout, deps.timeZone)!;
      await this.o.router.route(waifu.id, { id: watchTimeoutWakeId(watch, deps.timeZone), reason: "watch_timeout", watchId: watch.id, note: watch.note, at: at.toISOString() });
    }
    if (fresh.length > 0) await store.markFired("watches", fresh.map((watch) => watchTimeoutWakeId(watch, deps.timeZone)));
    const gone = new Set(due.map((watch) => `${watch.id}\0${watch.timeout}`));
    await store.rewriteWatches(deps.timeZone, (current, side) => {
      const watches = { ...side.watches };
      const kept = current.filter((watch) => {
        if (!gone.has(`${watch.id}\0${watch.timeout}`)) return true;
        delete watches[watch.id];
        return false;
      });
      return { entries: kept, ids: { ...side, watches } };
    });
  }

  /**
   * `~/places.md` (at most once a minute), `/tmp` expiry (first tick, then hourly), and her watch
   * file's resolutions when someone changed it outside the app.
   */
  private async housekeeping(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const nowMs = deps.now().getTime();
    if (nowMs - (this.placesAt.get(waifu.id) ?? -Infinity) >= PLACES_REFRESH_MS) {
      this.placesAt.set(waifu.id, nowMs);
      await refreshPlacesFile(deps, waifu);
      await homeStoreFor(deps, waifu).writeProfileFromConfig();
      await homeStoreFor(deps, waifu).resyncWatches(checkEnvFor(deps, waifu.id));
    }
    if (nowMs - (this.tmpAt.get(waifu.id) ?? -Infinity) >= TMP_SWEEP_MS) {
      this.tmpAt.set(waifu.id, nowMs);
      const removed = await homeStoreFor(deps, waifu).expireTmp(deps.now(), deps.config().life.tmp.retentionDays);
      if (removed > 0) deps.logger.info("Life /tmp files expired", { category: "life", waifuId: waifu.id, removed });
    }
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
