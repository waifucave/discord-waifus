import net from "node:net";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackend, type RunningBackend } from "../src/backend/server.js";
import { createRuntimeState, RuntimeStateSchema } from "../src/backend/runtime.js";
import type { Logger } from "../src/backend/logger.js";
import { ensureDataLayout } from "../src/config/layout.js";
import type {
  DiscordGatewayFacade,
  DiscordJsGatewayOptions,
  DiscordRuntimeIssue,
  DiscordRuntimeStatus
} from "../src/discord/client.js";
import type { ContextMessage } from "../src/orchestration/context.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import type {
  HelperRuntimeStatus,
  HelperSupervisorSnapshot
} from "../src/remote/helperTypes.js";
import type { HelperSupervisorController } from "../src/backend/remoteAccess/remoteAccessService.js";

let roots: string[] = [];
let backends: RunningBackend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("remote-access runtime summary", () => {
  it("accepts a sanitized optional summary without requiring helper startup", () => {
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: "2026-08-10T12:00:00.000Z",
      packageVersion: "1.5.203",
      port: 3888,
      dataRoot: "/private/tmp/waifus-runtime-test",
      mode: "test",
      paused: false,
      discord: connectedStatus(),
      queues: { active: 0, configuredGuilds: 0 },
      remoteAccess: {
        version: 1,
        enabled: false,
        helperState: "disabled",
        activationState: "activation_required",
        controlState: "inactive",
        directState: "inactive",
        trustedDeviceCount: 2,
        lastDirectAt: null,
        lastErrorCode: null
      }
    });

    expect(runtime.remoteAccess).toMatchObject({
      enabled: false,
      trustedDeviceCount: 2,
      directState: "inactive"
    });
    expect(() => RuntimeStateSchema.parse({
      ...runtime,
      remoteAccess: { ...runtime.remoteAccess, directState: "direct" }
    })).toThrow(/inactive runtime state/u);
  });

  it("integrates disabled remote access without launching the helper", async () => {
    const root = await initializedRemoteRoot();
    const supervisor = new FakeRemoteSupervisor();
    const backend = await startRemoteTestBackend(root, supervisor);

    expect(supervisor.startCalls).toBe(0);
    expect(backend.runtime.remoteAccess).toEqual({
      version: 1,
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      trustedDeviceCount: 0,
      lastDirectAt: null,
      lastErrorCode: null
    });
  });

  it("listens before starting the helper and mirrors its sanitized status", async () => {
    const root = await initializedRemoteRoot();
    await enableRemoteAccess(root);
    const port = await freePort();
    let healthDuringHelperStart = 0;
    const supervisor = new FakeRemoteSupervisor(remoteSupervisorSnapshot({
      runtimeStatus: remoteHelperStatus({
        directState: "direct",
        lastDirectAt: "100" as never
      })
    }));
    supervisor.onStart = async () => {
      healthDuringHelperStart = (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
    };

    const backend = await startRemoteTestBackend(root, supervisor, { port });

    expect(healthDuringHelperStart).toBe(200);
    expect(supervisor.startCalls).toBe(1);
    expect(backend.runtime.remoteAccess).toMatchObject({
      enabled: true,
      helperState: "ready",
      directState: "direct",
      lastDirectAt: "100"
    });
  });

  it("keeps the local host online when helper startup degrades", async () => {
    const root = await initializedRemoteRoot();
    await enableRemoteAccess(root);
    const supervisor = new FakeRemoteSupervisor();
    supervisor.startError = Object.assign(new Error("missing verified helper"), {
      code: "helper_missing"
    });
    const backend = await startRemoteTestBackend(root, supervisor);

    expect((await fetch(`${backend.url}/api/health`)).status).toBe(200);
    expect(backend.runtime.remoteAccess).toMatchObject({
      enabled: true,
      helperState: "failed",
      lastErrorCode: "helper_missing"
    });
  });

  it("uses the effective runtime host for the loopback prerequisite", async () => {
    const root = await initializedRemoteRoot();
    await enableRemoteAccess(root);
    const supervisor = new FakeRemoteSupervisor();
    const backend = await startRemoteTestBackend(root, supervisor, { host: "0.0.0.0" });

    expect(supervisor.startCalls).toBe(0);
    expect(backend.runtime.remoteAccess).toMatchObject({
      enabled: true,
      helperState: "failed",
      lastErrorCode: "bind_not_loopback"
    });
  });

  it("stops the helper while Fastify is still serving, then closes HTTP", async () => {
    const root = await initializedRemoteRoot();
    await enableRemoteAccess(root);
    const port = await freePort();
    let healthDuringHelperClose = 0;
    const supervisor = new FakeRemoteSupervisor();
    supervisor.onClose = async () => {
      healthDuringHelperClose = (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
    };
    const backend = await startRemoteTestBackend(root, supervisor, { port });

    await backend.close();
    backends = backends.filter((running) => running !== backend);

    expect(supervisor.closeCalls).toBe(1);
    expect(healthDuringHelperClose).toBe(200);
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });
});

