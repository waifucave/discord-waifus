// Types mirror docs/api.md and src/shared/schemas/*.ts.
// They are hand-aligned, not generated. Keep narrow and tolerant.

// P5 T6: the gateway registry (api/llm.ts) is the source of truth for provider ids now — the
// SPA writes native `params` everywhere, so this stays a plain string rather than a hard-coded
// union of the six legacy-catalog providers.
export type ProviderId = string;

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
  orchestratorConnected: boolean;
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
  kind: "orchestrator" | "waifu";
  state: "connected" | "connecting" | "error" | "disabled" | "missing_token";
  errorCode?:
    | "invalid_token"
    | "disallowed_intents"
    | "invalid_intents"
    | "gateway_rejected"
    | "network"
    | "orchestrator_unavailable"
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
  memory: {
    dreamHourLocal: number;
    maxPinnedInjected: number;
    maxMemoryNotesPerEpoch: number;
    maxInlineImagesPerEpoch: number;
    dmInjectionLimit: number;
  };
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

export type OrchestratorPromptSections = {
  pausePlanning: boolean;
  messageStructure: boolean;
};

export type AgentConfig = Revisioned & {
  enabled: boolean;
  providerId?: ProviderId;
  modelId?: string;
  contextWindow: number;
  prompt: string;
  directiveCooldown: number;
  params: Record<string, unknown>;
  promptSections: OrchestratorPromptSections;
};

// Gateway P6 Task 4: providerId/modelId accept explicit `null` on write to mean "unset" — the
// wire needs to carry that intent (a bare `undefined` field is dropped by JSON.stringify before
// it ever reaches the server and is indistinguishable from "field omitted, leave untouched").
export type UpdateAgentConfigBody = Partial<
  Omit<AgentConfig, "schemaVersion" | "updatedAt" | "providerId" | "modelId">
> & {
  revision: number;
  providerId?: ProviderId | null;
  modelId?: string | null;
};

export type ProviderCredentialStatus =
  | { configured: false }
  | {
      configured: true;
      label?: string;
      updatedAt: string;
      keyHint: string;
    };

// Gateway P6 Task 3: /api/providers is now credentials-status over the full gateway registry
// (all 14 provider ids) — no per-provider model list. The gateway registry itself (models
// included) lives at /api/llm/v1/* (see api/llm.ts).
export type ProviderMetadata = {
  id: ProviderId;
  displayName: string;
  docsUrl?: string;
  credentials: ProviderCredentialStatus;
};

export type ProvidersResponse = {
  revision: number;
  updatedAt: string;
  providers: ProviderMetadata[];
};

export type OrchestratorRespondingWaifu = {
  waifuId: string;
  delaySeconds: number;
  replyToMessageId?: string;
  directive?: { intent: string; goal?: string };
};

export type OrchestratorResponderOutcome = {
  id: string;
  waifuId: string;
  source: "orchestrator" | "handoff";
  handoffFromWaifuId?: string;
  status:
    | "pending"
    | "sent"
    | "tool_only"
    | "empty"
    | "blocked"
    | "unavailable"
    | "interrupted"
    | "failed"
    | "not_run";
  reason?: string;
  directiveStripped?: "cooldown" | "over_cap";
  messageIds: string[];
};

export type OrchestratorDecisionHistoryEntry = {
  id: string;
  guildId?: string;
  channelId?: string;
  action: "reply" | "no_reply";
  respondingWaifus: OrchestratorRespondingWaifu[];
  retriggerAfterSeconds?: number;
  wakePlan?: string;
  reasoning: string;
  status: "pending" | "completed" | "interrupted" | "failed";
  waifuMessageIds: string[];
  responderOutcomes: OrchestratorResponderOutcome[];
  createdAt: string;
};

