// Her machine's writes (Living cast spec §16.2, §16.9, §30.3): every writer — her Write and Edit,
// a Bash change set, the owner's API PUT/DELETE, the Wakeup tool, the app's own rewrites of her
// wakeups file, ReadMessages downloads — goes through this store, under one lock per waifu
// (`home:<id>`), so the same path rules, limits and special-file checks hold for all of them:
//
// - her app-managed files live in `~/life/` (§21 S1); `~/life/places.md` is the app's: she can
//   read it, nobody else writes it (§16.6);
// - `~/life/wakeups.json` (../wakeups/file.ts, her functions compiled in the sandbox),
//   `profile.json` (profileFile.ts) and `schedule.json`, her day (daySchedule.ts), are checked on
//   every write; a bad write is refused with the exact problem and nothing is saved;
// - home ≤ `life.home.maxBytes` and `life.home.maxFiles`, `/tmp` ≤ `life.tmp.maxBytes`, a file
//   written by Write/Edit/PUT ≤ 256 KiB; a name that differs from another in its folder only by case
//   or Unicode normalisation is refused;
// - a Bash change set is applied all or nothing, journalled first in
//   `life/pending-changes/<toolCallId>.json` so a crash mid-apply is finished at boot.
//
// Beside her folders (never visible to her): `life/wakeup-ids.json` (id counters, how each watch's
// places and names resolved, fires, errors, occurrences already routed) and the provenance index
// `life/files-index.json` (§16.2: which downloads came from whom, and from a DM).

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readWaifu } from "../../orchestration/stores/config.js";
import type { LifeConfig } from "../../shared/schemas/config.js";
import { FilesIndexSchema, WakeupSideSchema, type FilesIndex, type ProvenanceEntry, type WakeupSide } from "../../shared/schemas/life.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { StorageService } from "../../storage/storageService.js";
import { lifeLocks, lifePaths } from "../paths.js";
import { resolvePlace } from "../places.js";
import { HerFiles, HerFilesError, type HerEntry } from "./herFiles.js";
import {
  collisionKey,
  DAY_SCHEDULE_FILE,
  deleteReachesPlaces,
  herSlug,
  isDmFolderPath,
  isLifeDirPath,
  isPlacesFile,
  lifeSegments,
  MEMORY_FILE,
  parseVirtual,
  pathKey,
  PLACES_FILE,
  PROFILE_FILE,
  resolveHerPath,
  specialFileName,
  specialJsonFile,
  WAKEUPS_FILE,
  type HerPath,
  type HerRoot,
  type LifeFileName,
  type ResolvedHerPath
} from "./pathRules.js";
import { checkDayScheduleText, readDayPlan, type DayPlan } from "./daySchedule.js";
import type { PersonResolution } from "./specialFiles.js";
import { sharedSandbox, type Sandbox } from "../sandbox/index.js";
import { checkWakeupsText, readsWhole, WAKEUPS_FILE_HARD_BYTES, readWakeupEntries, wakeupsText, type WakeupEntry } from "../wakeups/file.js";
import { reconcileAfterWrite } from "../wakeups/state.js";
import { checkProfileText, profileFileText, profileServers, sameProfile, saveProfileToConfig, type ProfileFields } from "./profileFile.js";

/** A file written by Write, Edit or the API (§16.2). */
export const WRITE_MAX_BYTES = 256 * 1024;
/** Provenance entries kept (oldest dropped first). */
export const MAX_PROVENANCE_ENTRIES = 10_000;
const MAX_FIRED = 200;

/** The key of a `once` watch's match in the fired list (a file the app could not rewrite never fires it twice). */
export function onceKey(entry: Pick<WakeupEntry, "id" | "options">): string {
  return `once-${entry.id}-${entry.options?.until ?? ""}`;
}

export type HomeLimits = {
  homeMaxBytes: number;
  homeMaxFiles: number;
  homeMaxFolders: number;
  tmpMaxBytes: number;
  tmpMaxFiles: number;
  writeMaxBytes: number;
};

export function homeLimitsOf(life: Pick<LifeConfig, "home" | "tmp">): HomeLimits {
  return {
    homeMaxBytes: life.home.maxBytes,
    homeMaxFiles: life.home.maxFiles,
    homeMaxFolders: life.home.maxFolders,
    tmpMaxBytes: life.tmp.maxBytes,
    tmpMaxFiles: life.tmp.maxFiles,
    writeMaxBytes: WRITE_MAX_BYTES
  };
}

/** Most entries one change set may carry (the worker refuses more before sending). */
export const MAX_CHANGE_SET_ENTRIES = 5_000;
/** Checking a change set must finish within this; past it the set is refused and nothing is saved. */
export const CHANGE_CHECK_DEADLINE_MS = 30_000;
/** Text files read whole for forget and maintenance (her home's own limit bounds them). */
const READ_ALL_MAX_BYTES = 64 * 1024 * 1024;

