import { z } from "zod";
import {
  GitCommitSha1Schema,
  HelperTargetSchema,
  Sha256HexSchema
} from "./remoteAccess.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CapabilityNameListSchema,
  DeviceIdSchema,
  ProtocolVersionSchema,
  SemVerSchema,
  Uint64DecimalSchema
} from "./remoteProtocol.js";

export const MAX_TRUSTED_DEVICES = 256;
export const MAX_PENDING_PAIRING_REQUESTS = 16;
export const MAX_REMEMBERED_HOSTS = 256;
export const ACTIVATION_CHALLENGE_LIFETIME_SECONDS = 600;
export const PAIR_INVITATION_LIFETIME_SECONDS = 300;
export const MAX_FULL_PAIR_TOKEN_CHARACTERS = 1_024;
export const OFFLINE_FORGET_WARNING_CODE = "host_unreachable_remote_trust_may_remain";

const DISPLAY_NAME_CONTROL_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const FULL_PAIR_TOKEN_PATTERN = /^WF1\.[A-Za-z0-9_-]+$/;
const SHORT_CODE_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const SAS_WORD_PATTERN = /^[a-z]{2,16}$/;
const SAS_FINGERPRINT_PATTERN = /^[0-9a-f]{12}$/;
const REMOTE_SHELL_HOST_PATTERN = /^waifus-[a-z2-7]{52}\.localhost$/;

export const DeviceDisplayNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim(), "Display name must not have surrounding whitespace.")
  .refine((value) => !DISPLAY_NAME_CONTROL_PATTERN.test(value), "Display name contains unsafe control characters.")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256, "Display name exceeds 256 UTF-8 bytes.");

export type DeviceDisplayName = z.infer<typeof DeviceDisplayNameSchema>;

export const RemoteAccessErrorCodeSchema = z.enum([
  "activation_required",
  "bind_not_loopback",
  "control_unavailable",
  "coordination_unavailable",
  "custom_dashboard_unsupported",
  "direct_path_lost",
  "direct_timeout",
  "helper_incompatible",
  "helper_missing",
  "helper_signature_invalid",
  "helper_unavailable",
  "identity_corrupt",
  "port_mapping_unavailable",
  "repair_required",
  "stun_unavailable",
  "udp_unavailable",
  "unsupported_platform",
  "vault_protected_file_fallback",
  "vault_unavailable",
  "worker_quota_exhausted"
]);

export type RemoteAccessErrorCode = z.infer<typeof RemoteAccessErrorCodeSchema>;

export const HelperLifecycleStateSchema = z.enum([
  "disabled",
  "starting",
  "ready",
  "degraded",
  "failed"
]);
export const ActivationLifecycleStateSchema = z.enum([
  "activation_required",
  "active",
  "renewal_due"
]);
export const ControlConnectionStateSchema = z.enum([
  "inactive",
  "connecting",
  "connected",
  "reconnecting",
  "unavailable"
]);
export const DirectConnectionStateSchema = z.enum([
  "inactive",
  "direct",
  "reconnecting",
  "direct_unavailable"
]);
export const TrustedDeviceConnectionStateSchema = z.enum([
  "offline",
  "direct",
  "reconnecting",
  "direct_unavailable"
]);

export const RemoteAccessConfigV1Schema = z.object({
  revision: Uint64DecimalSchema,
  enabled: z.boolean(),
  displayName: DeviceDisplayNameSchema,
  updatedAt: Uint64DecimalSchema
}).strict();

export type RemoteAccessConfigV1 = z.infer<typeof RemoteAccessConfigV1Schema>;

export const UpdateRemoteAccessInputV1Schema = z.object({
  revision: Uint64DecimalSchema,
  enabled: z.boolean().optional(),
  displayName: DeviceDisplayNameSchema.optional()
}).strict().refine(
  (value) => value.enabled !== undefined || value.displayName !== undefined,
  "At least one remote-access setting must be supplied."
);

export type UpdateRemoteAccessInputV1 = z.infer<typeof UpdateRemoteAccessInputV1Schema>;

