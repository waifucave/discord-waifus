// The Living cast host (spec §3): one object that owns every life on this host — the per-waifu
// lives, the wake router and queue, intake, the detector, the scheduler, boot repair and catch-up,
// owner wakes, forget scrubs and the `/print` views. The runtime builds it after Discord connects
// and feeds it guild messages, DMs and cache events.

import type { Logger } from "../backend/logger.js";
import type { DiscordDirectMessageEvent, DiscordGatewayFacade } from "../discord/client.js";
import type { ConversationCacheEvent, ConversationMessageCache } from "../discord/conversationCache.js";
import type { GuildDirectory } from "../discord/guildDirectory.js";
import { curatedCatalog, type CuratedCatalog } from "../models/catalog.js";
import { createProviderCredentialsLookup, type ProviderKeyLookup } from "../models/credentials.js";
import type { ModelClient } from "../models/client.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { conversationKey, type ConversationRef } from "../orchestration/context/keys.js";
import { listDmLimitWaifuIds, listDmStates, listDmUserIds, readDmFloor } from "../orchestration/dm/dmStore.js";
import { queuePendingScrub, readPendingScrubs, removePendingScrubs, type PendingScrub, type PendingScrubSource } from "../orchestration/dm/forgotten.js";
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
  startEpochNow,
  summaryWithoutPerson,
  waifusWithLife,
  type ForgetIdentity,
  type ForgetScrubResult
} from "./forget.js";
import { Intake, type GuildMessageInput } from "./intake.js";
import { Life, lifeModelOf } from "./lifeLoop.js";
import { lifeStateExists, readLifeFile, readLifeLog, readLifeState, updateLifeState } from "./lifeStore.js";
import { runMaintenance } from "./maintenance.js";
import { OwnerNotices } from "./ownerNotices.js";
import { Notes, MEMORY_INDEX } from "./notes.js";
import { lifeLocks } from "./paths.js";
import { collectPlaces } from "./places.js";
import { lifeSystem } from "./request.js";
import { repairLife } from "./repair.js";
import { Scheduler } from "./scheduler.js";
import { WebTools } from "./search.js";
import { abortableSleep, KeyedMutex, Semaphore } from "./sync.js";
import { createWebBackend, LifeWebFetchCache, type WebBackend } from "./web/index.js";
import { newWakeId, pendingWakeCount } from "./wakeQueue.js";
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
};

