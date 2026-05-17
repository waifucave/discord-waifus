import { z } from "zod";
import { WaifuMemorySchema } from "../shared/schemas/domain.js";

export const StageManagerToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("add_memory"),
    memory: WaifuMemorySchema.omit({ id: true, createdAt: true, updatedAt: true, status: true })
  }),
  z.object({
    tool: z.literal("update_memory"),
    memoryId: z.string().min(1),
    patch: WaifuMemorySchema.partial().omit({ id: true, createdAt: true })
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

export type StageManagerMemoryApplyResult = {
  changed: boolean;
  syntheticContextEntry?: "[memories updated]";
  warnings: string[];
};
