import { z } from "zod";
import { ContextMessage, OrchestratorNoReplyMarker, formatTimestamp } from "../orchestration/context.js";
import { OrchestratorDecision, OrchestratorDecisionSchema } from "../orchestration/decisions.js";
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
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        messages: [
          { role: "system", content: request.systemPrompt },
          ...contextToChatMessagesForWaifu(request.messages, request.currentWaifuAuthorIds ?? []),
          ...(request.sceneDirection
            ? [{ role: "system", content: `<scene_direction>${request.sceneDirection}</scene_direction>` }]
            : [])
        ],
        temperature: request.temperature ?? this.model.defaultTemperature,
        top_p: request.topP ?? this.model.defaultTopP,
        max_tokens: request.maxOutputTokens,
        stream: false,
        ...reasoningFieldsForOpenAiChat(this.model, request.reasoning),
        ...openAiChatSamplingOverrides(this.model, request.reasoning)
      },
      signal: request.signal,
      extract: extractOpenAiChatText,
      queryRole: "waifu"
    });
    return { content: text };
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
    return parseStageManagerCalls(text, rendering.indexToId);
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
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: bearerHeaders(this.apiKey),
      body: {
        model: request.modelId,
        instructions: request.systemPrompt,
        input: [
          ...contextToResponsesInputForWaifu(request.messages, request.currentWaifuAuthorIds ?? []),
          ...(request.sceneDirection
            ? [{ role: "system", content: `<scene_direction>${request.sceneDirection}</scene_direction>` }]
            : [])
        ],
        temperature: request.temperature ?? this.model.defaultTemperature,
        top_p: request.topP ?? this.model.defaultTopP,
        max_output_tokens: request.maxOutputTokens,
        ...reasoningFieldsForOpenAiResponses(this.model, request.reasoning),
        ...openAiResponsesSamplingOverrides(this.model)
      },
      signal: request.signal,
      extract: extractOpenAiResponsesText,
      queryRole: "waifu"
    });
    return { content: text };
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
    return parseStageManagerCalls(text, rendering.indexToId);
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
    const text = await postJsonAndExtractText({
      url: `${this.provider.baseUrl}${this.model.endpoint}`,
      headers: anthropicHeaders(this.apiKey),
      body: {
        model: request.modelId,
        system: request.systemPrompt,
        messages: [
          ...contextToAnthropicMessagesForWaifu(request.messages, request.currentWaifuAuthorIds ?? []),
          ...(request.sceneDirection ? [{ role: "user", content: `<scene_direction>${request.sceneDirection}</scene_direction>` }] : [])
        ],
        temperature: constrainsSampling ? 1 : request.temperature ?? this.model.defaultTemperature,
        top_p: constrainsSampling ? undefined : request.topP ?? this.model.defaultTopP,
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {})
      },
      signal: request.signal,
      extract: extractAnthropicText,
      queryRole: "waifu"
    });
    return { content: text };
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
    return parseStageManagerCalls(text, rendering.indexToId);
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
  extract: (json: unknown) => string;
  queryRole: QueryRole;
};

async function postJsonAndExtractText(options: JsonPostOptions): Promise<string> {
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
    const content = options.extract(json).trim();
    if (!content) {
      throw new ProviderPipelineError("Provider returned an empty response.", json);
    }
    return content;
  } finally {
    requestSignal.cleanup();
  }
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
  return `[timestamp: ${marker.timestamp}] [type: no_reply] [retrigger: ${marker.retriggerAfterSeconds}s] [reason: ${reason}]`;
}

