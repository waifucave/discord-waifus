import type { ChatMessage, ResolvedModel, ToolDef } from "@waifucave/gateway";
import type { CompactionSettings, TokenBudget } from "./types.js";

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1_000;
const DEFAULT_MAX_OUTPUT_CAP = 8_192;

function contentChars(message: ChatMessage): { chars: number; images: number } {
  const { content } = message;
  if (typeof content === "string") return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        chars += block.text.length;
        break;
      case "image":
        images += 1;
        break;
      case "reasoning":
        chars += (block.text ?? "").length;
        break;
      case "toolCall":
        chars += block.name.length + block.arguments.length;
        break;
    }
  }
  return { chars, images };
}

/**
 * Cheap pre-flight token estimate: characters / 3.5, scaled by a per-model calibration `ratio`
 * (measured usage / estimate, see spec 8.9), plus a flat 1,000 tokens per inline image.
 * Tool definitions count through their JSON size.
 */
export function estimateTokens(messages: ChatMessage[], tools?: ToolDef[], ratio = 1): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    const counted = contentChars(message);
    chars += counted.chars;
    images += counted.images;
  }
  for (const tool of tools ?? []) chars += JSON.stringify(tool).length;
  return Math.ceil((chars / CHARS_PER_TOKEN) * ratio) + images * IMAGE_TOKENS;
}

/**
 * budget = contextTokens × triggerRatio − (params.maxOutputTokens ?? min(limits.maxOutputTokens, 8192)).
 * `budgetTokens` is the estimated-input size above which compaction triggers (never negative).
 */
export function resolveTokenBudget(
  model: ResolvedModel,
  params: Record<string, unknown>,
  s: CompactionSettings
): TokenBudget {
  const contextTokens = model.limits.contextTokens;
  const requested = params.maxOutputTokens;
  const maxOutputTokens =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : Math.min(model.limits.maxOutputTokens, DEFAULT_MAX_OUTPUT_CAP);
  return {
    contextTokens,
    maxOutputTokens,
    triggerRatio: s.triggerRatio,
    budgetTokens: Math.max(0, Math.floor(contextTokens * s.triggerRatio - maxOutputTokens))
  };
}
