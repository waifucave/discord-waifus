// The Living cast host (spec §3): one object that owns every life on this host — the per-waifu
// lives, the wake router and queue, intake, the detector, the scheduler, boot repair and catch-up,
// owner wakes, forget scrubs and the `/print` views. The runtime builds it after Discord connects
// and feeds it guild messages, DMs and cache events.

import type { Logger } from "../backend/logger.js";
import type { DiscordDirectMessageEvent, DiscordGatewayFacade, DiscordTypingEvent } from "../discord/client.js";
import type { ConversationCacheEvent, ConversationMessageCache } from "../discord/conversationCache.js";
import type { GuildDirectory } from "../discord/guildDirectory.js";
import { curatedCatalog, findCuratedModel, type CuratedCatalog } from "../models/catalog.js";
import { createProviderCredentialsLookup, type ProviderKeyLookup } from "../models/credentials.js";
import type { ModelClient } from "../models/client.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { conversationKey, type ConversationRef } from "../orchestration/context/keys.js";
import { listDmLimitWaifuIds, listDmStates, listDmUserIds, readDmFloor } from "../orchestration/dm/dmStore.js";
import { dropPendingScrubHashes, queuePendingScrub, readPendingScrubs, removePendingScrubs, type PendingScrub, type PendingScrubSource } from "../orchestration/dm/forgotten.js";
import { isKnownWaifuAuthor, listWaifus, readWaifu } from "../orchestration/stores/config.js";
import type { UsageLedger } from "../orchestration/usageLedger.js";
import type { AppConfig } from "../shared/schemas/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import { compareIds } from "../discord/rawMessage.js";
import { DailyCost } from "./budget.js";
import { BotRoles } from "./botRoles.js";
import type { LifeDeps, LifeImageFetcher } from "./deps.js";
import { AddresseeDetector } from "./detector/decider.js";
import {
  collectIdentity,
  insideDmScrubWindow,
  mergeIdentity,
  queueOwnerScrubs,
  recentScrubs,
  scrubOtherState,
  scrubPerson,
  personFileHashes,
  scrubPersonFiles,
  startEpochNow,
  summaryWithoutPerson,
  waifusWithLife,
  type ForgetIdentity,
  type ForgetScrubResult
} from "./forget.js";
import { Intake, type GuildMessageInput } from "./intake.js";
import { Life, lifeModelOf, type LifeActivity } from "./lifeLoop.js";
import { lifeStateExists, readLifeFile, readLifeLog, readLifeState, updateLifeState } from "./lifeStore.js";
import { runDream } from "./dream.js";
import { OwnerNotices } from "./ownerNotices.js";
import { IntakeMarks } from "./intakeMarks.js";
import { homeStoreFor } from "./home/index.js";
import { markdownLinks, type HomeStore } from "./home/homeStore.js";
import { MEMORY_INDEX } from "./home/memoryIndex.js";
import { isDmFolderPath } from "./home/pathRules.js";
import { lifeLocks } from "./paths.js";
import { collectPlaces, handleOf } from "./places.js";
import { NOTES_INDEX_PRIVATE, printLifeLines, printNotesText, printSystemPromptText } from "./lifeView.js";
import { compactLife, compactRetiredTools, currentHarness, startEpoch, startPendingEpoch } from "./compaction.js";
import { repairLife } from "./repair.js";
import { Scheduler } from "./scheduler.js";
import { TranscriptWriter } from "./transcripts/writer.js";
import { WebTools } from "./search.js";
import { abortableSleep, KeyedMutex, Semaphore } from "./sync.js";
import { createWebBackend, LifeWebFetchCache, type WebBackend } from "./web/index.js";
import { dropDeferredOf, newWakeId, pendingWakeCount } from "./wakeQueue.js";
import { WakeRouter, type RouteOutcome } from "./wakeRouter.js";
import type { OcrTextLookup } from "../orchestration/context/images.js";

export type LivingCastOptions = {
  storage: StorageService;
  logger: Logger;
  discord: () => DiscordGatewayFacade | undefined;
  conversations: ConversationMessageCache;
  directory: Pick<GuildDirectory, "view" | "memberName" | "findEmoji" | "members">;
  models: ModelClient;
  config: () => AppConfig;
  isPaused: () => boolean;
  usageLedger: UsageLedger;
  images?: LifeImageFetcher;
  ocr?: OcrTextLookup;
  credentials?: ProviderKeyLookup;
  /** Tests: a web backend over loopback fakes. */
  webBackend?: WebBackend;
  detector?: AddresseeDetector;
  now?: () => Date;
  timeZone?: string;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  tickMs?: number;
  /** Tests: do not start the periodic scheduler. */
  manualScheduler?: boolean;
  /** The idle updater's activity: each turn cycle, maintenance run and forget scrub holds a lease. */
  updateActivity?: { begin(): (() => void) | undefined };
  /** Busy work (turns, maintenance, forget scrubs) for `/api/runtime` `queues.active`. */
  onActiveRunsChange?: (activeRuns: number) => void;
  /** Her bot's Discord profile sync (spec §17), run after she changes ~/profile.json. */
  profileSync?: { syncWaifu(waifuId: string): Promise<void> };
};

export type OwnerForgetResult = { scrubbed: ForgetScrubResult[] };
export type PreparedForget = {
  waifu: WaifuConfig;
  identity: ForgetIdentity;
  scrub: PendingScrub;
  scope: "everything" | "conversation";
  source: "owner" | "dm";
  rateLimited: boolean;
  /** The hashes of her files from the person that step 1 removed (found again under her life lock). */
  tombstones: Set<string>;
};
export type PreparedOwnerForget = Array<{ waifu: WaifuConfig; scrub: PendingScrub; identity: ForgetIdentity }>;

