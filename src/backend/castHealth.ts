// What needs the owner's attention in the Living cast's own state (spec §14, L2 hand-offs): migration
// steps that left unreadable data alone, owner forgets that have not finished (or were given up),
// kept copies of unreadable forget records, queued forget scrubs, and the intake marks and pause
// start. Read-only and offline: `waifus doctor` and `waifus status` read it with no host running,
// `GET /api/owner-notices` adds the live runtime's notices.

import { readFile, readdir } from "node:fs/promises";
import { resolveDataPath } from "../config/paths.js";
import { INTAKE_MARKS_PATH } from "../life/intakeMarks.js";
import { countForgetRecordCopies, readPendingScrubs } from "../orchestration/dm/forgotten.js";
import { pendingForgetJobs, pendingParts } from "../orchestration/dm/forgetUser.js";
import type { StorageService } from "../storage/storageService.js";
import { readIncompleteMigrations, type IncompleteMigration } from "./migrations.js";

export type ForgetJobView = { userId: string; at: string; pending: ReturnType<typeof pendingParts> };

export type CastHealth = {
  forgetJobs: ForgetJobView[];
  incompleteMigrations: IncompleteMigration[];
  corruptForgetCopies: number;
  pendingScrubs: Array<{ waifuId: string; count: number }>;
  intake: { paused: boolean; pausedAt: string | null; marks: number };
};

async function intakeMarks(dataRoot: string): Promise<{ pausedAt: string | null; marks: number }> {
  try {
    const parsed = JSON.parse(await readFile(resolveDataPath(dataRoot, ...INTAKE_MARKS_PATH), "utf8")) as { marks?: unknown; pausedAt?: unknown };
    const marks = parsed.marks && typeof parsed.marks === "object" ? Object.keys(parsed.marks).length : 0;
    return { pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : null, marks };
  } catch {
    return { pausedAt: null, marks: 0 };
  }
}

/** Forget jobs a crash or a failure left behind, with their unfinished parts. */
export async function forgetJobViews(storage: StorageService): Promise<ForgetJobView[]> {
  return (await pendingForgetJobs(storage)).map((job) => ({ userId: job.userId, at: job.at, pending: pendingParts(job) }));
}

export async function castHealth(storage: StorageService, o: { paused: boolean }): Promise<CastHealth> {
  const waifuIds = (await readdir(resolveDataPath(storage.dataRoot, "user", "waifus")).catch(() => [] as string[])).filter((id) => !/^\.+$/u.test(id)).sort();
  const pendingScrubs: CastHealth["pendingScrubs"] = [];
  for (const waifuId of waifuIds) {
    const scrubs = await readPendingScrubs(storage, waifuId, { logger: { warn: () => undefined } }).catch(() => []);
    if (scrubs.length > 0) pendingScrubs.push({ waifuId, count: scrubs.length });
  }
  const [forgetJobs, incompleteMigrations, corruptForgetCopies, marks] = await Promise.all([
    forgetJobViews(storage).catch(() => [] as ForgetJobView[]),
    readIncompleteMigrations(storage.dataRoot),
    countForgetRecordCopies(storage.dataRoot).catch(() => 0),
    intakeMarks(storage.dataRoot)
  ]);
  return { forgetJobs, incompleteMigrations, corruptForgetCopies, pendingScrubs, intake: { paused: o.paused, ...marks } };
}
