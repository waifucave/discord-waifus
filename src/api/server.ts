import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createProviderCredentialsLookup } from "../models/credentials.js";
import { curatedCatalog, installedCatalog } from "../models/catalog.js";
import type { AssistantModelClient } from "./assistant/service.js";
import { clearModelWarnings, readModelWarnings } from "../models/modelWarnings.js";
import { decisionModelCatalog } from "../life/detector/catalog.js";
import { queueOwnerScrubs } from "../life/forget.js";
import { loadAppConfig, updateAppConfig } from "../config/appConfig.js";
import { resolveDataPath, userDataPath } from "../config/paths.js";
import { Logger, createLogger, type LogEntry } from "../backend/logger.js";
import { RuntimeState } from "../backend/runtime.js";
import { redactRemoteHostDetails, redactSecrets } from "../backend/redaction.js";
import { CastRuntime } from "../orchestration/runtime.js";
import { clearOcrArtifacts } from "../orchestration/ocr.js";
import { forgetJobNotices, forgetUser, unqueuedForgetResult } from "../orchestration/dm/forgetUser.js";
import { readThreads } from "../orchestration/stores/threads.js";
import { providerStatuses, keyHint } from "./providerStatus.js";
import { sharedProviderAlerts } from "../orchestration/providerAlerts.js";
import {
  AssistantConfig,
  AssistantConfigSchema,
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
  type ModelChoice,
  ProviderCredentialsFile,
  ProviderCredentialsFileSchema,
  ProviderIdSchema,
  ServerConfig,
  ServerConfigSchema,
  WaifuConfig,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { UpdateAppConfigBodySchema, type AppConfig } from "../shared/schemas/config.js";
import {
  CreateWaifuBodySchema as CreateWaifuBodySchemaShared,
  PeopleForgetBodySchema as PeopleForgetBodySchemaShared,
  ProviderCredentialsBodySchema as ProviderCredentialsBodySchemaShared,
  UpdateAssistantConfigBodySchema,
  UpdateChannelBodySchema,
  UpdateDiscordBotsBodySchema,
  UpdateServerBodySchema,
  UpdateWaifuBodySchema as UpdateWaifuBodySchemaShared
} from "../shared/schemas/api.js";
import type { DeepPartial } from "../shared/schemas/partial.js";
import { createRevisionedBase, nowIso } from "../shared/schemas/common.js";
import { StorageConflictError } from "../storage/errors.js";
import { StorageService } from "../storage/storageService.js";
import { AuditStore } from "../storage/auditStore.js";
import { OperationStore } from "../storage/operationStore.js";
import { onCapturedTrafficForgotten, recentQueries, recentReplies, subscribeQueries, subscribeReplies } from "../shared/queryLog.js";
import { listDocs, readDoc } from "./docsKb.js";
import { registerAssistantRoutes } from "./assistant/routes.js";
import { registerDmRoutes } from "./dms.js";
import { computeDmEligibility } from "../orchestration/dm/dmStore.js";
import { assertSafeId, assertSnowflakeId } from "./ids.js";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  conflict,
  notFound,
  preconditionRequired
} from "./errors.js";
import { mergeConfiguredBotsIntoMembers } from "../discord/memberCache.js";
import { DirectoryTransportError, GuildDirectory, type DirectoryKind } from "../discord/guildDirectory.js";
import { assertKnownProvider, assertModelChoiceValid } from "./writeValidation.js";
import { BrowserSecurity, type BrowserSecurityOptions } from "./browserSecurity.js";
import { installRoutePolicy } from "./routePolicy.js";
import { ROUTE_POLICY_MANIFEST } from "./routePolicyManifest.js";
import type { RemoteRequestPrincipal, RequestPrincipal } from "./requestPrincipal.js";
import { ClientContextV1Schema } from "../shared/schemas/remoteLifecycle.js";
import { registerAdminOperationRoutes } from "./adminOperations.js";
import { registerRemoteAccessRoutes } from "./remoteAccess.js";
import type { RemoteAccessService } from "../backend/remoteAccess/remoteAccessService.js";
import type { DashboardBuild } from "../backend/remoteAccess/dashboardBuild.js";
import { installMutationHandling } from "./mutations.js";
import {
  EVENT_AUTHORIZATION_HEARTBEAT_MS,
  MAX_EVENT_BYTES
} from "../shared/schemas/adminOperations.js";
import { EventStream, serializeSseEvent } from "./eventStream.js";
import type { CapturedQuery, CapturedReply } from "../shared/queryLog.js";
import { installUpdateActivity, type UpdateActivity } from "../backend/updates/activity.js";
import { automaticUpdateStatus } from "../backend/updates/worker.js";

export type ApiServerOptions = {
  updateActivity?: UpdateActivity;
  dataRoot: string;
  storage?: StorageService;
  runtime: RuntimeState;
  castRuntime?: CastRuntime;
  /** The host's guild directory (spec 9.4); the refresh routes go through it. Built over the storage when omitted. */
  directory?: GuildDirectory;
  runtimeControl?: {
    getCastRuntime: () => CastRuntime | undefined;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    reload: (reason: string) => Promise<void>;
  };
  logger?: Logger;
  /** Test hook: overrides the model client the assistant chat uses. */
  assistant?: {
    modelClient?: AssistantModelClient;
  };
  browserSecurity?: Partial<BrowserSecurityOptions>;
  remoteTrust?: {
    isAuthorized: (principal: RemoteRequestPrincipal) => boolean | Promise<boolean>;
  };
  remoteAccess?: RemoteAccessService;
  dashboardBuild?: DashboardBuild;
  administration?: {
    operationStore?: OperationStore;
    auditStore?: AuditStore;
    now?: () => bigint;
    randomBytes?: (size: number) => Uint8Array;
  };
};

// Serializes config.toml read-modify-write between PUT /api/config and runtime pause/resume.
const APP_CONFIG_LOCK = "app-config";

// Request bodies live with the shared API schemas (overhaul §10.6): the dashboard's types derive from them.
const ProviderCredentialsBodySchema = ProviderCredentialsBodySchemaShared;
const CreateWaifuBodySchema = CreateWaifuBodySchemaShared;
const UpdateWaifuBodySchema = UpdateWaifuBodySchemaShared;
const ServerConfigBodySchema = UpdateServerBodySchema;
const ChannelConfigBodySchema = UpdateChannelBodySchema;
const PeopleForgetBodySchema = PeopleForgetBodySchemaShared;
const AssistantConfigBodySchema = UpdateAssistantConfigBodySchema;
const DiscordBotsBodySchema = UpdateDiscordBotsBodySchema;

