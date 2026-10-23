import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { appDataPath } from "../config/paths.js";

const execFileAsync = promisify(execFile);

// B21: one ordinary host per data root. ResourceLockManager only serializes writers inside a
// single process, so `waifus dev` or `start --foreground` next to the daemon used to run two
// Discord runtimes on the same bot tokens (duplicate replies, lost writes). The remote gateway
// (`waifus remote`) is a different role with its own runtime files and keeps coexisting.
export const HOST_INSTANCE_LOCK_FILE = "host.lock";

const InstanceLockRecordSchema = z.object({
  version: z.literal(1),
  role: z.literal("host"),
  pid: z.number().int().positive(),
  // Epoch ms the OS reports for the holder's process start; null where it is unavailable
  // (Windows), in which case liveness falls back to the pid alone.
  processStartTime: z.number().nullable(),
  nonce: z.string().min(1),
  acquiredAt: z.string()
});
export type InstanceLockRecord = z.infer<typeof InstanceLockRecordSchema>;

export type ProcessIdentityProbe = {
  isAlive: (pid: number) => boolean;
  startTime: (pid: number) => Promise<number | null>;
};

const defaultProcessIdentityProbe: ProcessIdentityProbe = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  startTime: (pid) => processStartTime(pid)
};

/**
 * The OS start time of `pid` (epoch ms), or null when the process is gone or the platform has
 * no cheap source. Comparing it with a recorded value distinguishes a live holder from an
 * unrelated process that inherited a crashed holder's pid.
 */
