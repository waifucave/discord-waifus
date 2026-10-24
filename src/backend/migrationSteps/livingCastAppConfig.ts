// Step `living-cast-app-config-v1` (Living cast spec §11.2): `config.toml` moves to the Living cast
// settings.
//
// - `memory.dreamHourLocal` → `life.maintenanceHourLocal`;
//   `memory.maxInlineImagesPerEpoch` → `life.maxInlineImagesPerEpoch` (at most 20 now);
//   `discord.dm.maxConcurrentRuns` → `life.maxConcurrentTurns` (at most 16 now). A `life` value
//   already there wins. Every other `memory.*` key is dropped with the table.
// - `discord.deletedMessages.redactRecent` is dropped (and the table when it is left empty).
// - `discord.debounce.dmMs` / `dmMaxWaitMs` still at the old defaults (1500 / 8000) become 30000 /
//   180000; any other value is the owner's choice and stays.
//
// A missing or unparsable config is left for `loadAppConfig` to report. Idempotent: a converted
// file has none of the old keys and no old defaults, so a re-run leaves it byte-identical.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";

export const LEGACY_DM_DEBOUNCE = { dmMs: 1_500, dmMaxWaitMs: 8_000 };
export const LIVING_CAST_DM_DEBOUNCE = { dmMs: 30_000, dmMaxWaitMs: 180_000 };

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

export async function migrateLivingCastAppConfig(dataRoot: string): Promise<string | undefined> {
  const filePath = path.join(dataRoot, "config.toml");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let config: unknown;
  try {
    config = parseToml(raw);
  } catch {
    return undefined;
  }
  if (!isTable(config)) return undefined;

  let changed = false;
  const life: Table = isTable(config.life) ? config.life : {};
  const carry = (key: string, value: number | undefined) => {
    if (value === undefined || life[key] !== undefined) return;
    life[key] = value;
  };

  if (config.memory !== undefined) {
    const memory = isTable(config.memory) ? config.memory : {};
    carry("maintenanceHourLocal", integerIn(memory.dreamHourLocal, 0, 23));
    carry("maxInlineImagesPerEpoch", integerIn(memory.maxInlineImagesPerEpoch, 0, 20));
    delete config.memory;
    changed = true;
  }

  const discord = isTable(config.discord) ? config.discord : undefined;
  if (discord) {
    if (isTable(discord.dm) && "maxConcurrentRuns" in discord.dm) {
      carry("maxConcurrentTurns", integerIn(discord.dm.maxConcurrentRuns, 1, 16));
      delete discord.dm.maxConcurrentRuns;
      changed = true;
    }
    if (isTable(discord.deletedMessages)) {
      if ("redactRecent" in discord.deletedMessages) {
        delete discord.deletedMessages.redactRecent;
        changed = true;
      }
      if (Object.keys(discord.deletedMessages).length === 0) {
        delete discord.deletedMessages;
        changed = true;
      }
    }
    if (isTable(discord.debounce)) {
      if (discord.debounce.dmMs === LEGACY_DM_DEBOUNCE.dmMs) {
        discord.debounce.dmMs = LIVING_CAST_DM_DEBOUNCE.dmMs;
        changed = true;
      }
      if (discord.debounce.dmMaxWaitMs === LEGACY_DM_DEBOUNCE.dmMaxWaitMs) {
        discord.debounce.dmMaxWaitMs = LIVING_CAST_DM_DEBOUNCE.dmMaxWaitMs;
        changed = true;
      }
    }
  }

  if (!changed) return undefined;
  if (Object.keys(life).length > 0) config.life = life;
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return "living-cast-app-config-v1";
}
