import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema } from "../shared/schemas/common.js";

export const RuntimeStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  startedAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  packageVersion: z.string(),
  port: z.number().int().min(1).max(65_535),
  dataRoot: z.string(),
  mode: z.string(),
  paused: z.boolean().default(false),
  discord: z
    .object({
      connected: z.boolean(),
      orchestratorConnected: z.boolean(),
      waifuBotCount: z.number().int().nonnegative(),
      warnings: z.array(z.string()),
      retrying: z.boolean().optional(),
      retryAttempt: z.number().int().positive().optional(),
      nextRetryAt: IsoDateStringSchema.optional(),
      lastError: z.string().optional(),
      lastErrorAt: IsoDateStringSchema.optional()
    })
    .default({
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: []
    }),
  queues: z
    .object({
      active: z.number().int().nonnegative(),
      configuredGuilds: z.number().int().nonnegative()
    })
    .default({
      active: 0,
      configuredGuilds: 0
    })
});

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export function createRuntimeState(input: Omit<RuntimeState, "schemaVersion" | "updatedAt">): RuntimeState {
  return RuntimeStateSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ...input
  });
}
