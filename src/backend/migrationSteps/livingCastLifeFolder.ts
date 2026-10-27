// Living cast §21.6 (her day): three once-steps.
//
// `living-cast-life-folder-v1`: her app-managed files move into `~/life/` (S1). Per waifu
// (`user/waifus/<id>/home/`):
// - `schedule.json` (her reminders until §21) → `life/reminders.json`; `watches.json`,
//   `profile.json` and `places.md` → `life/` under the same names. A name is matched as her disk
//   compares names (case and Unicode normalisation), so `Schedule.json` moves too.
// - A name collision (the target already exists: a re-run after a crash, or a file she made there)
//   keeps the newer file (by modification time) and moves the other to the archive
//   (`user/.archive/living-cast/life-folder/<id>/<name>`, `-2`, `-3` … when taken). A file called
//   `life` in her home (not a folder) is archived the same way first.
// - Paths in her provenance index (`life/files-index.json`) and in journalled Bash change sets
//   (`life/pending-changes/*.json`) that name the old files are rewritten to the new ones.
// - A life that has begun gets a pending epoch start (reason `tools`: summarised with no kept turns,
//   since its turns name the old paths; the harness changed too).
// MEMORY.md and her notes stay where they are.
//
// `living-cast-drop-busy-v1`: the owner-set busy blocks are dropped (S3; her busy times come from
// her own `~/life/schedule.json` now). Each waifu's `availability.busy` is archived first
// (`user/.archive/living-cast/busy/<id>.json`, the first copy kept), then removed from `waifu.json`.
//
// `living-cast-bed-time-v1` (§21.6c): the owner's `availability.sleep` becomes `availability.bedTime`
// (same fields). The waifu document is archived first (`user/.archive/living-cast/bed-time/<id>.json`,
// the first copy kept); when both keys are there, `bedTime` wins and `sleep` goes.
//
// All are idempotent: once moved, dropped and renamed, a re-run finds nothing to do and changes no byte. A
// file that cannot be parsed is left alone and the step reports itself incomplete.

import { lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";
import { archivePath } from "./livingCastArchive.js";
import { isObject, readJsonFile } from "./memorySupport.js";

const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;

/** Old name at the top of her home → new name in `~/life/`. */
export const LIFE_FOLDER_MOVES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "schedule.json", to: "reminders.json" },
  { from: "watches.json", to: "watches.json" },
  { from: "profile.json", to: "profile.json" },
  { from: "places.md", to: "places.md" }
];

