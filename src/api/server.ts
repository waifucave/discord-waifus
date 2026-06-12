import { randomUUID, createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createGatewayHandler, type GatewayHandlerOptions, type ModelSummary, type ProviderDef } from "@waifucave/gateway";
import gatewayPlugin from "@waifucave/gateway/fastify";
import { createProviderCredentialsLookup } from "./llmGatewayCredentials.js";
import { loadAppConfig, saveAppConfig } from "../config/appConfig.js";
import { resolveDataPath, userDataPath } from "../config/paths.js";
import { Logger, createLogger } from "../backend/logger.js";
import { RuntimeState } from "../backend/runtime.js";
import { RuntimeOrchestrator } from "../orchestration/runtime.js";
import { clearOcrArtifacts } from "../orchestration/ocr.js";
import { extractEntities } from "../orchestration/memoryEntities.js";
import { getModel, listModels, listProviders } from "../providers/catalog.js";
import { createModelPipeline } from "../providers/pipelines.js";
import type { ModelPipeline } from "../providers/types.js";
import {
  AgentConfig,
  AgentConfigSchema,
  DiscordBotsFile,
  DiscordBotsFileSchema,
  GuildEmojisFile,
  GuildEmojisFileSchema,
  GuildEmojiCacheEntry,
  GuildMembersFile,
  GuildMembersFileSchema,
  GuildMemberCacheEntry,
  GuildRoleCacheEntry,
  GuildRolesFile,
  GuildRolesFileSchema,
  MemoryRecord,
  MemoryStore,
  MemoryStoreSchema,
  MemoryKindSchema,
  OrchestratorHistoryFile,
  OrchestratorHistoryFileSchema,
  ProviderCredentialsFile,
  ProviderCredentialsFileSchema,
  ReviewerHistoryFile,
  ReviewerHistoryFileSchema,
  ProviderIdSchema,
  ServerConfig,
  ServerConfigSchema,
  StageManagerHistoryFile,
  StageManagerHistoryFileSchema,
  WaifuConfig,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { AppConfigSchema } from "../shared/schemas/config.js";
import { createRevisionedBase, nowIso } from "../shared/schemas/common.js";
import { StorageConflictError } from "../storage/errors.js";
import { StorageService } from "../storage/storageService.js";
import { recentQueries, recentReplies, subscribeQueries, subscribeReplies } from "../shared/queryLog.js";
import { ApiError, badRequest, conflict, notFound, preconditionRequired } from "./errors.js";
import { mergeConfiguredBotsIntoMembers } from "../discord/memberCache.js";

export type ApiServerOptions = {
  dataRoot: string;
  storage?: StorageService;
  runtime: RuntimeState;
  runtimeOrchestrator?: RuntimeOrchestrator;
  runtimeControl?: {
    getOrchestrator: () => RuntimeOrchestrator | undefined;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    reload: (reason: string) => Promise<void>;
  };
  logger?: Logger;
  /** Test hook: overrides the fetch the mounted LLM gateway uses for provider calls. */
  llmGateway?: {
    fetchImpl?: typeof fetch;
  };
};

const ProviderCredentialsBodySchema = z.object({
  apiKey: z.string().min(1),
  label: z.string().optional(),
  revision: z.number().int().nonnegative().optional()
});

const CreateWaifuBodySchema = WaifuConfigSchema.omit({
  schemaVersion: true,
  revision: true,
  updatedAt: true
})
  .partial({ id: true, enabled: true, persona: true, contextWindow: true, generation: true })
  .required({ name: true, displayName: true });

// personaDigest is server-managed; clients cannot set it via PUT.
const UpdateWaifuBodySchema = WaifuConfigSchema.omit({ personaDigest: true }).partial().extend({
  revision: z.number().int().nonnegative().optional()
});

const ServerConfigBodySchema = ServerConfigSchema.partial().extend({
  revision: z.number().int().nonnegative().optional()
});

const ChannelConfigBodySchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  enabledWaifuIds: z.array(z.string()).optional()
});

const CreateMemoryBodySchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  waifuId: z.string().min(1),
  guildId: z.string().min(1),
  content: z.string().min(1),
  // User-created memories are pinned by default (per design), but the dashboard can override.
  strength: z.number().min(0).max(5).optional(),
  pinned: z.boolean().optional(),
  kind: MemoryKindSchema.optional()
});

const UpdateMemoryBodySchema = CreateMemoryBodySchema.partial().extend({
  revision: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "archived"]).optional()
});

const AgentConfigBodySchema = AgentConfigSchema.partial().extend({
  revision: z.number().int().nonnegative().optional()
});

const DiscordBotsBodySchema = DiscordBotsFileSchema.partial().extend({
  revision: z.number().int().nonnegative().optional()
});

const DiscordApiErrorSchema = z.object({
  message: z.string().optional(),
  code: z.number().optional()
});

const RuntimeTriggerBodySchema = z.object({
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional()
}).optional();

const ASSET_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

