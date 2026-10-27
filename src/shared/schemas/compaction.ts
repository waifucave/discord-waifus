import { z } from "zod";

// Compaction settings (spec 8.2/8.9): `AppConfig.compaction` holds the defaults, and
// `ServerConfig.compaction` may override any subset. The bare field schemas carry no defaults so
// the override shape (all optional) can never manufacture values for omitted keys.
const fields = {
  enabled: z.boolean(),
  triggerRatio: z.number().min(0.3).max(0.95),
  /** Auto-compaction between turns (spec §26): her last request reached this share of her budget. */
  emergencyRatio: z.number().min(0.35).max(0.99),
  maxMessages: z.number().int().min(20).max(200),
  keepRecent: z.number().int().min(5).max(120),
  waitTimeoutMs: z.number().int().min(0).max(30_000)
};

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  triggerRatio: 0.7,
  emergencyRatio: 0.9,
  maxMessages: 150,
  keepRecent: 30,
  waitTimeoutMs: 6_000
} as const;

export const CompactionSettingsSchema = z
  .object({
    enabled: fields.enabled.default(DEFAULT_COMPACTION_SETTINGS.enabled),
    triggerRatio: fields.triggerRatio.default(DEFAULT_COMPACTION_SETTINGS.triggerRatio),
    emergencyRatio: fields.emergencyRatio.default(DEFAULT_COMPACTION_SETTINGS.emergencyRatio),
    maxMessages: fields.maxMessages.default(DEFAULT_COMPACTION_SETTINGS.maxMessages),
    keepRecent: fields.keepRecent.default(DEFAULT_COMPACTION_SETTINGS.keepRecent),
    waitTimeoutMs: fields.waitTimeoutMs.default(DEFAULT_COMPACTION_SETTINGS.waitTimeoutMs)
  })
  .default({ ...DEFAULT_COMPACTION_SETTINGS });
export type CompactionSettings = z.infer<typeof CompactionSettingsSchema>;

// The emergency comes after the rest point (§26). A stored config is never refused for it (before
// §26 the trigger could be up to 0.95, above the new emergency default): loading moves the emergency
// above the trigger (`withEmergencyAboveTrigger`); an update that would break it is refused
// (`CompactionRatiosSchema`, a 400 for `PUT /api/config`).

/** The emergency just above a rest point at or over it: 0.04 higher, at most 0.99. */
export function emergencyAbove(triggerRatio: number): number {
  return Math.min(0.99, Math.round((triggerRatio + 0.04) * 100) / 100);
}

/** The settings with `emergencyRatio` greater than `triggerRatio` (moved up when it is not). */
export function withEmergencyAboveTrigger<T extends { triggerRatio: number; emergencyRatio: number }>(settings: T): T {
  return settings.emergencyRatio > settings.triggerRatio ? settings : { ...settings, emergencyRatio: emergencyAbove(settings.triggerRatio) };
}

/** What an update must satisfy: the emergency above the rest point. */
export const CompactionRatiosSchema = z
  .object({ triggerRatio: z.number(), emergencyRatio: z.number() })
  .refine((settings) => settings.emergencyRatio > settings.triggerRatio, {
    message: "compaction.emergencyRatio must be greater than compaction.triggerRatio",
    path: ["emergencyRatio"]
  });

// Per-server partial override: every key optional, no defaults.
export const CompactionOverrideSchema = z.object({
  enabled: fields.enabled.optional(),
  triggerRatio: fields.triggerRatio.optional(),
  maxMessages: fields.maxMessages.optional(),
  keepRecent: fields.keepRecent.optional(),
  waitTimeoutMs: fields.waitTimeoutMs.optional()
});
export type CompactionOverride = z.infer<typeof CompactionOverrideSchema>;

// PUT body form of the override: `null` per key = inherit (unset the stored override).
export const CompactionOverrideBodySchema = z.object({
  enabled: fields.enabled.nullable().optional(),
  triggerRatio: fields.triggerRatio.nullable().optional(),
  maxMessages: fields.maxMessages.nullable().optional(),
  keepRecent: fields.keepRecent.nullable().optional(),
  waitTimeoutMs: fields.waitTimeoutMs.nullable().optional()
});
