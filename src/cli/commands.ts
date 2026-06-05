import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { open, readFile, rm, stat } from "node:fs/promises";
import { ensureDataLayout } from "../config/layout.js";
import { appDataPath, DATA_ROOT_ENV, getDataRoot, resolveDataPath } from "../config/paths.js";
import { loadAppConfig } from "../config/appConfig.js";
import { startBackend } from "../backend/server.js";
import { RuntimeStateSchema } from "../backend/runtime.js";
import { diagnoseBundledOcr } from "../orchestration/ocrPackages.js";
import { StorageService } from "../storage/storageService.js";
import { DiscordBotsFileSchema, ProviderCredentialsFileSchema, createEmptyRevisionedFile } from "../shared/schemas/domain.js";
import { ParsedCli, flagBoolean, flagNumber, flagString } from "./parser.js";

const PACKAGE_NAME = "@starlight-ai/discord-waifus";
const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;
const GITHUB_RELEASES_API = "https://api.github.com/repos/HeavenllyDemon/Discord-Waifus/releases/latest";
const GITHUB_RELEASE_TARBALL_PREFIX = "starlight-ai-discord-waifus-";

export type CliProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type CliProcessRunner = {
  run(command: string, args: string[], options?: CliProcessOptions): Promise<number>;
};

export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type GitHubRelease = {
  tag_name?: string;
  assets?: GitHubReleaseAsset[];
};

export type CliRuntimeOptions = {
  processRunner?: CliProcessRunner;
  githubReleaseFetcher?: () => Promise<GitHubRelease>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export async function runCommand(parsed: ParsedCli, options: CliRuntimeOptions = {}): Promise<number> {
  const dataRoot = resolveCliDataRoot(parsed);

  switch (parsed.command) {
    case "help":
      printHelp();
      return 0;
    case "start":
      return startCommand(parsed, dataRoot, "start");
    case "dev":
      return startCommand(parsed, dataRoot, "dev");
    case "stop":
      return stopCommand(dataRoot);
    case "restart": {
      const stopCode = await stopCommand(dataRoot, { quiet: true });
      if (stopCode !== 0) {
        return stopCode;
      }
      return startCommand(parsed, dataRoot, "start");
    }
    case "status":
      return statusCommand(dataRoot);
    case "doctor":
      return doctorCommand(dataRoot);
    case "clean":
      return cleanCommand(parsed, dataRoot);
    case "update":
      return updateCommand(parsed, options);
  }
}

function resolveCliDataRoot(parsed: ParsedCli): string {
  const explicit = flagString(parsed.flags, "dataRoot");
  return getDataRoot(explicit ? { ...process.env, [DATA_ROOT_ENV]: explicit } : process.env);
}

function printHelp(): void {
  console.log(`waifus commands

Usage:
  waifus help
  waifus start [--host 127.0.0.1] [--port 3888] [--data-root PATH]
  waifus dev [--host 127.0.0.1] [--port 3888] [--data-root PATH]
  waifus stop [--data-root PATH]
  waifus restart [--host 127.0.0.1] [--port 3888] [--data-root PATH]
  waifus status [--data-root PATH]
  waifus doctor [--data-root PATH]
  waifus clean [--force] [--include-logs] [--data-root PATH]
  waifus update [--npm | --github]

Environment:
  ${DATA_ROOT_ENV}=PATH overrides the default ~/.dc-waifus data root.
`);
}

async function startCommand(
  parsed: ParsedCli,
  dataRoot: string,
  mode: "start" | "dev"
): Promise<number> {
  await ensureDataLayout(dataRoot);
  if (mode === "start" && !flagBoolean(parsed.flags, "foreground")) {
    return startDetachedCommand(parsed, dataRoot);
  }
  return startForegroundCommand(parsed, dataRoot, mode);
}

async function startDetachedCommand(parsed: ParsedCli, dataRoot: string): Promise<number> {
  const existing = await readRuntimeFile(dataRoot, "pid.json");
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`waifus backend already running at http://127.0.0.1:${existing.port}`);
    console.log(`data root: ${dataRoot}`);
    return 0;
  }
  if (existing) {
    await rm(appDataPath(dataRoot, "pid.json"), { force: true });
  }

  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot locate waifus CLI entrypoint for detached start.");
  }
  const child = spawn(process.execPath, [entrypoint, "start", "--foreground", ...backendStartArgs(parsed, dataRoot)], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore"
  });
  child.unref();
  if (!child.pid) {
    throw new Error("Failed to spawn detached waifus backend.");
  }

  const runtime = await waitForBackendStart(dataRoot, child.pid, 10_000);
  if (!runtime) {
    console.error(`waifus backend did not start within 10s; spawned pid ${child.pid}`);
    return 1;
  }
  console.log(`waifus backend running at http://127.0.0.1:${runtime.port}`);
  console.log(`data root: ${dataRoot}`);
  return 0;
}

