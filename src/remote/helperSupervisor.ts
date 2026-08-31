import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Logger } from "../backend/logger.js";
import { remoteStatePaths } from "./paths.js";
import {
  INITIAL_REQUIRED_CAPABILITIES,
  SemVerSchema,
  Uint64DecimalSchema,
  type ComponentHello,
  type ControlProfileV1,
  type RuntimePurpose
} from "../shared/schemas/remoteProtocol.js";
import { RemoteAccessErrorCodeSchema } from "../shared/schemas/remoteLifecycle.js";
import {
  HELPER_FAILURE_LIMIT,
  HELPER_FAILURE_WINDOW_MS,
  HELPER_GRACEFUL_DRAIN_MS,
  HELPER_HELLO_TIMEOUT_MS,
  HELPER_RESTART_DELAYS_MS,
  HelperSupervisorError,
  parseHelperIdentityStatus,
  parseHelperHello,
  parseHelperRuntimeStatus,
  parseHelperTarget,
  parseNegotiatedCapabilities,
  parseNegotiatedProtocol,
  type AuthenticatedHelperClient,
  type HelperActivationCancel,
  type HelperActivationPoll,
  type HelperActivationStart,
  type HelperIdentityStatus,
  type HelperLaunch,
  type HelperPackageResolver,
  type HelperProcessFactory,
  type HelperRole,
  type HelperRuntimeStatus,
  type HelperSupervisorSnapshot,
  type VerifiedHelperSelection
} from "./helperTypes.js";

type TimerHandle = ReturnType<typeof setTimeout>;