export class LivingCast {
  readonly deps: LifeDeps;
  readonly mutex = new KeyedMutex();
  readonly turns: Semaphore;
  readonly router: WakeRouter;
  readonly intake: Intake;
  readonly scheduler: Scheduler;
  readonly cost: DailyCost;
  readonly botRoles: BotRoles;
  readonly web: WebTools;
  /** Notices for the owner (`/api/runtime` `discord.warnings`). */
  readonly notices = new OwnerNotices();
  /** Intake high-water marks per place (catch-up, review I3). */
  readonly marks: IntakeMarks;
  /** The transcript store's writer (spec §18.2): fed by the conversation cache's events. */
  readonly transcripts: TranscriptWriter;
  /** When an explicit pause began: the resume catch-up starts there. */
  private pausedAt: Date | undefined;
  /** The start a running resume's catch-up began from (cleared when it ends). */
  private resumingSince: Date | undefined;
  private readonly webBackend: WebBackend;
  private readonly lives = new Map<string, Life>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly detector: AddresseeDetector;
  private stopped = false;

  constructor(private readonly o: LivingCastOptions) {
    const timeZone = o.timeZone ?? hostTimeZone();
    const config = o.config;
    const credentials = o.credentials ?? createProviderCredentialsLookup(o.storage.dataRoot);
    const catalog = (): CuratedCatalog => curatedCatalog({ allowed: config().models.allowed, maxOutputUsdPerMTok: config().models.maxOutputUsdPerMTok });
    const now = o.now ?? (() => new Date());
    const backend =
      o.webBackend ??
      createWebBackend({ resolveExaKey: () => credentials("exa") });
    this.webBackend = backend;
    const deps: LifeDeps = {
      storage: o.storage,
      logger: o.logger,
      discord: o.discord,
      conversations: o.conversations,
      directory: o.directory,
      models: o.models,
      ...(o.images ? { images: o.images } : {}),
      ...(o.ocr ? { ocr: o.ocr } : {}),
      config,
      catalog,
      now,
      timeZone,
      random: o.random ?? Math.random,
      sleep: o.sleep ?? abortableSleep,
      isPaused: o.isPaused,
      notices: this.notices,
      ...(o.profileSync ? { profileSync: o.profileSync } : {})
    };
    this.web = new WebTools({
      storage: o.storage,
      backend,
      config,
      models: o.models,
      catalog,
      credentials,
      cache: new LifeWebFetchCache({ ttlMs: () => config().life.webFetch.cacheMinutes * 60_000 }),
      now,
      timeZone,
      logger: o.logger
    });
    deps.web = this.web;
    this.deps = deps;
    this.turns = new Semaphore(() => config().life.maxConcurrentTurns);
    this.cost = new DailyCost(o.storage.dataRoot, timeZone);
    this.botRoles = new BotRoles({ discord: o.discord, refreshHours: () => config().discord.memberListRefreshHours });
    this.router = new WakeRouter({ deps, cost: this.cost, poke: (waifuId) => this.pokeLife(waifuId) });
    this.detector = o.detector ?? new AddresseeDetector({ credentials, usage: o.usageLedger });
    this.marks = new IntakeMarks(o.storage);
    this.transcripts = new TranscriptWriter(deps);
    this.intake = new Intake({ deps, router: this.router, botRoles: this.botRoles, cost: this.cost, detector: this.detector, marks: this.marks });
    this.scheduler = new Scheduler({
      deps,
      router: this.router,
      cost: this.cost,
      mutex: this.mutex,
      ...(o.tickMs ? { tickMs: o.tickMs } : {}),
      hooks: {
        poke: (waifuId) => this.pokeLife(waifuId),
        maintain: (waifu, signal, options) => this.maintain(waifu, signal, options),
        pendingScrubs: async (waifuId) => (await readPendingScrubs(this.deps.storage, waifuId, { logger: this.deps.logger })).length > 0,
        begin: () => this.activity.begin("maintenance")
      }
    });
  }

  /** Her life (created on first use; never once `stop()` began: a stopped cast hosts no new life). */
  life(waifuId: string): Life {
    let life = this.lives.get(waifuId);
    if (!life) {
      this.assertRunning();
      life = new Life(waifuId, { deps: this.deps, mutex: this.mutex, turns: this.turns, activity: this.activity, cost: this.cost });
      this.lives.set(waifuId, life);
    }
    return life;
  }

  /** A poke for her loop; nothing once the cast is stopping. */
  private pokeLife(waifuId: string, o?: { delayMs?: number }): void {
    if (this.stopped) return;
    this.life(waifuId).poke(o);
  }

  /**
   * Owner actions refuse a cast that is stopping or stopped (the reload window keeps the old cast
   * reachable until `stop()` returns): the routes answer `RuntimeOffline`, an owner wake is queued.
   */
  private assertRunning(): void {
    if (this.stopped) throw new LifeActionError("offline", "Her life is stopping (a reload or a reconnect); try again in a moment.");
  }

  /** True once `stop()` began. */
  get isStopped(): boolean {
    return this.stopped;
  }

  private activeRuns = 0;

