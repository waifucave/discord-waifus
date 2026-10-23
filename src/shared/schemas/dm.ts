import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";

// DM schemas (spec 9.1). T1 only wires `WaifuConfig.dm`; nothing reads it until Phase 5.

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
  limitNotice: z.string().max(300).default("") // "" = built-in template
});
export type WaifuDmSettings = z.infer<typeof WaifuDmSettingsSchema>;

// Outer default for WaifuConfig.dm: files written before Phase 5 have no `dm` key.
export function defaultWaifuDmSettings(): WaifuDmSettings {
  return { allowDms: false, rateLimit: { ...DEFAULT_DM_RATE_LIMIT }, notifyWhenLimited: true, limitNotice: "" };
}

export const DmRunRecordSchema = z.object({
  id: z.string().min(1),
  at: IsoDateStringSchema,
  triggerMessageId: z.string().min(1),
  status: z.enum([
    "sent",
    "tool_only",
    "empty",
    "blocked",
    "rate_limited",
    "notice_sent",
    "superseded",
    "interrupted",
    "failed",
    "undeliverable"
  ]),
  messageIds: z.array(z.string()).default([]),
  reason: z.string().max(200).optional(),
  durationMs: z.number().int().optional()
});
export type DmRunRecord = z.infer<typeof DmRunRecordSchema>;

// user/dms/<userId>/<waifuId>.json (resource `dm:<userId>:<waifuId>`)
export const DmStateSchema = RevisionedRecordSchema.extend({
  waifuId: z.string().min(1),
  userId: z.string().min(1),
  botId: z.string().min(1),
  dmChannelId: z.string().optional(),
  lastInboundMessageId: z.string().optional(),
  lastInboundAt: IsoDateStringSchema.optional(),
  lastRepliedMessageId: z.string().optional(),
  lastReplyAt: IsoDateStringSchema.optional(),
  pendingTriggerMessageId: z.string().optional(),
  pendingSince: IsoDateStringSchema.optional(),
  undeliverableSince: IsoDateStringSchema.optional(),
  recentRuns: z.array(DmRunRecordSchema).max(50).default([])
});
export type DmState = z.infer<typeof DmStateSchema>;

// user/dms/<userId>/limits/<waifuId>.json (resource `dm-limit:<userId>:<waifuId>`), kept separate so
// user-initiated forgetting can never reset the limiter.
export const DmLimitStateSchema = RevisionedRecordSchema.extend({
  waifuId: z.string().min(1),
  userId: z.string().min(1),
  replyTimestamps: z.array(IsoDateStringSchema).max(1000).default([]),
  limitNoticeSentAt: IsoDateStringSchema.optional()
});
export type DmLimitState = z.infer<typeof DmLimitStateSchema>;