function currentTimeBlock(): string {
  return `<current_time>\n${formatTimestamp(new Date())} (UTC)\n</current_time>`;
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

function contextToChatMessagesForWaifu(messages: ContextMessage[], currentWaifuAuthorIds: string[]) {
  const selfIds = new Set(currentWaifuAuthorIds);
  return messages.map((message) => ({
    role: selfIds.has(message.authorId) ? "assistant" : "user",
    name: pickProviderName(message),
    content: formatWaifuContextLine(message)
  }));
}

function pickProviderName(message: ContextMessage): string {
  const fromDisplay = safeName(message.displayName);
  if (fromDisplay !== "user") return fromDisplay;
  return safeName(message.name);
}

function contextToResponsesInputForWaifu(messages: ContextMessage[], currentWaifuAuthorIds: string[]) {
  const selfIds = new Set(currentWaifuAuthorIds);
  return messages.map((message) => ({
    role: selfIds.has(message.authorId) ? "assistant" : "user",
    content: formatWaifuContextLine(message)
  }));
}

function contextToAnthropicMessagesForWaifu(messages: ContextMessage[], currentWaifuAuthorIds: string[]) {
  const selfIds = new Set(currentWaifuAuthorIds);
  return messages.map((message) => ({
    role: selfIds.has(message.authorId) ? "assistant" : "user",
    content: formatWaifuContextLine(message)
  }));
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
Tool usage: compare the context to existing memories, choose all needed memory edits, and call ${STAGE_MANAGER_TOOL_NAME} exactly once with a toolCalls array. Do not write normal assistant text.
Each toolCalls item must match one of:
{ "tool": "add_memory", "memory": { "waifuId": string, "scope": "global"|"guild"|"channel"|"user", "content": string, "importance": 1|2|3|4|5, "sourceMessageIndices": number[] } }
{ "tool": "update_memory", "memoryId": string, "patch": { "waifuId"?: string, "scope"?: "global"|"guild"|"channel"|"user", "content"?: string, "importance"?: 1|2|3|4|5, "status"?: "active"|"archived" } }
{ "tool": "archive_memory", "memoryId": string }
{ "tool": "merge_memories", "sourceMemoryIds": string[], "mergedContent": string }
{ "tool": "no_change", "reason"?: string }.
sourceMessageIndices entries must be #N indices from the context above.
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
const ORCHESTRATOR_TOOL_DESCRIPTION = "Choose exactly one orchestration action for the current Discord context.";
export const ORCHESTRATOR_TOOL_PARAMETERS = orchestratorToolParameters();

function orchestratorToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema = {
    type: "string",
    description: waifuIds.length
      ? `Configured waifu id to reply with. Must be one of: ${waifuIds.join(", ")}.`
      : "Configured waifu id to reply with.",
    ...(waifuIds.length ? { enum: waifuIds } : {})
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["waifus", "stage_manager", "reviewer", "no_reply"],
        description: "Choose waifus to reply, stage_manager to run memory review, reviewer to inspect the latest waifu message for hallucination, or no_reply to wait."
      },
      selectedWaifus: {
        type: "array",
        description: "Required when action is waifus; omit for all other actions.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            waifuId: {
              ...waifuIdSchema
            },
            sceneDirection: {
              type: "string",
              description: "Optional private direction for this waifu reply."
            },
            replyToIndex: {
              type: "integer",
              minimum: 1,
              description: "Optional #N context index to reply to; use only for older non-latest messages."
            }
          },
          required: ["waifuId"]
        }
      },
      retriggerAfterSeconds: {
        type: "integer",
        minimum: 100,
        maximum: 28800,
        description: "Required when action is stage_manager or no_reply; omit for waifus and reviewer."
      },
      reasoning: {
        type: "string",
        description: "Brief operational reason for the decision."
      }
    },
    required: ["action", "reasoning"]
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
              scope: { type: "string", enum: ["global", "guild", "channel", "user"] },
              content: { type: "string" },
              importance: { type: "integer", enum: [1, 2, 3, 4, 5] },
              sourceMessageIndices: {
                type: "array",
                items: { type: "integer", minimum: 1 },
                description: "#N context indices supporting this memory."
              }
            },
            required: ["waifuId", "scope", "content", "importance"]
          },
          memoryId: {
            type: "string",
            description: "Required for update_memory or archive_memory."
          },
          patch: {
            type: "object",
            description: "Required when tool is update_memory.",
            additionalProperties: false,
            properties: {
              waifuId: { type: "string" },
              scope: { type: "string", enum: ["global", "guild", "channel", "user"] },
              content: { type: "string" },
              importance: { type: "integer", enum: [1, 2, 3, 4, 5] },
              status: { type: "string", enum: ["active", "archived"] }
            }
          },
          sourceMemoryIds: {
            type: "array",
            description: "Required when tool is merge_memories.",
            minItems: 2,
            items: { type: "string" }
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

const RawSelectedWaifuSchema = z.object({
  waifuId: z.string().min(1),
  sceneDirection: z.string().min(1).optional(),
  replyToIndex: z.number().int().min(1).optional()
});

const RawOrchestratorDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("waifus"),
    selectedWaifus: z.array(RawSelectedWaifuSchema).min(1),
    reasoning: z.string().min(1)
  }),
  z.object({
    action: z.literal("stage_manager"),
    retriggerAfterSeconds: z.number().int().min(100).max(28_800),
    reasoning: z.string().min(1)
  }),
  z.object({
    action: z.literal("reviewer"),
    reasoning: z.string().min(1)
  }),
  z.object({
    action: z.literal("no_reply"),
    retriggerAfterSeconds: z.number().int().min(100).max(28_800),
    reasoning: z.string().min(1)
  })
]);

