import { readFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import {
  AppConfig,
  AppConfigSchema,
  DEFAULT_APP_CONFIG,
  UpdateAppConfigBodySchema,
  type UpdateAppConfigBody
} from "../shared/schemas/config.js";
import { CompactionRatiosSchema, withEmergencyAboveTrigger } from "../shared/schemas/compaction.js";
import { atomicWriteText } from "../storage/atomic.js";
import { resolveDataPath } from "./paths.js";

export async function loadAppConfig(dataRoot: string): Promise<AppConfig> {
  const configPath = resolveDataPath(dataRoot, "config.toml");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = AppConfigSchema.parse(parse(raw));
    // Never refuse to start over the compaction ratios (§26): the emergency moves above the trigger.
    return { ...parsed, compaction: withEmergencyAboveTrigger(parsed.compaction) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_APP_CONFIG;
    }
    throw error;
  }
}

async function saveAppConfig(dataRoot: string, config: AppConfig): Promise<AppConfig> {
  const parsed = AppConfigSchema.parse(config);
  await atomicWriteText(resolveDataPath(dataRoot, "config.toml"), stringify(parsed) + "\n", {
    mode: 0o600
  });
  return parsed;
}

export function mergeAppConfigPatch(
  current: AppConfig,
  patchInput: UpdateAppConfigBody
): AppConfig {
  const patch = UpdateAppConfigBodySchema.parse(patchInput);
  const frontend = { ...current.frontend };
  if (patch.frontend && Object.prototype.hasOwnProperty.call(patch.frontend, "staticDir")) {
    if (patch.frontend.staticDir === null) {
      delete frontend.staticDir;
    } else if (patch.frontend.staticDir !== undefined) {
      frontend.staticDir = patch.frontend.staticDir;
    }
  }
  const life: Record<string, unknown> = { ...current.life, ...patch.life };
  // An explicit null unsets the dream model (the dream uses her own model again).
  if (patch.life && Object.prototype.hasOwnProperty.call(patch.life, "dreamModel") && patch.life.dreamModel === null) delete life["dreamModel"];
  const merged = AppConfigSchema.parse({
    ...current,
    ...patch,
    http: { ...current.http, ...patch.http },
    runtime: { ...current.runtime, ...patch.runtime },
    frontend,
    ocr: { ...current.ocr, ...patch.ocr },
    compaction: { ...current.compaction, ...patch.compaction },
    discord: {
      ...current.discord,
      ...patch.discord,
      images: { ...current.discord.images, ...patch.discord?.images },
      debounce: { ...current.discord.debounce, ...patch.discord?.debounce },
      dm: { ...current.discord.dm, ...patch.discord?.dm }
    },
    models: { ...current.models, ...patch.models },
    life: {
      ...life,
      webFetch: { ...current.life.webFetch, ...patch.life?.webFetch },
      home: { ...current.life.home, ...patch.life?.home },
      tmp: { ...current.life.tmp, ...patch.life?.tmp },
      attachments: { ...current.life.attachments, ...patch.life?.attachments },
      send: { ...current.life.send, ...patch.life?.send },
      bash: { ...current.life.bash, ...patch.life?.bash }
    },
    search: { ...current.search, ...patch.search },
    detector: { ...current.detector, ...patch.detector },
    updates: { ...current.updates, ...patch.updates }
  });
  // An update never leaves the emergency at or below the rest point (§26): a ZodError, so a 400.
  CompactionRatiosSchema.parse(merged.compaction);
  return merged;
}

export async function updateAppConfig(
  dataRoot: string,
  patch: UpdateAppConfigBody
): Promise<AppConfig> {
  return saveAppConfig(dataRoot, mergeAppConfigPatch(await loadAppConfig(dataRoot), patch));
}
