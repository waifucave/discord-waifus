/**
 * Unpaired UTF-16 surrogates (e.g. an emoji cut in half by a naive slice) survive
 * JSON.stringify but strict provider-side parsers reject them — DeepSeek's Rust backend
 * answers "unexpected end of hex escape". Every provider-bound string must pass through
 * here before serialization.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "").replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** Length-clip that never leaves half a surrogate pair at the boundary. */
export function clipSurrogateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let clipped = text.slice(0, max);
  const last = clipped.charCodeAt(clipped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  return clipped;
}

type ChatContent = string | Array<Record<string, unknown>>;
type ChatMessage = { role: string; content: ChatContent } & Record<string, unknown>;

/** Sanitizes every text field of a chat messages array; non-text parts pass through untouched. */
export function sanitizeChatMessages<T extends ChatMessage[]>(messages: T): T {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { ...message, content: stripLoneSurrogates(message.content) };
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) =>
          typeof part.text === "string" ? { ...part, text: stripLoneSurrogates(part.text) } : part
        )
      };
    }
    return message;
  }) as T;
}
