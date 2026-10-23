import { MemoryKind, PendingObservation } from "../shared/schemas/domain.js";
import { ContextMessage } from "../orchestration/contextMessages.js";
import { OrchestratorDecision } from "../orchestration/decisions.js";
import { DreamOp, ObserverOp, StageManagerObservation } from "../orchestration/stageManager.js";
import type { ReviewerDecision } from "../orchestration/tools.js";
import type { BuiltPrompt, ModelCallAttribution, SummaryResult } from "../orchestration/context/types.js";
import type { FinishReason, ToolChoice, Usage } from "@waifucave/gateway";
import type { LedgerEntry } from "../shared/schemas/context.js";

export type ModelRole = "orchestrator" | "waifu" | "stage_manager" | "reviewer";

export type ProviderRequest = {
  modelId: string;
  messages: ContextMessage[];
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
  // assembly from `messages`/`systemPrompt`. decideOrchestrator requires it (T5); `messages` then
  // carries the same transcript adapted for fakes and heuristics.
  prompt?: BuiltPrompt;
  // Who the call is billed to in the usage ledger (spec 8.10).
  attribution?: ModelCallAttribution;
  // Ledger entries behind `prompt`, for fakes and the deterministic fallback.
  transcript?: LedgerEntry[];
  // Called with the provider-reported usage of a successful decision call (decisions return only
  // the decision; the caller commits usage to its context for calibration, spec 8.9).
  onUsage?: (usage: Usage) => void;
};

// Spec 8.5: the waifu call sends `prompt` (the context engine's BuiltPrompt) verbatim; its tools
// are listed in `prompt.tools`. `availableWaifuIds` validates a PickNextWaifu call.
export type WaifuGenerationRequest = Omit<ProviderRequest, "messages"> & {
  messages?: ContextMessage[];
  stopSequences?: string[];
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
  subjects?: string[]; // current names of the people the memory is about
};

export type DreamRequest = ProviderRequest & {
  memories: DreamMemoryInput[];
  observations: PendingObservation[];
  availableWaifuIds?: string[];
};

export type StageManagerObserveRequest = ProviderRequest & {
  availableWaifuIds?: string[];
  // Rendered observer input (participants, existing memories m1..mN, transcript since the
  // per-conversation cursor). When absent the legacy `messages` window is formatted instead.
  observerInput?: string;
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
  // Every tool call of the response (recorded as `tool` context notes).
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
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
  // Legacy observations (no `op`) are still accepted and normalized into `add` ops.
  decideStageManagerObservations?(request: StageManagerObserveRequest): Promise<Array<ObserverOp | StageManagerObservation>>;
  decideDream?(request: DreamRequest): Promise<DreamOp[]>;
  decideReviewer?(request: ProviderRequest & { message: string; authorName?: string }): Promise<ReviewerDecision>;
  generatePersonaDigest?(request: PersonaDigestRequest): Promise<PersonaDigest>;
  generateAssistantTurn?(request: AssistantTurnRequest): Promise<AssistantTurnResult>;
  /**
   * Own-model context compaction (spec 8.9): the summary text (tool calls ignored) and the finish
   * reason. A `length` finish is retried once with a doubled cap; if it is still `length`, the
   * caller must not store the text.
   */
  summarizeContext?(request: SummarizeContextRequest): Promise<SummaryResult>;
}

/**
 * A context's summarize call (spec 8.9). `prompt` is sent through breakpoint C with its tools, and
 * the instruction replaces the ephemeral tail. Everything else mirrors the agent's REPLY call so
 * the provider's prompt cache hits: same `toolChoice` (waifus `auto`; a forced tool such as the
 * orchestrator's becomes `none` where supported, else `auto`), same params/sampling. Only the
 * output cap differs (see compactionMaxOutputTokens; max_tokens is not part of the cache key) and
 * stop sequences are not sent.
 */
export type SummarizeContextRequest = {
  prompt: BuiltPrompt;
  instruction: string;
  /** The reply call's tool choice (default `auto` when the prompt has tools). */
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  /** The reply call's output cap (its sampling `maxOutputTokens`), if any. */
  maxOutputTokens?: number;
  params?: Record<string, unknown>;
  /** Attribution of the reply call; the ledger purpose is always `compaction`. */
  attribution?: Omit<ModelCallAttribution, "purpose">;
  signal?: AbortSignal;
};
