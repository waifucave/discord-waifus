import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import {
  HELPER_DEBUG_LOG_ENV,
  HELPER_DEBUG_LOG_MAX_BYTES,
  HelperDebugLog,
  helperDebugLogEnabled,
  helperDebugLogPath,
  helperSupportsDebugLog
} from "../src/remote/helperDebugLog.js";
import { HelperSupervisor, type HelperSupervisorOptions } from "../src/remote/helperSupervisor.js";
import type {
  HelperLaunch,
  HelperLaunchRequest,
  HelperProcessExit,
  HelperProcessFactory,
  VerifiedHelperSelection
} from "../src/remote/helperTypes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function root(): Promise<string> {
  const value = await makeTempRoot("waifus-helper-debug-");
  roots.push(value);
  return value;
}

const posixIt = process.platform === "win32" ? it.skip : it;

describe("helper debug log file", () => {
  it("is the documented private path per role and starts with the documented bound", async () => {
    const dataRoot = await root();
    expect(helperDebugLogPath(dataRoot, "host")).toBe(path.join(dataRoot, "app", "logs", "remote-diagnostics", "helper-host.log"));
    expect(helperDebugLogPath(dataRoot, "remote")).toBe(path.join(dataRoot, "app", "logs", "remote-diagnostics", "helper-remote.log"));
    expect(HELPER_DEBUG_LOG_MAX_BYTES).toBe(1024 * 1024);
    expect(HELPER_DEBUG_LOG_ENV).toBe("TS_CONNECT_DEBUG_LOG");
    expect(() => new HelperDebugLog({ dataRoot, role: "host", maxBytes: HELPER_DEBUG_LOG_MAX_BYTES + 1 })).toThrow();
  });

  it("appends helper output in order to an owner-private file", async () => {
    const dataRoot = await root();
    const log = new HelperDebugLog({ dataRoot, role: "remote" });
    log.write(Buffer.from("2026-10-28T12:00:00.000Z magicsock: one\n"));
    log.write("2026-10-28T12:00:00.001Z magicsock: two\n");
    await log.flush();
    expect(await readFile(log.filePath, "utf8")).toBe(
      "2026-10-28T12:00:00.000Z magicsock: one\n2026-10-28T12:00:00.001Z magicsock: two\n"
    );
    if (process.platform !== "win32") {
      expect((await stat(log.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(log.filePath))).mode & 0o777).toBe(0o700);
    }
    // A later writer (next process start) continues the same file.
    await log.close();
    const next = new HelperDebugLog({ dataRoot, role: "remote" });
    next.write("three\n");
    await next.flush();
    expect(await readFile(log.filePath, "utf8")).toMatch(/two\nthree\n$/u);
    await next.close();
  });

  it("keeps at most the cap plus one rotated copy, rotating at line boundaries", async () => {
    const dataRoot = await root();
    const log = new HelperDebugLog({ dataRoot, role: "host", maxBytes: 1024 });
    for (let index = 0; index < 200; index++) log.write(`line ${String(index).padStart(4, "0")} ${"x".repeat(40)}\n`);
    await log.flush();
    const directory = path.dirname(log.filePath);
    expect((await readdir(directory)).sort()).toEqual(["helper-host.log", "helper-host.log.1"]);
    for (const name of ["helper-host.log", "helper-host.log.1"]) {
      const file = path.join(directory, name);
      const content = await readFile(file, "utf8");
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1024);
      expect(content.endsWith("\n")).toBe(true);
      expect(content.split("\n")[0]).toMatch(/^line \d{4} x+$/u);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(log.filePath, "utf8")).toContain("line 0199");
    await log.close();
  });

  it("cuts a single line longer than the cap instead of growing past it", async () => {
    const dataRoot = await root();
    const log = new HelperDebugLog({ dataRoot, role: "host", maxBytes: 1024 });
    log.write("y".repeat(3000));
    await log.flush();
    for (const name of await readdir(path.dirname(log.filePath))) {
      expect((await stat(path.join(path.dirname(log.filePath), name))).size).toBeLessThanOrEqual(1024);
    }
    await log.close();
  });

  posixIt("stops for good after a storage failure and never follows a planted link", async () => {
    const dataRoot = await root();
    const target = path.join(dataRoot, "elsewhere.txt");
    await writeFile(target, "untouched\n", { mode: 0o600 });
    const filePath = helperDebugLogPath(dataRoot, "host");
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await symlink(target, filePath);
    const log = new HelperDebugLog({ dataRoot, role: "host" });
    log.write("secret-free but misplaced\n");
    await log.flush();
    expect(log.failed).toBe(true);
    expect(await readFile(target, "utf8")).toBe("untouched\n");
    log.write("later\n");
    await log.flush();
    expect(await readFile(target, "utf8")).toBe("untouched\n");
  });

  posixIt("refuses to reuse an existing file that is not owner-private", async () => {
    const dataRoot = await root();
    const filePath = helperDebugLogPath(dataRoot, "remote");
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "old\n", { mode: 0o644 });
    const log = new HelperDebugLog({ dataRoot, role: "remote" });
    log.write("new\n");
    await log.flush();
    expect(log.failed).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("old\n");
  });

  it("reads the setting from config.toml and treats an unreadable config as off", async () => {
    const dataRoot = await root();
    expect(await helperDebugLogEnabled(dataRoot)).toBe(false);
    await writeFile(path.join(dataRoot, "config.toml"), "[remoteAccess]\nhelperDebugLog = true\n");
    expect(await helperDebugLogEnabled(dataRoot)).toBe(true);
    await writeFile(path.join(dataRoot, "config.toml"), "[remoteAccess]\nhelperDebugLog = \"yes\"\n");
    expect(await helperDebugLogEnabled(dataRoot)).toBe(false);
    await writeFile(path.join(dataRoot, "config.toml"), "not toml [");
    expect(await helperDebugLogEnabled(dataRoot)).toBe(false);
  });
});

