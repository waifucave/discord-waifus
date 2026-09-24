import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import type { RemoteRequestBridge } from "../src/backend/remoteAccess/requestBridge.js";
import {
  HelperSupervisor,
  type HelperSupervisorOptions
} from "../src/remote/helperSupervisor.js";
import { createProductionHelperSupervisor } from "../src/remote/productionHelper.js";
import type {
  AuthenticatedHelperClient,
  HelperLaunch,
  HelperLaunchRequest,
  HelperProcessExit,
  HelperProcessFactory,
  HelperRuntimeStatus,
  VerifiedHelperSelection
} from "../src/remote/helperTypes.js";
import type { IdentityResetReceiptV1 } from "../src/shared/schemas/remoteAccess.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const REQUIRED_CAPABILITIES = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const;

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function helperStatus(overrides: Partial<HelperRuntimeStatus> = {}): HelperRuntimeStatus {
  return {
    activationState: "active",
    controlState: "connected",
    directState: "inactive",
    lastDirectAt: null,
    lastErrorCode: null,
    ...overrides
  };
}

function helperClient(overrides: Partial<AuthenticatedHelperClient> = {}): AuthenticatedHelperClient {
  return {
    hello: {
      protocol: { major: 1, minor: 0 },
      component: "ts_connect",
      componentVersion: "0.1.0",
      buildId: "ts-connect-0123456789ab",
      nonce: Buffer.alloc(32, 0x41).toString("base64url") as never,
      capabilities: { required: [...REQUIRED_CAPABILITIES], optional: [] },
      controlProfile: 1,
      runtimePurpose: "normal"
    },
    negotiatedProtocol: { major: 1, minor: 0 },
    negotiatedCapabilities: [...REQUIRED_CAPABILITIES],
    currentStatus: () => helperStatus(),
    subscribeStatus: () => () => {},
    identityStatus: async () => ({
      activationState: "active",
      deviceId: "host-device-01",
      installationFingerprint: Buffer.alloc(16, 0x71).toString("base64url") as never,
      secretStorage: "keychain"
    }),
    startRuntime: async () => helperStatus({ controlState: "connected", directState: "reconnecting" }),
    runtimeStatus: async () => helperStatus({ controlState: "connected", directState: "reconnecting" }),
    reconnectRuntime: async () => helperStatus({ controlState: "reconnecting", directState: "reconnecting" }),
    stopRuntime: async () => helperStatus({ controlState: "inactive", directState: "inactive" }),
    registerGatewayLaunch: async () => {},
    requestSignedSelfRevocation: async () => true,
    forgetRememberedHost: async () => {},
    createInvitation: async () => ({
      invitationId: Buffer.alloc(16, 0x41).toString("base64url"),
      fullToken: `WF1.${Buffer.alloc(192).toString("base64url")}`,
      shortCode: "01AB-CDEF",
      expiresAt: "1786271130"
    }),
    cancelInvitation: async () => {},
    listPairingRequests: async () => ({ version: 1, requests: [] }),
    approvePairingRequest: async () => {},
    rejectPairingRequest: async () => {},
    listDevices: async () => ({ version: 1, devices: [] }),
    renameDevice: async (deviceId, input) => ({
      version: 1,
      deviceId,
      displayName: input.displayName,
      platform: { os: "darwin", arch: "arm64" },
      installationFingerprint: Buffer.alloc(16, 0x42).toString("base64url"),
      trustEpoch: "7",
      revision: String(BigInt(input.revision) + 1n),
      pairedAt: "1786000000",
      lastSeenAt: "1786270800",
      connectionState: "direct"
    }),
    revokeDevice: async () => {},
    reconcileDeviceRevocation: async () => {},
    resetIdentity: async () => identityResetReceipt(),
    getResetStatus: async () => identityResetReceipt(),
    request: async () => ({
      statusCode: 204,
      statusMessage: "No Content",
      headers: [],
      body: Readable.from([]),
      cancel: () => {}
    }),
    attachRequestBridge: () => {},
    close: async () => {},
    ...overrides
  };
}

