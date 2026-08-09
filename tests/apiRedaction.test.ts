import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { redactSecrets } from "../src/backend/redaction.js";
import type { LogEntry, Logger } from "../src/backend/logger.js";
import { createRuntimeState, type RuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { recordProviderQuery, recordProviderReply } from "../src/shared/queryLog.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const PROVIDER_SECRET = "sk-conflict_123456789012345678901234";
const STALE_PROVIDER_SECRET = "sk-stale_123456789012345678901234";
const DISCORD_SECRET = "M12345678901234567890123.ABCDEF.abcdefghijklmnopqrstuvwxyz1234";
const STALE_DISCORD_SECRET = "M98765432109876543210987.UVWXYZ.zyxwvutsrqponmlkjihgfedcba4321";
const AUTHORIZATION_SECRET = "authorization-sentinel-1234567890";
const INVITATION_SECRET = `WF1.${"A".repeat(96)}`;
const INTERNAL_CAPABILITY = "internal-capability-sentinel-1234567890";
const ENDPOINT = "192.0.2.1:41641";
const HELPER_SOCKET = "/private/tmp/waifus-helper-secret.sock";
const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "private-key-sentinel-1234567890",
  "-----END PRIVATE KEY-----"
].join("\n");

const SECRET_SENTINELS = [
  PROVIDER_SECRET,
  STALE_PROVIDER_SECRET,
  DISCORD_SECRET,
  STALE_DISCORD_SECRET,
  AUTHORIZATION_SECRET,
  INVITATION_SECRET,
  INTERNAL_CAPABILITY,
  ENDPOINT,
  HELPER_SOCKET,
  "private-key-sentinel-1234567890"
];

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function expectNoSentinels(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of SECRET_SENTINELS) {
    expect(serialized).not.toContain(sentinel);
  }
}

function makeRuntime(root: string): RuntimeState {
  return createRuntimeState({
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
      warnings: [
        `Authorization: Bearer ${AUTHORIZATION_SECRET}`,
        `direct endpoint ${ENDPOINT}`,
        `helperSocketPath=${HELPER_SOCKET}`,
        PRIVATE_KEY
      ]
    },
    queues: { active: 0, configuredGuilds: 0 }
  });
}

function testLogger(initial: LogEntry[] = []) {
  const entries = [...initial];
  const listeners = new Set<(entry: LogEntry) => void>();
  const emit = (level: LogEntry["level"], message: string, context?: unknown) => {
    const entry = { time: new Date().toISOString(), level, message, context };
    entries.unshift(entry);
    for (const listener of listeners) listener(entry);
  };
  const logger: Logger = {
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
  return { logger, entries };
}

async function makeApp(options: {
  logger?: Logger;
  runtime?: RuntimeState;
  reload?: () => Promise<void>;
} = {}) {
  const root = await makeTempRoot("waifus-api-redaction-");
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = options.runtime ?? makeRuntime(root);
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.reload
      ? {
          runtimeControl: {
            getOrchestrator: () => undefined,
            pause: async () => undefined,
            resume: async () => undefined,
            reload: options.reload
          }
        }
      : {}),
    remoteTrust: { isAuthorized: () => true }
  });
  apps.push(app);
  return { app, root, runtime };
}

function remotePrincipal() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: Buffer.alloc(16, 0x51).toString("base64url"),
    transportSessionId: Buffer.alloc(16, 0x52).toString("base64url"),
    trustEpoch: "11"
  });
}

describe("conflict response redaction", () => {
  it("returns only revision metadata for stale provider and Discord-bot writes", async () => {
    const { app } = await makeApp();
    const provider = await app.inject({
      method: "PUT",
      url: "/api/providers/openai/credentials",
      payload: { revision: 0, apiKey: PROVIDER_SECRET }
    });
    expect(provider.statusCode).toBe(200);
    const staleProvider = await app.inject({
      method: "PUT",
      url: "/api/providers/openai/credentials",
      payload: { revision: 0, apiKey: STALE_PROVIDER_SECRET }
    });

    const bots = await app.inject({
      method: "PUT",
      url: "/api/discord-bots",
      payload: {
        revision: 0,
        orchestrator: {
          id: "orchestrator",
          displayName: "Orchestrator",
          token: DISCORD_SECRET,
          enabled: true
        },
        waifus: []
      }
    });
    expect(bots.statusCode).toBe(200);
    const staleBots = await app.inject({
      method: "PUT",
      url: "/api/discord-bots",
      payload: {
        revision: 0,
        orchestrator: {
          id: "orchestrator",
          displayName: "Orchestrator",
          token: STALE_DISCORD_SECRET,
          enabled: true
        },
        waifus: []
      }
    });

    for (const response of [staleProvider, staleBots]) {
      expect(response.statusCode).toBe(409);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        error: "Conflict",
        message: "Record has changed since it was read.",
        latest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          revision: 1,
          updatedAt: expect.any(String)
        }
      });
      expectNoSentinels({ headers: response.headers, body: response.body });
    }
  });
});