/** What checking her files needs from the running app (her clock, the people she knows). */
export type CheckEnv = {
  now: Date;
  timeZone: string;
  /** A watch filter's `from` (a name or `<@id>`) → one person, or the reason it can't be used. */
  resolvePerson(name: string): Promise<PersonResolution>;
  /** Where her functions are compiled (default: the process's sandbox). */
  sandbox?: Sandbox;
  /** Page fetching is off (`life.webFetch` caps at 0): no new pages (§30.2). */
  pagesOff?: boolean;
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

/** The provenance entry fields of a file copied from a private chat's transcript (§18.3). */
export const TRANSCRIPT_COPY = "transcript";

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
  // A journal written before §30 also has watchIds/scheduleIds: dropped when read (their files are gone).
  wakeupIds: WakeupSideSchema.optional(),
  // Spec 17.1: her checked profile.json, saved to her config with the files.
  profile: z.object({ username: z.string().optional(), bio: z.string().optional(), nicknames: z.record(z.string(), z.string()).optional() }).optional()
});
type Journal = z.infer<typeof JournalSchema>;

/** Hashes by host path, size and mtime (the dashboard's private flags, DM-origin checks). */
const HASH_CACHE = new Map<string, { size: number; mtimeMs: number; sha: string }>();

/** Lives whose life-folder marker is known to exist (per data root), so it is checked once per process. */
const MARKED = new Set<string>();

/**
 * The app runs her life on the `~/life/` layout: the marker `living-cast-life-folder-v1` reads tells
 * a re-run (after a lost ledger) to leave her home alone, also for a waifu created after the upgrade.
 * Written only when missing (a migration in progress keeps its own).
 */
export async function ensureLifeFolderMarker(storage: StorageService, waifuId: string): Promise<void> {
  const id = `${storage.dataRoot}\0${waifuId}`;
  if (MARKED.has(id)) return;
  // The wakeups layout too (§30.3, `living-cast-wakeups-v1`): a `reminders.json` she writes later is her own file.
  for (const file of [storage.dataPath(lifePaths.lifeFolderMarker(waifuId)), storage.dataPath(lifePaths.wakeupsMarker(waifuId))]) {
    const exists = await stat(file).then(() => true, () => false);
    if (!exists) await atomicWriteJson(file, { version: 1, state: "done" });
  }
  MARKED.add(id);
}
const HASH_CACHE_MAX = 5_000;

type Planned = { path: HerPath; data?: Buffer; kind: "write" | "delete" | "dir" };

export class HomeStore {
  readonly files: HerFiles;

  constructor(
    readonly storage: StorageService,
    readonly waifuId: string,
    readonly slug: string,
    private readonly limits: () => HomeLimits,
    private readonly hooks: { onCorruptSide?(name: string): void; now?(): Date } = {}
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

  /** A path as she wrote it, spelled as on disk (`~/Memory.md` → `~/MEMORY.md` when that exists). */
  async resolveExisting(input: unknown, o: { allowRoot?: boolean } = {}): Promise<ResolvedHerPath> {
    const resolved = this.resolve(input, o);
    return resolved.ok ? { ok: true, path: await this.files.canonical(resolved.path) } : resolved;
  }

  path(root: HerRoot, segments: readonly string[]): HerPath {
    return this.files.path(root, segments);
  }

  home(name: string): HerPath {
    return this.path("home", [name]);
  }

  /** One of her `~/life/` files (§21 S1). */
  life(name: LifeFileName): HerPath {
    return this.path("home", lifeSegments(name));
  }

  /**
   * Every read-modify-write of her home runs here; the life-folder marker is written first, so a home
   * the app has touched (her tools, the API, the dashboard's profile rewrite) is never migrated again.
   */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await ensureLifeFolderMarker(this.storage, this.waifuId);
    return this.storage.withLocks([lifeLocks.home(this.waifuId)], work);
  }

