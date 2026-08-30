import { z } from "zod";
import {
  ActivationLifecycleStateSchema,
  ControlConnectionStateSchema,
  DirectConnectionStateSchema,
  HelperLifecycleStateSchema,
  RemoteAccessErrorCodeSchema,
  type RemoteAccessErrorCode
} from "../shared/schemas/remoteLifecycle.js";
import {
  CapabilityNameListSchema,
  ComponentHelloSchema,
  ProtocolVersionSchema,
  Uint64DecimalSchema,
  type ComponentHello,
  type ControlProfileV1,
  type ProtocolVersion,
  type RuntimePurpose,
  type Uint64Decimal
} from "../shared/schemas/remoteProtocol.js";
import { HelperTargetSchema, type HelperTarget } from "../shared/schemas/remoteAccess.js";

export const HELPER_HELLO_TIMEOUT_MS = 5_000;
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

export type AuthenticatedHelperClient = {
  readonly hello: ComponentHello;
  readonly negotiatedProtocol: ProtocolVersion;
  readonly negotiatedCapabilities: readonly string[];
  currentStatus: () => HelperRuntimeStatus;
  subscribeStatus: (listener: (status: HelperRuntimeStatus) => void) => () => void;
  close: () => Promise<void>;
};

export type HelperProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | string | null;
};

export type HelperLaunchRequest = {
  readonly role: HelperRole;
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

export function parseHelperRuntimeStatus(value: unknown): HelperRuntimeStatus {
  return HelperRuntimeStatusSchema.parse(value) as HelperRuntimeStatus;
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
