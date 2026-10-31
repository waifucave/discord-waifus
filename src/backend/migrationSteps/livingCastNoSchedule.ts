// Step `living-cast-no-schedule-v1` (Living cast spec §38, owner request 2026-10-31): her day
// (`~/life/schedule.json`) and her bed time are gone; every waifu is reachable at any hour.
//
// - Each `waifu.json` loses `availability` (her bed time), `scheduleInPrompt` and `dm.sleepNotice`.
//   What it had of them is archived first as `{waifuId, archivedAt, availability?, scheduleInPrompt?,
//   sleepNotice?}` under `user/.archive/living-cast/no-schedule/<id>.json` (the first copy is kept).
// - `config.toml` loses `life.morningLinesPerPlace`, `life.dayStartHourLocal`,
//   `life.busyEngagedMinutes`, `life.bedDozeMinutes` and `life.dreamAfterAsleepMinutes`; the file as
//   it was is copied first to `user/.archive/living-cast/no-schedule/config.toml` (the first copy
//   wins). Loading strips them anyway, so a host never fails to start over them.
// - Per waifu, once (her marker `life/no-schedule-v1.json`, outside her home; the app writes it too
//   whenever it touches her home, like the life-folder and wakeups markers, so a `schedule.json` she
//   writes later is never taken from her by a re-run after a lost ledger): her `home/life/schedule.json`
//   moves to `user/.archive/living-cast/no-schedule/<id>/schedule.json` (`schedule-2.json`, … when
//   taken), the app's `life/plans-fired.json` (hashes only) is deleted, and a life that has begun gets
//   a pending epoch start (reason `tools`: summarised, no kept turns), since her harness changed and
//   her old turns speak of her day, her phone checks and her mornings. A waifu with nothing to do
//   gets no marker from here, so a data root without old files stays byte-identical.
//
// Saved queues and states need nothing here: wakes deferred for her bed time and held for her busy
// blocks are released by the scheduler's first tick, and old state keys are dropped when read.

import { lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteJson, atomicWriteText } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";
import { archivePath } from "./livingCastArchive.js";
import { isObject, readJsonFile } from "./memorySupport.js";

export const NO_SCHEDULE_STEP_ID = "living-cast-no-schedule-v1";
/** Her marker's name in her internal `life/` folder (`lifePaths.noScheduleMarker`). */
export const NO_SCHEDULE_MARKER = "no-schedule-v1.json";
/** The `[life]` keys of her day and bed time (§21, §23), gone from `config.toml`. */
export const DROPPED_LIFE_KEYS = ["morningLinesPerPlace", "dayStartHourLocal", "busyEngagedMinutes", "bedDozeMinutes", "dreamAfterAsleepMinutes"] as const;

const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false
  );
}

async function waifuDirs(dataRoot: string): Promise<Array<{ id: string; dir: string }>> {
  const root = path.join(dataRoot, "user", "waifus");
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const out: Array<{ id: string; dir: string }> = [];
  for (const id of names) {
    if (!WAIFU_ID.test(id) || /^\.+$/u.test(id)) continue;
    const dir = path.join(root, id);
    if (await stat(dir).then((info) => info.isDirectory(), () => false)) out.push({ id, dir });
  }
  return out;
}

/** A free archive path for her old day file (`schedule.json`, `schedule-2.json`, …). */
async function archiveTarget(dataRoot: string, waifuId: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = archivePath(dataRoot, "no-schedule", waifuId, n === 1 ? "schedule.json" : `schedule-${n}.json`);
    if (!(await exists(candidate))) return candidate;
  }
}

type Counts = { waifus: number; days: number; epochs: number; unreadable: number };

/** `waifu.json` without her bed time, `scheduleInPrompt` and `dm.sleepNotice` (archived first). */
async function dropWaifuKeys(dataRoot: string, id: string, file: string, now: Date, counts: Counts): Promise<void> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") counts.unreadable += 1;
  if (read.kind !== "ok" || !isObject(read.value)) return;
  const waifu = read.value;
  const has = (record: Record<string, unknown>, name: string) => Object.prototype.hasOwnProperty.call(record, name);
  const dm = isObject(waifu.dm) ? waifu.dm : undefined;
  const hasNotice = dm !== undefined && has(dm, "sleepNotice");
  if (!has(waifu, "availability") && !has(waifu, "scheduleInPrompt") && !hasNotice) return;
  const archived = archivePath(dataRoot, "no-schedule", `${id}.json`);
  // The first copy is kept: a re-run after a crash never replaces the owner's original settings.
  if (!(await exists(archived))) {
    await atomicWriteJson(archived, {
      waifuId: id,
      archivedAt: now.toISOString(),
      ...(has(waifu, "availability") ? { availability: waifu.availability } : {}),
      ...(has(waifu, "scheduleInPrompt") ? { scheduleInPrompt: waifu.scheduleInPrompt } : {}),
      ...(hasNotice ? { sleepNotice: dm.sleepNotice } : {})
    });
  }
  const { availability: _availability, scheduleInPrompt: _scheduleInPrompt, ...rest } = waifu;
  const next: Record<string, unknown> = { ...rest };
  if (dm && hasNotice) {
    const { sleepNotice: _sleepNotice, ...dmRest } = dm;
    next.dm = dmRest;
  }
  await atomicWriteJson(file, next);
  counts.waifus += 1;
}

