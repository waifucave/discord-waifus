import type { RemoteRequestPrincipal } from "../../api/requestPrincipal.js";
import { isLoopbackAddress } from "../../api/requestPrincipal.js";
import type { RemoteRequestBridge } from "./requestBridge.js";
import type { RuntimeState } from "../runtime.js";
import {
  RemoteAccessErrorCodeSchema,
  type RemoteAccessErrorCode
} from "../../shared/schemas/remoteLifecycle.js";
import {
  RemoteAccessRuntimeSummarySchema,
  type RemoteAccessRuntimeSummary
} from "../runtime.js";
import type { HelperSupervisorSnapshot } from "../../remote/helperTypes.js";
import { RemoteAccessEvents } from "./events.js";
import { RemoteAccessStateStore, type RemoteAccessPersistedState } from "./stateStore.js";

export type HelperSupervisorController = {
  snapshot: () => HelperSupervisorSnapshot;
  subscribe: (listener: (snapshot: HelperSupervisorSnapshot) => void) => () => void;
  start: () => Promise<void>;
  reconnect: () => Promise<void>;
  close: () => Promise<void>;
};

export type ResolvedRemoteDashboard = {
  readonly path: string;
  readonly source: "bundled" | "custom";
  readonly buildId: string;
};

export type RemoteAccessServiceOptions = {
  dataRoot: string;
  runtime: RuntimeState;
  effectiveHost: string;
  dashboard: ResolvedRemoteDashboard;
  supervisor: HelperSupervisorController;
  stateStore?: RemoteAccessStateStore;
  resolveHost?: (host: string) => Promise<readonly string[]>;
};

function inactiveSummary(
  state: RemoteAccessPersistedState
): RemoteAccessRuntimeSummary {
  return RemoteAccessRuntimeSummarySchema.parse({
    version: 1,
    enabled: false,
    helperState: "disabled",
    activationState: state.installation.activationReference === null
      ? "activation_required"
      : "active",
    controlState: "inactive",
    directState: "inactive",
    trustedDeviceCount: state.trustIndex.pairs.length,
    lastDirectAt: null,
    lastErrorCode: null
  });
}

function failedSummary(
  state: RemoteAccessPersistedState,
  errorCode: RemoteAccessErrorCode
): RemoteAccessRuntimeSummary {
  return RemoteAccessRuntimeSummarySchema.parse({
    version: 1,
    enabled: true,
    helperState: "failed",
    activationState: state.installation.activationReference === null
      ? "activation_required"
      : "active",
    controlState: "unavailable",
    directState: "direct_unavailable",
    trustedDeviceCount: state.trustIndex.pairs.length,
    lastDirectAt: null,
    lastErrorCode: errorCode
  });
}

function repairRequiredSummary(): RemoteAccessRuntimeSummary {
  return RemoteAccessRuntimeSummarySchema.parse({
    version: 1,
    enabled: false,
    helperState: "disabled",
    activationState: "activation_required",
    controlState: "inactive",
    directState: "inactive",
    trustedDeviceCount: 0,
    lastDirectAt: null,
    lastErrorCode: "repair_required"
  });
}

function lifecycleErrorCode(error: unknown): RemoteAccessErrorCode {
  const candidate = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  const parsed = RemoteAccessErrorCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : "helper_unavailable";
}

