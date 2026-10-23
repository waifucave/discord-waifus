import { ContextMessage } from "./contextMessages.js";
import { jaccard, tokenSet } from "./text.js";

export type LoopAssessment = {
  suspected: boolean;
  notice?: string;
};

/** The fields the detector reads (a ContextMessage or an adapted ledger entry). */
export type LoopMessage = Pick<ContextMessage, "authorKind" | "authorId" | "content">;

const WINDOW = 8;                 // waifu messages considered
const TAIL_PAIRS = 4;             // newest pairs (of each kind) examined for repetition
const PAIR_THRESHOLD = 0.45;      // similarity that marks a pair repetitive
const HARD_THRESHOLD = 0.8;       // any single pair this similar => loop
const MIN_REPETITIVE_PAIRS = 2;   // soft-threshold pairs in the tail that constitute a loop

// Very short messages (e.g. "ok") tokenize to an empty set and score 0 against anything,
// so they never trigger loop detection.
// Deterministic repetition check over the most recent waifu-authored messages, two ways:
// - adjacent pairs: consecutive waifu messages restating each other (A ≈ B);
// - same-author pairs (I7): each message against that author's previous one in the window, so an
//   alternating A/B/A/B volley where each waifu repeats herself is caught even when A and B differ.
// Gives a flash-lite-class orchestrator an external loop signal instead of asking it to
// self-diagnose from raw chat.
export function assessLoop(messages: readonly LoopMessage[]): LoopAssessment {
  const waifuMessages = messages.filter((message) => message.authorKind === "waifu").slice(-WINDOW);
  if (waifuMessages.length < 2) return { suspected: false };
  const tokens = waifuMessages.map((message) => tokenSet(message.content));
  const adjacent: number[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    adjacent.push(jaccard(tokens[i - 1], tokens[i]));
  }
  const sameAuthor: number[] = [];
  for (let i = 1; i < waifuMessages.length; i += 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (waifuMessages[j].authorId !== waifuMessages[i].authorId) continue;
      // Directly consecutive messages of one author are already an adjacent pair.
      if (j !== i - 1) sameAuthor.push(jaccard(tokens[j], tokens[i]));
      break;
    }
  }
  const adjacentTail = adjacent.slice(-TAIL_PAIRS);
  const authorTail = sameAuthor.slice(-TAIL_PAIRS);
  const adjacentRepetitive = adjacentTail.filter((value) => value >= PAIR_THRESHOLD).length;
  const authorRepetitive = authorTail.filter((value) => value >= PAIR_THRESHOLD).length;
  const hard = [...adjacentTail, ...authorTail].some((value) => value >= HARD_THRESHOLD);
  const suspected = adjacentRepetitive >= MIN_REPETITIVE_PAIRS || authorRepetitive >= MIN_REPETITIVE_PAIRS || hard;
  if (!suspected) return { suspected: false };
  const detail =
    authorRepetitive > adjacentRepetitive
      ? `each waifu keeps restating her own previous message: ${authorRepetitive} of the latest ${authorTail.length} same-speaker pairs are near-duplicates`
      : `${adjacentRepetitive} of the latest ${adjacentTail.length} adjacent pairs are near-duplicates`;
  return {
    suspected: true,
    notice:
      `The last few waifu messages look repetitive (${detail}). ` +
      "Break the pattern: a different speaker, a directive with a concrete new goal, or silence."
  };
}

// ---------------------------------------------------------------------------
// Cast-retirement cadence: the orchestrator keeps ending runs after one or two
// reply passes and scheduling a wake, even in active rooms (live pattern,
// 2026-07-05: reasoning said "humans are actively engaged" and it still chose
// no_reply). Like assessLoop, this hands a lite-class model a deterministic
// external signal instead of asking it to self-diagnose.

const CADENCE_WINDOW = 6;       // completed decisions considered (newest first)
const CADENCE_MIN_PAUSES = 2;   // pauses in the window that make it a rhythm
const CADENCE_MAX_STREAK = 2;   // reply streaks this short mark early retirement

export function assessCastCadence(decisions: Array<{ action: string }>): LoopAssessment {
  const window = decisions.slice(0, CADENCE_WINDOW);
  const pauses = window.filter((decision) => decision.action === "no_reply").length;
  if (window.length < 3 || pauses < CADENCE_MIN_PAUSES) return { suspected: false };
  let longestReplyStreak = 0;
  let streak = 0;
  for (const decision of window) {
    if (decision.action === "reply") {
      streak += 1;
      longestReplyStreak = Math.max(longestReplyStreak, streak);
    } else {
      streak = 0;
    }
  }
  if (longestReplyStreak > CADENCE_MAX_STREAK) return { suspected: false };
  return {
    suspected: true,
    notice:
      "Your recent passes follow a fixed rhythm: one or two casts, then a timer. If the room is still active, " +
      "that reads as the cast clocking out mid-conversation — keep casting while the energy holds (several " +
      "consecutive casts are normal in a lively room) and reach for no_reply only once the room has genuinely cooled."
  };
}