export async function createApiServer(options: ApiServerOptions): Promise<FastifyInstance> {
  const storage = options.storage ?? new StorageService(options.dataRoot);
  const logger = options.logger ?? createLogger({ dataRoot: options.dataRoot });
  const app = fastify({ logger: false });
  app.addContentTypeParser(/^image\/(png|jpeg|webp|gif)$/u, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StorageConflictError) {
      void reply.status(409).send({
        error: "Conflict",
        message: error.message,
        latest: error.latest
      });
      return;
    }
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({
        error: error.name,
        message: error.message,
        details: error.details
      });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: "ValidationError",
        issues: error.issues
      });
      return;
    }
    const unknownError = error as Error;
    logger.error("Unhandled API error", { message: unknownError.message, stack: unknownError.stack });
    void reply.status(500).send({ error: "InternalServerError" });
  });

  // P2 (MIGRATION_PLAN §7.4/§8): the gateway HTTP API rides at /api/llm/* with
  // keys read live from user/providers.json. The plugin is self-encapsulated —
  // own JSON parsing, own error envelopes; pipelines.ts chat traffic is untouched.
  const llmGatewayOptions: GatewayHandlerOptions = {
    credentials: createProviderCredentialsLookup(options.dataRoot),
    ...(options.llmGateway?.fetchImpl ? { fetchImpl: options.llmGateway.fetchImpl } : {})
  };
  await app.register(gatewayPlugin, { prefix: "/api/llm", ...llmGatewayOptions });

  // Registry proxies (§7.4): /api/models and /api/providers carry the gateway
  // listings as additive sibling fields. A second handler instance (the plugin
  // builds its own internally) serves the exact public /v1 shapes; both
  // endpoints are static-registry GETs, so a non-200 is a gateway defect → 500.
  const llmProxy = createGatewayHandler(llmGatewayOptions);
  async function llmRegistryJson(endpoint: "/v1/models" | "/v1/providers"): Promise<unknown> {
    const response = await llmProxy.handle(new Request(`http://gateway.internal${endpoint}`));
    if (response.status !== 200) {
      throw new Error(`gateway registry endpoint ${endpoint} returned ${response.status}`);
    }
    return response.json();
  }

  app.get("/", async (request, reply) => {
    if (await tryServeFrontend(request, reply, options.dataRoot, "/")) {
      return reply;
    }
    return {
      name: "@waifucave/discord-waifus",
      api: "/api/health"
    };
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "discord-waifus",
    time: new Date().toISOString()
  }));

  app.get("/api/status", async () => ({
    running: true,
    paused: options.runtime.paused,
    httpUrl: `http://127.0.0.1:${options.runtime.port}`,
    dataRoot: options.dataRoot,
    discord: options.runtime.discord,
    queues: options.runtime.queues
  }));

  app.get("/api/runtime", async () => options.runtime);

  app.get("/api/config", async () => loadAppConfig(options.dataRoot));
  app.put("/api/config", async (request) => {
    const config = AppConfigSchema.parse(request.body);
    const saved = await saveAppConfig(options.dataRoot, config);
    options.runtime.paused = saved.runtime.paused;
    await options.runtimeControl?.reload("config-updated");
    return saved;
  });

  app.post("/api/cache/ocr/clear", async () => {
    await clearOcrArtifacts(options.dataRoot);
    return {
      accepted: true,
      message: "OCR cache and temporary OCR files cleared."
    };
  });

  app.get("/api/discord-bots", async () => sanitizeDiscordBots(await readDiscordBots(storage)));
  app.put("/api/discord-bots", async (request) => {
    const body = DiscordBotsBodySchema.parse(request.body);
    const saved = await storage.updateRevisionedJson({
      resourceKey: "discord-bots",
      relativePath: "user/discord-bots.json",
      schema: DiscordBotsFileSchema,
      fallback: emptyDiscordBots(),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => {
        const { revision: _revision, schemaVersion: _schemaVersion, updatedAt: _updatedAt, ...patch } = body;
        return mergeDiscordBots(current, patch);
      }
    });
    await options.runtimeControl?.reload("discord-bots-updated");
    return sanitizeDiscordBots(saved);
  });

  app.get("/api/orchestrator/config", async () => readAgentConfig(storage, "orchestrator"));
  app.put("/api/orchestrator/config", async (request) => {
    const body = AgentConfigBodySchema.parse(request.body);
    return updateAgentConfig(storage, request, "orchestrator", body, 20);
  });
  app.get("/api/orchestrator/history", async () => readOrchestratorHistory(storage));

  app.get("/api/stage-manager/config", async () => readAgentConfig(storage, "stage-manager"));
  app.put("/api/stage-manager/config", async (request) => {
    const body = AgentConfigBodySchema.parse(request.body);
    return updateAgentConfig(storage, request, "stage-manager", body, 80);
  });
  app.get("/api/stage-manager/history", async () => readStageManagerHistory(storage));

  app.get("/api/reviewer/config", async () => readAgentConfig(storage, "reviewer"));
  app.put("/api/reviewer/config", async (request) => {
    const body = AgentConfigBodySchema.parse(request.body);
    return updateAgentConfig(storage, request, "reviewer", body, 20);
  });
  app.get("/api/reviewer/history", async () => readReviewerHistory(storage));

  app.get("/api/providers", async () => {
    const [credentials, gatewayList] = await Promise.all([
      readProviderCredentials(storage),
      llmRegistryJson("/v1/providers") as Promise<{ providers: GatewayProviderListing[] }>
    ]);
    return {
      revision: credentials.revision,
      updatedAt: credentials.updatedAt,
      providers: listProviders().map((provider) => {
        const saved = credentials.providers[provider.id];
        return {
          ...provider,
          credentials: saved
            ? {
                configured: true,
                label: saved.label,
                updatedAt: saved.updatedAt,
                keyHint: keyHint(saved.apiKey)
              }
            : {
                configured: false
              }
        };
      }),
      gatewayProviders: gatewayList.providers
    };
  });

  app.put("/api/providers/:providerId/credentials", async (request) => {
    const { providerId } = z.object({ providerId: ProviderIdSchema }).parse(request.params);
    const body = ProviderCredentialsBodySchema.parse(request.body);
    const now = nowIso();
    const updated = await storage.updateRevisionedJson({
      resourceKey: "providers",
      relativePath: "user/providers.json",
      schema: ProviderCredentialsFileSchema,
      fallback: emptyProviderCredentials(),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => ({
        ...current,
        providers: {
          ...current.providers,
          [providerId]: {
            providerId,
            apiKey: body.apiKey,
            label: body.label,
            createdAt: current.providers[providerId]?.createdAt ?? now,
            updatedAt: now
          }
        }
      })
    });
    return providerCredentialsResponse(updated, providerId);
  });

  app.get("/api/models", async () => {
    const gatewayList = (await llmRegistryJson("/v1/models")) as { models: ModelSummary[] };
    return { models: listModels(), gatewayModels: gatewayList.models };
  });

  app.get("/api/waifus", async () => ({ waifus: await listWaifus(storage) }));
  app.post("/api/waifus", async (request, reply) => {
    const body = CreateWaifuBodySchema.parse(request.body);
    const id = body.id ?? slugId(body.name);
    assertSafeId(id);
    const relativePath = waifuRelativePath(id);
    if (await exists(resolveDataPath(options.dataRoot, relativePath))) {
      throw conflict(`Waifu ${id} already exists.`);
    }
    const waifu = WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      ...body,
      id
    });
    const saved = await storage.writeJson(`waifu:${id}`, relativePath, WaifuConfigSchema, waifu);
    return reply.status(201).send(saved);
  });

  app.get("/api/waifus/:waifuId", async (request) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    return readWaifu(storage, waifuId);
  });

  app.put("/api/waifus/:waifuId", async (request) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    const body = UpdateWaifuBodySchema.parse(request.body);
    requireRevision(request, body);
    const saved = await storage.updateRevisionedJson({
      resourceKey: `waifu:${waifuId}`,
      relativePath: waifuRelativePath(waifuId),
      schema: WaifuConfigSchema,
      fallback: await readWaifu(storage, waifuId),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => {
        const { revision: _revision, schemaVersion: _schemaVersion, updatedAt: _updatedAt, id: _id, ...patch } = body;
        return {
          ...current,
          ...patch,
          id: current.id,
          // personaDigest is server-managed; always carry it forward from current.
          personaDigest: current.personaDigest
        };
      }
    });
    // Fire-and-forget: regenerate persona digest when persona text changed.
    void generatePersonaDigestIfStale(storage, saved, logger).catch(() => {
      // Errors are handled inside generatePersonaDigestIfStale with logger.warn.
    });
    return saved;
  });

  app.post("/api/waifus/:waifuId/digest", async (request) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    const waifu = await readWaifu(storage, waifuId);
    const setup = await resolvePersonaDigestPipeline(storage);
    if (!setup.ok) {
      throw conflict(setup.reason);
    }
    const { pipeline, modelId } = setup;
    const personaHash = createHash("sha256").update(waifu.persona).digest("hex");
    const digest = await pipeline.generatePersonaDigest!({
      modelId,
      messages: [],
      personaText: waifu.persona
    });
    return storage.updateRevisionedJson({
      resourceKey: `waifu:${waifuId}`,
      relativePath: waifuRelativePath(waifuId),
      schema: WaifuConfigSchema,
      fallback: waifu,
      transform: (current) => ({
        ...current,
        personaDigest: { ...digest, personaHash }
      })
    });
  });

  app.delete("/api/waifus/:waifuId", async (request, reply) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    const existing = await readWaifu(storage, waifuId);
    const body = z.object({ revision: z.number().int().nonnegative().optional() }).optional().parse(request.body);
    const revision = expectedRevision(request, body);
    if (revision === undefined) {
      throw preconditionRequired("DELETE /api/waifus/:waifuId requires revision or If-Match.");
    }
    if (existing.revision !== revision) {
      throw new StorageConflictError("Record has changed since it was read.", existing);
    }
    await storage.withLocks([`waifu:${waifuId}`], () =>
      rm(resolveDataPath(options.dataRoot, "user", "waifus", waifuId), {
        recursive: true,
        force: true
      })
    );
    return reply.status(204).send();
  });

  app.post("/api/waifus/:waifuId/assets/pfp", async (request, reply) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    await readWaifu(storage, waifuId);
    return saveWaifuAsset(options.dataRoot, request, reply, waifuId, "pfp");
  });

  app.post("/api/waifus/:waifuId/assets/banner", async (request, reply) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    await readWaifu(storage, waifuId);
    return saveWaifuAsset(options.dataRoot, request, reply, waifuId, "banner");
  });

  app.get("/api/servers", async () => ({ servers: await listServers(storage) }));
  app.put("/api/servers/:guildId", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const body = ServerConfigBodySchema.parse(request.body);
    const fallback = ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId
    });
    return storage.updateRevisionedJson({
      resourceKey: `server:${guildId}`,
      relativePath: serverRelativePath(guildId),
      schema: ServerConfigSchema,
      fallback,
      expectedRevision: expectedRevision(request, body),
      transform: (current) => {
        const { revision: _revision, schemaVersion: _schemaVersion, updatedAt: _updatedAt, guildId: _guildId, ...patch } = body;
        return {
          ...current,
          ...patch,
          guildId
        };
      }
    });
  });

  app.get("/api/servers/:guildId/members", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readMembers(storage, guildId);
  });
  app.post("/api/servers/:guildId/members/refresh", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const refreshed = await refreshDiscordMembers(storage, guildId);
    return reply.status(202).send(refreshed);
  });

  app.get("/api/servers/:guildId/emojis", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readEmojis(storage, guildId);
  });
  app.post("/api/servers/:guildId/emojis/refresh", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const refreshed = await refreshDiscordEmojis(storage, guildId);
    return reply.status(202).send(refreshed);
  });

  app.get("/api/servers/:guildId/roles", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readRoles(storage, guildId);
  });
  app.post("/api/servers/:guildId/roles/refresh", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const refreshed = await refreshDiscordRoles(storage, guildId);
    return reply.status(202).send(refreshed);
  });

  app.put("/api/servers/:guildId/channels/:channelId", async (request) => {
    const { guildId, channelId } = z
      .object({ guildId: z.string().min(1), channelId: z.string().min(1) })
      .parse(request.params);
    assertSafeId(guildId);
    assertSafeId(channelId);
    const body = ChannelConfigBodySchema.parse(request.body);
    return storage.updateRevisionedJson({
      resourceKey: `server:${guildId}`,
      relativePath: serverRelativePath(guildId),
      schema: ServerConfigSchema,
      fallback: ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId
      }),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => ({
        ...current,
        channels: {
          ...current.channels,
          [channelId]: {
            channelId,
            name: body.name ?? current.channels[channelId]?.name,
            enabled: body.enabled,
            enabledWaifuIds: body.enabledWaifuIds ?? current.channels[channelId]?.enabledWaifuIds ?? []
          }
        }
      })
    });
  });

  app.get("/api/memories", async () => readMemoryStore(storage));
  app.post("/api/memories", async (request, reply) => {
    const body = CreateMemoryBodySchema.parse(request.body);
    const now = nowIso();
    const updated = await storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => ({
        ...current,
        memories: [
          ...current.memories,
          {
            id: randomUUID(),
            waifuId: body.waifuId,
            guildId: body.guildId,
            content: body.content,
            kind: body.kind ?? "fact",
            source: "user" as const,
            // User-created memories are pinned by default (only the user manages them).
            pinned: body.pinned ?? true,
            strength: body.strength ?? 5,
            entities: extractEntities(body.content),
            createdAt: now,
            updatedAt: now,
            status: "active" as const
          }
        ]
      })
    });
    return reply.status(201).send(updated);
  });

  app.put("/api/memories/:memoryId", async (request) => {
    const { memoryId } = parseIdParam(request.params, "memoryId");
    const body = UpdateMemoryBodySchema.parse(request.body);
    requireRevision(request, body);
    return storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => updateMemoryOrThrow(current, memoryId, body)
    });
  });

  app.delete("/api/memories/:memoryId", async (request) => {
    const { memoryId } = parseIdParam(request.params, "memoryId");
    const body = z.object({ revision: z.number().int().nonnegative().optional() }).optional().parse(request.body);
    const revision = expectedRevision(request, body);
    if (revision === undefined) {
      throw preconditionRequired("DELETE /api/memories/:memoryId requires revision or If-Match.");
    }
    return storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      expectedRevision: revision,
      transform: (current) => ({
        ...current,
        memories: current.memories.filter((memory) => memory.id !== memoryId)
      })
    });
  });

  app.post("/api/runtime/pause", async () => {
    options.runtime.paused = true;
    await (options.runtimeControl?.pause() ?? options.runtimeOrchestrator?.pause());
    options.runtime.updatedAt = nowIso();
    return options.runtime;
  });
  app.post("/api/runtime/resume", async () => {
    options.runtime.paused = false;
    await options.runtimeControl?.resume();
    options.runtime.updatedAt = nowIso();
    return options.runtime;
  });
  app.post("/api/runtime/reload", async () => {
    await options.runtimeControl?.reload("manual-api");
    return {
      accepted: true,
      message: "Runtime reload applied. Discord clients and runtime orchestration were rebuilt without restarting HTTP."
    };
  });
  app.post("/api/runtime/trigger/orchestrator", async (request) => {
    const body = RuntimeTriggerBodySchema.parse(request.body);
    const runtimeOrchestrator = options.runtimeControl?.getOrchestrator() ?? options.runtimeOrchestrator;
    if (body?.guildId && body.channelId && runtimeOrchestrator) {
      void runtimeOrchestrator.triggerChannel(body.guildId, body.channelId, "manual-api");
      return {
        accepted: true,
        message: "Orchestrator trigger accepted for the requested channel."
      };
    }
    const history = await appendOrchestratorHistory(storage, {
      id: randomUUID(),
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 180,
      reasoning: "Manual trigger accepted without a target guild/channel.",
      status: "completed",
      waifuMessageIds: [],
      responderOutcomes: [],
      createdAt: nowIso()
    });
    return {
      accepted: true,
      message: "Orchestrator trigger accepted and recorded in history.",
      history
    };
  });
  app.post("/api/runtime/trigger/stage-manager", async (request) => {
    const body = RuntimeTriggerBodySchema.parse(request.body);
    const runtimeOrchestrator = options.runtimeControl?.getOrchestrator() ?? options.runtimeOrchestrator;
    if (body?.guildId && body.channelId && runtimeOrchestrator) {
      void runtimeOrchestrator.triggerStageManager(body.guildId, body.channelId);
      return {
        accepted: true,
        message: "Stage-manager trigger accepted for the requested channel."
      };
    }
    const history = await appendStageManagerHistory(storage, {
      id: randomUUID(),
      tool: "no_change",
      affectedMemoryIds: [],
      summary: "Manual trigger accepted without a target guild/channel.",
      createdAt: nowIso()
    });
    return {
      accepted: true,
      message: "Stage-manager trigger accepted and recorded in history.",
      history
    };
  });
  app.get("/api/diagnostics/bundle", async () => diagnosticBundle(storage, options.runtime));
  app.get("/api/events", async (request, reply) => sendSseSnapshot(request, reply, options.runtime, logger));

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "NotFound", message: `${request.method} ${request.url} was not found.` });
    }
    if (await tryServeFrontend(request, reply, options.dataRoot)) {
      return reply;
    }
    return reply.status(404).send({ error: "NotFound", message: `${request.method} ${request.url} was not found.` });
  });

  return app;
}

