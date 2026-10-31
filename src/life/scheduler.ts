// The scheduler (Living cast spec §7.3, §5.7, §16.6, §16.9, §30, §38): her timed wakeups, the ends of
// her watches and pages, and her pages' checks (from `~/life/wakeups.json`), the batch of what waited
// while she was over her daily budget, daily maintenance (dreaming) with pending scrubs,
// `~/life/places.md` and `/tmp` expiry.
//
// One periodic tick (default every 15 s) checks every enabled waifu:
// - her timed wakeups in `~/life/wakeups.json` fire once per occurrence as `reminder` wakes (through
//   the router): an `at` is then removed, an `every` counts on from that time. Late ones after
//   downtime fire once on the first tick.
// - a watch or page whose `until` passed is removed and she is told it ended (a `watch_timeout`
//   wake); a page due a check is fetched (no model call) and checked (§30.2); her code's state is
//   saved into her file at most once a minute.
// - deferred wakes become one `morning` notification (the batch; the reason kept its name) once she
//   is under her daily budget again. A queue saved before §38 may hold wakes deferred for her bed
//   time or held for her busy blocks: the first tick releases them (the held ones as ordinary wakes).
// - `~/life/places.md` is rewritten when it would change, at most once a minute; `/tmp` files older
//   than `life.tmp.retentionDays` go at the first tick and hourly after.
// - maintenance: once a day at `life.maintenanceHourLocal`; it takes her life lock, so it never
//   overlaps a turn. Pending scrubs run with it.
// - the quiet-time rest (§25): with a large context, no turn running or queued, shortly before her
//   prompt cache expires, her life is poked; the life loop runs the rest turn (`cacheRest.ts`).

import { listWaifus } from "../orchestration/stores/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { Wake, WakeQueue } from "../shared/schemas/life.js";
import type { DailyCost } from "./budget.js";
import { instantOfLocal, localParts } from "./clock.js";
import { cacheRestDueFor } from "./cacheRest.js";
import type { LifeDeps } from "./deps.js";
import { readLifeFile, readLifeState, updateLifeState } from "./lifeStore.js";
import { checkEnvFor, homeStoreFor, refreshPlacesFile } from "./home/index.js";
import { checkPages, type PageFetch } from "./wakeups/run.js";
import { dueHeldMatches, dueTimed, endedWakeups, endWake, heldWake, saveWakeupStates, timedWake, type HeldMatch } from "./wakeups/schedule.js";
import { readTranscriptDay, transcriptDay } from "./transcripts/store.js";
import { previewText } from "./notifications.js";
import { parseDuration } from "./wakeups/when.js";
import { sharedSandbox } from "./sandbox/index.js";
import { morningBatch, type MorningLine, type MorningPlace, type NotificationView } from "./notifications.js";
import { lifeLocks } from "./paths.js";
import { collectPlaces, handleOf } from "./places.js";
import type { KeyedMutex } from "./sync.js";
import { deferForBudget, hasDeferred, newWakeId, releaseLegacyHeld, takeDeferred } from "./wakeQueue.js";
import type { WakeRouter } from "./wakeRouter.js";
import { parseConversationKey } from "../orchestration/context/keys.js";
import { forgottenPeople, isRemovedMessage, selfAuthorIds } from "./people.js";
import { readDmFloor } from "../orchestration/dm/dmStore.js";
import { wakeShowsDm } from "./lifeView.js";
import { refsForMessages } from "./messageRefs.js";
import { messagesOf } from "./wakeMessages.js";
import { unansweredForWakes } from "./unanswered.js";
import { snowflakeTime } from "../discord/refStore.js";
import { compareIds } from "../discord/rawMessage.js";

export const DEFAULT_TICK_MS = 15_000;
/** `~/places.md` is rewritten at most this often (§16.6; also at every turn start). */
export const PLACES_REFRESH_MS = 60_000;
/** `/tmp` expiry runs at the first tick and then this often (§16.9). */
export const TMP_SWEEP_MS = 3_600_000;

export type SchedulerHooks = {
  poke(waifuId: string): void;
  /** Runs maintenance (pending scrubs, then the dream) under her life lock; `signal` aborts it. */
  maintain(waifu: WaifuConfig, signal: AbortSignal): Promise<void>;
  /** A lease of busy work for the idle updater; undefined while the app is sealed for an update. */
  begin?(): (() => void) | undefined;
};

