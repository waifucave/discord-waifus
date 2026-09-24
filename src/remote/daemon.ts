import path from "node:path";
import { rm } from "node:fs/promises";
import { processIsAlive, readProcessState } from "../cli/processState.js";
import {
  createRemoteDaemonState,
  RemoteDaemonStateSchema,
  type RemoteDaemonState
} from "../shared/schemas/remoteRuntime.js";
import { SemVerSchema } from "../shared/schemas/remoteProtocol.js";
import { startRemoteGatewayApplication, type RunningRemoteGatewayApplication } from "./gateway/application.js";
import { publishRemoteDaemonStartup, publishRemoteDaemonState } from "./daemonState.js";
import type { HelperSupervisor } from "./helperSupervisor.js";
import { remoteRolePaths } from "./paths.js";
import type { RememberedHostRecordV1, RememberedHostStateV1 } from "./rememberedHosts.js";

const DEFAULT_STATUS_REFRESH_MS = 1_000;

export type StartRemoteGatewayDaemonOptions = Readonly<{
  dataRoot: string;
  appVersion: string;
  deviceDisplayName: string;
  supervisor: HelperSupervisor;
  port?: number;
  host?: string;
  statusRefreshMs?: number;
  onStatusError?: (error: unknown) => void;
}>;

export type RunningRemoteGatewayDaemon = Readonly<{
  runtime: RemoteDaemonState;
  bootstrapUrl: string;
  refreshState: () => Promise<RemoteDaemonState>;
  close: () => Promise<void>;
}>;

function selectedHost(state: RememberedHostStateV1): Readonly<{
  selectionState: RemoteDaemonState["selectionState"];
  host: RememberedHostRecordV1 | undefined;
}> {
  if (state.hosts.length === 0) return { selectionState: "no_hosts", host: undefined };
  if (state.explicitSelectedHostId !== null) {
    return {
      selectionState: "explicit",
      host: state.hosts.find((host) => host.hostId === state.explicitSelectedHostId)
    };
  }
  return state.hosts.length === 1
    ? { selectionState: "automatic_single", host: state.hosts[0] }
    : { selectionState: "selection_required", host: undefined };
}

function resolveHostSpecifier(
  state: RememberedHostStateV1,
  specifier: string
): RememberedHostRecordV1 {
  const byId = state.hosts.find((host) => host.hostId === specifier);
  if (byId) return byId;
  const byName = state.hosts.filter((host) => host.displayName === specifier);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error("Remote host name is ambiguous; use its stable host ID.");
  }
  throw new Error("Remote host was not found among remembered hosts.");
}

function stateFingerprint(state: RemoteDaemonState): string {
  return JSON.stringify({ ...state, updatedAt: "" });
}

