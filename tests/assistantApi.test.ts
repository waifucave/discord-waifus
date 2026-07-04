import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import type { ModelPipeline } from "../src/providers/types.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeApp(extra: { assistantPipeline?: ModelPipeline } = {}) {
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
    ...(extra.assistantPipeline ? { assistant: { createPipeline: () => extra.assistantPipeline! } } : {})
  });
  return { app, root };
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
      const roles = (transcript.json().messages as Array<{ role: string }>).map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(roles).toContain("event");
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
