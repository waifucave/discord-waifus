import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, rm } from "node:fs/promises";
import { ensureDataLayout } from "../config/layout.js";
import { appDataPath, DATA_ROOT_ENV, getDataRoot, resolveDataPath } from "../config/paths.js";
import { loadAppConfig } from "../config/appConfig.js";
import { startBackend } from "../backend/server.js";
import { RuntimeStateSchema } from "../backend/runtime.js";
import { StorageService } from "../storage/storageService.js";
import { DiscordBotsFileSchema, ProviderCredentialsFileSchema, createEmptyRevisionedFile } from "../shared/schemas/domain.js";
import { ParsedCli, flagBoolean, flagNumber, flagString } from "./parser.js";

export async function runCommand(parsed: ParsedCli): Promise<number> {
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
      return updateCommand();
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
  waifus update

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
  process.kill(pidState.pid, "SIGTERM");
  const stopped = await waitForExit(pidState.pid, 5_000);
  if (!stopped) {
    console.error(`pid ${pidState.pid} did not stop within 5s`);
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
  const result = {
    node: {
      version: process.versions.node,
      ok: nodeMajor >= 20
    },
    dataRoot,
    config,
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

async function updateCommand(): Promise<number> {
  console.log(`waifus update does not mutate files directly yet.

Global npm users can update with:
  npm install -g @starlight-ai/discord-waifus@latest

Git checkout users should pull and reinstall only when their worktree is clean:
  git status --short
  git pull --ff-only
  npm install
  npm run build

No files were changed by this command.`);
  return 0;
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
