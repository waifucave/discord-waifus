// Shared lexical helpers for the orchestration heuristics (loop detection, output validation,
// memory retrieval and dedupe, chunk dedupe, reply-quote matching). Pure; no imports.

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "that", "this", "these", "those", "it", "its", "as", "into", "about",
  "i", "you", "he", "she", "they", "we", "them", "his", "her", "their",
  "do", "does", "did", "have", "has", "had", "will", "would", "should", "could", "can",
  "not", "no", "yes", "so", "than", "then", "very", "just", "also", "too"
]);

// Letter/number runs (combining marks stay inside their word so Devanagari/Thai words are not cut).
const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;
// Scripts written without spaces between words: their runs become character bigrams.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々]+/gu;

function pushBigrams(run: string, out: Set<string>): void {
  const chars = [...run];
  if (chars.length === 1) {
    out.add(chars[0]!);
    return;
  }
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i]! + chars[i + 1]!);
}

function pushWord(word: string, out: Set<string>): void {
  // Length in code points so an accented or non-Latin word is not penalized for UTF-16 width.
  if ([...word].length >= 3 && !STOPWORDS.has(word)) out.add(word);
}

// Unicode-aware token set (spec 8.8): NFKC-normalized, lowercased `\p{L}\p{N}` runs of 3+ code
// points minus STOPWORDS; Han/Kana/Hangul runs become character bigrams (a lone CJK character
// stays a unigram). Tokens shorter than 3 chars are excluded to avoid noise from short function
// words, so very short Latin messages (e.g. "ok") produce an empty set and score 0 against
// anything. For ASCII input this is exactly the previous `[a-z0-9]` tokenizer.
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(WORD_RUN)) {
    const run = match[0];
    let last = 0;
    for (const cjk of run.matchAll(CJK_RUN)) {
      const start = cjk.index ?? 0;
      if (start > last) pushWord(run.slice(last, start), out);
      pushBigrams(cjk[0], out);
      last = start + cjk[0].length;
    }
    if (last < run.length) pushWord(run.slice(last), out);
  }
  return out;
}

/** Jaccard similarity of two token sets; 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Tokens for duplicate detection: `tokenSet` plus every number regardless of length, so
 * "Kevin has 3 cats" and "Kevin has 4 cats" are not near-duplicates.
 */
export function dedupeTokenSet(text: string): Set<string> {
  const tokens = tokenSet(text);
  for (const match of text.normalize("NFKC").matchAll(/\p{N}+/gu)) tokens.add(match[0]);
  return tokens;
}

/**
 * Canonical text for exact-duplicate checks: NFKC, lowercased, whitespace collapsed, trailing
 * sentence punctuation dropped.
 */
export function normalizeForDedupe(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？…]+$/u, "");
}
