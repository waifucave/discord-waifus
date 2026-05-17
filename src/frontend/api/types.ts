// Types mirror docs/api.md and src/shared/schemas/*.ts.
// They are hand-aligned, not generated. Keep narrow and tolerant.

export type ProviderId = "xai" | "deepseek" | "anthropic" | "openai" | "zai";

export type ReasoningEffort = "low" | "medium" | "high";

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

export type AgentConfig = Revisioned & {
  enabled: boolean;
  providerId?: ProviderId;
  modelId?: string;
  contextWindow: number;
  prompt: string;
  reasoning: ReasoningConfig;
};

export type ModelCapability = {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  endpoint: string;
  client: "openai-compatible-chat" | "openai-responses" | "anthropic-messages";
  supportedRoles: string[];
  supportsName: boolean;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
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

export type OrchestratorDecisionHistoryEntry = {
  id: string;
  guildId?: string;
  channelId?: string;
  action: "waifus" | "stage_manager" | "reviewer" | "no_reply";
  selectedWaifuIds: string[];
  reasoning: string;
  sceneDirections: string[];
  retriggerAfterSeconds?: number;
  createdAt: string;
};

export type OrchestratorHistoryFile = Revisioned & {
  decisions: OrchestratorDecisionHistoryEntry[];
};

export type StageManagerEditHistoryEntry = {
  id: string;
  guildId?: string;
  channelId?: string;
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  affectedMemoryIds: string[];
  summary: string;
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
  generation: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
  };
  reasoning: ReasoningConfig;
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
  generation?: WaifuConfig["generation"];
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

export type MemoryScope = "global" | "guild" | "channel" | "user";
export type MemoryStatus = "active" | "archived";
export type MemoryImportance = 1 | 2 | 3 | 4 | 5;

export type WaifuMemory = {
  id: string;
  waifuId: string;
  scope: MemoryScope;
  content: string;
  importance: MemoryImportance;
  createdAt: string;
  updatedAt: string;
  sourceMessageIds: string[];
  status: MemoryStatus;
};

export type MemoryStore = Revisioned & {
  memories: WaifuMemory[];
};

export type CreateMemoryBody = {
  revision?: number;
  waifuId: string;
  scope: MemoryScope;
  content: string;
  importance: MemoryImportance;
  sourceMessageIds?: string[];
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
