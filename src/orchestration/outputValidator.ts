// Deterministic waifu output validator.
//
// Pure module — no side effects; its only orchestration import is the shared
// lexical helper module (text.ts).

import { tokenSet } from "./text.js";

export type ValidationVerdict = "pass" | "retry" | "block";

export type Violation = {
  check: string;
  detail: string;
};

export type ValidationContext = {
  selfNames: string[];          // all self-aliases (display name, configured name, guild nickname)
  participantNames: string[];   // every known participant incl. self aliases
  directive?: { intent: string; goal: string };
  blockTags: string[];          // every XML-ish tag the harness can emit for this waifu
  toolNames: string[];
  recentSelfMessages?: string[]; // this waifu's own last few sent messages (raw content)
};

// ---------------------------------------------------------------------------
// Individual check functions (each returns Violation | undefined)
// ---------------------------------------------------------------------------

/**
 * harness-tag: flags any XML-like open/close tag that matches a known block
 * tag or the generic waifu-pattern tag shape.
 *
 * Patterns:
 *   - exact block tags from ctx.blockTags (case-insensitive, open or close)
 *   - generic: ^[a-z_]+_(identity|persona|schedule|anchor|relevant_memories)$
 *
 * Does NOT flag: `<3`, `a < b`, `x > y` (no tag-like word follows `<`).
 */
function checkHarnessTag(text: string, ctx: ValidationContext): Violation | undefined {
  // Build regex for known block tags
  for (const tag of ctx.blockTags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches opening <TAG> or <TAG ...> or </TAG>
    const re = new RegExp(`</?${escaped}[\\s>]`, "i");
    if (re.test(text)) {
      return { check: "harness-tag", detail: `found block tag <${tag}>` };
    }
    // Also match exact close without trailing space: </TAG>
    const reClose = new RegExp(`</${escaped}>`, "i");
    if (reClose.test(text)) {
      return { check: "harness-tag", detail: `found closing block tag </${tag}>` };
    }
  }
  // Generic waifu-pattern tags
  const genericPattern = /<\/?\s*[a-z][a-z0-9_]*_(identity|persona|schedule|anchor|relevant_memories)\s*[> /]/i;
  if (genericPattern.test(text)) {
    return { check: "harness-tag", detail: "found generic waifu-pattern tag" };
  }
  // Also catch generic close tags: </word_identity>
  const genericClose = /<\/\s*[a-z][a-z0-9_]*_(identity|persona|schedule|anchor|relevant_memories)\s*>/i;
  if (genericClose.test(text)) {
    return { check: "harness-tag", detail: "found generic waifu-pattern closing tag" };
  }
  return undefined;
}

/**
 * tool-fragment: flags tool names adjacent to `(`/`{`/`:`, or JSON-shaped
 * lines containing sensitive keys (content|waifuId|intent|goal|ops).
 */
