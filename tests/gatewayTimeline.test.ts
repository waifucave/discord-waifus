import { describe, expect, it } from "vitest";
import { buildOrchestratorChatMessages, formatDecisionOutcome, serializeOrchestratorDecisionArguments } from "../src/orchestration/pipeline/timeline.js";
import { ORCHESTRATOR_TOOL_NAME } from "../src/orchestration/tools.js";
import { ContextMessage } from "../src/orchestration/context.js";

const msg = (id: string, ts: string, content: string): ContextMessage => ({
  id, channelId: "c", authorKind: "user", authorId: "u", name: "ann", displayName: "Ann",
  content, timestamp: ts, reactions: []
});

const decision = {
  id: "d1",
  action: "no_reply" as const,
  respondingWaifus: [],
  retriggerAfterSeconds: 600,
  reasoning: "quiet hours, nothing to add — waiting for the humans to come back with something new",
  status: "completed" as const,
  waifuMessageIds: [],
  responderOutcomes: [],
  createdAt: "2026-06-12T10:05:00.000Z"
};

describe("buildOrchestratorChatMessages", () => {
  it("renders messages as user turns, decisions as assistant toolCall + tool result", () => {
    const out = buildOrchestratorChatMessages({
      systemPrompt: "ORCH",
      trailingPrompt: "DECIDE",
      messages: [msg("m1", "2026-06-12T10:00:00.000Z", "hi"), msg("m2", "2026-06-12T10:30:00.000Z", "still here")],
      pastDecisions: [decision],
      decisionMarkers: []
    });

    expect(out[0]).toEqual({ role: "system", content: "ORCH" });
    const assistant = out.find((m) => m.role === "assistant" && Array.isArray(m.content));
    expect(assistant).toBeDefined();
    const call = (assistant!.content as Array<{ type: string; id: string; name: string; arguments: string }>)[0]!;
    expect(call.type).toBe("toolCall");
    expect(call.name).toBe(ORCHESTRATOR_TOOL_NAME);
    expect(JSON.parse(call.arguments)).toEqual(serializeOrchestratorDecisionArguments(decision));
    const idx = out.indexOf(assistant!);
    expect(out[idx + 1]).toEqual({ role: "tool", toolCallId: call.id, content: formatDecisionOutcome(decision) });
    expect(out[out.length - 1]).toEqual({ role: "user", content: "DECIDE" });
  });

  it("keeps gap notes and wake markers as user text in chronological order", () => {
    const out = buildOrchestratorChatMessages({
      systemPrompt: "ORCH",
      messages: [msg("m1", "2026-06-12T10:00:00.000Z", "hi"), msg("m2", "2026-06-12T11:00:00.000Z", "back")],
      pastDecisions: [],
      decisionMarkers: [{ kind: "wake", timestamp: "2026-06-12T10:40:00.000Z", scheduledSeconds: 600, wakePlan: "check on Ann" }]
    });
    const texts = out.filter((m) => m.role === "user").map((m) => m.content as string);
    const wakeIndex = texts.findIndex((t) => t.includes("check on Ann"));
    expect(wakeIndex).toBeGreaterThanOrEqual(0);
    // a ≥15-minute gap note exists somewhere between the two messages
    expect(texts.some((t) => /\bgap\b|\bpass(ed)?\b|\bminutes?\b|\bm pass\b/i.test(t))).toBe(true);
  });
});

import { formatAge } from "../src/orchestration/context.js";

describe("orchestrator time awareness", () => {
  it("formatAge renders compact relative ages", () => {
    const now = new Date("2026-07-05T22:49:00.000Z");
    expect(formatAge("2026-07-05T22:48:13.000Z", now)).toBe("47s");
    expect(formatAge("2026-07-05T22:47:00.000Z", now)).toBe("2m");
    expect(formatAge("2026-07-05T19:49:00.000Z", now)).toBe("3h");
    expect(formatAge("2026-07-03T22:49:00.000Z", now)).toBe("2d");
  });

  it("message blocks carry an age tag and the timeline ends with a now anchor", () => {
    const now = new Date("2026-07-05T22:49:00.000Z");
    const chat = buildOrchestratorChatMessages({
      messages: [
        {
          id: "m1",
          channelId: "c",
          authorId: "u1",
          authorKind: "user",
          displayName: "K",
          content: "feet pics?",
          timestamp: "2026-07-05T22:47:00.000Z"
        } as never
      ],
      now
    });
    const userMessages = chat.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(userMessages.some((c) => c.includes("[2m] K: feet pics?"))).toBe(true);
    expect(userMessages[userMessages.length - 1]).toContain("now: 2026-07-05T22:49:00Z");
  });
});