async function readDiscordBots(storage: StorageService): Promise<DiscordBotsFile> {
  return storage.readJson("user/discord-bots.json", DiscordBotsFileSchema, emptyDiscordBots());
}

function emptyDiscordBots(): DiscordBotsFile {
  return DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }));
}

function mergeDiscordBots(
  current: DiscordBotsFile,
  patch: Partial<DiscordBotsFile>
): DiscordBotsFile {
  const orchestrator =
    patch.orchestrator === undefined
      ? current.orchestrator
      : patch.orchestrator === null
        ? null
        : {
            ...patch.orchestrator,
            token: patch.orchestrator.token ?? current.orchestrator?.token
          };
  const currentWaifus = new Map(current.waifus.map((bot) => [bot.id, bot]));
  const waifus = patch.waifus
    ? patch.waifus.map((bot) => ({
        ...bot,
        token: bot.token ?? currentWaifus.get(bot.id)?.token
      }))
    : current.waifus;
  return {
    ...current,
    orchestrator,
    waifus
  };
}

function sanitizeDiscordBots(file: DiscordBotsFile) {
  return {
    ...file,
    orchestrator: file.orchestrator ? sanitizeDiscordBot(file.orchestrator) : null,
    waifus: file.waifus.map(sanitizeDiscordBot)
  };
}

