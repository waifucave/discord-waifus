// What a life needs from the rest of the app (Living cast spec §3): storage, Discord, the
// conversation cache and directory, the model client, images and OCR, the web tools, configuration
// and a clock. Built once by the LivingCast host; tests pass fakes.

import type { Logger } from "../backend/logger.js";
import type { DiscordGatewayFacade } from "../discord/client.js";
import type { ConversationMessageCache } from "../discord/conversationCache.js";
import type { GuildDirectory } from "../discord/guildDirectory.js";
import type { ImageFetcher } from "../discord/attachments.js";
import type { ModelClient } from "../models/client.js";
import type { CuratedCatalog } from "../models/catalog.js";
import type { OcrTextLookup } from "../orchestration/context/images.js";
import type { AppConfig } from "../shared/schemas/config.js";
import type { StorageService } from "../storage/storageService.js";
import type { WebTools } from "./search.js";

/** The image fetcher plus the pin hook (images an epoch shows inline are exempt from cache eviction, §5.3). */
export type LifeImageFetcher = ImageFetcher & {
  /** Replace the pinned keys of one owner (a waifu's current epoch). */
  setPins?(owner: string, keys: readonly string[]): void;
};

export type LifeDeps = {
  storage: StorageService;
  logger: Logger;
  discord: () => DiscordGatewayFacade | undefined;
  conversations: ConversationMessageCache;
  directory: Pick<GuildDirectory, "view" | "memberName" | "findEmoji" | "members">;
  models: ModelClient;
  images?: LifeImageFetcher;
  ocr?: OcrTextLookup;
  web?: WebTools;
  config: () => AppConfig;
  /** The curated catalog under the current `[models]` config. */
  catalog: () => CuratedCatalog;
  now: () => Date;
  /** The host's IANA time zone (her schedule, time lines, reminders). */
  timeZone: string;
  random: () => number;
  /** Typing delays and pacing; tests pass an instant one. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  isPaused: () => boolean;
};
