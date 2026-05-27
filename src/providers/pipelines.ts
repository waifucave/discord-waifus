import { z } from "zod";
import { ContextMessage, OrchestratorNoReplyMarker, formatTimestamp } from "../orchestration/context.js";
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
import { StageManagerToolCall, StageManagerToolCallSchema } from "../orchestration/stageManager.js";
import { ReasoningConfig } from "../shared/schemas/domain.js";
import { getModel, getProviderForModel } from "./catalog.js";
import {
  ModelCapabilityMetadata,
  ModelPipeline,
  ProviderMetadata,
  ProviderRequest,
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

const WAIFU_STOP_SEQUENCES = ["\n[timestamp:", "\n[sender:"];

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
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: [
          { role: "system", content: request.systemPrompt },
          ...contextToChatMessagesForWaifu(request.messages, this.model.supportsImageInput),
          ...replyStyleMessagesForChat(request.replyStyle),
          { role: "system", content: directorNotesContent(request.sceneDirection) }
        ],
        temperature: request.temperature ?? this.model.defaultTemperature,
        top_p: request.topP ?? this.model.defaultTopP,
        max_tokens: request.maxOutputTokens,
        ...openAiChatPickNextWaifuToolPayload(this.model, request),
        stop: WAIFU_STOP_SEQUENCES,
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, request.reasoning),
        ...openAiChatSamplingOverrides(this.model, request.reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatWaifuResult(json, request.availableWaifuIds),
      queryRole: "waifu"
    });
    return result;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const rendering = renderContext(request.messages, request.decisionMarkers);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: [
          { role: "system", content: request.systemPrompt },
          contextToNamedUserMessage("messages", rendering),
          { role: "user", content: currentTimeBlock() }
        ],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatOrchestratorTool(request.availableWaifuIds)],
        tool_choice: { type: "function", function: { name: ORCHESTRATOR_TOOL_NAME } },
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, request.reasoning),
        ...openAiChatSamplingOverrides(this.model, request.reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, rendering.indexToId);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    const rendering = renderContext(request.messages);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: [
          { role: "system", content: stageManagerSystemPrompt(request.systemPrompt) },
          contextToNamedUserMessage("messages", rendering),
          { role: "user", name: "memories", content: JSON.stringify(request.memories) }
        ],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_tokens: request.maxOutputTokens,
        tools: [openAiChatStageManagerTool()],
        tool_choice: { type: "function", function: { name: STAGE_MANAGER_TOOL_NAME } },
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, request.reasoning),
        ...openAiChatSamplingOverrides(this.model, request.reasoning)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiChatToolArguments(json, STAGE_MANAGER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerCalls(text);
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: [
          { role: "system", content: reviewerSystemPrompt(request.systemPrompt) },
          { role: "user", content: request.message }
        ],
        temperature: request.temperature ?? 0,
        top_p: request.topP,
        max_tokens: request.maxOutputTokens ?? 64,
        tools: [openAiChatReviewerTool()],
        tool_choice: { type: "function", function: { name: REVIEWER_TOOL_NAME } },
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, request.reasoning),
        ...openAiChatSamplingOverrides(this.model, request.reasoning)
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
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: request.systemPrompt,
        input: [
          ...contextToResponsesInputForWaifu(request.messages, this.model.supportsImageInput),
          ...replyStyleMessagesForChat(request.replyStyle),
          { role: "system", content: directorNotesContent(request.sceneDirection) }
        ],
        temperature: request.temperature ?? this.model.defaultTemperature,
        top_p: request.topP ?? this.model.defaultTopP,
        max_output_tokens: request.maxOutputTokens,
        ...openAiResponsesPickNextWaifuToolPayload(this.model, request),
        stop: WAIFU_STOP_SEQUENCES,
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
    const rendering = renderContext(request.messages, request.decisionMarkers);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: request.systemPrompt,
        input: [contextToResponsesMessagesInput(rendering), { role: "user", content: currentTimeBlock() }],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesOrchestratorTool(request.availableWaifuIds)],
        tool_choice: { type: "function", name: ORCHESTRATOR_TOOL_NAME },
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: (json) => extractOpenAiResponsesToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, rendering.indexToId);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    const rendering = renderContext(request.messages);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: stageManagerSystemPrompt(request.systemPrompt),
        input: [
          contextToResponsesMessagesInput(rendering),
          { role: "user", content: `memories: ${JSON.stringify(request.memories)}` }
        ],
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tools: [openAiResponsesStageManagerTool()],
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
    const maxTokens = request.maxOutputTokens ?? 1024;
    const thinking = anthropicThinkingPayload(this.model, request.reasoning, maxTokens);
    const constrainsSampling = anthropicThinkingConstrainsSampling(thinking);
    const result = await postJsonAndExtractText<WaifuGenerationResult>({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: request.systemPrompt,
        messages: [
          ...contextToAnthropicMessagesForWaifu(request.messages, this.model.supportsImageInput),
          ...replyStyleMessagesForAnthropic(request.replyStyle),
          { role: "user", content: directorNotesContent(request.sceneDirection) }
        ],
        temperature: constrainsSampling ? 1 : request.temperature ?? this.model.defaultTemperature,
        top_p: constrainsSampling ? undefined : request.topP ?? this.model.defaultTopP,
        max_tokens: maxTokens,
        ...anthropicPickNextWaifuToolPayload(this.model, request),
        stop_sequences: WAIFU_STOP_SEQUENCES,
        ...(thinking ? { thinking } : {})
      },
      signal: request.signal,
      extract: (json) => extractAnthropicWaifuResult(json, request.availableWaifuIds),
      queryRole: "waifu"
    });
    return result;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const rendering = renderContext(request.messages, request.decisionMarkers);
    const maxTokens = request.maxOutputTokens ?? 1024;
    const thinking = anthropicThinkingPayload(this.model, request.reasoning, maxTokens);
    const constrainsSampling = anthropicThinkingConstrainsSampling(thinking);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: request.systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: rendering.block },
              { type: "text", text: currentTimeBlock() }
            ]
          }
        ],
        temperature: constrainsSampling ? 1 : request.temperature ?? 0.2,
        top_p: constrainsSampling ? undefined : request.topP,
        max_tokens: maxTokens,
        tools: [anthropicOrchestratorTool(request.availableWaifuIds)],
        tool_choice: { type: "tool", name: ORCHESTRATOR_TOOL_NAME },
        ...(thinking ? { thinking } : {})
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, ORCHESTRATOR_TOOL_NAME),
      queryRole: "orchestrator"
    });
    return parseDecision(text, rendering.indexToId);
  }

  async decideStageManager(request: StageManagerRequest): Promise<StageManagerToolCall[]> {
    const rendering = renderContext(request.messages);
    const maxTokens = request.maxOutputTokens ?? 1024;
    const thinking = anthropicThinkingPayload(this.model, request.reasoning, maxTokens);
    const constrainsSampling = anthropicThinkingConstrainsSampling(thinking);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: stageManagerSystemPrompt(request.systemPrompt),
        messages: [
          contextToAnthropicMessagesPrompt(rendering),
          { role: "user", content: `memories: ${JSON.stringify(request.memories)}` }
        ],
        temperature: constrainsSampling ? 1 : request.temperature ?? 0.2,
        top_p: constrainsSampling ? undefined : request.topP,
        max_tokens: maxTokens,
        tools: [anthropicStageManagerTool()],
        tool_choice: { type: "tool", name: STAGE_MANAGER_TOOL_NAME },
        ...(thinking ? { thinking } : {})
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, STAGE_MANAGER_TOOL_NAME),
      queryRole: "stage_manager"
    });
    return parseStageManagerCalls(text);
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    const maxTokens = request.maxOutputTokens ?? (request.reasoning?.enabled || request.reasoning?.effort ? 2048 : 256);
    const thinking = anthropicThinkingPayload(this.model, request.reasoning, maxTokens);
    const constrainsSampling = anthropicThinkingConstrainsSampling(thinking);
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: reviewerSystemPrompt(request.systemPrompt),
        messages: [{ role: "user", content: request.message }],
        temperature: constrainsSampling ? 1 : request.temperature ?? 0,
        top_p: constrainsSampling ? undefined : request.topP,
        max_tokens: maxTokens,
        tools: [anthropicReviewerTool()],
        tool_choice: { type: "tool", name: REVIEWER_TOOL_NAME },
        ...(thinking ? { thinking } : {})
      },
      signal: request.signal,
      extract: (json) => extractAnthropicToolArguments(json, REVIEWER_TOOL_NAME),
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

