import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";

export const ProviderIdSchema = z.enum(["xai", "deepseek", "anthropic", "openai", "zai", "google-ai-studio"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "max", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ReasoningConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    effort: ReasoningEffortSchema.optional(),
    budgetTokens: z.number().int().positive().optional()
  })
  .default({});
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;

export const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm time.");
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

type DailyInterval = {
  start: string;
  end: string;
};

function timeOfDayMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function dailyIntervalRanges(interval: DailyInterval): Array<[number, number]> {
  const start = timeOfDayMinutes(interval.start);
  const end = timeOfDayMinutes(interval.end);
  if (start < end) return [[start, end]];
  return [[start, 24 * 60], [0, end]];
}

function dailyIntervalsOverlap(a: DailyInterval, b: DailyInterval): boolean {
  return dailyIntervalRanges(a).some(([aStart, aEnd]) =>
    dailyIntervalRanges(b).some(([bStart, bEnd]) => Math.max(aStart, bStart) < Math.min(aEnd, bEnd))
  );
}

export const WaifuSleepScheduleSchema = z
  .object({
    enabled: z.boolean().default(false),
    start: TimeOfDaySchema.default("23:00"),
    end: TimeOfDaySchema.default("07:00")
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.start === value.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "Sleep end time must differ from start time."
      });
    }
  })
  .default({
    enabled: false,
    start: "23:00",
    end: "07:00"
  });
export type WaifuSleepSchedule = z.infer<typeof WaifuSleepScheduleSchema>;

export const WaifuBusyIntervalSchema = z
  .object({
    start: TimeOfDaySchema,
    end: TimeOfDaySchema,
    reason: z.string().min(1)
  })
  .superRefine((value, ctx) => {
    if (value.start === value.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "Busy end time must differ from start time."
      });
    }
  });
export type WaifuBusyInterval = z.infer<typeof WaifuBusyIntervalSchema>;

export const WaifuAvailabilitySchema = z
  .object({
    sleep: WaifuSleepScheduleSchema,
    busy: z.array(WaifuBusyIntervalSchema).default([])
  })
  .superRefine((value, ctx) => {
    for (let i = 0; i < value.busy.length; i += 1) {
      for (let j = i + 1; j < value.busy.length; j += 1) {
        if (dailyIntervalsOverlap(value.busy[i], value.busy[j])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["busy", j],
            message: "Busy intervals cannot overlap."
          });
        }
      }
    }
  })
  .default({
    sleep: {
      enabled: false,
      start: "23:00",
      end: "07:00"
    },
    busy: []
  });
export type WaifuAvailability = z.infer<typeof WaifuAvailabilitySchema>;

export const WaifuToolSettingsSchema = z
  .object({
    toolUse: z.boolean().default(true)
  })
  .default({
    toolUse: true
  });
export type WaifuToolSettings = z.infer<typeof WaifuToolSettingsSchema>;

// Prompt layout: an ordered tree describing which prompt blocks live in each of the three
// model-message slots (top system prompt / mid system block / trailing system block), in what
// order, and how they are grouped inside named XML wrappers. Block *wording* is fixed in code
// (see src/orchestration/promptBlocks.ts); this only controls placement, order, grouping and
// enable/disable. Replaces the former flat boolean WaifuPromptSectionsSchema.
export const PromptLayoutBlockNodeSchema = z.object({
  kind: z.literal("block"),
  blockId: z.string().min(1),
  enabled: z.boolean().default(true)
});
export type PromptLayoutBlockNode = z.infer<typeof PromptLayoutBlockNodeSchema>;

export const PromptLayoutGroupNodeSchema = z.object({
  kind: z.literal("group"),
  id: z.string().min(1),
  // XML wrapper tag. May contain the `{name}` token, substituted with the waifu tag at render.
  tag: z.string().min(1),
  enabled: z.boolean().default(true),
  children: z.array(PromptLayoutBlockNodeSchema).default([])
});
export type PromptLayoutGroupNode = z.infer<typeof PromptLayoutGroupNodeSchema>;

export const PromptLayoutNodeSchema = z.discriminatedUnion("kind", [
  PromptLayoutBlockNodeSchema,
  PromptLayoutGroupNodeSchema
]);
export type PromptLayoutNode = z.infer<typeof PromptLayoutNodeSchema>;

export const WaifuPromptLayoutSchema = z
  .object({
    top: z.array(PromptLayoutNodeSchema),
    mid: z.array(PromptLayoutNodeSchema),
    trailing: z.array(PromptLayoutNodeSchema)
  })
  .default(() => defaultWaifuPromptLayout());
