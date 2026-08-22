import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type CliProcessOptions, type CliProcessRunner } from "../src/cli/commands.js";
import { flagBoolean, flagNumber, flagString, parseCliArgs } from "../src/cli/parser.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

type RunnerCall = { command: string; args: string[]; options?: CliProcessOptions };

let roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("CLI parser", () => {
  it("parses commands, flags, and data-root aliases", () => {
    const parsed = parseCliArgs(["start", "--port", "4777", "--data-root=/tmp/waifus", "--force"]);
    expect(parsed.command).toBe("start");
    expect(flagNumber(parsed.flags, "port")).toBe(4777);
    expect(flagString(parsed.flags, "dataRoot")).toBe("/tmp/waifus");
    expect(flagBoolean(parsed.flags, "force")).toBe(true);
  });

  it("defaults unknown commands to help", () => {
    expect(parseCliArgs(["unknown"]).command).toBe("help");
  });
});

describe("waifus update", () => {
  it("updates the npm package globally", async () => {
    silenceCliOutput();
    const env = { PATH: "/usr/bin" };
    const { calls, runner } = createRunner();

    const code = await runCommand(parseCliArgs(["update"]), {
      env,
      platform: "linux",
      processRunner: runner
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["install", "-g", "@waifucave/discord-waifus@latest", "--force"],
        options: { env }
      },
      {
        command: "npm",
        args: ["uninstall", "-g", "@starlight-ai/discord-waifus"],
        options: { env }
      },
      {
        command: "npm",
        args: ["install", "-g", "@waifucave/discord-waifus@latest", "--force"],
        options: { env }
      }
    ]);
  });

  it("updates GitHub release packages from the latest migrated release tarball", async () => {
    silenceCliOutput();
    const env = { PATH: "/usr/bin" };
    const { calls, runner } = createRunner();

    const code = await runCommand(parseCliArgs(["update", "--github"]), {
      env,
      githubReleaseFetcher: async () => ({
        tag_name: "v1.2.0",
        assets: [
          {
            name: "waifucave-discord-waifus-1.2.0.tgz",
            browser_download_url:
              "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/waifucave-discord-waifus-1.2.0.tgz"
          }
        ]
      }),
      platform: "linux",
      processRunner: runner
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: "npm",
        args: [
          "install",
          "-g",
          "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/waifucave-discord-waifus-1.2.0.tgz",
          "--force"
        ],
        options: { env }
      },
      {
        command: "npm",
        args: ["uninstall", "-g", "@starlight-ai/discord-waifus"],
        options: { env }
      },
      {
        command: "npm",
        args: [
          "install",
          "-g",
          "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/waifucave-discord-waifus-1.2.0.tgz",
          "--force"
        ],
        options: { env }
      }
    ]);
  });

  it("falls back to the legacy root tarball during the package migration bridge", async () => {
    silenceCliOutput();
    const env = { PATH: "/usr/bin" };
    const { calls, runner } = createRunner();

    const code = await runCommand(parseCliArgs(["update", "--github"]), {
      env,
      githubReleaseFetcher: async () => ({
        tag_name: "v1.2.0",
        assets: [
          {
            name: "starlight-ai-discord-waifus-ocr-win32-x64-1.2.0.tgz",
            browser_download_url:
              "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/starlight-ai-discord-waifus-ocr-win32-x64-1.2.0.tgz"
          },
          {
            name: "starlight-ai-discord-waifus-1.2.0.tgz",
            browser_download_url:
              "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/starlight-ai-discord-waifus-1.2.0.tgz"
          }
        ]
      }),
      platform: "win32",
      processRunner: runner
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: "npm.cmd",
        args: [
          "install",
          "-g",
          "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/starlight-ai-discord-waifus-1.2.0.tgz",
          "--force"
        ],
        options: { env }
      },
      {
        command: "npm.cmd",
        args: ["uninstall", "-g", "@starlight-ai/discord-waifus"],
        options: { env }
      },
      {
        command: "npm.cmd",
        args: [
          "install",
          "-g",
          "https://github.com/waifucave/discord-waifus/releases/download/v1.2.0/starlight-ai-discord-waifus-1.2.0.tgz",
          "--force"
        ],
        options: { env }
      }
    ]);
  });

  it("refuses source checkout updates", async () => {
    silenceCliOutput();
    const { calls, runner } = createRunner();

    const code = await runCommand(parseCliArgs(["update", "--git"]), {
      platform: "linux",
      processRunner: runner
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it("fails GitHub release updates when no tarball asset exists", async () => {
    silenceCliOutput();
    const { calls, runner } = createRunner();

    const code = await runCommand(parseCliArgs(["update", "--release"]), {
      githubReleaseFetcher: async () => ({ tag_name: "v1.2.0", assets: [] }),
      platform: "linux",
      processRunner: runner
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("waifus start", () => {
  it("does not fail a detached start when the spawned backend is still alive", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    silenceCliOutput();
    const spawned = { pid: 12345, unref: vi.fn() };
    const spawnCalls: Array<{ command: string; args: string[] }> = [];

    const code = await runCommand(parseCliArgs(["start", "--data-root", root]), {
      argv: ["/usr/local/bin/node", "/usr/local/bin/waifus"],
      cwd: "/tmp",
      detachedBackendWaiter: async () => undefined,
      detachedSpawner: (command, args) => {
        spawnCalls.push({ command, args });
        return spawned;
      },
      env: { PATH: "/usr/bin" },
      execPath: "/usr/local/bin/node",
      processAlive: () => true
    });

    expect(code).toBe(0);
    expect(spawned.unref).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toEqual([
      {
        command: "/usr/local/bin/node",
        args: ["/usr/local/bin/waifus", "start", "--foreground", "--data-root", root]
      }
    ]);
    expect(console.log).toHaveBeenCalledWith("waifus backend is still starting after 30s; spawned pid 12345");
  });
});

describe("waifus clean remote-state boundaries", () => {
  it.each([
    ["host daemon", "backendPid"],
    ["host remote helper", "hostRuntimePid"],
    ["remote gateway", "remoteGatewayRuntimePid"]
  ] as const)("refuses without mutation while the %s is running", async (_label, pathKey) => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    silenceCliOutput();
    const paths = remoteStatePaths(root);
    await writeJsonFile(paths[pathKey], { pid: 42, role: pathKey });
    const userSentinel = path.join(root, "user", "clean-must-not-run.txt");
    await writeTextFile(userSentinel, "untouched");
    const before = new Map<string, string>();
    for (const filePath of [paths.hostConfig, paths.installation, paths.trustIndex, paths[pathKey], userSentinel]) {
      before.set(filePath, await readFile(filePath, "utf8"));
    }

    const code = await runCommand(parseCliArgs(["clean", "--force", "--data-root", root]), {
      processAlive: (pid) => pid === 42
    });

    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("clean refused"));
    for (const [filePath, bytes] of before) {
      expect(await readFile(filePath, "utf8")).toBe(bytes);
    }
  });

  it("preserves identity, activation, settings, trust, operations, audit, and remembered hosts byte-for-byte", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    silenceCliOutput();
    const paths = remoteStatePaths(root);
    const installation = JSON.parse(await readFile(paths.installation, "utf8")) as Record<string, unknown>;
    installation.activationReference = "vault:activation:test";
    await writeJsonFile(paths.installation, installation);
    await writeJsonFile(paths.hostConfig, {
      revision: "7",
      enabled: true,
      displayName: "Studio Host",
      updatedAt: "9007199254740993"
    });
    await writeJsonFile(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: "11",
      resetTombstone: "3",
      pairs: [
        {
          deviceId: "travel-mac",
          pairId: Buffer.alloc(16, 0x71).toString("base64url"),
          trustEpoch: "9"
        },
        {
          deviceId: "desk-linux",
          pairId: Buffer.alloc(16, 0x72).toString("base64url"),
          trustEpoch: "11"
        }
      ]
    });
    const preservedFiles = [
      paths.hostConfig,
      paths.installation,
      paths.trustIndex,
      path.join(paths.trustRoot, "pinned-public-bundle.json"),
      path.join(paths.operationsRoot, "ledger.json"),
      path.join(paths.auditRoot, "ledger.json"),
      path.join(paths.remoteGatewayStateRoot, "remembered-hosts.json")
    ];
    await writeTextFile(preservedFiles[3], "trust-sentinel\n");
    await writeTextFile(preservedFiles[4], "operation-sentinel\n");
    await writeTextFile(preservedFiles[5], "administrative-audit-sentinel\n");
    await writeTextFile(preservedFiles[6], "remembered-host-sentinel\n");
    const preserved = new Map<string, string>();
    for (const filePath of preservedFiles) preserved.set(filePath, await readFile(filePath, "utf8"));

    const ordinaryUser = path.join(root, "user", "ordinary-user-sentinel.txt");
    const ordinaryCache = path.join(root, "app", "cache", "ordinary-cache-sentinel.txt");
    const dashboardCache = path.join(paths.dashboardCacheRoot, "build", "asset.js");
    const hostTransient = path.join(paths.hostRuntimeRoot, "session.sock");
    const remoteTransient = path.join(paths.remoteGatewayRuntimeRoot, "browser-session.json");
    const hostLog = paths.hostLog;
    const remoteLog = paths.remoteGatewayLog;
    await writeTextFile(ordinaryUser, "ordinary-user");
    await writeTextFile(path.join(root, "config.toml"), "ordinary-config-sentinel\n");
    await writeTextFile(ordinaryCache, "ordinary-cache");
    await writeTextFile(dashboardCache, "dashboard-cache");
    await writeTextFile(hostTransient, "host-transient");
    await writeTextFile(remoteTransient, "remote-transient");
    await writeJsonFile(paths.backendPid, { pid: 101 });
    await writeJsonFile(paths.hostRuntimePid, { pid: 102 });
    await writeJsonFile(paths.remoteGatewayRuntimePid, { pid: 103 });
    await writeTextFile(hostLog, "host-log-sentinel\n");
    await writeTextFile(remoteLog, "remote-log-sentinel\n");

    const code = await runCommand(parseCliArgs(["clean", "--force", "--data-root", root]), {
      processAlive: () => false
    });

    expect(code).toBe(0);
    for (const [filePath, bytes] of preserved) {
      expect(await readFile(filePath, "utf8")).toBe(bytes);
    }
    await expect(access(ordinaryUser)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(ordinaryCache)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(dashboardCache)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(hostTransient)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(remoteTransient)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.backendPid)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(hostLog, "utf8")).toBe("host-log-sentinel\n");
    expect(await readFile(remoteLog, "utf8")).toBe("remote-log-sentinel\n");
    expect(await readFile(path.join(root, "config.toml"), "utf8")).not.toContain("ordinary-config-sentinel");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("preserved 2 remote pairings"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("local Settings → Remote Access"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("POST /api/remote-access/reset"));
  });

  it("removes ordinary role logs with --include-logs but never administrative audit", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    silenceCliOutput();
    const paths = remoteStatePaths(root);
    const auditFile = path.join(paths.auditRoot, "ledger.json");
    await writeTextFile(auditFile, "audit-must-survive\n");
    await writeTextFile(paths.hostLog, "host-log\n");
    await writeTextFile(paths.remoteGatewayLog, "remote-log\n");

    const code = await runCommand(
      parseCliArgs(["clean", "--force", "--include-logs", "--data-root", root]),
      { processAlive: () => false }
    );

    expect(code).toBe(0);
    await expect(access(paths.hostLog)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.remoteGatewayLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(auditFile, "utf8")).toBe("audit-must-survive\n");
  });

  it("refuses malformed daemon PID state without deleting anything", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    silenceCliOutput();
    const paths = remoteStatePaths(root);
    const sentinel = path.join(root, "user", "still-here.txt");
    await writeTextFile(paths.remoteGatewayRuntimePid, "not-json\n");
    await writeTextFile(sentinel, "still-here\n");

    const code = await runCommand(parseCliArgs(["clean", "--force", "--data-root", root]), {
      processAlive: () => false
    });

    expect(code).toBe(1);
    expect(await readFile(sentinel, "utf8")).toBe("still-here\n");
    expect(await readFile(paths.remoteGatewayRuntimePid, "utf8")).toBe("not-json\n");
  });
});

function createRunner() {
  const calls: RunnerCall[] = [];
  const runner: CliProcessRunner = {
    async run(command: string, args: string[], options?: CliProcessOptions) {
      calls.push({ command, args, options });
      return 0;
    }
  };
  return { calls, runner };
}

function silenceCliOutput(): void {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
