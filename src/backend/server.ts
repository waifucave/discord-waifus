import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadAppConfig } from "../config/appConfig.js";
import { appDataPath } from "../config/paths.js";
import { readPackageVersion } from "../config/layout.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { StorageService } from "../storage/storageService.js";
import {
  DiscordGatewayFacade,
  DiscordJsGateway,
  DiscordJsGatewayOptions,
  DiscordRuntimeIssue,
  DiscordRuntimeStatus
} from "../discord/client.js";
import { mergeConfiguredBotsIntoMembers } from "../discord/memberCache.js";
import { RuntimeOrchestrator } from "../orchestration/runtime.js";
import { ImageOcrService } from "../orchestration/ocr.js";
import {
  DiscordBotsFileSchema,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  GuildRoleCacheEntry,
  GuildRolesFileSchema,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { createApiServer } from "../api/server.js";
import { createLogger, Logger } from "./logger.js";
import { runMigrations } from "./migrations.js";
import { RuntimeState, createRuntimeState } from "./runtime.js";

export type StartBackendOptions = {
  dataRoot: string;
  port?: number;
  host?: string;
  mode?: "start" | "dev" | "test";
  logger?: Logger;
  createDiscordGateway?: (options: DiscordJsGatewayOptions) => DiscordGatewayFacade;
  discordRetryDelaysMs?: number[];
};

export type RunningBackend = {
  url: string;
  runtime: RuntimeState;
  close: () => Promise<void>;
};

const DEFAULT_DISCORD_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;

export async function startBackend(options: StartBackendOptions): Promise<RunningBackend> {
  await runMigrations(options.dataRoot);
  const config = await loadAppConfig(options.dataRoot);
  const packageVersion = await readPackageVersion();
  const port = options.port ?? config.http.port;
  const host = options.host ?? config.http.host;
  const logger = options.logger ?? createLogger({ dataRoot: options.dataRoot });
  const storage = new StorageService(options.dataRoot, {
    onLockWait: (resourceKey, waitMs) => logger.warn("Storage lock wait exceeded threshold", { resourceKey, waitMs })
  });
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion,
    port,
    dataRoot: options.dataRoot,
    mode: options.mode ?? "start",
    paused: config.runtime.paused,
    discord: offlineDiscordStatus(),
    queues: {
      active: 0,
      configuredGuilds: await countConfiguredGuilds(storage)
    }
  });

  const createDiscordGateway =
    options.createDiscordGateway ??
    ((gatewayOptions: DiscordJsGatewayOptions) => new DiscordJsGateway(gatewayOptions));
  const discordRetryDelaysMs = options.discordRetryDelaysMs?.length
    ? options.discordRetryDelaysMs
    : [...DEFAULT_DISCORD_RETRY_DELAYS_MS];

  let gateway: DiscordGatewayFacade | undefined;
  let runtimeOrchestrator: RuntimeOrchestrator | undefined;
  let discordRetryTimer: NodeJS.Timeout | undefined;
  let discordRetryAttempt = 0;
  let discordRecoveryInProgress = false;
  let pendingLiveDiscordErrorMessage: string | undefined;
  let closing = false;
  let enqueueReloadRuntime: (reason: string, retryOptions?: { scheduledRetry?: boolean }) => Promise<void>;

  const cleanupOcr = async (currentConfig = config) => {
    const ocr = new ImageOcrService({
      dataRoot: options.dataRoot,
      config: currentConfig.ocr,
      logger
    });
    await ocr.cleanupExpired().catch((error) => {
      logger.warn("OCR cleanup failed", { message: error instanceof Error ? error.message : String(error) });
    });
  };

  const makeRuntimeOrchestrator = (nextGateway: DiscordGatewayFacade, currentConfig = config) => {
    const ocr = new ImageOcrService({
      dataRoot: options.dataRoot,
      config: currentConfig.ocr,
      logger
    });
    return new RuntimeOrchestrator({
      storage,
      discord: nextGateway,
      logger,
      ocr,
      isPaused: () => runtime.paused,
      onActiveRunsChange: (activeRuns) => {
        runtime.queues.active = activeRuns;
        runtime.updatedAt = new Date().toISOString();
      }
    });
  };

  const clearDiscordRetry = () => {
    if (discordRetryTimer) {
      clearTimeout(discordRetryTimer);
      discordRetryTimer = undefined;
    }
  };

  const nextDiscordRetryDelayMs = (attempt: number) =>
    discordRetryDelaysMs[Math.min(attempt - 1, discordRetryDelaysMs.length - 1)] ??
    DEFAULT_DISCORD_RETRY_DELAYS_MS[0];

  const scheduleDiscordRetry = async (
    message: string,
    retryOptions: {
      preserveExistingTimer?: boolean;
      failureLabel?: string;
      logReason?: string;
    } = {}
  ) => {
    if (closing) return;
    const failureLabel = retryOptions.failureLabel ?? "Discord auto-connect failed";
    if (retryOptions.preserveExistingTimer && discordRetryTimer) {
      const lastErrorAt = new Date().toISOString();
      const attempt = Math.max(discordRetryAttempt, 1);
      const nextRetryAt = runtime.discord.nextRetryAt ??
        new Date(Date.now() + nextDiscordRetryDelayMs(attempt)).toISOString();
      runtime.discord = {
        ...withoutDiscordConnecting(runtime.discord),
        connected: false,
        orchestratorConnected: false,
        waifuBotCount: 0,
        retrying: true,
        retryAttempt: attempt,
        nextRetryAt,
        lastError: message,
        lastErrorAt,
        warnings: [
          `${failureLabel}: ${message}`,
          `Discord auto-connect will retry automatically at ${nextRetryAt}.`
        ]
      };
      runtime.updatedAt = new Date().toISOString();
      await writeRuntimeFiles(options.dataRoot, runtime);
      logger.warn("Discord auto-connect retry already pending; updated latest error", {
        attempt: runtime.discord.retryAttempt,
        nextRetryAt,
        message,
        reason: retryOptions.logReason
      });
      return;
    }
    clearDiscordRetry();
    discordRetryAttempt += 1;
    const lastErrorAt = new Date().toISOString();
    const delayMs = nextDiscordRetryDelayMs(discordRetryAttempt);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    runtime.discord = {
      ...withoutDiscordConnecting(runtime.discord),
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      retrying: true,
      retryAttempt: discordRetryAttempt,
      nextRetryAt,
      lastError: message,
      lastErrorAt,
      warnings: [
        `${failureLabel}: ${message}`,
        `Discord auto-connect will retry automatically at ${nextRetryAt}.`
      ]
    };
    runtime.updatedAt = new Date().toISOString();
    await writeRuntimeFiles(options.dataRoot, runtime);
    logger.warn("Discord auto-connect retry scheduled", {
      attempt: discordRetryAttempt,
      nextRetryAt,
      delayMs,
      message,
      reason: retryOptions.logReason
    });
    discordRetryTimer = setTimeout(() => {
      discordRetryTimer = undefined;
      void enqueueReloadRuntime("discord-auto-retry", { scheduledRetry: true }).catch((error) => {
        const retryMessage = error instanceof Error ? error.message : String(error);
        logger.error("Discord auto-connect retry failed outside gateway connection", { message: retryMessage });
      });
    }, delayMs);
  };

  const handleDiscordRuntimeIssue = async (issue: DiscordRuntimeIssue) => {
    if (closing) return;
    const message = issue.message || "Discord runtime issue.";
    if (!isRetryableDiscordRuntimeIssue(issue)) {
      logger.warn("Discord runtime issue did not trigger reconnect", discordRuntimeIssueLogContext(issue));
      return;
    }

    pendingLiveDiscordErrorMessage = message;
    if (discordRetryTimer) {
      await scheduleDiscordRetry(message, {
        preserveExistingTimer: true,
        failureLabel: "Discord connection lost",
        logReason: issue.source
      });
      return;
    }
    if (discordRecoveryInProgress) {
      return;
    }

    discordRecoveryInProgress = true;
    try {
      logger.warn("Discord runtime issue triggered reconnect", discordRuntimeIssueLogContext(issue));
      await runtimeOrchestrator?.stop();
      await gateway?.disconnect();
      runtimeOrchestrator = undefined;
      gateway = undefined;
      runtime.queues.active = 0;
      await scheduleDiscordRetry(pendingLiveDiscordErrorMessage ?? message, {
        preserveExistingTimer: true,
        failureLabel: "Discord connection lost",
        logReason: issue.source
      });
    } finally {
      discordRecoveryInProgress = false;
      pendingLiveDiscordErrorMessage = undefined;
    }
  };

  const reloadRuntime = async (reason: string, retryOptions: { scheduledRetry?: boolean } = {}) => {
    if (closing) return;
    if (!retryOptions.scheduledRetry) {
      clearDiscordRetry();
      discordRetryAttempt = 0;
    }
    logger.info("Reloading runtime", { reason });
    await runtimeOrchestrator?.stop();
    await gateway?.disconnect();
    runtimeOrchestrator = undefined;
    gateway = undefined;
    runtime.queues.active = 0;

    const currentConfig = await loadAppConfig(options.dataRoot);
    await cleanupOcr(currentConfig);
    if (closing) return;
    runtime.paused = currentConfig.runtime.paused;
    runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
    if (currentConfig.runtime.autoConnectDiscord) {
      runtime.discord = connectingDiscordStatus();
      runtime.updatedAt = new Date().toISOString();
      await writeRuntimeFiles(options.dataRoot, runtime);
    }
    const connected = await maybeConnectDiscord(
      storage,
      currentConfig.runtime.autoConnectDiscord,
      logger,
      createDiscordGateway,
      handleDiscordRuntimeIssue
    );
    if (closing) {
      await connected.gateway?.disconnect();
      return;
    }
    runtime.discord = connected.status;
    gateway = connected.gateway;
    if (gateway) {
      clearDiscordRetry();
      discordRetryAttempt = 0;
      runtimeOrchestrator = makeRuntimeOrchestrator(gateway, currentConfig);
      await runtimeOrchestrator.start();
    } else if (connected.retryableFailure) {
      await scheduleDiscordRetry(connected.retryableFailure.message);
    }
    if (closing) {
      await runtimeOrchestrator?.stop();
      await gateway?.disconnect();
      runtimeOrchestrator = undefined;
      gateway = undefined;
      return;
    }
    runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
    runtime.updatedAt = new Date().toISOString();
    await writeRuntimeFiles(options.dataRoot, runtime);
  };

  let reloadQueue: Promise<void> = Promise.resolve();
  enqueueReloadRuntime = (reason: string, retryOptions: { scheduledRetry?: boolean } = {}) => {
    const run = () => reloadRuntime(reason, retryOptions);
    const next = reloadQueue.then(run, run);
    reloadQueue = next.catch(() => undefined);
    return next;
  };

  runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
  const app = await createApiServer({
    dataRoot: options.dataRoot,
    storage,
    runtime,
    runtimeControl: {
      getOrchestrator: () => runtimeOrchestrator,
      pause: async () => {
        runtime.paused = true;
        await runtimeOrchestrator?.pause();
        runtime.updatedAt = new Date().toISOString();
        await writeRuntimeFiles(options.dataRoot, runtime);
      },
      resume: async () => {
        runtime.paused = false;
        runtime.updatedAt = new Date().toISOString();
        await writeRuntimeFiles(options.dataRoot, runtime);
      },
      reload: enqueueReloadRuntime
    },
    logger,
    browserSecurity: {
      listenerHost: host,
      port,
      mode: options.mode ?? "start"
    }
  });

  await app.listen({ host, port });
  await writeRuntimeFiles(options.dataRoot, runtime);
  logger.info("Backend started", { url: `http://${host}:${port}`, dataRoot: options.dataRoot });
  void enqueueReloadRuntime("startup").catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Startup runtime reload failed", { message });
  });

  return {
    url: `http://${host}:${port}`,
    runtime,
    close: async () => {
      closing = true;
      clearDiscordRetry();
      const shutdownStartedAt = Date.now();
      logger.info("Shutdown step start", { step: "orchestrator.stop" });
      let stepStartedAt = Date.now();
      await runtimeOrchestrator?.stop();
      logger.info("Shutdown step done", { step: "orchestrator.stop", ms: Date.now() - stepStartedAt });

      logger.info("Shutdown step start", { step: "discord.disconnect" });
      stepStartedAt = Date.now();
      await gateway?.disconnect();
      logger.info("Shutdown step done", { step: "discord.disconnect", ms: Date.now() - stepStartedAt });

      logger.info("Shutdown step start", { step: "fastify.close" });
      stepStartedAt = Date.now();
      await app.close();
      logger.info("Shutdown step done", { step: "fastify.close", ms: Date.now() - stepStartedAt });

      await rm(appDataPath(options.dataRoot, "pid.json"), { force: true });
      runtime.updatedAt = new Date().toISOString();
      await atomicWriteJson(appDataPath(options.dataRoot, "runtime.json"), runtime);
      logger.info("Backend stopped", { dataRoot: options.dataRoot, totalMs: Date.now() - shutdownStartedAt });
    }
  };
}

