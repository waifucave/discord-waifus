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

export function planWaifuReplyChunks(chunks: string[]): {
  immediateChunks: string[];
  cachedChunks: string[];
} {
  const immediateLimit =
    chunks[IMMEDIATE_CHUNK_LIMIT] &&
    characterCount(chunks[IMMEDIATE_CHUNK_LIMIT]) < SHORT_THIRD_CHUNK_CHAR_LIMIT
      ? IMMEDIATE_CHUNK_LIMIT + 1
      : IMMEDIATE_CHUNK_LIMIT;

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