function contextToNamedUserMessage(name: string, rendering: ContextRendering) {
  return {
    role: "user",
    name: safeName(name),
    content: rendering.block
  };
}

function contextToResponsesMessagesInput(rendering: ContextRendering) {
  return {
    role: "user",
    content: rendering.block
  };
}

function contextToAnthropicMessagesPrompt(rendering: ContextRendering) {
  return {
    role: "user",
    content: rendering.block
  };
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
    notes.push(`Scene direction: ${sceneDirection}`);
  }
  return `<director_notes>\n${notes.join("\n")}\n</director_notes>`;
}

function contextToChatMessagesForWaifu(messages: ContextMessage[], includeImages: boolean) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message);
    const text = formatWaifuContextLine(message);
    const imageBlocks = includeImages && role === "user" ? chatImageBlocks(message) : [];
    return {
      role,
      name: pickProviderName(message),
      content: imageBlocks.length ? [{ type: "text", text }, ...imageBlocks] : text
    };
  });
}

function chatImageBlocks(message: ContextMessage) {
  return (message.images ?? []).map((image) => ({
    type: "image_url" as const,
    image_url: { url: image.url }
  }));
}

function pickProviderName(message: ContextMessage): string {
  const fromDisplay = safeName(message.displayName);
  if (fromDisplay !== "user") return fromDisplay;
  return safeName(message.name);
}

