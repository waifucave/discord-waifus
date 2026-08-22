import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema } from "../shared/schemas/common.js";
import {
  ActivationLifecycleStateSchema,
  ControlConnectionStateSchema,
  DirectConnectionStateSchema,
  HelperLifecycleStateSchema,
  MAX_TRUSTED_DEVICES,
  RemoteAccessErrorCodeSchema
} from "../shared/schemas/remoteLifecycle.js";
import { Uint64DecimalSchema } from "../shared/schemas/remoteProtocol.js";

export const RemoteAccessRuntimeSummarySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  helperState: HelperLifecycleStateSchema,
  activationState: ActivationLifecycleStateSchema,
  controlState: ControlConnectionStateSchema,
  directState: DirectConnectionStateSchema,
  trustedDeviceCount: z.number().int().min(0).max(MAX_TRUSTED_DEVICES),
  lastDirectAt: Uint64DecimalSchema.nullable(),
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (
    !value.enabled
    && (
      value.helperState !== "disabled"
      || value.controlState !== "inactive"
      || value.directState !== "inactive"
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["helperState"],
      message: "Disabled remote access must have inactive runtime state."
    });
  }
});

export type RemoteAccessRuntimeSummary = z.infer<typeof RemoteAccessRuntimeSummarySchema>;

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
      connecting: z.boolean().optional(),
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
    }),
  remoteAccess: RemoteAccessRuntimeSummarySchema.optional()
});

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export function createRuntimeState(input: Omit<RuntimeState, "schemaVersion" | "updatedAt">): RuntimeState {
  return RuntimeStateSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ...input
  });
}
