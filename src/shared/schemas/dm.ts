import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";

// DM schemas (spec 9.1, Living cast §4.4–§4.5): per-waifu settings, the per-conversation DM state and
// the rate-limit counters (with the forget floor and the automatic-notice bookkeeping).

export const DmRateLimitSchema = z.object({
  maxReplies: z.number().int().min(1).max(1000),
  windowMinutes: z.number().int().min(1).max(10080)
});
export type DmRateLimit = z.infer<typeof DmRateLimitSchema>;

export const DEFAULT_DM_RATE_LIMIT: DmRateLimit = { maxReplies: 30, windowMinutes: 60 };

export const WaifuDmSettingsSchema = z.object({
  allowDms: z.boolean().default(false),
  rateLimit: DmRateLimitSchema.nullable().default({ ...DEFAULT_DM_RATE_LIMIT }), // null = unlimited
  notifyWhenLimited: z.boolean().default(true),
  limitNotice: z.string().max(300).default(""), // "" = built-in template
  // Living cast §4.5, §21.6c: sent once per bed time per user when a DM wake is deferred while she is asleep
  // ("" = none). No model call; not counted by the rate limit.
  sleepNotice: z.string().max(300).default("")
});
export type WaifuDmSettings = z.infer<typeof WaifuDmSettingsSchema>;

// Outer default for WaifuConfig.dm: files written before Phase 5 have no `dm` key.
export function defaultWaifuDmSettings(): WaifuDmSettings {
  return { allowDms: false, rateLimit: { ...DEFAULT_DM_RATE_LIMIT }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" };
}

// user/dms/<userId>/<waifuId>.json (resource `dm:<userId>:<waifuId>`)
export const DmStateSchema = RevisionedRecordSchema.extend({
  waifuId: z.string().min(1),
  userId: z.string().min(1),
  botId: z.string().min(1),
  dmChannelId: z.string().optional(),
  /** The user's Discord display name as last seen on an inbound DM (dashboard listing only). */
  userDisplayName: z.string().max(100).optional(),
  lastInboundMessageId: z.string().optional(),
  lastInboundAt: IsoDateStringSchema.optional(),
  lastRepliedMessageId: z.string().optional(),
  lastReplyAt: IsoDateStringSchema.optional(),
  /** A send failed with Discord error 50007 (the user closed DMs): no more sends until they write again. */
  undeliverableSince: IsoDateStringSchema.optional()
});
export type DmState = z.infer<typeof DmStateSchema>;

// user/dms/<userId>/limits/<waifuId>.json (resource `dm-limit:<userId>:<waifuId>`), kept separate so
// user-initiated forgetting can never reset the limiter.
export const DmLimitStateSchema = RevisionedRecordSchema.extend({
  waifuId: z.string().min(1),
  userId: z.string().min(1),
  replyTimestamps: z.array(IsoDateStringSchema).max(1000).default([]),
  limitNoticeSentAt: IsoDateStringSchema.optional(),
  /**
   * Forget floor (spec 9.1.4): Discord message ids at or below it predate the last DM /forget and
   * are never read again (the bot cannot delete the user's messages). Kept here because forgetting
   * never deletes this file.
   */
  floorMessageId: z.string().min(1).optional(),
  /** Living cast §4.5: the start (ISO) of the bed time the sleep notice was last sent for. */
  sleepNoticeSentFor: IsoDateStringSchema.optional(),
  /** Automatic notices (limit, sleep) she sent: `ReadMessages` renders them as `[auto] …`. */
  autoMessageIds: z.array(z.string().min(1)).max(50).default([])
});
export type DmLimitState = z.infer<typeof DmLimitStateSchema>;
