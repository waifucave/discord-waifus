import type { Express } from "express";
import type { BotManager } from "../bot-manager.js";
import type { ConfigManager } from "../config-manager.js";

export interface DebugEventRecord {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export function setupDebugRoutes(
  app: Express,
  deps: {
    botManager: BotManager;
    config: ConfigManager;
    getRecentEvents: () => DebugEventRecord[];
  }
): void {
  app.get("/api/debug", (_request, response) => {
    response.json({
      uptimeSeconds: Math.round(process.uptime()),
      listener: deps.botManager.getDebugState(),
      bots: deps.botManager.getBotStatuses(),
      config: {
        waifus: deps.config.waifus.map((waifu) => ({
          id: waifu.id,
          displayName: waifu.displayName,
          enabled: waifu.enabled,
          providerId: waifu.ai.providerId,
          model: waifu.ai.model
        })),
        channels: deps.config.channels.map((channel) => ({
          channelId: channel.channelId,
          channelName: channel.channelName,
          enabled: channel.enabled,
          activeWaifuIds: channel.activeWaifuIds,
          contextAnchorMessageId: channel.contextAnchorMessageId
        })),
        orchestrator: deps.config.orchestrator,
        stageManager: deps.config.stageManager
      },
      recentEvents: deps.getRecentEvents()
    });
  });
}
