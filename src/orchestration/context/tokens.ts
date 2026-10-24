// Cheap pre-flight token estimates over winter messages (kept from the Phase 4 context engine,
// Living cast spec §15). The life planner (L2) sizes its compaction budget with these.

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { CompactionSettings } from "../../shared/schemas/compaction.js";

const CHARS_PER_TOKEN = 3.5;
export const IMAGE_TOKENS = 1_000;
const DEFAULT_MAX_OUTPUT_CAP = 8_192;

export type EstimateTool = { name: string; description?: string; inputSchema?: unknown };

function blockChars(block: ContentBlockLike): { chars: number; images: number } {
  switch (block.type) {
    case "text":
      return { chars: block.text.length, images: 0 };
    case "image":
      return { chars: 0, images: 1 };
    case "thinking":
      return { chars: block.thinking.length, images: 0 };
    case "redacted_thinking":
      return { chars: 0, images: 0 };
    case "tool_use":
      return { chars: block.name.length + JSON.stringify(block.input ?? {}).length, images: 0 };
    case "tool_result": {
      if (typeof block.content === "string") return { chars: block.content.length, images: 0 };
      let chars = 0;
      let images = 0;
      for (const inner of block.content) {
        const counted = blockChars(inner);
        chars += counted.chars;
        images += counted.images;
      }
      return { chars, images };
    }
    default:
      return { chars: 0, images: 0 };
  }
}

function messageChars(message: ProviderMessageLike): { chars: number; images: number } {
  if (typeof message.content === "string") return { chars: message.content.length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const block of message.content) {
    const counted = blockChars(block);
    chars += counted.chars;
    images += counted.images;
  }
  return { chars, images };
}

/**
 * Pre-flight token estimate: characters / 3.5, scaled by a per-model calibration `ratio`
 * (measured usage / estimate, spec 8.9), plus a flat 1,000 tokens per inline image. System blocks
 * and tool definitions count through their text / JSON size.
 */
export function estimateTokens(
  messages: readonly ProviderMessageLike[],
  o: { system?: readonly string[]; tools?: readonly EstimateTool[]; ratio?: number } = {}
): number {
  let chars = (o.system ?? []).reduce((sum, block) => sum + block.length, 0);
  let images = 0;
  for (const message of messages) {
    const counted = messageChars(message);
    chars += counted.chars;
    images += counted.images;
  }
  for (const tool of o.tools ?? []) chars += JSON.stringify(tool).length;
  return Math.ceil((chars / CHARS_PER_TOKEN) * (o.ratio ?? 1)) + images * IMAGE_TOKENS;
}

export type TokenBudget = {
  contextTokens: number;
  maxOutputTokens: number;
  triggerRatio: number;
  budgetTokens: number;
};

/**
 * budget = contextTokens × triggerRatio − (requested max output ?? min(model output limit, 8192)).
 * `budgetTokens` is the estimated-input size above which compaction triggers (never negative).
 */
export function resolveTokenBudget(
  model: { contextWindow: number; maxOutputTokens?: number },
  s: Pick<CompactionSettings, "triggerRatio">,
  requestedMaxOutputTokens?: number
): TokenBudget {
  const maxOutputTokens =
    typeof requestedMaxOutputTokens === "number" && Number.isFinite(requestedMaxOutputTokens) && requestedMaxOutputTokens > 0
      ? requestedMaxOutputTokens
      : Math.min(model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_CAP, DEFAULT_MAX_OUTPUT_CAP);
  return {
    contextTokens: model.contextWindow,
    maxOutputTokens,
    triggerRatio: s.triggerRatio,
    budgetTokens: Math.max(0, Math.floor(model.contextWindow * s.triggerRatio - maxOutputTokens))
  };
}