export type OwnerForgetResult = { scrubbed: ForgetScrubResult[] };
export type PreparedForget = {
  waifu: WaifuConfig;
  identity: ForgetIdentity;
  scrub: PendingScrub;
  scope: "everything" | "conversation";
  source: "owner" | "dm";
  rateLimited: boolean;
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
      notices: this.notices
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
    this.router = new WakeRouter({ deps, cost: this.cost, poke: (waifuId) => this.life(waifuId).poke() });
    this.detector = o.detector ?? new AddresseeDetector({ credentials, usage: o.usageLedger });
    this.intake = new Intake({ deps, router: this.router, botRoles: this.botRoles, cost: this.cost, detector: this.detector });
    this.scheduler = new Scheduler({
      deps,
      router: this.router,
      cost: this.cost,
      mutex: this.mutex,
      ...(o.tickMs ? { tickMs: o.tickMs } : {}),
      hooks: { poke: (waifuId) => this.life(waifuId).poke(), maintain: (waifu) => this.maintain(waifu) }
    });
  }

  /** Her life (created on first use). */
  life(waifuId: string): Life {
    let life = this.lives.get(waifuId);
    if (!life) {
      life = new Life(waifuId, {
        deps: this.deps,
        mutex: this.mutex,
        turns: this.turns,
        hooks: { scheduleChanged: () => undefined }
      });
      this.lives.set(waifuId, life);
    }
    return life;
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
    const waifus = await listWaifus(deps.storage).catch(() => [] as WaifuConfig[]);
    for (const waifu of waifus) {
      if (!(await lifeStateExists(deps.storage, waifu.id))) continue;
      try {
        const repaired = await repairLife(deps, waifu.id);
        if (repaired.closedCalls > 0 || repaired.wasInTurn || repaired.tornLines) deps.logger.info("Life repaired after a restart", { category: "life", waifuId: waifu.id, ...repaired });
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
    if (!deps.isPaused()) await this.catchUpAndResume();
  }

  /**
   * Runs queued scrubs (her life lock held by the caller) and clears the ones that finished. The
   * identity is the stored one (collected before the DM data went) plus what is known now.
   */
  private async runPendingScrubs(waifu: WaifuConfig, scrubs: readonly PendingScrub[], source: string): Promise<ForgetScrubResult[]> {
    const done: PendingScrub[] = [];
    const results: ForgetScrubResult[] = [];
    for (const scrub of scrubs) {
      try {
        const identity = mergeIdentity(await collectIdentity(this.deps, waifu, scrub.userId), scrub);
        if (scrub.source === "dm_forget_conversation") {
          await this.forgetConversation(waifu, identity);
          done.push(scrub);
          continue;
        }
        const outcome = await scrubPerson(this.deps, waifu, identity, { source });
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
    this.scheduler.stop();
    this.intake.close();
    this.router.close();
    for (const life of this.lives.values()) life.stop();
    await Promise.all([...this.lives.values()].map((life) => life.whenIdle()));
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await this.intake.settle();
    this.detector.close();
    await this.webBackend.close().catch(() => undefined);
  }

  /** Explicit pause: abort in-flight calls; queues stay. */
  pause(): void {
    for (const life of this.lives.values()) life.abort("pause");
  }

  /** After a resume: catch up what arrived while paused and restart queued lives. */
  resume(): void {
    void this.track(this.catchUpAndResume());
  }

  /** §5.7 catch-up: messages newer than her read cursors and at most `resumeWindowMinutes` old go through intake. */
  async catchUpAndResume(): Promise<void> {
    const deps = this.deps;
    const windowMs = deps.config().discord.dm.resumeWindowMinutes * 60_000;
    const cutoff = deps.now().getTime() - windowMs;
    const waifus = (await listWaifus(deps.storage).catch(() => [])).filter((waifu) => waifu.enabled);
    const cursors = new Map<string, Record<string, { lastReadMessageId: string }>>();
    for (const waifu of waifus) cursors.set(waifu.id, (await readLifeFile(deps.storage, waifu.id, "reads")).cursors);
    if (windowMs > 0) {
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
          for (const message of page.messages) {
            if (Date.parse(message.createdAt) < cutoff) continue;
            const castWaifuIds = room.cast.filter((waifuId) => {
              const cursor = cursors.get(waifuId)?.[placeKey]?.lastReadMessageId;
              return !cursor || compareIds(message.id, cursor) > 0;
            });
            if (castWaifuIds.length === 0) continue;
            const ownWaifu = await this.isWaifuAuthor(message.authorId);
            if (message.authorIsBot && !ownWaifu) continue;
            await this.intake.onGuildMessage({ guildId: room.guildId, channelId: room.channelId, messageId: message.id, castWaifuIds, authorIsWaifu: ownWaifu, raw: message });
          }
        } catch (error) {
          deps.logger.warn("Life catch-up failed for a room", { placeKey, message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const state of await listDmStates(deps.storage).catch(() => [])) {
        const waifu = waifus.find((candidate) => candidate.id === state.waifuId);
        if (!waifu || !state.lastInboundMessageId) continue;
        const placeKey = conversationKey({ kind: "dm", waifuId: state.waifuId, userId: state.userId });
        const cursor = cursors.get(waifu.id)?.[placeKey]?.lastReadMessageId;
        if (cursor && compareIds(state.lastInboundMessageId, cursor) <= 0) continue;
        if (!state.lastInboundAt || Date.parse(state.lastInboundAt) < cutoff) continue;
        // Already queued (living-cast-dm-state-v1 turns a DM in flight at upgrade into a wake).
        const queued = (await readLifeFile(deps.storage, waifu.id, "wakes")).immediate;
        if (queued.some((wake) => wake.placeKey === placeKey && wake.messageId === state.lastInboundMessageId)) continue;
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
    await this.scheduler.tick();
    for (const waifu of waifus) if ((await pendingWakeCount(deps.storage, waifu.id)) > 0) this.life(waifu.id).poke();
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

  onCacheEvent(event: ConversationCacheEvent, castOf: (guildId: string, channelId: string) => Promise<string[]>): void {
    if (this.stopped) return;
    this.intake.onCacheEvent(event, castOf);
  }

  /** Role changes on Discord (§10.2): the bot role cache refetches. */
  onRolesChanged(guildId?: string): void {
    this.botRoles.invalidate(guildId);
  }

  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await this.intake.settle();
  }

  // ---- owner actions ------------------------------------------------------------------------------------

  /** `/wake`, the dashboard or the CLI: an `owner` wake (skips sleep and budget, §4.5). */
  async ownerWake(waifuId: string, note?: string): Promise<RouteOutcome> {
    const trimmed = note?.trim().slice(0, 500);
    return this.router.route(waifuId, { id: newWakeId(), reason: "owner", ...(trimmed ? { note: trimmed } : {}), at: this.deps.now().toISOString() });
  }

  /** Nightly maintenance plus pending scrubs (the scheduler holds her life lock). */
  private async maintain(waifu: WaifuConfig): Promise<void> {
    const model = lifeModelOf(this.deps, waifu);
    if (!model) return;
    const pending = await readPendingScrubs(this.deps.storage, waifu.id).catch(() => []);
    if (pending.length > 0) await this.runPendingScrubs(waifu, pending, "pending");
    await runMaintenance(this.deps, { waifu, model });
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
    const scrub = await queuePendingScrub(deps.storage, o.waifuId, o.userId, now, { source, names: identity.names, sharedNames: identity.sharedNames, logger: deps.logger });
    return { waifu, identity, scrub, scope: o.scope, source: o.source, rateLimited };
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
    if (prepared.rateLimited) return { ...none, queued: true };
    if (prepared.source === "dm") {
      // Recorded before the abort, so a burst of requests cannot abort her turns again and again.
      const now = deps.now();
      await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, scrubbedAt: recentScrubs({ ...current.scrubbedAt, [identity.userId]: now.toISOString() }, now) }));
    }
    const life = this.life(waifu.id);
    life.abort("forget");
    return this.mutex
      .run(lifeLocks.life(waifu.id), async () => {
        if (prepared.scope === "conversation") {
          await this.forgetConversation(waifu, identity);
          await removePendingScrubs(deps.storage, waifu.id, [scrub], { logger: deps.logger, now: deps.now() });
          return none;
        }
        const { complete, ...result } = await scrubPerson(deps, waifu, identity, { source: prepared.source });
        if (complete) await removePendingScrubs(deps.storage, waifu.id, [scrub], { logger: deps.logger, now: deps.now() });
        return result;
      })
      .finally(() => life.poke({ delayMs: 0 }));
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
    return queueOwnerScrubs(this.deps.storage, userId, this.deps.now(), { logger: this.deps.logger, identityOf: (waifu) => collectIdentity(this.deps, waifu, userId) });
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

  // ---- /print -------------------------------------------------------------------------------------------

  async printSystemPrompt(waifuId: string): Promise<string> {
    const state = await readLifeState(this.deps.storage, waifuId);
    if (!state.systemSnapshot) return "(no system prompt yet: her life has not started)";
    return lifeSystem(state).join("\n\n");
  }

  async printNotes(waifuId: string): Promise<string> {
    return (await new Notes(this.deps.storage, waifuId).read(MEMORY_INDEX)) ?? "(no MEMORY.md yet)";
  }

  /** The last 20 life-log lines with DM tool results and DM send arguments redacted (§10.4). */
  async printLife(waifuId: string): Promise<string> {
    const state = await readLifeState(this.deps.storage, waifuId);
    const all = await readLifeLog(this.deps.storage, waifuId, state.epoch);
    // DM tool calls of the whole epoch (a result's call may sit before the last 20 lines).
    const dmCalls = new Set<string>();
    for (const line of all) {
      const content = line.message?.["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block["type"] !== "tool_use") continue;
        const place = ((block["input"] ?? {}) as Record<string, unknown>)["place"];
        if (typeof place === "string" && isDmPlace(place)) dmCalls.add(String(block["id"]));
      }
    }
    const lines = all.slice(-20);
    return lines.map((line) => `${line.at.slice(11, 16)} ${line.kind}: ${redactLine(line.message, dmCalls)}`).join("\n") || "(her life log is empty)";
  }
}

const REDACTED = "[private chat redacted]";

function isDmPlace(place: string): boolean {
  return place.startsWith("dm/") || place.startsWith("dm_");
}

/**
 * Notification lines about a DM keep their reason, place and sender but lose every quoted part (the
 * preview, a matched watch word, a note), wherever they appear: a turn's notification block, or
 * notifications folded into a tool result (D14: DM content stays private from the owner too).
 */
export function redactDmNotifications(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*[-·] .*(?:· |\()dm[/_]/u.test(line) ? line.replace(/"[^"\n]*"/gu, `"${REDACTED}"`) : line))
    .join("\n");
}

/** One log line for `/print life`: DM tool results, DM send arguments and DM previews redacted. */
export function redactLine(message: Record<string, unknown> | null, dmCalls: ReadonlySet<string>): string {
  if (!message) return "—";
  const content = message["content"];
  if (typeof content === "string") return redactDmNotifications(content).slice(0, 300);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block["type"] === "text") parts.push(redactDmNotifications(String(block["text"])).slice(0, 300));
    else if (block["type"] === "tool_use") {
      const input = (block["input"] ?? {}) as Record<string, unknown>;
      parts.push(dmCalls.has(String(block["id"])) ? `${String(block["name"])}(${REDACTED})` : `${String(block["name"])}(${JSON.stringify(input).slice(0, 200)})`);
    } else if (block["type"] === "tool_result") {
      const raw = block["content"];
      const text = typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>).map((part) => (part["type"] === "text" ? String(part["text"]) : `[${String(part["type"])}]`)).join("\n")
          : JSON.stringify(raw);
      parts.push(dmCalls.has(String(block["tool_use_id"])) ? `result: ${REDACTED}` : `result: ${redactDmNotifications(text).slice(0, 200)}`);
    }
  }
  return parts.join(" | ");
}
