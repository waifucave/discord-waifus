import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";

export const ProviderIdSchema = z.enum(["xai", "deepseek", "anthropic", "openai", "zai"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ReasoningConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    effort: ReasoningEffortSchema.optional(),
    budgetTokens: z.number().int().positive().optional()
  })
  .default({});
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;

export const ProviderCredentialsSchema = z.object({
  providerId: ProviderIdSchema,
  apiKey: z.string().min(1),
  label: z.string().optional(),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema
});
export type ProviderCredentials = z.infer<typeof ProviderCredentialsSchema>;

export const ProviderCredentialsFileSchema = RevisionedRecordSchema.extend({
  providers: z.record(z.string(), ProviderCredentialsSchema)
});
export type ProviderCredentialsFile = z.infer<typeof ProviderCredentialsFileSchema>;

export const DiscordBotConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  applicationId: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  enabled: z.boolean().default(false)
});
export type DiscordBotConfig = z.infer<typeof DiscordBotConfigSchema>;

export const DiscordBotsFileSchema = RevisionedRecordSchema.extend({
  orchestrator: DiscordBotConfigSchema.nullable(),
  waifus: z.array(DiscordBotConfigSchema)
});
export type DiscordBotsFile = z.infer<typeof DiscordBotsFileSchema>;

export const OrchestratorPromptSectionsSchema = z
  .object({
    loopBreaking: z.boolean().default(true),
    idleTriggerPacing: z.boolean().default(true),
    messageStructure: z.boolean().default(true),
    toolUse: z.boolean().default(true)
  })
  .default({
    loopBreaking: true,
    idleTriggerPacing: true,
    messageStructure: true,
    toolUse: true
  });
export type OrchestratorPromptSections = z.infer<typeof OrchestratorPromptSectionsSchema>;

export const AgentConfigSchema = RevisionedRecordSchema.extend({
  enabled: z.boolean().default(false),
  providerId: z.union([ProviderIdSchema, z.null()]).optional().transform((value) => value ?? undefined),
  modelId: z.union([z.string(), z.null()]).optional().transform((value) => value ?? undefined),
  contextWindow: z.number().int().min(1).max(100).default(20),
  prompt: z.string().default(""),
  reasoning: ReasoningConfigSchema,
  promptSections: OrchestratorPromptSectionsSchema
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const WaifuConfigSchema = RevisionedRecordSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),
  persona: z.string().default(""),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().optional(),
  botId: z.string().optional(),
  contextWindow: z.number().int().min(1).max(100).default(50),
  generation: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      maxOutputTokens: z.number().int().positive().optional()
    })
    .default({}),
  reasoning: ReasoningConfigSchema
});
export type WaifuConfig = z.infer<typeof WaifuConfigSchema>;

export const ServerConfigSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().default(false),
  contextWindows: z
    .object({
      orchestrator: z.number().int().min(1).max(100).default(20),
      waifu: z.number().int().min(1).max(100).default(50),
      stageManager: z.number().int().min(1).max(100).default(80)
    })
    .default({ orchestrator: 20, waifu: 50, stageManager: 80 }),
  channels: z.record(
    z.string(),
    z.object({
      channelId: z.string().min(1),
      name: z.string().optional(),
      enabled: z.boolean().default(false),
      enabledWaifuIds: z.array(z.string()).default([])
    })
  ).default({})
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const GuildMemberCacheEntrySchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1).optional(),
  globalDisplayName: z.string().optional(),
  guildDisplayName: z.string().optional(),
  bot: z.boolean().default(false),
  lastSeenAt: IsoDateStringSchema.optional(),
  perChannelLastSeenAt: z.record(z.string(), IsoDateStringSchema).default({})
});
export type GuildMemberCacheEntry = z.infer<typeof GuildMemberCacheEntrySchema>;

export const GuildMembersFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  members: z.array(GuildMemberCacheEntrySchema)
});
export type GuildMembersFile = z.infer<typeof GuildMembersFileSchema>;

