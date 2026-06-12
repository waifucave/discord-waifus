import { z } from "zod";
import { AttachmentImage, ContextMessage, formatObserverContext, formatOrchestratorMessageBlock, formatSelfWaifuContent, formatTimestamp, formatWaifuContextBlock, OrchestratorWakeMarker } from "../orchestration/context.js";
import {
  OrchestratorActionSchema,
  OrchestratorDecision,
  OrchestratorDecisionSchema,
  Directive,
  MODEL_DIRECTIVE_INTENTS,
  RETRIGGER_MIN_SECONDS,
  RETRIGGER_MAX_SECONDS,
} from "../orchestration/decisions.js";
import { ReviewerDecision, ReviewerDecisionSchema } from "../orchestration/reviewer.js";
import {
  DreamOp,
  DreamOpSchema,
  OBSERVATION_KINDS,
  StageManagerObservation,
  StageManagerObservationSchema
} from "../orchestration/stageManager.js";
import { MemoryKindSchema, OrchestratorDecisionHistoryEntry, ReasoningConfig } from "../shared/schemas/domain.js";
import {
  ORCHESTRATOR_TOOL_NAME,
  SHORT_TERM_MEMORY_TOOL_NAME,
  PICK_NEXT_WAIFU_TOOL_NAME,
  DREAM_TOOL_NAME,
  OBSERVER_TOOL_NAME,
  PERSONA_DIGEST_TOOL_NAME,
  REVIEWER_TOOL_NAME,
  PERSONA_DIGEST_PROMPT,
  DREAM_PROMPT,
  observerSystemPrompt,
  reviewerSystemPrompt,
  orchestratorToolParameters,
  pickNextWaifuToolParameters,
  shortTermMemoryToolParameters,
  dreamToolParameters,
  flatDreamToolParameters,
  observerToolParameters,
  PERSONA_DIGEST_TOOL_PARAMETERS,
  REVIEWER_TOOL_PARAMETERS,
  googleAiStudioSchema,
} from "../orchestration/tools.js";
import { getModel, getProviderForModel } from "./catalog.js";
import {
  ModelCapabilityMetadata,
  ModelPipeline,
  PersonaDigest,
  PersonaDigestRequest,
  ProviderMetadata,
  ProviderRequest,
  DreamRequest,
  StageManagerObserveRequest,
  WaifuGenerationRequest,
  WaifuGenerationResult
} from "./types.js";
import { QueryRole, recordProviderQuery, recordProviderReply } from "../shared/queryLog.js";
import {
  OrchestratorTimelineItem,
  buildOrchestratorTimeline,
  serializeOrchestratorDecisionArguments,
  formatDecisionOutcome
} from "../orchestration/pipeline/timeline.js";

export class ProviderPipelineError extends Error {
  constructor(
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ProviderPipelineError";
  }
}

export type PipelineCredentials = {
  apiKey: string;
};

export function createModelPipeline(modelId: string, credentials: PipelineCredentials): ModelPipeline {
  const model = getModel(modelId);
  const provider = getProviderForModel(modelId);
  if (!model || !provider) {
    throw new ProviderPipelineError(`Unknown model ${modelId}.`);
  }
  switch (model.client) {
    case "openai-compatible-chat":
      return new OpenAiCompatibleChatPipeline(provider, model, credentials.apiKey);
    case "openai-responses":
      return new OpenAiResponsesPipeline(provider, model, credentials.apiKey);
    case "anthropic-messages":
      return new AnthropicMessagesPipeline(provider, model, credentials.apiKey);
    case "google-generative-language":
      return new GoogleGenerativeLanguagePipeline(provider, model, credentials.apiKey);
  }
}

class OpenAiCompatibleChatPipeline implements ModelPipeline {
  constructor(
    private readonly provider: ProviderMetadata,
    private readonly model: ModelCapabilityMetadata,
    private readonly apiKey: string
  ) {}

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    throwIfAborted(request.signal);
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const reasoning = openAiChatReasoningForWaifu(this.model, request);
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: request.systemPrompt },
          ...injectMemoriesIntoChatContext(
            contextToChatMessagesForWaifu(request.messages, this.model.supportsImageInput, request.selfAuthorIds ?? []),
            request.midSystemBlock ? { role: "system", content: request.midSystemBlock } : undefined
          ),
          ...(request.trailingSystemBlock ? [{ role: "system", content: request.trailingSystemBlock }] : []),
          ...(request.retryUserMessage ? [{ role: "user", content: request.retryUserMessage }] : [])
        ]),
        temperature: openAiChatTemperature(this.model, request.temperature ?? this.model.defaultTemperature),
        top_p: openAiChatTopP(this.model, request.topP ?? this.model.defaultTopP),
        max_tokens: request.maxOutputTokens,
        ...openAiChatWaifuToolsPayload(this.model, request),
        stop: openAiChatStopSequences(this.model, reasoning, request.stopSequences),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatWaifuResult(json, request.availableWaifuIds),
      queryRole: "waifu"
    });
    return result;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, buildOpenAiChatOrchestratorMessages({
          model: this.model,
          systemPrompt: request.systemPrompt ?? "",
          messages: request.messages,
          decisions: request.pastDecisions ?? [],
          markers: request.decisionMarkers,
          trailingPrompt: request.trailingPrompt ?? ""
        })),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0.2),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatOrchestratorTool(request.availableWaifuIds, request.replyRequired, request.directiveBudgetOpen ?? true)],
        tool_choice: openAiChatForcedToolChoice(this.model, ORCHESTRATOR_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds) },
          { role: "user", content: formatObserverContext(request.messages, new Date()) }
        ]),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0.2),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatObserverTool(request.availableWaifuIds)],
        tool_choice: openAiChatForcedToolChoice(this.model, OBSERVER_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, OBSERVER_TOOL_NAME),
      queryRole: "stage_manager_observer"
    });
    return parseStageManagerObservations(text);
  }

  async decideDream(request: DreamRequest): Promise<DreamOp[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: DREAM_PROMPT },
          ...dreamMessages(request)
        ]),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0.2),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatDreamTool(request.availableWaifuIds)],
        tool_choice: openAiChatForcedToolChoice(this.model, DREAM_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, DREAM_TOOL_NAME),
      queryRole: "dream"
    });
    return parseDreamOps(text);
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens ?? 64);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: reviewerSystemPrompt(request.systemPrompt) },
          { role: "user", content: request.message }
        ]),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens ?? 64,
        tools: [openAiChatReviewerTool()],
        tool_choice: openAiChatForcedToolChoice(this.model, REVIEWER_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, REVIEWER_TOOL_NAME),
      queryRole: "reviewer"
    });
    return parseReviewerDecision(text);
  }

  async generatePersonaDigest(request: PersonaDigestRequest): Promise<PersonaDigest> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: PERSONA_DIGEST_PROMPT },
          { role: "user", content: request.personaText }
        ]),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0.2),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatTool(PERSONA_DIGEST_TOOL_NAME, PERSONA_DIGEST_TOOL_DESCRIPTION, PERSONA_DIGEST_TOOL_PARAMETERS)],
        tool_choice: openAiChatForcedToolChoice(this.model, PERSONA_DIGEST_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, PERSONA_DIGEST_TOOL_NAME),
      queryRole: "stage_manager_librarian"
    });
    return parsePersonaDigest(text);
  }
}

