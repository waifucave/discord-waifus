// A waifu's life over HTTP (Living cast spec §14.1): status, the life log, owner wakes, a manual
// compaction, a reset of her short-term memory and the forget review lines. Waifu ids are checked
// with assertSafeId before any path is built.
//
// DM content (D14) stays out of every response unless the request says `includePrivate=1`, which is
// honoured only for local requests (the host's own dashboard or CLI): a paired remote device and the
// dashboard assistant get a 403 explaining why. What counts as DM content is in src/life/lifeView.ts.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { availabilityAt, DEFAULT_BED_CONTEXT } from "../life/clock.js";
import { dayPlanOf } from "../life/home/index.js";
import { dismissNeedsReview, readNeedsReview, withoutPrivateReview } from "../life/forget.js";
import { listLogEpochs, readLifeFile, readLifeLog, readLifeState } from "../life/lifeStore.js";
import { scanDmContent, viewLogLine } from "../life/lifeView.js";
import { LifeActionError, type LivingCast } from "../life/livingCast.js";
import { queueOwnerWakeOffline } from "../life/wakeQueue.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { readPendingScrubs } from "../orchestration/dm/forgotten.js";
import { readWaifu } from "../orchestration/stores/config.js";
import { todayUsage } from "../orchestration/usageReport.js";
import { LifeResetBodySchema, WakeBodySchema } from "../shared/schemas/api.js";
import type { Wake } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { ApiError, conflict, notFound } from "./errors.js";
import { assertSafeId } from "./ids.js";
import { localDayKey } from "../life/clock.js";

export type LifeRouteOptions = {
  storage: StorageService;
  /** The live Living cast (absent while Discord is offline). */
  cast: () => LivingCast | undefined;
  isPaused: () => boolean;
  now?: () => Date;
  timeZone?: string;
  /** The bed time settings (§21.6c: `life.busyEngagedMinutes`, `life.bedDozeMinutes`); defaults without it. */
  bedSettings?: () => Promise<{ busyEngagedMinutes: number; bedDozeMinutes: number }>;
};

const LOG_DEFAULT_LIMIT = 50;
const LOG_MAX_LIMIT = 200;
/** How long a compact request waits for the summary before answering `running`. */
const COMPACT_WAIT_MS = 10_000;

/** `includePrivate=1`: local requests only; never for a remote device or the dashboard assistant. */
export function includePrivateOf(request: FastifyRequest): boolean {
  const raw = (request.query as Record<string, unknown> | undefined)?.["includePrivate"];
  const asked = raw === "1" || raw === "true";
  if (!asked) return false;
  if (request.principal.kind !== "local") {
    throw new ApiError(
      403,
      "DM content is only shown on the host itself (D14). Open the dashboard on that computer to reveal it.",
      undefined,
      "PrivateContentLocalOnly"
    );
  }
  if (request.assistantDelegation) {
    throw new ApiError(403, "DM content never goes to the dashboard assistant.", undefined, "PrivateContentLocalOnly");
  }
  return true;
}

function waifuIdOf(params: unknown): string {
  const { waifuId } = z.object({ waifuId: z.string().min(1) }).parse(params);
  assertSafeId(waifuId);
  return waifuId;
}