function mergeNestedPatch<T>(current: T, patch: NoInfer<DeepPartial<T>> | undefined): T {
  if (patch === undefined) return current;
  if (!isPlainRecord(current) || !isPlainRecord(patch)) return patch as T;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = mergeNestedPatch(current[key], value as never);
  }
  return merged as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASSET_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

/**
 * Gateway P6 Task 4: after a `{...current, ...patch}` merge, an explicitly-unset field (the
 * patch carries the key with value `undefined` — see WaifuConfigSchema/AgentConfigSchema's
 * null-to-undefined transform) leaves an own key with value `undefined` on the merged object.
 * JSON.stringify already drops undefined-valued keys (both atomicWriteJson and Fastify's default
 * response serialization), so behavior is correct either way — this makes the "stored JSON never
 * carries nulls/undefined" guarantee explicit on the in-memory object too, rather than relying on
 * incidental serialization behavior.
 */
function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key as keyof T] === undefined) {
      delete value[key as keyof T];
    }
  }
  return value;
}

export async function createApiServer(options: ApiServerOptions): Promise<FastifyInstance> {
  const storage = options.storage ?? new StorageService(options.dataRoot);
  const operationStore = options.administration?.operationStore ?? new OperationStore(
    options.dataRoot,
    {
      storage,
      ...(options.administration?.now ? { now: options.administration.now } : {}),
      ...(options.administration?.randomBytes
        ? { randomBytes: options.administration.randomBytes }
        : {})
    }
  );
  const auditStore = options.administration?.auditStore ?? new AuditStore(options.dataRoot, {
    storage,
    ...(options.administration?.now ? { now: options.administration.now } : {})
  });
  const logger = options.logger ?? createLogger({ dataRoot: options.dataRoot });
  // The dashboard's refresh buttons and the runtime share one GuildDirectory (spec 9.4); a bare API
  // (tests, no runtime) refreshes through its own, which writes the same files.
  const standaloneDirectory = new GuildDirectory({ storage, logger, bots: () => readDiscordBots(storage) });
  const directoryFor = () =>
    options.directory ?? (options.runtimeControl?.getCastRuntime?.() ?? options.castRuntime)?.directory ?? standaloneDirectory;
  const refreshDirectory = async <T extends Record<string, unknown>>(
    guildId: string,
    kind: DirectoryKind,
    read: () => Promise<T>
  ) => {
    let result;
    try {
      result = await directoryFor().refresh(guildId, kind);
    } catch (error) {
      if (error instanceof DirectoryTransportError) throw badRequest(error.message);
      throw error;
    }
    return { accepted: result.accepted, guildId, message: result.message, ...(await read()) };
  };
  const app = fastify({ logger: false });
  // Model choices are validated against the curated catalog on write; the allow-list lives in
  // config.toml and changes without a restart, so it is re-read per write.
  const assertModelAllowed = async (choice: ModelChoice): Promise<void> => {
    const config = await loadAppConfig(options.dataRoot);
    assertModelChoiceValid(choice, { allowed: config.models.allowed, maxOutputUsdPerMTok: config.models.maxOutputUsdPerMTok });
  };
  // A model patch is validated only when it changes the stored model (route or effort), so a record
  // whose model is no longer offered can still be edited and resent unchanged. Returns whether the
  // write changes the model to an offered, non-null choice: only that clears the scope's model
  // warnings (a persona-only save never does; `DELETE /api/runtime/model-warnings/:scope` dismisses).
  const checkModelPatch = async (current: ModelChoice | undefined, patch: ModelChoice | null | undefined): Promise<boolean> => {
    if (!patch || sameModelChoice(current, patch)) return false;
    await assertModelAllowed(patch);
    return true;
  };
  // Spec 8.6: waifu bodies may still carry the removed `promptLayout`; it is ignored. Log it once
  // per process so a stale client is findable without flooding the log on every save.
  let promptLayoutIgnoredLogged = false;
  const noteIgnoredPromptLayout = (rawBody: unknown): void => {
    if (promptLayoutIgnoredLogged || !isPlainRecord(rawBody) || !("promptLayout" in rawBody)) return;
    promptLayoutIgnoredLogged = true;
    logger.warn("Ignoring `promptLayout` in a waifu request body: the prompt layout editor was removed.");
  };
  // Spec 9.7: server and channel bodies may still carry the removed `enabled` flag for one
  // release. It is ignored (never stored); logged once per process like `promptLayout`.
  let enabledFlagIgnoredLogged = false;
  const noteIgnoredEnabledFlag = (rawBody: unknown, scope: "server" | "channel"): void => {
    if (enabledFlagIgnoredLogged || !isPlainRecord(rawBody)) return;
    const channelsCarryIt =
      scope === "server" &&
      isPlainRecord(rawBody.channels) &&
      Object.values(rawBody.channels).some((channel) => isPlainRecord(channel) && "enabled" in channel);
    if (!("enabled" in rawBody) && !channelsCarryIt) return;
    enabledFlagIgnoredLogged = true;
    logger.warn(
      `Ignoring \`enabled\` in a ${scope} request body: the server/channel enabled flags were removed; use \`paused\` and a channel's enabledWaifuIds.`
    );
  };
  if (options.updateActivity) installUpdateActivity(app, options.updateActivity);
  const globalEvents = new EventStream<unknown>();
  const publishGlobalEvent = (event: string, data: unknown): void => {
    try {
      globalEvents.publish(event, data);
    } catch {
      // Telemetry must never break the application path that produced it. Oversized events are
      // omitted from replay; the next canonical snapshot still carries the bounded current state.
    }
  };
  const sourceUnsubscribers = [
    logger.subscribe?.((entry) => publishGlobalEvent("log", entry)),
    subscribeQueries((entry) => publishGlobalEvent("query", entry)),
    subscribeReplies((entry) => publishGlobalEvent("reply", entry)),
    onCapturedTrafficForgotten((matches) => void globalEvents.dropReplay((record) => matches(record.data)))
  ].filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined);
  app.addHook("onClose", async () => {
    for (const unsubscribe of sourceUnsubscribers) unsubscribe();
    globalEvents.close();
  });
  const runtimeMode = options.runtime.mode === "dev" || options.runtime.mode === "test"
    ? options.runtime.mode
    : "start";
  const browserSecurity = new BrowserSecurity({
    listenerHost: options.browserSecurity?.listenerHost ?? "127.0.0.1",
    port: options.browserSecurity?.port ?? options.runtime.port,
    mode: options.browserSecurity?.mode ?? runtimeMode,
    ...(options.browserSecurity?.now ? { now: options.browserSecurity.now } : {}),
    ...(options.browserSecurity?.randomBytes
      ? { randomBytes: options.browserSecurity.randomBytes }
      : {})
  });
  const routePolicies = installRoutePolicy(app, {
    manifest: ROUTE_POLICY_MANIFEST,
    browserSecurity,
    authorizeRemotePrincipal: options.remoteTrust?.isAuthorized
  });
  installMutationHandling(app, {
    operationStore,
    auditStore,
    ...(options.administration?.now ? { now: options.administration.now } : {}),
    ...(options.administration?.randomBytes
      ? { randomBytes: options.administration.randomBytes }
      : {})
  });
  app.addHook("preSerialization", async (request, _reply, payload) =>
    redactApiPayload(request.principal, payload, options.dataRoot)
  );
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    browserSecurity.refreshResponseCookie(request, reply, request.principal);
    return payload;
  });
  app.addContentTypeParser(/^image\/(png|jpeg|webp|gif)$/u, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((error, request, reply) => {
    reply.header("cache-control", "no-store");
    if (error instanceof StorageConflictError) {
      void reply.status(409).send({
        error: "Conflict",
        message: "Record has changed since it was read.",
        latest: error.latestVersion
      });
      return;
    }
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send(redactApiPayload(
        request.principal,
        apiErrorResponse(error),
        options.dataRoot
      ));
      return;
    }
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((segment) => typeof segment === "number" ? segment : String(segment)),
        message: redactSecrets(issue.message)
      }));
      void reply.status(400).send({
        error: "ValidationError",
        message: issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 400),
        issues
      });
      return;
    }
    const unknownError = error as Error;
    logger.error("Unhandled API error", redactSecrets({
      message: unknownError.message,
      stack: unknownError.stack
    }));
    void reply.status(500).send({ error: "InternalServerError" });
  });

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

  app.get("/api/status", async (request) =>
    statusResponse(options.runtime, request.principal, options.dataRoot)
  );

  const reconcileDmIntents = async () => {
    const cast = options.runtimeControl?.getCastRuntime?.() ?? options.castRuntime;
    if (!cast) return;
    try {
      const { relogged } = await cast.reconcileDmIntents();
      if (relogged.length > 0) logger.info("Re-logged waifu bots for DM intent changes", { botIds: relogged });
    } catch (error) {
      logger.warn("DM intent reconcile failed", { message: error instanceof Error ? error.message : String(error) });
    }
  };

  // Dismiss the persisted model notices of one scope (`waifu:<id>`, `assistant`). Live notices
  // (`model_unavailable`, `model_unpriced`) are computed from the current state and stay while it holds.
  app.delete("/api/runtime/model-warnings/:scope", async (request) => {
    const { scope } = z.object({ scope: z.string().min(1).max(200) }).parse(request.params);
    if (scope !== "assistant" && scope !== "models") {
      const match = /^waifu:(.+)$/u.exec(scope);
      if (!match) throw badRequest(`Unknown model warning scope: ${scope}`);
      assertSafeId(match[1]!);
    }
    return { scope, dismissed: await clearModelWarnings(options.dataRoot, scope) };
  });

  app.get("/api/runtime", async (request) => {
    const cast = options.runtimeControl?.getCastRuntime?.() ?? options.castRuntime;
    // An owner forget part given up after three tries stays a notice until the person is forgotten again.
    const forgetNotices = await forgetJobNotices(storage).catch(() => [] as string[]);
    const live = [...(cast?.permissionWarnings.list() ?? []), ...(cast?.cast?.notices.list() ?? []), ...forgetNotices];
    // Guild directory status (spec 9.6): is the member list endpoint usable, when did it last refresh.
    const directoryStatus = (options.directory ?? cast?.directory)?.status() ?? {
      memberListAvailable: null,
      lastRefreshAt: null,
      warnings: []
    };
    // DM eligibility and intent state (spec 9.6); without a live runtime nothing has DM intents.
    const dmStatus = cast
      ? await cast.dmStatus().catch(() => ({ eligibleWaifus: [], warnings: [] }))
      : await offlineDmStatus(storage);
    const runtime = {
      ...options.runtime,
      discord: {
        ...options.runtime.discord,
        warnings: [...options.runtime.discord.warnings, ...live],
        directory: directoryStatus,
        dm: dmStatus
      }
    };
    // Active quota/billing cooldowns (spec 8.10); empty when every provider is available.
    const providerAlerts = (cast?.providerAlerts ?? sharedProviderAlerts(options.dataRoot)).snapshot();
    // Model choices the owner must revisit (Living cast §9.2, §9.4).
    const models = { warnings: await modelWarnings(storage, options.dataRoot) };
    return { ...runtimeResponse(runtime, request.principal, options.dataRoot), providerAlerts, models };
  });

  registerAdminOperationRoutes(app, operationStore);
  registerRemoteAccessRoutes(app, options.remoteAccess, options.dashboardBuild);

  app.get("/api/updates", async () => automaticUpdateStatus(options.dataRoot));
  app.get("/api/config", async (request) => {
    const config = await loadAppConfig(options.dataRoot);
    return request.principal.kind === "remote_device" ? remoteAppConfig(config) : config;
  });
  app.put("/api/config", async (request) => {
    const patch = UpdateAppConfigBodySchema.parse(request.body);
    const currentConfig = await loadAppConfig(options.dataRoot);
    if (
      request.principal.kind === "remote_device"
      && (
        hasOwn(patch.http, "host")
        || hasOwn(patch.frontend, "staticDir")
        || (patch.updates !== undefined && Object.entries(patch.updates).some(([key, value]) =>
          value !== currentConfig.updates[key as keyof typeof currentConfig.updates]))
      )
    ) {
      throw new ApiError(
        403,
        "Host bind, filesystem-serving and automatic-update controls are local-only.",
        undefined,
        "RemoteConfigFieldForbidden"
      );
    }
    const saved = await storage.withLocks([APP_CONFIG_LOCK], () => updateAppConfig(options.dataRoot, patch));
    options.runtime.paused = saved.runtime.paused;
    const { updates: _beforeUpdates, ...beforeRuntimeConfig } = currentConfig;
    const { updates: _afterUpdates, ...afterRuntimeConfig } = saved;
    // Enabling idle updates must not itself abort a live conversation via runtime reload.
    const onlyUpdatesPatch = Object.keys(patch).every(key => key === "updates" || key === "schemaVersion");
    const updatesChanged = patch.updates && JSON.stringify(currentConfig.updates) !== JSON.stringify(saved.updates);
    const updaterOnlyChange = patch.updates && (onlyUpdatesPatch || (updatesChanged
      && JSON.stringify(beforeRuntimeConfig) === JSON.stringify(afterRuntimeConfig)));
    if (!updaterOnlyChange) {
      await options.runtimeControl?.reload("config-updated");
    }
    publishGlobalEvent("runtime", structuredClone(options.runtime));
    return request.principal.kind === "remote_device" ? remoteAppConfig(saved) : saved;
  });

  app.get("/api/client-context", async (request, reply) => {
    request.principal = browserSecurity.establishClientContext(request, reply);
    return ClientContextV1Schema.parse({ mode: "host" });
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

  // The addressee detector's native-choice decision models (Living cast §4.3): a separate
  // decision-only catalog, never offered as waifu models.
  app.get("/api/detector/models", async () => {
    const result = await decisionModelCatalog.list();
    const credentials = createProviderCredentialsLookup(options.dataRoot);
    return { ...result, models: result.models.map((m) => ({ ...m, configured: m.local ? Boolean(process.env.DC_WAIFUS_LAYA_PYTHON) : Boolean(credentials(m.provider)) })) };
  });

  // The curated model catalog (Living cast §9.2).
  app.get("/api/models", async () => modelsResponse(options.dataRoot));

  app.get("/api/logs", async (request) => {
    const limit = Math.min(Number((request.query as Record<string, string>).limit ?? 100) || 100, 500);
    const entries = options.logger?.recent?.() ?? [];
    // recent() is newest-first (logger unshifts) — take the head for the newest N
    return redactApiPayload(
      request.principal,
      { entries: entries.slice(0, limit) },
      options.dataRoot
    );
  });

  app.get("/api/docs", async () => ({ docs: await listDocs() }));
  app.get("/api/docs/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const doc = await readDoc(slug);
    if (!doc) return reply.code(404).send({ error: "NotFound", message: `Unknown doc: ${slug}` });
    return doc;
  });

  app.get("/api/assistant/config", async () => readAssistantConfig(storage));
  app.put("/api/assistant/config", async (request) => {
    const body = AssistantConfigBodySchema.parse(request.body);
    let pickedModel = false;
    const saved = await storage.updateRevisionedJson({
      resourceKey: "assistant",
      relativePath: "user/assistant/config.json",
      schema: AssistantConfigSchema,
      fallback: emptyAssistantConfig(),
      expectedRevision: expectedRevision(request, body),
      transform: async (current) => {
        pickedModel = await checkModelPatch(current.model, body.model);
        return pruneUndefined({ ...current, model: applyModelPatch(current.model, body.model) });
      }
    });
    if (pickedModel) await clearModelWarnings(options.dataRoot, "assistant");
    return saved;
  });

  registerAssistantRoutes(app, {
    dataRoot: options.dataRoot,
    ...(options.assistant?.modelClient ? { modelClient: options.assistant.modelClient } : {}),
    authorizePrincipal: (principal) => requestPrincipalStillAuthorized(options, browserSecurity, principal),
    ...(typeof options.remoteAccess?.subscribeInvalidations === "function"
      ? {
          subscribeInvalidations: options.remoteAccess.subscribeInvalidations.bind(
            options.remoteAccess
          )
        }
      : {})
  });
  app.get("/api/providers", async () => {
    const [credentials, config] = await Promise.all([readProviderCredentials(storage), loadAppConfig(options.dataRoot)]);
    return {
      revision: credentials.revision,
      updatedAt: credentials.updatedAt,
      catalogVersion: installedCatalog().catalogVersion,
      providers: providerStatuses(credentials, { allowed: config.models.allowed })
    };
  });

  // A saved/removed key (or topped-up account) must not stay blocked by a stale quota/billing cooldown.
  const clearProviderCooldown = (providerId: string) => {
    sharedProviderAlerts(options.dataRoot).clear(providerId);
    (options.runtimeControl?.getCastRuntime?.() ?? options.castRuntime)?.providerAlerts?.clear(providerId);
  };

  app.put("/api/providers/:providerId/credentials", async (request) => {
    const { providerId } = z.object({ providerId: ProviderIdSchema }).parse(request.params);
    assertKnownProvider(providerId);
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
    clearProviderCooldown(providerId);
    return providerCredentialsResponse(updated, providerId);
  });

  app.delete("/api/providers/:providerId/credentials", async (request) => {
    const { providerId } = z.object({ providerId: ProviderIdSchema }).parse(request.params);
    assertKnownProvider(providerId);
    const updated = await storage.updateRevisionedJson({
      resourceKey: "providers",
      relativePath: "user/providers.json",
      schema: ProviderCredentialsFileSchema,
      fallback: emptyProviderCredentials(),
      transform: (current) => {
        const { [providerId]: _removed, ...rest } = current.providers;
        return { ...current, providers: rest };
      }
    });
    clearProviderCooldown(providerId);
    return providerCredentialsResponse(updated, providerId);
  });

  app.get("/api/waifus", async () => ({ waifus: await listWaifus(storage) }));
  app.post("/api/waifus", async (request, reply) => {
    const body = CreateWaifuBodySchema.parse(request.body);
    noteIgnoredPromptLayout(request.body);
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
    if (waifu.model) await assertModelAllowed(waifu.model);
    const saved = await storage.writeJson(`waifu:${id}`, relativePath, WaifuConfigSchema, waifu);
    await reconcileDmIntents();
    return reply.status(201).send(saved);
  });

  app.get("/api/waifus/:waifuId", async (request) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    return readWaifu(storage, waifuId);
  });

  app.put("/api/waifus/:waifuId", async (request) => {
    const { waifuId } = parseIdParam(request.params, "waifuId");
    const body = UpdateWaifuBodySchema.parse(request.body);
    noteIgnoredPromptLayout(request.body);
    requireRevision(request, body);
    let pickedModel = false;
    const saved = await storage.updateRevisionedJson({
      resourceKey: `waifu:${waifuId}`,
      relativePath: waifuRelativePath(waifuId),
      schema: WaifuConfigSchema,
      fallback: await readWaifu(storage, waifuId),
      expectedRevision: expectedRevision(request, body),
      transform: async (current) => {
        pickedModel = await checkModelPatch(current.model, body.model);
        const {
          revision: _revision,
          schemaVersion: _schemaVersion,
          updatedAt: _updatedAt,
          id: _id,
          promptLayout: _ignoredPromptLayout,
          model: modelPatch,
          ...patch
        } = body;
        return pruneUndefined({
          ...current,
          ...patch,
          model: applyModelPatch(current.model, modelPatch),
          availability: mergeNestedPatch(current.availability, patch.availability),
          dm: mergeNestedPatch(current.dm, patch.dm),
          life: mergeNestedPatch(current.life, patch.life),
          id: current.id
        });
      }
    });
    if (pickedModel) await clearModelWarnings(options.dataRoot, `waifu:${waifuId}`);
    // Intents are fixed at login (spec 9.1): re-log only bots whose DM intents changed.
    await reconcileDmIntents();
    return saved;
  });

  app.post("/api/waifus/:waifuId/link-bot", async (request, reply) => {
    const { waifuId: id } = parseIdParam(request.params, "waifuId");
    const body = z.object({ applicationId: z.string().min(1).optional() }).parse(request.body ?? {});
    const waifuPath = waifuRelativePath(id);
    if (!(await exists(resolveDataPath(options.dataRoot, waifuPath)))) {
      return reply.code(404).send({ error: "NotFound", message: `Waifu ${id} is not configured.` });
    }
    const waifu = await storage.readJson(waifuPath, WaifuConfigSchema, null as never);
    // 1. ensure the discord-bots entry (id = waifuId), merging by id and preserving tokens
    const bots = await storage.updateRevisionedJson({
      resourceKey: "discord-bots",
      relativePath: "user/discord-bots.json",
      schema: DiscordBotsFileSchema,
      fallback: emptyDiscordBots(),
      transform: (current) => {
        const waifus = [...current.waifus];
        const index = waifus.findIndex((bot) => bot.id === id);
        const existing = index >= 0 ? waifus[index] : undefined;
        const entry = {
          id,
          displayName: waifu.displayName || waifu.name || id,
          enabled: true,
          ...(existing ?? {}),
          ...(body.applicationId ? { applicationId: body.applicationId } : {})
        };
        if (index >= 0) waifus[index] = entry;
        else waifus.push(entry);
        return { ...current, waifus };
      }
    });
    // 2. link the waifu to the entry
    const savedWaifu = await storage.updateRevisionedJson({
      resourceKey: `waifu:${id}`,
      relativePath: waifuPath,
      schema: WaifuConfigSchema,
      fallback: waifu,
      transform: (current) => ({ ...current, botId: id })
    });
    const entry = bots.waifus.find((bot) => bot.id === id);
    await reconcileDmIntents();
    return {
      linked: savedWaifu.botId === id,
      botId: id,
      applicationId: entry?.applicationId ?? null,
      tokenConfigured: Boolean(entry?.token),
      next: entry?.token
        ? "Token already stored — reload Discord to connect."
        : "Store the bot token (secure form or PUT /api/discord-bots), then reload Discord."
    };
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
    // Her model notices go with her.
    await clearModelWarnings(options.dataRoot, `waifu:${waifuId}`);
    await reconcileDmIntents();
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
  app.get("/api/servers/:guildId", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const servers = await listServers(storage);
    const server = servers.find((entry) => entry.guildId === guildId);
    if (!server) return reply.code(404).send({ error: "NotFound", message: `Server ${guildId} is not configured.` });
    return server;
  });
  app.put("/api/servers/:guildId", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const body = ServerConfigBodySchema.parse(request.body);
    noteIgnoredEnabledFlag(request.body, "server");
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
        const {
          revision: _revision,
          schemaVersion: _schemaVersion,
          updatedAt: _updatedAt,
          guildId: _guildId,
          enabled: _enabled,
          ...patch
        } = body;
        const { detector, ...rest } = patch;
        const next: ServerConfig = { ...current, ...rest, guildId };
        if (detector === null) delete next.detector;
        else if (detector !== undefined) next.detector = detector;
        return next;
      }
    });
  });

  app.delete("/api/servers/:guildId/channels/:channelId", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const { channelId } = parseIdParam(request.params, "channelId");
    const body = (request.body ?? {}) as { revision?: number };
    return storage.updateRevisionedJson({
      resourceKey: `server:${guildId}`,
      relativePath: serverRelativePath(guildId),
      schema: ServerConfigSchema,
      fallback: ServerConfigSchema.parse({ ...createRevisionedBase(), guildId }),
      expectedRevision: expectedRevision(request, body),
      transform: (current) => {
        const { [channelId]: _removed, ...channels } = current.channels;
        return { ...current, channels };
      }
    });
  });

  app.delete("/api/servers/:guildId", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const serverPath = userDataPath(options.dataRoot, "servers", guildId);
    // Same resource lock as every other server.json write, so a concurrent PUT cannot recreate
    // the directory halfway through the recursive removal. The runtime reads server config live
    // on every pass (no PUT/channel write reloads it either), so no runtime reload is needed.
    return storage.withLocks([`server:${guildId}`], async () => {
      if (!(await exists(serverPath))) {
        return reply.code(404).send({ error: "NotFound", message: `Server ${guildId} is not configured.` });
      }
      await rm(serverPath, { recursive: true, force: true });
      return { accepted: true, message: `Server ${guildId} configuration removed (sessions, rosters and decision history included).` };
    });
  });

  // Spec 9.5: the threads and forum posts the bot has seen under this server (guild id: snowflake).
  registerDmRoutes(app, {
    storage,
    runtime: () => options.runtimeControl?.getCastRuntime?.() ?? options.castRuntime
  });

  app.get("/api/servers/:guildId/threads", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readThreads(storage, guildId);
  });

  app.get("/api/servers/:guildId/members", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readMembers(storage, guildId);
  });
  app.post("/api/servers/:guildId/members/refresh", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const refreshed = await refreshDirectory(guildId, "members", async () => ({ members: await readMembers(storage, guildId) }));
    return reply.status(200).send(refreshed);
  });

  app.get("/api/servers/:guildId/emojis", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readEmojis(storage, guildId);
  });
  app.post("/api/servers/:guildId/emojis/refresh", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const refreshed = await refreshDirectory(guildId, "emojis", async () => ({ emojis: await readEmojis(storage, guildId) }));
    return reply.status(200).send(refreshed);
  });

  app.get("/api/servers/:guildId/roles", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    return readRoles(storage, guildId);
  });
  app.post("/api/servers/:guildId/roles/refresh", async (request, reply) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const refreshed = await refreshDirectory(guildId, "roles", async () => ({ roles: await readRoles(storage, guildId) }));
    return reply.status(200).send(refreshed);
  });

  app.put("/api/servers/:guildId/channels/:channelId", async (request) => {
    const { guildId } = parseIdParam(request.params, "guildId");
    const { channelId } = parseIdParam(request.params, "channelId");
    const body = ChannelConfigBodySchema.parse(request.body);
    noteIgnoredEnabledFlag(request.body, "channel");
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
            enabledWaifuIds: body.enabledWaifuIds ?? current.channels[channelId]?.enabledWaifuIds ?? [],
            ...((body.threads ?? current.channels[channelId]?.threads)
              ? { threads: body.threads ?? current.channels[channelId]!.threads }
              : {})
          }
        }
      })
    });
  });

  // Owner privacy affordance (Living cast §7.5, §14.1): forget one Discord user. The DM part (DM
  // history and state, rate-limit counters, cached images; floors kept) and the
  // `user/people/forgotten.json` record, then the life scrub of every waifu with a life or notes
  // (`lives`). Without a running cast runtime (Discord offline) the scrubs are queued and run when
  // each life next starts (`livesQueued`). A part of the DM/archive job that did not finish is
  // listed in `pending` (202): it runs again at the next start, up to three tries in all.
  app.post("/api/people/:userId/forget", async (request, reply) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(request.params);
    assertSnowflakeId(userId);
    const body = PeopleForgetBodySchema.parse(request.body);
    const input = { discordUserId: userId, dryRun: body.dryRun === true };
    const answer = <T extends { pending?: unknown[] }>(result: T): T => {
      if (result.pending && result.pending.length > 0) void reply.code(202);
      return result;
    };
    // The live runtime also drops cached DM messages and images (spec 9.1.4).
    const cast = options.runtimeControl?.getCastRuntime?.() ?? options.castRuntime;
    if (cast) return answer(await cast.forgetUser(input));
    if (input.dryRun) return forgetUser(storage, input, { logger });
    // The life scrubs are queued first, with the names read before the DM data goes.
    const queued = await queueOwnerScrubs(storage, userId, new Date(), { logger });
    const names = [...new Set(queued.flatMap((entry) => entry.identity.names))];
    const avoidNames = [...new Set(queued.flatMap((entry) => entry.identity.sharedNames))];
    const result = await forgetUser(storage, { ...input, names, avoidNames }, { logger }).catch((error: unknown) => {
      logger.warn("The owner's forget could not queue its DM part", { message: error instanceof Error ? error.message : String(error) });
      return unqueuedForgetResult(userId, error);
    });
    return answer({ ...result, livesQueued: queued.map((entry) => entry.waifu.id) });
  });

  // B2: pause used to live only in memory, so the next config save/reload (which re-reads
  // `runtime.paused` from config.toml) or a restart silently unpaused. Pause is the emergency
  // control, so the in-memory switch always happens first; persisting through the same writer
  // as PUT /api/config is best-effort, and a failure (unreadable/invalid/read-only config.toml)
  // returns a warning instead of failing the request.
  const persistRuntimePaused = async (paused: boolean): Promise<string | undefined> => {
    try {
      await storage.withLocks([APP_CONFIG_LOCK], () =>
        updateAppConfig(options.dataRoot, { runtime: { paused } }));
      return undefined;
    } catch (error) {
      logger.warn("Runtime pause state could not be persisted", {
        paused,
        message: error instanceof Error ? error.message : String(error)
      });
      return `Runtime ${paused ? "paused" : "resumed"}, but config.toml could not be updated; ` +
        "this will not survive a reload or restart.";
    }
  };
  const setRuntimePaused = async (request: FastifyRequest, paused: boolean) => {
    options.runtime.paused = paused;
    if (paused) await (options.runtimeControl?.pause() ?? options.castRuntime?.pause());
    else await options.runtimeControl?.resume();
    options.runtime.updatedAt = nowIso();
    const warning = await persistRuntimePaused(paused);
    publishGlobalEvent("runtime", structuredClone(options.runtime));
    const body = runtimeResponse(options.runtime, request.principal, options.dataRoot);
    return warning ? { ...body, warning } : body;
  };
  app.post("/api/runtime/pause", async (request) => setRuntimePaused(request, true));
  app.post("/api/runtime/resume", async (request) => setRuntimePaused(request, false));
  app.post("/api/runtime/reload", async () => {
    await options.runtimeControl?.reload("manual-api");
    publishGlobalEvent("runtime", structuredClone(options.runtime));
    return {
      accepted: true,
      message: "Runtime reload applied. Discord clients and runtime orchestration were rebuilt without restarting HTTP."
    };
  });
  app.get("/api/diagnostics/bundle", async (request) => diagnosticBundle(
    storage,
    runtimeResponse(options.runtime, request.principal, options.dataRoot),
    options.remoteAccess ? await options.remoteAccess.diagnostics() : undefined
  ));
  app.get("/api/events", async (request, reply) =>
    sendGlobalEventStream({
      request,
      reply,
      stream: globalEvents,
      runtime: options.runtime,
      logger,
      dataRoot: options.dataRoot,
      authorize: (principal) => requestPrincipalStillAuthorized(options, browserSecurity, principal)
    })
  );

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "NotFound", message: `${request.method} ${request.url} was not found.` });
    }
    if (request.principal.kind === "remote_device") {
      return reply.status(403).send({
        error: "RemoteRouteForbidden",
        message: "Host dashboard/static routes are not remotely proxied."
      });
    }
    if (await tryServeFrontend(request, reply, options.dataRoot)) {
      return reply;
    }
    return reply.status(404).send({ error: "NotFound", message: `${request.method} ${request.url} was not found.` });
  });

  routePolicies.registerNotFound();
  routePolicies.assertComplete();

  return app;
}

