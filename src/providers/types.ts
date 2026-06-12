import { MemoryKind, OrchestratorDecisionHistoryEntry, PendingObservation, ProviderId, ReasoningConfig } from "../shared/schemas/domain.js";
import { ContextMessage, OrchestratorWakeMarker } from "../orchestration/context.js";
import { OrchestratorDecision } from "../orchestration/decisions.js";
import { DreamOp, StageManagerObservation } from "../orchestration/stageManager.js";
import { ReviewerDecision } from "../orchestration/reviewer.js";

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
  decisionMarkers?: OrchestratorWakeMarker[];
  pastDecisions?: OrchestratorDecisionHistoryEntry[];
  trailingPrompt?: string;
  systemPrompt?: string;
  availableWaifuIds?: string[];
  replyRequired?: boolean;
  directiveBudgetOpen?: boolean;
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
  retryUserMessage?: string;
  pickNextWaifuToolEnabled?: boolean;
  shortTermMemoryToolEnabled?: boolean;
  stopSequences?: string[];
  // Discord author ids that are THIS waifu. In practice the bot user id only —
  // Discord's message.author.id is always the user id, never the application id.
  // Only these messages become assistant turns; everything else is a user turn.
  selfAuthorIds?: string[];
};

// One memory record presented to the dream pass. memoryIndex is 1-based WITHIN the current
// chunk; the runtime maps it back to the stored record id when applying ops.
export type DreamMemoryInput = {
  memoryIndex: number;
  waifuId: string;
  content: string;
  kind: MemoryKind;
  strength: number;
  ageDays: number;
  daysSinceRetrieved: number;
  expiresInHours?: number; // notes only
};

export type DreamRequest = ProviderRequest & {
  memories: DreamMemoryInput[];
  observations: PendingObservation[];
  availableWaifuIds?: string[];
};

export type StageManagerObserveRequest = ProviderRequest & {
  availableWaifuIds?: string[];
};

export type PersonaDigest = { voice: string; role: string };
export type PersonaDigestRequest = ProviderRequest & { personaText: string };

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
  decideDream?(request: DreamRequest): Promise<DreamOp[]>;
  decideReviewer?(request: ProviderRequest & { message: string }): Promise<ReviewerDecision>;
  generatePersonaDigest?(request: PersonaDigestRequest): Promise<PersonaDigest>;
}