export type WaifuPromptLayout = z.infer<typeof WaifuPromptLayoutSchema>;

// The default arrangement reproduces the historical hardcoded prompt exactly: an identity block
// followed by a `<{name}_behavior>` group in the top slot, the director-notes/participants/emojis
// trio in the mid slot, and memories/personality-reminder/currently-doing/scene-direction in the
// trailing slot. New waifus get this via the schema default; the migration derives enable flags
// from the old booleans on top of it.
export function defaultWaifuPromptLayout(): WaifuPromptLayout {
  const block = (blockId: string): PromptLayoutBlockNode => ({ kind: "block", blockId, enabled: true });
  return {
    top: [
      block("identity"),
      {
        kind: "group",
        id: "behavior",
        tag: "{name}_behavior",
        enabled: true,
        children: [
          block("personality"),
          block("schedule"),
          block("contextStructure"),
          block("environment"),
          block("replyTargeting"),
          block("mentionPolicy"),
          block("styleConstraints"),
          block("hardRules"),
          block("toolUse")
        ]
      }
    ],
    mid: [block("directorNotes"), block("activeParticipants"), block("serverEmojis")],
    trailing: [
      block("relevantMemories"),
      block("personalityReminder"),
      block("currentlyDoing"),
      block("sceneDirection")
    ]
  };
}

export const ServerToolSettingsSchema = z
  .object({
    pickNextWaifu: z.boolean().default(false),
    shortTermMemory: z.boolean().default(true)
  })
  .default({
    pickNextWaifu: false,
    shortTermMemory: true
  });
export type ServerToolSettings = z.infer<typeof ServerToolSettingsSchema>;

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
    pausePlanning: z.boolean().default(true),
    messageStructure: z.boolean().default(true)
  })
  .default({
    pausePlanning: true,
    messageStructure: true
  });
export type OrchestratorPromptSections = z.infer<typeof OrchestratorPromptSectionsSchema>;

export const AgentConfigSchema = RevisionedRecordSchema.extend({
  enabled: z.boolean().default(false),
  providerId: z.union([ProviderIdSchema, z.null()]).optional().transform((value) => value ?? undefined),
  modelId: z.union([z.string(), z.null()]).optional().transform((value) => value ?? undefined),
  contextWindow: z.number().int().min(1).max(100).default(20),
  prompt: z.string().default(""),
  useLegacyPrompt: z.boolean().default(false),
  clipSceneDirection: z.boolean().default(false),
  directiveCooldown: z.number().int().min(0).max(20).default(3),
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
  reasoning: ReasoningConfigSchema,
  availability: WaifuAvailabilitySchema,
  tools: WaifuToolSettingsSchema,
  promptLayout: WaifuPromptLayoutSchema
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
  tools: ServerToolSettingsSchema,
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

export const ActiveChatParticipantSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  lastSeenAt: IsoDateStringSchema,
  expiresAt: IsoDateStringSchema
});
export type ActiveChatParticipant = z.infer<typeof ActiveChatParticipantSchema>;

export const ActiveChatParticipantsFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  participants: z.array(ActiveChatParticipantSchema)
});
export type ActiveChatParticipantsFile = z.infer<typeof ActiveChatParticipantsFileSchema>;

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

export const WaifuMemorySchema = z
  .object({
    id: z.string().min(1),
    waifuId: z.string().min(1),
    scope: z.literal("guild"),
    guildId: z.string().min(1).optional(),
    content: z.string().min(1),
    importance: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5)
    ]),
    permanent: z.boolean().default(false),
    createdAt: IsoDateStringSchema,
    updatedAt: IsoDateStringSchema,
    sourceMessageIds: z.array(z.string()),
    status: z.enum(["active", "archived"])
  })
  .superRefine((memory, ctx) => {
    if (memory.status === "active" && !memory.guildId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["guildId"],
        message: "Active memories must be assigned to a guild."
      });
    }
  });
export type WaifuMemory = z.infer<typeof WaifuMemorySchema>;

export const MemoryStoreSchema = RevisionedRecordSchema.extend({
  memories: z.array(WaifuMemorySchema)
});
export type MemoryStore = z.infer<typeof MemoryStoreSchema>;

export const ShortTermMemorySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  waifuId: z.string().min(1),
  content: z.string().min(1),
  createdAt: IsoDateStringSchema,
  expiresAt: IsoDateStringSchema
});
export type ShortTermMemory = z.infer<typeof ShortTermMemorySchema>;

