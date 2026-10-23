import { describe, expect, it } from "vitest";
import { planRestartResume, unsentResponders } from "../src/orchestration/restartResume.js";
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

  it("a human message that arrived during downtime overrides the restored timer (wake promptly)", () => {
    const plan = planRestartResume(
      {
        guildId: "g1",
        channelId: "c1",
        session: { scheduledRetriggerAt: iso(700), activePipeline: null },
        latestDecision: decision({ createdAt: iso(-300) }),
        newestHumanMessageAt: iso(-30) // newer than the last decision — nobody has seen it
      },
      NOW
    );
    expect(plan.kind).toBe("restore-timer");
    expect(plan.kind === "restore-timer" && plan.seconds).toBeLessThanOrEqual(30);
    expect(plan.kind === "restore-timer" && plan.reason).toMatch(/downtime|missed/i);
  });

  it("an old human message does not shorten the restored timer", () => {
    const plan = planRestartResume(
      {
        guildId: "g1",
        channelId: "c1",
        session: { scheduledRetriggerAt: iso(700), activePipeline: null },
        latestDecision: decision({ createdAt: iso(-300) }),
        newestHumanMessageAt: iso(-400) // the last decision already saw it
      },
      NOW
    );
    expect(plan.kind === "restore-timer" && plan.seconds).toBe(700);
  });

  it("nothing pending → no action", () => {
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: decision({}) },
      NOW
    );
    expect(plan.kind).toBe("none");
  });

  it("resumes a responder interrupted by a planned shutdown/reload (runtime_shutdown)", () => {
    const entry = decision({
      status: "interrupted",
      createdAt: iso(-60),
      respondingWaifus: [{ waifuId: "akari", delaySeconds: 0 }],
      responderOutcomes: [{ id: "o1", waifuId: "akari", source: "orchestrator", status: "interrupted", reason: "runtime_shutdown", messageIds: [] }]
    } as never);
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: entry },
      NOW
    );
    expect(plan.kind).toBe("resume-responders");
  });

  it("never resumes a responder interrupted by an explicit user pause", () => {
    const entry = decision({
      status: "interrupted",
      createdAt: iso(-60),
      respondingWaifus: [{ waifuId: "akari", delaySeconds: 0 }],
      responderOutcomes: [{ id: "o1", waifuId: "akari", source: "orchestrator", status: "interrupted", reason: "runtime paused", messageIds: [] }]
    } as never);
    const plan = planRestartResume(
      { guildId: "g1", channelId: "c1", session: { activePipeline: null }, latestDecision: entry },
      NOW
    );
    expect(plan.kind).toBe("none");
  });
});

describe("unsentResponders", () => {
  const interrupted = { status: "interrupted", reason: "runtime_restarted", messageIds: [] };

  it("matches planned responders by waifu id after a handoff outcome was inserted ahead of them", () => {
    const entry = decision({
      respondingWaifus: [
        { waifuId: "akari", delaySeconds: 0 },
        { waifuId: "riko", delaySeconds: 4, directive: { intent: "spotlight", goal: "answer K" } }
      ],
      responderOutcomes: [
        { id: "o1", waifuId: "akari", source: "orchestrator", status: "sent", messageIds: ["m1"] },
        { id: "h1", waifuId: "mika", source: "handoff", handoffFromWaifuId: "akari", status: "sent", messageIds: ["m2"] },
        { id: "o2", waifuId: "riko", source: "orchestrator", ...interrupted }
      ]
    } as never);
    const unsent = unsentResponders(entry);
    expect(unsent.map((responder) => responder.waifuId)).toEqual(["riko"]);
    expect(unsent[0].directive?.goal).toBe("answer K");
  });

  it("follows execution order after a handoff moved a planned responder forward", () => {
    const entry = decision({
      respondingWaifus: [
        { waifuId: "akari", delaySeconds: 0 },
        { waifuId: "riko", delaySeconds: 3 },
        { waifuId: "mika", delaySeconds: 5, directive: { intent: "change_topic", goal: "the trip" } }
      ],
      responderOutcomes: [
        { id: "o1", waifuId: "akari", source: "orchestrator", status: "sent", messageIds: ["m1"] },
        { id: "o3", waifuId: "mika", source: "orchestrator", handoffFromWaifuId: "akari", ...interrupted },
        { id: "o2", waifuId: "riko", source: "orchestrator", ...interrupted }
      ]
    } as never);
    const unsent = unsentResponders(entry);
    expect(unsent.map((responder) => responder.waifuId)).toEqual(["mika", "riko"]);
    expect(unsent[0].directive?.goal).toBe("the trip");
  });

  it("matches repeated waifus by occurrence and resumes an unsent handoff", () => {
    const entry = decision({
      respondingWaifus: [
        { waifuId: "akari", delaySeconds: 0, directive: { intent: "spotlight", goal: "first" } },
        { waifuId: "akari", delaySeconds: 2, directive: { intent: "spotlight", goal: "second" } }
      ],
      responderOutcomes: [
        { id: "o1", waifuId: "akari", source: "orchestrator", status: "sent", messageIds: ["m1"] },
        { id: "h1", waifuId: "riko", source: "handoff", handoffFromWaifuId: "akari", ...interrupted },
        { id: "o2", waifuId: "akari", source: "orchestrator", status: "pending", messageIds: [] }
      ]
    } as never);
    const unsent = unsentResponders(entry);
    expect(unsent.map((responder) => responder.waifuId)).toEqual(["riko", "akari"]);
    expect(unsent[0].directive).toBeUndefined();
    expect(unsent[1].directive?.goal).toBe("second");
  });
});