function sanitizeDiscordBot(bot: DiscordBotsFile["waifus"][number]) {
  return {
    ...bot,
    token: undefined,
    tokenConfigured: Boolean(bot.token),
    tokenHint: bot.token ? keyHint(bot.token) : undefined
  };
}

async function readAgentConfig(
  storage: StorageService,
  agent: "orchestrator" | "stage-manager" | "reviewer"
): Promise<AgentConfig> {
  const defaultWindow = agent === "stage-manager" ? 80 : 20;
  return storage.readJson(
    `user/${agent}/config.json`,
    AgentConfigSchema,
    AgentConfigSchema.parse(
      createEmptyRevisionedFile({
        enabled: false,
        contextWindow: defaultWindow,
        prompt: ""
      })
    )
  );
}

async function updateAgentConfig(
  storage: StorageService,
  request: FastifyRequest,
  agent: "orchestrator" | "stage-manager" | "reviewer",
  body: z.infer<typeof AgentConfigBodySchema>,
  defaultContextWindow: number
): Promise<AgentConfig> {
  return storage.updateRevisionedJson({
    resourceKey: agent,
    relativePath: `user/${agent}/config.json`,
    schema: AgentConfigSchema,
    fallback: AgentConfigSchema.parse(
      createEmptyRevisionedFile({
        enabled: false,
        contextWindow: defaultContextWindow,
        prompt: ""
      })
    ),
    expectedRevision: expectedRevision(request, body),
    transform: (current) => {
      const { revision: _revision, schemaVersion: _schemaVersion, updatedAt: _updatedAt, ...patch } = body;
      return {
        ...current,
        ...patch
      };
    }
  });
}

