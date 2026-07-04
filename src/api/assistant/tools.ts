import type { FastifyInstance } from "fastify";
import type { ToolDef } from "@waifucave/gateway";
import { readDoc, searchDocs } from "../docsKb.js";

export type AssistantToolContext = { app: FastifyInstance };

export type AssistantTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (ctx: AssistantToolContext, args: Record<string, unknown>) => Promise<string>;
};

async function inject(
  ctx: AssistantToolContext,
  options: { method: "GET" | "PUT" | "POST" | "DELETE"; url: string; payload?: unknown }
): Promise<{ status: number; body: string }> {
  const response = await ctx.app.inject({
    method: options.method,
    url: options.url,
    ...(options.payload === undefined ? {} : { payload: options.payload as Record<string, unknown> })
  });
  return { status: response.statusCode, body: response.body };
}

// Read-modify-write for revisioned resources: GET → merge → PUT with the fresh revision;
// one retry when a concurrent writer bumps the revision between our read and write (409).
async function revisionedPut(
  ctx: AssistantToolContext,
  url: string,
  merge: (current: Record<string, unknown>) => Record<string, unknown>
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await inject(ctx, { method: "GET", url });
    if (current.status !== 200) return `GET ${url} failed (${current.status}): ${current.body}`;
    const parsed = JSON.parse(current.body) as Record<string, unknown>;
    const result = await inject(ctx, {
      method: "PUT",
      url,
      payload: { ...merge(parsed), revision: parsed.revision }
    });
    if (result.status !== 409) return result.body;
  }
  return "Conflict: the resource changed twice while I was writing. Try again.";
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