export const RemoteAccessStatusV1Schema = z.object({
  version: z.literal(1),
  config: RemoteAccessConfigV1Schema,
  identity: z.object({
    deviceId: DeviceIdSchema,
    installationFingerprint: Base64Url16BytesSchema
  }).strict(),
  appVersion: SemVerSchema,
  dashboardBuildId: Sha256HexSchema,
  helperVersion: SemVerSchema.nullable(),
  helperReleaseSequence: Uint64DecimalSchema.nullable(),
  protocol: ProtocolVersionSchema,
  capabilities: CapabilityNameListSchema,
  helperState: HelperLifecycleStateSchema,
  activationState: ActivationLifecycleStateSchema,
  controlState: ControlConnectionStateSchema,
  directState: DirectConnectionStateSchema,
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
  if (
    !value.config.enabled
    && (
      value.helperState !== "disabled"
      || value.controlState !== "inactive"
      || value.directState !== "inactive"
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["helperState"],
      message: "Disabled remote access must report inactive runtime state."
    });
  }
});

export type RemoteAccessStatusV1 = z.infer<typeof RemoteAccessStatusV1Schema>;

export const ActivationOperationIdSchema = Base64Url32BytesSchema.brand<"ActivationOperationId">();
export type ActivationOperationId = z.infer<typeof ActivationOperationIdSchema>;

export const ActivationVerificationUrlSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const allowedOrigin = url.origin === "https://pair.waifucave.com"
      || url.origin === "https://pair-staging.waifucave.com";
    return allowedOrigin
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.pathname === "/activate"
      && url.search === ""
      && url.hash.startsWith("#")
      && Base64Url32BytesSchema.safeParse(url.hash.slice(1)).success
      && url.href === value;
  }, "Expected an exact WaifuCave fragment-only activation URL.");

export const ActivationStartResultSchema = z.object({
  activationOperationId: ActivationOperationIdSchema,
  verificationUrl: ActivationVerificationUrlSchema,
  expiresAt: Uint64DecimalSchema
}).strict();

export type ActivationStartResult = z.infer<typeof ActivationStartResultSchema>;

const ActivationStatusBaseShape = {
  activationOperationId: ActivationOperationIdSchema,
  expiresAt: Uint64DecimalSchema
};

const ActivationPendingStatusSchema = z.object({
  ...ActivationStatusBaseShape,
  state: z.literal("pending")
}).strict();
const ActivationCompletedStatusSchema = z.object({
  ...ActivationStatusBaseShape,
  state: z.literal("completed"),
  completedAt: Uint64DecimalSchema
}).strict();
const ActivationExpiredStatusSchema = z.object({
  ...ActivationStatusBaseShape,
  state: z.literal("expired")
}).strict();
const ActivationFailedStatusSchema = z.object({
  ...ActivationStatusBaseShape,
  state: z.literal("failed"),
  errorCode: z.enum([
    "activation_rejected",
    "activation_unavailable",
    "certificate_invalid",
    "helper_unavailable",
    "worker_quota_exhausted"
  ])
}).strict();

export const ActivationStatusSchema = z.union([
  ActivationPendingStatusSchema,
  ActivationCompletedStatusSchema,
  ActivationExpiredStatusSchema,
  ActivationFailedStatusSchema
]).superRefine((value, ctx) => {
  if (value.state === "completed" && BigInt(value.completedAt) > BigInt(value.expiresAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "Activation completion cannot follow expiry."
    });
  }
});

export type ActivationStatus = z.infer<typeof ActivationStatusSchema>;

export const FullPairTokenSchema = z
  .string()
  .min(8)
  .max(MAX_FULL_PAIR_TOKEN_CHARACTERS)
  .regex(FULL_PAIR_TOKEN_PATTERN, "Expected a bounded unpadded WF1 token.")
  .refine((value) => {
    const payload = value.slice("WF1.".length);
    const decoded = Buffer.from(payload, "base64url");
    return decoded.byteLength > 0
      && decoded.byteLength <= 768
      && decoded.toString("base64url") === payload;
  }, "Expected canonical unpadded base64url token bytes.");