async function readOrchestratorHistory(storage: StorageService): Promise<OrchestratorHistoryFile> {
  return storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema, emptyOrchestratorHistory());
}

function emptyOrchestratorHistory(): OrchestratorHistoryFile {
  return OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }));
}

async function appendOrchestratorHistory(
  storage: StorageService,
  entry: OrchestratorHistoryFile["decisions"][number]
): Promise<OrchestratorHistoryFile> {
  return storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: emptyOrchestratorHistory(),
    transform: (current) => ({
      ...current,
      decisions: [entry, ...current.decisions].slice(0, 200)
    })
  });
}

async function readStageManagerHistory(storage: StorageService): Promise<StageManagerHistoryFile> {
  return storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema, emptyStageManagerHistory());
}

function emptyStageManagerHistory(): StageManagerHistoryFile {
  return StageManagerHistoryFileSchema.parse(createEmptyRevisionedFile({ edits: [] }));
}

async function appendStageManagerHistory(
  storage: StorageService,
  entry: StageManagerHistoryFile["edits"][number]
): Promise<StageManagerHistoryFile> {
  return storage.updateRevisionedJson({
    resourceKey: "stage-manager:history",
    relativePath: "user/stage-manager/history.json",
    schema: StageManagerHistoryFileSchema,
    fallback: emptyStageManagerHistory(),
    transform: (current) => ({
      ...current,
      edits: [entry, ...current.edits].slice(0, 200)
    })
  });
}

async function readReviewerHistory(storage: StorageService): Promise<ReviewerHistoryFile> {
  return storage.readJson("user/reviewer/history.json", ReviewerHistoryFileSchema, emptyReviewerHistory());
}

function emptyReviewerHistory(): ReviewerHistoryFile {
  return ReviewerHistoryFileSchema.parse(createEmptyRevisionedFile({ reviews: [] }));
}

async function readProviderCredentials(storage: StorageService): Promise<ProviderCredentialsFile> {
  return storage.readJson("user/providers.json", ProviderCredentialsFileSchema, emptyProviderCredentials());
}

function emptyProviderCredentials(): ProviderCredentialsFile {
  return ProviderCredentialsFileSchema.parse(createEmptyRevisionedFile({ providers: {} }));
}

function providerCredentialsResponse(file: ProviderCredentialsFile, providerId: string) {
  const saved = file.providers[providerId];
  return {
    revision: file.revision,
    updatedAt: file.updatedAt,
    providerId,
    credentials: saved
      ? {
          configured: true,
          label: saved.label,
          updatedAt: saved.updatedAt,
          keyHint: keyHint(saved.apiKey)
        }
      : { configured: false }
  };
}

function keyHint(value: string): string {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

async function listWaifus(storage: StorageService): Promise<WaifuConfig[]> {
  const root = userDataPath(storage.dataRoot, "waifus");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const waifus = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await storage.readJson(waifuRelativePath(entry), WaifuConfigSchema);
      } catch {
        return undefined;
      }
    })
  );
  return waifus.filter((waifu): waifu is WaifuConfig => waifu !== undefined);
}

async function readWaifu(storage: StorageService, waifuId: string): Promise<WaifuConfig> {
  assertSafeId(waifuId);
  try {
    return await storage.readJson(waifuRelativePath(waifuId), WaifuConfigSchema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw notFound(`Waifu ${waifuId} was not found.`);
    }
    throw error;
  }
}

function waifuRelativePath(waifuId: string): string {
  assertSafeId(waifuId);
  return path.join("user", "waifus", waifuId, "waifu.json");
}

