// The dashboard's API types (overhaul spec §10.6, I17). Domain, config, runtime, life, usage and
// request-body types are derived from the shared zod schemas with type-only imports (erased at
// build; `tests/frontendSharedImports.test.ts` keeps it that way). What the server builds by hand
// (the curated model list, provider status, assistant events) and the Remote Access shapes (their
// schemas need Node, D5) are mirrored here and kept narrow.

import type { z } from "zod";
import type {
  CreateWaifuBodySchema,
  DetectorConfigResponseSchema,
  DiscordProfileStatusSchema,
  ForgetJobsResponseSchema,
  HerFileDeleteResponseSchema,
  HerFileEntrySchema,
  HerFileResponseSchema,
  HerFilesListResponseSchema,
  HerFileWriteBodySchema,
  HerFileWriteResponseSchema,
  LifeCompactResponseSchema,
  LifeLogBlockSchema,
  LifeLogLineViewSchema,
  LifeLogResponseSchema,
  LifeResetResponseSchema,
  LifeStatusResponseSchema,
  LifeWakeViewSchema,
  NeedsReviewItemSchema,
  NeedsReviewDismissResponseSchema,
  NeedsReviewResponseSchema,
  OwnerNoticesResponseSchema,
  PeopleForgetResponseSchema,
  PlanEntryDeleteResponseSchema,
  ProviderCredentialsBodySchema,
  ReminderViewSchema,
  ScheduleResponseSchema,
  SearchUsageResponseSchema,
  UpdateAssistantConfigBodySchema,
  UpdateChannelBodySchema,
  UpdateServerBodySchema,
  UpdateWaifuBodySchema,
  UsageResponseSchema,
  WakeResponseSchema,
  WatchesResponseSchema,
  WatchViewSchema
} from "../../shared/schemas/api";
import type { AppConfig as SharedAppConfig, UpdateAppConfigBody as SharedUpdateAppConfigBody } from "../../shared/schemas/config";
import type { CompactionSettings as SharedCompactionSettings } from "../../shared/schemas/compaction";
import type { DetectorHistoryEntry as SharedDetectorHistoryEntry } from "../../shared/schemas/detector";
import type { DiscordBotConfig as SharedDiscordBotConfig, ServerConfig as SharedServerConfig, WaifuConfig as SharedWaifuConfig } from "../../shared/schemas/domain";
import type { RevisionedRecord } from "../../shared/schemas/common";
import type { ProviderId } from "../../shared/schemas/domain";
import type { DiscordBotConnectionStatusSchema, DiscordRuntimeStatusSchema, QueueRuntimeSchema, RuntimeStateBaseSchema } from "../../shared/schemas/runtime";

export type {
  AssistantConfig,
  GuildEmojiCacheEntry,
  GuildEmojisFile,
  GuildMemberCacheEntry,
  GuildMembersFile,
  GuildRoleCacheEntry,
  GuildRolesFile,
  ModelChoice,
  ProviderId,
  WaifuAvailability,
  WaifuConfig,
  WaifuBedTime
} from "../../shared/schemas/domain";
export type { WaifuDmSettings } from "../../shared/schemas/dm";
export type { ThreadRecord, ThreadsFile } from "../../shared/schemas/threads";
export type { RevisionedRecord as Revisioned } from "../../shared/schemas/common";
export type { UsageGroupKey } from "../../shared/schemas/api";

/** One row of GET /api/models (mirrors src/models/catalog.ts CuratedModel). */
export type CuratedModel = {
  id: string;
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  providerDisplayName: string;
  family: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  imageInput: boolean;
  efforts: string[];
  defaultEffort?: string;
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number; cacheReadPerMTokUsd?: number; cacheWritePerMTokUsd?: number };
  /** Contributor (training) variant: only ever an explicit user choice. */
  contributor: boolean;
  promptCaching: boolean;
  /** How long her prompt stays cached after a request (spec §25); absent: not known. */
  cacheTtlMs?: number;
  credentialsConfigured: boolean;
};

export type ModelsResponse = {
  catalogVersion: string;
  maxOutputUsdPerMTok: number;
  models: CuratedModel[];
  hidden: Array<{ id: string; reason: string }>;
  /** Curated routes the allow list leaves out that would be offered if switched on. */
  available?: CuratedModel[];
};

