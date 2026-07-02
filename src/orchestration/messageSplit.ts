const PARAGRAPH_SPLIT_RE = /\n+/;
const SENTENCE_SPLIT_RE = /(?<=[.?!])\s+/;
// Replies at or below this length ship as ONE Discord message. Live data (2026-07) showed the
// old 100-char cap shredding register-compliant replies (median 152ch) into 2-3 message bursts,
// which both walls the channel and teaches the model multi-part replies via its own history.
const HARD_CHUNK_CHARS = 280;
const COMMA_FINDER_RE = /,/g;
const EMOJI_FINDER_RE =
  /<a?:[A-Za-z0-9_]+:\d+>|[0-9#*]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?)*/gu;

export function splitWaifuReply(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  const chunks: string[] = [];
  // Newlines are the author's own message breaks — always honored. Within a paragraph,
  // sentences are PACKED up to the hard limit instead of one-sentence-per-message.
  for (const paragraph of trimmed.split(PARAGRAPH_SPLIT_RE)) {
    const piece = paragraph.trim();
    if (piece.length === 0) continue;
    if (characterCount(piece) <= HARD_CHUNK_CHARS) {
      chunks.push(piece);
      continue;
    }
    for (const packed of packSentences(piece)) {
      splitLongChunk(packed, chunks);
    }
  }
  return dedupeNearDuplicateChunks(chunks);
}

// Greedily pack sentences into chunks of at most HARD_CHUNK_CHARS. A single over-long
// sentence passes through untouched here; splitLongChunk handles it at commas/emoji.
function packSentences(paragraph: string): string[] {
  const packed: string[] = [];
  let current = "";
  for (const part of paragraph.split(SENTENCE_SPLIT_RE)) {
    const sentence = part.trim();
    if (sentence.length === 0) continue;
    if (current.length === 0) {
      current = sentence;
      continue;
    }
    if (characterCount(current) + 1 + characterCount(sentence) <= HARD_CHUNK_CHARS) {
      current = `${current} ${sentence}`;
    } else {
      packed.push(current);
      current = sentence;
    }
  }
  if (current.length > 0) packed.push(current);
  return packed;
}

function splitLongChunk(chunk: string, out: string[]): void {
  if (characterCount(chunk) <= HARD_CHUNK_CHARS) {
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

// Reasoning-heavy models occasionally emit several near-identical drafts of the same beat in one
// output; each used to ship as its own Discord message. Chunks that heavily overlap an earlier
// chunk of the SAME reply are dropped — this removes the model's duplicated variants, never
// distinct content.
const DUPLICATE_JACCARD_THRESHOLD = 0.7;
const DUPLICATE_MIN_TOKENS = 3;

function dedupeNearDuplicateChunks(chunks: string[]): string[] {
  const kept: string[] = [];
  const keptTokens: Array<Set<string>> = [];
  for (const chunk of chunks) {
    const tokens = dedupeTokenSet(chunk);
    const isDuplicate =
      tokens.size >= DUPLICATE_MIN_TOKENS &&
      keptTokens.some((prior) => jaccard(prior, tokens) >= DUPLICATE_JACCARD_THRESHOLD);
    if (isDuplicate) continue;
    kept.push(chunk);
    keptTokens.push(tokens);
  }
  return kept;
}

function dedupeTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
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
