import type { Readable } from "node:stream";
import { z } from "zod";
import {
  ActivationOperationIdSchema,
  ActivationVerificationUrlSchema,
  ActivationLifecycleStateSchema,
  ApprovePairingInputV1Schema,
  ControlConnectionStateSchema,
  DirectConnectionStateSchema,
  HelperLifecycleStateSchema,
  PairInvitationV1Schema,
  PendingPairingRequestListV1Schema,
  RenameTrustedDeviceInputV1Schema,
  RemoteAccessErrorCodeSchema,
  SecretStorageKindSchema,
  TrustedDeviceListV1Schema,
  TrustedDeviceSummaryV1Schema,
  type ApprovePairingInputV1,
  type PairInvitationV1,
  type PendingPairingRequestListV1,
  type RenameTrustedDeviceInputV1,
  type RemoteAccessErrorCode,
  type TrustedDeviceListV1,
  type TrustedDeviceSummaryV1
} from "../shared/schemas/remoteLifecycle.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CapabilityNameListSchema,
  ComponentHelloSchema,
  DeviceIdSchema,
  PrincipalStableIdSchema,
  ProtocolVersionSchema,
  Uint64DecimalSchema,
  type ComponentHello,
  type ControlProfileV1,
  type HttpMethod,
  type ProtocolVersion,
  type RemoteBrowserContextV1,
  type RuntimePurpose,
  type Uint64Decimal
} from "../shared/schemas/remoteProtocol.js";
import {
  HelperTargetSchema,
  type GetResetStatusCommand,
  type HelperTarget,
  type IdentityResetReceiptV1,
  type ResetIdentityCommand
} from "../shared/schemas/remoteAccess.js";
import type {
  RemoteBridgeResponse,
  RemoteRequestBridge
} from "../backend/remoteAccess/requestBridge.js";
import type { RemoteHeaderTuple } from "../backend/remoteAccess/bridgeProtocol.js";

export const HELPER_HELLO_TIMEOUT_MS = 5_000;
export const HELPER_COMMAND_TIMEOUT_MS = 30_000;
export const HELPER_GRACEFUL_DRAIN_MS = 20_000;
export const HELPER_FAILURE_WINDOW_MS = 5 * 60_000;
export const HELPER_FAILURE_LIMIT = 10;
export const HELPER_RESTART_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

export const HelperRoleSchema = z.enum(["host", "remote"]);
export type HelperRole = z.infer<typeof HelperRoleSchema>;

export const HelperRuntimeStatusSchema = z.object({
  activationState: ActivationLifecycleStateSchema,
  controlState: ControlConnectionStateSchema,
  directState: DirectConnectionStateSchema,
  lastDirectAt: Uint64DecimalSchema.nullable(),
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable()
}).strict();

export type HelperRuntimeStatus = Omit<
  z.infer<typeof HelperRuntimeStatusSchema>,
  "lastDirectAt"
> & {
  readonly lastDirectAt: Uint64Decimal | null;
};

export const HelperIdentityStatusSchema = z.object({
  activationState: ActivationLifecycleStateSchema,
  deviceId: DeviceIdSchema,
  installationFingerprint: Base64Url16BytesSchema,
  secretStorage: SecretStorageKindSchema
}).strict();

export const HelperDeviceRevocationRecoverySchema = z.object({
  deviceId: DeviceIdSchema,
  pairId: Base64Url16BytesSchema,
  deniedTrustEpoch: Uint64DecimalSchema.refine(
    (value) => value !== "0",
    "A denied trust epoch must be positive."
  ),
  denyEpoch: Uint64DecimalSchema
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.denyEpoch) <= BigInt(value.deniedTrustEpoch)) {
    ctx.addIssue({
      code: "custom",
      path: ["denyEpoch"],
      message: "A recovery deny epoch must advance beyond its denied trust epoch."
    });
  }
});

export type HelperDeviceRevocationRecovery = z.infer<
  typeof HelperDeviceRevocationRecoverySchema
>;

export type HelperIdentityStatus = z.infer<typeof HelperIdentityStatusSchema>;

export const HelperActivationErrorCodeSchema = z.enum([
  "activation_rejected",
  "activation_unavailable",
  "certificate_invalid",
  "helper_unavailable",
  "worker_quota_exhausted"
]);

export type HelperActivationErrorCode = z.infer<typeof HelperActivationErrorCodeSchema>;

export const HelperIdentityResetErrorCodeSchema = z.enum([
  "helper_unavailable",
  "sibling_daemon_running"
]);

export type HelperIdentityResetErrorCode = z.infer<
  typeof HelperIdentityResetErrorCodeSchema
>;

