// One source per rule (spec 6.2/8.5): a waifu's `verbosity` drives the prompt wording, the output
// validator's length limits, and the reply splitter.
//
// Reply processing order (spec 8.5): strip leaked header → parse ↩#ref marker → strip
// impersonation → validateWaifuOutput → splitWaifuReply. Length handling:
// - over softMaxChars (or maxLines): trim at a sentence boundary when ≥ 40% of the text is kept,
//   else retry once;
// - after the retry: the same sentence trim, else hard-trim at a word boundary to hardMaxChars.
// There is no soft-length bypass: a reply is never sent over its limits unchanged.

import type { WaifuVerbosity } from "../shared/schemas/domain.js";
import { jaccard } from "./text.js";
import { validateLeaks, type ValidationContext, type Violation } from "./outputValidator.js";

export type { ValidationContext, Violation };
export type Verbosity = WaifuVerbosity;

export type VerbosityProfile = {
  level: Verbosity;
  /** The one style sentence the waifu harness puts in her system prompt. */
  promptRule: string;
  softMaxChars: number;
  hardMaxChars: number;
  maxLines: number;
  splitChunkChars: number;
};

export const VERBOSITY_PROFILES: Readonly<Record<Verbosity, VerbosityProfile>> = {
  terse: {
    level: "terse",
    promptRule:
      "Keep messages short, like texting in a fast group chat: usually one line of a few words, two short lines at most; a single word or emoji is a complete message.",
    softMaxChars: 140,
    hardMaxChars: 280,
    maxLines: 2,
    splitChunkChars: 280
  },
  chatty: {
    level: "chatty",
    promptRule:
      "Write casual chat messages of one to three short lines; save longer answers for when someone asks for detail.",
    softMaxChars: 320,
    hardMaxChars: 600,
    maxLines: 3,
    splitChunkChars: 400
  },
  expressive: {
    level: "expressive",
    promptRule:
      "You can write fuller messages, up to a short paragraph, when the moment calls for it; quick reactions can still be a single line.",
    softMaxChars: 900,
    hardMaxChars: 1800,
    maxLines: 6,
    splitChunkChars: 900
  }
};

