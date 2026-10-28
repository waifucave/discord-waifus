// Step `living-cast-send-cap-15-v1` (Living cast spec §27.1): one SendMessage script sends several
// short messages, each counting against `life.maxSendsPerTurn`, so its default rose from 8 to 15. A
// saved config.toml spells every default out, so a value of exactly 8 (the old default) becomes 15;
// any other value is the owner's choice and stays.
//
// A missing config, or one without the key at 8, is a no-op; an unparsable one is left for
// `loadAppConfig` to report and the step reports itself incomplete. Idempotent: a converted file
// holds 15, so a re-run leaves it byte-identical.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";

export const SEND_CAP_STEP_ID = "living-cast-send-cap-15-v1";
export const LEGACY_MAX_SENDS_PER_TURN = 8;
export const MAX_SENDS_PER_TURN = 15;

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function migrateLivingCastSendCap(dataRoot: string): Promise<MigrationStepOutcome> {
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
  const life = config.life;
  if (!isTable(life) || life.maxSendsPerTurn !== LEGACY_MAX_SENDS_PER_TURN) return undefined;
  life.maxSendsPerTurn = MAX_SENDS_PER_TURN;
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return SEND_CAP_STEP_ID;
}
