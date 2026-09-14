import { spawn, type SpawnOptions } from "node:child_process";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { ensureRemoteOnlyLayout } from "../config/layout.js";
import { FullPairTokenSchema } from "../shared/schemas/remoteLifecycle.js";
import {
  RemoteDaemonStateSchema,
  type RemoteDaemonState
} from "../shared/schemas/remoteRuntime.js";
import { remoteRolePaths } from "../remote/paths.js";
import { flagBoolean, flagString, type ParsedCli } from "./parser.js";
import { openBrowser } from "./openBrowser.js";
import {
  processIsAlive,
  readProcessState,
  stopDaemonProcess,
  type StopDaemonResult
} from "./processState.js";

const REMOTE_START_TIMEOUT_MS = 30_000;
const BootstrapHandoffSchema = z.object({
  runtime: RemoteDaemonStateSchema,
  bootstrapUrl: z.string().url()
}).strict();
const RemoteDaemonStateReadSchema = RemoteDaemonStateSchema;

export type RemoteDetachedChild = {
  readonly pid?: number;
  unref(): void;
};

export type RemoteDetachedSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions
) => RemoteDetachedChild;

export type RunningRemoteCliDaemon = Readonly<{
  runtime: RemoteDaemonState;
  bootstrapUrl: string;
  close: () => Promise<void>;
}>;

export type RemoteCliOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly argv?: string[];
  readonly execPath?: string;
  readonly cwd?: string;
  readonly detachedSpawner?: RemoteDetachedSpawner;
  readonly processAlive?: (pid: number) => boolean;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForProcessExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  readonly remotePreflight?: (input: Readonly<{
    dataRoot: string;
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
  }>) => void | Promise<void>;
  readonly remoteForegroundStarter?: (input: Readonly<{
    dataRoot: string;
    port?: number;
    host?: string;
  }>) => Promise<RunningRemoteCliDaemon>;
  readonly remoteStartWaiter?: (
    dataRoot: string,
    pid: number,
    timeoutMs: number,
    child: RemoteDetachedChild
  ) => Promise<Readonly<{ runtime: RemoteDaemonState; bootstrapUrl: string }> | undefined>;
  readonly remoteHoldOpen?: () => Promise<void>;
  readonly browserOpener?: (url: string) => void | Promise<void>;
};

export type RemoteDaemonStatus = Readonly<{
  running: boolean;
  pid?: number;
  url?: string;
  runtime?: RemoteDaemonState;
}>;

class RemoteCliError extends Error {}

function parsePort(parsed: ParsedCli): number | undefined {
  const raw = flagString(parsed.flags, "port");
  if (raw === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(raw)) {
    throw new RemoteCliError("Remote gateway port must be an integer from 0 through 65535.");
  }
  const port = Number(raw);
  if (port > 65_535) {
    throw new RemoteCliError("Remote gateway port must be an integer from 0 through 65535.");
  }
  return port;
}

function validateHandoff(
  value: Readonly<{ runtime: RemoteDaemonState; bootstrapUrl: string }>,
  expectedPid: number
): Readonly<{ runtime: RemoteDaemonState; bootstrapUrl: string }> {
  const parsed = BootstrapHandoffSchema.parse(value);
  const url = new URL(parsed.bootstrapUrl);
  if (
    parsed.runtime.pid !== expectedPid
    || url.origin !== parsed.runtime.connectionShellOrigin
    || !/^\/_waifus_remote\/bootstrap\/[A-Za-z0-9_-]{43}$/u.test(url.pathname)
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new RemoteCliError("Remote daemon startup handoff is invalid.");
  }
  return parsed;
}

async function defaultPreflight(input: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): Promise<void> {
  if (input.platform === "darwin" && input.arch === "x64") {
    throw new RemoteCliError(
      "Intel macOS remote mode is not supported yet; this is a planned follow-up."
    );
  }
  throw new RemoteCliError(
    "A verified ts-connect helper package is not installed for this platform. Run `waifus doctor` for details."
  );
}

