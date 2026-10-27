// Step `living-cast-drop-rest-notice-ratio-v1` (Living cast spec §26): the rest notice moved to the
// compaction trigger, so `life.restNoticeRatio` (a share of the old trigger) is gone. The key is
// dropped from `config.toml`; the file as it was is copied first to
// `user/.archive/living-cast/rest-notice-ratio/config.toml` (the first copy wins).
//
// A missing config, or one without the key, is a no-op; an unparsable one is left for
// `loadAppConfig` to report and the step reports itself incomplete. Idempotent: a converted file has
// no such key, so a re-run leaves it byte-identical.

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";
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
  const life = config.life;
  if (!isTable(life) || !("restNoticeRatio" in life)) return undefined;
  delete life.restNoticeRatio;
  const archived = archivePath(dataRoot, "rest-notice-ratio", "config.toml");
  if (!(await lstat(archived).then(() => true, () => false))) await atomicWriteText(archived, raw, { mode: 0o600 });
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return DROP_REST_NOTICE_RATIO_STEP_ID;
}