class OpenAiResponsesPipeline implements ModelPipeline {
  constructor(
    private readonly provider: ProviderMetadata,
    private readonly model: ModelCapabilityMetadata,
    private readonly apiKey: string
  ) {}

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: request.systemPrompt,
        input: [
          ...injectMemoriesIntoChatContext(
            contextToResponsesInputForWaifu(request.messages, this.model.supportsImageInput, request.selfAuthorIds ?? []),
            request.midSystemBlock ? { role: "system", content: request.midSystemBlock } : undefined
          ),
          ...(request.trailingSystemBlock ? [{ role: "system", content: request.trailingSystemBlock }] : []),
          ...(request.retryUserMessage ? [{ role: "user", content: request.retryUserMessage }] : [])
        ],
        temperature: request.temperature ?? this.model.defaultTemperature,
        top_p: request.topP ?? this.model.defaultTopP,
        max_output_tokens: request.maxOutputTokens,
        ...openAiResponsesWaifuToolsPayload(this.model, request),
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesWaifuResult(json, request.availableWaifuIds),
      queryRole: "waifu"
    });
    return result;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: request.systemPrompt,
        input: buildOpenAiResponsesOrchestratorInput({
          messages: request.messages,
          decisions: request.pastDecisions ?? [],
          markers: request.decisionMarkers,
          trailingPrompt: request.trailingPrompt ?? ""
        }),
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesOrchestratorTool(request.availableWaifuIds, request.replyRequired, request.directiveBudgetOpen ?? true)],
        tool_choice: { type: "function", name: ORCHESTRATOR_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds),
        input: [{ role: "user", content: formatObserverContext(request.messages, new Date()) }],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesObserverTool(request.availableWaifuIds)],
        tool_choice: { type: "function", name: OBSERVER_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, OBSERVER_TOOL_NAME),
      queryRole: "stage_manager_observer"
    });
    return parseStageManagerObservations(text);
  }

  async decideDream(request: DreamRequest): Promise<DreamOp[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: DREAM_PROMPT,
        input: dreamMessages(request),
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesDreamTool(request.availableWaifuIds)],
        tool_choice: { type: "function", name: DREAM_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, DREAM_TOOL_NAME),
      queryRole: "dream"
    });
    return parseDreamOps(text);
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens ?? 64);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: reviewerSystemPrompt(request.systemPrompt),
        input: [{ role: "user", content: request.message }],
        temperature: request.temperature ?? 0,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens ?? 64,
        tools: [openAiResponsesReviewerTool()],
        tool_choice: { type: "function", name: REVIEWER_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, REVIEWER_TOOL_NAME),
      queryRole: "reviewer"
    });
    return parseReviewerDecision(text);
  }

  async generatePersonaDigest(request: PersonaDigestRequest): Promise<PersonaDigest> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: PERSONA_DIGEST_PROMPT,
        input: [{ role: "user", content: request.personaText }],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesTool(PERSONA_DIGEST_TOOL_NAME, PERSONA_DIGEST_TOOL_DESCRIPTION, PERSONA_DIGEST_TOOL_PARAMETERS)],
        tool_choice: { type: "function", name: PERSONA_DIGEST_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, PERSONA_DIGEST_TOOL_NAME),
      queryRole: "stage_manager_librarian"
    });
    return parsePersonaDigest(text);
  }
}

class AnthropicMessagesPipeline implements ModelPipeline {
  constructor(
    private readonly provider: ProviderMetadata,
    private readonly model: ModelCapabilityMetadata,
    private readonly apiKey: string
  ) {}

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    const maxTokens = request.maxOutputTokens ?? anthropicDefaultMaxTokens(this.model, request.reasoning);
    validateMaxOutputTokens(this.model, maxTokens);
    const thinking = anthropicThinkingPayload(this.model, request.reasoning, maxTokens);
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: request.systemPrompt,
        messages: [
          ...injectMemoriesIntoChatContext(
            contextToAnthropicMessagesForWaifu(request.messages, this.model.supportsImageInput, request.selfAuthorIds ?? []),
            request.midSystemBlock ? { role: "user" as const, content: systemNoteTurn(request.midSystemBlock) } : undefined
          ),
          ...(request.trailingSystemBlock ? [{ role: "user" as const, content: systemNoteTurn(request.trailingSystemBlock) }] : []),
          ...(request.retryUserMessage ? [{ role: "user" as const, content: request.retryUserMessage }] : [])
        ],
        ...anthropicSamplingPayload(
          this.model,
          request.temperature ?? this.model.defaultTemperature,
          request.topP ?? this.model.defaultTopP,
          thinking
        ),
        max_tokens: maxTokens,
        ...anthropicWaifuToolsPayload(this.model, request),
        stop_sequences: request.stopSequences?.length ? request.stopSequences : undefined,
        ...anthropicOutputConfig(this.model, request.reasoning, thinking),
        ...(thinking ? { thinking } : {})
      },
      signal: request.signal,
      extract: (json) => extractAnthropicWaifuResult(json, request.availableWaifuIds),
      queryRole: "waifu"
    });
    return result;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const maxTokens = request.maxOutputTokens ?? 1024;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: request.systemPrompt,
        messages: buildAnthropicOrchestratorMessages({
          messages: request.messages,
          decisions: request.pastDecisions ?? [],
          markers: request.decisionMarkers,
          trailingPrompt: request.trailingPrompt ?? ""
        }),
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicOrchestratorTool(request.availableWaifuIds, request.replyRequired, request.directiveBudgetOpen ?? true)],
        tool_choice: { type: "tool", name: ORCHESTRATOR_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    const maxTokens = request.maxOutputTokens ?? 1024;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds),
        messages: [{ role: "user", content: formatObserverContext(request.messages, new Date()) }],
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicObserverTool(request.availableWaifuIds)],
        tool_choice: { type: "tool", name: OBSERVER_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, OBSERVER_TOOL_NAME),
      queryRole: "stage_manager_observer"
    });
    return parseStageManagerObservations(text);
  }

  async decideDream(request: DreamRequest): Promise<DreamOp[]> {
    const maxTokens = request.maxOutputTokens ?? 1024;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: DREAM_PROMPT,
        messages: dreamMessages(request),
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicDreamTool(request.availableWaifuIds)],
        tool_choice: { type: "tool", name: DREAM_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, DREAM_TOOL_NAME),
      queryRole: "dream"
    });
    return parseDreamOps(text);
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    const maxTokens = request.maxOutputTokens ?? 256;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: reviewerSystemPrompt(request.systemPrompt),
        messages: [{ role: "user", content: request.message }],
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicReviewerTool()],
        tool_choice: { type: "tool", name: REVIEWER_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, REVIEWER_TOOL_NAME),
      queryRole: "reviewer"
    });
    return parseReviewerDecision(text);
  }

  async generatePersonaDigest(request: PersonaDigestRequest): Promise<PersonaDigest> {
    const maxTokens = request.maxOutputTokens ?? 256;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: PERSONA_DIGEST_PROMPT,
        messages: [{ role: "user", content: request.personaText }],
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicTool(PERSONA_DIGEST_TOOL_NAME, PERSONA_DIGEST_TOOL_DESCRIPTION, PERSONA_DIGEST_TOOL_PARAMETERS)],
        tool_choice: { type: "tool", name: PERSONA_DIGEST_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, PERSONA_DIGEST_TOOL_NAME),
      queryRole: "stage_manager_librarian"
    });
    return parsePersonaDigest(text);
  }
}

class GoogleGenerativeLanguagePipeline implements ModelPipeline {
  constructor(
    private readonly provider: ProviderMetadata,
    private readonly model: ModelCapabilityMetadata,
    private readonly apiKey: string
  ) {}

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const contextContents = await contextToGoogleMessagesForWaifu(
      request.messages,
      this.model.supportsImageInput,
      request.selfAuthorIds ?? []
    );
    const contents = [
      ...injectMemoriesIntoChatContext(
        contextContents,
        request.midSystemBlock ? googleUserTurn(systemNoteTurn(request.midSystemBlock)) : undefined
      ),
      ...(request.trailingSystemBlock ? [googleUserTurn(systemNoteTurn(request.trailingSystemBlock))] : []),
      ...(request.retryUserMessage ? [googleUserTurn(request.retryUserMessage)] : [])
    ];
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
        contents,
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? this.model.defaultTemperature,
          topP: request.topP ?? this.model.defaultTopP,
          maxOutputTokens: request.maxOutputTokens,
          stopSequences: request.stopSequences,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        ...googleAiStudioWaifuToolsPayload(this.model, request)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleWaifuResult(json, request.availableWaifuIds),
      queryRole: "waifu"
    });
    return result;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
        contents: buildGoogleOrchestratorContents({
          messages: request.messages,
          decisions: request.pastDecisions ?? [],
          markers: request.decisionMarkers,
          trailingPrompt: request.trailingPrompt ?? ""
        }),
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0.2,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioOrchestratorTool(request.availableWaifuIds, request.replyRequired, request.directiveBudgetOpen ?? true)],
        toolConfig: googleForceToolConfig(ORCHESTRATOR_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: { parts: [{ text: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds) }] },
        contents: [googleUserTurn(formatObserverContext(request.messages, new Date()))],
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0.2,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioObserverTool(request.availableWaifuIds)],
        toolConfig: googleForceToolConfig(OBSERVER_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, OBSERVER_TOOL_NAME),
      queryRole: "stage_manager_observer"
    });
    return parseStageManagerObservations(text);
  }

  async decideDream(request: DreamRequest): Promise<DreamOp[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: { parts: [{ text: DREAM_PROMPT }] },
        contents: [
          googleUserTurn(`memories: ${JSON.stringify(request.memories)}`),
          googleUserTurn(`observations: ${JSON.stringify(request.observations)}`)
        ],
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0.2,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioDreamTool(request.availableWaifuIds)],
        toolConfig: googleForceToolConfig(DREAM_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, DREAM_TOOL_NAME),
      queryRole: "dream"
    });
    return parseDreamOps(text);
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens ?? 64);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: { parts: [{ text: reviewerSystemPrompt(request.systemPrompt) }] },
        contents: [googleUserTurn(request.message)],
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens ?? 64,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioReviewerTool()],
        toolConfig: googleForceToolConfig(REVIEWER_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, REVIEWER_TOOL_NAME),
      queryRole: "reviewer"
    });
    return parseReviewerDecision(text);
  }

  async generatePersonaDigest(request: PersonaDigestRequest): Promise<PersonaDigest> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: { parts: [{ text: PERSONA_DIGEST_PROMPT }] },
        contents: [googleUserTurn(request.personaText)],
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0.2,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioTool(PERSONA_DIGEST_TOOL_NAME, PERSONA_DIGEST_TOOL_DESCRIPTION, PERSONA_DIGEST_TOOL_PARAMETERS)],
        toolConfig: googleForceToolConfig(PERSONA_DIGEST_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, PERSONA_DIGEST_TOOL_NAME),
      queryRole: "stage_manager_librarian"
    });
    return parsePersonaDigest(text);
  }
}

