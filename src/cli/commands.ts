import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { lstat, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { ensureDataLayout } from "../config/layout.js";
import { appDataPath, DATA_ROOT_ENV, getDataRoot, resolveDataPath } from "../config/paths.js";
import { loadAppConfig } from "../config/appConfig.js";
import { startBackend } from "../backend/server.js";
import {
  findUnresolvedModels,
  findUnstampedFiles,
  readDiscordBotsLeniently,
  readProviderIdsLeniently
} from "../backend/migrations.js";
import { RuntimeStateSchema } from "../backend/runtime.js";
import type { RuntimeState } from "../backend/runtime.js";
import {
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessTrustIndexV1Schema
} from "../shared/schemas/remoteAccess.js";
import { RemoteAccessConfigV1Schema } from "../shared/schemas/remoteLifecycle.js";
import { remoteStatePaths } from "../remote/paths.js";
import { inspectRememberedHostState } from "../remote/rememberedHosts.js";
import { diagnoseBundledOcr } from "../orchestration/ocrPackages.js";
import { StorageService } from "../storage/storageService.js";
import { DEFAULT_APP_CONFIG } from "../shared/schemas/config.js";
import { DiscordBotsFileSchema, ProviderCredentialsFileSchema, createEmptyRevisionedFile } from "../shared/schemas/domain.js";
import { ParsedCli, flagBoolean, flagNumber, flagString } from "./parser.js";
import {
  readRemoteDaemonStatus,
  runRemoteCommand,
  type RemoteCliOptions
} from "./remoteCommand.js";
import {
  processIsAlive,
  readProcessState,
  stopDaemonProcess,
  type StopDaemonResult
} from "./processState.js";

const LEGACY_PACKAGE_NAME = "@starlight-ai/discord-waifus";
const UPDATE_PACKAGE_NAME = "@waifucave/discord-waifus";
const UPDATE_PACKAGE_SPEC = `${UPDATE_PACKAGE_NAME}@latest`;
const GITHUB_RELEASES_API = "https://api.github.com/repos/waifucave/discord-waifus/releases/latest";
const GITHUB_RELEASE_TARBALL_PACKAGES = [UPDATE_PACKAGE_NAME, LEGACY_PACKAGE_NAME];

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

export type CliRuntimeOptions = RemoteCliOptions & {
  processRunner?: CliProcessRunner;
  githubReleaseFetcher?: () => Promise<GitHubRelease>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  argv?: string[];
  execPath?: string;
  cwd?: string;
  detachedSpawner?: CliDetachedSpawner;
  detachedBackendWaiter?: (dataRoot: string, pid: number, timeoutMs: number) => Promise<RuntimeState | undefined>;
  processAlive?: (pid: number) => boolean;
};

export type CliDetachedSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions
) => { pid?: number; unref(): void };

const DETACHED_START_TIMEOUT_MS = 30_000;

export async function runCommand(parsed: ParsedCli, options: CliRuntimeOptions = {}): Promise<number> {
  const dataRoot = resolveCliDataRoot(parsed, options.env ?? process.env);

  switch (parsed.command) {
    case "help":
      printHelp();
      return 0;
    case "start":
      return startCommand(parsed, dataRoot, "start", options);
    case "dev":
      return startCommand(parsed, dataRoot, "dev", options);
    case "stop":
      return stopCommand(dataRoot, {
        isAlive: options.processAlive,
        kill: options.killProcess,
        waitForExit: options.waitForProcessExit
      });
    case "restart": {
      const stopCode = await stopCommand(dataRoot, {
        quiet: true,
        isAlive: options.processAlive,
        kill: options.killProcess,
        waitForExit: options.waitForProcessExit
      });
      if (stopCode !== 0) {
        return stopCode;
      }
      return startCommand(parsed, dataRoot, "start", options);
    }
    case "status":
      return statusCommand(dataRoot, options.processAlive);
    case "doctor":
      return doctorCommand(dataRoot, options);
    case "clean":
      return cleanCommand(parsed, dataRoot, options.processAlive ?? processIsAlive);
    case "update":
      return updateCommand(parsed, options);
    case "remote":
      return runRemoteCommand(parsed, dataRoot, options);
  }
}

