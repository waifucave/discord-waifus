import {
  expectedRoutePolicyInventory,
  type RemotePolicy,
  type RetryClass,
  type RouteFieldPolicy,
  type RoutePolicyDefinition
} from "./routePolicy.js";

function safe(
  path: string,
  remotePolicy: RemotePolicy = "full_admin",
  fieldPolicy?: RouteFieldPolicy
): RoutePolicyDefinition {
  return {
    method: "GET",
    path,
    remotePolicy,
    ...(fieldPolicy ? { fieldPolicy } : {})
  };
}

function mutation(
  method: "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  retryClass: Exclude<RetryClass, "safe">,
  auditAction: string,
  fieldPolicy?: RouteFieldPolicy
): RoutePolicyDefinition {
  return {
    method,
    path,
    remotePolicy: "full_admin",
    retryClass,
    auditAction,
    ...(fieldPolicy ? { fieldPolicy } : {})
  };
}

export const ROUTE_POLICY_MANIFEST: readonly RoutePolicyDefinition[] = Object.freeze([
  safe("/", "local_only"),
  {
    method: "*",
    path: "/api/llm/*",
    remotePolicy: "full_admin",
    gatewaySemanticRoutes: [
      { method: "GET", path: "/api/llm/v1/providers", retryClass: "safe" },
      { method: "GET", path: "/api/llm/v1/models", retryClass: "safe" },
      {
        method: "GET",
        path: "/api/llm/v1/models/:provider/:model",
        pathPattern: /^\/api\/llm\/v1\/models\/[^/]+\/.+$/u,
        retryClass: "safe"
      },
      {
        method: "POST",
        path: "/api/llm/v1/chat",
        retryClass: "non_replayable",
        auditAction: "llm.chat"
      },
      { method: "POST", path: "/api/llm/v1/validate", retryClass: "safe" }
    ]
  },
  safe("/api/health"),
  safe("/api/status"),
  safe("/api/runtime"),
  safe("/api/config", "full_admin", "app_config"),
  mutation("PUT", "/api/config", "reconciled", "config.update", "app_config"),
  mutation("POST", "/api/cache/ocr/clear", "reconciled", "cache.ocr.clear"),
  safe("/api/discord-bots"),
  mutation("PUT", "/api/discord-bots", "reconciled", "discord_bots.update"),
  safe("/api/orchestrator/config"),
  mutation("PUT", "/api/orchestrator/config", "transactional", "orchestrator.config.update"),
  safe("/api/orchestrator/history"),
  safe("/api/stage-manager/config"),
  mutation("PUT", "/api/stage-manager/config", "transactional", "stage_manager.config.update"),
  safe("/api/stage-manager/history"),
  safe("/api/reviewer/config"),
  mutation("PUT", "/api/reviewer/config", "transactional", "reviewer.config.update"),
  safe("/api/reviewer/history"),
  safe("/api/logs"),
  safe("/api/docs"),
  safe("/api/docs/:slug"),
  safe("/api/assistant/config"),
  mutation("PUT", "/api/assistant/config", "transactional", "assistant.config.update"),
  mutation(
    "POST",
    "/api/assistant/conversations",
    "transactional",
    "assistant.conversation.create"
  ),
  safe("/api/assistant/conversations"),
  safe("/api/assistant/conversations/:id"),
  mutation(
    "POST",
    "/api/assistant/conversations/:id/messages",
    "non_replayable",
    "assistant.message.send"
  ),
  mutation(
    "DELETE",
    "/api/assistant/conversations/:id",
    "transactional",
    "assistant.conversation.delete"
  ),
  safe("/api/assistant/conversations/:id/stream"),
  safe("/api/providers"),
  mutation(
    "PUT",
    "/api/providers/:providerId/credentials",
    "transactional",
    "provider.credentials.set"
  ),
  mutation(
    "DELETE",
    "/api/providers/:providerId/credentials",
    "transactional",
    "provider.credentials.delete"
  ),
  safe("/api/waifus"),
  mutation("POST", "/api/waifus", "transactional", "waifu.create"),
  safe("/api/waifus/:waifuId"),
  mutation("PUT", "/api/waifus/:waifuId", "transactional", "waifu.update"),
  mutation("POST", "/api/waifus/:waifuId/link-bot", "reconciled", "waifu.bot.link"),
  mutation("POST", "/api/waifus/:waifuId/digest", "non_replayable", "waifu.digest.generate"),
  mutation("DELETE", "/api/waifus/:waifuId", "transactional", "waifu.delete"),
  mutation("POST", "/api/waifus/:waifuId/assets/pfp", "transactional", "waifu.asset.pfp.write"),
  mutation(
    "POST",
    "/api/waifus/:waifuId/assets/banner",
    "transactional",
    "waifu.asset.banner.write"
  ),
  safe("/api/servers"),
  safe("/api/servers/:guildId"),
  mutation("PUT", "/api/servers/:guildId", "transactional", "server.update"),
  mutation(
    "DELETE",
    "/api/servers/:guildId/channels/:channelId",
    "transactional",
    "server.channel.delete"
  ),
  mutation("DELETE", "/api/servers/:guildId", "transactional", "server.delete"),
  safe("/api/servers/:guildId/members"),
  mutation(
    "POST",
    "/api/servers/:guildId/members/refresh",
    "reconciled",
    "server.members.refresh"
  ),
  safe("/api/servers/:guildId/emojis"),
  mutation(
    "POST",
    "/api/servers/:guildId/emojis/refresh",
    "reconciled",
    "server.emojis.refresh"
  ),
  safe("/api/servers/:guildId/roles"),
  mutation(
    "POST",
    "/api/servers/:guildId/roles/refresh",
    "reconciled",
    "server.roles.refresh"
  ),
  mutation(
    "PUT",
    "/api/servers/:guildId/channels/:channelId",
    "transactional",
    "server.channel.update"
  ),
  safe("/api/memories"),
  mutation("POST", "/api/memories", "transactional", "memory.create"),
  mutation("PUT", "/api/memories/:memoryId", "transactional", "memory.update"),
  mutation("DELETE", "/api/memories/:memoryId", "transactional", "memory.delete"),
  mutation("POST", "/api/runtime/pause", "reconciled", "runtime.pause"),
  mutation("POST", "/api/runtime/resume", "reconciled", "runtime.resume"),
  mutation("POST", "/api/runtime/reload", "reconciled", "runtime.reload"),
  mutation("POST", "/api/runtime/stop", "reconciled", "runtime.channel.stop"),
  mutation(
    "POST",
    "/api/runtime/trigger/orchestrator",
    "non_replayable",
    "runtime.orchestrator.trigger"
  ),
  mutation(
    "POST",
    "/api/runtime/trigger/stage-manager",
    "non_replayable",
    "runtime.stage_manager.trigger"
  ),
  safe("/api/diagnostics/bundle"),
  safe("/api/events"),
  safe("/api/client-context", "never_proxy"),
  {
    method: "*",
    path: "<not-found>",
    remotePolicy: "local_only",
    synthetic: "not_found"
  }
]);

export const EXPECTED_ROUTE_POLICY_INVENTORY = Object.freeze(
  expectedRoutePolicyInventory(ROUTE_POLICY_MANIFEST)
);