type JsonPostOptions = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  extract: (json: unknown) => unknown;
  queryRole: QueryRole;
};

async function postJsonAndExtractText<T = string>(options: JsonPostOptions & {
  extract: (json: unknown) => T;
}): Promise<T> {
  throwIfAborted(options.signal);
  const body = stripUndefined(options.body);
  const query = recordProviderQuery(options.queryRole, body);
  const requestSignal = providerRequestSignal(options.signal);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.headers
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal
    });
    const text = await response.text();
    let json: unknown;
    let replyPayload: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
      replyPayload = json ?? null;
    } catch {
      json = { raw: text.slice(0, 1000) };
      replyPayload = { raw: text };
    }
    recordProviderReply(options.queryRole, query.id, response.status, response.ok, replyPayload);
    if (!response.ok) {
      throw new ProviderPipelineError(`Provider request failed with HTTP ${response.status}.`, json);
    }
    const extracted = options.extract(json);
    if (typeof extracted === "string") {
      const content = extracted.trim();
      if (!content) {
        throw new ProviderPipelineError("Provider returned an empty response.", json);
      }
      return content as T;
    }
    if (isRecord(extracted) && typeof extracted.content === "string") {
      const content = extracted.content.trim();
      return { ...extracted, content } as T;
    }
    if (extracted === undefined || extracted === null) {
      throw new ProviderPipelineError("Provider returned an empty response.", json);
    }
    return extracted as T;
  } finally {
    requestSignal.cleanup();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerRequestSignal(parent?: AbortSignal, timeoutMs = 180_000): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new ProviderPipelineError(`Provider request timed out after ${timeoutMs / 1000}s.`));
  }, timeoutMs);
  const abortFromParent = () => {
    controller.abort(parent?.reason instanceof Error ? parent.reason : new Error("Provider request aborted."));
  };
  if (parent) {
    if (parent.aborted) {
      abortFromParent();
    } else {
      parent.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

type OrchestratorQueryInput = {
  messages: ContextMessage[];
  decisions: OrchestratorDecisionHistoryEntry[];
  markers?: OrchestratorWakeMarker[];
  trailingPrompt: string;
};

function buildOpenAiChatOrchestratorMessages(
  input: OrchestratorQueryInput & { model: ModelCapabilityMetadata; systemPrompt: string }
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: input.systemPrompt }];
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions, input.markers ?? [])) {
    if (item.kind === "note") {
      messages.push({ role: "user", content: item.text });
    } else if (item.kind === "message") {
      messages.push({ role: "user", content: formatOrchestratorMessageBlock(item.message) });
    } else {
      const args = serializeOrchestratorDecisionArguments(item.decision);
      messages.push(stripUndefined({
        role: "assistant",
        content: input.model.providerId === "zai" ? undefined : null,
        tool_calls: [
          {
            id: item.decision.id,
            type: "function",
            function: {
              name: ORCHESTRATOR_TOOL_NAME,
              arguments: JSON.stringify(args)
            }
          }
        ]
      }));
      messages.push({
        role: "tool",
        tool_call_id: item.decision.id,
        content: formatDecisionOutcome(item.decision)
      });
    }
  }
  messages.push({ role: "user", content: input.trailingPrompt });
  return messages;
}

function buildOpenAiResponsesOrchestratorInput(input: OrchestratorQueryInput): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions, input.markers ?? [])) {
    if (item.kind === "note") {
      items.push({ role: "user", content: [{ type: "input_text", text: item.text }] });
    } else if (item.kind === "message") {
      items.push({ role: "user", content: formatOrchestratorMessageBlock(item.message) });
    } else {
      const args = serializeOrchestratorDecisionArguments(item.decision);
      items.push({
        type: "function_call",
        call_id: item.decision.id,
        name: ORCHESTRATOR_TOOL_NAME,
        arguments: JSON.stringify(args)
      });
      items.push({
        type: "function_call_output",
        call_id: item.decision.id,
        output: formatDecisionOutcome(item.decision)
      });
    }
  }
  items.push({
    role: "user",
    content: [{ type: "input_text", text: input.trailingPrompt }]
  });
  return items;
}

function buildAnthropicOrchestratorMessages(input: OrchestratorQueryInput): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let userBlocks: Array<Record<string, unknown>> = [];
  const flushUser = () => {
    if (userBlocks.length > 0) {
      result.push({ role: "user", content: userBlocks });
      userBlocks = [];
    }
  };
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions, input.markers ?? [])) {
    if (item.kind === "note") {
      userBlocks.push({ type: "text", text: item.text });
    } else if (item.kind === "message") {
      userBlocks.push({ type: "text", text: formatOrchestratorMessageBlock(item.message) });
    } else {
      flushUser();
      const args = serializeOrchestratorDecisionArguments(item.decision);
      result.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: item.decision.id,
            name: ORCHESTRATOR_TOOL_NAME,
            input: args
          }
        ]
      });
      userBlocks.push({
        type: "tool_result",
        tool_use_id: item.decision.id,
        content: formatDecisionOutcome(item.decision)
      });
    }
  }
  userBlocks.push({ type: "text", text: input.trailingPrompt });
  flushUser();
  return result;
}

function buildGoogleOrchestratorContents(input: OrchestratorQueryInput): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions, input.markers ?? [])) {
    if (item.kind === "note") {
      contents.push(googleUserTurn(item.text));
    } else if (item.kind === "message") {
      contents.push(googleUserTurn(formatOrchestratorMessageBlock(item.message)));
    } else {
      const args = serializeOrchestratorDecisionArguments(item.decision);
      contents.push({
        role: "model",
        parts: [{ functionCall: { name: ORCHESTRATOR_TOOL_NAME, args } }]
      });
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: ORCHESTRATOR_TOOL_NAME,
              response: { output: formatDecisionOutcome(item.decision) }
            }
          }
        ]
      });
    }
  }
  contents.push(googleUserTurn(input.trailingPrompt));
  return contents;
}

function contextToChatMessagesForWaifu(messages: ContextMessage[], includeImages: boolean, selfAuthorIds: string[] = []) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message, selfAuthorIds);
    const text = role === "assistant" ? formatSelfWaifuContent(message) : formatWaifuContextBlock(message);
    const imageBlocks = includeImages && role === "user" ? chatImageBlocks(message) : [];
    return {
      role,
      content: imageBlocks.length ? [{ type: "text", text }, ...imageBlocks] : text
    };
  });
}

function injectMemoriesIntoChatContext<T, M>(
  contextMessages: T[],
  memoriesMessage: M | undefined
): Array<T | M> {
  if (!memoriesMessage) return contextMessages;
  const insertAt = Math.max(0, contextMessages.length - 2);
  return [...contextMessages.slice(0, insertAt), memoriesMessage, ...contextMessages.slice(insertAt)];
}

function chatImageBlocks(message: ContextMessage) {
  return (message.images ?? []).map((image) => ({
    type: "image_url" as const,
    image_url: { url: image.url }
  }));
}

function contextToResponsesInputForWaifu(messages: ContextMessage[], includeImages: boolean, selfAuthorIds: string[] = []) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message, selfAuthorIds);
    const text = role === "assistant" ? formatSelfWaifuContent(message) : formatWaifuContextBlock(message);
    const imageBlocks = includeImages && role === "user" ? responsesImageBlocks(message) : [];
    return {
      role,
      content: imageBlocks.length ? [{ type: "input_text" as const, text }, ...imageBlocks] : text
    };
  });
}