export function verbosityProfile(level: Verbosity | undefined): VerbosityProfile {
  return VERBOSITY_PROFILES[level ?? "terse"] ?? VERBOSITY_PROFILES.terse;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type WaifuVerdict = "pass" | "trim" | "retry" | "block";

export type WaifuValidationContext = ValidationContext & {
  profile: VerbosityProfile;
  /** True on the last attempt: length overruns hard-trim instead of asking for a retry. */
  finalAttempt?: boolean;
};

export type WaifuValidation = { verdict: WaifuVerdict; violations: Violation[]; trimmed?: string };

/** A trim must keep at least this share of the text, else the reply is regenerated once. */
const MIN_KEPT_RATIO = 0.4;

function chars(value: string): number {
  return Array.from(value).length;
}

function sliceChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

// A sentence ends at . ! ? … (optionally followed by closing quotes/brackets/emoji-free runs of
// the same punctuation) before whitespace or the end of the text.
const SENTENCE_END_RE = /[.!?…]+["'”’)\]]*(?=\s|$)/gu;

/** The longest prefix of `text` that ends at a sentence boundary (or line end) within `max` chars. */
export function trimAtSentence(text: string, max: number): string {
  const trimmed = text.trim();
  if (chars(trimmed) <= max) return trimmed;
  let best = "";
  for (const match of trimmed.matchAll(SENTENCE_END_RE)) {
    const end = (match.index ?? 0) + match[0].length;
    const candidate = trimmed.slice(0, end).trimEnd();
    if (chars(candidate) > max) break;
    best = candidate;
  }
  // A line break is a boundary too (the author's own message break).
  const lines = trimmed.split("\n");
  let acc = "";
  for (const line of lines) {
    const next = acc ? `${acc}\n${line}` : line;
    if (chars(next.trimEnd()) > max) break;
    acc = next;
  }
  const byLine = acc.trimEnd();
  return chars(byLine) > chars(best) ? byLine : best;
}

/**
 * I5: a reply cut off by the output limit (`finishReason: "length"`) keeps only its complete
 * sentences/lines; "" when not even one is complete.
 */
export function cutToCompleteSentence(text: string): string {
  const trimmed = text.trim();
  let end = 0;
  for (const match of trimmed.matchAll(SENTENCE_END_RE)) end = (match.index ?? 0) + match[0].length;
  const lastBreak = trimmed.lastIndexOf("\n");
  if (lastBreak > end) end = lastBreak;
  return trimmed.slice(0, end).trimEnd();
}

/** Cut `text` to at most `max` chars at the last word boundary (exactly at `max` without one). */
export function trimAtWord(text: string, max: number): string {
  const trimmed = text.trim();
  if (chars(trimmed) <= max) return trimmed;
  const head = sliceChars(trimmed, max + 1);
  const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  const result = cut > head.length / 2 ? head.slice(0, cut) : sliceChars(trimmed, max);
  return result.replace(/[\s,;:–—-]+$/u, "").trimEnd();
}

function lengthViolations(text: string, profile: VerbosityProfile): Violation[] {
  const violations: Violation[] = [];
  const lines = nonEmptyLines(text);
  if (lines.length > profile.maxLines) {
    violations.push({ check: "too-many-lines", detail: `${lines.length} lines (max ${profile.maxLines})` });
  }
  const count = chars(text.trim());
  if (count > profile.softMaxChars) {
    violations.push({ check: "length", detail: `${count} chars (soft max ${profile.softMaxChars})` });
  }
  return violations;
}

/**
 * The full verdict for one candidate reply (already header-stripped, marker-parsed and
 * impersonation-stripped):
 * - `block`: a surviving mass ping;
 * - `retry`: any leak (tags, headers, stray ↩#ref, self-talk, self-repeat, …), or a length overrun
 *   that cannot be trimmed keeping ≥ 40% (not on the final attempt);
 * - `trim`: a length overrun fixed by `trimmed`;
 * - `pass`.
 */
export function validateWaifuOutput(text: string, ctx: WaifuValidationContext): WaifuValidation {
  const leaks = validateLeaks(text, ctx);
  if (leaks.verdict !== "pass") return { verdict: leaks.verdict, violations: leaks.violations };

  const violations = lengthViolations(text, ctx.profile);
  if (violations.length === 0) return { verdict: "pass", violations: [] };

  const original = text.trim();
  const lines = nonEmptyLines(original);
  const linesCut = lines.length > ctx.profile.maxLines ? lines.slice(0, ctx.profile.maxLines).join("\n") : original;
  const sentence = trimAtSentence(linesCut, ctx.profile.softMaxChars);
  if (sentence && chars(sentence) >= MIN_KEPT_RATIO * chars(original)) {
    return { verdict: "trim", violations, trimmed: sentence };
  }
  if (!ctx.finalAttempt) return { verdict: "retry", violations };
  const hard = trimAtWord(linesCut, ctx.profile.hardMaxChars);
  return { verdict: "trim", violations, trimmed: hard };
}

// ---------------------------------------------------------------------------
// Retry notes (user-role, ephemeral: spec 6.3 — never a user turn with the waifu's name)
// ---------------------------------------------------------------------------

export const CUT_OFF_RETRY_NOTE = "Your last message was cut off; write a shorter one.";

const REASONS: Record<string, (p: VerbosityProfile) => string> = {
  length: (p) => `it was too long — keep it under ${p.softMaxChars} characters`,
  "too-many-lines": (p) => `it had too many lines — ${p.maxLines === 1 ? "one line" : `${p.maxLines} lines at most`}`,
  "self-repeat": () => "you already said that — say something new, or just react in a couple of words",
  "directive-echo": () => "it restated the direction — pursue it in your own words instead",
  "stray-reply-marker": () => "a ↩#ref marker may only appear at the very start of a message",
  "header-leak": () => "it contained transcript headers — write only your own message, no times, refs or names",
  "transcript-shape": () => "it contained lines for other people — write only your own message",
  "harness-tag": () => "it contained prompt tags — write only the plain chat message",
  "tool-fragment": () => "it contained tool syntax — write only the plain chat message",
  "bracket-tag": () => "it contained bracketed notes — write only the plain chat message",
  "self-talk": () => "it contained your reasoning — write only the message itself",
  "mass-ping": () => "it pinged everyone — never do that"
};

/** "Your last draft was rejected: <reasons>. Write it again." */
export function retryNote(violations: Violation[], profile: VerbosityProfile): string {
  const reasons = [...new Set(violations.map((v) => (REASONS[v.check] ?? (() => `it failed the ${v.check} check`))(profile)))];
  const reason = reasons.length > 0 ? reasons.join("; ") : "it could not be sent";
  return `Your last draft was rejected: ${reason}. Write it again.`;
}

// ---------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------

const PARAGRAPH_SPLIT_RE = /\n+/;
const SENTENCE_SPLIT_RE = /(?<=[.?!])\s+/;
// Discord rejects messages over 2000 characters. Measured in UTF-16 units (stricter than code
// points) so the limit holds whichever way Discord counts.
const DISCORD_MESSAGE_MAX_CHARS = 2000;
const COMMA_FINDER_RE = /,/g;
const EMOJI_FINDER_RE =
  /<a?:[A-Za-z0-9_]+:\d+>|[0-9#*]️?⃣|(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[︎️]|\p{Emoji_Modifier})?(?:‍(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[︎️]|\p{Emoji_Modifier})?)*/gu;

/**
 * Split a validated reply into Discord messages. Newlines are the author's own message breaks and
 * are always honored; within a paragraph sentences are packed up to `profile.splitChunkChars`;
 * an over-long sentence splits at a comma/emoji seam, and anything over Discord's limit is
 * hard-split. Near-duplicate chunks of the same reply are dropped.
 */
export function splitWaifuReply(content: string, profile: VerbosityProfile): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  const limit = profile.splitChunkChars;
  const chunks: string[] = [];
  for (const paragraph of trimmed.split(PARAGRAPH_SPLIT_RE)) {
    const piece = paragraph.trim();
    if (piece.length === 0) continue;
    if (chars(piece) <= limit) {
      chunks.push(piece);
      continue;
    }
    for (const packed of packSentences(piece, limit)) {
      splitLongChunk(packed, chunks, limit);
    }
  }
  return dedupeNearDuplicateChunks(chunks);
}

function packSentences(paragraph: string, limit: number): string[] {
  const packed: string[] = [];
  let current = "";
  for (const part of paragraph.split(SENTENCE_SPLIT_RE)) {
    const sentence = part.trim();
    if (sentence.length === 0) continue;
    if (current.length === 0) {
      current = sentence;
      continue;
    }
    if (chars(current) + 1 + chars(sentence) <= limit) {
      current = `${current} ${sentence}`;
    } else {
      packed.push(current);
      current = sentence;
    }
  }
  if (current.length > 0) packed.push(current);
  return packed;
}

function splitLongChunk(chunk: string, out: string[], limit: number): void {
  if (chars(chunk) <= limit) {
    out.push(chunk);
    return;
  }
  const split = trySplitLongChunk(chunk);
  if (!split) {
    out.push(...hardSplitForDiscord(chunk));
    return;
  }
  splitLongChunk(split[0], out, limit);
  splitLongChunk(split[1], out, limit);
}

function hardSplitForDiscord(chunk: string): string[] {
  const pieces: string[] = [];
  let rest = chunk;
  while (rest.length > DISCORD_MESSAGE_MAX_CHARS) {
    const window = rest.slice(0, DISCORD_MESSAGE_MAX_CHARS + 1);
    let cut = -1;
    for (let index = DISCORD_MESSAGE_MAX_CHARS; index >= DISCORD_MESSAGE_MAX_CHARS / 2; index -= 1) {
      if (/\s/.test(window[index] ?? "")) {
        cut = index;
        break;
      }
    }
    if (cut === -1) {
      cut = DISCORD_MESSAGE_MAX_CHARS;
      const before = rest.charCodeAt(cut - 1);
      if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
    }
    const head = rest.slice(0, cut).trimEnd();
    if (head) pieces.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function trySplitLongChunk(chunk: string): [string, string] | null {
  const mid = chunk.length / 2;
  return bestCommaSplit(chunk, mid) ?? bestEmojiSplit(chunk, mid);
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
// output. Calibrated on live duplicate variants (0.54-0.76 overlap) vs distinct lines (0.00-0.16).
const DUPLICATE_JACCARD_THRESHOLD = 0.6;
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

const MS_PER_CHAR = 30;
const MIN_DELAY_MS = 600;
const MAX_DELAY_MS = 4500;

export function typingDelayMs(chunk: string): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, chunk.length * MS_PER_CHAR));
}
