// Durable forget records (Living cast spec §7.5 step 1, §7.3):
//
// - The owner's forget-user adds `{userId, at}` to `user/people/forgotten.json` (§7.5 step 1): that
//   user's messages written at or before `at` render as `(removed)`, and the memories→notes
//   migration leaves out every record about them.
// - A life scrub that has not run yet is queued in `user/waifus/<id>/life/pending-scrubs.json`: the
//   owner's forget-user (run now, or when her life next starts), a DM user's `/forget everything` or
//   `/forget conversation` (run now, or at her nightly maintenance inside the 6-hour window). The
//   entry keeps the names collected before the DM data went, so a later run still knows them. The
//   memories→notes migration leaves out her records about a queued user.
//
// One entry per user (per waifu for scrubs); a later forget moves `at` forward and never weakens the
// source (owner > everything > conversation).
//
// Only a missing file reads as empty. An unreadable `forgotten.json` is never treated as "nobody
// forgotten": reads throw `ForgetRecordCorruptError` (callers fail closed). A write keeps a copy of
// the unreadable file (`<name>.corrupt-<timestamp>`, with a warning) and starts from every entry
// that can still be read out of it: whole entries when the JSON parses, else each `{…}` object
// with a user id, else each bare `"userId": "<id>"` (forgotten as of now, queued as an owner
// scrub). Pending scrubs are salvaged the same way on read, so a queued scrub is never lost to a
// torn file. A forget scrubs those copies too (the person's entries, or the lines carrying them),
// and a copy older than 7 days goes whole: its salvage was merged when it was made.

import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../backend/logger.js";
import { resolveDataPath } from "../../config/paths.js";
import type { StorageService } from "../../storage/storageService.js";
import { atomicWriteJson } from "../../storage/atomic.js";

export const FORGOTTEN_PEOPLE_PATH = ["user", "people", "forgotten.json"] as const;
const FORGOTTEN_LOCK = "people-forgotten";
const USER_ID = /^\d{5,25}$/u;

export type ForgottenPerson = { userId: string; at: string };
/**
 * A queued life scrub of one person. `owner_forget`: the owner's forget-user (run now, or when her
 * life next starts). `dm_forget_everything` / `dm_forget_conversation`: a DM user's `/forget`
 * (run now, or at nightly maintenance inside the 6-hour window, §7.3).
 */
export type PendingScrubSource = "dm_forget_conversation" | "dm_forget_everything" | "owner_forget";
export type PendingScrub = { userId: string; at: string; source: PendingScrubSource; names?: string[]; sharedNames?: string[] };

const SOURCE_RANK: Record<PendingScrubSource, number> = { dm_forget_conversation: 0, dm_forget_everything: 1, owner_forget: 2 };

export type ForgetRecordLogger = Pick<Logger, "warn">;