function offlineDiscordStatus(warnings: string[] = []): DiscordRuntimeStatus {
  return {
    connected: false,
    orchestratorConnected: false,
    waifuBotCount: 0,
    warnings
  };
}

function connectingDiscordStatus(): DiscordRuntimeStatus {
  return {
    connected: false,
    orchestratorConnected: false,
    waifuBotCount: 0,
    warnings: [],
    connecting: true
  };
}

function withoutDiscordConnecting(status: DiscordRuntimeStatus): DiscordRuntimeStatus {
  const next = { ...status };
  delete next.connecting;
  return next;
}

async function maybeConnectDiscord(
  storage: StorageService,
  autoConnect: boolean,
  logger: Logger,
  createDiscordGateway: (options: DiscordJsGatewayOptions) => DiscordGatewayFacade,
  onRuntimeIssue?: (issue: DiscordRuntimeIssue) => void | Promise<void>
): Promise<{
  status: DiscordRuntimeStatus;
  gateway?: DiscordGatewayFacade;
  retryableFailure?: { message: string };
}> {
  const offline = offlineDiscordStatus(
    autoConnect ? ["Discord auto-connect is enabled but no orchestrator token is configured."] : []
  );
  if (!autoConnect) {
    return { status: offline };
  }
  const bots = await storage.readJson(
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
  );
  if (!bots.orchestrator?.token) {
    return { status: offline };
  }
  const gateway = createDiscordGateway({
    orchestrator: bots.orchestrator,
    waifus: bots.waifus,
    logger,
    cacheForGuild: async (guildId) => {
      const [members, emojis, roles] = await Promise.all([
        storage.readJson(
          `user/servers/${guildId}/members.json`,
          GuildMembersFileSchema,
          GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
        ),
        storage.readJson(
          `user/servers/${guildId}/emojis.json`,
          GuildEmojisFileSchema,
          GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
        ),
        storage.readJson(
          `user/servers/${guildId}/roles.json`,
          GuildRolesFileSchema,
          GuildRolesFileSchema.parse(createEmptyRevisionedFile({ guildId, roles: [] }))
        )
      ]);
      return {
        members: mergeConfiguredBotsIntoMembers(members.members, bots),
        emojis: emojis.emojis,
        roles: roles.roles
      };
    },
    refreshMembersForGuild: async (guildId) => {
      const members = await refreshDiscordMembersForRuntime(storage, guildId);
      return {
        members: mergeConfiguredBotsIntoMembers(members.members, bots)
      };
    },
    refreshRolesForGuild: async (guildId) => {
      const roles = await refreshDiscordRolesForRuntime(storage, guildId);
      return {
        roles: roles.roles
      };
    },
    onRuntimeIssue
  });
  try {
    const status = await gateway.connect();
    return { status, gateway };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableDiscordAutoConnectError(error);
    logger.error("Discord auto-connect failed", { message });
    await gateway.disconnect();
    return {
      status: {
        connected: false,
        orchestratorConnected: false,
        waifuBotCount: 0,
        warnings: [`Discord auto-connect failed: ${message}`]
      },
      retryableFailure: retryable ? { message } : undefined
    };
  }
}

