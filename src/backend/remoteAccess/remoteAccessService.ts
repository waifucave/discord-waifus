import { randomBytes } from "node:crypto";
import type { RemoteRequestPrincipal } from "../../api/requestPrincipal.js";
import { isLoopbackAddress } from "../../api/requestPrincipal.js";
import type { RemoteRequestBridge } from "./requestBridge.js";
import type { RuntimeState } from "../runtime.js";
import {
  ACTIVATION_CHALLENGE_LIFETIME_SECONDS,
  ActivationOperationIdSchema,
  ActivationStartResultSchema,
  ActivationStatusSchema,
  ApprovePairingInputV1Schema,
  PairInvitationV1Schema,
  PendingPairingRequestListV1Schema,
  RenameTrustedDeviceInputV1Schema,
  RevokeTrustedDeviceInputV1Schema,
  TrustedDeviceListV1Schema,
  TrustedDeviceSummaryV1Schema,
  type ApprovePairingInputV1,
  type PairInvitationV1,
  type PendingPairingRequestListV1,
  RemoteAccessDiagnosticsV1Schema,
  RemoteAccessErrorCodeSchema,
  RemoteAccessStatusV1Schema,
  type RenameTrustedDeviceInputV1,
  type RevokeTrustedDeviceInputV1,
  type TrustedDeviceListV1,
  type TrustedDeviceSummaryV1,
  UpdateRemoteAccessInputV1Schema,
  type ActivationStartResult,
  type ActivationStatus,
  type RemoteAccessConfigV1,
  type RemoteAccessDiagnosticsV1,
  type RemoteAccessStatusV1,
  type RemoteAccessErrorCode
} from "../../shared/schemas/remoteLifecycle.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  DeviceIdSchema
} from "../../shared/schemas/remoteProtocol.js";
import {
  GetResetStatusCommandSchema,
  IdentityResetReceiptV1Schema,
  ResetIdentityCommandSchema,
  type GetResetStatusCommand,
  type IdentityResetReceiptV1,
  type ResetIdentityCommand
} from "../../shared/schemas/remoteAccess.js";
import {
  RemoteAccessRuntimeSummarySchema,
  type RemoteAccessRuntimeSummary
} from "../runtime.js";
import {
  HelperCommandError,
  HelperConfirmedAdminActorSchema,
  HelperDeviceRevocationRecoverySchema,
  HelperRequestActorSchema,
  HelperSupervisorError,
  type HelperActivationCancel,
  type HelperActivationPoll,
  type HelperActivationStart,
  type HelperIdentityStatus,
  type HelperConfirmedAdminActor,
  type HelperDeviceRevocationRecovery,
  type HelperRequestActor,
  type HelperSupervisorSnapshot
} from "../../remote/helperTypes.js";
import { RemoteAccessEvents } from "./events.js";
import {
  RemoteAccessInvalidations,
  RemoteAccessInvalidationV1Schema,
  type RemoteAccessInvalidationListener
} from "./invalidation.js";
import {
  IdentityResetState,
  IdentityResetStateError,
  type IdentityResetTombstoneV1
} from "./identityResetState.js";
import {
  RemoteAccessRevisionConflictError,
  RemoteAccessStateStore,
  type RemoteAccessPersistedState
} from "./stateStore.js";

const MAX_PENDING_ACTIVATIONS = 16;
const MAX_RETAINED_ACTIVATIONS = 128;
const TERMINAL_ACTIVATION_RETENTION_SECONDS = 600n;

export type HelperSupervisorController = {
  snapshot: () => HelperSupervisorSnapshot;
  identityStatus: () => HelperIdentityStatus | null;
  subscribe: (listener: (snapshot: HelperSupervisorSnapshot) => void) => () => void;
  attachRequestBridge: (bridge: RemoteRequestBridge) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reconnect: () => Promise<void>;
  startRuntime: (selectedPairId?: string) => Promise<HelperSupervisorSnapshot["runtimeStatus"]>;
  runtimeStatus: () => Promise<HelperSupervisorSnapshot["runtimeStatus"]>;
  reconnectRuntime: () => Promise<HelperSupervisorSnapshot["runtimeStatus"]>;
  stopRuntime: () => Promise<HelperSupervisorSnapshot["runtimeStatus"]>;
  registerGatewayLaunch: (gatewayLaunchId: string, expiresAt: string) => Promise<void>;
  beginActivation: (operationId: string) => Promise<HelperActivationStart>;
  pollActivation: (operationId: string) => Promise<HelperActivationPoll>;
  cancelActivation: (operationId: string) => Promise<HelperActivationCancel>;
  createInvitation?: (
    actor: ConfirmedAdminActor,
    idempotencyKey: string
  ) => Promise<PairInvitationV1>;
  cancelInvitation?: (invitationId: string, actor: ConfirmedAdminActor) => Promise<void>;
  listPairingRequests?: (
    actor: RemoteAccessRequestActor
  ) => Promise<PendingPairingRequestListV1>;
  approvePairingRequest?: (
    requestId: string,
    input: ApprovePairingInputV1,
    actor: ConfirmedAdminActor
  ) => Promise<void>;
  rejectPairingRequest?: (
    requestId: string,
    actor: RemoteAccessRequestActor
  ) => Promise<void>;
  listDevices?: () => Promise<TrustedDeviceListV1>;
  renameDevice?: (
    deviceId: string,
    input: RenameTrustedDeviceInputV1,
    actor: RemoteAccessRequestActor
  ) => Promise<TrustedDeviceSummaryV1>;
  revokeDevice?: (deviceId: string, actor: ConfirmedAdminActor) => Promise<void>;
  reconcileDeviceRevocation?: (input: HelperDeviceRevocationRecovery) => Promise<void>;
  resetIdentity?: (input: ResetIdentityCommand) => Promise<IdentityResetReceiptV1>;
  getResetStatus?: (input: GetResetStatusCommand) => Promise<IdentityResetReceiptV1>;
  close: () => Promise<void>;
};