function contextToResponsesInputForWaifu(messages: ContextMessage[], includeImages: boolean) {
  return messages.map((message) => {
    const role = roleForWaifuContext(message);
    const text = formatWaifuContextLine(message);
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
    const text = formatWaifuContextLine(message);
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

function formatWaifuContextLine(message: ContextMessage): string {
  const prefix = `[timestamp: ${message.timestamp}] [sender: ${message.displayName}]`;
  const suffix = buildSuffix(message, undefined);
  return `${prefix} ${message.content}${suffix}`;
}

function formatContextMessage(message: ContextMessage, index: number, idToIndex: Map<string, number>): string {
  const prefix = `[index: #${index}] [timestamp: ${message.timestamp}] [sender: ${message.displayName}]`;
  const suffix = buildSuffix(message, idToIndex);
  return `${prefix} ${message.content}${suffix}`;
}

function buildSuffix(message: ContextMessage, idToIndex: Map<string, number> | undefined): string {
  const parts: string[] = [];
  if (message.images?.length) {
    parts.push(`[images: ${message.images.length}]`);
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

function stageManagerSystemPrompt(customPrompt?: string): string {
  return [customPrompt?.trim(), stageManagerJsonInstruction()].filter(Boolean).join("\n\n");
}

export function safeName(input: string): string {
  if (!input) return "user";
  const decomposed = input.normalize("NFKD");
  const cleaned = decomposed
    .replace(/\p{M}/gu, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "user";
  return cleaned.slice(0, 64);
}

function stageManagerJsonInstruction(): string {
  return `Each message in the context is tagged with [index: #N], [timestamp: ISO-8601 UTC], and [sender: DisplayName] before its body, optionally followed by [reactions: ...] and [replying to: ...]. Reference messages by their #N index.
Each existing memory in the memories input has a memoryIndex. Reference existing memories by memoryIndex.
Tool usage: compare the context to existing memories for this Discord server, choose all needed memory edits, and call ${STAGE_MANAGER_TOOL_NAME} exactly once with a toolCalls array. Do not write normal assistant text.
All memory edits apply only to the current Discord server. Do not choose or mention global, channel, or user scopes.
Each toolCalls item must match one of:
{ "tool": "add_memory", "memory": { "waifuId": string, "content": string, "importance": 1|2|3|4|5 } }
{ "tool": "update_memory", "memoryIndex": number, "patch": { "waifuId"?: string, "content"?: string, "importance"?: 1|2|3|4|5 } }
{ "tool": "archive_memory", "memoryIndex": number }
{ "tool": "merge_memories", "sourceMemoryIndices": number[], "mergedContent": string }
{ "tool": "no_change", "reason"?: string }.
Use no_change when no durable memory edit is needed.`;
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

function orchestratorToolParameters(availableWaifuIds?: string[]): object {
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
        enum: ["reply", "no_reply"],
        description: "\"reply\" when at least one waifu should answer; \"no_reply\" when nobody should speak now."
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
export const STAGE_MANAGER_TOOL_PARAMETERS = {
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
              waifuId: { type: "string" },
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
              waifuId: { type: "string" },
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

function openAiChatOrchestratorTool(availableWaifuIds?: string[]) {
  return openAiChatTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds));
}

function openAiResponsesOrchestratorTool(availableWaifuIds?: string[]) {
  return openAiResponsesTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds));
}

function anthropicOrchestratorTool(availableWaifuIds?: string[]) {
  return anthropicTool(ORCHESTRATOR_TOOL_NAME, ORCHESTRATOR_TOOL_DESCRIPTION, orchestratorToolParameters(availableWaifuIds));
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

function openAiChatStageManagerTool() {
  return openAiChatTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, STAGE_MANAGER_TOOL_PARAMETERS);
}

function openAiResponsesStageManagerTool() {
  return openAiResponsesTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, STAGE_MANAGER_TOOL_PARAMETERS);
}

function anthropicStageManagerTool() {
  return anthropicTool(STAGE_MANAGER_TOOL_NAME, STAGE_MANAGER_TOOL_DESCRIPTION, STAGE_MANAGER_TOOL_PARAMETERS);
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

function openAiChatPickNextWaifuToolPayload(
  model: ModelCapabilityMetadata,
  request: WaifuGenerationRequest
): { tools?: unknown[]; tool_choice?: "auto" } {
  if (!shouldExposePickNextWaifuTool(model, request)) return {};
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
  importance: ImportanceSchema.optional()
});

const RawStageManagerToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("add_memory"),
    memory: z.object({
      waifuId: z.string().min(1),
      content: z.string().min(1),
      importance: ImportanceSchema
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

function parseDecision(text: string, indexToId: Map<number, string>): OrchestratorDecision {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const raw = RawOrchestratorDecisionSchema.parse(parsed);
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
    return calls.map((call: unknown) => {
      const raw = RawStageManagerToolCallSchema.parse(call);
      return StageManagerToolCallSchema.parse(raw);
    });
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return valid stage-manager tool calls.", {
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
  return {
    content: message?.content ?? "",
    ...parsePickedNextWaifu(toolCall?.function?.arguments, availableWaifuIds)
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
  return {
    content: extractOpenAiResponsesText(parsed),
    ...parsePickedNextWaifu(call?.arguments, availableWaifuIds)
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
  return {
    content: extractAnthropicText(parsed),
    ...parsePickedNextWaifu(toolUse?.input, availableWaifuIds)
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
    if (controls.has("reasoning.effort") && reasoning.effort) {
      return { reasoning_effort: reasoning.effort };
    }
    return {};
  }
  if (model.providerId === "deepseek") {
    const thinking: Record<string, unknown> = {};
    if (controls.has("reasoning.enabled") && reasoning.enabled !== undefined) {
      thinking.type = reasoning.enabled ? "enabled" : "disabled";
    }
    if (controls.has("reasoning.effort") && reasoning.effort) {
      thinking.reasoning_effort = reasoning.effort;
    }
    return Object.keys(thinking).length ? { thinking } : {};
  }
  if (model.providerId === "zai") {
    if (controls.has("reasoning.enabled") && reasoning.enabled !== undefined) {
      return { thinking: { type: reasoning.enabled ? "enabled" : "disabled" } };
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
    return { reasoning: { effort: reasoning.effort } };
  }
  return {};
}

type AnthropicThinking =
  | { type: "enabled"; budget_tokens: number }
  | { type: "adaptive"; effort?: "low" | "medium" | "high" }
  | { type: "disabled" };

function anthropicThinkingPayload(
  model: ModelCapabilityMetadata,
  reasoning: ReasoningConfig | undefined,
  maxTokens: number
): AnthropicThinking | undefined {
  const modelId = model.modelId;
  // Opus 4.7: adaptive-only. Always send adaptive; cannot be disabled.
  if (modelId === "claude-opus-4-7") {
    return { type: "adaptive", effort: reasoning?.effort ?? "high" };
  }
  // Sonnet 4.6: adaptive recommended; can be disabled.
  if (modelId === "claude-sonnet-4-6") {
    if (reasoning?.enabled === false) return { type: "disabled" };
    if (reasoning?.enabled === true || reasoning?.effort) {
      return { type: "adaptive", effort: reasoning?.effort ?? "high" };
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
    const budget = Math.max(1024, Math.min(requested, Math.max(1024, maxTokens - 1)));
    return { type: "enabled", budget_tokens: budget };
  }
  return undefined;
}

function anthropicThinkingConstrainsSampling(thinking: AnthropicThinking | undefined): boolean {
  return thinking?.type === "enabled" || thinking?.type === "adaptive";
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
