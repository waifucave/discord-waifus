import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import type { LogEntry, Logger } from "../src/backend/logger.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import type { ModelPipeline } from "../src/providers/types.js";
import { parseEventCursor } from "../src/shared/eventCursor.js";
import { SseParser, type ParsedSseEvent } from "../src/frontend/api/resumableEventFeed.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function testLogger(): Logger {
  const entries: LogEntry[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();
  const emit = (level: LogEntry["level"], message: string, context?: unknown): void => {
    const entry = { time: new Date().toISOString(), level, message, context };
    entries.unshift(entry);
    for (const listener of listeners) listener(entry);
  };
  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    recent: () => [...entries],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

async function makeApp(options: {
  logger?: Logger;
  authorizeRemote?: () => boolean;
  assistantPipeline?: ModelPipeline;
} = {}) {
  const root = await makeTempRoot("waifus-events-api-");
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: {
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: []
    },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.authorizeRemote
      ? { remoteTrust: { isAuthorized: () => options.authorizeRemote!() } }
      : {}),
    ...(options.assistantPipeline
      ? { assistant: { createPipeline: () => options.assistantPipeline! } }
      : {})
  });
  apps.push(app);
  return { app, root };
}

function remotePrincipal() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: Buffer.alloc(16, 0x41).toString("base64url"),
    transportSessionId: Buffer.alloc(16, 0x42).toString("base64url"),
    trustEpoch: "5"
  });
}

class SseReader {
  private readonly parser = new SseParser();
  private readonly decoder = new TextDecoder();
  private readonly queued: ParsedSseEvent[] = [];

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(): Promise<ParsedSseEvent> {
    while (this.queued.length === 0) {
      const chunk = await withTimeout(this.reader.read(), 3_000, "SSE frame");
      if (chunk.done) {
        this.queued.push(...this.parser.push(this.decoder.decode()), ...this.parser.finish());
        break;
      }
      this.queued.push(...this.parser.push(this.decoder.decode(chunk.value, { stream: true })));
    }
    const event = this.queued.shift();
    if (!event) throw new Error("SSE stream ended before the expected frame.");
    return event;
  }
}

async function closeFetchStream(
  controller: AbortController,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  controller.abort();
  await reader.cancel().catch(() => undefined);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("global event API", () => {
  it("emits a canonical snapshot and replays the bounded suffix from Last-Event-ID", async () => {
    const logger = testLogger();
    const { app } = await makeApp({ logger });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const firstController = new AbortController();
    const firstResponse = await fetch(`${address}/api/events`, { signal: firstController.signal });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("content-type")).toContain("text/event-stream");
    const firstRawReader = firstResponse.body!.getReader();
    const firstReader = new SseReader(firstRawReader);
    const snapshot = await firstReader.next();
    expect(snapshot.event).toBe("snapshot");
    expect(snapshot.id).toMatch(/^v1:[A-Za-z0-9_-]{21}[AQgw]:0$/u);
    expect(JSON.parse(snapshot.data)).toMatchObject({
      version: 1,
      runtime: { mode: "test", paused: false },
      logs: [],
      queries: expect.any(Array),
      replies: expect.any(Array)
    });

    logger.info("first-live-event", { value: 1 });
    const first = await firstReader.next();
    expect(first).toMatchObject({ event: "log", id: expect.any(String) });
    expect(parseEventCursor(first.id!)).toMatchObject({ sequence: "1" });
    await closeFetchStream(firstController, firstRawReader);

    logger.info("second-offline-event", { value: 2 });
    const secondController = new AbortController();
    const secondResponse = await fetch(`${address}/api/events`, {
      headers: { "Last-Event-ID": first.id! },
      signal: secondController.signal
    });
    const secondRawReader = secondResponse.body!.getReader();
    const replay = await new SseReader(secondRawReader).next();
    expect(replay.event).toBe("log");
    expect(replay.id).toBe(`v1:${parseEventCursor(first.id!).streamEpoch}:2`);
    expect(JSON.parse(replay.data)).toMatchObject({ message: "second-offline-event" });
    await closeFetchStream(secondController, secondRawReader);
  });

  it("sends snapshot_required before a canonical snapshot for epoch mismatch and cursor gaps", async () => {
    const { app } = await makeApp();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const foreignEpoch = Buffer.alloc(16, 0x7d).toString("base64url");
    for (const lastEventId of [`v1:${foreignEpoch}:1`, "malformed"]) {
      const controller = new AbortController();
      const response = await fetch(`${address}/api/events`, {
        headers: { "Last-Event-ID": lastEventId },
        signal: controller.signal
      });
      const rawReader = response.body!.getReader();
      const reader = new SseReader(rawReader);
      const reset = await reader.next();
      const snapshot = await reader.next();
      expect(reset.event).toBe("snapshot_required");
      expect(reset.id).toBeUndefined();
      expect(JSON.parse(reset.data)).toMatchObject({
        version: 1,
        type: "snapshot_required",
        reason: lastEventId === "malformed" ? "cursor_gap" : "epoch_mismatch"
      });
      expect(snapshot.event).toBe("snapshot");
      expect(snapshot.id).toMatch(/^v1:[A-Za-z0-9_-]{21}[AQgw]:0$/u);
      await closeFetchStream(controller, rawReader);
    }
  });

  it("redacts remote frames and closes before delivering the first event after revocation", async () => {
    const logger = testLogger();
    let allowed = true;
    let authorizationChecks = 0;
    const { app, root } = await makeApp({
      logger,
      authorizeRemote: () => {
        authorizationChecks += 1;
        return allowed;
      }
    });
    const responsePromise = dispatchInternal(app, remotePrincipal(), undefined, {
      method: "GET",
      url: "/api/events"
    });
    await waitFor(() => authorizationChecks >= 2, "remote snapshot authorization");
    logger.info("authorized-visible", {
      dataRoot: root,
      apiKey: "sk-secret-remote-event-1234567890"
    });
    await waitFor(() => authorizationChecks >= 3, "remote live-event authorization");
    allowed = false;
    logger.info("must-not-cross-revocation", { protected: true });

    const response = await withTimeout(responsePromise, 3_000, "revoked global stream close");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: snapshot");
    expect(response.body).toContain("authorized-visible");
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain("sk-secret-remote-event-1234567890");
    expect(response.body).not.toContain("must-not-cross-revocation");
  });
});