async function listServers(storage: StorageService): Promise<ServerConfig[]> {
  const root = userDataPath(storage.dataRoot, "servers");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const servers = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await storage.readJson(serverRelativePath(entry), ServerConfigSchema);
      } catch {
        return undefined;
      }
    })
  );
  return servers.filter((server): server is ServerConfig => server !== undefined);
}

function serverRelativePath(guildId: string): string {
  assertSafeId(guildId);
  return path.join("user", "servers", guildId, "server.json");
}

type GatewayProviderListing = ProviderDef & { credentialConfigured: boolean };

async function readMembers(storage: StorageService, guildId: string): Promise<GuildMembersFile> {
  assertSafeId(guildId);
  const [file, bots] = await Promise.all([
    storage.readJson(
      path.join("user", "servers", guildId, "members.json"),
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    ),
    readDiscordBots(storage)
  ]);
  return {
    ...file,
    members: mergeConfiguredBotsIntoMembers(file.members, bots)
  };
}

async function readEmojis(storage: StorageService, guildId: string): Promise<GuildEmojisFile> {
  assertSafeId(guildId);
  return storage.readJson(
    path.join("user", "servers", guildId, "emojis.json"),
    GuildEmojisFileSchema,
    GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
  );
}

async function readRoles(storage: StorageService, guildId: string): Promise<GuildRolesFile> {
  assertSafeId(guildId);
  return storage.readJson(
    path.join("user", "servers", guildId, "roles.json"),
    GuildRolesFileSchema,
    GuildRolesFileSchema.parse(createEmptyRevisionedFile({ guildId, roles: [] }))
  );
}

async function readMemoryStore(storage: StorageService): Promise<MemoryStore> {
  return storage.readJson("user/memories.json", MemoryStoreSchema, emptyMemoryStore());
}

function emptyMemoryStore(): MemoryStore {
  return MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }));
}

function updateMemoryOrThrow(
  current: MemoryStore,
  memoryId: string,
  patch: z.infer<typeof UpdateMemoryBodySchema>
): MemoryStore {
  let found = false;
  const now = nowIso();
  const memories = current.memories.map((memory): MemoryRecord => {
    if (memory.id !== memoryId) {
      return memory;
    }
    found = true;
    const { revision: _revision, ...editable } = patch;
    const next: MemoryRecord = {
      ...memory,
      ...editable,
      updatedAt: now
    };
    if (editable.content !== undefined) {
      next.entities = extractEntities(editable.content);
    }
    return next;
  });
  if (!found) {
    throw notFound(`Memory ${memoryId} was not found.`);
  }
  return {
    ...current,
    memories
  };
}

function parseIdParam(params: unknown, key: string): Record<string, string> {
  const parsed = z.record(z.string(), z.string().min(1)).parse(params);
  assertSafeId(parsed[key]);
  return parsed;
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw badRequest(`Invalid id: ${id}`);
  }
}

function slugId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || randomUUID();
}

async function saveWaifuAsset(
  dataRoot: string,
  request: FastifyRequest,
  reply: FastifyReply,
  waifuId: string,
  kind: "pfp" | "banner"
) {
  const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const ext = ASSET_EXT_BY_MIME[contentType];
  if (!ext) {
    throw badRequest("Asset upload requires image/png, image/jpeg, image/webp, or image/gif.");
  }
  if (!Buffer.isBuffer(request.body)) {
    throw badRequest("Asset upload body must be raw image bytes.");
  }
  const body = request.body;
  if (body.byteLength === 0) {
    throw badRequest("Asset upload body is empty.");
  }
  if (body.byteLength > 8 * 1024 * 1024) {
    throw badRequest("Asset upload is too large. Maximum size is 8 MB.");
  }
  const dir = resolveDataPath(dataRoot, "user", "waifus", waifuId);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.values(ASSET_EXT_BY_MIME).map((knownExt) => rm(path.join(dir, `${kind}.${knownExt}`), { force: true }))
  );
  const relativePath = path.join("user", "waifus", waifuId, `${kind}.${ext}`);
  await writeFile(resolveDataPath(dataRoot, relativePath), body, { mode: 0o600 });
  return reply.status(201).send({
    ok: true,
    kind,
    waifuId,
    contentType,
    bytes: body.byteLength,
    relativePath
  });
}

async function refreshDiscordMembers(storage: StorageService, guildId: string) {
  const token = await readDiscordBotToken(storage);
  if (!token) {
    return {
      accepted: false,
      guildId,
      message: "Discord bot token is not configured. Save the orchestrator bot first.",
      members: await readMembers(storage, guildId)
    };
  }
  const rawMembers = await fetchAllDiscordGuildMembers(token, guildId);
  const now = nowIso();
  const bots = await readDiscordBots(storage);
  const members: GuildMemberCacheEntry[] = mergeConfiguredBotsIntoMembers(
    rawMembers.map((member) => ({
      userId: member.user.id,
      username: member.user.username,
      globalDisplayName: member.user.global_name ?? undefined,
      guildDisplayName: member.nick ?? member.user.global_name ?? member.user.username,
      bot: member.user.bot ?? false,
      lastSeenAt: now,
      perChannelLastSeenAt: {}
    })),
    bots
  );
  const file = await storage.updateRevisionedJson({
    resourceKey: `members:${guildId}`,
    relativePath: path.join("user", "servers", guildId, "members.json"),
    schema: GuildMembersFileSchema,
    fallback: GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] })),
    transform: (current) => ({
      ...current,
      guildId,
      members
    })
  });
  return {
    accepted: true,
    guildId,
    message: `Fetched ${members.length} members from Discord.`,
    members: file
  };
}