const RawStageManagerPatchSchema = z.object({
  waifuId: z.string().min(1).optional(),
  scope: z.enum(["global", "guild", "channel", "user"]).optional(),
  content: z.string().min(1).optional(),
  importance: ImportanceSchema.optional(),
  status: z.enum(["active", "archived"]).optional()
});

const RawStageManagerToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("add_memory"),
    memory: z.object({
      waifuId: z.string().min(1),
      scope: z.enum(["global", "guild", "channel", "user"]),
      content: z.string().min(1),
      importance: ImportanceSchema,
      sourceMessageIndices: z.array(z.number().int().min(1)).default([])
    })
  }),
  z.object({
    tool: z.literal("update_memory"),
    memoryId: z.string().min(1),
    patch: RawStageManagerPatchSchema
  }),
  z.object({
    tool: z.literal("archive_memory"),
    memoryId: z.string().min(1)
  }),
  z.object({
    tool: z.literal("merge_memories"),
    sourceMemoryIds: z.array(z.string().min(1)).min(2),
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
    if (raw.action !== "waifus") {
      return OrchestratorDecisionSchema.parse(raw);
    }
    return OrchestratorDecisionSchema.parse({
      action: "waifus",
      reasoning: raw.reasoning,
      selectedWaifus: raw.selectedWaifus.map((selected) => ({
        waifuId: selected.waifuId,
        sceneDirection: selected.sceneDirection,
        replyToMessageId: selected.replyToIndex !== undefined ? indexToId.get(selected.replyToIndex) : undefined
      }))
    });
  } catch (error) {
    throw new ProviderPipelineError("Provider did not return a valid orchestrator decision.", {
      text,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseStageManagerCalls(text: string, indexToId: Map<number, string>): StageManagerToolCall[] {
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    const calls = Array.isArray(parsed) ? parsed : (parsed.toolCalls ?? parsed.calls ?? []);
    return calls.map((call: unknown) => {
      const raw = RawStageManagerToolCallSchema.parse(call);
      if (raw.tool === "add_memory") {
        const sourceMessageIds = raw.memory.sourceMessageIndices
          .map((index) => indexToId.get(index))
          .filter((id): id is string => Boolean(id));
        return StageManagerToolCallSchema.parse({
          tool: "add_memory",
          memory: {
            waifuId: raw.memory.waifuId,
            scope: raw.memory.scope,
            content: raw.memory.content,
            importance: raw.memory.importance,
            sourceMessageIds
          }
        });
      }
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
