import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { executeAssistantTool, toolDefs } from "../src/api/assistant/tools.js";
import { createRemoteRequestPrincipal, LOCAL_REQUEST_PRINCIPAL } from "../src/api/requestPrincipal.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import type { AssistantActionProposal } from "../src/api/assistant/actions.js";
import { randomBytes } from "node:crypto";
import { conversationOwner } from "../src/api/assistant/conversations.js";
import { HomeStore, homeLimitsOf } from "../src/life/home/homeStore.js";
import { AppConfigSchema } from "../src/shared/schemas/config.js";
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
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const storage = new StorageService(root);
  const app = await createApiServer({ dataRoot: root, runtime, storage });
  return { app, root, storage };
}

function localToolContext(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  return {
    app,
    actor: conversationOwner(LOCAL_REQUEST_PRINCIPAL),
    principal: LOCAL_REQUEST_PRINCIPAL
  };
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
    for (const tool of toolDefs()) walk(tool.inputSchema, tool.name);
    expect(offenders).toEqual([]);
  });

  it("exposes every spec tool as a ModelTool with a JSON input schema", () => {
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
      "get_assistant_config",
      "set_assistant_model",
      "list_detector_models",
      "forget_person",
      "get_life",
      "wake_waifu",
      "list_files",
      "read_file",
      "write_file",
      "list_schedule",
      "list_watches",
      "get_usage",
      "get_setting_help",
      "update_app_config",
      "list_dms",
      "forget_dm",
      "read_logs",
      "get_remote_access_status",
      "set_remote_access_enabled",
      "request_remote_pairing_invite",
      "cancel_remote_pairing_invite",
      "list_remote_pairing_requests",
      "approve_remote_pairing_request",
      "reject_remote_pairing_request",
      "list_remote_devices",
      "rename_remote_device",
      "revoke_remote_device",
      "reconnect_remote_access",
      "get_remote_access_diagnostics",
      "docs_search",
      "docs_read"
    ]) {
      expect(names, required).toContain(required);
    }
    // Living cast L1 retired the director, stage manager, reviewer and memory store with their tools.
    for (const retired of ["get_agent_config", "update_agent_config", "search_memories", "add_memory", "update_memory", "delete_memory", "trigger_orchestrator", "trigger_stage_manager", "get_orchestrator_history", "regenerate_waifu_digest", "list_one_shot_models", "forget_user"]) {
      expect(names, retired).not.toContain(retired);
    }
    for (const tool of toolDefs()) {
      expect(typeof tool.description, tool.name).toBe("string");
      expect((tool.inputSchema as { type?: unknown }).type, tool.name).toBe("object");
    }
  });

  it("Living cast tools: get_life, wake_waifu, get_usage, get_setting_help and update_app_config", async () => {
    const { app } = await makeApp();
    try {
      const ctx = localToolContext(app);
      await executeAssistantTool(ctx, "create_waifu", JSON.stringify({ id: "momo", name: "Momo" }));
      const woken = JSON.parse(await executeAssistantTool(ctx, "wake_waifu", JSON.stringify({ waifuId: "momo", note: "say hi to the garden club" })));
      expect(woken).toMatchObject({ waifuId: "momo", outcome: "queued_offline" });
      const life = JSON.parse(await executeAssistantTool(ctx, "get_life", JSON.stringify({ waifuId: "momo", log: true, limit: 5 })));
      expect(life.status).toMatchObject({ waifuId: "momo", includePrivate: false });
      expect(life.status.queue.wakes).toEqual([expect.objectContaining({ reason: "owner", note: "say hi to the garden club" })]);
      expect(life.log).toMatchObject({ includePrivate: false, lines: [] });
      const usage = JSON.parse(await executeAssistantTool(ctx, "get_usage", JSON.stringify({ groupBy: "waifu", tz: "UTC" })));
      expect(usage).toMatchObject({ groupBy: ["waifu"], timeZone: "UTC", totals: { calls: 0 } });
      const help = await executeAssistantTool(ctx, "get_setting_help", JSON.stringify({ topic: "app.life.maxSendsPerTurn" }));
      expect(help).toContain("maxSendsPerTurn");
      expect(help.length).toBeLessThanOrEqual(12_100);
      const whole = await executeAssistantTool(ctx, "get_setting_help", JSON.stringify({ topic: "app" }));
      expect(whole.length).toBeLessThanOrEqual(12_100);
      const changed = JSON.parse(await executeAssistantTool(ctx, "update_app_config", JSON.stringify({ changes: { life: { maxSendsPerTurn: 6 } } })));
      expect(changed).toEqual({ ok: true, changed: ["life"] });
      const config = (await app.inject({ method: "GET", url: "/api/config" })).json() as { life: { maxSendsPerTurn: number } };
      expect(config.life.maxSendsPerTurn).toBe(6);
      expect(config.life).not.toHaveProperty("maxToolRounds");
    } finally {
      await app.close();
    }
  });

  it("update_app_config only proposes http.host, frontend.staticDir and updates.*: a confirmation card applies them (owner decision)", async () => {
    const { app } = await makeApp();
    try {
      const proposals: AssistantActionProposal[] = [];
      const ctx = {
        ...localToolContext(app),
        delegation: { conversationId: "conversation-1", toolCallId: "call-1" },
        actions: {
          propose: async (proposal: AssistantActionProposal) => {
            proposals.push(proposal);
            return { version: 1 as const, actionId: "action-1", category: proposal.category, summary: proposal.summary, expiresAt: "2026-10-25T12:00:00.000Z" };
          },
          cancelOwnedInvitation: async () => undefined
        }
      };
      const before = (await app.inject({ method: "GET", url: "/api/config" })).json() as { http: { host: string; port: number }; updates: { enabled: boolean } };
      const result = JSON.parse(
        await executeAssistantTool(
          ctx,
          "update_app_config",
          JSON.stringify({ changes: { life: { maxSendsPerTurn: 6 }, http: { host: "0.0.0.0", port: 4000 }, frontend: { staticDir: "somewhere" }, updates: { enabled: !before.updates.enabled } } })
        )
      );
      expect(result).toMatchObject({ ok: true, changed: ["life", "http"], status: "confirmation_required", category: "app_config_host", proposed: ["http.host", "frontend.staticDir", "updates.enabled"] });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.operation).toEqual({ kind: "exact_http", method: "PUT", canonicalTarget: "/api/config", payload: { http: { host: "0.0.0.0" }, frontend: { staticDir: "somewhere" }, updates: { enabled: !before.updates.enabled } } });
      expect(proposals[0]!.summary).toContain('http.host to "0.0.0.0"');
      // Ordinary keys applied; the three wait for the owner's click.
      const after = (await app.inject({ method: "GET", url: "/api/config" })).json() as { life: { maxSendsPerTurn: number }; http: { host: string; port: number }; frontend: { staticDir?: string }; updates: { enabled: boolean } };
      expect(after.life.maxSendsPerTurn).toBe(6);
      expect(after.http).toEqual({ ...before.http, port: 4000 });
      expect(after.frontend.staticDir).toBeUndefined();
      expect(after.updates.enabled).toBe(before.updates.enabled);
    } finally {
      await app.close();
    }
  });

  it("update_app_config only proposes the helper debug log (remoteAccess.*) on a confirmation card", async () => {
    const { app } = await makeApp();
    try {
      const proposals: AssistantActionProposal[] = [];
      const ctx = {
        ...localToolContext(app),
        delegation: { conversationId: "conversation-1", toolCallId: "call-1" },
        actions: {
          propose: async (proposal: AssistantActionProposal) => {
            proposals.push(proposal);
            return { version: 1 as const, actionId: "action-1", category: proposal.category, summary: proposal.summary, expiresAt: "2026-10-25T12:00:00.000Z" };
          },
          cancelOwnedInvitation: async () => undefined
        }
      };
      const result = JSON.parse(
        await executeAssistantTool(ctx, "update_app_config", JSON.stringify({ changes: { remoteAccess: { helperDebugLog: true } } }))
      );
      expect(result).toMatchObject({ status: "confirmation_required", proposed: ["remoteAccess.helperDebugLog"] });
      expect(proposals[0]!.operation).toEqual({ kind: "exact_http", method: "PUT", canonicalTarget: "/api/config", payload: { remoteAccess: { helperDebugLog: true } } });
      const after = (await app.inject({ method: "GET", url: "/api/config" })).json() as { remoteAccess: { helperDebugLog: boolean } };
      expect(after.remoteAccess.helperDebugLog).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("her files: list_files and read_file never show a DM file; write_file only proposes a card with the exact PUT", async () => {
    const { app, storage } = await makeApp();
    try {
      const proposals: AssistantActionProposal[] = [];
      const ctx = {
        ...localToolContext(app),
        delegation: { conversationId: "conversation-1", toolCallId: "call-1" },
        actions: {
          propose: async (proposal: AssistantActionProposal) => {
            proposals.push(proposal);
            return { version: 1 as const, actionId: "action-1", category: proposal.category, summary: proposal.summary, expiresAt: "2026-10-25T12:00:00.000Z" };
          },
          cancelOwnedInvitation: async () => undefined
        }
      };
      await executeAssistantTool(ctx, "create_waifu", JSON.stringify({ id: "momo", name: "Momo" }));
      const home = new HomeStore(storage, "momo", "momo", () => homeLimitsOf(AppConfigSchema.parse({}).life));
      await home.files.writeBytes(home.path("home", ["people", "kevin.md"]), Buffer.from("# Kevin\nlikes lemon cake\n"));
      await home.files.writeBytes(home.path("tmp", ["dm", "kevin", "a7-menu.txt"]), Buffer.from("secret brownies"));

      const listed = JSON.parse(await executeAssistantTool(ctx, "list_files", JSON.stringify({ waifuId: "momo" })));
      expect(listed.entries.map((entry: { name: string }) => entry.name)).toEqual(["life", "people"]); // life/profile.json: written from her config (spec 17.1, §21)
      const dm = await executeAssistantTool(ctx, "list_files", JSON.stringify({ waifuId: "momo", root: "tmp", dir: "dm" }));
      expect(dm).toContain("[private chat redacted]");
      expect(dm).not.toContain("kevin");
      const read = JSON.parse(await executeAssistantTool(ctx, "read_file", JSON.stringify({ waifuId: "momo", path: "people/kevin.md" })));
      expect(read).toMatchObject({ text: "# Kevin\nlikes lemon cake\n", includePrivate: false });
      const secret = await executeAssistantTool(ctx, "read_file", JSON.stringify({ waifuId: "momo", path: "/tmp/dm/kevin/a7-menu.txt" }));
      expect(secret).toContain("PrivateContentLocalOnly");
      expect(secret).not.toContain("brownies");
      expect(JSON.parse(await executeAssistantTool(ctx, "list_schedule", JSON.stringify({ waifuId: "momo" })))).toMatchObject({ entries: [] });
      expect(JSON.parse(await executeAssistantTool(ctx, "list_watches", JSON.stringify({ waifuId: "momo" })))).toMatchObject({ entries: [], includePrivate: false });

      const proposed = JSON.parse(await executeAssistantTool(ctx, "write_file", JSON.stringify({ waifuId: "momo", path: "~/people/kevin.md", text: "# Kevin\nlikes lemon cake and tea\n" })));
      expect(proposed).toMatchObject({ status: "confirmation_required", category: "waifu_file_write" });
      expect(proposals[0]!.summary).toContain("Replace ~/people/kevin.md");
      expect(proposals[0]!.operation).toEqual({ kind: "exact_http", method: "PUT", canonicalTarget: "/api/waifus/momo/files/~/people/kevin.md", payload: { text: "# Kevin\nlikes lemon cake and tea\n", expectedHash: read.hash } });
      // Nothing changes until the owner's click; the click's request carries the card's id.
      expect(await home.files.readText(home.path("home", ["people", "kevin.md"]))).toBe("# Kevin\nlikes lemon cake\n");
      const putAs = (pendingActionId: string | undefined, payload: Record<string, unknown>) =>
        dispatchInternal(app, LOCAL_REQUEST_PRINCIPAL, { conversationId: "conversation-1", ...(pendingActionId ? { pendingActionId } : {}) }, {
          method: "PUT",
          url: "/api/waifus/momo/files/~/people/kevin.md",
          headers: { "idempotency-key": randomBytes(32).toString("base64url") },
          payload
        });
      expect((await putAs(undefined, { text: "x" })).statusCode).toBe(403);
      const operation = proposals[0]!.operation as { payload: Record<string, unknown> };
      expect((await putAs("action-1", operation.payload)).statusCode).toBe(200);
      expect(await home.files.readText(home.path("home", ["people", "kevin.md"]))).toBe("# Kevin\nlikes lemon cake and tea\n");

      expect(JSON.parse(await executeAssistantTool(ctx, "write_file", JSON.stringify({ waifuId: "momo", path: "notes.md", text: "x".repeat(20 * 1024) }))).error).toContain("16 KB");
      expect(await executeAssistantTool(ctx, "write_file", JSON.stringify({ waifuId: "momo", path: "/tmp/dm/kevin/a7-menu.txt", text: "x" }))).toContain("PrivateContentLocalOnly");
      expect(proposals).toHaveLength(1);
      const created = JSON.parse(await executeAssistantTool(ctx, "write_file", JSON.stringify({ waifuId: "momo", path: "ideas.md", text: "bake sale" })));
      expect(created.status).toBe("confirmation_required");
      expect(proposals[1]!.operation).toMatchObject({ canonicalTarget: "/api/waifus/momo/files/~/ideas.md", payload: { text: "bake sale", expectedHash: null } });
    } finally {
      await app.close();
    }
  });

  it("an assistant delegation cannot set http.host, frontend.staticDir, updates.* or remoteAccess.* without the card", async () => {
    const { app } = await makeApp();
    try {
      const before = (await app.inject({ method: "GET", url: "/api/config" })).json() as { updates: { enabled: boolean } };
      const put = (payload: Record<string, unknown>, pendingActionId?: string) =>
        dispatchInternal(app, LOCAL_REQUEST_PRINCIPAL, { conversationId: "conversation-1", toolCallId: "call-1", ...(pendingActionId ? { pendingActionId } : {}) }, {
          method: "PUT",
          url: "/api/config",
          headers: { "idempotency-key": randomBytes(32).toString("base64url") },
          payload
        });
      for (const payload of [{ http: { host: "0.0.0.0" } }, { frontend: { staticDir: "somewhere" } }, { updates: { enabled: !before.updates.enabled } }, { updates: { idleMinutes: 99 } }, { remoteAccess: { helperDebugLog: true } }]) {
        const refused = await put(payload);
        expect(refused.statusCode, JSON.stringify(payload)).toBe(403);
        expect(refused.json(), JSON.stringify(payload)).toMatchObject({ error: "AssistantConfirmationRequired" });
      }
      expect((await put({ life: { maxSendsPerTurn: 7 } })).statusCode).toBe(200);
      // The card's own request (it carries the pending action id) applies.
      expect((await put({ http: { host: "127.0.0.2" } }, "action-1")).statusCode).toBe(200);
      expect(((await app.inject({ method: "GET", url: "/api/config" })).json() as { http: { host: string } }).http.host).toBe("127.0.0.2");
      // A tool call from a paired remote device is refused before any card.
      const remote = JSON.parse(
        await executeAssistantTool(
          {
            ...localToolContext(app),
            principal: createRemoteRequestPrincipal({ kind: "remote_device", stableId: "remote:travel-mac", deviceId: "travel-mac", peerFingerprint: Buffer.alloc(16, 1).toString("base64url"), transportSessionId: Buffer.alloc(16, 2).toString("base64url"), trustEpoch: "1" })
          },
          "update_app_config",
          JSON.stringify({ changes: { http: { host: "0.0.0.0" } } })
        )
      );
      expect(remote.error).toMatch(/only be changed on the host itself/u);
    } finally {
      await app.close();
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

  it("sets and reads the assistant's own model, validated against the curated list", async () => {
    const { app } = await makeApp();
    try {
      const ctx = localToolContext(app);
      const updated = await executeAssistantTool(
        ctx,
        "set_assistant_model",
        JSON.stringify({ model: { providerId: "deepseek", modelId: "deepseek-flash" } })
      );
      expect(JSON.parse(updated).model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
      const read = await executeAssistantTool(ctx, "get_assistant_config", "{}");
      expect(JSON.parse(read).model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
      const refused = await executeAssistantTool(ctx, "set_assistant_model", JSON.stringify({ model: { providerId: "openai", modelId: "gpt-4o" } }));
      expect(refused).toContain("model_not_available");
      const unset = await executeAssistantTool(ctx, "set_assistant_model", JSON.stringify({ unset: true }));
      expect(JSON.parse(unset)).not.toHaveProperty("model");
      // The schema matches what the tool accepts: a model object or the unset flag.
      const schema = toolDefs().find((tool) => tool.name === "set_assistant_model")!.inputSchema as {
        properties: Record<string, { type: string }>;
        required?: string[];
      };
      expect(schema.properties.model!.type).toBe("object");
      expect(schema.properties.unset!.type).toBe("boolean");
      expect(schema.required ?? []).toEqual([]);
      expect(JSON.parse(await executeAssistantTool(ctx, "set_assistant_model", "{}"))).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("list_models returns the curated routes with efforts and key status, filterable by provider", async () => {
    const { app } = await makeApp();
    try {
      const ctx = localToolContext(app);
      await executeAssistantTool(ctx, "set_provider_key", JSON.stringify({ providerId: "deepseek", apiKey: "sk-test" }));
      const all = JSON.parse(await executeAssistantTool(ctx, "list_models", "{}")) as Array<Record<string, unknown>>;
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((model) => Array.isArray(model.efforts) && typeof model.contributor === "boolean")).toBe(true);
      const deepseek = JSON.parse(await executeAssistantTool(ctx, "list_models", JSON.stringify({ providerId: "deepseek" }))) as Array<Record<string, unknown>>;
      expect(deepseek.map((model) => model.modelId)).toContain("deepseek-flash");
      expect(deepseek.every((model) => model.providerId === "deepseek" && model.credentialsConfigured === true)).toBe(true);
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

  it("retired tools are unknown to the assistant", async () => {
    const { app } = await makeApp();
    try {
      for (const tool of ["trigger_orchestrator", "search_memories"]) {
        expect(await executeAssistantTool(localToolContext(app), tool, "{}")).toBe(`Unknown tool: ${tool}`);
      }
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

  it("update_waifu sets, changes and unsets the nested model", async () => {
    const { app } = await makeApp();
    try {
      await executeAssistantTool(localToolContext(app), "create_waifu", JSON.stringify({ id: "p1", name: "P", displayName: "P", persona: "x", model: { providerId: "deepseek", modelId: "deepseek-flash" } }));
      let waifu = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/p1" })).body) as { model?: Record<string, unknown> };
      expect(waifu.model).toEqual({ providerId: "deepseek", modelId: "deepseek-flash" });
      await executeAssistantTool(localToolContext(app), "update_waifu", JSON.stringify({ id: "p1", changes: { model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "low" } } }));
      waifu = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/p1" })).body);
      expect(waifu.model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "low" });
      await executeAssistantTool(localToolContext(app), "update_waifu", JSON.stringify({ id: "p1", changes: { model: null } }));
      waifu = JSON.parse((await app.inject({ method: "GET", url: "/api/waifus/p1" })).body);
      expect(waifu).not.toHaveProperty("model");
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
      const purposeSchema = (def?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.purpose;
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