class FakeRemoteSupervisor implements HelperSupervisorController {
  startCalls = 0;
  reconnectCalls = 0;
  closeCalls = 0;
  startError: Error | undefined;
  onStart: (() => Promise<void>) | undefined;
  onClose: (() => Promise<void>) | undefined;
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();

  constructor(private current = remoteSupervisorSnapshot()) {}

  snapshot(): HelperSupervisorSnapshot {
    return this.current;
  }

  identityStatus() {
    return null;
  }

  subscribe(listener: (snapshot: HelperSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    await this.onStart?.();
    if (this.startError) throw this.startError;
    for (const listener of this.#listeners) listener(this.current);
  }

  async stop(): Promise<void> {}

  async reconnect(): Promise<void> {
    this.reconnectCalls += 1;
  }

  async beginActivation(): Promise<never> {
    throw new Error("Activation is not configured in this backend lifecycle test.");
  }

  async pollActivation(): Promise<never> {
    throw new Error("Activation is not configured in this backend lifecycle test.");
  }

  async cancelActivation(): Promise<never> {
    throw new Error("Activation is not configured in this backend lifecycle test.");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.onClose?.();
  }
}

function remoteHelperStatus(
  overrides: Partial<HelperRuntimeStatus> = {}
): HelperRuntimeStatus {
  return {
    activationState: "active",
    controlState: "connected",
    directState: "inactive",
    lastDirectAt: null,
    lastErrorCode: null,
    ...overrides
  };
}

function remoteSupervisorSnapshot(
  overrides: Partial<HelperSupervisorSnapshot> = {}
): HelperSupervisorSnapshot {
  return {
    state: "ready",
    helperVersion: "0.1.0",
    releaseSequence: "42" as never,
    forkCommit: "0123456789abcdef0123456789abcdef01234567",
    target: { os: "darwin", arch: "arm64" },
    protocol: { major: 1, minor: 0 },
    capabilities: [
      "waifus.browser-context.v1",
      "waifus.dashboard.manifest.v1",
      "waifus.http.v1",
      "waifus.principal.v1",
      "waifus.sse.cursor.v1",
      "waifus.stream.cancel.v1"
    ],
    runtimeStatus: remoteHelperStatus(),
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false,
    ...overrides
  };
}

describe("backend Discord auto-connect retry", () => {
  it("serves HTTP before slow Discord auto-connect completes", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const gateway = new FakeDiscordGateway([connectedStatus()], { connectDelayMs: 20_000 });
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);

    const response = await fetch(`${backend.url}/api/status`);
    expect(response.status).toBe(200);
    const status = await response.json() as { running: boolean; discord: DiscordRuntimeStatus };
    expect(status.running).toBe(true);
    expect(status.discord).toMatchObject({
      connected: false,
      connecting: true
    });
    expect(backend.runtime.discord.connecting).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);

    await vi.waitFor(() => expect(backend.runtime.discord.connected).toBe(true));
    expect(backend.runtime.discord.connecting).toBeUndefined();
  });

