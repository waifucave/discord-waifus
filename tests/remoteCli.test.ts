import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeState } from "../src/backend/runtime.js";
import { runCommand } from "../src/cli/commands.js";
import { openBrowser } from "../src/cli/openBrowser.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import { remoteRolePaths, remoteStatePaths } from "../src/remote/paths.js";
import { createRemoteDaemonState } from "../src/shared/schemas/remoteRuntime.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const hostId = Buffer.alloc(32, 0x51).toString("base64url");
const shellOrigin = `http://waifus-${"a".repeat(52)}.localhost:43123`;
const bootstrapUrl = `${shellOrigin}/_waifus_remote/bootstrap/${Buffer.alloc(32, 0x61).toString("base64url")}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function state(pid = 4242, dataRoot = "/tmp/waifus-remote") {
  return createRemoteDaemonState({
    pid,
    startedAt: "2026-09-13T06:00:00.000Z",
    packageVersion: "1.5.203",
    port: 43123,
    dataRoot,
    mode: "remote",
    connectionShellOrigin: shellOrigin,
    helperVersion: "0.1.0",
    helperReleaseSequence: "42",
    protocol: { major: 1, minor: 0 },
    capabilities: ["waifus.http.v1"],
    helperState: "ready",
    activationState: "active",
    controlState: "connected",
    directState: "direct",
    rememberedHostCount: 1,
    selectionState: "automatic_single",
    selectedHostId: hostId,
    lastDirectAt: "1786270900",
    lastErrorCode: null
  });
}

function hostState(pid: number, dataRoot: string) {
  return createRuntimeState({
    pid,
    startedAt: "2026-09-13T06:00:00.000Z",
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot,
    mode: "start",
    paused: false,
    discord: {
      connected: true,
      orchestratorConnected: true,
      waifuBotCount: 2,
      warnings: []
    },
    queues: {
      active: 0,
      configuredGuilds: 1
    }
  });
}

function silence(): void {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("waifus remote parser", () => {
  it("parses start, status, stop, and remote flags without treating actions as host selectors", () => {
    expect(parseCliArgs(["remote"])).toMatchObject({ command: "remote", remoteAction: "start" });
    expect(parseCliArgs(["remote", "status", "--data-root", "/tmp/r"])).toMatchObject({
      command: "remote",
      remoteAction: "status",
      positional: [],
      flags: { dataRoot: "/tmp/r" }
    });
    expect(parseCliArgs(["remote", "stop"])).toMatchObject({
      command: "remote",
      remoteAction: "stop",
      positional: []
    });
    expect(parseCliArgs([
      "remote",
      "--foreground",
      "--no-open",
      "--host",
      "Studio Host",
      "--port",
      "43123"
    ])).toMatchObject({
      remoteAction: "start",
      flags: {
        foreground: true,
        noOpen: true,
        host: "Studio Host",
        port: "43123"
      }
    });
  });

  it("rejects unknown subcommands and pairing tokens before any preflight", async () => {
    const root = await makeTempRoot("waifus-remote-cli-token-");
    roots.push(root);
    silence();
    const preflight = vi.fn();
    const detachedSpawner = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const options = {
      argv: ["node", "waifus"],
      processAlive: () => false,
      remotePreflight: preflight,
      detachedSpawner
    };
    await expect(runCommand(parseCliArgs(["remote", "wat", "--data-root", root]), options))
      .resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unknown remote action"));

    const fullToken = `WF1.${Buffer.alloc(32, 0x72).toString("base64url")}`;
    await expect(runCommand(parseCliArgs(["remote", fullToken, "--data-root", root]), options))
      .resolves.toBe(1);
    await expect(runCommand(parseCliArgs([
      "remote",
      "--host",
      `https://pair.waifucave.com/?token=${fullToken}`,
      "--data-root",
      root
    ]), options)).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("paste pairing tokens"));
    expect(preflight).not.toHaveBeenCalled();
    expect(detachedSpawner).not.toHaveBeenCalled();
  });

  it("lists all remote command forms in help", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      if (typeof message === "string") logs.push(message);
    });

    expect(await runCommand(parseCliArgs(["help"]))).toBe(0);

    const help = logs.join("\n");
    expect(help).toContain("waifus remote [--foreground] [--no-open]");
    expect(help).toContain("waifus remote status [--data-root PATH]");
    expect(help).toContain("waifus remote stop [--data-root PATH]");
  });
});

