import type { HelperSupervisor } from "../helperSupervisor.js";
import { DashboardCache } from "../dashboardCache.js";
import type { DashboardRemoteClient } from "../dashboardDownloader.js";
import { RememberedHostStore, type RememberedHostRecordV1 } from "../rememberedHosts.js";
import { createRemoteHelperBackend } from "./helperBackend.js";
import { startRemoteDashboardFrameShell } from "./frameShell.js";
import { RemoteLocalApi, type RemoteGatewayLocalBackend } from "./localApi.js";
import {
  RemoteOriginStore,
  deriveConnectionShellHostname
} from "./originStore.js";
import { startRemoteGatewayRuntime } from "./runtime.js";
import { RemoteSelectedHostGateway } from "./selectedHost.js";
import { startRemoteGateway, type RunningRemoteGateway } from "./server.js";

type SelectedGateway = Readonly<{
  hostId: string;
  trustEpoch: string;
  dashboard: RunningRemoteGateway;
  frameShell: RunningRemoteGateway;
}>;

export type StartRemoteGatewayApplicationOptions = Readonly<{
  dataRoot: string;
  appVersion: string;
  deviceDisplayName: string;
  supervisor: HelperSupervisor;
  port?: number;
}>;

export type RunningRemoteGatewayApplication = Readonly<{
  shell: RunningRemoteGateway;
  rememberedHosts: RememberedHostStore;
  connectRememberedHost: (host: RememberedHostRecordV1) => Promise<void>;
  close: () => Promise<void>;
}>;

function selectedHostClient(supervisor: HelperSupervisor): DashboardRemoteClient {
  const snapshot = supervisor.snapshot();
  if (!snapshot.helperVersion || !snapshot.protocol || snapshot.state !== "ready") {
    throw new Error("A verified remote helper is required for selected-host requests.");
  }
  return Object.freeze({
    hello: Object.freeze({ componentVersion: snapshot.helperVersion }),
    negotiatedProtocol: snapshot.protocol,
    negotiatedCapabilities: snapshot.capabilities,
    request: (input) => supervisor.request(input)
  });
}