  /** Runs `work` holding her home lock (the scheduler's and intake's rewrites). */
  withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.locked(work);
  }

  // ---- side files ----------------------------------------------------------------------------------

  /**
   * A side file. Missing reads as empty. One that exists but cannot be read is kept as
   * `<name>.corrupt-<ms>`, replaced by an empty one marked `recoveredAt` (her reminders and watches
   * due before then are ambiguous: the scheduler drops them without firing), and the owner is told.
   */
  private async readSide<T>(relative: string, schema: z.ZodType<T>, o: { recover?: boolean } = {}): Promise<T> {
    const file = this.storage.dataPath(relative);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return schema.parse({});
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      if (!o.recover) return schema.parse({});
      const at = (this.hooks.now?.() ?? new Date()).toISOString();
      await copyFile(file, `${file}.corrupt-${Date.parse(at)}`).catch(() => undefined);
      const fresh = schema.parse({ recoveredAt: at });
      await this.writeSide(relative, fresh).catch(() => undefined);
      this.hooks.onCorruptSide?.(path.basename(relative));
      return fresh;
    }
  }

  readWakeupSide(): Promise<WakeupSide> {
    return this.readSide(lifePaths.wakeupIds(this.waifuId), WakeupSideSchema, { recover: true });
  }

  async readIndex(): Promise<FilesIndex> {
    return this.readSide(lifePaths.filesIndex(this.waifuId), FilesIndexSchema);
  }

  private async writeSide(relative: string, value: unknown): Promise<void> {
    await atomicWriteJson(this.storage.dataPath(relative), value);
  }

  // ---- her wakeups file (§30.3) ---------------------------------------------------------------------

  async readWakeupsText(): Promise<string | undefined> {
    return this.files.readText(this.life(WAKEUPS_FILE)).catch(() => undefined);
  }

  /** Her wakeups as saved (read leniently) with what the app keeps beside them. */
  async readWakeups(): Promise<{ entries: WakeupEntry[]; side: WakeupSide; text: string | undefined }> {
    const [text, side] = await Promise.all([this.readWakeupsText(), this.readWakeupSide()]);
    return { entries: readWakeupEntries(text), side, text };
  }

  /** Her day as saved (`~/life/schedule.json`, §21.2); a file that fails the checks is no plan. */
  async readDay(): Promise<DayPlan | undefined> {
    return readDayPlan(await this.files.readText(this.life(DAY_SCHEDULE_FILE)).catch(() => undefined));
  }

  // ---- checks shared by every writer -------------------------------------------------------------------

  /** The special-file checks for one write: the (maybe rewritten) bytes and the side files to save. */
  private async checkSpecial(p: HerPath, data: Buffer | undefined, env: CheckEnv): Promise<SpecialResult> {
    const special = specialJsonFile(p);
    if (!special) return data ? { data } : {};
    if (special === "profile") {
      if (data === undefined) throw new HomeError(`error: ${PROFILE_FILE} can't be deleted; change what's in it instead`, "special");
      if (!isTextBytes(data)) throw new HomeError(`error: ${PROFILE_FILE} must be text (JSON)`, "special");
      const waifu = await readWaifu(this.storage, this.waifuId);
      const checked = checkProfileText(data.toString("utf8"), { name: waifu.name, servers: await profileServers(this.storage) });
      if (!checked.ok) throw new HomeError(checked.error, "special");
      return { data, profile: checked.fields };
    }
    if (data !== undefined && !isTextBytes(data)) throw new HomeError(`error: ${specialFileName(special)} must be text (JSON)`, "special");
    if (special === "schedule") {
      // Her day (§21.2): deleting it is no plan today; busy blocks stay in her waking hours.
      if (data === undefined) return {};
      const waifu = await readWaifu(this.storage, this.waifuId);
      const checked = checkDayScheduleText(data.toString("utf8"), { bedTime: waifu.availability.bedTime });
      if (!checked.ok) throw new HomeError(checked.error, "special");
      return { data };
    }
    const text = data === undefined ? "[]\n" : data.toString("utf8");
    const { entries: previous, side } = await this.readWakeups();
    const checked = await checkWakeupsText(text, this.wakeupContext(env, previous, side));
    if (!checked.ok) throw new HomeError(checked.error, "special");
    // A `once` watch that fired is gone for good: a stale copy of the file never brings it back.
    for (const entry of checked.entries) {
      if (entry.kind === "watch" && side.fired.includes(onceKey(entry))) throw new HomeError(`error: wakeups.json entry ${entry.id}: it already fired once and was removed; leave it out`, "special");
    }
    return {
      ...(data !== undefined ? { data: checked.rewritten ? Buffer.from(checked.text, "utf8") : data } : {}),
      wakeupIds: { ...checked.side, fired: side.fired },
      wakeupsWritten: { before: previous, after: checked.entries }
    };
  }

  /** What checking her wakeups file needs: her clock, her places, the people she knows, the sandbox. */
  private wakeupContext(env: CheckEnv, previous: readonly WakeupEntry[], side: WakeupSide) {
    return {
      now: env.now,
      timeZone: env.timeZone,
      previous,
      side,
      resolvePlace: async (handle: string) => (await resolvePlace(this.storage, this.waifuId, handle))?.placeKey,
      resolvePerson: env.resolvePerson,
      compile: (sources: string[]) => (env.sandbox ?? sharedSandbox()).compile(sources, { timeZone: env.timeZone, now: env.now }),
      ...(env.pagesOff ? { pagesOff: true } : {})
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
    const created = new Set<string>();
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
        if (!there) {
          sim.set(folder.virtual, { root: folder.root, kind: "dir", size: 0 });
          created.add(folder.virtual);
        }
      }
      const there = sim.get(key);
      if (step.kind === "dir") {
        if (there?.kind === "file") throw new HomeError(`error: ${step.path.display} is a file, not a folder`, "invalid");
        if (!there) created.add(key);
        sim.set(key, { root: step.path.root, kind: "dir", size: 0 });
        continue;
      }
      if (there?.kind === "dir") throw new HomeError(`error: ${step.path.display} is a folder`, "invalid");
      if (o.writeMax !== undefined && (step.data?.length ?? 0) > o.writeMax) {
        throw new HomeError(`error: a file can be at most ${o.writeMax / 1024} KB; split it into several files`, "limit");
      }
      if (!there) created.add(key);
      sim.set(key, { root: step.path.root, kind: "file", size: step.data?.length ?? 0 });
    }
    // Names that differ only by case or normalisation, where the plan creates one of them (two such
    // names the owner already has on a case-sensitive disk are left alone).
    const byFolder = new Map<string, Map<string, string>>();
    for (const virtual of sim.keys()) {
      const parent = path.posix.dirname(virtual);
      const name = path.posix.basename(virtual);
      let names = byFolder.get(parent);
      if (!names) byFolder.set(parent, (names = new Map()));
      const key = collisionKey(name);
      const other = names.get(key);
      if (other !== undefined && other !== name && (created.has(virtual) || created.has(path.posix.join(parent, other)))) {
        const shown = parseVirtual(parent, this.slug)?.display ?? parent;
        throw new HomeError(`error: ${shown} already has ${other}; two names can't differ only by case`, "collision");
      }
      names.set(key, name);
    }
    let homeBytes = 0;
    let homeFiles = 0;
    let homeFolders = 0;
    let tmpBytes = 0;
    let tmpFiles = 0;
    for (const entry of sim.values()) {
      if (entry.kind !== "file") {
        if (entry.root === "home") homeFolders += 1;
        continue;
      }
      if (entry.root === "home") {
        homeBytes += entry.size;
        homeFiles += 1;
      } else {
        tmpBytes += entry.size;
        tmpFiles += 1;
      }
    }
    const before = (root: HerRoot) => [...current.values()].filter((entry) => entry.kind === "file" && entry.path.root === root);
    const foldersBefore = [...current.values()].filter((entry) => entry.kind === "dir" && entry.path.root === "home").length;
    if (homeFolders > limits.homeMaxFolders && homeFolders > foldersBefore) throw new HomeError(`error: your home has ${limits.homeMaxFolders} folders already; merge or delete some first`, "limit");
    if (tmpFiles > limits.tmpMaxFiles && tmpFiles > before("tmp").length) throw new HomeError(`error: /tmp has ${limits.tmpMaxFiles} files already; delete some first`, "limit");
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
  async writeText(p: HerPath, content: string, env: CheckEnv, o: { expectedHash?: string | null; staleMessage?: string } = {}): Promise<{ bytes: number; created: boolean; hash: string; rewritten: boolean; path: HerPath; profileChanged?: boolean }> {
    if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
    return this.locked(async () => {
      p = await this.files.canonical(p);
      const info = await this.files.inspect(p);
      if (info.kind === "link") throw new HomeError(`error: ${p.display} can't be used: it is a link`, "link");
      if (info.kind === "dir") throw new HomeError(`error: ${p.display} is a folder`, "invalid");
      let existing: Buffer | undefined;
      if (info.kind === "file") existing = await this.files.readBytes(p);
      if (o.expectedHash !== undefined) {
        const current = existing ? sha256(existing) : null;
        if (current !== o.expectedHash) throw new HomeError(o.staleMessage ?? `error: ${p.display} changed since it was read`, "conflict");
      }
      if (existing && !isTextBytes(existing)) throw new HomeError(`error: ${p.display} isn't a text file; remove it with Bash first if you want to replace it`, "binary");
      const raw = Buffer.from(content, "utf8");
      if (raw.length > this.limits().writeMaxBytes) throw new HomeError(`error: a file can be at most ${this.limits().writeMaxBytes / 1024} KB; split it into several files`, "limit");
      const special = await this.checkSpecial(p, raw, env);
      const data = special.data ?? raw;
      this.checkPlan([{ path: p, data, kind: "write" }], await this.snapshot());
      await this.files.writeBytes(p, data);
      const profileChanged = await this.saveSpecialSide(special);
      return { bytes: data.length, created: existing === undefined, hash: sha256(data), rewritten: data !== raw, path: p, ...(special.profile ? { profileChanged } : {}) };
    });
  }

  /**
   * The Wakeup tool's changes (§30.2), all or nothing: `cancel` ids are removed, `add` entries (no
   * ids) appended, and the result is checked like any write of the file, under one hold of her home
   * lock (nothing the app rewrites in between is lost). Returns the new entries with their ids, in
   * order. A cancel of an unknown id is refused.
   */
  async applyWakeups(o: { add: ReadonlyArray<Record<string, unknown>>; cancel: readonly string[] }, env: CheckEnv): Promise<{ added: WakeupEntry[]; cancelled: string[]; entries: WakeupEntry[] }> {
    return this.locked(async () => {
      const p = this.life(WAKEUPS_FILE);
      const text = await this.files.readText(p).catch(() => undefined);
      let current: Array<Record<string, unknown>> = [];
      if (text?.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          value = undefined;
        }
        if (!Array.isArray(value)) throw new HomeError(`error: ${p.display} can't be read as a list right now; fix it first (Read it to see why)`, "special");
        current = value as Array<Record<string, unknown>>;
      }
      for (const id of o.cancel) if (!current.some((entry) => entry["id"] === id)) throw new HomeError(`error: there is no wakeup ${id}; see ~/life/wakeups.json`, "invalid");
      const kept = current.filter((entry) => !o.cancel.includes(entry["id"] as string));
      const before = new Set(kept.map((entry) => entry["id"]));
      const raw = Buffer.from(`[\n${[...kept, ...o.add].map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n]\n`, "utf8");
      const special = await this.checkSpecial(p, raw, env);
      const data = special.data ?? raw;
      this.checkPlan([{ path: p, data, kind: "write" }], await this.snapshot());
      await this.files.writeBytes(p, data);
      await this.saveSpecialSide(special);
      const entries = readWakeupEntries(data.toString("utf8"));
      return { added: entries.filter((entry) => !before.has(entry.id)), cancelled: [...o.cancel], entries };
    });
  }

  /** Replaces `oldString` (exactly once unless `replaceAll`). Returns how many were replaced. */
  async editText(p: HerPath, oldString: string, newString: string, replaceAll: boolean, env: CheckEnv): Promise<{ count: number; rewritten: boolean; hash: string; profileChanged?: boolean }> {
    if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
    if (oldString.length === 0) throw new HomeError("error: old_string must not be empty", "invalid");
    if (oldString === newString) throw new HomeError("error: old_string and new_string are the same", "invalid");
    return this.locked(async () => {
      p = await this.files.canonical(p);
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
      const profileChanged = await this.saveSpecialSide(special);
      return { count: replaceAll ? count : 1, rewritten: data !== raw, hash: sha256(data), ...(special.profile ? { profileChanged } : {}) };
    });
  }

  /** The owner's DELETE (§16.11): one file. Her special JSON files are checked as if emptied. */
  async deleteFile(p: HerPath, env: CheckEnv, o: { expectedHash?: string | null } = {}): Promise<boolean> {
    if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
    return this.locked(async () => {
      p = await this.files.canonical(p);
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

  /** Saves what a special-file write carries beside the file; returns whether her profile config changed. */
  private async saveSpecialSide(o: SpecialResult): Promise<boolean> {
    if (o.wakeupIds) await this.writeSide(lifePaths.wakeupIds(this.waifuId), o.wakeupIds);
    if (o.wakeupsWritten) reconcileAfterWrite(this.storage.dataRoot, this.waifuId, o.wakeupsWritten.before, o.wakeupsWritten.after);
    return o.profile ? saveProfileToConfig(this.storage, this.waifuId, o.profile) : false;
  }

  // ---- Bash change sets ---------------------------------------------------------------------------------

  /**
   * Applies a Bash change set all or nothing (§16.3.5): every path by the path rules, places.md
   * untouched, her special files checked, the limits and names checked on the result, and nothing
   * changed under her since the command started. Journalled first (`journalId`, the tool call id).
   */
  async applyChanges(changes: ChangeSet, base: ChangeBase, env: CheckEnv, o: { journalId: string; deadlineMs?: number }): Promise<AppliedChanges & { profileChanged?: boolean }> {
    const entries = changes.writes.length + changes.deletes.length + changes.dirs.length;
    if (entries > MAX_CHANGE_SET_ENTRIES) {
      throw new HomeError(`error: the command changed ${entries} files and folders; at most ${MAX_CHANGE_SET_ENTRIES} can be saved at once`, "limit");
    }
    const deadline = Date.now() + (o.deadlineMs ?? CHANGE_CHECK_DEADLINE_MS);
    const inTime = () => {
      if (Date.now() > deadline) throw new HomeError("error: the changes took too long to check; save fewer files at once", "limit");
    };
    return this.locked(async () => {
      const plan: Planned[] = [];
      const baseByKey = new Map([...base].map(([virtual, entry]) => [pathKey(virtual), entry] as const));
      const parse = async (virtual: string): Promise<HerPath> => {
        const resolved = resolveHerPath(virtual, this.slug, { allowRoot: true });
        if (!resolved.ok) throw new HomeError(`error: ${resolved.error}`, "invalid");
        if (resolved.path.segments.length === 0) throw new HomeError(`error: ${virtual} is one of your folders and can't be replaced`, "invalid");
        return this.files.canonical(resolved.path);
      };
      for (const virtual of changes.deletes) {
        const p = await parse(virtual);
        if (deleteReachesPlaces(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
        plan.push({ path: p, kind: "delete" });
      }
      for (const virtual of changes.dirs) plan.push({ path: await parse(virtual), kind: "dir" });
      for (const write of changes.writes) {
        const p = await parse(write.path);
        if (isPlacesFile(p)) throw new HomeError(`error: ${PLACES_REFUSED}`, "places");
        plan.push({ path: p, kind: "write", data: Buffer.from(write.data) });
      }
      inTime();
      // Nothing changed under her while the command ran (the app's own rewrites included).
      for (const step of plan) {
        if (step.kind === "dir") continue;
        const was = base.get(step.path.virtual) ?? baseByKey.get(pathKey(step.path.virtual));
        const now = await this.files.inspect(step.path);
        if (now.kind === "link") throw new HomeError(`error: ${step.path.display} can't be used: it is a link`, "link");
        const changed = was === undefined ? now.kind === "file" : was.kind === "file" ? now.kind !== "file" || now.size !== was.size || now.mtimeMs !== was.mtimeMs : false;
        if (changed) throw new HomeError(`error: ${step.path.display} changed while the command ran; run it again`, "conflict");
      }
      inTime();
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
      const side: { wakeupIds?: WakeupSide; profile?: ProfileFields } = {};
      let wakeupsWritten: SpecialResult["wakeupsWritten"];
      for (const name of [WAKEUPS_FILE, PROFILE_FILE, DAY_SCHEDULE_FILE] as const) {
        const target = this.life(name);
        const write = [...effective].reverse().find((step) => step.kind === "write" && step.path.virtual === target.virtual);
        const removed = effective.some((step) => step.kind === "delete" && (step.path.virtual === target.virtual || target.virtual.startsWith(`${step.path.virtual}/`)));
        if (!write && !removed) continue;
        const checked = await this.checkSpecial(target, write ? write.data : undefined, env);
        if (write && checked.data) write.data = checked.data;
        Object.assign(side, checked.wakeupIds ? { wakeupIds: checked.wakeupIds } : {}, checked.profile ? { profile: checked.profile } : {});
        if (checked.wakeupsWritten) wakeupsWritten = checked.wakeupsWritten;
      }
      this.checkPlan(effective, await this.snapshot());
      inTime();
      const journal: Journal = {
        writes: effective.filter((step) => step.kind === "write").map((step) => ({ path: step.path.virtual, data: step.data!.toString("base64") })),
        deletes: effective.filter((step) => step.kind === "delete").map((step) => step.path.virtual),
        dirs: effective.filter((step) => step.kind === "dir").map((step) => step.path.virtual),
        ...side
      };
      const display = (virtual: string) => parseVirtual(virtual, this.slug)?.display ?? virtual;
      const applied: AppliedChanges & { profileChanged?: boolean } = { changed: journal.writes.map((write) => display(write.path)), deleted: journal.deletes.map(display), created: journal.dirs.map(display) };
      if (journal.writes.length + journal.deletes.length + journal.dirs.length === 0 && !side.wakeupIds) return applied;
      const profileBefore = side.profile ? await readWaifu(this.storage, this.waifuId).catch(() => undefined) : undefined;
      const journalDir = this.storage.dataPath(lifePaths.pendingChanges(this.waifuId));
      const journalFile = path.join(journalDir, `${safeJournalName(o.journalId)}.json`);
      await mkdir(journalDir, { recursive: true, mode: 0o700 });
      // The previous call's marker: its done intent is written by now (her calls run one at a time).
      for (const name of await readdir(journalDir).catch(() => [] as string[])) if (name.endsWith(APPLIED_SUFFIX)) await rm(path.join(journalDir, name), { force: true });
      await atomicWriteJson(journalFile, journal);
      // The files are written without a flush each, then flushed together: the journal makes the
      // set complete after a crash either way.
      await this.applyJournal(journal, { durable: false });
      if (wakeupsWritten) reconcileAfterWrite(this.storage.dataRoot, this.waifuId, wakeupsWritten.before, wakeupsWritten.after);
      if (side.profile) applied.profileChanged = !profileBefore || !sameProfile(profileBefore, side.profile);
      // Kept as a marker until her next change set: a crash before the call's done intent still
      // tells boot repair the changes were saved.
      await rename(journalFile, `${journalFile.slice(0, -".json".length)}${APPLIED_SUFFIX}`).catch(() => rm(journalFile, { force: true }));
      return applied;
    });
  }

  /** A journal's path under her current slug (she may have been renamed between a crash and boot). */
  private journalPath(virtual: string): HerPath | undefined {
    return parseVirtual(virtual.replace(/^\/home\/[^/]+/u, `/home/${this.slug}`), this.slug);
  }

  /** Applies a journal (idempotent: a write is by content, a delete of nothing is nothing). */
  private async applyJournal(journal: Journal, o: { durable?: boolean } = {}): Promise<void> {
    const written: HerPath[] = [];
    for (const virtual of journal.deletes) {
      const p = this.journalPath(virtual);
      if (p && p.segments.length > 0) await this.files.remove(p, { recursive: true }).catch((error: unknown) => {
        if (!(error instanceof HerFilesError && error.code === "missing")) throw error;
      });
    }
    for (const virtual of journal.dirs) {
      const p = this.journalPath(virtual);
      if (p) await this.files.ensureFolders(p, p.segments.length);
    }
    for (const write of journal.writes) {
      const p = this.journalPath(write.path);
      if (!p) continue;
      await this.files.writeBytes(p, Buffer.from(write.data, "base64"), o.durable === false ? { durable: false } : {});
      written.push(p);
    }
    if (o.durable === false) await this.files.flush(written);
    await this.saveSpecialSide(journal);
  }

  /**
   * Boot repair (§16.9): finishes every journalled change set a crash left. Returns their ids, and
   * the id of a change set saved just before the crash (its marker).
   */
  async recoverPendingChanges(): Promise<string[]> {
    const dir = this.storage.dataPath(lifePaths.pendingChanges(this.waifuId));
    let all: string[];
    try {
      all = await readdir(dir);
    } catch {
      return [];
    }
    const names = all.filter((name) => name.endsWith(".json"));
    const done: string[] = [];
    for (const name of all.filter((entry) => entry.endsWith(APPLIED_SUFFIX))) {
      done.push(name.slice(0, -APPLIED_SUFFIX.length));
      await rm(path.join(dir, name), { force: true });
    }
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
   * Rewrites her day (`~/life/schedule.json`; forget's scrub, §21.6). Only a file that passes its
   * checks is rewritten, and only when something changed. Returns whether it wrote.
   */
  async rewriteDay(transform: (plan: DayPlan) => DayPlan): Promise<boolean> {
    return this.locked(async () => {
      const plan = readDayPlan(await this.files.readText(this.life(DAY_SCHEDULE_FILE)).catch(() => undefined));
      if (!plan) return false;
      const next = transform(plan);
      if (JSON.stringify(next) === JSON.stringify(plan)) return false;
      await this.files.writeBytes(this.life(DAY_SCHEDULE_FILE), Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
      return true;
    });
  }

  /**
   * Rewrites her wakeups and their side file together (a timed one fired, a once watch matched, one
   * ended, her code's state saved, one disabled, the owner removed one, a forget). The side file (fires,
   * error counts, page checks and fetches) is always written. The file itself is left alone when it
   * does not read whole (`clean: false`) or, as a backstop, when the rewrite would grow it past
   * `WAKEUPS_FILE_HARD_BYTES` (her own writes stop at `MAX_WAKEUPS_FILE_BYTES`, so the app's stop
   * reasons always fit): then `saved` is false, and a caller routes no wake that depends on it.
   */
  async rewriteWakeups(transform: (entries: WakeupEntry[], side: WakeupSide) => { entries: WakeupEntry[]; side: WakeupSide }): Promise<{ clean: boolean; saved: boolean }> {
    return this.locked(async () => {
      const { entries, side, text } = await this.readWakeups();
      const clean = readsWhole(text, entries.length);
      const next = transform(entries, side);
      const changed = JSON.stringify(next.entries) !== JSON.stringify(entries);
      let saved = !changed;
      if (clean && changed) {
        const written = wakeupsText(next.entries);
        const size = Buffer.byteLength(written, "utf8");
        if (size <= WAKEUPS_FILE_HARD_BYTES || size <= Buffer.byteLength(text ?? "", "utf8")) {
          await this.files.writeBytes(this.life(WAKEUPS_FILE), Buffer.from(written, "utf8"));
          next.side = { ...next.side, sourceHash: sha256(written) };
          saved = true;
        }
      }
      next.side = { ...next.side, fired: next.side.fired.slice(-MAX_FIRED) };
      if (JSON.stringify(next.side) !== JSON.stringify(side)) await this.writeSide(lifePaths.wakeupIds(this.waifuId), next.side);
      return { clean, saved };
    });
  }

  /** Records wake ids routed (timed occurrences, timeouts, once matches) so they never fire twice. */
  async markWakeupsFired(wakeIds: readonly string[]): Promise<void> {
    if (wakeIds.length === 0) return;
    await this.locked(async () => {
      const side = await this.readWakeupSide();
      await this.writeSide(lifePaths.wakeupIds(this.waifuId), { ...side, fired: [...side.fired.filter((id) => !wakeIds.includes(id)), ...wakeIds].slice(-MAX_FIRED) });
    });
  }

  /**
   * `~/profile.json` from her config (spec 17.1): written when missing, unreadable or saying
   * something else than her config (a dashboard edit); her own layout is kept while it agrees.
   * Returns whether it wrote.
   */
  async writeProfileFromConfig(): Promise<boolean> {
    return this.locked(async () => {
      const waifu = await readWaifu(this.storage, this.waifuId);
      const servers = await profileServers(this.storage);
      const p = this.life(PROFILE_FILE);
      const current = await this.files.readText(p).catch(() => undefined);
      if (current !== undefined) {
        const checked = checkProfileText(current, { name: waifu.name, servers });
        // Her name is shown for reference: a rename rewrites the file too.
        if (checked.ok && sameProfile(checked.fields, waifu) && current.includes(JSON.stringify(waifu.name))) return false;
      }
      await this.files.writeBytes(p, Buffer.from(profileFileText(waifu, servers), "utf8"));
      return true;
    });
  }

  /** `~/life/places.md` (§16.6), written only when it would change. Returns whether it did. */
  async writePlaces(text: string): Promise<boolean> {
    return this.locked(async () => {
      const p = this.life(PLACES_FILE);
      const current = await this.files.readText(p).catch(() => undefined);
      if (current === text) return false;
      await this.files.writeBytes(p, Buffer.from(text, "utf8"));
      return true;
    });
  }

  /**
   * Re-checks her wakeups file after someone changed it outside the app (the owner, on disk): the
   * side file follows when the file still passes, otherwise it keeps the last good resolution.
   */
  async resyncWakeups(env: CheckEnv): Promise<"same" | "updated" | "invalid"> {
    return this.locked(async () => {
      const text = (await this.readWakeupsText()) ?? "";
      const side = await this.readWakeupSide();
      if (sha256(text) === side.sourceHash || (!text.trim() && Object.keys(side.watches).length === 0 && Object.keys(side.every).length === 0)) return "same";
      // Checked against itself: what is in the file is what is saved (a passed time is kept).
      const checked = await checkWakeupsText(text, this.wakeupContext(env, readWakeupEntries(text), side)).catch(() => undefined);
      if (!checked?.ok || checked.rewritten) return "invalid";
      await this.writeSide(lifePaths.wakeupIds(this.waifuId), { ...checked.side, sourceHash: sha256(text), fired: side.fired });
      return "updated";
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
      let count = files.length - (existing ? 1 : 0);
      for (const oldest of files.filter((candidate) => candidate !== existing).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total + data.length <= limits.tmpMaxBytes && count + 1 <= limits.tmpMaxFiles) break;
        await this.files.remove(oldest.path).catch(() => undefined);
        total -= oldest.size;
        count -= 1;
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
    if (isDmFolderPath(p)) return entries.find((entry) => pathKey(entry.path) === pathKey(p.virtual))?.placeKey ?? byPath?.placeKey ?? "dm_file";
    if (entries.length === 0) return undefined;
    const info = await this.files.inspect(p);
    if (info.kind !== "file" || !entries.some((entry) => entry.size === info.size)) return undefined;
    const sha = await this.hashOf(p);
    return entries.find((entry) => entry.sha256 === sha)?.placeKey;
  }

  /**
   * Files she made from a private chat's transcript (§18.3, D14): a copy (`cp`, `cat >`, a Write of
   * what Read showed her) keeps its DM origin like a DM download, by content hash. Recorded only when
   * the file's bytes still equal the transcript text she was served.
   */
  async recordTranscriptCopies(copies: ReadonlyArray<{ path: HerPath; sha256: string; size: number; placeKey: string }>, now: Date): Promise<number> {
    if (copies.length === 0) return 0;
    return this.locked(async () => {
      const index = await this.readIndex();
      const added: ProvenanceEntry[] = [];
      for (const copy of copies) {
        const info = await this.files.inspect(copy.path);
        if (info.kind !== "file" || info.size !== copy.size || sha256(await this.files.readBytes(copy.path)) !== copy.sha256) continue;
        added.push({
          sha256: copy.sha256,
          placeKey: copy.placeKey,
          messageId: TRANSCRIPT_COPY,
          authorId: TRANSCRIPT_COPY,
          attachmentId: TRANSCRIPT_COPY,
          downloadedAt: now.toISOString(),
          path: copy.path.virtual,
          size: copy.size
        });
      }
      if (added.length === 0) return 0;
      const paths = new Set(added.map((entry) => entry.path));
      const kept = index.entries.filter((entry) => !(entry.attachmentId === TRANSCRIPT_COPY && paths.has(entry.path)));
      await this.writeSide(lifePaths.filesIndex(this.waifuId), { entries: [...kept, ...added].slice(-MAX_PROVENANCE_ENTRIES) });
      return added.length;
    });
  }

  /** A file whose bytes are a copy of a private chat's transcript (SendMessage refuses it, §18.3). */
  async isTranscriptCopy(p: HerPath, index?: FilesIndex): Promise<boolean> {
    const entries = (index ?? (await this.readIndex())).entries.filter((entry) => entry.attachmentId === TRANSCRIPT_COPY);
    if (entries.length === 0) return false;
    const info = await this.files.inspect(p);
    if (info.kind !== "file" || !entries.some((entry) => entry.size === info.size)) return false;
    const sha = await this.hashOf(p);
    return entries.some((entry) => entry.sha256 === sha);
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
   * Her private files right now: `~/MEMORY.md`, every file it links to, and everything in `~/life/`
   * (her day, reminders, watches, profile and places, §21.6; `isPrivateFile` covers the whole
   * folder). Copies under other names are hers to share.
   */
  async privateFiles(): Promise<Set<string>> {
    const out = new Set([pathKey(this.home(MEMORY_FILE).virtual), ...([DAY_SCHEDULE_FILE, WAKEUPS_FILE, PLACES_FILE, PROFILE_FILE] as const).map((name) => pathKey(this.life(name).virtual))]);
    const memory = await this.files.canonical(this.home(MEMORY_FILE));
    const index = await this.files.readText(memory).catch(() => undefined);
    for (const target of markdownLinks(index ?? "")) {
      const resolved = await this.resolveExisting(target.startsWith("/") || target.startsWith("~") ? target : `~/${target}`);
      if (resolved.ok) out.add(pathKey(resolved.path.virtual));
    }
    return out;
  }

  /** One of her private files (by `privateFiles`, any spelling; anything in `~/life/`). */
  async isPrivateFile(p: HerPath, privateKeys?: ReadonlySet<string>): Promise<boolean> {
    if (isLifeDirPath(p)) return true;
    return (privateKeys ?? (await this.privateFiles())).has(pathKey((await this.files.canonical(p)).virtual));
  }

  /** The text files of her home (forget's scrub and verification, maintenance): path below home → text. */
  async readAllText(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const entry of await this.files.walk("home")) {
      if (entry.kind !== "file" || entry.size > READ_ALL_MAX_BYTES) continue;
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

/** A change set's journal after it was applied (kept until her next one). */
const APPLIED_SUFFIX = ".applied";

export function safeJournalName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 100) || "change";
}

/** What a special-file check gives the write: the bytes to save and what goes beside them. */
type SpecialResult = {
  data?: Buffer;
  wakeupIds?: WakeupSide;
  profile?: ProfileFields;
  /** Her wakeups before and after (the state waiting in memory follows her write, §30.2). */
  wakeupsWritten?: { before: readonly WakeupEntry[]; after: readonly WakeupEntry[] };
};

async function rmdirQuiet(dir: string): Promise<void> {
  const { rmdir } = await import("node:fs/promises");
  await rmdir(dir).catch(() => undefined);
}

/**
 * Link targets in Markdown that name her files (§16.3.2): inline links `[t](people/kevin.md)`,
 * `[t](<people/mina notes.md> "title")`, reference definitions `[r1]: people/ref.md`, with `./`,
 * `~/` or absolute paths, percent-encoding and anchors or queries removed. URLs are left out.
 */
export function markdownLinks(text: string): string[] {
  const raw: string[] = [];
  // Inline: `](target)`, `](<target with spaces>)`, an optional title after the target.
  for (const match of text.matchAll(/\]\(\s*(?:<([^>\n]*)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/gu)) raw.push((match[1] ?? match[2])!);
  // Reference definitions: `[id]: target` or `[id]: <target>` at the start of a line.
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]*)>|(\S+))/gmu)) raw.push((match[1] ?? match[2])!);
  const out: string[] = [];
  for (const candidate of raw) {
    let target = candidate.trim().split("#")[0]!.split("?")[0]!;
    if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // kept as written
    }
    out.push(target.replace(/^(\.\/)+/u, ""));
  }
  return out;
}