class StaticLaunch implements HelperLaunch {
  readonly authenticated = new Promise<never>(() => {});
  readonly exited = new Promise<HelperProcessExit>(() => {});
  requestDrain(): void {}
  closeParentChannel(): void {}
  forceTerminate(): void {}
}

class RecordingFactory implements HelperProcessFactory {
  readonly requests: HelperLaunchRequest[] = [];
  async launch(request: HelperLaunchRequest): Promise<HelperLaunch> {
    this.requests.push(request);
    return new StaticLaunch();
  }
}

const quietLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function launchOnce(
  dataRoot: string,
  overrides: Partial<HelperSupervisorOptions>,
  helperVersion = "0.1.18"
): Promise<HelperLaunchRequest> {
  const factory = new RecordingFactory();
  const selection: VerifiedHelperSelection = {
    binaryPath: path.join(dataRoot, "package", "bin", "ts-connect"),
    helperVersion,
    releaseSequence: "42" as never,
    forkCommit: "0123456789abcdef0123456789abcdef01234567",
    target: { os: "darwin", arch: "arm64" },
    capabilities: [
      "waifus.browser-context.v1", "waifus.dashboard.manifest.v1", "waifus.http.v1",
      "waifus.principal.v1", "waifus.sse.cursor.v1", "waifus.stream.cancel.v1"
    ],
    ipcProtocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } }
  };
  const supervisor = new HelperSupervisor({
    role: "host",
    dataRoot,
    appVersion: "1.5.203",
    buildId: "dashboard-build",
    runtimePurpose: "normal",
    controlProfile: 1,
    packageResolver: { resolve: async () => selection },
    processFactory: factory,
    logger: quietLogger,
    jitter: () => 0,
    ...overrides
  });
  void supervisor.start().catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (factory.requests.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(factory.requests).toHaveLength(1);
  return factory.requests[0]!;
}

describe("helper debug log wiring", () => {
  it("passes nothing extra and writes nothing when the setting is off", async () => {
    // Even a debug variable in the app's own environment never reaches the helper.
    vi.stubEnv(HELPER_DEBUG_LOG_ENV, "1");
    for (const setting of [undefined, () => false, async () => false, () => { throw new Error("config unreadable"); }]) {
      const dataRoot = await root();
      const request = await launchOnce(dataRoot, setting === undefined ? {} : { helperDebugLog: setting });
      expect(request.environment).not.toHaveProperty(HELPER_DEBUG_LOG_ENV);
      expect(request.stderrSink).toBeUndefined();
      await expect(stat(path.join(dataRoot, "app", "logs", "remote-diagnostics", "helper-host.log"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("never stores stderr from a helper older than the first redacting one", async () => {
    expect(helperSupportsDebugLog("0.1.17")).toBe(false);
    expect(helperSupportsDebugLog("0.1.18")).toBe(true);
    expect(helperSupportsDebugLog("0.2.0")).toBe(true);
    expect(helperSupportsDebugLog("1.0.0")).toBe(true);
    expect(helperSupportsDebugLog("0.1.18-dev")).toBe(false);
    const dataRoot = await root();
    const request = await launchOnce(dataRoot, { helperDebugLog: () => true }, "0.1.17");
    expect(request.environment).not.toHaveProperty(HELPER_DEBUG_LOG_ENV);
    expect(request.stderrSink).toBeUndefined();
    await expect(stat(helperDebugLogPath(dataRoot, "host"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sets only the debug variable and stores stderr when the setting is on", async () => {
    const dataRoot = await root();
    const request = await launchOnce(dataRoot, { helperDebugLog: async () => true });
    expect(request.environment[HELPER_DEBUG_LOG_ENV]).toBe("1");
    expect(Object.keys(request.environment).filter((key) => key !== "DBUS_SESSION_BUS_ADDRESS")).toEqual([HELPER_DEBUG_LOG_ENV]);
    expect(request.stderrSink).toBeInstanceOf(HelperDebugLog);
    const sink = request.stderrSink as HelperDebugLog;
    sink.write(Buffer.from("2026-10-28T12:00:00.000Z magicsock: hello\n"));
    await sink.flush();
    const content = await readFile(helperDebugLogPath(dataRoot, "host"), "utf8");
    expect(content).toMatch(/^\S+ discord-waifus: host helper launch, debug log on\n/u);
    expect(content).toContain("magicsock: hello\n");
  });
});