function responsesImageBlocks(message: ContextMessage) {
  return (message.images ?? []).map((image) => ({
    type: "input_image" as const,
    image_url: image.url
  }));
}

function contextToAnthropicMessagesForWaifu(messages: ContextMessage[], includeImages: boolean, selfAuthorIds: string[] = []) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message, selfAuthorIds);
    const text = role === "assistant" ? formatSelfWaifuContent(message) : formatWaifuContextBlock(message);
    const imageBlocks = includeImages && role === "user" ? anthropicImageBlocks(message) : [];
    return {
      role,
      content: imageBlocks.length ? [{ type: "text" as const, text }, ...imageBlocks] : text
    };
  });
}

function anthropicImageBlocks(message: ContextMessage) {
  return (message.images ?? []).map((image) => ({
    type: "image" as const,
    source: { type: "url" as const, url: image.url }
  }));
}

function roleForWaifuContext(message: ContextMessage, selfAuthorIds: string[]): "assistant" | "user" {
  return message.authorKind === "waifu" && selfAuthorIds.includes(message.authorId)
    ? "assistant"
    : "user";
}

// The dream pass reads two JSON user blocks: the active memory chunk and the pending observations.
function dreamMessages(request: DreamRequest): Array<{ role: "user"; content: string }> {
  return [
    { role: "user", content: `memories: ${JSON.stringify(request.memories)}` },
    { role: "user", content: `observations: ${JSON.stringify(request.observations)}` }
  ];
}


const REVIEWER_TOOL_DESCRIPTION = "Decide whether the latest logical waifu message is hallucinated or leaked internal content.";
const ORCHESTRATOR_TOOL_DESCRIPTION = "Choose whether a waifu should reply next and which waifu(s) should respond.";
const PICK_NEXT_WAIFU_TOOL_DESCRIPTION =
  "Hand the next turn directly to another waifu without waiting for the director. Call at most once, after writing your own reply, and only when she has an obvious immediate follow-up to what you just said.";
const SHORT_TERM_MEMORY_TOOL_DESCRIPTION =
  "Your personal notepad. The chat history can vanish at any time (channel switch, cleanup); your notes are what survives. Save one short standalone sentence whenever the conversation produces something you'd want to still know tomorrow: a plan, a promise, a new fact about someone, the state of a running joke or argument. Spell names out ('Riko owes Ali tacos since Thursday', never 'she owes him'). Up to 5 calls per reply. Skip pure filler and anything already shown in your memories block. Notes expire after about three days unless the nightly process promotes them. Calling this tool does NOT replace your message — always also write your normal reply in the same turn.";





const DREAM_TOOL_DESCRIPTION = "Return the full set of consolidation operations for the nightly memory pass.";
const OBSERVER_TOOL_DESCRIPTION = "Return atomic, durable observations extracted from the chat window. An empty array means nothing durable was disclosed.";
const PERSONA_DIGEST_TOOL_DESCRIPTION = "Distill the character sheet into a casting digest.";
const PersonaDigestResultSchema = z.object({ voice: z.string().min(1), role: z.string().min(1) });

function parsePersonaDigest(text: string): PersonaDigest {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return PersonaDigestResultSchema.parse(parsed);
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return a valid persona digest.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}





function openAiChatOrchestratorTool(availableWaifuIds?: string[], replyRequired = false, directiveBudgetOpen = true) {
  return openAiChatTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired, directiveBudgetOpen));
}

function openAiResponsesOrchestratorTool(availableWaifuIds?: string[], replyRequired = false, directiveBudgetOpen = true) {
  return openAiResponsesTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired, directiveBudgetOpen));
}

function anthropicOrchestratorTool(availableWaifuIds?: string[], replyRequired = false, directiveBudgetOpen = true) {
  return anthropicTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired, directiveBudgetOpen));
}

function openAiChatPickNextWaifuTool(availableWaifuIds?: string[]) {
  return openAiChatTool(PICK_NEXT_WAIFU_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_DESCRIPTION, pickNextWaifuToolParameters(availableWaifuIds));
}

function openAiResponsesPickNextWaifuTool(availableWaifuIds?: string[]) {
  return openAiResponsesTool(PICK_NEXT_WAIFU_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_DESCRIPTION, pickNextWaifuToolParameters(availableWaifuIds));
}

function anthropicPickNextWaifuTool(availableWaifuIds?: string[]) {
  return anthropicTool(PICK_NEXT_WAIFU_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_DESCRIPTION, pickNextWaifuToolParameters(availableWaifuIds));
}

function openAiChatShortTermMemoryTool() {
  return openAiChatTool(SHORT_TERM_MEMORY_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_DESCRIPTION, shortTermMemoryToolParameters());
}

function openAiResponsesShortTermMemoryTool() {
  return openAiResponsesTool(SHORT_TERM_MEMORY_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_DESCRIPTION, shortTermMemoryToolParameters());
}

function anthropicShortTermMemoryTool() {
  return anthropicTool(SHORT_TERM_MEMORY_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_DESCRIPTION, shortTermMemoryToolParameters());
}

function openAiChatDreamTool(availableWaifuIds?: string[]) {
  return openAiChatTool(DREAM_TOOL_NAME, DREAM_TOOL_DESCRIPTION, dreamToolParameters(availableWaifuIds));
}

function openAiResponsesDreamTool(availableWaifuIds?: string[]) {
  return openAiResponsesTool(DREAM_TOOL_NAME, DREAM_TOOL_DESCRIPTION, dreamToolParameters(availableWaifuIds));
}

function anthropicDreamTool(availableWaifuIds?: string[]) {
  return anthropicTool(DREAM_TOOL_NAME, DREAM_TOOL_DESCRIPTION, dreamToolParameters(availableWaifuIds));
}

function openAiChatObserverTool(availableWaifuIds?: string[]) {
  return openAiChatTool(OBSERVER_TOOL_NAME, OBSERVER_TOOL_DESCRIPTION, observerToolParameters(availableWaifuIds));
}

function openAiResponsesObserverTool(availableWaifuIds?: string[]) {
  return openAiResponsesTool(OBSERVER_TOOL_NAME, OBSERVER_TOOL_DESCRIPTION, observerToolParameters(availableWaifuIds));
}

function anthropicObserverTool(availableWaifuIds?: string[]) {
  return anthropicTool(OBSERVER_TOOL_NAME, OBSERVER_TOOL_DESCRIPTION, observerToolParameters(availableWaifuIds));
}

function openAiChatReviewerTool() {
  return openAiChatTool(REVIEWER_TOOL_NAME, REVIEWER_TOOL_DESCRIPTION, REVIEWER_TOOL_PARAMETERS);
}

function openAiResponsesReviewerTool() {
  return openAiResponsesTool(REVIEWER_TOOL_NAME, REVIEWER_TOOL_DESCRIPTION, REVIEWER_TOOL_PARAMETERS, true);
}

function anthropicReviewerTool() {
  return anthropicTool(REVIEWER_TOOL_NAME, REVIEWER_TOOL_DESCRIPTION, REVIEWER_TOOL_PARAMETERS);
}

function shouldExposePickNextWaifuTool(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): boolean {
  return Boolean(
    model.supportsTools &&
    request.pickNextWaifuToolEnabled &&
    (request.availableWaifuIds?.length ?? 0) > 0
  );
}

function shouldExposeShortTermMemoryTool(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): boolean {
  return Boolean(model.supportsTools && request.shortTermMemoryToolEnabled);
}

function openAiChatPickNextWaifuToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  if (!shouldExposePickNextWaifuTool(model, request)) return {};
  if (model.providerId === "deepseek") {
    return {
      tools: [openAiChatPickNextWaifuTool(request.availableWaifuIds)]
    };
  }
  return {
    tools: [openAiChatPickNextWaifuTool(request.availableWaifuIds)],
    tool_choice: "auto"
  };
}

function openAiResponsesPickNextWaifuToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  if (!shouldExposePickNextWaifuTool(model, request)) return {};
  return {
    tools: [openAiResponsesPickNextWaifuTool(request.availableWaifuIds)],
    tool_choice: "auto"
  };
}

function anthropicPickNextWaifuToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: { type: "auto" } } {
  if (!shouldExposePickNextWaifuTool(model, request)) return {};
  return {
    tools: [anthropicPickNextWaifuTool(request.availableWaifuIds)],
    tool_choice: { type: "auto" }
  };
}

function openAiChatShortTermMemoryToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  if (!shouldExposeShortTermMemoryTool(model, request)) return {};
  if (model.providerId === "deepseek") {
    return { tools: [openAiChatShortTermMemoryTool()] };
  }
  return { tools: [openAiChatShortTermMemoryTool()], tool_choice: "auto" };
}

function openAiResponsesShortTermMemoryToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  if (!shouldExposeShortTermMemoryTool(model, request)) return {};
  return { tools: [openAiResponsesShortTermMemoryTool()], tool_choice: "auto" };
}

function anthropicShortTermMemoryToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: { type: "auto" } } {
  if (!shouldExposeShortTermMemoryTool(model, request)) return {};
  return { tools: [anthropicShortTermMemoryTool()], tool_choice: { type: "auto" } };
}

function openAiChatWaifuToolsPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  const pick = openAiChatPickNextWaifuToolPayload(model, request);
  const mem = openAiChatShortTermMemoryToolPayload(model, request);
  const tools = [...(pick.tools ?? []), ...(mem.tools ?? [])];
  if (!tools.length) return {};
  const tool_choice = pick.tool_choice ?? mem.tool_choice;
  return tool_choice ? { tools, tool_choice } : { tools };
}

function openAiResponsesWaifuToolsPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  const pick = openAiResponsesPickNextWaifuToolPayload(model, request);
  const mem = openAiResponsesShortTermMemoryToolPayload(model, request);
  const tools = [...(pick.tools ?? []), ...(mem.tools ?? [])];
  if (!tools.length) return {};
  const tool_choice = pick.tool_choice ?? mem.tool_choice;
  return tool_choice ? { tools, tool_choice } : { tools };
}

function anthropicWaifuToolsPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: { type: "auto" } } {
  const pick = anthropicPickNextWaifuToolPayload(model, request);
  const mem = anthropicShortTermMemoryToolPayload(model, request);
  const tools = [...(pick.tools ?? []), ...(mem.tools ?? [])];
  if (!tools.length) return {};
  const tool_choice = pick.tool_choice ?? mem.tool_choice;
  return tool_choice ? { tools, tool_choice } : { tools };
}

function openAiChatTool(name: string, description: string, parameters: object) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters
    }
  };
}

function openAiResponsesTool(name: string, description: string, parameters: object, strict = false) {
  return {
    type: "function",
    name,
    description,
    parameters,
    ...(strict ? { strict: true } : {})
  };
}

function anthropicTool(name: string, description: string, inputSchema: object) {
  return {
    name,
    description,
    input_schema: inputSchema
  };
}

const ImportanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);
const RawImportanceSchema = z.preprocess((value) => {
  if (typeof value === "string" && /^[1-5]$/.test(value)) {
    return Number(value);
  }
  return value;
}, ImportanceSchema);

const RawStageManagerObservationSchema = z.object({
  waifuId: z.string().min(1),
  content: z.string().min(1),
  importance: RawImportanceSchema,
  kind: z.enum(OBSERVATION_KINDS)
});

const RawDirectiveSchema = z.object({
  intent: z.string().min(1),
  goal: z.string().min(1)
});

const RawRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).nullish(),
  directive: RawDirectiveSchema.nullish().catch(null)
});

const PickNextWaifuCallSchema = z.object({
  waifuId: z.string().min(1)
});

const RawOrchestratorDecisionSchema = z.object({
  action: OrchestratorActionSchema,
  respondingWaifus: z.array(RawRespondingWaifuSchema).default([]),
  retriggerAfterSeconds: z
    .union([z.number().min(RETRIGGER_MIN_SECONDS).max(RETRIGGER_MAX_SECONDS), z.null()])
    .optional(),
  wakePlan: z.union([z.string(), z.null()]).optional(),
  reasoning: z.string().min(1)
});

// The model may emit ops in either the nested shape (matching the OpenAI/Anthropic tool schema:
// `memory`/`patch` sub-objects) or the flattened Google shape (`waifuId`/`content`/`strength`
// hoisted to the op level). This lenient schema accepts both and a normalizer below folds the flat
// form into the canonical DreamOp.
const RawDreamOpSchema = z.object({
  op: z.enum(["add", "promote", "rewrite", "merge", "decay", "archive", "none"]),
  memory: z
    .object({
      waifuId: z.string().min(1),
      content: z.string().min(1),
      kind: MemoryKindSchema,
      strength: z.number().min(0).max(5),
      entities: z.array(z.string()).default([])
    })
    .optional(),
  patch: z
    .object({
      kind: MemoryKindSchema.optional(),
      strength: z.number().min(0).max(5).optional(),
      content: z.string().min(1).optional()
    })
    .optional(),
  memoryIndex: z.number().int().min(1).optional(),
  memoryIndices: z.array(z.number().int().min(1)).min(2).optional(),
  content: z.string().min(1).optional(),
  entities: z.array(z.string()).optional(),
  kind: MemoryKindSchema.optional(),
  strength: z.number().min(0).max(5).optional(),
  reason: z.string().min(1).optional(),
  waifuId: z.string().min(1).optional()
});

function normalizeRawDirective(
  directive: { intent: string; goal: string } | null | undefined
): Directive | undefined {
  if (!directive) return undefined;
  if (!(MODEL_DIRECTIVE_INTENTS as readonly string[]).includes(directive.intent)) return undefined;
  const goal = directive.goal.trim();
  if (!goal) return undefined;
  return { intent: directive.intent as Directive["intent"], goal };
}

