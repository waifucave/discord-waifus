export function splitWaifuReply(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.?!])\s+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

const IMMEDIATE_CHUNK_LIMIT = 2;
const SHORT_THIRD_CHUNK_CHAR_LIMIT = 18;
const THIRD_CHUNK_INDEX = 2;
const FOURTH_CHUNK_INDEX = 3;
const CUSTOM_EMOJI_ONLY_RE = /^<a?:[A-Za-z0-9_]+:(?:\d+)?>$/;
const KEYCAP_EMOJI_ONLY_RE = /^[0-9#*]\uFE0F?\u20E3$/u;
const UNICODE_EMOJI_ONLY_RE =
  /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?)*)$/u;

export function planWaifuReplyChunks(chunks: string[]): {
  immediateChunks: string[];
  cachedChunks: string[];
} {
  let immediateLimit = IMMEDIATE_CHUNK_LIMIT;
  if (chunks[THIRD_CHUNK_INDEX] && characterCount(chunks[THIRD_CHUNK_INDEX]) < SHORT_THIRD_CHUNK_CHAR_LIMIT) {
    immediateLimit = THIRD_CHUNK_INDEX + 1;
  }
  if (immediateLimit === THIRD_CHUNK_INDEX + 1 && chunks[FOURTH_CHUNK_INDEX] && isEmojiOnlyChunk(chunks[FOURTH_CHUNK_INDEX])) {
    immediateLimit = FOURTH_CHUNK_INDEX + 1;
  }

  return {
    immediateChunks: chunks.slice(0, immediateLimit),
    cachedChunks: chunks.slice(immediateLimit)
  };
}

const MS_PER_CHAR = 30;
const MIN_DELAY_MS = 600;
const MAX_DELAY_MS = 4500;

export function typingDelayMs(chunk: string): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, chunk.length * MS_PER_CHAR));
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isEmojiOnlyChunk(value: string): boolean {
  const trimmed = value.trim();
  return CUSTOM_EMOJI_ONLY_RE.test(trimmed) || KEYCAP_EMOJI_ONLY_RE.test(trimmed) || UNICODE_EMOJI_ONLY_RE.test(trimmed);
}
