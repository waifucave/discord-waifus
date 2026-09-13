import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema } from "./common.js";
import {
  ActivationLifecycleStateSchema,
  ConnectionShellOriginSchema,
  ControlConnectionStateSchema,
  DirectConnectionStateSchema,
  GatewaySelectionStateSchema,
  HelperLifecycleStateSchema,
  MAX_REMEMBERED_HOSTS,
  RemoteAccessErrorCodeSchema
} from "./remoteLifecycle.js";
import {
  Base64Url32BytesSchema,
  CapabilityNameListSchema,
  ProtocolVersionSchema,
  SemVerSchema,
  Uint64DecimalSchema
} from "./remoteProtocol.js";

export const RemoteDaemonStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  version: z.literal(1),
  kind: z.literal("remote_gateway"),
  pid: z.number().int().positive(),
  startedAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  packageVersion: SemVerSchema,
  port: z.number().int().min(1).max(65_535),
  dataRoot: z.string().min(1),
  mode: z.enum(["remote", "test"]),
  connectionShellOrigin: ConnectionShellOriginSchema,
  helperVersion: SemVerSchema.nullable(),
  helperReleaseSequence: Uint64DecimalSchema.nullable(),
  protocol: ProtocolVersionSchema,
  capabilities: CapabilityNameListSchema,
  helperState: HelperLifecycleStateSchema,
  activationState: ActivationLifecycleStateSchema,
  controlState: ControlConnectionStateSchema,
  directState: DirectConnectionStateSchema,
  rememberedHostCount: z.number().int().min(0).max(MAX_REMEMBERED_HOSTS),
  selectionState: GatewaySelectionStateSchema,
  selectedHostId: Base64Url32BytesSchema.nullable(),
  lastDirectAt: Uint64DecimalSchema.nullable(),
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if ((value.helperVersion === null) !== (value.helperReleaseSequence === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["helperReleaseSequence"],
      message: "Helper version and release sequence must be present or absent together."
    });
  }
  let origin: URL;
  try {
    origin = new URL(value.connectionShellOrigin);
  } catch {
    return;
  }
  if (Number(origin.port) !== value.port) {
    ctx.addIssue({
      code: "custom",
      path: ["connectionShellOrigin"],
      message: "Connection-shell origin port must match the remote daemon listener."
    });
  }
  const hasSelection = value.selectedHostId !== null;
  const selectionIsBound = value.selectionState === "automatic_single"
    || value.selectionState === "explicit";
  if (hasSelection !== selectionIsBound) {
    ctx.addIssue({
      code: "custom",
      path: ["selectedHostId"],
      message: "Selected host presence must match the selection state."
    });
  }
  if (value.selectionState === "no_hosts" && value.rememberedHostCount !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["rememberedHostCount"],
      message: "The no-hosts state requires an empty remembered-host set."
    });
  }
  if (value.selectionState === "selection_required" && value.rememberedHostCount < 2) {
    ctx.addIssue({
      code: "custom",
      path: ["rememberedHostCount"],
      message: "Host selection is required only when multiple hosts are remembered."
    });
  }
  if (value.selectionState === "automatic_single" && value.rememberedHostCount !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["rememberedHostCount"],
      message: "Automatic selection requires exactly one remembered host."
    });
  }
  if (value.selectionState === "explicit" && value.rememberedHostCount < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["rememberedHostCount"],
      message: "Explicit selection requires a remembered host."
    });
  }
  if (!hasSelection && value.directState !== "inactive") {
    ctx.addIssue({
      code: "custom",
      path: ["directState"],
      message: "An unselected gateway cannot report a host direct path."
    });
  }
  if (
    value.helperState === "disabled"
    && (value.controlState !== "inactive" || value.directState !== "inactive")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["helperState"],
      message: "A disabled helper must have inactive network state."
    });
  }
});

export type RemoteDaemonState = z.infer<typeof RemoteDaemonStateSchema>;

export function createRemoteDaemonState(
  input: Omit<RemoteDaemonState, "schemaVersion" | "version" | "kind" | "updatedAt">
): RemoteDaemonState {
  return RemoteDaemonStateSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    version: 1,
    kind: "remote_gateway",
    updatedAt: new Date().toISOString(),
    ...input
  });
}
