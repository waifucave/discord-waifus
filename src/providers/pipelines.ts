import { z } from "zod";
import { AttachmentImage, ContextMessage, OrchestratorNoReplyMarker, formatOrchestratorMessageBlock, formatTimestamp, formatWaifuContextBlock } from "../orchestration/context.js";
import {
  OrchestratorActionSchema,
  OrchestratorDecision,
  OrchestratorDecisionSchema,
  MAX_WAIFU_DELAY_SECONDS,
  REPLY_STYLE_VALUES,
  ReplyStyle,
  ReplyStyleSchema,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS
} from "../orchestration/decisions.js";
import { ReviewerDecision, ReviewerDecisionSchema } from "../orchestration/reviewer.js";
import {
  OBSERVATION_KINDS,
  StageManagerObservation,
  StageManagerObservationSchema,
  StageManagerToolCall,
  StageManagerToolCallSchema
} from "../orchestration/stageManager.js";
import { OrchestratorDecisionHistoryEntry, ReasoningConfig } from "../shared/schemas/domain.js";
import { getModel, getProviderForModel } from "./catalog.js";
import {
  ModelCapabilityMetadata,
  ModelPipeline,
  ProviderMetadata,
  ProviderRequest,
  StageManagerObserveRequest,
  StageManagerRequest,
  WaifuGenerationRequest,
  WaifuGenerationResult
} from "./types.js";
import { QueryRole, recordProviderQuery } from "../shared/queryLog.js";

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
            contextToChatMessagesForWaifu(request.messages, this.model.supportsImageInput),
            request.memoriesBlock ? { role: "system", content: request.memoriesBlock } : undefined
          ),
          ...replyStyleMessagesForChat(request.replyStyle),
          { role: "system", content: directorNotesContent(request.sceneDirection) }
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
          trailingPrompt: request.trailingPrompt ?? ""
        })),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0.2),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatOrchestratorTool(request.availableWaifuIds, request.replyRequired)],
        tool_choice: openAiChatForcedToolChoice(this.model, ORCHESTRATOR_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, new Map(), request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const rendering = renderContext(request.messages);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds) },
          contextToUserMessage(rendering)
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
      queryRole: "stage_manager"
    });
    return parseStageManagerObservations(text);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const reasoning = openAiChatReasoningForForcedTool(this.model, request.reasoning);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: openAiChatMessagesForModel(this.model, [
          { role: "system", content: librarianSystemPrompt(request.availableWaifuIds) },
          { role: "user", content: `observations: ${JSON.stringify(request.observations ?? [])}` },
          { role: "user", content: `memories: ${JSON.stringify(request.memories)}` }
        ]),
        temperature: openAiChatTemperature(this.model, request.temperature ?? 0.2),
        top_p: openAiChatTopP(this.model, request.topP),
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatStageManagerTool(request.availableWaifuIds)],
        tool_choice: openAiChatForcedToolChoice(this.model, STAGE_MANAGER_TOOL_NAME),
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, reasoning),
        ...openAiChatSamplingOverrides(this.model, reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, STAGE_MANAGER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerCalls(text);
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
            contextToResponsesInputForWaifu(request.messages, this.model.supportsImageInput),
            request.memoriesBlock ? { role: "system", content: request.memoriesBlock } : undefined
          ),
          ...replyStyleMessagesForChat(request.replyStyle),
          { role: "system", content: directorNotesContent(request.sceneDirection) }
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
          trailingPrompt: request.trailingPrompt ?? ""
        }),
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesOrchestratorTool(request.availableWaifuIds, request.replyRequired)],
        tool_choice: { type: "function", name: ORCHESTRATOR_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, new Map(), request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const rendering = renderContext(request.messages);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds),
        input: [contextToUserMessage(rendering)],
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
      queryRole: "stage_manager"
    });
    return parseStageManagerObservations(text);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: librarianSystemPrompt(request.availableWaifuIds),
        input: [
          { role: "user", content: `observations: ${JSON.stringify(request.observations ?? [])}` },
          { role: "user", content: `memories: ${JSON.stringify(request.memories)}` }
        ],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesStageManagerTool(request.availableWaifuIds)],
        tool_choice: { type: "function", name: STAGE_MANAGER_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, STAGE_MANAGER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerCalls(text);
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
            contextToAnthropicMessagesForWaifu(request.messages, this.model.supportsImageInput),
            request.memoriesBlock ? { role: "user" as const, content: request.memoriesBlock } : undefined
          ),
          ...replyStyleMessagesForAnthropic(request.replyStyle),
          { role: "user", content: directorNotesContent(request.sceneDirection) }
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
          trailingPrompt: request.trailingPrompt ?? ""
        }),
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicOrchestratorTool(request.availableWaifuIds, request.replyRequired)],
        tool_choice: { type: "tool", name: ORCHESTRATOR_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, new Map(), request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    const rendering = renderContext(request.messages);
    const maxTokens = request.maxOutputTokens ?? 1024;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds),
        messages: [contextToUserMessage(rendering)],
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicObserverTool(request.availableWaifuIds)],
        tool_choice: { type: "tool", name: OBSERVER_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, OBSERVER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerObservations(text);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    const maxTokens = request.maxOutputTokens ?? 1024;
    validateMaxOutputTokens(this.model, maxTokens);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: librarianSystemPrompt(request.availableWaifuIds),
        messages: [
          { role: "user", content: `observations: ${JSON.stringify(request.observations ?? [])}` },
          { role: "user", content: `memories: ${JSON.stringify(request.memories)}` }
        ],
        ...anthropicSamplingPayload(this.model, request.temperature ?? 0.2, request.topP, undefined),
        max_tokens: maxTokens,
        tools: [anthropicStageManagerTool(request.availableWaifuIds)],
        tool_choice: { type: "tool", name: STAGE_MANAGER_TOOL_NAME }
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, STAGE_MANAGER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerCalls(text);
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
      this.model.supportsImageInput
    );
    const replyHint = replyStyleHint(request.replyStyle);
    const contents = [
      ...injectMemoriesIntoChatContext(
        contextContents,
        request.memoriesBlock ? googleUserTurn(request.memoriesBlock) : undefined
      ),
      ...(replyHint ? [googleUserTurn(replyHint)] : []),
      googleUserTurn(directorNotesContent(request.sceneDirection))
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
          trailingPrompt: request.trailingPrompt ?? ""
        }),
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0.2,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioOrchestratorTool(request.availableWaifuIds, request.replyRequired)],
        toolConfig: googleForceToolConfig(ORCHESTRATOR_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, new Map(), request.replyRequired);
  }

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<StageManagerObservation[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const rendering = renderContext(request.messages);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: { parts: [{ text: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds) }] },
        contents: [googleUserTurn(rendering.block)],
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
      queryRole: "stage_manager"
    });
    return parseStageManagerObservations(text);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    validateMaxOutputTokens(this.model, request.maxOutputTokens);
    const text = await postJsonAndExtractText({
      url: googleAiStudioUrl(this.provider, this.model),
      headers: googleAiStudioHeaders(this.apiKey),
      body: stripUndefined({
        systemInstruction: { parts: [{ text: librarianSystemPrompt(request.availableWaifuIds) }] },
        contents: [
          googleUserTurn(`observations: ${JSON.stringify(request.observations ?? [])}`),
          googleUserTurn(`memories: ${JSON.stringify(request.memories)}`)
        ],
        generationConfig: googleGenerationConfig(this.model, {
          temperature: request.temperature ?? 0.2,
          topP: request.topP,
          maxOutputTokens: request.maxOutputTokens,
          reasoning: request.reasoning
        }),
        safetySettings: googleSafetySettings,
        tools: [googleAiStudioStageManagerTool(request.availableWaifuIds)],
        toolConfig: googleForceToolConfig(STAGE_MANAGER_TOOL_NAME)
      }),
      signal: request.signal,
      extract: (json) => extractGoogleToolArguments(json, STAGE_MANAGER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerCalls(text);
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
  recordProviderQuery(options.queryRole, body);
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
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text.slice(0, 1000) };
    }
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

type ContextRendering = {
  block: string;
  idToIndex: Map<string, number>;
  indexToId: Map<number, string>;
};

function renderContext(
  messages: ContextMessage[],
  markers: OrchestratorNoReplyMarker[] = []
): ContextRendering {
  const idToIndex = new Map<string, number>();
  const indexToId = new Map<number, string>();
  messages.forEach((message, i) => {
    const index = i + 1;
    idToIndex.set(message.id, index);
    indexToId.set(index, message.id);
  });
  type Item =
    | { kind: "message"; message: ContextMessage; index: number }
    | { kind: "marker"; marker: OrchestratorNoReplyMarker };
  const items: Item[] = [
    ...messages.map((message, i): Item => ({ kind: "message", message, index: i + 1 })),
    ...markers.map((marker): Item => ({ kind: "marker", marker }))
  ];
  items.sort((a, b) => {
    const ta = a.kind === "message" ? a.message.timestamp : a.marker.timestamp;
    const tb = b.kind === "message" ? b.message.timestamp : b.marker.timestamp;
    if (ta === tb) {
      if (a.kind === b.kind) return 0;
      return a.kind === "message" ? -1 : 1;
    }
    return ta < tb ? -1 : 1;
  });
  const lines = items.map((item) =>
    item.kind === "message"
      ? formatContextMessage(item.message, item.index, idToIndex)
      : formatNoReplyMarker(item.marker)
  );
  return { block: lines.join("\n"), idToIndex, indexToId };
}

function formatNoReplyMarker(marker: OrchestratorNoReplyMarker): string {
  const reason = marker.reasoning.replace(/\s+/g, " ").trim();
  return `[no_reply] [timestamp: ${marker.timestamp}] [reason: ${reason}] [retrigger: ${marker.retriggerAfterSeconds}s]`;
}

function currentTimeBlock(): string {
  return `<current_time>\n${formatPromptCurrentHour(new Date())}\n</current_time>`;
}

function formatPromptCurrentHour(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + `T${String(date.getHours()).padStart(2, "0")}`;
}

function contextToUserMessage(rendering: ContextRendering) {
  return {
    role: "user",
    content: rendering.block
  };
}

const ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER = "ok";

type OrchestratorTimelineItem =
  | { kind: "message"; message: ContextMessage; timestamp: string }
  | { kind: "decision"; decision: OrchestratorDecisionHistoryEntry; timestamp: string };

function buildOrchestratorTimeline(
  messages: ContextMessage[],
  decisions: OrchestratorDecisionHistoryEntry[]
): OrchestratorTimelineItem[] {
  const oldestMessageTimestamp = messages.length ? messages[0].timestamp : undefined;
  const items: OrchestratorTimelineItem[] = [
    ...messages.map((message): OrchestratorTimelineItem => ({
      kind: "message",
      message,
      timestamp: message.timestamp
    })),
    ...decisions
      .filter((decision) =>
        oldestMessageTimestamp === undefined ? false : decision.createdAt >= oldestMessageTimestamp
      )
      .map((decision): OrchestratorTimelineItem => ({
        kind: "decision",
        decision,
        timestamp: decision.createdAt
      }))
  ];
  items.sort((a, b) => {
    if (a.timestamp === b.timestamp) {
      if (a.kind === b.kind) return 0;
      return a.kind === "message" ? -1 : 1;
    }
    return a.timestamp < b.timestamp ? -1 : 1;
  });
  return items;
}

function serializeOrchestratorDecisionArguments(decision: OrchestratorDecisionHistoryEntry): Record<string, unknown> {
  return {
    action: decision.action,
    respondingWaifus: decision.respondingWaifus.map((responder) => ({
      waifuId: responder.waifuId,
      delaySeconds: responder.delaySeconds,
      replyStyle: responder.replyStyle,
      repleyToMessageIndex: null,
      sceneDirection: responder.sceneDirection ?? null
    })),
    retriggerAfterSeconds:
      decision.action === "no_reply" ? decision.retriggerAfterSeconds ?? null : null,
    reasoning: decision.reasoning
  };
}

type OrchestratorQueryInput = {
  messages: ContextMessage[];
  decisions: OrchestratorDecisionHistoryEntry[];
  trailingPrompt: string;
};

function buildOpenAiChatOrchestratorMessages(
  input: OrchestratorQueryInput & { model: ModelCapabilityMetadata; systemPrompt: string }
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: input.systemPrompt }];
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions)) {
    if (item.kind === "message") {
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
        content: ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER
      });
    }
  }
  messages.push({ role: "system", content: input.trailingPrompt });
  return messages;
}

