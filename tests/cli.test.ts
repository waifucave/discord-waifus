import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type CliProcessOptions, type CliProcessRunner } from "../src/cli/commands.js";
import { flagBoolean, flagNumber, flagString, parseCliArgs } from "../src/cli/parser.js";
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