export const HelperActivationStartSchema = z.object({
  operationId: ActivationOperationIdSchema,
  verificationUrl: ActivationVerificationUrlSchema,
  expiresAt: Uint64DecimalSchema
}).strict();

export type HelperActivationStart = z.infer<typeof HelperActivationStartSchema>;

const HelperActivationPollBaseShape = {
  operationId: ActivationOperationIdSchema,
  expiresAt: Uint64DecimalSchema
};

export const HelperActivationPollSchema = z.discriminatedUnion("state", [
  z.object({ ...HelperActivationPollBaseShape, state: z.literal("pending") }).strict(),
  z.object({ ...HelperActivationPollBaseShape, state: z.literal("completed") }).strict(),
  z.object({ ...HelperActivationPollBaseShape, state: z.literal("expired") }).strict(),
  z.object({
    ...HelperActivationPollBaseShape,
    state: z.literal("failed"),
    errorCode: HelperActivationErrorCodeSchema
  }).strict()
]);

export type HelperActivationPoll = z.infer<typeof HelperActivationPollSchema>;

export const HelperActivationCancelSchema = z.object({
  operationId: ActivationOperationIdSchema,
  cancelled: z.literal(true)
}).strict();

export type HelperActivationCancel = z.infer<typeof HelperActivationCancelSchema>;

const HelperLocalRequestActorSchema = z.object({
  kind: z.literal("local"),
  stableId: z.literal("local")
}).strict();

const HelperRemoteRequestActorBaseSchema = z.object({
  kind: z.literal("remote_device"),
  stableId: PrincipalStableIdSchema,
  deviceId: DeviceIdSchema,
  trustEpoch: Uint64DecimalSchema
}).strict();

const HelperRemoteRequestActorSchema = HelperRemoteRequestActorBaseSchema.refine(
  (value) => value.stableId === `remote:${value.deviceId}`,
  { path: ["stableId"], message: "Remote actor stable ID must derive from device ID." }
);

export const HelperRequestActorSchema = z.discriminatedUnion("kind", [
  HelperLocalRequestActorSchema,
  HelperRemoteRequestActorSchema
]);

export type HelperRequestActor = z.infer<typeof HelperRequestActorSchema>;

export const HelperConfirmedAdminActorSchema = z.discriminatedUnion("kind", [
  HelperLocalRequestActorSchema.extend({
    hostServerLaunchId: Base64Url32BytesSchema,
    browserSessionId: Base64Url32BytesSchema
  }),
  HelperRemoteRequestActorBaseSchema.extend({
    gatewayLaunchId: Base64Url32BytesSchema,
    browserSessionId: Base64Url32BytesSchema
  }).refine(
    (value) => value.stableId === `remote:${value.deviceId}`,
    { path: ["stableId"], message: "Remote actor stable ID must derive from device ID." }
  )
]);

export type HelperConfirmedAdminActor = z.infer<typeof HelperConfirmedAdminActorSchema>;

export type VerifiedHelperSelection = {
  readonly binaryPath: string;
  readonly helperVersion: string;
  readonly releaseSequence: Uint64Decimal;
  readonly forkCommit: string;
  readonly target: HelperTarget;
  readonly capabilities: readonly string[];
  readonly ipcProtocol: {
    readonly minimum: ProtocolVersion;
    readonly maximum: ProtocolVersion;
  };
};

export type ResolveHelperPackageInput = {
  readonly role: HelperRole;
  readonly dataRoot: string;
  readonly appVersion: string;
};

export type HelperPackageResolver = {
  resolve: (input: ResolveHelperPackageInput) => Promise<VerifiedHelperSelection>;
};

export type HelperRemoteRequest = {
  readonly method: HttpMethod;
  readonly canonicalTarget: string;
  readonly headers: readonly RemoteHeaderTuple[];
  readonly browserContext: RemoteBrowserContextV1;
  readonly body?: Readable;
  readonly signal?: AbortSignal;
};

export type HelperRemoteResponse = RemoteBridgeResponse;

