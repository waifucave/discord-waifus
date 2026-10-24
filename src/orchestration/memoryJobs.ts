// Memory background work: the per-conversation stage-manager observer (idle-scheduled, cursor
// based) and the ONE global nightly dream consolidation pass (waifus round-robin from a persisted
// cursor, budget DREAM_CHUNKS_PER_NIGHT), plus the manual /memories trigger that runs both.

import { randomUUID } from "node:crypto";
import { GatewayPipelineError } from "./pipeline/params.js";
import type { PendingObservation } from "../shared/schemas/domain.js";
import {
  DREAM_CHUNKS_PER_NIGHT,
  DREAM_CURSOR_RELATIVE_PATH,
  DreamCursorFileSchema,
  type DreamHistoryEntry,
  applyDreamOps,
  buildWaifuDreamChunks,
  dreamChunkWaifuIds,
  dreamWaifuOrder
} from "./dream.js";
import { createEmptyRevisionedFile } from "../shared/schemas/domain.js";
import { nowIso } from "../shared/schemas/common.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { sendDreamDebugLog, sendStageManagerDebugLog } from "./debugLog.js";
import { ModelAccess } from "./modelAccess.js";
import {
  type DreamPassResult,
  type RuntimeHooks,
  type RuntimeOrchestratorOptions,
  type RuntimeServices,
  type StageManagerRunResult,
  summarizeProviderPipelineDetails,
  timerKey
} from "./runtimeShared.js";
import { ensureServer, listAvailableWaifusForChannel, listWaifus, readAgentConfig, readDiscordBotsFile } from "./stores/config.js";
import { appendStageManagerHistory } from "./stores/decisionHistory.js";
import {
  readMemoryStore,
  readPendingObservations,
  updateMemoryStore,
  updatePendingObservations
} from "./stores/memories.js";
import { ensureChannelSession } from "./stores/sessions.js";
import { resolveContextCap } from "./contextWindows.js";
import { type ConversationRef, conversationKey } from "./context/keys.js";
import { loadSubjectDirectory, subjectNameResolver } from "./memorySubjects.js";
import {
  type ApplyObserverOpsResult,
  applyObserverOps,
  existingMemoriesFor,
  ledgerEntriesAfterCursor,
  observerParticipants,
  readConversationLedger,
  renderObserverInput,
  windowEntries,
  windowMessagesAfterCursor
} from "./observer.js";
import { type ObserverCursor, advanceObserverCursor, readObserverCursor } from "./observerCursor.js";
import { parseRawObserverOps } from "./tools.js";
import type { LedgerEntry } from "../shared/schemas/context.js";
import type { ContextMessage } from "./contextMessages.js";

// Default hour of the day (local time, 0-23) for the nightly dream pass (`memory.dreamHourLocal`).
const DEFAULT_DREAM_HOUR_LOCAL = 5;
const GLOBAL_DREAM_TIMER = "global";
// requestObserveThrough reads the backlog in cap-sized batches; bound the catch-up loop.
const OBSERVE_THROUGH_MAX_ROUNDS = 10;

type StageManagerSchedule = {
  idleTimer?: NodeJS.Timeout;
};

export type MemoryJobHooks = RuntimeHooks & {
  /** True while a channel run is active for the guild. */
  isGuildRunActive(guildId: string): boolean;
  /** True while any channel run is active (the global dream defers behind it). */
  isAnyRunActive?(): boolean;
};

export type DreamRunScope = {
  /** Manual runs (/memories) dream only these waifus and never move the nightly cursor. */
  waifuIds?: string[];
};

