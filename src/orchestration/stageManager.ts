import { z } from "zod";

const ImportanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);

const StageManagerMemoryInputSchema = z.object({
  waifuId: z.string().min(1),
  content: z.string().min(1),
  importance: ImportanceSchema,
  sourceMessageIds: z.array(z.string())
});

const StageManagerMemoryPatchSchema = z.object({
  waifuId: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  importance: ImportanceSchema.optional(),
  sourceMessageIds: z.array(z.string()).optional(),
  status: z.enum(["active", "archived"]).optional()
});

export const StageManagerToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("add_memory"),
    memory: StageManagerMemoryInputSchema
  }),
  z.object({
    tool: z.literal("update_memory"),
    memoryId: z.string().min(1),
    patch: StageManagerMemoryPatchSchema
  }),
  z.object({
    tool: z.literal("archive_memory"),
    memoryId: z.string().min(1)
  }),
  z.object({
    tool: z.literal("merge_memories"),
    sourceMemoryIds: z.array(z.string().min(1)).min(2),
    mergedContent: z.string().min(1)
  }),
  z.object({
    tool: z.literal("no_change"),
    reason: z.string().optional()
  })
]);

export type StageManagerToolCall = z.infer<typeof StageManagerToolCallSchema>;