describe("assistant event API", () => {
  it("closes a remote assistant stream without leaking the next protected event after revocation", async () => {
    let finishTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        throw new Error("unused");
      },
      async generateAssistantTurn(request) {
        await turnGate;
        return {
          content: "must-not-cross-assistant-revocation",
          messages: [
            ...request.messages,
            { role: "assistant", content: "must-not-cross-assistant-revocation" }
          ]
        };
      }
    };
    let allowed = true;
    let authorizationChecks = 0;
    const { app } = await makeApp({
      assistantPipeline: pipeline,
      authorizeRemote: () => {
        authorizationChecks += 1;
        return allowed;
      }
    });
    await app.inject({
      method: "PUT",
      url: "/api/providers/deepseek/credentials",
      payload: { apiKey: "sk-test" }
    });
    const orchestrator = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
    await app.inject({
      method: "PUT",
      url: "/api/orchestrator/config",
      payload: {
        revision: orchestrator.json().revision,
        providerId: "deepseek",
        modelId: "deepseek-v4-pro"
      }
    });
    const created = await app.inject({ method: "POST", url: "/api/assistant/conversations" });
    const conversationId = created.json().conversationId as string;
    const streamPromise = dispatchInternal(app, remotePrincipal(), undefined, {
      method: "GET",
      url: `/api/assistant/conversations/${conversationId}/stream`
    });
    await waitFor(() => authorizationChecks >= 2, "remote assistant snapshot authorization");
    const turnPromise = app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversationId}/messages`,
      payload: { content: "continue" }
    });
    await waitFor(() => authorizationChecks >= 3, "authorized assistant event");
    allowed = false;
    finishTurn();

    const [streamResponse, turnResponse] = await Promise.all([
      withTimeout(streamPromise, 3_000, "revoked assistant stream close"),
      withTimeout(turnPromise, 3_000, "assistant turn completion")
    ]);
    expect(turnResponse.statusCode).toBe(200);
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body).toContain("event: snapshot");
    expect(streamResponse.body).toContain("\"type\":\"turn_started\"");
    expect(streamResponse.body).not.toContain("must-not-cross-assistant-revocation");
  });
});
