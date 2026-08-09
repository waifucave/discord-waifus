import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { executeAssistantTool, toolDefs } from "../src/api/assistant/tools.js";
import { LOCAL_REQUEST_PRINCIPAL } from "../src/api/requestPrincipal.js";
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

function localToolContext(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  return { app, principal: LOCAL_REQUEST_PRINCIPAL };
}

describe("assistant tools", () => {
  it("never uses JSON-Schema type arrays (Google proto schemas reject them)", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === "type" && Array.isArray(value)) offenders.push(path);
          walk(value, `${path}.${key}`);
        }
      }
    };
    for (const tool of toolDefs()) walk(tool.parameters, tool.name);
    expect(offenders).toEqual([]);
  });

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
      const ctx = localToolContext(app);
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
      const ctx = localToolContext(app);
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
      const ctx = localToolContext(app);
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
      const missing = await executeAssistantTool(localToolContext(app), "get_waifu", JSON.stringify({ id: "ghost" }));
      expect(missing.toLowerCase()).toContain("not found");
      const unknown = await executeAssistantTool(localToolContext(app), "no_such_tool", "{}");
      expect(unknown).toContain("Unknown tool");
      const badArgs = await executeAssistantTool(localToolContext(app), "get_waifu", "{nope");
      expect(badArgs).toContain("Invalid arguments");
    } finally {
      await app.close();
    }
  });

  it("link_waifu_bot wires bot entry, applicationId, and waifu.botId in one call", async () => {
    const { app } = await makeApp();
    try {
      const created = await executeAssistantTool(
        localToolContext(app),
        "create_waifu",
        JSON.stringify({ id: "reiko", name: "Reiko", displayName: "Reiko", persona: "sweet" })
      );
      expect(created).toContain("reiko");
      const result = await executeAssistantTool(
        localToolContext(app),
        "link_waifu_bot",
        JSON.stringify({ waifuId: "reiko", applicationId: "1523083688701591562" })
      );
      const parsed = JSON.parse(result) as { linked: boolean; botId: string; tokenConfigured: boolean };
      expect(parsed.linked).toBe(true);
      expect(parsed.botId).toBe("reiko");
      expect(parsed.tokenConfigured).toBe(false);
      const bots = await app.inject({ method: "GET", url: "/api/discord-bots" });
      const botsBody = JSON.parse(bots.body) as { waifus: Array<{ id: string; applicationId?: string }> };
      expect(botsBody.waifus.find((b) => b.id === "reiko")?.applicationId).toBe("1523083688701591562");
      const waifu = await app.inject({ method: "GET", url: "/api/waifus/reiko" });
      expect((JSON.parse(waifu.body) as { botId?: string }).botId).toBe("reiko");
    } finally {
      await app.close();
    }
  });

  it("delete_waifu actually deletes (fetches the revision itself)", async () => {
    const { app } = await makeApp();
    try {
      await executeAssistantTool(localToolContext(app), "create_waifu", JSON.stringify({ id: "doomed", name: "Doomed", displayName: "Doomed", persona: "x" }));
      const result = await executeAssistantTool(localToolContext(app), "delete_waifu", JSON.stringify({ id: "doomed" }));
      expect(result.toLowerCase()).toContain("deleted");
      const check = await app.inject({ method: "GET", url: "/api/waifus/doomed" });
      expect(check.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("update_memory and delete_memory carry the store revision", async () => {
    const { app } = await makeApp();
    try {
      await executeAssistantTool(localToolContext(app), "add_memory", JSON.stringify({ waifuId: "riko", guildId: "g1", content: "old fact" }));
      const list = JSON.parse(await executeAssistantTool(localToolContext(app), "search_memories", JSON.stringify({ q: "old" }))) as Array<{ id: string }>;
      const memoryId = list[0].id;
      const updated = await executeAssistantTool(localToolContext(app), "update_memory", JSON.stringify({ memoryId, changes: { content: "new fact" } }));
      expect(updated).toContain("new fact");
      const deleted = await executeAssistantTool(localToolContext(app), "delete_memory", JSON.stringify({ memoryId }));
      expect(deleted.toLowerCase()).toContain("delete");
      const after = JSON.parse(await executeAssistantTool(localToolContext(app), "search_memories", JSON.stringify({ q: "fact" }))) as unknown[];
      expect(after).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("clear_provider_key removes a stored key", async () => {
    const { app } = await makeApp();
    try {
      await executeAssistantTool(localToolContext(app), "set_provider_key", JSON.stringify({ providerId: "deepseek", apiKey: "sk-test" }));
      const cleared = await executeAssistantTool(localToolContext(app), "clear_provider_key", JSON.stringify({ providerId: "deepseek" }));
      expect(cleared.toLowerCase()).toContain("removed");
      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.body).not.toContain('"configured":true');
    } finally {
      await app.close();
    }
  });

  it("update_discord_bots merges by entry id — unlisted bots survive", async () => {
    const { app } = await makeApp();
    try {
      await executeAssistantTool(localToolContext(app), "update_discord_bots", JSON.stringify({ waifus: [
        { id: "momo", displayName: "Momo", enabled: true, applicationId: "111" },
        { id: "riko", displayName: "Riko", enabled: true, applicationId: "222" }
      ] }));
      await executeAssistantTool(localToolContext(app), "update_discord_bots", JSON.stringify({ waifus: [
        { id: "momo", displayName: "Momo Renamed", enabled: true }
      ] }));
      const bots = JSON.parse((await app.inject({ method: "GET", url: "/api/discord-bots" })).body) as { waifus: Array<{ id: string; displayName: string; applicationId?: string }> };
      expect(bots.waifus.find((b) => b.id === "riko")).toBeDefined();
      expect(bots.waifus.find((b) => b.id === "momo")?.displayName).toBe("Momo Renamed");
      expect(bots.waifus.find((b) => b.id === "momo")?.applicationId).toBe("111");
    } finally {
      await app.close();
    }
  });

  it("update_waifu deep-merges params — setting temperature keeps the rest", async () => {
    const { app } = await makeApp();
    try {
      await executeAssistantTool(localToolContext(app), "create_waifu", JSON.stringify({ id: "p1", name: "P", displayName: "P", persona: "x" }));
      await executeAssistantTool(localToolContext(app), "update_waifu", JSON.stringify({ id: "p1", changes: { params: { temperature: 0.7, topP: 0.9 } } }));
      await executeAssistantTool(localToolContext(app), "update_waifu", JSON.stringify({ id: "p1", changes: { params: { temperature: 0.3 } } }));
      const waifu = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/p1" })).body) as { params: Record<string, unknown> };
      expect(waifu.params).toEqual({ temperature: 0.3, topP: 0.9 });
    } finally {
      await app.close();
    }
  });

  it("request_secret shows a secure form marker without touching storage", async () => {
    const { app } = await makeApp();
    try {
      const result = await executeAssistantTool(
        localToolContext(app),
        "request_secret",
        JSON.stringify({ purpose: "provider_key", providerId: "deepseek" })
      );
      const parsed = JSON.parse(result) as { status: string; note: string; target: string };
      expect(parsed.status).toBe("secure_form_shown");
      expect(parsed.target).toBe("deepseek");
      expect(parsed.note).toMatch(/without entering/i);
      // no key was written — the browser posts the secret, not this tool
      const providers = await app.inject({ method: "GET", url: "/api/providers" });
      expect(providers.body).not.toContain('"configured":true');
      // purpose is constrained so the panel can always render a form
      const def = toolDefs().find((tool) => tool.name === "request_secret");
      const purposeSchema = (def?.parameters as { properties: Record<string, { enum?: string[] }> }).properties.purpose;
      expect(purposeSchema.enum).toEqual(["provider_key", "bot_token"]);
    } finally {
      await app.close();
    }
  });

  it("searches and reads the docs KB", async () => {
    const { app } = await makeApp();
    try {
      const results = await executeAssistantTool(localToolContext(app), "docs_search", JSON.stringify({ query: "discord bot token intents" }));
      expect(results).toContain("discord-setup");
      const doc = await executeAssistantTool(localToolContext(app), "docs_read", JSON.stringify({ slug: "waifus" }));
      expect(doc).toContain("persona");
    } finally {
      await app.close();
    }
  });
});
