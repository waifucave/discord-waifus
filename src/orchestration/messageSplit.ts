const PARAGRAPH_SPLIT_RE = /\n+/;
const SENTENCE_SPLIT_RE = /(?<=[.?!])\s+/;
const MAX_CHUNK_CHARS = 100;
const COMMA_FINDER_RE = /,/g;
const EMOJI_FINDER_RE =
  /<a?:[A-Za-z0-9_]+:\d+>|[0-9#*]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?)*/gu;

export function splitWaifuReply(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const sentenceChunks: string[] = [];
  for (const paragraph of trimmed.split(PARAGRAPH_SPLIT_RE)) {
    for (const part of paragraph.split(SENTENCE_SPLIT_RE)) {
      const piece = part.trim();
      if (piece.length > 0) sentenceChunks.push(piece);
    }
  }
  const result: string[] = [];
  for (const chunk of sentenceChunks) splitLongChunk(chunk, result);
  return result;
}

function splitLongChunk(chunk: string, out: string[]): void {
  if (characterCount(chunk) <= MAX_CHUNK_CHARS) {
    out.push(chunk);
    return;
  }
  const split = trySplitLongChunk(chunk);
  if (!split) {
    out.push(chunk);
    return;
  }
  splitLongChunk(split[0], out);
  splitLongChunk(split[1], out);
}

function trySplitLongChunk(chunk: string): [string, string] | null {
  const mid = chunk.length / 2;
  const commaSplit = bestCommaSplit(chunk, mid);
  if (commaSplit) return commaSplit;
  return bestEmojiSplit(chunk, mid);
}

function bestCommaSplit(chunk: string, mid: number): [string, string] | null {
  let bestIndex: number | null = null;
  let bestDist = Infinity;
  for (const match of chunk.matchAll(COMMA_FINDER_RE)) {
    const idx = match.index ?? 0;
    if (idx === 0 || idx === chunk.length - 1) continue;
    const dist = Math.abs(idx - mid);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = idx;
    }
  }
  if (bestIndex === null) return null;
  const left = chunk.slice(0, bestIndex).trimEnd();
  const right = chunk.slice(bestIndex + 1).trimStart();
  if (!left || !right) return null;
  return [left, right];
}

function bestEmojiSplit(chunk: string, mid: number): [string, string] | null {
  let bestEnd: number | null = null;
  let bestDist = Infinity;
  for (const match of chunk.matchAll(EMOJI_FINDER_RE)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= chunk.length) continue;
    const dist = Math.abs(end - mid);
    if (dist < bestDist) {
      bestDist = dist;
      bestEnd = end;
    }
  }
  if (bestEnd === null) return null;
  const left = chunk.slice(0, bestEnd).trimEnd();
  const right = chunk.slice(bestEnd).trimStart();
  if (!left || !right) return null;
  return [left, right];
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