export const GuildEmojiCacheEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  animated: z.boolean().default(false),
  available: z.boolean().default(true),
  roles: z.array(z.string()).default([]),
  fetchedAt: IsoDateStringSchema
});
export type GuildEmojiCacheEntry = z.infer<typeof GuildEmojiCacheEntrySchema>;

export const GuildEmojisFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  emojis: z.array(GuildEmojiCacheEntrySchema)
});
export type GuildEmojisFile = z.infer<typeof GuildEmojisFileSchema>;

export const GuildRoleCacheEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.number().int().nonnegative().default(0),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
  managed: z.boolean().default(false),
  fetchedAt: IsoDateStringSchema
});
export type GuildRoleCacheEntry = z.infer<typeof GuildRoleCacheEntrySchema>;

export const GuildRolesFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  roles: z.array(GuildRoleCacheEntrySchema)
});
export type GuildRolesFile = z.infer<typeof GuildRolesFileSchema>;

export const WaifuMemorySchema = z.object({
  id: z.string().min(1),
  waifuId: z.string().min(1),
  scope: z.enum(["global", "guild", "channel", "user"]),
  content: z.string().min(1),
  importance: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5)
  ]),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  sourceMessageIds: z.array(z.string()),
  status: z.enum(["active", "archived"])
});
export type WaifuMemory = z.infer<typeof WaifuMemorySchema>;

export const MemoryStoreSchema = RevisionedRecordSchema.extend({
  memories: z.array(WaifuMemorySchema)
});
export type MemoryStore = z.infer<typeof MemoryStoreSchema>;

export const OrchestratorDecisionStepSchema = z.object({
  kind: z.string().min(1),
  sceneDirection: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional()
});
export type OrchestratorDecisionStep = z.infer<typeof OrchestratorDecisionStepSchema>;

export const OrchestratorDecisionHistoryEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  steps: z.array(OrchestratorDecisionStepSchema).default([]),
  idleTrigger: z
    .union([
      z.literal(180),
      z.literal(300),
      z.literal(900),
      z.literal(1800),
      z.literal(3600),
      z.literal(7200),
      z.literal(14400)
    ])
    .optional(),
  reasoning: z.string().default(""),
  createdAt: IsoDateStringSchema
});
export type OrchestratorDecisionHistoryEntry = z.infer<typeof OrchestratorDecisionHistoryEntrySchema>;

export const OrchestratorHistoryFileSchema = RevisionedRecordSchema.extend({
  decisions: z.array(OrchestratorDecisionHistoryEntrySchema)
});
export type OrchestratorHistoryFile = z.infer<typeof OrchestratorHistoryFileSchema>;

export const StageManagerEditHistoryEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  tool: z.enum(["add_memory", "update_memory", "archive_memory", "merge_memories", "no_change"]),
  affectedMemoryIds: z.array(z.string()).default([]),
  summary: z.string().default(""),
  createdAt: IsoDateStringSchema
});
export type StageManagerEditHistoryEntry = z.infer<typeof StageManagerEditHistoryEntrySchema>;

export const StageManagerHistoryFileSchema = RevisionedRecordSchema.extend({
  edits: z.array(StageManagerEditHistoryEntrySchema)
});
export type StageManagerHistoryFile = z.infer<typeof StageManagerHistoryFileSchema>;

export const ReviewerHistoryEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  reviewerUserId: z.string().optional(),
  targetMessageIds: z.array(z.string()).default([]),
  hallucination: z.boolean(),
  deleted: z.boolean().default(false),
  createdAt: IsoDateStringSchema
});
export type ReviewerHistoryEntry = z.infer<typeof ReviewerHistoryEntrySchema>;

export const ReviewerHistoryFileSchema = RevisionedRecordSchema.extend({
  reviews: z.array(ReviewerHistoryEntrySchema)
});
export type ReviewerHistoryFile = z.infer<typeof ReviewerHistoryFileSchema>;

export function createEmptyRevisionedFile<T extends Record<string, unknown>>(extra: T) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    ...extra
  };
}
