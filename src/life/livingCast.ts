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
import { listDmStates, readDmFloor } from "../orchestration/dm/dmStore.js";
import { pendingScrubsPath, queuePendingScrub, readPendingScrubs } from "../orchestration/dm/forgotten.js";
import { isKnownWaifuAuthor, listWaifus, readWaifu } from "../orchestration/stores/config.js";
import type { UsageLedger } from "../orchestration/usageLedger.js";
import type { AppConfig } from "../shared/schemas/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { compareIds } from "../discord/rawMessage.js";
import { DailyCost } from "./budget.js";
import { BotRoles } from "./botRoles.js";
import type { LifeDeps, LifeImageFetcher } from "./deps.js";
import { AddresseeDetector } from "./detector/decider.js";
import { collectIdentity, DM_SCRUB_RATE_MS, scrubOtherState, scrubPerson, summaryWithoutPerson, type ForgetScrubResult } from "./forget.js";
import { Intake, type GuildMessageInput } from "./intake.js";
import { Life, lifeModelOf } from "./lifeLoop.js";
import { lifeStateExists, readLifeFile, readLifeLog, readLifeState, updateLifeState } from "./lifeStore.js";
import { runMaintenance } from "./maintenance.js";
import { Notes, MEMORY_INDEX } from "./notes.js";
import { lifeLocks } from "./paths.js";
import { collectPlaces } from "./places.js";
import { lifeSystem } from "./request.js";
import { repairLife } from "./repair.js";
import { Scheduler } from "./scheduler.js";
import { WebTools } from "./search.js";
import { abortableSleep, KeyedMutex, Semaphore } from "./sync.js";
import { createWebBackend, WebFetchCache, type WebBackend } from "./web/index.js";
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
      createWebBackend({
        resolveExaKey: () => credentials("exa"),
        exaMinIntervalMs: () => Math.ceil(1_000 / Math.max(1, config().search.maxPerSecond))
      });
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
      isPaused: o.isPaused
    };
    this.web = new WebTools({
      storage: o.storage,
      backend,
      config,
      models: o.models,
      catalog,
      credentials,
      cache: new WebFetchCache({ ttlMs: () => config().life.webFetch.cacheMinutes * 60_000 }),
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
    await this.loadDmFloors();
    if (!this.o.manualScheduler) this.scheduler.start();
    if (!deps.isPaused()) await this.catchUpAndResume();
  }

  /** DM forget floors are loaded for every DM conversation at boot (and on every forget, §6.2). */
  async loadDmFloors(): Promise<void> {
    for (const state of await listDmStates(this.deps.storage).catch(() => [])) {
      const floor = await readDmFloor(this.deps.storage, state.userId, state.waifuId).catch(() => undefined);
      if (floor) this.deps.conversations.setFloor({ kind: "dm", waifuId: state.waifuId, userId: state.userId }, floor);
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
    for (const scrub of pending) {
      try {
        const identity = await collectIdentity(this.deps, waifu, scrub.userId);
        await scrubPerson(this.deps, waifu, identity, { source: "pending" });
      } catch (error) {
        this.deps.logger.warn("Pending scrub failed", { waifuId: waifu.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (pending.length > 0) await atomicWriteJson(pendingScrubsPath(this.deps.storage.dataRoot, waifu.id), { scrubs: [] });
    await runMaintenance(this.deps, { waifu, model });
  }

  /**
   * §7.5 for a life, after the DM part (step 1) is done by the caller. `everything` runs 2–5 (the
   * DM source at most once per 6 hours per user, later requests queue 2–5 as a pending scrub);
   * `conversation` runs step 2 only.
   */
  async forgetInLife(o: { waifuId: string; userId: string; source: "owner" | "dm"; scope: "everything" | "conversation" }): Promise<ForgetScrubResult> {
    const deps = this.deps;
    const none: ForgetScrubResult = { waifuId: o.waifuId, removedLines: 0, removedSentences: 0, needsReview: [] };
    const waifu = await readWaifu(deps.storage, o.waifuId).catch(() => undefined);
    // No life and no notes: there is nothing of the person to scrub.
    if (!waifu || (!(await lifeStateExists(deps.storage, o.waifuId)) && !(await new Notes(deps.storage, o.waifuId).exists()))) return none;
    const identity = await collectIdentity(deps, waifu, o.userId);
    const life = this.life(o.waifuId);
    life.abort("forget");
    return this.mutex.run(lifeLocks.life(o.waifuId), async () => {
      if (o.scope === "conversation") {
        await summaryWithoutPerson(deps, waifu, identity);
        await scrubOtherState(deps, waifu, { ...identity, names: [], sharedNames: [] });
        return { waifuId: o.waifuId, removedLines: 0, removedSentences: 0, needsReview: [] };
      }
      if (o.source === "dm") {
        const state = await readLifeState(deps.storage, o.waifuId);
        const last = state.scrubbedAt[o.userId];
        if (last && deps.now().getTime() - Date.parse(last) < DM_SCRUB_RATE_MS) {
          await queuePendingScrub(deps.storage, o.waifuId, o.userId, deps.now(), { logger: deps.logger });
          return { waifuId: o.waifuId, removedLines: 0, removedSentences: 0, needsReview: [], queued: true };
        }
      }
      return scrubPerson(deps, waifu, identity, { source: o.source });
    }).finally(() => life.poke({ delayMs: 0 }));
  }

  /** The owner's forget-user: every waifu with a life, steps 2–5 now. */
  async forgetPerson(userId: string): Promise<OwnerForgetResult> {
    const scrubbed: ForgetScrubResult[] = [];
    for (const waifu of await listWaifus(this.deps.storage).catch(() => [])) {
      if (!(await lifeStateExists(this.deps.storage, waifu.id)) && !(await new Notes(this.deps.storage, waifu.id).exists())) continue;
      scrubbed.push(await this.forgetInLife({ waifuId: waifu.id, userId, source: "owner", scope: "everything" }));
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

/** One log line for `/print life`: DM tool results and DM send arguments redacted. */
export function redactLine(message: Record<string, unknown> | null, dmCalls: ReadonlySet<string>): string {
  if (!message) return "—";
  const content = message["content"];
  if (typeof content === "string") return content.slice(0, 300);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block["type"] === "text") parts.push(String(block["text"]).slice(0, 300));
    else if (block["type"] === "tool_use") {
      const input = (block["input"] ?? {}) as Record<string, unknown>;
      parts.push(dmCalls.has(String(block["id"])) ? `${String(block["name"])}(${REDACTED})` : `${String(block["name"])}(${JSON.stringify(input).slice(0, 200)})`);
    } else if (block["type"] === "tool_result") {
      const text = typeof block["content"] === "string" ? block["content"] : JSON.stringify(block["content"]);
      parts.push(dmCalls.has(String(block["tool_use_id"])) ? `result: ${REDACTED}` : `result: ${text.slice(0, 200)}`);
    }
  }
  return parts.join(" | ");
}
