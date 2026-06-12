import { z } from "zod";

const ImportanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);

export const OBSERVATION_KINDS = ["fact", "preference", "relationship", "event", "commitment"] as const;

export const StageManagerObservationSchema = z.object({
  waifuId: z.string().min(1),
  content: z.string().min(1),
  importance: ImportanceSchema,
  kind: z.enum(OBSERVATION_KINDS),
  entities: z.array(z.string()).default([])
});

export type StageManagerObservation = z.infer<typeof StageManagerObservationSchema>;

const StageManagerMemoryInputSchema = z.object({
  waifuId: z.string().min(1),
  content: z.string().min(1),
  importance: ImportanceSchema
});

const StageManagerMemoryPatchSchema = z.object({
  waifuId: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  importance: ImportanceSchema.optional()
});

export const StageManagerToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("add_memory"),
    memory: StageManagerMemoryInputSchema
  }),
  z.object({
    tool: z.literal("update_memory"),
    memoryIndex: z.number().int().min(1),
    patch: StageManagerMemoryPatchSchema
  }),
  z.object({
    tool: z.literal("archive_memory"),
    memoryIndex: z.number().int().min(1)
  }),
  z.object({
    tool: z.literal("merge_memories"),
    sourceMemoryIndices: z.array(z.number().int().min(1)).min(2),
    mergedContent: z.string().min(1)
  }),
  z.object({
    tool: z.literal("no_change"),
    reason: z.string().optional()
  })
]);

export type StageManagerToolCall = z.infer<typeof StageManagerToolCallSchema>;