/**
 * A model notice from `/api/runtime`: `scope` is `waifu:<id>`, `assistant` or `models`; `label` names
 * it for people (her display name); `previous` is the model it had before (`provider/model`);
 * `dismissible` notices can be removed with `api.dismissModelWarnings(scope)`.
 */
export type ModelWarning = { scope: string; label?: string; code: string; detail: string; at?: string; previous?: string; dismissible?: boolean };

export type HealthResponse = {
  ok: boolean;
  service: string;
  time: string;
};

export type ClientContext =
  | { mode: "host" }
  | {
      mode: "remote";
      selectedHostId: string;
      connectionState: "direct" | "reconnecting" | "direct_unavailable";
      connectionShellOrigin: string;
    };

export type RemoteAccessConfig = {
  revision: string;
  enabled: boolean;
  displayName: string;
  updatedAt: string;
};

export type RemoteAccessStatus = {
  version: 1;
  config: RemoteAccessConfig;
  identity: {
    deviceId: string;
    installationFingerprint: string;
  };
  appVersion: string;
  dashboardBuildId: string;
  helperVersion: string | null;
  helperReleaseSequence: string | null;
  protocol: { major: number; minor: number };
  capabilities: string[];
  helperState: "disabled" | "starting" | "ready" | "degraded" | "failed";
  activationState: "activation_required" | "active" | "renewal_due";
  controlState: "inactive" | "connecting" | "connected" | "reconnecting" | "unavailable";
  directState: "inactive" | "direct" | "reconnecting" | "direct_unavailable";
  lastDirectAt: string | null;
  lastErrorCode: string | null;
};

export type HelperTarget =
  | { os: "darwin"; arch: "arm64" }
  | { os: "win32"; arch: "x64" | "arm64" }
  | { os: "linux"; arch: "x64" | "arm64" }
  | { os: "linux"; arch: "arm"; goarm: 7 };

export type ActivationStartResult = {
  activationOperationId: string;
  verificationUrl: string;
  expiresAt: string;
};

export type ActivationStatus =
  | { activationOperationId: string; expiresAt: string; state: "pending" }
  | {
      activationOperationId: string;
      expiresAt: string;
      state: "completed";
      completedAt: string;
    }
  | { activationOperationId: string; expiresAt: string; state: "expired" }
  | {
      activationOperationId: string;
      expiresAt: string;
      state: "failed";
      errorCode: string;
    };

export type OperationAccepted = {
  operationId: string;
  status: "accepted";
  statusUrl: string;
};

export type PairInvitation = {
  invitationId: string;
  fullToken: string;
  shortCode: string;
  expiresAt: string;
};

export type PendingPairingRequest = {
  version: 1;
  requestId: string;
  invitationId: string;
  invitationGeneration: string;
  entryFlow: "full_token" | "short_code";
  claimedDisplayName: string;
  claimedPlatform: HelperTarget;
  claimedInstallationFingerprint: string;
  remoteIdentityBundleHash: string;
  expiresAt: string;
  protocol: { major: number; minor: number };
  transcriptHash: string;
  channelBinding: string;
  sasIndices: [number, number, number, number, number];
  sasWords: [string, string, string, string, string];
  sasFingerprint: string;
};

export type PendingPairingRequestList = {
  version: 1;
  requests: PendingPairingRequest[];
};

export type ApprovePairingInput = Pick<
  PendingPairingRequest,
  | "invitationGeneration"
  | "remoteIdentityBundleHash"
  | "transcriptHash"
  | "channelBinding"
  | "sasIndices"
  | "sasFingerprint"
>;

export type TrustedDevice = {
  version: 1;
  deviceId: string;
  displayName: string;
  platform: HelperTarget;
  installationFingerprint: string;
  trustEpoch: string;
  revision: string;
  pairedAt: string;
  lastSeenAt: string | null;
  connectionState: "offline" | "direct" | "reconnecting" | "direct_unavailable";
};

export type TrustedDeviceList = {
  version: 1;
  devices: TrustedDevice[];
};

