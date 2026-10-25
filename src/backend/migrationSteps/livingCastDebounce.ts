// Step `living-cast-typing-holds-v1` (Living cast spec §4.2, §11.2): typing-aware holds make the
// long quiet timers unnecessary. `discord.debounce` values still at an earlier default move to the
// new defaults; any other value is the owner's choice and stays:
//
// - `dmMs` 15000 (the L2 default) → 2500; `dmMaxWaitMs` 180000 → 60000;
// - `serverMs` 1200 → 1500; `serverMaxWaitMs` 4000 → 10000 (the room hold now also covers direct
//   wakes and typing, so its cap is the room's longest hold).
//
// A missing config or one without the table is a no-op; an unparsable one is left for
// `loadAppConfig` to report and the step reports itself incomplete. Idempotent: a converted file
// holds none of the earlier defaults, so a re-run leaves it byte-identical.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";

/** Earlier defaults → the typing-hold defaults, per `discord.debounce` key. */
export const TYPING_HOLD_DEBOUNCE_MOVES: Record<string, { from: number; to: number }> = {
  dmMs: { from: 15_000, to: 2_500 },
  dmMaxWaitMs: { from: 180_000, to: 60_000 },
  serverMs: { from: 1_200, to: 1_500 },
  serverMaxWaitMs: { from: 4_000, to: 10_000 }
};

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function migrateLivingCastTypingHolds(dataRoot: string): Promise<MigrationStepOutcome> {
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
  const debounce = isTable(config.discord) && isTable(config.discord.debounce) ? config.discord.debounce : undefined;
  if (!debounce) return undefined;
  let changed = false;
  for (const [key, move] of Object.entries(TYPING_HOLD_DEBOUNCE_MOVES)) {
    if (debounce[key] !== move.from) continue;
    debounce[key] = move.to;
    changed = true;
  }
  if (!changed) return undefined;
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return "living-cast-typing-holds-v1";
}
