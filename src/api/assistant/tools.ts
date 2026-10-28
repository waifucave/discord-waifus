import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ModelTool } from "../../models/client.js";
import {
  ApprovePairingInputV1Schema,
  AssistantSafePairingRequestSummaryV1Schema,
  PendingPairingRequestListV1Schema,
  RemoteAccessStatusV1Schema,
  TrustedDeviceListV1Schema,
  TrustedDeviceSummaryV1Schema
} from "../../shared/schemas/remoteLifecycle.js";
import { FORGET_LIMITS_TEXT } from "../../shared/constants/forget.js";
import { herFileUrl, herPathInput } from "../../shared/constants/files.js";
import { listDocs, readDoc, searchDocs } from "../docsKb.js";
import { dispatchInternal } from "../internalDispatch.js";
import type {
  AssistantDelegation,
  RequestPrincipal
} from "../requestPrincipal.js";
import type { ConversationOwner } from "./conversations.js";
import type {
  AssistantActionProposal,
  AssistantActionSummary
} from "./actions.js";

export type AssistantActionController = {
  propose: (proposal: AssistantActionProposal) => Promise<AssistantActionSummary>;
  cancelOwnedInvitation: (invitationId: string) => Promise<string | undefined>;
};

export type AssistantToolContext = {
  app: FastifyInstance;
  actor: ConversationOwner;
  principal: RequestPrincipal;
  delegation?: AssistantDelegation;
  actions?: AssistantActionController;
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

/** get_setting_help answers are cut here (overhaul spec §10.7). */
const SETTING_HELP_MAX_CHARS = 12_000;

/** read_file answers are cut here. */
const ASSISTANT_FILE_TEXT_MAX_CHARS = 20_000;
/** write_file's text travels in the confirmation card, which holds at most 32 KB. */
export const ASSISTANT_WRITE_MAX_BYTES = 16 * 1024;
const ASSISTANT_WRITE_PREVIEW_CHARS = 1_500;

/** The most usage groups one `get_usage` answer carries (the costliest; the rest are counted). */
export const ASSISTANT_USAGE_MAX_GROUPS = 40;

/**
 * A usage report sized for the assistant's context: the costliest groups only, the rest counted in
 * `omittedGroups` (their calls and cost stay in `totals`).
 */
export function usageForAssistant(statusCode: number, body: string): string {
  if (statusCode !== 200) return body;
  let report: { groups?: Array<{ costUsd?: number; calls?: number }> } & Record<string, unknown>;
  try {
    report = JSON.parse(body) as typeof report;
  } catch {
    return body.slice(0, SETTING_HELP_MAX_CHARS);
  }
  const groups = Array.isArray(report.groups) ? report.groups : [];
  if (groups.length <= ASSISTANT_USAGE_MAX_GROUPS) return body;
  const kept = [...groups].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || (b.calls ?? 0) - (a.calls ?? 0)).slice(0, ASSISTANT_USAGE_MAX_GROUPS);
  return JSON.stringify({ ...report, groups: kept, omittedGroups: groups.length - kept.length, note: `Only the ${ASSISTANT_USAGE_MAX_GROUPS} costliest groups are listed; totals cover everything. Narrow the range or the groupBy for more.` });
}

const MODEL_CHOICE_PARAMETER = {
  type: "object",
  description: "A curated model from list_models.",
  properties: {
    providerId: { type: "string" },
    modelId: { type: "string" },
    effort: { type: "string", description: "One of the model's efforts." }
  },
  required: ["providerId", "modelId"],
  additionalProperties: false
} as const;

function actionController(ctx: AssistantToolContext): AssistantActionController {
  if (!ctx.actions) throw new Error("Secure assistant actions require a bound browser session.");
  return ctx.actions;
}

/** What the card says about the keys only the owner's click applies. */
const GUARDED_APP_CONFIG_NOTE =
  "The host bind decides who can reach the dashboard and API, the served folder decides what the dashboard runs, and " +
  "automatic updates install new versions unattended, and the helper debug log writes network details to a local file; " +
  "a wrong value can lock you out or run code you did not mean to.";

/**
 * Splits an update_app_config patch: `http.host`, `frontend.staticDir`, `updates.*` and
 * `remoteAccess.*` go to a confirmation card (the owner's click applies them), the rest applies
 * directly.
 */
