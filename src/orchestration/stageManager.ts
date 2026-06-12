import { z } from "zod";
import { MemoryKindSchema } from "../shared/schemas/domain.js";

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

// The nightly dream pass speaks the 0-5 `strength` scale directly (not the librarian's 1-5
// importance). Each op references existing memories by their per-chunk `memoryIndex` (1-based).
export const DreamOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    memory: z.object({
      waifuId: z.string().min(1),
      content: z.string().min(1),
      kind: MemoryKindSchema,
      strength: z.number().min(0).max(5),
      entities: z.array(z.string()).default([])
    })
  }),
  z.object({
    op: z.literal("promote"),
    memoryIndex: z.number().int().min(1),
    patch: z
      .object({
        kind: MemoryKindSchema.optional(),
        strength: z.number().min(0).max(5).optional(),
        content: z.string().min(1).optional()
      })
      .default({})
  }),
  z.object({
    op: z.literal("rewrite"),
    memoryIndex: z.number().int().min(1),
    content: z.string().min(1),
    entities: z.array(z.string()).default([])
  }),
  z.object({
    op: z.literal("merge"),
    memoryIndices: z.array(z.number().int().min(1)).min(2),
    content: z.string().min(1),
    entities: z.array(z.string()).default([])
  }),
  z.object({
    op: z.literal("decay"),
    memoryIndex: z.number().int().min(1),
    strength: z.number().min(0).max(5)
  }),
  z.object({
    op: z.literal("archive"),
    memoryIndex: z.number().int().min(1),
    reason: z.string().min(1)
  }),
  z.object({ op: z.literal("none") })
]);
export type DreamOp = z.infer<typeof DreamOpSchema>;
