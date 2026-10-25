// Her machine's writes (Living cast spec §16.2–§16.5, §16.9): every writer — her Write and Edit,
// a Bash change set, the owner's API PUT/DELETE, the app's own rewrites of her reminder and watch
// files, ReadMessages downloads — goes through this store, under one lock per waifu
// (`home:<id>`), so the same path rules, limits and special-file checks hold for all of them:
//
// - `~/places.md` is the app's: she can read it, nobody else writes it (§16.6);
// - `~/schedule.json` and `~/watches.json` are checked on every write (specialFiles.ts); a bad
//   write is refused with the exact problem and nothing is saved;
// - home ≤ `life.home.maxBytes` and `life.home.maxFiles`, `/tmp` ≤ `life.tmp.maxBytes`, a file
//   written by Write/Edit/PUT ≤ 256 KiB; a name that differs from another in its folder only by case
//   or Unicode normalisation is refused;
// - a Bash change set is applied all or nothing, journalled first in
//   `life/pending-changes/<toolCallId>.json` so a crash mid-apply is finished at boot.
//
// Beside her folders (never visible to her): `life/watch-ids.json` (how each watch's place and
// person resolved, repeat-watch fires, the id counter), `life/schedule-ids.json` and the provenance
// index `life/files-index.json` (§16.2: which downloads came from whom, and from a DM).

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readWaifu } from "../../orchestration/stores/config.js";
import type { LifeConfig } from "../../shared/schemas/config.js";
import { FilesIndexSchema, ScheduleIdsSchema, WatchIdsSchema, type FilesIndex, type ProvenanceEntry, type ScheduleIds, type WatchIds } from "../../shared/schemas/life.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { StorageService } from "../../storage/storageService.js";
import { lifeLocks, lifePaths } from "../paths.js";
import { resolvePlace } from "../places.js";
import { HerFiles, HerFilesError, type HerEntry } from "./herFiles.js";
import {
  collisionKey,
  herSlug,
  isPlacesFile,
  MEMORY_FILE,
  parseVirtual,
  PLACES_FILE,
  resolveHerPath,
  SCHEDULE_FILE,
  specialJsonFile,
  WATCHES_FILE,
  type HerPath,
  type HerRoot,
  type ResolvedHerPath
} from "./pathRules.js";
import {
  checkScheduleText,
  checkWatchesText,
  readScheduleEntries,
  readWatchEntries,
  scheduleText,
  watchesText,
  type PersonResolution,
  type ReminderEntry,
  type ResolvedBinding,
  type WatchEntry
} from "./specialFiles.js";

/** A file written by Write, Edit or the API (§16.2). */
export const WRITE_MAX_BYTES = 256 * 1024;
/** Provenance entries kept (oldest dropped first). */
export const MAX_PROVENANCE_ENTRIES = 10_000;
const MAX_FIRED = 100;

export type HomeLimits = { homeMaxBytes: number; homeMaxFiles: number; tmpMaxBytes: number; writeMaxBytes: number };

export function homeLimitsOf(life: Pick<LifeConfig, "home" | "tmp">): HomeLimits {
  return { homeMaxBytes: life.home.maxBytes, homeMaxFiles: life.home.maxFiles, tmpMaxBytes: life.tmp.maxBytes, writeMaxBytes: WRITE_MAX_BYTES };
}

/** What checking her files needs from the running app (her clock, the people she knows). */
export type CheckEnv = {
  now: Date;
  timeZone: string;
  /** A watch's `from` (a name or `<@id>`) → one person, or the reason it can't be used. */
  resolvePerson(name: string): Promise<PersonResolution>;
};

export type HomeErrorCode = "limit" | "invalid" | "places" | "special" | "conflict" | "missing" | "binary" | "link" | "collision";

export class HomeError extends Error {
  override name = "HomeError";
  constructor(
    message: string,
    readonly code: HomeErrorCode
  ) {
    super(message);
  }
}

