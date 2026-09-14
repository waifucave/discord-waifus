import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import type { ModelPipeline } from "../src/providers/types.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeApp(extra: {
  assistantPipeline?: ModelPipeline;
  authorizeRemote?: (stableId: string) => boolean;
} = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "0.1.0",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    ...(extra.assistantPipeline ? { assistant: { createPipeline: () => extra.assistantPipeline! } } : {}),
    ...(extra.authorizeRemote
      ? { remoteTrust: { isAuthorized: (principal) => extra.authorizeRemote!(principal.stableId) } }
      : {})
  });
  return { app, root };
}

function remoteActor(deviceId: string, trustEpoch = "5", transportByte = 0x42) {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: Buffer.alloc(16, 0x41).toString("base64url"),
    transportSessionId: Buffer.alloc(16, transportByte).toString("base64url"),
    trustEpoch
  });
}

function browserHeaders() {
  return {
    host: "127.0.0.1:3888",
    origin: "http://127.0.0.1:3888",
    "sec-fetch-site": "same-origin"
  };
}

async function browserSession(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  const response = await app.inject({
    method: "GET",
    url: "/api/client-context",
    headers: browserHeaders()
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: String(response.headers["set-cookie"]),
    csrf: String(response.headers["x-waifus-csrf"])
  };
}

const fakePipeline: ModelPipeline = {
  async generateWaifu() {
    throw new Error("unused");
  },
  async generateAssistantTurn(request) {
    const toolResult = await request.executeTool("list_waifus", "{}");
    request.onEvent?.({ type: "tool_call", name: "list_waifus", arguments: "{}" });
    request.onEvent?.({ type: "tool_result", name: "list_waifus", result: toolResult });
    const count = (JSON.parse(toolResult) as unknown[]).length;
    return {
      content: `You have ${count} waifus.`,
      messages: [...request.messages, { role: "assistant", content: `You have ${count} waifus.` }]
    };
  }
};

describe("assistant chat API", () => {
  it("runs a turn end-to-end through the fake pipeline and real tools", async () => {
    const { app } = await makeApp({ assistantPipeline: fakePipeline });
    try {
      await app.inject({ method: "PUT", url: "/api/providers/deepseek/credentials", payload: { apiKey: "sk-test" } });
      const orch = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
      await app.inject({
        method: "PUT",
        url: "/api/orchestrator/config",
        payload: { revision: orch.json().revision, providerId: "deepseek", modelId: "deepseek-v4-pro" }
      });

      const created = await app.inject({ method: "POST", url: "/api/assistant/conversations" });
      expect(created.statusCode).toBe(200);
      const conversationId = created.json().conversationId as string;

      const waifus = await app.inject({ method: "GET", url: "/api/waifus" });
      const waifuCount = (waifus.json().waifus as unknown[]).length;

      const reply = await app.inject({
        method: "POST",
        url: `/api/assistant/conversations/${conversationId}/messages`,
        payload: { content: "how many waifus do I have?" }
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().reply).toBe(`You have ${waifuCount} waifus.`);

      const transcript = await app.inject({ method: "GET", url: `/api/assistant/conversations/${conversationId}` });
      expect(transcript.statusCode).toBe(200);
      const messages = transcript.json().messages as Array<{ role: string; cursor?: string }>;
      const roles = messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(roles).toContain("event");
      const eventCursors = messages.flatMap((message) => message.role === "event" ? [message.cursor] : []);
      expect(eventCursors.length).toBeGreaterThan(0);
      expect(eventCursors.every((cursor) => /^v1:[A-Za-z0-9_-]{21}[AQgw]:(?:0|[1-9][0-9]*)$/u.test(cursor ?? "")))
        .toBe(true);
    } finally {
      await app.close();
    }
  });

  it("keeps a remote actor through assistant snapshots and self-REST tools", async () => {
    const authorizedStableIds: string[] = [];
    const { app } = await makeApp({
      assistantPipeline: fakePipeline,
      authorizeRemote: (stableId) => {
        authorizedStableIds.push(stableId);
        return stableId === "remote:travel-mac";
      }
    });
    try {
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
      const actor = remoteActor("travel-mac");
      const created = await dispatchInternal(app, actor, undefined, {
        method: "POST",
        url: "/api/assistant/conversations",
        headers: { "idempotency-key": Buffer.alloc(32, 0x70).toString("base64url") }
      });
      const response = await dispatchInternal(app, actor, undefined, {
        method: "POST",
        url: `/api/assistant/conversations/${created.json<{ conversationId: string }>().conversationId}/messages`,
        headers: { "idempotency-key": Buffer.alloc(32, 0x71).toString("base64url") },
        payload: { content: "how many?" }
      });
      expect(response.statusCode).toBe(200);
      expect(authorizedStableIds.length).toBeGreaterThan(3);
      expect(new Set(authorizedStableIds)).toEqual(new Set(["remote:travel-mac"]));
    } finally {
      await app.close();
    }
  });

  it("hides conversations from other actors and invalidates a changed trust epoch", async () => {
    const { app } = await makeApp({ authorizeRemote: () => true });
    try {
      const owner = remoteActor("travel-mac", "5", 0x42);
      const reconnectedOwner = remoteActor("travel-mac", "5", 0x43);
      const changedEpoch = remoteActor("travel-mac", "6", 0x44);
      const otherDevice = remoteActor("studio-pc", "5", 0x45);
      const created = await dispatchInternal(app, owner, undefined, {
        method: "POST",
        url: "/api/assistant/conversations",
        headers: { "idempotency-key": Buffer.alloc(32, 0x72).toString("base64url") }
      });
      const id = created.json<{ conversationId: string }>().conversationId;

      expect((await dispatchInternal(app, reconnectedOwner, undefined, {
        method: "GET",
        url: `/api/assistant/conversations/${id}`
      })).statusCode).toBe(200);
      for (const actor of [changedEpoch, otherDevice]) {
        expect((await dispatchInternal(app, actor, undefined, {
          method: "GET",
          url: `/api/assistant/conversations/${id}`
        })).statusCode).toBe(404);
        expect((await dispatchInternal(app, actor, undefined, {
          method: "GET",
          url: "/api/assistant/conversations"
        })).json<{ conversations: unknown[] }>().conversations).toEqual([]);
      }
      expect((await dispatchInternal(app, otherDevice, undefined, {
        method: "POST",
        url: `/api/assistant/conversations/${id}/messages`,
        headers: { "idempotency-key": Buffer.alloc(32, 0x75).toString("base64url") },
        payload: { content: "cross-owner turn" }
      })).statusCode).toBe(404);
      expect((await dispatchInternal(app, otherDevice, undefined, {
        method: "DELETE",
        url: `/api/assistant/conversations/${id}`,
        headers: { "idempotency-key": Buffer.alloc(32, 0x76).toString("base64url") }
      })).statusCode).toBe(404);
      expect((await dispatchInternal(app, otherDevice, undefined, {
        method: "GET",
        url: `/api/assistant/conversations/${id}/stream`
      })).statusCode).toBe(404);
      expect((await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${id}`
      })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("isolates conversations between local browser sessions", async () => {
    const { app } = await makeApp();
    try {
      const browserA = await browserSession(app);
      const browserB = await browserSession(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/assistant/conversations",
        headers: {
          ...browserHeaders(),
          cookie: browserA.cookie,
          "x-waifus-csrf": browserA.csrf,
          "idempotency-key": Buffer.alloc(32, 0x77).toString("base64url")
        }
      });
      expect(created.statusCode).toBe(200);
      const id = created.json().conversationId as string;

      expect((await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${id}`,
        headers: { ...browserHeaders(), cookie: browserA.cookie }
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${id}`,
        headers: { ...browserHeaders(), cookie: browserB.cookie }
      })).statusCode).toBe(404);
      const listB = await app.inject({
        method: "GET",
        url: "/api/assistant/conversations",
        headers: { ...browserHeaders(), cookie: browserB.cookie }
      });
      expect(listB.json().conversations).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("does not commit a model reply after the remote owner is revoked mid-turn", async () => {
    let authorized = true;
    let markStarted: (() => void) | undefined;
    let finishTurn: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const delayedPipeline: ModelPipeline = {
      async generateWaifu() {
        throw new Error("unused");
      },
      async generateAssistantTurn(request) {
        markStarted!();
        await finish;
        return {
          content: "stale reply",
          messages: [...request.messages, { role: "assistant", content: "stale reply" }]
        };
      }
    };
    const { app } = await makeApp({
      assistantPipeline: delayedPipeline,
      authorizeRemote: () => authorized
    });
    try {
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
      const actor = remoteActor("travel-mac");
      const created = await dispatchInternal(app, actor, undefined, {
        method: "POST",
        url: "/api/assistant/conversations",
        headers: { "idempotency-key": Buffer.alloc(32, 0x73).toString("base64url") }
      });
      const id = created.json<{ conversationId: string }>().conversationId;
      const pending = dispatchInternal(app, actor, undefined, {
        method: "POST",
        url: `/api/assistant/conversations/${id}/messages`,
        headers: { "idempotency-key": Buffer.alloc(32, 0x74).toString("base64url") },
        payload: { content: "wait for it" }
      });
      await started;
      authorized = false;
      finishTurn!();
      expect((await pending).statusCode).toBe(403);

      authorized = true;
      const transcript = await dispatchInternal(app, actor, undefined, {
        method: "GET",
        url: `/api/assistant/conversations/${id}`
      });
      expect(transcript.statusCode).toBe(200);
      const body = transcript.json<{ busy: boolean; messages: Array<{ role: string; content?: string }> }>();
      expect(body.busy).toBe(false);
      expect(body.messages).not.toContainEqual(expect.objectContaining({ role: "assistant", content: "stale reply" }));
    } finally {
      await app.close();
    }
  });

  it("blocks a queued tool mutation after the remote owner is revoked", async () => {
    let authorized = true;
    let markToolQueued: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    const toolQueued = new Promise<void>((resolve) => {
      markToolQueued = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const queuedToolPipeline: ModelPipeline = {
      async generateWaifu() {
        throw new Error("unused");
      },
      async generateAssistantTurn(request) {
        markToolQueued!();
        await toolGate;
        await request.executeTool("runtime_pause", "{}");
        return {
          content: "paused",
          messages: [...request.messages, { role: "assistant", content: "paused" }]
        };
      }
    };
    const { app } = await makeApp({
      assistantPipeline: queuedToolPipeline,
      authorizeRemote: () => authorized
    });
    try {
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
      const actor = remoteActor("travel-mac");
      const created = await dispatchInternal(app, actor, undefined, {
        method: "POST",
        url: "/api/assistant/conversations",
        headers: { "idempotency-key": Buffer.alloc(32, 0x78).toString("base64url") }
      });
      const id = created.json<{ conversationId: string }>().conversationId;
      const pending = dispatchInternal(app, actor, undefined, {
        method: "POST",
        url: `/api/assistant/conversations/${id}/messages`,
        headers: { "idempotency-key": Buffer.alloc(32, 0x79).toString("base64url") },
        payload: { content: "pause it" }
      });
      await toolQueued;
      authorized = false;
      releaseTool!();
      expect((await pending).statusCode).toBe(403);

      authorized = true;
      const status = await dispatchInternal(app, actor, undefined, {
        method: "GET",
        url: "/api/status"
      });
      expect(status.statusCode).toBe(200);
      expect(status.json<{ paused: boolean }>().paused).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("503s with a reason when no model is configured anywhere", async () => {
    const { app } = await makeApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/assistant/conversations" });
      const reply = await app.inject({
        method: "POST",
        url: `/api/assistant/conversations/${created.json().conversationId}/messages`,
        payload: { content: "hi" }
      });
      expect(reply.statusCode).toBe(503);
      expect(String(reply.json().error)).toMatch(/model/i);
    } finally {
      await app.close();
    }
  });

  it("404s for unknown conversations", async () => {
    const { app } = await makeApp();
    try {
      const transcript = await app.inject({ method: "GET", url: "/api/assistant/conversations/nope" });
      expect(transcript.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("assistant conversation listing", () => {
  it("lists conversations and reflects deletes", async () => {
    const { app } = await makeApp();
    try {
      const a = JSON.parse((await app.inject({ method: "POST", url: "/api/assistant/conversations" })).body) as { conversationId: string };
      const b = JSON.parse((await app.inject({ method: "POST", url: "/api/assistant/conversations" })).body) as { conversationId: string };
      const list = JSON.parse((await app.inject({ method: "GET", url: "/api/assistant/conversations" })).body) as {
        conversations: Array<{ id: string; createdAt: string; messageCount: number }>;
      };
      expect(list.conversations.map((c) => c.id).sort()).toEqual([a.conversationId, b.conversationId].sort());
      expect(list.conversations.every((c) => typeof c.createdAt === "string" && c.messageCount === 0)).toBe(true);
      await app.inject({ method: "DELETE", url: `/api/assistant/conversations/${a.conversationId}` });
      const after = JSON.parse((await app.inject({ method: "GET", url: "/api/assistant/conversations" })).body) as { conversations: unknown[] };
      expect(after.conversations).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