const key = (name: string) => name.normalize("NFC").toLowerCase();

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function kind(target: string): Promise<"file" | "dir" | "link" | undefined> {
  try {
    const info = await lstat(target);
    return info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function waifuDirs(dataRoot: string): Promise<Array<{ id: string; dir: string }>> {
  const root = path.join(dataRoot, "user", "waifus");
  const out: Array<{ id: string; dir: string }> = [];
  for (const id of await list(root)) {
    if (!WAIFU_ID.test(id) || /^\.+$/u.test(id)) continue;
    const dir = path.join(root, id);
    if (await stat(dir).then((info) => info.isDirectory(), () => false)) out.push({ id, dir });
  }
  return out;
}

/** A free archive path for one of her files (`name`, `name-2`, …). */
async function archiveTarget(dataRoot: string, waifuId: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n += 1) {
    const candidate = archivePath(dataRoot, "life-folder", waifuId, n === 1 ? name : `${stem}-${n}${ext}`);
    if (!(await kind(candidate))) return candidate;
  }
}

async function archive(dataRoot: string, waifuId: string, source: string, name: string): Promise<void> {
  const target = await archiveTarget(dataRoot, waifuId, name);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await rename(source, target);
}

type LifeCounts = { moved: number; archived: number; rewritten: number; epochs: number; unreadable: number };

export async function migrateLivingCastLifeFolder(dataRoot: string, o: { now?: () => Date } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  const counts: LifeCounts = { moved: 0, archived: 0, rewritten: 0, epochs: 0, unreadable: 0 };
  for (const { id, dir } of await waifuDirs(dataRoot)) {
    const home = path.join(dir, "home");
    if ((await kind(home)) !== "dir") continue;
    const moved = await moveFiles(dataRoot, id, home, counts);
    if (moved.size === 0) continue;
    await rewriteIndex(path.join(dir, "life", "files-index.json"), moved, counts);
    await rewriteJournals(path.join(dir, "life", "pending-changes"), moved, counts);
    await markEpoch(path.join(dir, "life", "state.json"), now, counts);
  }
  const changed = counts.moved + counts.archived + counts.rewritten + counts.epochs;
  const applied = changed > 0 ? `living-cast-life-folder-${counts.moved}-${counts.archived}-${counts.rewritten}-${counts.epochs}` : undefined;
  if (counts.unreadable > 0) return { ...(applied ? { applied } : {}), incomplete: `${counts.unreadable} life file(s) could not be parsed` };
  return applied;
}

/** Moves her old top-level files into `home/life/`. Returns old name key → new name for what moved. */
async function moveFiles(dataRoot: string, waifuId: string, home: string, counts: LifeCounts): Promise<Map<string, string>> {
  const names = await list(home);
  const moved = new Map<string, string>();
  const sources = LIFE_FOLDER_MOVES.flatMap((move) => names.filter((name) => key(name) === key(move.from)).map((name) => ({ name, to: move.to })));
  if (sources.length === 0) return moved;
  const lifeName = names.find((name) => key(name) === "life");
  const lifeDir = path.join(home, lifeName ?? "life");
  const lifeKind = await kind(lifeDir);
  if (lifeKind && lifeKind !== "dir") {
    await archive(dataRoot, waifuId, lifeDir, lifeName ?? "life");
    counts.archived += 1;
  }
  await mkdir(lifeDir, { recursive: true, mode: 0o700 });
  for (const { name, to } of sources) {
    const source = path.join(home, name);
    if ((await kind(source)) !== "file") continue;
    const existing = (await list(lifeDir)).find((entry) => key(entry) === key(to));
    const target = path.join(lifeDir, existing ?? to);
    if (existing) {
      // Both exist: the newer one stays; the other is archived (nothing is lost).
      const [old, current] = await Promise.all([stat(source), stat(target)]);
      if (old.mtimeMs > current.mtimeMs) {
        await archive(dataRoot, waifuId, target, to);
        await rename(source, path.join(lifeDir, to));
      } else {
        await archive(dataRoot, waifuId, source, name);
      }
      counts.archived += 1;
    } else {
      await rename(source, target);
    }
    counts.moved += 1;
    moved.set(key(name), to);
  }
  return moved;
}

/** `/home/<slug>/schedule.json` → `/home/<slug>/life/reminders.json` (and the other moves). */
function movedPath(virtual: unknown, moved: ReadonlyMap<string, string>): string | undefined {
  if (typeof virtual !== "string") return undefined;
  const match = /^(\/home\/[^/]+)\/([^/]+)$/u.exec(virtual);
  if (!match) return undefined;
  const to = moved.get(key(match[2]!));
  return to ? `${match[1]}/life/${to}` : undefined;
}

async function rewriteIndex(file: string, moved: ReadonlyMap<string, string>, counts: LifeCounts): Promise<void> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") counts.unreadable += 1;
  if (read.kind !== "ok" || !isObject(read.value) || !Array.isArray(read.value.entries)) return;
  let changed = false;
  const entries = read.value.entries.map((entry) => {
    if (!isObject(entry)) return entry;
    const next = movedPath(entry.path, moved);
    if (!next) return entry;
    changed = true;
    return { ...entry, path: next };
  });
  if (!changed) return;
  await atomicWriteJson(file, { ...read.value, entries });
  counts.rewritten += 1;
}