/** `GET /api/runtime` adds the guild directory and DM status to the stored Discord runtime. */
export type DiscordRuntime = z.output<typeof DiscordRuntimeStatusSchema> & {
  /** `GET /api/runtime` only (spec 9.6): the guild directory's member list status. */
  directory?: {
    memberListAvailable: boolean | null;
    lastRefreshAt: string | null;
    warnings: string[];
  };
  /** `GET /api/runtime` only (spec 9.6): DM-eligible waifus and DM warnings. */
  dm?: {
    eligibleWaifus: Array<{ waifuId: string; botId: string; intentActive: boolean }>;
    /** `dm_bot_shared:<botId>`, `dm_missing_model:<waifuId>`, `dm_intent_pending_reconnect:<botId>`. */
    warnings: string[];
  };
};

export type DiscordBotConnectionStatus = z.output<typeof DiscordBotConnectionStatusSchema>;
export type QueueRuntime = z.output<typeof QueueRuntimeSchema>;

export type StatusResponse = {
  running: boolean;
  paused: boolean;
  httpUrl: string;
  dataRoot: string;
  discord: DiscordRuntime;
  queues: QueueRuntime;
};

export type RuntimeState = Omit<z.output<typeof RuntimeStateBaseSchema>, "discord"> & {
  discord: DiscordRuntime;
  /** Living cast §9.2: unmapped/unavailable model choices and unpriced routes. */
  models?: { warnings: ModelWarning[] };
  /** Remote Access summary (hand-mirrored: its schema needs Node, D5). */
  remoteAccess?: {
    version: 1;
    enabled: boolean;
    helperState: "disabled" | "starting" | "ready" | "degraded" | "failed";
    activationState: "activation_required" | "active" | "renewal_due";
    controlState: "inactive" | "connecting" | "connected" | "reconnecting" | "unavailable";
    directState: "inactive" | "direct" | "reconnecting" | "direct_unavailable";
    trustedDeviceCount: number;
    lastDirectAt: string | null;
    lastErrorCode: string | null;
  };
};

export type CompactionSettings = SharedCompactionSettings;
export type AppConfig = SharedAppConfig;
/** `PUT /api/config`: a partial patch; send only what changed. */
export type UpdateAppConfigBody = SharedUpdateAppConfigBody;

export type AutoUpdateStatus = {
  state: "disabled" | "unsupported" | "checking" | "current" | "waiting_idle" | "installing" | "updated" | "rolled_back" | "failed";
  currentVersion: string; candidateVersion: string | null; lastCheckAt: string | null;
  reason: "none" | "busy" | "disabled" | "credentials_locked" | "check_failed" | "update_failed" | "restart_failed" | "source_checkout";
};

/** A bot entry as `GET /api/discord-bots` returns it: the token is never sent back, only whether one is set. */
export type DiscordBotConfig = Omit<SharedDiscordBotConfig, "token"> & {
  /** Write-only: send it to set or replace the token. */
  token?: string;
  tokenConfigured?: boolean;
  tokenHint?: string;
};

export type DiscordBotsFile = {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  orchestrator: DiscordBotConfig | null;
  waifus: DiscordBotConfig[];
};

/** `PUT /api/discord-bots`: send only what changes (`revision` makes it conditional). */
export type UpdateDiscordBotsBody = {
  revision?: number;
  orchestrator?: DiscordBotConfig | null;
  waifus?: DiscordBotConfig[];
};

/** `POST /api/waifus/:id/link-bot`. */
export type WaifuBotLink = {
  linked: boolean;
  botId: string;
  applicationId: string | null;
  tokenConfigured: boolean;
  next: string;
};

export type UpdateAssistantConfigBody = z.input<typeof UpdateAssistantConfigBodySchema>;

export type ProviderCredentialStatus =
  | { configured: false }
  | {
      configured: true;
      label?: string;
      updatedAt: string;
      keyHint: string;
    };

// /api/providers: credential status for the providers serving curated routes, the detector's
// providers and any provider with a stored key. Models are listed by GET /api/models.
export type ProviderMetadata = {
  id: ProviderId;
  displayName: string;
  docsUrl?: string;
  credentials: ProviderCredentialStatus;
};

export type ProvidersResponse = {
  revision: number;
  updatedAt: string;
  catalogVersion: string;
  providers: ProviderMetadata[];
};

export type WaifusResponse = { waifus: SharedWaifuConfig[] };

