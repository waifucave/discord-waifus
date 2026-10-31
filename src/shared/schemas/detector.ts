import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";

// The addressee detector's target (Living cast spec §4.3): a native-choice decision API. One global
// target (`[detector] target` in config.toml), plus an optional per-server override. An empty target
// means "no detector": bursts nobody was addressed in fall back to the §4.3 heuristic.

export const DetectorTargetSchema = z
  .string()
  .max(200)
  .regex(/^(openai:gpt-6-luna|openrouter:[A-Za-z0-9~._\/-]+(?::free)?|laya:(english|multilingual|typed-decisions))$/)
  .refine((v) => !v.startsWith("openrouter:respan/span-"), "Yes/no-only models are not supported.");

/** The detector's default target (spec §4.3): Jev scored 40/40 on the addressee benchmark. */
export const DEFAULT_DETECTOR_TARGET = "openrouter:typesafe/jev-1.14";

/** The 2.x one-shot default target; a server that still had it gets no override on upgrade (§11.2). */
export const LEGACY_ONE_SHOT_TARGET = "openrouter:cloudflare/clef";

/** A stored target: a decision API target, or "" for none. */
export const DetectorTargetOrNoneSchema = z.union([DetectorTargetSchema, z.literal("")]);

/** `ServerConfig.detector`: the per-server override of the global target ("" = no detector here). */
export const ServerDetectorOverrideSchema = z.object({ target: DetectorTargetOrNoneSchema });
export type ServerDetectorOverride = z.infer<typeof ServerDetectorOverrideSchema>;

// `user/servers/<guildId>/detector-history.json` (spec §4.3): the last 300 results per guild.
export const DETECTOR_HISTORY_MAX = 300;

export const DetectorHistoryEntrySchema = z.object({
  at: IsoDateStringSchema,
  channelId: z.string().min(1),
  burstMessageIds: z.array(z.string()),
  /** The model's choice, `fallback:anyone` / `fallback:none` when no target answered, or `nobody_around` (§24: no question asked). */
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number()).default({}),
  /** The waifu ids woken by this result. */
  woke: z.array(z.string()).optional(),
  /**
   * Cast members left out because they were not around (§24), and why: over her daily budget is
   * `budget`, the only reason written since §38; `busy`, `bed time` and `asleep` are read from older
   * history entries.
   */
  leftOut: z.array(z.object({ waifuId: z.string().min(1), why: z.enum(["budget", "busy", "bed time", "asleep"]) })).optional(),
  /** The cast member who wrote the burst (a waifu-authored message, §4.3); absent for a person's. */
  authorWaifuId: z.string().optional(),
  /** The `chime_in` answer when it was asked, and who was woken to chime in (at most one per room per 10 minutes). */
  chimeIn: z.object({ choice: z.string().min(1), probabilities: z.record(z.string(), z.number()).default({}), woke: z.string().optional() }).optional(),
  target: z.string().optional(),
  error: z.string().optional()
});
export type DetectorHistoryEntry = z.infer<typeof DetectorHistoryEntrySchema>;

export const DetectorHistoryFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  entries: z.array(DetectorHistoryEntrySchema).max(DETECTOR_HISTORY_MAX).default([])
});
export type DetectorHistoryFile = z.infer<typeof DetectorHistoryFileSchema>;
