import { z } from "zod";
import { IsoDateStringSchema } from "./common.js";

// One line of user/usage/YYYY-MM-DD.jsonl per model call (spec 8.10). Written by usageLedger.ts
// (T7a); read by the usage routes (Phase 6).

export const USAGE_PURPOSES = [
  "waifu_reply",
  "waifu_retry",
  "orchestrator",
  "observer",
  "dream",
  "reviewer",
  "persona_digest",
  "compaction",
  "assistant",
  "one_shot" // native-choice orchestrator decisions (oneShot/decider.ts)
] as const;
export const UsagePurposeSchema = z.enum(USAGE_PURPOSES);
export type UsagePurpose = z.infer<typeof UsagePurposeSchema>;

const TokenCountSchema = z.number().int().nonnegative();

export const UsageLedgerEntrySchema = z.object({
  at: IsoDateStringSchema,
  purpose: UsagePurposeSchema,
  agentId: z.string().optional(),
  waifuId: z.string().optional(),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  conversationKey: z.string().optional(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  status: z.enum(["ok", "aborted", "failed"]),
  // false when the provider returned no usage (aborted/failed streams): token fields are then 0.
  usageKnown: z.boolean(),
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cacheReadTokens: TokenCountSchema.optional(),
  cacheWriteTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  finishReason: z.string().optional(),
  errorKind: z.string().optional(),
  estimatedInputTokens: TokenCountSchema.optional(),
  durationMs: z.number().nonnegative()
});
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntrySchema>;
