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

import { readFile } from "node:fs/promises";
import { resolveDataPath } from "../../config/paths.js";
import type { StorageService } from "../../storage/storageService.js";
import { atomicWriteJson } from "../../storage/atomic.js";

export const FORGOTTEN_PEOPLE_PATH = ["user", "people", "forgotten.json"] as const;
const FORGOTTEN_LOCK = "people-forgotten";

export type ForgottenPerson = { userId: string; at: string };
export type PendingScrub = { userId: string; at: string; source: "dm_forget_everything" };

async function readEntries<T>(file: string, field: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const entries = parsed[field];
    return Array.isArray(entries) ? (entries.filter((entry) => entry && typeof entry === "object") as T[]) : [];
  } catch {
    return [];
  }
}

function upsert<T extends { userId: string; at: string }>(entries: T[], next: T): T[] {
  const others = entries.filter((entry) => entry.userId !== next.userId);
  const previous = entries.find((entry) => entry.userId === next.userId);
  const kept = previous && previous.at > next.at ? previous : next;
  return [...others, kept];
}

export async function readForgottenPeople(storage: StorageService): Promise<ForgottenPerson[]> {
  return readEntries<ForgottenPerson>(resolveDataPath(storage.dataRoot, ...FORGOTTEN_PEOPLE_PATH), "forgotten");
}

/** The owner's forget-user: `{userId, at}` into `user/people/forgotten.json`. */
export async function recordForgottenPerson(storage: StorageService, userId: string, at: Date): Promise<void> {
  const file = resolveDataPath(storage.dataRoot, ...FORGOTTEN_PEOPLE_PATH);
  await storage.withLocks([FORGOTTEN_LOCK], async () => {
    const forgotten = upsert(await readForgottenPeople(storage), { userId, at: at.toISOString() });
    await atomicWriteJson(file, { forgotten });
  });
}

export function pendingScrubsPath(dataRoot: string, waifuId: string): string {
  return resolveDataPath(dataRoot, "user", "waifus", waifuId, "life", "pending-scrubs.json");
}

export async function readPendingScrubs(storage: StorageService, waifuId: string): Promise<PendingScrub[]> {
  return readEntries<PendingScrub>(pendingScrubsPath(storage.dataRoot, waifuId), "scrubs");
}

/** A DM user's `/forget everything`: a scrub of that user queued for her (spec §7.3). */
export async function queuePendingScrub(storage: StorageService, waifuId: string, userId: string, at: Date): Promise<void> {
  const file = pendingScrubsPath(storage.dataRoot, waifuId);
  await storage.withLocks([`pending-scrubs:${waifuId}`], async () => {
    const scrubs = upsert(await readPendingScrubs(storage, waifuId), { userId, at: at.toISOString(), source: "dm_forget_everything" as const });
    await atomicWriteJson(file, { scrubs });
  });
}
