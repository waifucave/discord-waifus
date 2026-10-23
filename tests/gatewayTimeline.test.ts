import { describe, expect, it } from "vitest";
import {
  decisionNoteFor,
  formatDecisionCallText,
  formatDecisionOutcome,
  isDecisionFinal,
  serializeOrchestratorDecisionArguments
} from "../src/orchestration/pipeline/timeline.js";
import type { OrchestratorDecisionHistoryEntry } from "../src/shared/schemas/domain.js";

const pause: OrchestratorDecisionHistoryEntry = {
  id: "d1",
  action: "no_reply",
  respondingWaifus: [],
  retriggerAfterSeconds: 600,
  wakePlan: "check on Ann",
  reasoning: "quiet hours, nothing to add — waiting for the humans to come back with something new",
  status: "completed",
  waifuMessageIds: [],
  responderOutcomes: [],
  createdAt: "2026-06-12T10:05:00.000Z"
};

const reply: OrchestratorDecisionHistoryEntry = {
  ...pause,
  id: "d2",
  action: "reply",
  respondingWaifus: [
    { waifuId: "aria", delaySeconds: 2, directive: { intent: "change_topic", goal: "the bake sale" } },
    { waifuId: "riko", delaySeconds: 4 }
  ],
  retriggerAfterSeconds: undefined,
  wakePlan: undefined,
  status: "pending",
  responderOutcomes: [
    { id: "o1", waifuId: "aria", source: "orchestrator", status: "sent", messageIds: ["m1"] },
    { id: "o2", waifuId: "riko", source: "orchestrator", status: "pending", messageIds: [] }
  ]
};

describe("orchestrator decision serializers (spec 8.7)", () => {
  it("serializes lossy call arguments: no goal text, no delays, clipped reasoning", () => {
    const args = serializeOrchestratorDecisionArguments(reply);
    expect(args).toEqual({
      action: "reply",
      respondingWaifus: [
        { waifuId: "aria", directive: { intent: "change_topic" } },
        { waifuId: "riko", directive: null }
      ],
      retriggerAfterSeconds: null,
      wakePlan: null,
      reasoning: pause.reasoning
    });
    expect(JSON.stringify(args)).not.toContain("bake sale");
  });

  it("formats final outcomes", () => {
    expect(formatDecisionOutcome(pause)).toBe("paused 600s");
    expect(formatDecisionOutcome({ ...reply, status: "completed" })).toBe("sent");
    expect(formatDecisionOutcome({ ...reply, status: "interrupted" })).toBe("interrupted by new activity");
    // With refs, the produced messages are named (the note reads right wherever it sits).
    const refs = new Map([["m1", "a4"]]);
    expect(formatDecisionOutcome({ ...reply, status: "completed" }, (id) => refs.get(id))).toBe("sent → #a4");
    expect(formatDecisionOutcome({ ...reply, status: "interrupted" }, (id) => refs.get(id))).toBe("sent → #a4; interrupted by new activity");
    expect(decisionNoteFor({ ...reply, status: "completed" }, (id) => refs.get(id))).toMatchObject({ outcome: "sent → #a4", at: reply.createdAt });
    expect(
      formatDecisionOutcome({
        ...reply,
        status: "completed",
        responderOutcomes: [reply.responderOutcomes[0]!, { ...reply.responderOutcomes[1]!, status: "empty" }]
      })
    ).toBe("riko: empty");
  });

  it("writes a decision note only once the decision is final", () => {
    expect(isDecisionFinal(reply)).toBe(false);
    expect(decisionNoteFor(reply)).toBeUndefined();
    const note = decisionNoteFor({ ...reply, status: "completed" });
    expect(note).toEqual({
      kind: "decision",
      decisionId: "d2",
      call: JSON.stringify(serializeOrchestratorDecisionArguments(reply)),
      outcome: "sent",
      at: reply.createdAt
    });
    expect(decisionNoteFor(pause)).toMatchObject({ kind: "decision", decisionId: "d1", outcome: "paused 600s" });
  });

  it("renders compact text for the no-tools (JSON-schema) path", () => {
    expect(formatDecisionCallText(decisionNoteFor({ ...reply, status: "completed" })!.call as string)).toBe(
      "reply → aria (change_topic), riko"
    );
    expect(formatDecisionCallText((decisionNoteFor(pause) as { call: string }).call)).toBe('no_reply 600s · plan: "check on Ann"');
    expect(formatDecisionCallText("reply → Aria")).toBe("reply → Aria");
  });
});
