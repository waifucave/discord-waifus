import { z } from "zod";

export const stageManagerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  providerId: z.string().min(1).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  temperature: z.number().min(0).max(2).default(0.4),
  maxTokens: z.number().int().positive().default(500),
  quietPeriodSeconds: z.number().int().min(10).default(300),
  historyLimit: z.number().int().min(10).max(100).default(60),
  maxRelationshipsPerWaifu: z.number().int().min(1).max(50).default(20),
  maxMemoriesPerWaifu: z.number().int().min(1).max(20).default(8)
});

export const stageManagerFileSchema = z.object({
  stageManager: stageManagerConfigSchema
});

export const relationshipEntrySchema = z.object({
  targetKind: z.enum(["user", "waifu"]),
  targetName: z.string().min(1),
  targetUserId: z.string().nullable().default(null),
  targetWaifuId: z.string().nullable().default(null),
  relationship: z.string().min(1).max(220),
  updatedAt: z.string().min(1)
});

export const memoryNoteSchema = z.object({
  slot: z.number().int().min(1),
  note: z.string().min(1).max(220),
  sourceMessageIds: z.array(z.string()).max(5).default([]),
  updatedAt: z.string().min(1)
});

export const waifuStageStateSchema = z.object({
  relationshipsByParticipant: z.record(z.string(), relationshipEntrySchema).default({}),
  memories: z.array(memoryNoteSchema).default([])
});

export const channelStageStateSchema = z.object({
  lastProcessedMessageId: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null)
});

export const stageManagerStateSchema = z.object({
  waifus: z.record(z.string(), waifuStageStateSchema).default({}),
  channels: z.record(z.string(), channelStageStateSchema).default({})
});

export const relationshipUpdateSchema = z.object({
  waifuId: z.string().min(1),
  targetParticipantKey: z.string().min(1),
  relationship: z.string().min(1).max(220)
});

export const memoryUpdateSchema = z.object({
  waifuId: z.string().min(1),
  slot: z.number().int().min(1).nullable().default(null),
  note: z.string().min(1).max(220),
  sourceMessageIds: z.array(z.string()).max(5).default([])
});

export const stageManagerDecisionSchema = z.object({
  relationshipUpdates: z.array(relationshipUpdateSchema).max(10).default([]),
  memoryUpdates: z.array(memoryUpdateSchema).max(10).default([]),
  reasoning: z.string().default("")
});

export const stageManagerDecisionToolInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    relationshipUpdates: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          waifuId: { type: "string" },
          targetParticipantKey: { type: "string" },
          relationship: { type: "string" }
        },
        required: ["waifuId", "targetParticipantKey", "relationship"]
      }
    },
    memoryUpdates: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          waifuId: { type: "string" },
          slot: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
          },
          note: { type: "string" },
          sourceMessageIds: {
            type: "array",
            maxItems: 5,
            items: { type: "string" }
          }
        },
        required: ["waifuId", "slot", "note", "sourceMessageIds"]
      }
    },
    reasoning: { type: "string" }
  },
  required: ["relationshipUpdates", "memoryUpdates", "reasoning"]
} as const;

export type StageManagerConfig = z.infer<typeof stageManagerConfigSchema>;
export type StageManagerFile = z.infer<typeof stageManagerFileSchema>;
export type RelationshipEntry = z.infer<typeof relationshipEntrySchema>;
export type MemoryNote = z.infer<typeof memoryNoteSchema>;
export type WaifuStageState = z.infer<typeof waifuStageStateSchema>;
export type ChannelStageState = z.infer<typeof channelStageStateSchema>;
export type StageManagerState = z.infer<typeof stageManagerStateSchema>;
export type RelationshipUpdate = z.infer<typeof relationshipUpdateSchema>;
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;
export type StageManagerDecision = z.infer<typeof stageManagerDecisionSchema>;
