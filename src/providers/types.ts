import { ProviderId, ReasoningConfig } from "../shared/schemas/domain.js";
import { ContextMessage, OrchestratorNoReplyMarker } from "../orchestration/context.js";
import { OrchestratorDecision, ReplyStyle } from "../orchestration/decisions.js";
import { StageManagerToolCall } from "../orchestration/stageManager.js";
import { ReviewerDecision } from "../orchestration/reviewer.js";
import { WaifuMemory } from "../shared/schemas/domain.js";

export type ModelRole = "orchestrator" | "waifu" | "stage_manager" | "reviewer";

export type ModelCapabilityMetadata = {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  endpoint: string;
  client: "openai-compatible-chat" | "openai-responses" | "anthropic-messages";
  supportedRoles: Array<"system" | "developer" | "user" | "assistant" | "tool">;
  supportsName: boolean;
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
  systemPrompt?: string;
  availableWaifuIds?: string[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
};

export type WaifuGenerationRequest = ProviderRequest & {
  systemPrompt: string;
  sceneDirection?: string;
  replyStyle?: ReplyStyle;
  pickNextWaifuToolEnabled?: boolean;
};

export type StageManagerMemory = {
  memoryIndex: number;
  waifuId: string;
  content: string;
  importance: WaifuMemory["importance"];
};

export type StageManagerRequest = ProviderRequest & {
  memories: StageManagerMemory[];
};

export type WaifuGenerationResult = {
  content: string;
  pickedNextWaifuId?: string;
  rejectedPickNextWaifu?: {
    reason: "malformed" | "unavailable_waifu";
    waifuId?: string;
  };
  usage?: Record<string, number>;
};

export interface ModelPipeline {
  generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult>;
  decideOrchestrator?(request: ProviderRequest): Promise<OrchestratorDecision>;
  decideStageManager?(request: StageManagerRequest): Promise<StageManagerToolCall[]>;
  decideReviewer?(request: ProviderRequest & { message: string }): Promise<ReviewerDecision>;
}