export const ShortTermMemoryStoreSchema = RevisionedRecordSchema.extend({
  entries: z.array(ShortTermMemorySchema)
});
export type ShortTermMemoryStore = z.infer<typeof ShortTermMemoryStoreSchema>;

export const OrchestratorReplyStyleSchema = z.enum(["normal", "short", "long", "sleepy"]);
export type OrchestratorReplyStyle = z.infer<typeof OrchestratorReplyStyleSchema>;

export const OrchestratorDirectiveSchema = z.object({
  intent: z.string().min(1),
  // goal is stored in history for the dashboard; it is omitted from few-shot replay.
  goal: z.string().optional()
});
export type OrchestratorDirective = z.infer<typeof OrchestratorDirectiveSchema>;

export const OrchestratorRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  replyStyle: OrchestratorReplyStyleSchema.optional(),
  replyToMessageId: z.string().min(1).optional(),
  sceneDirection: z.string().min(1).optional(),
  directive: OrchestratorDirectiveSchema.optional()
});
export type OrchestratorRespondingWaifu = z.infer<typeof OrchestratorRespondingWaifuSchema>;

export const OrchestratorActionLogSchema = z.enum(["reply", "no_reply"]);

export const OrchestratorDecisionStatusSchema = z.enum(["pending", "completed", "interrupted", "failed"]);
export type OrchestratorDecisionStatus = z.infer<typeof OrchestratorDecisionStatusSchema>;

export const OrchestratorResponderOutcomeSourceSchema = z.enum(["orchestrator", "handoff"]);
export type OrchestratorResponderOutcomeSource = z.infer<typeof OrchestratorResponderOutcomeSourceSchema>;

export const OrchestratorResponderOutcomeStatusSchema = z.enum([
  "pending",
  "sent",
  "tool_only",
  "empty",
  "unavailable",
  "interrupted",
  "failed",
  "not_run"
]);
export type OrchestratorResponderOutcomeStatus = z.infer<typeof OrchestratorResponderOutcomeStatusSchema>;

export const OrchestratorResponderOutcomeSchema = z.object({
  id: z.string().min(1),
  waifuId: z.string().min(1),
  source: OrchestratorResponderOutcomeSourceSchema,
  handoffFromWaifuId: z.string().min(1).optional(),
  status: OrchestratorResponderOutcomeStatusSchema,
  reason: z.string().min(1).optional(),
  directiveStripped: z.enum(["cooldown", "over_cap"]).optional(),
  messageIds: z.array(z.string()).default([])
});
export type OrchestratorResponderOutcome = z.infer<typeof OrchestratorResponderOutcomeSchema>;

export const OrchestratorDecisionHistoryEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  action: OrchestratorActionLogSchema.default("reply"),
  respondingWaifus: z.array(OrchestratorRespondingWaifuSchema).default([]),
  retriggerAfterSeconds: z.number().min(0).optional(),
  wakePlan: z.string().optional(),
  reasoning: z.string().default(""),
  status: OrchestratorDecisionStatusSchema.default("completed"),
  waifuMessageIds: z.array(z.string()).default([]),
  responderOutcomes: z.array(OrchestratorResponderOutcomeSchema).default([]),
  createdAt: IsoDateStringSchema
});
export type OrchestratorDecisionHistoryEntry = z.infer<typeof OrchestratorDecisionHistoryEntrySchema>;

export const OrchestratorHistoryFileSchema = RevisionedRecordSchema.extend({
  decisions: z.array(OrchestratorDecisionHistoryEntrySchema)
});
export type OrchestratorHistoryFile = z.infer<typeof OrchestratorHistoryFileSchema>;

export const OrchestratorDebugRouteSchema = z.object({
  sourceGuildId: z.string().min(1).optional(),
  sourceChannelId: z.string().min(1),
  destinationGuildId: z.string().min(1).optional(),
  destinationChannelId: z.string().min(1),
  createdByUserId: z.string().min(1),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema
});
export type OrchestratorDebugRoute = z.infer<typeof OrchestratorDebugRouteSchema>;

export const OrchestratorDebugConfigFileSchema = RevisionedRecordSchema.extend({
  routes: z.record(z.string(), OrchestratorDebugRouteSchema).default({})
});
export type OrchestratorDebugConfigFile = z.infer<typeof OrchestratorDebugConfigFileSchema>;

export const StageManagerEditHistoryEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  tool: z.enum(["add_memory", "update_memory", "archive_memory", "merge_memories", "no_change"]),
  affectedMemoryIds: z.array(z.string()).default([]),
  summary: z.string().default(""),
  observationCount: z.number().int().min(0).optional(),
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
