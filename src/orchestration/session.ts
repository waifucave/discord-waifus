import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema, RevisionedRecordSchema } from "../shared/schemas/common.js";

export const ChannelSessionStateSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  paused: z.boolean().default(false),
  activePipeline: z
    .object({
      kind: z.enum(["orchestrator", "waifu"]),
      startedAt: IsoDateStringSchema,
      cancelReason: z.string().optional()
    })
    .nullable()
    .default(null),
  stageManager: z
    .object({
      active: z.boolean().default(false),
      startedAt: IsoDateStringSchema.optional()
    })
    .default({ active: false }),
  scheduledIdleTriggerAt: IsoDateStringSchema.optional(),
  pendingMessageIds: z.array(z.string()).default([]),
  cachedWaifuContinuation: z
    .object({
      waifuId: z.string().min(1),
      senderBotId: z.string().min(1),
      chunks: z.array(z.string().min(1)).min(1),
      allowedUserMentionIds: z.array(z.string()).default([]),
      cachedAt: IsoDateStringSchema,
      idleAfter: IsoDateStringSchema
    })
    .nullable()
    .default(null)
});

export type ChannelSessionState = z.infer<typeof ChannelSessionStateSchema>;

export interface CancellationHandle {
  readonly signal: AbortSignal;
  cancel(reason: string): void;
}

export function createCancellationHandle(): CancellationHandle {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel: (reason: string) => controller.abort(new Error(reason))
  };
}

export function createEmptyChannelSessionState(guildId: string, channelId: string): ChannelSessionState {
  const now = new Date().toISOString();
  return ChannelSessionStateSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    guildId,
    channelId
  });
}
