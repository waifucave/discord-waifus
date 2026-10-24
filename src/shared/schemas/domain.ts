import { z } from "zod";
import { OneShotConfigSchema } from "./oneShot.js";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";
import { CompactionOverrideSchema } from "./compaction.js";
import { WaifuDmSettingsSchema, defaultWaifuDmSettings } from "./dm.js";
import { ChannelThreadsModeSchema } from "./threads.js";

// A winter catalog provider id (`anthropic`, `openrouter`, …). Unknown ids are rejected at API
// write time — see src/api/writeValidation.ts's assertKnownProvider, which checks the installed
// winter catalog.
export const ProviderIdSchema = z.string().min(1);

/**
 * A model choice (Living cast spec §9.2): a curated winter route plus an optional reasoning effort
 * from the route's own list. The route is validated against the curated catalog at write time;
 * stored efforts are re-validated at every boot (src/backend/migrationSteps/modelEffortCheck.ts).
 */
export const ModelChoiceSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  effort: z.string().min(1).optional()
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

// Explicit `null` on write means "unset" (the PUT handlers delete the key from the merged object);
// plain `.optional()` alone cannot tell "send null to unset" from "field omitted, leave untouched".
const OptionalModelChoiceSchema = z.union([ModelChoiceSchema, z.null()]).optional().transform((value) => value ?? undefined);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

const TimeOfDaySchema = z
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

const WaifuSleepScheduleSchema = z
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

const WaifuBusyIntervalSchema = z
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

const ProviderCredentialsSchema = z.object({
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
  // A missing flag means enabled: the runtime historically logged in every bot with a token.
  enabled: z.boolean().default(true)
});
export type DiscordBotConfig = z.infer<typeof DiscordBotConfigSchema>;

export const DiscordBotsFileSchema = RevisionedRecordSchema.extend({
  orchestrator: DiscordBotConfigSchema.nullable(),
  waifus: z.array(DiscordBotConfigSchema)
});
export type DiscordBotsFile = z.infer<typeof DiscordBotsFileSchema>;

/**
 * `user/assistant/config.json`: the dashboard assistant's own model (Living cast spec §9.3). When
 * unset, the assistant uses the first configured waifu's model.
 */
export const AssistantConfigSchema = RevisionedRecordSchema.extend({
  model: OptionalModelChoiceSchema
});
export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;

export const WAIFU_VERBOSITIES = ["terse", "chatty", "expressive"] as const;
export type WaifuVerbosity = (typeof WAIFU_VERBOSITIES)[number];

export const WaifuConfigSchema = RevisionedRecordSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),
  persona: z.string().default(""),
  // Living cast §9.2: nested model choice (living-cast-models-v1 converted the flat gateway
  // providerId/modelId/params). Explicit `null` on write unsets it.
  model: OptionalModelChoiceSchema,
  botId: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => value ?? undefined),
  availability: WaifuAvailabilitySchema,
  // Phase 4 prompt settings (spec 8.2); Living cast's life harness (L2) reads them.
  verbosity: z.enum(WAIFU_VERBOSITIES).default("terse"),
  customInstructions: z.string().max(4000).default(""),
  scheduleInPrompt: z.boolean().default(true),
  // Phase 5 DM settings (spec 9.1).
  dm: WaifuDmSettingsSchema.default(() => defaultWaifuDmSettings())
});
export type WaifuConfig = z.infer<typeof WaifuConfigSchema>;

