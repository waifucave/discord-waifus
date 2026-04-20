export interface ProviderConfig {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic";
  origin: "built-in" | "custom";
  authMode: "required" | "none";
  baseUrl: string;
  enabled: boolean;
  models: string[];
  keyValue: string;
  hasKey: boolean;
  isBuiltIn: boolean;
  canDelete: boolean;
  isRuntimeCallable: boolean;
  runtimeErrors: string[];
}

export interface WaifuDocument {
  id: string;
  name: string;
  displayName: string;
  botToken: string;
  applicationId: string;
  enabled: boolean;
  avatarPath: string | null;
  bannerPath: string | null;
  statusText: string | null;
  statusType: "online" | "idle" | "dnd" | "invisible";
  personality: {
    description: string;
    traits: string[];
    speechPatterns: string[];
    likes: string[];
    dislikes: string[];
    backstory: string;
    quirks: string[];
    relationshipsWithOtherWaifus: Record<string, string>;
  };
  schedule: {
    sleepTime: { start: string; end: string };
    busyTime: { start: string; end: string; reason: string };
  };
  ai: {
    providerId: string;
    model: string;
    temperature: number;
    repetitionPenalty: number;
    maxTokens: number;
    systemPromptOverride: string | null;
  };
}

export type WaifuConfig = WaifuDocument;

export interface MigrationWarning {
  code: string;
  field: string;
  message: string;
  legacyValue?: string;
  createdAt: string;
}

export interface WaifuEditorMeta {
  isDraft: boolean;
  isDiscordReady: boolean;
  isAiReady: boolean;
  isChatReady: boolean;
  isRuntimeReady: boolean;
  runtimeValidationErrors: string[];
  migrationWarnings: MigrationWarning[];
}

export interface StageManagerRelationshipEditorEntry {
  participantKey: string;
  targetKind: "user" | "waifu";
  targetName: string;
  targetUserId: string | null;
  targetWaifuId: string | null;
  relationship: string;
  updatedAt: string;
}

export interface StageManagerMemoryEditorEntry {
  slot: number;
  note: string;
  sourceMessageIds: string[];
  updatedAt: string;
}

export interface StageManagerGuildEditorState {
  guildId: string;
  relationships: StageManagerRelationshipEditorEntry[];
  memories: StageManagerMemoryEditorEntry[];
}

export interface WaifuStageManagerEditorDocument {
  guilds: StageManagerGuildEditorState[];
}

export interface WaifuEditorPayload {
  waifu: WaifuDocument;
  stageManager: WaifuStageManagerEditorDocument;
  meta: WaifuEditorMeta;
}

export interface WaifuEditorWritePayload {
  waifu: WaifuDocument;
  stageManager: WaifuStageManagerEditorDocument;
}

export interface InvalidWaifuRow {
  filePath: string;
  idHint: string | null;
  error: string;
  migrationWarnings: MigrationWarning[];
}

export interface ChannelConfig {
  guildId: string;
  channelId: string;
  channelName: string;
  enabled: boolean;
  activeWaifuIds: string[];
  availableEmojis?: string[];
  availableGuildMembers?: Array<{
    id: string;
    displayName: string;
    username: string;
    globalName: string | null;
    bot: boolean;
  }>;
  contextAnchorMessageId: string | null;
  contextMessageCount: number;
  idleChatterEnabled: boolean;
  idleTimerMinSeconds: number;
  idleTimerMaxSeconds: number;
}

export interface StatusResponse {
  uptimeSeconds: number;
  bots: Array<{ waifuId: string; ready: boolean; userId: string | null }>;
  activeGenerations: Array<{ channelId: string; waifuId?: string }>;
  stageManager: {
    scheduledChannels: Array<{
      channelId: string;
      runAt: string;
      reason: "quiet" | "manual" | "startup_reconciliation";
    }>;
    runningChannels: string[];
    dirtyChannels: string[];
  };
  configSummary: {
    waifus: number;
    providers: number;
    channels: number;
  };
}

