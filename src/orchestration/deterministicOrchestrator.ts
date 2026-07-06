// Deterministic (model-free) orchestrator decisions.
//
// Two jobs: a zero-credit orchestration mode, and the fallback when the model call fails or a
// provider blocks the prompt (live incident 2026-07-06: Gemini PROHIBITED_CONTENT blocked an
// active room repeatedly). It picks the next speaker from structural signals only — reply
// targets, name addressing, references, rotation, availability — never content judgment.
//
// Pure module: no side effects, no imports from runtime. Interval helpers are copied verbatim
// from runtime.ts (modules stay decoupled per W1 precedent). Schedules are server-local time,
// same convention as currentlyDoingForWaifu.

import type { ContextMessage } from "./context.js";
import { DIRECTIVE_GOAL_MAX_CHARS, type OrchestratorDecision } from "./decisions.js";
import type { WaifuAvailability } from "../shared/schemas/domain.js";

export type DeterministicCastMember = {
  waifuId: string;
  /** Every handle she answers to: name, display name, server nickname. */
  names: string[];
  /** Discord author ids that attribute context messages to her (bot entry id + application id). */
  authorIds: string[];
  availability: WaifuAvailability;
};

export type DeterministicDecisionInput = {
  /** Chronological, oldest first — same order the model orchestrator receives. */
  messages: ContextMessage[];
  cast: DeterministicCastMember[];
  now: Date;
};

const ROTATION_WINDOW = 4;        // recent waifu messages examined for dominance penalties
const SCORE_REPLY_TARGET = 100;
const SCORE_ADDRESSED = 90;
const SCORE_REFERENCED = 30;
const SCORE_WAIFU_REFERENCED = 15;
const SCORE_PARTICIPANT = 20; // must stay below PENALTY_PER_RECENT_MESSAGE so rotation wins on generic messages
const PENALTY_LAST_SPEAKER = -60;
const PENALTY_PER_RECENT_MESSAGE = -25;
const PARTICIPATION_WINDOW = 10;  // messages scanned for thread participation

export function decideDeterministically(input: DeterministicDecisionInput): OrchestratorDecision {
  const { messages, now } = input;
  const latest = messages[messages.length - 1];
  const newestHumanTs = [...messages].reverse().find((m) => m.authorKind === "user")?.timestamp;
  const humanAgeSeconds =
    newestHumanTs !== undefined ? Math.max(0, (now.getTime() - Date.parse(newestHumanTs)) / 1000) : Infinity;

  const candidates = input.cast.filter((member) => isAvailable(member.availability, now));
  const quiet = (reason: string): OrchestratorDecision => ({
    action: "no_reply",
    respondingWaifus: [],
    retriggerAfterSeconds: retriggerForHumanAge(humanAgeSeconds),
    reasoning: `deterministic: ${reason}`
  });

  if (candidates.length === 0) return quiet("no enabled, awake, unbusy waifu is available");
  if (!latest || latest.authorKind !== "user") {
    return quiet("latest message is not from a human; cast-only pacing");
  }

  const authorOf = (message: ContextMessage): DeterministicCastMember | undefined =>
    input.cast.find(
      (member) => member.authorIds.includes(message.authorId) || matchesName(member, message.displayName, "exact")
    );

  const recentWaifuMessages = messages.filter((m) => m.authorKind === "waifu").slice(-ROTATION_WINDOW);
  const lastWaifuMessage = recentWaifuMessages[recentWaifuMessages.length - 1];
  const participationSlice = messages.slice(-PARTICIPATION_WINDOW);

  const scored = candidates.map((member) => {
    let score = 0;
    const reasons: string[] = [];

    if (latest.replyTo?.authorName && matchesName(member, latest.replyTo.authorName, "exact")) {
      score += SCORE_REPLY_TARGET;
      reasons.push("reply target");
    }
    if (isAddressed(member, latest.content)) {
      score += SCORE_ADDRESSED;
      reasons.push("addressed by name");
    } else if (isReferenced(member, latest.content)) {
      score += SCORE_REFERENCED;
      reasons.push("referenced");
    }
    if (
      recentWaifuMessages.some(
        (m) => authorOf(m)?.waifuId !== member.waifuId && isReferenced(member, m.content)
      )
    ) {
      score += SCORE_WAIFU_REFERENCED;
      reasons.push("talked about by the cast");
    }
    if (participationSlice.some((m) => m.authorKind === "waifu" && authorOf(m)?.waifuId === member.waifuId)) {
      score += SCORE_PARTICIPANT;
      reasons.push("in the live thread");
    }
    if (lastWaifuMessage && authorOf(lastWaifuMessage)?.waifuId === member.waifuId) {
      score += PENALTY_LAST_SPEAKER;
      reasons.push("spoke last");
    }
    const recentCount = recentWaifuMessages.filter((m) => authorOf(m)?.waifuId === member.waifuId).length;
    score += recentCount * PENALTY_PER_RECENT_MESSAGE;

    // rotation tiebreak: the longer since she spoke, the better
    const lastSpokeIndex = findLastIndex(messages, (m) => m.authorKind === "waifu" && authorOf(m)?.waifuId === member.waifuId);
    const staleness = lastSpokeIndex === -1 ? messages.length : messages.length - 1 - lastSpokeIndex;

    return { member, score, staleness, reasons };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.staleness !== a.staleness) return b.staleness - a.staleness;
    // stable variety tiebreak: hash of (latest message id, waifu id)
    return stableHash(latest.id + b.member.waifuId) - stableHash(latest.id + a.member.waifuId);
  });

  const winner = scored[0];
  const delaySeconds = 2 + (stableHash(latest.id + winner.member.waifuId) % 4);
  return {
    action: "reply",
    respondingWaifus: [{ waifuId: winner.member.waifuId, delaySeconds }],
    reasoning: `deterministic: ${winner.member.waifuId} picked (${winner.reasons.join(", ") || "rotation"}; score ${winner.score})`
  };
}

