// The owner's forget-user, step 1 (spec 9.1.4; Living cast §7.5), behind
// `POST /api/people/:userId/forget`: every DM with the user goes (`dmForget(scope: "all")` per
// waifu: DM conversation directory, DM state, cached images), then everything else in
// `user/dms/<userId>/`. The rate-limit counters are reset (only the owner can do that), but each
// limits file stays with its forget floor alone: the bot cannot delete the user's own messages, so
// without the floor the next DM would read the forgotten chat back from Discord. A floor is never
// lost and never lowered: every floor is written (or raised) first, for every waifu with a DM, a
// DM state or a limits file, before anything is removed.
//
// Also here, with or without a running cast: `{userId, at}` is recorded in
// `user/people/forgotten.json` (§7.5 step 1); the person leaves every server's `members.json` and
// active-chat participant lists; the Living cast archive is scrubbed whole (owner decision D-b);
// the kept copies of unreadable forget records lose them; and the in-memory captured traffic
// (Activity, the `/api/events` replay) loses every entry carrying them (always, even when a part
// failed). The life scrubs (summary, other state, notes, verification) are queued by the caller
// before this runs. The usage ledger and app logs (ids only) are never rewritten (O5).
//
// Crash safety: the work is a durable job (`user/people/forget-jobs.json`, with the names
// collected before the DM data went) written before anything is removed and cleared only when
// every part succeeded. Each part runs on its own (one failing never skips the others), and a job
// left behind by a crash or a failure runs again, whole, at the next boot (`resumeForgetJobs`).

import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../backend/logger.js";
import { resolveDataPath } from "../../config/paths.js";
import { scrubArchive, type ArchiveScrubResult } from "../../life/archiveScrub.js";
import { personMatcher } from "../../life/text.js";
import { forgetCapturedTraffic } from "../../shared/queryLog.js";
import { ActiveChatParticipantsFileSchema, GuildMembersFileSchema } from "../../shared/schemas/domain.js";
import type { DmLimitState } from "../../shared/schemas/dm.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { StorageService } from "../../storage/storageService.js";
import { dmForget, dmWaifuIdsForUser, type DmForgetHooks } from "./dmForget.js";
import { dmFloorAt, dmUserDir, laterFloor, listDmLimitWaifuIds, listDmUserIds, updateDmLimit } from "./dmStore.js";
import { recordForgottenPerson, scrubForgetRecordCopies } from "./forgotten.js";

export type ForgetUserResult = {
  discordUserId: string;
  dryRun: boolean;
  /** DM conversation directories deleted. */
  dmContexts: number;
  /** DM state files deleted (rate-limit counter files are counted separately in dmLimits). */
  dmStates: number;
  /** Rate-limit counter files reset (each keeps only its forget floor). */
  dmLimits: number;
  cachedImages: number;
  /** Server member lists and active-chat participant lists the person was removed from. */
  memberLists?: number;
  /** The Living cast archive scrub (D-b): files rewritten, records removed, files left unreadable. */
  archive?: ArchiveScrubResult;
};

/** A forget-user whose DM, archive and member-list part has not finished yet. */
export type ForgetJob = {
  userId: string;
  at: string;
  /** Names only this person has (collected before the DM data went). */
  names?: string[];
  /** Names someone else has: never used to remove anything. */
  avoidNames?: string[];
};

const SNOWFLAKE = /^\d{5,25}$/u;
const FORGET_JOBS_PATH = ["user", "people", "forget-jobs.json"] as const;
const FORGET_JOBS_LOCK = "people-forget-jobs";

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).then((names) => names.sort(), () => [] as string[]);
}

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);

