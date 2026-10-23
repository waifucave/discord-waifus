// /console debug routes (user/orchestrator/debug.json): which channel receives a source
// channel's debug logs.

import path from "node:path";
import { OrchestratorDebugConfigFileSchema, ServerConfigSchema, createEmptyRevisionedFile } from "../../shared/schemas/domain.js";
import { createRevisionedBase, nowIso } from "../../shared/schemas/common.js";
import { StorageService } from "../../storage/storageService.js";

export async function setDebugRoute(storage: StorageService, input: {
  sourceGuildId?: string;
  sourceChannelId: string;
  destinationGuildId?: string;
  destinationChannelId: string;
  userId: string;
}): Promise<void> {
  // Debug routes carry full orchestrator reasoning, directives, and dream summaries — never route
  // them into a channel where waifus are active. Read the destination guild's server config
  // (read-only) and refuse when the destination channel has enabled waifus.
  if (input.destinationGuildId) {
    const destinationServer = await storage.readJson(
      path.join("user", "servers", input.destinationGuildId, "server.json"),
      ServerConfigSchema,
      ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId: input.destinationGuildId,
        enabled: true
      })
    );
    if ((destinationServer.channels[input.destinationChannelId]?.enabledWaifuIds?.length ?? 0) > 0) {
      throw new Error("Refusing to route debug logs into a channel with active waifus — pick a private channel.");
    }
  }
  const now = nowIso();
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:debug",
    relativePath: "user/orchestrator/debug.json",
    schema: OrchestratorDebugConfigFileSchema,
    fallback: OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} })),
    transform: (current) => {
      const previous = current.routes[input.sourceChannelId];
      return {
        ...current,
        routes: {
          ...current.routes,
          [input.sourceChannelId]: {
            sourceGuildId: input.sourceGuildId,
            sourceChannelId: input.sourceChannelId,
            destinationGuildId: input.destinationGuildId,
            destinationChannelId: input.destinationChannelId,
            createdByUserId: previous?.createdByUserId ?? input.userId,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now
          }
        }
      };
    }
  });
}

export async function unsetDebugRoute(storage: StorageService, sourceChannelId: string): Promise<boolean> {
  let removed = false;
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:debug",
    relativePath: "user/orchestrator/debug.json",
    schema: OrchestratorDebugConfigFileSchema,
    fallback: OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} })),
    transform: (current) => {
      if (!current.routes[sourceChannelId]) {
        return current;
      }
      const { [sourceChannelId]: _removed, ...routes } = current.routes;
      removed = true;
      return { ...current, routes };
    }
  });
  return removed;
}

export async function readDebugRoute(storage: StorageService, sourceChannelId: string) {
  const config = await storage.readJson(
    "user/orchestrator/debug.json",
    OrchestratorDebugConfigFileSchema,
    OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} }))
  );
  return config.routes[sourceChannelId];
}

// The dream pass is guild-scoped (no originating channel), so its debug log goes to any route
// configured for the guild: prefer one whose sourceGuildId matches, else the first route.
export async function readDebugRouteForGuild(storage: StorageService, guildId: string) {
  const config = await storage.readJson(
    "user/orchestrator/debug.json",
    OrchestratorDebugConfigFileSchema,
    OrchestratorDebugConfigFileSchema.parse(createEmptyRevisionedFile({ routes: {} }))
  );
  const routes = Object.values(config.routes);
  return routes.find((route) => route.sourceGuildId === guildId) ?? routes[0];
}