function resolveCliDataRoot(parsed: ParsedCli, env: NodeJS.ProcessEnv): string {
  const explicit = flagString(parsed.flags, "dataRoot");
  return getDataRoot(explicit ? { ...env, [DATA_ROOT_ENV]: explicit } : env);
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
  waifus remote [--foreground] [--no-open] [--host ID_OR_NAME] [--port PORT] [--data-root PATH]
  waifus remote status [--data-root PATH]
  waifus remote stop [--data-root PATH]

Environment:
  ${DATA_ROOT_ENV}=PATH overrides the default ~/.dc-waifus data root.
`);
}

async function startCommand(
  parsed: ParsedCli,
  dataRoot: string,
  mode: "start" | "dev",
  options: CliRuntimeOptions
): Promise<number> {
  await ensureDataLayout(dataRoot);
  if (mode === "start" && !flagBoolean(parsed.flags, "foreground")) {
    return startDetachedCommand(parsed, dataRoot, options);
  }
  return startForegroundCommand(parsed, dataRoot, mode);
}

async function startDetachedCommand(
  parsed: ParsedCli,
  dataRoot: string,
  options: CliRuntimeOptions
): Promise<number> {
  const existing = await readProcessState(appDataPath(dataRoot, "pid.json"), RuntimeStateReadSchema);
  const processAlive = options.processAlive ?? processIsAlive;
  if (existing && processAlive(existing.pid)) {
    console.log(`waifus backend already running at http://127.0.0.1:${existing.port}`);
    console.log(`data root: ${dataRoot}`);
    return 0;
  }
  if (existing) {
    await rm(appDataPath(dataRoot, "pid.json"), { force: true });
  }

  const argv = options.argv ?? process.argv;
  const entrypoint = argv[1];
  if (!entrypoint) {
    throw new Error("Cannot locate waifus CLI entrypoint for detached start.");
  }
  const detachedSpawner = options.detachedSpawner ?? spawn;
  const child = detachedSpawner(options.execPath ?? process.execPath, [entrypoint, "start", "--foreground", ...backendStartArgs(parsed, dataRoot)], {
    cwd: options.cwd ?? process.cwd(),
    detached: true,
    env: options.env ?? process.env,
    stdio: "ignore"
  });
  child.unref();
  if (!child.pid) {
    throw new Error("Failed to spawn detached waifus backend.");
  }

  const runtime = await (options.detachedBackendWaiter ?? waitForBackendStart)(
    dataRoot,
    child.pid,
    DETACHED_START_TIMEOUT_MS
  );
  if (!runtime) {
    if (processAlive(child.pid)) {
      console.log(`waifus backend is still starting after 30s; spawned pid ${child.pid}`);
      console.log(`data root: ${dataRoot}`);
      console.log(`logs: ${appDataPath(dataRoot, "logs", "backend.log")}`);
      return 0;
    }
    console.error(`waifus backend did not start within 30s; spawned pid ${child.pid} exited`);
    console.error(`logs: ${appDataPath(dataRoot, "logs", "backend.log")}`);
    return 1;
  }
  console.log(`waifus backend running at http://127.0.0.1:${runtime.port}`);
  if (runtime.discord.connecting) {
    console.log("Discord auto-connect is still connecting; dashboard/status will update when ready.");
  }
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

async function stopCommand(
  dataRoot: string,
  options: {
    quiet?: boolean;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  } = {}
): Promise<number> {
  const logFile = appDataPath(dataRoot, "logs", "backend.log");
  let tailController: AbortController | undefined;
  let tailDone: Promise<void> | undefined;
  let result: StopDaemonResult;
  try {
    result = await stopDaemonProcess({
      pidFile: appDataPath(dataRoot, "pid.json"),
      schema: RuntimeStateReadSchema,
      isAlive: options.isAlive,
      kill: options.kill,
      waitForExit: options.waitForExit,
      beforeTerminate: async (pid) => {
        if (!options.quiet) {
          const logStartOffset = await fileSize(logFile);
          tailController = new AbortController();
          tailDone = tailShutdownLog(logFile, logStartOffset, tailController.signal);
          console.log(`sending SIGTERM to pid ${pid}`);
        }
      },
      beforeEscalate: (pid) => {
        if (!options.quiet) {
          console.log(`pid ${pid} did not exit within 20s of SIGTERM; escalating to SIGKILL`);
        }
      }
    });
  } finally {
    tailController?.abort();
    await tailDone;
  }
  if (!options.quiet) reportHostStop(result);
  return result.state === "still_running" ? 1 : 0;
}

