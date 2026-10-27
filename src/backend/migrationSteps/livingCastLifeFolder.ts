// Living cast §21.6 (her day): three once-steps.
//
// `living-cast-life-folder-v1`: her app-managed files move into `~/life/` (S1). Per waifu
// (`user/waifus/<id>/home/`):
// - A folder `life/` she made herself before the upgrade (her own notes) is renamed `life-notes/`
//   (`life-notes-2/` … when taken), so it never becomes the app's private, dream-refused folder; a
//   file called `life` is archived (`user/.archive/living-cast/life-folder/<id>/life`).
// - `schedule.json` (her reminders until §21) → `life/reminders.json`; `watches.json`,
//   `profile.json` and `places.md` → `life/` under the same names. A name is matched as her disk
//   compares names (case and Unicode normalisation), so `Schedule.json` moves too.
// - A name collision (the target already exists: a re-run after a crash) keeps the newer file (by
//   modification time) and moves the other to the archive (`…/life-folder/<id>/<name>`, `-2` … when
//   taken).
// - Paths in her provenance index (`life/files-index.json`) and in journalled Bash change sets
//   (`life/pending-changes/*.json`) that name the old files (or her renamed notes folder) are
//   rewritten.
// - A life that has begun and had files to move gets a pending epoch start (reason `tools`:
//   summarised with no kept turns, since its turns name the old paths; the harness changed too).
// MEMORY.md and her notes stay where they are.
//
// Her marker (`user/waifus/<id>/life/life-folder-v1.json`, outside her home; the app also writes it
// for every life it runs) records what is done: `{state: "moving", parts, notes?, epoch}` (written
// before anything moves, with the name her own folder gets) while the parts run (each part is recorded when it finished, so a crash or an unreadable file resumes where
// it stopped and a part never runs twice), `{state: "done"}` after. A waifu with the marker done is
// skipped: a re-run after a lost ledger never moves files she wrote at the top of her home later. A
// life whose state already has a §21 field (`lastDayStart`) counts as done too.
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

/** Her marker's name in her internal `life/` folder (the app writes it too: `lifePaths.lifeFolderMarker`). */
export const LIFE_FOLDER_MARKER = "life-folder-v1.json";

const PARTS = ["notes", "moves", "index", "journals", "epoch"] as const;
type Part = (typeof PARTS)[number];
type Marker = { version: 1; state: "moving" | "done"; parts?: Part[]; notes?: string; epoch?: boolean };

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

/** Test hook: stop (throw) right after a part, as a crash there would. */
export type LifeFolderCrash = "start" | Part;

async function readMarker(file: string): Promise<Marker | undefined> {
  const read = await readJsonFile(file);
  if (read.kind !== "ok" || !isObject(read.value)) return undefined;
  const value = read.value;
  if (value.state !== "moving" && value.state !== "done") return undefined;
  return {
    version: 1,
    state: value.state,
    ...(Array.isArray(value.parts) ? { parts: value.parts.filter((part): part is Part => PARTS.includes(part as Part)) } : {}),
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.epoch === "boolean" ? { epoch: value.epoch } : {})
  };
}

/** Her internal state already carries a §21 field: the app has run her life since the upgrade. */
async function upgradedAlready(stateFile: string): Promise<boolean> {
  const read = await readJsonFile(stateFile);
  return read.kind === "ok" && isObject(read.value) && typeof read.value.lastDayStart === "string";
}