function buildOpenAiResponsesOrchestratorInput(input: OrchestratorQueryInput): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions)) {
    if (item.kind === "message") {
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
        output: ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER
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
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions)) {
    if (item.kind === "message") {
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
        content: ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER
      });
    }
  }
  userBlocks.push({ type: "text", text: input.trailingPrompt });
  flushUser();
  return result;
}

function buildGoogleOrchestratorContents(input: OrchestratorQueryInput): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const item of buildOrchestratorTimeline(input.messages, input.decisions)) {
    if (item.kind === "message") {
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
              response: { output: ORCHESTRATOR_TOOL_RESULT_PLACEHOLDER }
            }
          }
        ]
      });
    }
  }
  contents.push(googleUserTurn(input.trailingPrompt));
  return contents;
}

function replyStyleHint(replyStyle: ReplyStyle | undefined): string | undefined {
  if (!replyStyle || replyStyle === "normal") return undefined;
  return `<reply_style>${replyStyle}</reply_style>`;
}

function replyStyleMessagesForChat(replyStyle: ReplyStyle | undefined): Array<{ role: "system"; content: string }> {
  const hint = replyStyleHint(replyStyle);
  return hint ? [{ role: "system", content: hint }] : [];
}

function replyStyleMessagesForAnthropic(replyStyle: ReplyStyle | undefined): Array<{ role: "user"; content: string }> {
  const hint = replyStyleHint(replyStyle);
  return hint ? [{ role: "user", content: hint }] : [];
}