export class MemoryJobs {
  private readonly stageManagerSchedules = new Map<string, StageManagerSchedule>();
  readonly activeStageManagerRuns = new Set<Promise<StageManagerRunResult>>();
  // guildId:channelId → observer run in flight (in-memory so a crash can never leave it stuck).
  private readonly activeStageManagerChannels = new Map<string, Promise<StageManagerRunResult>>();
  // conversation key → DM observer run in flight (spec 9.1 step 8).
  private readonly activeDmObservers = new Map<string, Promise<StageManagerRunResult>>();
  // The single global dream timer (key "global"; also holds the defer chain) — a Map so
  // stop()/pause() clear it like any other timer.
  readonly dreamTimers = new Map<string, NodeJS.Timeout>();
  readonly activeDreamRuns = new Set<Promise<DreamPassResult>>();
  // Global reentrancy guard: two concurrent passes would double-drain the observation queue.
  private dreaming: Promise<DreamPassResult> | undefined;
  private static readonly STAGE_MANAGER_IDLE_DELAY_MS = 60 * 60 * 1000;
  // When a channel run is active at dream time we defer 15 min, up to 8 times, then run anyway.
  private static readonly DREAM_DEFER_DELAY_MS = 15 * 60 * 1000;
  private static readonly DREAM_MAX_DEFERS = 8;
  private readonly stageManagerIdleDelayMs: number;

  constructor(
    private readonly options: RuntimeServices & Pick<RuntimeOrchestratorOptions, "memory">,
    private readonly models: ModelAccess,
    private readonly hooks: MemoryJobHooks,
    stageManagerIdleDelayMs?: number
  ) {
    this.stageManagerIdleDelayMs = stageManagerIdleDelayMs ?? MemoryJobs.STAGE_MANAGER_IDLE_DELAY_MS;
  }

  private get dreamHourLocal(): number {
    return this.options.memory?.dreamHourLocal ?? DEFAULT_DREAM_HOUR_LOCAL;
  }

  private get dreamChunkBudget(): number {
    return this.options.memory?.dreamChunksPerNight ?? DREAM_CHUNKS_PER_NIGHT;
  }

