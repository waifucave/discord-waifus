import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadAppConfig } from "../config/appConfig.js";
import { appDataPath } from "../config/paths.js";
import { readPackageVersion } from "../config/layout.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { StorageService } from "../storage/storageService.js";
import { DiscordJsGateway, DiscordRuntimeStatus } from "../discord/client.js";
import { mergeConfiguredBotsIntoMembers } from "../discord/memberCache.js";
import { RuntimeOrchestrator } from "../orchestration/runtime.js";
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
};

export type RunningBackend = {
  url: string;
  runtime: RuntimeState;
  close: () => Promise<void>;
};

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

  let gateway: DiscordJsGateway | undefined;
  let runtimeOrchestrator: RuntimeOrchestrator | undefined;

  const makeRuntimeOrchestrator = (nextGateway: DiscordJsGateway) =>
    new RuntimeOrchestrator({
      storage,
      discord: nextGateway,
      logger,
      isPaused: () => runtime.paused,
      onActiveRunsChange: (activeRuns) => {
        runtime.queues.active = activeRuns;
        runtime.updatedAt = new Date().toISOString();
      }
    });

  const reloadRuntime = async (reason: string) => {
    logger.info("Reloading runtime", { reason });
    await runtimeOrchestrator?.stop();
    await gateway?.disconnect();
    runtimeOrchestrator = undefined;
    gateway = undefined;
    runtime.queues.active = 0;

    const currentConfig = await loadAppConfig(options.dataRoot);
    runtime.paused = currentConfig.runtime.paused;
    const connected = await maybeConnectDiscord(storage, currentConfig.runtime.autoConnectDiscord, logger);
    runtime.discord = connected.status;
    gateway = connected.gateway;
    if (gateway) {
      runtimeOrchestrator = makeRuntimeOrchestrator(gateway);
      await runtimeOrchestrator.start();
    }
    runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
    runtime.updatedAt = new Date().toISOString();
    await writeRuntimeFiles(options.dataRoot, runtime);
  };

  await reloadRuntime("startup");
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
      reload: reloadRuntime
    },
    logger
  });

  await app.listen({ host, port });
  await writeRuntimeFiles(options.dataRoot, runtime);
  logger.info("Backend started", { url: `http://${host}:${port}`, dataRoot: options.dataRoot });

  return {
    url: `http://${host}:${port}`,
    runtime,
    close: async () => {
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

async function maybeConnectDiscord(
  storage: StorageService,
  autoConnect: boolean,
  logger: Logger
): Promise<{ status: DiscordRuntimeStatus; gateway?: DiscordJsGateway }> {
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
  const gateway = new DiscordJsGateway({
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
    }
  });
  try {
    const status = await gateway.connect();
    return { status, gateway };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Discord auto-connect failed", { message });
    await gateway.disconnect();
    return {
      status: {
        connected: false,
        orchestratorConnected: false,
        waifuBotCount: 0,
        warnings: [`Discord auto-connect failed: ${message}`]
      }
    };
  }
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