function directorNotesContent(sceneDirection: string | undefined): string {
  const notes = [
    "Keep your reply short.",
    "Do not repeat what the previous waifu just said.",
    "Do not repeat a person's name when recent context already makes the target clear.",
    "To pull a quiet person back in, use their <@Name> tag instead of repeating their name; do not tag them again if anyone already tagged them recently."
  ];
  if (sceneDirection) {
    notes.push(`<scene_direction>${sceneDirection}</scene_direction>`);
  }
  return `<director_notes>\n${notes.join("\n")}\n</director_notes>`;
}

function contextToChatMessagesForWaifu(messages: ContextMessage[], includeImages: boolean) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message);
    const text = formatWaifuContextBlock(message);
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

function contextToResponsesInputForWaifu(messages: ContextMessage[], includeImages: boolean) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message);
    const text = formatWaifuContextBlock(message);
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

function contextToAnthropicMessagesForWaifu(messages: ContextMessage[], includeImages: boolean) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message);
    const text = formatWaifuContextBlock(message);
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

function roleForWaifuContext(message: ContextMessage): "assistant" | "user" {
  return message.authorKind === "waifu" ? "assistant" : "user";
}

function formatContextMessage(message: ContextMessage, index: number, idToIndex: Map<string, number>): string {
  const prefix = `[index: #${index}] [timestamp: ${message.timestamp}] ${message.displayName}:`;
  const suffix = buildSuffix(message, idToIndex);
  const body = message.content.length > 0 ? ` ${message.content}` : "";
  return `${prefix}${body}${suffix}`;
}