export const PairShortCodeSchema = z
  .string()
  .length(9)
  .regex(SHORT_CODE_PATTERN, "Expected normalized Crockford Base32 XXXX-XXXX.");

export const CreateInvitationInputV1Schema = z.object({}).strict();

export const PairInvitationV1Schema = z.object({
  invitationId: Base64Url16BytesSchema,
  fullToken: FullPairTokenSchema,
  shortCode: PairShortCodeSchema,
  expiresAt: Uint64DecimalSchema
}).strict();

export type PairInvitationV1 = z.infer<typeof PairInvitationV1Schema>;

export const PairEntryFlowSchema = z.enum(["full_token", "short_code"]);
export const SasIndicesSchema = z.tuple([
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023)
]);
export const SasWordsSchema = z.tuple([
  z.string().min(2).max(16).regex(SAS_WORD_PATTERN),
  z.string().min(2).max(16).regex(SAS_WORD_PATTERN),
  z.string().min(2).max(16).regex(SAS_WORD_PATTERN),
  z.string().min(2).max(16).regex(SAS_WORD_PATTERN),
  z.string().min(2).max(16).regex(SAS_WORD_PATTERN)
]);
export const SasFingerprintSchema = z.string().length(12).regex(SAS_FINGERPRINT_PATTERN);

export const PendingPairingRequestV1Schema = z.object({
  version: z.literal(1),
  requestId: Base64Url16BytesSchema,
  invitationId: Base64Url16BytesSchema,
  invitationGeneration: Uint64DecimalSchema,
  entryFlow: PairEntryFlowSchema,
  claimedDisplayName: DeviceDisplayNameSchema,
  claimedPlatform: HelperTargetSchema,
  claimedInstallationFingerprint: Base64Url16BytesSchema,
  remoteIdentityBundleHash: Base64Url32BytesSchema,
  expiresAt: Uint64DecimalSchema,
  protocol: ProtocolVersionSchema,
  transcriptHash: Base64Url32BytesSchema,
  channelBinding: Base64Url32BytesSchema,
  sasIndices: SasIndicesSchema,
  sasWords: SasWordsSchema,
  sasFingerprint: SasFingerprintSchema
}).strict();

export type PendingPairingRequestV1 = z.infer<typeof PendingPairingRequestV1Schema>;

export const PendingPairingRequestListV1Schema = z.object({
  version: z.literal(1),
  requests: z.array(PendingPairingRequestV1Schema).max(MAX_PENDING_PAIRING_REQUESTS)
}).strict();

export const ApprovePairingInputV1Schema = z.object({
  invitationGeneration: Uint64DecimalSchema,
  remoteIdentityBundleHash: Base64Url32BytesSchema,
  transcriptHash: Base64Url32BytesSchema,
  channelBinding: Base64Url32BytesSchema,
  sasIndices: SasIndicesSchema,
  sasFingerprint: SasFingerprintSchema
}).strict();

export type ApprovePairingInputV1 = z.infer<typeof ApprovePairingInputV1Schema>;

export const AssistantSafePairingRequestSummaryV1Schema = z.object({
  requestId: Base64Url16BytesSchema,
  claimedDisplayName: DeviceDisplayNameSchema,
  claimedPlatform: HelperTargetSchema,
  expiresAt: Uint64DecimalSchema
}).strict();

export type AssistantSafePairingRequestSummaryV1 = z.infer<
  typeof AssistantSafePairingRequestSummaryV1Schema
>;

export const TrustedDeviceSummaryV1Schema = z.object({
  version: z.literal(1),
  deviceId: DeviceIdSchema,
  displayName: DeviceDisplayNameSchema,
  platform: HelperTargetSchema,
  installationFingerprint: Base64Url16BytesSchema,
  trustEpoch: Uint64DecimalSchema,
  revision: Uint64DecimalSchema,
  pairedAt: Uint64DecimalSchema,
  lastSeenAt: Uint64DecimalSchema.nullable(),
  connectionState: TrustedDeviceConnectionStateSchema
}).strict();