/**
 * Maintenance running anywhere in this process, by data root and waifu: a reload's new scheduler
 * never starts one while the old one's is still finishing (review M3).
 */
const RUNNING_MAINTENANCE = new Map<string, Promise<void>>();

export { timedWakeId, endWakeId } from "./wakeups/schedule.js";

/** Whether her daily maintenance is due (`lastAt`: her last one): at `hourLocal` every local day (§38). */
export function maintenanceDue(now: Date, timeZone: string, hourLocal: number, lastAt: string | undefined): boolean {
  const last = lastAt ? Date.parse(lastAt) : 0;
  const p = localParts(now, timeZone);
  const at = instantOfLocal(timeZone, p.year, p.month, p.day, hourLocal, 0).getTime();
  return now.getTime() >= at && last < at;
}

/** How many times the batch is built in one tick when a wake was deferred while it was built (then the next tick tries). */
const BATCH_BUILD_ATTEMPTS = 5;
/** A room's batch may start this much before the pause: the hold of the burst that began it (§4.2: 60 s at most, typing aside). */
const BATCH_LEAD_MS = 10 * 60_000;

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
      // Each step on its own: one that fails (her wakeups' code, a file) never skips the others.
      const steps: Array<[string, () => Promise<void>]> = [
        ["wakeups", () => this.wakeups(waifu)],
        ["held", () => this.releaseHeld(waifu)],
        ["deferred", () => this.releaseDeferred(waifu)],
        ["maintenance", () => this.maintenance(waifu)],
        ["cacheRest", () => this.cacheRest(waifu)],
        ["housekeeping", () => this.housekeeping(waifu)]
      ];
      for (const [step, runStep] of steps) {
        try {
          await runStep();
        } catch (error) {
          deps.logger.warn("Life scheduler tick failed", { waifuId: waifu.id, step, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  /**
   * Her wakeups (§30.2): due timed ones are routed (`reminder`) under a wake id made from the wakeup
   * and its time, recorded as routed, and only then removed (`at`) or counted on from (`every`): a
   * crash in between routes the same wake again, which the queue does not add twice (review M4).
   * Watches and pages that ended are routed (`watch_timeout`) and removed the same way. Pages due a
   * check are fetched and checked; her code's waiting state is saved at most once a minute.
   */
  private async wakeups(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const now = deps.now();
    const store = homeStoreFor(deps, waifu);
    const { entries, side } = await store.readWakeups();
    if (entries.length > 0) {
      const timed = dueTimed(entries, side, now, deps.timeZone);
      const ended = endedWakeups(entries, side, now, deps.timeZone);
      for (const item of timed.fresh) await this.o.router.route(waifu.id, timedWake(item));
      for (const item of ended) if (item.route) await this.o.router.route(waifu.id, endWake(item, side));
      const routed = [...timed.fresh.map((item) => item.wakeId), ...ended.filter((item) => item.route).map((item) => item.wakeId)];
      await store.markWakeupsFired(routed);
      const gone = new Set([...timed.done, ...ended.map((item) => item.entry.id)]);
      const counted = new Map(timed.fresh.filter((item) => item.entry.kind === "every").map((item) => [item.entry.id, item.due.toISOString()] as const));
      const startCounting = entries.filter((entry) => entry.kind === "every" && side.every[entry.id]?.when !== entry.when);
      if (gone.size > 0 || counted.size > 0 || startCounting.length > 0) {
        await store.rewriteWakeups((current, currentSide) => {
          const every = { ...currentSide.every };
          for (const entry of current) {
            if (entry.kind !== "every") continue;
            const at = counted.get(entry.id);
            // An `every` counts on from the occurrence it fired; one the side file lacks (edited on disk) starts now.
            if (at && every[entry.id]?.when === entry.when) every[entry.id] = { when: entry.when!, since: at };
            else if (every[entry.id]?.when !== entry.when) every[entry.id] = { when: entry.when!, since: now.toISOString() };
          }
          const watches = { ...currentSide.watches };
          const pages = { ...currentSide.pages };
          const kept = current.filter((entry) => {
            if (!gone.has(entry.id)) return true;
            const original = entries.find((candidate) => candidate.id === entry.id);
            // Only the same wakeup (her edit in between keeps hers).
            if (JSON.stringify(original?.when) !== JSON.stringify(entry.when) || JSON.stringify(original?.options) !== JSON.stringify(entry.options)) return true;
            delete watches[entry.id];
            delete pages[entry.id];
            return false;
          });
          return { entries: kept, side: { ...currentSide, every, watches, pages } };
        });
      }
      await this.releaseHeldMatches(waifu, store, entries, side, now);
      const fetchPage = this.pageFetch();
      if (fetchPage && entries.some((entry) => entry.kind === "page")) {
        // Her pages on their own: one that fails never stops her timed wakeups or her saved state.
        try {
          const wakes = await checkPages({
            store,
            sandbox: sharedSandbox(),
            now,
            timeZone: deps.timeZone,
            fetch: fetchPage,
            everyMs: (entry) => {
              const every = parseDuration(entry.options?.every);
              return every.ok ? every.value : undefined;
            }
          });
          for (const wake of wakes) await this.o.router.route(waifu.id, wake);
        } catch (error) {
          deps.logger.warn("Life page check failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const { errorWakes } = await saveWakeupStates(store, now.getTime());
    for (const wake of errorWakes) await this.o.router.route(waifu.id, wake);
  }

  /**
   * Room matches a repeating watch's 10-minute spacing held back (§30.2): once the spacing allows,
   * each fires as a watch wake, its message read from the transcript (a message that is gone, deleted
   * or forgotten, fires nothing). When she has written in that place since the message, she has been
   * there: nothing fires. Either way the match is cleared; a fire counts against the spacing and cap.
   */
  private async releaseHeldMatches(
    waifu: WaifuConfig,
    store: ReturnType<typeof homeStoreFor>,
    entries: Parameters<typeof dueHeldMatches>[0],
    side: Parameters<typeof dueHeldMatches>[1],
    now: Date
  ): Promise<void> {
    const deps = this.o.deps;
    const due = dueHeldMatches(entries, side, now, deps.timeZone, deps.config().life.maxWatchFiresPerDay);
    if (due.length === 0) return;
    const state = await readLifeState(deps.storage, waifu.id).catch(() => undefined);
    const done: Array<{ id: string; messageId: string; fired: boolean }> = [];
    for (const { entry, held } of due) {
      const sent = state?.recentSends?.[held.placeKey];
      const message = sent !== undefined && Date.parse(sent) > Date.parse(held.at) ? undefined : await this.heldMessage(held);
      const ref = parseConversationKey(held.placeKey);
      if (message) await this.o.router.route(waifu.id, heldWake(entry, held, message), ref?.kind === "guild" ? { guildId: ref.guildId } : {});
      done.push({ id: entry.id, messageId: held.messageId, fired: message !== undefined });
    }
    await store.rewriteWakeups((current, currentSide) => {
      const watches = { ...currentSide.watches };
      for (const item of done) {
        const watch = watches[item.id];
        // Only the match it fired: a newer one held meanwhile stays for the next tick.
        if (watch?.held?.messageId !== item.messageId) continue;
        const { held: _held, ...rest } = watch;
        watches[item.id] = item.fired ? { ...rest, fires: [...rest.fires, now.toISOString()] } : rest;
      }
      return { entries: current, side: { ...currentSide, watches } };
    });
  }

  /** A held match's message as her transcript has it, or nothing when it is gone. */
  private async heldMessage(held: HeldMatch): Promise<{ fromName: string; preview: string } | undefined> {
    const deps = this.o.deps;
    const lines = await readTranscriptDay(deps.storage.dataRoot, held.placeKey, transcriptDay(held.at, deps.timeZone)).catch(() => []);
    const line = lines.find((candidate) => candidate.id === held.messageId);
    return line ? { fromName: line.author, preview: previewText(line.text, line.files?.length ?? 0) } : undefined;
  }

  /** Her pages' fetch (§30.2): the SSRF-checked fetcher, no model call; none without the web tools. */
  private pageFetch(): PageFetch | undefined {
    const web = this.o.deps.web;
    // The owner's "no page fetching" (a 0 cap) holds for her pages too.
    return web && web.fetchOffered() ? (url) => web.fetchForWakeup(url) : undefined;
  }

  /** She has been quiet with a large context and her prompt cache is about to expire (§25): her life runs the rest turn. */
  private async cacheRest(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const state = await readLifeState(deps.storage, waifu.id);
    if (await cacheRestDueFor(deps, waifu, state, { spentToday: (waifuId, now) => this.o.cost.today(waifuId, now) })) this.o.hooks.poke(waifu.id);
  }

  /**
   * `~/places.md` (at most once a minute), `/tmp` expiry (first tick, then hourly), and her wakeups
   * file's resolutions when someone changed it outside the app.
   */
  private async housekeeping(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const nowMs = deps.now().getTime();
    if (nowMs - (this.placesAt.get(waifu.id) ?? -Infinity) >= PLACES_REFRESH_MS) {
      this.placesAt.set(waifu.id, nowMs);
      await refreshPlacesFile(deps, waifu);
      await homeStoreFor(deps, waifu).writeProfileFromConfig();
      await homeStoreFor(deps, waifu).resyncWakeups(checkEnvFor(deps, waifu.id));
    }
    if (nowMs - (this.tmpAt.get(waifu.id) ?? -Infinity) >= TMP_SWEEP_MS) {
      this.tmpAt.set(waifu.id, nowMs);
      const removed = await homeStoreFor(deps, waifu).expireTmp(deps.now(), deps.config().life.tmp.retentionDays);
      if (removed > 0) deps.logger.info("Life /tmp files expired", { category: "life", waifuId: waifu.id, removed });
    }
  }

  /** Wakes a queue saved before §38 held for her busy blocks come back as ordinary wakes. */
  private async releaseHeld(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const count = await releaseLegacyHeld(deps.storage, waifu.id);
    if (count > 0) {
      deps.logger.info("Life held wakes released after the upgrade", { category: "life", waifuId: waifu.id, count });
      this.o.hooks.poke(waifu.id);
    }
  }

  /**
   * What waited for her (§4.4 guard 5) becomes one `morning` wake, the batch, once she is under her
   * daily budget again (her next local day). A queue saved before §38 may hold a batch deferred for
   * her bed time (no reason any more): it is released at the first tick, unless she is over budget,
   * when it waits for her budget like the rest.
   */
  private async releaseDeferred(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const now = deps.now();
    const queue = await readLifeFile(deps.storage, waifu.id, "wakes");
    if (!hasDeferred(queue) && !queue.deferred.reason) return;
    const budget = waifu.life.dailyBudgetUsd;
    if (budget !== null && budget !== undefined && (await this.o.cost.today(waifu.id, now)) >= budget) {
      if (queue.deferred.reason !== "budget" && hasDeferred(queue)) await deferForBudget(deps.storage, waifu.id);
      return;
    }
    const linesPerPlace = deps.config().life.notificationLinesPerPlace;
    // The batch is built from the deferred wakes as read, then taken only if they are still exactly
    // those (a wake deferred meanwhile would lose its lines): otherwise it is built again.
    let released: Wake | undefined;
    for (let attempt = 0, deferred = queue.deferred; ; attempt += 1) {
      const built = await this.batchView(waifu, deferred, now);
      const toWake = (locked: WakeQueue["deferred"]): Wake | undefined => {
        const since = locked.since ? new Date(locked.since) : now;
        const lines = morningBatch({ since, until: now, places: built.places, items: built.items, linesPerPlace }, built.view);
        if (lines.length <= 1) return undefined;
        // D14: a batch showing anything from a DM makes her turn a DM turn.
        return { id: newWakeId(), reason: "morning", batch: lines, ...(built.dm ? { dm: true } : {}), at: now.toISOString() };
      };
      const taken = await takeDeferred(deps.storage, waifu.id, toWake, deferred);
      if (!taken.conflict) {
        released = taken.wake;
        break;
      }
      // Wakes keep arriving while it is built: nothing is released this tick (no lines lost); the
      // next tick tries again.
      if (attempt >= BATCH_BUILD_ATTEMPTS - 1) {
        deps.logger.info("Life deferred batch put off: the deferred wakes kept changing", { category: "life", waifuId: waifu.id });
        return;
      }
      deferred = (await readLifeFile(deps.storage, waifu.id, "wakes")).deferred;
    }
    if (released) {
      deps.logger.info("Life deferred batch queued", { category: "life", waifuId: waifu.id, lines: released.batch?.length ?? 0 });
      this.o.hooks.poke(waifu.id);
    }
  }

  /**
   * What the batch shows (§23): its places, the deferred items it lists, handles and refs,
   * and whether any of it comes from a DM (D14). Lines at or below a DM's forget floor and lines or
   * watch matches from a forgotten person (at or before the forget) are left out; with unreadable
   * forget records no line is shown (counts stay).
   */
  private async batchView(waifu: WaifuConfig, deferred: WakeQueue["deferred"], now: Date): Promise<{ places: MorningPlace[]; items: Wake[]; view: NotificationView; dm: boolean }> {
    const deps = this.o.deps;
    const forgotten = await forgottenPeople(deps.storage).catch(() => undefined);
    const floors = new Map<string, string | undefined>();
    const floorOf = async (key: string) => {
      const ref = parseConversationKey(key);
      if (ref?.kind !== "dm") return undefined;
      if (!floors.has(key)) floors.set(key, await readDmFloor(deps.storage, ref.userId, ref.waifuId).catch(() => undefined));
      return floors.get(key);
    };
    const kept = async (key: string, message: { id: string; fromUserId?: string | undefined }, fallbackAt: string) => {
      if (!forgotten) return false;
      const floor = await floorOf(key);
      if (floor && compareIds(message.id, floor) <= 0) return false;
      const time = snowflakeTime(message.id);
      return !message.fromUserId || !isRemovedMessage({ authorId: message.fromUserId, createdAt: time !== undefined ? new Date(time).toISOString() : fallbackAt }, forgotten);
    };
    const items: Wake[] = [];
    for (const item of deferred.items) {
      const watch = item.reason === "watch" || item.reasons?.includes("watch") === true;
      if (!watch || !item.placeKey) {
        items.push(item);
        continue;
      }
      // A watch match quotes the message: shown only while that message may be. With unreadable
      // forget records only her note and the place are left.
      if (!forgotten) {
        const { messages: _messages, matched: _matched, fromName: _fromName, fromUserId: _fromUserId, preview: _preview, ...bare } = item;
        items.push(bare);
        continue;
      }
      const messages = messagesOf(item);
      const shown = [];
      for (const message of messages) if (await kept(item.placeKey, message, item.at)) shown.push(message);
      if (messages.length > 0 && shown.length === 0) continue;
      if (messages.length === 0 && item.fromUserId && isRemovedMessage({ authorId: item.fromUserId, createdAt: item.at }, forgotten)) continue;
      items.push(messages.length > 0 ? { ...item, messages: shown } : item);
    }
    const places = await this.batchPlaces(waifu, deferred, kept);
    const handles = new Map<string, string>();
    for (const key of [...places.map((place) => place.placeKey), ...items.flatMap((item) => (item.placeKey ? [item.placeKey] : []))]) {
      handles.set(key, await handleOf(deps.storage, waifu.id, key));
    }
    const refs = await this.batchRefs(places, items, now);
    // Her ended watches' places: how often she has written there with no answer (§34).
    const unanswered = await unansweredForWakes(deps, { waifuId: waifu.id, selfAuthorIds: await selfAuthorIds(deps.storage, waifu), wakes: items, now });
    const view: NotificationView = { timeZone: deps.timeZone, handle: (key) => handles.get(key) ?? key, unread: () => undefined, ref: (key, id) => refs.get(key)?.get(id), unanswered: (key) => unanswered.get(key) };
    // From a DM: a DM's lines or count, a DM watch or timeout, an earlier batch that showed one.
    const dm = places.some((place) => place.kind === "dm") || items.some((item) => wakeShowsDm(item));
    return { places, items, view, dm };
  }

  /**
   * Per place: mentions from the deferred counters, messages counted from the conversation cache
   * since the pause began (with their time span), and the batch's message lines (§23).
   */
  private async batchPlaces(
    waifu: WaifuConfig,
    deferred: WakeQueue["deferred"],
    kept: (key: string, message: { id: string; fromUserId?: string | undefined }, fallbackAt: string) => Promise<boolean>
  ): Promise<MorningPlace[]> {
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
      const lines: MorningLine[] = [];
      for (const line of counters?.lines ?? []) {
        if (!(await kept(key, line, deferred.since ?? deps.now().toISOString()))) continue;
        const at = snowflakeTime(line.id);
        lines.push({ id: line.id, ...(line.fromName !== undefined ? { fromName: line.fromName } : {}), preview: line.preview, reasons: line.reasons ?? [], ...(at !== undefined ? { at: new Date(at) } : {}) });
      }
      // A room's batch starts at the pause, or at the first message it kept when that came just
      // before (a burst's hold); never earlier than BATCH_LEAD_MS before it.
      const from = Math.max(since - BATCH_LEAD_MS, Math.min(since, ...lines.flatMap((line) => (line.at ? [line.at.getTime()] : []))));
      const night = deps.conversations.bufferedMessages(ref).filter((message) => !self.has(message.authorId) && Date.parse(message.createdAt) >= from);
      const messages = night.length;
      const place = places.find((candidate) => candidate.placeKey === key);
      const dropped = (counters?.lines?.length ?? 0) - lines.length;
      let earlier = counters?.earlier ?? 0;
      if (ref.kind === "dm") {
        // DM wakes deferred before the lines were kept (an upgrade night) count as earlier ones.
        if (lines.length > 0) earlier = Math.max(earlier, (counters?.dms ?? 0) - lines.length - dropped);
        const count = Math.max((counters?.dms ?? 0) - dropped, messages, lines.length + earlier);
        if (count > 0) out.push({ placeKey: key, kind: "dm", mentions: 0, messages: count, ...(lines.length > 0 ? { lines } : {}), ...(earlier > 0 ? { earlier } : {}) });
        continue;
      }
      const mentions = Math.max(counters?.mentions ?? 0, lines.length + earlier);
      const total = Math.max(messages, mentions + (counters?.detector ?? 0));
      const times = [...night.map((message) => Date.parse(message.createdAt)), ...lines.flatMap((line) => (line.at && line.at.getTime() >= from ? [line.at.getTime()] : []))].filter(Number.isFinite);
      const span = times.length > 0 ? { span: { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) } } : {};
      if (mentions > 0 || total > 0) out.push({ placeKey: key, kind: place?.kind ?? "room", mentions, messages: total, ...(lines.length > 0 ? { lines } : {}), ...(earlier > 0 ? { earlier } : {}), ...span });
    }
    return out;
  }

  /** The refs of every message the batch names (§23), per place (§22.1: stored, else assigned). */
  private async batchRefs(places: readonly MorningPlace[], items: readonly Wake[], now: Date): Promise<Map<string, Map<string, string>>> {
    const deps = this.o.deps;
    const wanted = new Map<string, Set<string>>();
    const want = (key: string, id: string) => {
      const set = wanted.get(key) ?? new Set<string>();
      set.add(id);
      wanted.set(key, set);
    };
    for (const place of places) for (const line of place.lines ?? []) want(place.placeKey, line.id);
    for (const item of items) {
      if (!item.placeKey || (item.reason !== "watch" && !item.reasons?.includes("watch"))) continue;
      if (item.messageId) want(item.placeKey, item.messageId);
      for (const message of messagesOf(item)) want(item.placeKey, message.id);
    }
    const out = new Map<string, Map<string, string>>();
    for (const [key, ids] of wanted) {
      // The cached messages before them get their refs too, so refs stay in message order (§4.7).
      const conversation = parseConversationKey(key);
      const newest = [...ids].reduce((a, b) => (compareIds(a, b) >= 0 ? a : b));
      const before = conversation ? deps.conversations.bufferedMessages(conversation).filter((message) => !ids.has(message.id) && compareIds(message.id, newest) < 0) : [];
      const messages = [
        ...before.map((message) => ({ id: message.id, at: message.createdAt })),
        ...[...ids].map((id) => ({ id, at: new Date(snowflakeTime(id) ?? now.getTime()).toISOString() }))
      ];
      out.set(key, await refsForMessages(deps, key, messages, now).catch(() => new Map<string, string>()));
    }
    return out;
  }

  /** Starts her maintenance in the background when it is due (one per waifu in the whole process). */
  private async maintenance(waifu: WaifuConfig): Promise<void> {
    const deps = this.o.deps;
    const key = `${deps.storage.dataRoot}\0${waifu.id}`;
    if (this.maintenanceRuns.has(waifu.id) || RUNNING_MAINTENANCE.has(key)) return;
    const state = await readLifeState(deps.storage, waifu.id);
    if (!maintenanceDue(deps.now(), deps.timeZone, deps.config().life.maintenanceHourLocal, state.lastMaintenanceAt)) return;
    if (this.stopped || this.maintenanceRuns.has(waifu.id) || RUNNING_MAINTENANCE.has(key)) return;
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
