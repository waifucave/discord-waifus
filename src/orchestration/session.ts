import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema, RevisionedRecordSchema } from "../shared/schemas/common.js";

// What armed a channel's retrigger timer:
// - no_reply: the orchestrator paused and planned a wake (decisionId = that decision)
// - turn_limit / nothing_sent: the pass loop ended (turn cap, or responders sent nothing)
// - crash_recovery: the run threw; cast_wake_suppressed: a wake was skipped as over budget
// - preempted: another channel's run in the same guild took over this channel's turn
// - shutdown: a planned runtime stop interrupted the run; restart_resume: boot catch-up
const RETRIGGER_SOURCES = [
  "no_reply",
  "turn_limit",
  "nothing_sent",
  "crash_recovery",
  "cast_wake_suppressed",
  "preempted",
  "shutdown",
  "restart_resume"
] as const;

// Retired never-read fields (`paused`, `pendingMessageIds`) are simply stripped by z.object when
// an older session file is parsed, so those files keep loading.
export const ChannelSessionStateSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
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
  scheduledRetriggerAt: IsoDateStringSchema.optional(),
  // Who armed scheduledRetriggerAt (absent on sessions written before this was recorded). The
  // wake pass uses it to pick the right wake marker/backoff instead of the newest no_reply.
  scheduledRetrigger: z
    .object({
      source: z.enum(RETRIGGER_SOURCES),
      seconds: z.number().nonnegative(),
      decisionId: z.string().min(1).optional()
    })
    .optional()
});

export type ChannelSessionState = z.infer<typeof ChannelSessionStateSchema>;
export type RetriggerWake = NonNullable<ChannelSessionState["scheduledRetrigger"]>;
export type RetriggerSource = RetriggerWake["source"];

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
