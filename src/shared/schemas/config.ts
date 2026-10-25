import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "./common.js";
import { CompactionSettingsSchema } from "./compaction.js";
import { DEFAULT_ALLOWED_ROUTES, DEFAULT_MAX_OUTPUT_USD_PER_MTOK } from "../../models/defaults.js";
import { DEFAULT_DETECTOR_TARGET, DetectorTargetOrNoneSchema } from "./detector.js";

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

// Discord image fetching/caching (spec 8.4). Phase 5 adds debounce/dm siblings.
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
// Debounce (spec 9.2, Living cast §4.1, §4.2): the channel debounce batches a burst for the
// addressee detector only; the DM timer is the `dm` wake's quiet period (30 s after the user's last
// message, capped at `dmMaxWaitMs`).
const DEBOUNCE_FIELDS = {
  serverMs: z.number().int().min(0).max(30_000),
  serverMaxWaitMs: z.number().int().min(0).max(120_000),
  dmMs: z.number().int().min(0).max(120_000),
  dmMaxWaitMs: z.number().int().min(0).max(300_000)
};
export const DEFAULT_DEBOUNCE = { serverMs: 1200, serverMaxWaitMs: 4000, dmMs: 30_000, dmMaxWaitMs: 180_000 };
const DiscordDebounceConfigSchema = z
  .object({
    serverMs: DEBOUNCE_FIELDS.serverMs.default(DEFAULT_DEBOUNCE.serverMs),
    serverMaxWaitMs: DEBOUNCE_FIELDS.serverMaxWaitMs.default(DEFAULT_DEBOUNCE.serverMaxWaitMs),
    dmMs: DEBOUNCE_FIELDS.dmMs.default(DEFAULT_DEBOUNCE.dmMs),
    dmMaxWaitMs: DEBOUNCE_FIELDS.dmMaxWaitMs.default(DEFAULT_DEBOUNCE.dmMaxWaitMs)
  })
  .default({ ...DEFAULT_DEBOUNCE });
export type DebounceConfig = z.infer<typeof DiscordDebounceConfigSchema>;
// Boot catch-up (Living cast §5.7): messages that arrived while the host was down wake her only
// when they are at most this old (`discord.dm.resumeWindowMinutes`, guilds and DMs alike).
const DM_RUNTIME_FIELDS = {
  resumeWindowMinutes: z.number().int().min(0).max(1440)
};
export const DEFAULT_DM_RUNTIME = { resumeWindowMinutes: 60 };
const DiscordDmConfigSchema = z
  .object({
    resumeWindowMinutes: DM_RUNTIME_FIELDS.resumeWindowMinutes.default(DEFAULT_DM_RUNTIME.resumeWindowMinutes)
  })
  .default({ ...DEFAULT_DM_RUNTIME });
export type DmRuntimeConfig = z.infer<typeof DiscordDmConfigSchema>;
// Guild directory (spec 9.4/9.8): the privileged GuildMembers intent is opt-in (O7) and re-logs
// the House bot when changed; the full member list is re-fetched every N hours (0 = never).
const DEFAULT_GUILD_MEMBERS_INTENT = false;
const DEFAULT_MEMBER_LIST_REFRESH_HOURS = 24;
export const DiscordConfigSchema = z
  .object({
    images: DiscordImagesConfigSchema,
    guildMembersIntent: z.boolean().default(DEFAULT_GUILD_MEMBERS_INTENT),
    memberListRefreshHours: z.number().int().min(0).max(168).default(DEFAULT_MEMBER_LIST_REFRESH_HOURS),
    debounce: DiscordDebounceConfigSchema,
    dm: DiscordDmConfigSchema
  })
  .default({
    images: { ...DEFAULT_DISCORD_IMAGES },
    guildMembersIntent: DEFAULT_GUILD_MEMBERS_INTENT,
    memberListRefreshHours: DEFAULT_MEMBER_LIST_REFRESH_HOURS,
    debounce: { ...DEFAULT_DEBOUNCE },
    dm: { ...DEFAULT_DM_RUNTIME }
  });
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;


const MODEL_ROUTE_RE = /^[a-z0-9][a-z0-9._-]*\/\S+$/u;

// Curated model catalog (Living cast §9.2): the allowed winter routes and the output price cap.
export const DEFAULT_MODELS_CONFIG = {
  allowed: [...DEFAULT_ALLOWED_ROUTES],
  maxOutputUsdPerMTok: DEFAULT_MAX_OUTPUT_USD_PER_MTOK
};
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

