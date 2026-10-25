// Cast-wide routes of the Living cast API (spec §14.1): usage from the usage ledger, web search
// usage, the addressee detector's target and history, unfinished owner forgets and the owner
// notices (what needs the owner's attention, shared with `waifus doctor` / `waifus status`).

import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { castHealth, forgetJobViews } from "../backend/castHealth.js";
import { loadAppConfig } from "../config/appConfig.js";
import { localDayKey } from "../life/clock.js";
import { DM_REDACTED } from "../life/lifeView.js";
import { SEARCH_USAGE_PATH } from "../life/search.js";
import { createProviderCredentialsLookup } from "../models/credentials.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { assertTimeZone, parseGroupBy, shiftDay, usageReport, UsageQueryError } from "../orchestration/usageReport.js";
import { DetectorConfigBodySchema } from "../shared/schemas/api.js";
import { createRevisionedBase } from "../shared/schemas/common.js";
import type { UpdateAppConfigBody } from "../shared/schemas/config.js";
import { DEFAULT_DETECTOR_TARGET, DetectorHistoryFileSchema, DetectorTargetOrNoneSchema } from "../shared/schemas/detector.js";
import { SearchUsageSchema } from "../shared/schemas/life.js";
import { USAGE_PURPOSES, LEGACY_USAGE_PURPOSES } from "../shared/schemas/usage.js";
import type { StorageService } from "../storage/storageService.js";
import { badRequest } from "./errors.js";
import { assertSafeId, assertSnowflakeId } from "./ids.js";
import { includePrivateOf } from "./lifeRoutes.js";

export type CastRouteOptions = {
  storage: StorageService;
  dataRoot: string;
  isPaused: () => boolean;
  /** `discord.warnings` of `/api/runtime` (permission warnings, Living cast notices, given-up forget parts). */
  liveNotices: () => Promise<string[]>;
  /** Saves a config patch like `PUT /api/config` (lock, validation, reload). */
  applyConfigPatch: (request: FastifyRequest, patch: UpdateAppConfigBody) => Promise<unknown>;
  now?: () => Date;
  timeZone?: string;
};

export function registerCastRoutes(app: FastifyInstance, o: CastRouteOptions): void {
  const now = () => o.now?.() ?? new Date();
  const timeZone = () => o.timeZone ?? hostTimeZone();

  // Usage (§14.1): the usage ledger grouped by local day (or waifu, purpose, model, provider, turn,
  // place, server), last 7 days by default, in the host's time zone unless `tz` names another.
  app.get("/api/usage", async (request) => {
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        groupBy: z.string().optional(),
        tz: z.string().max(100).optional(),
        waifuId: z.string().min(1).optional(),
        purpose: z.enum([...USAGE_PURPOSES, ...LEGACY_USAGE_PURPOSES]).optional(),
        guildId: z.string().optional()
      })
      .parse(request.query ?? {});
    if (query.waifuId) assertSafeId(query.waifuId);
    if (query.guildId) assertSnowflakeId(query.guildId);
    try {
      const zone = assertTimeZone(query.tz ?? timeZone());
      const to = query.to ?? localDayKey(now(), zone);
      const from = query.from ?? shiftDay(to, -6);
      return await usageReport(o.dataRoot, {
        from,
        to,
        timeZone: zone,
        groupBy: parseGroupBy(query.groupBy),
        ...(query.waifuId ? { waifuId: query.waifuId } : {}),
        ...(query.purpose ? { purpose: query.purpose } : {}),
        ...(query.guildId ? { guildId: query.guildId } : {})
      });
    } catch (error) {
      if (error instanceof UsageQueryError) throw badRequest(error.message);
      throw error;
    }
  });

  // Web search usage (§6.8, §14.1): today's host-wide counts, the caps and the newest queries.
  app.get("/api/search/usage", async (request) => {
    // Queries from a DM turn (D14) keep their place on the list and lose their text unless the
    // request is local and says includePrivate=1.
    const includePrivate = includePrivateOf(request);
    const [usage, config] = await Promise.all([
      o.storage.readJson(SEARCH_USAGE_PATH, SearchUsageSchema, SearchUsageSchema.parse({ ...createRevisionedBase() })).catch(() => SearchUsageSchema.parse({ ...createRevisionedBase() })),
      loadAppConfig(o.dataRoot)
    ]);
    const today = localDayKey(now(), timeZone());
    const sameDay = usage.day === today;
    return {
      day: today,
      searches: sameDay ? usage.searches : 0,
      fetches: sameDay ? usage.fetches : 0,
      limits: {
        maxPerSecond: config.search.maxPerSecond,
        maxPerDay: config.search.maxPerDay,
        maxPerWaifuPerDay: config.search.maxPerWaifuPerDay,
        fetchMaxPerWaifuPerDay: config.life.webFetch.maxPerWaifuPerDay,
        fetchMaxPerTurn: config.life.webFetch.maxPerTurn
      },
      exaKeyConfigured: Boolean(createProviderCredentialsLookup(o.dataRoot)("exa")),
      includePrivate,
      recent: [...usage.recent].reverse().map(({ turnId: _turnId, ...entry }) => (entry.dm && !includePrivate ? { ...entry, query: DM_REDACTED } : entry))
    };
  });

  // The addressee detector's global target (§4.3; config.toml `[detector] target`).
  app.get("/api/detector/config", async () => {
    const config = await loadAppConfig(o.dataRoot);
    return { target: config.detector.target, default: DEFAULT_DETECTOR_TARGET };
  });

  app.put("/api/detector/config", async (request) => {
    const body = DetectorConfigBodySchema.parse(request.body);
    const target = DetectorTargetOrNoneSchema.safeParse(body.target);
    if (!target.success) throw badRequest(`Unknown detector target: ${body.target}. See GET /api/detector/models; "" turns the detector off.`);
    await o.applyConfigPatch(request, { detector: { target: target.data } });
    const config = await loadAppConfig(o.dataRoot);
    return { target: config.detector.target, default: DEFAULT_DETECTOR_TARGET };
  });

  // The last 300 detector results of one server (§4.3).
  app.get("/api/detector/history", async (request) => {
    const { guildId } = z.object({ guildId: z.string().min(1) }).parse(request.query ?? {});
    assertSnowflakeId(guildId);
    const file = await o.storage
      .readJson(path.join("user", "servers", guildId, "detector-history.json"), DetectorHistoryFileSchema)
      .catch(() => undefined);
    return { guildId, entries: [...(file?.entries ?? [])].reverse() };
  });

  // Owner forgets that have not finished (§7.5): each part left, its last error, whether a start retries it.
  app.get("/api/people/forget-jobs", async () => ({ jobs: await forgetJobViews(o.storage) }));

  app.get("/api/owner-notices", async () => {
    const [notices, health] = await Promise.all([o.liveNotices().catch(() => [] as string[]), castHealth(o.storage, { paused: o.isPaused() })]);
    return { notices, ...health };
  });
}