async function existingWaifu(storage: StorageService, waifuId: string) {
  try {
    return await readWaifu(storage, waifuId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(`Waifu ${waifuId} was not found.`);
    throw error;
  }
}

function isDmKey(placeKey: string | undefined): boolean {
  return placeKey?.startsWith("dm_") === true;
}

/** A queued wake for the owner: DM previews, matched words and notes only with `includePrivate`. */
function wakeView(wake: Wake, includePrivate: boolean) {
  const dm = isDmKey(wake.placeKey) || wake.reason === "dm" || wake.dm === true;
  const hide = dm && !includePrivate;
  return {
    id: wake.id,
    reason: wake.reason,
    ...(wake.reasons ? { reasons: wake.reasons } : {}),
    ...(wake.placeKey ? { place: wake.placeKey } : {}),
    ...(wake.fromName ? { from: wake.fromName } : {}),
    ...(wake.preview !== undefined && !hide ? { preview: wake.preview } : {}),
    ...(wake.note !== undefined && (!hide || wake.reason === "owner") ? { note: wake.note } : {}),
    ...(dm ? { dm: true } : {}),
    ...(wake.count ? { count: wake.count } : {}),
    at: wake.at
  };
}

export function registerLifeRoutes(app: FastifyInstance, o: LifeRouteOptions): void {
  const now = () => o.now?.() ?? new Date();
  const timeZone = () => o.timeZone ?? hostTimeZone();

  app.get("/api/waifus/:waifuId/life", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const waifu = await existingWaifu(o.storage, waifuId);
    const at = now();
    const zone = timeZone();
    const [state, queue, usage, today, review, scrubs] = await Promise.all([
      readLifeState(o.storage, waifuId, at),
      readLifeFile(o.storage, waifuId, "wakes"),
      readLifeFile(o.storage, waifuId, "usage"),
      todayUsage(o.storage.dataRoot, waifuId, at, zone),
      readNeedsReview(o.storage, waifuId),
      readPendingScrubs(o.storage, waifuId, { logger: { warn: () => undefined } }).catch(() => [])
    ]);
    const lines = await readLifeLog(o.storage, waifuId, state.epoch);
    const settings = await o.bedSettings?.().catch(() => undefined);
    const bed = settings ? { engagedMinutes: settings.busyEngagedMinutes, dozeMinutes: settings.bedDozeMinutes } : DEFAULT_BED_CONTEXT;
    const availability = availabilityAt(waifu.availability, at, zone, { day: await dayPlanOf(o.storage, waifu), bed: { ...bed, lastSentAt: state.lastSentAt } });
    const bedPhase = availability.bed ? { bed: availability.bed.phase } : {};
    const cast = o.cast();
    const sameDay = usage.day === localDayKey(at, zone);
    return {
      waifuId,
      displayName: waifu.displayName || waifu.name,
      enabled: waifu.enabled,
      model: waifu.model ?? null,
      hasBot: Boolean(waifu.botId),
      runtime: { running: cast !== undefined, busy: cast?.lifeBusy(waifuId) ?? false, paused: o.isPaused() },
      availability:
        availability.state === "busy"
          ? { state: "busy" as const, reason: availability.reason, until: availability.until, ...bedPhase }
          : availability.state === "asleep"
            ? { state: "asleep" as const, until: availability.windowEnd.toISOString(), ...bedPhase }
            : { state: "awake" as const, ...bedPhase },
      started: state.systemSnapshot !== null,
      status: state.status,
      currentTurn: state.currentTurn
        ? { id: state.currentTurn.id, startedAt: state.currentTurn.startedAt, rounds: state.currentTurn.rounds, wakes: state.currentTurn.wakeIds.length }
        : null,
      epoch: state.epoch,
      epochStartedAt: state.epochStartedAt,
      logLines: lines.filter((line) => line.message !== null).length,
      lastTurnEndedAt: state.lastTurnEndedAt ?? null,
      lastCompaction: state.lastCompaction ?? null,
      lastMaintenanceAt: state.lastMaintenanceAt ?? null,
      compactionPausedUntil: state.compactionPausedUntil ?? null,
      failedTurnAt: state.failedTurn && !state.failedTurn.followUpDone ? state.failedTurn.at : null,
      queue: {
        immediate: queue.immediate.length,
        deferred: {
          reason: queue.deferred.reason ?? null,
          since: queue.deferred.since ?? null,
          places: Object.keys(queue.deferred.places).length,
          items: queue.deferred.items.length
        },
        quiet: queue.quiet.length,
        wakes: [...queue.immediate, ...queue.deferred.items].slice(0, 50).map((wake) => wakeView(wake, includePrivate))
      },
      today: {
        day: today.day,
        costUsd: today.costUsd,
        calls: today.calls,
        budgetUsd: waifu.life.dailyBudgetUsd ?? null,
        searches: sameDay ? usage.searches : 0,
        fetches: sameDay ? usage.fetches : 0
      },
      summary: includePrivate ? { text: state.summary, hidden: false } : { text: null, hidden: state.summary !== null && state.summary.trim() !== "" },
      counts: { needsReview: review.length, pendingScrubs: scrubs.length },
      includePrivate
    };
  });

  app.get("/api/waifus/:waifuId/life/log", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const query = z
      .object({
        epoch: z.coerce.number().int().positive().optional(),
        before: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(LOG_MAX_LIMIT).optional()
      })
      .parse(request.query ?? {});
    await existingWaifu(o.storage, waifuId);
    const state = await readLifeState(o.storage, waifuId, now());
    const epochs = await listLogEpochs(o.storage, waifuId);
    const epoch = query.epoch ?? state.epoch;
    if (query.epoch !== undefined && query.epoch !== state.epoch && !epochs.includes(query.epoch)) {
      throw notFound(`Epoch ${query.epoch} has no log (old epochs are kept 7 days).`);
    }
    const all = await readLifeLog(o.storage, waifuId, epoch);
    // The DM scan covers the whole epoch: a result's call, or the turn's wakes, may be on an older page.
    const scan = scanDmContent(all);
    const before = query.before === undefined ? all : all.filter((line) => line.seq < query.before!);
    const limit = query.limit ?? LOG_DEFAULT_LIMIT;
    const page = before.slice(-limit);
    let redactedBlocks = 0;
    const lines = page.map((line) => {
      const { view, redacted } = viewLogLine(line, scan, { includePrivate });
      redactedBlocks += redacted;
      return view;
    });
    return {
      waifuId,
      epoch,
      epochs: epochs.includes(state.epoch) ? epochs : [...epochs, state.epoch].sort((a, b) => a - b),
      lines,
      hasMore: before.length > page.length,
      includePrivate,
      redactedBlocks
    };
  });

  // An owner wake (§4.1 `owner`): skips her bed time and budget. Discord offline (or the cast stopping
  // for a reload): it waits in her queue.
  app.post("/api/waifus/:waifuId/wake", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const body = WakeBodySchema.parse(request.body ?? {});
    await existingWaifu(o.storage, waifuId);
    const cast = o.cast();
    if (cast) {
      try {
        return { waifuId, outcome: await cast.ownerWake(waifuId, body.note) };
      } catch (error) {
        if (!(error instanceof LifeActionError && error.code === "offline")) throw error;
      }
    }
    const wake = await queueOwnerWakeOffline(o.storage, waifuId, body.note, now());
    return { waifuId, outcome: "queued_offline" as const, wakeId: wake.id };
  });

  const liveCast = (action: string): LivingCast => {
    const cast = o.cast();
    if (!cast) throw new ApiError(409, `Her life runs only while Discord is connected; ${action} once it is.`, undefined, "RuntimeOffline");
    return cast;
  };

  const lifeAction = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof LifeActionError && error.code === "offline") throw new ApiError(409, error.message, undefined, "RuntimeOffline");
      if (error instanceof LifeActionError) throw conflict(error.message, { code: error.code });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound("That waifu was not found.");
      throw error;
    }
  };

  // A manual compaction (§5.6): between turns, under her life lock.
  app.post("/api/waifus/:waifuId/life/compact", async (request, reply) => {
    const waifuId = waifuIdOf(request.params);
    await existingWaifu(o.storage, waifuId);
    const cast = liveCast("compact her life");
    const running = lifeAction(() => cast.compactNow(waifuId));
    // Errors that come at once (no model, not started) answer the request; a long summary does not hold it.
    const settled = await Promise.race([
      running.then((result) => ({ done: true as const, result })),
      new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), COMPACT_WAIT_MS).unref?.())
    ]);
    if (!settled.done) {
      running.catch(() => undefined);
      return reply.code(202).send({ waifuId, state: "running" });
    }
    // Aborted (a pause or a shutdown while it ran): nothing changed.
    if (settled.result.aborted) return { waifuId, state: "aborted", epoch: settled.result.epoch, summarized: false };
    return { waifuId, state: "done", epoch: settled.result.epoch, summarized: settled.result.summarized };
  });

  // Reset her short-term memory: a fresh epoch with no summary; notes, plans and queue stay.
  app.post("/api/waifus/:waifuId/life/reset", async (request) => {
    const waifuId = waifuIdOf(request.params);
    LifeResetBodySchema.parse(request.body ?? {});
    await existingWaifu(o.storage, waifuId);
    const cast = liveCast("reset her life");
    const result = await lifeAction(() => cast.resetLife(waifuId));
    return { waifuId, epoch: result.epoch, deferred: result.deferred };
  });

  // Forget review lines (§7.5 step 5): names a forget could only list, for the owner to check.
  app.get("/api/waifus/:waifuId/life/needs-review", async (request) => {
    const waifuId = waifuIdOf(request.params);
    await existingWaifu(o.storage, waifuId);
    // Private lines (D14) keep their place and lose their text unless the request is local and asks.
    const includePrivate = includePrivateOf(request);
    const items = await readNeedsReview(o.storage, waifuId);
    return { waifuId, includePrivate, items: includePrivate ? items : items.map(withoutPrivateReview) };
  });

  app.delete("/api/waifus/:waifuId/life/needs-review/:itemId", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const { itemId } = z.object({ itemId: z.string().regex(/^[0-9a-f]{16}$/u) }).parse(request.params);
    await existingWaifu(o.storage, waifuId);
    if (!(await dismissNeedsReview(o.storage, waifuId, itemId))) throw notFound("That review line is not listed any more.");
    // Only the id: the mutation layer keeps this response for a day, and review lines may be private.
    return { waifuId, dismissed: itemId };
  });
}