function parseDecision(text: string, replyRequired = false): OrchestratorDecision {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const raw = RawOrchestratorDecisionSchema.parse(parsed);
    if (replyRequired && raw.action !== "reply") {
      throw new Error("Manual /run requires action=reply.");
    }
    return OrchestratorDecisionSchema.parse({
      action: raw.action,
      respondingWaifus: raw.respondingWaifus.map((entry) => ({
        waifuId: entry.waifuId,
        delaySeconds: entry.delaySeconds ?? 0,
        directive: normalizeRawDirective(entry.directive)
      })),
      retriggerAfterSeconds:
        raw.retriggerAfterSeconds === null ? undefined : raw.retriggerAfterSeconds,
      wakePlan: raw.wakePlan ?? undefined,
      reasoning: raw.reasoning
    });
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return a valid orchestrator decision.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseDreamOps(text: string): DreamOp[] {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const rawOps = Array.isArray(parsed) ? parsed : (parsed.ops ?? parsed.toolCalls ?? []);
    if (!Array.isArray(rawOps)) {
      throw new Error("dream response did not contain an ops array.");
    }
    const validOps: DreamOp[] = [];
    const invalidOps: string[] = [];
    rawOps.forEach((op: unknown, index: number) => {
      try {
        validOps.push(normalizeDreamOp(op));
      } catch (error) {
        invalidOps.push(`#${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (validOps.length > 0) {
      return validOps;
    }
    throw new Error(
      invalidOps.length
        ? `No valid dream ops. Invalid ops: ${invalidOps.join("; ")}`
        : "Provider returned no dream ops."
    );
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return valid dream ops.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeDreamOp(op: unknown): DreamOp {
  const raw = RawDreamOpSchema.parse(op);
  switch (raw.op) {
    case "add":
      return DreamOpSchema.parse({
        op: "add",
        memory:
          raw.memory ??
          stripUndefined({
            waifuId: raw.waifuId,
            content: raw.content,
            kind: raw.kind,
            strength: raw.strength,
            entities: raw.entities
          })
      });
    case "promote":
      return DreamOpSchema.parse({
        op: "promote",
        memoryIndex: raw.memoryIndex,
        patch:
          raw.patch ??
          stripUndefined({
            kind: raw.kind,
            strength: raw.strength,
            content: raw.content
          })
      });
    case "rewrite":
      return DreamOpSchema.parse({
        op: "rewrite",
        memoryIndex: raw.memoryIndex,
        content: raw.content,
        entities: raw.entities
      });
    case "merge":
      return DreamOpSchema.parse({
        op: "merge",
        memoryIndices: raw.memoryIndices,
        content: raw.content,
        entities: raw.entities
      });
    case "decay":
      return DreamOpSchema.parse({
        op: "decay",
        memoryIndex: raw.memoryIndex,
        strength: raw.strength
      });
    case "archive":
      return DreamOpSchema.parse({
        op: "archive",
        memoryIndex: raw.memoryIndex,
        reason: raw.reason
      });
    case "none":
      return DreamOpSchema.parse({ op: "none" });
  }
}

function parseStageManagerObservations(text: string): StageManagerObservation[] {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const raw = Array.isArray(parsed) ? parsed : (parsed.observations ?? []);
    return raw.map((item: unknown) => StageManagerObservationSchema.parse(RawStageManagerObservationSchema.parse(item)));
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return valid stage-manager observations.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseReviewerDecision(text: string): ReviewerDecision {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return ReviewerDecisionSchema.parse(parsed);
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return a valid reviewer decision.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

function extractOpenAiChatText(json: unknown): string {
  const parsed = json as { choices?: Array<{ message?: { content?: string } }> };
  return parsed.choices?.[0]?.message?.content ?? "";
}

function extractOpenAiChatWaifuResult(json: unknown, availableWaifuIds?: string[]): WaifuGenerationResult {
  const parsed = json as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          function?: {
            name?: string;
            arguments?: unknown;
          };
        }>;
      };
    }>;
  };
  const message = parsed.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.find((call) => call.function?.name === PICK_NEXT_WAIFU_TOOL_NAME);
  const shortTermMemoryEntries = (message?.tool_calls ?? [])
    .filter((call) => call.function?.name === SHORT_TERM_MEMORY_TOOL_NAME)
    .map((call) => parseShortTermMemoryArguments(call.function?.arguments))
    .filter((entry): entry is string => Boolean(entry));
  return {
    content: message?.content ?? "",
    ...parsePickedNextWaifu(toolCall?.function?.arguments, availableWaifuIds),
    ...(shortTermMemoryEntries.length ? { shortTermMemoryEntries } : {})
  };
}

function extractOpenAiChatToolArguments(json: unknown, toolName: string): string {
  const parsed = json as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          function?: {
            name?: string;
            arguments?: unknown;
          };
        }>;
      };
    }>;
  };
  const message = parsed.choices?.[0]?.message;
  const toolCall =
    message?.tool_calls?.find((call) => call.function?.name === toolName) ??
    message?.tool_calls?.[0];
  const args = toolCall?.function?.arguments;
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return message?.content ?? "";
}

function extractOpenAiResponsesText(json: unknown): string {
  const parsed = json as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  if (parsed.output_text) return parsed.output_text;
  return (
    parsed.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? "")
      .join("") ?? ""
  );
}

function extractOpenAiResponsesWaifuResult(json: unknown, availableWaifuIds?: string[]): WaifuGenerationResult {
  const parsed = json as {
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: unknown;
      content?: Array<{ text?: string; type?: string }>;
    }>;
    output_text?: string;
  };
  const call = parsed.output?.find((item) => item.type === "function_call" && item.name === PICK_NEXT_WAIFU_TOOL_NAME);
  const shortTermMemoryEntries = (parsed.output ?? [])
    .filter((item) => item.type === "function_call" && item.name === SHORT_TERM_MEMORY_TOOL_NAME)
    .map((item) => parseShortTermMemoryArguments(item.arguments))
    .filter((entry): entry is string => Boolean(entry));
  return {
    content: extractOpenAiResponsesText(parsed),
    ...parsePickedNextWaifu(call?.arguments, availableWaifuIds),
    ...(shortTermMemoryEntries.length ? { shortTermMemoryEntries } : {})
  };
}

function extractOpenAiResponsesToolArguments(json: unknown, toolName: string): string {
  const parsed = json as {
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: unknown;
      content?: Array<{ text?: string; type?: string }>;
    }>;
    output_text?: string;
  };
  const call =
    parsed.output?.find((item) => item.type === "function_call" && item.name === toolName) ??
    parsed.output?.find((item) => item.type === "function_call");
  if (typeof call?.arguments === "string") return call.arguments;
  if (call?.arguments && typeof call.arguments === "object") return JSON.stringify(call.arguments);
  return extractOpenAiResponsesText(parsed) || parsed.output_text || "";
}

function extractAnthropicText(json: unknown): string {
  const parsed = json as { content?: Array<{ type?: string; text?: string }> };
  return parsed.content?.map((part) => part.text ?? "").join("") ?? "";
}

function extractAnthropicWaifuResult(json: unknown, availableWaifuIds?: string[]): WaifuGenerationResult {
  const parsed = json as {
    content?: Array<{
      type?: string;
      name?: string;
      input?: unknown;
      text?: string;
    }>;
  };
  const toolUse = parsed.content?.find((part) => part.type === "tool_use" && part.name === PICK_NEXT_WAIFU_TOOL_NAME);
  const shortTermMemoryEntries = (parsed.content ?? [])
    .filter((part) => part.type === "tool_use" && part.name === SHORT_TERM_MEMORY_TOOL_NAME)
    .map((part) => parseShortTermMemoryArguments(part.input))
    .filter((entry): entry is string => Boolean(entry));
  return {
    content: extractAnthropicText(parsed),
    ...parsePickedNextWaifu(toolUse?.input, availableWaifuIds),
    ...(shortTermMemoryEntries.length ? { shortTermMemoryEntries } : {})
  };
}

function extractAnthropicToolArguments(json: unknown, toolName: string): string {
  const parsed = json as {
    content?: Array<{
      type?: string;
      name?: string;
      input?: unknown;
      text?: string;
    }>;
  };
  const toolUse =
    parsed.content?.find((part) => part.type === "tool_use" && part.name === toolName) ??
    parsed.content?.find((part) => part.type === "tool_use");
  if (typeof toolUse?.input === "string") return toolUse.input;
  if (toolUse?.input && typeof toolUse.input === "object") return JSON.stringify(toolUse.input);
  return extractAnthropicText(parsed);
}

const ShortTermMemoryCallSchema = z.object({
  content: z.string().min(1)
});

function parseShortTermMemoryArguments(argumentsValue: unknown): string | undefined {
  if (argumentsValue === undefined || argumentsValue === null) return undefined;
  try {
    const parsed =
      typeof argumentsValue === "string"
        ? JSON.parse(stripCodeFence(argumentsValue))
        : argumentsValue;
    const call = ShortTermMemoryCallSchema.parse(parsed);
    return call.content.trim() || undefined;
  } catch {
    return undefined;
  }
}

function parsePickedNextWaifu(
  argumentsValue: unknown,
  availableWaifuIds?: string[]
): Pick<WaifuGenerationResult, "pickedNextWaifuId" | "rejectedPickNextWaifu"> {
  if (argumentsValue === undefined || argumentsValue === null) return {};
  try {
    const parsed =
      typeof argumentsValue === "string"
        ? JSON.parse(stripCodeFence(argumentsValue))
        : argumentsValue;
    const call = PickNextWaifuCallSchema.parse(parsed);
    const allowed = new Set(availableWaifuIds ?? []);
    if (allowed.size > 0 && !allowed.has(call.waifuId)) {
      return {
        rejectedPickNextWaifu: {
          reason: "unavailable_waifu",
          waifuId: call.waifuId
        }
      };
    }
    return { pickedNextWaifuId: call.waifuId };
  } catch {
    return {
      rejectedPickNextWaifu: {
        reason: "malformed"
      }
    };
  }
}

function validateMaxOutputTokens(model: ModelCapabilityMetadata, maxOutputTokens: number | undefined): void {
  if (maxOutputTokens === undefined || model.maxOutputTokens === undefined) return;
  if (maxOutputTokens > model.maxOutputTokens) {
    throw new ProviderPipelineError(
      `${model.modelId} supports at most ${model.maxOutputTokens} output tokens; received ${maxOutputTokens}.`
    );
  }
}

function openAiChatMessagesForModel(
  model: ModelCapabilityMetadata,
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const providerSafeMessages = model.providerId === "deepseek"
    ? messages.map((message) => {
      if (typeof message.content !== "string") return message;
      return {
        ...message,
        content: shieldMalformedHexEscapes(message.content)
      };
    })
    : messages;
  if (model.providerId !== "zai" || providerSafeMessages.some((message) => message.role === "user")) {
    return providerSafeMessages;
  }
  const lastIndex = providerSafeMessages.length - 1;
  return providerSafeMessages.map((message, index) =>
    index === lastIndex ? { ...message, role: "user" } : message
  );
}

function shieldMalformedHexEscapes(content: string): string {
  return content.replace(
    /(\\+)([uUx])([0-9A-Fa-f]*)/g,
    (match, slashes: string, marker: string, digits: string) => {
      const expectedDigits = marker === "U" ? 8 : marker === "u" ? 4 : 2;
      if (slashes.length % 2 === 0 || digits.length >= expectedDigits) {
        return match;
      }
      return `\\${match}`;
    }
  );
}

function openAiChatTemperature(
  model: ModelCapabilityMetadata,
  temperature: number | undefined
): number | undefined {
  if (model.providerId === "zai" && temperature !== undefined) {
    return Math.max(0, Math.min(1, temperature));
  }
  return temperature;
}

function openAiChatForcedToolChoice(
  model: ModelCapabilityMetadata,
  toolName: string
): "auto" | { type: "function"; function: { name: string } } {
  // Z.AI documents tool_choice as an enum with only "auto"; forced OpenAI-style objects return 400.
  if (model.providerId === "zai") return "auto";
  return { type: "function", function: { name: toolName } };
}

function openAiChatTopP(
  model: ModelCapabilityMetadata,
  topP: number | undefined
): number | undefined {
  if (model.providerId === "zai" && topP !== undefined && topP < 0.01) {
    return undefined;
  }
  return topP;
}

function openAiChatStopSequences(
  model: ModelCapabilityMetadata,
  reasoning: ReasoningConfig | undefined,
  stopSequences: string[] | undefined
): string[] | undefined {
  if (!stopSequences?.length) return undefined;
  if (isXaiReasoningRequest(model, reasoning)) return undefined;
  if (model.providerId === "zai") return [stopSequences[0]];
  return stopSequences;
}

function openAiChatReasoningForForcedTool(
  model: ModelCapabilityMetadata,
  reasoning: ReasoningConfig | undefined
): ReasoningConfig | undefined {
  // DeepSeek V4 defaults to thinking mode; keep forced tool calls in non-thinking mode.
  if (model.providerId === "deepseek") return { enabled: false };
  return reasoning;
}

function openAiChatReasoningForWaifu(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): ReasoningConfig | undefined {
  if (model.providerId !== "deepseek") return request.reasoning;
  if (shouldExposePickNextWaifuTool(model, request)) return { enabled: false };
  if (request.reasoning?.enabled === true) return request.reasoning;
  return { enabled: false };
}

function isXaiReasoningRequest(model: ModelCapabilityMetadata, reasoning?: ReasoningConfig): boolean {
  if (model.providerId !== "xai") return false;
  if (model.modelId === "grok-4.20-0309-reasoning") return true;
  if (model.modelId === "grok-4.20-0309-non-reasoning") return false;
  if (model.modelId === "grok-4.3") {
    return reasoning?.enabled === false || reasoning?.effort === "none" ? false : true;
  }
  return false;
}

function openAiChatSamplingOverrides(
  model: ModelCapabilityMetadata,
  reasoning?: ReasoningConfig
): { temperature?: undefined; top_p?: undefined } {
  // DeepSeek thinking mode is incompatible with temperature/top_p/presence_penalty/frequency_penalty.
  if (model.providerId === "deepseek" && reasoning?.enabled === true) {
    return { temperature: undefined, top_p: undefined };
  }
  return {};
}

function openAiResponsesSamplingOverrides(
  model: ModelCapabilityMetadata
): { temperature?: undefined; top_p?: undefined } {
  // OpenAI gpt-5.x reasoning models reject temperature/top_p with a 400 unsupported_parameter error.
  if (model.providerId === "openai" && model.reasoningControls.includes("reasoning.effort")) {
    return { temperature: undefined, top_p: undefined };
  }
  return {};
}

function reasoningFieldsForOpenAiChat(
  model: ModelCapabilityMetadata,
  reasoning?: ReasoningConfig
): Record<string, unknown> {
  if (!reasoning) return {};
  const controls = new Set(model.reasoningControls);
  if (model.providerId === "xai") {
    if (controls.has("reasoning.enabled") && reasoning.enabled === false) {
      return { reasoning_effort: "none" };
    }
    if (controls.has("reasoning.effort") && reasoning.effort) {
      const effort = xaiReasoningEffort(reasoning.effort);
      return effort ? { reasoning_effort: effort } : {};
    }
    return {};
  }
  if (model.providerId === "deepseek") {
    const fields: Record<string, unknown> = {};
    if (controls.has("reasoning.enabled") && reasoning.enabled !== undefined) {
      fields.thinking = { type: reasoning.enabled ? "enabled" : "disabled" };
    }
    if (reasoning.enabled !== false && controls.has("reasoning.effort") && reasoning.effort) {
      fields.reasoning_effort = deepSeekReasoningEffort(reasoning.effort);
    }
    return fields;
  }
  if (model.providerId === "zai") {
    if (controls.has("reasoning.enabled") && reasoning.enabled !== undefined) {
      return { thinking: { type: reasoning.enabled ? "enabled" : "disabled", clear_thinking: true } };
    }
    return {};
  }
  return {};
}

function reasoningFieldsForOpenAiResponses(
  model: ModelCapabilityMetadata,
  reasoning?: ReasoningConfig
): Record<string, unknown> {
  if (!reasoning) return {};
  const controls = new Set(model.reasoningControls);
  if (controls.has("reasoning.effort") && reasoning.effort) {
    const effort = openAiReasoningEffort(reasoning.effort);
    return effort ? { reasoning: { effort } } : {};
  }
  return {};
}

function xaiReasoningEffort(effort: ReasoningConfig["effort"]): "none" | "low" | "medium" | "high" | undefined {
  if (effort === "none" || effort === "low" || effort === "medium" || effort === "high") return effort;
  return undefined;
}

function deepSeekReasoningEffort(effort: ReasoningConfig["effort"]): "high" | "max" {
  return effort === "max" ? "max" : "high";
}

function openAiReasoningEffort(
  effort: ReasoningConfig["effort"]
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (
    effort === "none" ||
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  return undefined;
}

type AnthropicThinking =
  | { type: "enabled"; budget_tokens: number }
  | { type: "adaptive" }
  | { type: "disabled" };

function anthropicDefaultMaxTokens(
  model: ModelCapabilityMetadata,
  reasoning: ReasoningConfig | undefined
): number {
  if (model.modelId.startsWith("claude-haiku-4-5") && reasoning?.enabled === true) {
    return 2048;
  }
  return 1024;
}

function anthropicThinkingPayload(
  model: ModelCapabilityMetadata,
  reasoning: ReasoningConfig | undefined,
  maxTokens: number
): AnthropicThinking | undefined {
  const modelId = model.modelId;
  // Opus 4.7: adaptive is the only thinking-on mode, but it must be requested explicitly.
  if (modelId === "claude-opus-4-7") {
    if (reasoning?.enabled === false) return undefined;
    if (reasoning?.enabled === true || reasoning?.effort) return { type: "adaptive" };
    return undefined;
  }
  // Sonnet 4.6: adaptive recommended; can be disabled.
  if (modelId === "claude-sonnet-4-6") {
    if (reasoning?.enabled === false) return { type: "disabled" };
    if (reasoning?.enabled === true || reasoning?.effort) {
      return { type: "adaptive" };
    }
    return undefined;
  }
  // Haiku 4.5 (and other manual-only models): manual enabled/disabled.
  if (modelId.startsWith("claude-haiku-4-5")) {
    if (reasoning?.enabled === false) return { type: "disabled" };
    if (!reasoning?.enabled) return undefined;
    const requested = reasoning.budgetTokens && reasoning.budgetTokens > 0
      ? reasoning.budgetTokens
      : 1024;
    const maxBudget = maxTokens - 1;
    if (maxBudget < 1024) return undefined;
    const budget = Math.max(1024, Math.min(requested, maxBudget));
    return { type: "enabled", budget_tokens: budget };
  }
  return undefined;
}

function anthropicThinkingConstrainsSampling(thinking: AnthropicThinking | undefined): boolean {
  return thinking?.type === "enabled" || thinking?.type === "adaptive";
}

function anthropicOutputConfig(
  model: ModelCapabilityMetadata,
  reasoning: ReasoningConfig | undefined,
  thinking: AnthropicThinking | undefined
): Record<string, unknown> {
  if (thinking?.type !== "adaptive") return {};
  const effort = anthropicEffort(model, reasoning?.effort);
  return effort ? { output_config: { effort } } : {};
}

function anthropicEffort(
  model: ModelCapabilityMetadata,
  effort: ReasoningConfig["effort"]
): "low" | "medium" | "high" | "max" | "xhigh" | undefined {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "max") return "max";
  if (model.modelId === "claude-opus-4-7" && effort === "xhigh") return "xhigh";
  return undefined;
}

function anthropicSamplingPayload(
  model: ModelCapabilityMetadata,
  temperature: number | undefined,
  topP: number | undefined,
  thinking: AnthropicThinking | undefined
): { temperature?: number; top_p?: number } {
  if (model.modelId === "claude-opus-4-7") return {};
  if (anthropicThinkingConstrainsSampling(thinking)) {
    return { temperature: 1 };
  }
  return {
    temperature,
    top_p: topP
  };
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`
  };
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted.");
  }
}

function googleAiStudioHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

function googleAiStudioUrl(provider: ProviderMetadata, model: ModelCapabilityMetadata): string {
  return `${provider.baseUrl}${model.endpoint}/${model.modelId}:generateContent`;
}

const googleSafetySettings = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

function googleUserTurn(text: string) {
  return { role: "user" as const, parts: [{ text }] };
}

function googleGenerationConfig(
  model: ModelCapabilityMetadata,
  opts: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    reasoning?: ReasoningConfig;
  }
): Record<string, unknown> {
  return stripUndefined({
    temperature: opts.temperature,
    topP: opts.topP,
    maxOutputTokens: opts.maxOutputTokens,
    stopSequences: opts.stopSequences?.length ? opts.stopSequences.slice(0, 5) : undefined,
    thinkingConfig: googleThinkingConfig(model, opts.reasoning)
  });
}

function googleThinkingConfig(
  model: ModelCapabilityMetadata,
  reasoning?: ReasoningConfig
): Record<string, unknown> | undefined {
  const modelId = model.modelId;
  // Gemini 3.x flash family uses thinkingLevel (minimal | low | medium | high).
  if (modelId.startsWith("gemini-3")) {
    if (reasoning?.enabled === false) return { thinkingLevel: "minimal" };
    if (reasoning?.effort) return { thinkingLevel: reasoning.effort };
    return undefined;
  }
  // Gemini 2.5 Flash: thinkingBudget; 0 disables; max 24576.
  if (modelId === "gemini-2.5-flash") {
    if (reasoning?.enabled === false) return { thinkingBudget: 0 };
    if (reasoning?.budgetTokens && reasoning.budgetTokens > 0) {
      return { thinkingBudget: Math.min(reasoning.budgetTokens, 24576) };
    }
    return undefined;
  }
  // Gemini 2.5 Flash Lite: 0 disables, -1 requests dynamic thinking, positive budgets clamp to [512, 24576].
  if (modelId === "gemini-2.5-flash-lite") {
    if (reasoning?.enabled === false) return { thinkingBudget: 0 };
    if (reasoning?.enabled === true && !reasoning.budgetTokens) return { thinkingBudget: -1 };
    if (reasoning?.budgetTokens && reasoning.budgetTokens > 0) {
      return { thinkingBudget: Math.max(512, Math.min(reasoning.budgetTokens, 24576)) };
    }
    return undefined;
  }
  return undefined;
}

function googleAiStudioTool(name: string, description: string, parameters: object) {
  return { functionDeclarations: [{ name, description, parameters: googleAiStudioSchema(parameters) }] };
}



function googleForceToolConfig(name: string) {
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
}

function googleAiStudioOrchestratorTool(availableWaifuIds?: string[], replyRequired = false, directiveBudgetOpen = true) {
  return googleAiStudioTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired, directiveBudgetOpen));
}