function buildSuffix(message: ContextMessage, idToIndex: Map<string, number> | undefined): string {
  const parts: string[] = [];
  if (message.images?.length) {
    parts.push(`[images: ${message.images.length}]`);
    message.images.forEach((image, index) => {
      const text = formatOcrText(image.ocrText);
      if (text) {
        parts.push(`[image_text #${index + 1}: ${text}]`);
      }
    });
  }
  if (message.reactions.length) {
    parts.push(
      `[reactions: ${message.reactions.map((reaction) => `${reaction.emoji} x${reaction.count}`).join(", ")}]`
    );
  }
  if (message.replyTo) {
    const referencedIndex = idToIndex?.get(message.replyTo.messageId);
    if (referencedIndex !== undefined) {
      parts.push(`[replying to: #${referencedIndex}]`);
    } else {
      const author = message.replyTo.authorName ?? "unknown";
      const preview = message.replyTo.contentPreview ?? "";
      parts.push(`[replying to: ${author}: ${preview}]`.replace(/\s+\]$/, "]"));
    }
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function formatOcrText(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return normalized || undefined;
}

function observerSystemPrompt(customPrompt?: string, availableWaifuIds?: string[]): string {
  return [customPrompt?.trim(), observerInstruction(availableWaifuIds)].filter(Boolean).join("\n\n");
}

function observerInstruction(availableWaifuIds?: string[]): string {
  const waifuInstruction = availableWaifuIds?.length
    ? `Allowed waifuId values: ${availableWaifuIds.join(", ")}. waifuId is the waifu who should remember this observation; it is never a human user name from chat.`
    : "No waifus are available in this channel; return an empty observations array.";
  return `You are extracting durable memories from a Discord chat window.

Each message in the context is tagged with [index: #N] and [timestamp: ISO-8601 UTC], followed by \`DisplayName:\` and the body, optionally followed by [reactions: ...] and [replying to: ...].

Your only job: scan the window and produce a small list of atomic, durable observations worth remembering. Then call ${OBSERVER_TOOL_NAME} exactly once with an observations array. Do not write normal assistant text. An empty array is allowed and is the correct answer when nothing durable was disclosed.

What counts as a durable observation (test before emitting): "Would this still be useful to know in a week, with zero memory of this conversation?" If no, drop it.

Each observation must be:
- A single atomic fact, stated independently of the chat. Phrase it as a standalone sentence about a named person, not as a recap of what happened.
- Owned by one waifu via waifuId — the waifu who should carry this memory in her prompt going forward. ${waifuInstruction}
- Classified by kind: "fact" (stable attribute), "preference" (likes/dislikes), "relationship" (between two named people), "event" (a dated thing that happened), or "commitment" (a promise or future plan).
- Scored 1–5 for importance: 1 = trivial flavor, 3 = useful when the waifu next talks to this person, 5 = central to who this person is.

Do NOT emit narration. Reject strings shaped like:
- "Kevin and Mia were talking about cooking." (recap, not a fact)
- "The user mentioned a movie." (no specific content)
- "Yuki greeted Kevin warmly." (chat event with no durable substance)
- "Kevin asked about Yuki's day." (small talk, not a fact about anyone)

Do emit things like:
- "Kevin is allergic to peanuts." (fact)
- "Mia prefers green tea over black tea." (preference)
- "Kevin and Mia are siblings." (relationship)
- "Kevin promised to share his cookbook on Friday." (commitment)

Importance heuristic: a one-off mention is a 2; a stated preference is a 3; an allergy / hard constraint / family relation is a 4–5. Emotional intensity alone is not importance.

If the entire window is small talk, banter, or roleplay with no durable facts, return an empty array. That is normal.`;
}

function librarianSystemPrompt(availableWaifuIds?: string[]): string {
  const waifuInstruction = availableWaifuIds?.length
    ? `Allowed memory waifuId values: ${availableWaifuIds.join(", ")}. waifuId is the waifu that receives this memory in her prompt; it is never a human user name.`
    : "No waifus are available for memory ownership in this channel; use no_change.";
  return `You are the memory librarian for a Discord waifu bot.

You receive two JSON blocks in user messages:
- \`observations: ...\` — new durable observations extracted from a recent chat window. Each has waifuId, content, importance, and kind.
- \`memories: ...\` — a pruned list of existing memories that could plausibly collide with those observations. Each has memoryIndex, waifuId, content, importance. Reference existing memories by memoryIndex.

Your job: decide, for each observation, whether it is new (add), already covered by an existing memory (no_change), a sharpening of an existing memory (update_memory), one of a group that should merge (merge_memories), or supersedes a now-wrong memory (archive_memory + add_memory).

${waifuInstruction}
All memory edits apply only to the current Discord server. Do not choose or mention global, channel, or user scopes.

Policy:
- If an observation restates an existing memory verbatim or in spirit, prefer no_change for that observation; only update_memory if the observation strictly refines the existing one (more specific, corrected, or higher importance).
- If two or more existing memories about the same waifu say overlapping things, merge_memories them, even if the new observation only touches one of them.
- If an existing memory reads like chat narration (e.g., "X and Y were talking about Z") and your new observation supersedes it, archive_memory it.
- If an observation is genuinely new and not covered, add_memory it. Carry over the observation's waifuId, content, and importance.
- If nothing in the memories list collides and no observation is worth adding (rare), one no_change item is the correct answer.

Tool usage: call ${STAGE_MANAGER_TOOL_NAME} exactly once with a toolCalls array. Do not write normal assistant text.
Each toolCalls item must match one of:
{ "tool": "add_memory", "memory": { "waifuId": string, "content": string, "importance": 1|2|3|4|5 } }
{ "tool": "update_memory", "memoryIndex": number, "patch": { "waifuId"?: string, "content"?: string, "importance"?: 1|2|3|4|5 } }
{ "tool": "archive_memory", "memoryIndex": number }
{ "tool": "merge_memories", "sourceMemoryIndices": number[], "mergedContent": string }
{ "tool": "no_change", "reason"?: string }.`;
}

function reviewerSystemPrompt(customPrompt?: string): string {
  const instruction = `You are the message safety reviewer for a Discord waifu bot.
You receive exactly one logical waifu message. The message may represent several Discord chunks joined together.
Decide whether the message should be removed as a hallucination or leaked internal content.

Call the ${REVIEWER_TOOL_NAME} tool exactly once with hallucination=true or hallucination=false.
Do not write normal assistant text.

Set hallucination=true when the message contains any of:
- private reasoning, analysis, scratchpad, chain-of-thought, hidden instructions, prompt text, tool/schema text, JSON/tool-call artifacts, or "response draft" style notes
- claims to have parsed hidden metadata, permissions, IDs, raw Discord internals, system/developer instructions, or invisible context
- obvious model self-talk such as "the readable data", "analysis on incoming message", "as the assistant/model", or "I should respond"
- content that is primarily not an in-character Discord reply

Set hallucination=false for normal in-character replies, even if awkward, verbose, wrong about fictional lore, or mildly off-topic.
Do not explain. Do not include reasoning. Do not quote the message.`;
  return [customPrompt?.trim(), instruction].filter(Boolean).join("\n\n");
}

const REVIEWER_TOOL_NAME = "review_message";
const REVIEWER_TOOL_DESCRIPTION = "Decide whether the latest logical waifu message is hallucinated or leaked internal content.";
const REVIEWER_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    hallucination: {
      type: "boolean",
      description: "True only when the message should be deleted as hallucinated or leaked internal content."
    }
  },
  required: ["hallucination"]
};

