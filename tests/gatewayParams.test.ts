// tests/gatewayParams.test.ts
import { describe, expect, it } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { buildUnifiedParams, preconformRequest } from "../src/orchestration/pipeline/params.js";

const gateway = createGateway({});

describe("buildUnifiedParams", () => {
  it("maps generation + reasoning config to dotted gateway params", () => {
    expect(
      buildUnifiedParams({
        temperature: 0.7, topP: 0.9, maxOutputTokens: 2048,
        reasoning: { enabled: true, effort: "high", budgetTokens: 2000 },
        stopSequences: ["\nA:", "\nB:"]
      })
    ).toEqual({
      temperature: 0.7, topP: 0.9, maxOutputTokens: 2048,
      "reasoning.enabled": true, "reasoning.effort": "high", "reasoning.budgetTokens": 2000,
      stopSequences: ["\nA:", "\nB:"]
    });
  });

  it("omits unset fields and maps effort 'none' to enabled:false", () => {
    expect(buildUnifiedParams({ reasoning: { effort: "none" } })).toEqual({ "reasoning.enabled": false });
    expect(buildUnifiedParams({})).toEqual({});
  });
});

describe("preconformRequest", () => {
  it("resolves forced-tool×thinking conflicts by disabling reasoning (deepseek, thinking default ON)", () => {
    const out = preconformRequest(gateway, "deepseek", "deepseek-v4-pro", {
      params: {}, toolChoice: { name: "orchestrator_decision" }
    });
    expect(out.params["reasoning.enabled"]).toBe(false);
    expect(out.toolChoice).toEqual({ name: "orchestrator_decision" });
    expect(gateway.validate("deepseek", "deepseek-v4-pro", { params: out.params, toolChoice: "named" }).ok).toBe(true);
  });

  it("drops violating optional params instead of failing (unsupported keys on gpt-5.5)", () => {
    const out = preconformRequest(gateway, "openai", "gpt-5.5", {
      params: { temperature: 0.7, topP: 0.9, maxOutputTokens: 512 }
    });
    expect(out.params).toEqual({ maxOutputTokens: 512 });
    expect(out.dropped.map((d) => d.param).sort()).toEqual(["temperature", "topP"]);
  });

  it("truncates stopSequences to the model's maxItems (gemini caps at 5)", () => {
    const out = preconformRequest(gateway, "google-ai-studio", "gemini-2.5-flash", {
      params: { stopSequences: ["a", "b", "c", "d", "e", "f", "g"] }
    });
    expect(out.params.stopSequences).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("throws GatewayPipelineError for an unknown model", () => {
    expect(() => preconformRequest(gateway, "deepseek", "nope", { params: {} })).toThrow(/Unknown model/);
  });

  it("throws cleanly when forced tools are unsupported outright (no reasoning remedy available)", () => {
    // gemini-2.5-pro keeps toolChoice [auto, none] and has no reasoning.enabled
    // param — the reasoning remedy must NOT be attempted and the loop must not churn.
    expect(() =>
      preconformRequest(gateway, "google-ai-studio", "gemini-2.5-pro", { params: {}, toolChoice: "required" })
    ).toThrow(/unsupported_tool_choice/);
  });

  it("drops a bad reasoning effort enum value instead of failing", () => {
    const out = preconformRequest(gateway, "openai", "gpt-5.5", {
      params: { "reasoning.effort": "definitely-not-an-effort" }
    });
    expect(out.params["reasoning.effort"]).toBeUndefined();
    expect(out.dropped.some((d) => d.param === "reasoning.effort" && d.reason === "bad_enum")).toBe(true);
  });
});