async function fetchAllDiscordGuildMembers(token: string, guildId: string) {
  const MemberSchema = z.object({
    nick: z.string().nullable().optional(),
    user: z.object({
      id: z.string(),
      username: z.string().optional(),
      global_name: z.string().nullable().optional(),
      bot: z.boolean().optional()
    })
  });
  const members: Array<z.infer<typeof MemberSchema>> = [];
  let after = "0";
  for (;;) {
    const response = await discordApiFetch(
      token,
      `/guilds/${guildId}/members?limit=1000&after=${encodeURIComponent(after)}`
    );
    const page = z.array(MemberSchema).parse(response);
    members.push(...page);
    if (page.length < 1000) {
      return members;
    }
    after = page[page.length - 1]?.user.id ?? after;
  }
}

async function refreshDiscordEmojis(storage: StorageService, guildId: string) {
  const token = await readDiscordBotToken(storage);
  if (!token) {
    return {
      accepted: false,
      guildId,
      message: "Discord bot token is not configured. Save the orchestrator bot first.",
      emojis: await readEmojis(storage, guildId)
    };
  }
  const response = await discordApiFetch(token, `/guilds/${guildId}/emojis`);
  const rawEmojis = z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        animated: z.boolean().optional(),
        available: z.boolean().optional(),
        roles: z.array(z.string()).optional()
      })
    )
    .parse(response);
  const now = nowIso();
  const emojis: GuildEmojiCacheEntry[] = rawEmojis
    .filter((emoji) => emoji.name)
    .map((emoji) => ({
      id: emoji.id,
      name: emoji.name ?? "emoji",
      animated: emoji.animated ?? false,
      available: emoji.available ?? true,
      roles: emoji.roles ?? [],
      fetchedAt: now
    }));
  const file = await storage.updateRevisionedJson({
    resourceKey: `emojis:${guildId}`,
    relativePath: path.join("user", "servers", guildId, "emojis.json"),
    schema: GuildEmojisFileSchema,
    fallback: GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] })),
    transform: (current) => ({
      ...current,
      guildId,
      emojis
    })
  });
  return {
    accepted: true,
    guildId,
    message: `Fetched ${emojis.length} server emojis from Discord.`,
    emojis: file
  };
}

async function refreshDiscordRoles(storage: StorageService, guildId: string) {
  const token = await readDiscordBotToken(storage);
  if (!token) {
    return {
      accepted: false,
      guildId,
      message: "Discord bot token is not configured. Save the orchestrator bot first.",
      roles: await readRoles(storage, guildId)
    };
  }
  const rawRoles = await fetchAllDiscordGuildRoles(token, guildId);
  const roles = mapDiscordRoles(rawRoles);
  const file = await storage.updateRevisionedJson({
    resourceKey: `roles:${guildId}`,
    relativePath: path.join("user", "servers", guildId, "roles.json"),
    schema: GuildRolesFileSchema,
    fallback: GuildRolesFileSchema.parse(createEmptyRevisionedFile({ guildId, roles: [] })),
    transform: (current) => ({
      ...current,
      guildId,
      roles
    })
  });
  return {
    accepted: true,
    guildId,
    message: `Fetched ${roles.length} server roles from Discord.`,
    roles: file
  };
}

async function fetchAllDiscordGuildRoles(token: string, guildId: string) {
  const response = await discordApiFetch(token, `/guilds/${guildId}/roles`);
  return z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        color: z.number().int().nonnegative().optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
        managed: z.boolean().optional()
      })
    )
    .parse(response);
}

function mapDiscordRoles(rawRoles: Awaited<ReturnType<typeof fetchAllDiscordGuildRoles>>): GuildRoleCacheEntry[] {
  const now = nowIso();
  return rawRoles
    .filter((role) => role.name !== "@everyone")
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color ?? 0,
      hoist: role.hoist ?? false,
      mentionable: role.mentionable ?? false,
      managed: role.managed ?? false,
      fetchedAt: now
    }));
}

async function readDiscordBotToken(storage: StorageService): Promise<string | undefined> {
  const bots = await readDiscordBots(storage);
  return bots.orchestrator?.enabled === false
    ? bots.waifus.find((bot) => bot.enabled && bot.token)?.token
    : bots.orchestrator?.token ?? bots.waifus.find((bot) => bot.enabled && bot.token)?.token;
}

