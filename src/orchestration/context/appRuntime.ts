// The production ContextRuntime wiring (spec 8.3): one instance per RuntimeOrchestrator, shared by
// the waifu reply path (ResponderExecutor), the orchestrator (ChannelRunner) and later the
// background agents. Everything here is plain construction; behaviour lives in runtime.ts.

import type { Logger } from "../../backend/logger.js";
import { DiscordImageFetcher, type ImageCacheConfig, type ImageFetcher } from "../../discord/attachments.js";
import type { DiscordGatewayFacade } from "../../discord/client.js";
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "../../shared/schemas/compaction.js";
import { DEFAULT_APP_CONFIG, type MemoryConfig } from "../../shared/schemas/config.js";
import type { ServerConfig } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";
import { createStorageMemorySnapshotProvider } from "../memorySnapshot.js";
import { FileContextStore } from "./contextStore.js";
import { DiscordConversationSource } from "./fetchTranscript.js";
import type { OcrTextLookup } from "./images.js";
import { ContextRuntime, type CalibrationHook } from "./runtime.js";
import { NoopCompaction, type CompactionService } from "./types.js";

export type AppContextRuntimeOptions = {
  storage: StorageService;
  /** Resolved lazily: the Discord gateway can be swapped while the runtime lives. */
  discord: () => DiscordGatewayFacade | undefined;
  logger: Logger;
  /** Shared image fetcher (the OCR service's, spec 8.4). Built over the data root when omitted. */
  images?: ImageFetcher;
  /** `AppConfig.discord.images`, only used when `images` is omitted. */
  imageConfig?: Partial<ImageCacheConfig>;
  /** `AppConfig.compaction` (defaults when omitted); `ServerConfig.compaction` overrides per key. */
  compactionSettings?: CompactionSettings;
  /** `AppConfig.memory` (notes/images per epoch, pinned cap); defaults fill missing keys. */
  memory?: Partial<MemoryConfig>;
  /** Cached OCR text lookup (ImageOcrService.cachedText) for the image freeze rule. */
  ocr?: OcrTextLookup;
  /** T7b swaps in the real service; NoopCompaction until then. */
  compaction?: CompactionService;
  calibrate?: CalibrationHook;
  /** Test seams. */
  now?: () => Date;
  timeZone?: () => string;
};

/** App-level compaction settings with the server's per-key override applied (spec 6.6). */
export function resolveCompactionSettings(app: CompactionSettings | undefined, server?: ServerConfig): CompactionSettings {
  const base = { ...DEFAULT_COMPACTION_SETTINGS, ...app };
  const override = server?.compaction ?? {};
  const merged: CompactionSettings = { ...base };
  for (const [key, value] of Object.entries(override) as Array<[keyof CompactionSettings, unknown]>) {
    if (value !== undefined && value !== null) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export function createAppContextRuntime(o: AppContextRuntimeOptions): ContextRuntime {
  const memory: MemoryConfig = { ...DEFAULT_APP_CONFIG.memory, ...o.memory };
  const images =
    o.images ??
    new DiscordImageFetcher({
      dataRoot: o.storage.dataRoot,
      logger: o.logger,
      ...(o.imageConfig ? { config: o.imageConfig } : {})
    });
  return new ContextRuntime({
    store: new FileContextStore(o.storage, {
      ...(o.now ? { now: o.now } : {}),
      ...(o.timeZone ? { timeZone: o.timeZone } : {})
    }),
    snapshots: createStorageMemorySnapshotProvider(o.storage, {
      onStampError: (error) =>
        o.logger.warn("Failed to stamp memory retrieval", {
          message: error instanceof Error ? error.message : String(error)
        })
    }),
    compaction: o.compaction ?? NoopCompaction,
    messages: new DiscordConversationSource(o.discord),
    images,
    settings: (server) => resolveCompactionSettings(o.compactionSettings, server),
    logger: o.logger,
    memory: () => memory,
    ...(o.ocr ? { ocr: o.ocr } : {}),
    ...(o.calibrate ? { calibrate: o.calibrate } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.timeZone ? { timeZone: o.timeZone } : {})
  });
}
