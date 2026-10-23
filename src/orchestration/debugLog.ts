// Sends formatted debug logs to the debug route configured for a channel (best-effort).

import { WaifuConfig } from "../shared/schemas/domain.js";
import type { OrchestratorDecision } from "./decisions.js";
import {
  type StageManagerDebugEntry,
  formatDreamDebugLog,
  formatOrchestratorDebugLog,
  formatStageManagerDebugLog,
  splitDebugMessage
} from "./debugFormat.js";
import type { RuntimeServices } from "./runtimeShared.js";
import { readDebugRoute, readDebugRouteForGuild } from "./stores/debugRoutes.js";

export async function sendOrchestratorDebugLog(services: RuntimeServices, input: {
  guildId: string;
  channelId: string;
  decision: OrchestratorDecision;
  availableWaifus: WaifuConfig[];
}): Promise<void> {
  await sendDebugLogForChannel(services, 
    input.guildId,
    input.channelId,
    formatOrchestratorDebugLog(input)
  );
}

export async function sendStageManagerDebugLog(services: RuntimeServices, input: {
  guildId: string;
  channelId: string;
  entries: StageManagerDebugEntry[];
  observationCount: number;
}): Promise<void> {
  await sendDebugLogForChannel(services, 
    input.guildId,
    input.channelId,
    formatStageManagerDebugLog(input)
  );
}

export async function sendDreamDebugLog(services: RuntimeServices, input: {
  guildId: string;
  entries: Array<{ tool: StageManagerDebugEntry["tool"]; summary: string }>;
}): Promise<void> {
  const route = await readDebugRouteForGuild(services.storage, input.guildId);
  if (!route) return;
  await sendDebugLogForChannel(services, 
    input.guildId,
    route.sourceChannelId,
    formatDreamDebugLog(input)
  );
}

export async function sendDebugLogForChannel(services: RuntimeServices, guildId: string, channelId: string, content: string): Promise<void> {
  try {
    if (!services.discord.sendDebugMessage) {
      return;
    }
    const route = await readDebugRoute(services.storage, channelId);
    if (!route) {
      return;
    }
    if (route.sourceGuildId && route.sourceGuildId !== guildId) {
      services.logger.warn("Skipping debug log for route with mismatched source guild", {
        sourceGuildId: guildId,
        sourceChannelId: channelId,
        routeSourceGuildId: route.sourceGuildId
      });
      return;
    }
    for (const chunk of splitDebugMessage(content)) {
      await services.discord.sendDebugMessage({
        channelId: route.destinationChannelId,
        content: chunk
      });
    }
  } catch (error) {
    services.logger.warn("Failed to send Discord debug log", {
      guildId,
      channelId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