export function splitGuardedAppConfig(changes: Record<string, unknown>): { guarded: Record<string, unknown>; rest: Record<string, unknown>; keys: string[] } {
  const guarded: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...changes };
  const keys: string[] = [];
  const take = (group: string, key: string) => {
    const section = rest[group];
    if (!section || typeof section !== "object" || Array.isArray(section) || !Object.hasOwn(section, key)) return;
    const { [key]: value, ...others } = section as Record<string, unknown>;
    guarded[group] = { ...((guarded[group] as Record<string, unknown> | undefined) ?? {}), [key]: value };
    keys.push(`${group}.${key}`);
    if (Object.keys(others).length > 0) rest[group] = others;
    else delete rest[group];
  };
  take("http", "host");
  take("frontend", "staticDir");
  for (const group of ["updates", "remoteAccess"]) {
    const section = rest[group];
    if (section === undefined) continue;
    guarded[group] = section;
    keys.push(...(section && typeof section === "object" && !Array.isArray(section) ? Object.keys(section).map((key) => `${group}.${key}`) : [group]));
    delete rest[group];
  }
  return { guarded, rest, keys };
}

function valueAt(record: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined), record);
}

function confirmationResult(action: AssistantActionSummary): string {
  return JSON.stringify({
    status: "confirmation_required",
    actionId: action.actionId,
    category: action.category,
    expiresAt: action.expiresAt,
    note: "A secure dashboard card is waiting for the user. The assistant cannot confirm it."
  });
}

function helperTargetLabel(target: { os: string; arch: string; goarm?: number }): string {
  const architecture = target.arch === "arm" && target.goarm ? `armv${target.goarm}` : target.arch;
  return `${target.os} ${architecture}`;
}