function reportHostStop(result: StopDaemonResult): void {
  if (result.state === "absent") console.log("waifus backend is not running: no pid file found");
  if (result.state === "stale_removed") {
    console.log(`waifus backend is not running: stale pid ${result.pid} removed`);
  }
  if (result.state === "stopped") console.log(`stopped waifus backend pid ${result.pid}`);
  if (result.state === "still_running") {
    console.error(`pid ${result.pid} is still alive after SIGKILL`);
  }
}

async function statusCommand(
  dataRoot: string,
  isAlive: (pid: number) => boolean = processIsAlive
): Promise<number> {
  const [runtime, pidState, remote] = await Promise.all([
    readProcessState(appDataPath(dataRoot, "runtime.json"), RuntimeStateReadSchema),
    readProcessState(appDataPath(dataRoot, "pid.json"), RuntimeStateReadSchema),
    readRemoteDaemonStatus(dataRoot, isAlive)
  ]);
  const hostRunning = pidState ? isAlive(pidState.pid) : false;
  console.log(
    JSON.stringify(
      {
        dataRoot,
        host: {
          running: hostRunning,
          pid: pidState?.pid,
          url: runtime ? `http://127.0.0.1:${runtime.port}` : undefined,
          runtime
        },
        remote
      },
      null,
      2
    )
  );
  return hostRunning || remote.running ? 0 : 1;
}

async function doctorCommand(dataRoot: string, options: CliRuntimeOptions): Promise<number> {
  await ensureDataLayout(dataRoot);

  // doctor is read-only: it never calls runMigrations. An unmigrated (schemaVersion 1) data root
  // would otherwise crash every strict Zod parse below (`z.literal(CURRENT_SCHEMA_VERSION)`)
  // before doctor gets a chance to report anything useful. Degrade those three reads instead of
  // letting the error propagate — but only when the parse failure is specifically a schemaVersion
  // mismatch; any other validation failure (genuinely malformed data) still throws, so it surfaces
  // as a real error instead of a silent pass. The fallback is a thunk (not a plain value) so the
  // providers/discord-bots cases below can extract the real on-disk data leniently instead of
  // reporting a synthetic empty file — an unmigrated root with real stored credentials/bots must
  // still surface them, not hide them.
  let unmigrated = false;
  const degradeOnVersionMismatch = async <T>(load: () => Promise<T>, fallback: () => Promise<T> | T): Promise<T> => {
    try {
      return await load();
    } catch (error) {
      if (!isSchemaVersionMismatch(error)) throw error;
      unmigrated = true;
      return await fallback();
    }
  };

  const config = await degradeOnVersionMismatch(() => loadAppConfig(dataRoot), () => DEFAULT_APP_CONFIG);
  const storage = new StorageService(dataRoot);
  const providerFallback = ProviderCredentialsFileSchema.parse(createEmptyRevisionedFile({ providers: {} }));
  const providersConfigured = await degradeOnVersionMismatch(
    async () =>
      Object.keys(
        (await storage.readJson("user/providers.json", ProviderCredentialsFileSchema, providerFallback)).providers
      ),
    () => readProviderIdsLeniently(dataRoot)
  );
  const discordFallback = DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }));
  const discordSummary = await degradeOnVersionMismatch(
    async () => {
      const discordFile = await storage.readJson("user/discord-bots.json", DiscordBotsFileSchema, discordFallback);
      return {
        orchestratorConfigured: discordFile.orchestrator?.token !== undefined,
        waifuBotCount: discordFile.waifus.length
      };
    },
    () => readDiscordBotsLeniently(dataRoot)
  );

  const warnings: string[] = [];
  if (unmigrated) {
    warnings.push("unmigrated data root — run `waifus start` to migrate");
  }

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const [bundledOcr, unstamped, unresolvedModels, remoteAccess] = await Promise.all([
    diagnoseBundledOcr(),
    findUnstampedFiles(dataRoot),
    findUnresolvedModels(dataRoot),
    remoteManagementDoctorSummary(dataRoot, options)
  ]);
  const result = {
    node: {
      version: process.versions.node,
      ok: nodeMajor >= 20
    },
    dataRoot,
    config,
    warnings,
    schema: {
      unstamped
    },
    models: {
      unresolved: unresolvedModels
    },
    ocr: {
      config: config.ocr,
      platform: process.platform,
      arch: process.arch,
      bundled: bundledOcr
    },
    providersConfigured,
    discord: {
      orchestratorConfigured: discordSummary.orchestratorConfigured,
      waifuBotCount: discordSummary.waifuBotCount,
      warnings: [
        "MESSAGE_CONTENT intent must be enabled for complete Discord channel context.",
        "GUILD_MEMBERS intent is optional unless full member refreshes are required."
      ]
    },
    remoteAccess
  };
  console.log(JSON.stringify(result, null, 2));
  // models.unresolved is informational only (§7.3 doctor-warning intent) — it never flips the
  // exit code.
  return result.node.ok ? 0 : 1;
}

