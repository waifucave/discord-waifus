import { z } from "zod";

export const channelSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string().min(1),
  enabled: z.boolean().default(true),
  activeWaifuIds: z.array(z.string()).default([]),
  contextAnchorMessageId: z.string().nullable().default(null),
  contextMessageCount: z.number().int().min(1).max(100).default(80),
  idleChatterEnabled: z.boolean().default(true),
  idleTimerMinSeconds: z.number().int().min(100).max(7200).default(100),
  idleTimerMaxSeconds: z.number().int().min(100).max(7200).default(300)
}).refine(
  (value) => value.idleTimerMaxSeconds >= value.idleTimerMinSeconds,
  "idleTimerMaxSeconds must be greater than or equal to idleTimerMinSeconds"
);

export const channelsFileSchema = z.object({
  channels: z.array(channelSchema).default([])
});

export type ChannelConfig = z.infer<typeof channelSchema>;
export type ChannelsFile = z.infer<typeof channelsFileSchema>;