const AGENT_CONFIG_URLS: Record<string, string> = {
  orchestrator: "/api/orchestrator/config",
  "stage-manager": "/api/stage-manager/config",
  reviewer: "/api/reviewer/config",
  assistant: "/api/assistant/config"
};

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: "get_runtime_status",
    description: "Runtime and Discord connection status: connected bots, pause state, queues, data root.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const [runtime, status] = await Promise.all([
        inject(ctx, { method: "GET", url: "/api/runtime" }),
        inject(ctx, { method: "GET", url: "/api/status" })
      ]);
      return JSON.stringify({ runtime: JSON.parse(runtime.body), status: JSON.parse(status.body) });
    }
  },
  {
    name: "list_providers",
    description: "Model providers and whether each has an API key configured. Never returns key material.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/providers" });
      if (result.status !== 200) return result.body;
      const parsed = JSON.parse(result.body) as { providers: Array<Record<string, unknown>> };
      return JSON.stringify(
        parsed.providers.map((provider) => ({
          providerId: provider.providerId ?? provider.id,
          configured: (provider.credentials as Record<string, unknown> | undefined)?.configured ?? false
        }))
      );
    }
  },
  {
    name: "set_provider_key",
    description:
      "Set (or replace) the API key for a provider. The key is stored write-only. Only use this when the " +
      "user already pasted the key into chat themselves — otherwise call request_secret.",
    parameters: {
      type: "object",
      properties: { providerId: { type: "string" }, apiKey: { type: "string" } },
      required: ["providerId", "apiKey"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, {
        method: "PUT",
        url: `/api/providers/${encodeURIComponent(String(args.providerId))}/credentials`,
        payload: { apiKey: String(args.apiKey) }
      });
      return result.status === 200 ? `Provider ${args.providerId} key configured.` : result.body;
    }
  },
  {
    name: "clear_provider_key",
    description: "Remove the stored API key for a provider.",
    parameters: {
      type: "object",
      properties: { providerId: { type: "string" } },
      required: ["providerId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, {
        method: "DELETE",
        url: `/api/providers/${encodeURIComponent(String(args.providerId))}/credentials`
      });
      return result.status < 300 ? `Provider ${args.providerId} key removed.` : result.body;
    }
  },
  {
    name: "request_secret",
    description:
      "Ask the user for a secret (provider API key or Discord bot token) via a secure input form in the dashboard. " +
      "The secret is posted by the browser directly to storage and NEVER enters this conversation. " +
      "ALWAYS use this instead of asking the user to paste a key or token into chat. " +
      "For provider_key set providerId; for bot_token set botId (a discord-bots entry id, or 'orchestrator'). " +
      "Open at most ONE form per reply, and only for a secret the user is ready to provide right now. " +
      "After calling it, tell the user to paste the secret into the form and END your reply — an automated " +
      "[secure-form] receipt message arrives once it is saved. Application IDs are not secret: set them via " +
      "link_waifu_bot or update_discord_bots.",
    parameters: {
      type: "object",
      properties: {
        purpose: { type: "string", enum: ["provider_key", "bot_token"] },
        providerId: { type: "string", description: "Required when purpose is provider_key." },
        botId: { type: "string", description: "Required when purpose is bot_token." }
      },
      required: ["purpose"],
      additionalProperties: false
    },
    execute: async (_ctx, args) => {
      const purpose = String(args.purpose);
      const target = purpose === "provider_key" ? String(args.providerId ?? "") : String(args.botId ?? "");
      if (!target) {
        return JSON.stringify({ status: "error", note: `Missing ${purpose === "provider_key" ? "providerId" : "botId"}.` });
      }
      return JSON.stringify({
        status: "secure_form_shown",
        purpose,
        target,
        note:
          "A secure input form is now shown to the user. The secret is stored directly without entering this conversation. " +
          "Tell the user to paste it there and end your reply; a confirmation message follows once it is saved."
      });
    }
  },
  {
    name: "list_models",
    description: "All models in the gateway registry with provider and key capabilities.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/llm/v1/models" });
      return result.status === 200 ? result.body : `Model registry unavailable (${result.status}).`;
    }
  },
  {
    name: "list_waifus",
    description: "List all configured waifus with id, name, model, and enabled state.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/waifus" });
      if (result.status !== 200) return result.body;
      const parsed = JSON.parse(result.body) as { waifus: Array<Record<string, unknown>> };
      return JSON.stringify(
        parsed.waifus.map((waifu) => ({
          id: waifu.id,
          name: waifu.name,
          displayName: waifu.displayName,
          enabled: waifu.enabled,
          providerId: waifu.providerId,
          modelId: waifu.modelId,
          botId: waifu.botId
        }))
      );
    }
  },
  {
    name: "get_waifu",
    description: "Full config of one waifu (persona, params, availability, tools, prompt layout).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "GET", url: `/api/waifus/${encodeURIComponent(String(args.id))}` });
      return result.body;
    }
  },
  {
    name: "create_waifu",
    description: "Create a waifu. Required: id (kebab-case), name, persona. Optional: providerId, modelId, displayName, params.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        persona: { type: "string" },
        displayName: { type: "string" },
        providerId: { type: "string" },
        modelId: { type: "string" },
        params: { type: "object" }
      },
      required: ["id", "name", "persona"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const payload = { ...args, displayName: args.displayName ?? args.name };
      const result = await inject(ctx, { method: "POST", url: "/api/waifus", payload });
      return result.body;
    }
  },
  {
    name: "update_waifu",
    description: "Update fields on an existing waifu. Pass only the fields to change under `changes`.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, changes: { type: "object" } },
      required: ["id", "changes"],
      additionalProperties: false
    },
    execute: async (ctx, args) =>
      revisionedPut(ctx, `/api/waifus/${encodeURIComponent(String(args.id))}`, () => ({
        ...(args.changes as Record<string, unknown>)
      }))
  },
  {
    name: "delete_waifu",
    description: "Permanently delete a waifu. Destructive — confirm with the user in chat first.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "DELETE", url: `/api/waifus/${encodeURIComponent(String(args.id))}` });
      return result.status < 300 ? `Waifu ${args.id} deleted.` : result.body;
    }
  },
  {
    name: "regenerate_waifu_digest",
    description: "Regenerate the persona digest (voice/drives summary) for a waifu.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "POST", url: `/api/waifus/${encodeURIComponent(String(args.id))}/digest` });
      return result.body;
    }
  },
  {
    name: "list_servers",
    description: "Discord servers the app knows, with channels and per-channel enabled waifus.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/servers" });
      return result.body;
    }
  },
  {
    name: "update_channel",
    description: "Update a channel's settings: enabled flag and enabledWaifuIds (which waifus may speak).",
    parameters: {
      type: "object",
      properties: {
        guildId: { type: "string" },
        channelId: { type: "string" },
        enabled: { type: "boolean" },
        enabledWaifuIds: { type: "array", items: { type: "string" } }
      },
      required: ["guildId", "channelId"],
      additionalProperties: true
    },
    execute: async (ctx, args) => {
      const { guildId, channelId, ...settings } = args;
      const serverUrl = `/api/servers/${encodeURIComponent(String(guildId))}`;
      const current = await inject(ctx, { method: "GET", url: serverUrl });
      if (current.status !== 200) return current.body;
      const server = JSON.parse(current.body) as { revision: number; channels?: Record<string, Record<string, unknown>> };
      const existing = server.channels?.[String(channelId)] ?? {};
      const result = await inject(ctx, {
        method: "PUT",
        url: `${serverUrl}/channels/${encodeURIComponent(String(channelId))}`,
        payload: { ...existing, ...settings, revision: server.revision }
      });
      return result.body;
    }
  },
  {
    name: "list_discord_bots",
    description: "Discord bot entries (orchestrator + waifu bots). Tokens are redacted.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/discord-bots" });
      return result.body;
    }
  },
  {
    name: "link_waifu_bot",
    description:
      "Wire a character to a Discord bot in one call: ensures a discord-bots entry with id = waifuId, sets its " +
      "applicationId (if given), and sets the waifu's botId to that entry. This is the FIRST step when connecting " +
      "a character to Discord. Then call request_secret(purpose bot_token, botId = waifuId) for the token, and " +
      "finish with runtime_reload. Application IDs are not secret and belong in this call, not in request_secret.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        applicationId: { type: "string", description: "The Discord application id shown in the developer portal." }
      },
      required: ["waifuId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const waifuId = String(args.waifuId);
      const waifuResult = await inject(ctx, { method: "GET", url: `/api/waifus/${encodeURIComponent(waifuId)}` });
      if (waifuResult.status !== 200) return `Waifu ${waifuId} not found (${waifuResult.status}).`;
      const waifu = JSON.parse(waifuResult.body) as Record<string, unknown>;

      const botsPut = await revisionedPut(ctx, "/api/discord-bots", (current) => {
        const waifus = ((current.waifus as Array<Record<string, unknown>>) ?? []).slice();
        const index = waifus.findIndex((bot) => bot.id === waifuId);
        const existing = index >= 0 ? waifus[index] : undefined;
        const entry = {
          id: waifuId,
          displayName: (waifu.displayName as string) || (waifu.name as string) || waifuId,
          enabled: true,
          ...(existing ?? {}),
          ...(args.applicationId ? { applicationId: String(args.applicationId) } : {})
        };
        if (index >= 0) waifus[index] = entry;
        else waifus.push(entry);
        return { waifus };
      });
      if (botsPut.startsWith("GET ") || botsPut.startsWith("Conflict")) return botsPut;

      const waifuPut = await revisionedPut(ctx, `/api/waifus/${encodeURIComponent(waifuId)}`, () => ({ botId: waifuId }));
      if (waifuPut.startsWith("GET ") || waifuPut.startsWith("Conflict")) return waifuPut;

      const bots = JSON.parse(botsPut) as { waifus: Array<Record<string, unknown>> };
      const entry = bots.waifus.find((bot) => bot.id === waifuId);
      return JSON.stringify({
        linked: true,
        botId: waifuId,
        applicationId: entry?.applicationId ?? null,
        tokenConfigured: Boolean(entry?.tokenConfigured),
        next: entry?.tokenConfigured
          ? "Token already stored — call runtime_reload to connect."
          : "Now call request_secret with purpose bot_token and this botId, then runtime_reload after the user saves it."
      });
    }
  },
  {
    name: "update_discord_bots",
    description:
      "Update Discord bot entries. The server MERGES per entry and preserves stored tokens when omitted — nothing is " +
      "wiped by leaving fields out. For wiring a character's bot prefer link_waifu_bot; use this for orchestrator " +
      "applicationId or display tweaks. Apply directly; no confirmation needed.",
    parameters: {
      // NOTE: keep every "type" a single string — Google's proto-based schema validation
      // rejects JSON-Schema type arrays like ["object", "null"].
      type: "object",
      properties: { orchestrator: { type: "object" }, waifus: { type: "array", items: { type: "object" } } },
      additionalProperties: false
    },
    execute: async (ctx, args) => revisionedPut(ctx, "/api/discord-bots", () => args)
  },
  {
    name: "get_agent_config",
    description: "Read an agent config: orchestrator, stage-manager, reviewer, or assistant.",
    parameters: {
      type: "object",
      properties: { agent: { type: "string", enum: Object.keys(AGENT_CONFIG_URLS) } },
      required: ["agent"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const url = AGENT_CONFIG_URLS[String(args.agent)];
      if (!url) return `Unknown agent: ${args.agent}`;
      const result = await inject(ctx, { method: "GET", url });
      return result.body;
    }
  },
  {
    name: "update_agent_config",
    description: "Update an agent config (model, params, prompt, enabled, contextWindow). Pass only changed fields under `changes`.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", enum: Object.keys(AGENT_CONFIG_URLS) },
        changes: { type: "object" }
      },
      required: ["agent", "changes"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const url = AGENT_CONFIG_URLS[String(args.agent)];
      if (!url) return `Unknown agent: ${args.agent}`;
      return revisionedPut(ctx, url, () => ({ ...(args.changes as Record<string, unknown>) }));
    }
  },
  {
    name: "search_memories",
    description: "Search memory records by text, optionally filtered by guildId and waifuId. Returns up to 30 matches.",
    parameters: {
      type: "object",
      properties: { q: { type: "string" }, guildId: { type: "string" }, waifuId: { type: "string" } },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "GET", url: "/api/memories" });
      if (result.status !== 200) return result.body;
      const store = JSON.parse(result.body) as { memories: Array<Record<string, unknown>> };
      const q = args.q ? String(args.q).toLowerCase() : undefined;
      const matches = store.memories
        .filter((memory) => memory.status !== "archived")
        .filter((memory) => (args.guildId ? memory.guildId === args.guildId : true))
        .filter((memory) => (args.waifuId ? memory.waifuId === args.waifuId : true))
        .filter((memory) => (q ? String(memory.content).toLowerCase().includes(q) : true))
        .slice(0, 30)
        .map((memory) => ({
          id: memory.id,
          waifuId: memory.waifuId,
          guildId: memory.guildId,
          kind: memory.kind,
          pinned: memory.pinned,
          content: memory.content
        }));
      return JSON.stringify(matches);
    }
  },
  {
    name: "add_memory",
    description: "Add a memory record for a waifu in a guild. User-created memories are pinned by default.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        guildId: { type: "string" },
        content: { type: "string" },
        pinned: { type: "boolean" },
        kind: { type: "string" }
      },
      required: ["waifuId", "guildId", "content"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "POST", url: "/api/memories", payload: args });
      return result.body;
    }
  },
  {
    name: "update_memory",
    description: "Update a memory record's content, kind, pinned flag, or archive it (status: archived).",
    parameters: {
      type: "object",
      properties: { memoryId: { type: "string" }, changes: { type: "object" } },
      required: ["memoryId", "changes"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, {
        method: "PUT",
        url: `/api/memories/${encodeURIComponent(String(args.memoryId))}`,
        payload: args.changes
      });
      return result.body;
    }
  },
  {
    name: "delete_memory",
    description: "Delete a memory record permanently.",
    parameters: {
      type: "object",
      properties: { memoryId: { type: "string" } },
      required: ["memoryId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "DELETE", url: `/api/memories/${encodeURIComponent(String(args.memoryId))}` });
      return result.status < 300 ? `Memory ${args.memoryId} deleted.` : result.body;
    }
  },
  {
    name: "trigger_orchestrator",
    description: "Run an orchestrator decision pass on a channel right now.",
    parameters: {
      type: "object",
      properties: { guildId: { type: "string" }, channelId: { type: "string" } },
      required: ["guildId", "channelId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/trigger/orchestrator", payload: args });
      return result.status === 200 ? "Orchestrator pass triggered." : result.body;
    }
  },
  {
    name: "trigger_stage_manager",
    description: "Run a stage-manager observer pass on a channel right now.",
    parameters: {
      type: "object",
      properties: { guildId: { type: "string" }, channelId: { type: "string" } },
      required: ["guildId", "channelId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/trigger/stage-manager", payload: args });
      return result.status === 200 ? "Stage-manager pass triggered." : result.body;
    }
  },
  {
    name: "runtime_pause",
    description: "Pause all orchestration (bots stop replying).",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/pause" });
      return result.status === 200 ? "Runtime paused." : result.body;
    }
  },
  {
    name: "runtime_resume",
    description: "Resume orchestration after a pause.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/resume" });
      return result.status === 200 ? "Runtime resumed." : result.body;
    }
  },
  {
    name: "runtime_reload",
    description: "Reload configs into the running orchestrator (after config changes).",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/reload", payload: { reason: "assistant" } });
      return result.status === 200 ? "Runtime reloaded." : result.body;
    }
  },
  {
    name: "read_logs",
    description: "Recent backend log entries (newest last). Optional limit, default 100, max 500.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const limit = args.limit ? Number(args.limit) : 100;
      const result = await inject(ctx, { method: "GET", url: `/api/logs?limit=${limit}` });
      return result.body;
    }
  },
  {
    name: "docs_search",
    description: "Search the built-in documentation. Returns matching doc slugs to read with docs_read.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false
    },
    execute: async (_ctx, args) => {
      const results = await searchDocs(String(args.query));
      if (results.length === 0) return "No matching docs.";
      return JSON.stringify(results.slice(0, 5).map(({ slug, title, description }) => ({ slug, title, description })));
    }
  },
  {
    name: "docs_read",
    description: "Read one documentation page by slug (from docs_search or the index).",
    parameters: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false
    },
    execute: async (_ctx, args) => {
      const doc = await readDoc(String(args.slug));
      return doc ? doc.content : `Unknown doc: ${args.slug}`;
    }
  }
];

const TOOLS_BY_NAME = new Map(ASSISTANT_TOOLS.map((tool) => [tool.name, tool]));

export function toolDefs(): ToolDef[] {
  return ASSISTANT_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Execute a tool by name. Never throws — failures come back as strings the model can react to. */
export async function executeAssistantTool(ctx: AssistantToolContext, name: string, argsJson: string): Promise<string> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (error) {
    return `Invalid arguments: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    return await tool.execute(ctx, args);
  } catch (error) {
    return `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