export async function migrateLivingCastLifeFolder(dataRoot: string, o: { now?: () => Date; crashAfter?: LifeFolderCrash } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  const counts: LifeCounts = { moved: 0, archived: 0, rewritten: 0, epochs: 0, unreadable: 0 };
  let markers = 0;
  for (const { id, dir } of await waifuDirs(dataRoot)) {
    const lifeDir = path.join(dir, "life");
    const markerFile = path.join(lifeDir, LIFE_FOLDER_MARKER);
    let marker = await readMarker(markerFile);
    if (marker?.state === "done") continue;
    const home = path.join(dir, "home");
    const homeNames = (await kind(home)) === "dir" ? await list(home) : [];
    if (!marker) {
      if (await upgradedAlready(path.join(lifeDir, "state.json"))) {
        await mkdir(lifeDir, { recursive: true, mode: 0o700 });
        await atomicWriteJson(markerFile, { version: 1, state: "done" } satisfies Marker);
        markers += 1;
        continue;
      }
      // Before anything moves: a `life` of her own steps aside, and the marker says what is to come.
      const lifeName = homeNames.find((name) => key(name) === "life");
      let notes: string | undefined;
      if (lifeName) {
        const lifeKind = await kind(path.join(home, lifeName));
        if (lifeKind === "dir") {
          notes = await freeName(home, "life-notes");
        } else if (lifeKind) {
          await archive(dataRoot, id, path.join(home, lifeName), lifeName);
          counts.archived += 1;
        }
      }
      const hasOld = homeNames.some((name) => LIFE_FOLDER_MOVES.some((move) => key(move.from) === key(name)));
      marker = { version: 1, state: "moving", parts: [], ...(notes ? { notes } : {}), epoch: hasOld || notes !== undefined };
      await mkdir(lifeDir, { recursive: true, mode: 0o700 });
      await atomicWriteJson(markerFile, marker);
      markers += 1;
      if (o.crashAfter === "start") throw new Error("crash after start");
    }
    const done = new Set(marker.parts ?? []);
    const finish = async (part: Part, ok: boolean) => {
      if (!ok) return;
      done.add(part);
      marker = { ...marker!, parts: PARTS.filter((entry) => done.has(entry)) };
      await atomicWriteJson(markerFile, marker);
      if (o.crashAfter === part) throw new Error(`crash after ${part}`);
    };
    const mapping = pathMapping(marker.notes);
    if (!done.has("notes")) {
      // Her own folder is renamed once (a re-run finds it renamed already, and life/ then is ours).
      const notes = marker.notes;
      const lifeName = (await list(home)).find((name) => key(name) === "life");
      if (notes && lifeName && !(await kind(path.join(home, notes))) && (await kind(path.join(home, lifeName))) === "dir") {
        await rename(path.join(home, lifeName), path.join(home, notes));
        counts.moved += 1;
      }
      await finish("notes", true);
    }
    if (!done.has("moves")) await finish("moves", (await kind(home)) !== "dir" || (await moveFiles(dataRoot, id, home, counts), true));
    if (!done.has("index")) await finish("index", await rewriteIndex(path.join(lifeDir, "files-index.json"), mapping, counts));
    if (!done.has("journals")) await finish("journals", await rewriteJournals(path.join(lifeDir, "pending-changes"), mapping, counts));
    if (!done.has("epoch")) await finish("epoch", marker.epoch ? await markEpoch(path.join(lifeDir, "state.json"), now, counts) : true);
    if (PARTS.every((part) => done.has(part))) await atomicWriteJson(markerFile, { version: 1, state: "done", ...(marker.notes ? { notes: marker.notes } : {}) } satisfies Marker);
  }
  const changed = counts.moved + counts.archived + counts.rewritten + counts.epochs;
  const applied = changed + markers > 0 ? `living-cast-life-folder-${counts.moved}-${counts.archived}-${counts.rewritten}-${counts.epochs}` : undefined;
  if (counts.unreadable > 0) return { ...(applied ? { applied } : {}), incomplete: `${counts.unreadable} life file(s) could not be parsed` };
  return applied;
}

/** `life-notes`, else `life-notes-2`, … (compared as her disk compares names). */
async function freeName(home: string, base: string): Promise<string> {
  const taken = new Set((await list(home)).map(key));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(key(name))) return name;
  }
}

