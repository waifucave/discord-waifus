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
  RemoteAccessErrorCodeSchema,
  UpdateRemoteAccessInputV1Schema,
  type ActivationStartResult,
  type ActivationStatus,
  type RemoteAccessConfigV1,
  type RemoteAccessErrorCode
} from "../../shared/schemas/remoteLifecycle.js";
import { Base64Url32BytesSchema } from "../../shared/schemas/remoteProtocol.js";
import {
  RemoteAccessRuntimeSummarySchema,
  type RemoteAccessRuntimeSummary
} from "../runtime.js";
import {
  HelperCommandError,
  HelperSupervisorError,
  type HelperActivationCancel,
  type HelperActivationPoll,
  type HelperActivationStart,
  type HelperSupervisorSnapshot
} from "../../remote/helperTypes.js";
import { RemoteAccessEvents } from "./events.js";
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
  subscribe: (listener: (snapshot: HelperSupervisorSnapshot) => void) => () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reconnect: () => Promise<void>;
  beginActivation: (operationId: string) => Promise<HelperActivationStart>;
  pollActivation: (operationId: string) => Promise<HelperActivationPoll>;
  cancelActivation: (operationId: string) => Promise<HelperActivationCancel>;
  close: () => Promise<void>;
};

export type LocalActivationActor = {
  readonly hostServerLaunchId: string;
  readonly browserSessionId: string;
};

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
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #activationOperations = new Map<string, ActivationOperation>();
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
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#randomBytes = options.randomBytes ?? randomBytes;
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

    this.#subscribeSupervisor();
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
    try {
      const state = await this.#stateStore.load();
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
        this.#publish(snapshotSummary(state, this.#options.supervisor.snapshot()));
      } else {
        this.#publish(inactiveSummary(state));
      }
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    } catch {
      operation.status = this.#failedActivationStatus(operation, "certificate_invalid");
      await this.#stopHelperIfInactiveAndIdle();
      return structuredClone(operation.status);
    }
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
    const next = await this.#stateStore.updateConfig(input, this.#nowSeconds());
    this.#state = next;
    if (!next.config.enabled) {
      if (current.config.enabled) {
        this.#unsubscribeSupervisor?.();
        this.#unsubscribeSupervisor = undefined;
      }
      await this.#stopHelperIfInactiveAndIdle();
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
      this.#publish(snapshotSummary(next, this.#options.supervisor.snapshot()));
    } catch (error) {
      this.#publish(failedSummary(next, lifecycleErrorCode(error)));
    }
    return structuredClone(next.config);
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

  #subscribeSupervisor(): void {
    if (this.#unsubscribeSupervisor) return;
    this.#unsubscribeSupervisor = this.#options.supervisor.subscribe((snapshot) => {
      if (!this.#state || this.#closed || !this.#state.config.enabled) return;
      this.#publish(snapshotSummary(this.#state, snapshot));
    });
  }

  #requireState(): RemoteAccessPersistedState {
    if (!this.#started || this.#closed || !this.#state) {
      throw new RemoteAccessServiceUnavailableError();
    }
    return this.#state;
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
}

export { RemoteAccessRevisionConflictError };
