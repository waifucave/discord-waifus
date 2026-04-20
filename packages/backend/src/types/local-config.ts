import { z } from "zod";
import {
  busyTimeSchema,
  timeRangeSchema,
  type AIConfig,
  type BusyTime,
  type PersonalityConfig,
  type ScheduleConfig,
  type TimeRange
} from "./waifu.js";

export const localConfigSchemaVersion = 1;
export const waifuIdPattern = /^[A-Za-z0-9_-]+$/;
export const localAssetUrlPrefix = "/local-assets";

export const localProviderTypeSchema = z.enum(["openai-compatible", "anthropic"]);
export const providerOriginSchema = z.enum(["built-in", "custom"]);
export const providerAuthModeSchema = z.enum(["required", "none"]);

export const appSettingsTomlSchema = z.object({
  app: z.object({
    schemaVersion: z.literal(localConfigSchemaVersion).default(localConfigSchemaVersion)
  })
});

export const providerCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: localProviderTypeSchema,
  authMode: providerAuthModeSchema,
  enabledByDefault: z.boolean().default(false),
  baseUrl: z.string().min(1),
  models: z.array(z.string()).default([])
});

export const providerCatalogFileSchema = z.object({
  providers: z.array(providerCatalogEntrySchema).default([])
});

export const localProviderDefinitionSchema = z.object({
  id: z.string().min(1),
  origin: providerOriginSchema,
  name: z.string().min(1),
  type: localProviderTypeSchema,
  authMode: providerAuthModeSchema,
  enabled: z.boolean().default(true),
  baseUrl: z.string().min(1),
  models: z.array(z.string()).default([])
});

export const localProviderOverridesTomlSchema = z.object({
  providers: z.array(localProviderDefinitionSchema).default([])
});

export const providerKeyEntrySchema = z.object({
  id: z.string().min(1),
  apiKey: z.string().default("")
});

export const providerKeysTomlSchema = z.object({
  providerKeys: z.array(providerKeyEntrySchema).default([])
});

export const localChannelSchema = z
  .object({
    guildId: z.string().min(1),
    channelId: z.string().min(1),
    channelName: z.string().min(1),
    enabled: z.boolean().default(true),
    activeWaifuIds: z.array(z.string()).default([]),
    contextAnchorMessageId: z.string().default(""),
    contextMessageCount: z.number().int().min(1).max(100).default(80),
    idleChatterEnabled: z.boolean().default(true),
    idleTimerMinSeconds: z.number().int().min(100).max(7200).default(100),
    idleTimerMaxSeconds: z.number().int().min(100).max(7200).default(300)
  })
  .refine(
    (value) => value.idleTimerMaxSeconds >= value.idleTimerMinSeconds,
    "idleTimerMaxSeconds must be greater than or equal to idleTimerMinSeconds"
  );

export const channelsTomlSchema = z.object({
  channels: z.array(localChannelSchema).default([])
});

export const orchestratorTomlSchema = z.object({
  orchestrator: z.object({
    providerId: z.string().default("configure-me"),
    model: z.string().default("configure-me"),
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().positive().default(500)
  })
});

export const stageManagerTomlSchema = z.object({
  stageManager: z.object({
    enabled: z.boolean().default(true),
    providerId: z.string().default(""),
    model: z.string().default(""),
    temperature: z.number().min(0).max(2).default(0.4),
    maxTokens: z.number().int().positive().default(500),
    quietPeriodSeconds: z.number().int().min(10).default(300),
    historyLimit: z.number().int().min(10).max(100).default(60),
    maxRelationshipsPerWaifu: z.number().int().min(1).max(50).default(20),
    maxMemoriesPerWaifu: z.number().int().min(1).max(20).default(8)
  })
});

export const localPersonalitySchema = z.object({
  description: z.string().default(""),
  traits: z.array(z.string()).default([]),
  speechPatterns: z.array(z.string()).default([]),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  backstory: z.string().default(""),
  quirks: z.array(z.string()).default([]),
  relationshipsWithOtherWaifus: z.record(z.string(), z.string()).default({})
});

export const localAiConfigSchema = z.object({
  providerId: z.string().default(""),
  model: z.string().default(""),
  temperature: z.number().min(0).max(2).default(0.8),
  repetitionPenalty: z.number().min(0).max(2).default(1),
  maxTokens: z.number().int().positive().default(300),
  systemPromptOverride: z.string().nullable().default(null)
});

export const localScheduleSchema = z.object({
  sleepTime: timeRangeSchema.default({ start: "01:00", end: "09:00" }),
  busyTime: busyTimeSchema.default({
    start: "09:00",
    end: "17:00",
    reason: "Busy"
  })
});

export const waifuDocumentSchema = z.object({
  schemaVersion: z.literal(localConfigSchemaVersion).default(localConfigSchemaVersion),
  id: z.string().regex(waifuIdPattern),
  name: z.string().min(1),
  displayName: z.string().min(1),
  botToken: z.string().default(""),
  applicationId: z.string().default(""),
  enabled: z.boolean().default(false),
  avatarPath: z.string().nullable().default(null),
  bannerPath: z.string().nullable().default(null),
  statusText: z.string().nullable().default(null),
  statusType: z.enum(["online", "idle", "dnd", "invisible"]).default("online"),
  personality: localPersonalitySchema,
  schedule: localScheduleSchema,
  ai: localAiConfigSchema
});