/** Is she awake and not busy right now? Server-local time, like the schedule prompt blocks. */
function isAvailable(availability: WaifuAvailability, now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (availability.sleep.enabled && dailyIntervalContains(minutes, availability.sleep)) return false;
  for (const interval of availability.busy) {
    if (dailyIntervalContains(minutes, interval)) return false;
  }
  return true;
}

/** Addressed = her name opens/closes the message, or appears alongside second-person "you". */
function isAddressed(member: DeterministicCastMember, content: string): boolean {
  const text = content.trim();
  const lower = text.toLowerCase();
  for (const name of member.names) {
    const n = name.trim();
    if (!n) continue;
    const ln = n.toLowerCase();
    if (lower.startsWith(ln)) return true;
    if (lower.endsWith(ln) || lower.endsWith(`${ln}?`) || lower.endsWith(`${ln}!`)) return true;
    if (containsName(lower, ln) && /\byou\b|\bu\b/.test(lower)) return true;
  }
  return false;
}

function isReferenced(member: DeterministicCastMember, content: string): boolean {
  const lower = content.toLowerCase();
  return member.names.some((name) => name.trim() && containsName(lower, name.trim().toLowerCase()));
}

/** Word-boundary match for ASCII names, substring for CJK/emoji handles where \b is useless. */
function containsName(haystackLower: string, nameLower: string): boolean {
  if (/^[\x20-\x7e]+$/.test(nameLower)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(nameLower)}($|[^a-z0-9])`).test(haystackLower);
  }
  return haystackLower.includes(nameLower);
}

function matchesName(member: DeterministicCastMember, value: string | undefined, _mode: "exact"): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return member.names.some((name) => name.trim().toLowerCase() === v);
}

function retriggerForHumanAge(ageSeconds: number): number {
  if (ageSeconds < 120) return 45;
  if (ageSeconds < 900) return 240;
  if (ageSeconds < 7200) return 900;
  return 3600;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function dailyIntervalContains(currentMinutes: number, interval: { start: string; end: string }): boolean {
  const start = timeOfDayMinutes(interval.start);
  const end = timeOfDayMinutes(interval.end);
  if (start === end) return false;
  if (start < end) return currentMinutes >= start && currentMinutes < end;
  return currentMinutes >= start || currentMinutes < end;
}

function timeOfDayMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Wake-plan enforcement: when the model schedules a wake with a plan and then defers that
 * plan again on the wake itself (live 2026-07-06 08:11: "have Lumi start a new topic" →
 * no_reply restating the same plan), execute the plan deterministically — the plan text
 * names the waifu, and the plan itself becomes her change_topic goal.
 */
export function enforceWakePlan(input: {
  plan: string;
  cast: DeterministicCastMember[];
  messages: ContextMessage[];
  now: Date;
}): OrchestratorDecision | undefined {
  const available = input.cast.filter((member) => isAvailable(member.availability, input.now));
  if (available.length === 0) return undefined;
  const named = available.find((member) => isReferenced(member, input.plan));
  const member = named ?? stalestMember(available, input.messages);
  if (!member) return undefined;
  const goal = clipSurrogateSafeText(input.plan.trim(), DIRECTIVE_GOAL_MAX_CHARS);
  return {
    action: "reply",
    respondingWaifus: [{ waifuId: member.waifuId, delaySeconds: 2, directive: { intent: "change_topic", goal } }],
    reasoning: `deterministic wake-plan enforcement: the model deferred its own plan twice; ${member.waifuId} executes it`
  };
}

function stalestMember(
  candidates: DeterministicCastMember[],
  messages: ContextMessage[]
): DeterministicCastMember | undefined {
  let best: DeterministicCastMember | undefined;
  let bestStaleness = -1;
  for (const member of candidates) {
    let lastIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.authorKind === "waifu" &&
        (member.authorIds.includes(message.authorId) || member.names.some((n) => n.trim().toLowerCase() === message.displayName.trim().toLowerCase()))
      ) {
        lastIndex = i;
        break;
      }
    }
    const staleness = lastIndex === -1 ? messages.length + 1 : messages.length - 1 - lastIndex;
    if (staleness > bestStaleness) {
      bestStaleness = staleness;
      best = member;
    }
  }
  return best;
}

function clipSurrogateSafeText(text: string, max: number): string {
  if (text.length <= max) return text;
  let clipped = text.slice(0, max);
  const last = clipped.charCodeAt(clipped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  return clipped;
}