describe("waifus remote lifecycle", () => {
  it("preflights, starts detached, waits for a healthy tokenized URL, then opens the browser", async () => {
    const root = await makeTempRoot("waifus-remote-cli-detached-");
    roots.push(root);
    silence();
    const order: string[] = [];
    const spawned = { pid: 4242, unref: vi.fn() };
    const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const code = await runCommand(parseCliArgs([
      "remote",
      "--host",
      "Studio Host",
      "--port",
      "43123",
      "--data-root",
      root
    ]), {
      argv: ["/usr/local/bin/node", "/usr/local/bin/waifus"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
      execPath: "/usr/local/bin/node",
      processAlive: () => false,
      remotePreflight: async () => { order.push("preflight"); },
      detachedSpawner: (command, args, options) => {
        order.push("spawn");
        spawnCalls.push({ command, args, options });
        return spawned;
      },
      remoteStartWaiter: async (_dataRoot, pid) => {
        order.push("healthy");
        return { runtime: state(pid), bootstrapUrl };
      },
      browserOpener: async (url) => {
        order.push("browser");
        expect(url).toBe(bootstrapUrl);
      }
    });

    expect(code).toBe(0);
    expect(order).toEqual(["preflight", "spawn", "healthy", "browser"]);
    expect(spawned.unref).toHaveBeenCalledTimes(1);
    expect(spawnCalls[0]).toMatchObject({
      command: "/usr/local/bin/node",
      args: [
        "/usr/local/bin/waifus",
        "remote",
        "--foreground",
        "--no-open",
        "--data-root",
        root,
        "--host",
        "Studio Host",
        "--port",
        "43123"
      ]
    });
    expect(JSON.stringify(spawnCalls)).not.toContain("WF1.");
  });

  it("consumes the detached child's owner-only bootstrap handoff before opening the browser", async () => {
    const root = await makeTempRoot("waifus-remote-cli-real-waiter-");
    roots.push(root);
    silence();
    const paths = remoteRolePaths(root, "remote");
    let handoffWrite: Promise<void> | undefined;
    const browserOpener = vi.fn(async (url: string) => {
      expect(url).toBe(bootstrapUrl);
    });

    const code = await runCommand(parseCliArgs([
      "remote",
      "--data-root",
      root
    ]), {
      argv: ["node", "waifus"],
      processAlive: (pid) => pid === process.pid,
      remotePreflight: async () => undefined,
      detachedSpawner: () => {
        const runtime = state(process.pid, root);
        handoffWrite = (async () => {
          await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
          await writeFile(paths.runtimePid, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
          await writeFile(paths.runtimeState, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
          await writeFile(paths.startupHandoff, `${JSON.stringify({ runtime, bootstrapUrl })}\n`, {
            mode: 0o600
          });
        })();
        return { pid: process.pid, unref: vi.fn() };
      },
      browserOpener
    });
    await handoffWrite;

    expect(code).toBe(0);
    expect(browserOpener).toHaveBeenCalledTimes(1);
    await expect(access(paths.startupHandoff)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and erases a startup handoff whose permissions could expose its token", async () => {
    const root = await makeTempRoot("waifus-remote-cli-handoff-mode-");
    roots.push(root);
    silence();
    const paths = remoteRolePaths(root, "remote");
    let handoffWrite: Promise<void> | undefined;
    const browserOpener = vi.fn();

    const code = await runCommand(parseCliArgs(["remote", "--data-root", root]), {
      argv: ["node", "waifus"],
      processAlive: (pid) => pid === process.pid,
      remotePreflight: async () => undefined,
      detachedSpawner: () => {
        const runtime = state(process.pid, root);
        handoffWrite = (async () => {
          await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
          await writeFile(paths.startupHandoff, `${JSON.stringify({ runtime, bootstrapUrl })}\n`, {
            mode: 0o600
          });
          await chmod(paths.startupHandoff, 0o644);
        })();
        return { pid: process.pid, unref: vi.fn() };
      },
      browserOpener
    });
    await handoffWrite;

    expect(code).toBe(1);
    expect(browserOpener).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("permissions are too broad"));
    await expect(access(paths.startupHandoff)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors --no-open and forwards foreground options only after preflight", async () => {
    const root = await makeTempRoot("waifus-remote-cli-foreground-");
    roots.push(root);
    silence();
    const browserOpener = vi.fn();
    const close = vi.fn();
    const order: string[] = [];
    const code = await runCommand(parseCliArgs([
      "remote",
      "--foreground",
      "--no-open",
      "--host",
      hostId,
      "--data-root",
      root
    ]), {
      remotePreflight: async () => { order.push("preflight"); },
      remoteForegroundStarter: async (input) => {
        order.push("start");
        expect(input).toMatchObject({ dataRoot: root, host: hostId });
        return { runtime: state(process.pid), bootstrapUrl, close };
      },
      remoteHoldOpen: async () => { order.push("hold"); },
      browserOpener
    });

    expect(code).toBe(0);
    expect(order).toEqual(["preflight", "start", "hold"]);
    expect(browserOpener).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(bootstrapUrl));
    expect(close).not.toHaveBeenCalled();
  });

  it("removes a stale remote PID before spawning and leaves the host PID untouched", async () => {
    const root = await makeTempRoot("waifus-remote-cli-stale-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    silence();
    const paths = remoteRolePaths(root, "remote");
    const hostPid = remoteStatePaths(root).backendPid;
    await mkdir(path.dirname(paths.runtimePid), { recursive: true });
    await writeFile(paths.runtimePid, `${JSON.stringify(state(1111))}\n`);
    await mkdir(path.dirname(hostPid), { recursive: true });
    await writeFile(hostPid, `${JSON.stringify({ pid: 2222 })}\n`);

    await runCommand(parseCliArgs(["remote", "--data-root", root]), {
      argv: ["node", "waifus"],
      processAlive: () => false,
      remotePreflight: async () => undefined,
      detachedSpawner: () => ({ pid: 3333, unref: vi.fn() }),
      remoteStartWaiter: async () => ({ runtime: state(3333), bootstrapUrl }),
      browserOpener: async () => undefined
    });

    await expect(access(paths.runtimePid)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(hostPid, "utf8"))).toEqual({ pid: 2222 });
  });

  it("remote status and stop operate only on the remote daemon", async () => {
    const root = await makeTempRoot("waifus-remote-cli-status-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    silence();
    const remote = remoteRolePaths(root, "remote");
    const hostPid = remoteStatePaths(root).backendPid;
    await writeFile(remote.runtimePid, `${JSON.stringify(state(4242))}\n`);
    await writeFile(remote.runtimeState, `${JSON.stringify(state(4242))}\n`);
    await writeFile(remote.startupHandoff, `${JSON.stringify({
      runtime: state(4242),
      bootstrapUrl
    })}\n`, { mode: 0o600 });
    await writeFile(hostPid, `${JSON.stringify({ pid: 5151 })}\n`);

    expect(await runCommand(parseCliArgs(["remote", "status", "--data-root", root]), {
      processAlive: (pid) => pid === 4242 || pid === 5151
    })).toBe(0);
    const alive = new Set([4242, 5151]);
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    expect(await runCommand(parseCliArgs(["remote", "stop", "--data-root", root]), {
      processAlive: (pid) => alive.has(pid),
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
        alive.delete(pid);
      },
      waitForProcessExit: async (pid) => !alive.has(pid)
    })).toBe(0);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(alive.has(5151)).toBe(true);
    expect(JSON.parse(await readFile(hostPid, "utf8"))).toEqual({ pid: 5151 });
    await expect(access(remote.startupHandoff)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails unsupported Intel macOS and missing helpers before spawning", async () => {
    const root = await makeTempRoot("waifus-remote-cli-preflight-");
    roots.push(root);
    silence();
    const detachedSpawner = vi.fn(() => ({ pid: 1, unref: vi.fn() }));

    expect(await runCommand(parseCliArgs(["remote", "--data-root", root]), {
      platform: "darwin",
      arch: "x64",
      detachedSpawner
    })).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Intel macOS"));
    expect(detachedSpawner).not.toHaveBeenCalled();

    expect(await runCommand(parseCliArgs(["remote", "--data-root", root]), {
      platform: "linux",
      arch: "x64",
      detachedSpawner
    })).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("waifus doctor"));
    expect(detachedSpawner).not.toHaveBeenCalled();

    expect(await runCommand(parseCliArgs(["remote", "--data-root", root]), {
      platform: "linux",
      arch: "x64",
      remotePreflight: async () => {
        throw Object.assign(new Error("Helper package signature did not verify."), {
          code: "helper_signature_invalid"
        });
      },
      detachedSpawner
    })).toBe(1);
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("waifus doctor"));
    expect(detachedSpawner).not.toHaveBeenCalled();
  });

  it("reports host and remote separately and succeeds when only the remote daemon is alive", async () => {
    const root = await makeTempRoot("waifus-remote-cli-dual-status-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const remote = remoteRolePaths(root, "remote");
    await writeFile(remote.runtimePid, `${JSON.stringify(state(4242, root))}\n`);
    await writeFile(remote.runtimeState, `${JSON.stringify(state(4242, root))}\n`);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      if (typeof message === "string") logs.push(message);
    });

    const code = await runCommand(parseCliArgs(["status"]), {
      env: { DC_WAIFUS_HOME: root },
      processAlive: (pid) => pid === 4242
    });

    expect(code).toBe(0);
    expect(JSON.parse(logs.at(-1) ?? "null")).toMatchObject({
      dataRoot: root,
      host: { running: false },
      remote: {
        running: true,
        pid: 4242,
        url: shellOrigin
      }
    });
  });

  it("reports both roles and succeeds when only the host daemon is alive", async () => {
    const root = await makeTempRoot("waifus-remote-cli-host-status-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const paths = remoteStatePaths(root);
    await writeFile(paths.backendPid, `${JSON.stringify(hostState(5151, root))}\n`);
    await writeFile(paths.backendRuntime, `${JSON.stringify(hostState(5151, root))}\n`);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      if (typeof message === "string") logs.push(message);
    });

    const code = await runCommand(parseCliArgs(["status", "--data-root", root]), {
      processAlive: (pid) => pid === 5151
    });

    expect(code).toBe(0);
    expect(JSON.parse(logs.at(-1) ?? "null")).toMatchObject({
      dataRoot: root,
      host: {
        running: true,
        pid: 5151,
        url: "http://127.0.0.1:3888"
      },
      remote: { running: false }
    });
  });

  it("host stop leaves a coexisting remote gateway alive", async () => {
    const root = await makeTempRoot("waifus-remote-cli-host-stop-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    silence();
    const paths = remoteStatePaths(root);
    await writeFile(paths.backendPid, `${JSON.stringify(hostState(5151, root))}\n`);
    await writeFile(paths.remoteGatewayRuntimePid, `${JSON.stringify(state(4242, root))}\n`);
    const alive = new Set([4242, 5151]);
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const code = await runCommand(parseCliArgs(["stop", "--data-root", root]), {
      processAlive: (pid) => alive.has(pid),
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
        alive.delete(pid);
      },
      waitForProcessExit: async (pid) => !alive.has(pid)
    });

    expect(code).toBe(0);
    expect(killed).toEqual([{ pid: 5151, signal: "SIGTERM" }]);
    expect(alive.has(4242)).toBe(true);
    expect(JSON.parse(await readFile(paths.remoteGatewayRuntimePid, "utf8"))).toMatchObject({
      pid: 4242,
      kind: "remote_gateway"
    });
  });
});

describe("remote browser launch", () => {
  it.each([
    ["darwin", "open", [bootstrapUrl]],
    ["linux", "xdg-open", [bootstrapUrl]],
    ["win32", "cmd.exe", ["/d", "/s", "/c", "start", "", bootstrapUrl]]
  ] as const)("uses the platform launcher on %s", async (platform, command, args) => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const unref = vi.fn();

    await openBrowser(bootstrapUrl, platform, (actualCommand, actualArgs) => {
      calls.push({ command: actualCommand, args: actualArgs });
      return { unref };
    });

    expect(calls).toEqual([{ command, args }]);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("refuses URLs outside the isolated loopback gateway", async () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }));

    await expect(openBrowser("https://pair.waifucave.com/activate", "linux", spawnProcess))
      .rejects.toThrow("non-local");
    await expect(openBrowser(
      `http://evil.localhost:43123/_waifus_remote/bootstrap/${Buffer.alloc(32, 0x61).toString("base64url")}`,
      "linux",
      spawnProcess
    )).rejects.toThrow("non-local");
    await expect(openBrowser(`${bootstrapUrl}?leak=1`, "linux", spawnProcess))
      .rejects.toThrow("non-local");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