export const PLACES_REFUSED = "places.md is kept up to date for you and can't be changed";

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** UTF-8 without NUL bytes: a file Write/Edit/Read treat as text. */
export function isTextBytes(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** "1.2 KB" — sizes as her results show them. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

/** A Bash change set (§16.3.5): what the command left different in her folders. */
export type ChangeSet = {
  writes: Array<{ path: string; data: Uint8Array }>;
  deletes: string[];
  dirs: string[];
};

/** What each file was when the command started (size and mtime), for the conflict check. */
export type ChangeBase = ReadonlyMap<string, { kind: "file" | "dir"; size: number; mtimeMs: number }>;

export type AppliedChanges = { changed: string[]; deleted: string[]; created: string[] };

const JournalSchema = z.object({
  writes: z.array(z.object({ path: z.string(), data: z.string() })),
  deletes: z.array(z.string()),
  dirs: z.array(z.string()),
  watchIds: WatchIdsSchema.optional(),
  scheduleIds: ScheduleIdsSchema.optional()
});
type Journal = z.infer<typeof JournalSchema>;

/** Hashes by host path, size and mtime (the dashboard's private flags, DM-origin checks). */
const HASH_CACHE = new Map<string, { size: number; mtimeMs: number; sha: string }>();
const HASH_CACHE_MAX = 5_000;

type Planned = { path: HerPath; data?: Buffer; kind: "write" | "delete" | "dir" };

export class HomeStore {
  readonly files: HerFiles;

  constructor(
    readonly storage: StorageService,
    readonly waifuId: string,
    readonly slug: string,
    private readonly limits: () => HomeLimits
  ) {
    this.files = new HerFiles(storage, waifuId, slug);
  }

  /** Her store, with her slug from her current name. */
  static async open(storage: StorageService, waifuId: string, limits: () => HomeLimits): Promise<HomeStore> {
    const waifu = await readWaifu(storage, waifuId);
    return new HomeStore(storage, waifuId, herSlug(waifu), limits);
  }

  resolve(input: unknown, o: { allowRoot?: boolean } = {}): ResolvedHerPath {
    return resolveHerPath(input, this.slug, o);
  }

  path(root: HerRoot, segments: readonly string[]): HerPath {
    return this.files.path(root, segments);
  }

  home(name: string): HerPath {
    return this.path("home", [name]);
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return this.storage.withLocks([lifeLocks.home(this.waifuId)], work);
  }

  /** Runs `work` holding her home lock (the scheduler's and intake's rewrites). */
  withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.locked(work);
  }

  // ---- side files ----------------------------------------------------------------------------------

  private async readSide<T>(relative: string, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(JSON.parse(await readFile(this.storage.dataPath(relative), "utf8")));
    } catch {
      return schema.parse({});
    }
  }

  readWatchIds(): Promise<WatchIds> {
    return this.readSide(lifePaths.watchIds(this.waifuId), WatchIdsSchema);
  }

  readScheduleIds(): Promise<ScheduleIds> {
    return this.readSide(lifePaths.scheduleIds(this.waifuId), ScheduleIdsSchema);
  }

  async readIndex(): Promise<FilesIndex> {
    return this.readSide(lifePaths.filesIndex(this.waifuId), FilesIndexSchema);
  }

  private async writeSide(relative: string, value: unknown): Promise<void> {
    await atomicWriteJson(this.storage.dataPath(relative), value);
  }

  // ---- her reminder and watch files ------------------------------------------------------------------

  async readScheduleText(): Promise<string | undefined> {
    return this.files.readText(this.home(SCHEDULE_FILE)).catch(() => undefined);
  }

  async readWatchesText(): Promise<string | undefined> {
    return this.files.readText(this.home(WATCHES_FILE)).catch(() => undefined);
  }

  async readSchedule(timeZone: string): Promise<ReminderEntry[]> {
    return readScheduleEntries(await this.readScheduleText(), timeZone);
  }

  /** Her watches with how they resolved (bindings of a watch the side file lacks resolve to nothing). */
  async readWatches(timeZone: string): Promise<{ entries: WatchEntry[]; ids: WatchIds }> {
    const [text, ids] = await Promise.all([this.readWatchesText(), this.readWatchIds()]);
    return { entries: readWatchEntries(text, timeZone), ids };
  }

  // ---- checks shared by every writer -------------------------------------------------------------------

  /** The special-file checks for one write: the (maybe rewritten) bytes and the side files to save. */
  private async checkSpecial(
    p: HerPath,
    data: Buffer | undefined,
    env: CheckEnv
  ): Promise<{ data?: Buffer; watchIds?: WatchIds; scheduleIds?: ScheduleIds }> {
    const special = specialJsonFile(p);
    if (!special) return data ? { data } : {};
    const text = data === undefined ? "[]\n" : data.toString("utf8");
    if (data !== undefined && !isTextBytes(data)) throw new HomeError(`error: ${p.segments[0]} must be text (JSON)`, "special");
    if (special === "schedule") {
      const ids = await this.readScheduleIds();
      const previous = readScheduleEntries(await this.readScheduleText(), env.timeZone);
      const checked = checkScheduleText(text, { now: env.now, timeZone: env.timeZone, previous, nextId: ids.nextId });
      if (!checked.ok) throw new HomeError(checked.error, "special");
      return { ...(data !== undefined ? { data: checked.rewritten ? Buffer.from(checked.text, "utf8") : data } : {}), scheduleIds: { ...ids, nextId: checked.nextId } };
    }
    const ids = await this.readWatchIds();
    const previous = readWatchEntries(await this.readWatchesText(), env.timeZone);
    const previousResolved = new Map(Object.entries(ids.watches).map(([id, watch]) => [id, watch.bindings as ResolvedBinding[]]));
    const checked = await checkWatchesText(text, {
      now: env.now,
      timeZone: env.timeZone,
      previous,
      previousResolved,
      nextId: ids.nextId,
      resolvePlace: async (handle) => (await resolvePlace(this.storage, this.waifuId, handle))?.placeKey,
      resolvePerson: env.resolvePerson
    });
    if (!checked.ok) throw new HomeError(checked.error, "special");
    const finalText = checked.rewritten ? checked.text : text;
    const watches: WatchIds["watches"] = {};
    for (const [id, bindings] of checked.resolved) watches[id] = { bindings, fires: ids.watches[id]?.fires ?? [] };
    return {
      ...(data !== undefined ? { data: checked.rewritten ? Buffer.from(checked.text, "utf8") : data } : {}),
      watchIds: { ...ids, nextId: checked.nextId, watches, sourceHash: sha256(finalText) }
    };
  }

  /** Every file now, by virtual path, per root (the limits and collisions are checked on it). */
  private async snapshot(): Promise<Map<string, HerEntry>> {
    const out = new Map<string, HerEntry>();
    for (const root of ["home", "tmp"] as const) for (const entry of await this.files.walk(root)) out.set(entry.path.virtual, entry);
    return out;
  }

  /**
   * Checks a planned set of changes against the limits and the name rules, on a simulation of her
   * folders after it. Throws a HomeError naming the first problem.
   */
  private checkPlan(plan: readonly Planned[], current: Map<string, HerEntry>, o: { writeMax?: number } = {}): void {
    const limits = this.limits();
    const sim = new Map<string, { root: HerRoot; kind: "file" | "dir"; size: number }>();
    for (const [virtual, entry] of current) sim.set(virtual, { root: entry.path.root, kind: entry.kind, size: entry.size });
    for (const step of plan) {
      const key = step.path.virtual;
      if (step.kind === "delete") {
        for (const existing of [...sim.keys()]) if (existing === key || existing.startsWith(`${key}/`)) sim.delete(existing);
        continue;
      }
      // Every folder on the way exists (or is made) and is not a file.
      for (let depth = 1; depth < step.path.segments.length + (step.kind === "dir" ? 1 : 0); depth += 1) {
        const folder = this.path(step.path.root, step.path.segments.slice(0, depth));
        const there = sim.get(folder.virtual);
        if (there?.kind === "file") throw new HomeError(`error: ${folder.display} is a file, not a folder`, "invalid");
        if (!there) sim.set(folder.virtual, { root: folder.root, kind: "dir", size: 0 });
      }
      const there = sim.get(key);
      if (step.kind === "dir") {
        if (there?.kind === "file") throw new HomeError(`error: ${step.path.display} is a file, not a folder`, "invalid");
        sim.set(key, { root: step.path.root, kind: "dir", size: 0 });
        continue;
      }
      if (there?.kind === "dir") throw new HomeError(`error: ${step.path.display} is a folder`, "invalid");
      if (o.writeMax !== undefined && (step.data?.length ?? 0) > o.writeMax) {
        throw new HomeError(`error: a file can be at most ${o.writeMax / 1024} KB; split it into several files`, "limit");
      }
      sim.set(key, { root: step.path.root, kind: "file", size: step.data?.length ?? 0 });
    }
    // Names that differ only by case or normalisation, among the entries the plan creates.
    const byFolder = new Map<string, Map<string, string>>();
    for (const virtual of sim.keys()) {
      const parent = path.posix.dirname(virtual);
      const name = path.posix.basename(virtual);
      let names = byFolder.get(parent);
      if (!names) byFolder.set(parent, (names = new Map()));
      const key = collisionKey(name);
      const other = names.get(key);
      if (other !== undefined && other !== name) {
        const shown = parseVirtual(parent, this.slug)?.display ?? parent;
        throw new HomeError(`error: ${shown} already has ${other}; two names can't differ only by case`, "collision");
      }
      names.set(key, name);
    }
    let homeBytes = 0;
    let homeFiles = 0;
    let tmpBytes = 0;
    for (const entry of sim.values()) {
      if (entry.kind !== "file") continue;
      if (entry.root === "home") {
        homeBytes += entry.size;
        homeFiles += 1;
      } else tmpBytes += entry.size;
    }
    const before = (root: HerRoot) => [...current.values()].filter((entry) => entry.kind === "file" && entry.path.root === root);
    const grew = (root: HerRoot, now: number) => now > before(root).reduce((sum, entry) => sum + entry.size, 0);
    if (homeBytes > limits.homeMaxBytes && grew("home", homeBytes)) throw new HomeError(`error: your home is full (${mib(limits.homeMaxBytes)}); delete or shorten something first`, "limit");
    if (homeFiles > limits.homeMaxFiles && homeFiles > before("home").length) throw new HomeError(`error: your home has ${limits.homeMaxFiles} files already; merge or delete some first`, "limit");
    if (tmpBytes > limits.tmpMaxBytes && grew("tmp", tmpBytes)) throw new HomeError(`error: /tmp is full (${mib(limits.tmpMaxBytes)}); delete something there first`, "limit");
  }

  // ---- Write, Edit, the API -------------------------------------------------------------------------------

  /**
   * Creates or replaces a text file (folders made as needed). `expectedHash`: the content hash the
   * writer last saw (the API's revision): a different file on disk is a conflict.
   */
  async writeText(p: HerPath, content: string, env: CheckEnv, o: { expectedHash?: string | null } = {}): Promise<{ bytes: number; created: boolean; hash: string; rewritten: boolean }> {
    if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
    return this.locked(async () => {
      const info = await this.files.inspect(p);
      if (info.kind === "link") throw new HomeError(`error: ${p.display} can't be used: it is a link`, "link");
      if (info.kind === "dir") throw new HomeError(`error: ${p.display} is a folder`, "invalid");
      let existing: Buffer | undefined;
      if (info.kind === "file") existing = await this.files.readBytes(p);
      if (o.expectedHash !== undefined) {
        const current = existing ? sha256(existing) : null;
        if (current !== o.expectedHash) throw new HomeError(`error: ${p.display} changed since it was read`, "conflict");
      }
      if (existing && !isTextBytes(existing)) throw new HomeError(`error: ${p.display} isn't a text file; remove it with Bash first if you want to replace it`, "binary");
      const raw = Buffer.from(content, "utf8");
      if (raw.length > this.limits().writeMaxBytes) throw new HomeError(`error: a file can be at most ${this.limits().writeMaxBytes / 1024} KB; split it into several files`, "limit");
      const special = await this.checkSpecial(p, raw, env);
      const data = special.data ?? raw;
      this.checkPlan([{ path: p, data, kind: "write" }], await this.snapshot());
      await this.files.writeBytes(p, data);
      await this.saveSpecialSide(special);
      return { bytes: data.length, created: existing === undefined, hash: sha256(data), rewritten: data !== raw };
    });
  }

  /** Replaces `oldString` (exactly once unless `replaceAll`). Returns how many were replaced. */
  async editText(p: HerPath, oldString: string, newString: string, replaceAll: boolean, env: CheckEnv): Promise<{ count: number; rewritten: boolean }> {
    if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
    if (oldString.length === 0) throw new HomeError("error: old_string must not be empty", "invalid");
    if (oldString === newString) throw new HomeError("error: old_string and new_string are the same", "invalid");
    return this.locked(async () => {
      const info = await this.files.inspect(p);
      if (info.kind === "missing") throw new HomeError(`error: ${p.display} doesn't exist`, "missing");
      if (info.kind === "link") throw new HomeError(`error: ${p.display} can't be used: it is a link`, "link");
      if (info.kind === "dir") throw new HomeError(`error: ${p.display} is a folder`, "invalid");
      const bytes = await this.files.readBytes(p);
      if (!isTextBytes(bytes)) throw new HomeError(`error: ${p.display} isn't a text file`, "binary");
      const current = bytes.toString("utf8");
      let count = 0;
      for (let at = current.indexOf(oldString); at >= 0; at = current.indexOf(oldString, at + oldString.length)) count += 1;
      if (count === 0) throw new HomeError(`error: old_string is not in ${p.display}; read it first`, "invalid");
      if (count > 1 && !replaceAll) throw new HomeError(`error: old_string appears ${count} times in ${p.display}; include more of the surrounding text, or pass replace_all`, "invalid");
      const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
      const raw = Buffer.from(next, "utf8");
      if (raw.length > this.limits().writeMaxBytes) throw new HomeError(`error: a file can be at most ${this.limits().writeMaxBytes / 1024} KB; split it into several files`, "limit");
      const special = await this.checkSpecial(p, raw, env);
      const data = special.data ?? raw;
      this.checkPlan([{ path: p, data, kind: "write" }], await this.snapshot());
      await this.files.writeBytes(p, data);
      await this.saveSpecialSide(special);
      return { count: replaceAll ? count : 1, rewritten: data !== raw };
    });
  }

  /** The owner's DELETE (§16.11): one file. Her special JSON files are checked as if emptied. */
  async deleteFile(p: HerPath, env: CheckEnv, o: { expectedHash?: string | null } = {}): Promise<boolean> {
    if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
    return this.locked(async () => {
      const info = await this.files.inspect(p);
      if (info.kind === "missing") return false;
      if (info.kind === "link") throw new HomeError(`error: ${p.display} can't be used: it is a link`, "link");
      if (info.kind === "dir") throw new HomeError(`error: ${p.display} is a folder`, "invalid");
      if (o.expectedHash !== undefined) {
        const current = sha256(await this.files.readBytes(p));
        if (current !== o.expectedHash) throw new HomeError(`error: ${p.display} changed since it was read`, "conflict");
      }
      const special = await this.checkSpecial(p, undefined, env);
      await this.files.remove(p);
      await this.saveSpecialSide(special);
      return true;
    });
  }

  private async saveSpecialSide(o: { watchIds?: WatchIds; scheduleIds?: ScheduleIds }): Promise<void> {
    if (o.watchIds) await this.writeSide(lifePaths.watchIds(this.waifuId), o.watchIds);
    if (o.scheduleIds) await this.writeSide(lifePaths.scheduleIds(this.waifuId), o.scheduleIds);
  }

  // ---- Bash change sets ---------------------------------------------------------------------------------

  /**
   * Applies a Bash change set all or nothing (§16.3.5): every path by the path rules, places.md
   * untouched, her special files checked, the limits and names checked on the result, and nothing
   * changed under her since the command started. Journalled first (`journalId`, the tool call id).
   */
  async applyChanges(changes: ChangeSet, base: ChangeBase, env: CheckEnv, o: { journalId: string }): Promise<AppliedChanges> {
    return this.locked(async () => {
      const plan: Planned[] = [];
      const parse = (virtual: string): HerPath => {
        const p = parseVirtual(virtual, this.slug);
        if (!p || p.segments.length === 0) throw new HomeError(`error: ${virtual} is outside your folders`, "invalid");
        return p;
      };
      for (const virtual of changes.deletes) {
        const p = parse(virtual);
        if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
        plan.push({ path: p, kind: "delete" });
      }
      for (const virtual of changes.dirs) plan.push({ path: parse(virtual), kind: "dir" });
      for (const write of changes.writes) {
        const p = parse(write.path);
        if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
        plan.push({ path: p, kind: "write", data: Buffer.from(write.data) });
      }
      // Nothing changed under her while the command ran (the app's own rewrites included).
      for (const step of plan) {
        if (step.kind === "dir") continue;
        const was = base.get(step.path.virtual);
        const now = await this.files.inspect(step.path);
        if (now.kind === "link") throw new HomeError(`error: ${step.path.display} can't be used: it is a link`, "link");
        const changed = was === undefined ? now.kind === "file" : was.kind === "file" ? now.kind !== "file" || now.size !== was.size || now.mtimeMs !== was.mtimeMs : false;
        if (changed) throw new HomeError(`error: ${step.path.display} changed while the command ran; run it again`, "conflict");
      }
      // Writes identical to what is on disk are no change at all.
      const effective: Planned[] = [];
      for (const step of plan) {
        if (step.kind === "write") {
          const now = await this.files.inspect(step.path);
          if (now.kind === "file" && now.size === step.data!.length && sha256(await this.files.readBytes(step.path)) === sha256(step.data!)) continue;
        }
        if (step.kind === "delete" && (await this.files.inspect(step.path)).kind === "missing") continue;
        if (step.kind === "dir" && (await this.files.inspect(step.path)).kind === "dir") continue;
        effective.push(step);
      }
      // Her special files: the result of the whole set is checked once.
      const side: { watchIds?: WatchIds; scheduleIds?: ScheduleIds } = {};
      for (const name of [SCHEDULE_FILE, WATCHES_FILE]) {
        const target = this.home(name);
        const write = [...effective].reverse().find((step) => step.kind === "write" && step.path.virtual === target.virtual);
        const removed = effective.some((step) => step.kind === "delete" && (step.path.virtual === target.virtual || target.virtual.startsWith(`${step.path.virtual}/`)));
        if (!write && !removed) continue;
        const checked = await this.checkSpecial(target, write ? write.data : undefined, env);
        if (write && checked.data) write.data = checked.data;
        Object.assign(side, checked.watchIds ? { watchIds: checked.watchIds } : {}, checked.scheduleIds ? { scheduleIds: checked.scheduleIds } : {});
      }
      this.checkPlan(effective, await this.snapshot());
      const journal: Journal = {
        writes: effective.filter((step) => step.kind === "write").map((step) => ({ path: step.path.virtual, data: step.data!.toString("base64") })),
        deletes: effective.filter((step) => step.kind === "delete").map((step) => step.path.virtual),
        dirs: effective.filter((step) => step.kind === "dir").map((step) => step.path.virtual),
        ...side
      };
      const applied: AppliedChanges = { changed: [], deleted: journal.deletes.map((virtual) => parse(virtual).display), created: journal.dirs.map((virtual) => parse(virtual).display) };
      for (const write of journal.writes) applied.changed.push(parse(write.path).display);
      if (journal.writes.length + journal.deletes.length + journal.dirs.length === 0 && !side.watchIds && !side.scheduleIds) return applied;
      const journalFile = this.storage.dataPath(path.join(lifePaths.pendingChanges(this.waifuId), `${safeJournalName(o.journalId)}.json`));
      await mkdir(path.dirname(journalFile), { recursive: true, mode: 0o700 });
      await atomicWriteJson(journalFile, journal);
      await this.applyJournal(journal);
      await rm(journalFile, { force: true });
      return applied;
    });
  }

  /** Applies a journal (idempotent: a write is by content, a delete of nothing is nothing). */
  private async applyJournal(journal: Journal): Promise<void> {
    for (const virtual of journal.deletes) {
      const p = parseVirtual(virtual, this.slug);
      if (p && p.segments.length > 0) await this.files.remove(p, { recursive: true }).catch((error: unknown) => {
        if (!(error instanceof HerFilesError && error.code === "missing")) throw error;
      });
    }
    for (const virtual of journal.dirs) {
      const p = parseVirtual(virtual, this.slug);
      if (p) await this.files.ensureFolders(p, p.segments.length);
    }
    for (const write of journal.writes) {
      const p = parseVirtual(write.path, this.slug);
      if (p) await this.files.writeBytes(p, Buffer.from(write.data, "base64"));
    }
    await this.saveSpecialSide(journal);
  }

  /** Boot repair (§16.9): finishes every journalled change set a crash left. Returns their ids. */
  async recoverPendingChanges(): Promise<string[]> {
    const dir = this.storage.dataPath(lifePaths.pendingChanges(this.waifuId));
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const done: string[] = [];
    await this.locked(async () => {
      for (const name of names.sort()) {
        const file = path.join(dir, name);
        try {
          const journal = JournalSchema.parse(JSON.parse(await readFile(file, "utf8")));
          await this.applyJournal(journal);
          done.push(name.slice(0, -".json".length));
        } catch {
          // A torn journal was written before anything was applied: nothing to finish.
        }
        await rm(file, { force: true });
      }
    });
    return done;
  }

  // ---- the app's own rewrites ------------------------------------------------------------------------------

  /**
   * Rewrites her reminders (a reminder fired, or moved to its next time). A file that does not read
   * cleanly is left alone (`false`): the caller's fired list keeps it from firing twice.
   */
  async rewriteSchedule(timeZone: string, transform: (entries: ReminderEntry[]) => ReminderEntry[]): Promise<boolean> {
    return this.locked(async () => {
      const text = await this.readScheduleText();
      const entries = readScheduleEntries(text, timeZone);
      if (text?.trim() && !wellFormed(text, entries.length)) return false;
      const next = transform(entries);
      if (JSON.stringify(next) === JSON.stringify(entries)) return true;
      await this.files.writeBytes(this.home(SCHEDULE_FILE), Buffer.from(scheduleText(next), "utf8"));
      return true;
    });
  }

  /** Rewrites her watches (a `once` watch matched, a watch timed out) and their side file together. */
  async rewriteWatches(timeZone: string, transform: (entries: WatchEntry[], ids: WatchIds) => { entries: WatchEntry[]; ids: WatchIds }): Promise<boolean> {
    return this.locked(async () => {
      const text = await this.readWatchesText();
      const ids = await this.readWatchIds();
      const entries = readWatchEntries(text, timeZone);
      const clean = !text?.trim() || wellFormed(text, entries.length);
      const next = transform(entries, ids);
      if (clean && JSON.stringify(next.entries) !== JSON.stringify(entries)) {
        const written = watchesText(next.entries);
        await this.files.writeBytes(this.home(WATCHES_FILE), Buffer.from(written, "utf8"));
        next.ids = { ...next.ids, sourceHash: sha256(written) };
      }
      if (JSON.stringify(next.ids) !== JSON.stringify(ids)) await this.writeSide(lifePaths.watchIds(this.waifuId), next.ids);
      return clean;
    });
  }

  /** Records occurrences routed (reminders, watch timeouts) so they never fire twice. */
  async markFired(kind: "schedule" | "watches", wakeIds: readonly string[]): Promise<void> {
    if (wakeIds.length === 0) return;
    await this.locked(async () => {
      if (kind === "schedule") {
        const ids = await this.readScheduleIds();
        await this.writeSide(lifePaths.scheduleIds(this.waifuId), { ...ids, fired: [...ids.fired.filter((id) => !wakeIds.includes(id)), ...wakeIds].slice(-MAX_FIRED) });
      } else {
        const ids = await this.readWatchIds();
        await this.writeSide(lifePaths.watchIds(this.waifuId), { ...ids, fired: [...ids.fired.filter((id) => !wakeIds.includes(id)), ...wakeIds].slice(-MAX_FIRED) });
      }
    });
  }

  /** `~/places.md` (§16.6), written only when it would change. Returns whether it did. */
  async writePlaces(text: string): Promise<boolean> {
    return this.locked(async () => {
      const p = this.home(PLACES_FILE);
      const current = await this.files.readText(p).catch(() => undefined);
      if (current === text) return false;
      await this.files.writeBytes(p, Buffer.from(text, "utf8"));
      return true;
    });
  }

  /**
   * Re-checks her watch file after someone changed it outside the app (the owner, on disk): the side
   * file follows when the file still passes, otherwise it keeps the last good resolution.
   */
  async resyncWatches(env: CheckEnv): Promise<"same" | "updated" | "invalid"> {
    return this.locked(async () => {
      const text = (await this.readWatchesText()) ?? "";
      const ids = await this.readWatchIds();
      if (sha256(text) === ids.sourceHash || (!text.trim() && Object.keys(ids.watches).length === 0)) return "same";
      try {
        const checked = await this.checkSpecial(this.home(WATCHES_FILE), Buffer.from(text, "utf8"), { ...env, now: new Date(0) });
        if (checked.watchIds) await this.writeSide(lifePaths.watchIds(this.waifuId), { ...checked.watchIds, sourceHash: sha256(text), fired: ids.fired });
        return "updated";
      } catch {
        return "invalid";
      }
    });
  }

  // ---- /tmp -------------------------------------------------------------------------------------------------

  /** Deletes every `/tmp` file last written more than `retentionDays` ago (§16.2), and the folders left empty. */
  async expireTmp(now: Date, retentionDays: number): Promise<number> {
    const cutoff = now.getTime() - retentionDays * 24 * 3_600_000;
    return this.locked(async () => {
      let removed = 0;
      const entries = await this.files.walk("tmp");
      for (const entry of entries) {
        if (entry.kind !== "file" || entry.mtimeMs > cutoff) continue;
        await this.files.remove(entry.path).catch(() => undefined);
        removed += 1;
      }
      // Empty folders go too (deepest first).
      for (const entry of [...entries].reverse()) {
        if (entry.kind === "dir") await rmdirQuiet(this.files.hostPath(entry.path));
      }
      return removed;
    });
  }

  /**
   * Saves a ReadMessages download into `/tmp` (§16.3.1): oldest `/tmp` files are deleted first when
   * it would not fit; a file larger than the whole `/tmp` is refused (`false`). The provenance entry
   * is recorded with it.
   */
  async saveDownload(p: HerPath, data: Buffer, entry: Omit<ProvenanceEntry, "sha256" | "path" | "size">): Promise<boolean> {
    const limits = this.limits();
    if (p.root !== "tmp" || data.length > limits.tmpMaxBytes) return false;
    return this.locked(async () => {
      const files = (await this.files.walk("tmp")).filter((candidate) => candidate.kind === "file");
      let total = files.reduce((sum, candidate) => sum + candidate.size, 0);
      const existing = files.find((candidate) => candidate.path.virtual === p.virtual);
      if (existing) total -= existing.size;
      for (const oldest of files.filter((candidate) => candidate !== existing).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total + data.length <= limits.tmpMaxBytes) break;
        await this.files.remove(oldest.path).catch(() => undefined);
        total -= oldest.size;
      }
      if (total + data.length > limits.tmpMaxBytes) return false;
      await this.files.writeBytes(p, data);
      const index = await this.readIndex();
      const sha = sha256(data);
      const kept = index.entries.filter((old) => !(old.attachmentId === entry.attachmentId && old.path === p.virtual));
      await this.writeSide(lifePaths.filesIndex(this.waifuId), { entries: [...kept, { ...entry, sha256: sha, path: p.virtual, size: data.length }].slice(-MAX_PROVENANCE_ENTRIES) });
      return true;
    });
  }

  // ---- provenance --------------------------------------------------------------------------------------------

  /** The content hash of a file (cached by host path, size and mtime). */
  async hashOf(p: HerPath): Promise<string | undefined> {
    const info = await this.files.inspect(p);
    if (info.kind !== "file") return undefined;
    const host = this.files.hostPath(p);
    const cached = HASH_CACHE.get(host);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.sha;
    const sha = sha256(await this.files.readBytes(p));
    if (HASH_CACHE.size >= HASH_CACHE_MAX) HASH_CACHE.delete(HASH_CACHE.keys().next().value!);
    HASH_CACHE.set(host, { size: info.size, mtimeMs: info.mtimeMs, sha });
    return sha;
  }

  /**
   * The DM a file came from (§16.2): its hash was downloaded from a DM place (copies she made with
   * `cp` or moved count too), or it sits under `/tmp/dm/`. Returns the DM's placeKey, else undefined.
   */
  async dmOrigin(p: HerPath, index?: FilesIndex): Promise<string | undefined> {
    const entries = (index ?? (await this.readIndex())).entries.filter((entry) => entry.placeKey.startsWith("dm_"));
    const byPath = entries.find((entry) => entry.path === p.virtual);
    if (p.root === "tmp" && p.segments[0] === "dm") return byPath?.placeKey ?? "dm_file";
    if (entries.length === 0) return undefined;
    const info = await this.files.inspect(p);
    if (info.kind !== "file" || !entries.some((entry) => entry.size === info.size)) return undefined;
    const sha = await this.hashOf(p);
    return entries.find((entry) => entry.sha256 === sha)?.placeKey;
  }

  /** Drops provenance entries (forget, §16.9). */
  async dropProvenance(drop: (entry: ProvenanceEntry) => boolean): Promise<number> {
    return this.locked(async () => {
      const index = await this.readIndex();
      const kept = index.entries.filter((entry) => !drop(entry));
      if (kept.length !== index.entries.length) await this.writeSide(lifePaths.filesIndex(this.waifuId), { entries: kept });
      return index.entries.length - kept.length;
    });
  }

  // ---- private files (SendMessage, §16.3.2) --------------------------------------------------------------------

  /**
   * Her private files right now: `~/MEMORY.md`, every file it links to, her reminders, watches and
   * places. Copies under other names are hers to share.
   */
  async privateFiles(): Promise<Set<string>> {
    const out = new Set([MEMORY_FILE, SCHEDULE_FILE, WATCHES_FILE, PLACES_FILE].map((name) => this.home(name).virtual));
    const index = await this.files.readText(this.home(MEMORY_FILE)).catch(() => undefined);
    for (const target of markdownLinks(index ?? "")) {
      const resolved = this.resolve(target.startsWith("/") || target.startsWith("~") ? target : `~/${target}`);
      if (resolved.ok) out.add(resolved.path.virtual);
    }
    return out;
  }

  /** The text files of her home (forget's scrub and verification, maintenance): path below home → text. */
  async readAllText(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const entry of await this.files.walk("home")) {
      if (entry.kind !== "file" || entry.size > 4 * WRITE_MAX_BYTES) continue;
      const data = await this.files.readBytes(entry.path).catch(() => undefined);
      if (data && isTextBytes(data)) out.set(entry.path.segments.join("/"), data.toString("utf8"));
    }
    return out;
  }

  /** Every file anywhere in her two folders, with its hash (forget's deletion by hash). */
  async allFiles(): Promise<HerEntry[]> {
    return [...(await this.files.walk("home")), ...(await this.files.walk("tmp"))].filter((entry) => entry.kind === "file");
  }
}

export function safeJournalName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 100) || "change";
}

/** True when every entry of the array read (the app never rewrites a file it would lose part of). */
function wellFormed(text: string, readEntries: number): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) && value.length === readEntries;
  } catch {
    return false;
  }
}

async function rmdirQuiet(dir: string): Promise<void> {
  const { rmdir } = await import("node:fs/promises");
  await rmdir(dir).catch(() => undefined);
}

/** Relative link targets in Markdown (`[Kevin](people/kevin.md)`), without anchors; URLs left out. */
export function markdownLinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) {
    const target = match[1]!.split("#")[0]!;
    if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    try {
      out.push(decodeURIComponent(target.replace(/^\.\//u, "")));
    } catch {
      out.push(target.replace(/^\.\//u, ""));
    }
  }
  return out;
}
