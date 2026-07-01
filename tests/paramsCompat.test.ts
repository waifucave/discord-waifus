// tests/paramsCompat.test.ts
import { describe, expect, it } from "vitest";
import { legacyToParams, paramsToLegacy } from "../src/shared/paramsCompat.js";

describe("legacyToParams", () => {
  it("maps generation fields to their dotted-equivalent (flat) keys", () => {
    expect(
      legacyToParams({
        generation: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 }
      })
    ).toEqual({
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 2048
    });
  });

  it("maps reasoning.{enabled,effort,budgetTokens} to dotted keys", () => {
    expect(
      legacyToParams({
        reasoning: { enabled: true, effort: "high", budgetTokens: 2000 }
      })
    ).toEqual({
      "reasoning.enabled": true,
      "reasoning.effort": "high",
      "reasoning.budgetTokens": 2000
    });
  });

  it("maps effort 'none' to ONLY reasoning.enabled: false, dropping effort/budgetTokens", () => {
    expect(
      legacyToParams({
        reasoning: { effort: "none", enabled: true, budgetTokens: 5000 }
      })
    ).toEqual({ "reasoning.enabled": false });
  });

  it("returns {} for empty/undefined input", () => {
    expect(legacyToParams({})).toEqual({});
    expect(legacyToParams({ reasoning: {}, generation: {} })).toEqual({});
  });

  it("combines generation and reasoning fields together", () => {
    expect(
      legacyToParams({
        generation: { temperature: 0.5 },
        reasoning: { enabled: false }
      })
    ).toEqual({
      temperature: 0.5,
      "reasoning.enabled": false
    });
  });

  it("omits unset fields individually rather than defaulting them", () => {
    expect(legacyToParams({ generation: { temperature: 0.3 } })).toEqual({ temperature: 0.3 });
    expect(legacyToParams({ reasoning: { effort: "medium" } })).toEqual({ "reasoning.effort": "medium" });
  });
});

describe("paramsToLegacy", () => {
  it("round-trips generation fields", () => {
    expect(
      paramsToLegacy({ temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 })
    ).toEqual({
      reasoning: {},
      generation: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 }
    });
  });

  it("round-trips reasoning dotted keys", () => {
    expect(
      paramsToLegacy({
        "reasoning.enabled": true,
        "reasoning.effort": "high",
        "reasoning.budgetTokens": 2000
      })
    ).toEqual({
      reasoning: { enabled: true, effort: "high", budgetTokens: 2000 },
      generation: {}
    });
  });

  it("round-trips the effort:'none' special case (reasoning.enabled: false alone)", () => {
    expect(paramsToLegacy({ "reasoning.enabled": false })).toEqual({
      reasoning: { enabled: false },
      generation: {}
    });
  });

  it("ignores unknown keys (stopSequences, arbitrary garbage)", () => {
    expect(
      paramsToLegacy({
        stopSequences: ["\nA:", "\nB:"],
        someRandomGarbageKey: "whatever",
        temperature: 0.4
      })
    ).toEqual({
      reasoning: {},
      generation: { temperature: 0.4 }
    });
  });

  it("returns empty reasoning/generation objects for empty input", () => {
    expect(paramsToLegacy({})).toEqual({ reasoning: {}, generation: {} });
  });

  it("skips type-mismatched values instead of passing them through", () => {
    expect(
      paramsToLegacy({
        temperature: "0.7", // wrong type: should be number
        topP: 0.9,
        maxOutputTokens: "2048", // wrong type
        "reasoning.enabled": "true", // wrong type: should be boolean
        "reasoning.effort": 5, // wrong type: should be string
        "reasoning.budgetTokens": "2000" // wrong type: should be number
      })
    ).toEqual({
      reasoning: {},
      generation: { topP: 0.9 }
    });
  });

  it("full round trip: legacyToParams -> paramsToLegacy reconstructs the original shape", () => {
    const original = {
      generation: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 },
      reasoning: { enabled: true, effort: "high", budgetTokens: 2000 }
    };
    expect(paramsToLegacy(legacyToParams(original))).toEqual(original);
  });
});
