import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "./common.js";
import { CompactionSettingsSchema } from "./compaction.js";

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
export const DiscordConfigSchema = z
  .object({ images: DiscordImagesConfigSchema, deletedMessages: DiscordDeletedMessagesConfigSchema })
  .default({ images: { ...DEFAULT_DISCORD_IMAGES }, deletedMessages: { ...DEFAULT_DELETED_MESSAGES } });
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  http: HttpConfigSchema,
  runtime: RuntimeConfigSchema,
  frontend: FrontendConfigSchema,
  ocr: OcrConfigSchema,
  compaction: CompactionSettingsSchema,
  memory: MemoryConfigSchema,
  discord: DiscordConfigSchema,
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
    deletedMessages: z.object({
      redactRecent: DELETED_MESSAGES_FIELDS.redactRecent.optional()
    }).strict().optional()
  }).strict().optional()
}).strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UpdateAppConfigBody = z.infer<typeof UpdateAppConfigBodySchema>;
export type OcrConfig = z.infer<typeof OcrConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