const ASSISTANT_TOOLS: AssistantTool[] = [
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
      "For provider_key set providerId; for bot_token set botId (a discord-bots entry id, or 'house' for the House bot). " +
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
      "The curated model list (Living cast): every model a waifu or the assistant may use, with its route " +
      "{providerId, modelId}, the reasoning efforts it accepts, whether it is a contributor (training) variant, " +
      "and whether its provider has an API key. Optional providerId filter.",
    parameters: {
      type: "object",
      properties: { providerId: { type: "string", description: "e.g. anthropic, openai, deepseek, meta, openrouter" } },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "GET", url: "/api/models" });
      if (result.status !== 200) return `Model list unavailable (${result.status}).`;
      const parsed = JSON.parse(result.body) as { models?: Array<Record<string, unknown>> };
      const compact = (parsed.models ?? [])
        .filter((model) => (args.providerId ? model.providerId === args.providerId : true))
        .map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          efforts: model.efforts,
          ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
          contributor: model.contributor,
          credentialsConfigured: model.credentialsConfigured
        }));
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
          model: waifu.model,
          botId: waifu.botId
        }))
      );
    }
  },
  {
    name: "get_waifu",
    description: "Full config of one waifu (persona, model, availability, DM and style settings).",
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
    description:
      "Create a waifu. Required: id (kebab-case), name, persona. Optional: displayName and model " +
      "{providerId, modelId, effort?} from list_models.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        persona: { type: "string" },
        displayName: { type: "string" },
        model: MODEL_CHOICE_PARAMETER
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
    description:
      "Update fields on an existing waifu. Pass only the fields to change under `changes`; everything else is kept as it is. " +
      "`model` is {providerId, modelId, effort?} from list_models (null unsets it). Style fields: " +
      "`customInstructions` (extra prompt text, max 4000 chars) and `scheduleInPrompt` (boolean, whether her " +
      "schedule is mentioned in the prompt). Discord profile fields, synced to her own bot by the app: `username` (her bot's " +
      "Discord username, 2–32 chars, no @ # : ``` and not containing 'discord' or 'clyde'; Discord allows about 2 changes an hour; " +
      "unset leaves her bot's current name alone, her `name` stays her identity in prompts and wake words), `bio` (her About Me, the application " +
      "description, max 400 chars) and `nicknames` (object of server id → nickname, 1–32 chars, replaced whole); null unsets each. " +
      "GET /api/waifus/:id/discord-profile shows whether the sync is done or waiting for a rate limit. " +
      "The prompt layout editor no longer exists; there is nothing to send for it. " +
      "Every key with its type and default: get_setting_help('waifu').",
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
    description: "Update a channel's settings: enabledWaifuIds (which waifus may speak; a channel is live when the list is non-empty). Every key: get_setting_help('channel').",
    parameters: {
      type: "object",
      properties: {
        guildId: { type: "string" },
        channelId: { type: "string" },
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
    description: "Discord bot entries (the House bot + waifu bots; the House bot is stored under the key `orchestrator`). Tokens are redacted.",
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
      "for the House bot's applicationId or display tweaks (key `orchestrator`). Apply directly; no confirmation needed. " +
      "Every key: get_setting_help('bot').",
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
    name: "get_assistant_config",
    description:
      "Read the assistant's own model setting. When it is unset the assistant borrows a waifu's model (an offered, " +
      "non-contributor model whose provider has a key), or does not run.",
    parameters: NO_ARGS,
    execute: async (ctx) => (await inject(ctx, { method: "GET", url: "/api/assistant/config" })).body
  },
  {
    name: "set_assistant_model",
    description:
      "Set the assistant's own model: pass `model` {providerId, modelId, effort?} from list_models, or `unset: true` " +
      "to clear it (the assistant then borrows a waifu's model: only an offered, non-contributor model whose " +
      "provider has a key).",
    parameters: {
      // One string `type` per node (Google's proto schemas reject ["object", "null"]): unsetting is
      // its own flag rather than a nullable model.
      type: "object",
      properties: {
        model: MODEL_CHOICE_PARAMETER,
        unset: { type: "boolean", description: "true clears the assistant's model; omit `model` then." }
      },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      if (args.unset === true || args.model === null) return revisionedPut(ctx, "/api/assistant/config", () => ({ model: null }));
      if (!args.model || typeof args.model !== "object") return JSON.stringify({ error: "Pass `model` from list_models, or `unset: true`." });
      return revisionedPut(ctx, "/api/assistant/config", () => ({ model: args.model }));
    }
  },
  {
    name: "forget_person",
    description:
      "Propose forgetting a Discord user everywhere on this host (Living cast §7.5): their DMs with every waifu, DM " +
      "state and cached DM images, member lists, the archive, and a best-effort scrub of every waifu's life log, " +
      "summary and her files (a name someone else also has is only listed for review). Destructive: it runs only if the " +
      "user accepts the separate secure dashboard confirmation card, which states what a forget cannot remove.",
    parameters: {
      type: "object",
      properties: { discordUserId: { type: "string", description: "The Discord user id (snowflake)." } },
      required: ["discordUserId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const discordUserId = String(args.discordUserId);
      const target = `/api/people/${encodeURIComponent(discordUserId)}/forget`;
      // Dry run first so the card states exactly what will be deleted.
      const preview = await inject(ctx, { method: "POST", url: target, payload: { confirm: true, dryRun: true } });
      if (preview.status !== 200) return preview.body;
      const counts = JSON.parse(preview.body) as { dmContexts: number; dmStates: number; cachedImages: number };
      const action = await actionController(ctx).propose({
        category: "people_forget",
        summary:
          `Forget Discord user ${discordUserId}: delete ${counts.dmContexts} DM conversation${counts.dmContexts === 1 ? "" : "s"}, ` +
          `${counts.dmStates} DM state${counts.dmStates === 1 ? "" : "s"} and ${counts.cachedImages} cached image${counts.cachedImages === 1 ? "" : "s"}, ` +
          `and scrub them from every waifu's life and files. ${FORGET_LIMITS_TEXT}`,
        resource: { type: "discord_user", identifier: discordUserId },
        operation: {
          kind: "exact_http",
          method: "POST",
          canonicalTarget: target,
          payload: { confirm: true }
        }
      });
      return JSON.stringify({ ...JSON.parse(confirmationResult(action)), preview: counts, limits: FORGET_LIMITS_TEXT });
    }
  },
  {
    name: "list_dms",
    description:
      "Read-only: private DM conversations between waifus and Discord users (newest first): last inbound/reply times, " +
      "the per-user rate limit (used/max, freesAt) and the latest run outcome (sent, rate_limited, undeliverable, ...). " +
      "Never returns message text. Optional waifuId/userId filters.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        userId: { type: "string", description: "Discord user id (snowflake)." },
        limit: { type: "number", description: "Max conversations (default 20, max 200)." }
      },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const query = new URLSearchParams();
      if (args.waifuId) query.set("waifuId", String(args.waifuId));
      if (args.userId) query.set("userId", String(args.userId));
      query.set("limit", String(Math.min(Number(args.limit) || 20, 200)));
      const result = await inject(ctx, { method: "GET", url: `/api/dms?${query.toString()}` });
      return result.body;
    }
  },
  {
    name: "forget_dm",
    description:
      "Propose forgetting one waifu's DMs with one Discord user. scope 'conversation' deletes the DM transcript and run " +
      "records; 'all' also deletes the DM state and cached images. Never resets the rate limit. Destructive: it runs " +
      "only if the user accepts the separate secure dashboard confirmation card.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        userId: { type: "string", description: "The Discord user id (snowflake)." },
        scope: { type: "string", enum: ["conversation", "all"] }
      },
      required: ["waifuId", "userId", "scope"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const waifuId = String(args.waifuId);
      const userId = String(args.userId);
      const scope = args.scope === "all" ? "all" : "conversation";
      const target = `/api/dms/${encodeURIComponent(waifuId)}/${encodeURIComponent(userId)}/forget`;
      const preview = await inject(ctx, { method: "POST", url: target, payload: { confirm: true, scope, dryRun: true } });
      if (preview.status !== 200) return preview.body;
      const counts = (JSON.parse(preview.body) as { deleted: Record<string, number> }).deleted;
      const action = await actionController(ctx).propose({
        category: "dm_forget",
        summary:
          `Forget ${waifuId}'s DMs with Discord user ${userId} (${scope}): delete ${counts.dmContexts ?? 0} conversation(s)` +
          (scope === "all" ? ` and ${counts.cachedImages ?? 0} cached image(s)` : "") +
          ". The rate limit is kept.",
        resource: { type: "dm_conversation", identifier: `${waifuId}:${userId}` },
        operation: { kind: "exact_http", method: "POST", canonicalTarget: target, payload: { confirm: true, scope } }
      });
      return JSON.stringify({ ...JSON.parse(confirmationResult(action)), preview: counts });
    }
  },
  {
    name: "update_server",
    description:
      "Update server-level settings for a guild: paused (the kill switch), detector ({ target } overrides the app's " +
      "detector here; null inherits). For per-channel toggles use update_channel. Every key: get_setting_help('server').",
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
    name: "list_detector_models",
    description: "List the addressee detector's native-choice decision models and credential/setup status (OpenAI, OpenRouter and experimental local Laya). Does not change configuration or run inference.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/detector/models" });
      return result.body;
    }
  },
  {
    name: "get_remote_access_status",
    description:
      "Read the host's Remote Access lifecycle, helper, protocol, and direct-connection status. " +
      "Remote management is direct-only and never relays application traffic.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/remote-access" });
      if (result.status !== 200) return result.body;
      const status = RemoteAccessStatusV1Schema.parse(JSON.parse(result.body));
      return JSON.stringify({
        ...status,
        identity: { deviceId: status.identity.deviceId }
      });
    }
  },
  {
    name: "set_remote_access_enabled",
    description:
      "Propose enabling or disabling Remote Access. The change runs only if the user accepts the " +
      "separate secure dashboard confirmation card.",
    parameters: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const statusResult = await inject(ctx, { method: "GET", url: "/api/remote-access" });
      if (statusResult.status !== 200) return statusResult.body;
      const status = RemoteAccessStatusV1Schema.parse(JSON.parse(statusResult.body));
      const enabled = args.enabled === true;
      const action = await actionController(ctx).propose({
        category: enabled ? "remote_access_enable" : "remote_access_disable",
        summary: `${enabled ? "Enable" : "Disable"} Remote Access on ${status.config.displayName}.`,
        resource: { type: "remote_access", identifier: status.identity.deviceId },
        operation: {
          kind: "exact_http",
          method: "PUT",
          canonicalTarget: "/api/remote-access",
          payload: { revision: status.config.revision, enabled }
        }
      });
      return confirmationResult(action);
    }
  },
  {
    name: "request_remote_pairing_invite",
    description:
      "Ask the dashboard to show a secure invitation card. Only the browser can create and see " +
      "the pairing token, manual code, or QR; none of them enter this chat.",
    parameters: NO_ARGS,
    execute: async (ctx) => confirmationResult(await actionController(ctx).propose({
      category: "remote_pairing_invitation",
      summary: "Create a private, short-lived invitation for another device.",
      resource: { type: "remote_pairing_invitation", identifier: "new" },
      operation: {
        kind: "exact_http",
        method: "POST",
        canonicalTarget: "/api/remote-access/invitations",
        payload: {},
        resultPolicy: "pair_invitation"
      }
    }))
  },
  {
    name: "cancel_remote_pairing_invite",
    description:
      "Cancel a pairing invitation by opaque invitation ID. An invitation created by this browser " +
      "is cancelled directly; cancelling another administrator's invitation requires a secure card.",
    parameters: {
      type: "object",
      properties: { invitationId: { type: "string" } },
      required: ["invitationId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const invitationId = String(args.invitationId);
      const ownedResult = await actionController(ctx).cancelOwnedInvitation(invitationId);
      if (ownedResult !== undefined) return ownedResult;
      const action = await actionController(ctx).propose({
        category: "remote_invitation_cancel",
        summary: `Cancel pairing invitation ${invitationId}.`,
        resource: { type: "remote_pairing_invitation", identifier: invitationId },
        operation: {
          kind: "exact_http",
          method: "DELETE",
          canonicalTarget: `/api/remote-access/invitations/${encodeURIComponent(invitationId)}`
        }
      });
      return confirmationResult(action);
    }
  },
  {
    name: "list_remote_pairing_requests",
    description:
      "List pending pairing requests using assistant-safe identity claims only. Safety words, " +
      "fingerprints, transcript bindings, and key material are intentionally withheld from chat.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/remote-access/pairing-requests" });
      if (result.status !== 200) return result.body;
      const parsed = PendingPairingRequestListV1Schema.parse(JSON.parse(result.body));
      return JSON.stringify(parsed.requests.map((request) =>
        AssistantSafePairingRequestSummaryV1Schema.parse({
          requestId: request.requestId,
          claimedDisplayName: request.claimedDisplayName,
          claimedPlatform: request.claimedPlatform,
          expiresAt: request.expiresAt
        })
      ));
    }
  },
  {
    name: "approve_remote_pairing_request",
    description:
      "Propose approving one opaque pairing request ID. The assistant never receives the safety " +
      "phrase or fingerprint; the user must compare both in the secure dashboard card.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const requestId = String(args.requestId);
      const result = await inject(ctx, { method: "GET", url: "/api/remote-access/pairing-requests" });
      if (result.status !== 200) return result.body;
      const requests = PendingPairingRequestListV1Schema.parse(JSON.parse(result.body)).requests;
      const request = requests.find((candidate) => candidate.requestId === requestId);
      if (!request) return "The pairing request is no longer pending.";
      const expectedPayload = ApprovePairingInputV1Schema.parse({
        invitationGeneration: request.invitationGeneration,
        remoteIdentityBundleHash: request.remoteIdentityBundleHash,
        transcriptHash: request.transcriptHash,
        channelBinding: request.channelBinding,
        sasIndices: request.sasIndices,
        sasFingerprint: request.sasFingerprint
      });
      const action = await actionController(ctx).propose({
        category: "remote_pairing_approval",
        summary: `Approve ${request.claimedDisplayName} (${helperTargetLabel(request.claimedPlatform)}) after comparing its safety phrase.`,
        resource: { type: "remote_pairing_request", identifier: request.requestId },
        operation: {
          kind: "derived_pairing_approval",
          method: "POST",
          canonicalTarget: `/api/remote-access/pairing-requests/${encodeURIComponent(request.requestId)}/approve`,
          requestId: request.requestId,
          expectedPayload
        }
      });
      return confirmationResult(action);
    }
  },
  {
    name: "reject_remote_pairing_request",
    description: "Reject a pending remote pairing request by opaque request ID.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const requestId = String(args.requestId);
      const result = await inject(ctx, {
        method: "POST",
        url: `/api/remote-access/pairing-requests/${encodeURIComponent(requestId)}/reject`
      });
      return result.status === 202 ? `Pairing request ${requestId} was rejected.` : result.body;
    }
  },
  {
    name: "list_remote_devices",
    description: "List trusted remote devices, their revisions, last-seen times, and direct status.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/remote-access/devices" });
      if (result.status !== 200) return result.body;
      const devices = TrustedDeviceListV1Schema.parse(JSON.parse(result.body)).devices;
      return JSON.stringify(devices.map(({ installationFingerprint: _fingerprint, ...device }) => device));
    }
  },
  {
    name: "rename_remote_device",
    description: "Rename a trusted remote device's display metadata.",
    parameters: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        displayName: { type: "string" }
      },
      required: ["deviceId", "displayName"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const deviceId = String(args.deviceId);
      const listed = await inject(ctx, { method: "GET", url: "/api/remote-access/devices" });
      if (listed.status !== 200) return listed.body;
      const device = TrustedDeviceListV1Schema.parse(JSON.parse(listed.body)).devices
        .find((candidate) => candidate.deviceId === deviceId);
      if (!device) return `Unknown remote device: ${deviceId}`;
      const result = await inject(ctx, {
        method: "PUT",
        url: `/api/remote-access/devices/${encodeURIComponent(deviceId)}`,
        payload: { revision: device.revision, displayName: String(args.displayName) }
      });
      if (result.status !== 200) return result.body;
      const { installationFingerprint: _fingerprint, ...renamed } =
        TrustedDeviceSummaryV1Schema.parse(JSON.parse(result.body));
      return JSON.stringify(renamed);
    }
  },
  {
    name: "revoke_remote_device",
    description:
      "Propose revoking a trusted remote device. Trust is removed only if the user accepts the " +
      "separate secure dashboard confirmation card.",
    parameters: {
      type: "object",
      properties: { deviceId: { type: "string" } },
      required: ["deviceId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const deviceId = String(args.deviceId);
      const listed = await inject(ctx, { method: "GET", url: "/api/remote-access/devices" });
      if (listed.status !== 200) return listed.body;
      const device = TrustedDeviceListV1Schema.parse(JSON.parse(listed.body)).devices
        .find((candidate) => candidate.deviceId === deviceId);
      if (!device) return `Unknown remote device: ${deviceId}`;
      const action = await actionController(ctx).propose({
        category: "remote_device_revoke",
        summary: `Revoke ${device.displayName} (${device.deviceId}) from this host.`,
        resource: { type: "remote_device", identifier: device.deviceId },
        operation: {
          kind: "exact_http",
          method: "DELETE",
          canonicalTarget: `/api/remote-access/devices/${encodeURIComponent(device.deviceId)}`,
          payload: { revision: device.revision }
        }
      });
      return confirmationResult(action);
    }
  },
  {
    name: "reconnect_remote_access",
    description: "Ask the embedded connector to rediscover a direct path. This never enables relay traffic.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/remote-access/reconnect" });
      return result.status === 202 ? "Direct reconnection started." : result.body;
    }
  },
  {
    name: "get_remote_access_diagnostics",
    description:
      "Read sanitized direct-connect diagnostics and the prohibited relay/proxy counters. Never returns endpoints or keys.",
    parameters: NO_ARGS,
    execute: async (ctx) => (await inject(ctx, { method: "GET", url: "/api/remote-access/diagnostics" })).body
  },
  {
    name: "runtime_pause",
    description: "Pause the cast (bots stop replying).",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/pause" });
      return result.status === 200 ? "Runtime paused." : result.body;
    }
  },
  {
    name: "runtime_resume",
    description: "Resume the cast after a pause.",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/resume" });
      return result.status === 200 ? "Runtime resumed." : result.body;
    }
  },
  {
    name: "runtime_reload",
    description: "Reload configs into the running runtime (after config changes).",
    parameters: NO_ARGS,
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "POST", url: "/api/runtime/reload", payload: { reason: "assistant" } });
      return result.status === 200 ? "Runtime reloaded." : result.body;
    }
  },
  {
    name: "get_life",
    description:
      "A waifu's life (Living cast): awake, asleep or mid-turn, her wake queue, today's cost and budget, her last " +
      "compaction and turn, and with `log: true` the newest life-log lines (tool calls show their name and arguments). " +
      "Content from private chats (DMs) is never shown to you; such lines say they were redacted.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        log: { type: "boolean", description: "Also return the newest life-log lines." },
        limit: { type: "number", description: "How many log lines (default 20, max 100)." }
      },
      required: ["waifuId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const base = `/api/waifus/${encodeURIComponent(String(args.waifuId))}/life`;
      const status = await inject(ctx, { method: "GET", url: base });
      if (status.status !== 200 || args.log !== true) return status.body;
      const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 20), 100));
      const log = await inject(ctx, { method: "GET", url: `${base}/log?limit=${limit}` });
      return JSON.stringify({ status: JSON.parse(status.body), log: log.status === 200 ? JSON.parse(log.body) : log.body });
    }
  },
  {
    name: "wake_waifu",
    description:
      "Wake a waifu now as the owner, with an optional note she sees (max 500 characters). An owner wake skips her " +
      "sleep and budget; with Discord offline it waits in her queue. Apply directly when the user asks.",
    parameters: {
      type: "object",
      properties: { waifuId: { type: "string" }, note: { type: "string" } },
      required: ["waifuId"],
      additionalProperties: false
    },
    execute: async (ctx, args) =>
      (
        await inject(ctx, {
          method: "POST",
          url: `/api/waifus/${encodeURIComponent(String(args.waifuId))}/wake`,
          payload: typeof args.note === "string" && args.note.trim() ? { note: args.note.trim().slice(0, 500) } : {}
        })
      ).body
  },
  {
    name: "list_files",
    description:
      "List a folder of a waifu's own computer (Living cast §16): her home (`/home/<name>`, `~`: her notes in any " +
      "layout, MEMORY.md her index; life/ holds schedule.json her day (written each morning), wakeups.json (her wakeups), profile.json and places.md kept by the app) " +
      "or /tmp (files people sent, deleted after the number of days its usage.retentionDays says, 7 by default, since the last write), " +
      "or /transcripts (read-only: everything said where she is, one file per place per day, kept forever). Entries have name, path, kind, size and " +
      "modified time. Files and transcripts from private chats are never shown to you: they appear as `[private chat redacted]`.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        root: { type: "string", enum: ["home", "tmp", "transcripts"], description: "Default home." },
        dir: { type: "string", description: "A folder below the root (`people`), or a path from an entry." }
      },
      required: ["waifuId"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const query = new URLSearchParams();
      if (args.root === "home" || args.root === "tmp" || args.root === "transcripts") query.set("root", args.root);
      if (typeof args.dir === "string" && args.dir.trim()) query.set("dir", args.dir.trim());
      const suffix = query.toString();
      return (await inject(ctx, { method: "GET", url: `/api/waifus/${encodeURIComponent(String(args.waifuId))}/files${suffix ? `?${suffix}` : ""}` })).body;
    }
  },
  {
    name: "read_file",
    description:
      "Read one of a waifu's files by path (`~/people/kevin.md`, `/home/<name>/MEMORY.md`, `/tmp/…`, `/transcripts/<server>/<room>/<day>.md`; a relative path " +
      "is under her home). Text files come back with their text and a hash; images and PDFs only with their size and " +
      "type (the owner opens them in the dashboard). Files from private chats are refused; a note's lines from private chats " +
      "come back as [private chat redacted] and that file is then read-only for you.",
    parameters: {
      type: "object",
      properties: { waifuId: { type: "string" }, path: { type: "string" } },
      required: ["waifuId", "path"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const result = await inject(ctx, { method: "GET", url: herFileUrl(String(args.waifuId), herPathInput(String(args.path ?? ""))) });
      if (result.status !== 200) return result.body;
      const file = JSON.parse(result.body) as { text?: string } & Record<string, unknown>;
      if (typeof file.text === "string" && file.text.length > ASSISTANT_FILE_TEXT_MAX_CHARS) {
        return JSON.stringify({ ...file, text: `${file.text.slice(0, ASSISTANT_FILE_TEXT_MAX_CHARS)}\n… (cut)`, cut: true });
      }
      return result.body;
    }
  },
  {
    name: "write_file",
    description:
      "Propose creating or replacing a text file in a waifu's folders (the whole new text). It runs only if the user " +
      "accepts the separate secure dashboard confirmation card, which shows the file and the whole text; the " +
      "same checks as her own Write tool apply when it runs (life/places.md is refused; the JSON files in life/ " +
      "must stay valid JSON in her format). At most 16 KB; larger edits are for the dashboard's editor.",
    parameters: {
      type: "object",
      properties: {
        waifuId: { type: "string" },
        path: { type: "string", description: "`~/people/kevin.md`, `/tmp/x.txt`, or relative to her home." },
        text: { type: "string", description: "The whole new content." }
      },
      required: ["waifuId", "path", "text"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const waifuId = String(args.waifuId);
      const text = typeof args.text === "string" ? args.text : "";
      if (Buffer.byteLength(text, "utf8") > ASSISTANT_WRITE_MAX_BYTES) {
        return JSON.stringify({ error: `At most ${ASSISTANT_WRITE_MAX_BYTES / 1024} KB through a confirmation card; ask the owner to edit the file in the dashboard (Life → her files).` });
      }
      const herPath = herPathInput(String(args.path ?? ""));
      const target = herFileUrl(waifuId, herPath);
      // The current revision, so the card replaces exactly what it shows (a change meanwhile is a conflict).
      const current = await inject(ctx, { method: "GET", url: target });
      if (current.status !== 200 && current.status !== 404) return current.body;
      const existing = current.status === 200 ? (JSON.parse(current.body) as { hash?: string; display?: string; kind?: string; readOnly?: boolean }) : undefined;
      if (existing?.readOnly) return JSON.stringify({ error: "life/places.md is kept up to date by the app and can't be changed." });
      if (existing && existing.kind !== "text") return JSON.stringify({ error: "That file isn't a text file; it can't be replaced with text." });
      const shown = existing?.display ?? herPath;
      const preview = text.length > ASSISTANT_WRITE_PREVIEW_CHARS ? `${text.slice(0, ASSISTANT_WRITE_PREVIEW_CHARS)}\n…` : text;
      const action = await actionController(ctx).propose({
        category: "waifu_file_write",
        summary: `${existing ? "Replace" : "Create"} ${shown} in ${waifuId}'s folders (${Buffer.byteLength(text, "utf8")} bytes):\n${preview || "(empty file)"}`,
        resource: { type: "waifu_file", identifier: `${waifuId}:${shown}`.slice(0, 256) },
        operation: { kind: "exact_http", method: "PUT", canonicalTarget: target, payload: { text, expectedHash: existing?.hash ?? null } }
      });
      return confirmationResult(action);
    }
  },
  {
    name: "list_wakeups",
    description:
      "A waifu's wakeups (her ~/life/wakeups.json, set with her Wakeup tool): timed ones (at: once, every: repeating, with the " +
      "next times), watches (places, a filter object or her own JavaScript function, until when, once) and pages (url, check, " +
      "every, until), each with its source, state and why it stopped if her code failed. She manages them herself; read-only " +
      "here. A wakeup watching a private chat is shown without its words.",
    parameters: { type: "object", properties: { waifuId: { type: "string" } }, required: ["waifuId"], additionalProperties: false },
    execute: async (ctx, args) => (await inject(ctx, { method: "GET", url: `/api/waifus/${encodeURIComponent(String(args.waifuId))}/wakeups` })).body
  },
  {
    name: "get_usage",
    description:
      "Model calls and cost from the usage ledger, by local day (default: the last 7 days in the host's time zone). " +
      "groupBy is one or two of day, waifu, purpose, model, provider, turn, place, server (comma separated).",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "First local day, YYYY-MM-DD." },
        to: { type: "string", description: "Last local day, YYYY-MM-DD." },
        groupBy: { type: "string" },
        waifuId: { type: "string" },
        tz: { type: "string", description: "IANA time zone, e.g. Europe/Berlin." }
      },
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const query = new URLSearchParams();
      for (const key of ["from", "to", "groupBy", "waifuId", "tz"] as const) {
        if (typeof args[key] === "string" && args[key]) query.set(key, args[key] as string);
      }
      const suffix = query.toString();
      const result = await inject(ctx, { method: "GET", url: `/api/usage${suffix ? `?${suffix}` : ""}` });
      return usageForAssistant(result.status, result.body);
    }
  },
  {
    name: "get_setting_help",
    description:
      "Help for settings from the settings registry: a group (app, waifu, server, channel, assistant, bot, provider, " +
      "remote-access), a key (app.life.maxSendsPerTurn), part of a group (app.life) or a topic (life, forget, usage, " +
      "detector, runtime). Lists each key's type, default, bounds and how to set it. Use it before changing a setting " +
      "you are not sure about.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const topic = String(args.topic ?? "").trim() || "index";
      const result = await inject(ctx, { method: "GET", url: `/api/help/${encodeURIComponent(topic)}?format=md` });
      return result.body.length > SETTING_HELP_MAX_CHARS ? `${result.body.slice(0, SETTING_HELP_MAX_CHARS)}\n… (cut; ask for a narrower topic)` : result.body;
    }
  },
  {
    name: "update_app_config",
    description:
      "Change host-wide settings (config.toml): pass only the keys to change as a nested object under `changes`, e.g. " +
      "{ life: { maxSendsPerTurn: 6 } } or { search: { maxPerDay: 200 } }. See get_setting_help('app') for every key. " +
      "Ordinary keys apply directly. http.host, frontend.staticDir, updates.* and remoteAccess.* are only proposed: a secure dashboard " +
      "confirmation card waits for the user, and only their click on the host's dashboard applies them (never from a " +
      "paired remote device).",
    parameters: {
      type: "object",
      properties: { changes: { type: "object" } },
      required: ["changes"],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      if (!args.changes || typeof args.changes !== "object" || Array.isArray(args.changes)) return JSON.stringify({ error: "Pass the keys to change under `changes`." });
      const { guarded, rest, keys } = splitGuardedAppConfig(args.changes as Record<string, unknown>);
      if (keys.length > 0 && ctx.principal.kind === "remote_device") {
        return JSON.stringify({ error: `${keys.join(", ")} can only be changed on the host itself, not from a paired remote device.` });
      }
      const out: Record<string, unknown> = {};
      if (Object.keys(rest).length > 0) {
        const result = await inject(ctx, { method: "PUT", url: "/api/config", payload: rest });
        if (result.status !== 200) return result.body;
        Object.assign(out, { ok: true, changed: Object.keys(rest) });
      }
      if (keys.length === 0) return JSON.stringify(out);
      const action = await actionController(ctx).propose({
        category: "app_config_host",
        summary: `Change ${keys.map((key) => `${key} to ${JSON.stringify(valueAt(guarded, key))}`).join(", ")} in config.toml. ${GUARDED_APP_CONFIG_NOTE}`,
        resource: { type: "app_config", identifier: "config.toml" },
        operation: { kind: "exact_http", method: "PUT", canonicalTarget: "/api/config", payload: guarded }
      });
      return JSON.stringify({ ...out, ...JSON.parse(confirmationResult(action)), proposed: keys });
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

export function toolDefs(_context?: Pick<AssistantToolContext, "actor" | "principal">): ModelTool[] {
  return ASSISTANT_TOOLS.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }));
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