export type LocalActivationActor = {
  readonly hostServerLaunchId: string;
  readonly browserSessionId: string;
};

export type RemoteAccessRequestActor = HelperRequestActor;
export type ConfirmedAdminActor = HelperConfirmedAdminActor;

type ActivationOperation = {
  readonly operationId: string;
  readonly owner: string;
  readonly expiresAt: bigint;
  status: ActivationStatus;
};

export class ActivationRequiredError extends Error {
  constructor() {
    super("Remote access must be activated before it can be enabled.");
    this.name = "ActivationRequiredError";
  }
}

export class ActivationOperationNotFoundError extends Error {
  constructor() {
    super("Activation operation was not found.");
    this.name = "ActivationOperationNotFoundError";
  }
}

export class ActivationOperationCapacityError extends Error {
  constructor() {
    super("Activation operation capacity is exhausted.");
    this.name = "ActivationOperationCapacityError";
  }
}

export class RemoteAccessServiceUnavailableError extends Error {
  constructor() {
    super("Remote-access state is unavailable.");
    this.name = "RemoteAccessServiceUnavailableError";
  }
}

export class RemoteAccessActorUnauthorizedError extends Error {
  constructor() {
    super("The remote administrative actor is no longer authorized.");
    this.name = "RemoteAccessActorUnauthorizedError";
  }
}

export class RemoteAccessInactiveError extends Error {
  constructor() {
    super("Remote access is not active.");
    this.name = "RemoteAccessInactiveError";
  }
}

export class RemoteAccessEnableBlockedError extends Error {
  constructor(
    readonly code: "bind_not_loopback" | "custom_dashboard_unsupported"
  ) {
    super(code === "bind_not_loopback"
      ? "Remote access requires the host API to remain loopback-only."
      : "Remote access requires the bundled dashboard build.");
    this.name = "RemoteAccessEnableBlockedError";
  }
}

export class RemoteAccessTrustedDeviceNotFoundError extends Error {
  constructor() {
    super("The trusted remote device was not found.");
    this.name = "RemoteAccessTrustedDeviceNotFoundError";
  }
}

export class RemoteAccessDeviceRevisionConflictError extends Error {
  constructor(readonly latest: TrustedDeviceSummaryV1) {
    super("The trusted remote device changed since it was reviewed.");
    this.name = "RemoteAccessDeviceRevisionConflictError";
  }
}

export type PreparedDeviceRevocation = Readonly<{
  version: 1;
  deviceId: string;
  pairId: string;
  trustEpoch: string;
  denyEpoch: string;
  created: boolean;
}>;

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
  identityResetState?: IdentityResetState;
  resolveHost?: (host: string) => Promise<readonly string[]>;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
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
    trustedDeviceCount: trustedDeviceCount(state),
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
    trustedDeviceCount: trustedDeviceCount(state),
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

function resetPendingSummary(errorCode: RemoteAccessErrorCode | null = null): RemoteAccessRuntimeSummary {
  return RemoteAccessRuntimeSummarySchema.parse({
    version: 1,
    enabled: false,
    helperState: "disabled",
    activationState: "activation_required",
    controlState: "inactive",
    directState: "inactive",
    trustedDeviceCount: 0,
    lastDirectAt: null,
    lastErrorCode: errorCode
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
    trustedDeviceCount: trustedDeviceCount(state),
    lastDirectAt: runtimeStatus.lastDirectAt,
    lastErrorCode: snapshot.lastErrorCode ?? runtimeStatus.lastErrorCode
  });
}