async function startForegroundCommand(
  parsed: ParsedCli,
  dataRoot: string,
  mode: "start" | "dev"
): Promise<number> {
  const port = flagNumber(parsed.flags, "port");
  const host = flagString(parsed.flags, "host");
  const running = await startBackend({ dataRoot, port, host, mode });
  console.log(`waifus backend running at ${running.url}`);
  console.log(`data root: ${dataRoot}`);

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`received ${signal}, stopping waifus backend`);
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise(() => undefined);
  return 0;
}

function backendStartArgs(parsed: ParsedCli, dataRoot: string): string[] {
  const args = ["--data-root", dataRoot];
  const host = flagString(parsed.flags, "host");
  const port = flagString(parsed.flags, "port");
  if (host) {
    args.push("--host", host);
  }
  if (port) {
    args.push("--port", port);
  }
  return args;
}

async function stopCommand(dataRoot: string, options: { quiet?: boolean } = {}): Promise<number> {
  const pidState = await readRuntimeFile(dataRoot, "pid.json");
  if (!pidState) {
    if (!options.quiet) {
      console.log("waifus backend is not running: no pid file found");
    }
    return 0;
  }
  if (!isProcessAlive(pidState.pid)) {
    await rm(appDataPath(dataRoot, "pid.json"), { force: true });
    if (!options.quiet) {
      console.log(`waifus backend is not running: stale pid ${pidState.pid} removed`);
    }
    return 0;
  }
  const logFile = appDataPath(dataRoot, "logs", "backend.log");
  const logStartOffset = await fileSize(logFile);
  const tailController = new AbortController();
  const tailDone = options.quiet
    ? Promise.resolve()
    : tailShutdownLog(logFile, logStartOffset, tailController.signal);

  if (!options.quiet) {
    console.log(`sending SIGTERM to pid ${pidState.pid}`);
  }
  process.kill(pidState.pid, "SIGTERM");
  let stopped = await waitForExit(pidState.pid, 20_000);
  if (!stopped) {
    if (!options.quiet) {
      console.log(`pid ${pidState.pid} did not exit within 20s of SIGTERM; escalating to SIGKILL`);
    }
    try {
      process.kill(pidState.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        tailController.abort();
        await tailDone;
        throw error;
      }
    }
    stopped = await waitForExit(pidState.pid, 3_000);
  }
  tailController.abort();
  await tailDone;
  if (!stopped) {
    console.error(`pid ${pidState.pid} is still alive after SIGKILL`);
    return 1;
  }
  await rm(appDataPath(dataRoot, "pid.json"), { force: true });
  if (!options.quiet) {
    console.log(`stopped waifus backend pid ${pidState.pid}`);
  }
  return 0;
}

async function statusCommand(dataRoot: string): Promise<number> {
  const runtime = await readRuntimeFile(dataRoot, "runtime.json");
  const pidState = await readRuntimeFile(dataRoot, "pid.json");
  const running = pidState ? isProcessAlive(pidState.pid) : false;
  console.log(
    JSON.stringify(
      {
        running,
        pid: pidState?.pid,
        url: runtime ? `http://127.0.0.1:${runtime.port}` : undefined,
        dataRoot,
        runtime
      },
      null,
      2
    )
  );
  return running ? 0 : 1;
}