/** Moves her old top-level files into `home/life/`. */
async function moveFiles(dataRoot: string, waifuId: string, home: string, counts: LifeCounts): Promise<void> {
  const names = await list(home);
  const sources = LIFE_FOLDER_MOVES.flatMap((move) => names.filter((name) => key(name) === key(move.from)).map((name) => ({ name, to: move.to })));
  if (sources.length === 0) return;
  const lifeDir = path.join(home, names.find((name) => key(name) === "life") ?? "life");
  await mkdir(lifeDir, { recursive: true, mode: 0o700 });
  for (const { name, to } of sources) {
    const source = path.join(home, name);
    if ((await kind(source)) !== "file") continue;
    const existing = (await list(lifeDir)).find((entry) => key(entry) === key(to));
    const target = path.join(lifeDir, existing ?? to);
    if (existing) {
      // Both exist (a re-run after a crash mid-move): the newer one stays; the other is archived.
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
  }
}

/** The app's names in `~/life/` after the moves: a path there is never her renamed notes folder's. */
const APP_LIFE_NAMES = new Set(LIFE_FOLDER_MOVES.map((move) => key(move.to)));

/**
 * Old path below her home → new one: the moved files, and her own `life/` folder renamed. Mapping a
 * path twice (a crash between a rewrite and its record) gives the same result: a path already in
 * the app's `life/` keeps its place.
 */
function pathMapping(notes: string | undefined): (virtual: unknown) => string | undefined {
  return (virtual) => {
    if (typeof virtual !== "string") return undefined;
    const own = /^(\/home\/[^/]+)\/life(?:\/([^/]+)(\/.*)?)?$/iu.exec(virtual);
    if (notes && own && !(own[2] && !own[3] && APP_LIFE_NAMES.has(key(own[2])))) return `${own[1]}/${notes}${own[2] ? `/${own[2]}${own[3] ?? ""}` : ""}`;
    const match = /^(\/home\/[^/]+)\/([^/]+)$/u.exec(virtual);
    if (!match) return undefined;
    const to = LIFE_FOLDER_MOVES.find((move) => key(move.from) === key(match[2]!))?.to;
    return to ? `${match[1]}/life/${to}` : undefined;
  };
}

/** Returns false when the file could not be read (the part runs again). */
async function rewriteIndex(file: string, mapPath: (virtual: unknown) => string | undefined, counts: LifeCounts): Promise<boolean> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") {
    counts.unreadable += 1;
    return false;
  }
  if (read.kind !== "ok" || !isObject(read.value) || !Array.isArray(read.value.entries)) return true;
  let changed = false;
  const entries = read.value.entries.map((entry) => {
    if (!isObject(entry)) return entry;
    const next = mapPath(entry.path);
    if (!next) return entry;
    changed = true;
    return { ...entry, path: next };
  });
  if (!changed) return true;
  await atomicWriteJson(file, { ...read.value, entries });
  counts.rewritten += 1;
  return true;
}

async function rewriteJournals(dir: string, mapPath: (virtual: unknown) => string | undefined, counts: LifeCounts): Promise<boolean> {
  let ok = true;
  for (const name of await list(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const read = await readJsonFile(file);
    if (read.kind === "invalid") {
      counts.unreadable += 1;
      ok = false;
    }
    if (read.kind !== "ok" || !isObject(read.value)) continue;
    const journal = read.value;
    let changed = false;
    const map = (value: unknown) => {
      const next = mapPath(value);
      if (next) changed = true;
      return next ?? value;
    };
    const writes = Array.isArray(journal.writes) ? journal.writes.map((write) => (isObject(write) ? { ...write, path: map(write.path) } : write)) : journal.writes;
    const deletes = Array.isArray(journal.deletes) ? journal.deletes.map(map) : journal.deletes;
    const dirs = Array.isArray(journal.dirs) ? journal.dirs.map(map) : journal.dirs;
    if (!changed) continue;
    await atomicWriteJson(file, { ...journal, writes, deletes, dirs });
    counts.rewritten += 1;
  }
  return ok;
}

/** A life that has begun starts a new epoch before her next turn (summarised, no kept turns). */
async function markEpoch(file: string, now: Date, counts: LifeCounts): Promise<boolean> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") {
    counts.unreadable += 1;
    return false;
  }
  if (read.kind !== "ok" || !isObject(read.value) || !isObject(read.value.systemSnapshot)) return true;
  const state = read.value;
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