function remoteTargetSupport(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): Readonly<{ supported: boolean; note: string | null }> {
  if (platform === "darwin" && arch === "x64") {
    return Object.freeze({
      supported: false,
      note: "Intel macOS remote mode is a later follow-up."
    });
  }
  const supported = (platform === "darwin" && arch === "arm64")
    || (platform === "win32" && (arch === "x64" || arch === "arm64"))
    || (platform === "linux" && (arch === "x64" || arch === "arm64" || arch === "arm"));
  return Object.freeze({
    supported,
    note: supported ? null : `Remote mode is not supported on ${platform}/${arch}.`
  });
}

async function remoteManagementDoctorSummary(
  dataRoot: string,
  options: CliRuntimeOptions
): Promise<Record<string, unknown>> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = remoteTargetSupport(platform, arch);
  const isAlive = options.processAlive ?? processIsAlive;
  const [hostRuntime, hostPid, remote] = await Promise.all([
    readProcessState(appDataPath(dataRoot, "runtime.json"), RuntimeStateReadSchema),
    readProcessState(appDataPath(dataRoot, "pid.json"), RuntimeStateReadSchema),
    readRemoteDaemonStatus(dataRoot, isAlive)
  ]);
  const hostRunning = hostPid ? isAlive(hostPid.pid) : false;
  const remoteRuntime = remote.runtime;
  const runtimeVerified = remote.running
    && remoteRuntime?.helperState === "ready"
    && remoteRuntime.helperVersion !== null
    && remoteRuntime.helperReleaseSequence !== null;
  const helperState = !target.supported
    ? "unsupported"
    : runtimeVerified
      ? "runtime_verified"
      : "missing";
  return Object.freeze({
    target: Object.freeze({ platform, arch, ...target }),
    helperPackage: Object.freeze({
      state: helperState,
      verified: runtimeVerified,
      version: runtimeVerified ? remoteRuntime.helperVersion : null,
      releaseSequence: runtimeVerified ? remoteRuntime.helperReleaseSequence : null,
      protocol: runtimeVerified ? remoteRuntime.protocol : null,
      capabilities: runtimeVerified ? [...remoteRuntime.capabilities] : [],
      lastErrorCode: runtimeVerified || !target.supported
        ? null
        : remoteRuntime?.lastErrorCode
          ?? hostRuntime?.remoteAccess?.lastErrorCode
          ?? "helper_missing"
    }),
    host: Object.freeze({
      running: hostRunning,
      pid: hostPid?.pid,
      runtime: hostRuntime?.remoteAccess ?? null
    }),
    remote: Object.freeze({
      running: remote.running,
      pid: remote.pid,
      runtime: remoteRuntime
        ? Object.freeze({
            helperVersion: remoteRuntime.helperVersion,
            helperReleaseSequence: remoteRuntime.helperReleaseSequence,
            protocol: remoteRuntime.protocol,
            capabilities: [...remoteRuntime.capabilities],
            helperState: remoteRuntime.helperState,
            activationState: remoteRuntime.activationState,
            controlState: remoteRuntime.controlState,
            directState: remoteRuntime.directState,
            rememberedHostCount: remoteRuntime.rememberedHostCount,
            selectionState: remoteRuntime.selectionState,
            lastDirectAt: remoteRuntime.lastDirectAt,
            lastErrorCode: remoteRuntime.lastErrorCode
          })
        : null
    }),
    network: Object.freeze({
      stun: "unknown",
      udp: "unknown",
      portMapping: "unknown"
    })
  });
}

