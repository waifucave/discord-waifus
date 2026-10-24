import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "./common.js";
import { CompactionSettingsSchema } from "./compaction.js";
import { DEFAULT_ALLOWED_ROUTES, DEFAULT_MAX_OUTPUT_USD_PER_MTOK } from "../../models/defaults.js";

const HttpConfigSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(3888)
  })
  .default({ host: "127.0.0.1", port: 3888 });

const RuntimeConfigSchema = z
  .object({
    autoConnectDiscord: z.boolean().default(true),
    paused: z.boolean().default(false)
  })
  .default({ autoConnectDiscord: true, paused: false });

const FrontendConfigSchema = z
  .object({
    staticDir: z.string().optional()
  })
  .default({});

export const OcrConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    engine: z
      .preprocess(
        (value) => value === "tesseract" ? "system-tesseract" : value,
        z.enum(["auto", "apple-vision", "bundled-tesseract", "system-tesseract"])
      )
      .default("auto"),
    cacheTtlHours: z.number().int().min(1).max(24 * 30).default(168),
    timeoutMs: z.number().int().min(250).max(30_000).default(1_500),
    maxImageBytes: z.number().int().min(1024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
    maxImagesPerModelCall: z.number().int().min(0).max(20).default(4),
    maxTextCharsPerImage: z.number().int().min(100).max(10_000).default(1_500)
  })
  .default({
    enabled: true,
    engine: "auto",
    cacheTtlHours: 168,
    timeoutMs: 1_500,
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerModelCall: 4,
    maxTextCharsPerImage: 1_500
  });

// Per-waifu memory/context tuning (spec 8.2). dmInjectionLimit is the DM snapshot size (Phase 5).
const MEMORY_FIELDS = {
  dreamHourLocal: z.number().int().min(0).max(23),
  maxPinnedInjected: z.number().int().min(0).max(20),
  maxMemoryNotesPerEpoch: z.number().int().min(0).max(20),
  maxInlineImagesPerEpoch: z.number().int().min(0).max(32),
  dmInjectionLimit: z.number().int().min(1).max(50)
};
const DEFAULT_MEMORY_CONFIG = {
  dreamHourLocal: 5,
  maxPinnedInjected: 6,
  maxMemoryNotesPerEpoch: 6,
  maxInlineImagesPerEpoch: 8,
  dmInjectionLimit: 12
};
export const MemoryConfigSchema = z
  .object({
    dreamHourLocal: MEMORY_FIELDS.dreamHourLocal.default(DEFAULT_MEMORY_CONFIG.dreamHourLocal),
    maxPinnedInjected: MEMORY_FIELDS.maxPinnedInjected.default(DEFAULT_MEMORY_CONFIG.maxPinnedInjected),
    maxMemoryNotesPerEpoch: MEMORY_FIELDS.maxMemoryNotesPerEpoch.default(DEFAULT_MEMORY_CONFIG.maxMemoryNotesPerEpoch),
    maxInlineImagesPerEpoch: MEMORY_FIELDS.maxInlineImagesPerEpoch.default(DEFAULT_MEMORY_CONFIG.maxInlineImagesPerEpoch),
    dmInjectionLimit: MEMORY_FIELDS.dmInjectionLimit.default(DEFAULT_MEMORY_CONFIG.dmInjectionLimit)
  })
  .default({ ...DEFAULT_MEMORY_CONFIG });
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// Discord image fetching/caching (spec 8.4). Phase 5 adds debounce/dm/deletedMessages siblings.
const DISCORD_IMAGE_FIELDS = {
  maxBytes: z.number().int().min(64 * 1024).max(20 * 1024 * 1024),
  fetchTimeoutMs: z.number().int().min(500).max(30_000),
  memoryCacheMb: z.number().int().min(0).max(512),
  diskCacheMb: z.number().int().min(0).max(2048),
  diskCacheTtlHours: z.number().int().min(1).max(720)
};
const DEFAULT_DISCORD_IMAGES = {
  maxBytes: 5 * 1024 * 1024,
  fetchTimeoutMs: 5_000,
  memoryCacheMb: 64,
  diskCacheMb: 256,
  diskCacheTtlHours: 168
};
const DiscordImagesConfigSchema = z
  .object({
    maxBytes: DISCORD_IMAGE_FIELDS.maxBytes.default(DEFAULT_DISCORD_IMAGES.maxBytes),
    fetchTimeoutMs: DISCORD_IMAGE_FIELDS.fetchTimeoutMs.default(DEFAULT_DISCORD_IMAGES.fetchTimeoutMs),
    memoryCacheMb: DISCORD_IMAGE_FIELDS.memoryCacheMb.default(DEFAULT_DISCORD_IMAGES.memoryCacheMb),
    diskCacheMb: DISCORD_IMAGE_FIELDS.diskCacheMb.default(DEFAULT_DISCORD_IMAGES.diskCacheMb),
    diskCacheTtlHours: DISCORD_IMAGE_FIELDS.diskCacheTtlHours.default(DEFAULT_DISCORD_IMAGES.diskCacheTtlHours)
  })
  .default({ ...DEFAULT_DISCORD_IMAGES });
