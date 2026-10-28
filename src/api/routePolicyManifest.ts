import {
  expectedRoutePolicyInventory,
  type RemotePolicy,
  type RetryClass,
  type RouteFieldPolicy,
  type RoutePolicyDefinition
} from "./routePolicyDefinitions.js";

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
  safe("/api/health"),
  safe("/api/status"),
  safe("/api/runtime"),
  safe("/api/admin/operations/:operationId"),
  safe("/api/remote-access"),
  {
    method: "POST",
    path: "/api/remote-access/activation",
    remotePolicy: "local_only",
    retryClass: "non_replayable",
    auditAction: "remote_access.activation.begin",
    persistResponse: false
  },
  safe("/api/remote-access/activation/:activationOperationId", "local_only"),
  {
    method: "DELETE",
    path: "/api/remote-access/activation/:activationOperationId",
    remotePolicy: "local_only",
    retryClass: "reconciled",
    auditAction: "remote_access.activation.cancel"
  },
  mutation("PUT", "/api/remote-access", "reconciled", "remote_access.update"),
  {
    method: "POST",
    path: "/api/remote-access/reset",
    remotePolicy: "local_only",
    retryClass: "reconciled",
    auditAction: "remote_access.identity.reset"
  },
  mutation(
    "POST",
    "/api/remote-access/reconnect",
    "reconciled",
    "remote_access.reconnect"
  ),
  {
    method: "POST",
    path: "/api/remote-access/invitations",
    remotePolicy: "full_admin",
    retryClass: "invitation_recovery",
    auditAction: "remote_access.invitation.create",
    persistResponse: false
  },
  mutation(
    "DELETE",
    "/api/remote-access/invitations/:invitationId",
    "reconciled",
    "remote_access.invitation.cancel"
  ),
  safe("/api/remote-access/pairing-requests"),
  mutation(
    "POST",
    "/api/remote-access/pairing-requests/:requestId/approve",
    "reconciled",
    "remote_access.pairing.approve"
  ),
  mutation(
    "POST",
    "/api/remote-access/pairing-requests/:requestId/reject",
    "reconciled",
    "remote_access.pairing.reject"
  ),
  safe("/api/remote-access/devices"),
  mutation(
    "PUT",
    "/api/remote-access/devices/:deviceId",
    "transactional",
    "remote_access.device.rename"
  ),
  mutation(
    "DELETE",
    "/api/remote-access/devices/:deviceId",
    "reconciled",
    "remote_access.device.revoke"
  ),
  safe("/api/remote-access/diagnostics"),
  safe("/api/remote-access/dashboard-manifest"),
  safe("/api/remote-access/dashboard-assets/:buildId/*"),
  safe("/api/config", "full_admin", "app_config"),
  safe("/api/updates"),
  mutation("PUT", "/api/config", "reconciled", "config.update", "app_config"),
  mutation("POST", "/api/cache/ocr/clear", "reconciled", "cache.ocr.clear"),
  safe("/api/discord-bots"),
  mutation("PUT", "/api/discord-bots", "reconciled", "discord_bots.update"),
  safe("/api/models"),
  safe("/api/detector/models"),
  safe("/api/logs"),
  safe("/api/docs"),
  safe("/api/docs/:slug"),
  safe("/api/help"),
  safe("/api/help/:topic"),
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
  safe("/api/assistant/actions/:actionId"),
  {
    method: "POST",
    path: "/api/assistant/actions/:actionId/confirm",
    remotePolicy: "full_admin",
    retryClass: "non_replayable",
    auditAction: "assistant.action.confirm",
    persistResponse: false
  },
  mutation(
    "DELETE",
    "/api/assistant/actions/:actionId",
    "transactional",
    "assistant.action.cancel"
  ),
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
  mutation("DELETE", "/api/waifus/:waifuId", "transactional", "waifu.delete"),
  mutation("POST", "/api/waifus/:waifuId/assets/pfp", "transactional", "waifu.asset.pfp.write"),
  mutation(
    "POST",
    "/api/waifus/:waifuId/assets/banner",
    "transactional",
    "waifu.asset.banner.write"
  ),
  safe("/api/waifus/:waifuId/assets/:kind"),
  safe("/api/waifus/:waifuId/discord-profile"),
  mutation("POST", "/api/waifus/:waifuId/discord-profile/sync", "reconciled", "waifu.discord_profile.sync"),
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
  safe("/api/servers/:guildId/threads"),
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
  // Living cast §14.1: lives, usage, search, the detector, forget jobs and owner notices.
  safe("/api/waifus/:waifuId/life"),
  safe("/api/waifus/:waifuId/life/log"),
  mutation("POST", "/api/waifus/:waifuId/wake", "transactional", "waifu.wake"),
  mutation("POST", "/api/waifus/:waifuId/life/compact", "non_replayable", "waifu.life.compact"),
  mutation("POST", "/api/waifus/:waifuId/life/reset", "transactional", "waifu.life.reset"),
  safe("/api/waifus/:waifuId/life/needs-review"),
  mutation("DELETE", "/api/waifus/:waifuId/life/needs-review/:itemId", "transactional", "waifu.life.review.dismiss"),
  // Living cast §16.11, §30.3: her files and wakeups.
  safe("/api/waifus/:waifuId/files"),
  safe("/api/waifus/:waifuId/files/*"),
  mutation("PUT", "/api/waifus/:waifuId/files/*", "transactional", "waifu.files.write"),
  mutation("DELETE", "/api/waifus/:waifuId/files/*", "transactional", "waifu.files.delete"),
  safe("/api/waifus/:waifuId/wakeups"),
  mutation("DELETE", "/api/waifus/:waifuId/wakeups/:wakeupId", "transactional", "waifu.wakeups.delete"),
  safe("/api/usage"),
  safe("/api/search/usage"),
  safe("/api/detector/config"),
  mutation("PUT", "/api/detector/config", "reconciled", "detector.config.update"),
  safe("/api/detector/history"),
  safe("/api/people/forget-jobs"),
  safe("/api/owner-notices"),
  mutation("POST", "/api/people/:userId/forget", "transactional", "people.forget"),
  safe("/api/dms"),
  safe("/api/dms/:waifuId/:userId"),
  mutation("POST", "/api/dms/:waifuId/:userId/forget", "transactional", "dm.forget"),
  mutation("POST", "/api/runtime/pause", "reconciled", "runtime.pause"),
  mutation("POST", "/api/runtime/resume", "reconciled", "runtime.resume"),
  mutation("POST", "/api/runtime/reload", "reconciled", "runtime.reload"),
  mutation("DELETE", "/api/runtime/model-warnings/:scope", "reconciled", "runtime.model_warnings.dismiss"),
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
