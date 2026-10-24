// A scripted stand-in for the assistant's ModelClient (not a test file itself). Each model round
// calls `step` with the request, the round number within the turn and the tool results the
// previous round produced; the step answers with text and/or tool calls.

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { AssistantModelClient } from "../src/api/assistant/service.js";
import type { ModelCallRequest, ModelCallResult, ModelStreamSink } from "../src/models/client.js";

export type ScriptedReply = { text?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> };

export type ScriptStepInput = {
  request: ModelCallRequest;
  /** 0 for the first model call of a turn, then +1 per tool round. */
  round: number;
  /** The previous round's tool results, in call order. */
  toolResults: Array<{ name: string; result: string }>;
};

export type ScriptStep = (input: ScriptStepInput) => ScriptedReply | Promise<ScriptedReply>;

function isPlainUser(message: ProviderMessageLike): boolean {
  return message.role === "user" && (typeof message.content === "string" || !message.content.some((block) => block.type === "tool_result"));
}

function roundOf(messages: readonly ProviderMessageLike[]): number {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isPlainUser(messages[index]!)) {
      lastUser = index;
      break;
    }
  }
  return messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
}

function toolResultsOf(messages: readonly ProviderMessageLike[]): Array<{ name: string; result: string }> {
  const last = messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) if (block.type === "tool_use") names.set(block.id, block.name);
  }
  return last.content
    .filter((block): block is Extract<ContentBlockLike, { type: "tool_result" }> => block.type === "tool_result")
    .map((block) => ({
      name: names.get(block.tool_use_id) ?? "?",
      result: typeof block.content === "string" ? block.content : JSON.stringify(block.content)
    }));
}

let callCounter = 0;

export function scriptedAssistantClient(step: ScriptStep): AssistantModelClient & { requests: ModelCallRequest[] } {
  const requests: ModelCallRequest[] = [];
  return {
    requests,
    async stream(request: ModelCallRequest, sink: ModelStreamSink): Promise<ModelCallResult> {
      requests.push(request);
      const reply = await step({ request, round: roundOf(request.messages), toolResults: toolResultsOf(request.messages) });
      const content: ContentBlockLike[] = [];
      if (reply.text) {
        sink.onTextDelta?.(reply.text);
        content.push({ type: "text", text: reply.text });
      }
      const toolCalls = (reply.toolCalls ?? []).map((call) => ({ id: `call-${++callCounter}`, name: call.name, input: call.args ?? {} }));
      for (const call of toolCalls) {
        sink.onToolCallStart?.(call.id, call.name);
        content.push({ type: "tool_use", ...call });
      }
      return {
        message: { role: "assistant", content, origin: { providerId: request.route.providerId, modelKey: `${request.route.providerId}/${request.route.modelId}`, family: "fake" } },
        text: reply.text ?? "",
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_use" : "stop",
        durationMs: 0
      } as ModelCallResult;
    }
  };
}

/** The curated route the assistant tests configure (DeepSeek Flash, direct). */
export const ASSISTANT_TEST_MODEL = { providerId: "deepseek", modelId: "deepseek-flash" } as const;
