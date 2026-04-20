import type { Express } from "express";
import { z } from "zod";
import { AIRouter } from "../ai-router.js";
import type { ConfigManager } from "../config-manager.js";
import {
  localProviderTypeSchema,
  providerAuthModeSchema,
  providerOriginSchema,
  type LocalProviderDefinition
} from "../types/index.js";
import { asyncRoute } from "./helpers.js";

const createProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: localProviderTypeSchema,
  authMode: providerAuthModeSchema.default("required"),
  baseUrl: z.string().min(1),
  enabled: z.boolean().default(true),
  models: z.array(z.string()).default([]),
  keyValue: z.string().default("")
});

const updateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  type: localProviderTypeSchema.optional(),
  authMode: providerAuthModeSchema.optional(),
  baseUrl: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  models: z.array(z.string()).optional(),
  keyValue: z.string().optional()
});

export function setupProviderRoutes(
  app: Express,
  deps: { config: ConfigManager; aiRouter: AIRouter }
): void {
  app.get(
    "/api/providers",
    asyncRoute(async (_request, response) => {
      const composed = await deps.config.composer.compose();
      response.json({ providers: composed.providerEditorEntries });
    })
  );

  app.post(
    "/api/providers",
    asyncRoute(async (request, response) => {
      const provider = createProviderSchema.parse(request.body);
      const [providers, keys] = await Promise.all([
        deps.config.runtimeStore.readProviders(),
        deps.config.runtimeStore.readProviderKeys()
      ]);
      if (providers.providers.some((entry) => entry.id === provider.id)) {
        response.status(409).json({ error: "Provider with this id already exists" });
        return;
      }

      await deps.config.runtimeStore.writeProviders({
        providers: [
          ...providers.providers,
          {
            id: provider.id,
            origin: "custom" as const,
            name: provider.name,
            type: provider.type,
            authMode: provider.authMode,
            enabled: provider.enabled,
            baseUrl: provider.baseUrl,
            models: provider.models
          }
        ].sort((left, right) => left.id.localeCompare(right.id))
      });
      await deps.config.runtimeStore.writeProviderKeys({
        providerKeys: [
          ...keys.providerKeys.filter((entry) => entry.id !== provider.id),
          { id: provider.id, apiKey: provider.keyValue }
        ].sort((left, right) => left.id.localeCompare(right.id))
      });
      await deps.config.refreshFromDisk("providers.json");

      const composed = await deps.config.composer.compose();
      const created = composed.providerEditorEntries.find((entry) => entry.id === provider.id);
      response.status(201).json(created);
    })
  );

  app.put(
    "/api/providers/:id",
    asyncRoute(async (request, response) => {
      const providerId = String(request.params.id);
      const patch = updateProviderSchema.parse(request.body);
      const [providers, keys] = await Promise.all([
        deps.config.runtimeStore.readProviders(),
        deps.config.runtimeStore.readProviderKeys()
      ]);
      const existing = providers.providers.find((entry) => entry.id === providerId);
      if (!existing) {
        response.status(404).json({ error: "Provider not found" });
        return;
      }

      const nextDefinition = mergeProviderDefinition(existing, patch);
      const nextProviders = providers.providers.map((entry) =>
        entry.id === providerId ? nextDefinition : entry
      );
      const nextKeys = [
        ...keys.providerKeys.filter((entry) => entry.id !== providerId),
        {
          id: providerId,
          apiKey: patch.keyValue ?? keys.providerKeys.find((entry) => entry.id === providerId)?.apiKey ?? ""
        }
      ];

      if (existing.origin === "built-in") {
        nextDefinition.name = existing.name;
        nextDefinition.type = existing.type;
        nextDefinition.authMode = existing.authMode;
      }

      await deps.config.runtimeStore.writeProviders({ providers: nextProviders });
      await deps.config.runtimeStore.writeProviderKeys({
        providerKeys: nextKeys.sort((left, right) => left.id.localeCompare(right.id))
      });
      await deps.config.refreshFromDisk("providers.json");

      const composed = await deps.config.composer.compose();
      const updated = composed.providerEditorEntries.find((entry) => entry.id === providerId);
      response.json(updated);
    })
  );

  app.delete(
    "/api/providers/:id",
    asyncRoute(async (request, response) => {
      const providerId = String(request.params.id);
      const [providers, keys] = await Promise.all([
        deps.config.runtimeStore.readProviders(),
        deps.config.runtimeStore.readProviderKeys()
      ]);
      const existing = providers.providers.find((entry) => entry.id === providerId);
      if (!existing) {
        response.status(404).json({ error: "Provider not found" });
        return;
      }
      if (existing.origin !== "custom") {
        response.status(400).json({ error: "Built-in providers cannot be deleted" });
        return;
      }

      await deps.config.runtimeStore.writeProviders({
        providers: providers.providers.filter((entry) => entry.id !== providerId)
      });
      await deps.config.runtimeStore.writeProviderKeys({
        providerKeys: keys.providerKeys.filter((entry) => entry.id !== providerId)
      });
      await deps.config.refreshFromDisk("providers.json");
      response.status(204).end();
    })
  );

  app.post(
    "/api/providers/:id/test",
    asyncRoute(async (request, response) => {
      const providerId = String(request.params.id);
      const composed = await deps.config.composer.compose();
      const provider = composed.providerEditorEntries.find((entry) => entry.id === providerId);
      if (!provider) {
        response.status(404).json({ error: "Provider not found" });
        return;
      }

      const model = provider.models[0];
      if (!model) {
        response.status(400).json({ error: "Provider has no configured models", runtimeErrors: provider.runtimeErrors });
        return;
      }

      if (!provider.isRuntimeCallable) {
        const runtimeErrors = provider.enabled
          ? provider.runtimeErrors
          : ["Provider is disabled"];
        response.status(400).json({
          error: provider.enabled ? "Provider is not fully configured" : "Provider is disabled",
          runtimeErrors,
          models: provider.models,
          ok: false
        });
        return;
      }

      const result = await deps.aiRouter.complete({
        providerId,
        model,
        messages: [{ role: "user", content: "Say hello in one sentence." }],
        maxTokens: 50,
        timeoutMs: 20_000
      });

      response.json({
        ok: true,
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage
      });
    })
  );

  app.get(
    "/api/providers/:id/models",
    asyncRoute(async (request, response) => {
      const providerId = String(request.params.id);
      const composed = await deps.config.composer.compose();
      const provider = composed.providerEditorEntries.find((entry) => entry.id === providerId);
      if (!provider) {
        response.status(404).json({ error: "Provider not found" });
        return;
      }

      if (!provider.isRuntimeCallable) {
        const runtimeErrors = provider.enabled
          ? provider.runtimeErrors
          : ["Provider is disabled"];
        response.json({
          models: provider.models,
          discoveryAttempted: false,
          runtimeErrors
        });
        return;
      }

      try {
        const discovered = await deps.aiRouter.fetchAvailableModels(providerId);
        response.json({
          models: [...new Set([...provider.models, ...discovered])],
          discoveryAttempted: true,
          runtimeErrors: []
        });
      } catch (error) {
        response.json({
          models: provider.models,
          discoveryAttempted: true,
          runtimeErrors: [
            ...(provider.runtimeErrors ?? []),
            error instanceof Error ? error.message : String(error)
          ]
        });
      }
    })
  );
}

function mergeProviderDefinition(
  existing: LocalProviderDefinition,
  patch: z.infer<typeof updateProviderSchema>
): LocalProviderDefinition {
  return {
    id: existing.id,
    origin: existing.origin,
    name: patch.name ?? existing.name,
    type: patch.type ?? existing.type,
    authMode: patch.authMode ?? existing.authMode,
    enabled: patch.enabled ?? existing.enabled,
    baseUrl: patch.baseUrl ?? existing.baseUrl,
    models: patch.models ? [...patch.models] : existing.models
  };
}
