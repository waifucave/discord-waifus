// Restart resume planning: make a server restart invisible to the room.
//
// Everything needed already persists — channel sessions carry the absolute retrigger time,
// orchestrator history carries interrupted decisions with responders, directives, reasoning,
// and wake plans. This pure module decides, per channel, what boot should do with them:
// re-arm the timer with the REMAINING time, re-execute responders that never sent, or nothing.

import type {
  OrchestratorDecisionHistoryEntry,
  OrchestratorRespondingWaifu
} from "../shared/schemas/domain.js";

// Only two outcome shapes mean "the restart ate her line": still pending (resume ran before
// the boot heal) or interrupted with the heal's runtime_restarted marker. Interruptions with
// other reasons were superseded by real messages BEFORE the restart and must stay dead.
/** Interrupted decisions older than this get a fresh pass instead of a zombie reply. */
const RESUME_DECISION_WINDOW_MS = 15 * 60 * 1000;
/** Elapsed timers and stale work fire shortly after boot (clamped upward by scheduleRetrigger). */
const PROMPT_STAGGER_SECONDS = 15;

export type ResumeChannelInput = {
  guildId: string;
  channelId: string;
  session: {
    scheduledRetriggerAt?: string;
    activePipeline: { kind: string; startedAt: string } | null;
  };
  /** Newest orchestrator decision recorded for this channel, regardless of status. */
  latestDecision?: OrchestratorDecisionHistoryEntry;
  /** Newest human message visible in the channel at boot (supplied when Discord is reachable). */
  newestHumanMessageAt?: string;
};

export type ResumeAction =
  | {
      kind: "resume-responders";
      guildId: string;
      channelId: string;
      decisionId: string;
      responders: OrchestratorRespondingWaifu[];
      reasoning: string;
    }
  | { kind: "restore-timer"; guildId: string; channelId: string; seconds: number; reason: string }
  | { kind: "none" };

export function unsentResponders(entry: OrchestratorDecisionHistoryEntry): OrchestratorRespondingWaifu[] {
  return entry.respondingWaifus.filter((responder, index) => {
    const outcome = entry.responderOutcomes[index];
    if (!outcome || outcome.waifuId !== responder.waifuId) return false;
    if (outcome.messageIds.length > 0) return false;
    if (outcome.status === "pending") return true;
    return outcome.status === "interrupted" && outcome.reason === "runtime_restarted";
  });
}

export function planRestartResume(input: ResumeChannelInput, now: Date): ResumeAction {
  const { guildId, channelId, session, latestDecision } = input;

  // 1. A decision that was cut down mid-execution: the chosen waifus never spoke.
  if (latestDecision && latestDecision.action === "reply") {
    const unsent = unsentResponders(latestDecision);
    if (unsent.length > 0) {
      const ageMs = now.getTime() - Date.parse(latestDecision.createdAt);
      if (ageMs <= RESUME_DECISION_WINDOW_MS) {
        return {
          kind: "resume-responders",
          guildId,
          channelId,
          decisionId: latestDecision.id,
          // the pre-restart delay already elapsed in real time; speak promptly
          responders: unsent.map((responder) => ({ ...responder, delaySeconds: 0 })),
          reasoning: latestDecision.reasoning
        };
      }
      // Too old to replay the beat verbatim — let a fresh pass read the room instead.
      return { kind: "restore-timer", guildId, channelId, seconds: PROMPT_STAGGER_SECONDS, reason: "stale interrupted decision" };
    }
  }

  // 2. A human message nobody has processed yet (arrived during the downtime window)
  // outranks any schedule — "keep counting" only applies when nothing new happened.
  if (
    input.newestHumanMessageAt &&
    (!latestDecision || input.newestHumanMessageAt > latestDecision.createdAt)
  ) {
    return {
      kind: "restore-timer",
      guildId,
      channelId,
      seconds: PROMPT_STAGGER_SECONDS,
      reason: "human message arrived during downtime"
    };
  }

  // 3. A scheduled wake: keep counting the original clock.
  if (session.scheduledRetriggerAt) {
    const remainingSeconds = Math.round((Date.parse(session.scheduledRetriggerAt) - now.getTime()) / 1000);
    if (remainingSeconds > 0) {
      return { kind: "restore-timer", guildId, channelId, seconds: remainingSeconds, reason: "persisted retrigger restored" };
    }
    return { kind: "restore-timer", guildId, channelId, seconds: PROMPT_STAGGER_SECONDS, reason: "retrigger elapsed during downtime" };
  }

  // 4. A run that died mid-flight without responders or a timer: check the room soon.
  if (session.activePipeline) {
    return { kind: "restore-timer", guildId, channelId, seconds: PROMPT_STAGGER_SECONDS, reason: "pipeline was active at shutdown" };
  }

  return { kind: "none" };
}