// True only when every issue in the Zod failure is the schemaVersion literal mismatch — i.e. the
// *only* thing wrong is that the file predates the current migration. Any other validation issue
// (missing fields, wrong types, genuinely malformed content) returns false so the caller rethrows
// instead of masking a real error behind the "unmigrated" degrade path.
function isSchemaVersionMismatch(error: unknown): boolean {
  const zodError = error instanceof z.ZodError ? error : unwrapZodErrorCause(error);
  return (
    zodError !== undefined &&
    zodError.issues.length > 0 &&
    zodError.issues.every((issue) => issue.path.length === 1 && issue.path[0] === "schemaVersion")
  );
}

function unwrapZodErrorCause(error: unknown): z.ZodError | undefined {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause instanceof z.ZodError ? cause : undefined;
}

async function cleanCommand(
  parsed: ParsedCli,
  dataRoot: string,
  processAlive: (pid: number) => boolean
): Promise<number> {
  const force = flagBoolean(parsed.flags, "force");
  const includeLogs = flagBoolean(parsed.flags, "includeLogs");
  const daemonState = await inspectCleanDaemonState(dataRoot, processAlive);
  if (reportCleanDaemonRefusal(daemonState)) return 1;

  let preservedPairCount: number;
  try {
    preservedPairCount = await validatePreservedRemoteStateForClean(dataRoot);
  } catch (error) {
    console.error(`clean refused: ${(error as Error).message}`);
    return 1;
  }
  if (!force) {
    const confirmed = await confirm(
      `Delete saved Discord Waifus user data in ${dataRoot}? Type "delete" to continue: `
    );
    if (!confirmed) {
      console.log("clean cancelled");
      return 1;
    }
  }

  // Confirmation may take arbitrarily long. Recheck immediately before deletion so a daemon
  // started while the prompt was open cannot be cleaned out from underneath its live state.
  const finalDaemonState = await inspectCleanDaemonState(dataRoot, processAlive);
  if (reportCleanDaemonRefusal(finalDaemonState)) return 1;
  try {
    preservedPairCount = await validatePreservedRemoteStateForClean(dataRoot);
  } catch (error) {
    console.error(`clean refused: ${(error as Error).message}`);
    return 1;
  }

  const paths = remoteStatePaths(dataRoot);
  const deletionTargets = [
    { filePath: resolveDataPath(dataRoot, "user"), recursive: true },
    { filePath: resolveDataPath(dataRoot, "config.toml"), recursive: false },
    { filePath: appDataPath(dataRoot, "cache"), recursive: true },
    { filePath: paths.backendPid, recursive: false },
    { filePath: paths.backendRuntime, recursive: false },
    { filePath: paths.hostRuntimeRoot, recursive: true },
    { filePath: paths.remoteGatewayRuntimeRoot, recursive: true },
    ...(includeLogs
      ? [paths.backendLog, paths.hostLog, paths.remoteGatewayLog].map((filePath) => ({
          filePath,
          recursive: false
        }))
      : [])
  ];
  const validatedTargets = deletionTargets.map(({ filePath, recursive }) => ({
    filePath: cleanTargetPath(dataRoot, filePath),
    recursive
  }));
  await Promise.all(validatedTargets.map(({ filePath, recursive }) =>
    rm(filePath, { recursive, force: true })
  ));
  await ensureDataLayout(dataRoot);
  console.log(
    `cleaned ordinary user data in ${dataRoot}; preserved ${preservedPairCount} remote pairing${preservedPairCount === 1 ? "" : "s"}.`
  );
  console.log(
    "To remove the installation identity and all pairings, use Reset identity in local Settings → Remote Access. The POST /api/remote-access/reset flow is local-only."
  );
  return 0;
}