  it("retries transient Discord DNS failures and clears retry status after recovery", async () => {
    const root = await initializedRootWithOrchestrator();
    const outcomes: Array<DiscordRuntimeStatus | Error> = [
      Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" }),
      connectedStatus()
    ];
    const gateway = new FakeDiscordGateway(outcomes);
    const backend = await startTestBackend(root, gateway, [250]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.retrying).toBe(true));
    expect(backend.runtime.discord).toMatchObject({
      connected: false,
      retrying: true,
      retryAttempt: 1,
      lastError: "getaddrinfo ENOTFOUND discord.com"
    });
    expect(backend.runtime.discord.nextRetryAt).toBeDefined();

    await waitForConnectCalls(gateway, 2);
    expect(backend.runtime.discord).toMatchObject({
      connected: true,
      orchestratorConnected: true,
      waifuBotCount: 0,
      warnings: []
    });
    expect(backend.runtime.discord.retrying).toBeUndefined();
    expect(backend.runtime.discord.nextRetryAt).toBeUndefined();
  });

  it("does not retry permanent Discord setup errors", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const gateway = new FakeDiscordGateway([new Error("An invalid token was provided.")]);
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.warnings).toEqual([
      "Discord auto-connect failed: An invalid token was provided."
    ]));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(gateway.connectCalls).toBe(1);
    expect(backend.runtime.discord.warnings).toEqual([
      "Discord auto-connect failed: An invalid token was provided."
    ]);
  });

  it("manual runtime reload clears the pending retry and attempts Discord immediately", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const outcomes: Array<DiscordRuntimeStatus | Error> = [
      Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" }),
      connectedStatus()
    ];
    const gateway = new FakeDiscordGateway(outcomes);
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.retrying).toBe(true));

    const response = await fetch(`${backend.url}/api/runtime/reload`, { method: "POST" });
    expect(response.status).toBe(200);

    expect(gateway.connectCalls).toBe(2);
    expect(backend.runtime.discord.connected).toBe(true);
    expect(backend.runtime.discord.retrying).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(gateway.connectCalls).toBe(2);
  });

  it("shutdown cancels pending Discord retry timers", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const outcomes: Array<DiscordRuntimeStatus | Error> = [
      Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" }),
      connectedStatus()
    ];
    const gateway = new FakeDiscordGateway(outcomes);
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.retrying).toBe(true));

    await backend.close();
    backends = backends.filter((running) => running !== backend);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(gateway.connectCalls).toBe(1);
  });

  it("retries transient live Discord runtime failures after a connected gateway reports them", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const gateway = new FakeDiscordGateway([connectedStatus(), connectedStatus()]);
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.connected).toBe(true));

    await gateway.emitRuntimeIssue(retryableDiscordIssue("getaddrinfo ENOTFOUND discord.com"));

    expect(gateway.disconnectCalls).toBe(1);
    expect(backend.runtime.discord).toMatchObject({
      connected: false,
      retrying: true,
      retryAttempt: 1,
      lastError: "getaddrinfo ENOTFOUND discord.com"
    });
    expect(backend.runtime.discord.warnings[0]).toBe(
      "Discord connection lost: getaddrinfo ENOTFOUND discord.com"
    );

    await vi.advanceTimersToNextTimerAsync();

    await waitForConnectCalls(gateway, 2);
    expect(backend.runtime.discord).toMatchObject({
      connected: true,
      orchestratorConnected: true,
      warnings: []
    });
  });

  it("updates live Discord retry errors without postponing a pending retry", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const gateway = new FakeDiscordGateway([connectedStatus(), connectedStatus()]);
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.connected).toBe(true));

    await gateway.emitRuntimeIssue(retryableDiscordIssue("getaddrinfo ENOTFOUND discord.com"));
    const nextRetryAt = backend.runtime.discord.nextRetryAt;

    await vi.advanceTimersByTimeAsync(1_000);
    await gateway.emitRuntimeIssue(retryableDiscordIssue("connect ETIMEDOUT discord.com"));

    expect(backend.runtime.discord).toMatchObject({
      retrying: true,
      retryAttempt: 1,
      nextRetryAt,
      lastError: "connect ETIMEDOUT discord.com"
    });

    await vi.advanceTimersByTimeAsync(4_000);

    await waitForConnectCalls(gateway, 2);
    expect(backend.runtime.discord.connected).toBe(true);
  });

  it("logs non-retryable live Discord runtime issues without forcing reconnect", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const gateway = new FakeDiscordGateway([connectedStatus()]);
    const backend = await startTestBackend(root, gateway, [5_000]);

    await waitForConnectCalls(gateway, 1);
    await vi.waitFor(() => expect(backend.runtime.discord.connected).toBe(true));

    await gateway.emitRuntimeIssue({
      source: "client-error",
      message: "An invalid token was provided.",
      error: new Error("An invalid token was provided.")
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(gateway.connectCalls).toBe(1);
    expect(gateway.disconnectCalls).toBe(0);
    expect(backend.runtime.discord.connected).toBe(true);
    expect(backend.runtime.discord.retrying).toBeUndefined();
  });
});

