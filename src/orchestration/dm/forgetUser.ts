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
// collected before the DM data went) written before anything is removed. Each part runs on its
// own (one failing never skips the others; the DM parts wait for the floors) and is recorded in
// the job when it finishes (`done`) or fails (`failures`, with an error code). The job is cleared
// when every part finished. A crash or a failure leaves it for the next boot (`resumeForgetJobs`,
// before Discord connects), which runs only the unfinished parts. Every part removes only what is
// at or below the job's floor and time, so a resumed part never touches a chat the person started
// after the forget. A part that failed three times is given up: it is no longer retried at boot,
// and `/api/runtime` shows an owner notice naming it (`forgetJobNotices`) until a new forget of
// that person replaces the job.

import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../backend/logger.js";
import { resolveDataPath } from "../../config/paths.js";
import { scrubArchive, type ArchiveScrubResult } from "../../life/archiveScrub.js";
import { forgetPersonInTranscripts } from "../../life/transcripts/forget.js";
import { hostTimeZone } from "../context/timeFormat.js";
import { personMatcher } from "../../life/text.js";
import { forgetCapturedTraffic } from "../../shared/queryLog.js";
import { ActiveChatParticipantsFileSchema, GuildMembersFileSchema } from "../../shared/schemas/domain.js";
import type { DmLimitState } from "../../shared/schemas/dm.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { StorageService } from "../../storage/storageService.js";
import { dmForget, dmWaifuIdsForUser, type DmForgetHooks } from "./dmForget.js";
import { aboveFloor, dmFloorAt, dmStatePath, dmUserDir, laterFloor, listDmLimitWaifuIds, listDmUserIds, readDmState, updateDmLimit } from "./dmStore.js";
import { recordForgottenPerson, scrubForgetRecordCopies } from "./forgotten.js";

// The parts of one owner forget (in the order they run) and the retry cap live with the zod-free
// constants the dashboard and the CLI share.
import { FORGET_JOB_PARTS, FORGET_PART_MAX_FAILURES, type ForgetJobPart } from "../../shared/constants/forget.js";
export { FORGET_JOB_PARTS, FORGET_PART_MAX_FAILURES, type ForgetJobPart };

export type ForgetPartFailure = { count: number; error: string; at: string };

/** A part that has not finished: retried at the next start unless it was given up. */
export type ForgetPending = { part: ForgetJobPart; error?: string; failures: number; retried: boolean };

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
  /** Transcript lines removed (§18.5). */
  transcriptLines?: number;
  /** Parts that did not finish (absent when every part did). */
  pending?: ForgetPending[];
};

/** A forget-user whose DM, archive and member-list part has not finished yet. */
export type ForgetJob = {
  userId: string;
  at: string;
  /** Names only this person has (collected before the DM data went). */
  names?: string[];
  /** Names someone else has: never used to remove anything. */
  avoidNames?: string[];
  /** Parts that finished. */
  done?: ForgetJobPart[];
  /** Parts that failed: how often, the last error code and when. */
  failures?: Partial<Record<ForgetJobPart, ForgetPartFailure>>;
};

const SNOWFLAKE = /^\d{5,25}$/u;
const FORGET_JOBS_PATH = ["user", "people", "forget-jobs.json"] as const;
const FORGET_JOBS_LOCK = "people-forget-jobs";
const isPart = (value: unknown): value is ForgetJobPart => typeof value === "string" && (FORGET_JOB_PARTS as readonly string[]).includes(value);

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).then((names) => names.sort(), () => [] as string[]);
}

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);