async function discordApiFetch(token: string, pathAndQuery: string): Promise<unknown> {
  const response = await fetch(`https://discord.com/api/v10${pathAndQuery}`, {
    headers: {
      authorization: token.startsWith("Bot ") ? token : `Bot ${token}`,
      "user-agent": "Discord-Waifus/0.1"
    }
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const body = DiscordApiErrorSchema.safeParse(parsed);
    const message = body.success ? body.data.message : response.statusText;
    throw badRequest(`Discord API request failed (${response.status}): ${message ?? "unknown error"}`);
  }
  return parsed;
}

async function diagnosticBundle(storage: StorageService, runtime: unknown) {
  const [providers, bots, orchestrator, stageManager, memories] = await Promise.all([
    readProviderCredentials(storage),
    readDiscordBots(storage),
    readAgentConfig(storage, "orchestrator"),
    readAgentConfig(storage, "stage-manager"),
    readMemoryStore(storage)
  ]);
  return {
    generatedAt: nowIso(),
    runtime,
    providers: {
      revision: providers.revision,
      configured: Object.fromEntries(
        Object.entries(providers.providers).map(([id, credentials]) => [
          id,
          {
            label: credentials.label,
            updatedAt: credentials.updatedAt,
            keyHint: keyHint(credentials.apiKey)
          }
        ])
      )
    },
    discord: {
      revision: bots.revision,
      orchestratorConfigured: Boolean(bots.orchestrator?.token),
      orchestratorApplicationId: bots.orchestrator?.applicationId,
      waifuBotCount: bots.waifus.length,
      configuredWaifuBotCount: bots.waifus.filter((bot) => bot.token).length
    },
    orchestrator: {
      revision: orchestrator.revision,
      providerId: orchestrator.providerId,
      modelId: orchestrator.modelId,
      contextWindow: orchestrator.contextWindow,
      promptLength: orchestrator.prompt.length
    },
    stageManager: {
      revision: stageManager.revision,
      providerId: stageManager.providerId,
      modelId: stageManager.modelId,
      contextWindow: stageManager.contextWindow,
      promptLength: stageManager.prompt.length
    },
    memories: {
      revision: memories.revision,
      count: memories.memories.length
    }
  };
}

async function resolveStaticDir(configured?: string): Promise<string | undefined> {
  const bundledCandidates = [
    // Default to the frontend bundled with the installed package, resolved
    // relative to this module rather than process.cwd(), so `waifus start`
    // serves the dashboard no matter which directory it was launched from.
    // (dist/api/server.js and src/api/server.ts both sit two levels under the
    // package root, where dist-frontend/ lives.)
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-frontend"),
    // Backwards-compatible fallback for setups that relied on the working directory.
    path.resolve(process.cwd(), "dist-frontend")
  ];
  const candidates = configured ? [path.resolve(configured), ...bundledCandidates] : bundledCandidates;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function tryServeFrontend(
  request: FastifyRequest,
  reply: FastifyReply,
  dataRoot: string,
  overrideUrl?: string
): Promise<boolean> {
  const config = await loadAppConfig(dataRoot);
  const staticDir = await resolveStaticDir(config.frontend.staticDir);
  if (!staticDir) {
    return false;
  }
  const url = new URL(overrideUrl ?? request.url, "http://waifus.local");
  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  const filePath = path.resolve(staticDir, relativePath);
  if (!filePath.startsWith(staticDir + path.sep) && filePath !== staticDir) {
    return false;
  }

  const candidate = await readableFile(filePath) ? filePath : path.join(staticDir, "index.html");
  if (!(await readableFile(candidate))) {
    return false;
  }
  const body = await readFile(candidate);
  reply.header("content-type", contentTypeFor(candidate));
  reply.header("cache-control", candidate.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
  reply.send(body);
  return true;
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expectedRevision(request: FastifyRequest, body: { revision?: number } | undefined): number | undefined {
  if (body?.revision !== undefined) {
    return body.revision;
  }
  const ifMatch = request.headers["if-match"];
  if (typeof ifMatch !== "string") {
    return undefined;
  }
  const normalized = ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireRevision(request: FastifyRequest, body: { revision?: number } | undefined): void {
  if (expectedRevision(request, body) === undefined) {
    throw preconditionRequired("This endpoint requires revision in the body or an If-Match header.");
  }
}

function sendSseSnapshot(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: RuntimeState,
  logger: Logger
): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  reply.raw.write(`event: runtime\ndata: ${JSON.stringify(runtime)}\n\n`);
  for (const entry of logger.recent?.().slice().reverse() ?? []) {
    reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  for (const entry of recentQueries()) {
    reply.raw.write(`event: query\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  for (const entry of recentReplies()) {
    reply.raw.write(`event: reply\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  const unsubscribeLogs = logger.subscribe?.((entry) => {
    reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  });
  const unsubscribeQueries = subscribeQueries((entry) => {
    reply.raw.write(`event: query\ndata: ${JSON.stringify(entry)}\n\n`);
  });
  const unsubscribeReplies = subscribeReplies((entry) => {
    reply.raw.write(`event: reply\ndata: ${JSON.stringify(entry)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  }, 30_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeLogs?.();
    unsubscribeQueries();
    unsubscribeReplies();
    reply.raw.end();
  });
}

type DigestPipeline = ModelPipeline & { generatePersonaDigest: NonNullable<ModelPipeline["generatePersonaDigest"]> };
type DigestSetup =
  | { ok: true; pipeline: DigestPipeline; modelId: string }
  | { ok: false; reason: string };

async function resolvePersonaDigestPipeline(storage: StorageService): Promise<DigestSetup> {
  const stageManagerConfig = await readAgentConfig(storage, "stage-manager");
  const modelId = stageManagerConfig.modelId;
  if (!modelId) {
    return { ok: false, reason: "Stage-manager has no model configured." };
  }
  const credentials = await readProviderCredentials(storage);
  const model = getModel(modelId);
  if (!model) {
    return { ok: false, reason: "Stage-manager model is not recognized." };
  }
  const providerCreds = credentials.providers[model.providerId];
  if (!providerCreds?.apiKey) {
    return { ok: false, reason: `Stage-manager provider "${model.providerId}" has no API key configured.` };
  }
  const pipeline = createModelPipeline(modelId, { apiKey: providerCreds.apiKey });
  if (!pipeline.generatePersonaDigest) {
    return { ok: false, reason: "Stage-manager model does not support persona digest generation." };
  }
  return { ok: true, pipeline: pipeline as DigestPipeline, modelId };
}

async function generatePersonaDigestIfStale(
  storage: StorageService,
  waifu: WaifuConfig,
  logger: Logger
): Promise<void> {
  let resolvedModelId: string | undefined;
  try {
    const personaHash = createHash("sha256").update(waifu.persona).digest("hex");
    if (waifu.personaDigest?.personaHash === personaHash) {
      // Digest is up to date; nothing to do.
      return;
    }
    const setup = await resolvePersonaDigestPipeline(storage);
    if (!setup.ok) return;
    const { pipeline, modelId } = setup;
    resolvedModelId = modelId;
    const digest = await pipeline.generatePersonaDigest({
      modelId,
      messages: [],
      personaText: waifu.persona
    });
    await storage.updateRevisionedJson({
      resourceKey: `waifu:${waifu.id}`,
      relativePath: waifuRelativePath(waifu.id),
      schema: WaifuConfigSchema,
      fallback: waifu,
      transform: (current) => ({
        ...current,
        personaDigest: { ...digest, personaHash }
      })
    });
  } catch (error) {
    logger.warn("Persona digest generation failed", {
      waifuId: waifu.id,
      modelId: resolvedModelId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