const RETRYABLE_DISCORD_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

const RETRYABLE_DISCORD_MESSAGE_PATTERNS = [
  /\bgetaddrinfo\b/i,
  /\bdns\b/i,
  /\bnetwork\b/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bsocket\b/i,
  /\bfetch failed\b/i,
  /\bconnection reset\b/i,
  /\bconnection refused\b/i,
  /\bunreachable\b/i
];

const RETRYABLE_DISCORD_CLOSE_CODES = new Set([1001, 1006, 1011, 1012, 1013, 4000]);

function isRetryableDiscordAutoConnectError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && RETRYABLE_DISCORD_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_DISCORD_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isRetryableDiscordRuntimeIssue(issue: DiscordRuntimeIssue): boolean {
  if (isRetryableDiscordAutoConnectError(issue.error ?? issue) || isRetryableDiscordAutoConnectError(issue)) {
    return true;
  }
  if (issue.source === "invalidated") {
    return true;
  }
  if (issue.source === "shard-disconnect" && issue.wasClean === false && typeof issue.code === "number") {
    return RETRYABLE_DISCORD_CLOSE_CODES.has(issue.code);
  }
  return false;
}

function discordRuntimeIssueLogContext(issue: DiscordRuntimeIssue): Record<string, unknown> {
  return {
    source: issue.source,
    botId: issue.botId,
    shardId: issue.shardId,
    code: issue.code,
    wasClean: issue.wasClean,
    message: issue.message
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const nestedError = errorCode((error as { error?: unknown }).error);
  if (nestedError) return nestedError;
  return errorCode((error as { cause?: unknown }).cause);
}

async function refreshDiscordMembersForRuntime(storage: StorageService, guildId: string) {
  const token = await readDiscordBotToken(storage);
  if (!token) {
    return storage.readJson(
      `user/servers/${guildId}/members.json`,
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    );
  }
  const rawMembers = await fetchAllDiscordGuildMembers(token, guildId);
  const now = new Date().toISOString();
  const members = rawMembers.map((member) => ({
    userId: member.user.id,
    username: member.user.username,
    globalDisplayName: member.user.global_name ?? undefined,
    guildDisplayName: member.nick ?? member.user.global_name ?? member.user.username,
    bot: member.user.bot ?? false,
    lastSeenAt: now,
    perChannelLastSeenAt: {}
  }));
  return storage.updateRevisionedJson({
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
}

async function fetchAllDiscordGuildMembers(token: string, guildId: string) {
  const members: Array<{
    nick?: string | null;
    user: {
      id: string;
      username?: string;
      global_name?: string | null;
      bot?: boolean;
    };
  }> = [];
  let after = "0";
  for (;;) {
    const response = await discordApiFetch(token, `/guilds/${guildId}/members?limit=1000&after=${encodeURIComponent(after)}`);
    const page = response as typeof members;
    members.push(...page);
    if (page.length < 1000) {
      return members;
    }
    after = page[page.length - 1]?.user.id ?? after;
  }
}

async function refreshDiscordRolesForRuntime(storage: StorageService, guildId: string) {
  const token = await readDiscordBotToken(storage);
  if (!token) {
    return storage.readJson(
      `user/servers/${guildId}/roles.json`,
      GuildRolesFileSchema,
      GuildRolesFileSchema.parse(createEmptyRevisionedFile({ guildId, roles: [] }))
    );
  }
  const rawRoles = await fetchAllDiscordGuildRoles(token, guildId);
  const roles = mapDiscordRoles(rawRoles);
  return storage.updateRevisionedJson({
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
}

async function fetchAllDiscordGuildRoles(token: string, guildId: string) {
  const response = await discordApiFetch(token, `/guilds/${guildId}/roles`);
  return response as Array<{
    id: string;
    name: string;
    color?: number;
    hoist?: boolean;
    mentionable?: boolean;
    managed?: boolean;
  }>;
}

function mapDiscordRoles(rawRoles: Awaited<ReturnType<typeof fetchAllDiscordGuildRoles>>): GuildRoleCacheEntry[] {
  const now = new Date().toISOString();
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
  const bots = await storage.readJson(
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
  );
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
    const message = typeof parsed === "object" && parsed && "message" in parsed
      ? String((parsed as { message?: unknown }).message)
      : response.statusText;
    throw new Error(`Discord API request failed (${response.status}): ${message}`);
  }
  return parsed;
}

async function countConfiguredGuilds(storage: StorageService): Promise<number> {
  try {
    const entries = await readdir(path.join(storage.dataRoot, "user", "servers"));
    return entries.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function writeRuntimeFiles(dataRoot: string, runtime: RuntimeState): Promise<void> {
  await Promise.all([
    atomicWriteJson(appDataPath(dataRoot, "pid.json"), runtime),
    atomicWriteJson(appDataPath(dataRoot, "runtime.json"), runtime)
  ]);
}
