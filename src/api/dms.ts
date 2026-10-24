// DM routes (spec 9.8, 12.5): list DM conversations, show one (state and rate limit; never message
// bodies), and forget one (transactional, audited as `dm.forget`). waifuId is validated with
// assertSafeId, user ids must be Discord snowflakes.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CastRuntime } from "../orchestration/runtime.js";
import { conversationKey } from "../orchestration/context/keys.js";
import { dmForget } from "../orchestration/dm/dmForget.js";
import { assessDmLimit } from "../orchestration/dm/rateLimit.js";
import { listDmStates, readDmLimitIfExists, readDmState } from "../orchestration/dm/dmStore.js";
import { readWaifu } from "../orchestration/stores/config.js";
import type { DmState } from "../shared/schemas/dm.js";
import type { StorageService } from "../storage/storageService.js";
import { badRequest, notFound } from "./errors.js";
import { assertSafeId, assertSnowflakeId } from "./ids.js";

const ListQuerySchema = z.object({
  waifuId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const ForgetBodySchema = z.object({
  confirm: z.literal(true),
  scope: z.enum(["conversation", "all"]),
  dryRun: z.boolean().optional()
});

export type DmRouteOptions = {
  storage: StorageService;
  runtime: () => CastRuntime | undefined;
};

async function rateLimitView(storage: StorageService, state: Pick<DmState, "userId" | "waifuId">) {
  const waifu = await readWaifu(storage, state.waifuId).catch(() => undefined);
  const limit = waifu?.dm.rateLimit ?? null;
  if (!limit) return null;
  const stored = await readDmLimitIfExists(storage, state.userId, state.waifuId);
  const assessment = assessDmLimit(stored?.replyTimestamps ?? [], limit, new Date());
  return {
    used: assessment.used,
    max: limit.maxReplies,
    windowMinutes: limit.windowMinutes,
    limited: assessment.limited,
    ...(assessment.freesAt ? { freesAt: assessment.freesAt } : {})
  };
}

function parseParams(params: unknown): { waifuId: string; userId: string } {
  const parsed = z.object({ waifuId: z.string().min(1), userId: z.string().min(1) }).parse(params);
  assertSafeId(parsed.waifuId);
  assertSnowflakeId(parsed.userId);
  return parsed;
}

export function registerDmRoutes(app: FastifyInstance, o: DmRouteOptions): void {
  app.get("/api/dms", async (request) => {
    const query = ListQuerySchema.safeParse(request.query ?? {});
    if (!query.success) throw badRequest("Invalid DM list query.", query.error.issues);
    if (query.data.waifuId) assertSafeId(query.data.waifuId);
    if (query.data.userId) assertSnowflakeId(query.data.userId);
    const states = (await listDmStates(o.storage))
      .filter((state) => (!query.data.waifuId || state.waifuId === query.data.waifuId) && (!query.data.userId || state.userId === query.data.userId))
      .sort((a, b) => (b.lastInboundAt ?? "").localeCompare(a.lastInboundAt ?? ""))
      .slice(0, query.data.limit ?? 200);
    const conversations = [];
    for (const state of states) {
      conversations.push({
        conversationKey: conversationKey({ kind: "dm", waifuId: state.waifuId, userId: state.userId }),
        waifuId: state.waifuId,
        userId: state.userId,
        ...(state.userDisplayName ? { userDisplayName: state.userDisplayName } : {}),
        ...(state.lastInboundAt ? { lastInboundAt: state.lastInboundAt } : {}),
        ...(state.lastReplyAt ? { lastReplyAt: state.lastReplyAt } : {}),
        rateLimit: await rateLimitView(o.storage, state)
      });
    }
    return { conversations };
  });

  app.get("/api/dms/:waifuId/:userId", async (request) => {
    const { waifuId, userId } = parseParams(request.params);
    const state = await readDmState(o.storage, userId, waifuId);
    if (!state) throw notFound(`No DM between ${waifuId} and ${userId}.`);
    return { state, rateLimit: await rateLimitView(o.storage, state) };
  });

  app.post("/api/dms/:waifuId/:userId/forget", async (request) => {
    const { waifuId, userId } = parseParams(request.params);
    const body = ForgetBodySchema.parse(request.body);
    const input = { userId, waifuId, scope: body.scope, dryRun: body.dryRun === true };
    const runtime = o.runtime();
    const result = runtime ? await runtime.forgetDm(input) : await dmForget(o.storage, input);
    return { dryRun: result.dryRun, scope: result.scope, deleted: result.deleted };
  });
}