// Spec 9.5 (hybrid delete): a deleted message among the newest `redactRecent` ledger entries (or
// not yet seen by any model) becomes "(message deleted)"; older ones keep the cached transcript.
const DELETED_MESSAGES_FIELDS = { redactRecent: z.number().int().min(0).max(200) };
const DEFAULT_DELETED_MESSAGES = { redactRecent: 20 };
const DiscordDeletedMessagesConfigSchema = z
  .object({ redactRecent: DELETED_MESSAGES_FIELDS.redactRecent.default(DEFAULT_DELETED_MESSAGES.redactRecent) })
  .default({ ...DEFAULT_DELETED_MESSAGES });
// I2 debounce (spec 9.2/9.8): a burst of human messages costs one pass. `serverMs: 0` restores
// the pre-debounce behaviour (every message starts a run at once).
const DEBOUNCE_FIELDS = {
  serverMs: z.number().int().min(0).max(30_000),
  serverMaxWaitMs: z.number().int().min(0).max(120_000),
  dmMs: z.number().int().min(0).max(30_000),
  dmMaxWaitMs: z.number().int().min(0).max(120_000)
};
export const DEFAULT_DEBOUNCE = { serverMs: 1200, serverMaxWaitMs: 4000, dmMs: 1500, dmMaxWaitMs: 8000 };
const DiscordDebounceConfigSchema = z
  .object({
    serverMs: DEBOUNCE_FIELDS.serverMs.default(DEFAULT_DEBOUNCE.serverMs),
    serverMaxWaitMs: DEBOUNCE_FIELDS.serverMaxWaitMs.default(DEFAULT_DEBOUNCE.serverMaxWaitMs),
    dmMs: DEBOUNCE_FIELDS.dmMs.default(DEFAULT_DEBOUNCE.dmMs),
    dmMaxWaitMs: DEBOUNCE_FIELDS.dmMaxWaitMs.default(DEFAULT_DEBOUNCE.dmMaxWaitMs)
  })
  .default({ ...DEFAULT_DEBOUNCE });
export type DebounceConfig = z.infer<typeof DiscordDebounceConfigSchema>;
// DM runner (spec 9.1/9.8): concurrent DM generations across all waifus, and how old a missed
// DM may be for boot/resume catch-up.
const DM_RUNTIME_FIELDS = {
  maxConcurrentRuns: z.number().int().min(1).max(32),
  resumeWindowMinutes: z.number().int().min(0).max(1440)
};
export const DEFAULT_DM_RUNTIME = { maxConcurrentRuns: 4, resumeWindowMinutes: 60 };
const DiscordDmConfigSchema = z
  .object({
    maxConcurrentRuns: DM_RUNTIME_FIELDS.maxConcurrentRuns.default(DEFAULT_DM_RUNTIME.maxConcurrentRuns),
    resumeWindowMinutes: DM_RUNTIME_FIELDS.resumeWindowMinutes.default(DEFAULT_DM_RUNTIME.resumeWindowMinutes)
  })
  .default({ ...DEFAULT_DM_RUNTIME });