/** Own the helper, connection shell, initial selection, status file, and shutdown as one daemon. */
export async function startRemoteGatewayDaemon(
  options: StartRemoteGatewayDaemonOptions
): Promise<RunningRemoteGatewayDaemon> {
  const dataRoot = path.resolve(options.dataRoot);
  const appVersion = SemVerSchema.parse(options.appVersion);
  const paths = remoteRolePaths(dataRoot, "remote");
  const previous = await readProcessState(paths.runtimePid, RemoteDaemonStateSchema);
  if (previous && processIsAlive(previous.pid)) {
    throw new Error("A waifus remote gateway is already running for this data root.");
  }
  const refreshMs = options.statusRefreshMs ?? DEFAULT_STATUS_REFRESH_MS;
  if (!Number.isInteger(refreshMs) || refreshMs < 100) {
    throw new TypeError("Remote status refresh interval must be at least 100 ms.");
  }

  let application: RunningRemoteGatewayApplication | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let published = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let refreshTail: Promise<void> = Promise.resolve();
  let runtime: RemoteDaemonState | undefined;
  let initialConnectionPending = true;
  const startedAt = new Date().toISOString();

  const buildRuntimeState = async (running: RunningRemoteGatewayApplication): Promise<RemoteDaemonState> => {
    const remembered = await running.rememberedHosts.getState();
    const selection = selectedHost(remembered);
    const helper = options.supervisor.snapshot();
    return createRemoteDaemonState({
      pid: process.pid,
      startedAt,
      packageVersion: appVersion,
      port: running.shell.port,
      dataRoot,
      mode: "remote",
      connectionShellOrigin: running.shell.origin,
      helperVersion: helper.helperVersion,
      helperReleaseSequence: helper.releaseSequence,
      protocol: helper.protocol ?? { major: 1, minor: 0 },
      capabilities: [...helper.capabilities],
      helperState: helper.state,
      activationState: helper.runtimeStatus.activationState,
      controlState: helper.runtimeStatus.controlState,
      directState: selection.host ? helper.runtimeStatus.directState : "inactive",
      rememberedHostCount: remembered.hosts.length,
      selectionState: selection.selectionState,
      selectedHostId: selection.host?.hostId ?? null,
      lastDirectAt: helper.runtimeStatus.lastDirectAt,
      lastErrorCode: helper.lastErrorCode
    });
  };

  const refresh = async (): Promise<RemoteDaemonState> => {
    if (!application || !runtime || closing) {
      throw new Error("Remote gateway is not running.");
    }
    if (initialConnectionPending) {
      const helper = options.supervisor.snapshot();
      if (helper.state === "ready" && helper.runtimeStatus.activationState !== "activation_required") {
        const selection = selectedHost(await application.rememberedHosts.getState());
        if (selection.host) {
          initialConnectionPending = false;
          if (selection.host.connectionState === "offline") {
            await application.connectRememberedHost(selection.host).catch(() => undefined);
          }
        }
      }
    }
    const next = await buildRuntimeState(application);
    if (stateFingerprint(next) !== stateFingerprint(runtime)) {
      await publishRemoteDaemonState({ dataRoot, runtime: next });
      runtime = next;
    }
    return runtime;
  };

  const queueRefresh = (): Promise<RemoteDaemonState> => {
    const result = refreshTail.then(refresh);
    refreshTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    if (interval) clearInterval(interval);
    unsubscribe?.();
    closePromise = (async () => {
      await refreshTail;
      const results = await Promise.allSettled([
        application?.close(),
        options.supervisor.close()
      ]);
      if (published && runtime) {
        const current = await readProcessState(paths.runtimePid, RemoteDaemonStateSchema);
        if (current?.pid === runtime.pid && current.startedAt === runtime.startedAt) {
          await rm(paths.runtimePid, { force: true });
          await rm(paths.startupHandoff, { force: true });
        }
      }
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return closePromise;
  };

  try {
    await options.supervisor.start();
    application = await startRemoteGatewayApplication({
      dataRoot,
      appVersion,
      deviceDisplayName: options.deviceDisplayName,
      supervisor: options.supervisor,
      ...(options.port === undefined ? {} : { port: options.port })
    });
    const remembered = await application.rememberedHosts.getState();
    const explicit = options.host === undefined
      ? undefined
      : resolveHostSpecifier(remembered, options.host);
    if (explicit) await application.rememberedHosts.select(explicit.hostId);
    const selected = explicit ?? selectedHost(await application.rememberedHosts.getState()).host;
    const helper = options.supervisor.snapshot();
    if (
      selected
      && helper.state === "ready"
      && helper.runtimeStatus.activationState !== "activation_required"
    ) {
      initialConnectionPending = false;
      // A temporarily unreachable host must not make the local activation/selection shell disappear.
      await application.connectRememberedHost(selected).catch(() => undefined);
    }
    runtime = await buildRuntimeState(application);
    const bootstrapUrl = application.shell.bootstrapUrl;
    published = true;
    await publishRemoteDaemonStartup({ dataRoot, runtime, bootstrapUrl });
    unsubscribe = options.supervisor.subscribe(() => {
      void queueRefresh().catch((error) => options.onStatusError?.(error));
    });
    interval = setInterval(() => {
      void queueRefresh().catch((error) => options.onStatusError?.(error));
    }, refreshMs);
    interval.unref();
    return Object.freeze({
      runtime,
      bootstrapUrl,
      refreshState: queueRefresh,
      close
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
