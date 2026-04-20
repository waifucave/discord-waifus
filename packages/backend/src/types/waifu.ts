import { z } from "zod";

export const timeRangeSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/)
});

export const busyTimeSchema = timeRangeSchema.extend({
  reason: z.string().min(1)
});

export const personalitySchema = z.object({
  description: z.string().min(1),
  traits: z.array(z.string()).default([]),
  speechPatterns: z.array(z.string()).default([]),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  backstory: z.string().min(1),
  quirks: z.array(z.string()).default([]),
  relationshipsWithOtherWaifus: z.record(z.string()).default({})
});

export const aiConfigSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.8),
  repetitionPenalty: z.number().min(0).max(2).default(1),
  maxTokens: z.number().int().positive().default(300),
  systemPromptOverride: z.string().nullable().default(null)
});

export const scheduleSchema = z.object({
  sleepTime: timeRangeSchema,
  busyTime: busyTimeSchema
});

export const waifuSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  botToken: z.string().min(1),
  applicationId: z.string().min(1),
  enabled: z.boolean().default(true),
  avatarPath: z.string().nullable().default(null),
  bannerPath: z.string().nullable().default(null),
  statusText: z.string().nullable().default(null),
  statusType: z.enum(["online", "idle", "dnd", "invisible"]).default("online"),
  personality: personalitySchema,
  schedule: scheduleSchema,
  ai: aiConfigSchema
});

export const waifusFileSchema = z.object({
  waifus: z.array(waifuSchema).default([])
});

export type TimeRange = z.infer<typeof timeRangeSchema>;
export type BusyTime = z.infer<typeof busyTimeSchema>;
export type PersonalityConfig = z.infer<typeof personalitySchema>;
export type AIConfig = z.infer<typeof aiConfigSchema>;
export type ScheduleConfig = z.infer<typeof scheduleSchema>;
export type WaifuConfig = z.infer<typeof waifuSchema>;
export type WaifusFile = z.infer<typeof waifusFileSchema>;