function reportCleanDaemonRefusal(state: {
  running: Array<{ label: string; pid: number }>;
  error?: string;
}): boolean {
  if (state.error) {
    console.error(`clean refused: ${state.error}`);
    return true;
  }
  if (state.running.length > 0) {
    console.error(
      `clean refused: stop the running ${state.running.map((entry) => `${entry.label} (pid ${entry.pid})`).join(", ")} first.`
    );
    return true;
  }
  return false;
}

const CleanPidStateSchema = z.object({
  pid: z.number().int().positive()
}).passthrough();

async function inspectCleanDaemonState(
  dataRoot: string,
  processAlive: (pid: number) => boolean
): Promise<{
  running: Array<{ label: string; pid: number }>;
  error?: string;
}> {
  const paths = remoteStatePaths(dataRoot);
  const candidates = [
    { label: "host daemon", filePath: paths.backendPid },
    { label: "host remote helper", filePath: paths.hostRuntimePid },
    { label: "remote gateway", filePath: paths.remoteGatewayRuntimePid }
  ];
  const running: Array<{ label: string; pid: number }> = [];
  for (const candidate of candidates) {
    let value: unknown;
    try {
      const info = await lstat(candidate.filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("PID state is not a regular file.");
      }
      const raw = await readFile(candidate.filePath, "utf8");
      value = JSON.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        running,
        error: `cannot verify ${candidate.label} state at ${candidate.filePath}; no files were changed.`
      };
    }
    const parsed = CleanPidStateSchema.safeParse(value);
    if (!parsed.success) {
      return {
        running,
        error: `cannot verify ${candidate.label} PID state at ${candidate.filePath}; no files were changed.`
      };
    }
    try {
      if (processAlive(parsed.data.pid)) {
        running.push({ label: candidate.label, pid: parsed.data.pid });
      }
    } catch {
      return {
        running,
        error: `cannot verify whether ${candidate.label} pid ${parsed.data.pid} is stopped; no files were changed.`
      };
    }
  }
  return { running };
}

async function validatePreservedRemoteStateForClean(dataRoot: string): Promise<number> {
  const paths = remoteStatePaths(dataRoot);
  for (const directory of [
    paths.hostStateRoot,
    paths.trustRoot,
    paths.operationsRoot,
    paths.auditRoot,
    paths.remoteGatewayStateRoot
  ]) {
    await assertOptionalOwnedDirectory(directory);
  }
  const [config, installation, trustIndex, rememberedHosts] = await Promise.all([
    readOptionalJson(paths.hostConfig),
    readOptionalJson(paths.installation),
    readOptionalJson(paths.trustIndex),
    inspectRememberedHostState(dataRoot)
  ]);
  if (config === undefined && installation === undefined && trustIndex === undefined) {
    const [trustEntries, gatewayEntries] = await Promise.all([
      readDirectoryOrEmpty(paths.trustRoot),
      readDirectoryOrEmpty(paths.remoteGatewayStateRoot)
    ]);
    if (trustEntries.length > 0 || gatewayEntries.length > 0 || rememberedHosts.exists) {
      throw new Error("remote trust metadata exists without its installation state; repair it before cleaning.");
    }
    return 0;
  }
  if (config === undefined || installation === undefined || trustIndex === undefined) {
    throw new Error("preserved remote installation state is incomplete; repair it before cleaning.");
  }
  RemoteAccessConfigV1Schema.parse(config);
  RemoteAccessInstallationStateV1Schema.parse(installation);
  return RemoteAccessTrustIndexV1Schema.parse(trustIndex).pairs.length + rememberedHosts.hostCount;
}