async function doctorCommand(dataRoot: string): Promise<number> {
  await ensureDataLayout(dataRoot);
  const config = await loadAppConfig(dataRoot);
  const storage = new StorageService(dataRoot);
  const providerFile = await storage.readJson(
    "user/providers.json",
    ProviderCredentialsFileSchema,
    ProviderCredentialsFileSchema.parse(createEmptyRevisionedFile({ providers: {} }))
  );
  const discordFile = await storage.readJson(
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
  );
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const bundledOcr = await diagnoseBundledOcr();
  const result = {
    node: {
      version: process.versions.node,
      ok: nodeMajor >= 20
    },
    dataRoot,
    config,
    ocr: {
      config: config.ocr,
      platform: process.platform,
      arch: process.arch,
      bundled: bundledOcr
    },
    providersConfigured: Object.keys(providerFile.providers),
    discord: {
      orchestratorConfigured: discordFile.orchestrator?.token !== undefined,
      waifuBotCount: discordFile.waifus.length,
      warnings: [
        "MESSAGE_CONTENT intent must be enabled for complete Discord channel context.",
        "GUILD_MEMBERS intent is optional unless full member refreshes are required."
      ]
    }
  };
  console.log(JSON.stringify(result, null, 2));
  return result.node.ok ? 0 : 1;
}

async function cleanCommand(parsed: ParsedCli, dataRoot: string): Promise<number> {
  const force = flagBoolean(parsed.flags, "force");
  const includeLogs = flagBoolean(parsed.flags, "includeLogs");
  if (!force) {
    const confirmed = await confirm(
      `Delete saved Discord Waifus user data in ${dataRoot}? Type "delete" to continue: `
    );
    if (!confirmed) {
      console.log("clean cancelled");
      return 1;
    }
  }

  await Promise.all([
    rm(resolveDataPath(dataRoot, "user"), { recursive: true, force: true }),
    rm(resolveDataPath(dataRoot, "config.toml"), { force: true }),
    rm(appDataPath(dataRoot, "cache"), { recursive: true, force: true }),
    includeLogs ? rm(appDataPath(dataRoot, "logs"), { recursive: true, force: true }) : Promise.resolve()
  ]);
  await ensureDataLayout(dataRoot);
  console.log(`cleaned user data in ${dataRoot}`);
  return 0;
}

async function updateCommand(parsed: ParsedCli, options: CliRuntimeOptions): Promise<number> {
  const runner = options.processRunner ?? defaultProcessRunner;
  const forceNpm = flagBoolean(parsed.flags, "npm") || flagBoolean(parsed.flags, "global");
  const forceGithub = flagBoolean(parsed.flags, "github") || flagBoolean(parsed.flags, "release");

  if (flagBoolean(parsed.flags, "git")) {
    console.error(
      "waifus update only updates installed packages. For source checkouts, run git pull, npm install, and npm run build yourself."
    );
    return 1;
  }

  if (forceNpm && forceGithub) {
    console.error("Use either --npm/--global or --github/--release, not both.");
    return 1;
  }

  if (forceGithub) {
    return updateGithubReleasePackage(runner, options);
  }
  return updateGlobalNpmPackage(runner, options);
}

async function updateGlobalNpmPackage(runner: CliProcessRunner, options: CliRuntimeOptions): Promise<number> {
  const npm = npmCommand(options.platform ?? process.platform);

  console.log(`Updating ${PACKAGE_NAME} from npm...`);
  const code = await runner.run(npm, ["install", "-g", PACKAGE_SPEC], {
    env: options.env ?? process.env
  });
  if (code !== 0) {
    console.error(`Failed to update ${PACKAGE_NAME}; npm exited with code ${code}.`);
    return code;
  }
  console.log(`Updated ${PACKAGE_NAME} globally. Restart any running waifus backend to use the new version.`);
  return 0;
}