export type AuthenticatedHelperClient = {
  readonly hello: ComponentHello;
  readonly negotiatedProtocol: ProtocolVersion;
  readonly negotiatedCapabilities: readonly string[];
  currentStatus: () => HelperRuntimeStatus;
  subscribeStatus: (listener: (status: HelperRuntimeStatus) => void) => () => void;
  identityStatus: () => Promise<HelperIdentityStatus>;
  beginActivation: (operationId: string) => Promise<HelperActivationStart>;
  pollActivation: (operationId: string) => Promise<HelperActivationPoll>;
  cancelActivation: (operationId: string) => Promise<HelperActivationCancel>;
  startRuntime: (selectedPairId?: string) => Promise<HelperRuntimeStatus>;
  runtimeStatus: () => Promise<HelperRuntimeStatus>;
  reconnectRuntime: () => Promise<HelperRuntimeStatus>;
  stopRuntime: () => Promise<HelperRuntimeStatus>;
  registerGatewayLaunch: (gatewayLaunchId: string, expiresAt: string) => Promise<void>;
  createInvitation: (
    actor: HelperConfirmedAdminActor,
    idempotencyKey: string
  ) => Promise<PairInvitationV1>;
  cancelInvitation: (
    invitationId: string,
    actor: HelperConfirmedAdminActor
  ) => Promise<void>;
  listPairingRequests: (
    actor: HelperRequestActor
  ) => Promise<PendingPairingRequestListV1>;
  approvePairingRequest: (
    requestId: string,
    input: ApprovePairingInputV1,
    actor: HelperConfirmedAdminActor
  ) => Promise<void>;
  rejectPairingRequest: (
    requestId: string,
    actor: HelperRequestActor
  ) => Promise<void>;
  listDevices: () => Promise<TrustedDeviceListV1>;
  renameDevice: (
    deviceId: string,
    input: RenameTrustedDeviceInputV1,
    actor: HelperRequestActor
  ) => Promise<TrustedDeviceSummaryV1>;
  revokeDevice: (
    deviceId: string,
    actor: HelperConfirmedAdminActor
  ) => Promise<void>;
  reconcileDeviceRevocation: (
    input: HelperDeviceRevocationRecovery
  ) => Promise<void>;
  resetIdentity: (input: ResetIdentityCommand) => Promise<IdentityResetReceiptV1>;
  getResetStatus: (input: GetResetStatusCommand) => Promise<IdentityResetReceiptV1>;
  request: (request: HelperRemoteRequest) => Promise<HelperRemoteResponse>;
  attachRequestBridge: (bridge: RemoteRequestBridge) => void;
  close: () => Promise<void>;
};

export class HelperStreamError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HelperStreamError";
  }
}

export type HelperProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | string | null;
};

export type HelperLaunchRequest = {
  readonly role: HelperRole;
  readonly dataRoot: string;
  readonly binaryPath: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly parentEndpoint: string;
  readonly parentCapability: Buffer;
  readonly parentHello: ComponentHello;
};

export type HelperLaunch = {
  readonly authenticated: Promise<AuthenticatedHelperClient>;
  readonly exited: Promise<HelperProcessExit>;
  requestDrain: () => void | Promise<void>;
  closeParentChannel: () => void | Promise<void>;
  forceTerminate: () => void | Promise<void>;
};

export type HelperProcessFactory = {
  launch: (request: HelperLaunchRequest) => Promise<HelperLaunch>;
};

export type HelperSupervisorSnapshot = {
  readonly state: z.infer<typeof HelperLifecycleStateSchema>;
  readonly helperVersion: string | null;
  readonly releaseSequence: Uint64Decimal | null;
  readonly forkCommit: string | null;
  readonly target: HelperTarget | null;
  readonly protocol: ProtocolVersion | null;
  readonly capabilities: readonly string[];
  readonly runtimeStatus: HelperRuntimeStatus;
  readonly lastErrorCode: RemoteAccessErrorCode | null;
  readonly consecutiveFailures: number;
  readonly restartScheduled: boolean;
};

export class HelperSupervisorError extends Error {
  constructor(
    readonly code: RemoteAccessErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HelperSupervisorError";
  }
}

export class HelperCommandError extends Error {
  constructor(
    readonly code: HelperActivationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HelperCommandError";
  }
}

export class HelperIdentityResetError extends Error {
  constructor(
    readonly code: HelperIdentityResetErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HelperIdentityResetError";
  }
}

export function parseHelperRuntimeStatus(value: unknown): HelperRuntimeStatus {
  return HelperRuntimeStatusSchema.parse(value) as HelperRuntimeStatus;
}

export function parseHelperIdentityStatus(value: unknown): HelperIdentityStatus {
  return HelperIdentityStatusSchema.parse(value);
}

export function parseHelperHello(value: unknown): ComponentHello {
  return ComponentHelloSchema.parse(value);
}

export function parseHelperTarget(value: unknown): HelperTarget {
  return HelperTargetSchema.parse(value);
}

export function parseNegotiatedCapabilities(value: unknown): readonly string[] {
  return Object.freeze([...CapabilityNameListSchema.parse(value)]);
}

export function parseNegotiatedProtocol(value: unknown): ProtocolVersion {
  return Object.freeze(ProtocolVersionSchema.parse(value));
}

export type HelperLaunchContext = {
  readonly controlProfile: ControlProfileV1;
  readonly runtimePurpose: RuntimePurpose;
};