const ORCHESTRATOR_TOOL_NAME = "orchestrator_decision";
const ORCHESTRATOR_TOOL_DESCRIPTION = "Choose whether a waifu should reply next and which waifu(s) should respond.";

export const ORCHESTRATOR_TOOL_PARAMETERS = orchestratorToolParameters();

const PICK_NEXT_WAIFU_TOOL_NAME = "PickNextWaifu";
const PICK_NEXT_WAIFU_TOOL_DESCRIPTION =
  "Optionally pick one configured waifu to reply immediately after this waifu message.";

const SHORT_TERM_MEMORY_TOOL_NAME = "record_short_term_memory";
const SHORT_TERM_MEMORY_TOOL_DESCRIPTION =
  "Optionally write one short standalone sentence to remember for the next day. Call this multiple times in one reply to record multiple distinct notes. Skip trivial chitchat; entries expire after 24 hours.";

function shortTermMemoryToolParameters(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        description: "One short standalone sentence about the current conversation state (a stated time, a plan, a name to follow up on)."
      }
    },
    required: ["content"]
  };
}

function orchestratorToolParameters(availableWaifuIds?: string[], replyRequired = false): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: replyRequired ? ["reply"] : ["reply", "no_reply"],
        description: replyRequired
          ? "\"reply\" is required for this manual run."
          : "\"reply\" when at least one waifu should answer; \"no_reply\" when nobody should speak now."
      },
      respondingWaifus: {
        type: "array",
        description: "Ordered list of waifus that will reply, in send order. Must be non-empty when action is \"reply\" and must be empty when action is \"no_reply\". Waifus speak one after the other; any incoming chat message cancels the rest of the chain.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            waifuId: waifuIdSchema,
            delaySeconds: {
              type: "number",
              minimum: 0,
              maximum: MAX_WAIFU_DELAY_SECONDS,
              description: `Realistic reading/typing delay before this waifu starts replying, in seconds. 0 means start immediately; maximum is ${MAX_WAIFU_DELAY_SECONDS}.`
            },
            replyStyle: {
              type: "string",
              enum: [...REPLY_STYLE_VALUES],
              description: "Soft hint for this reply's length and tone: \"normal\" is the default, \"short\" is one terse line, \"long\" leans toward a slightly longer reply, \"sleepy\" sounds tired/low-energy."
            },
            repleyToMessageIndex: {
              anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
              description: "Optional #N context index to reply to; only set when intentionally anchoring to a specific older message. Otherwise null."
            },
            sceneDirection: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "Optional one-line invisible direction shaping this waifu's next message. Use when the persona alone won't carry the beat. Null when no special steering is needed."
            }
          },
          required: ["waifuId", "delaySeconds", "replyStyle", "repleyToMessageIndex", "sceneDirection"]
        }
      },
      retriggerAfterSeconds: {
        anyOf: [
          { type: "number", minimum: RETRIGGER_MIN_SECONDS, maximum: RETRIGGER_MAX_SECONDS },
          { type: "null" }
        ],
        description: `Required when action is \"no_reply\": seconds to wait before the orchestrator re-evaluates the room (${RETRIGGER_MIN_SECONDS}..${RETRIGGER_MAX_SECONDS}). Must be null when action is \"reply\".`
      },
      reasoning: {
        type: "string",
        description: "Brief operational reason for this decision."
      }
    },
    required: ["action", "respondingWaifus", "retriggerAfterSeconds", "reasoning"]
  };
}

function pickNextWaifuToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of these configured waifu ids: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      waifuId: waifuIdSchema
    },
    required: ["waifuId"]
  };
}

const STAGE_MANAGER_TOOL_NAME = "manage_memories";
const STAGE_MANAGER_TOOL_DESCRIPTION = "Return the complete set of memory edits needed for the current Discord context.";
export const STAGE_MANAGER_TOOL_PARAMETERS = stageManagerToolParameters();

const OBSERVER_TOOL_NAME = "record_observations";
const OBSERVER_TOOL_DESCRIPTION = "Return atomic, durable observations extracted from the chat window. An empty array means nothing durable was disclosed.";
export const OBSERVER_TOOL_PARAMETERS = observerToolParameters();

function observerToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}. This is the memory owner, not a human user.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      observations: {
        type: "array",
        description: "Durable observations to record. Empty array is valid and means nothing durable was disclosed.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["waifuId", "content", "importance", "kind"],
          properties: {
            waifuId: waifuIdSchema,
            content: { type: "string", description: "Atomic standalone fact, not a recap of chat events." },
            importance: { type: "integer", enum: [1, 2, 3, 4, 5] },
            kind: { type: "string", enum: [...OBSERVATION_KINDS] }
          }
        }
      }
    },
    required: ["observations"]
  };
}

function stageManagerToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}. This is the memory owner, not a human user.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      toolCalls: {
        type: "array",
        description: "Memory edit operations to apply. Use one no_change item when no edit is needed.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            tool: {
              type: "string",
              enum: ["add_memory", "update_memory", "archive_memory", "merge_memories", "no_change"]
            },
            memory: {
              type: "object",
              description: "Required when tool is add_memory.",
              additionalProperties: false,
              properties: {
                waifuId: waifuIdSchema,
                content: { type: "string" },
                importance: { type: "integer", enum: [1, 2, 3, 4, 5] }
              },
              required: ["waifuId", "content", "importance"]
            },
            memoryIndex: {
              type: "integer",
              minimum: 1,
              description: "Required for update_memory or archive_memory."
            },
            patch: {
              type: "object",
              description: "Required when tool is update_memory.",
              additionalProperties: false,
              properties: {
                waifuId: waifuIdSchema,
                content: { type: "string" },
                importance: { type: "integer", enum: [1, 2, 3, 4, 5] }
              }
            },
            sourceMemoryIndices: {
              type: "array",
              description: "Required when tool is merge_memories.",
              minItems: 2,
              items: { type: "integer", minimum: 1 }
            },
            mergedContent: {
              type: "string",
              description: "Required when tool is merge_memories."
            },
            reason: {
              type: "string",
              description: "Optional explanation for no_change."
            }
          },
          required: ["tool"]
        }
      }
    },
    required: ["toolCalls"]
  };
}

function flatStageManagerToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Configured waifu id; must be one of: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    properties: {
      toolCalls: {
        type: "array",
        description: "Memory edit operations to apply. Use one no_change item when no edit is needed.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: ["add_memory", "update_memory", "archive_memory", "merge_memories", "no_change"]
            },
            waifuId: {
              ...waifuIdSchema,
              description: "Required for add_memory. Optional for update_memory."
            },
            content: {
              type: "string",
              description: "Memory content for add_memory/update_memory, or the merged content for merge_memories."
            },
            importance: {
              type: "integer",
              enum: [1, 2, 3, 4, 5],
              description: "Required for add_memory. Optional for update_memory."
            },
            memoryIndex: {
              type: "integer",
              minimum: 1,
              description: "Required for update_memory or archive_memory."
            },
            sourceMemoryIndices: {
              type: "array",
              description: "Required for merge_memories.",
              minItems: 2,
              items: { type: "integer", minimum: 1 }
            },
            reason: {
              type: "string",
              description: "Optional explanation for no_change."
            }
          },
          required: ["tool"]
        }
      }
    },
    required: ["toolCalls"]
  };
}

function openAiChatOrchestratorTool(availableWaifuIds?: string[], replyRequired = false) {
  return openAiChatTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired));
}

function openAiResponsesOrchestratorTool(availableWaifuIds?: string[], replyRequired = false) {
  return openAiResponsesTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired));
}

function anthropicOrchestratorTool(availableWaifuIds?: string[], replyRequired = false) {
  return anthropicTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired));
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

function openAiChatStageManagerTool(availableWaifuIds?: string[]) {
  return openAiChatTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, stageManagerToolParameters(availableWaifuIds));
}

function openAiResponsesStageManagerTool(availableWaifuIds?: string[]) {
  return openAiResponsesTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, stageManagerToolParameters(availableWaifuIds));
}

function anthropicStageManagerTool(availableWaifuIds?: string[]) {
  return anthropicTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, stageManagerToolParameters(availableWaifuIds));
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

const RawRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0),
  replyStyle: ReplyStyleSchema,
  repleyToMessageIndex: z.union([z.number().int().min(1), z.null()]).optional(),
  sceneDirection: z.union([z.string().min(1), z.null()]).optional()
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
  reasoning: z.string().min(1)
});

const RawStageManagerPatchSchema = z.object({
  waifuId: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  importance: RawImportanceSchema.optional()
});

const RawStageManagerToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("add_memory"),
    memory: z.object({
      waifuId: z.string().min(1),
      content: z.string().min(1),
      importance: RawImportanceSchema
    })
  }),
  z.object({
    tool: z.literal("update_memory"),
    memoryIndex: z.number().int().min(1),
    patch: RawStageManagerPatchSchema
  }),
  z.object({
    tool: z.literal("archive_memory"),
    memoryIndex: z.number().int().min(1)
  }),
  z.object({
    tool: z.literal("merge_memories"),
    sourceMemoryIndices: z.array(z.number().int().min(1)).min(2),
    mergedContent: z.string().min(1)
  }),
  z.object({
    tool: z.literal("no_change"),
    reason: z.string().optional()
  })
]);

const RawFlatStageManagerToolCallSchema = z.object({
  tool: z.enum(["add_memory", "update_memory", "archive_memory", "merge_memories", "no_change"]),
  waifuId: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  importance: RawImportanceSchema.optional(),
  memoryIndex: z.number().int().min(1).optional(),
  sourceMemoryIndices: z.array(z.number().int().min(1)).min(2).optional(),
  mergedContent: z.string().min(1).optional(),
  reason: z.string().optional()
});

