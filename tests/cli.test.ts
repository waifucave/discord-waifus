import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type CliProcessOptions, type CliProcessRunner } from "../src/cli/commands.js";
import { flagBoolean, flagNumber, flagString, parseCliArgs } from "../src/cli/parser.js";

type RunnerCall = { command: string; args: string[]; options?: CliProcessOptions };

afterEach(() => {
  vi.restoreAllMocks();
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
  it("updates npm packages globally by default", async () => {
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
        args: ["install", "-g", "@starlight-ai/discord-waifus@latest"],
        options: { env }
      }
    ]);
  });

  it("updates GitHub release packages from the latest release tarball", async () => {
    silenceCliOutput();
    const env = { PATH: "/usr/bin" };
    const { calls, runner } = createRunner();

    const code = await runCommand(parseCliArgs(["update", "--github"]), {
      env,
      githubReleaseFetcher: async () => ({
        tag_name: "v1.2.0",
        assets: [
          {
            name: "starlight-ai-discord-waifus-1.2.0.tgz",
            browser_download_url:
              "https://github.com/HeavenllyDemon/Discord-Waifus/releases/download/v1.2.0/starlight-ai-discord-waifus-1.2.0.tgz"
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
          "https://github.com/HeavenllyDemon/Discord-Waifus/releases/download/v1.2.0/starlight-ai-discord-waifus-1.2.0.tgz"
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
