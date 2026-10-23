// Orchestrator decision serializers (spec 8.7). A past decision reaches the director's context as
// a `decision` ContextNote written once the decision is final: `call` is the (lossy) serialized
// tool-call arguments, `outcome` the final-state result text. The transcript renders the note as
// an orchestrator_decision tool-call turn, or — on the JSON-schema fallback, which sends no tools —
// as a text line `[decision 14:02] reply → aria · sent`. No relative ages anywhere.

import type { OrchestratorDecisionHistoryEntry } from "../../shared/schemas/domain.js";
import type { NewContextNote } from "../context/types.js";

function clipReplayText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

// Replay is deliberately lossy: goal text, delays, and full reasoning are omitted so past
// decisions cannot teach the model a directive-writing or scripting habit.
export function serializeOrchestratorDecisionArguments(decision: OrchestratorDecisionHistoryEntry): Record<string, unknown> {
  return {
    action: decision.action,
    respondingWaifus: decision.respondingWaifus.map((responder) => ({
      waifuId: responder.waifuId,
      directive: responder.directive ? { intent: responder.directive.intent } : null
    })),
    retriggerAfterSeconds:
      decision.action === "no_reply" ? decision.retriggerAfterSeconds ?? null : null,
    wakePlan: decision.action === "no_reply" ? decision.wakePlan ?? null : null,
    reasoning: clipReplayText(decision.reasoning, 160)
  };
}

/**
 * Final-state outcome text. With `refFor`, the refs of the messages the decision produced are
 * named (`sent → #a3, #a4`), so the note reads correctly wherever it sits in the transcript.
 */
export function formatDecisionOutcome(
  decision: OrchestratorDecisionHistoryEntry,
  refFor: (messageId: string) => string | undefined = () => undefined
): string {
  if (decision.action === "no_reply") {
    return `paused ${decision.retriggerAfterSeconds ?? "?"}s`;
  }
  const sentRefs = decision.responderOutcomes
    .filter((outcome) => outcome.status === "sent")
    .flatMap((outcome) => outcome.messageIds)
    .map(refFor)
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => `#${ref}`);
  const deviations = decision.responderOutcomes
    // "pending" means the chain was cut before this responder fired — the interrupted arm covers it
    .filter((outcome) => outcome.status !== "sent" && outcome.status !== "pending")
    .map((outcome) => `${outcome.waifuId}: ${outcome.status}`);
  if (decision.status === "interrupted") {
    deviations.push("interrupted by new activity");
  } else if (decision.status === "failed") {
    deviations.push("failed");
  }
  const sent = sentRefs.length ? `sent → ${sentRefs.join(", ")}` : deviations.length ? undefined : "sent";
  return [sent, ...deviations].filter(Boolean).join("; ");
}

/** True once nothing about the decision's outcome can change any more. */
export function isDecisionFinal(decision: Pick<OrchestratorDecisionHistoryEntry, "status">): boolean {
  return decision.status !== "pending";
}

/** The frozen `decision` note for a final decision; undefined while it is still pending. */
export function decisionNoteFor(
  decision: OrchestratorDecisionHistoryEntry,
  refFor?: (messageId: string) => string | undefined
): NewContextNote | undefined {
  if (!isDecisionFinal(decision)) return undefined;
  return {
    kind: "decision",
    decisionId: decision.id,
    call: JSON.stringify(serializeOrchestratorDecisionArguments(decision)),
    outcome: formatDecisionOutcome(decision, refFor),
    at: decision.createdAt
  };
}

/**
 * Compact text of a serialized decision call for the no-tools path: `reply → aria, riko
 * (change_topic)` or `no_reply 420s · plan: "…"`. Falls back to the raw text when it is not JSON.
 */
export function formatDecisionCallText(call: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call);
  } catch {
    return call;
  }
  if (!parsed || typeof parsed !== "object") return call;
  const args = parsed as {
    action?: unknown;
    respondingWaifus?: Array<{ waifuId?: unknown; directive?: { intent?: unknown } | null }>;
    retriggerAfterSeconds?: unknown;
    wakePlan?: unknown;
  };
  if (args.action === "reply") {
    const responders = (Array.isArray(args.respondingWaifus) ? args.respondingWaifus : []).map((responder) => {
      const id = typeof responder?.waifuId === "string" ? responder.waifuId : "?";
      const intent = responder?.directive && typeof responder.directive.intent === "string" ? responder.directive.intent : undefined;
      return intent ? `${id} (${intent})` : id;
    });
    return `reply → ${responders.join(", ") || "?"}`;
  }
  if (args.action === "no_reply") {
    const seconds = typeof args.retriggerAfterSeconds === "number" ? ` ${args.retriggerAfterSeconds}s` : "";
    const plan = typeof args.wakePlan === "string" && args.wakePlan ? ` · plan: "${args.wakePlan}"` : "";
    return `no_reply${seconds}${plan}`;
  }
  return call;
}
