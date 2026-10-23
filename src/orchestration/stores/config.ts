// Read/ensure helpers for user-owned config files the runtime consults: servers, channels,
// waifus, agent configs and the Discord bots file.

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  AgentConfig,
  AgentConfigSchema,
  DiscordBotsFile,
  DiscordBotsFileSchema,
  ServerConfig,
  ServerConfigSchema,
  WaifuConfig,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../../shared/schemas/domain.js";
import { createRevisionedBase } from "../../shared/schemas/common.js";
import { StorageService } from "../../storage/storageService.js";
import type { RuntimeServices } from "../runtimeShared.js";

export async function readAgentConfig(storage: StorageService, agent: "orchestrator" | "stage-manager" | "reviewer", defaultWindow: number): Promise<AgentConfig> {
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

export async function readWaifu(storage: StorageService, waifuId: string): Promise<WaifuConfig> {
  return storage.readJson(path.join("user", "waifus", waifuId, "waifu.json"), WaifuConfigSchema);
}

export async function listWaifus(storage: StorageService): Promise<WaifuConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(storage.dataRoot, "user", "waifus"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const waifus = await Promise.all(
    entries.map((entry) => readWaifu(storage, entry).catch(() => undefined))
  );
  return waifus.filter((waifu): waifu is WaifuConfig => Boolean(waifu));
}

export async function listAvailableWaifusForChannel(storage: StorageService, channel: ServerConfig["channels"][string]): Promise<WaifuConfig[]> {
  const waifus = await listWaifus(storage);
  const waifusById = new Map(
    waifus
      .filter((waifu) => waifu.enabled && waifu.modelId && waifu.botId)
      .map((waifu) => [waifu.id, waifu])
  );
  return (channel.enabledWaifuIds ?? [])
    .map((waifuId) => waifusById.get(waifuId))
    .filter((waifu): waifu is WaifuConfig => Boolean(waifu));
}

export async function listAvailableWaifusForGuild(storage: StorageService, server: ServerConfig): Promise<WaifuConfig[]> {
  const enabledWaifuIds = new Set<string>();
  for (const channel of Object.values(server.channels)) {
    for (const waifuId of channel.enabledWaifuIds ?? []) {
      enabledWaifuIds.add(waifuId);
    }
  }
  if (enabledWaifuIds.size === 0) {
    return [];
  }
  const waifus = await listWaifus(storage);
  const waifusById = new Map(waifus.map((waifu) => [waifu.id, waifu]));
  return [...enabledWaifuIds]
    .map((waifuId) => waifusById.get(waifuId))
    .filter((waifu): waifu is WaifuConfig => Boolean(waifu));
}

export async function ensureServer(storage: StorageService, guildId: string): Promise<ServerConfig> {
  return storage.updateRevisionedJson({
    resourceKey: `server:${guildId}`,
    relativePath: path.join("user", "servers", guildId, "server.json"),
    schema: ServerConfigSchema,
    fallback: ServerConfigSchema.parse({ ...createRevisionedBase(), guildId, enabled: true }),
    transform: (current) => current
  });
}

export async function ensureChannelConfig(services: RuntimeServices, server: ServerConfig, channelId: string): Promise<ServerConfig> {
  if (server.channels[channelId]) {
    return server;
  }
  let metadata:
    | {
        guildName?: string;
        channelName?: string;
      }
    | undefined;
  try {
    metadata = await services.discord.fetchChannelMetadata?.({
      guildId: server.guildId,
      channelId
    });
  } catch (error) {
    services.logger.warn("Failed to fetch Discord names for newly detected channel", {
      guildId: server.guildId,
      channelId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return services.storage.updateRevisionedJson({
    resourceKey: `server:${server.guildId}`,
    relativePath: path.join("user", "servers", server.guildId, "server.json"),
    schema: ServerConfigSchema,
    fallback: server,
    transform: (current) => {
      const currentChannel = current.channels[channelId];
      return {
        ...current,
        name: metadata?.guildName ?? current.name,
        channels: {
          ...current.channels,
          [channelId]: currentChannel
            ? {
                ...currentChannel,
                name: currentChannel.name ?? metadata?.channelName
              }
            : {
                channelId,
                name: metadata?.channelName,
                enabled: false,
                enabledWaifuIds: []
              }
        }
      };
    }
  });
}

export function channelHasWaifus(
  channel: ServerConfig["channels"][string] | undefined
): channel is ServerConfig["channels"][string] {
  return Boolean(channel && (channel.enabledWaifuIds?.length ?? 0) > 0);
}

export async function readDiscordBotsFile(storage: StorageService): Promise<DiscordBotsFile> {
  return storage.readJson(
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
  );
}

export async function isKnownWaifuAuthor(storage: StorageService, authorId: string): Promise<boolean> {
  const bots = await readDiscordBotsFile(storage);
  return bots.waifus.some((bot) => bot.id === authorId || bot.applicationId === authorId);
}

export async function listKnownGuildIds(storage: StorageService): Promise<string[]> {
  try {
    const entries = await readdir(path.join(storage.dataRoot, "user", "servers"), {
      withFileTypes: true
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function syncGuilds(services: RuntimeServices): Promise<void> {
  const guilds = await services.discord.listGuilds?.();
  for (const guild of guilds ?? []) {
    const relativePath = path.join("user", "servers", guild.guildId, "server.json");
    const fallback = ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId: guild.guildId,
      name: guild.name,
      enabled: true
    });
    const existing = await services.storage.readJson(relativePath, ServerConfigSchema, fallback);
    const channelNames = new Map<string, string>();
    if (services.discord.fetchChannelMetadata) {
      for (const channelId of Object.keys(existing.channels)) {
        try {
          const metadata = await services.discord.fetchChannelMetadata({
            guildId: guild.guildId,
            channelId
          });
          if (metadata.channelName) {
            channelNames.set(channelId, metadata.channelName);
          }
        } catch (error) {
          services.logger.warn("Failed to refresh Discord channel name during startup", {
            guildId: guild.guildId,
            channelId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    await services.storage.updateRevisionedJson({
      resourceKey: `server:${guild.guildId}`,
      relativePath,
      schema: ServerConfigSchema,
      fallback,
      transform: (current) => {
        const channels = Object.fromEntries(
          Object.entries(current.channels).map(([channelId, channel]) => [
            channelId,
            {
              ...channel,
              name: channelNames.get(channelId) ?? channel.name
            }
          ])
        );
        return {
          ...current,
          name: guild.name,
          channels
        };
      }
    });
  }
}