class FakeDiscordGateway implements DiscordGatewayFacade {
  connectCalls = 0;
  disconnectCalls = 0;
  onRuntimeIssue?: DiscordJsGatewayOptions["onRuntimeIssue"];

  constructor(
    private readonly outcomes: Array<DiscordRuntimeStatus | Error>,
    private readonly options: { connectDelayMs?: number } = {}
  ) {}

  async connect(): Promise<DiscordRuntimeStatus> {
    this.connectCalls += 1;
    const outcome = this.outcomes.shift() ?? connectedStatus();
    if (this.options.connectDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.connectDelayMs));
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async fetchFreshContext(): Promise<ContextMessage[]> {
    return [];
  }

  async sendWaifuMessage(): Promise<{ messageId: string }> {
    return { messageId: "message-1" };
  }

  async sendTyping(): Promise<void> {}

  async emitRuntimeIssue(issue: DiscordRuntimeIssue): Promise<void> {
    await this.onRuntimeIssue?.(issue);
  }
}

async function initializedRootWithOrchestrator(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  await writeFile(
    path.join(root, "user", "discord-bots.json"),
    JSON.stringify(
      {
        ...createRevisionedBase(),
        orchestrator: {
          id: "orchestrator",
          displayName: "Orchestrator",
          token: "test-token",
          enabled: true
        },
        waifus: []
      },
      null,
      2
    ) + "\n"
  );
  return root;
}

async function initializedRemoteRoot(): Promise<string> {
  const root = await makeTempRoot("waifus-backend-remote-");
  roots.push(root);
  await ensureDataLayout(root);
  return root;
}

async function enableRemoteAccess(root: string): Promise<void> {
  const paths = remoteStatePaths(root);
  const config = JSON.parse(await readFile(paths.hostConfig, "utf8")) as Record<string, unknown>;
  await writeFile(paths.hostConfig, JSON.stringify({
    ...config,
    revision: "1",
    enabled: true,
    updatedAt: "1"
  }, null, 2) + "\n", { mode: 0o600 });
  const installation = JSON.parse(
    await readFile(paths.installation, "utf8")
  ) as Record<string, unknown>;
  await writeFile(paths.installation, JSON.stringify({
    ...installation,
    activationReference: `waifus.activation.v1.${String(installation.installationId)}`
  }, null, 2) + "\n", { mode: 0o600 });
}

async function startRemoteTestBackend(
  root: string,
  supervisor: HelperSupervisorController,
  options: { port?: number; host?: string } = {}
): Promise<RunningBackend> {
  const backend = await startBackend({
    dataRoot: root,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? await freePort(),
    mode: "test",
    logger: quietLogger(),
    remoteAccess: {
      supervisor,
      dashboard: {
        path: path.resolve("dist-frontend"),
        source: "bundled",
        buildId: "a".repeat(64)
      }
    }
  });
  backends.push(backend);
  return backend;
}

async function startTestBackend(
  root: string,
  gateway: DiscordGatewayFacade,
  discordRetryDelaysMs: number[]
): Promise<RunningBackend> {
  const backend = await startBackend({
    dataRoot: root,
    host: "127.0.0.1",
    port: await freePort(),
    mode: "test",
    logger: quietLogger(),
    discordRetryDelaysMs,
    createDiscordGateway: (gatewayOptions) => {
      (gateway as FakeDiscordGateway).onRuntimeIssue = gatewayOptions.onRuntimeIssue;
      return gateway;
    }
  });
  backends.push(backend);
  return backend;
}

async function waitForConnectCalls(gateway: FakeDiscordGateway, count: number): Promise<void> {
  await vi.waitFor(() => expect(gateway.connectCalls).toBe(count), { timeout: 5_000 });
}

function retryableDiscordIssue(message: string): DiscordRuntimeIssue {
  return {
    source: "client-error",
    message,
    error: Object.assign(new Error(message), {
      code: message.includes("ETIMEDOUT") ? "ETIMEDOUT" : "ENOTFOUND"
    })
  };
}

function connectedStatus(): DiscordRuntimeStatus {
  return {
    connected: true,
    orchestratorConnected: true,
    waifuBotCount: 0,
    warnings: []
  };
}

function quietLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close(() => reject(new Error("Could not allocate test port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
