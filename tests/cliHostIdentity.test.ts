import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { connectHost } from "../src/cli/hostClient.js";
import { runCommand, type CliRuntimeOptions } from "../src/cli/commands.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { appDataPath } from "../src/config/paths.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { HOST_INSTANCE_LOCK_FILE } from "../src/storage/instanceLock.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const HOLDER = 4242;
const STARTED_AT = Date.parse("2026-10-20T10:00:00.000Z");

let roots: string[] = [];
let lines: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function setup(options: { lockStartTime?: number | null; withLock?: boolean } = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const runtime = createRuntimeState({
    pid: HOLDER,
    startedAt: new Date(STARTED_AT).toISOString(),
    packageVersion: "0.1.0",
    port: 4777,
    dataRoot: root,
    mode: "start",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  await writeFile(appDataPath(root, "pid.json"), JSON.stringify(runtime));
  await writeFile(appDataPath(root, "runtime.json"), JSON.stringify(runtime));
  if (options.withLock !== false) {
    await mkdir(path.dirname(appDataPath(root, HOST_INSTANCE_LOCK_FILE)), { recursive: true });
    await writeFile(appDataPath(root, HOST_INSTANCE_LOCK_FILE), JSON.stringify({
      version: 1,
      role: "host",
      pid: HOLDER,
      processStartTime: options.lockStartTime === undefined ? STARTED_AT - 500 : options.lockStartTime,
      nonce: "a".repeat(32),
      acquiredAt: new Date(STARTED_AT).toISOString()
    }));
  }
  return root;
}

function cliOptions(currentStartTime: number | null, extra: Partial<CliRuntimeOptions> = {}): CliRuntimeOptions {
  return {
    processAlive: (pid) => pid === HOLDER,
    processStartTime: async (pid) => (pid === HOLDER ? currentStartTime : null),
    killProcess: vi.fn(),
    waitForProcessExit: async () => true,
    ...extra
  };
}

describe("B21b: CLI verifies host identity before reporting or signalling", () => {
  it("stop never signals a reused pid whose start time does not match the lock", async () => {
    const root = await setup();
    const options = cliOptions(STARTED_AT + 3_600_000);
    expect(await runCommand(parseCliArgs(["stop", "--data-root", root]), options)).toBe(0);
    expect(options.killProcess).not.toHaveBeenCalled();
    expect(existsSync(appDataPath(root, "pid.json"))).toBe(false);
    expect(existsSync(appDataPath(root, HOST_INSTANCE_LOCK_FILE))).toBe(false);
    expect(lines.join("\n")).toContain(`stale pid ${HOLDER}`);
  });

  it("stop signals the host when the lock identity matches", async () => {
    const root = await setup();
    const options = cliOptions(STARTED_AT - 500);
    expect(await runCommand(parseCliArgs(["stop", "--data-root", root]), options)).toBe(0);
    expect(options.killProcess).toHaveBeenCalledWith(HOLDER, "SIGTERM");
  });

  it("stop still signals the host when its observed start time drifted by ~1s", async () => {
    const root = await setup();
    const options = cliOptions(STARTED_AT - 500 + 1_000);
    expect(await runCommand(parseCliArgs(["stop", "--data-root", root]), options)).toBe(0);
    expect(options.killProcess).toHaveBeenCalledWith(HOLDER, "SIGTERM");
  });

  it("without a lock, a process that started after the recorded backend start is stale", async () => {
    const root = await setup({ withLock: false });
    const reused = cliOptions(STARTED_AT + 60_000);
    expect(await runCommand(parseCliArgs(["stop", "--data-root", root]), reused)).toBe(0);
    expect(reused.killProcess).not.toHaveBeenCalled();

    const legacy = await setup({ withLock: false });
    const genuine = cliOptions(STARTED_AT - 1_000);
    expect(await runCommand(parseCliArgs(["stop", "--data-root", legacy]), genuine)).toBe(0);
    expect(genuine.killProcess).toHaveBeenCalledWith(HOLDER, "SIGTERM");
  });

  it("status does not report a stale pid as running", async () => {
    const root = await setup();
    await runCommand(parseCliArgs(["status", "--data-root", root]), cliOptions(STARTED_AT + 3_600_000));
    expect(JSON.parse(lines.join("\n")).host.running).toBe(false);
    lines.length = 0;
    await runCommand(parseCliArgs(["status", "--data-root", root]), cliOptions(STARTED_AT - 500));
    expect(JSON.parse(lines.join("\n")).host.running).toBe(true);
  });

  it("detached start replaces stale state instead of claiming the host is running", async () => {
    const root = await setup();
    const detachedSpawner = vi.fn(() => ({ pid: 5555, unref: vi.fn() }));
    const code = await runCommand(parseCliArgs(["start", "--data-root", root]), cliOptions(STARTED_AT + 3_600_000, {
      argv: ["/usr/local/bin/node", "/usr/local/bin/waifus"],
      detachedSpawner,
      detachedBackendWaiter: async () => undefined,
      processAlive: (pid) => pid === HOLDER || pid === 5555
    }));
    expect(code).toBe(0);
    expect(detachedSpawner).toHaveBeenCalledOnce();
    expect(existsSync(appDataPath(root, HOST_INSTANCE_LOCK_FILE))).toBe(false);
  });

  it("detached start reports a verified live host without spawning", async () => {
    const root = await setup();
    const detachedSpawner = vi.fn();
    const code = await runCommand(parseCliArgs(["start", "--data-root", root]), cliOptions(STARTED_AT - 500, {
      detachedSpawner: detachedSpawner as never
    }));
    expect(code).toBe(0);
    expect(detachedSpawner).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("already running at http://127.0.0.1:4777");
  });

  it("a detached start that lost the lock race reports the winning host", async () => {
    const root = await setup({ withLock: false });
    await import("node:fs/promises").then(({ rm }) => rm(appDataPath(root, "pid.json")));
    const lockFile = appDataPath(root, HOST_INSTANCE_LOCK_FILE);
    const detachedSpawner = vi.fn(() => {
      // Another `waifus start` won the race while this child was spawning; this child exits.
      // Written synchronously: the lock must be complete on disk before the CLI looks at it. An
      // unawaited async write could still be pending (file missing) or half-written (truncated,
      // read back as "starting") when the waiter returned under load.
      writeFileSync(lockFile, JSON.stringify({
        version: 1, role: "host", pid: HOLDER, processStartTime: STARTED_AT - 500,
        nonce: "b".repeat(32), acquiredAt: new Date(STARTED_AT).toISOString()
      }));
      return { pid: 5555, unref: vi.fn() };
    });
    const code = await runCommand(parseCliArgs(["start", "--data-root", root]), cliOptions(STARTED_AT - 500, {
      argv: ["/usr/local/bin/node", "/usr/local/bin/waifus"],
      detachedSpawner,
      detachedBackendWaiter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      }
    }));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(`already running (pid ${HOLDER})`);
  });
});

describe("connectHost", () => {
  it("reaches a host bound to IPv6 loopback only (::1) after 127.0.0.1 refuses (review)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url === "/api/runtime" ? { pid: process.pid, dataRoot: root } : {}));
    });
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, "::1", () => resolve(true));
    });
    if (!listening) return; // No IPv6 loopback on this machine: nothing to check.
    try {
      const port = (server.address() as AddressInfo).port;
      await writeFile(appDataPath(root, "pid.json"), JSON.stringify({ ...createRuntimeState({ pid: process.pid, startedAt: new Date().toISOString(), packageVersion: "0.1.0", port, dataRoot: root, mode: "start", paused: false, discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] }, queues: { active: 0, configuredGuilds: 0 } }) }));
      const transport = await connectHost(root, { probe: { isAlive: () => true, startTime: async () => null } });
      expect(transport).toBeDefined();
      const runtime = await transport!({ method: "GET", path: "/api/runtime" });
      expect(runtime.body).toMatchObject({ pid: process.pid });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