function remoteChildArgs(parsed: ParsedCli, dataRoot: string): string[] {
  const args = ["remote", "--foreground", "--no-open", "--data-root", dataRoot];
  const host = flagString(parsed.flags, "host");
  const port = flagString(parsed.flags, "port");
  if (host) args.push("--host", host);
  if (port) args.push("--port", port);
  return args;
}

function positionalError(parsed: ParsedCli): string | undefined {
  const values = [
    ...parsed.positional,
    ...Object.values(parsed.flags).filter((value): value is string => typeof value === "string")
  ];
  if (values.some(containsFullPairToken)) {
    return "Do not pass pairing tokens on the command line; paste pairing tokens into the protected local connection shell.";
  }
  if (parsed.positional.length === 0) return undefined;
  return `unknown remote action: ${parsed.positional[0]}`;
}

function containsFullPairToken(value: string): boolean {
  for (const match of value.matchAll(/WF1\.[A-Za-z0-9_-]+/gu)) {
    if (FullPairTokenSchema.safeParse(match[0]).success) return true;
  }
  return false;
}

export async function runRemoteCommand(
  parsed: ParsedCli,
  dataRoot: string,
  options: RemoteCliOptions = {}
): Promise<number> {
  const invalid = positionalError(parsed);
  if (invalid) {
    console.error(invalid);
    return 1;
  }
  if (parsed.remoteAction === "status") return remoteStatus(dataRoot, options);
  if (parsed.remoteAction === "stop") return remoteStop(dataRoot, options);
  try {
    parsePort(parsed);
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    await (options.remotePreflight ?? defaultPreflight)({ dataRoot, platform, arch });
    await ensureRemoteOnlyLayout(dataRoot);
    return flagBoolean(parsed.flags, "foreground")
      ? await remoteForeground(parsed, dataRoot, options)
      : await remoteDetached(parsed, dataRoot, options);
  } catch (error) {
    console.error(remoteStartErrorMessage(error));
    return 1;
  }
}

function remoteStartErrorMessage(error: unknown): string {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "helper_missing") {
    return "A verified ts-connect helper package is not installed for this platform. Run `waifus doctor` for details.";
  }
  if (code === "helper_signature_invalid") {
    return "The installed ts-connect helper failed signature verification. Run `waifus doctor` for details.";
  }
  if (code === "helper_incompatible") {
    return "The installed ts-connect helper is incompatible with this Waifus version. Run `waifus doctor` for details.";
  }
  return error instanceof Error ? error.message : "Remote gateway failed to start.";
}

async function remoteDetached(
  parsed: ParsedCli,
  dataRoot: string,
  options: RemoteCliOptions
): Promise<number> {
  const paths = remoteRolePaths(dataRoot, "remote");
  const isAlive = options.processAlive ?? processIsAlive;
  const existing = await readProcessState(paths.runtimePid, RemoteDaemonStateReadSchema);
  if (existing && isAlive(existing.pid)) {
    console.log(`waifus remote gateway already running at ${existing.connectionShellOrigin}`);
    console.log("Use `waifus remote stop` before restarting if a new browser session is needed.");
    return 0;
  }
  if (existing) await rm(paths.runtimePid, { force: true });

  const entrypoint = (options.argv ?? process.argv)[1];
  if (!entrypoint) throw new RemoteCliError("Cannot locate waifus CLI entrypoint for remote start.");
  const spawner = options.detachedSpawner ?? spawn;
  const child = spawner(
    options.execPath ?? process.execPath,
    [entrypoint, ...remoteChildArgs(parsed, dataRoot)],
    {
      cwd: options.cwd ?? process.cwd(),
      detached: true,
      env: options.env ?? process.env,
      stdio: "ignore"
    }
  );
  child.unref();
  if (!child.pid) throw new RemoteCliError("Failed to spawn detached waifus remote gateway.");
  const handoff = await (options.remoteStartWaiter ?? waitForRemoteStart)(
    dataRoot,
    child.pid,
    REMOTE_START_TIMEOUT_MS,
    child
  );
  if (!handoff) {
    if (isAlive(child.pid)) {
      console.error(`waifus remote gateway is still starting after 30s; spawned pid ${child.pid}`);
    } else {
      console.error(`waifus remote gateway did not start within 30s; spawned pid ${child.pid} exited`);
    }
    console.error(`logs: ${paths.log}`);
    return 1;
  }
  const ready = validateHandoff(handoff, child.pid);
  console.log(`waifus remote gateway running at ${ready.runtime.connectionShellOrigin}`);
  console.log(`data root: ${dataRoot}`);
  if (!flagBoolean(parsed.flags, "noOpen")) {
    await (options.browserOpener ?? openBrowser)(ready.bootstrapUrl);
  } else {
    console.log(ready.bootstrapUrl);
  }
  return 0;
}