/** A life that has begun starts a new epoch before her next turn (summarised, no kept turns). */
async function markEpoch(file: string, now: Date, counts: Counts): Promise<boolean> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") {
    counts.unreadable += 1;
    return false;
  }
  if (read.kind !== "ok" || !isObject(read.value) || !isObject(read.value.systemSnapshot)) return true;
  const state = read.value;
  // A pending start (a forget's, an earlier step's) already rebuilds her prompt: its reason stays.
  if (state.pendingEpochStart === true) return true;
  await atomicWriteJson(file, {
    ...state,
    revision: typeof state.revision === "number" ? state.revision + 1 : 1,
    updatedAt: now.toISOString(),
    pendingEpochStart: true,
    pendingEpochReason: "tools"
  });
  counts.epochs += 1;
  return true;
}

/** Her day file archived, the plans record gone, a begun life's epoch pending; then her marker. */
async function dropDay(dataRoot: string, id: string, dir: string, now: Date, counts: Counts): Promise<void> {
  const lifeDir = path.join(dir, "life");
  const markerFile = path.join(lifeDir, NO_SCHEDULE_MARKER);
  if (await exists(markerFile)) return;
  const day = path.join(dir, "home", "life", "schedule.json");
  const plans = path.join(lifeDir, "plans-fired.json");
  const stateFile = path.join(lifeDir, "state.json");
  const state = await readJsonFile(stateFile);
  const begun = state.kind === "ok" && isObject(state.value) && isObject(state.value.systemSnapshot);
  const hasDay = await exists(day);
  const hasPlans = await exists(plans);
  // Nothing of her day and no life to restart: no marker (the app writes it when it touches her home).
  if (!hasDay && !hasPlans && !begun && state.kind !== "invalid") return;
  if (hasDay) {
    const target = await archiveTarget(dataRoot, id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(day, target);
    counts.days += 1;
  }
  if (hasPlans) await rm(plans, { force: true });
  // An unreadable state keeps her marker unwritten: the next boot tries again.
  if (!(await markEpoch(stateFile, now, counts))) return;
  await mkdir(lifeDir, { recursive: true, mode: 0o700 });
  await atomicWriteJson(markerFile, { version: 1, state: "done" });
}

/** `config.toml` without the `[life]` keys of her day and bed time (archived first). */
async function dropConfigKeys(dataRoot: string): Promise<{ changed: boolean; incomplete?: string }> {
  const filePath = path.join(dataRoot, "config.toml");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { changed: false };
    throw error;
  }
  let config: unknown;
  try {
    config = parseToml(raw);
  } catch {
    return { changed: false, incomplete: "config.toml could not be parsed" };
  }
  if (!isObject(config)) return { changed: false, incomplete: "config.toml is not a table" };
  const life = config.life;
  if (!isObject(life) || !DROPPED_LIFE_KEYS.some((name) => name in life)) return { changed: false };
  for (const name of DROPPED_LIFE_KEYS) delete life[name];
  const archived = archivePath(dataRoot, "no-schedule", "config.toml");
  if (!(await exists(archived))) await atomicWriteText(archived, raw, { mode: 0o600 });
  await atomicWriteText(filePath, stringifyToml(config) + "\n", { mode: 0o600 });
  return { changed: true };
}

export async function migrateLivingCastNoSchedule(dataRoot: string, o: { now?: () => Date } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  const counts: Counts = { waifus: 0, days: 0, epochs: 0, unreadable: 0 };
  for (const { id, dir } of await waifuDirs(dataRoot)) {
    await dropWaifuKeys(dataRoot, id, path.join(dir, "waifu.json"), now, counts);
    await dropDay(dataRoot, id, dir, now, counts);
  }
  const config = await dropConfigKeys(dataRoot);
  const parts = [
    counts.waifus > 0 ? `${counts.waifus} waifu(s)` : undefined,
    counts.days > 0 ? `${counts.days} day file(s)` : undefined,
    counts.epochs > 0 ? `${counts.epochs} epoch(s)` : undefined,
    config.changed ? "config" : undefined
  ].filter(Boolean);
  const applied = parts.length > 0 ? `${NO_SCHEDULE_STEP_ID}: ${parts.join(", ")}` : undefined;
  const problems = [counts.unreadable > 0 ? `${counts.unreadable} waifu or life state file(s) could not be parsed` : undefined, config.incomplete].filter(Boolean);
  if (problems.length > 0) return { ...(applied ? { applied } : {}), incomplete: problems.join("; ") };
  return applied;
}