function snapshotSummary(
  state: RemoteAccessPersistedState,
  snapshot: HelperSupervisorSnapshot
): RemoteAccessRuntimeSummary {
  const runtimeStatus = snapshot.runtimeStatus;
  return RemoteAccessRuntimeSummarySchema.parse({
    version: 1,
    enabled: true,
    helperState: snapshot.state,
    activationState: runtimeStatus.activationState,
    controlState: runtimeStatus.controlState,
    directState: runtimeStatus.directState,
    trustedDeviceCount: state.trustIndex.pairs.length,
    lastDirectAt: runtimeStatus.lastDirectAt,
    lastErrorCode: snapshot.lastErrorCode ?? runtimeStatus.lastErrorCode
  });
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

function canonicalHost(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export class RemoteAccessService {
  readonly #options: RemoteAccessServiceOptions;
  readonly #stateStore: RemoteAccessStateStore;
  readonly #events = new RemoteAccessEvents();
  readonly #resolveHost: (host: string) => Promise<readonly string[]>;
  #state: RemoteAccessPersistedState | undefined;
  #summary: RemoteAccessRuntimeSummary | undefined;
  #unsubscribeSupervisor: (() => void) | undefined;
  #requestBridge: RemoteRequestBridge | undefined;
  #started = false;
  #closed = false;

  constructor(options: RemoteAccessServiceOptions) {
    this.#options = options;
    this.#stateStore = options.stateStore ?? new RemoteAccessStateStore(options.dataRoot);
    this.#resolveHost = options.resolveHost ?? defaultResolveHost;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Remote access service is closed.");
    if (this.#started) return;
    this.#started = true;
    let state: RemoteAccessPersistedState;
    try {
      state = await this.#stateStore.load();
    } catch {
      this.#publish(repairRequiredSummary());
      return;
    }
    this.#state = state;
    if (!state.config.enabled) {
      this.#publish(inactiveSummary(state));
      return;
    }
    if (state.installation.activationReference === null) {
      this.#publish(failedSummary(state, "activation_required"));
      return;
    }
    if (!await this.#effectiveBindIsLoopback()) {
      this.#publish(failedSummary(state, "bind_not_loopback"));
      return;
    }
    if (this.#options.dashboard.source !== "bundled") {
      this.#publish(failedSummary(state, "custom_dashboard_unsupported"));
      return;
    }

    this.#unsubscribeSupervisor = this.#options.supervisor.subscribe((snapshot) => {
      if (!this.#state || this.#closed) return;
      this.#publish(snapshotSummary(this.#state, snapshot));
    });
    try {
      await this.#options.supervisor.start();
    } catch (error) {
      this.#unsubscribeSupervisor?.();
      this.#unsubscribeSupervisor = undefined;
      this.#publish(failedSummary(state, lifecycleErrorCode(error)));
      return;
    }
    this.#publish(snapshotSummary(state, this.#options.supervisor.snapshot()));
  }

  getRuntimeSummary(): RemoteAccessRuntimeSummary {
    if (!this.#summary) throw new Error("Remote access service has not started.");
    return structuredClone(this.#summary);
  }

  subscribe(listener: (summary: RemoteAccessRuntimeSummary) => void): () => void {
    return this.#events.subscribe(listener);
  }

  attachRequestBridge(bridge: RemoteRequestBridge): void {
    if (this.#started || this.#closed) {
      throw new Error("Remote request bridge must be attached before service startup.");
    }
    if (this.#requestBridge && this.#requestBridge !== bridge) {
      throw new Error("Remote request bridge is already attached.");
    }
    this.#requestBridge = bridge;
  }

  async isAuthorized(principal: RemoteRequestPrincipal): Promise<boolean> {
    if (!this.#started || this.#closed || !this.#summary?.enabled) return false;
    return this.#stateStore.isAuthorized(principal.deviceId, principal.trustEpoch);
  }

  async reconnect(): Promise<void> {
    if (!this.#started || this.#closed || !this.#summary?.enabled) {
      throw new Error("Remote access is not active.");
    }
    await this.#options.supervisor.reconnect();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#requestBridge?.close(new Error("Remote access service is stopping."));
    this.#unsubscribeSupervisor?.();
    this.#unsubscribeSupervisor = undefined;
    await this.#options.supervisor.close();
    this.#events.clear();
  }

  async #effectiveBindIsLoopback(): Promise<boolean> {
    const host = canonicalHost(this.#options.effectiveHost.trim().toLowerCase());
    if (isLoopbackAddress(host)) return true;
    let addresses: readonly string[];
    try {
      addresses = await this.#resolveHost(host);
    } catch {
      return false;
    }
    return addresses.length > 0 && addresses.every(isLoopbackAddress);
  }

  #publish(summary: RemoteAccessRuntimeSummary): void {
    const parsed = RemoteAccessRuntimeSummarySchema.parse(summary);
    this.#summary = parsed;
    this.#options.runtime.remoteAccess = structuredClone(parsed);
    this.#options.runtime.updatedAt = new Date().toISOString();
    this.#events.emit(structuredClone(parsed));
  }
}