// WebFetch (spec §6.9): the digest model ("" = the cheapest offered route with a key; a
// contributor route only when named here), caps, the fetch bounds and the page cache.
const WEB_FETCH_FIELDS = {
  model: z.union([z.literal(""), z.string().regex(MODEL_ROUTE_RE, "Use a winter route key such as openai/gpt-6-luna.")]),
  maxPerWaifuPerDay: z.number().int().min(0).max(500),
  maxPerTurn: z.number().int().min(0).max(20),
  directMaxChars: z.number().int().min(0).max(20_000),
  maxBytes: z.number().int().min(64 * 1024).max(10 * 1024 * 1024),
  timeoutMs: z.number().int().min(2_000).max(60_000),
  maxRedirects: z.number().int().min(0).max(10),
  cacheMinutes: z.number().int().min(0).max(1_440)
};
export const DEFAULT_WEB_FETCH_CONFIG = {
  model: "",
  maxPerWaifuPerDay: 20,
  maxPerTurn: 3,
  directMaxChars: 2_000,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 5,
  cacheMinutes: 15
};
const WebFetchConfigSchema = z
  .object({
    model: WEB_FETCH_FIELDS.model.default(DEFAULT_WEB_FETCH_CONFIG.model),
    maxPerWaifuPerDay: WEB_FETCH_FIELDS.maxPerWaifuPerDay.default(DEFAULT_WEB_FETCH_CONFIG.maxPerWaifuPerDay),
    maxPerTurn: WEB_FETCH_FIELDS.maxPerTurn.default(DEFAULT_WEB_FETCH_CONFIG.maxPerTurn),
    directMaxChars: WEB_FETCH_FIELDS.directMaxChars.default(DEFAULT_WEB_FETCH_CONFIG.directMaxChars),
    maxBytes: WEB_FETCH_FIELDS.maxBytes.default(DEFAULT_WEB_FETCH_CONFIG.maxBytes),
    timeoutMs: WEB_FETCH_FIELDS.timeoutMs.default(DEFAULT_WEB_FETCH_CONFIG.timeoutMs),
    maxRedirects: WEB_FETCH_FIELDS.maxRedirects.default(DEFAULT_WEB_FETCH_CONFIG.maxRedirects),
    cacheMinutes: WEB_FETCH_FIELDS.cacheMinutes.default(DEFAULT_WEB_FETCH_CONFIG.cacheMinutes)
  })
  .default({ ...DEFAULT_WEB_FETCH_CONFIG });
export type WebFetchConfig = z.infer<typeof WebFetchConfigSchema>;

// Her own machine (spec §16.10): her folders' limits, downloads, attachments she sends and the
// simulated Bash.
const HOME_FIELDS = {
  maxBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024),
  maxFiles: z.number().int().min(10).max(20_000),
  maxFolders: z.number().int().min(10).max(5_000)
};
const TMP_FIELDS = {
  maxBytes: z.number().int().min(1024 * 1024).max(2 * 1024 * 1024 * 1024),
  maxFiles: z.number().int().min(10).max(20_000),
  retentionDays: z.number().int().min(1).max(90)
};
const ATTACHMENT_FIELDS = { maxBytes: z.number().int().min(64 * 1024).max(50 * 1024 * 1024) };
const SEND_FIELDS = { maxFiles: z.number().int().min(0).max(10) };
const BASH_FIELDS = {
  enabled: z.boolean(),
  python: z.boolean(),
  maxTimeoutMs: z.number().int().min(1_000).max(300_000),
  maxOutputChars: z.number().int().min(1_000).max(100_000),
  maxMemoryMb: z.number().int().min(128).max(4_096)
};
export const DEFAULT_HOME_CONFIG = { maxBytes: 50 * 1024 * 1024, maxFiles: 2_000, maxFolders: 500 };
export const DEFAULT_TMP_CONFIG = { maxBytes: 200 * 1024 * 1024, maxFiles: 2_000, retentionDays: 7 };
export const DEFAULT_ATTACHMENTS_CONFIG = { maxBytes: 10 * 1024 * 1024 };
export const DEFAULT_SEND_CONFIG = { maxFiles: 4 };
export const DEFAULT_BASH_CONFIG = { enabled: true, python: true, maxTimeoutMs: 60_000, maxOutputChars: 16_000, maxMemoryMb: 512 };
const HomeConfigSchema = z
  .object({
    maxBytes: HOME_FIELDS.maxBytes.default(DEFAULT_HOME_CONFIG.maxBytes),
    maxFiles: HOME_FIELDS.maxFiles.default(DEFAULT_HOME_CONFIG.maxFiles),
    maxFolders: HOME_FIELDS.maxFolders.default(DEFAULT_HOME_CONFIG.maxFolders)
  })
  .default({ ...DEFAULT_HOME_CONFIG });
