import { MemoryKind, OrchestratorDecisionHistoryEntry, PendingObservation } from "../shared/schemas/domain.js";
import { ContextMessage, OrchestratorWakeMarker } from "../orchestration/contextMessages.js";
import { OrchestratorDecision } from "../orchestration/decisions.js";
import { DreamOp, StageManagerObservation } from "../orchestration/stageManager.js";
import type { ReviewerDecision } from "../orchestration/tools.js";
import type { BuiltPrompt, ModelCallAttribution } from "../orchestration/context/types.js";
import type { FinishReason, Usage } from "@waifucave/gateway";
import type { LedgerEntry } from "../shared/schemas/context.js";

export type ModelRole = "orchestrator" | "waifu" | "stage_manager" | "reviewer";

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
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  // Phase 4 context engine (spec 8.1). When set, `prompt` is sent verbatim instead of the legacy
  // assembly from `messages`/`systemPrompt`; nothing sets it until the engine is wired (T3/T5).
  prompt?: BuiltPrompt;
  // Who the call is billed to in the usage ledger (spec 8.10).
  attribution?: ModelCallAttribution;
  // Ledger entries behind `prompt`, for fakes and the deterministic fallback.
  transcript?: LedgerEntry[];
};

export type WaifuGenerationRequest = ProviderRequest & {
  // Optional once `prompt` carries the system message; legacy callers still set it.
  systemPrompt?: string;
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
  // Gateway 0.4.0 usage convention (inputTokens includes cache reads/writes; see Usage).
  usage?: Usage;
  finishReason?: FinishReason;
};

export type AssistantTurnEvent =
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string };

export type AssistantTurnRequest = {
  modelId: string;
  /** Full model-facing transcript incl. system prompt and the new user turn. */
  messages: import("@waifucave/gateway").ChatMessage[];
  tools: import("@waifucave/gateway").ToolDef[];
  executeTool: (name: string, argsJson: string) => Promise<string>;
  onEvent?: (event: AssistantTurnEvent) => void;
  params?: Record<string, unknown>;
  /** Hard cap on executed tool calls per turn (default 12). */
  maxToolCalls?: number;
  signal?: AbortSignal;
};

export type AssistantTurnResult = {
  /** Final text reply. */
  content: string;
  /** Transcript with the assistant/tool turns of this turn appended. */
  messages: import("@waifucave/gateway").ChatMessage[];
};

export interface ModelPipeline {
  generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult>;
  decideOrchestrator?(request: ProviderRequest): Promise<OrchestratorDecision>;
  decideStageManagerObservations?(request: StageManagerObserveRequest): Promise<StageManagerObservation[]>;
  decideDream?(request: DreamRequest): Promise<DreamOp[]>;
  decideReviewer?(request: ProviderRequest & { message: string }): Promise<ReviewerDecision>;
  generatePersonaDigest?(request: PersonaDigestRequest): Promise<PersonaDigest>;
  generateAssistantTurn?(request: AssistantTurnRequest): Promise<AssistantTurnResult>;
}