export type TrustedDeviceSummaryV1 = z.infer<typeof TrustedDeviceSummaryV1Schema>;

export const TrustedDeviceListV1Schema = z.object({
  version: z.literal(1),
  devices: z.array(TrustedDeviceSummaryV1Schema).max(MAX_TRUSTED_DEVICES)
}).strict();

export const RenameTrustedDeviceInputV1Schema = z.object({
  revision: Uint64DecimalSchema,
  displayName: DeviceDisplayNameSchema
}).strict();

export type RenameTrustedDeviceInputV1 = z.infer<typeof RenameTrustedDeviceInputV1Schema>;

export const AvailabilityStateSchema = z.enum(["unknown", "available", "unavailable"]);
export const SecretStorageKindSchema = z.enum([
  "keychain",
  "windows_protected_storage",
  "secret_service",
  "protected_file_fallback",
  "unavailable"
]);

const HelperDiagnosticsV1Schema = z.object({
  state: HelperLifecycleStateSchema,
  version: SemVerSchema.nullable(),
  releaseSequence: Uint64DecimalSchema.nullable(),
  forkCommit: GitCommitSha1Schema.nullable(),
  target: HelperTargetSchema.nullable(),
  protocol: ProtocolVersionSchema.nullable(),
  capabilities: CapabilityNameListSchema,
  secretStorage: SecretStorageKindSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (
    value.state === "ready"
    && (
      value.version === null
      || value.releaseSequence === null
      || value.forkCommit === null
      || value.target === null
      || value.protocol === null
      || value.secretStorage === null
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Ready helper diagnostics require complete verified build metadata."
    });
  }
});

export const RemoteAccessDiagnosticsV1Schema = z.object({
  version: z.literal(1),
  appVersion: SemVerSchema,
  dashboardBuildId: Sha256HexSchema,
  helper: HelperDiagnosticsV1Schema,
  controlState: ControlConnectionStateSchema,
  stun: AvailabilityStateSchema,
  udp: AvailabilityStateSchema,
  portMapping: AvailabilityStateSchema,
  directState: DirectConnectionStateSchema,
  lastTransitionAt: Uint64DecimalSchema.nullable(),
  lastDirectAt: Uint64DecimalSchema.nullable(),
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable(),
  prohibited: z.object({
    derpRouteSelections: Uint64DecimalSchema,
    derpApplicationBytes: Uint64DecimalSchema,
    peerRelayRouteSelections: Uint64DecimalSchema,
    peerRelayApplicationBytes: Uint64DecimalSchema,
    genericProxyRequests: Uint64DecimalSchema,
    genericProxyBytes: Uint64DecimalSchema
  }).strict()
}).strict();

export type RemoteAccessDiagnosticsV1 = z.infer<typeof RemoteAccessDiagnosticsV1Schema>;

export const ConnectionShellOriginSchema = z
  .string()
  .min(1)
  .max(96)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const port = Number.parseInt(url.port, 10);
    return url.protocol === "http:"
      && url.username === ""
      && url.password === ""
      && REMOTE_SHELL_HOST_PATTERN.test(url.hostname)
      && url.port !== ""
      && /^[1-9][0-9]{0,4}$/.test(url.port)
      && port >= 1
      && port <= 65_535
      && url.origin === value;
  }, "Expected the exact isolated Waifus connection-shell origin.");

const HostClientContextV1Schema = z.object({
  mode: z.literal("host")
}).strict();
const RemoteClientContextV1Schema = z.object({
  mode: z.literal("remote"),
  selectedHostId: Base64Url32BytesSchema,
  connectionState: z.enum(["direct", "reconnecting", "direct_unavailable"]),
  connectionShellOrigin: ConnectionShellOriginSchema
}).strict();

export const ClientContextV1Schema = z.discriminatedUnion("mode", [
  HostClientContextV1Schema,
  RemoteClientContextV1Schema
]);

export type ClientContextV1 = z.infer<typeof ClientContextV1Schema>;