const TmpConfigSchema = z
  .object({
    maxBytes: TMP_FIELDS.maxBytes.default(DEFAULT_TMP_CONFIG.maxBytes),
    maxFiles: TMP_FIELDS.maxFiles.default(DEFAULT_TMP_CONFIG.maxFiles),
    retentionDays: TMP_FIELDS.retentionDays.default(DEFAULT_TMP_CONFIG.retentionDays)
  })
  .default({ ...DEFAULT_TMP_CONFIG });
const AttachmentsConfigSchema = z.object({ maxBytes: ATTACHMENT_FIELDS.maxBytes.default(DEFAULT_ATTACHMENTS_CONFIG.maxBytes) }).default({ ...DEFAULT_ATTACHMENTS_CONFIG });
const SendConfigSchema = z.object({ maxFiles: SEND_FIELDS.maxFiles.default(DEFAULT_SEND_CONFIG.maxFiles) }).default({ ...DEFAULT_SEND_CONFIG });
const BashConfigSchema = z
  .object({
    enabled: BASH_FIELDS.enabled.default(DEFAULT_BASH_CONFIG.enabled),
    python: BASH_FIELDS.python.default(DEFAULT_BASH_CONFIG.python),
    maxTimeoutMs: BASH_FIELDS.maxTimeoutMs.default(DEFAULT_BASH_CONFIG.maxTimeoutMs),
    maxOutputChars: BASH_FIELDS.maxOutputChars.default(DEFAULT_BASH_CONFIG.maxOutputChars),
    maxMemoryMb: BASH_FIELDS.maxMemoryMb.default(DEFAULT_BASH_CONFIG.maxMemoryMb)
  })
  .default({ ...DEFAULT_BASH_CONFIG });

// Living cast (spec §11.3): the life loop's limits. `maxContextTokens` stays below the lowest
// long-context price tier in the curated list.
const LIFE_FIELDS = {
  maxConcurrentTurns: z.number().int().min(1).max(16),
  maxToolRounds: z.number().int().min(1).max(30),
  maxTurnMs: z.number().int().min(30_000).max(600_000),
  maxLogMessages: z.number().int().min(50).max(2_000),
  maxContextTokens: z.number().int().min(32_000).max(100_000),
  maxInlineImagesPerEpoch: z.number().int().min(0).max(20),
  maxInlineImageBytesPerEpoch: z.number().int().min(0).max(20_971_520),
  maxSendPlacesPerTurn: z.number().int().min(1).max(10),
  maxSendsPerTurn: z.number().int().min(1).max(50),
  maxWakesPerUserPerHour: z.number().int().min(1).max(200),
  maxWatchFiresPerDay: z.number().int().min(1).max(100),
  maxWaifuTriggeredTurns: z.number().int().min(0).max(100),
  maintenanceHourLocal: z.number().int().min(0).max(23)
};
export const DEFAULT_LIFE_CONFIG = {
  maxConcurrentTurns: 4,
  maxToolRounds: 12,
  maxTurnMs: 180_000,
  maxLogMessages: 400,
  maxContextTokens: 96_000,
  maxInlineImagesPerEpoch: 8,
  maxInlineImageBytesPerEpoch: 12_582_912,
  maxSendPlacesPerTurn: 3,
  maxSendsPerTurn: 8,
  maxWakesPerUserPerHour: 20,
  maxWatchFiresPerDay: 24,
  maxWaifuTriggeredTurns: 0,
  maintenanceHourLocal: 5
};
export const LifeConfigSchema = z
  .object({
    maxConcurrentTurns: LIFE_FIELDS.maxConcurrentTurns.default(DEFAULT_LIFE_CONFIG.maxConcurrentTurns),
    maxToolRounds: LIFE_FIELDS.maxToolRounds.default(DEFAULT_LIFE_CONFIG.maxToolRounds),
    maxTurnMs: LIFE_FIELDS.maxTurnMs.default(DEFAULT_LIFE_CONFIG.maxTurnMs),
    maxLogMessages: LIFE_FIELDS.maxLogMessages.default(DEFAULT_LIFE_CONFIG.maxLogMessages),
    maxContextTokens: LIFE_FIELDS.maxContextTokens.default(DEFAULT_LIFE_CONFIG.maxContextTokens),
    maxInlineImagesPerEpoch: LIFE_FIELDS.maxInlineImagesPerEpoch.default(DEFAULT_LIFE_CONFIG.maxInlineImagesPerEpoch),
    maxInlineImageBytesPerEpoch: LIFE_FIELDS.maxInlineImageBytesPerEpoch.default(DEFAULT_LIFE_CONFIG.maxInlineImageBytesPerEpoch),
    maxSendPlacesPerTurn: LIFE_FIELDS.maxSendPlacesPerTurn.default(DEFAULT_LIFE_CONFIG.maxSendPlacesPerTurn),
    maxSendsPerTurn: LIFE_FIELDS.maxSendsPerTurn.default(DEFAULT_LIFE_CONFIG.maxSendsPerTurn),
    maxWakesPerUserPerHour: LIFE_FIELDS.maxWakesPerUserPerHour.default(DEFAULT_LIFE_CONFIG.maxWakesPerUserPerHour),
    maxWatchFiresPerDay: LIFE_FIELDS.maxWatchFiresPerDay.default(DEFAULT_LIFE_CONFIG.maxWatchFiresPerDay),
    maxWaifuTriggeredTurns: LIFE_FIELDS.maxWaifuTriggeredTurns.default(DEFAULT_LIFE_CONFIG.maxWaifuTriggeredTurns),
    maintenanceHourLocal: LIFE_FIELDS.maintenanceHourLocal.default(DEFAULT_LIFE_CONFIG.maintenanceHourLocal),
    webFetch: WebFetchConfigSchema,
    home: HomeConfigSchema,
    tmp: TmpConfigSchema,
    attachments: AttachmentsConfigSchema,
    send: SendConfigSchema,
    bash: BashConfigSchema
  })
  .default({
    ...DEFAULT_LIFE_CONFIG,
    webFetch: { ...DEFAULT_WEB_FETCH_CONFIG },
    home: { ...DEFAULT_HOME_CONFIG },
    tmp: { ...DEFAULT_TMP_CONFIG },
    attachments: { ...DEFAULT_ATTACHMENTS_CONFIG },
    send: { ...DEFAULT_SEND_CONFIG },
    bash: { ...DEFAULT_BASH_CONFIG }
  });
