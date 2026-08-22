import net from "node:net";
import path from "node:path";
import { writeFile } from "node:fs/promises";
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
});

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
