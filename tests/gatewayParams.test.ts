// tests/gatewayParams.test.ts
import { describe, expect, it } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { buildUnifiedParams, preconformRequest } from "../src/orchestration/pipeline/params.js";

const gateway = createGateway({});

describe("buildUnifiedParams", () => {
  it("maps explicit per-call fields to dotted gateway params", () => {
    expect(
      buildUnifiedParams({
        temperature: 0.7, topP: 0.9, maxOutputTokens: 2048,
        stopSequences: ["\nA:", "\nB:"]
      })
    ).toEqual({
      temperature: 0.7, topP: 0.9, maxOutputTokens: 2048,
      stopSequences: ["\nA:", "\nB:"]
    });
  });

  it("omits unset fields", () => {
    expect(buildUnifiedParams({})).toEqual({});
  });

  // Pinned precedence: config-sourced inputs.params WINS over the explicit per-call
  // role-default fields (temperature here is both a role default AND a config override).
  it("config params (inputs.params) override per-call role defaults", () => {
    expect(
      buildUnifiedParams({ temperature: 0.2, params: { temperature: 0.9, "reasoning.enabled": false } })
    ).toEqual({ temperature: 0.9, "reasoning.enabled": false });
  });

  it("merges config params alongside untouched per-call fields", () => {
    expect(
      buildUnifiedParams({ temperature: 0.2, maxOutputTokens: 512, params: { "reasoning.effort": "high" } })
    ).toEqual({ temperature: 0.2, maxOutputTokens: 512, "reasoning.effort": "high" });
  });
});

describe("preconformRequest", () => {
  it("resolves forced-tool×thinking conflicts by disabling reasoning (anthropic, live 400 on Beta 2026-07-03)", () => {
    // The stage-manager shape: haiku with reasoning.enabled stored, observer call forces its tool.
    const out = preconformRequest(gateway, "anthropic", "claude-haiku-4-5-20251001", {
      params: { "reasoning.enabled": true, "reasoning.budgetTokens": 10240 },
      toolChoice: { name: "record_observations" }
    });
    expect(out.params["reasoning.enabled"]).toBe(false);
    expect(out.params["reasoning.budgetTokens"]).toBeUndefined();
    expect(out.toolChoice).toEqual({ name: "record_observations" });
    expect(
      gateway.validate("anthropic", "claude-haiku-4-5-20251001", { params: out.params, toolChoice: "named" }).ok
    ).toBe(true);
  });

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
