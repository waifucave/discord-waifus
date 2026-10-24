// The last shaping step before a request goes to the adapter (Living cast spec §5.4, §9.1).
//
// A life's log can hold two user messages in a row: a turn that ended on a user message (a cap, an
// interrupt, an error, a restart repair) is followed by the next turn's notifications. Some
// endpoints refuse successive same-role messages (DeepSeek's reasoning models: "does not support
// successive user or assistant messages"), winter's chat-completions mapper does not join them
// (its Google mapper does), and Anthropic joins them server-side anyway. So adjacent user messages
// are joined into one for every family, their blocks kept in order.
//
// Prefix stability: joining only appends blocks to a message that already exists, never rewrites
// or reorders one, so every earlier request's blocks are still a prefix of the next request's. In
// practice the first of two joined messages was rarely the last message of any request (the
// capped round's tool results are written after its last call).

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";

function blocksOf(content: ProviderMessageLike["content"]): ContentBlockLike[] {
  return typeof content === "string" ? (content.length > 0 ? [{ type: "text", text: content }] : []) : [...content];
}

/**
 * Adjacent user messages joined into one. A message that carries tool results is never joined onto
 * the one before it: tool results must open the message that answers the tool calls.
 */
export function joinAdjacentUserMessages(messages: readonly ProviderMessageLike[]): ProviderMessageLike[] {
  const out: ProviderMessageLike[] = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    const carriesResults = typeof message.content !== "string" && message.content.some((block) => block.type === "tool_result");
    if (previous && previous.role === "user" && message.role === "user" && !carriesResults) {
      out[out.length - 1] = { ...previous, content: [...blocksOf(previous.content), ...blocksOf(message.content)] };
      continue;
    }
    out.push(message);
  }
  return out;
}
