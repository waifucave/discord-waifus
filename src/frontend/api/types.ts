// Types mirror docs/api.md and src/shared/schemas/*.ts.
// They are hand-aligned, not generated. Keep narrow and tolerant.

export type ProviderId = "xai" | "deepseek" | "anthropic" | "openai" | "zai" | "google-ai-studio";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "max" | "xhigh";

export type ReasoningConfig = {
  enabled?: boolean;
  effort?: ReasoningEffort;
  budgetTokens?: number;
};

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
};

export type AppConfig = {
  schemaVersion: number;
  http: { host: string; port: number };
  runtime: { autoConnectDiscord: boolean; paused: boolean };
  frontend: { staticDir?: string };
  ocr: {
    enabled: boolean;
    engine: "auto" | "apple-vision" | "bundled-tesseract" | "system-tesseract";
    cacheTtlHours: number;
    timeoutMs: number;
    maxImageBytes: number;
    maxImagesPerModelCall: number;
    maxTextCharsPerImage: number;
  };
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

export type UpdateAgentConfigBody = Partial<Omit<AgentConfig, "schemaVersion" | "updatedAt">> & {
  revision: number;
};

export type ModelCapability = {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  endpoint: string;
  client: "openai-compatible-chat" | "openai-responses" | "anthropic-messages" | "google-generative-language";
  supportedRoles: string[];
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  supportsImageInput: boolean;
  reasoningControls: string[];
  maxContextTokens?: number;
  maxOutputTokens?: number;
  defaultTemperature?: number;
  defaultTopP?: number;
  safeDefaultRoles: ("orchestrator" | "waifu" | "stage_manager" | "reviewer")[];
};

export type ProviderCredentialStatus =
  | { configured: false }
  | {
      configured: true;
      label?: string;
      updatedAt: string;
      keyHint: string;
    };

export type ProviderMetadata = {
  id: ProviderId;
  displayName: string;
  credentialName: string;
  baseUrl: string;
  docsUrl: string;
  models: ModelCapability[];
  credentials: ProviderCredentialStatus;
};

export type ProvidersResponse = {
  revision: number;
  updatedAt: string;
  providers: ProviderMetadata[];
};

export type ModelsResponse = {
  models: ModelCapability[];
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

// Mirror of WaifuPromptLayoutSchema in src/shared/schemas/domain.ts. Controls which prompt blocks
// land in each of the three model-message slots, their order, and how they are grouped. Block
// wording is fixed in code (see src/orchestration/promptBlocks.ts).
export type PromptLayoutBlockNode = {
  kind: "block";
  blockId: string;
  enabled: boolean;
};

export type PromptLayoutGroupNode = {
  kind: "group";
  id: string;
  tag: string;
  enabled: boolean;
  children: PromptLayoutBlockNode[];
};

export type PromptLayoutNode = PromptLayoutBlockNode | PromptLayoutGroupNode;

export type WaifuPromptLayout = {
  top: PromptLayoutNode[];
  mid: PromptLayoutNode[];
  trailing: PromptLayoutNode[];
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
  promptLayout: WaifuPromptLayout;
  personaDigest?: {
    voice: string;
    role: string;
    personaHash: string;
  };
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
  promptLayout?: WaifuPromptLayout;
};

export type UpdateWaifuBody = Partial<Omit<WaifuConfig, "schemaVersion" | "updatedAt">> & {
  revision: number;
};

export type ChannelConfig = {
  channelId: string;
  name?: string;
  enabled: boolean;
  enabledWaifuIds: string[];
};

export type ServerConfig = Revisioned & {
  guildId: string;
  name?: string;
  enabled: boolean;
  contextWindows: {
    orchestrator: number;
    waifu: number;
    stageManager: number;
  };
  tools: ServerToolSettings;
  channels: Record<string, ChannelConfig>;
};

export type ServersResponse = { servers: ServerConfig[] };

export type UpdateServerBody = Partial<Omit<ServerConfig, "schemaVersion" | "updatedAt" | "guildId">> & {
  revision: number;
};

export type ChannelBody = {
  revision: number;
  name?: string;
  enabled: boolean;
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

export type MemoryRecord = {
  id: string;
  guildId: string;
  channelId?: string;
  waifuId: string;
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  pinned: boolean;
  strength: number;
  entities: string[];
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt?: string;
  status: MemoryStatus;
};

export type MemoryStore = Revisioned & {
  memories: MemoryRecord[];
};

export type CreateMemoryBody = {
  revision?: number;
  waifuId: string;
  guildId: string;
  content: string;
  strength?: number;
  pinned?: boolean;
  kind?: MemoryKind;
};

export type UpdateMemoryBody = Partial<CreateMemoryBody> & {
  revision: number;
  status?: MemoryStatus;
};

export type ProviderCredentialsBody = {
  apiKey: string;
  label?: string;
  revision?: number;
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
};

export type ApiErrorBody = {
  error: string;
  message?: string;
  details?: unknown;
  latest?: unknown;
  issues?: unknown;
};
