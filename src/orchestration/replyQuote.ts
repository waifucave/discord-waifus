import type { ContextMessage } from "./context.js";

export type ReplyQuoteExtraction = {
  replyToMessageId: string | undefined;
  cleanedContent: string;
};

const QUOTE_LINE_RE = /^[ \t]*>(?!>)[ \t]?(.*)$/;
const AUTHOR_PREFIX_RE = /^[^\n:]{1,40}:[ \t]+/;
const JACCARD_THRESHOLD = 0.6;

export function extractReplyQuote(
  content: string,
  candidates: ContextMessage[]
): ReplyQuoteExtraction {
  const lines = content.split("\n");
  const quoteBodies: string[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const match = lines[cursor].match(QUOTE_LINE_RE);
    if (!match) break;
    quoteBodies.push(match[1]);
    cursor += 1;
  }
  if (quoteBodies.length === 0) {
    return { replyToMessageId: undefined, cleanedContent: content };
  }
  const cleanedContent = lines.slice(cursor).join("\n").replace(/^\s+/, "");
  const quoteText = quoteBodies.join("\n").replace(AUTHOR_PREFIX_RE, "").trim();
  const replyToMessageId = quoteText.length === 0 ? undefined : findBestMatch(quoteText, candidates);
  return { replyToMessageId, cleanedContent };
}

function findBestMatch(quoteText: string, candidates: ContextMessage[]): string | undefined {
  const target = normalizeForMatch(quoteText);
  if (!target) return undefined;
  const ordered = [...candidates].reverse();
  for (const candidate of ordered) {
    if (normalizeForMatch(candidate.content) === target) return candidate.id;
  }
  for (const candidate of ordered) {
    const candNorm = normalizeForMatch(candidate.content);
    if (!candNorm) continue;
    if (candNorm.includes(target) || target.includes(candNorm)) return candidate.id;
  }
  let bestId: string | undefined = undefined;
  let bestScore = JACCARD_THRESHOLD;
  for (const candidate of ordered) {
    const score = jaccard(target, normalizeForMatch(candidate.content));
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return bestId;
}

export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}