/** The queued jobs. A torn file still yields every user id in it (as of now, the safe choice). */
async function readJobs(storage: StorageService, now: Date): Promise<ForgetJob[]> {
  let raw: string;
  try {
    raw = await readFile(resolveDataPath(storage.dataRoot, ...FORGET_JOBS_PATH), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { jobs?: unknown };
    if (!Array.isArray(parsed.jobs)) throw new Error("no jobs list");
    return parsed.jobs.flatMap((entry): ForgetJob[] => {
      if (!entry || typeof entry !== "object") return [];
      const job = entry as Record<string, unknown>;
      if (typeof job.userId !== "string" || !SNOWFLAKE.test(job.userId)) return [];
      const at = typeof job.at === "string" && Number.isFinite(Date.parse(job.at)) ? job.at : now.toISOString();
      const names = strings(job.names);
      const avoidNames = strings(job.avoidNames);
      return [{ userId: job.userId, at, ...(names ? { names } : {}), ...(avoidNames ? { avoidNames } : {}) }];
    });
  } catch {
    const ids = new Set([...raw.matchAll(/"userId"\s*:\s*"(\d{5,25})"/gu)].map((match) => match[1]!));
    return [...ids].map((userId) => ({ userId, at: now.toISOString() }));
  }
}

async function updateJobs(storage: StorageService, now: Date, transform: (jobs: ForgetJob[]) => ForgetJob[]): Promise<void> {
  await storage.withLocks([FORGET_JOBS_LOCK], async () => {
    const jobs = transform(await readJobs(storage, now));
    const file = resolveDataPath(storage.dataRoot, ...FORGET_JOBS_PATH);
    if (jobs.length === 0) await rm(file, { force: true });
    else await atomicWriteJson(file, { jobs });
  });
}

/** One job per user: `at` moves forward, the names add up. */
async function queueForgetJob(storage: StorageService, job: ForgetJob, now: Date): Promise<ForgetJob> {
  let stored = job;
  await updateJobs(storage, now, (jobs) => {
    const previous = jobs.find((entry) => entry.userId === job.userId);
    const names = [...new Set([...(previous?.names ?? []), ...(job.names ?? [])])];
    const avoidNames = [...new Set([...(previous?.avoidNames ?? []), ...(job.avoidNames ?? [])])];
    stored = {
      userId: job.userId,
      at: previous && previous.at > job.at ? previous.at : job.at,
      ...(names.length > 0 ? { names } : {}),
      ...(avoidNames.length > 0 ? { avoidNames } : {})
    };
    return [...jobs.filter((entry) => entry.userId !== job.userId), stored];
  });
  return stored;
}

/** The job is done: removed unless a later forget of the same person was queued meanwhile. */
async function finishForgetJob(storage: StorageService, job: ForgetJob, now: Date): Promise<void> {
  await updateJobs(storage, now, (jobs) => jobs.filter((entry) => entry.userId !== job.userId || entry.at > job.at));
}

/** The jobs a crash or a failure left behind (the dashboard shows them in L3). */
export async function pendingForgetJobs(storage: StorageService): Promise<ForgetJob[]> {
  return readJobs(storage, new Date());
}

/** The person leaves every `members.json` and `active-chat-participants/<channel>.json`. */
export async function dropFromServerLists(storage: StorageService, userId: string): Promise<number> {
  let changed = 0;
  for (const guildId of await listDir(storage.dataPath("user", "servers"))) {
    if (!SNOWFLAKE.test(guildId)) continue;
    const membersPath = path.join("user", "servers", guildId, "members.json");
    const members = await storage.readJson(membersPath, GuildMembersFileSchema).catch(() => undefined);
    if (members?.members.some((member) => member.userId === userId)) {
      await storage.updateRevisionedJson({
        resourceKey: `members:${guildId}`,
        relativePath: membersPath,
        schema: GuildMembersFileSchema,
        fallback: members,
        transform: (current) => ({ ...current, members: current.members.filter((member) => member.userId !== userId) })
      });
      changed += 1;
    }
    for (const name of await listDir(storage.dataPath("user", "servers", guildId, "active-chat-participants"))) {
      if (!name.endsWith(".json")) continue;
      const channelId = name.slice(0, -".json".length);
      const relative = path.join("user", "servers", guildId, "active-chat-participants", name);
      const file = await storage.readJson(relative, ActiveChatParticipantsFileSchema).catch(() => undefined);
      if (!file?.participants.some((participant) => participant.userId === userId)) continue;
      await storage.updateRevisionedJson({
        resourceKey: `active-chat-participants:${guildId}:${channelId}`,
        relativePath: relative,
        schema: ActiveChatParticipantsFileSchema,
        fallback: file,
        transform: (current) => ({ ...current, participants: current.participants.filter((participant) => participant.userId !== userId) })
      });
      changed += 1;
    }
  }
  return changed;
}

/** A limits file reset to its forget floor alone (the counters and notices go). */
function floorOnly(current: DmLimitState, floor: string): DmLimitState {
  const { limitNoticeSentAt: _notice, sleepNoticeSentFor: _sleep, ...rest } = current;
  return { ...rest, replyTimestamps: [], autoMessageIds: [], floorMessageId: laterFloor(current.floorMessageId, floor) };
}

/** Waifus whose DM with the user has a floor to keep: a DM directory, a DM state or a limits file. */
async function dmWaifuIds(storage: StorageService, userId: string): Promise<string[]> {
  const hasDir = (await listDmUserIds(storage)).includes(userId);
  return [...new Set([...(await dmWaifuIdsForUser(storage, userId)), ...(hasDir ? await listDmLimitWaifuIds(storage, userId) : [])])].sort();
}

/**
 * Every part of one job, each on its own; the captured traffic is forgotten whatever happens. The
 * floors come first and use the job's time, so a resumed job keeps what the person wrote since.
 * Throws the first failure after the rest ran (the job then stays queued).
 */
async function runForgetJob(storage: StorageService, job: ForgetJob, hooks: DmForgetHooks): Promise<Omit<ForgetUserResult, "discordUserId" | "dryRun">> {
  const { userId } = job;
  const at = new Date(job.at);
  const floor = dmFloorAt(at);
  const logger = hooks.logger;
  const failures: unknown[] = [];
  const part = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      failures.push(error);
      logger?.warn("A part of the owner's forget failed; it runs again at the next start", { part: name, message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };
  const result: Omit<ForgetUserResult, "discordUserId" | "dryRun"> = { dmContexts: 0, dmStates: 0, dmLimits: 0, cachedImages: 0 };
  try {
    // The record first: whatever fails next, the person is still left out.
    await part("record", () => recordForgottenPerson(storage, userId, at, logger ? { logger } : {}));
    // Then every floor, before anything is removed.
    const floors = await part("floors", async () => {
      for (const waifuId of await dmWaifuIds(storage, userId)) await updateDmLimit(storage, userId, waifuId, (current) => ({ ...current, floorMessageId: laterFloor(current.floorMessageId, floor) }));
      return true;
    });
    if (floors) {
      const dm = await part("dms", () => dmForget(storage, { userId, scope: "all" }, { ...hooks, now: () => at }));
      if (dm) Object.assign(result, { dmContexts: dm.deleted.dmContexts, dmStates: dm.deleted.dmStates, cachedImages: dm.deleted.cachedImages });
      // The rest of `user/dms/<userId>/` goes; each limits file keeps only its floor.
      const limits = await part("dm-directory", async () => {
        if (!(await listDmUserIds(storage)).includes(userId)) return 0;
        const dir = storage.dataPath(dmUserDir(userId));
        for (const name of await listDir(dir)) if (name !== "limits") await rm(path.join(dir, name), { recursive: true, force: true });
        const waifuIds = await listDmLimitWaifuIds(storage, userId);
        for (const waifuId of waifuIds) await updateDmLimit(storage, userId, waifuId, (current) => floorOnly(current, floor));
        return waifuIds.length;
      });
      result.dmLimits = limits ?? 0;
    }
    const memberLists = await part("member-lists", () => dropFromServerLists(storage, userId));
    if (memberLists !== undefined) result.memberLists = memberLists;
    const archive = await part("archive", () =>
      scrubArchive(storage.dataRoot, {
        userId,
        ...(job.names ? { names: job.names } : {}),
        ...(job.avoidNames ? { avoidNames: job.avoidNames } : {}),
        ...(logger ? { logger } : {})
      })
    );
    if (archive) result.archive = archive;
    await part("record-copies", () => scrubForgetRecordCopies(storage, { userId, carries: personMatcher(userId, job.names), now: (hooks.now ?? (() => new Date()))() }));
  } finally {
    forgetCapturedTraffic(personMatcher(userId, job.names));
  }
  if (failures.length > 0) throw failures[0];
  return result;
}

export async function forgetUser(
  storage: StorageService,
  input: {
    discordUserId: string;
    dryRun?: boolean;
    /** Names only this person has (collected before the DM data goes): the archive scrub uses them. */
    names?: readonly string[];
    /** Names someone else has: never used to remove anything. */
    avoidNames?: readonly string[];
  },
  hooks: DmForgetHooks = {}
): Promise<ForgetUserResult> {
  const { discordUserId } = input;
  const now = (hooks.now ?? (() => new Date()))();
  if (input.dryRun === true) {
    const dm = await dmForget(storage, { userId: discordUserId, scope: "all", dryRun: true }, hooks);
    const hasDmDir = (await listDmUserIds(storage)).includes(discordUserId);
    return {
      discordUserId,
      dryRun: true,
      dmContexts: dm.deleted.dmContexts,
      dmStates: dm.deleted.dmStates,
      dmLimits: hasDmDir ? (await listDmLimitWaifuIds(storage, discordUserId)).length : 0,
      cachedImages: dm.deleted.cachedImages
    };
  }
  const job = await queueForgetJob(
    storage,
    {
      userId: discordUserId,
      at: now.toISOString(),
      ...(input.names && input.names.length > 0 ? { names: [...input.names] } : {}),
      ...(input.avoidNames && input.avoidNames.length > 0 ? { avoidNames: [...input.avoidNames] } : {})
    },
    now
  );
  const result = await runForgetJob(storage, { ...job, at: now.toISOString() }, hooks);
  await finishForgetJob(storage, { ...job, at: now.toISOString() }, now);
  return { discordUserId, dryRun: false, ...result };
}

/**
 * Boot (before Discord connects): every forget job a crash or a failure left behind runs again,
 * whole. A job that fails again stays queued for the next start.
 */
export async function resumeForgetJobs(storage: StorageService, o: { logger?: Pick<Logger, "warn" | "info">; now?: () => Date } = {}): Promise<number> {
  const now = (o.now ?? (() => new Date()))();
  let resumed = 0;
  for (const job of await readJobs(storage, now)) {
    try {
      await runForgetJob(storage, job, { ...(o.logger ? { logger: o.logger } : {}), ...(o.now ? { now: o.now } : {}) });
      await finishForgetJob(storage, job, now);
      resumed += 1;
      o.logger?.info("A forget left unfinished ran again", { category: "forget" });
    } catch (error) {
      o.logger?.warn("A forget left unfinished failed again; it runs at the next start", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  return resumed;
}
