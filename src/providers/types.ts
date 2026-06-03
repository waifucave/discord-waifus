import { OrchestratorDecisionHistoryEntry, ProviderId, ReasoningConfig } from "../shared/schemas/domain.js";
import { ContextMessage, OrchestratorNoReplyMarker } from "../orchestration/context.js";
import { OrchestratorDecision, ReplyStyle } from "../orchestration/decisions.js";
import { StageManagerObservation, StageManagerToolCall } from "../orchestration/stageManager.js";
import { ReviewerDecision } from "../orchestration/reviewer.js";
import { WaifuMemory } from "../shared/schemas/domain.js";

export type ModelRole = "orchestrator" | "waifu" | "stage_manager" | "reviewer";

export type ModelCapabilityMetadata = {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  endpoint: string;
  client: "openai-compatible-chat" | "openai-responses" | "anthropic-messages" | "google-generative-language";
  supportedRoles: Array<"system" | "developer" | "user" | "assistant" | "tool" | "model">;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  supportsImageInput: boolean;
  reasoningControls: string[];
  maxContextTokens?: number;
  maxOutputTokens?: number;
  defaultTemperature?: number;
  defaultTopP?: number;
  safeDefaultRoles: ModelRole[];
};

export type ProviderMetadata = {
  id: ProviderId;
  displayName: string;
  credentialName: string;
  baseUrl: string;
  docsUrl: string;
  models: ModelCapabilityMetadata[];
};

export type ProviderRequest = {
  modelId: string;
  messages: ContextMessage[];
  decisionMarkers?: OrchestratorNoReplyMarker[];
  pastDecisions?: OrchestratorDecisionHistoryEntry[];
  trailingPrompt?: string;
  systemPrompt?: string;
  availableWaifuIds?: string[];
  replyRequired?: boolean;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
};

export type WaifuGenerationRequest = ProviderRequest & {
  systemPrompt: string;
  midSystemBlock?: string;
  trailingSystemBlock?: string;
  replyStyle?: ReplyStyle;
  pickNextWaifuToolEnabled?: boolean;
  shortTermMemoryToolEnabled?: boolean;
  stopSequences?: string[];
};

export type StageManagerMemory = {
  memoryIndex: number;
  waifuId: string;
  content: string;
  importance: WaifuMemory["importance"];
};

export type StageManagerRequest = ProviderRequest & {
  memories: StageManagerMemory[];
  availableWaifuIds?: string[];
  observations?: StageManagerObservation[];
};

export type StageManagerObserveRequest = ProviderRequest & {
  availableWaifuIds?: string[];
};

export type WaifuGenerationResult = {
  content: string;
  pickedNextWaifuId?: string;
  rejectedPickNextWaifu?: {
    reason: "malformed" | "unavailable_waifu";
    waifuId?: string;
  };
  shortTermMemoryEntries?: string[];
  usage?: Record<string, number>;
};

export interface ModelPipeline {
  generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult>;
  decideOrchestrator?(request: ProviderRequest): Promise<OrchestratorDecision>;
  decideStageManagerObservations?(request: StageManagerObserveRequest): Promise<StageManagerObservation[]>;
  decideStageManager?(request: StageManagerRequest): Promise<StageManagerToolCall[]>;
  decideReviewer?(request: ProviderRequest & { message: string }): Promise<ReviewerDecision>;
}