async function updateGithubReleasePackage(runner: CliProcessRunner, options: CliRuntimeOptions): Promise<number> {
  const fetchRelease = options.githubReleaseFetcher ?? fetchLatestGithubRelease;
  console.log(`Checking latest GitHub release for ${PACKAGE_NAME}...`);
  const release = await fetchRelease();
  const asset = selectGithubReleaseTarball(release);
  if (!asset) {
    console.error(`Latest GitHub release does not include a ${GITHUB_RELEASE_TARBALL_PREFIX}*.tgz asset.`);
    return 1;
  }

  const npm = npmCommand(options.platform ?? process.platform);
  const label = release.tag_name ? ` ${release.tag_name}` : "";
  console.log(`Updating ${PACKAGE_NAME} from GitHub release${label}...`);
  const code = await runner.run(npm, ["install", "-g", asset.browser_download_url], {
    env: options.env ?? process.env
  });
  if (code !== 0) {
    console.error(`Failed to update ${PACKAGE_NAME}; npm exited with code ${code}.`);
    return code;
  }
  console.log(`Updated ${PACKAGE_NAME} from GitHub release. Restart any running waifus backend to use the new version.`);
  return 0;
}

const defaultProcessRunner: CliProcessRunner = {
  run: runProcess
};

async function runProcess(command: string, args: string[], options: CliProcessOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit"
    });
    child.once("error", (error) => {
      console.error(`Failed to start ${command}: ${error.message}`);
      settle(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`${command} exited from signal ${signal}.`);
        settle(1);
        return;
      }
      settle(code ?? 1);
    });
  });
}

async function fetchLatestGithubRelease(): Promise<GitHubRelease> {
  const response = await fetch(GITHUB_RELEASES_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "discord-waifus-cli"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GitHubRelease;
}

function selectGithubReleaseTarball(release: GitHubRelease): GitHubReleaseAsset | undefined {
  return selectPackageTarball(release, PACKAGE_NAME);
}

function npmPackTarballPrefix(packageName: string): string {
  return `${packageName.replace(/^@/u, "").replace(/\//gu, "-")}-`;
}

function selectPackageTarball(release: GitHubRelease, packageName: string): GitHubReleaseAsset | undefined {
  const prefix = npmPackTarballPrefix(packageName);
  return release.assets?.find(
    (asset) => asset.name.startsWith(prefix) && asset.name.endsWith(".tgz") && looksLikeNpmPackVersion(asset.name, prefix)
  );
}

function looksLikeNpmPackVersion(assetName: string, prefix: string): boolean {
  const suffix = assetName.slice(prefix.length, -".tgz".length);
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(suffix);
}

function npmCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

async function readRuntimeFile(dataRoot: string, name: "pid.json" | "runtime.json") {
  try {
    const raw = await readFile(appDataPath(dataRoot, name), "utf8");
    return RuntimeStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function tailShutdownLog(logFile: string, fromOffset: number, signal: AbortSignal): Promise<void> {
  let offset = fromOffset;
  let pending = "";
  while (!signal.aborted) {
    let size: number;
    try {
      size = (await stat(logFile)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (size > offset) {
      const handle = await open(logFile, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        await handle.read(buf, 0, buf.length, offset);
        offset = size;
        pending += buf.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry: { message?: unknown; context?: { step?: unknown; ms?: unknown; totalMs?: unknown } };
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          const message = typeof entry.message === "string" ? entry.message : "";
          const step = typeof entry.context?.step === "string" ? entry.context.step : undefined;
          if (message === "Shutdown step start" && step) {
            console.log(`  ${step} ...`);
          } else if (message === "Shutdown step done" && step) {
            const ms = typeof entry.context?.ms === "number" ? entry.context.ms : undefined;
            console.log(`  ${step} done${ms !== undefined ? ` in ${ms}ms` : ""}`);
          } else if (message === "Backend stopped") {
            const totalMs = typeof entry.context?.totalMs === "number" ? entry.context.totalMs : undefined;
            console.log(`  backend stopped${totalMs !== undefined ? ` (total ${totalMs}ms)` : ""}`);
          }
        }
      } finally {
        await handle.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForBackendStart(dataRoot: string, pid: number, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runtime = await readRuntimeFile(dataRoot, "runtime.json");
    if (runtime?.pid === pid && isProcessAlive(pid)) {
      return runtime;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === "delete";
  } finally {
    rl.close();
  }
}