export type LifeConfig = z.infer<typeof LifeConfigSchema>;

// WebSearch (spec §6.8): Exa's hosted MCP server, keyless by default; an Exa key saved as the `exa`
// provider credential is the fallback. Host-wide and per-waifu caps; 0 disables search.
const SEARCH_FIELDS = {
  maxPerSecond: z.number().int().min(0).max(10),
  maxPerDay: z.number().int().min(0).max(10_000),
  maxPerWaifuPerDay: z.number().int().min(0).max(10_000)
};
export const DEFAULT_SEARCH_CONFIG = { maxPerSecond: 2, maxPerDay: 50, maxPerWaifuPerDay: 20 };
const SearchConfigSchema = z
  .object({
    maxPerSecond: SEARCH_FIELDS.maxPerSecond.default(DEFAULT_SEARCH_CONFIG.maxPerSecond),
    maxPerDay: SEARCH_FIELDS.maxPerDay.default(DEFAULT_SEARCH_CONFIG.maxPerDay),
    maxPerWaifuPerDay: SEARCH_FIELDS.maxPerWaifuPerDay.default(DEFAULT_SEARCH_CONFIG.maxPerWaifuPerDay)
  })
  .default({ ...DEFAULT_SEARCH_CONFIG });
export type SearchConfig = z.infer<typeof SearchConfigSchema>;

// The addressee detector (spec §4.3): the global native-choice target ("" = none).
const DetectorConfigSchema = z
  .object({ target: DetectorTargetOrNoneSchema.default(DEFAULT_DETECTOR_TARGET) })
  .default({ target: DEFAULT_DETECTOR_TARGET });
