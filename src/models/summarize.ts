// The compaction summarize call over ModelClient (Living cast spec §5.6): the caller's normal
// request (same route, tools, effort, system and messages) plus one appended user message with the
// instruction, so the cached prefix is reused. winter has no `toolChoice: none`, so the instruction
// asks for text only; tool calls in the reply are discarded. No text → one retry with a stronger
// text-only instruction. A summary cut off by the output cap (`length`) is retried once with a
// doubled cap, and is never returned as complete.

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { compactionMaxOutputTokens } from "../orchestration/context/compaction.js";
import type { CuratedModel } from "./catalog.js";
import type { ModelCallRequest, ModelClient, ModelFinishReason } from "./client.js";

export const TEXT_ONLY_RETRY_PREFIX =
  "Your previous reply contained no summary text. Reply with the summary as plain text only; do not call any tool.";

export type SummarizeRequest = Omit<ModelCallRequest, "attribution" | "maxOutputTokens"> & {
  attribution: Omit<ModelCallRequest["attribution"], "purpose">;
  /** The instruction user message's content (instruction text plus, for lives, a time line). */
  instruction: string | ContentBlockLike[];
  /** The model facts used to size the output cap. */
  model?: Pick<CuratedModel, "efforts" | "maxOutputTokens">;
  replyMaxOutputTokens?: number;
};

export type SummaryResult = { text: string; finishReason: ModelFinishReason; complete: boolean };

function withPrefix(instruction: string | ContentBlockLike[], prefix: string): ContentBlockLike[] {
  const blocks: ContentBlockLike[] = typeof instruction === "string" ? [{ type: "text", text: instruction }] : [...instruction];
  return [{ type: "text", text: prefix }, ...blocks];
}

export async function summarizeWithModel(client: ModelClient, request: SummarizeRequest): Promise<SummaryResult> {
  const { instruction, model, replyMaxOutputTokens, attribution, ...base } = request;
  const cap = compactionMaxOutputTokens({
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(model ? { model } : {}),
    ...(replyMaxOutputTokens !== undefined ? { replyMaxOutputTokens } : {})
  });
  const send = async (content: string | ContentBlockLike[], maxOutputTokens: number) => {
    const appended: ProviderMessageLike = { role: "user", content };
    return client.call({
      ...base,
      messages: [...request.messages, appended],
      maxOutputTokens,
      attribution: { ...attribution, purpose: "compaction" }
    });
  };
  let result = await send(instruction, cap);
  if (result.finishReason === "length" && (!model?.maxOutputTokens || cap < model.maxOutputTokens)) {
    const doubled = model?.maxOutputTokens ? Math.min(model.maxOutputTokens, cap * 2) : cap * 2;
    result = await send(instruction, doubled);
  }
  if (!result.text.trim() && result.finishReason !== "length") {
    result = await send(withPrefix(instruction, TEXT_ONLY_RETRY_PREFIX), cap);
  }
  const text = result.text.trim();
  return { text, finishReason: result.finishReason, complete: text.length > 0 && result.finishReason !== "length" };
}