export interface OrchestratorConfig {
  providerId: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface StageManagerConfig {
  enabled: boolean;
  providerId: string | null;
  model: string | null;
  temperature: number;
  maxTokens: number;
  quietPeriodSeconds: number;
  historyLimit: number;
  maxRelationshipsPerWaifu: number;
  maxMemoriesPerWaifu: number;
}

export interface StageManagerRelationshipEntry {
  targetKind: "user" | "waifu";
  targetName: string;
  targetUserId: string | null;
  targetWaifuId: string | null;
  relationship: string;
  updatedAt: string;
}

export interface StageManagerMemoryNote {
  slot: number;
  note: string;
  sourceMessageIds: string[];
  updatedAt: string;
}

export interface StageManagerWaifuState {
  relationshipsByParticipant: Record<string, StageManagerRelationshipEntry>;
  memories: StageManagerMemoryNote[];
}

export interface StageManagerChannelState {
  lastProcessedMessageId: string | null;
  lastRunAt: string | null;
}

export interface StageManagerState {
  waifus: Record<string, StageManagerWaifuState>;
  channels: Record<string, StageManagerChannelState>;
}

export interface StageManagerRuntimeState {
  scheduledChannels: Array<{
    channelId: string;
    runAt: string;
    reason: "quiet" | "manual" | "startup_reconciliation";
  }>;
  runningChannels: string[];
  dirtyChannels: string[];
}

export interface StageManagerGuildDiagnostics {
  guildId: string;
  checkpoint: {
    lastProcessedMessageId: string | null;
    lastRunAt: string | null;
  };
  channels: Array<{
    channelId: string;
    channelName: string;
    enabled: boolean;
    activeWaifuIds: string[];
  }>;
  waifus: Array<{
    waifuId: string;
    displayName: string;
    relationships: StageManagerRelationshipEditorEntry[];
    memories: StageManagerMemoryEditorEntry[];
  }>;
}

export interface StageManagerDiagnosticsState {
  guilds: StageManagerGuildDiagnostics[];
}

export interface StageManagerDiagnosticsRuntime {
  scheduledGuilds: Array<{
    guildId: string;
    runAt: string;
    reason: "quiet" | "manual" | "startup_reconciliation";
    channelIds: string[];
  }>;
  runningGuilds: string[];
  dirtyGuilds: string[];
}

export interface StageManagerRunSummary {
  decision: {
    relationshipUpdates: Array<{
      waifuId: string;
      targetParticipantKey: string;
      relationship: string;
    }>;
    memoryUpdates: Array<{
      waifuId: string;
      slot: number | null;
      note: string;
      sourceMessageIds: string[];
    }>;
    reasoning: string;
  };
  applied: {
    relationshipUpdateCount: number;
    memoryUpdateCount: number;
    affectedWaifuIds: string[];
    affectedParticipantKeys: string[];
  };
  snapshotLastMessageId: string | null;
  messageCount: number;
  newMessageCount: number;
  noOp: boolean;
  usedFallbackModel: boolean;
}

export interface DebugResponse {
  uptimeSeconds: number;
  listener: {
    listenerBotId: string | null;
    knownBotUserIds: Array<{ waifuId: string; userId: string }>;
    reconnectAttempts: Array<{ waifuId: string; attempts: number }>;
  };
  bots: Array<{ waifuId: string; ready: boolean; userId: string | null }>;
  config: {
    waifus: Array<{
      id: string;
      displayName: string;
      enabled: boolean;
      providerId: string;
      model: string;
    }>;
    channels: Array<{
      channelId: string;
      channelName: string;
      enabled: boolean;
      activeWaifuIds: string[];
      contextAnchorMessageId: string | null;
    }>;
    orchestrator: OrchestratorConfig;
    stageManager: StageManagerConfig;
  };
  recentEvents: Array<{
    timestamp: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
}

export interface ChatMessageEvent {
  id: string;
  content: string;
  authorName: string;
  authorAvatar: string | null;
  isWaifu: boolean;
  waifuId: string | null;
  timestamp: string;
}

export interface OrchestratorDecisionEvent {
  action: "reply" | "no_reply";
  respondingWaifus: Array<{
    waifuId: string;
    delaySeconds: number;
    replyStyle: "normal" | "short" | "long" | "sleepy";
    sceneDirection: string | null;
  }>;
  directInteraction: {
    waifuId: string;
    delaySeconds: number;
    emoji: string;
  } | null;
  reasoning: string;
  retriggerAfterSeconds: number | null;
  timestamp: string;
}

export interface StageManagerScheduledEvent {
  channelId: string;
  runAt: string;
  reason: "quiet" | "manual" | "startup_reconciliation";
  timestamp: string;
}

export interface StageManagerCompleteEvent {
  channelId: string;
  trigger: "quiet" | "manual" | "startup_reconciliation";
  relationshipUpdateCount: number;
  memoryUpdateCount: number;
  affectedWaifuIds: string[];
  affectedParticipantKeys: string[];
  reasoning: string;
  checkpointMessageId: string | null;
  snapshotLastMessageId: string | null;
  noOp: boolean;
  usedFallbackModel: boolean;
  timestamp: string;
}
