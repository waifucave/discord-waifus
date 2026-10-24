import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "../shared/schemas/common.js";
import { RuntimeStateBaseSchema } from "../shared/schemas/runtime.js";
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

/** The runtime state plus its Remote Access summary (the rest lives in src/shared/schemas/runtime.ts). */
export const RuntimeStateSchema = RuntimeStateBaseSchema.extend({
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
