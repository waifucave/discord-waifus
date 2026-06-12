import type { ChatMessage } from "@waifucave/gateway";
import { ContextMessage, formatOrchestratorMessageBlock, OrchestratorWakeMarker } from "../context.js";
import { OrchestratorDecisionHistoryEntry } from "../../shared/schemas/domain.js";
import { ORCHESTRATOR_TOOL_NAME } from "../tools.js";

export type OrchestratorTimelineItem =
  | { kind: "message"; message: ContextMessage; timestamp: string }
  | { kind: "decision"; decision: OrchestratorDecisionHistoryEntry; timestamp: string }
  | { kind: "note"; text: string; timestamp: string };

const GAP_NOTE_MIN_MS = 15 * 60 * 1000;

function formatGapLabel(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 90) return `[${minutes}m pass]`;
  const hours = Math.round(gapMs / 3_600_000);
  return `[${hours}h pass]`;
}

function gapNotes(messages: ContextMessage[]): OrchestratorTimelineItem[] {
  const notes: OrchestratorTimelineItem[] = [];
  for (let i = 1; i < messages.length; i += 1) {
    const gapMs = Date.parse(messages[i].timestamp) - Date.parse(messages[i - 1].timestamp);
    if (gapMs >= GAP_NOTE_MIN_MS) {
      // timestamp matches the following message; kindRank places the note before it
      notes.push({ kind: "note", text: formatGapLabel(gapMs), timestamp: messages[i].timestamp });
    }
  }
  return notes;
}

function formatWakeMarker(marker: OrchestratorWakeMarker): string {
  const plan = marker.wakePlan ? ` Your plan was: "${marker.wakePlan}".` : "";
  return (
    `[wake: the ${marker.scheduledSeconds}s pause you scheduled has elapsed with no new messages.${plan}` +
    " Execute the plan now, or if the room state changed, decide fresh. Do not schedule another identical pause — either act, or back off with a longer pause.]"
  );
}

export function buildOrchestratorTimeline(
  messages: ContextMessage[],
  decisions: OrchestratorDecisionHistoryEntry[],
  markers: OrchestratorWakeMarker[]
): OrchestratorTimelineItem[] {
  const oldestMessageTimestamp = messages.length ? messages[0].timestamp : undefined;
  const kindRank = { note: 0, message: 1, decision: 2 } as const;
  const items: OrchestratorTimelineItem[] = [
    ...messages.map((message): OrchestratorTimelineItem => ({ kind: "message", message, timestamp: message.timestamp })),
    ...gapNotes(messages),
    ...decisions
      .filter((decision) =>
        oldestMessageTimestamp === undefined ? false : decision.createdAt >= oldestMessageTimestamp
      )
      .map((decision): OrchestratorTimelineItem => ({ kind: "decision", decision, timestamp: decision.createdAt })),
    ...markers.map((marker): OrchestratorTimelineItem => ({ kind: "note", text: formatWakeMarker(marker), timestamp: marker.timestamp }))
  ];
  items.sort((a, b) => {
    if (a.timestamp === b.timestamp) return kindRank[a.kind] - kindRank[b.kind];
    return a.timestamp < b.timestamp ? -1 : 1;
  });
  return items;
}

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

export function formatDecisionOutcome(decision: OrchestratorDecisionHistoryEntry): string {
  if (decision.action === "no_reply") {
    return `paused ${decision.retriggerAfterSeconds ?? "?"}s`;
  }
  const deviations = decision.responderOutcomes
    // "pending" means the chain was cut before this responder fired — the interrupted arm covers it
    .filter((outcome) => outcome.status !== "sent" && outcome.status !== "pending")
    .map((outcome) => `${outcome.waifuId}: ${outcome.status}`);
  if (decision.status === "interrupted") {
    deviations.push("interrupted by new activity");
  }
  return deviations.length ? deviations.join("; ") : "sent";
}

export type OrchestratorTimelineInputs = {
  systemPrompt?: string;
  trailingPrompt?: string;
  messages: ContextMessage[];
  pastDecisions?: OrchestratorDecisionHistoryEntry[];
  decisionMarkers?: OrchestratorWakeMarker[];
};

export function buildOrchestratorChatMessages(inputs: OrchestratorTimelineInputs): ChatMessage[] {
  const timeline = buildOrchestratorTimeline(
    inputs.messages,
    inputs.pastDecisions ?? [],
    inputs.decisionMarkers ?? []
  );
  const out: ChatMessage[] = [];
  if (inputs.systemPrompt) out.push({ role: "system", content: inputs.systemPrompt });
  let callCounter = 0;
  for (const item of timeline) {
    if (item.kind === "decision") {
      const id = `past_decision_${++callCounter}`;
      out.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id,
            name: ORCHESTRATOR_TOOL_NAME,
            arguments: JSON.stringify(serializeOrchestratorDecisionArguments(item.decision))
          }
        ]
      });
      out.push({ role: "tool", toolCallId: id, content: formatDecisionOutcome(item.decision) });
    } else if (item.kind === "message") {
      out.push({ role: "user", content: formatOrchestratorMessageBlock(item.message) });
    } else {
      // note (gap or wake marker)
      out.push({ role: "user", content: item.text });
    }
  }
  if (inputs.trailingPrompt) out.push({ role: "user", content: inputs.trailingPrompt });
  return out;
}
