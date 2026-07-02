// Deterministic waifu output validator.
//
// Pure module — no side effects, no imports from other orchestration modules.
// tokenSet/STOPWORDS are copied verbatim from loopDetector.ts (modules stay
// decoupled by design — do not import from loopDetector).

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
};

// ---------------------------------------------------------------------------
// Token helpers (verbatim from loopDetector.ts — keep decoupled)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "that", "this", "these", "those", "it", "its", "as", "into", "about",
  "i", "you", "he", "she", "they", "we", "them", "his", "her", "their",
  "do", "does", "did", "have", "has", "had", "will", "would", "should", "could", "can",
  "not", "no", "yes", "so", "than", "then", "very", "just", "also", "too"
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  );
}

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
 * length-register: SOFT check — the room register is fast casual chat, and live data
 * showed prompt wording alone does not hold the register on every model. Over the soft
 * limit → one corrective retry; if the retry is still long it is SENT ANYWAY (soft
 * violations never withhold content — see SOFT_VALIDATOR_CHECKS).
 */
const LENGTH_SOFT_LIMIT_CHARS = 180;

function checkLengthRegister(text: string, _ctx: ValidationContext): Violation | undefined {
  const visible = Array.from(text.trim()).length;
  if (visible > LENGTH_SOFT_LIMIT_CHARS) {
    return { check: "length-register", detail: `${visible} chars (soft limit ${LENGTH_SOFT_LIMIT_CHARS})` };
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
// Exported validator
// ---------------------------------------------------------------------------

const BLOCK_CHECKS = [checkMassPing] as const;
const RETRY_CHECKS = [
  checkHarnessTag,
  checkToolFragment,
  checkBracketTag,
  checkTranscriptShape,
  checkDirectiveEcho,
  checkSelfTalk,
  checkLengthRegister,
] as const;

// Checks whose violations trigger a corrective retry but must NEVER withhold content:
// if they survive the final attempt, the reply is sent as-is.
export const SOFT_VALIDATOR_CHECKS: ReadonlySet<string> = new Set(["length-register"]);

// Violation-specific corrective retry lines. The generic "contained X" wording is useless
// for register violations — cheap models need the concrete instruction.
const CORRECTIVE_HINTS: Record<string, string> = {
  "length-register": "that was too long for this chat — send just your single strongest line, under 25 words"
};

export function correctiveRetryMessage(displayName: string, violations: Violation[]): string {
  const hints = violations
    .map((violation) => CORRECTIVE_HINTS[violation.check])
    .filter((hint): hint is string => Boolean(hint));
  const generic = violations
    .filter((violation) => !CORRECTIVE_HINTS[violation.check])
    .map((violation) => violation.check);
  const parts = [...hints];
  if (generic.length > 0) {
    parts.push(`your previous draft was rejected: contained ${generic.join(", ")}; write only the plain chat message`);
  }
  return `${displayName}: (${parts.join("; ")})`;
}

export function validateWaifuOutput(
  text: string,
  ctx: ValidationContext
): { verdict: ValidationVerdict; violations: Violation[] } {
  const violations: Violation[] = [];

  // Run all checks — violations accumulate
  for (const check of BLOCK_CHECKS) {
    const v = check(text, ctx);
    if (v) violations.push(v);
  }
  for (const check of RETRY_CHECKS) {
    const v = check(text, ctx);
    if (v) violations.push(v);
  }

  // Verdict precedence: block > retry > pass
  if (violations.some((v) => v.check === "mass-ping")) {
    return { verdict: "block", violations };
  }
  if (violations.length > 0) {
    return { verdict: "retry", violations };
  }
  return { verdict: "pass", violations: [] };
}