export async function processStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<number | null> {
  if (platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 5_000,
      windowsHide: true
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// `ps -o lstart` is second-resolution and the reported start can shift by about a second (NTP
// step, VM suspend/resume, procps deriving it from boot time). An exact comparison would judge a
// live holder stale and let a second host break its lock, so allow this much drift. A reused pid
// belongs to a process started after the holder crashed, typically far outside this window.
export const PROCESS_START_TIME_SLACK_MS = 2_000;

function startTimesMatch(observed: number, recorded: number): boolean {
  return Math.abs(observed - recorded) <= PROCESS_START_TIME_SLACK_MS;
}

export class InstanceLockHeldError extends Error {
  constructor(
    readonly dataRoot: string,
    readonly holderPid: number | undefined,
    readonly holderPort: number | undefined
  ) {
    const holder = holderPid === undefined
      ? "another process is starting"
      : `pid ${holderPid}${holderPort ? `, http://127.0.0.1:${holderPort}` : ""}`;
    super(
      `Another waifus host is already running for data root ${dataRoot} (${holder}). ` +
      "Stop it with `waifus stop` or use a different --data-root."
    );
    this.name = "InstanceLockHeldError";
  }
}

export type HostInstanceLock = {
  readonly record: InstanceLockRecord;
  release: () => Promise<void>;
};

type LockRead =
  | { kind: "missing" }
  | { kind: "unreadable"; ageMs: number }
  | { kind: "record"; record: InstanceLockRecord };

export type HostInstanceState =
  | { state: "absent" }
  | { state: "stale"; record?: InstanceLockRecord }
  // The lock was just created and its record is not written yet.
  | { state: "starting" }
  | { state: "running"; pid: number; record?: InstanceLockRecord; verified: boolean };

// A holder writes its record right after the exclusive create; an unreadable file younger than
// this is a holder mid-write, older is a crash between create and write.
const DEFAULT_UNREADABLE_GRACE_MS = 10_000;

export async function acquireHostInstanceLock(
  dataRoot: string,
  options: { probe?: ProcessIdentityProbe; unreadableGraceMs?: number } = {}
): Promise<HostInstanceLock> {
  const probe = options.probe ?? defaultProcessIdentityProbe;
  const graceMs = options.unreadableGraceMs ?? DEFAULT_UNREADABLE_GRACE_MS;
  const lockPath = hostLockPath(dataRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const record: InstanceLockRecord = {
    version: 1,
    role: "host",
    pid: process.pid,
    processStartTime: await probe.startTime(process.pid),
    nonce: randomBytes(16).toString("hex"),
    acquiredAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // Exclusive create is the atomic step: exactly one process wins a missing lock.
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { record, release: () => releaseHostInstanceLock(lockPath, record.nonce) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readLock(lockPath);
    if (existing.kind === "missing") continue;
    if (existing.kind === "unreadable") {
      if (existing.ageMs < graceMs) throw new InstanceLockHeldError(dataRoot, undefined, undefined);
      await breakStaleLock(lockPath, null);
      continue;
    }
    const liveness = await holderLiveness(existing.record, probe);
    if (liveness !== "stale") {
      throw new InstanceLockHeldError(
        dataRoot,
        existing.record.pid,
        await holderPort(dataRoot, existing.record.pid)
      );
    }
    await breakStaleLock(lockPath, existing.record.nonce);
  }
  throw new InstanceLockHeldError(dataRoot, undefined, undefined);
}

/**
 * B21b: whether a host is running for this data root, judged from the lock (pid plus OS start
 * time) rather than a bare `kill(pid, 0)` on pid.json — after a crash that pid may belong to an
 * unrelated process. Without a lock (a host from before this change) it reports "absent" and
 * callers fall back to their own pid.json checks.
 */
export async function hostInstanceState(
  dataRoot: string,
  probe: ProcessIdentityProbe = defaultProcessIdentityProbe
): Promise<HostInstanceState> {
  const existing = await readLock(hostLockPath(dataRoot));
  if (existing.kind === "missing") return { state: "absent" };
  if (existing.kind === "unreadable") {
    return existing.ageMs < DEFAULT_UNREADABLE_GRACE_MS
      ? { state: "starting" }
      : { state: "stale" };
  }
  const liveness = await holderLiveness(existing.record, probe);
  if (liveness === "stale") return { state: "stale", record: existing.record };
  return { state: "running", pid: existing.record.pid, record: existing.record, verified: liveness === "verified" };
}

/** Removes a lock only after confirming its holder is gone; never touches a live holder's lock. */
export async function clearStaleHostInstanceLock(
  dataRoot: string,
  probe: ProcessIdentityProbe = defaultProcessIdentityProbe
): Promise<boolean> {
  const state = await hostInstanceState(dataRoot, probe);
  if (state.state !== "stale") return false;
  await breakStaleLock(hostLockPath(dataRoot), state.record?.nonce ?? null);
  return true;
}

function hostLockPath(dataRoot: string): string {
  return appDataPath(dataRoot, HOST_INSTANCE_LOCK_FILE);
}

async function holderLiveness(
  record: InstanceLockRecord,
  probe: ProcessIdentityProbe
): Promise<"verified" | "unverified" | "stale"> {
  if (!probe.isAlive(record.pid)) return "stale";
  if (record.processStartTime === null) return "unverified";
  const current = await probe.startTime(record.pid);
  // An alive pid whose start time cannot be read is treated as the holder: refusing a second
  // instance is the safe direction.
  if (current === null) return "unverified";
  return startTimesMatch(current, record.processStartTime) ? "verified" : "stale";
}

async function readLock(lockPath: string): Promise<LockRead> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    return { kind: "record", record: InstanceLockRecordSchema.parse(JSON.parse(raw)) };
  } catch {
    try {
      return { kind: "unreadable", ageMs: Date.now() - (await stat(lockPath)).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
  }
}

// Move the stale lock aside before deleting it, then check what was actually moved: if another
// starter replaced the stale lock in the meantime, its fresh lock is linked back (never over a
// newer one) instead of being deleted out from under it.
async function breakStaleLock(lockPath: string, staleNonce: string | null): Promise<void> {
  const aside = `${lockPath}.${randomBytes(6).toString("hex")}.stale`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await readLock(aside);
  const movedNonce = moved.kind === "record" ? moved.record.nonce : null;
  if (movedNonce !== staleNonce) {
    await link(aside, lockPath).catch(() => undefined);
  }
  await rm(aside, { force: true });
}

async function releaseHostInstanceLock(lockPath: string, nonce: string): Promise<void> {
  const current = await readLock(lockPath);
  if (current.kind === "record" && current.record.nonce === nonce) {
    await rm(lockPath, { force: true });
  }
}

async function holderPort(dataRoot: string, pid: number): Promise<number | undefined> {
  try {
    const state = JSON.parse(await readFile(appDataPath(dataRoot, "pid.json"), "utf8")) as {
      pid?: unknown;
      port?: unknown;
    };
    return state.pid === pid && typeof state.port === "number" ? state.port : undefined;
  } catch {
    return undefined;
  }
}