/** Start the protected local shell; host assets/API are exposed only on a selected direct path. */
export async function startRemoteGatewayApplication(
  options: StartRemoteGatewayApplicationOptions
): Promise<RunningRemoteGatewayApplication> {
  const origins = new RemoteOriginStore(options.dataRoot);
  const rememberedHosts = new RememberedHostStore(options.dataRoot);
  const originState = await origins.getState();
  const hostname = deriveConnectionShellHostname(
    Buffer.from(originState.localOriginSeed, "base64url")
  );
  const helperBackend = createRemoteHelperBackend({
    supervisor: options.supervisor,
    appVersion: options.appVersion,
    deviceDisplayName: options.deviceDisplayName
  });
  let shell!: RunningRemoteGateway;
  let localApi!: RemoteLocalApi;
  let selected: SelectedGateway | undefined;
  let selectionTail: Promise<void> = Promise.resolve();
  let runtimeHostKey: Readonly<{ hostId: string; trustEpoch: string }> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const serializeSelection = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = selectionTail.then(operation);
    selectionTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const closeSelected = async (): Promise<void> => {
    const current = selected;
    selected = undefined;
    if (!current) return;
    await Promise.all([current.frameShell.close(), current.dashboard.close()]);
  };

  const openSelected = (host: RememberedHostRecordV1): Promise<string> => serializeSelection(
    async () => {
      if (closing) throw new Error("Remote gateway is closing.");
      if (
        runtimeHostKey?.hostId !== host.hostId
        || runtimeHostKey.trustEpoch !== host.trustEpoch
        || options.supervisor.snapshot().runtimeStatus.directState !== "direct"
      ) {
        throw new Error("The selected host does not own the direct helper runtime.");
      }
      if (selected?.hostId === host.hostId && selected.trustEpoch === host.trustEpoch) {
        return selected.frameShell.issueBootstrapUrl();
      }
      await closeSelected();
      const client = selectedHostClient(options.supervisor);
      let dashboardHandler: RemoteSelectedHostGateway | undefined;
      let frameShellOrigin: string | undefined;
      const dashboard = await startRemoteGatewayRuntime({
        dataRoot: options.dataRoot,
        pinnedHostId: host.hostId,
        hostTrustEpoch: host.trustEpoch,
        surface: "dashboard",
        frameAncestorOrigin: () => frameShellOrigin,
        registerGatewayLaunch: (gatewayLaunchId, expiresAt) => (
          options.supervisor.registerGatewayLaunch(gatewayLaunchId, expiresAt)
        ),
        handleAuthenticatedRequest: (...args) => {
          if (!dashboardHandler) throw new Error("Selected-host dashboard is not ready.");
          return dashboardHandler.handle(...args);
        }
      });
      let frameShell: RunningRemoteGateway | undefined;
      try {
        frameShell = await startRemoteDashboardFrameShell({ dashboard });
        frameShellOrigin = frameShell.origin;
        dashboardHandler = new RemoteSelectedHostGateway({
          cache: new DashboardCache({ dataRoot: options.dataRoot }),
          client,
          hostKey: { hostId: host.hostId, trustEpoch: host.trustEpoch },
          remoteGatewayVersion: options.appVersion,
          connectionShellOrigin: shell.origin,
          localOrigin: dashboard.origin,
          connectionState: () => {
            const state = options.supervisor.snapshot().runtimeStatus.directState;
            return state === "inactive" ? "direct_unavailable" : state;
          }
        });
      } catch (error) {
        await Promise.allSettled([frameShell?.close(), dashboard.close()]);
        throw error;
      }
      const result: SelectedGateway = Object.freeze({
        hostId: host.hostId,
        trustEpoch: host.trustEpoch,
        dashboard,
        frameShell
      });
      if (
        closing
        || runtimeHostKey?.hostId !== host.hostId
        || runtimeHostKey.trustEpoch !== host.trustEpoch
        || options.supervisor.snapshot().runtimeStatus.directState !== "direct"
      ) {
        await Promise.allSettled([result.frameShell.close(), result.dashboard.close()]);
        throw new Error("Selected host changed while opening its dashboard.");
      }
      selected = result;
      return result.frameShell.issueBootstrapUrl();
    }
  );

  const backend: RemoteGatewayLocalBackend = {
    ...helperBackend,
    connectRememberedHost: async (host) => {
      if (closing) throw new Error("Remote gateway is closing.");
      runtimeHostKey = undefined;
      await serializeSelection(async () => {
        await closeSelected();
        await helperBackend.connectRememberedHost(host);
        runtimeHostKey = { hostId: host.hostId, trustEpoch: host.trustEpoch };
      });
    },
    disconnectRememberedHost: async (host) => {
      if (closing) throw new Error("Remote gateway is closing.");
      if (runtimeHostKey?.hostId === host.hostId) runtimeHostKey = undefined;
      await serializeSelection(async () => {
        if (selected?.hostId === host.hostId) await closeSelected();
        await helperBackend.disconnectRememberedHost(host);
      });
    },
    requestSignedSelfRevocation: async (host) => {
      if (closing) throw new Error("Remote gateway is closing.");
      if (runtimeHostKey?.hostId === host.hostId) runtimeHostKey = undefined;
      return serializeSelection(async () => {
        if (selected?.hostId === host.hostId) await closeSelected();
        return helperBackend.requestSignedSelfRevocation(host);
      });
    },
    forgetRememberedHost: async (host) => {
      if (closing) throw new Error("Remote gateway is closing.");
      if (runtimeHostKey?.hostId === host.hostId) runtimeHostKey = undefined;
      await serializeSelection(async () => {
        if (selected?.hostId === host.hostId) await closeSelected();
        await helperBackend.forgetRememberedHost(host);
      });
    }
  };

  shell = await startRemoteGateway({
    hostname,
    port: options.port ?? 0,
    surface: "shell",
    handleAuthenticatedRequest: (...args) => {
      if (!localApi) throw new Error("Remote connection shell is not ready.");
      return localApi.handle(...args);
    }
  });
  localApi = new RemoteLocalApi({
    backend,
    rememberedHosts,
    origins,
    issueSelectedHostBootstrap: openSelected
  });

  return Object.freeze({
    shell,
    rememberedHosts,
    connectRememberedHost: async (host: RememberedHostRecordV1) => {
      if (closing) throw new Error("Remote gateway is closing.");
      await backend.connectRememberedHost(host);
      await rememberedHosts.updateConnection(host.hostId, "reconnecting", null, null);
    },
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      runtimeHostKey = undefined;
      closePromise = (async () => {
        const results = await Promise.allSettled([shell.close(), localApi.close()]);
        await selectionTail;
        await closeSelected();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return closePromise;
    }
  });
}