export type OrchestratorHistoryFile = Revisioned & {
  decisions: OrchestratorDecisionHistoryEntry[];
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

export type WaifuToolSettings = {
  toolUse: boolean;
};

export type ServerToolSettings = {
  pickNextWaifu: boolean;
  shortTermMemory: boolean;
};

export type StageManagerEditHistoryEntry = {
  id: string;
  guildId?: string;
  channelId?: string;
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  affectedMemoryIds: string[];
  summary: string;
  observationCount?: number;
  createdAt: string;
};

export type StageManagerHistoryFile = Revisioned & {
  edits: StageManagerEditHistoryEntry[];
};

export type ReviewerHistoryEntry = {
  id: string;
  guildId?: string;
  channelId?: string;
  reviewerUserId?: string;
  targetMessageIds: string[];
  hallucination: boolean;
  deleted: boolean;
  createdAt: string;
};

export type ReviewerHistoryFile = Revisioned & {
  reviews: ReviewerHistoryEntry[];
};

export type WaifuConfig = Revisioned & {
  id: string;
  name: string;
  displayName: string;
  enabled: boolean;
  persona: string;
  providerId?: ProviderId;
  modelId?: string;
  botId?: string;
  contextWindow: number;
  params: Record<string, unknown>;
  availability: WaifuAvailability;
  tools: WaifuToolSettings;
  verbosity: WaifuVerbosity;
  customInstructions: string;
  scheduleInPrompt: boolean;
  dm: WaifuDmSettings;
  personaDigest?: {
    voice: string;
    role: string;
    personaHash: string;
  };
};

export type WaifuVerbosity = "terse" | "chatty" | "expressive";

// rateLimit null = unlimited.
export type WaifuDmSettings = {
  allowDms: boolean;
  rateLimit: { maxReplies: number; windowMinutes: number } | null;
  notifyWhenLimited: boolean;
  limitNotice: string;
};

export type WaifusResponse = { waifus: WaifuConfig[] };

export type CreateWaifuBody = {
  name: string;
  displayName: string;
  id?: string;
  enabled?: boolean;
  persona?: string;
  providerId?: ProviderId;
  modelId?: string;
  botId?: string;
  contextWindow?: number;
  params?: Record<string, unknown>;
  availability?: WaifuAvailability;
  tools?: WaifuToolSettings;
  verbosity?: WaifuVerbosity;
  customInstructions?: string;
  scheduleInPrompt?: boolean;
  dm?: Partial<Omit<WaifuDmSettings, "rateLimit">> & { rateLimit?: WaifuDmSettings["rateLimit"] };
};

// Gateway P6 Task 4: providerId/modelId accept explicit `null` on write to mean "unset" (see
// UpdateAgentConfigBody above for why `undefined` alone can't carry that intent over the wire).
export type UpdateWaifuBody = Partial<
  Omit<WaifuConfig, "schemaVersion" | "updatedAt" | "providerId" | "modelId" | "botId">
> & {
  revision: number;
  providerId?: ProviderId | null;
  modelId?: string | null;
  botId?: string | null;
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
  orchestratorMode?: "model" | "deterministic" | "one-shot";
  oneShot?: { target: string };
  stageManagerEnabled?: boolean;
  paused?: boolean;
  // Optional overrides (B29): absent = inherit the agent/waifu `contextWindow`.
  contextWindows: {
    orchestrator?: number;
    waifu?: number;
    stageManager?: number;
  };
  compaction?: Partial<CompactionSettings>;
  tools: ServerToolSettings;
  channels: Record<string, ChannelConfig>;
};

export type ServersResponse = { servers: ServerConfig[] };

// `null` per key in contextWindows/compaction = inherit (unset the stored override).
export type UpdateServerBody = Partial<
  Omit<ServerConfig, "schemaVersion" | "updatedAt" | "guildId" | "contextWindows" | "compaction">
> & {
  revision: number;
  contextWindows?: { [K in keyof ServerConfig["contextWindows"]]?: number | null };
  compaction?: { [K in keyof CompactionSettings]?: CompactionSettings[K] | null };
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

export type MemoryStatus = "active" | "archived";
export type MemoryKind = "fact" | "preference" | "relationship" | "event" | "commitment" | "context";
export const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "relationship", "event", "commitment", "context"];
export type MemorySource = "waifu_tool" | "stage_manager" | "dream" | "user";
export const MEMORY_SOURCES: MemorySource[] = ["waifu_tool", "stage_manager", "dream", "user"];

// Memories are global per waifu (spec 8.8): `origin` is provenance only.
export type MemoryOrigin = { guildId?: string; channelId?: string; dm?: true };
export type MemorySubject = { discordUserId?: string; waifuId?: string; name: string };
export type MemoryArchivedReason = "merged" | "expired" | "deduped" | "user" | "unknown_waifu";

export type MemoryRecord = {
  id: string;
  waifuId: string;
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  pinned: boolean;
  strength: number;
  origin: MemoryOrigin;
  subjects: MemorySubject[];
  /** Per-record revision: send it back as `recordRevision` on PUT/DELETE. */
  revision: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt?: string;
  status: MemoryStatus;
  archivedReason?: MemoryArchivedReason;
  mergedInto?: string;
};

export type MemoryStore = Revisioned & {
  memories: MemoryRecord[];
};

export type CreateMemoryBody = {
  revision?: number;
  waifuId: string;
  guildId?: string;
  channelId?: string;
  content: string;
  strength?: number;
  pinned?: boolean;
  kind?: MemoryKind;
  subjects?: MemorySubject[];
};

/** POST /api/memories answers the full store, plus `duplicateOf` when the write looked like one. */
export type CreateMemoryResponse = MemoryStore & { duplicateOf?: string };

export type UpdateMemoryBody = {
  /** Preferred: the record's own revision. */
  recordRevision?: number;
  /** Legacy store-wide revision. */
  revision?: number;
  content?: string;
  strength?: number;
  pinned?: boolean;
  kind?: MemoryKind;
  subjects?: MemorySubject[];
  status?: MemoryStatus;
};

export type ForgetUserResult = {
  discordUserId: string;
  dryRun: boolean;
  memories: number;
  observations: number;
  ledgers: number;
  ledgerEntries: number;
  /** Spec 9.1.4: DM conversations, DM state files and rate-limit counter files removed. */
  dmContexts: number;
  dmStates: number;
  dmLimits: number;
  cachedImages: number;
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
    orchestratorConfigured: boolean;
    orchestratorApplicationId?: string;
    waifuBotCount: number;
    configuredWaifuBotCount: number;
  };
  orchestrator: {
    revision: number;
    providerId?: ProviderId;
    modelId?: string;
    contextWindow: number;
    promptLength: number;
  };
  stageManager: {
    revision: number;
    providerId?: ProviderId;
    modelId?: string;
    contextWindow: number;
    promptLength: number;
  };
  memories: { revision: number; count: number };
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