async function rewriteJournals(dir: string, moved: ReadonlyMap<string, string>, counts: LifeCounts): Promise<void> {
  for (const name of await list(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const read = await readJsonFile(file);
    if (read.kind === "invalid") counts.unreadable += 1;
    if (read.kind !== "ok" || !isObject(read.value)) continue;
    const journal = read.value;
    let changed = false;
    const mapPath = (value: unknown) => {
      const next = movedPath(value, moved);
      if (next) changed = true;
      return next ?? value;
    };
    const writes = Array.isArray(journal.writes) ? journal.writes.map((write) => (isObject(write) ? { ...write, path: mapPath(write.path) } : write)) : journal.writes;
    const deletes = Array.isArray(journal.deletes) ? journal.deletes.map(mapPath) : journal.deletes;
    const dirs = Array.isArray(journal.dirs) ? journal.dirs.map(mapPath) : journal.dirs;
    if (!changed) continue;
    await atomicWriteJson(file, { ...journal, writes, deletes, dirs });
    counts.rewritten += 1;
  }
}

/** A life that has begun starts a new epoch before her next turn (summarised, no kept turns). */
async function markEpoch(file: string, now: Date, counts: LifeCounts): Promise<void> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") counts.unreadable += 1;
  if (read.kind !== "ok" || !isObject(read.value) || !isObject(read.value.systemSnapshot)) return;
  const state = read.value;
  if (state.pendingEpochStart === true) return;
  await atomicWriteJson(file, {
    ...state,
    revision: typeof state.revision === "number" ? state.revision + 1 : 1,
    updatedAt: now.toISOString(),
    pendingEpochStart: true,
    pendingEpochReason: "tools"
  });
  counts.epochs += 1;
}

// ---- living-cast-drop-busy-v1 -------------------------------------------------------------------

export async function migrateLivingCastDropBusy(dataRoot: string, o: { now?: () => Date } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  let dropped = 0;
  let unreadable = 0;
  for (const { id, dir } of await waifuDirs(dataRoot)) {
    const file = path.join(dir, "waifu.json");
    const read = await readJsonFile(file);
    if (read.kind === "invalid") unreadable += 1;
    if (read.kind !== "ok" || !isObject(read.value)) continue;
    const waifu = read.value;
    const availability = waifu.availability;
    if (!isObject(availability) || !Object.prototype.hasOwnProperty.call(availability, "busy")) continue;
    const { busy, ...rest } = availability;
    const archived = archivePath(dataRoot, "busy", `${id}.json`);
    // The first copy is kept: a re-run after a crash never replaces the owner's original blocks.
    if (!(await kind(archived))) await atomicWriteJson(archived, { waifuId: id, archivedAt: now.toISOString(), busy });
    await atomicWriteJson(file, { ...waifu, availability: rest });
    dropped += 1;
  }
  const applied = dropped > 0 ? `living-cast-drop-busy-${dropped}` : undefined;
  if (unreadable > 0) return { ...(applied ? { applied } : {}), incomplete: `${unreadable} waifu file(s) could not be parsed` };
  return applied;
}

export async function migrateLivingCastBedTime(dataRoot: string, o: { now?: () => Date } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  let renamed = 0;
  let unreadable = 0;
  for (const { id, dir } of await waifuDirs(dataRoot)) {
    const file = path.join(dir, "waifu.json");
    const read = await readJsonFile(file);
    if (read.kind === "invalid") unreadable += 1;
    if (read.kind !== "ok" || !isObject(read.value)) continue;
    const waifu = read.value;
    const availability = waifu.availability;
    if (!isObject(availability) || !Object.prototype.hasOwnProperty.call(availability, "sleep")) continue;
    const { sleep, ...rest } = availability;
    const archived = archivePath(dataRoot, "bed-time", `${id}.json`);
    // The first copy is kept: a re-run after a crash never replaces the original document.
    if (!(await kind(archived))) await atomicWriteJson(archived, { waifuId: id, archivedAt: now.toISOString(), waifu });
    const bedTime = Object.prototype.hasOwnProperty.call(rest, "bedTime") ? rest.bedTime : sleep;
    await atomicWriteJson(file, { ...waifu, availability: { ...rest, bedTime } });
    renamed += 1;
  }
  const applied = renamed > 0 ? `living-cast-bed-time-${renamed}` : undefined;
  if (unreadable > 0) return { ...(applied ? { applied } : {}), incomplete: `${unreadable} waifu file(s) could not be parsed` };
  return applied;
}