function googleAiStudioDreamTool(availableWaifuIds?: string[]) {
  return googleAiStudioTool(DREAM_TOOL_NAME, DREAM_TOOL_DESCRIPTION, flatDreamToolParameters(availableWaifuIds));
}

function googleAiStudioObserverTool(availableWaifuIds?: string[]) {
  return googleAiStudioTool(OBSERVER_TOOL_NAME, OBSERVER_TOOL_DESCRIPTION, observerToolParameters(availableWaifuIds));
}

function googleAiStudioReviewerTool() {
  return googleAiStudioTool(REVIEWER_TOOL_NAME, REVIEWER_TOOL_DESCRIPTION, REVIEWER_TOOL_PARAMETERS);
}

function googleAiStudioPickNextWaifuTool(availableWaifuIds?: string[]) {
  return googleAiStudioTool(PICK_NEXT_WAIFU_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_DESCRIPTION, pickNextWaifuToolParameters(availableWaifuIds));
}

function googleAiStudioShortTermMemoryTool() {
  return googleAiStudioTool(SHORT_TERM_MEMORY_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_DESCRIPTION, shortTermMemoryToolParameters());
}

function googleAiStudioPickNextWaifuToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; toolConfig?: { functionCallingConfig: { mode: "AUTO" } } } {
  if (!shouldExposePickNextWaifuTool(model, request)) return {};
  return {
    tools: [googleAiStudioPickNextWaifuTool(request.availableWaifuIds)],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } }
  };
}

function googleAiStudioShortTermMemoryToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; toolConfig?: { functionCallingConfig: { mode: "AUTO" } } } {
  if (!shouldExposeShortTermMemoryTool(model, request)) return {};
  return {
    tools: [googleAiStudioShortTermMemoryTool()],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } }
  };
}

function googleAiStudioWaifuToolsPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; toolConfig?: { functionCallingConfig: { mode: "AUTO" } } } {
  const pick = googleAiStudioPickNextWaifuToolPayload(model, request);
  const mem = googleAiStudioShortTermMemoryToolPayload(model, request);
  const tools = [...(pick.tools ?? []), ...(mem.tools ?? [])];
  if (!tools.length) return {};
  const toolConfig = pick.toolConfig ?? mem.toolConfig;
  return toolConfig ? { tools, toolConfig } : { tools };
}

async function contextToGoogleMessagesForWaifu(
  messages: ContextMessage[],
  includeImages: boolean,
  selfAuthorIds: string[] = []
): Promise<Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }>> {
  return Promise.all(
    messages.map(async (message) => {
      const role: "user" | "model" = roleForWaifuContext(message, selfAuthorIds) === "assistant" ? "model" : "user";
      const text = role === "model" ? formatSelfWaifuContent(message) : formatWaifuContextBlock(message);
      const imageParts = includeImages && role === "user" ? await googleImageParts(message) : [];
      return {
        role,
        parts: [{ text }, ...imageParts]
      };
    })
  );
}

async function googleImageParts(
  message: ContextMessage
): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const parts = await Promise.all((message.images ?? []).map((image) => googleInlineImagePart(image)));
  return parts.filter((part): part is { inlineData: { mimeType: string; data: string } } => part !== undefined);
}

async function googleInlineImagePart(
  image: AttachmentImage
): Promise<{ inlineData: { mimeType: string; data: string } } | undefined> {
  try {
    const response = await fetch(image.url);
    if (!response.ok) return undefined;
    const headerType = response.headers.get("content-type") ?? undefined;
    const fromHeader = headerType && headerType.toLowerCase().startsWith("image/")
      ? headerType.split(";")[0].trim()
      : undefined;
    const mimeType = fromHeader ?? image.contentType ?? guessImageMimeFromUrl(image.url);
    if (!mimeType || !mimeType.startsWith("image/")) return undefined;
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");
    return { inlineData: { mimeType, data } };
  } catch {
    return undefined;
  }
}

function guessImageMimeFromUrl(url: string): string | undefined {
  const match = url.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  if (!match) return undefined;
  switch (match[1]) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    default: return undefined;
  }
}

function extractGoogleText(json: unknown): string {
  const parsed = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

function extractGoogleWaifuResult(json: unknown, availableWaifuIds?: string[]): WaifuGenerationResult {
  const parsed = json as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name?: string; args?: unknown };
        }>;
      };
    }>;
  };
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const pickCall = parts.find((part) => part.functionCall?.name === PICK_NEXT_WAIFU_TOOL_NAME)?.functionCall;
  const shortTermMemoryEntries = parts
    .filter((part) => part.functionCall?.name === SHORT_TERM_MEMORY_TOOL_NAME)
    .map((part) => parseShortTermMemoryArguments(part.functionCall?.args))
    .filter((entry): entry is string => Boolean(entry));
  return {
    content: extractGoogleText(parsed),
    ...parsePickedNextWaifu(pickCall?.args, availableWaifuIds),
    ...(shortTermMemoryEntries.length ? { shortTermMemoryEntries } : {})
  };
}

function extractGoogleToolArguments(json: unknown, toolName: string): string {
  const parsed = json as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name?: string; args?: unknown };
        }>;
      };
    }>;
  };
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const call =
    parts.find((part) => part.functionCall?.name === toolName)?.functionCall
    ?? parts.find((part) => part.functionCall)?.functionCall;
  const args = call?.args;
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return extractGoogleText(parsed);
}

function systemNoteTurn(content: string): string {
  return `<system_note>\n${content}\n</system_note>`;
}

export { ORCHESTRATOR_TOOL_PARAMETERS, DREAM_TOOL_PARAMETERS, OBSERVER_TOOL_PARAMETERS } from "../orchestration/tools.js";

export const __testables = { parseDecision, buildOpenAiChatOrchestratorMessages, formatDecisionOutcome, buildOrchestratorTimeline, serializeOrchestratorDecisionArguments, contextToChatMessagesForWaifu };