const PairStartFullTokenInputSchema = z.object({
  kind: z.literal("full_token"),
  token: FullPairTokenSchema
}).strict();
const PairStartShortCodeInputSchema = z.object({
  kind: z.literal("short_code"),
  code: PairShortCodeSchema
}).strict();

export const PairStartInputSchema = z.discriminatedUnion("kind", [
  PairStartFullTokenInputSchema,
  PairStartShortCodeInputSchema
]);

export type PairStartInput = z.infer<typeof PairStartInputSchema>;

export const PairOperationIdSchema = Base64Url32BytesSchema.brand<"PairOperationId">();
export type PairOperationId = z.infer<typeof PairOperationIdSchema>;

const PAIR_STATUS_PATH_PREFIX = "/_waifus_remote/v1/pair/";
export const PairOperationStatusUrlSchema = z
  .string()
  .length(PAIR_STATUS_PATH_PREFIX.length + 43)
  .refine((value) => {
    if (!value.startsWith(PAIR_STATUS_PATH_PREFIX)) {
      return false;
    }
    return PairOperationIdSchema.safeParse(value.slice(PAIR_STATUS_PATH_PREFIX.length)).success;
  }, "Expected a canonical same-origin pair-operation status path.");

function pairStatusUrlMatches(
  value: { pairOperationId: string; statusUrl: string },
  ctx: z.RefinementCtx
): void {
  if (value.statusUrl !== `${PAIR_STATUS_PATH_PREFIX}${value.pairOperationId}`) {
    ctx.addIssue({
      code: "custom",
      path: ["statusUrl"],
      message: "Pair-operation status URL must derive from pairOperationId."
    });
  }
}

export const PairOperationStateSchema = z.enum([
  "starting",
  "verification_required",
  "awaiting_host_approval",
  "connecting",
  "completed",
  "failed",
  "expired",
  "cancelled"
]);

export const PairStartResultSchema = z.object({
  pairOperationId: PairOperationIdSchema,
  statusUrl: PairOperationStatusUrlSchema,
  state: z.literal("starting"),
  expiresAt: Uint64DecimalSchema
}).strict().superRefine(pairStatusUrlMatches);

export type PairStartResult = z.infer<typeof PairStartResultSchema>;

const PairOperationStatusBaseShape = {
  pairOperationId: PairOperationIdSchema,
  statusUrl: PairOperationStatusUrlSchema,
  expiresAt: Uint64DecimalSchema
};
const PairOperationOpaqueStatusSchema = z.object({
  ...PairOperationStatusBaseShape,
  state: z.enum([
    "starting",
    "awaiting_host_approval",
    "connecting",
    "completed",
    "expired",
    "cancelled"
  ])
}).strict();
const PairOperationVerificationStatusSchema = z.object({
  ...PairOperationStatusBaseShape,
  state: z.literal("verification_required"),
  entryFlow: PairEntryFlowSchema,
  sasWords: SasWordsSchema,
  sasFingerprint: SasFingerprintSchema,
  claimedHostDisplayName: DeviceDisplayNameSchema,
  claimedHostPlatform: HelperTargetSchema,
  claimedHostInstallationFingerprint: Base64Url16BytesSchema
}).strict();
const PairOperationFailedStatusSchema = z.object({
  ...PairOperationStatusBaseShape,
  state: z.literal("failed"),
  errorCode: z.enum([
    "helper_unavailable",
    "invalid_invitation",
    "invitation_expired",
    "pairing_rejected",
    "pairing_unavailable",
    "protocol_incompatible",
    "self_pair",
    "verification_mismatch"
  ])
}).strict();

export const PairOperationStatusSchema = z.union([
  PairOperationOpaqueStatusSchema,
  PairOperationVerificationStatusSchema,
  PairOperationFailedStatusSchema
]).superRefine(pairStatusUrlMatches);

export type PairOperationStatus = z.infer<typeof PairOperationStatusSchema>;

export const PairOperationEventSchema = z.object({
  pairOperationId: PairOperationIdSchema,
  state: PairOperationStateSchema,
  at: Uint64DecimalSchema
}).strict();

