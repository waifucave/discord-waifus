// Durable forget records (Living cast spec §7.5 step 1, §7.3). L1 has no notes or lives to scrub
// yet, so a forget leaves a record that L2 acts on:
//
// - The owner's forget-user adds `{userId, at}` to `user/people/forgotten.json` (§7.5 step 1): that
//   user's messages written at or before `at` render as `(removed)`, and the memories→notes
//   migration leaves out every record about them.
// - A DM user's `/forget everything` queues a scrub for that waifu in
//   `user/waifus/<id>/life/pending-scrubs.json` (§7.3): the memories→notes migration leaves out her
//   records about that user, and her maintenance runs the scrub.
//
// One entry per user (per waifu for scrubs); a later forget moves `at` forward.
//
// Only a missing file reads as empty. An unreadable one (bad JSON, wrong shape) is never treated as
// "nobody forgotten": reads throw `ForgetRecordCorruptError`, and a write first moves the file aside
// to `<name>.corrupt-<timestamp>` (kept for the owner) with a warning, then starts a fresh one.

import { readFile, rename } from "node:fs/promises";
import type { Logger } from "../../backend/logger.js";
import { resolveDataPath } from "../../config/paths.js";
import type { StorageService } from "../../storage/storageService.js";
import { atomicWriteJson } from "../../storage/atomic.js";

export const FORGOTTEN_PEOPLE_PATH = ["user", "people", "forgotten.json"] as const;
const FORGOTTEN_LOCK = "people-forgotten";

export type ForgottenPerson = { userId: string; at: string };
/**
 * A queued life scrub of one person. `dm_forget_everything`: a DM user's `/forget everything` inside
 * the 6-hour window, run at nightly maintenance (§7.3). `owner_forget`: the owner's forget-user while
 * no cast runtime was running (Discord offline), run when her life next starts (§7.5).
 */
export type PendingScrubSource = "dm_forget_everything" | "owner_forget";
export type PendingScrub = { userId: string; at: string; source: PendingScrubSource };

export type ForgetRecordLogger = Pick<Logger, "warn">;

/** A forget record file exists but cannot be read as one. */
export class ForgetRecordCorruptError extends Error {
  override name = "ForgetRecordCorruptError";
  constructor(readonly file: string, reason: string) {
    super(`Forget record ${file} is unreadable: ${reason}`);
  }
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
    throw new ForgetRecordCorruptError(file, error instanceof Error ? error.message : String(error));
  }
  const entries = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
  if (!Array.isArray(entries)) throw new ForgetRecordCorruptError(file, `no "${field}" list`);
  return entries.filter((entry) => entry && typeof entry === "object") as T[];
}

/** The entries to update: a corrupt file is moved aside (with a warning) and the update starts fresh. */
async function entriesForUpdate<T>(file: string, field: string, logger: ForgetRecordLogger | undefined, now: Date): Promise<T[]> {
  try {
    return await readEntries<T>(file, field);
  } catch (error) {
    if (!(error instanceof ForgetRecordCorruptError)) throw error;
    const aside = `${file}.corrupt-${now.toISOString().replace(/[:.]/gu, "-")}`;
    await rename(file, aside);
    (logger ?? console).warn("A forget record file was unreadable; it was moved aside and a fresh one started", {
      file,
      movedTo: aside,
      reason: error.message
    });
    return [];
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
    const forgotten = upsert(await entriesForUpdate<ForgottenPerson>(file, "forgotten", o.logger, at), { userId, at: at.toISOString() });
    await atomicWriteJson(file, { forgotten });
  });
}

export function pendingScrubsPath(dataRoot: string, waifuId: string): string {
  return resolveDataPath(dataRoot, "user", "waifus", waifuId, "life", "pending-scrubs.json");
}

export async function readPendingScrubs(storage: Pick<StorageService, "dataRoot">, waifuId: string): Promise<PendingScrub[]> {
  return readEntries<PendingScrub>(pendingScrubsPath(storage.dataRoot, waifuId), "scrubs");
}

/**
 * A scrub of that user queued for her: a DM user's `/forget everything` (spec §7.3), or the owner's
 * forget-user while the cast runtime is not running. One entry per user; an `owner_forget` entry is
 * never downgraded to the nightly DM source.
 */
export async function queuePendingScrub(
  storage: StorageService,
  waifuId: string,
  userId: string,
  at: Date,
  o: { logger?: ForgetRecordLogger; source?: PendingScrubSource } = {}
): Promise<void> {
  const file = pendingScrubsPath(storage.dataRoot, waifuId);
  await storage.withLocks([`pending-scrubs:${waifuId}`], async () => {
    const existing = await entriesForUpdate<PendingScrub>(file, "scrubs", o.logger, at);
    const owner = o.source === "owner_forget" || existing.some((entry) => entry.userId === userId && entry.source === "owner_forget");
    const merged = upsert(existing, { userId, at: at.toISOString(), source: o.source ?? "dm_forget_everything" });
    const scrubs = merged.map((entry) => (entry.userId === userId && owner ? { ...entry, source: "owner_forget" as const } : entry));
    await atomicWriteJson(file, { scrubs });
  });
}

/** Drops the scrubs that ran (same user and time); entries queued meanwhile stay. */
export async function removePendingScrubs(storage: StorageService, waifuId: string, done: readonly PendingScrub[], o: { logger?: ForgetRecordLogger; now?: Date } = {}): Promise<void> {
  if (done.length === 0) return;
  const file = pendingScrubsPath(storage.dataRoot, waifuId);
  await storage.withLocks([`pending-scrubs:${waifuId}`], async () => {
    const existing = await entriesForUpdate<PendingScrub>(file, "scrubs", o.logger, o.now ?? new Date());
    const scrubs = existing.filter((entry) => !done.some((ran) => ran.userId === entry.userId && ran.at === entry.at));
    await atomicWriteJson(file, { scrubs });
  });
}