async function remoteForeground(
  parsed: ParsedCli,
  dataRoot: string,
  options: RemoteCliOptions
): Promise<number> {
  const starter = options.remoteForegroundStarter ?? (async () => {
    throw new RemoteCliError(
      "Remote gateway runtime is unavailable without a verified ts-connect helper."
    );
  });
  const running = await starter({
    dataRoot,
    port: parsePort(parsed),
    ...(flagString(parsed.flags, "host") ? { host: flagString(parsed.flags, "host") } : {})
  });
  const ready = validateHandoff({
    runtime: running.runtime,
    bootstrapUrl: running.bootstrapUrl
  }, process.pid);
  console.log(`waifus remote gateway running at ${ready.runtime.connectionShellOrigin}`);
  console.log(`data root: ${dataRoot}`);
  if (!flagBoolean(parsed.flags, "noOpen")) {
    await (options.browserOpener ?? openBrowser)(ready.bootstrapUrl);
  } else {
    console.log(ready.bootstrapUrl);
  }
  if (!options.remoteHoldOpen) {
    const shutdown = async () => {
      await running.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  await (options.remoteHoldOpen ?? (() => new Promise<void>(() => undefined)))();
  return 0;
}

async function remoteStatus(dataRoot: string, options: RemoteCliOptions): Promise<number> {
  const status = await readRemoteDaemonStatus(dataRoot, options.processAlive);
  console.log(JSON.stringify({ ...status, dataRoot }, null, 2));
  return status.running ? 0 : 1;
}

export async function readRemoteDaemonStatus(
  dataRoot: string,
  isAlive: (pid: number) => boolean = processIsAlive
): Promise<RemoteDaemonStatus> {
  const paths = remoteRolePaths(dataRoot, "remote");
  const [runtime, pidState] = await Promise.all([
    readProcessState(paths.runtimeState, RemoteDaemonStateReadSchema),
    readProcessState(paths.runtimePid, RemoteDaemonStateReadSchema)
  ]);
  const running = pidState ? isAlive(pidState.pid) : false;
  return Object.freeze({
    running,
    pid: pidState?.pid,
    url: runtime?.connectionShellOrigin,
    runtime
  });
}

async function remoteStop(dataRoot: string, options: RemoteCliOptions): Promise<number> {
  const paths = remoteRolePaths(dataRoot, "remote");
  const result = await stopDaemonProcess({
    pidFile: paths.runtimePid,
    schema: RemoteDaemonStateReadSchema,
    isAlive: options.processAlive,
    kill: options.killProcess,
    waitForExit: options.waitForProcessExit
  });
  reportStop(result);
  return result.state === "still_running" ? 1 : 0;
}

function reportStop(result: StopDaemonResult): void {
  if (result.state === "absent") console.log("waifus remote gateway is not running: no pid file found");
  if (result.state === "stale_removed") {
    console.log(`waifus remote gateway is not running: stale pid ${result.pid} removed`);
  }
  if (result.state === "stopped") console.log(`stopped waifus remote gateway pid ${result.pid}`);
  if (result.state === "still_running") console.error(`remote gateway pid ${result.pid} is still alive`);
}

async function waitForRemoteStart(): Promise<undefined> {
  return undefined;
}
