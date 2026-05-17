import { readFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { AppConfig, AppConfigSchema, DEFAULT_APP_CONFIG } from "../shared/schemas/config.js";
import { atomicWriteText } from "../storage/atomic.js";
import { resolveDataPath } from "./paths.js";

export async function loadAppConfig(dataRoot: string): Promise<AppConfig> {
  const configPath = resolveDataPath(dataRoot, "config.toml");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parse(raw);
    return AppConfigSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_APP_CONFIG;
    }
    throw error;
  }
}

export async function saveAppConfig(dataRoot: string, config: AppConfig): Promise<AppConfig> {
  const parsed = AppConfigSchema.parse(config);
  await atomicWriteText(resolveDataPath(dataRoot, "config.toml"), stringify(parsed) + "\n", {
    mode: 0o600
  });
  return parsed;
}
