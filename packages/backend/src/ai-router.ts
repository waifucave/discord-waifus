import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderConfig } from "./types/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

export interface CompletionRequest {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  timeoutMs?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionResponse {
  content: string;
  finishReason: string;
  usage?: CompletionUsage;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolChoice =
  | {
      type: "required";
    }
  | {
      type: "tool";
      name: string;
    };

export interface ToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export class AIRouter {
  private readonly providers = new Map<string, ProviderConfig>();

  constructor(providers: ProviderConfig[]) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }
  }

  setProviders(providers: ProviderConfig[]): void {
    this.providers.clear();
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }
  }

  getProvider(providerId: string): ProviderConfig | undefined {
    return this.providers.get(providerId);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const provider = this.providers.get(request.providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${request.providerId}`);
    }

    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.throwIfAborted(request.signal);

      try {
        if (provider.type === "anthropic") {
          return await this.completeAnthropic(provider, request);
        }

        return await this.completeOpenAICompatible(provider, request);
      } catch (error) {
        this.throwIfAborted(request.signal);
        if (!this.shouldRetry(error) || attempt === attempts - 1) {
          throw error;
        }

        const backoffMs = 350 * 2 ** attempt;
        await sleep(backoffMs, undefined, { signal: request.signal });
      }
    }

    throw new Error("AI request exhausted retries");
  }

  async fetchAvailableModels(providerId: string): Promise<string[]> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return [];
    }

    const response = await this.fetchWithTimeout(`${provider.baseUrl}/models`, {
      method: "GET",
      headers: this.buildHeaders(provider)
    });

    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((entry) => entry.id)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }

  private async completeOpenAICompatible(
    provider: ProviderConfig,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    const repetitionControl = buildOpenAICompatibleRepetitionControl(
      provider,
      request.repetitionPenalty
    );
    const response = await this.fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(provider),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.8,
        max_tokens: request.maxTokens ?? 300,
        stream: Boolean(request.onToken),
        ...repetitionControl,
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema
                }
              })),
              tool_choice: toOpenAIToolChoice(request.toolChoice)
            }
          : {})
      }),
      signal: request.signal,
      timeoutMs: request.timeoutMs
    });

    if (request.onToken) {
      return this.handleOpenAIStream(response, request.onToken, request.signal);
    }

    const data = (await response.json()) as OpenAIChatCompletionResponse;
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      finishReason: data.choices?.[0]?.finish_reason ?? "stop",
      toolCalls: data.choices?.[0]?.message?.tool_calls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: safeParseJson(toolCall.function.arguments)
      })),
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0
          }
        : undefined
    };
  }

  private async completeAnthropic(
    provider: ProviderConfig,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: formatAnthropicMessageContent(message)
      }));

    const response = await this.fetchWithTimeout(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: request.model,
        system,
        messages,
        max_tokens: request.maxTokens ?? 300,
        temperature: request.temperature ?? 0.8,
        stream: Boolean(request.onToken),
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema
              })),
              tool_choice: toAnthropicToolChoice(request.toolChoice)
            }
          : {})
      }),
      signal: request.signal,
      timeoutMs: request.timeoutMs
    });

    if (request.onToken) {
      return this.handleAnthropicStream(response, request.onToken, request.signal);
    }

    const data = (await response.json()) as AnthropicCompletionResponse;
    return {
      content:
        data.content
          ?.map((block) => ("text" in block ? block.text ?? "" : ""))
          .join("") ?? "",
      finishReason: data.stop_reason ?? "stop",
      toolCalls: data.content
        ?.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: block.name,
          arguments: block.input
        })),
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens ?? 0,
            completionTokens: data.usage.output_tokens ?? 0
          }
        : undefined
    };
  }

  private async handleOpenAIStream(
    response: Response,
    onToken: (token: string) => void,
    signal?: AbortSignal
  ): Promise<CompletionResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Missing response body for stream");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "stop";

    while (true) {
      this.throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          return { content, finishReason };
        }

        const data = JSON.parse(payload) as OpenAIStreamChunk;
        const delta = data.choices?.[0]?.delta?.content;
        const nextFinishReason = data.choices?.[0]?.finish_reason;
        if (typeof delta === "string" && delta.length > 0) {
          content += delta;
          onToken(delta);
        }
        if (nextFinishReason) {
          finishReason = nextFinishReason;
        }
      }
    }

    return { content, finishReason };
  }

  private async handleAnthropicStream(
    response: Response,
    onToken: (token: string) => void,
    signal?: AbortSignal
  ): Promise<CompletionResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Missing response body for stream");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "stop";

    while (true) {
      this.throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload) {
          continue;
        }

        const data = JSON.parse(payload) as AnthropicStreamEvent;
        if (data.type === "content_block_delta") {
          const token = data.delta?.text;
          if (typeof token === "string" && token.length > 0) {
            content += token;
            onToken(token);
          }
        }
        if (data.type === "message_stop" && data.stop_reason) {
          finishReason = data.stop_reason;
        }
      }
    }

    return { content, finishReason };
  }

  private buildHeaders(provider: ProviderConfig): HeadersInit {
    if (provider.type === "anthropic") {
      return {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      };
    }

    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`
    };
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit & { timeoutMs?: number }
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(init.timeoutMs ?? 30_000);
    const combinedSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        signal: combinedSignal
      });
    } catch (error) {
      throw normalizeNetworkError(error);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new AIRouterHttpError(response.status, text);
    }

    return response;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof AIRouterAbortError) {
      return false;
    }

    if (error instanceof AIRouterHttpError) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }

    return error instanceof AIRouterNetworkError;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }

    throw new AIRouterAbortError();
  }
}