describe("principal-aware response redaction", () => {
  it("keeps intended local runtime details and removes host-only details remotely", async () => {
    const { entries, logger } = testLogger([{
      time: new Date().toISOString(),
      level: "warn",
      message: "helper connection detail",
      context: {
        dataRoot: "filled-after-app-creation",
        endpointCandidates: [ENDPOINT],
        helperSocketPath: HELPER_SOCKET,
        invitationSecret: INVITATION_SECRET,
        internalCapability: INTERNAL_CAPABILITY
      }
    }]);
    const { app, root } = await makeApp({ logger });
    entries[0].context = {
      dataRoot: root,
      endpointCandidates: [ENDPOINT],
      helperSocketPath: HELPER_SOCKET,
      invitationSecret: INVITATION_SECRET,
      internalCapability: INTERNAL_CAPABILITY
    };
    const actor = remotePrincipal();

    const localStatus = await app.inject({ method: "GET", url: "/api/status" });
    const localRuntime = await app.inject({ method: "GET", url: "/api/runtime" });
    const localDiagnostics = await app.inject({ method: "GET", url: "/api/diagnostics/bundle" });
    expect(localStatus.json()).toMatchObject({
      dataRoot: root,
      httpUrl: "http://127.0.0.1:3888"
    });
    expect(localRuntime.json()).toMatchObject({ dataRoot: root, port: 3888, pid: process.pid });
    expect(localDiagnostics.json().runtime.dataRoot).toBe(root);

    const remoteStatus = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/api/status"
    });
    const remoteRuntime = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/api/runtime"
    });
    const remotePause = await dispatchInternal(app, actor, undefined, {
      method: "POST",
      url: "/api/runtime/pause"
    });
    const remoteDiagnostics = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/api/diagnostics/bundle"
    });
    const remoteLogs = await dispatchInternal(app, actor, undefined, {
      method: "GET",
      url: "/api/logs"
    });

    expect(remoteStatus.json()).not.toHaveProperty("dataRoot");
    expect(remoteStatus.json()).not.toHaveProperty("httpUrl");
    expect(remoteRuntime.json()).not.toHaveProperty("dataRoot");
    expect(remoteRuntime.json()).not.toHaveProperty("port");
    expect(remoteRuntime.json()).not.toHaveProperty("pid");
    expect(remotePause.json()).not.toHaveProperty("dataRoot");
    expect(remotePause.json()).not.toHaveProperty("port");
    expect(remotePause.json()).not.toHaveProperty("pid");
    expect(remoteDiagnostics.json().runtime).not.toHaveProperty("dataRoot");
    for (const response of [remoteStatus, remoteRuntime, remotePause, remoteDiagnostics, remoteLogs]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain("http://127.0.0.1");
      expectNoSentinels(response.body);
    }
  });
});

describe("final serialization and error-log redaction", () => {
  it("scrubs the forbidden corpus from logs, query/reply capture, diagnostics, audit stubs, and SSE", async () => {
    const rawContext = {
      apiKey: PROVIDER_SECRET,
      token: DISCORD_SECRET,
      authorization: `Bearer ${AUTHORIZATION_SECRET}`,
      invitationSecret: INVITATION_SECRET,
      internalCapability: INTERNAL_CAPABILITY,
      endpointCandidates: [ENDPOINT],
      helperSocketPath: HELPER_SOCKET,
      privateKey: PRIVATE_KEY
    };
    const { logger } = testLogger([{
      time: new Date().toISOString(),
      level: "error",
      message: `Authorization: Bearer ${AUTHORIZATION_SECRET}; endpoint ${ENDPOINT}`,
      context: rawContext
    }]);
    const { app } = await makeApp({ logger });
    const query = recordProviderQuery("assistant", {
      messages: [{ role: "user", content: rawContext }]
    });
    const reply = recordProviderReply("assistant", query.id, 401, false, rawContext);
    const auditStub = redactSecrets({
      actor: "remote:travel-mac",
      requestBody: rawContext,
      result: rawContext
    });

    expectNoSentinels(query);
    expectNoSentinels(reply);
    expectNoSentinels(auditStub);

    for (const url of ["/api/status", "/api/runtime", "/api/logs", "/api/diagnostics/bundle"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expectNoSentinels(response.body);
    }

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    for (let index = 0; index < 20 && !stream.includes("event: reply"); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect(stream).toContain("event: runtime");
    expect(stream).toContain("event: query");
    expect(stream).toContain("event: reply");
    expectNoSentinels(stream);
  });

  it("redacts unknown-error message and stack before handing them to the logger", async () => {
    const captured = testLogger();
    const secretError = [
      `Authorization: Bearer ${AUTHORIZATION_SECRET}`,
      `endpoint=${ENDPOINT}`,
      PRIVATE_KEY
    ].join("; ");
    const { app } = await makeApp({
      logger: captured.logger,
      reload: async () => {
        throw new Error(secretError);
      }
    });
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { runtime: { paused: true } }
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "InternalServerError" });
    expect(captured.entries).toHaveLength(1);
    expectNoSentinels(captured.entries);
  });
});
