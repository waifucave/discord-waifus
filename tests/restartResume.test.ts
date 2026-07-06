import { describe, expect, it } from "vitest";
import { planRestartResume } from "../src/orchestration/restartResume.js";
import type { OrchestratorDecisionHistoryEntry } from "../src/shared/schemas/domain.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const iso = (secondsFromNow: number) => new Date(NOW.getTime() + secondsFromNow * 1000).toISOString();

function decision(partial: Partial<OrchestratorDecisionHistoryEntry>): OrchestratorDecisionHistoryEntry {
  return {
    id: "d1",
    guildId: "g1",
    channelId: "c1",
    action: "reply",
    respondingWaifus: [],
    reasoning: "test",
    status: "completed",
    waifuMessageIds: [],
    responderOutcomes: [],
    createdAt: iso(-60),
    ...partial
  } as OrchestratorDecisionHistoryEntry;
}

describe("planRestartResume", () => {
  it("restores the remaining time of a pending retrigger (1000s chosen, 300s elapsed → ~700s left)", () => {
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { scheduledRetriggerAt: iso(700), activePipeline: null } },
      NOW
    );
    expect(plan.kind).toBe("restore-timer");
    expect(plan.kind === "restore-timer" && plan.seconds).toBe(700);
  });

  it("a retrigger that elapsed during downtime fires promptly", () => {
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { scheduledRetriggerAt: iso(-400), activePipeline: null } },
      NOW
    );
    expect(plan.kind).toBe("restore-timer");
    expect(plan.kind === "restore-timer" && plan.seconds).toBeLessThanOrEqual(30);
  });

  it("a young interrupted decision resumes its unsent responders with directives intact", () => {
    const entry = decision({
      status: "pending",
      createdAt: iso(-120),
      respondingWaifus: [
        { waifuId: "akari", delaySeconds: 3, directive: { intent: "change_topic", goal: "ask about the trip" } },
        { waifuId: "riko", delaySeconds: 5 }
      ],
      responderOutcomes: [
        { id: "o1", waifuId: "akari", source: "decision", status: "pending", messageIds: [] },
        { id: "o2", waifuId: "riko", source: "decision", status: "sent", messageIds: ["m1"] }
      ]
    } as never);
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: entry },
      NOW
    );
    expect(plan.kind).toBe("resume-responders");
    if (plan.kind === "resume-responders") {
      expect(plan.responders).toHaveLength(1);
      expect(plan.responders[0].waifuId).toBe("akari");
      expect(plan.responders[0].directive?.goal).toBe("ask about the trip");
      expect(plan.reasoning).toContain("test");
    }
  });

  it("a stale interrupted decision gets a fresh prompt run instead of a zombie reply", () => {
    const entry = decision({
      status: "pending",
      createdAt: iso(-3600),
      respondingWaifus: [{ waifuId: "akari", delaySeconds: 0 }],
      responderOutcomes: [{ id: "o1", waifuId: "akari", source: "decision", status: "pending", messageIds: [] }]
    } as never);
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: entry },
      NOW
    );
    expect(plan.kind).toBe("restore-timer");
    expect(plan.kind === "restore-timer" && plan.seconds).toBeLessThanOrEqual(30);
  });

  it("interrupted decision takes precedence over a scheduled timer", () => {
    const entry = decision({
      status: "pending",
      createdAt: iso(-60),
      respondingWaifus: [{ waifuId: "akari", delaySeconds: 0 }],
      responderOutcomes: [{ id: "o1", waifuId: "akari", source: "decision", status: "interrupted", reason: "runtime_restarted", messageIds: [] }]
    } as never);
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { scheduledRetriggerAt: iso(500), activePipeline: null }, latestDecision: entry },
      NOW
    );
    expect(plan.kind).toBe("resume-responders");
  });

  it("a decision interrupted by a real message before the restart stays dead", () => {
    const entry = decision({
      status: "interrupted",
      createdAt: iso(-60),
      respondingWaifus: [{ waifuId: "akari", delaySeconds: 0 }],
      responderOutcomes: [{ id: "o1", waifuId: "akari", source: "decision", status: "interrupted", reason: "restarted by message:123", messageIds: [] }]
    } as never);
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: entry },
      NOW
    );
    expect(plan.kind).toBe("none");
  });

  it("nothing pending → no action", () => {
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: decision({}) },
      NOW
    );
    expect(plan.kind).toBe("none");
  });
});