function readFailures(value: unknown): ForgetJob["failures"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: NonNullable<ForgetJob["failures"]> = {};
  for (const [part, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isPart(part) || !entry || typeof entry !== "object") continue;
    const failure = entry as Record<string, unknown>;
    const count = typeof failure.count === "number" && Number.isInteger(failure.count) && failure.count > 0 ? failure.count : 1;
    out[part] = { count, error: typeof failure.error === "string" ? failure.error : "unknown", at: typeof failure.at === "string" ? failure.at : "" };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
      const done = strings(job.done)?.filter(isPart);
      const failures = readFailures(job.failures);
      return [
        {
          userId: job.userId,
          at,
          ...(names ? { names } : {}),
          ...(avoidNames ? { avoidNames } : {}),
          ...(done && done.length > 0 ? { done } : {}),
          ...(failures ? { failures } : {})
        }
      ];
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

/** One job per user: a new forget starts over (every part, no failures); the names add up. */
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

/** Records one part's outcome in the job (unless a later forget of the person replaced it). */
function withOutcome(job: ForgetJob, part: ForgetJobPart, outcome: { error?: string }, now: Date): ForgetJob {
  if (outcome.error === undefined) {
    const { [part]: _cleared, ...failures } = job.failures ?? {};
    const { failures: _old, ...rest } = job;
    return { ...rest, done: [...new Set([...(job.done ?? []), part])], ...(Object.keys(failures).length > 0 ? { failures } : {}) };
  }
  const previous = job.failures?.[part];
  return { ...job, failures: { ...job.failures, [part]: { count: (previous?.count ?? 0) + 1, error: outcome.error, at: now.toISOString() } } };
}

async function saveJob(storage: StorageService, job: ForgetJob, now: Date): Promise<void> {
  await updateJobs(storage, now, (jobs) => jobs.map((entry) => (entry.userId === job.userId && entry.at === job.at ? job : entry)));
}

/** The job is done: removed unless a later forget of the same person was queued meanwhile. */
async function finishForgetJob(storage: StorageService, job: ForgetJob, now: Date): Promise<void> {
  await updateJobs(storage, now, (jobs) => jobs.filter((entry) => entry.userId !== job.userId || entry.at !== job.at));
}

/** A part still to run: not finished and not given up. */
const runnable = (job: ForgetJob, part: ForgetJobPart) => !(job.done ?? []).includes(part) && (job.failures?.[part]?.count ?? 0) < FORGET_PART_MAX_FAILURES;

/** The parts of a job that have not finished, with their last error and whether a boot retries them. */
export function pendingParts(job: ForgetJob): ForgetPending[] {
  return FORGET_JOB_PARTS.filter((part) => !(job.done ?? []).includes(part)).map((part) => {
    const failure = job.failures?.[part];
    return { part, ...(failure ? { error: failure.error } : {}), failures: failure?.count ?? 0, retried: (failure?.count ?? 0) < FORGET_PART_MAX_FAILURES };
  });
}

/** The jobs a crash or a failure left behind, with their progress (the dashboard shows them in L3). */
export async function pendingForgetJobs(storage: StorageService): Promise<ForgetJob[]> {
  return readJobs(storage, new Date());
}

/** Owner notices (`/api/runtime` warnings) for the parts given up after three failures. */
export async function forgetJobNotices(storage: StorageService): Promise<string[]> {
  const notices: string[] = [];
  for (const job of await readJobs(storage, new Date())) {
    for (const pending of pendingParts(job)) {
      if (pending.retried) continue;
      notices.push(
        `The owner's forget of user ${job.userId} could not finish its "${pending.part}" part after ${pending.failures} tries (${pending.error ?? "unknown error"}); it is no longer retried at start. Fix the cause, then forget the person again.`
      );
    }
  }
  return notices;
}

/** An error's code for the job file and the notice: never a path or a message. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/u.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]{2,60}$/u.test(error.name) ? error.name : "error";
}

/**
 * The person leaves every `members.json` and `active-chat-participants/<channel>.json`. With `at`
 * (the forget job), only entries seen at or before it go: a later sighting is the person back.
 */
export async function dropFromServerLists(storage: StorageService, userId: string, o: { at?: Date } = {}): Promise<number> {
  const before = (iso: string | undefined) => o.at === undefined || iso === undefined || !(Date.parse(iso) > o.at.getTime());
  let changed = 0;
  for (const guildId of await listDir(storage.dataPath("user", "servers"))) {
    if (!SNOWFLAKE.test(guildId)) continue;
    const membersPath = path.join("user", "servers", guildId, "members.json");
    const members = await storage.readJson(membersPath, GuildMembersFileSchema).catch(() => undefined);
    const dropMember = (member: { userId: string; fetchedAt?: string }) => member.userId === userId && before(member.fetchedAt);
    if (members?.members.some(dropMember)) {
      await storage.updateRevisionedJson({
        resourceKey: `members:${guildId}`,
        relativePath: membersPath,
        schema: GuildMembersFileSchema,
        fallback: members,
        transform: (current) => ({ ...current, members: current.members.filter((member) => !dropMember(member)) })
      });
      changed += 1;
    }
    for (const name of await listDir(storage.dataPath("user", "servers", guildId, "active-chat-participants"))) {
      if (!name.endsWith(".json")) continue;
      const channelId = name.slice(0, -".json".length);
      const relative = path.join("user", "servers", guildId, "active-chat-participants", name);
      const file = await storage.readJson(relative, ActiveChatParticipantsFileSchema).catch(() => undefined);
      const dropParticipant = (participant: { userId: string; lastSeenAt?: string }) => participant.userId === userId && before(participant.lastSeenAt);
      if (!file?.participants.some(dropParticipant)) continue;
      await storage.updateRevisionedJson({
        resourceKey: `active-chat-participants:${guildId}:${channelId}`,
        relativePath: relative,
        schema: ActiveChatParticipantsFileSchema,
        fallback: file,
        transform: (current) => ({ ...current, participants: current.participants.filter((participant) => !dropParticipant(participant)) })
      });
      changed += 1;
    }
  }
  return changed;
}

/**
 * A limits file reset to its forget floor: the counters and notices at or before the forget go,
 * anything newer (a chat started after it) stays.
 */
function floorOnly(current: DmLimitState, floor: string, at: Date): DmLimitState {
  const later = (iso: string | undefined) => iso !== undefined && Date.parse(iso) > at.getTime();
  const { limitNoticeSentAt, ...rest } = current;
  return {
    ...rest,
    replyTimestamps: current.replyTimestamps.filter(later),
    autoMessageIds: current.autoMessageIds.filter((id) => aboveFloor(id, floor)),
    ...(later(limitNoticeSentAt) ? { limitNoticeSentAt } : {}),
    floorMessageId: laterFloor(current.floorMessageId, floor)
  };
}

/** Waifus whose DM with the user has a floor to keep: a DM directory, a DM state or a limits file. */
async function dmWaifuIds(storage: StorageService, userId: string): Promise<string[]> {
  const hasDir = (await listDmUserIds(storage)).includes(userId);
  return [...new Set([...(await dmWaifuIdsForUser(storage, userId)), ...(hasDir ? await listDmLimitWaifuIds(storage, userId) : [])])].sort();
}

/** The rest of `user/dms/<userId>/`: entries at or below the floor go; limits keep their floor. */
async function clearDmDirectory(storage: StorageService, userId: string, floor: string, at: Date): Promise<number> {
  if (!(await listDmUserIds(storage)).includes(userId)) return 0;
  const dir = storage.dataPath(dmUserDir(userId));
  for (const name of await listDir(dir)) {
    if (name === "limits") continue;
    if (name.endsWith(".json")) {
      // A DM state from a chat started after the forget stays.
      const state = await readDmState(storage, userId, name.slice(0, -5)).catch(() => undefined);
      if (state && [state.lastInboundMessageId, state.lastRepliedMessageId].some((id) => id !== undefined && aboveFloor(id, floor))) continue;
      if (state) {
        await rm(storage.dataPath(dmStatePath(userId, state.waifuId)), { force: true });
        continue;
      }
    }
    await rm(path.join(dir, name), { recursive: true, force: true });
  }
  const waifuIds = await listDmLimitWaifuIds(storage, userId);
  for (const waifuId of waifuIds) await updateDmLimit(storage, userId, waifuId, (current) => floorOnly(current, floor, at));
  return waifuIds.length;
}

type JobOutcome = { result: Omit<ForgetUserResult, "discordUserId" | "dryRun" | "pending">; job: ForgetJob };

/**
 * The unfinished parts of one job, each on its own, each recorded in the job as it ends; the
 * captured traffic is forgotten whatever happens. The floors come first and use the job's time;
 * the DM parts run only once the floors are written.
 */
async function runForgetJob(storage: StorageService, initial: ForgetJob, hooks: DmForgetHooks): Promise<JobOutcome> {
  let job = initial;
  const { userId } = job;
  const at = new Date(job.at);
  const floor = dmFloorAt(at);
  const logger = hooks.logger;
  const clock = () => (hooks.now ?? (() => new Date()))();
  const result: JobOutcome["result"] = { dmContexts: 0, dmStates: 0, dmLimits: 0, cachedImages: 0 };
  const record = async (name: ForgetJobPart, outcome: { error?: string }) => {
    job = withOutcome(job, name, outcome, clock());
    await saveJob(storage, job, clock()).catch((error: unknown) => logger?.warn("The forget job could not be updated", { part: name, code: errorCode(error) }));
  };
  const part = async <T>(name: ForgetJobPart, run: () => Promise<T>): Promise<T | undefined> => {
    if (!runnable(job, name)) return undefined;
    let value: T;
    try {
      value = await run();
    } catch (error) {
      const code = errorCode(error);
      await record(name, { error: code });
      logger?.warn("A part of the owner's forget failed; it runs again at the next start", { part: name, code });
      return undefined;
    }
    await record(name, {});
    return value;
  };
  try {
    // The record first: whatever fails next, the person is still left out.
    await part("record", () => recordForgottenPerson(storage, userId, at, logger ? { logger } : {}));
    // Then every floor, before anything is removed.
    await part("floors", async () => {
      for (const waifuId of await dmWaifuIds(storage, userId)) await updateDmLimit(storage, userId, waifuId, (current) => ({ ...current, floorMessageId: laterFloor(current.floorMessageId, floor) }));
      return true;
    });
    if ((job.done ?? []).includes("floors")) {
      const dm = await part("dms", () => dmForget(storage, { userId, scope: "all", onlyAtOrBelow: floor }, { ...hooks, now: () => at }));
      if (dm) Object.assign(result, { dmContexts: dm.deleted.dmContexts, dmStates: dm.deleted.dmStates, cachedImages: dm.deleted.cachedImages });
      result.dmLimits = (await part("dm-directory", () => clearDmDirectory(storage, userId, floor, at))) ?? 0;
    }
    const memberLists = await part("member-lists", () => dropFromServerLists(storage, userId, { at }));
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
    // §18.5: their lines and the lines naming them in every transcript, and their DM transcripts.
    const transcripts = await part("transcripts", () =>
      forgetPersonInTranscripts({ dataRoot: storage.dataRoot, timeZone: hostTimeZone() }, { userId, ...(job.names ? { names: job.names } : {}), at, floor })
    );
    if (transcripts) result.transcriptLines = transcripts.removedLines;
    await part("record-copies", () => scrubForgetRecordCopies(storage, { userId, carries: personMatcher(userId, job.names) }));
  } finally {
    forgetCapturedTraffic(personMatcher(userId, job.names));
  }
  if (pendingParts(job).length === 0) await finishForgetJob(storage, job, clock()).catch(() => undefined);
  return { result, job };
}

/**
 * The result when the job could not even be queued (its file is unwritable): nothing of step 1
 * ran and nothing retries it; every part is reported pending, not retried.
 */
export function unqueuedForgetResult(discordUserId: string, error: unknown): ForgetUserResult {
  const code = errorCode(error);
  return {
    discordUserId,
    dryRun: false,
    dmContexts: 0,
    dmStates: 0,
    dmLimits: 0,
    cachedImages: 0,
    pending: FORGET_JOB_PARTS.map((part) => ({ part, error: code, failures: 1, retried: false }))
  };
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
  const outcome = await runForgetJob(storage, job, hooks);
  const pending = pendingParts(outcome.job);
  return { discordUserId, dryRun: false, ...outcome.result, ...(pending.length > 0 ? { pending } : {}) };
}

/**
 * Boot (before Discord connects): the unfinished parts of every forget job a crash or a failure
 * left behind run again; finished and given-up parts do not. Returns how many jobs finished.
 */
export async function resumeForgetJobs(storage: StorageService, o: { logger?: Pick<Logger, "warn" | "info">; now?: () => Date } = {}): Promise<number> {
  const now = (o.now ?? (() => new Date()))();
  let finished = 0;
  for (const job of await readJobs(storage, now)) {
    if (!FORGET_JOB_PARTS.some((part) => runnable(job, part))) continue;
    try {
      const outcome = await runForgetJob(storage, job, { ...(o.logger ? { logger: o.logger } : {}), ...(o.now ? { now: o.now } : {}) });
      const pending = pendingParts(outcome.job);
      if (pending.length === 0) {
        finished += 1;
        o.logger?.info("A forget left unfinished ran again", { category: "forget" });
      } else {
        o.logger?.warn("A forget left unfinished still has parts pending", { category: "forget", parts: pending.map((entry) => entry.part) });
      }
    } catch (error) {
      o.logger?.warn("A forget left unfinished could not run", { code: errorCode(error) });
    }
  }
  return finished;
}
