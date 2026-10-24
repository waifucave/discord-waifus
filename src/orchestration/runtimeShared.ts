// Types shared by the runtime facade (runtime.ts) and its store helpers.

import type { Logger } from "../backend/logger.js";
import type { DiscordGatewayFacade } from "../discord/client.js";
import type { StorageService } from "../storage/storageService.js";
import type { ImageCacheConfig, ImageFetcher } from "../discord/attachments.js";
import type { ImageRef } from "../shared/schemas/discordMessage.js";
import type { CompactionSettings } from "../shared/schemas/compaction.js";
import type { ConversationMessageCache } from "../discord/conversationCache.js";
import type { GuildDirectory } from "../discord/guildDirectory.js";
import type { UsageLedger } from "./usageLedger.js";
import type { ProviderAlerts } from "./providerAlerts.js";
import type { UpdateActivity } from "../backend/updates/activity.js";

export type RuntimeOrchestratorOptions = {
  updateActivity?: UpdateActivity;
  storage: StorageService;
  discord: DiscordGatewayFacade;
  logger: Logger;
  /** Defaults to the shared per-data-root instances. */
  usageLedger?: UsageLedger;
  providerAlerts?: ProviderAlerts;
  isPaused?: () => boolean;
  onActiveRunsChange?: (activeRuns: number) => void;
  ocr?: {
    /** Cached OCR text without running OCR (ImageOcrService.cachedText). */
    cachedText?(ref: ImageRef): Promise<string | undefined>;
    /** Bounded OCR (ImageOcrService.textFor). */
    textFor?(ref: ImageRef, o: { timeoutMs: number; signal?: AbortSignal }): Promise<string | undefined>;
    /** Drop cached OCR text for deleted images (ImageOcrService.purge). */
    purge?(keys: readonly string[]): Promise<void>;
    dispose?(): Promise<void>;
  };
  /** Shared Discord image fetcher (the OCR service's, spec 8.4); built over the data root when omitted. */
  images?: ImageFetcher;
  /** `AppConfig.discord.images`, used only when `images` is omitted. */
  imageConfig?: Partial<ImageCacheConfig>;
  /** `AppConfig.compaction` (applies to lives, Living cast §5.6). */
  compaction?: CompactionSettings;
  /** Prebuilt guild directory (tests); otherwise one is built over the data root (spec 9.4). */
  directory?: GuildDirectory;
  /** Prebuilt conversation cache (tests); otherwise one is built over the Discord facade (spec 9.4). */
  conversationCache?: ConversationMessageCache;
  /** `AppConfig.discord.debounce` (spec 9.2). */
  debounce?: Partial<import("../shared/schemas/config.js").DebounceConfig>;
  /** `AppConfig.discord.dm` (spec 9.1): the boot catch-up window. */
  dm?: Partial<import("../shared/schemas/config.js").DmRuntimeConfig>;
  /** `AppConfig.discord.memberListRefreshHours` (default 24, 0 = never). */
  memberListRefreshHours?: number;
  /** The whole app configuration (lives read `life`, `search`, `detector`, `compaction`, `models`). */
  appConfig?: import("../shared/schemas/config.js").AppConfig;
  /** The model client lives use (default: the shared client of the data root). */
  models?: import("../models/client.js").ModelClient;
  /** Test seams for the Living cast host. */
  livingCast?: Partial<import("../life/livingCast.js").LivingCastOptions>;
};

/** The narrow I/O services the store helpers need. */
export type RuntimeServices = Pick<RuntimeOrchestratorOptions, "storage" | "discord" | "logger" | "isPaused">;
