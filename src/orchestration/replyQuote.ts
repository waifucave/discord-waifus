import type { ContextMessage } from "./context.js";

export type ReplyQuoteExtraction = {
  replyToMessageId: string | undefined;
  cleanedContent: string;
};

const QUOTE_LINE_RE = /^[ \t]*>(?!>)[ \t]?(.*)$/;
const REPLYING_TO_QUOTE_LINE_RE = /^[ \t]*replying[ \t]+to[ \t]*>[ \t]?(.*)$/i;
const AUTHOR_BODY_RE = /^[ \t]*([^:\n]{1,40}):[ \t]*(.+)$/;
const IMPLICIT_QUOTE_LINE_RE = /^[ \t]*([^:\n]{1,40}):[ \t]+(.+)$/;
const JACCARD_THRESHOLD = 0.6;
type MatchOptions = {
  allowContainment?: boolean;
  allowJaccard?: boolean;
};

export function extractReplyQuote(
  content: string,
  candidates: ContextMessage[]
): ReplyQuoteExtraction {
  const lines = content.split("\n");
  const quoteBodies: string[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const match = lines[cursor].match(REPLYING_TO_QUOTE_LINE_RE) ?? lines[cursor].match(QUOTE_LINE_RE);
    if (!match) break;
    quoteBodies.push(match[1]);
    cursor += 1;
  }
  if (quoteBodies.length === 0) {
    const implicit = tryImplicitQuote(content, candidates);
    if (implicit) return implicit;
    return { replyToMessageId: undefined, cleanedContent: content };
  }
  const cleanedContent = lines.slice(cursor).join("\n").replace(/^\s+/, "");
  const replyToMessageId = resolveQuoteTarget(quoteBodies.join("\n"), candidates);
  return { replyToMessageId: replyToMessageId?.id, cleanedContent };
}

function tryImplicitQuote(
  content: string,
  candidates: ContextMessage[]
): ReplyQuoteExtraction | null {
  const lines = content.split("\n");
  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === "") firstIdx += 1;
  if (firstIdx >= lines.length) return null;
  if (/^[ \t]*>/.test(lines[firstIdx])) return null;
  const match = lines[firstIdx].match(IMPLICIT_QUOTE_LINE_RE);
  if (!match) return tryImplicitContentQuote(lines, firstIdx, candidates);
  const authorName = match[1];
  const body = match[2];
  const tokenCount = matchTokenCount(body);
  if (tokenCount < 2) return null;
  const matched = findBestMatch(body, candidates, authorName, {
    allowContainment: tokenCount >= 3,
    allowJaccard: false
  });
  if (!matched) return null;
  const cleanedContent = [...lines.slice(0, firstIdx), ...lines.slice(firstIdx + 1)]
    .join("\n")
    .replace(/^\s+/, "");
  return { replyToMessageId: matched.id, cleanedContent };
}

function tryImplicitContentQuote(
  lines: string[],
  firstIdx: number,
  candidates: ContextMessage[]
): ReplyQuoteExtraction | null {
  if (lines.slice(firstIdx + 1).every((line) => line.trim() === "")) return null;
  const body = lines[firstIdx].trim();
  const tokenCount = matchTokenCount(body);
  if (tokenCount < 2) return null;
  const matched = findBestMatch(body, candidates, undefined, {
    allowContainment: tokenCount >= 3,
    allowJaccard: false
  });
  if (!matched) return null;
  if (matched.id === candidates.at(-1)?.id) return null;
  const cleanedContent = [...lines.slice(0, firstIdx), ...lines.slice(firstIdx + 1)]
    .join("\n")
    .replace(/^\s+/, "");
  return { replyToMessageId: matched.id, cleanedContent };
}

function resolveQuoteTarget(quoteText: string, candidates: ContextMessage[]): ContextMessage | undefined {
  const trimmed = quoteText.trim();
  if (!trimmed) return undefined;
  const authorBody = trimmed.match(AUTHOR_BODY_RE);
  if (authorBody) {
    return findBestMatch(authorBody[2], candidates, authorBody[1]);
  }
  return findMostRecentByAuthor(trimmed, candidates) ?? findBestMatch(trimmed, candidates);
}

function findBestMatch(
  quoteText: string,
  candidates: ContextMessage[],
  authorName?: string,
  options: MatchOptions = {}
): ContextMessage | undefined {
  const target = normalizeForMatch(quoteText);
  if (!target) return undefined;
  const ordered = [...candidates].reverse();
  const authorMatches = authorName
    ? ordered.filter((candidate) => candidateMatchesAuthor(candidate, authorName))
    : [];
  const pools = authorMatches.length ? [authorMatches, ordered] : [ordered];
  for (const pool of pools) {
    for (const candidate of pool) {
      if (normalizeForMatch(candidate.content) === target) return candidate;
    }
  }
  if (options.allowContainment !== false) {
    for (const pool of pools) {
      for (const candidate of pool) {
        const candNorm = normalizeForMatch(candidate.content);
        if (!candNorm) continue;
        if (candNorm.includes(target) || target.includes(candNorm)) return candidate;
      }
    }
  }
  if (options.allowJaccard !== false) {
    for (const pool of pools) {
      let best: ContextMessage | undefined = undefined;
      let bestScore = JACCARD_THRESHOLD;
      for (const candidate of pool) {
        const score = jaccard(target, normalizeForMatch(candidate.content));
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (best) return best;
    }
  }
  return undefined;
}

export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchTokenCount(input: string): number {
  return normalizeForMatch(input).split(" ").filter(Boolean).length;
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

function findMostRecentByAuthor(authorName: string, candidates: ContextMessage[]): ContextMessage | undefined {
  const normalized = normalizeForMatch(authorName);
  if (!normalized) return undefined;
  return [...candidates]
    .reverse()
    .find((candidate) => candidateMatchesAuthor(candidate, authorName));
}

function candidateMatchesAuthor(candidate: ContextMessage, authorName: string): boolean {
  const target = normalizeForMatch(authorName);
  if (!target) return false;
  return [candidate.displayName, candidate.name]
    .map(normalizeForMatch)
    .some((candidateName) => candidateName === target);
}