export type PairOperationEvent = z.infer<typeof PairOperationEventSchema>;

export const GatewaySelectionStateSchema = z.enum([
  "no_hosts",
  "selection_required",
  "automatic_single",
  "explicit"
]);

export type GatewaySelectionState = z.infer<typeof GatewaySelectionStateSchema>;

const GatewayBrowserSessionSummaryV1Schema = z.object({
  idleExpiresAt: Uint64DecimalSchema,
  absoluteExpiresAt: Uint64DecimalSchema
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.idleExpiresAt) > BigInt(value.absoluteExpiresAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["idleExpiresAt"],
      message: "Idle expiry cannot follow absolute expiry."
    });
  }
});

export const GatewayBootstrapV1Schema = z.object({
  version: z.literal(1),
  gatewayVersion: SemVerSchema,
  helperVersion: SemVerSchema.nullable(),
  helperReleaseSequence: Uint64DecimalSchema.nullable(),
  protocol: ProtocolVersionSchema,
  capabilities: CapabilityNameListSchema,
  session: GatewayBrowserSessionSummaryV1Schema,
  activationState: ActivationLifecycleStateSchema,
  helperState: HelperLifecycleStateSchema,
  controlState: ControlConnectionStateSchema,
  directState: DirectConnectionStateSchema,
  rememberedHostCount: z.number().int().min(0).max(MAX_REMEMBERED_HOSTS),
  selectionState: GatewaySelectionStateSchema,
  selectedHostId: Base64Url32BytesSchema.nullable(),
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if ((value.helperVersion === null) !== (value.helperReleaseSequence === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["helperReleaseSequence"],
      message: "Helper version and release sequence must be present or absent together."
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
});

export type GatewayBootstrapV1 = z.infer<typeof GatewayBootstrapV1Schema>;

export const RememberedHostSummaryV1Schema = z.object({
  version: z.literal(1),
  hostId: Base64Url32BytesSchema,
  displayName: DeviceDisplayNameSchema,
  platform: HelperTargetSchema,
  installationFingerprint: Base64Url16BytesSchema,
  trustEpoch: Uint64DecimalSchema,
  revision: Uint64DecimalSchema,
  pairedAt: Uint64DecimalSchema,
  lastSeenAt: Uint64DecimalSchema.nullable(),
  lastDirectAt: Uint64DecimalSchema.nullable(),
  connectionState: TrustedDeviceConnectionStateSchema,
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable()
}).strict();

export type RememberedHostSummaryV1 = z.infer<typeof RememberedHostSummaryV1Schema>;

export const RememberedHostListV1Schema = z.object({
  version: z.literal(1),
  hosts: z.array(RememberedHostSummaryV1Schema).max(MAX_REMEMBERED_HOSTS)
}).strict().superRefine((value, ctx) => {
  const hostIds = new Set<string>();
  for (let index = 0; index < value.hosts.length; index += 1) {
    const hostId = value.hosts[index]!.hostId;
    if (hostIds.has(hostId)) {
      ctx.addIssue({
        code: "custom",
        path: ["hosts", index, "hostId"],
        message: "Remembered host IDs must be unique."
      });
    }
    hostIds.add(hostId);
  }
});

export type RememberedHostListV1 = z.infer<typeof RememberedHostListV1Schema>;

export const RememberedHostActionInputV1Schema = z.object({}).strict();

export type RememberedHostActionInputV1 = z.infer<typeof RememberedHostActionInputV1Schema>;

export const ConnectRememberedHostResultV1Schema = z.object({
  hostId: Base64Url32BytesSchema,
  action: z.literal("connect"),
  state: z.literal("connecting"),
  acceptedAt: Uint64DecimalSchema
}).strict();

export type ConnectRememberedHostResultV1 = z.infer<
  typeof ConnectRememberedHostResultV1Schema
>;

export const DisconnectRememberedHostResultV1Schema = z.object({
  hostId: Base64Url32BytesSchema,
  action: z.literal("disconnect"),
  state: z.literal("offline"),
  completedAt: Uint64DecimalSchema
}).strict();

export type DisconnectRememberedHostResultV1 = z.infer<
  typeof DisconnectRememberedHostResultV1Schema
>;

const ReachableFirstForgetInputV1Schema = z.object({
  revision: Uint64DecimalSchema,
  mode: z.literal("reachable_first")
}).strict();
const LocalOnlyConfirmedForgetInputV1Schema = z.object({
  revision: Uint64DecimalSchema,
  mode: z.literal("local_only_confirmed"),
  warningCode: z.literal(OFFLINE_FORGET_WARNING_CODE)
}).strict();

export const ForgetRememberedHostInputV1Schema = z.discriminatedUnion("mode", [
  ReachableFirstForgetInputV1Schema,
  LocalOnlyConfirmedForgetInputV1Schema
]);

export type ForgetRememberedHostInputV1 = z.infer<typeof ForgetRememberedHostInputV1Schema>;

const LocalOnlyConfirmationRequiredResultV1Schema = z.object({
  hostId: Base64Url32BytesSchema,
  state: z.literal("local_only_confirmation_required"),
  revision: Uint64DecimalSchema,
  warningCode: z.literal(OFFLINE_FORGET_WARNING_CODE),
  requiredMode: z.literal("local_only_confirmed")
}).strict();
const SignedForgetResultV1Schema = z.object({
  hostId: Base64Url32BytesSchema,
  state: z.literal("forgotten"),
  revocation: z.literal("signed_self_revocation"),
  forgottenAt: Uint64DecimalSchema
}).strict();
const LocalOnlyForgetResultV1Schema = z.object({
  hostId: Base64Url32BytesSchema,
  state: z.literal("forgotten"),
  revocation: z.literal("local_only"),
  warningCode: z.literal(OFFLINE_FORGET_WARNING_CODE),
  forgottenAt: Uint64DecimalSchema
}).strict();

export const ForgetRememberedHostResultV1Schema = z.union([
  LocalOnlyConfirmationRequiredResultV1Schema,
  SignedForgetResultV1Schema,
  LocalOnlyForgetResultV1Schema
]);

export type ForgetRememberedHostResultV1 = z.infer<typeof ForgetRememberedHostResultV1Schema>;

const ActivationOperationStateChangedEventV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("activation_operation_state_changed"),
  activationOperationId: ActivationOperationIdSchema,
  state: z.enum(["pending", "completed", "failed", "expired", "cancelled"]),
  at: Uint64DecimalSchema
}).strict();
const PairOperationStateChangedEventV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("pair_operation_state_changed"),
  pairOperationId: PairOperationIdSchema,
  state: PairOperationStateSchema,
  at: Uint64DecimalSchema
}).strict();
const RememberedHostsChangedEventV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("remembered_hosts_changed"),
  at: Uint64DecimalSchema
}).strict();
const HostConnectionChangedEventV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("host_connection_changed"),
  hostId: Base64Url32BytesSchema,
  state: TrustedDeviceConnectionStateSchema,
  at: Uint64DecimalSchema
}).strict();
const HostSelectionChangedEventV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("host_selection_changed"),
  hostId: Base64Url32BytesSchema.nullable(),
  selectionState: GatewaySelectionStateSchema,
  at: Uint64DecimalSchema
}).strict().superRefine((value, ctx) => {
  const requiresHost = value.selectionState === "automatic_single"
    || value.selectionState === "explicit";
  if ((value.hostId !== null) !== requiresHost) {
    ctx.addIssue({
      code: "custom",
      path: ["hostId"],
      message: "Selection events must bind a host exactly when selection is active."
    });
  }
});

export const GatewayLocalEventV1Schema = z.discriminatedUnion("type", [
  ActivationOperationStateChangedEventV1Schema,
  PairOperationStateChangedEventV1Schema,
  RememberedHostsChangedEventV1Schema,
  HostConnectionChangedEventV1Schema,
  HostSelectionChangedEventV1Schema
]);

export type GatewayLocalEventV1 = z.infer<typeof GatewayLocalEventV1Schema>;
