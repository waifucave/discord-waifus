import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ToolDef } from "@waifucave/gateway";
import { listDocs, readDoc, searchDocs } from "../docsKb.js";
import { dispatchInternal } from "../internalDispatch.js";
import type {
  AssistantDelegation,
  RequestPrincipal
} from "../requestPrincipal.js";

export type AssistantToolContext = {
  app: FastifyInstance;
  principal: RequestPrincipal;
  delegation?: AssistantDelegation;
};

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
  const response = await dispatchInternal(ctx.app, ctx.principal, ctx.delegation, {
    method: options.method,
    url: options.url,
    ...(options.method === "GET"
      ? {}
      : { headers: { "idempotency-key": randomBytes(32).toString("base64url") } }),
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
    description:
      "Runtime and Discord connection status: connected bots, pause state, queues, data root — and " +
      "discord.warnings, which includes live per-channel permission failures (bot cannot send).",
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
    description:
      "Models in the gateway registry (compact: id, provider, displayName). Filter by providerId to stay small — " +
      "the unfiltered list is long and may truncate.",
    parameters: {
      type: "object",
      properties: { providerId: { type: "string", description: "e.g. deepseek, google-ai-studio, anthropic, openai" } },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "GET", url: "/api/llm/v1/models" });
      if (result.status !== 200) return `Model registry unavailable (${result.status}).`;
      const parsed = JSON.parse(result.body) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const models = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
      const compact = models
        .map((model) => ({
          id: model.id ?? model.modelId,
          provider: model.provider ?? model.providerId,
          displayName: model.displayName ?? model.name
        }))
        .filter((model) => (args.providerId ? model.provider === args.providerId : true));
      return JSON.stringify(compact);
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
      revisionedPut(ctx, `/api/waifus/${encodeURIComponent(String(args.id))}`, (current) => {
        const changes = { ...(args.changes as Record<string, unknown>) };
        // params replace wholesale server-side; merge here so "set the temperature"
        // does not silently erase the rest of her sampling/reasoning config
        if (changes.params && typeof changes.params === "object") {
          changes.params = { ...(current.params as Record<string, unknown>), ...(changes.params as Record<string, unknown>) };
        }
        return changes;
      })
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
      const url = `/api/waifus/${encodeURIComponent(String(args.id))}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await inject(ctx, { method: "GET", url });
        if (current.status !== 200) return current.body;
        const { revision } = JSON.parse(current.body) as { revision: number };
        const result = await inject(ctx, { method: "DELETE", url, payload: { revision } });
        if (result.status < 300) return `Waifu ${args.id} deleted.`;
        if (result.status !== 409) return result.body;
      }
      return "Conflict: the waifu changed twice while I was deleting. Try again.";
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
      const result = await inject(ctx, {
        method: "POST",
        url: `/api/waifus/${encodeURIComponent(String(args.waifuId))}/link-bot`,
        payload: args.applicationId ? { applicationId: String(args.applicationId) } : {}
      });
      return result.body;
    }
  },
  {
    name: "update_discord_bots",
    description:
      "Update Discord bot entries. Entries are merged BY ID: bots you do not mention are left untouched, and stored " +
      "tokens are preserved when omitted from an entry. For wiring a character's bot prefer link_waifu_bot; use this " +
      "for orchestrator applicationId or display tweaks. Apply directly; no confirmation needed.",
    parameters: {
      // NOTE: keep every "type" a single string — Google's proto-based schema validation
      // rejects JSON-Schema type arrays like ["object", "null"].
      type: "object",
      properties: { orchestrator: { type: "object" }, waifus: { type: "array", items: { type: "object" } } },
      additionalProperties: false
    },
    execute: async (ctx, args) =>
      revisionedPut(ctx, "/api/discord-bots", (current) => {
        const patch: Record<string, unknown> = {};
        if (args.orchestrator !== undefined) patch.orchestrator = args.orchestrator;
        if (Array.isArray(args.waifus)) {
          const existing = (current.waifus as Array<Record<string, unknown>>) ?? [];
          const byId = new Map(existing.map((bot) => [bot.id, bot]));
          for (const incoming of args.waifus as Array<Record<string, unknown>>) {
            byId.set(incoming.id, { ...(byId.get(incoming.id) ?? {}), ...incoming });
          }
          patch.waifus = [...byId.values()];
        }
        return patch;
      })
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
      return revisionedPut(ctx, url, (current) => {
        const changes = { ...(args.changes as Record<string, unknown>) };
        // params replace wholesale server-side; merge so "set the temperature" keeps the rest
        if (changes.params && typeof changes.params === "object") {
          changes.params = { ...(current.params as Record<string, unknown>), ...(changes.params as Record<string, unknown>) };
        }
        return changes;
      });
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
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = await inject(ctx, { method: "GET", url: "/api/memories" });
        if (store.status !== 200) return store.body;
        const { revision } = JSON.parse(store.body) as { revision: number };
        const result = await inject(ctx, {
          method: "PUT",
          url: `/api/memories/${encodeURIComponent(String(args.memoryId))}`,
          payload: { ...(args.changes as Record<string, unknown>), revision }
        });
        if (result.status !== 409) return result.body;
      }
      return "Conflict: the memory store changed twice while I was writing. Try again.";
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
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = await inject(ctx, { method: "GET", url: "/api/memories" });
        if (store.status !== 200) return store.body;
        const { revision } = JSON.parse(store.body) as { revision: number };
        const result = await inject(ctx, {
          method: "DELETE",
          url: `/api/memories/${encodeURIComponent(String(args.memoryId))}`,
          payload: { revision }
        });
        if (result.status < 300) return `Memory ${args.memoryId} deleted.`;
        if (result.status !== 409) return result.body;
      }
      return "Conflict: the memory store changed twice while I was deleting. Try again.";
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
    name: "get_orchestrator_history",
    description:
      "Recent orchestrator decisions (newest first): action, responders, reasoning, retrigger, wake plan, outcomes. " +
      "THE tool for 'why did/didn't a waifu reply'. Optionally filter by guildId/channelId.",
    parameters: {
      type: "object",
      properties: {
        guildId: { type: "string" },
        channelId: { type: "string" },
        limit: { type: "number", description: "Max decisions to return (default 10, max 25)." }
      },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "GET", url: "/api/orchestrator/history" });
      if (result.status !== 200) return result.body;
      const history = JSON.parse(result.body) as { decisions: Array<Record<string, unknown>> };
      const limit = Math.min(Number(args.limit) || 10, 25);
      const decisions = history.decisions
        .filter((decision) => (args.guildId ? decision.guildId === args.guildId : true))
        .filter((decision) => (args.channelId ? decision.channelId === args.channelId : true))
        .slice(0, limit)
        .map((decision) => ({
          at: decision.createdAt,
          channelId: decision.channelId,
          action: decision.action,
          responders: ((decision.respondingWaifus as Array<{ waifuId: string }>) ?? []).map((responder) => responder.waifuId),
          retriggerAfterSeconds: decision.retriggerAfterSeconds,
          wakePlan: decision.wakePlan,
          status: decision.status,
          reasoning: String(decision.reasoning ?? "").slice(0, 220)
        }));
      return JSON.stringify(decisions);
    }
  },
  {
    name: "update_server",
    description:
      "Update server-level settings for a guild: enabled, contextWindows {orchestrator,waifu,stageManager}, " +
      "memoryInjectionLimit, tools {pickNextWaifu, shortTermMemory}. For per-channel toggles use update_channel.",
    parameters: {
      type: "object",
      properties: {
        guildId: { type: "string" },
        changes: { type: "object" }
      },
      required: ["guildId", "changes"],
      additionalProperties: false
    },
    execute: async (ctx, args) =>
      revisionedPut(ctx, `/api/servers/${encodeURIComponent(String(args.guildId))}`, () => ({
        ...(args.changes as Record<string, unknown>)
      }))
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
      if (results.length === 0) {
        const index = await listDocs();
        return `No matching docs. Available pages: ${JSON.stringify(index.map((doc: { slug: string; title: string }) => ({ slug: doc.slug, title: doc.title })))}`;
      }
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