function hasOwn(value: object | undefined, key: string): boolean {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
}

async function requestPrincipalStillAuthorized(
  options: ApiServerOptions,
  browserSecurity: BrowserSecurity,
  principal: RequestPrincipal
): Promise<boolean> {
  if (principal.kind === "local") return browserSecurity.isPrincipalCurrent(principal);
  return options.remoteTrust !== undefined && await options.remoteTrust.isAuthorized(principal);
}

function redactApiPayload<T>(
  principal: RequestPrincipal | undefined,
  value: T,
  dataRoot: string
): T {
  return principal?.kind === "remote_device"
    ? redactRemoteHostDetails(value, [dataRoot])
    : redactSecrets(value);
}

function statusResponse(
  runtime: RuntimeState,
  principal: RequestPrincipal,
  dataRoot: string
) {
  const shared = {
    running: true,
    paused: runtime.paused,
    discord: runtime.discord,
    queues: runtime.queues
  };
  return redactApiPayload(
    principal,
    principal.kind === "remote_device"
      ? shared
      : {
          ...shared,
          httpUrl: `http://127.0.0.1:${runtime.port}`,
          dataRoot
        },
    dataRoot
  );
}

function runtimeResponse(
  runtime: RuntimeState,
  principal: RequestPrincipal,
  dataRoot: string
) {
  if (principal.kind === "local") return redactSecrets(runtime);
  const {
    pid: _pid,
    port: _port,
    dataRoot: _dataRoot,
    ...remoteRuntime
  } = runtime;
  return redactRemoteHostDetails(remoteRuntime, [dataRoot]);
}