  async triggerStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    // Manual trigger (/memories or the dashboard): run the channel observer, then a global dream
    // run for the waifus enabled there, folding both into a single status the caller reports.
    const observer = await this.startStageManagerRun(guildId, channelId);
    if (observer.status === "already_running" || observer.status === "disabled") {
      return observer;
    }
    let dream: DreamPassResult;
    try {
      const server = await ensureServer(this.options.storage, guildId);
      const channel = server.channels[channelId];
      const waifuIds = channel ? (await listAvailableWaifusForChannel(this.options.storage, channel)).map((waifu) => waifu.id) : [];
      dream = await this.startDreamRun({ waifuIds });
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

  /**
   * Compaction handoff (spec 8.9): resolve once the stage-manager observer of `conversation`
   * has read the ledger through `seq` (running it now, in cursor-bounded batches, if needed).
   * Never rejects; a disabled/failed observer simply stops the catch-up. DM conversations use the
   * DM observer (no per-server flags).
   */
  async requestObserveThrough(conversation: ConversationRef, seq: number): Promise<void> {
    if (conversation.kind === "dm") {
      try {
        for (let round = 0; round < OBSERVE_THROUGH_MAX_ROUNDS; round += 1) {
          await this.activeDmObservers.get(conversationKey(conversation))?.catch(() => undefined);
          const before = await readObserverCursor(this.options.storage, conversation);
          if (before.cursorSeq !== null && before.cursorSeq >= seq) return;
          const result = await this.startDmObserverRun(conversation);
          if (result.status === "disabled" || result.status === "failed") return;
          if (result.status === "already_running") continue;
          const after = await readObserverCursor(this.options.storage, conversation);
          if (after.cursorSeq === before.cursorSeq) return;
        }
      } catch (error) {
        this.options.logger.warn("DM observer catch-up before compaction failed", {
          waifuId: conversation.waifuId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    const { guildId, channelId } = conversation;
    try {
      for (let round = 0; round < OBSERVE_THROUGH_MAX_ROUNDS; round += 1) {
        await this.activeStageManagerChannels.get(timerKey(guildId, channelId))?.catch(() => undefined);
        const before = await readObserverCursor(this.options.storage, conversation);
        if (before.cursorSeq !== null && before.cursorSeq >= seq) return;
        const result = await this.startStageManagerRun(guildId, channelId);
        if (result.status === "disabled" || result.status === "failed") return;
        if (result.status === "already_running") continue;
        const after = await readObserverCursor(this.options.storage, conversation);
        if (after.cursorSeq === before.cursorSeq) return; // no ledger progress possible
      }
    } catch (error) {
      this.options.logger.warn("Observer catch-up before compaction failed", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async loadObserverTranscript(
    conversation: Extract<ConversationRef, { kind: "guild" }>,
    cursor: ObserverCursor,
    cap: number,
    model: { providerId?: string; modelId: string }
  ): Promise<{ entries: LedgerEntry[]; messages: ContextMessage[]; next: ObserverCursor }> {
    const ledger = await readConversationLedger(this.options.storage, conversation);
    if (ledger && Object.keys(ledger.entries).length > 0) {
      const batch = ledgerEntriesAfterCursor(Object.values(ledger.entries), cursor, cap);
      return { entries: batch.entries, messages: [], next: batch.next };
    }
    // Legacy path until the context engine writes ledgers: the fresh Discord window, filtered to
    // messages newer than the cursor message id.
    const fetched = await this.options.discord.fetchFreshContext({
      guildId: conversation.guildId,
      channelId: conversation.channelId,
      limit: cap
    });
    const fresh = windowMessagesAfterCursor(fetched, cursor);
    const messages = await this.models.messagesForModel(fresh.messages, model);
    return { entries: windowEntries(messages), messages, next: fresh.next };
  }

  private async runStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    {
      // Per-guild kill switch: observers stay off for this server (the global dream does not).
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
    const conversation = { kind: "guild" as const, guildId, channelId };
    const key = conversationKey(conversation);
    const cursor = await readObserverCursor(this.options.storage, conversation);
    const transcript = await this.loadObserverTranscript(
      conversation,
      cursor,
      resolveContextCap("stageManager", server, config),
      { providerId: config.providerId, modelId: config.modelId }
    );

    if (transcript.entries.length === 0) {
      // Nothing new since the last read: never re-read, never call the model.
      await advanceObserverCursor(this.options.storage, conversation, transcript.next);
      this.options.logger.info("Stage manager observer skipped: nothing new since its cursor", { guildId, channelId });
      return { status: "no_change", message: "No new messages since the last observer run." };
    }

    const [bots, waifus, store, directory] = await Promise.all([
      readDiscordBotsFile(this.options.storage),
      listWaifus(this.options.storage),
      readMemoryStore(this.options.storage),
      loadSubjectDirectory(this.options.storage, guildId)
    ]);
    const waifuByAuthor = new Map<string, string>();
    for (const waifu of waifus) {
      for (const id of resolveBotAuthorIds(waifu.botId, bots)) waifuByAuthor.set(id, waifu.id);
    }
    const participants = observerParticipants(transcript.entries, (authorId) => waifuByAuthor.get(authorId));
    const now = new Date();
    // DM-origin memories never reach a server observer (it could rewrite or merge them into guild records).
    const existing = existingMemoriesFor(store.memories.filter((record) => !record.origin.dm), { allowedWaifuIds, participants, now });
    const input = renderObserverInput({
      participants,
      memories: existing,
      entries: transcript.entries,
      nameFor: subjectNameResolver([directory])
    });

    this.options.logger.info("Stage manager observer started", {
      guildId,
      channelId,
      modelId: config.modelId,
      contextMessages: transcript.entries.length,
      existingMemories: existing.length
    });
    const rawOps = await pipeline.decideStageManagerObservations({
      modelId: config.modelId,
      messages: transcript.messages,
      observerInput: input.text,
      // B28: the stage manager's custom prompt is prepended to the observer instruction.
      ...(config.prompt.trim() ? { systemPrompt: config.prompt } : {}),
      availableWaifuIds: allowedWaifuIds,
      params: config.params
    });
    const ops = parseRawObserverOps(rawOps as unknown[]);
    const applyContext = {
      handles: input.handles,
      memoryHandles: input.memoryHandles,
      allowedWaifuIds,
      origin: { guildId, channelId },
      conversationKey: key
    };

    let result: ApplyObserverOpsResult = { memories: [], queued: [], history: [], applied: 0, skipped: 0 };
    const immediate = ops.filter((op) => op.op !== "add" || op.importance >= 4);
    if (immediate.length > 0) {
      await updateMemoryStore(this.options.storage, (current) => {
        result = applyObserverOps(current.memories, ops, { ...applyContext, now });
        return { ...current, memories: result.memories };
      });
    } else {
      result = applyObserverOps(store.memories, ops, { ...applyContext, now });
    }
    if (result.queued.length > 0) {
      const queued = result.queued;
      await updatePendingObservations(this.options.storage, (current) => ({
        ...current,
        observations: [...current.observations, ...queued]
      }));
    }
    // Advance only after the ops landed, so a failed run re-reads the same messages.
    await advanceObserverCursor(this.options.storage, conversation, transcript.next, now);

    const unknownOwner = ops.filter((op) => op.op === "add" && !allowedWaifuIds.includes(op.waifuId)).length;
    this.options.logger.info("Stage manager observer finished", {
      guildId,
      channelId,
      ops: ops.length,
      applied: result.applied,
      queued: result.queued.length,
      skipped: result.skipped
    });

    const nowTs = nowIso();
    const entries = [];
    for (const item of result.history) {
      entries.push({ id: randomUUID(), guildId, channelId, ...item, observationCount: ops.length, createdAt: nowTs });
    }
    const fastTracked = result.history.filter((item) => item.tool === "add_memory").length;
    const edits = result.history.filter((item) => item.tool !== "add_memory" && item.tool !== "no_change").length;
    entries.push({
      id: randomUUID(),
      guildId,
      channelId,
      tool: "no_change" as const,
      affectedMemoryIds: [] as string[],
      summary:
        ops.length === 0
          ? "No observations extracted"
          : unknownOwner === ops.length
            ? `Dropped ${ops.length} observation(s) with unknown waifu ids`
            : `queued: ${result.queued.length}, fastTracked: ${fastTracked}, edits: ${edits}`,
      observationCount: ops.length,
      createdAt: nowTs
    });
    for (const entry of entries) {
      await appendStageManagerHistory(this.options.storage, entry);
    }
    void sendStageManagerDebugLog(this.options, { guildId, channelId, entries, observationCount: ops.length });
    return { status: result.applied > 0 ? "updated" : "no_change" };
  }

  /**
   * DM observer scheduling (spec 9.1 step 8): the same idle delay as channels; DM observers ignore
   * every per-server flag (there is no server).
   */
  noteDmActivity(conversation: Extract<ConversationRef, { kind: "dm" }>): void {
    const key = `dm:${conversationKey(conversation)}`;
    const schedule = this.stageManagerSchedules.get(key) ?? {};
    this.stageManagerSchedules.set(key, schedule);
    if (schedule.idleTimer) clearTimeout(schedule.idleTimer);
    schedule.idleTimer = setTimeout(() => {
      const current = this.stageManagerSchedules.get(key);
      if (!current) return;
      current.idleTimer = undefined;
      this.stageManagerSchedules.delete(key);
      this.hooks.runBackground("Scheduled DM observer run failed", { waifuId: conversation.waifuId }, () =>
        this.startDmObserverRun(conversation)
      );
    }, this.stageManagerIdleDelayMs);
    schedule.idleTimer.unref?.();
  }

  /** DM forget: cancel the conversation's idle observer and wait for a run in flight. */
  async quiesceDmObserver(conversation: Extract<ConversationRef, { kind: "dm" }>): Promise<void> {
    const timerKey = `dm:${conversationKey(conversation)}`;
    const schedule = this.stageManagerSchedules.get(timerKey);
    if (schedule?.idleTimer) clearTimeout(schedule.idleTimer);
    this.stageManagerSchedules.delete(timerKey);
    await this.activeDmObservers.get(conversationKey(conversation))?.catch(() => undefined);
  }

  startDmObserverRun(conversation: Extract<ConversationRef, { kind: "dm" }>): Promise<StageManagerRunResult> {
    const key = conversationKey(conversation);
    if (this.activeDmObservers.has(key)) return Promise.resolve({ status: "already_running" });
    const promise = this.runDmObserver(conversation).catch((error: unknown): StageManagerRunResult => {
      this.options.logger.error("DM observer failed", {
        waifuId: conversation.waifuId,
        message: error instanceof Error ? error.message : String(error)
      });
      return { status: "failed", message: error instanceof Error ? error.message : "DM observer failed." };
    });
    this.activeDmObservers.set(key, promise);
    this.activeStageManagerRuns.add(promise);
    void promise.finally(() => {
      this.activeStageManagerRuns.delete(promise);
      if (this.activeDmObservers.get(key) === promise) this.activeDmObservers.delete(key);
    });
    return promise;
  }

  /** The observer over one DM ledger: memories get `origin: { dm: true }` and belong to her only. */
  private async runDmObserver(conversation: Extract<ConversationRef, { kind: "dm" }>): Promise<StageManagerRunResult> {
    const config = await readAgentConfig(this.options.storage, "stage-manager", 80);
    if (!config.enabled || !config.modelId) return { status: "disabled" };
    const pipeline = this.models.pipelineFor({ providerId: config.providerId, modelId: config.modelId }, "stage_manager_observer");
    if (!pipeline.decideStageManagerObservations) {
      throw new Error(`Model ${config.modelId} does not implement observer decisions.`);
    }
    const allowedWaifuIds = [conversation.waifuId];
    const cursor = await readObserverCursor(this.options.storage, conversation);
    const ledger = await readConversationLedger(this.options.storage, conversation);
    const batch = ledger
      ? ledgerEntriesAfterCursor(Object.values(ledger.entries), cursor, resolveContextCap("stageManager", undefined, config))
      : { entries: [] as LedgerEntry[], next: cursor };
    if (batch.entries.length === 0) {
      await advanceObserverCursor(this.options.storage, conversation, batch.next);
      return { status: "no_change", message: "No new messages since the last observer run." };
    }
    const [bots, waifus, store, directory] = await Promise.all([
      readDiscordBotsFile(this.options.storage),
      listWaifus(this.options.storage),
      readMemoryStore(this.options.storage),
      loadSubjectDirectory(this.options.storage)
    ]);
    const waifuByAuthor = new Map<string, string>();
    for (const waifu of waifus) {
      for (const id of resolveBotAuthorIds(waifu.botId, bots)) waifuByAuthor.set(id, waifu.id);
    }
    const participants = observerParticipants(batch.entries, (authorId) => waifuByAuthor.get(authorId));
    const now = new Date();
    // Only this user's DM-origin memories: the DM observer may never rewrite a server memory with
    // private content (or another user's DM).
    const existing = existingMemoriesFor(
      store.memories.filter((record) => record.origin.dm === true && record.origin.userId === conversation.userId),
      { allowedWaifuIds, participants, now }
    );
    const input = renderObserverInput({ participants, memories: existing, entries: batch.entries, nameFor: subjectNameResolver([directory]) });
    const rawOps = await pipeline.decideStageManagerObservations({
      modelId: config.modelId,
      messages: [],
      observerInput: input.text,
      ...(config.prompt.trim() ? { systemPrompt: config.prompt } : {}),
      availableWaifuIds: allowedWaifuIds,
      params: config.params
    });
    const ops = parseRawObserverOps(rawOps as unknown[]);
    const applyContext = {
      handles: input.handles,
      memoryHandles: input.memoryHandles,
      allowedWaifuIds,
      origin: { dm: true as const, userId: conversation.userId },
      conversationKey: conversationKey(conversation)
    };
    let result: ApplyObserverOpsResult = { memories: [], queued: [], history: [], applied: 0, skipped: 0 };
    if (ops.some((op) => op.op !== "add" || op.importance >= 4)) {
      await updateMemoryStore(this.options.storage, (current) => {
        result = applyObserverOps(current.memories, ops, { ...applyContext, now });
        return { ...current, memories: result.memories };
      });
    } else {
      result = applyObserverOps(store.memories, ops, { ...applyContext, now });
    }
    if (result.queued.length > 0) {
      const queued = result.queued;
      await updatePendingObservations(this.options.storage, (current) => ({ ...current, observations: [...current.observations, ...queued] }));
    }
    await advanceObserverCursor(this.options.storage, conversation, batch.next, now);
    // DM outcomes are not routed to debug channels or the guild observer history (spec 9.1.3).
    this.options.logger.info("DM observer finished", {
      waifuId: conversation.waifuId,
      ops: ops.length,
      applied: result.applied,
      queued: result.queued.length
    });
    return { status: result.applied > 0 ? "updated" : "no_change" };
  }

  startStageManagerRun(guildId: string, channelId: string): Promise<StageManagerRunResult> {
    const key = timerKey(guildId, channelId);
    if (this.activeStageManagerChannels.has(key)) {
      return Promise.resolve({ status: "already_running" });
    }
    const promise = this.runStageManager(guildId, channelId).catch((error: unknown): StageManagerRunResult => {
      this.options.logger.error("Stage manager failed", {
        guildId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof GatewayPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
      });
      return { status: "failed", message: error instanceof Error ? error.message : "Stage manager failed." };
    });
    this.activeStageManagerChannels.set(key, promise);
    this.activeStageManagerRuns.add(promise);
    void promise.finally(() => {
      this.activeStageManagerRuns.delete(promise);
      if (this.activeStageManagerChannels.get(key) === promise) this.activeStageManagerChannels.delete(key);
    });
    return promise;
  }

  // Arm the single global dream timer (spec 8.8). Kept async for the runtime's start sequence.
  async scheduleDreamRuns(): Promise<void> {
    this.armDreamTimer();
  }

  // Next `memory.dreamHourLocal` fire time; re-armed after each run. If a channel run is active
  // when the timer fires, defer 15 min up to 8 times, then run anyway.
  armDreamTimer(deferCount = 0): void {
    const delay = deferCount > 0 ? MemoryJobs.DREAM_DEFER_DELAY_MS : msUntilNextDreamRun(this.dreamHourLocal, new Date());
    const existing = this.dreamTimers.get(GLOBAL_DREAM_TIMER);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.dreamTimers.delete(GLOBAL_DREAM_TIMER);
      if (this.options.isPaused?.()) {
        this.armDreamTimer();
        return;
      }
      const active = this.hooks.isAnyRunActive?.() ?? false;
      if (active && deferCount < MemoryJobs.DREAM_MAX_DEFERS) {
        this.armDreamTimer(deferCount + 1);
        return;
      }
      this.hooks.runBackground("Scheduled dream pass failed", {}, async () => {
        try {
          await this.startDreamRun();
        } finally {
          // Re-arm for the next day regardless of outcome.
          this.armDreamTimer();
        }
      });
    }, delay);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.dreamTimers.set(GLOBAL_DREAM_TIMER, timer);
  }

  clearAllDreamTimers(): void {
    for (const timer of this.dreamTimers.values()) {
      clearTimeout(timer);
    }
    this.dreamTimers.clear();
  }

  startDreamRun(scope: DreamRunScope = {}): Promise<DreamPassResult> {
    if (this.dreaming) {
      this.options.logger.info("Dream pass already running, skipping duplicate run");
      return Promise.resolve({ status: "already_running", applied: 0, skipped: 0, chunks: 0, message: "Dream pass already running." });
    }
    const promise = this.runDreamPass(scope).finally(() => {
      this.dreaming = undefined;
    });
    this.dreaming = promise;
    this.activeDreamRuns.add(promise);
    void promise
      .finally(() => {
        this.activeDreamRuns.delete(promise);
      })
      .catch((error) => {
        this.options.logger.error("Dream pass run failed outside handler", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return promise;
  }

  // The global consolidation pass. Waifus are visited once each, round-robin from the persisted
  // cursor (nightly) or in the given order (manual); each waifu's chunks run SEQUENTIALLY and
  // their ops are applied by record id inside one revisioned store update, so concurrent writers
  // are never clobbered. At most `dreamChunkBudget` model calls per pass. Per-server
  // `stageManagerEnabled` does not gate the dream (it gates observers only).
  private async runDreamPass(scope: DreamRunScope): Promise<DreamPassResult> {
    const config = await readAgentConfig(this.options.storage, "stage-manager", 80);
    if (!config.enabled || !config.modelId) {
      return { status: "disabled", applied: 0, skipped: 0, chunks: 0 };
    }
    const pipeline = this.models.pipelineFor(
      { providerId: config.providerId, modelId: config.modelId },
      "dream"
    );
    // Configured waifus: a hallucinated or deleted owner never lands.
    const waifus = await listWaifus(this.options.storage);
    const configuredWaifuIds = new Set(waifus.map((waifu) => waifu.id));
    const nightly = scope.waifuIds === undefined;
    const cursorFile = nightly ? await this.readDreamCursor() : undefined;
    const resume = cursorFile?.resume && configuredWaifuIds.has(cursorFile.resume.waifuId) ? cursorFile.resume : null;
    let order = nightly
      ? dreamWaifuOrder(configuredWaifuIds, cursorFile?.cursor)
      : [...new Set(scope.waifuIds)].filter((waifuId) => configuredWaifuIds.has(waifuId));
    if (resume) {
      // Continue the waifu the last night stopped inside, then the round-robin after her.
      const at = order.indexOf(resume.waifuId);
      order = [...order.slice(at), ...order.slice(0, at)];
    }
    const directory = await loadSubjectDirectory(this.options.storage);
    const nameFor = subjectNameResolver([directory]);

    let totalApplied = 0;
    let totalSkipped = 0;
    let chunksProcessed = 0;

    try {
      waifuLoop: for (const waifuId of order) {
        const [store, pending] = await Promise.all([
          readMemoryStore(this.options.storage),
          readPendingObservations(this.options.storage)
        ]);
        const allChunks = buildWaifuDreamChunks(waifuId, store.memories, pending.observations, new Date(), { nameFor });
        const firstChunk = resume && resume.waifuId === waifuId ? resume.chunkIndex : 0;
        const chunks = allChunks.slice(firstChunk);
        for (const [offset, chunk] of chunks.entries()) {
          if (chunksProcessed >= this.dreamChunkBudget) break waifuLoop;
          // Only require the dream capability once there is real work; an empty cast needs no call.
          if (!pipeline.decideDream) {
            throw new Error(`Model ${config.modelId} does not implement dream decisions.`);
          }
          // Per-chunk ownership: "add" ops may only target the waifu this chunk is about.
          const allowedWaifuIds = dreamChunkWaifuIds(chunk).filter((id) => configuredWaifuIds.has(id));
          this.options.logger.info("Dream pass chunk started", {
            waifuId,
            chunkKey: chunk.key,
            modelId: config.modelId,
            memories: chunk.inputs.length,
            observations: chunk.observations.length
          });
          const ops = await pipeline.decideDream({
            modelId: config.modelId,
            messages: [],
            memories: chunk.inputs,
            observations: chunk.observations,
            availableWaifuIds: allowedWaifuIds,
            // B28: the stage manager's custom prompt reaches the dream as <owner_policy> too.
            ...(config.prompt.trim() ? { systemPrompt: config.prompt } : {}),
            params: config.params
          });
          const now = new Date();
          let historyEntries: DreamHistoryEntry[] = [];
          let applied = 0;
          let skipped = 0;
          await updateMemoryStore(this.options.storage, (current) => {
            const result = applyDreamOps(current.memories, ops, chunk.indexMap, {
              now,
              allowedWaifuIds,
              observations: chunk.observations
            });
            historyEntries = result.historyEntries;
            applied = result.applied;
            skipped = result.skipped;
            return { ...current, memories: result.memories };
          });

          // Clear exactly this chunk's consumed observations from the queue.
          const consumedIds = new Set(chunk.observations.map((observation) => observation.id));
          if (consumedIds.size > 0) {
            await updatePendingObservations(this.options.storage, (current) => ({
              ...current,
              observations: current.observations.filter((observation) => !consumedIds.has(observation.id))
            }));
          }

          for (const guildId of chunkGuildIds(chunk.observations, store.memories, chunk.indexMap)) {
            void sendDreamDebugLog(this.options, { guildId, entries: historyEntries });
          }
          for (const entry of historyEntries) {
            await appendStageManagerHistory(this.options.storage, { ...entry, observationCount: chunk.observations.length });
          }
          totalApplied += applied;
          totalSkipped += skipped;
          chunksProcessed += 1;
          this.options.logger.info("Dream pass chunk finished", { waifuId, chunkKey: chunk.key, applied, skipped });
          const nextChunk = firstChunk + offset + 1;
          // Persist progress inside a large waifu so a spent budget (or a failure) resumes here.
          if (nightly && nextChunk < allChunks.length) await this.writeDreamCursor({ resume: { waifuId, chunkIndex: nextChunk } });
        }
        // Every chunk of this waifu is done: the next night starts after her.
        if (nightly) await this.writeDreamCursor({ cursor: waifuId, resume: null });
      }
    } catch (error) {
      this.options.logger.error("Dream pass failed", {
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

  private async readDreamCursor() {
    return this.options.storage.readJson(
      DREAM_CURSOR_RELATIVE_PATH,
      DreamCursorFileSchema,
      DreamCursorFileSchema.parse(createEmptyRevisionedFile({ cursor: null }))
    );
  }

  private async writeDreamCursor(patch: { cursor?: string; resume: { waifuId: string; chunkIndex: number } | null }): Promise<void> {
    await this.options.storage.updateRevisionedJson({
      resourceKey: "memory:dream-cursor",
      relativePath: DREAM_CURSOR_RELATIVE_PATH,
      schema: DreamCursorFileSchema,
      fallback: DreamCursorFileSchema.parse(createEmptyRevisionedFile({ cursor: null })),
      transform: (current) => ({ ...current, ...patch })
    });
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

// Guilds a dream chunk's material came from (debug-log routing only).
function chunkGuildIds(
  observations: PendingObservation[],
  memories: Array<{ id: string; origin: { guildId?: string } }>,
  indexMap: Map<number, string>
): string[] {
  const ids = new Set(indexMap.values());
  return [
    ...new Set(
      [
        ...observations.map((observation) => observation.origin?.guildId),
        ...memories.filter((memory) => ids.has(memory.id)).map((memory) => memory.origin.guildId)
      ].filter((guildId): guildId is string => Boolean(guildId))
    )
  ];
}

// Milliseconds until the next `hour`:00 local time.
export function msUntilNextDreamRun(hour: number, now: Date): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
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
    ? "observer recorded memories"
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