export type DmRuntimeConfig = z.infer<typeof DiscordDmConfigSchema>;
// Guild directory (spec 9.4/9.8): the privileged GuildMembers intent is opt-in (O7) and re-logs
// the orchestrator when changed; the full member list is re-fetched every N hours (0 = never).
const DEFAULT_GUILD_MEMBERS_INTENT = false;
const DEFAULT_MEMBER_LIST_REFRESH_HOURS = 24;
export const DiscordConfigSchema = z
  .object({
    images: DiscordImagesConfigSchema,
    guildMembersIntent: z.boolean().default(DEFAULT_GUILD_MEMBERS_INTENT),
    memberListRefreshHours: z.number().int().min(0).max(168).default(DEFAULT_MEMBER_LIST_REFRESH_HOURS),
    deletedMessages: DiscordDeletedMessagesConfigSchema,
    debounce: DiscordDebounceConfigSchema,
    dm: DiscordDmConfigSchema
  })
  .default({
    images: { ...DEFAULT_DISCORD_IMAGES },
    guildMembersIntent: DEFAULT_GUILD_MEMBERS_INTENT,
    memberListRefreshHours: DEFAULT_MEMBER_LIST_REFRESH_HOURS,
    deletedMessages: { ...DEFAULT_DELETED_MESSAGES },
    debounce: { ...DEFAULT_DEBOUNCE },
    dm: { ...DEFAULT_DM_RUNTIME }
  });
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

// Curated model catalog (Living cast §9.2): the allowed winter routes and the output price cap.
export const DEFAULT_MODELS_CONFIG = {
  allowed: [...DEFAULT_ALLOWED_ROUTES],
  maxOutputUsdPerMTok: DEFAULT_MAX_OUTPUT_USD_PER_MTOK
};
const MODEL_ROUTE_RE = /^[a-z0-9][a-z0-9._-]*\/\S+$/u;
const MODELS_FIELDS = {
  allowed: z.array(z.string().regex(MODEL_ROUTE_RE, "Use a winter route key such as anthropic/claude-sonnet-5-5.")).max(100),
  // D6: never above $10 per million output tokens; the owner may only lower it.
  maxOutputUsdPerMTok: z.number().positive().max(10)
};
const ModelsConfigSchema = z
  .object({
    allowed: MODELS_FIELDS.allowed.default(() => [...DEFAULT_MODELS_CONFIG.allowed]),
    maxOutputUsdPerMTok: MODELS_FIELDS.maxOutputUsdPerMTok.default(DEFAULT_MODELS_CONFIG.maxOutputUsdPerMTok)
  })
  .default(() => ({ allowed: [...DEFAULT_MODELS_CONFIG.allowed], maxOutputUsdPerMTok: DEFAULT_MODELS_CONFIG.maxOutputUsdPerMTok }));
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  http: HttpConfigSchema,
  runtime: RuntimeConfigSchema,
  frontend: FrontendConfigSchema,
  ocr: OcrConfigSchema,
  compaction: CompactionSettingsSchema,
  memory: MemoryConfigSchema,
  discord: DiscordConfigSchema,
  models: ModelsConfigSchema,
  updates: z.object({
    enabled: z.boolean().default(false),
    checkIntervalMinutes: z.number().int().min(15).max(1440).default(60),
    idleMinutes: z.number().int().min(1).max(120).default(5)
  }).default({ enabled: false, checkIntervalMinutes: 60, idleMinutes: 5 })
});

