import { EventEmitter } from "node:events";

export interface ChatMessageEvent {
  channelId: string;
  id: string;
  content: string;
  authorName: string;
  authorAvatar: string | null;
  isWaifu: boolean;
  waifuId: string | null;
  timestamp: string;
}

export interface OrchestratorDecisionEvent {
  channelId: string;
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

export interface GenerationStartEvent {
  channelId: string;
  waifuId: string;
  waifuName: string;
  responseIndex: number;
  replyStyle: "normal" | "short" | "long" | "sleepy";
  delaySeconds: number;
  replyToMessageId: string | null;
  sceneDirection: string | null;
}

export interface GenerationTokenEvent {
  channelId: string;
  waifuId: string;
  token: string;
  totalTokens: number;
}

export interface GenerationCompleteEvent {
  channelId: string;
  waifuId: string;
  content: string;
  tokenCount: number;
  durationMs: number;
  responseIndex: number;
  messageId: string;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  rawContent: string;
}

export interface GenerationCancelledEvent {
  channelId: string;
  waifuId?: string;
  reason: string;
}

export interface StageManagerScheduledEvent {
  channelId: string;
  runAt: string;
  reason: "quiet" | "manual" | "startup_reconciliation";
  timestamp: string;
}

export interface StageManagerStartEvent {
  channelId: string;
  trigger: "quiet" | "manual" | "startup_reconciliation";
  messageCount: number;
  newMessageCount: number;
  snapshotLastMessageId: string | null;
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

export interface StageManagerErrorEvent {
  channelId: string;
  trigger: "quiet" | "manual" | "startup_reconciliation";
  error: string;
  timestamp: string;
}

interface RuntimeEventMap {
  "chat:message": [ChatMessageEvent];
  "orchestrator:decision": [OrchestratorDecisionEvent];
  "generation:start": [GenerationStartEvent];
  "generation:token": [GenerationTokenEvent];
  "generation:complete": [GenerationCompleteEvent];
  "generation:cancelled": [GenerationCancelledEvent];
  "stage-manager:scheduled": [StageManagerScheduledEvent];
  "stage-manager:start": [StageManagerStartEvent];
  "stage-manager:complete": [StageManagerCompleteEvent];
  "stage-manager:error": [StageManagerErrorEvent];
  "config:reloaded": [{ changedPath: string; timestamp: string }];
}

export class RuntimeEventBus extends EventEmitter<RuntimeEventMap> {}
