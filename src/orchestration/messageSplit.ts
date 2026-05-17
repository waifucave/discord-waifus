export function splitWaifuReply(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.?!])\s+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

const MS_PER_CHAR = 30;
const MIN_DELAY_MS = 600;
const MAX_DELAY_MS = 4500;

export function typingDelayMs(chunk: string): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, chunk.length * MS_PER_CHAR));
}
