import type { Express } from "express";
import { z } from "zod";
import type { ConfigManager } from "../config-manager.js";
import { orchestratorConfigSchema } from "../types/index.js";
import { asyncRoute } from "./helpers.js";

const updateOrchestratorSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional()
});

export function setupOrchestratorRoutes(
  app: Express,
  deps: { config: ConfigManager }
): void {
  app.get("/api/orchestrator", (_request, response) => {
    response.json({
      orchestrator: deps.config.orchestrator
    });
  });

  app.put(
    "/api/orchestrator",
    asyncRoute(async (request, response) => {
      const patch = updateOrchestratorSchema.parse(request.body);
      const nextConfig = orchestratorConfigSchema.parse({
        ...deps.config.orchestrator,
        ...patch
      });

      await deps.config.saveOrchestrator(nextConfig);
      response.json({
        orchestrator: nextConfig
      });
    })
  );
}
