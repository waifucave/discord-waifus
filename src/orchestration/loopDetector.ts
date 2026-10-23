import { ContextMessage } from "./context.js";
import { jaccard, tokenSet } from "./text.js";

export type LoopAssessment = {
  suspected: boolean;
  notice?: string;
};

const WINDOW = 8;                 // waifu messages considered
const TAIL_PAIRS = 4;             // adjacent-pair tail window examined for repetition
const PAIR_THRESHOLD = 0.45;      // similarity that marks a pair repetitive
const HARD_THRESHOLD = 0.8;       // any single pair this similar => loop
const MIN_REPETITIVE_PAIRS = 2;   // soft-threshold pairs in the tail that constitute a loop

// Very short messages (e.g. "ok") tokenize to an empty set and score 0 against anything,
// so they never trigger loop detection.
// Deterministic repetition check over the most recent waifu-authored messages.
// Gives a flash-lite-class orchestrator an external loop signal instead of
// asking it to self-diagnose from raw chat.
export function assessLoop(messages: ContextMessage[]): LoopAssessment {
  const waifuMessages = messages.filter((message) => message.authorKind === "waifu").slice(-WINDOW);
  if (waifuMessages.length < 2) return { suspected: false };
  const tokens = waifuMessages.map((message) => tokenSet(message.content));
  const similarities: number[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    similarities.push(jaccard(tokens[i - 1], tokens[i]));
  }
  const tail = similarities.slice(-TAIL_PAIRS);
  const repetitivePairs = tail.filter((value) => value >= PAIR_THRESHOLD).length;
  const suspected = repetitivePairs >= MIN_REPETITIVE_PAIRS || tail.some((value) => value >= HARD_THRESHOLD);
  if (!suspected) return { suspected: false };
  return {
    suspected: true,
    notice:
      `The last few waifu messages look repetitive (${repetitivePairs} of the latest ${tail.length} adjacent pairs ` +
      "are near-duplicates). Break the pattern: a different speaker, a directive with a concrete new goal, or silence."
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
