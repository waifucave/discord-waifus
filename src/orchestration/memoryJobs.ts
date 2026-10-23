// Memory background work: the per-channel stage-manager observer (idle-scheduled) and the
// per-guild nightly dream consolidation pass, plus the manual /memories trigger that runs both.

import { randomUUID } from "node:crypto";
import { GatewayPipelineError } from "./pipeline/params.js";
import {
  MemoryRecord,
  MemoryStoreSchema,
  PendingObservation,
  PendingObservationsFileSchema,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { extractEntities } from "./memoryEntities.js";
import {
  DREAM_CURSOR_RELATIVE_PATH,
  DreamCursorFileSchema,
  applyDreamOps,
  dreamChunkWaifuIds,
  guildHash,
  orderDreamChunks,
  selectDreamInput
} from "./dream.js";
import { nowIso } from "../shared/schemas/common.js";
import { sendDreamDebugLog, sendStageManagerDebugLog } from "./debugLog.js";
import { ModelAccess } from "./modelAccess.js";
import {
  type DreamPassResult,
  type RuntimeHooks,
  type RuntimeServices,
  type StageManagerRunResult,
  summarizeProviderPipelineDetails,
  timerKey
} from "./runtimeShared.js";
import { ensureServer, listAvailableWaifusForChannel, listKnownGuildIds, listWaifus, readAgentConfig } from "./stores/config.js";
import { appendStageManagerHistory } from "./stores/decisionHistory.js";
import { emptyMemoryStore, readMemoryStore } from "./stores/memories.js";
import { ensureChannelSession } from "./stores/sessions.js";
import { legacyServerContextWindow } from "./contextWindows.js";

// Hour of the day (local time, 0-23) at which the nightly dream pass fires.
const DREAM_HOUR_LOCAL = 5;

type StageManagerSchedule = {
  idleTimer?: NodeJS.Timeout;
};

export type MemoryJobHooks = RuntimeHooks & {
  /** True while a channel run is active for the guild (dream passes defer behind it). */
  isGuildRunActive(guildId: string): boolean;
};

export class MemoryJobs {
  private readonly stageManagerSchedules = new Map<string, StageManagerSchedule>();
  readonly activeStageManagerRuns = new Set<Promise<StageManagerRunResult>>();
  // guildId:channelId of observer runs in flight (in-memory so a crash can never leave it stuck).
  private readonly activeStageManagerChannels = new Set<string>();
  // Per-guild daily dream-pass timers (next-run setTimeout, re-armed after each run) and any
  // pending defer timers for runs deferred because a channel run was active.
  readonly dreamTimers = new Map<string, NodeJS.Timeout>();
  readonly activeDreamRuns = new Set<Promise<DreamPassResult>>();
  // Per-guild reentrancy guard for the dream pass. Prevents two concurrent runs for the same
  // guild from double-draining the observation queue or producing duplicate merge records.
  private readonly dreamingGuilds = new Set<string>();
  private static readonly STAGE_MANAGER_IDLE_DELAY_MS = 60 * 60 * 1000;
  // Dream pass: per guild, once per day at DREAM_HOUR_LOCAL (±15 min deterministic jitter). When a
  // channel run is active for the guild we defer 15 min, up to 8 times, then run anyway.
  private static readonly DREAM_DEFER_DELAY_MS = 15 * 60 * 1000;
  private static readonly DREAM_MAX_DEFERS = 8;
  private readonly stageManagerIdleDelayMs: number;

  constructor(
    private readonly options: RuntimeServices,
    private readonly models: ModelAccess,
    private readonly hooks: MemoryJobHooks,
    stageManagerIdleDelayMs?: number
  ) {
    this.stageManagerIdleDelayMs = stageManagerIdleDelayMs ?? MemoryJobs.STAGE_MANAGER_IDLE_DELAY_MS;
  }

  async triggerStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    // Manual trigger (/memories or the dashboard): run the observer (queue + fast-track) and then
    // the dream pass, folding both into a single status the caller reports.
    const observer = await this.startStageManagerRun(guildId, channelId);
    if (observer.status === "already_running" || observer.status === "disabled") {
      return observer;
    }
    let dream: DreamPassResult;
    try {
      dream = await this.startDreamRun(guildId);
    } catch (error) {
      this.options.logger.error("Dream pass failed during manual trigger", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      dream = { status: "failed", applied: 0, skipped: 0, chunks: 0, message: error instanceof Error ? error.message : "Dream pass failed." };
    }
    return combineStageAndDream(observer, dream);
  }

  noteStageManagerActivity(guildId: string, channelId: string): void {
    const key = timerKey(guildId, channelId);
    const schedule = this.stageManagerSchedules.get(key) ?? {};
    this.stageManagerSchedules.set(key, schedule);

    if (schedule.idleTimer) {
      clearTimeout(schedule.idleTimer);
    }
    schedule.idleTimer = setTimeout(() => {
      const current = this.stageManagerSchedules.get(key);
      if (!current) return;
      current.idleTimer = undefined;
      this.stageManagerSchedules.delete(key);
      this.hooks.runBackground("Scheduled stage manager run failed", { guildId, channelId }, () =>
        this.startStageManagerRun(guildId, channelId)
      );
    }, this.stageManagerIdleDelayMs);
  }

  private async runStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    {
      // Per-guild kill switch: observers (and everything they feed) stay off for this server.
      const server = await ensureServer(this.options.storage, guildId);
      if (!server.stageManagerEnabled) {
        this.options.logger.info("Stage manager disabled for this server; skipping run", { guildId, channelId });
        return { status: "disabled", message: "Stage manager is disabled for this server." };
      }
      if (server.paused) {
        this.options.logger.info("Stage manager skipped because server is paused", { guildId, channelId });
        return { status: "disabled", message: "Server is paused." };
      }
    }
    await ensureChannelSession(this.options.storage, guildId, channelId);
    // Reentrancy is guarded in memory: the persisted session.stageManager flag used to survive a
    // crash as `active: true` and answer "already_running" forever. It is no longer consulted.
    const stageKey = timerKey(guildId, channelId);
    if (this.activeStageManagerChannels.has(stageKey)) {
      return { status: "already_running" };
    }
    this.activeStageManagerChannels.add(stageKey);
    try {
      const server = await ensureServer(this.options.storage, guildId);
      const config = await readAgentConfig(this.options.storage, "stage-manager", 80);
      if (!config.enabled || !config.modelId) {
        return { status: "disabled" };
      }
      const pipeline = this.models.pipelineFor(
        { providerId: config.providerId, modelId: config.modelId },
        "stage_manager_observer"
      );
      if (!pipeline.decideStageManagerObservations) {
        throw new Error(`Model ${config.modelId} does not implement observer decisions.`);
      }
      const channel = server.channels[channelId];
      const availableWaifus = channel ? await listAvailableWaifusForChannel(this.options.storage, channel) : [];
      const allowedWaifuIds = availableWaifus.map((waifu) => waifu.id);
      let messages = await this.options.discord.fetchFreshContext({
        guildId,
        channelId,
        limit: legacyServerContextWindow("stageManager", server)
      });
      messages = await this.models.messagesForModel(messages, { providerId: config.providerId, modelId: config.modelId });

      this.options.logger.info("Stage manager observer started", {
        guildId,
        channelId,
        modelId: config.modelId,
        contextMessages: messages.length
      });
      const observations = await pipeline.decideStageManagerObservations({
        modelId: config.modelId,
        messages,
        availableWaifuIds: allowedWaifuIds,
        params: config.params
      });
      const allowedObservations = observations.filter((observation) => allowedWaifuIds.includes(observation.waifuId));
      this.options.logger.info("Stage manager observer finished", {
        guildId,
        channelId,
        observations: observations.length,
        allowedObservations: allowedObservations.length
      });

      if (allowedObservations.length === 0) {
        const entry = {
          id: randomUUID(),
          guildId,
          channelId,
          tool: "no_change" as const,
          affectedMemoryIds: [] as string[],
          summary: observations.length === 0
            ? "No observations extracted"
            : `Dropped ${observations.length} observation(s) with unknown waifu ids`,
          observationCount: observations.length,
          createdAt: nowIso()
        };
        await appendStageManagerHistory(this.options.storage, entry);
        void sendStageManagerDebugLog(this.options, {
          guildId,
          channelId,
          entries: [entry],
          observationCount: observations.length
        });
        return { status: "no_change" };
      }

      // Split observations: fast-track (importance >= 4) go directly to the memory store so
      // critical facts don't wait for the next dream; the rest are queued for the dream pass to
      // consolidate. Only queued (<4) observations reach the dream, so no fact is added twice.
      const fastTrackedObservations = allowedObservations.filter((obs) => obs.importance >= 4);
      const queuedObservations = allowedObservations.filter((obs) => obs.importance < 4);

      const nowTs = nowIso();

      // Append queued observations (importance < 4) to the pending queue
      if (queuedObservations.length > 0) {
        await this.options.storage.updateRevisionedJson({
          resourceKey: "memory:pending",
          relativePath: "user/memory/pending-observations.json",
          schema: PendingObservationsFileSchema,
          fallback: PendingObservationsFileSchema.parse(createEmptyRevisionedFile({ observations: [] })),
          transform: (current) => {
            const newPending = queuedObservations.map((obs) => ({
              id: randomUUID(),
              guildId,
              channelId,
              waifuId: obs.waifuId,
              content: obs.content,
              kind: obs.kind,
              importance: obs.importance,
              entities: (obs.entities?.length ?? 0) > 0 ? obs.entities : extractEntities(obs.content),
              createdAt: nowTs
            }));
            return { ...current, observations: [...current.observations, ...newPending] };
          }
        });
      }

      // Fast-track: write importance >= 4 observations directly to the memory store
      if (fastTrackedObservations.length > 0) {
        await this.options.storage.updateRevisionedJson({
          resourceKey: "memories:global",
          relativePath: "user/memories.json",
          schema: MemoryStoreSchema,
          fallback: emptyMemoryStore(),
          transform: (current) => {
            const newMemories: MemoryRecord[] = fastTrackedObservations.map((obs) => ({
              id: randomUUID(),
              guildId,
              channelId,
              waifuId: obs.waifuId,
              content: obs.content,
              kind: obs.kind,
              source: "stage_manager" as const,
              pinned: false,
              strength: obs.importance,
              entities: (obs.entities?.length ?? 0) > 0 ? obs.entities : extractEntities(obs.content),
              createdAt: nowTs,
              updatedAt: nowTs,
              status: "active" as const
            }));
            return { ...current, memories: [...current.memories, ...newMemories] };
          }
        });
      }

      // The observer's job ends at the queue and fast-track; the dream pass (its own schedule, or
      // the manual /memories trigger) drains the queue and consolidates the store.
      const summary = `queued: ${queuedObservations.length}, fastTracked: ${fastTrackedObservations.length}`;
      const entry = {
        id: randomUUID(),
        guildId,
        channelId,
        tool: "no_change" as const,
        affectedMemoryIds: [] as string[],
        summary,
        observationCount: allowedObservations.length,
        createdAt: nowTs
      };
      await appendStageManagerHistory(this.options.storage, entry);
      void sendStageManagerDebugLog(this.options, {
        guildId,
        channelId,
        entries: [entry],
        observationCount: allowedObservations.length
      });
      return { status: fastTrackedObservations.length > 0 ? "updated" : "no_change" };
    } catch (error) {
      this.options.logger.error("Stage manager failed", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof GatewayPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
      });
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Stage manager failed."
      };
    } finally {
      this.activeStageManagerChannels.delete(stageKey);
    }
  }

  startStageManagerRun(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    const promise = this.runStageManager(guildId, channelId);
    this.activeStageManagerRuns.add(promise);
    void promise
      .finally(() => {
        this.activeStageManagerRuns.delete(promise);
      })
      .catch((error) => {
        this.options.logger.error("Stage manager run failed outside handler", {
          guildId,
          channelId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return promise;
  }

  // Arm a daily dream timer per known guild. Guild ids come from the on-disk server directory.
  async scheduleDreamRuns(): Promise<void> {
    let guildIds: string[];
    try {
      guildIds = await listKnownGuildIds(this.options.storage);
    } catch (error) {
      this.options.logger.warn("Failed to enumerate guilds for dream scheduling", {
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    for (const guildId of guildIds) {
      this.armDreamTimer(guildId);
    }
  }

  // Compute the next 05:00-local fire time (with deterministic per-guild jitter) and re-arm after
  // each run. If a channel run is active for the guild when the timer fires, defer 15 min up to 8
  // times, then run anyway. The defer chain reuses the same dreamTimers slot so stop()/pause()
  // clears it.
  armDreamTimer(guildId: string, deferCount = 0): void {
    const delay = deferCount > 0 ? MemoryJobs.DREAM_DEFER_DELAY_MS : msUntilNextDreamRun(guildId, new Date());
    const existing = this.dreamTimers.get(guildId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.dreamTimers.delete(guildId);
      if (this.options.isPaused?.()) {
        this.armDreamTimer(guildId);
        return;
      }
      const active = this.hooks.isGuildRunActive(guildId);
      if (active && deferCount < MemoryJobs.DREAM_MAX_DEFERS) {
        this.armDreamTimer(guildId, deferCount + 1);
        return;
      }
      this.hooks.runBackground("Scheduled dream pass failed", { guildId }, async () => {
        try {
          await this.startDreamRun(guildId);
        } finally {
          // Re-arm for the next day regardless of outcome.
          this.armDreamTimer(guildId);
        }
      });
    }, delay);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.dreamTimers.set(guildId, timer);
  }

  clearAllDreamTimers(): void {
    for (const timer of this.dreamTimers.values()) {
      clearTimeout(timer);
    }
    this.dreamTimers.clear();
  }

  startDreamRun(guildId: string): Promise<DreamPassResult> {
    if (this.dreamingGuilds.has(guildId)) {
      this.options.logger.info("Dream pass already running for guild, skipping duplicate run", { guildId });
      return Promise.resolve({ status: "already_running", applied: 0, skipped: 0, chunks: 0, message: "Dream pass already running for this guild." });
    }
    this.dreamingGuilds.add(guildId);
    const promise = this.runDreamPass(guildId).finally(() => {
      this.dreamingGuilds.delete(guildId);
    });
    this.activeDreamRuns.add(promise);
    void promise
      .finally(() => {
        this.activeDreamRuns.delete(promise);
      })
      .catch((error) => {
        this.options.logger.error("Dream pass run failed outside handler", {
          guildId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return promise;
  }

  // The nightly (or manually triggered) consolidation pass. Reads the store and pending queue,
  // chunks the active records, and runs decideDream → applyDreamOps per chunk SEQUENTIALLY,
  // re-reading the store between chunks so per-chunk indices stay valid (max 5 iterations).
  // Each iteration re-selects chunks from the freshest store, rotates them past the persisted
  // per-guild cursor (so the 5-chunk cap round-robins across nights instead of always dreaming
  // the same first waifus), then picks the first chunk whose stable key has not yet been
  // processed — so mutations from prior iterations cannot shift the nth position into a chunk
  // we already handled.
  private async runDreamPass(guildId: string): Promise<DreamPassResult> {
    const server = await ensureServer(this.options.storage, guildId);
    if (!server.stageManagerEnabled || server.paused) {
      return { status: "disabled", applied: 0, skipped: 0, chunks: 0 };
    }
    const config = await readAgentConfig(this.options.storage, "stage-manager", 80);
    if (!config.enabled || !config.modelId) {
      return { status: "disabled", applied: 0, skipped: 0, chunks: 0 };
    }
    const pipeline = this.models.pipelineFor(
      { providerId: config.providerId, modelId: config.modelId },
      "dream"
    );
    // Configured waifus: each chunk's owners are intersected with this set so a hallucinated or
    // deleted owner never lands.
    const configuredWaifuIds = new Set((await listWaifus(this.options.storage)).map((waifu) => waifu.id));
    const startCursor = (await this.readDreamCursors()).cursors[guildId];

    let totalApplied = 0;
    let totalSkipped = 0;
    let chunksProcessed = 0;
    const MAX_ITERATIONS = 5;
    const processedKeys = new Set<string>();

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        const store = await readMemoryStore(this.options.storage);
        const pending = await this.readPendingObservations();
        const guildMemories = store.memories.filter((memory) => memory.guildId === guildId);
        const guildObservations = pending.observations.filter((observation) => observation.guildId === guildId);
        const chunks = orderDreamChunks(selectDreamInput(guildMemories, guildObservations, new Date()), startCursor);
        const chunk = chunks.find((c) => !processedKeys.has(c.key));
        if (!chunk) break;

        // Only require the dream capability once there is real work; an empty room needs no call.
        if (!pipeline.decideDream) {
          throw new Error(`Model ${config.modelId} does not implement dream decisions.`);
        }
        const decideDream = pipeline.decideDream.bind(pipeline);
        // Per-chunk ownership: "add" ops may only target the waifus this chunk is about (its
        // records' and observations' owners), not any waifu in the guild.
        const allowedWaifuIds = dreamChunkWaifuIds(chunk).filter((waifuId) => configuredWaifuIds.has(waifuId));

        this.options.logger.info("Dream pass chunk started", {
          guildId,
          modelId: config.modelId,
          iteration,
          memories: chunk.inputs.length,
          observations: chunk.observations.length
        });
        const ops = await decideDream({
          modelId: config.modelId,
          messages: [],
          memories: chunk.inputs,
          observations: chunk.observations,
          availableWaifuIds: allowedWaifuIds,
          params: config.params
        });
        const now = new Date();
        const result = applyDreamOps(store.memories, ops, chunk.indexMap, { guildId, now, allowedWaifuIds });

        await this.options.storage.updateRevisionedJson({
          resourceKey: "memories:global",
          relativePath: "user/memories.json",
          schema: MemoryStoreSchema,
          fallback: emptyMemoryStore(),
          transform: (current) => {
            // Re-apply against the freshest store so concurrent writers (fast-track, CRUD) are not
            // clobbered: ops touch only this chunk's records, identified by id.
            const applied = applyDreamOps(current.memories, ops, chunk.indexMap, { guildId, now, allowedWaifuIds });
            return { ...current, memories: applied.memories };
          }
        });

        // Clear exactly this chunk's consumed observations from the queue.
        const consumedIds = new Set(chunk.observations.map((observation) => observation.id));
        if (consumedIds.size > 0) {
          await this.options.storage.updateRevisionedJson({
            resourceKey: "memory:pending",
            relativePath: "user/memory/pending-observations.json",
            schema: PendingObservationsFileSchema,
            fallback: PendingObservationsFileSchema.parse(createEmptyRevisionedFile({ observations: [] })),
            transform: (current) => ({
              ...current,
              observations: current.observations.filter((observation) => !consumedIds.has(observation.id))
            })
          });
        }

        for (const entry of result.historyEntries) {
          await appendStageManagerHistory(this.options.storage, {
            ...entry,
            guildId,
            observationCount: chunk.observations.length
          });
        }
        void sendDreamDebugLog(this.options, { guildId, entries: result.historyEntries });

        processedKeys.add(chunk.key);
        await this.writeDreamCursor(guildId, chunk.key);
        totalApplied += result.applied;
        totalSkipped += result.skipped;
        chunksProcessed += 1;
        this.options.logger.info("Dream pass chunk finished", {
          guildId,
          iteration,
          chunkKey: chunk.key,
          applied: result.applied,
          skipped: result.skipped
        });
      }
    } catch (error) {
      this.options.logger.error("Dream pass failed", {
        guildId,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof GatewayPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
      });
      return {
        status: "failed",
        applied: totalApplied,
        skipped: totalSkipped,
        chunks: chunksProcessed,
        message: error instanceof Error ? error.message : "Dream pass failed."
      };
    }

    return {
      status: totalApplied > 0 ? "updated" : "no_change",
      applied: totalApplied,
      skipped: totalSkipped,
      chunks: chunksProcessed
    };
  }

  private async readDreamCursors() {
    return this.options.storage.readJson(
      DREAM_CURSOR_RELATIVE_PATH,
      DreamCursorFileSchema,
      DreamCursorFileSchema.parse(createEmptyRevisionedFile({ cursors: {} }))
    );
  }

  private async writeDreamCursor(guildId: string, key: string): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "memory:dream-cursor",
      relativePath: DREAM_CURSOR_RELATIVE_PATH,
      schema: DreamCursorFileSchema,
      fallback: DreamCursorFileSchema.parse(createEmptyRevisionedFile({ cursors: {} })),
      transform: (current) => ({ ...current, cursors: { ...current.cursors, [guildId]: key } })
    });
  }

  private async readPendingObservations(): Promise<{ observations: PendingObservation[] }> {
    return this.options.storage.readJson(
      "user/memory/pending-observations.json",
      PendingObservationsFileSchema,
      PendingObservationsFileSchema.parse(createEmptyRevisionedFile({ observations: [] }))
    );
  }

  clearStageManagerTimers(guildId: string, channelId: string): void {
    const key = timerKey(guildId, channelId);
    const schedule = this.stageManagerSchedules.get(key);
    if (!schedule) return;
    if (schedule.idleTimer) {
      clearTimeout(schedule.idleTimer);
    }
    this.stageManagerSchedules.delete(key);
  }

  clearAllStageManagerTimers(): void {
    for (const schedule of this.stageManagerSchedules.values()) {
      if (schedule.idleTimer) {
        clearTimeout(schedule.idleTimer);
      }
    }
    this.stageManagerSchedules.clear();
  }
}

// Next DREAM_HOUR_LOCAL fire time for a guild's dream pass, with deterministic ±15 min jitter.
function msUntilNextDreamRun(guildId: string, now: Date): number {
  const jitterMinutes = (guildHash(guildId) % 30) - 15;
  const next = new Date(now);
  next.setHours(DREAM_HOUR_LOCAL, 0, 0, 0);
  next.setMinutes(next.getMinutes() + jitterMinutes);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(0, next.getTime() - now.getTime());
}

// Fold the observer (stage-manager) run and the dream pass into a single result for the manual
// /memories trigger. Status reflects whether either step changed the store.
function combineStageAndDream(observer: StageManagerRunResult, dream: DreamPassResult): StageManagerRunResult {
  const observerChanged = observer.status === "updated";
  const dreamChanged = dream.status === "updated";
  const failed = observer.status === "failed" || dream.status === "failed";
  const observerNote = observer.status === "updated"
    ? "observer fast-tracked and queued observations"
    : observer.status === "no_change"
      ? "observer found nothing new"
      : observer.message ?? observer.status;
  const dreamNote = dream.status === "failed"
    ? dream.message ?? "dream pass failed"
    : dream.status === "already_running"
      ? dream.message ?? "dream pass already running"
      : `dream pass applied ${dream.applied}, skipped ${dream.skipped} across ${dream.chunks} chunk${dream.chunks === 1 ? "" : "s"}`;
  const message = `Observer + dream pass: ${observerNote}; ${dreamNote}.`;
  if (failed) {
    return { status: "failed", message };
  }
  return { status: observerChanged || dreamChanged ? "updated" : "no_change", message };
}