function cleanTargetPath(dataRoot: string, filePath: string): string {
  const root = path.resolve(dataRoot);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`clean target escapes the canonical data root: ${filePath}`);
  }
  return target;
}

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`preserved remote state is not an owned regular file: ${filePath}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`preserved remote state has the wrong owner: ${filePath}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`preserved remote state permissions are too broad: ${filePath}`);
    }
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readDirectoryOrEmpty(directory: string): Promise<string[]> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`preserved remote state is not an owned directory: ${directory}`);
    }
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function assertOptionalOwnedDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`preserved remote state is not an owned directory: ${directory}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`preserved remote state directory has the wrong owner: ${directory}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`preserved remote state directory permissions are too broad: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
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
  const installArgs = ["install", "-g", UPDATE_PACKAGE_SPEC, "--force"];

  console.log(`Updating ${UPDATE_PACKAGE_NAME} from npm...`);
  const code = await installAndRelinkAfterLegacyCleanup(npm, installArgs, runner, options);
  if (code !== 0) {
    console.error(`Failed to update ${UPDATE_PACKAGE_NAME}; npm exited with code ${code}.`);
    return code;
  }
  console.log(`Updated ${UPDATE_PACKAGE_NAME} globally. Restart any running waifus backend to use the new version.`);
  return 0;
}

async function updateGithubReleasePackage(runner: CliProcessRunner, options: CliRuntimeOptions): Promise<number> {
  const fetchRelease = options.githubReleaseFetcher ?? fetchLatestGithubRelease;
  console.log(`Checking latest GitHub release for ${UPDATE_PACKAGE_NAME}...`);
  const release = await fetchRelease();
  const asset = selectGithubReleaseTarball(release);
  if (!asset) {
    console.error(
      `Latest GitHub release does not include a ${GITHUB_RELEASE_TARBALL_PACKAGES.map(npmPackTarballPrefix).join("*.tgz or ")}*.tgz asset.`
    );
    return 1;
  }

  const npm = npmCommand(options.platform ?? process.platform);
  const label = release.tag_name ? ` ${release.tag_name}` : "";
  const installArgs = ["install", "-g", asset.browser_download_url, "--force"];
  console.log(`Updating ${UPDATE_PACKAGE_NAME} from GitHub release${label}...`);
  const code = await installAndRelinkAfterLegacyCleanup(npm, installArgs, runner, options);
  if (code !== 0) {
    console.error(`Failed to update ${UPDATE_PACKAGE_NAME}; npm exited with code ${code}.`);
    return code;
  }
  console.log(`Updated ${UPDATE_PACKAGE_NAME} from GitHub release. Restart any running waifus backend to use the new version.`);
  return 0;
}

async function installAndRelinkAfterLegacyCleanup(
  npm: string,
  installArgs: string[],
  runner: CliProcessRunner,
  options: CliRuntimeOptions
): Promise<number> {
  const env = options.env ?? process.env;
  const installCode = await runner.run(npm, installArgs, { env });
  if (installCode !== 0) {
    return installCode;
  }

  console.log(`Cleaning up legacy ${LEGACY_PACKAGE_NAME} package if present...`);
  const uninstallCode = await runner.run(npm, ["uninstall", "-g", LEGACY_PACKAGE_NAME], { env });
  if (uninstallCode !== 0) {
    return uninstallCode;
  }

  console.log("Relinking the waifus command to the WaifuCave package...");
  return runner.run(npm, installArgs, { env });
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
  for (const packageName of GITHUB_RELEASE_TARBALL_PACKAGES) {
    const asset = selectPackageTarball(release, packageName);
    if (asset) {
      return asset;
    }
  }
  return undefined;
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

// status/stop only need the pid (plus, for status, a couple of display fields) out of
// runtime.json/pid.json — they never migrate anything. Loosen just the schemaVersion check
// (any non-negative integer, not literally CURRENT_SCHEMA_VERSION) so a stale runtime/pid file
// left on disk by a pre-upgrade process doesn't crash `waifus status`/`waifus stop`. The strict
// literal in RuntimeStateSchema itself is untouched — it still governs every write.
const RuntimeStateReadSchema = RuntimeStateSchema.extend({
  schemaVersion: z.number().int().nonnegative()
});

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
    const runtime = await readProcessState(
      appDataPath(dataRoot, "runtime.json"),
      RuntimeStateReadSchema
    );
    if (runtime?.pid === pid && processIsAlive(pid)) {
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
