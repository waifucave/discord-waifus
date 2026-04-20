import type { Express } from "express";
import { z } from "zod";
import type { BotManager } from "../bot-manager.js";
import type { ConfigManager } from "../config-manager.js";
import { channelSchema } from "../types/index.js";
import { asyncRoute } from "./helpers.js";

const createChannelSchema = channelSchema;
const updateChannelSchema = z.object({
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  channelName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  activeWaifuIds: z.array(z.string()).optional(),
  contextAnchorMessageId: z.string().nullable().optional(),
  contextMessageCount: z.number().int().min(1).max(100).optional(),
  idleChatterEnabled: z.boolean().optional(),
  idleTimerMinSeconds: z.number().int().min(100).max(7200).optional(),
  idleTimerMaxSeconds: z.number().int().min(100).max(7200).optional()
});

export function setupChannelRoutes(
  app: Express,
  deps: { config: ConfigManager; botManager: BotManager }
): void {
  app.get(
    "/api/channels",
    asyncRoute(async (_request, response) => {
      const channels = await Promise.all(
        deps.config.channels.map(async (channel) => {
          const [availableEmojis, guildMembers] = await Promise.all([
            deps.botManager.getAvailableGuildEmojis(channel.guildId),
            deps.botManager.fetchGuildMembers(channel.guildId)
          ]);

          return {
            ...channel,
            availableEmojis,
            availableGuildMembers: guildMembers.map((member) => ({
              id: member.id,
              displayName: member.displayName,
              username: member.user.username,
              globalName: member.user.globalName ?? null,
              bot: member.user.bot
            }))
          };
        })
      );
      response.json({ channels });
    })
  );

  app.post(
    "/api/channels",
    asyncRoute(async (request, response) => {
      const channel = createChannelSchema.parse(request.body);
      if (deps.config.channels.some((entry) => entry.channelId === channel.channelId)) {
        response.status(409).json({ error: "Channel already exists" });
        return;
      }

      await deps.config.saveChannels([...deps.config.channels, channel]);
      response.status(201).json(channel);
    })
  );

  app.put(
    "/api/channels/:id",
    asyncRoute(async (request, response) => {
      const patch = updateChannelSchema.parse(request.body);
      const channelId = String(request.params.id);
      const existing = deps.config.channels.find((entry) => entry.channelId === channelId);
      if (!existing) {
        response.status(404).json({ error: "Channel not found" });
        return;
      }

      const updated = createChannelSchema.parse({
        ...existing,
        ...patch
      });

      await deps.config.saveChannels(
        deps.config.channels.map((entry) =>
          entry.channelId === channelId ? updated : entry
        )
      );
      response.json(updated);
    })
  );

  app.delete(
    "/api/channels/:id",
    asyncRoute(async (request, response) => {
      await deps.config.saveChannels(
        deps.config.channels.filter((entry) => entry.channelId !== String(request.params.id))
      );
      response.status(204).end();
    })
  );
}
