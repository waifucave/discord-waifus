import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { executeAssistantTool, toolDefs } from "../src/api/assistant/tools.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeApp() {
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
  const app = await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) });
  return { app, root };
}

describe("assistant tools", () => {
  it("exposes every spec tool as a gateway ToolDef", () => {
    const names = toolDefs().map((tool) => tool.name);
    for (const required of [
      "get_runtime_status",
      "list_providers",
      "set_provider_key",
      "list_models",
      "list_waifus",
      "get_waifu",
      "create_waifu",
      "update_waifu",
      "delete_waifu",
      "list_servers",
      "update_channel",
      "list_discord_bots",
      "get_agent_config",
      "update_agent_config",
      "search_memories",
      "add_memory",
      "trigger_orchestrator",
      "read_logs",
      "docs_search",
      "docs_read"
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it("creates and updates a waifu through the real API handlers", async () => {
    const { app } = await makeApp();
    try {
      const ctx = { app };
      const created = await executeAssistantTool(
        ctx,
        "create_waifu",
        JSON.stringify({ id: "momo", name: "Momo", persona: "sunny chaos gremlin" })
      );
      expect(JSON.parse(created).id).toBe("momo");
      const updated = await executeAssistantTool(
        ctx,
        "update_waifu",
        JSON.stringify({ id: "momo", changes: { displayName: "Momo!" } })
      );
      expect(JSON.parse(updated).displayName).toBe("Momo!");
      const list = await executeAssistantTool(ctx, "list_waifus", "{}");
      expect(list).toContain("momo");
    } finally {
      await app.close();
    }
  });

  it("never leaks provider keys through list_providers", async () => {
    const { app } = await makeApp();
    try {
      const ctx = { app };
      await executeAssistantTool(ctx, "set_provider_key", JSON.stringify({ providerId: "deepseek", apiKey: "sk-super-secret" }));
      const listed = await executeAssistantTool(ctx, "list_providers", "{}");
      expect(listed).not.toContain("sk-super-secret");
      expect(listed).toContain("deepseek");
    } finally {
      await app.close();
    }
  });

  it("reads agent configs and updates them with revision retry", async () => {
    const { app } = await makeApp();
    try {
      const ctx = { app };
      const updated = await executeAssistantTool(
        ctx,
        "update_agent_config",
        JSON.stringify({ agent: "assistant", changes: { providerId: "deepseek", modelId: "deepseek-v4-pro" } })
      );
      expect(JSON.parse(updated).modelId).toBe("deepseek-v4-pro");
      const read = await executeAssistantTool(ctx, "get_agent_config", JSON.stringify({ agent: "assistant" }));
      expect(JSON.parse(read).modelId).toBe("deepseek-v4-pro");
    } finally {
      await app.close();
    }
  });

  it("returns tool errors as strings instead of throwing", async () => {
    const { app } = await makeApp();
    try {
      const missing = await executeAssistantTool({ app }, "get_waifu", JSON.stringify({ id: "ghost" }));
      expect(missing.toLowerCase()).toContain("not found");
      const unknown = await executeAssistantTool({ app }, "no_such_tool", "{}");
      expect(unknown).toContain("Unknown tool");
      const badArgs = await executeAssistantTool({ app }, "get_waifu", "{nope");
      expect(badArgs).toContain("Invalid arguments");
    } finally {
      await app.close();
    }
  });

  it("searches and reads the docs KB", async () => {
    const { app } = await makeApp();
    try {
      const results = await executeAssistantTool({ app }, "docs_search", JSON.stringify({ query: "discord bot token intents" }));
      expect(results).toContain("discord-setup");
      const doc = await executeAssistantTool({ app }, "docs_read", JSON.stringify({ slug: "waifus" }));
      expect(doc).toContain("persona");
    } finally {
      await app.close();
    }
  });
});