/** A forget record file exists but cannot be read as one. */
export class ForgetRecordCorruptError extends Error {
  override name = "ForgetRecordCorruptError";
  constructor(
    readonly file: string,
    reason: string,
    /** Whatever could still be read out of it. */
    readonly salvaged: Array<Record<string, unknown>> = []
  ) {
    super(`Forget record ${file} is unreadable: ${reason}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const withUser = (entry: unknown): entry is Record<string, unknown> & { userId: string } => isRecord(entry) && typeof entry.userId === "string" && USER_ID.test(entry.userId);

/** Entries that can still be read out of a broken record file. */
function salvage(raw: string, field: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = isRecord(parsed) ? parsed[field] : undefined;
    if (Array.isArray(entries)) return entries.filter(withUser);
  } catch {
    // not JSON: scan for objects and bare ids below
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const match of raw.matchAll(/\{[^{}]*\}/gu)) {
    try {
      const entry = JSON.parse(match[0]) as unknown;
      if (withUser(entry)) out.set(entry.userId, entry);
    } catch {
      // a torn object: its id may still be found below
    }
  }
  for (const match of raw.matchAll(/"userId"\s*:\s*"(\d{5,25})"/gu)) if (!out.has(match[1]!)) out.set(match[1]!, { userId: match[1]! });
  return [...out.values()];
}

async function readEntries<T>(file: string, field: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ForgetRecordCorruptError(file, error instanceof Error ? error.message : String(error), salvage(raw, field));
  }
  const entries = isRecord(parsed) ? parsed[field] : undefined;
  if (!Array.isArray(entries)) throw new ForgetRecordCorruptError(file, `no "${field}" list`, salvage(raw, field));
  return entries.filter((entry) => entry && typeof entry === "object") as T[];
}

/**
 * The entries to update. An unreadable file is moved aside (kept for the owner, with a warning)
 * and the update starts from what could be salvaged from it (`complete` fills missing fields).
 */
async function entriesForUpdate<T>(
  file: string,
  field: string,
  logger: ForgetRecordLogger | undefined,
  now: Date,
  complete: (entry: Record<string, unknown> & { userId: string }) => T
): Promise<T[]> {
  try {
    return await readEntries<T>(file, field);
  } catch (error) {
    if (!(error instanceof ForgetRecordCorruptError)) throw error;
    const aside = `${file}.corrupt-${now.toISOString().replace(/[:.]/gu, "-")}`;
    await rename(file, aside);
    (logger ?? console).warn("A forget record file was unreadable; a copy was kept and the entries that could be read carried over", {
      file,
      movedTo: aside,
      salvaged: error.salvaged.length,
      reason: error.message
    });
    return error.salvaged.filter(withUser).map(complete);
  }
}

function upsert<T extends { userId: string; at: string }>(entries: T[], next: T): T[] {
  const others = entries.filter((entry) => entry.userId !== next.userId);
  const previous = entries.find((entry) => entry.userId === next.userId);
  const kept = previous && previous.at > next.at ? previous : next;
  return [...others, kept];
}

export async function readForgottenPeople(storage: Pick<StorageService, "dataRoot">): Promise<ForgottenPerson[]> {
  return readEntries<ForgottenPerson>(resolveDataPath(storage.dataRoot, ...FORGOTTEN_PEOPLE_PATH), "forgotten");
}

/** The owner's forget-user: `{userId, at}` into `user/people/forgotten.json`. */
export async function recordForgottenPerson(storage: StorageService, userId: string, at: Date, o: { logger?: ForgetRecordLogger } = {}): Promise<void> {
  const file = resolveDataPath(storage.dataRoot, ...FORGOTTEN_PEOPLE_PATH);
  await storage.withLocks([FORGOTTEN_LOCK], async () => {
    // A salvaged entry without a readable time is forgotten as of now (the conservative choice).
    const salvaged = await entriesForUpdate<ForgottenPerson>(file, "forgotten", o.logger, at, (entry) => ({
      userId: entry.userId,
      at: typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry.at : at.toISOString()
    }));
    const forgotten = upsert(salvaged, { userId, at: at.toISOString() });
    await atomicWriteJson(file, { forgotten });
  });
}

export function pendingScrubsPath(dataRoot: string, waifuId: string): string {
  return resolveDataPath(dataRoot, "user", "waifus", waifuId, "life", "pending-scrubs.json");
}

const stringList = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);

/** A salvaged scrub: an unknown source runs as the owner's (at the next start, the safe choice). */
function completeScrub(now: Date) {
  return (entry: Record<string, unknown> & { userId: string }): PendingScrub => {
    const source = typeof entry.source === "string" && entry.source in SOURCE_RANK ? (entry.source as PendingScrubSource) : "owner_forget";
    const names = stringList(entry.names);
    const sharedNames = stringList(entry.sharedNames);
    return {
      userId: entry.userId,
      at: typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry.at : now.toISOString(),
      source,
      ...(names ? { names } : {}),
      ...(sharedNames ? { sharedNames } : {})
    };
  };
}

/** Queued scrubs; a torn file yields what can be salvaged from it (logged), never an error. */
export async function readPendingScrubs(storage: Pick<StorageService, "dataRoot">, waifuId: string, o: { logger?: ForgetRecordLogger } = {}): Promise<PendingScrub[]> {
  try {
    return await readEntries<PendingScrub>(pendingScrubsPath(storage.dataRoot, waifuId), "scrubs");
  } catch (error) {
    if (!(error instanceof ForgetRecordCorruptError)) throw error;
    (o.logger ?? console).warn("Pending scrubs file is unreadable; running the scrubs that could be read from it", { waifuId, salvaged: error.salvaged.length });
    return error.salvaged.filter(withUser).map(completeScrub(new Date()));
  }
}

function mergeNames(...lists: Array<string[] | undefined>): string[] | undefined {
  const all = lists.flatMap((list) => list ?? []);
  return all.length > 0 ? [...new Set(all)] : undefined;
}

/**
 * Queues a scrub of that user for her. One entry per user: `at` moves forward, the source never
 * weakens (owner > everything > conversation) and the names add up. Returns the stored entry.
 */
export async function queuePendingScrub(
  storage: StorageService,
  waifuId: string,
  userId: string,
  at: Date,
  o: { logger?: ForgetRecordLogger; source?: PendingScrubSource; names?: string[]; sharedNames?: string[] } = {}
): Promise<PendingScrub> {
  const file = pendingScrubsPath(storage.dataRoot, waifuId);
  let stored!: PendingScrub;
  await storage.withLocks([`pending-scrubs:${waifuId}`], async () => {
    const existing = await entriesForUpdate<PendingScrub>(file, "scrubs", o.logger, at, completeScrub(at));
    const previous = existing.find((entry) => entry.userId === userId);
    const wanted = o.source ?? "dm_forget_everything";
    const source = previous && SOURCE_RANK[previous.source] > SOURCE_RANK[wanted] ? previous.source : wanted;
    const names = mergeNames(previous?.names, o.names);
    const sharedNames = mergeNames(previous?.sharedNames, o.sharedNames);
    const later = previous && previous.at > at.toISOString() ? previous.at : at.toISOString();
    stored = { userId, at: later, source, ...(names ? { names } : {}), ...(sharedNames ? { sharedNames } : {}) };
    await atomicWriteJson(file, { scrubs: [...existing.filter((entry) => entry.userId !== userId), stored] });
  });
  return stored;
}

/** Drops the scrubs that ran (same user and time); entries queued meanwhile stay. */
export async function removePendingScrubs(storage: StorageService, waifuId: string, done: readonly Pick<PendingScrub, "userId" | "at">[], o: { logger?: ForgetRecordLogger; now?: Date } = {}): Promise<void> {
  if (done.length === 0) return;
  const file = pendingScrubsPath(storage.dataRoot, waifuId);
  const now = o.now ?? new Date();
  await storage.withLocks([`pending-scrubs:${waifuId}`], async () => {
    const existing = await entriesForUpdate<PendingScrub>(file, "scrubs", o.logger, now, completeScrub(now));
    const scrubs = existing.filter((entry) => !done.some((ran) => ran.userId === entry.userId && ran.at === entry.at));
    await atomicWriteJson(file, { scrubs });
  });
}

/** Kept copies of unreadable record files live this long (their salvage was merged when made). */
export const CORRUPT_COPY_RETENTION_MS = 7 * 24 * 3_600_000;
const COPY_NAME = /^(?:forgotten|pending-scrubs)\.json\.corrupt-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u;

async function listNames(dir: string): Promise<string[]> {
  return readdir(dir).then((names) => names.sort(), () => [] as string[]);
}

/** Every kept copy of an unreadable forget record: `forgotten.json` and each life's pending scrubs. */
async function forgetRecordCopies(dataRoot: string): Promise<Array<{ file: string; madeAt: number | undefined }>> {
  const dirs = [resolveDataPath(dataRoot, "user", "people")];
  for (const waifuId of await listNames(resolveDataPath(dataRoot, "user", "waifus"))) {
    if (/^\.+$/u.test(waifuId)) continue;
    dirs.push(resolveDataPath(dataRoot, "user", "waifus", waifuId, "life"));
  }
  const copies: Array<{ file: string; madeAt: number | undefined }> = [];
  for (const dir of dirs) {
    for (const name of await listNames(dir)) {
      const match = COPY_NAME.exec(name);
      if (!match) continue;
      const madeAt = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
      copies.push({ file: path.join(dir, name), madeAt: Number.isFinite(madeAt) ? madeAt : undefined });
    }
  }
  return copies;
}

async function copyAge(copy: { file: string; madeAt: number | undefined }, now: Date): Promise<number> {
  const madeAt = copy.madeAt ?? (await stat(copy.file).then((info) => info.mtimeMs, () => now.getTime()));
  return now.getTime() - madeAt;
}

/** Deletes kept copies older than 7 days (boot, and every forget). Returns how many went. */
export async function pruneForgetRecordCopies(storage: Pick<StorageService, "dataRoot">, now: Date): Promise<number> {
  let removed = 0;
  for (const copy of await forgetRecordCopies(storage.dataRoot)) {
    if ((await copyAge(copy, now)) < CORRUPT_COPY_RETENTION_MS) continue;
    await rm(copy.file, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Forget (§7.5): the kept copies lose the person. A copy that parses loses the person's entries;
 * one that does not loses every line `carries` matches (their id or a name only they have).
 * Old copies go whole first. Returns the copies changed or deleted.
 */
export async function scrubForgetRecordCopies(
  storage: Pick<StorageService, "dataRoot">,
  o: { userId: string; carries: (text: string) => boolean; now: Date }
): Promise<number> {
  let changed = await pruneForgetRecordCopies(storage, o.now);
  for (const copy of await forgetRecordCopies(storage.dataRoot)) {
    const raw = await readFile(copy.file, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    let next: string;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) throw new Error("not an object");
      const field = Array.isArray(parsed.forgotten) ? "forgotten" : Array.isArray(parsed.scrubs) ? "scrubs" : undefined;
      if (!field) throw new Error("no list");
      const entries = parsed[field] as unknown[];
      const kept = entries.filter((entry) => !(isRecord(entry) && entry.userId === o.userId));
      next = kept.length === entries.length ? raw : `${JSON.stringify({ ...parsed, [field]: kept }, null, 2)}\n`;
    } catch {
      next = raw.split("\n").filter((line) => !o.carries(line)).join("\n");
    }
    if (next === raw) continue;
    await writeFile(copy.file, next, { encoding: "utf8", mode: 0o600 });
    changed += 1;
  }
  return changed;
}