export class AIRouterHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`AI provider request failed with status ${status}`);
    this.name = "AIRouterHttpError";
  }
}

export class AIRouterNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AIRouterNetworkError";
  }
}

export class AIRouterAbortError extends Error {
  constructor() {
    super("AI request was aborted");
    this.name = "AbortError";
  }
}

function normalizeNetworkError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new AIRouterAbortError();
  }

  if (error instanceof Error) {
    return new AIRouterNetworkError(error.message, error);
  }

  return new AIRouterNetworkError("Unknown network error", error);
}

function buildOpenAICompatibleRepetitionControl(
  provider: ProviderConfig,
  repetitionPenalty?: number
): Record<string, number> | undefined {
  if (typeof repetitionPenalty !== "number" || !Number.isFinite(repetitionPenalty)) {
    return undefined;
  }

  const clampedPenalty = clamp(repetitionPenalty, 0, 2);
  const frequencyPenalty = clamp((clampedPenalty - 1) * 2, -2, 2);
  if (provider.id === "lmstudio") {
    return {
      frequency_penalty: frequencyPenalty,
      repeat_penalty: clampedPenalty
    };
  }

  return {
    frequency_penalty: frequencyPenalty
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

interface AnthropicCompletionResponse {
  content?: Array<AnthropicContentBlock>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: {
    text?: string;
  };
  stop_reason?: string;
}

type AnthropicContentBlock =
  | {
      type?: "text";
      text?: string;
    }
  | AnthropicToolUseBlock;

interface AnthropicToolUseBlock {
  type: "tool_use";
  id?: string;
  name: string;
  input: unknown;
}

function toOpenAIToolChoice(toolChoice?: ToolChoice): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice.type === "required") {
    return "required";
  }

  return {
    type: "function",
    function: {
      name: toolChoice.name
    }
  };
}

function toAnthropicToolChoice(toolChoice?: ToolChoice): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice.type === "required") {
    return {
      type: "any"
    };
  }

  return {
    type: "tool",
    name: toolChoice.name
  };
}

function safeParseJson(input: string): unknown {
  return JSON.parse(input);
}

function formatAnthropicMessageContent(message: ChatMessage): string {
  if (!message.name) {
    return message.content;
  }

  return `[Speaker: ${message.name}]\n${message.content}`;
}
