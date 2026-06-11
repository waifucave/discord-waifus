import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_GOAL_MAX_CHARS,
  MODEL_DIRECTIVE_INTENTS,
  OrchestratorDecisionSchema,
  RespondingWaifuSchema,
  WAKE_PLAN_MAX_CHARS
} from "../src/orchestration/decisions.js";

describe("RespondingWaifuSchema", () => {
  it("defaults delaySeconds to 0 and accepts a directive", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "break_loop", goal: "land a brand-new topic" }
    });
    expect(parsed.delaySeconds).toBe(0);
    expect(parsed.directive).toEqual({ intent: "break_loop", goal: "land a brand-new topic" });
  });

  it("degrades a malformed directive to undefined instead of failing", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "break_loop" } // missing goal
    });
    expect(parsed.directive).toBeUndefined();
  });

  it("accepts an over-cap goal (cap is a runtime guardrail, not a parse rule)", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "spotlight", goal: "x".repeat(DIRECTIVE_GOAL_MAX_CHARS + 50) }
    });
    expect(parsed.directive?.goal.length).toBe(DIRECTIVE_GOAL_MAX_CHARS + 50);
  });

  it("excludes manual from the model-facing intent list", () => {
    expect(MODEL_DIRECTIVE_INTENTS).not.toContain("manual");
  });

  it("degrades an unknown intent to undefined instead of failing", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "breek_loop", goal: "valid goal" }
    });
    expect(parsed.directive).toBeUndefined();
  });

  it("degrades a whitespace-only goal to undefined", () => {
    const parsed = RespondingWaifuSchema.parse({
      waifuId: "aria",
      directive: { intent: "break_loop", goal: "   " }
    });
    expect(parsed.directive).toBeUndefined();
  });
});

describe("OrchestratorDecisionSchema", () => {
  it("clips wakePlan instead of rejecting it", () => {
    const parsed = OrchestratorDecisionSchema.parse({
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 600,
      wakePlan: "y".repeat(WAKE_PLAN_MAX_CHARS + 100),
      reasoning: "quiet room"
    });
    expect(parsed.wakePlan?.length).toBe(WAKE_PLAN_MAX_CHARS);
  });

  it("still enforces the reply/no_reply shape rules", () => {
    expect(() =>
      OrchestratorDecisionSchema.parse({
        action: "reply",
        respondingWaifus: [],
        reasoning: "broken"
      })
    ).toThrow();
  });

  it("maps a whitespace-only wakePlan to undefined", () => {
    const parsed = OrchestratorDecisionSchema.parse({
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 600,
      wakePlan: "   ",
      reasoning: "quiet room"
    });
    expect(parsed.wakePlan).toBeUndefined();
  });
});