export type HelperSupervisorOptions = {
  role: HelperRole;
  dataRoot: string;
  appVersion: string;
  buildId: string;
  controlProfile: ControlProfileV1;
  runtimePurpose: RuntimePurpose;
  packageResolver: HelperPackageResolver;
  processFactory: HelperProcessFactory;
  logger: Logger;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => number;
  jitter?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

const FORK_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function initialRuntimeStatus(): HelperRuntimeStatus {
  return {
    activationState: "activation_required",
    controlState: "inactive",
    directState: "inactive",
    lastDirectAt: null,
    lastErrorCode: null
  };
}

function initialSnapshot(): HelperSupervisorSnapshot {
  return Object.freeze({
    state: "disabled",
    helperVersion: null,
    releaseSequence: null,
    forkCommit: null,
    target: null,
    protocol: null,
    capabilities: Object.freeze([]),
    runtimeStatus: Object.freeze(initialRuntimeStatus()),
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false
  });
}

function errorCode(error: unknown): HelperSupervisorError["code"] {
  const candidate = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  const parsed = RemoteAccessErrorCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : "helper_unavailable";
}

function asSupervisorError(error: unknown): HelperSupervisorError {
  if (error instanceof HelperSupervisorError) return error;
  return new HelperSupervisorError(errorCode(error), "Remote helper lifecycle step failed.");
}

function protocolWithin(
  value: { major: number; minor: number },
  minimum: { major: number; minor: number },
  maximum: { major: number; minor: number }
): boolean {
  return value.major === minimum.major
    && value.major === maximum.major
    && value.minor >= minimum.minor
    && value.minor <= maximum.minor;
}

function validatedSelection(value: VerifiedHelperSelection): VerifiedHelperSelection {
  if (!path.isAbsolute(value.binaryPath) || path.normalize(value.binaryPath) !== value.binaryPath) {
    throw new HelperSupervisorError("helper_signature_invalid", "Verified helper path is invalid.");
  }
  const helperVersion = SemVerSchema.parse(value.helperVersion);
  const releaseSequence = Uint64DecimalSchema.parse(value.releaseSequence);
  if (BigInt(releaseSequence) < 1n || !FORK_COMMIT_PATTERN.test(value.forkCommit)) {
    throw new HelperSupervisorError("helper_signature_invalid", "Verified helper metadata is invalid.");
  }
  const target = parseHelperTarget(value.target);
  const capabilities = parseNegotiatedCapabilities(value.capabilities);
  for (const capability of INITIAL_REQUIRED_CAPABILITIES) {
    if (!capabilities.includes(capability)) {
      throw new HelperSupervisorError("helper_incompatible", "Verified helper lacks a required capability.");
    }
  }
  const minimum = parseNegotiatedProtocol(value.ipcProtocol.minimum);
  const maximum = parseNegotiatedProtocol(value.ipcProtocol.maximum);
  if (
    minimum.major !== maximum.major
    || minimum.minor > maximum.minor
    || minimum.major !== 1
  ) {
    throw new HelperSupervisorError("helper_incompatible", "Verified helper IPC range is incompatible.");
  }
  return Object.freeze({
    binaryPath: value.binaryPath,
    helperVersion,
    releaseSequence,
    forkCommit: value.forkCommit,
    target,
    capabilities,
    ipcProtocol: Object.freeze({ minimum, maximum })
  });
}

function unixEndpoint(dataRoot: string, role: HelperRole): string {
  const paths = remoteStatePaths(dataRoot);
  const runtimeRoot = role === "host" ? paths.hostRuntimeRoot : paths.remoteGatewayRuntimeRoot;
  // Keep the basename deliberately tiny: macOS limits pathname Unix sockets to 103 bytes, while
  // the runtime directory must remain inside the selected data root for ownership isolation.
  const endpoint = path.join(runtimeRoot, "p");
  if (Buffer.byteLength(endpoint, "utf8") > 103) {
    throw new HelperSupervisorError(
      "helper_unavailable",
      "Remote helper Unix endpoint exceeds the portable path limit."
    );
  }
  return endpoint;
}

function windowsEndpoint(endpointToken: Uint8Array): string {
  return `\\\\.\\pipe\\waifus-parent.${Buffer.from(endpointToken).toString("base64url")}`;
}

function validateAuthenticatedClient(
  client: AuthenticatedHelperClient,
  selection: VerifiedHelperSelection,
  controlProfile: ControlProfileV1,
  runtimePurpose: RuntimePurpose
): AuthenticatedHelperClient {
  const hello = parseHelperHello(client.hello);
  const protocol = parseNegotiatedProtocol(client.negotiatedProtocol);
  const capabilities = parseNegotiatedCapabilities(client.negotiatedCapabilities);
  if (
    hello.component !== "ts_connect"
    || hello.componentVersion !== selection.helperVersion
    || hello.controlProfile !== controlProfile
    || hello.runtimePurpose !== runtimePurpose
    || !protocolWithin(protocol, selection.ipcProtocol.minimum, selection.ipcProtocol.maximum)
  ) {
    throw new HelperSupervisorError("helper_incompatible", "Authenticated helper HELLO is incompatible.");
  }
  for (const required of INITIAL_REQUIRED_CAPABILITIES) {
    if (!capabilities.includes(required)) {
      throw new HelperSupervisorError("helper_incompatible", "Negotiated helper capability is missing.");
    }
  }
  parseHelperRuntimeStatus(client.currentStatus());
  return client;
}

export class HelperSupervisor {
  readonly #options: HelperSupervisorOptions;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #jitter: () => number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();
  #snapshot = initialSnapshot();
  #launch: HelperLaunch | undefined;
  #client: AuthenticatedHelperClient | undefined;
  #identityStatus: HelperIdentityStatus | undefined;
  #unsubscribeStatus: (() => void) | undefined;
  #attemptPromise: Promise<void> | undefined;
  #restartTimer: TimerHandle | undefined;
  #failureTimes: number[] = [];
  #generation = 0;
  #closing = false;

  constructor(options: HelperSupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#jitter = options.jitter ?? Math.random;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
  }

  snapshot(): HelperSupervisorSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: HelperSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  identityStatus(): HelperIdentityStatus | null {
    return this.#identityStatus ? structuredClone(this.#identityStatus) : null;
  }

  async start(): Promise<void> {
    if (this.#closing) {
      throw new HelperSupervisorError("helper_unavailable", "Remote helper supervisor is closed.");
    }
    if (this.#snapshot.state === "ready") return;
    await this.#runAttempt();
  }

  async reconnect(): Promise<void> {
    if (this.#closing) {
      throw new HelperSupervisorError("helper_unavailable", "Remote helper supervisor is closed.");
    }
    this.#cancelRestart();
    this.#failureTimes = [];
    this.#update({ consecutiveFailures: 0, restartScheduled: false });
    if (this.#launch) await this.#shutdownCurrentLaunch();
    await this.#runAttempt();
  }

  async stop(): Promise<void> {
    if (this.#closing) return;
    this.#generation += 1;
    this.#cancelRestart();
    this.#failureTimes = [];
    await this.#shutdownCurrentLaunch();
    this.#update(initialSnapshot());
  }

  async beginActivation(operationId: string): Promise<HelperActivationStart> {
    return this.#readyClient().beginActivation(operationId);
  }

  async pollActivation(operationId: string): Promise<HelperActivationPoll> {
    return this.#readyClient().pollActivation(operationId);
  }

  async cancelActivation(operationId: string): Promise<HelperActivationCancel> {
    return this.#readyClient().cancelActivation(operationId);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#generation += 1;
    this.#cancelRestart();
    await this.#shutdownCurrentLaunch();
    this.#update({
      ...initialSnapshot(),
      consecutiveFailures: this.#snapshot.consecutiveFailures
    });
  }

  async #runAttempt(): Promise<void> {
    if (this.#attemptPromise) return this.#attemptPromise;
    const promise = this.#attempt();
    this.#attemptPromise = promise;
    try {
      await promise;
    } finally {
      if (this.#attemptPromise === promise) this.#attemptPromise = undefined;
    }
  }

  async #attempt(): Promise<void> {
    const generation = ++this.#generation;
    this.#update({ state: "starting", restartScheduled: false, lastErrorCode: null });
    let launch: HelperLaunch | undefined;
    let client: AuthenticatedHelperClient | undefined;
    try {
      const selection = validatedSelection(await this.#options.packageResolver.resolve({
        role: this.#options.role,
        dataRoot: this.#options.dataRoot,
        appVersion: this.#options.appVersion
      }));
      const capability = Buffer.from(this.#randomBytes(32));
      if (capability.byteLength !== 32) {
        capability.fill(0);
        throw new HelperSupervisorError("helper_unavailable", "Parent capability source returned invalid bytes.");
      }
      const nonce = Buffer.from(this.#randomBytes(32));
      if (nonce.byteLength !== 32) {
        capability.fill(0);
        nonce.fill(0);
        throw new HelperSupervisorError("helper_unavailable", "Parent nonce source returned invalid bytes.");
      }
      const parentHello = parseHelperHello({
        protocol: { major: 1, minor: 0 },
        component: "discord_waifus",
        componentVersion: this.#options.appVersion,
        buildId: this.#options.buildId,
        nonce: nonce.toString("base64url"),
        capabilities: { required: [...INITIAL_REQUIRED_CAPABILITIES], optional: [] },
        controlProfile: this.#options.controlProfile,
        runtimePurpose: this.#options.runtimePurpose
      });
      nonce.fill(0);
      let endpoint: string;
      if (selection.target.os === "win32") {
        const endpointToken = Buffer.from(this.#randomBytes(16));
        if (endpointToken.byteLength !== 16) {
          capability.fill(0);
          endpointToken.fill(0);
          throw new HelperSupervisorError("helper_unavailable", "Pipe endpoint source returned invalid bytes.");
        }
        endpoint = windowsEndpoint(endpointToken);
        endpointToken.fill(0);
      } else {
        endpoint = unixEndpoint(this.#options.dataRoot, this.#options.role);
      }
      try {
        launch = await this.#options.processFactory.launch({
          role: this.#options.role,
          dataRoot: this.#options.dataRoot,
          binaryPath: selection.binaryPath,
          argv: Object.freeze(["supervised", "--parent-endpoint", endpoint]),
          environment: Object.freeze({}),
          parentEndpoint: endpoint,
          parentCapability: capability,
          parentHello
        });
      } finally {
        capability.fill(0);
      }
      this.#launch = launch;
      client = await this.#awaitAuthenticated(launch);
      validateAuthenticatedClient(
        client,
        selection,
        this.#options.controlProfile,
        this.#options.runtimePurpose
      );
      const identityStatus = parseHelperIdentityStatus(await client.identityStatus());
      if (this.#closing || generation !== this.#generation) {
        await client.close().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#identityStatus = identityStatus;
      const runtimeStatus = parseHelperRuntimeStatus({
        ...client.currentStatus(),
        activationState: identityStatus.activationState
      });
      this.#unsubscribeStatus = client.subscribeStatus((value) => {
        if (this.#client !== client || this.#closing) return;
        try {
          const nextStatus = parseHelperRuntimeStatus(value);
          this.#update({
            runtimeStatus: nextStatus,
            lastErrorCode: nextStatus.lastErrorCode
          });
        } catch {
          void this.#failReadyLaunch(
            new HelperSupervisorError("helper_incompatible", "Helper emitted invalid status.")
          );
        }
      });
      this.#update({
        state: "ready",
        helperVersion: selection.helperVersion,
        releaseSequence: selection.releaseSequence,
        forkCommit: selection.forkCommit,
        target: selection.target,
        protocol: parseNegotiatedProtocol(client.negotiatedProtocol),
        capabilities: parseNegotiatedCapabilities(client.negotiatedCapabilities),
        runtimeStatus,
        lastErrorCode: runtimeStatus.lastErrorCode,
        consecutiveFailures: 0,
        restartScheduled: false
      });
      this.#options.logger.info("Remote helper authenticated", {
        role: this.#options.role,
        state: "ready"
      });
      const authenticatedLaunch = launch;
      void authenticatedLaunch.exited.then(
        () => this.#onUnexpectedExit(generation, authenticatedLaunch),
        () => this.#onUnexpectedExit(generation, authenticatedLaunch)
      );
    } catch (error) {
      if (client) await client.close().catch(() => undefined);
      if (launch) await this.#discardFailedLaunch(launch);
      if (this.#launch === launch) this.#launch = undefined;
      if (!this.#closing && generation === this.#generation) this.#recordFailure(error);
    }
  }

  async #awaitAuthenticated(launch: HelperLaunch): Promise<AuthenticatedHelperClient> {
    let timeout: TimerHandle | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = this.#setTimeout(() => reject(new HelperSupervisorError(
        "helper_unavailable",
        "Helper authentication deadline expired."
      )), HELPER_HELLO_TIMEOUT_MS);
    });
    const exitedPromise = launch.exited.then<never>(() => {
      throw new HelperSupervisorError("helper_unavailable", "Helper exited before authentication.");
    });
    try {
      return await Promise.race([launch.authenticated, exitedPromise, timeoutPromise]);
    } finally {
      if (timeout) this.#clearTimeout(timeout);
    }
  }

  #readyClient(): AuthenticatedHelperClient {
    if (this.#closing || this.#snapshot.state !== "ready" || !this.#client) {
      throw new HelperSupervisorError("helper_unavailable", "Remote helper is not ready.");
    }
    return this.#client;
  }

  async #discardFailedLaunch(launch: HelperLaunch): Promise<void> {
    await Promise.resolve(launch.requestDrain()).catch(() => undefined);
    await Promise.resolve(launch.closeParentChannel()).catch(() => undefined);
    await Promise.resolve(launch.forceTerminate()).catch(() => undefined);
  }

  async #onUnexpectedExit(generation: number, launch: HelperLaunch): Promise<void> {
    if (this.#closing || generation !== this.#generation) return;
    const client = this.#client;
    this.#unsubscribeStatus?.();
    this.#unsubscribeStatus = undefined;
    this.#client = undefined;
    if (this.#launch === launch) this.#launch = undefined;
    await client?.close().catch(() => undefined);
    await Promise.resolve(launch.closeParentChannel()).catch(() => undefined);
    if (this.#closing || generation !== this.#generation) return;
    this.#recordFailure(new HelperSupervisorError(
      "helper_unavailable",
      "Authenticated helper exited unexpectedly."
    ));
  }

  async #failReadyLaunch(error: HelperSupervisorError): Promise<void> {
    if (this.#closing) return;
    await this.#shutdownCurrentLaunch();
    this.#recordFailure(error);
  }

  #recordFailure(error: unknown): void {
    const failure = asSupervisorError(error);
    const now = this.#now();
    this.#failureTimes = this.#failureTimes
      .filter((timestamp) => now - timestamp <= HELPER_FAILURE_WINDOW_MS);
    this.#failureTimes.push(now);
    const consecutiveFailures = this.#snapshot.consecutiveFailures + 1;
    const degraded = this.#failureTimes.length >= HELPER_FAILURE_LIMIT;
    this.#update({
      state: "degraded",
      lastErrorCode: failure.code,
      runtimeStatus: Object.freeze({
        ...this.#snapshot.runtimeStatus,
        controlState: "unavailable",
        directState: this.#snapshot.runtimeStatus.directState === "direct"
          ? "direct"
          : "direct_unavailable",
        lastErrorCode: failure.code
      }),
      consecutiveFailures,
      restartScheduled: !degraded
    });
    this.#options.logger.warn("Remote helper lifecycle degraded", {
      role: this.#options.role,
      code: failure.code,
      failures: this.#failureTimes.length,
      restartScheduled: !degraded
    });
    if (!degraded) this.#scheduleRestart(consecutiveFailures);
  }

  #scheduleRestart(consecutiveFailures: number): void {
    this.#cancelRestart();
    const baseDelay = HELPER_RESTART_DELAYS_MS[
      Math.min(consecutiveFailures - 1, HELPER_RESTART_DELAYS_MS.length - 1)
    ]!;
    const boundedJitter = Math.max(-1, Math.min(1, this.#jitter()));
    const delay = Math.max(0, Math.round(baseDelay * (1 + boundedJitter * 0.1)));
    this.#restartTimer = this.#setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#closing) return;
      this.#update({ restartScheduled: false });
      void this.#runAttempt();
    }, delay);
  }

  #cancelRestart(): void {
    if (this.#restartTimer) this.#clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  async #shutdownCurrentLaunch(): Promise<void> {
    const launch = this.#launch;
    const client = this.#client;
    this.#launch = undefined;
    this.#client = undefined;
    this.#unsubscribeStatus?.();
    this.#unsubscribeStatus = undefined;
    if (!launch) return;
    await client?.close().catch(() => undefined);
    await Promise.resolve(launch.requestDrain()).catch(() => undefined);
    let drainTimer: TimerHandle | undefined;
    const drained = await Promise.race([
      launch.exited.then(() => true, () => true),
      new Promise<false>((resolve) => {
        drainTimer = this.#setTimeout(() => resolve(false), HELPER_GRACEFUL_DRAIN_MS);
      })
    ]);
    if (drainTimer) this.#clearTimeout(drainTimer);
    if (!drained) {
      await Promise.resolve(launch.forceTerminate()).catch(() => undefined);
      await launch.exited.catch(() => undefined);
    }
    await Promise.resolve(launch.closeParentChannel()).catch(() => undefined);
  }

  #update(patch: Partial<HelperSupervisorSnapshot>): void {
    const next = Object.freeze({
      ...this.#snapshot,
      ...patch,
      capabilities: Object.freeze([...(patch.capabilities ?? this.#snapshot.capabilities)]),
      runtimeStatus: Object.freeze({
        ...this.#snapshot.runtimeStatus,
        ...(patch.runtimeStatus ?? {})
      })
    });
    this.#snapshot = next;
    for (const listener of this.#listeners) listener(next);
  }
}
