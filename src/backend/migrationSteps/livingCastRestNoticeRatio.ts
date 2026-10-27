// Step `living-cast-drop-rest-notice-ratio-v1` (Living cast spec §26): the rest notice moved to the
// compaction trigger, so `life.restNoticeRatio` (a share of the old trigger) is gone, and the new
// `compaction.emergencyRatio` (default 0.9) must be above the trigger, which could be up to 0.95
// before. In `config.toml` the step drops `life.restNoticeRatio` and, when `compaction.triggerRatio`
// is at or above the emergency default and no `emergencyRatio` is set, writes one just above it
// (`emergencyAbove`: +0.04, at most 0.99). The file as it was is copied first to
// `user/.archive/living-cast/rest-notice-ratio/config.toml` (the first copy wins). Loading clamps the
// same way regardless (`loadAppConfig`), so a host never fails to start over it.
//
// A missing config, or one with nothing to change, is a no-op; an unparsable one is left for
// `loadAppConfig` to report and the step reports itself incomplete. Idempotent: a converted file has
// no such key, so a re-run leaves it byte-identical.

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";
import { DEFAULT_COMPACTION_SETTINGS, emergencyAbove } from "../../shared/schemas/compaction.js";
import { archivePath } from "./livingCastArchive.js";

export const DROP_REST_NOTICE_RATIO_STEP_ID = "living-cast-drop-rest-notice-ratio-v1";

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function migrateLivingCastDropRestNoticeRatio(dataRoot: string): Promise<MigrationStepOutcome> {
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
  let changed = false;
  const life = config.life;
  if (isTable(life) && "restNoticeRatio" in life) {
    delete life.restNoticeRatio;
    changed = true;
  }
  const compaction = config.compaction;
  if (isTable(compaction) && typeof compaction.triggerRatio === "number" && compaction.emergencyRatio === undefined && compaction.triggerRatio >= DEFAULT_COMPACTION_SETTINGS.emergencyRatio) {
    compaction.emergencyRatio = emergencyAbove(compaction.triggerRatio);
    changed = true;
  }
  if (!changed) return undefined;
  const archived = archivePath(dataRoot, "rest-notice-ratio", "config.toml");
  if (!(await lstat(archived).then(() => true, () => false))) await atomicWriteText(archived, raw, { mode: 0o600 });
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return DROP_REST_NOTICE_RATIO_STEP_ID;
}