export const ServerConfigSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  name: z.string().optional(),
  // B29: optional overrides (precedence: explicit server override > agent/waifu `contextWindow`).
  // Files written before Phase 4 carry all three keys; they parse unchanged until the
  // server-context-windows-explicit-v1 migration drops keys equal to the old defaults.
  contextWindows: z
    .object({
      orchestrator: z.number().int().min(1).max(200).optional(),
      waifu: z.number().int().min(1).max(200).optional(),
      stageManager: z.number().int().min(1).max(200).optional()
    })
    .default({}),
  // Per-server override of AppConfig.compaction; absent keys inherit.
  compaction: CompactionOverrideSchema.optional(),
  memoryInjectionLimit: z.number().int().min(1).max(50).default(12),
  // "model" uses the globally configured orchestrator model; "deterministic" forces the
  // model-free structural decider for every channel of this guild (zero orchestration spend).
  orchestratorMode: z.enum(["model", "deterministic", "one-shot"]).default("model"),
  oneShot: OneShotConfigSchema,
  // Per-guild kill switch for the stage manager's automatic work (idle observers + dreams).
  stageManagerEnabled: z.boolean().default(true),
  // Temporary per-guild mute: messages are observed (sessions stay warm) but nothing runs
  // and nothing is scheduled until unpaused. This is the server's kill switch (spec 9.7): the
  // old server/channel `enabled` flags are gone, a channel is live when it has an enabled waifu.
  paused: z.boolean().default(false),
  tools: ServerToolSettingsSchema,
  channels: z.record(
    z.string(),
    z.object({
      channelId: z.string().min(1),
      name: z.string().optional(),
      enabledWaifuIds: z.array(z.string()).default([]),
      // Spec 9.5 / O2: do this channel's threads and forum posts inherit its cast ("inherit") or
      // stay silent ("off")? Absent means "inherit" (kept optional, not defaulted, so older writers
      // and partial PUTs never manufacture or reset it). A thread with an explicit entry of its own
      // is not affected.
      threads: ChannelThreadsModeSchema.optional(),
      // Runtime-only (ensureServer's thread overlay, stores/threads.ts): marks a virtual entry for
      // a thread that inherits `parentId`'s cast. Never persisted; the API never returns it.
      thread: z
        .object({
          parentId: z.string().min(1),
          lastActivityAt: IsoDateStringSchema.optional(),
          /** The thread has an entry (and cast) of its own; the overlay only adds its state. */
          explicit: z.boolean().optional(),
          /** Archived or locked: the entry keeps its cast but takes no part until unarchived. */
          silenced: z.boolean().optional()
        })
        .optional()
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

// W3 unified memory record. Replaces the former WaifuMemory/ShortTermMemory split: a
// "short-term memory" is now just a record with source "waifu_tool", kind "context", and an
// expiresAt. Old persisted records (importance/permanent/scope/sourceMessageIds) are migrated by
// shape detection in runMigrations BEFORE any read can default these fields — see migrateMemoryStoreV2.
export const MEMORY_KINDS = ["fact", "preference", "relationship", "event", "commitment", "context"] as const;
export const MemoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MEMORY_SOURCES = ["waifu_tool", "stage_manager", "dream", "user"] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// Phase 4 (spec 8.8, D2): memories are global per waifu. Where a memory was learned is provenance
// only (`origin`), never a retrieval filter. Subjects are the people/waifus the memory is about,
// keyed by stable ids; `name` is the last-known display name (refreshed at render time).
export const MemoryOriginSchema = z.object({
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  dm: z.literal(true).optional(),
  // DM provenance (spec 9.1.4): the Discord user of the private chat, so forgetting a user
  // finds every DM-origin record and the same-origin boost stays inside that user's own DM.
  userId: z.string().min(1).optional()
});
export type MemoryOrigin = z.infer<typeof MemoryOriginSchema>;

export const MemorySubjectSchema = z.object({
  discordUserId: z.string().min(1).optional(),
  waifuId: z.string().min(1).optional(),
  name: z.string().min(1)
});
export type MemorySubject = z.infer<typeof MemorySubjectSchema>;

export const MEMORY_ARCHIVED_REASONS = ["merged", "expired", "deduped", "user", "unknown_waifu"] as const;
export const MemoryArchivedReasonSchema = z.enum(MEMORY_ARCHIVED_REASONS);
export type MemoryArchivedReason = z.infer<typeof MemoryArchivedReasonSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  waifuId: z.string().min(1),
  content: z.string().min(1),
  kind: MemoryKindSchema.default("fact"),
  source: MemorySourceSchema.default("stage_manager"),
  pinned: z.boolean().default(false), // user-managed; never auto-edited, always injected
  strength: z.number().min(0).max(5).default(3),
  origin: MemoryOriginSchema.default({}),
  subjects: z.array(MemorySubjectSchema).default([]),
  // Per-record optimistic-concurrency counter: every content write bumps it (API, observer ops,
  // dream, waifu tool, archival); retrieval statistics (lastRetrievedAt) never do.
  revision: z.number().int().nonnegative().default(0),
  expiresAt: IsoDateStringSchema.optional(), // hard TTL (waifu notes); absent = durable
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  lastRetrievedAt: IsoDateStringSchema.optional(),
  status: z.enum(["active", "archived"]).default("active"),
  archivedReason: MemoryArchivedReasonSchema.optional(),
  mergedInto: z.string().min(1).optional()
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryStoreSchema = RevisionedRecordSchema.extend({
  memories: z.array(MemoryRecordSchema)
});
export type MemoryStore = z.infer<typeof MemoryStoreSchema>;

export const PendingObservationSchema = z.object({
  id: z.string().min(1),
  waifuId: z.string().min(1),
  content: z.string().min(1),
  kind: MemoryKindSchema,
  importance: z.number().int().min(1).max(5),
  subjects: z.array(MemorySubjectSchema).default([]),
  origin: MemoryOriginSchema.default({}),
  // The conversation the observer read (`g_<guild>_<channel>` | `dm_<user>_<waifu>`).
  conversationKey: z.string().min(1).optional(),
  createdAt: IsoDateStringSchema
});
export type PendingObservation = z.infer<typeof PendingObservationSchema>;

export const PendingObservationsFileSchema = RevisionedRecordSchema.extend({
  observations: z.array(PendingObservationSchema)
});
export type PendingObservationsFile = z.infer<typeof PendingObservationsFileSchema>;

const OrchestratorDirectiveSchema = z.object({
  intent: z.string().min(1),
  // goal is stored in history for the dashboard; it is omitted from few-shot replay.
  goal: z.string().optional()
});
export type OrchestratorDirective = z.infer<typeof OrchestratorDirectiveSchema>;

export const OrchestratorRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  replyToMessageId: z.string().min(1).optional(),
  directive: OrchestratorDirectiveSchema.optional()
});
export type OrchestratorRespondingWaifu = z.infer<typeof OrchestratorRespondingWaifuSchema>;

const OrchestratorActionLogSchema = z.enum(["reply", "no_reply"]);

export const OrchestratorDecisionStatusSchema = z.enum(["pending", "completed", "interrupted", "failed"]);
export type OrchestratorDecisionStatus = z.infer<typeof OrchestratorDecisionStatusSchema>;

const OrchestratorResponderOutcomeSourceSchema = z.enum(["orchestrator", "handoff"]);
export type OrchestratorResponderOutcomeSource = z.infer<typeof OrchestratorResponderOutcomeSourceSchema>;

const OrchestratorResponderOutcomeStatusSchema = z.enum([
  "pending",
  "sent",
  "tool_only",
  "empty",
  "blocked",
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

const OrchestratorDebugRouteSchema = z.object({
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

const StageManagerEditHistoryEntrySchema = z.object({
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

const ReviewerHistoryEntrySchema = z.object({
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