  /**
   * One lease of busy work (review I7): the idle updater sees it through `updateActivity` and
   * `/api/runtime` through `onActiveRunsChange`. `undefined` when the app is sealed for an update.
   */
  readonly activity: LifeActivity = {
    begin: () => {
      const release = this.o.updateActivity?.begin();
      if (this.o.updateActivity && !release) return undefined;
      this.activeRuns += 1;
      this.o.onActiveRunsChange?.(this.activeRuns);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.activeRuns -= 1;
        release?.();
        this.o.onActiveRunsChange?.(this.activeRuns);
      };
    }
  };

  /** Turns, maintenance runs and forget scrubs running now. */
  get active(): number {
    return this.activeRuns;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.background.add(work);
    void work.finally(() => this.background.delete(work)).catch(() => undefined);
    return work;
  }

  // ---- lifecycle ------------------------------------------------------------------------------------

  /** Boot: repair every life, load DM forget floors, start the scheduler, catch up, resume queued wakes. */
  async start(): Promise<void> {
    const deps = this.deps;
    await this.marks.load();
    // The transcript store's start and every room's access intervals, before any event is written.
    await this.transcripts.start().catch((error: unknown) => deps.logger.warn("Transcripts could not start", { category: "life", message: error instanceof Error ? error.message : String(error) }));
    const waifus = await listWaifus(deps.storage).catch(() => [] as WaifuConfig[]);
    for (const waifu of waifus) {
      if (!(await lifeStateExists(deps.storage, waifu.id))) continue;
      try {
        const repaired = await repairLife(deps, waifu.id);
        if (repaired.closedCalls > 0 || repaired.wasInTurn || repaired.tornLines) deps.logger.info("Life repaired after a restart", { category: "life", waifuId: waifu.id, ...repaired });
        // A failed turn's follow-up that never ran is armed again (review M13).
        const failed = (await readLifeState(deps.storage, waifu.id)).failedTurn;
        if (failed && !failed.followUpDone && !this.stopped) this.life(waifu.id).armFollowUp(Date.parse(failed.at));
        // `scrubbedAt` keeps only the DM forget window; an older entry is a trace of the person.
        const now = deps.now();
        await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, scrubbedAt: recentScrubs(current.scrubbedAt, now) }));
      } catch (error) {
        deps.logger.error("Life boot repair failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    // Owner forgets that could not run (no runtime, a failure, a crash) run before her next turn:
    // the life lock is queued here, ahead of anything catch-up or the scheduler starts.
    for (const waifu of waifus) {
      let owner: PendingScrub[];
      try {
        owner = (await readPendingScrubs(deps.storage, waifu.id)).filter((scrub) => scrub.source === "owner_forget");
      } catch (error) {
        deps.logger.warn("Pending scrubs unreadable", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (owner.length > 0) void this.track(this.mutex.run(lifeLocks.life(waifu.id), () => this.runPendingScrubs(waifu, owner, "owner")));
    }
    await this.loadDmFloors();
    if (!this.o.manualScheduler) this.scheduler.start();
    const pausedAt = this.marks.pausedAt;
    if (deps.isPaused()) {
      // Booting paused without a recorded start: the resume catches up the boot window it skipped.
      if (!pausedAt) await this.marks.setPausedAt(new Date(deps.now().getTime() - deps.config().discord.dm.resumeWindowMinutes * 60_000)).catch(() => undefined);
    } else {
      // A pause that ended with the process (a reload, a crash): catch up from its start.
      await this.catchUpAndResume(pausedAt ? { since: pausedAt } : {});
      if (pausedAt) await this.clearPauseStart(pausedAt);
    }
  }

  /**
   * Runs queued scrubs (her life lock held by the caller) and clears the ones that finished. The
   * identity is the stored one (collected before the DM data went) plus what is known now.
   */
  private async runPendingScrubs(waifu: WaifuConfig, scrubs: readonly PendingScrub[], source: string, signal?: AbortSignal): Promise<ForgetScrubResult[]> {
    const done: PendingScrub[] = [];
    const results: ForgetScrubResult[] = [];
    for (const scrub of scrubs) {
      // A shutdown or pause stops between scrubs; the rest stay queued (durable) for next time.
      if (signal?.aborted) break;
      try {
        const identity = mergeIdentity(await collectIdentity(this.deps, waifu, scrub.userId), scrub);
        // A boot-time owner scrub or a queued DM forget: her DM's intake mark names the person (F10).
        await this.dropDmMark(waifu.id, scrub.userId);
        // The hashes step 1 removed before a crash or a wait: a copy saved since is found by them.
        const tombstones = new Set(scrub.fileHashes ?? []);
        if (scrub.source === "dm_forget_conversation") {
          await scrubPersonFiles(this.deps, waifu, identity, { dmOnly: true, tombstones });
          await this.dropScrubHashes(waifu.id, scrub);
          await this.forgetConversation(waifu, identity);
          done.push(scrub);
          continue;
        }
        const outcome = await scrubPerson(this.deps, waifu, identity, { source, tombstones });
        await this.dropScrubHashes(waifu.id, scrub);
        results.push(outcome);
        if (outcome.complete) done.push(scrub);
      } catch (error) {
        this.deps.logger.warn("Pending scrub failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    await removePendingScrubs(this.deps.storage, waifu.id, done, { logger: this.deps.logger, now: this.deps.now() }).catch((error: unknown) =>
      this.deps.logger.warn("Pending scrubs could not be cleared", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) })
    );
    return results;
  }

  /** The file step ran under her life lock: the pending scrub's file hashes are not needed any more. */
  private async dropScrubHashes(waifuId: string, scrub: Pick<PendingScrub, "userId" | "fileHashes">): Promise<void> {
    if (!scrub.fileHashes) return;
    await dropPendingScrubHashes(this.deps.storage, waifuId, scrub.userId, { logger: this.deps.logger, now: this.deps.now() }).catch((error: unknown) =>
      this.deps.logger.warn("Pending scrub file hashes could not be dropped", { waifuId, message: error instanceof Error ? error.message : String(error) })
    );
  }

  /** DM forget floors are loaded for every DM conversation at boot (and on every forget, §6.2). */
  async loadDmFloors(): Promise<void> {
    // A forget deletes the DM state file; the floor lives on in `limits/<waifu>.json`, so walk those.
    for (const userId of await listDmUserIds(this.deps.storage).catch(() => [] as string[])) {
      for (const waifuId of await listDmLimitWaifuIds(this.deps.storage, userId).catch(() => [] as string[])) {
        const floor = await readDmFloor(this.deps.storage, userId, waifuId).catch(() => undefined);
        if (floor) this.deps.conversations.setFloor({ kind: "dm", waifuId, userId }, floor);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.intake.close();
    this.router.close();
    // Everything is aborted first, then awaited: a maintenance run may be waiting for her life lock
    // behind a turn, and only the turn's abort lets it go (N1). Maintenance runs are waited for, so
    // none overlaps the next runtime's (M3).
    this.scheduler.abortMaintenance();
    this.abortOwnerRuns("shutdown");
    for (const life of this.lives.values()) life.stop();
    await this.scheduler.stop();
    await Promise.all([...this.lives.values()].map((life) => life.whenIdle()));
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await this.intake.settle();
    await this.transcripts.close();
    await this.marks.flush();
    this.detector.close();
    await this.webBackend.close().catch(() => undefined);
  }

  /** Explicit pause: abort in-flight calls (maintenance too); queues stay. */
  pause(): void {
    // A pause while a resume still catches up starts where that catch-up started.
    this.pausedAt ??= this.resumingSince ?? this.marks.pausedAt ?? this.deps.now();
    // Kept on disk, so a reload or a restart while paused still catches up from here (N4).
    void this.track(this.marks.setPausedAt(this.pausedAt).catch(() => undefined));
    this.scheduler.abortMaintenance();
    this.abortOwnerRuns("pause");
    for (const life of this.lives.values()) life.abort("pause");
  }

  /** After a resume: catch up what arrived while paused (from the pause start) and restart queued lives. */
  resume(): void {
    const since = this.pausedAt ?? this.marks.pausedAt;
    this.pausedAt = undefined;
    this.resumingSince = since;
    void this.track(
      this.catchUpAndResume(since ? { since } : {}).then(async () => {
        if (this.resumingSince === since) this.resumingSince = undefined;
        await this.clearPauseStart(since);
      })
    );
  }

  /**
   * After a catch-up from `since`: the saved pause start goes, unless she was paused again
   * meanwhile. That pause keeps the earlier start (`pause()` takes the running resume's), so a
   * reload catches up the whole gap.
   */
  private async clearPauseStart(since: Date | undefined): Promise<void> {
    if (this.pausedAt !== undefined || this.deps.isPaused()) return;
    if (this.marks.pausedAt?.getTime() !== since?.getTime()) return;
    await this.marks.setPausedAt(undefined).catch(() => undefined);
  }

  /**
   * §5.7 catch-up: messages newer than both her read cursor and the intake mark of their place go
   * through intake: at boot those at most `resumeWindowMinutes` old, after a resume those since the
   * pause began. A message intake already took (live delivery since connect) is never taken twice.
   */
  async catchUpAndResume(o: { since?: Date } = {}): Promise<void> {
    const deps = this.deps;
    await this.marks.load();
    const windowMs = deps.config().discord.dm.resumeWindowMinutes * 60_000;
    const cutoff = o.since ? o.since.getTime() : deps.now().getTime() - windowMs;
    const waifus = (await listWaifus(deps.storage).catch(() => [])).filter((waifu) => waifu.enabled);
    const cursors = new Map<string, Record<string, { lastReadMessageId: string }>>();
    for (const waifu of waifus) cursors.set(waifu.id, (await readLifeFile(deps.storage, waifu.id, "reads")).cursors);
    const queuedIds = new Set<string>();
    for (const waifu of waifus) for (const wake of (await readLifeFile(deps.storage, waifu.id, "wakes")).immediate) if (wake.messageId) queuedIds.add(wake.messageId);
    const newer = (id: string, ...marks: Array<string | undefined>) => marks.every((mark) => !mark || compareIds(id, mark) > 0);
    if (windowMs > 0 || o.since) {
      const rooms = new Map<string, { guildId: string; channelId: string; cast: string[] }>();
      for (const waifu of waifus) {
        for (const place of await collectPlaces(deps.storage, waifu.id)) {
          if (place.kind === "dm" || !place.guildId || !place.channelId || place.paused) continue;
          const entry = rooms.get(place.placeKey) ?? { guildId: place.guildId, channelId: place.channelId, cast: [] };
          entry.cast.push(waifu.id);
          rooms.set(place.placeKey, entry);
        }
      }
      for (const [placeKey, room] of rooms) {
        try {
          const page = await deps.conversations.readPage({ conversation: { kind: "guild", guildId: room.guildId, channelId: room.channelId }, limit: 50 });
          const mark = this.marks.get(placeKey);
          for (const message of page.messages) {
            if (Date.parse(message.createdAt) < cutoff || !newer(message.id, mark) || queuedIds.has(message.id)) continue;
            const castWaifuIds = room.cast.filter((waifuId) => newer(message.id, cursors.get(waifuId)?.[placeKey]?.lastReadMessageId));
            if (castWaifuIds.length === 0) continue;
            const ownWaifu = await this.isWaifuAuthor(message.authorId);
            if (message.authorIsBot && !ownWaifu) continue;
            await this.intake.onGuildMessage({ guildId: room.guildId, channelId: room.channelId, messageId: message.id, castWaifuIds, authorIsWaifu: ownWaifu, raw: message });
          }
          // Old messages wait for nobody's typing: the room's burst fires now (§4.2, §5.7).
          this.intake.flushBurst(placeKey);
        } catch (error) {
          deps.logger.warn("Life catch-up failed for a room", { placeKey, message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const state of await listDmStates(deps.storage).catch(() => [])) {
        const waifu = waifus.find((candidate) => candidate.id === state.waifuId);
        if (!waifu || !state.lastInboundMessageId) continue;
        const placeKey = conversationKey({ kind: "dm", waifuId: state.waifuId, userId: state.userId });
        const floor = await readDmFloor(deps.storage, state.userId, state.waifuId).catch(() => undefined);
        if (!newer(state.lastInboundMessageId, cursors.get(waifu.id)?.[placeKey]?.lastReadMessageId, this.marks.get(placeKey), floor)) continue;
        if (!state.lastInboundAt || Date.parse(state.lastInboundAt) < cutoff) continue;
        // Already queued (living-cast-dm-state-v1 turns a DM in flight at upgrade into a wake).
        if (queuedIds.has(state.lastInboundMessageId)) continue;
        await this.intake.onDirectMessage({
          waifuId: state.waifuId,
          botId: state.botId,
          userId: state.userId,
          ...(state.userDisplayName ? { userDisplayName: state.userDisplayName } : {}),
          channelId: state.dmChannelId ?? "",
          messageId: state.lastInboundMessageId,
          createdAt: state.lastInboundAt
        });
      }
    }
    // Late reminders fire once; queued wakes start turns.
    await this.scheduler.tick({ waitForMaintenance: false });
    for (const waifu of waifus) if ((await pendingWakeCount(deps.storage, waifu.id)) > 0) this.pokeLife(waifu.id);
  }

  private async isWaifuAuthor(authorId: string): Promise<boolean> {
    return isKnownWaifuAuthor(this.deps.storage, authorId).catch(() => false);
  }

  // ---- intake entry points ------------------------------------------------------------------------------

  onGuildMessage(input: GuildMessageInput): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.track(this.intake.onGuildMessage(input));
  }

  onDirectMessage(event: DiscordDirectMessageEvent): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.track(this.intake.onDirectMessage(event));
  }

  /** Someone is typing: their pending burst there waits (§4.2). */
  onTyping(event: DiscordTypingEvent): void {
    if (this.stopped) return;
    this.intake.onTyping(event);
  }

  onCacheEvent(event: ConversationCacheEvent, castOf: (guildId: string, channelId: string) => Promise<string[]>): void {
    if (this.stopped) return;
    this.transcripts.onCacheEvent(event);
    this.intake.onCacheEvent(event, castOf);
  }

  /** Role changes on Discord (§10.2): the bot role cache refetches. */
  onRolesChanged(guildId?: string): void {
    this.botRoles.invalidate(guildId);
  }

  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await this.intake.settle();
    await this.transcripts.settle();
    await this.scheduler.settle();
  }

  // ---- owner actions ------------------------------------------------------------------------------------

  /** `/wake`, the dashboard or the CLI: an `owner` wake (skips her bed time and budget, §4.5). */
  async ownerWake(waifuId: string, note?: string): Promise<RouteOutcome> {
    this.assertRunning();
    const trimmed = note?.trim().slice(0, 500);
    return this.track(this.router.route(waifuId, { id: newWakeId(), reason: "owner", ...(trimmed ? { note: trimmed } : {}), at: this.deps.now().toISOString() }));
  }

  /** Nightly maintenance plus pending scrubs (the scheduler holds her life lock). */
  private async maintain(waifu: WaifuConfig, signal: AbortSignal, o: { dream?: boolean } = {}): Promise<void> {
    // Aborted while it waited for her life lock (a shutdown, a pause, a reload): nothing starts (N1).
    if (signal.aborted) return;
    const pending = await readPendingScrubs(this.deps.storage, waifu.id, { logger: this.deps.logger });
    // Pending scrubs run first, with or without her model (§7.5): files by hash, DM data, transcripts,
    // wakes and review lines never need one; her summary is cleared instead of rewritten; the notes
    // session runs on `life.dreamModel` when her model is unavailable, and with neither her notes
    // lose the lines naming them and the scrub completes (recorded as skipped). So no night, model
    // or bed time can keep a scrub waiting for good, and the dream never reads what it removes.
    if (pending.length > 0 && !signal.aborted) await this.runPendingScrubs(waifu, pending, "pending", signal);
    // A bed time that ended without her falling asleep long enough has no dream (§21.6c).
    if (signal.aborted || o.dream === false) return;
    await runDream(this.deps, { waifu, signal });
  }

  /** `/forget conversation` (steps 0–2 for the DM), then the epoch starts at once so the old log goes too. */
  private async forgetConversation(waifu: WaifuConfig, identity: ForgetIdentity): Promise<void> {
    await summaryWithoutPerson(this.deps, waifu, identity);
    await scrubOtherState(this.deps, waifu, identity, { dmOnly: true });
    if ((await readLifeState(this.deps.storage, waifu.id)).pendingEpochStart) await startEpochNow(this.deps, waifu, "forget");
  }

  /** Step 0 for one life, before the caller deletes any DM data (undefined: no life and no notes). */
  async forgetIdentity(waifuId: string, userId: string): Promise<ForgetIdentity | undefined> {
    const waifu = await readWaifu(this.deps.storage, waifuId).catch(() => undefined);
    if (!waifu || !(await waifusWithLife(this.deps.storage)).some((candidate) => candidate.id === waifuId)) return undefined;
    return collectIdentity(this.deps, waifu, userId);
  }

  /**
   * The first half of §7.5 for one life, before the DM data goes: the identity is collected and the
   * scrub queued (durable, with the names), and a DM user's request inside the 6-hour window is
   * marked to stay queued for her nightly maintenance.
   */
  async prepareForget(o: { waifuId: string; userId: string; source: "owner" | "dm"; scope: "everything" | "conversation"; identity?: ForgetIdentity }): Promise<PreparedForget | undefined> {
    const deps = this.deps;
    const waifu = await readWaifu(deps.storage, o.waifuId).catch(() => undefined);
    // No life and no notes: there is nothing of the person to scrub.
    if (!waifu || !(await waifusWithLife(deps.storage)).some((candidate) => candidate.id === o.waifuId)) return undefined;
    const identity = o.identity ?? (await collectIdentity(deps, waifu, o.userId));
    const source: PendingScrubSource = o.source === "owner" && o.scope === "everything" ? "owner_forget" : o.scope === "everything" ? "dm_forget_everything" : "dm_forget_conversation";
    const now = deps.now();
    // A DM user's forget runs at most once per 6 hours (either scope); inside the window it is only queued.
    const rateLimited = o.source === "dm" && insideDmScrubWindow(await readLifeState(deps.storage, o.waifuId), o.userId, now);
    // The hashes step 1 is about to remove are queued with the scrub first: the provenance entries
    // go with the files, and a copy a running Bash saves meanwhile must still be found after a crash.
    const dmOnly = o.scope === "conversation";
    const fileHashes = await personFileHashes(deps, waifu, o.userId, { dmOnly }).catch(() => [] as string[]);
    const scrub = await queuePendingScrub(deps.storage, o.waifuId, o.userId, now, { source, names: identity.names, sharedNames: identity.sharedNames, fileHashes, logger: deps.logger });
    // The DM data goes now (every scope, rate-limited or not): so does the DM's intake mark (F10),
    // and her files from them (§16.9 step 1; `conversation`: only what came from the DM).
    await this.dropDmMark(o.waifuId, o.userId);
    // What waits for her morning from them goes now too (§23): a rate-limited DM forget's scrub can
    // wait for her dream, and her morning would show their DM lines first.
    const dmKey = conversationKey({ kind: "dm", waifuId: o.waifuId, userId: o.userId });
    const dmHandle = await handleOf(deps.storage, o.waifuId, dmKey).catch(() => undefined);
    await dropDeferredOf(deps.storage, o.waifuId, {
      userId: o.userId,
      dmKey,
      everything: o.scope === "everything",
      ...(dmHandle ? { dmHandle } : {}),
      names: identity.names
    }).catch((error: unknown) => {
      deps.logger.warn("Forget could not drop the person's deferred wakes", { waifuId: o.waifuId, message: error instanceof Error ? error.message : String(error) });
    });
    const tombstones = new Set<string>(fileHashes);
    await scrubPersonFiles(deps, waifu, identity, { dmOnly, tombstones }).catch((error: unknown) => {
      deps.logger.warn("Forget could not delete her files from the person", { waifuId: o.waifuId, message: error instanceof Error ? error.message : String(error) });
    });
    return { waifu, identity, scrub, scope: o.scope, source: o.source, rateLimited, tombstones };
  }

  /** Forget: the intake mark of her DM with this person, written at once (F10). */
  private async dropDmMark(waifuId: string, userId: string): Promise<void> {
    const dmKey = conversationKey({ kind: "dm", waifuId, userId });
    await this.marks.drop((key) => key === dmKey).catch(() => undefined);
  }

  /**
   * The second half (the caller has done step 1): steps 2–5 (`everything`) or 0–2 for the DM
   * (`conversation`) under her life lock, then the queued scrub is cleared, unless the DM rate
   * limit holds it for maintenance (her turn is then never aborted) or the notes scrub failed.
   */
  async runForget(prepared: PreparedForget): Promise<ForgetScrubResult> {
    const deps = this.deps;
    const { waifu, identity, scrub } = prepared;
    const none: ForgetScrubResult = { waifuId: waifu.id, removedLines: 0, removedSentences: 0, needsReview: [] };
    // Step 1 again once her running turn is over: a Bash command that was running may have saved a
    // copy of a file step 1 removed (its provenance is gone; the tombstones still know its hash).
    // Once it ran under her lock, the hashes queued with the scrub are dropped (a failed run keeps them).
    const filesAgain = () =>
      scrubPersonFiles(deps, waifu, identity, { dmOnly: prepared.scope === "conversation", tombstones: prepared.tombstones }).then(
        async (removed) => {
          await this.dropScrubHashes(waifu.id, { userId: identity.userId, fileHashes: [...prepared.tombstones] });
          return removed;
        },
        (error: unknown) => {
          deps.logger.warn("Forget could not delete her files from the person", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
          return 0;
        }
      );
    // Rate limited, or the cast is stopping: the scrub stays queued (it runs at her next start). The
    // file step still runs again after her current turn (never aborted for a rate-limited request).
    if (prepared.rateLimited && !this.stopped) void this.track(this.mutex.run(lifeLocks.life(waifu.id), filesAgain));
    if (prepared.rateLimited || this.stopped) return { ...none, queued: true };
    if (prepared.source === "dm") {
      // Recorded before the abort, so a burst of requests cannot abort her turns again and again.
      const now = deps.now();
      await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, scrubbedAt: recentScrubs({ ...current.scrubbedAt, [identity.userId]: now.toISOString() }, now) }));
    }
    const life = this.life(waifu.id);
    life.abort("forget");
    // Busy for the updater while it runs; a sealed app still runs it (it is queued durably anyway).
    const lease = this.activity.begin("forget");
    return this.mutex
      .run(lifeLocks.life(waifu.id), async () => {
        await filesAgain();
        if (prepared.scope === "conversation") {
          await this.forgetConversation(waifu, identity);
          await removePendingScrubs(deps.storage, waifu.id, [scrub], { logger: deps.logger, now: deps.now() });
          return none;
        }
        const { complete, ...result } = await scrubPerson(deps, waifu, identity, { source: prepared.source });
        if (complete) await removePendingScrubs(deps.storage, waifu.id, [scrub], { logger: deps.logger, now: deps.now() });
        // Her DM's intake mark names the person (the DM floor keeps old messages out from now on).
        await this.dropDmMark(waifu.id, identity.userId);
        return result;
      })
      .finally(() => {
        lease?.();
        if (!this.stopped) life.poke({ delayMs: 0 });
      });
  }

  /** §7.5 for a life, after the DM part (step 1) is done by the caller: `prepareForget` + `runForget`. */
  async forgetInLife(o: { waifuId: string; userId: string; source: "owner" | "dm"; scope: "everything" | "conversation"; identity?: ForgetIdentity }): Promise<ForgetScrubResult> {
    const prepared = await this.prepareForget(o);
    if (!prepared) return { waifuId: o.waifuId, removedLines: 0, removedSentences: 0, needsReview: [] };
    return this.runForget(prepared);
  }

  /**
   * The owner's forget-user, before the DM data goes: an `owner_forget` pending scrub for every
   * waifu with a life folder or notes, each with the identity collected now.
   */
  async prepareOwnerForget(userId: string): Promise<PreparedOwnerForget> {
    const prepared = await queueOwnerScrubs(this.deps.storage, userId, this.deps.now(), { logger: this.deps.logger, identityOf: (waifu) => collectIdentity(this.deps, waifu, userId) });
    // Every DM intake mark of the person, whatever waifu (F10).
    await this.marks.dropUser(userId).catch(() => undefined);
    return prepared;
  }

  /**
   * The owner's forget-user: every waifu with a life, steps 2–5 now. Each was queued first as an
   * `owner_forget` pending scrub (`prepareOwnerForget`) and is cleared once it ran, so a failure or
   * a crash resumes at boot.
   */
  async forgetPerson(userId: string, prepared?: PreparedOwnerForget): Promise<OwnerForgetResult> {
    const scrubbed: ForgetScrubResult[] = [];
    for (const { waifu, identity } of prepared ?? (await this.prepareOwnerForget(userId))) {
      try {
        scrubbed.push(await this.forgetInLife({ waifuId: waifu.id, userId, source: "owner", scope: "everything", identity }));
      } catch (error) {
        this.deps.logger.warn("Owner forget scrub failed; it runs again when her life next starts", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
        scrubbed.push({ waifuId: waifu.id, removedLines: 0, removedSentences: 0, needsReview: [], queued: true });
      }
    }
    await this.loadDmFloors();
    return { scrubbed };
  }

  // ---- owner actions on a life (Living cast §14.1) -------------------------------------------------------

  private readonly ownerRuns = new Set<AbortController>();

  /**
   * A manual compaction (`POST /api/waifus/:id/life/compact`, §5.6 "a manual compact"): under her life
   * lock, so it runs between turns. The summary uses the model her epoch runs on (else hers now).
   * Pause and shutdown abort it; an aborted summary changes nothing.
   */
  async compactNow(waifuId: string): Promise<{ epoch: number; summarized: boolean; aborted: boolean }> {
    this.assertRunning();
    return this.track(this.compactNowRun(waifuId));
  }

  private async compactNowRun(waifuId: string): Promise<{ epoch: number; summarized: boolean; aborted: boolean }> {
    const deps = this.deps;
    const waifu = await readWaifu(deps.storage, waifuId);
    const model = lifeModelOf(deps, waifu);
    if (!model) throw new LifeActionError("no_model", `${waifu.displayName} has no offered model; pick one before compacting her life.`);
    if (!(await readLifeState(deps.storage, waifuId)).systemSnapshot) throw new LifeActionError("not_started", `${waifu.displayName}'s life has not started yet; there is nothing to compact.`);
    const controller = new AbortController();
    this.ownerRuns.add(controller);
    const lease = this.activity.begin("maintenance");
    try {
      return await this.mutex.run(lifeLocks.life(waifuId), async () => {
        // Stopped while it waited for her lock: nothing starts.
        if (controller.signal.aborted) return { epoch: (await readLifeState(deps.storage, waifuId)).epoch, summarized: false, aborted: true };
        const state = await readLifeState(deps.storage, waifuId);
        const harness = await currentHarness(deps, waifu, model);
        // A forget or a deferred reset left an epoch to start: that epoch starts now, nothing is
        // summarised again (a reset's old log would come back into the summary).
        // A tool-surface change is summarised with the old calls as text (§16.13).
        if (state.pendingEpochStart && state.pendingEpochReason === "tools") {
          const old = state.modelRoute ? findCuratedModel(state.modelRoute, deps.catalog()) : undefined;
          const outcome = await compactRetiredTools(deps, {
            waifu,
            state,
            lines: await readLifeLog(deps.storage, waifuId, state.epoch),
            summaryRoute: old ?? model,
            ...(state.modelRoute?.effort ? { effort: state.modelRoute.effort } : {}),
            nextHarness: harness,
            omit: { deleted: state.deletedReadIds.map((id) => `message ${id}`), people: [] },
            signal: controller.signal
          });
          return { epoch: outcome.state.epoch, summarized: outcome.summarized, aborted: outcome.aborted === true };
        }
        if (state.pendingEpochStart) {
          const next = await startPendingEpoch(deps, waifuId, state, harness);
          return { epoch: next.epoch, summarized: false, aborted: false };
        }
        const lines = await readLifeLog(deps.storage, waifuId, state.epoch);
        const old = state.modelRoute ? findCuratedModel(state.modelRoute, deps.catalog()) : undefined;
        const outcome = await compactLife(deps, {
          waifu,
          state,
          lines,
          summaryRoute: old ?? model,
          ...(state.modelRoute?.effort ? { effort: state.modelRoute.effort } : {}),
          nextHarness: harness,
          reason: "manual",
          omit: { deleted: state.deletedReadIds.map((id) => `message ${id}`), people: [] },
          signal: controller.signal
        });
        return { epoch: outcome.state.epoch, summarized: outcome.summarized, aborted: outcome.aborted === true };
      });
    } finally {
      lease?.();
      this.ownerRuns.delete(controller);
      this.pokeLife(waifuId);
    }
  }

  /**
   * Reset her short-term memory (`POST /api/waifus/:id/life/reset`): her turn is aborted, then a
   * fresh epoch starts with no summary and no kept turns. Notes, queued wakes, watches, reminders and
   * read cursors stay; the old epoch's log is kept the usual 7 days. Without a model the new epoch
   * starts at her next turn (the summary is cleared now).
   */
  async resetLife(waifuId: string): Promise<{ epoch: number; deferred: boolean }> {
    this.assertRunning();
    return this.track(this.resetLifeRun(waifuId));
  }

  private async resetLifeRun(waifuId: string): Promise<{ epoch: number; deferred: boolean }> {
    const deps = this.deps;
    const waifu = await readWaifu(deps.storage, waifuId);
    const model = lifeModelOf(deps, waifu);
    const life = this.life(waifuId);
    life.abort("reset");
    const lease = this.activity.begin("maintenance");
    try {
      return await this.mutex.run(lifeLocks.life(waifuId), async () => {
        const state = await readLifeState(deps.storage, waifuId);
        if (model && state.systemSnapshot) {
          const harness = await currentHarness(deps, waifu, model);
          const next = await startEpoch(deps, waifuId, { harness, summary: null, kept: [], readIds: [], reason: "reset", summarized: false, strippedBlocks: 0 });
          deps.logger.info("Life reset by the owner", { category: "life", waifuId, epoch: next.epoch });
          return { epoch: next.epoch, deferred: false };
        }
        // Her next turn starts the epoch as a reset (the old log is kept 7 days, as with a model).
        const next = await updateLifeState(deps.storage, waifuId, (current) => ({ ...current, summary: null, ...(current.systemSnapshot ? { pendingEpochStart: true, pendingEpochReason: "reset" as const } : {}) }));
        deps.logger.info("Life reset by the owner; the fresh epoch starts at her next turn", { category: "life", waifuId });
        return { epoch: next.epoch, deferred: true };
      });
    } finally {
      lease?.();
      if (!this.stopped) life.poke();
    }
  }

  /** Aborts the owner's running compactions (pause, shutdown). */
  private abortOwnerRuns(reason: string): void {
    for (const controller of this.ownerRuns) controller.abort(new Error(reason));
  }

  /** Whether a turn cycle of hers runs now. */
  lifeBusy(waifuId: string): boolean {
    return this.lives.get(waifuId)?.busy ?? false;
  }

  // ---- /print -------------------------------------------------------------------------------------------

  /**
   * Blocks A and B; unless `private`, `<life_so_far>` (her summary) is hidden and so are the lines of
   * her index copy that `/print notes` leaves out (§10.4, D14).
   */
  async printSystemPrompt(waifuId: string, o: { private?: boolean } = {}): Promise<string> {
    const state = await readLifeState(this.deps.storage, waifuId);
    if (o.private === true || !state.systemSnapshot) return printSystemPromptText(state, { private: o.private === true });
    const store = homeStoreFor(this.deps, await readWaifu(this.deps.storage, waifuId));
    return printSystemPromptText(state, { private: false, privateLine: await this.privateNoteLines(store, state.systemSnapshot.memoryIndex) });
  }

  /**
   * Her `MEMORY.md` (§10.4). Unless `private`, D14 as in the dashboard's file views: a line linking to
   * a file that came from a private chat (by provenance, or under `/tmp/dm/`) or naming a DM place
   * or path is left out; an index whose own bytes came from a private chat is not shown at all.
   */
  async printNotes(waifuId: string, o: { private?: boolean } = {}): Promise<string> {
    const waifu = await readWaifu(this.deps.storage, waifuId);
    const store = homeStoreFor(this.deps, waifu);
    const index = await store.resolveExisting(`~/${MEMORY_INDEX}`);
    const text = index.ok ? await store.files.readText(index.path).catch(() => undefined) : undefined;
    if (text === undefined || !index.ok) return "(no MEMORY.md yet)";
    if (o.private === true) return text;
    if ((await store.dmOrigin(index.path).catch(() => "unknown")) !== undefined) return NOTES_INDEX_PRIVATE;
    return printNotesText(text, { private: false, privateLine: await this.privateNoteLines(store, text) });
  }

  /** Which lines of an index link to one of her files from a private chat (D14); an unreadable files index counts every link as private. */
  private async privateNoteLines(store: HomeStore, text: string): Promise<(line: string) => boolean> {
    const filesIndex = await store.readIndex().catch(() => undefined);
    const privateTargets = new Set<string>();
    for (const target of new Set(markdownLinks(text))) {
      const resolved = await store.resolveExisting(target.startsWith("/") || target.startsWith("~") ? target : `~/${target}`).catch(() => undefined);
      if (!resolved?.ok) continue;
      const origin = !filesIndex ? "unknown" : isDmFolderPath(resolved.path) ? "dm" : await store.dmOrigin(resolved.path, filesIndex).catch(() => "unknown");
      if (origin !== undefined) privateTargets.add(target);
    }
    return (line) => privateTargets.size > 0 && markdownLinks(line).some((target) => privateTargets.has(target));
  }

  /** The last 20 life-log lines; unless `private`, DM content is left out by the §14.4 rule (§10.4, D14). */
  async printLife(waifuId: string, o: { private?: boolean } = {}): Promise<string> {
    const state = await readLifeState(this.deps.storage, waifuId);
    const all = await readLifeLog(this.deps.storage, waifuId, state.epoch);
    return printLifeLines(all, { private: o.private === true });
  }
}

/** An owner action on a life that cannot run now (`no_model`, `not_started`). */
export class LifeActionError extends Error {
  override name = "LifeActionError";
  constructor(readonly code: "no_model" | "not_started" | "offline", message: string) {
    super(message);
  }
}

export { redactDmNotifications } from "./lifeView.js";
