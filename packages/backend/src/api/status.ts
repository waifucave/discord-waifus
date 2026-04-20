import type { Express } from "express";
import type { BotManager } from "../bot-manager.js";
import type { ConfigManager } from "../config-manager.js";
import type { Orchestrator } from "../orchestrator.js";
import type { StageManager } from "../stage-manager.js";

export function setupStatusRoutes(
  app: Express,
  deps: {
    botManager: BotManager;
    config: ConfigManager;
    orchestrator: Orchestrator;
    stageManager: StageManager;
  }
): void {
  app.get("/api/status", (_request, response) => {
    response.json({
      uptimeSeconds: Math.round(process.uptime()),
      bots: deps.botManager.getBotStatuses(),
      activeGenerations: deps.orchestrator.getGenerationStatus(),
      stageManager: deps.stageManager.getRuntimeState(),
      configSummary: {
        waifus: deps.config.waifus.length,
        providers: deps.config.providers.length,
        channels: deps.config.channels.length
      }
    });
  });
}