// App config writes are partial updates. Re-declare every defaulted field without its default so
// an omitted key remains absent through parsing and cannot reset a stored nondefault value.
export const UpdateAppConfigBodySchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).optional(),
  http: z.object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional()
  }).strict().optional(),
  runtime: z.object({
    autoConnectDiscord: z.boolean().optional(),
    paused: z.boolean().optional()
  }).strict().optional(),
  frontend: z.object({
    staticDir: z.string().min(1).nullable().optional()
  }).strict().optional(),
  updates: z.object({
    enabled: z.boolean().optional(),
    checkIntervalMinutes: z.number().int().min(15).max(1440).optional(),
    idleMinutes: z.number().int().min(1).max(120).optional()
  }).strict().optional(),
  ocr: z.object({
    enabled: z.boolean().optional(),
    engine: z.preprocess(
      (value) => value === "tesseract" ? "system-tesseract" : value,
      z.enum(["auto", "apple-vision", "bundled-tesseract", "system-tesseract"])
    ).optional(),
    cacheTtlHours: z.number().int().min(1).max(24 * 30).optional(),
    timeoutMs: z.number().int().min(250).max(30_000).optional(),
    maxImageBytes: z.number().int().min(1024).max(32 * 1024 * 1024).optional(),
    maxImagesPerModelCall: z.number().int().min(0).max(20).optional(),
    maxTextCharsPerImage: z.number().int().min(100).max(10_000).optional()
  }).strict().optional(),
  compaction: z.object({
    enabled: z.boolean().optional(),
    triggerRatio: z.number().min(0.3).max(0.95).optional(),
    maxMessages: z.number().int().min(20).max(200).optional(),
    keepRecent: z.number().int().min(5).max(120).optional(),
    waitTimeoutMs: z.number().int().min(0).max(30_000).optional()
  }).strict().optional(),
  memory: z.object({
    dreamHourLocal: MEMORY_FIELDS.dreamHourLocal.optional(),
    maxPinnedInjected: MEMORY_FIELDS.maxPinnedInjected.optional(),
    maxMemoryNotesPerEpoch: MEMORY_FIELDS.maxMemoryNotesPerEpoch.optional(),
    maxInlineImagesPerEpoch: MEMORY_FIELDS.maxInlineImagesPerEpoch.optional(),
    dmInjectionLimit: MEMORY_FIELDS.dmInjectionLimit.optional()
  }).strict().optional(),
  discord: z.object({
    images: z.object({
      maxBytes: DISCORD_IMAGE_FIELDS.maxBytes.optional(),
      fetchTimeoutMs: DISCORD_IMAGE_FIELDS.fetchTimeoutMs.optional(),
      memoryCacheMb: DISCORD_IMAGE_FIELDS.memoryCacheMb.optional(),
      diskCacheMb: DISCORD_IMAGE_FIELDS.diskCacheMb.optional(),
      diskCacheTtlHours: DISCORD_IMAGE_FIELDS.diskCacheTtlHours.optional()
    }).strict().optional(),
    guildMembersIntent: z.boolean().optional(),
    memberListRefreshHours: z.number().int().min(0).max(168).optional(),
    deletedMessages: z.object({
      redactRecent: DELETED_MESSAGES_FIELDS.redactRecent.optional()
    }).strict().optional(),
    debounce: z.object({
      serverMs: DEBOUNCE_FIELDS.serverMs.optional(),
      serverMaxWaitMs: DEBOUNCE_FIELDS.serverMaxWaitMs.optional(),
      dmMs: DEBOUNCE_FIELDS.dmMs.optional(),
      dmMaxWaitMs: DEBOUNCE_FIELDS.dmMaxWaitMs.optional()
    }).strict().optional(),
    dm: z.object({
      maxConcurrentRuns: DM_RUNTIME_FIELDS.maxConcurrentRuns.optional(),
      resumeWindowMinutes: DM_RUNTIME_FIELDS.resumeWindowMinutes.optional()
    }).strict().optional()
  }).strict().optional(),
  models: z.object({
    allowed: MODELS_FIELDS.allowed.optional(),
    maxOutputUsdPerMTok: MODELS_FIELDS.maxOutputUsdPerMTok.optional()
  }).strict().optional()
}).strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UpdateAppConfigBody = z.infer<typeof UpdateAppConfigBodySchema>;
export type OcrConfig = z.infer<typeof OcrConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