function checkToolFragment(text: string, ctx: ValidationContext): Violation | undefined {
  for (const name of ctx.toolNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\s*[({:]`, "i");
    if (re.test(text)) {
      return { check: "tool-fragment", detail: `found tool name "${name}" adjacent to call syntax` };
    }
  }
  // JSON-shaped line containing sensitive keys
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const keys = Object.keys(candidate as Record<string, unknown>);
          const sensitiveKeys = ["content", "waifuId", "intent", "goal", "ops"];
          if (keys.some((k) => sensitiveKeys.includes(k))) {
            return { check: "tool-fragment", detail: `found JSON with sensitive keys: ${keys.join(", ")}` };
          }
        }
      } catch {
        // Not valid JSON — not a structured fragment
      }
    }
  }
  return undefined;
}

/**
 * bracket-tag: flags surviving `[word: value]` metadata shapes anywhere.
 *
 * Pattern: `[WORD_WITH_POSSIBLE_UNDERSCORES: content]`
 * The key must be a single token matching `[A-Za-z_][A-Za-z0-9_]*` (no spaces,
 * no hyphens in the key portion before the colon) to avoid false-positives on
 * `[citation needed]` (which has a space) or `arrays[0]: fine` (digit start).
 */
function checkBracketTag(text: string, ctx: ValidationContext): Violation | undefined {
  // Matches [IDENTIFIER: content] where IDENTIFIER has no spaces or digits at start
  // The space after colon is required per spec: `/\[[A-Za-z_][A-Za-z0-9_ -]*:\s[^\]]*\]/`
  // But we tighten to exclude multi-word keys with spaces by requiring the key
  // to be a single identifier-like token (only A-Za-z0-9_ with no spaces before colon).
  const re = /\[[A-Za-z_][A-Za-z0-9_]*:\s[^\]]*\]/;
  if (re.test(text)) {
    return { check: "bracket-tag", detail: "found bracket metadata tag [key: value]" };
  }
  return undefined;
}

/**
 * transcript-shape: flags ≥2 lines matching `^\s*NAME:` for participant
 * names EXCLUDING self-names. Single impersonation lines are the strip's
 * territory.
 *
 * Self-name lines do not count (they would be natural self-attribution).
 */
function checkTranscriptShape(text: string, ctx: ValidationContext): Violation | undefined {
  const lines = text.split("\n");
  const selfSet = new Set(ctx.selfNames.map((n) => n.toLowerCase()));
  let otherParticipantLines = 0;

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]*)\s*:/);
    if (!match) continue;
    const name = match[1].trim().toLowerCase();
    if (selfSet.has(name)) continue;
    // Check if this name is a known participant
    const isParticipant = ctx.participantNames.some(
      (p) => p.toLowerCase() === name
    );
    if (isParticipant) {
      otherParticipantLines += 1;
    }
  }

  if (otherParticipantLines >= 2) {
    return {
      check: "transcript-shape",
      detail: `found ${otherParticipantLines} participant-attributed lines (transcript pattern)`,
    };
  }
  return undefined;
}

/**
 * directive-echo: token-overlap(reply, directive.goal) ≥ 0.6.
 * Only fires when goal has ≥3 non-stopword tokens.
 * Overlap = |reply ∩ goal| / |goal| (recall-style, not Jaccard).
 */
function checkDirectiveEcho(text: string, ctx: ValidationContext): Violation | undefined {
  if (!ctx.directive) return undefined;
  const goalTokens = tokenSet(ctx.directive.goal);
  if (goalTokens.size < 3) return undefined;

  const replyTokens = tokenSet(text);
  let intersection = 0;
  for (const token of goalTokens) {
    if (replyTokens.has(token)) intersection += 1;
  }
  const overlap = intersection / goalTokens.size;
  if (overlap >= 0.6) {
    return {
      check: "directive-echo",
      detail: `reply overlaps goal by ${Math.round(overlap * 100)}% (≥60%)`,
    };
  }
  return undefined;
}

/**
 * self-talk: re-checks post-strip for internal reasoning leaks.
 * Patterns:
 *   - Leading analysis/reasoning/etc. label: `^WORD:`
 *   - XML thinking/analysis/reasoning/scratchpad blocks
 */
const SELF_TALK_LABEL_RE = /^\s*(analysis|reasoning|thoughts?|scratchpad|response draft|draft reply|final answer|message to send)\s*:/im;
const SELF_TALK_TAG_RE = /<(analysis|thinking|reasoning|thought|scratchpad)\b/i;

function checkSelfTalk(text: string, _ctx: ValidationContext): Violation | undefined {
  if (SELF_TALK_LABEL_RE.test(text)) {
    return { check: "self-talk", detail: "found internal reasoning label" };
  }
  if (SELF_TALK_TAG_RE.test(text)) {
    return { check: "self-talk", detail: "found internal reasoning XML block" };
  }
  return undefined;
}

/**
 * self-repeat: the candidate is (near-)identical to one of the waifu's OWN recent
 * messages. Seen live: the same conversation-starter line sent twice, five minutes
 * apart, with another character's answer in between. Retry, then block — silence
 * beats saying the same thing twice.
 */
const SELF_REPEAT_JACCARD = 0.85;

function checkSelfRepeat(text: string, ctx: ValidationContext): Violation | undefined {
  if (!ctx.recentSelfMessages?.length) return undefined;
  const candidateNorm = normalizeForRepeat(text);
  if (candidateNorm.length === 0) return undefined;
  const candidateTokens = tokenSet(text);
  for (const prior of ctx.recentSelfMessages) {
    if (normalizeForRepeat(prior) === candidateNorm) {
      return { check: "self-repeat", detail: "identical to a recent own message" };
    }
    const priorTokens = tokenSet(prior);
    if (candidateTokens.size >= 4 && priorTokens.size >= 4) {
      let intersection = 0;
      for (const token of candidateTokens) {
        if (priorTokens.has(token)) intersection += 1;
      }
      const union = candidateTokens.size + priorTokens.size - intersection;
      if (union > 0 && intersection / union >= SELF_REPEAT_JACCARD) {
        return { check: "self-repeat", detail: "near-duplicate of a recent own message" };
      }
    }
  }
  return undefined;
}

function normalizeForRepeat(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * header-leak: a transcript header (`[14:02 #k3]`) at the start of any line. The leading one is
 * stripped before validation; one that survives means the model wrote transcript lines.
 */
const HEADER_LEAK_RE = /^\[\d{1,2}:\d{2} #/m;

function checkHeaderLeak(text: string, _ctx: ValidationContext): Violation | undefined {
  if (HEADER_LEAK_RE.test(text)) {
    return { check: "header-leak", detail: "found a transcript header [HH:MM #ref]" };
  }
  return undefined;
}

/**
 * stray-reply-marker: a `↩#ref` marker anywhere after the start (the leading one is consumed by
 * parseReplyMarker before validation, so any marker left is mid-text).
 */
const STRAY_REPLY_MARKER_RE = /↩\uFE0F?\s?#[0-9a-z]{2,6}/;

function checkStrayReplyMarker(text: string, _ctx: ValidationContext): Violation | undefined {
  if (STRAY_REPLY_MARKER_RE.test(text)) {
    return { check: "stray-reply-marker", detail: "found a ↩#ref marker mid-text" };
  }
  return undefined;
}

/**
 * mass-ping: surviving @everyone / @here → BLOCK (belt-and-braces after
 * the denormalizer, which also defuses them).
 */
const MASS_PING_RE = /@everyone|@here/;

function checkMassPing(text: string, _ctx: ValidationContext): Violation | undefined {
  if (MASS_PING_RE.test(text)) {
    return { check: "mass-ping", detail: "found @everyone or @here mass ping" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Exported leak validator (length and register live in verbosity.ts)
// ---------------------------------------------------------------------------

const BLOCK_CHECKS = [checkMassPing] as const;
const RETRY_CHECKS = [
  checkHarnessTag,
  checkToolFragment,
  checkBracketTag,
  checkTranscriptShape,
  checkDirectiveEcho,
  checkSelfTalk,
  checkSelfRepeat,
  checkHeaderLeak,
  checkStrayReplyMarker,
] as const;

/**
 * Leak checks only: `block` for a surviving mass ping, `retry` for any other leak, else `pass`.
 * The full waifu verdict (incl. length trim) is `validateWaifuOutput` in verbosity.ts.
 */
export function validateLeaks(
  text: string,
  ctx: ValidationContext
): { verdict: ValidationVerdict; violations: Violation[] } {
  const violations: Violation[] = [];
  for (const check of BLOCK_CHECKS) {
    const v = check(text, ctx);
    if (v) violations.push(v);
  }
  for (const check of RETRY_CHECKS) {
    const v = check(text, ctx);
    if (v) violations.push(v);
  }
  if (violations.some((v) => v.check === "mass-ping")) {
    return { verdict: "block", violations };
  }
  if (violations.length > 0) {
    return { verdict: "retry", violations };
  }
  return { verdict: "pass", violations: [] };
}
