import type { Express } from "express";
import { z } from "zod";
import type { ConfigManager } from "../config-manager.js";
import type { StageManager } from "../stage-manager.js";
import { stageManagerConfigSchema } from "../types/index.js";
import { asyncRoute } from "./helpers.js";

const updateStageManagerSchema = z.object({
  enabled: z.boolean().optional(),
  providerId: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  quietPeriodSeconds: z.number().int().min(10).optional(),
  historyLimit: z.number().int().min(10).max(100).optional(),
  maxRelationshipsPerWaifu: z.number().int().min(1).max(50).optional(),
  maxMemoriesPerWaifu: z.number().int().min(1).max(20).optional()
});

const manualRunSchema = z.object({
  guildId: z.string().min(1)
});

export function setupStageManagerRoutes(
  app: Express,
  deps: {
    config: ConfigManager;
    stageManager: StageManager;
  }
): void {
  app.get("/api/stage-manager", (_request, response) => {
    response.json({
      stageManager: deps.config.stageManager
    });
  });

  app.put(
    "/api/stage-manager",
    asyncRoute(async (request, response) => {
      const patch = updateStageManagerSchema.parse(request.body);
      const nextConfig = stageManagerConfigSchema.parse({
        ...deps.config.stageManager,
        ...patch
      });

      await deps.config.saveStageManager(nextConfig);
      response.json({
        stageManager: nextConfig
      });
    })
  );

  app.get(
    "/api/stage-manager/state",
    asyncRoute(async (_request, response) => {
      response.json(await buildStageManagerStateResponse(deps.config, deps.stageManager));
    })
  );

  app.post(
    "/api/stage-manager/run",
    asyncRoute(async (request, response) => {
      const { guildId } = manualRunSchema.parse(request.body);
      const channel = deps.config.channels.find(
        (entry) =>
          entry.guildId === guildId &&
          entry.enabled &&
          entry.activeWaifuIds.length > 0
      );
      if (!channel) {
        response.status(404).json({ error: "No eligible channel found for this guild" });
        return;
      }

      const result = await deps.stageManager.runNow(channel.channelId);
      response.json({
        guildId,
        channelId: channel.channelId,
        result
      });
    })
  );
}

async function buildStageManagerStateResponse(config: ConfigManager, stageManager: StageManager) {
  const runtime = stageManager.getRuntimeState();
  const rawState = stageManager.getStateSnapshot() as Record<string, unknown>;
  const waifuDocuments = (await config.runtimeStore.listWaifuDocuments()).documents;
  const waifuNames = new Map(waifuDocuments.map((entry) => [entry.id, entry.displayName || entry.name] as const));
  const channelsByGuild = new Map<string, typeof config.channels>();

  for (const channel of config.channels) {
    const existing = channelsByGuild.get(channel.guildId) ?? [];
    existing.push(channel);
    channelsByGuild.set(channel.guildId, existing);
  }

  const checkpoints = asRecord(rawState.guilds);
  const waifusById = asRecord(rawState.waifus);
  const guildIds = new Set<string>([
    ...channelsByGuild.keys(),
    ...Object.keys(checkpoints),
    ...Object.values(waifusById).flatMap((guilds) => Object.keys(asRecord(guilds)))
  ]);

  return {
    state: {
      guilds: [...guildIds].sort().map((guildId) => ({
          guildId,
          checkpoint: normalizeCheckpoint(checkpoints[guildId]),
          channels: (channelsByGuild.get(guildId) ?? []).map((channel) => ({
            channelId: channel.channelId,
            channelName: channel.channelName,
            enabled: channel.enabled,
            activeWaifuIds: channel.activeWaifuIds
          })),
          waifus: Object.entries(waifusById)
            .filter(([, guilds]) => guildId in asRecord(guilds))
            .map(([waifuId, guilds]) => {
              const guildState = asRecord(asRecord(guilds)[guildId]);
              return {
              waifuId,
                displayName: waifuNames.get(waifuId) ?? waifuId,
                relationships: Object.entries(asRecord(guildState.relationshipsByParticipant))
                  .sort((left, right) => left[0].localeCompare(right[0]))
                  .map(([participantKey, entry]) => ({
                    participantKey,
                    ...asRecord(entry)
                  })),
                memories: asArray(guildState.memories).sort(
                  (left, right) =>
                    Number(asRecord(left).slot ?? 0) - Number(asRecord(right).slot ?? 0)
                )
              };
            })
            .sort((left, right) => left.displayName.localeCompare(right.displayName))
        }))
    },
    runtime: groupRuntimeByGuild(runtime, config.channels)
  };
}

function groupRuntimeByGuild(
  runtime: {
    scheduledChannels: Array<{ channelId: string; runAt: string; reason: string }>;
    runningChannels: string[];
    dirtyChannels: string[];
  },
  channels: Array<{ channelId: string; guildId: string }>
) {
  const guildByChannelId = new Map(channels.map((channel) => [channel.channelId, channel.guildId] as const));
  const scheduledGuildMap = new Map<
    string,
    { guildId: string; runAt: string; reason: string; channelIds: string[] }
  >();

  for (const entry of runtime.scheduledChannels) {
    const guildId = guildByChannelId.get(entry.channelId);
    if (!guildId) {
      continue;
    }
    const existing = scheduledGuildMap.get(guildId);
    if (existing) {
      existing.channelIds.push(entry.channelId);
      if (entry.runAt < existing.runAt) {
        existing.runAt = entry.runAt;
        existing.reason = entry.reason;
      }
      continue;
    }
    scheduledGuildMap.set(guildId, {
      guildId,
      runAt: entry.runAt,
      reason: entry.reason,
      channelIds: [entry.channelId]
    });
  }

  return {
    scheduledGuilds: [...scheduledGuildMap.values()].sort((left, right) =>
      left.guildId.localeCompare(right.guildId)
    ),
    runningGuilds: [
      ...new Set(
        runtime.runningChannels
          .map((channelId) => guildByChannelId.get(channelId))
          .filter((guildId): guildId is string => Boolean(guildId))
      )
    ],
    dirtyGuilds: [
      ...new Set(
        runtime.dirtyChannels
          .map((channelId) => guildByChannelId.get(channelId))
          .filter((guildId): guildId is string => Boolean(guildId))
      )
    ]
  };
}

function normalizeCheckpoint(value: unknown) {
  const record = asRecord(value);
  return {
    lastProcessedMessageId:
      typeof record.lastProcessedMessageId === "string" ? record.lastProcessedMessageId : null,
    lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : null
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
