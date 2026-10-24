import { z } from "zod";
import { IsoDateStringSchema } from "./common.js";

// One line of user/usage/YYYY-MM-DD.jsonl per model call (spec 8.10, Living cast §9.1). Written by
// usageLedger.ts from winter's usage event; read by the usage routes.

/** Purposes new lines are written with (Living cast §9.1, §9.3). */
export const USAGE_PURPOSES = ["life", "maintenance", "detector", "compaction", "assistant"] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/** Purposes of the retired orchestrator era: old lines stay readable, nothing writes them. */
export const LEGACY_USAGE_PURPOSES = [
  "waifu_reply",
  "waifu_retry",
  "orchestrator",
  "observer",
  "dream",
  "reviewer",
  "persona_digest",
  "one_shot"
] as const;
export type LegacyUsagePurpose = (typeof LEGACY_USAGE_PURPOSES)[number];

export const UsagePurposeSchema = z.enum(USAGE_PURPOSES);
const StoredUsagePurposeSchema = z.enum([...USAGE_PURPOSES, ...LEGACY_USAGE_PURPOSES]);

const TokenCountSchema = z.number().int().nonnegative();

export const UsageLedgerEntrySchema = z.object({
  at: IsoDateStringSchema,
  purpose: StoredUsagePurposeSchema,
  agentId: z.string().optional(),
  waifuId: z.string().optional(),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  conversationKey: z.string().optional(),
  /** The life turn this call belongs to (Living cast §9.1). */
  turnId: z.string().optional(),
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
  /** winter's count of thinking blocks the provider dropped from the replayed history. */
  thinkingBlocksDropped: TokenCountSchema.optional(),
  /** Absent for an unpriced route (it counts as 0 toward budgets). */
  costUsd: z.number().nonnegative().optional(),
  finishReason: z.string().optional(),
  errorKind: z.string().optional(),
  estimatedInputTokens: TokenCountSchema.optional(),
  durationMs: z.number().nonnegative()
});
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntrySchema>;
/** A line as the app writes it: only current purposes. */
export type UsageLedgerLine = Omit<UsageLedgerEntry, "purpose"> & { purpose: UsagePurpose };