export const stageManagerRelationshipEntrySchema = z.object({
  targetKind: z.enum(["user", "waifu"]),
  targetName: z.string().min(1),
  targetUserId: z.string().nullable().default(null),
  targetWaifuId: z.string().nullable().default(null),
  relationship: z.string().min(1).max(220),
  updatedAt: z.string().min(1)
});

export const stageManagerMemoryEntrySchema = z.object({
  slot: z.number().int().min(1),
  note: z.string().min(1).max(220),
  sourceMessageIds: z.array(z.string()).max(5).default([]),
  updatedAt: z.string().min(1)
});

export const stageManagerGuildStateSchema = z.object({
  relationshipsByParticipant: z.record(z.string(), stageManagerRelationshipEntrySchema).default({}),
  memories: z.array(stageManagerMemoryEntrySchema).default([])
});

export const stageManagerWaifuDocumentSchema = z.object({
  schemaVersion: z.literal(localConfigSchemaVersion).default(localConfigSchemaVersion),
  waifuId: z.string().regex(waifuIdPattern),
  guilds: z.record(z.string(), stageManagerGuildStateSchema).default({})
});

export const stageManagerCheckpointSchema = z.object({
  lastProcessedMessageId: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null)
});

export const stageManagerCheckpointsFileSchema = z.object({
  guilds: z.record(z.string(), stageManagerCheckpointSchema).default({})
});

export const migrationStateStatusSchema = z.enum(["bootstrap_empty", "import_completed"]);

export const migrationStateSchema = z.object({
  schemaVersion: z.literal(localConfigSchemaVersion).default(localConfigSchemaVersion),
  status: migrationStateStatusSchema,
  createdAt: z.string().min(1),
  completedAt: z.string().min(1)
});

export const migrationWarningSchema = z.object({
  code: z.string().min(1),
  field: z.string().min(1),
  message: z.string().min(1),
  legacyValue: z.string().optional(),
  createdAt: z.string().min(1)
});

export const migrationWarningsFileSchema = z.object({
  schemaVersion: z.literal(localConfigSchemaVersion).default(localConfigSchemaVersion),
  globalWarnings: z.array(migrationWarningSchema).default([]),
  waifuWarnings: z.record(z.string(), z.array(migrationWarningSchema)).default({})
});

export type AppSettingsToml = z.infer<typeof appSettingsTomlSchema>;
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;
export type ProviderCatalogFile = z.infer<typeof providerCatalogFileSchema>;
export type LocalProviderDefinition = z.infer<typeof localProviderDefinitionSchema>;
export type LocalProviderOverridesToml = z.infer<typeof localProviderOverridesTomlSchema>;
export type ProviderKeyEntry = z.infer<typeof providerKeyEntrySchema>;
export type ProviderKeysToml = z.infer<typeof providerKeysTomlSchema>;
export type LocalChannelConfig = z.infer<typeof localChannelSchema>;
export type ChannelsToml = z.infer<typeof channelsTomlSchema>;
export type OrchestratorToml = z.infer<typeof orchestratorTomlSchema>;
export type StageManagerToml = z.infer<typeof stageManagerTomlSchema>;
export type LocalPersonalityConfig = z.infer<typeof localPersonalitySchema>;
export type LocalAiConfig = z.infer<typeof localAiConfigSchema>;
export type LocalScheduleConfig = z.infer<typeof localScheduleSchema>;
export type WaifuDocument = z.infer<typeof waifuDocumentSchema>;
export type StageManagerRelationshipEntry = z.infer<typeof stageManagerRelationshipEntrySchema>;
export type StageManagerMemoryEntry = z.infer<typeof stageManagerMemoryEntrySchema>;
export type StageManagerGuildState = z.infer<typeof stageManagerGuildStateSchema>;
export type StageManagerWaifuDocument = z.infer<typeof stageManagerWaifuDocumentSchema>;
export type StageManagerCheckpoint = z.infer<typeof stageManagerCheckpointSchema>;
export type StageManagerCheckpointsFile = z.infer<typeof stageManagerCheckpointsFileSchema>;
export type MigrationStateStatus = z.infer<typeof migrationStateStatusSchema>;
export type MigrationState = z.infer<typeof migrationStateSchema>;
export type MigrationWarning = z.infer<typeof migrationWarningSchema>;
export type MigrationWarningsFile = z.infer<typeof migrationWarningsFileSchema>;

export type LocalConfigAssetPath = string;

export interface RuntimeWaifuDraftFields {
  botToken: string;
  applicationId: string;
  personality: Pick<PersonalityConfig, "description" | "backstory">;
  ai: Pick<AIConfig, "providerId" | "model">;
}

export interface LocalWaifuDefaults {
  sleepTime: TimeRange;
  busyTime: BusyTime;
  assetUrlPrefix: string;
}

export const localWaifuDefaults: LocalWaifuDefaults = {
  sleepTime: { start: "01:00", end: "09:00" },
  busyTime: { start: "09:00", end: "17:00", reason: "Busy" },
  assetUrlPrefix: localAssetUrlPrefix
};

export function createEmptyStageManagerWaifuDocument(waifuId: string): StageManagerWaifuDocument {
  return stageManagerWaifuDocumentSchema.parse({
    schemaVersion: localConfigSchemaVersion,
    waifuId,
    guilds: {}
  });
}

export function isValidWaifuId(value: string): boolean {
  return waifuIdPattern.test(value);
}