function remoteAppConfig(config: AppConfig) {
  return {
    schemaVersion: config.schemaVersion,
    http: { port: config.http.port },
    runtime: config.runtime,
    frontend: {},
    ocr: config.ocr,
    compaction: config.compaction,
    discord: config.discord,
    models: config.models,
    life: config.life,
    search: config.search,
    detector: config.detector,
    updates: config.updates
  };
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
  // The House bot lives under the bots file's `orchestrator` key.
  const house =
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
    orchestrator: house,
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

async function readAssistantConfig(storage: StorageService): Promise<AssistantConfig> {
  return storage.readJson("user/assistant/config.json", AssistantConfigSchema, emptyAssistantConfig());
}

function emptyAssistantConfig(): AssistantConfig {
  return AssistantConfigSchema.parse(createEmptyRevisionedFile({}));
}

function sameModelChoice(a: ModelChoice | undefined, b: ModelChoice): boolean {
  return a !== undefined && a.providerId === b.providerId && a.modelId === b.modelId && a.effort === b.effort;
}

/** `null` unsets, a choice replaces, `undefined` keeps the stored model. */
function applyModelPatch(current: ModelChoice | undefined, patch: ModelChoice | null | undefined): ModelChoice | undefined {
  if (patch === undefined) return current;
  return patch ?? undefined;
}

/** `GET /api/models` (Living cast §9.2): curated routes with their facts and credential status. */
async function modelsResponse(dataRoot: string) {
  const config = await loadAppConfig(dataRoot);
  const lookup = createProviderCredentialsLookup(dataRoot);
  const curated = curatedCatalog({ allowed: config.models.allowed, maxOutputUsdPerMTok: config.models.maxOutputUsdPerMTok });
  return {
    catalogVersion: curated.catalogVersion,
    maxOutputUsdPerMTok: config.models.maxOutputUsdPerMTok,
    models: curated.models.map((model) => ({ ...model, credentialsConfigured: Boolean(lookup(model.providerId)) })),
    hidden: curated.hidden
  };
}

/**
 * A model warning as `/api/runtime` shows it: `label` names the scope for people (her name, not
 * `waifu:<id>`); `dismissible` marks a persisted notice `DELETE /api/runtime/model-warnings/:scope` removes.
 */
type ModelWarningView = { scope: string; label: string; code: string; detail: string; at?: string; previous?: string; dismissible: boolean };

/** Persisted model warnings plus live ones: unpriced curated routes and stored choices the catalog no longer offers. */
async function modelWarnings(storage: StorageService, dataRoot: string): Promise<ModelWarningView[]> {
  const [persisted, config, waifus, assistant] = await Promise.all([
    readModelWarnings(dataRoot),
    loadAppConfig(dataRoot),
    listWaifus(storage),
    readAssistantConfig(storage).catch(() => undefined)
  ]);
  const curated = curatedCatalog({ allowed: config.models.allowed, maxOutputUsdPerMTok: config.models.maxOutputUsdPerMTok });
  const offered = new Set(curated.models.map((model) => model.id));
  const names = new Map(waifus.map((waifu) => [`waifu:${waifu.id}`, waifu.displayName || waifu.name || waifu.id]));
  const labelOf = (scope: string): string => {
    if (scope === "assistant") return "Assistant";
    if (scope === "models") return "Models";
    return names.get(scope) ?? (scope.startsWith("waifu:") ? scope.slice("waifu:".length) : scope);
  };
  const live: ModelWarningView[] = curated.models
    .filter((model) => !model.pricing)
    .map((model) => ({ scope: "models", label: labelOf("models"), code: "model_unpriced", detail: `${model.id} has no price; its cost counts as 0 toward budgets.`, dismissible: false }));
  const unavailable = (scope: string, model: ModelChoice | undefined) => {
    if (!model) return;
    const id = `${model.providerId}/${model.modelId}`;
    if (offered.has(id)) return;
    const hidden = curated.hidden.find((entry) => entry.id === id);
    live.push({ scope, label: labelOf(scope), code: "model_unavailable", detail: `${id} is not offered${hidden ? ` (${hidden.reason})` : ""}.`, previous: id, dismissible: false });
  };
  for (const waifu of waifus) unavailable(`waifu:${waifu.id}`, waifu.model);
  unavailable("assistant", assistant?.model);
  return [...persisted.map((warning) => ({ ...warning, label: labelOf(warning.scope), dismissible: true })), ...live];
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

function parseIdParam(params: unknown, key: string): Record<string, string> {
  const parsed = z.record(z.string(), z.string().min(1)).parse(params);
  if (key === "guildId" || key === "channelId") assertSnowflakeId(parsed[key]);
  else assertSafeId(parsed[key]);
  return parsed;
}

function slugId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug && !/^\.+$/.test(slug) ? slug : randomUUID();
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

async function diagnosticBundle(
  storage: StorageService,
  runtime: unknown,
  remoteAccess?: Awaited<ReturnType<RemoteAccessService["diagnostics"]>>
) {
  const [providers, bots, assistant] = await Promise.all([
    readProviderCredentials(storage),
    readDiscordBots(storage),
    readAssistantConfig(storage).catch(() => undefined)
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
      houseConfigured: Boolean(bots.orchestrator?.token),
      houseApplicationId: bots.orchestrator?.applicationId,
      waifuBotCount: bots.waifus.length,
      configuredWaifuBotCount: bots.waifus.filter((bot) => bot.token).length
    },
    assistant: {
      model: assistant?.model ? `${assistant.model.providerId}/${assistant.model.modelId}` : null
    },
    ...(remoteAccess ? { remoteAccess } : {})
  };
}

export type ResolvedStaticDir = {
  readonly path: string;
  readonly source: "bundled" | "custom";
};

export async function resolveStaticDir(configured?: string): Promise<ResolvedStaticDir | undefined> {
  const bundledCandidates: ResolvedStaticDir[] = [
    // Default to the frontend bundled with the installed package, resolved
    // relative to this module rather than process.cwd(), so `waifus start`
    // serves the dashboard no matter which directory it was launched from.
    // (dist/api/server.js and src/api/server.ts both sit two levels under the
    // package root, where dist-frontend/ lives.)
    {
      path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-frontend"),
      source: "bundled"
    },
    // Backwards-compatible fallback for setups that relied on the working directory.
    { path: path.resolve(process.cwd(), "dist-frontend"), source: "bundled" }
  ];
  const candidates: ResolvedStaticDir[] = configured
    ? [{ path: path.resolve(configured), source: "custom" }, ...bundledCandidates]
    : bundledCandidates;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) {
      continue;
    }
    seen.add(candidate.path);
    if (await exists(candidate.path)) {
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
  const resolvedStaticDir = await resolveStaticDir(config.frontend.staticDir);
  if (!resolvedStaticDir) {
    return false;
  }
  const staticDir = resolvedStaticDir.path;
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

type GlobalStreamSnapshot = {
  version: 1;
  runtime: RuntimeState;
  logs: LogEntry[];
  queries: CapturedQuery[];
  replies: CapturedReply[];
};

function sendGlobalEventStream(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  stream: EventStream<unknown>;
  runtime: RuntimeState;
  logger: Logger;
  dataRoot: string;
  authorize: (principal: RequestPrincipal) => boolean | Promise<boolean>;
}): void {
  const { request, reply } = input;
  const writeEvent = (event: string, value: unknown, cursor?: string): void => {
    if (reply.raw.destroyed || reply.raw.writableEnded) throw new Error("SSE connection is closed.");
    reply.raw.write(serializeSseEvent({ event, data: value, ...(cursor ? { cursor } : {}) }));
  };
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  const suppliedCursor = request.headers["last-event-id"];
  const subscription = input.stream.subscribeAuthorized({
    principal: request.principal,
    ...(typeof suppliedCursor === "string" && suppliedCursor
      ? { lastEventId: suppliedCursor }
      : {}),
    authorize: input.authorize,
    project: (principal, event, data) => event === "runtime"
      ? runtimeResponse(data as RuntimeState, principal, input.dataRoot)
      : redactApiPayload(principal, data, input.dataRoot),
    snapshot: (): GlobalStreamSnapshot => ({
      version: 1,
      runtime: structuredClone(input.runtime),
      logs: input.logger.recent?.().slice().reverse() ?? [],
      queries: recentQueries(),
      replies: recentReplies()
    }),
    projectSnapshot: (principal, snapshot) => boundGlobalSnapshot({
      version: 1,
      runtime: runtimeResponse(snapshot.runtime, principal, input.dataRoot),
      logs: redactApiPayload(principal, snapshot.logs, input.dataRoot),
      queries: redactApiPayload(principal, snapshot.queries, input.dataRoot),
      replies: redactApiPayload(principal, snapshot.replies, input.dataRoot)
    }),
    onReset: (reset) => writeEvent("snapshot_required", reset),
    onSnapshot: (snapshot, cursor) => writeEvent("snapshot", snapshot, cursor),
    onEvent: (event, data, cursor) => writeEvent(event, data, cursor),
    onUnauthorized: () => endSseReply(reply),
    onClose: () => endSseReply(reply),
    onError: () => endSseReply(reply)
  });
  const heartbeat = setInterval(() => {
    void subscription.heartbeat(() => {
      writeEvent("heartbeat", { time: new Date().toISOString() });
    });
  }, EVENT_AUTHORIZATION_HEARTBEAT_MS);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    subscription.close();
  };
  request.raw.once("close", cleanup);
  reply.raw.once("error", cleanup);
  void subscription.ready;
}

function boundGlobalSnapshot(snapshot: {
  version: 1;
  runtime: unknown;
  logs: unknown[];
  queries: unknown[];
  replies: unknown[];
}) {
  const bounded = structuredClone(snapshot);
  const arrays = [bounded.logs, bounded.queries, bounded.replies];
  const targetBytes = MAX_EVENT_BYTES - 512;
  while (Buffer.byteLength(JSON.stringify(bounded), "utf8") > targetBytes) {
    let selected: unknown[] | undefined;
    let selectedBytes = -1;
    for (const entries of arrays) {
      if (entries.length === 0) continue;
      const bytes = Buffer.byteLength(JSON.stringify(entries[0]), "utf8");
      if (bytes > selectedBytes) {
        selected = entries;
        selectedBytes = bytes;
      }
    }
    if (!selected) break;
    selected.shift();
  }
  return bounded;
}

function endSseReply(reply: FastifyReply): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
}

async function offlineDmStatus(storage: StorageService) {
  try {
    const [waifus, bots] = await Promise.all([listWaifus(storage), readDiscordBots(storage)]);
    const eligibility = computeDmEligibility(waifus, bots);
    return {
      eligibleWaifus: eligibility.eligible.map((entry) => ({ ...entry, intentActive: false })),
      warnings: eligibility.warnings
    };
  } catch {
    return { eligibleWaifus: [], warnings: [] };
  }
}
