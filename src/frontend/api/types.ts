// Types mirror docs/api.md and src/shared/schemas/*.ts.
// They are hand-aligned, not generated. Keep narrow and tolerant.

// A winter catalog provider id (`anthropic`, `openrouter`, …): a plain string, the server validates.
export type ProviderId = string;

/** A curated model route plus an optional reasoning effort from the route's own list (Living cast §9.2). */
export type ModelChoice = {
  providerId: ProviderId;
  modelId: string;
  effort?: string;
};

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
  credentialsConfigured: boolean;
};

export type ModelsResponse = {
  catalogVersion: string;
  maxOutputUsdPerMTok: number;
  models: CuratedModel[];
  hidden: Array<{ id: string; reason: string }>;
};

/**
 * A model notice from `/api/runtime`: `scope` is `waifu:<id>`, `assistant` or `models`; `label` names
 * it for people (her display name); `previous` is the model it had before (`provider/model`);
 * `dismissible` notices can be removed with `api.dismissModelWarnings(scope)`.
 */
export type ModelWarning = { scope: string; label?: string; code: string; detail: string; at?: string; previous?: string; dismissible?: boolean };

export type Revisioned = {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
};

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

export type DiscordRuntime = {
  connected: boolean;
  houseConnected: boolean;
  waifuBotCount: number;
  warnings: string[];
  connecting?: boolean;
  retrying?: boolean;
  retryAttempt?: number;
  nextRetryAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  bots?: DiscordBotConnectionStatus[];
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

export type DiscordBotConnectionStatus = {
  botId: string;
  displayName: string;
  kind: "house" | "waifu";
  state: "connected" | "connecting" | "error" | "disabled" | "missing_token";
  errorCode?:
    | "invalid_token"
    | "disallowed_intents"
    | "invalid_intents"
    | "gateway_rejected"
    | "network"
    | "house_unavailable"
    | "unknown";
  error?: string;
  closeCode?: number;
  nextRetryAt?: string;
  updatedAt: string;
};

export type QueueRuntime = {
  active: number;
  configuredGuilds: number;
};

export type StatusResponse = {
  running: boolean;
  paused: boolean;
  httpUrl: string;
  dataRoot: string;
  discord: DiscordRuntime;
  queues: QueueRuntime;
};

export type RuntimeState = {
  schemaVersion: number;
  pid: number;
  startedAt: string;
  updatedAt: string;
  packageVersion: string;
  port: number;
  dataRoot: string;
  mode: string;
  paused: boolean;
  discord: DiscordRuntime;
  queues: QueueRuntime;
  /** Living cast §9.2: unmapped/unavailable model choices and unpriced routes. */
  models?: { warnings: ModelWarning[] };
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

export type CompactionSettings = {
  enabled: boolean;
  triggerRatio: number;
  maxMessages: number;
  keepRecent: number;
  waitTimeoutMs: number;
};

export type AppConfig = {
  schemaVersion: number;
  http: { host: string; port: number };
  runtime: { autoConnectDiscord: boolean; paused: boolean };
  frontend: { staticDir?: string };
  updates: { enabled: boolean; checkIntervalMinutes: number; idleMinutes: number };
  ocr: {
    enabled: boolean;
    engine: "auto" | "apple-vision" | "bundled-tesseract" | "system-tesseract";
    cacheTtlHours: number;
    timeoutMs: number;
    maxImageBytes: number;
    maxImagesPerModelCall: number;
    maxTextCharsPerImage: number;
  };
  compaction: CompactionSettings;
  models?: { allowed: string[]; maxOutputUsdPerMTok: number };
  life: {
    maxConcurrentTurns: number;
    maxToolRounds: number;
    maxTurnMs: number;
    maxLogMessages: number;
    maxContextTokens: number;
    maxInlineImagesPerEpoch: number;
    maxInlineImageBytesPerEpoch: number;
    maxSendPlacesPerTurn: number;
    maxSendsPerTurn: number;
    maxWakesPerUserPerHour: number;
    maxWatchFiresPerDay: number;
    maxWaifuTriggeredTurns: number;
    maintenanceHourLocal: number;
    webFetch: {
      model: string;
      maxPerWaifuPerDay: number;
      maxPerTurn: number;
      directMaxChars: number;
      maxBytes: number;
      timeoutMs: number;
      maxRedirects: number;
      cacheMinutes: number;
    };
  };
  search: { maxPerSecond: number; maxPerDay: number; maxPerWaifuPerDay: number };
  detector: { target: string };
  discord: {
    images: {
      maxBytes: number;
      fetchTimeoutMs: number;
      memoryCacheMb: number;
      diskCacheMb: number;
      diskCacheTtlHours: number;
    };
    guildMembersIntent: boolean;
    memberListRefreshHours: number;
  };
};

export type AutoUpdateStatus = {
  state: "disabled" | "unsupported" | "checking" | "current" | "waiting_idle" | "installing" | "updated" | "rolled_back" | "failed";
  currentVersion: string; candidateVersion: string | null; lastCheckAt: string | null;
  reason: "none" | "busy" | "disabled" | "credentials_locked" | "check_failed" | "update_failed" | "restart_failed" | "source_checkout";
};

export type DiscordBotConfig = {
  id: string;
  displayName: string;
  applicationId?: string;
  token?: string;
  tokenConfigured?: boolean;
  tokenHint?: string;
  enabled: boolean;
};

export type DiscordBotsFile = Revisioned & {
  orchestrator: DiscordBotConfig | null;
  waifus: DiscordBotConfig[];
};

/** `user/assistant/config.json`: the assistant's own model (unset = first configured waifu's). */
export type AssistantConfig = Revisioned & {
  model?: ModelChoice;
};

export type UpdateAssistantConfigBody = {
  revision?: number;
  /** `null` unsets. */
  model: ModelChoice | null;
};

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

export type WaifuSleepSchedule = {
  enabled: boolean;
  start: string;
  end: string;
};

export type WaifuBusyInterval = {
  start: string;
  end: string;
  reason: string;
};

export type WaifuAvailability = {
  sleep: WaifuSleepSchedule;
  busy: WaifuBusyInterval[];
};

export type WaifuConfig = Revisioned & {
  id: string;
  name: string;
  displayName: string;
  enabled: boolean;
  persona: string;
  model?: ModelChoice;
  botId?: string;
  availability: WaifuAvailability;
  verbosity: WaifuVerbosity;
  customInstructions: string;
  scheduleInPrompt: boolean;
  /** Her names wake her as whole words (Living cast §4.1). */
  wakeOnName: boolean;
  /** Her daily budget in USD for her local day; null = none (Living cast §4.4). */
  life: { dailyBudgetUsd: number | null };
  dm: WaifuDmSettings;
};

export type WaifuVerbosity = "terse" | "chatty" | "expressive";

// rateLimit null = unlimited.
export type WaifuDmSettings = {
  allowDms: boolean;
  rateLimit: { maxReplies: number; windowMinutes: number } | null;
  notifyWhenLimited: boolean;
  limitNotice: string;
  /** Sent once per sleep window when a DM waits for her morning ("" = none, Living cast §4.5). */
  sleepNotice: string;
};

export type WaifusResponse = { waifus: WaifuConfig[] };

export type CreateWaifuBody = {
  name: string;
  displayName: string;
  id?: string;
  enabled?: boolean;
  persona?: string;
  model?: ModelChoice;
  botId?: string;
  availability?: WaifuAvailability;
  verbosity?: WaifuVerbosity;
  customInstructions?: string;
  scheduleInPrompt?: boolean;
  dm?: Partial<Omit<WaifuDmSettings, "rateLimit">> & { rateLimit?: WaifuDmSettings["rateLimit"] };
};

// `model`/`botId` accept explicit `null` on write to mean "unset" (a bare `undefined` field is
// dropped by JSON.stringify and is indistinguishable from "field omitted, leave untouched").
export type UpdateWaifuBody = Partial<
  Omit<WaifuConfig, "schemaVersion" | "updatedAt" | "model" | "botId" | "dm" | "life">
> & {
  revision: number;
  model?: ModelChoice | null;
  botId?: string | null;
  /** Merged into the stored settings: omitted keys keep their value. */
  dm?: Partial<Omit<WaifuDmSettings, "rateLimit">> & { rateLimit?: WaifuDmSettings["rateLimit"] };
  life?: { dailyBudgetUsd?: number | null };
};

export type ChannelConfig = {
  channelId: string;
  name?: string;
  enabledWaifuIds: string[];
  /** Threads and forum posts under this channel: inherit its cast (default) or stay silent. */
  threads?: "inherit" | "off";
};

export type ThreadRecord = {
  threadId: string;
  parentId: string;
  name: string;
  kind: "public_thread" | "private_thread" | "announcement_thread" | "forum_post";
  archived: boolean;
  locked: boolean;
  lastActivityAt: string;
};

export type ThreadsFile = Revisioned & {
  guildId: string;
  threads: Record<string, ThreadRecord>;
};

export type ServerConfig = Revisioned & {
  guildId: string;
  name?: string;
  /** The addressee detector's per-server override: absent inherits, "" turns it off here. */
  detector?: { target: string };
  paused?: boolean;
  channels: Record<string, ChannelConfig>;
};

export type ServersResponse = { servers: ServerConfig[] };

export type UpdateServerBody = Partial<Omit<ServerConfig, "schemaVersion" | "updatedAt" | "guildId">> & {
  revision: number;
};

export type ChannelBody = {
  revision: number;
  name?: string;
  enabledWaifuIds?: string[];
};

export type GuildMemberCacheEntry = {
  userId: string;
  username?: string;
  globalDisplayName?: string;
  guildDisplayName?: string;
  bot: boolean;
  lastSeenAt?: string;
  perChannelLastSeenAt: Record<string, string>;
};

export type GuildMembersFile = Revisioned & {
  guildId: string;
  members: GuildMemberCacheEntry[];
};

export type GuildEmojiCacheEntry = {
  id: string;
  name: string;
  animated: boolean;
  available: boolean;
  roles: string[];
  fetchedAt: string;
};

export type GuildEmojisFile = Revisioned & {
  guildId: string;
  emojis: GuildEmojiCacheEntry[];
};

export type GuildRoleCacheEntry = {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  fetchedAt: string;
};

export type GuildRolesFile = Revisioned & {
  guildId: string;
  roles: GuildRoleCacheEntry[];
};

/** POST /api/people/:userId/forget (Living cast §14.1; L1 runs the DM part). */
export type ForgetUserResult = {
  discordUserId: string;
  dryRun: boolean;
  /** Spec 9.1.4: DM conversations, DM state files and rate-limit counter files removed. */
  dmContexts: number;
  dmStates: number;
  dmLimits: number;
  cachedImages: number;
  /** Parts of the DM/archive job that did not finish (HTTP 202): retried at the next start unless `retried` is false. */
  pending?: Array<{ part: string; error?: string; failures: number; retried: boolean }>;
};

export type ProviderCredentialsBody = {
  apiKey: string;
  label?: string;
  revision?: number;
};

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
  latest?: Pick<Revisioned, "schemaVersion" | "revision" | "updatedAt">;
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
