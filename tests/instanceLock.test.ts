import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { startBackend, type RunningBackend } from "../src/backend/server.js";
import type { Logger } from "../src/backend/logger.js";
import { appDataPath } from "../src/config/paths.js";
import { ensureDataLayout } from "../src/config/layout.js";
import {
  HOST_INSTANCE_LOCK_FILE,
  InstanceLockHeldError,
  acquireHostInstanceLock,
  hostInstanceState,
  processStartTime,
  type ProcessIdentityProbe
} from "../src/storage/instanceLock.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];
let backends: RunningBackend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function root(): Promise<string> {
  const dir = await makeTempRoot();
  roots.push(dir);
  await ensureDataLayout(dir);
  return dir;
}

function lockPath(dataRoot: string): string {
  return appDataPath(dataRoot, HOST_INSTANCE_LOCK_FILE);
}

async function writeLock(dataRoot: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(lockPath(dataRoot)), { recursive: true });
  await writeFile(lockPath(dataRoot), JSON.stringify({
    version: 1,
    role: "host",
    nonce: "f".repeat(32),
    acquiredAt: new Date().toISOString(),
    ...record
  }));
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

const fixedProbe = (startTimes: Record<number, number | null>, alive: number[]): ProcessIdentityProbe => ({
  isAlive: (pid) => alive.includes(pid),
  startTime: async (pid) => startTimes[pid] ?? null
});

describe("B21: exclusive host instance lock", () => {
  it("acquires once, refuses a live second holder with its pid, and releases only its own lock", async () => {
    const dataRoot = await root();
    const lock = await acquireHostInstanceLock(dataRoot);
    const record = JSON.parse(await readFile(lockPath(dataRoot), "utf8"));
    expect(record).toMatchObject({ version: 1, role: "host", pid: process.pid, nonce: lock.record.nonce });

    const second = acquireHostInstanceLock(dataRoot);
    await expect(second).rejects.toBeInstanceOf(InstanceLockHeldError);
    await expect(second).rejects.toThrow(new RegExp(`pid ${process.pid}`));

    await lock.release();
    expect(existsSync(lockPath(dataRoot))).toBe(false);
    const again = await acquireHostInstanceLock(dataRoot);
    // A stale handle must never remove someone else's lock.
    await lock.release();
    expect(existsSync(lockPath(dataRoot))).toBe(true);
    await again.release();
  });

  it("reports the holder's port from pid.json when it is known", async () => {
    const dataRoot = await root();
    const lock = await acquireHostInstanceLock(dataRoot);
    await writeFile(appDataPath(dataRoot, "pid.json"), JSON.stringify({ pid: process.pid, port: 4999 }));
    await expect(acquireHostInstanceLock(dataRoot)).rejects.toThrow(/127\.0\.0\.1:4999/);
    await lock.release();
  });

  it("replaces a lock whose pid is no longer alive", async () => {
    const dataRoot = await root();
    await writeLock(dataRoot, { pid: await exitedPid(), processStartTime: null });
    const lock = await acquireHostInstanceLock(dataRoot);
    expect(lock.record.pid).toBe(process.pid);
    await lock.release();
  });

  it("replaces a lock whose pid was reused by a different process (start-time mismatch)", async () => {
    const dataRoot = await root();
    await writeLock(dataRoot, { pid: 4242, processStartTime: 1_000 });
    const probe = fixedProbe({ 4242: 60_000, [process.pid]: 5_000 }, [4242, process.pid]);
    expect(await hostInstanceState(dataRoot, probe)).toMatchObject({ state: "stale" });
    const lock = await acquireHostInstanceLock(dataRoot, { probe });
    expect(lock.record).toMatchObject({ pid: process.pid, processStartTime: 5_000 });
    await lock.release();

    await writeLock(dataRoot, { pid: 4242, processStartTime: 60_000 });
    expect(await hostInstanceState(dataRoot, probe)).toMatchObject({ state: "running", pid: 4242 });
    await expect(acquireHostInstanceLock(dataRoot, { probe })).rejects.toBeInstanceOf(InstanceLockHeldError);
  });

  it("tolerates a ~1s start-time skew from ps second resolution, NTP steps or VM resume", async () => {
    const dataRoot = await root();
    await writeLock(dataRoot, { pid: 4242, processStartTime: 10_000 });
    for (const observed of [9_000, 11_000, 12_000]) {
      const probe = fixedProbe({ 4242: observed, [process.pid]: 50_000 }, [4242, process.pid]);
      expect(await hostInstanceState(dataRoot, probe), String(observed)).toMatchObject({ state: "running", pid: 4242 });
      await expect(acquireHostInstanceLock(dataRoot, { probe })).rejects.toBeInstanceOf(InstanceLockHeldError);
    }
    const reused = fixedProbe({ 4242: 13_000 }, [4242]);
    expect(await hostInstanceState(dataRoot, reused)).toMatchObject({ state: "stale" });
  });

  it("treats an old unreadable lock as stale but a fresh one as held", async () => {
    const dataRoot = await root();
    await mkdir(path.dirname(lockPath(dataRoot)), { recursive: true });
    await writeFile(lockPath(dataRoot), "");
    await expect(acquireHostInstanceLock(dataRoot, { unreadableGraceMs: 60_000 }))
      .rejects.toBeInstanceOf(InstanceLockHeldError);
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath(dataRoot), old, old);
    const lock = await acquireHostInstanceLock(dataRoot, { unreadableGraceMs: 60_000 });
    await lock.release();
  });

  it("reads this process's start time on supported platforms", async () => {
    const started = await processStartTime(process.pid);
    if (process.platform === "win32") {
      expect(started).toBeNull();
    } else {
      expect(started).toBeTypeOf("number");
      expect(started!).toBeLessThanOrEqual(Date.now());
      expect(await processStartTime(process.pid)).toBe(started);
      expect(await processStartTime(await exitedPid())).toBeNull();
    }
  });
});

describe("B21: startBackend holds the host lock for its lifetime", () => {
  it("refuses a second backend on the same data root and frees the root on close", async () => {
    const dataRoot = await root();
    const first = await startBackend(testBackendOptions(dataRoot, await freePort()));
    backends.push(first);
    await expect(startBackend(testBackendOptions(dataRoot, await freePort())))
      .rejects.toThrow(/already running/);
    // The refused start must not disturb the live instance's lock or pid file.
    expect(JSON.parse(await readFile(lockPath(dataRoot), "utf8")).pid).toBe(process.pid);
    expect((await fetch(`${first.url}/api/health`)).status).toBe(200);

    await first.close();
    backends = backends.filter((backend) => backend !== first);
    expect(existsSync(lockPath(dataRoot))).toBe(false);
    const second = await startBackend(testBackendOptions(dataRoot, await freePort()));
    backends.push(second);
    expect((await fetch(`${second.url}/api/health`)).status).toBe(200);
  });

  it("releases the lock when startup fails", async () => {
    const dataRoot = await root();
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port));
    });
    try {
      await expect(startBackend(testBackendOptions(dataRoot, port))).rejects.toThrow();
      expect(existsSync(lockPath(dataRoot))).toBe(false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

function testBackendOptions(dataRoot: string, port: number) {
  return {
    dataRoot,
    host: "127.0.0.1",
    port,
    mode: "test" as const,
    logger: quietLogger(),
    remoteAccess: {
      supervisor: undefined,
      dashboard: { path: path.resolve("dist-frontend"), source: "bundled" as const, buildId: "a".repeat(64) }
    }
  };
}

function quietLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