function identityResetReceipt(): IdentityResetReceiptV1 {
  return {
    version: 1,
    resetTombstone: "19",
    resetId: Buffer.alloc(16, 0x51).toString("base64url"),
    oldInstallationPublicKey: Buffer.alloc(32, 0x52).toString("base64url"),
    newInstallationPublicKey: Buffer.alloc(32, 0x53).toString("base64url"),
    oldFingerprint: Buffer.alloc(16, 0x54).toString("base64url"),
    newFingerprint: Buffer.alloc(16, 0x55).toString("base64url"),
    clearedActivationCount: "1",
    clearedPairCount: "2",
    clearedHostRoleSecretCount: "3",
    clearedRemoteRoleSecretCount: "4",
    stage: "complete",
    completedAt: "1786271200"
  };
}

function selection(binaryPath: string): VerifiedHelperSelection {
  return {
    binaryPath,
    helperVersion: "0.1.0",
    releaseSequence: "42" as never,
    forkCommit: "0123456789abcdef0123456789abcdef01234567",
    target: { os: "darwin", arch: "arm64" },
    capabilities: [...REQUIRED_CAPABILITIES],
    ipcProtocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } }
  };
}

class FakeLaunch implements HelperLaunch {
  readonly #authentication = deferred<AuthenticatedHelperClient>();
  readonly #exit = deferred<HelperProcessExit>();
  readonly authenticated = this.#authentication.promise;
  readonly exited = this.#exit.promise;
  drainCalls = 0;
  parentCloseCalls = 0;
  forceCalls = 0;
  exitOnDrain = true;

  requestDrain(): void {
    this.drainCalls += 1;
    if (this.exitOnDrain) this.#exit.resolve({ code: 0, signal: null });
  }

  closeParentChannel(): void {
    this.parentCloseCalls += 1;
  }

  forceTerminate(): void {
    this.forceCalls += 1;
    this.#exit.resolve({ code: null, signal: "SIGKILL" });
  }

  resolveAuthenticated(client: AuthenticatedHelperClient): void {
    this.#authentication.resolve(client);
  }

  resolveExit(exit: HelperProcessExit): void {
    this.#exit.resolve(exit);
  }
}

class FakeProcessFactory implements HelperProcessFactory {
  readonly requests: HelperLaunchRequest[] = [];
  readonly launches: FakeLaunch[] = [];
  launchError: Error | undefined;

  async launch(request: HelperLaunchRequest): Promise<HelperLaunch> {
    this.requests.push(request);
    if (this.launchError) throw this.launchError;
    const launch = new FakeLaunch();
    this.launches.push(launch);
    return launch;
  }
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (message: string, context?: unknown) => {
    lines.push(JSON.stringify({ message, context }));
  };
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    lines
  };
}

