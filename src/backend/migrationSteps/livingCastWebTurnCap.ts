// Step `living-cast-web-turn-cap-6-v1` (Living cast spec §31.4): one Web script searches and opens
// several results, each counting against `life.webFetch.maxPerTurn`, so its default rose from 3 to 6.
// A saved config.toml spells every default out, so a value of exactly 3 (the old default) becomes 6;
// any other value is the owner's choice and stays.
//
// A missing config, or one without the key at 3, is a no-op; an unparsable one is left for
// `loadAppConfig` to report and the step reports itself incomplete. Idempotent: a converted file
// holds 6, so a re-run leaves it byte-identical.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";

export const WEB_TURN_CAP_STEP_ID = "living-cast-web-turn-cap-6-v1";
export const LEGACY_WEB_FETCH_MAX_PER_TURN = 3;
export const WEB_FETCH_MAX_PER_TURN = 6;

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function migrateLivingCastWebTurnCap(dataRoot: string): Promise<MigrationStepOutcome> {
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
    return { incomplete: "config.toml could not be parsed" };
  }
  if (!isTable(config)) return { incomplete: "config.toml is not a table" };
  const webFetch = isTable(config.life) ? config.life.webFetch : undefined;
  if (!isTable(webFetch) || webFetch.maxPerTurn !== LEGACY_WEB_FETCH_MAX_PER_TURN) return undefined;
  webFetch.maxPerTurn = WEB_FETCH_MAX_PER_TURN;
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return WEB_TURN_CAP_STEP_ID;
}
