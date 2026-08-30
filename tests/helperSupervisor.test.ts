import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import {
  HelperSupervisor,
  type HelperSupervisorOptions
} from "../src/remote/helperSupervisor.js";
import type {
  AuthenticatedHelperClient,
  HelperLaunch,
  HelperLaunchRequest,
  HelperProcessExit,
  HelperProcessFactory,
  HelperRuntimeStatus,
  VerifiedHelperSelection
} from "../src/remote/helperTypes.js";
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
    close: async () => {},
    ...overrides
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