export type CreateWaifuBody = z.input<typeof CreateWaifuBodySchema>;

// `model`/`botId` accept explicit `null` on write to mean "unset" (a bare `undefined` field is
// dropped by JSON.stringify and is indistinguishable from "field omitted, leave untouched").
export type UpdateWaifuBody = z.input<typeof UpdateWaifuBodySchema> & { revision: number };

/** `GET /api/waifus/:id/discord-profile` (Living cast §17). */
export type DiscordProfileStatus = z.output<typeof DiscordProfileStatusSchema>;

export type ServerConfig = SharedServerConfig;
export type ChannelConfig = SharedServerConfig["channels"][string];
export type ServersResponse = { servers: ServerConfig[] };
export type UpdateServerBody = z.input<typeof UpdateServerBodySchema> & { revision: number };
export type ChannelBody = z.input<typeof UpdateChannelBodySchema>;

/** POST /api/people/:userId/forget (Living cast §7.5, §14.1): HTTP 202 when `pending` is not empty. */
export type ForgetUserResult = z.output<typeof PeopleForgetResponseSchema>;
export type ForgetJobsResponse = z.output<typeof ForgetJobsResponseSchema>;
export type OwnerNotices = z.output<typeof OwnerNoticesResponseSchema>;

export type ProviderCredentialsBody = z.input<typeof ProviderCredentialsBodySchema>;

// --- Lives (Living cast §14.1) ---
export type LifeStatus = z.output<typeof LifeStatusResponseSchema>;
export type LifeWakeView = z.output<typeof LifeWakeViewSchema>;
export type LifeLog = z.output<typeof LifeLogResponseSchema>;
export type LifeLogLineView = z.output<typeof LifeLogLineViewSchema>;
export type LifeLogBlock = z.output<typeof LifeLogBlockSchema>;
export type WakeResult = z.output<typeof WakeResponseSchema>;
export type LifeCompactResult = z.output<typeof LifeCompactResponseSchema>;
export type LifeResetResult = z.output<typeof LifeResetResponseSchema>;
export type NeedsReviewItem = z.output<typeof NeedsReviewItemSchema>;
export type NeedsReviewResponse = z.output<typeof NeedsReviewResponseSchema>;
export type NeedsReviewDismissResponse = z.output<typeof NeedsReviewDismissResponseSchema>;

// --- Her files, reminders and watches (Living cast §16.11) ---
export type HerFileEntry = z.output<typeof HerFileEntrySchema>;
export type HerFilesList = z.output<typeof HerFilesListResponseSchema>;
export type HerFile = z.output<typeof HerFileResponseSchema>;
export type HerFileWriteBody = z.input<typeof HerFileWriteBodySchema>;
export type HerFileWriteResult = z.output<typeof HerFileWriteResponseSchema>;
export type HerFileDeleteResult = z.output<typeof HerFileDeleteResponseSchema>;
export type ReminderView = z.output<typeof ReminderViewSchema>;
export type ScheduleResponse = z.output<typeof ScheduleResponseSchema>;
export type WatchView = z.output<typeof WatchViewSchema>;
export type WatchesResponse = z.output<typeof WatchesResponseSchema>;
export type PlanEntryDeleteResult = z.output<typeof PlanEntryDeleteResponseSchema>;

/** `GET /api/logs`: newest first. */
export type LogsResponse = { entries: Array<{ time: string; level: string; message: string; context?: unknown }> };

// --- Help (the settings registry over HTTP; server-built, so mirrored here) ---
export type HelpKey = {
  id: string;
  group: string;
  path: string;
  type: "boolean" | "integer" | "number" | "string" | "enum" | "string-list" | "json";
  typeLabel: string;
  enum?: string[];
  min?: number;
  /** `min` itself is not allowed (more than it). */
  minExclusive?: true;
  max?: number;
  maxLength?: number;
  nullable: boolean;
  default?: unknown;
  help: string;
  /** A short human name for forms; absent for keys that have none. */
  label?: string;
  flags: Array<"secret" | "readOnly" | "localOnlyWrite" | "remoteHidden" | "nullUnset" | "nullIsValue" | "leaf">;
  applies: "live" | "reload" | "restart";
  example?: string;
  unit?: string;
  cli: string[];
};
export type HelpTopic =
  | { kind: "group"; id: string; title: string; summary: string; description: string; keys: HelpKey[]; notes: string[] }
  | { kind: "subtree"; id: string; group: string; keys: HelpKey[] }
  | { kind: "key"; id: string; group: string; key: HelpKey }
  | { kind: "resource"; id: string; title: string; summary: string; description: string }
  | { kind: "command"; id: string; name: string; summary: string; usage: string[] };

