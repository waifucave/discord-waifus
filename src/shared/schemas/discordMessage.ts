import { z } from "zod";
import { IsoDateStringSchema } from "./common.js";

// Raw input to the conversation ledger (spec 8.1): one record per Discord message, never merged.

export const ImageRefSchema = z.object({
  // attachmentKey(): "att:<attachmentId>" or "url:<sha256>" — stable across re-signed URLs.
  key: z.string().min(1),
  attachmentId: z.string().optional(),
  url: z.string().min(1),
  filename: z.string().optional(),
  contentType: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  conversationKey: z.string().optional()
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

const RawAttachmentSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  filename: z.string(),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  durationSecs: z.number().nonnegative().optional(),
  isVoice: z.boolean().optional()
});

const RawEmbedSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  providerName: z.string().optional(),
  thumbnailUrl: z.string().optional()
});

export const RawDiscordMessageSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  guildId: z.string().min(1).optional(),
  authorId: z.string().min(1),
  authorName: z.string(),
  authorIsBot: z.boolean(),
  createdAt: IsoDateStringSchema,
  editedAt: IsoDateStringSchema.optional(),
  type: z.number().int().nonnegative(), // Discord message type
  content: z.string(),
  attachments: z.array(RawAttachmentSchema),
  embeds: z.array(RawEmbedSchema),
  stickers: z.array(z.object({ name: z.string() })),
  poll: z.object({ question: z.string(), answers: z.array(z.string()) }).optional(),
  snapshots: z.array(z.object({ content: z.string(), attachments: z.array(RawAttachmentSchema) })), // forwards
  referenceMessageId: z.string().min(1).optional(),
  mentions: z.object({
    users: z.record(z.string(), z.string()),
    roles: z.record(z.string(), z.string()),
    channels: z.record(z.string(), z.string())
  })
});
export type RawDiscordMessage = z.infer<typeof RawDiscordMessageSchema>;