export type DetectorConfig = z.infer<typeof DetectorConfigSchema>;

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  http: HttpConfigSchema,
  runtime: RuntimeConfigSchema,
  frontend: FrontendConfigSchema,
  ocr: OcrConfigSchema,
  compaction: CompactionSettingsSchema,
  discord: DiscordConfigSchema,
  models: ModelsConfigSchema,
  life: LifeConfigSchema,
  search: SearchConfigSchema,
  detector: DetectorConfigSchema,
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
    debounce: z.object({
      serverMs: DEBOUNCE_FIELDS.serverMs.optional(),
      serverMaxWaitMs: DEBOUNCE_FIELDS.serverMaxWaitMs.optional(),
      dmMs: DEBOUNCE_FIELDS.dmMs.optional(),
      dmMaxWaitMs: DEBOUNCE_FIELDS.dmMaxWaitMs.optional()
    }).strict().optional(),
    dm: z.object({
      resumeWindowMinutes: DM_RUNTIME_FIELDS.resumeWindowMinutes.optional()
    }).strict().optional()
  }).strict().optional(),
  models: z.object({
    allowed: MODELS_FIELDS.allowed.optional(),
    maxOutputUsdPerMTok: MODELS_FIELDS.maxOutputUsdPerMTok.optional()
  }).strict().optional(),
  life: z.object({
    maxConcurrentTurns: LIFE_FIELDS.maxConcurrentTurns.optional(),
    maxToolRounds: LIFE_FIELDS.maxToolRounds.optional(),
    maxTurnMs: LIFE_FIELDS.maxTurnMs.optional(),
    maxLogMessages: LIFE_FIELDS.maxLogMessages.optional(),
    maxContextTokens: LIFE_FIELDS.maxContextTokens.optional(),
    maxInlineImagesPerEpoch: LIFE_FIELDS.maxInlineImagesPerEpoch.optional(),
    maxInlineImageBytesPerEpoch: LIFE_FIELDS.maxInlineImageBytesPerEpoch.optional(),
    maxSendPlacesPerTurn: LIFE_FIELDS.maxSendPlacesPerTurn.optional(),
    maxSendsPerTurn: LIFE_FIELDS.maxSendsPerTurn.optional(),
    maxWakesPerUserPerHour: LIFE_FIELDS.maxWakesPerUserPerHour.optional(),
    maxWatchFiresPerDay: LIFE_FIELDS.maxWatchFiresPerDay.optional(),
    maxWaifuTriggeredTurns: LIFE_FIELDS.maxWaifuTriggeredTurns.optional(),
    maintenanceHourLocal: LIFE_FIELDS.maintenanceHourLocal.optional(),
    webFetch: z.object({
      model: WEB_FETCH_FIELDS.model.optional(),
      maxPerWaifuPerDay: WEB_FETCH_FIELDS.maxPerWaifuPerDay.optional(),
      maxPerTurn: WEB_FETCH_FIELDS.maxPerTurn.optional(),
      directMaxChars: WEB_FETCH_FIELDS.directMaxChars.optional(),
      maxBytes: WEB_FETCH_FIELDS.maxBytes.optional(),
      timeoutMs: WEB_FETCH_FIELDS.timeoutMs.optional(),
      maxRedirects: WEB_FETCH_FIELDS.maxRedirects.optional(),
      cacheMinutes: WEB_FETCH_FIELDS.cacheMinutes.optional()
    }).strict().optional(),
    home: z.object({ maxBytes: HOME_FIELDS.maxBytes.optional(), maxFiles: HOME_FIELDS.maxFiles.optional(), maxFolders: HOME_FIELDS.maxFolders.optional() }).strict().optional(),
    tmp: z.object({ maxBytes: TMP_FIELDS.maxBytes.optional(), maxFiles: TMP_FIELDS.maxFiles.optional(), retentionDays: TMP_FIELDS.retentionDays.optional() }).strict().optional(),
    attachments: z.object({ maxBytes: ATTACHMENT_FIELDS.maxBytes.optional() }).strict().optional(),
    send: z.object({ maxFiles: SEND_FIELDS.maxFiles.optional() }).strict().optional(),
    bash: z.object({
      enabled: BASH_FIELDS.enabled.optional(),
      python: BASH_FIELDS.python.optional(),
      maxTimeoutMs: BASH_FIELDS.maxTimeoutMs.optional(),
      maxOutputChars: BASH_FIELDS.maxOutputChars.optional(),
      maxMemoryMb: BASH_FIELDS.maxMemoryMb.optional()
    }).strict().optional()
  }).strict().optional(),
  search: z.object({
    maxPerSecond: SEARCH_FIELDS.maxPerSecond.optional(),
    maxPerDay: SEARCH_FIELDS.maxPerDay.optional(),
    maxPerWaifuPerDay: SEARCH_FIELDS.maxPerWaifuPerDay.optional()
  }).strict().optional(),
  detector: z.object({
    target: DetectorTargetOrNoneSchema.optional()
  }).strict().optional()
}).strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UpdateAppConfigBody = z.infer<typeof UpdateAppConfigBodySchema>;
export type OcrConfig = z.infer<typeof OcrConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