async function makeSupervisor(
  factory: FakeProcessFactory,
  overrides: Partial<HelperSupervisorOptions> = {}
) {
  const dataRoot = await makeTempRoot("waifus-helper-supervisor-");
  roots.push(dataRoot);
  const logs = recordingLogger();
  const verified = selection(path.join(dataRoot, "package", "bin", "ts-connect"));
  const supervisor = new HelperSupervisor({
    role: "host",
    dataRoot,
    appVersion: "1.5.203",
    buildId: "dashboard-build",
    runtimePurpose: "normal",
    controlProfile: 1,
    packageResolver: { resolve: async () => verified },
    processFactory: factory,
    logger: logs.logger,
    jitter: () => 0,
    ...overrides
  });
  return { supervisor, verified, dataRoot, logs };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("role-neutral helper supervisor", () => {
  it("constructs the production supervisor with the verified package and protected process seams", async () => {
    const factory = new FakeProcessFactory();
    const dataRoot = await makeTempRoot("wph-");
    roots.push(dataRoot);
    const verified = selection(path.join(dataRoot, "package", "bin", "ts-connect"));
    const supervisor = await createProductionHelperSupervisor({
      role: "remote",
      dataRoot,
      appVersion: "1.5.203",
      buildId: "remote-gateway-1.5.203",
      logger: recordingLogger().logger,
      packageResolver: { resolve: async () => verified },
      processFactory: factory
    });

    const starting = supervisor.start();
    await settle();
    factory.launches[0].resolveAuthenticated(helperClient());
    await starting;

    expect(factory.requests).toHaveLength(1);
    expect(factory.requests[0]).toMatchObject({
      role: "remote",
      dataRoot,
      binaryPath: verified.binaryPath,
      argv: ["supervised", "--parent-endpoint", expect.any(String)],
      parentHello: {
        component: "discord_waifus",
        componentVersion: "1.5.203",
        buildId: "remote-gateway-1.5.203",
        controlProfile: 1,
        runtimePurpose: "normal"
      }
    });
    await supervisor.close();
  });

  it("rejects attaching a host request bridge to a remote-role supervisor", async () => {
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory, { role: "remote" });

    expect(() => supervisor.attachRequestBridge({} as RemoteRequestBridge)).toThrowError(
      "Only a host-role helper supervisor may attach the Fastify request bridge."
    );
    expect(factory.requests).toHaveLength(0);

    await supervisor.close();
  });

  it("exposes remote requests only through its current authenticated client", async () => {
    const factory = new FakeProcessFactory();
    const remoteSelection = {
      ...selection("/tmp/waifus-test-ts-connect.exe"),
      target: { os: "win32" as const, arch: "x64" as const }
    };
    const { supervisor } = await makeSupervisor(factory, {
      role: "remote",
      packageResolver: { resolve: async () => remoteSelection }
    });
    const canonicalTarget = "/api/remote-access/dashboard-manifest";
    const input = {
      method: "GET" as const,
      canonicalTarget,
      headers: [["accept", "application/json"]] as const,
      browserContext: {
        version: 1 as const,
        gatewayLaunchId: Buffer.alloc(32, 0x31).toString("base64url") as never,
        browserSessionId: Buffer.alloc(32, 0x32).toString("base64url") as never,
        requestNonce: Buffer.alloc(16, 0x33).toString("base64url") as never,
        method: "GET" as const,
        canonicalTarget,
        csrfValidated: true as const
      }
    };

    await expect(supervisor.request(input)).rejects.toMatchObject({ code: "helper_unavailable" });
    const request = vi.fn(helperClient().request);
    const started = supervisor.start();
    await vi.waitFor(() => expect(factory.launches).toHaveLength(1));
    factory.launches[0]!.resolveAuthenticated(helperClient({ request }));
    await started;

    const response = await supervisor.request(input);
    expect(response.statusCode).toBe(204);
    expect(request).toHaveBeenCalledWith(input);

    await supervisor.close();
  });

  it("attaches the authenticated request bridge and restores the desired runtime", async () => {
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const bridge = {} as RemoteRequestBridge;
    const attachRequestBridge = vi.fn();
    const startRuntime = vi.fn(async () => helperStatus({
      controlState: "connected",
      directState: "reconnecting"
    }));
    const stopRuntime = vi.fn(async () => helperStatus({
      controlState: "inactive",
      directState: "inactive"
    }));
    supervisor.attachRequestBridge(bridge);
    const started = supervisor.start();
    await settle();
    factory.launches[0]!.resolveAuthenticated(helperClient({
      attachRequestBridge,
      startRuntime,
      stopRuntime
    }));
    await started;

    await supervisor.startRuntime();
    expect(attachRequestBridge).toHaveBeenCalledWith(bridge);
    expect(startRuntime).toHaveBeenCalledWith(undefined);
    expect(supervisor.snapshot().runtimeStatus).toMatchObject({
      controlState: "connected",
      directState: "reconnecting"
    });

    const restarted = supervisor.reconnect();
    await vi.waitFor(() => expect(factory.launches).toHaveLength(2));
    const restartedClient = helperClient({ attachRequestBridge, startRuntime, stopRuntime });
    factory.launches[1]!.resolveAuthenticated(restartedClient);
    await restarted;
    expect(startRuntime).toHaveBeenCalledTimes(2);

    await supervisor.stop();
    expect(stopRuntime).toHaveBeenCalledTimes(2);
  });

  it("drains the helper and clears runtime restart intent after identity rotation", async () => {
    vi.useFakeTimers();
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const resetIdentity = vi.fn(async () => identityResetReceipt());
    const getResetStatus = vi.fn(async () => identityResetReceipt());
    const startRuntime = vi.fn(async () => helperStatus({
      controlState: "connected",
      directState: "reconnecting"
    }));
    const started = supervisor.start();
    await settle();
    const launch = factory.launches[0]!;
    launch.resolveAuthenticated(helperClient({ resetIdentity, getResetStatus, startRuntime }));
    await started;
    await supervisor.startRuntime();

    await expect(supervisor.getResetStatus({ resetTombstone: "19" }))
      .resolves.toEqual(identityResetReceipt());
    expect(getResetStatus).toHaveBeenCalledWith({ resetTombstone: "19" });

    await expect(supervisor.resetIdentity({
      resetTombstone: "19",
      expectedOldFingerprint: Buffer.alloc(16, 0x54).toString("base64url")
    })).resolves.toEqual(identityResetReceipt());

    expect(resetIdentity).toHaveBeenCalledWith({
      resetTombstone: "19",
      expectedOldFingerprint: Buffer.alloc(16, 0x54).toString("base64url")
    });
    expect(launch.drainCalls).toBe(1);
    expect(launch.parentCloseCalls).toBe(1);
    expect(supervisor.snapshot()).toMatchObject({
      state: "disabled",
      restartScheduled: false,
      runtimeStatus: {
        activationState: "activation_required",
        controlState: "inactive",
        directState: "inactive"
      }
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory.launches).toHaveLength(1);
    await supervisor.close();
  });

  it("retries the desired runtime start when the first start did not become active", async () => {
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const startRuntime = vi.fn()
      .mockRejectedValueOnce(new Error("first start failed"))
      .mockResolvedValueOnce(helperStatus({
        controlState: "connected",
        directState: "reconnecting"
      }));
    const reconnectRuntime = vi.fn(async () => helperStatus());
    const started = supervisor.start();
    await settle();
    factory.launches[0]!.resolveAuthenticated(helperClient({
      startRuntime,
      reconnectRuntime
    }));
    await started;

    await expect(supervisor.startRuntime()).rejects.toThrow("first start failed");
    await expect(supervisor.reconnectRuntime()).resolves.toMatchObject({
      controlState: "connected",
      directState: "reconnecting"
    });
    expect(startRuntime).toHaveBeenCalledTimes(2);
    expect(reconnectRuntime).not.toHaveBeenCalled();

    await supervisor.close();
  });

  it("passes secrets only through the protected capability field and validates HELLO metadata", async () => {
    const factory = new FakeProcessFactory();
    const { supervisor, verified, dataRoot, logs } = await makeSupervisor(factory);
    const started = supervisor.start();
    await settle();
    const launch = factory.launches[0]!;
    launch.resolveAuthenticated(helperClient());
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      helperVersion: "0.1.0",
      releaseSequence: "42",
      lastErrorCode: null
    });
    expect(factory.requests).toHaveLength(1);
    const request = factory.requests[0]!;
    expect(request).toMatchObject({
      role: "host",
      binaryPath: verified.binaryPath,
      argv: ["supervised", "--parent-endpoint", path.join(dataRoot, "app", "tmp", "remote-host", "p")],
      environment: {},
      parentHello: {
        component: "discord_waifus",
        componentVersion: "1.5.203",
        controlProfile: 1,
        runtimePurpose: "normal"
      }
    });
    expect(request.parentCapability).toHaveLength(32);
    const secretForms = [
      request.parentCapability.toString("hex"),
      request.parentCapability.toString("base64url")
    ];
    const publicLaunchShape = JSON.stringify({
      argv: request.argv,
      environment: request.environment,
      hello: request.parentHello,
      logs: logs.lines
    });
    for (const secret of secretForms) expect(publicLaunchShape).not.toContain(secret);

    await supervisor.close();
    expect(launch.drainCalls).toBe(1);
    expect(launch.parentCloseCalls).toBe(1);
  });

  it("fails closed on an incompatible helper HELLO", async () => {
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const started = supervisor.start();
    await settle();
    factory.launches[0]!.resolveAuthenticated(helperClient({
      hello: {
        ...helperClient().hello,
        componentVersion: "0.2.0"
      }
    }));
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastErrorCode: "helper_incompatible"
    });
    expect(factory.launches[0]!.parentCloseCalls).toBe(1);
    await supervisor.close();
  });

  it("does not derive a Windows pipe name from the parent capability", async () => {
    const factory = new FakeProcessFactory();
    const randomValues = [
      Buffer.alloc(32, 0x11),
      Buffer.alloc(32, 0x22),
      Buffer.alloc(16, 0x33)
    ];
    const { supervisor, dataRoot } = await makeSupervisor(factory, {
      randomBytes: (size) => {
        const value = randomValues.shift();
        expect(value?.byteLength).toBe(size);
        return value!;
      },
      packageResolver: {
        resolve: async () => ({
          ...selection(path.join(dataRoot, "package", "bin", "ts-connect.exe")),
          target: { os: "win32", arch: "x64" }
        })
      }
    });
    const started = supervisor.start();
    await settle();
    factory.launches[0]!.resolveAuthenticated(helperClient());
    await started;

    const request = factory.requests[0]!;
    expect(request.parentEndpoint).toBe(
      `\\\\.\\pipe\\waifus-parent.${Buffer.alloc(16, 0x33).toString("base64url")}`
    );
    expect(request.parentEndpoint).not.toContain(
      request.parentCapability.subarray(0, 16).toString("base64url")
    );
    await supervisor.close();
  });

  it("mirrors the latest helper status error at the top level", async () => {
    const factory = new FakeProcessFactory();
    let statusListener: ((status: HelperRuntimeStatus) => void) | undefined;
    const { supervisor } = await makeSupervisor(factory);
    const started = supervisor.start();
    await settle();
    factory.launches[0]!.resolveAuthenticated(helperClient({
      subscribeStatus: (listener) => {
        statusListener = listener;
        return () => {};
      }
    }));
    await started;

    statusListener!(helperStatus({
      controlState: "unavailable",
      lastErrorCode: "coordination_unavailable"
    }));
    expect(supervisor.snapshot()).toMatchObject({
      lastErrorCode: "coordination_unavailable",
      runtimeStatus: {
        controlState: "unavailable",
        lastErrorCode: "coordination_unavailable"
      }
    });
    await supervisor.close();
  });

  it("closes the parent channel when an authenticated helper exits unexpectedly", async () => {
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const started = supervisor.start();
    await settle();
    const launch = factory.launches[0]!;
    launch.resolveAuthenticated(helperClient());
    await started;

    launch.resolveExit({ code: 70, signal: null });
    await vi.waitFor(() => expect(supervisor.snapshot().state).toBe("degraded"));

    expect(launch.parentCloseCalls).toBe(1);
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastErrorCode: "helper_unavailable",
      restartScheduled: true
    });
    await supervisor.close();
  });

  it("enforces the five-second authentication deadline", async () => {
    vi.useFakeTimers();
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const started = supervisor.start();
    await settle();

    await vi.advanceTimersByTimeAsync(5_000);
    await started;
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastErrorCode: "helper_unavailable"
    });
    expect(factory.launches[0]!.parentCloseCalls).toBe(1);
    expect(factory.launches[0]!.forceCalls).toBe(1);
    await supervisor.close();
  });

  it("uses bounded restart backoff and enters degraded after ten failures in five minutes", async () => {
    vi.useFakeTimers();
    const factory = new FakeProcessFactory();
    factory.launchError = Object.assign(new Error("secret path must not be logged"), {
      code: "helper_unavailable"
    });
    const { supervisor, logs } = await makeSupervisor(factory);
    await supervisor.start();
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 30_000, 30_000];
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }

    expect(factory.requests).toHaveLength(10);
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 10,
      restartScheduled: false
    });
    expect(logs.lines.join("\n")).not.toContain("secret path must not be logged");

    await supervisor.reconnect();
    expect(factory.requests).toHaveLength(11);
    await supervisor.close();
  });

  it("drains for twenty seconds before force-terminating a stuck helper", async () => {
    vi.useFakeTimers();
    const factory = new FakeProcessFactory();
    const { supervisor } = await makeSupervisor(factory);
    const started = supervisor.start();
    await settle();
    const launch = factory.launches[0]!;
    launch.resolveAuthenticated(helperClient());
    await started;
    launch.exitOnDrain = false;

    const closing = supervisor.close();
    await settle();
    expect(launch.drainCalls).toBe(1);
    expect(launch.forceCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(launch.forceCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(launch.forceCalls).toBe(1);
    expect(launch.parentCloseCalls).toBe(1);
    expect(supervisor.snapshot().state).toBe("disabled");
  });
});