function parseDecision(text: string, indexToId: Map<number, string>, replyRequired = false): OrchestratorDecision {
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
        delaySeconds: entry.delaySeconds,
        replyStyle: entry.replyStyle,
        replyToMessageId: replyToMessageIdForIndex(entry.repleyToMessageIndex, indexToId),
        sceneDirection: entry.sceneDirection ?? undefined
      })),
      retriggerAfterSeconds:
        raw.retriggerAfterSeconds === null ? undefined : raw.retriggerAfterSeconds,
      reasoning: raw.reasoning
    });
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return a valid orchestrator decision.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function replyToMessageIdForIndex(
  repleyToMessageIndex: number | null | undefined,
  indexToId: Map<number, string>
): string | undefined {
  if (repleyToMessageIndex === null || repleyToMessageIndex === undefined) {
    return undefined;
  }
  const messageId = indexToId.get(repleyToMessageIndex);
  if (!messageId) {
    throw new Error(`repleyToMessageIndex #${repleyToMessageIndex} does not exist in the provided context.`);
  }
  return messageId;
}

function parseStageManagerCalls(text: string): StageManagerToolCall[] {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const calls = Array.isArray(parsed) ? parsed : (parsed.toolCalls ?? parsed.calls ?? []);
    return calls.map((call: unknown) => normalizeStageManagerToolCall(call));
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return valid stage-manager tool calls.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeStageManagerToolCall(call: unknown): StageManagerToolCall {
  const nested = RawStageManagerToolCallSchema.safeParse(call);
  if (nested.success) {
    return StageManagerToolCallSchema.parse(nested.data);
  }

  const raw = RawFlatStageManagerToolCallSchema.parse(call);
  switch (raw.tool) {
    case "add_memory":
      return StageManagerToolCallSchema.parse({
        tool: raw.tool,
        memory: {
          waifuId: raw.waifuId,
          content: raw.content,
          importance: raw.importance
        }
      });
    case "update_memory":
      return StageManagerToolCallSchema.parse({
        tool: raw.tool,
        memoryIndex: raw.memoryIndex,
        patch: stripUndefined({
          waifuId: raw.waifuId,
          content: raw.content,
          importance: raw.importance
        })
      });
    case "archive_memory":
      return StageManagerToolCallSchema.parse({
        tool: raw.tool,
        memoryIndex: raw.memoryIndex
      });
    case "merge_memories":
      return StageManagerToolCallSchema.parse({
        tool: raw.tool,
        sourceMemoryIndices: raw.sourceMemoryIndices,
        mergedContent: raw.mergedContent ?? raw.content
      });
    case "no_change":
      return StageManagerToolCallSchema.parse({
        tool: raw.tool,
        reason: raw.reason
      });
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
  if (model.providerId !== "zai" || messages.some((message) => message.role === "user")) {
    return messages;
  }
  const lastIndex = messages.length - 1;
  return messages.map((message, index) =>
    index === lastIndex ? { ...message, role: "user" } : message
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
    stopSequences: opts.stopSequences?.length ? opts.stopSequences : undefined,
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

function googleAiStudioSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => googleAiStudioSchema(item));
  }
  if (!isRecord(schema)) return schema;

  const converted: Record<string, unknown> = {};
  let nullable = false;

  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "anyOf") continue;
    if (key === "enum" && Array.isArray(value)) {
      converted.enum = value.map(String);
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const nonNullTypes = value.filter((item) => item !== "null");
      nullable = nonNullTypes.length !== value.length;
      converted.type = nonNullTypes.length === 1 ? nonNullTypes[0] : googleAiStudioSchema(nonNullTypes);
      continue;
    }
    converted[key] = googleAiStudioSchema(value);
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const nonNullSchemas = anyOf.filter((item) => !(isRecord(item) && item.type === "null"));
    const hasNullSchema = nonNullSchemas.length !== anyOf.length;
    if (hasNullSchema && nonNullSchemas.length === 1) {
      const base = googleAiStudioSchema(nonNullSchemas[0]);
      if (isRecord(base)) {
        const parentFields = { ...converted };
        Object.assign(converted, base, parentFields);
        nullable = true;
      }
    } else {
      converted.anyOf = anyOf.map((item) => googleAiStudioSchema(item));
    }
  }

  if (nullable) {
    converted.nullable = true;
  }
  return converted;
}

function googleForceToolConfig(name: string) {
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
}

function googleAiStudioOrchestratorTool(availableWaifuIds?: string[], replyRequired = false) {
  return googleAiStudioTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds, replyRequired));
}

function googleAiStudioStageManagerTool(availableWaifuIds?: string[]) {
  return googleAiStudioTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, flatStageManagerToolParameters(availableWaifuIds));
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
  includeImages: boolean
): Promise<Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }>> {
  return Promise.all(
    messages.map(async (message) => {
      const role: "user" | "model" = roleForWaifuContext(message) === "assistant" ? "model" : "user";
      const text = formatWaifuContextBlock(message);
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