/** `GET /api/detector/models`: the addressee detector's decision models. */
export type DetectorModelsResponse = {
  models: Array<{ target: string; label: string; provider: string; local: boolean; configured: boolean }>;
  unavailable: boolean;
};

// --- Usage, search, detector ---
export type UsageResponse = z.output<typeof UsageResponseSchema>;
export type SearchUsage = z.output<typeof SearchUsageResponseSchema>;
export type DetectorConfigResponse = z.output<typeof DetectorConfigResponseSchema>;
export type DetectorHistoryEntry = SharedDetectorHistoryEntry;

export type RemoteAccessDiagnostics = {
  version: 1;
  appVersion: string;
  dashboardBuildId: string;
  helper: {
    state: "disabled" | "starting" | "ready" | "degraded" | "failed";
    version: string | null;
    releaseSequence: string | null;
    forkCommit: string | null;
    target: HelperTarget | null;
    protocol: { major: number; minor: number } | null;
    capabilities: string[];
    secretStorage:
      | "keychain"
      | "windows_protected_storage"
      | "secret_service"
      | "protected_file_fallback"
      | "unavailable"
      | null;
  };
  controlState: "inactive" | "connecting" | "connected" | "reconnecting" | "unavailable";
  stun: "unknown" | "available" | "unavailable";
  udp: "unknown" | "available" | "unavailable";
  portMapping: "unknown" | "available" | "unavailable";
  directState: "inactive" | "direct" | "reconnecting" | "direct_unavailable";
  lastTransitionAt: string | null;
  lastDirectAt: string | null;
  lastErrorCode: string | null;
  prohibited: {
    derpRouteSelections: string;
    derpApplicationBytes: string;
    peerRelayRouteSelections: string;
    peerRelayApplicationBytes: string;
    genericProxyRequests: string;
    genericProxyBytes: string;
  };
};

export type DiagnosticBundle = {
  generatedAt: string;
  runtime: RuntimeState;
  providers: {
    revision: number;
    configured: Record<string, { label?: string; updatedAt: string; keyHint: string }>;
  };
  discord: {
    revision: number;
    houseConfigured: boolean;
    houseApplicationId?: string;
    waifuBotCount: number;
    configuredWaifuBotCount: number;
  };
  assistant: { model: string | null };
  remoteAccess?: RemoteAccessDiagnostics;
};

export type ApiErrorBody = {
  error: string;
  message?: string;
  details?: unknown;
  latest?: Pick<RevisionedRecord, "schemaVersion" | "revision" | "updatedAt">;
  issues?: unknown;
};

// --- Assistant chat (mirrors src/api/assistant/conversations.ts) ---
export type AssistantEvent =
  | { type: "turn_started" }
  | { type: "text"; content: string }
  /** Live-only fragment of the reply being streamed (never in the stored transcript). */
  | { type: "text_delta"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "confirmation_required"; actionId: string; category: string; summary: string }
  | { type: "turn_completed" }
  | { type: "error"; message: string };

export type AssistantStoredMessage =
  | { role: "user" | "assistant"; content: string; at: string }
  | { role: "event"; event: AssistantEvent; cursor: string; at: string };

export type AssistantActionDetail = {
  version: 1;
  actionId: string;
  category: string;
  summary: string;
  expiresAt: string;
  /** A proposed file write: the whole new text (at most 16 KB). */
  fileText?: string;
  secure?: {
    kind: "pairing_request";
    requestId: string;
    claimedDisplayName: string;
    claimedPlatform: HelperTarget;
    expiresAt: string;
    sasWords: [string, string, string, string, string];
    sasFingerprint: string;
  };
};

export type AssistantActionConfirmation = {
  version: 1;
  actionId: string;
  category: string;
  status: "completed" | "failed";
  message: string;
  resourceId?: string;
  invitation?: PairInvitation;
};
