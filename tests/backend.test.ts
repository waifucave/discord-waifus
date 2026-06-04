import net from "node:net";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackend, type RunningBackend } from "../src/backend/server.js";
import type { Logger } from "../src/backend/logger.js";
import { ensureDataLayout } from "../src/config/layout.js";
import type { DiscordGatewayFacade, DiscordRuntimeStatus } from "../src/discord/client.js";
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

describe("backend Discord auto-connect retry", () => {
  it("retries transient Discord DNS failures and clears retry status after recovery", async () => {
    vi.useFakeTimers();
    const root = await initializedRootWithOrchestrator();
    const outcomes: Array<DiscordRuntimeStatus | Error> = [
      Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" }),
      connectedStatus()
    ];
    const gateway = new FakeDiscordGateway(outcomes);
    const backend = await startTestBackend(root, gateway, [5_000]);

    expect(gateway.connectCalls).toBe(1);
    expect(backend.runtime.discord).toMatchObject({
      connected: false,
      retrying: true,
      retryAttempt: 1,
      lastError: "getaddrinfo ENOTFOUND discord.com"
    });
    expect(backend.runtime.discord.nextRetryAt).toBeDefined();

    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => expect(gateway.connectCalls).toBe(2));
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

    expect(gateway.connectCalls).toBe(1);
    expect(backend.runtime.discord.retrying).toBeUndefined();

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

    await backend.close();
    backends = backends.filter((running) => running !== backend);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(gateway.connectCalls).toBe(1);
  });
});

class FakeDiscordGateway implements DiscordGatewayFacade {
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(private readonly outcomes: Array<DiscordRuntimeStatus | Error>) {}

  async connect(): Promise<DiscordRuntimeStatus> {
    this.connectCalls += 1;
    const outcome = this.outcomes.shift() ?? connectedStatus();
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
    createDiscordGateway: () => gateway
  });
  backends.push(backend);
  return backend;
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