function trustedDeviceCount(state: RemoteAccessPersistedState): number {
  return state.trustIndex.pairs.filter((pair) => {
    const denial = state.localDenyIndex.devices.find(
      (candidate) => candidate.deviceId === pair.deviceId
    );
    return !denial || (
      pair.pairId !== denial.pairId
      && BigInt(pair.trustEpoch) > BigInt(denial.denyEpoch)
    );
  }).length;
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
  readonly #identityReset: IdentityResetState;
  readonly #events = new RemoteAccessEvents();
  readonly #invalidations = new RemoteAccessInvalidations();
  readonly #resolveHost: (host: string) => Promise<readonly string[]>;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #activationOperations = new Map<string, ActivationOperation>();
  readonly #revocationFinalizers = new Map<string, Promise<void>>();
  readonly #publishedRevocations = new Set<string>();
  #revocationRecovery: Promise<void> | undefined;
  #identityResetPromise: Promise<IdentityResetReceiptV1> | undefined;
  #lastVerifiedHelperSnapshot: HelperSupervisorSnapshot | undefined;
  #state: RemoteAccessPersistedState | undefined;
  #summary: RemoteAccessRuntimeSummary | undefined;
  #unsubscribeSupervisor: (() => void) | undefined;
  #requestBridge: RemoteRequestBridge | undefined;
  #started = false;
  #closed = false;

  constructor(options: RemoteAccessServiceOptions) {
    this.#options = options;
    this.#stateStore = options.stateStore ?? new RemoteAccessStateStore(options.dataRoot);
    this.#identityReset = options.identityResetState ?? new IdentityResetState(options.dataRoot);
    this.#resolveHost = options.resolveHost ?? defaultResolveHost;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Remote access service is closed.");
    if (this.#started) return;
    this.#started = true;
    let resetState: IdentityResetTombstoneV1 | undefined;
    try {
      resetState = await this.#identityReset.load();
      if (resetState && resetState.stage !== "complete") {
        await this.#recoverIdentityReset(resetState);
      }
    } catch (error) {
      try {
        this.#state = await this.#stateStore.load();
        this.#publish(resetPendingSummary(lifecycleErrorCode(error)));
      } catch {
        this.#publish(repairRequiredSummary());
      }
      return;
    }
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

    this.#subscribeSupervisor();
    try {
      await this.#options.supervisor.start();
      await this.#options.supervisor.startRuntime();
      this.#rememberHelperSnapshot(this.#options.supervisor.snapshot());
    } catch (error) {
      this.#unsubscribeSupervisor?.();
      this.#unsubscribeSupervisor = undefined;
      this.#publish(failedSummary(state, lifecycleErrorCode(error)));
      return;
    }
    this.#publish(snapshotSummary(state, this.#options.supervisor.snapshot()));
    await this.#recoverPendingDeviceRevocations().catch(() => undefined);
  }

  getRuntimeSummary(): RemoteAccessRuntimeSummary {
    if (!this.#summary) throw new Error("Remote access service has not started.");
    return structuredClone(this.#summary);
  }

  subscribe(listener: (summary: RemoteAccessRuntimeSummary) => void): () => void {
    return this.#events.subscribe(listener);
  }

  subscribeInvalidations(listener: RemoteAccessInvalidationListener): () => void {
    return this.#invalidations.subscribe(listener);
  }

  attachRequestBridge(bridge: RemoteRequestBridge): void {
    if (this.#started || this.#closed) {
      throw new Error("Remote request bridge must be attached before service startup.");
    }
    if (this.#requestBridge && this.#requestBridge !== bridge) {
      throw new Error("Remote request bridge is already attached.");
    }
    this.#requestBridge = bridge;
    this.#options.supervisor.attachRequestBridge(bridge);
  }

  async isAuthorized(principal: RemoteRequestPrincipal): Promise<boolean> {
    if (!this.#started || this.#closed || !this.#summary?.enabled) return false;
    return this.#stateStore.isAuthorized(principal.deviceId, principal.trustEpoch);
  }

  async reconnect(): Promise<void> {
    if (!this.#started || this.#closed || !this.#summary?.enabled) {
      throw new RemoteAccessInactiveError();
    }
    await this.#options.supervisor.reconnectRuntime();
    this.#rememberHelperSnapshot(this.#options.supervisor.snapshot());
    await this.#recoverPendingDeviceRevocations().catch(() => undefined);
  }

  async assertNoLiveRemoteSibling(): Promise<void> {
    await this.#identityReset.assertNoLiveRemoteSibling();
  }

  async resetIdentity(): Promise<IdentityResetReceiptV1> {
    this.#requireState();
    if (this.#identityResetPromise) return this.#identityResetPromise;
    const reset = this.#runIdentityReset();
    this.#identityResetPromise = reset;
    const clear = () => {
      if (this.#identityResetPromise === reset) this.#identityResetPromise = undefined;
    };
    void reset.then(clear, clear);
    return reset;
  }

  async createInvitation(
    actorValue: ConfirmedAdminActor,
    idempotencyKeyValue: string
  ): Promise<PairInvitationV1> {
    this.#requireActiveManagement();
    const actor = await this.#authorizeConfirmedActor(actorValue);
    const idempotencyKey = Base64Url32BytesSchema.parse(idempotencyKeyValue);
    const method = this.#options.supervisor.createInvitation;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    return PairInvitationV1Schema.parse(
      await method.call(this.#options.supervisor, actor, idempotencyKey)
    );
  }

  async cancelInvitation(
    invitationId: string,
    actorValue: ConfirmedAdminActor
  ): Promise<void> {
    this.#requireActiveManagement();
    const actor = await this.#authorizeConfirmedActor(actorValue);
    const method = this.#options.supervisor.cancelInvitation;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    await method.call(this.#options.supervisor, Base64Url16BytesSchema.parse(invitationId), actor);
  }

  async listPairingRequests(
    actorValue: RemoteAccessRequestActor
  ): Promise<PendingPairingRequestListV1> {
    this.#requireActiveManagement();
    const actor = await this.#authorizeRequestActor(actorValue);
    const method = this.#options.supervisor.listPairingRequests;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    return PendingPairingRequestListV1Schema.parse(
      await method.call(this.#options.supervisor, actor)
    );
  }

  async approvePairingRequest(
    requestId: string,
    inputValue: ApprovePairingInputV1,
    actorValue: ConfirmedAdminActor
  ): Promise<void> {
    this.#requireActiveManagement();
    const actor = await this.#authorizeConfirmedActor(actorValue);
    const input = ApprovePairingInputV1Schema.parse(inputValue);
    const method = this.#options.supervisor.approvePairingRequest;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    await method.call(
      this.#options.supervisor,
      Base64Url16BytesSchema.parse(requestId),
      input,
      actor
    );
  }

  async rejectPairingRequest(
    requestId: string,
    actorValue: RemoteAccessRequestActor
  ): Promise<void> {
    this.#requireActiveManagement();
    const actor = await this.#authorizeRequestActor(actorValue);
    const method = this.#options.supervisor.rejectPairingRequest;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    await method.call(
      this.#options.supervisor,
      Base64Url16BytesSchema.parse(requestId),
      actor
    );
  }

  async listDevices(): Promise<TrustedDeviceListV1> {
    this.#requireState();
    const method = this.#options.supervisor.listDevices;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    const result = TrustedDeviceListV1Schema.parse(await method.call(this.#options.supervisor));
    const state = await this.#stateStore.load();
    return TrustedDeviceListV1Schema.parse({
      version: 1,
      devices: result.devices.filter((device) => {
        const pair = state.trustIndex.pairs.find(
          (candidate) => candidate.deviceId === device.deviceId
        );
        const denial = state.localDenyIndex.devices.find(
          (candidate) => candidate.deviceId === device.deviceId
        );
        return pair && pair.trustEpoch === device.trustEpoch && (
          !denial || (
            pair.pairId !== denial.pairId
            && BigInt(pair.trustEpoch) > BigInt(denial.denyEpoch)
          )
        );
      })
    });
  }

  async renameDevice(
    deviceIdValue: string,
    inputValue: RenameTrustedDeviceInputV1,
    actorValue: RemoteAccessRequestActor
  ): Promise<TrustedDeviceSummaryV1> {
    this.#requireState();
    const actor = await this.#authorizeRequestActor(actorValue);
    const deviceId = DeviceIdSchema.parse(deviceIdValue);
    const input = RenameTrustedDeviceInputV1Schema.parse(inputValue);
    const method = this.#options.supervisor.renameDevice;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    const result = TrustedDeviceSummaryV1Schema.parse(
      await method.call(this.#options.supervisor, deviceId, input, actor)
    );
    if (result.deviceId !== deviceId) {
      throw new HelperSupervisorError(
        "helper_incompatible",
        "Helper returned a different trusted-device ID."
      );
    }
    return result;
  }

  async revokeDevice(
    deviceIdValue: string,
    inputValue: RevokeTrustedDeviceInputV1,
    actorValue: ConfirmedAdminActor
  ): Promise<PreparedDeviceRevocation> {
    this.#requireActiveManagement();
    await this.#authorizeConfirmedActor(actorValue);
    const deviceId = DeviceIdSchema.parse(deviceIdValue);
    const input = RevokeTrustedDeviceInputV1Schema.parse(inputValue);
    const listMethod = this.#options.supervisor.listDevices;
    if (!listMethod || !this.#options.supervisor.reconcileDeviceRevocation) {
      throw new RemoteAccessServiceUnavailableError();
    }
    const devices = TrustedDeviceListV1Schema.parse(
      await listMethod.call(this.#options.supervisor)
    );
    const target = devices.devices.find((device) => device.deviceId === deviceId);
    if (!target) throw new RemoteAccessTrustedDeviceNotFoundError();
    if (target.revision !== input.revision) {
      throw new RemoteAccessDeviceRevisionConflictError(target);
    }
    const local = await this.#stateStore.denyDevice(
      deviceId,
      target.trustEpoch,
      this.#nowSeconds()
    );
    this.#state = await this.#stateStore.load();
    if (this.#summary?.enabled) {
      this.#publish(snapshotSummary(this.#state, this.#options.supervisor.snapshot()));
    }
    return Object.freeze({
      version: 1,
      deviceId,
      pairId: local.denial.pairId,
      trustEpoch: local.denial.deniedTrustEpoch,
      denyEpoch: local.denial.denyEpoch,
      created: local.created
    });
  }

  async finishDeviceRevocation(revocation: PreparedDeviceRevocation): Promise<void> {
    const parsed = Object.freeze({
      version: 1 as const,
      deviceId: DeviceIdSchema.parse(revocation.deviceId),
      pairId: Base64Url16BytesSchema.parse(revocation.pairId),
      trustEpoch: revocation.trustEpoch,
      denyEpoch: revocation.denyEpoch,
      created: revocation.created === true
    });
    const event = RemoteAccessInvalidationV1Schema.parse({
      version: 1,
      kind: "device_trust_revoked",
      stableId: `remote:${parsed.deviceId}`,
      deviceId: parsed.deviceId,
      trustEpoch: parsed.trustEpoch,
      denyEpoch: parsed.denyEpoch
    });
    const key = `${parsed.deviceId}:${parsed.denyEpoch}`;
    const pending = this.#revocationFinalizers.get(key);
    if (pending) return pending;
    const finalizer = (async () => {
      if (!this.#publishedRevocations.has(key)) {
        this.#publishedRevocations.add(key);
        this.#invalidations.emit(event);
        this.#requestBridge?.cancelDevice(
          parsed.deviceId,
          new Error("Remote device trust was revoked.")
        );
      }
      const method = this.#options.supervisor.reconcileDeviceRevocation;
      if (!method) throw new RemoteAccessServiceUnavailableError();
      await method.call(this.#options.supervisor, HelperDeviceRevocationRecoverySchema.parse({
        deviceId: parsed.deviceId,
        pairId: parsed.pairId,
        deniedTrustEpoch: parsed.trustEpoch,
        denyEpoch: parsed.denyEpoch
      }));
      try {
        const state = await this.#stateStore.load();
        this.#state = state;
        if (this.#summary?.enabled) {
          this.#publish(snapshotSummary(state, this.#options.supervisor.snapshot()));
        }
      } catch {
        // The durable local denial remains authoritative even if the helper's public mirror cannot
        // be reread immediately. A later authorization read still fails closed.
      }
    })();
    this.#revocationFinalizers.set(key, finalizer);
    try {
      await finalizer;
    } catch (error) {
      this.#revocationFinalizers.delete(key);
      throw error;
    }
  }

  async getStatus(): Promise<RemoteAccessStatusV1> {
    const state = this.#requireState();
    const identity = await this.#ensureIdentityStatus();
    const summary = this.getRuntimeSummary();
    const helper = this.#lastVerifiedHelperSnapshot ?? this.#options.supervisor.snapshot();
    return RemoteAccessStatusV1Schema.parse({
      version: 1,
      config: state.config,
      identity: {
        deviceId: identity.deviceId,
        installationFingerprint: identity.installationFingerprint
      },
      appVersion: this.#options.runtime.packageVersion,
      dashboardBuildId: this.#options.dashboard.buildId,
      helperVersion: helper.helperVersion,
      helperReleaseSequence: helper.releaseSequence,
      protocol: helper.protocol ?? { major: 1, minor: 0 },
      capabilities: helper.capabilities,
      helperState: summary.helperState,
      activationState: summary.activationState,
      controlState: summary.controlState,
      directState: summary.directState,
      lastDirectAt: summary.lastDirectAt,
      lastErrorCode: summary.lastErrorCode
    });
  }

  async diagnostics(): Promise<RemoteAccessDiagnosticsV1> {
    let identity = this.#options.supervisor.identityStatus();
    let diagnosticErrorCode: RemoteAccessErrorCode | null = null;
    if (!identity) {
      try {
        identity = await this.#ensureIdentityStatus();
      } catch (error) {
        diagnosticErrorCode = lifecycleErrorCode(error);
      }
    }
    const summary = this.getRuntimeSummary();
    const helper = this.#lastVerifiedHelperSnapshot ?? this.#options.supervisor.snapshot();
    const helperState = summary.helperState === "ready" && (
      helper.helperVersion === null
      || helper.releaseSequence === null
      || helper.forkCommit === null
      || helper.target === null
      || helper.protocol === null
      || identity === null
    )
      ? "failed"
      : summary.helperState;
    return RemoteAccessDiagnosticsV1Schema.parse({
      version: 1,
      appVersion: this.#options.runtime.packageVersion,
      dashboardBuildId: this.#options.dashboard.buildId,
      helper: {
        state: helperState,
        version: helper.helperVersion,
        releaseSequence: helper.releaseSequence,
        forkCommit: helper.forkCommit,
        target: helper.target,
        protocol: helper.protocol,
        capabilities: helper.capabilities,
        secretStorage: identity?.secretStorage ?? null
      },
      controlState: summary.controlState,
      stun: "unknown",
      udp: "unknown",
      portMapping: "unknown",
      directState: summary.directState,
      lastTransitionAt: null,
      lastDirectAt: summary.lastDirectAt,
      lastErrorCode: summary.lastErrorCode
        ?? diagnosticErrorCode
        ?? (helperState !== summary.helperState ? "helper_unavailable" : null),
      prohibited: {
        derpRouteSelections: "0",
        derpApplicationBytes: "0",
        peerRelayRouteSelections: "0",
        peerRelayApplicationBytes: "0",
        genericProxyRequests: "0",
        genericProxyBytes: "0"
      }
    });
  }

  async beginActivation(actorValue: LocalActivationActor): Promise<ActivationStartResult> {
    const state = this.#requireState();
    const actor = this.#parseActivationActor(actorValue);
    await this.#pruneActivationOperations();
    const pending = [...this.#activationOperations.values()]
      .filter((operation) => operation.status.state === "pending").length;
    if (pending >= MAX_PENDING_ACTIVATIONS || this.#activationOperations.size >= MAX_RETAINED_ACTIVATIONS) {
      throw new ActivationOperationCapacityError();
    }
    const operationId = this.#newActivationOperationId();
    try {
      await this.#options.supervisor.start();
      this.#rememberHelperSnapshot(this.#options.supervisor.snapshot());
      const helperResult = await this.#options.supervisor.beginActivation(operationId);
      if (helperResult.operationId !== operationId) {
        throw new HelperSupervisorError(
          "helper_incompatible",
          "Helper returned a different local activation operation ID."
        );
      }
      const now = this.#nowSeconds();
      const expiresAt = BigInt(helperResult.expiresAt);
      if (
        expiresAt <= now
        || expiresAt > now + BigInt(ACTIVATION_CHALLENGE_LIFETIME_SECONDS + 60)
      ) {
        throw new HelperSupervisorError(
          "helper_incompatible",
          "Helper returned an invalid activation lifetime."
        );
      }
      const status = ActivationStatusSchema.parse({
        activationOperationId: operationId,
        state: "pending",
        expiresAt: expiresAt.toString()
      });
      this.#activationOperations.set(operationId, {
        operationId,
        owner: this.#activationOwner(actor),
        expiresAt,
        status
      });
      return ActivationStartResultSchema.parse({
        activationOperationId: operationId,
        verificationUrl: helperResult.verificationUrl,
        expiresAt: expiresAt.toString()
      });
    } catch (error) {
      if (!state.config.enabled && pending === 0) {
        await this.#options.supervisor.stop().catch(() => undefined);
      }
      throw error;
    }
  }

  async getActivation(
    operationIdValue: string,
    actorValue: LocalActivationActor
  ): Promise<ActivationStatus> {
    const operation = this.#ownedActivationOperation(operationIdValue, actorValue);
    if (operation.status.state !== "pending") return structuredClone(operation.status);
    const now = this.#nowSeconds();
    if (now >= operation.expiresAt) {
      await this.#options.supervisor.cancelActivation(operation.operationId).catch(() => undefined);
      operation.status = ActivationStatusSchema.parse({
        activationOperationId: operation.operationId,
        state: "expired",
        expiresAt: operation.expiresAt.toString()
      });
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    let helperResult: HelperActivationPoll;
    try {
      helperResult = await this.#options.supervisor.pollActivation(operation.operationId);
    } catch (error) {
      operation.status = this.#failedActivationStatus(
        operation,
        this.#activationErrorCode(error)
      );
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    if (
      helperResult.operationId !== operation.operationId
      || BigInt(helperResult.expiresAt) !== operation.expiresAt
    ) {
      await this.#options.supervisor.cancelActivation(operation.operationId).catch(() => undefined);
      operation.status = this.#failedActivationStatus(operation, "certificate_invalid");
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    if (helperResult.state === "pending") return structuredClone(operation.status);
    if (helperResult.state === "expired") {
      operation.status = ActivationStatusSchema.parse({
        activationOperationId: operation.operationId,
        state: "expired",
        expiresAt: operation.expiresAt.toString()
      });
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    if (helperResult.state === "failed") {
      operation.status = this.#failedActivationStatus(operation, helperResult.errorCode);
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    let state: RemoteAccessPersistedState;
    try {
      state = await this.#stateStore.load();
    } catch {
      operation.status = this.#failedActivationStatus(operation, "certificate_invalid");
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    if (state.installation.activationReference === null) {
      operation.status = this.#failedActivationStatus(operation, "certificate_invalid");
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
    this.#state = state;
    operation.status = ActivationStatusSchema.parse({
      activationOperationId: operation.operationId,
      state: "completed",
      expiresAt: operation.expiresAt.toString(),
      completedAt: now.toString()
    });
    if (state.config.enabled) {
      this.#subscribeSupervisor();
      try {
        await this.#options.supervisor.startRuntime();
        this.#publish(snapshotSummary(state, this.#options.supervisor.snapshot()));
      } catch (error) {
        this.#publish(failedSummary(state, lifecycleErrorCode(error)));
      }
    } else {
      this.#publish(inactiveSummary(state));
    }
    await this.#stopHelperIfInactiveAndIdle();
    return structuredClone(operation.status);
  }

  async cancelActivation(operationIdValue: string, actorValue: LocalActivationActor): Promise<void> {
    const operation = this.#ownedActivationOperation(operationIdValue, actorValue);
    this.#activationOperations.delete(operation.operationId);
    if (operation.status.state === "pending") {
      await this.#options.supervisor.cancelActivation(operation.operationId).catch(() => undefined);
    }
    await this.#stopHelperIfInactiveAndIdle();
  }

  async updateConfig(inputValue: unknown): Promise<RemoteAccessConfigV1> {
    const input = UpdateRemoteAccessInputV1Schema.parse(inputValue);
    const current = await this.#stateStore.load();
    this.#state = current;
    if (input.enabled === true && current.installation.activationReference === null) {
      throw new ActivationRequiredError();
    }
    if (input.enabled === true && !await this.#effectiveBindIsLoopback()) {
      throw new RemoteAccessEnableBlockedError("bind_not_loopback");
    }
    if (input.enabled === true && this.#options.dashboard.source !== "bundled") {
      throw new RemoteAccessEnableBlockedError("custom_dashboard_unsupported");
    }
    const next = await this.#stateStore.updateConfig(input, this.#nowSeconds());
    this.#state = next;
    if (!next.config.enabled) {
      if (current.config.enabled) {
        this.#unsubscribeSupervisor?.();
        this.#unsubscribeSupervisor = undefined;
      }
      this.#publish(inactiveSummary(next));
      return structuredClone(next.config);
    }
    if (!await this.#effectiveBindIsLoopback()) {
      this.#publish(failedSummary(next, "bind_not_loopback"));
      return structuredClone(next.config);
    }
    if (this.#options.dashboard.source !== "bundled") {
      this.#publish(failedSummary(next, "custom_dashboard_unsupported"));
      return structuredClone(next.config);
    }
    this.#subscribeSupervisor();
    try {
      await this.#options.supervisor.start();
      await this.#options.supervisor.startRuntime();
      this.#rememberHelperSnapshot(this.#options.supervisor.snapshot());
      this.#publish(snapshotSummary(next, this.#options.supervisor.snapshot()));
    } catch (error) {
      this.#publish(failedSummary(next, lifecycleErrorCode(error)));
    }
    if (this.#summary?.helperState === "ready") {
      await this.#recoverPendingDeviceRevocations().catch(() => undefined);
    }
    return structuredClone(next.config);
  }

  async drainDisabledHelper(): Promise<void> {
    if (!this.#started || this.#closed || this.#state?.config.enabled !== false) return;
    await this.#stopHelperIfInactiveAndIdle();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pendingActivations = [...this.#activationOperations.values()]
      .filter((operation) => operation.status.state === "pending");
    for (const operation of pendingActivations) {
      await this.#options.supervisor.cancelActivation(operation.operationId).catch(() => undefined);
    }
    this.#activationOperations.clear();
    await this.#identityResetPromise?.catch(() => undefined);
    await Promise.allSettled(this.#revocationFinalizers.values());
    this.#requestBridge?.close(new Error("Remote access service is stopping."));
    this.#unsubscribeSupervisor?.();
    this.#unsubscribeSupervisor = undefined;
    await this.#options.supervisor.close();
    this.#events.clear();
    this.#invalidations.clear();
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

  async #runIdentityReset(): Promise<IdentityResetReceiptV1> {
    await this.#identityReset.assertNoLiveRemoteSibling();
    const identity = await this.#ensureIdentityStatus();
    const prepared = await this.#identityReset.prepare(
      identity.installationFingerprint,
      this.#nowSeconds()
    );
    this.#state = await this.#stateStore.load();
    this.#publish(resetPendingSummary());

    const pendingActivations = [...this.#activationOperations.values()]
      .filter((operation) => operation.status.state === "pending");
    for (const operation of pendingActivations) {
      await this.#options.supervisor.cancelActivation(operation.operationId).catch(() => undefined);
    }
    this.#activationOperations.clear();

    for (const pair of prepared.pairs) {
      const event = RemoteAccessInvalidationV1Schema.parse({
        version: 1,
        kind: "device_trust_revoked",
        stableId: `remote:${pair.deviceId}`,
        deviceId: pair.deviceId,
        trustEpoch: pair.trustEpoch,
        denyEpoch: prepared.resetTombstone
      });
      const key = `${pair.deviceId}:${prepared.resetTombstone}`;
      if (!this.#publishedRevocations.has(key)) {
        this.#publishedRevocations.add(key);
        this.#invalidations.emit(event);
        this.#requestBridge?.cancelDevice(
          pair.deviceId,
          new Error("Remote installation identity was reset.")
        );
      }
    }

    const method = this.#options.supervisor.resetIdentity;
    if (!method) throw new RemoteAccessServiceUnavailableError();
    try {
      await this.#options.supervisor.start();
      const receipt = IdentityResetReceiptV1Schema.parse(await method.call(
        this.#options.supervisor,
        ResetIdentityCommandSchema.parse({
          resetTombstone: prepared.resetTombstone,
          expectedOldFingerprint: prepared.expectedOldFingerprint
        })
      ));
      await this.#verifyReplacementIdentity(receipt);
      await this.#identityReset.markHelperComplete(receipt, this.#nowSeconds());
      await this.#identityReset.finalize(this.#nowSeconds());
      const state = await this.#stateStore.load();
      this.#state = state;
      this.#unsubscribeSupervisor?.();
      this.#unsubscribeSupervisor = undefined;
      this.#publish(inactiveSummary(state));
      return receipt;
    } catch (error) {
      await this.#options.supervisor.stop().catch(() => undefined);
      throw error;
    }
  }

  async #recoverIdentityReset(resetState: IdentityResetTombstoneV1): Promise<void> {
    if (resetState.stage === "complete") return;
    if (resetState.stage === "helper_complete") {
      await this.#identityReset.finalize(this.#nowSeconds());
      return;
    }

    const prepared = await this.#identityReset.prepare(
      resetState.expectedOldFingerprint,
      this.#nowSeconds()
    );
    const getStatus = this.#options.supervisor.getResetStatus;
    const resetIdentity = this.#options.supervisor.resetIdentity;
    if (!getStatus || !resetIdentity) throw new RemoteAccessServiceUnavailableError();
    await this.#options.supervisor.start();
    try {
      let receipt: IdentityResetReceiptV1 | undefined;
      try {
        receipt = IdentityResetReceiptV1Schema.parse(await getStatus.call(
          this.#options.supervisor,
          GetResetStatusCommandSchema.parse({ resetTombstone: prepared.resetTombstone })
        ));
      } catch {
        // An interrupted command may not yet have created its helper journal. Reissuing the exact
        // same tombstone/fingerprint is the helper's idempotent recovery path.
      }
      if (!receipt || receipt.stage !== "complete") {
        receipt = IdentityResetReceiptV1Schema.parse(await resetIdentity.call(
          this.#options.supervisor,
          ResetIdentityCommandSchema.parse({
            resetTombstone: prepared.resetTombstone,
            expectedOldFingerprint: prepared.expectedOldFingerprint
          })
        ));
      }
      await this.#verifyReplacementIdentity(receipt);
      await this.#identityReset.markHelperComplete(receipt, this.#nowSeconds());
      await this.#identityReset.finalize(this.#nowSeconds());
    } finally {
      await this.#options.supervisor.stop().catch(() => undefined);
    }
  }

  async #verifyReplacementIdentity(receipt: IdentityResetReceiptV1): Promise<void> {
    try {
      await this.#options.supervisor.start();
      const identity = this.#options.supervisor.identityStatus();
      if (
        !identity
        || identity.activationState !== "activation_required"
        || identity.installationFingerprint !== receipt.newFingerprint
      ) {
        throw new IdentityResetStateError(
          "Replacement helper identity does not match the completed reset receipt."
        );
      }
      this.#rememberHelperSnapshot(this.#options.supervisor.snapshot());
    } finally {
      await this.#options.supervisor.stop().catch(() => undefined);
    }
  }

  #publish(summary: RemoteAccessRuntimeSummary): void {
    const parsed = RemoteAccessRuntimeSummarySchema.parse(summary);
    this.#summary = parsed;
    this.#options.runtime.remoteAccess = structuredClone(parsed);
    this.#options.runtime.updatedAt = new Date().toISOString();
    this.#events.emit(structuredClone(parsed));
  }

  #subscribeSupervisor(): void {
    if (this.#unsubscribeSupervisor) return;
    this.#unsubscribeSupervisor = this.#options.supervisor.subscribe((snapshot) => {
      if (!this.#state || this.#closed || !this.#state.config.enabled) return;
      this.#rememberHelperSnapshot(snapshot);
      this.#publish(snapshotSummary(this.#state, snapshot));
      if (snapshot.state === "ready") {
        void this.#recoverPendingDeviceRevocations().catch(() => undefined);
      }
    });
  }

  #recoverPendingDeviceRevocations(): Promise<void> {
    if (this.#revocationRecovery) return this.#revocationRecovery;
    const recovery = this.#runPendingDeviceRevocations();
    this.#revocationRecovery = recovery;
    const clear = () => {
      if (this.#revocationRecovery === recovery) this.#revocationRecovery = undefined;
    };
    void recovery.then(clear, clear);
    return recovery;
  }

  async #runPendingDeviceRevocations(): Promise<void> {
    if (this.#closed) return;
    const method = this.#options.supervisor.reconcileDeviceRevocation;
    if (!method) return;
    const state = await this.#stateStore.load();
    for (const denial of state.localDenyIndex.devices) {
      const pair = state.trustIndex.pairs.find(
        (candidate) => candidate.deviceId === denial.deviceId
      );
      if (
        !pair
        || pair.pairId !== denial.pairId
        || pair.trustEpoch !== denial.deniedTrustEpoch
      ) {
        continue;
      }
      const key = `${denial.deviceId}:${denial.denyEpoch}`;
      if (this.#revocationFinalizers.has(key)) continue;
      const convergence = method.call(this.#options.supervisor, {
        deviceId: denial.deviceId,
        pairId: denial.pairId,
        deniedTrustEpoch: denial.deniedTrustEpoch,
        denyEpoch: denial.denyEpoch
      });
      this.#revocationFinalizers.set(key, convergence);
      try {
        await convergence;
      } catch (error) {
        this.#revocationFinalizers.delete(key);
        throw error;
      }
    }
    try {
      const refreshed = await this.#stateStore.load();
      this.#state = refreshed;
      if (this.#summary?.enabled) {
        this.#publish(snapshotSummary(refreshed, this.#options.supervisor.snapshot()));
      }
    } catch {
      // Authorization rereads the durable deny ledger and remains fail closed. A later helper
      // snapshot retries public-state refresh without weakening the cutoff.
    }
  }

  #requireState(): RemoteAccessPersistedState {
    if (!this.#started || this.#closed || !this.#state) {
      throw new RemoteAccessServiceUnavailableError();
    }
    return this.#state;
  }

  #requireActiveManagement(): void {
    this.#requireState();
    if (!this.#summary?.enabled || this.#summary.helperState !== "ready") {
      throw new RemoteAccessInactiveError();
    }
  }

  async #authorizeRequestActor(
    actorValue: RemoteAccessRequestActor
  ): Promise<RemoteAccessRequestActor> {
    const actor = HelperRequestActorSchema.parse(actorValue);
    if (
      actor.kind === "remote_device"
      && !await this.#stateStore.isAuthorized(actor.deviceId, actor.trustEpoch)
    ) {
      throw new RemoteAccessActorUnauthorizedError();
    }
    return Object.freeze(actor);
  }

  async #authorizeConfirmedActor(
    actorValue: ConfirmedAdminActor
  ): Promise<ConfirmedAdminActor> {
    const actor = HelperConfirmedAdminActorSchema.parse(actorValue);
    if (
      actor.kind === "remote_device"
      && !await this.#stateStore.isAuthorized(actor.deviceId, actor.trustEpoch)
    ) {
      throw new RemoteAccessActorUnauthorizedError();
    }
    return Object.freeze(actor);
  }

  #nowSeconds(): bigint {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RemoteAccessServiceUnavailableError();
    }
    return BigInt(value);
  }

  #parseActivationActor(actor: LocalActivationActor): LocalActivationActor {
    return Object.freeze({
      hostServerLaunchId: Base64Url32BytesSchema.parse(actor.hostServerLaunchId),
      browserSessionId: Base64Url32BytesSchema.parse(actor.browserSessionId)
    });
  }

  #activationOwner(actor: LocalActivationActor): string {
    return `${actor.hostServerLaunchId}:${actor.browserSessionId}`;
  }

  #newActivationOperationId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = Buffer.from(this.#randomBytes(32));
      if (bytes.byteLength !== 32) {
        bytes.fill(0);
        throw new RemoteAccessServiceUnavailableError();
      }
      const value = ActivationOperationIdSchema.parse(bytes.toString("base64url"));
      bytes.fill(0);
      if (!this.#activationOperations.has(value)) return value;
    }
    throw new RemoteAccessServiceUnavailableError();
  }

  #ownedActivationOperation(
    operationIdValue: string,
    actorValue: LocalActivationActor
  ): ActivationOperation {
    const operationId = ActivationOperationIdSchema.safeParse(operationIdValue);
    const actor = this.#parseActivationActor(actorValue);
    const operation = operationId.success
      ? this.#activationOperations.get(operationId.data)
      : undefined;
    if (!operation || operation.owner !== this.#activationOwner(actor)) {
      throw new ActivationOperationNotFoundError();
    }
    return operation;
  }

  async #pruneActivationOperations(): Promise<void> {
    const now = this.#nowSeconds();
    for (const [operationId, operation] of this.#activationOperations) {
      if (operation.status.state === "pending" && now >= operation.expiresAt) {
        await this.#options.supervisor.cancelActivation(operationId).catch(() => undefined);
        operation.status = ActivationStatusSchema.parse({
          activationOperationId: operationId,
          state: "expired",
          expiresAt: operation.expiresAt.toString()
        });
      }
      if (
        operation.status.state !== "pending"
        && now >= operation.expiresAt + TERMINAL_ACTIVATION_RETENTION_SECONDS
      ) {
        this.#activationOperations.delete(operationId);
      }
    }
  }

  #failedActivationStatus(
    operation: ActivationOperation,
    errorCode: Extract<ActivationStatus, { state: "failed" }>["errorCode"]
  ): ActivationStatus {
    return ActivationStatusSchema.parse({
      activationOperationId: operation.operationId,
      state: "failed",
      expiresAt: operation.expiresAt.toString(),
      errorCode
    });
  }

  #activationErrorCode(
    error: unknown
  ): Extract<ActivationStatus, { state: "failed" }>["errorCode"] {
    if (error instanceof HelperCommandError) return error.code;
    if (error instanceof HelperSupervisorError && error.code === "worker_quota_exhausted") {
      return "worker_quota_exhausted";
    }
    return "helper_unavailable";
  }

  async #stopHelperIfInactiveAndIdle(): Promise<void> {
    if (this.#state?.config.enabled) return;
    const hasPendingActivation = [...this.#activationOperations.values()]
      .some((operation) => operation.status.state === "pending");
    if (!hasPendingActivation) {
      await this.#options.supervisor.stop().catch(() => undefined);
    }
  }

  #rememberHelperSnapshot(snapshot: HelperSupervisorSnapshot): void {
    if (
      snapshot.helperVersion === null
      || snapshot.releaseSequence === null
      || snapshot.forkCommit === null
      || snapshot.target === null
      || snapshot.protocol === null
    ) {
      return;
    }
    this.#lastVerifiedHelperSnapshot = structuredClone(snapshot);
  }

  async #ensureIdentityStatus(): Promise<HelperIdentityStatus> {
    const cached = this.#options.supervisor.identityStatus();
    if (cached) return cached;
    const state = this.#requireState();
    await this.#options.supervisor.start();
    const snapshot = this.#options.supervisor.snapshot();
    this.#rememberHelperSnapshot(snapshot);
    const identity = this.#options.supervisor.identityStatus();
    if (!state.config.enabled && !this.#hasPendingActivation()) {
      await this.#options.supervisor.stop().catch(() => undefined);
    }
    if (!identity) throw new RemoteAccessServiceUnavailableError();
    return identity;
  }

  #hasPendingActivation(): boolean {
    return [...this.#activationOperations.values()]
      .some((operation) => operation.status.state === "pending");
  }
}

export { RemoteAccessRevisionConflictError };
