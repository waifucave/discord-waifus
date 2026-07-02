import { describe, expect, it } from "vitest";
import { createGatewayHandler, type ParamDescriptor, type ResolvedModel } from "@waifucave/gateway";
import type { LlmModelSummary, LlmValidationViolation } from "../src/frontend/api/llm";
import {
  addTag,
  buildParamControls,
  clampToDescriptor,
  defaultRoute,
  findRoute,
  groupModelRoutes,
  paramLabel,
  violationsByParam,
  type RouteGroup
} from "../src/frontend/components/modelParams/logic.js";

function summary(overrides: Partial<LlmModelSummary> & Pick<LlmModelSummary, "providerId" | "modelId">): LlmModelSummary {
  return {
    family: "family",
    displayName: "Display Name",
    company: "Company",
    wire: "openai-chat",
    streaming: true,
    tools: true,
    reasoning: false,
    jsonMode: false,
    jsonSchema: false,
    imageInput: false,
    deprecated: false,
    confidence: "verified",
    ...overrides
  };
}

describe("buildParamControls", () => {
  const doc: Pick<ResolvedModel, "params"> = {
    params: {
      temperature: { type: "number", min: 0, max: 2, default: 1 },
      topP: { type: "number", min: 0, max: 1, default: 1 },
      stopSequences: { type: "string[]", maxItems: 4 },
      topK: { type: "int", min: 0, max: 100, confidence: "unverified" },
      "reasoning.enabled": { type: "boolean", default: false },
      "reasoning.effort": { type: "enum", values: ["low", "medium", "high"] },
      "reasoning.exclude": { type: "boolean", default: false }
    }
  };

  it("orders sampling params first (named priority, then alphabetical), then reasoning (enabled first, then alphabetical)", () => {
    const controls = buildParamControls(doc);
    expect(controls.map((c) => c.key)).toEqual([
      "temperature",
      "topP",
      "stopSequences",
      "topK",
      "reasoning.enabled",
      "reasoning.effort",
      "reasoning.exclude"
    ]);
  });

  it("groups sampling params as 'sampling' and reasoning.* params as 'reasoning'", () => {
    const controls = buildParamControls(doc);
    const byKey = new Map(controls.map((c) => [c.key, c]));
    expect(byKey.get("temperature")?.group).toBe("sampling");
    expect(byKey.get("topP")?.group).toBe("sampling");
    expect(byKey.get("stopSequences")?.group).toBe("sampling");
    expect(byKey.get("topK")?.group).toBe("sampling");
    expect(byKey.get("reasoning.enabled")?.group).toBe("reasoning");
    expect(byKey.get("reasoning.effort")?.group).toBe("reasoning");
    expect(byKey.get("reasoning.exclude")?.group).toBe("reasoning");
  });

  it("flags only the unverified descriptor cell", () => {
    const controls = buildParamControls(doc);
    const byKey = new Map(controls.map((c) => [c.key, c]));
    expect(byKey.get("topK")?.unverified).toBe(true);
    expect(byKey.get("temperature")?.unverified).toBe(false);
    expect(byKey.get("topP")?.unverified).toBe(false);
    expect(byKey.get("stopSequences")?.unverified).toBe(false);
    expect(byKey.get("reasoning.enabled")?.unverified).toBe(false);
    expect(byKey.get("reasoning.effort")?.unverified).toBe(false);
    expect(byKey.get("reasoning.exclude")?.unverified).toBe(false);
  });

  it("classifies dotted, non-reasoning params as 'other', ordered alphabetically after reasoning", () => {
    const otherDoc: Pick<ResolvedModel, "params"> = {
      params: {
        temperature: { type: "number", min: 0, max: 2 },
        "reasoning.enabled": { type: "boolean" },
        "minimax.reasoningSplit": { type: "boolean" },
        "google.safetySettings": { type: "map" }
      }
    };
    const controls = buildParamControls(otherDoc);
    expect(controls.map((c) => c.key)).toEqual([
      "temperature",
      "reasoning.enabled",
      "google.safetySettings",
      "minimax.reasoningSplit"
    ]);
    expect(controls.find((c) => c.key === "google.safetySettings")?.group).toBe("other");
    expect(controls.find((c) => c.key === "minimax.reasoningSplit")?.group).toBe("other");
  });

  it("excludes responseFormat by key, even though its descriptor.type is 'enum' (moonshot shape) not 'map'", () => {
    // AMENDED Global Constraint: no responseFormat/structured-output control anywhere (anthropic
    // codec gap, out of P5 scope). Type-based skipping alone wouldn't catch this — moonshot's
    // responseFormat descriptor is type:"enum", identical in shape to a legitimately-renderable
    // enum param — so the exclusion must be keyed on the param name specifically.
    const docWithResponseFormat: Pick<ResolvedModel, "params"> = {
      params: {
        temperature: { type: "number", min: 0, max: 2 },
        responseFormat: { type: "enum", values: ["text", "json_object", "json_schema"], default: "text" }
      }
    };
    const controls = buildParamControls(docWithResponseFormat);
    expect(controls.map((c) => c.key)).toEqual(["temperature"]);
    expect(controls.some((c) => c.key === "responseFormat")).toBe(false);
  });

  it("excludes responseFormat from a real moonshot registry doc", () => {
    const handler = createGatewayHandler({});
    const doc = handler.gateway.getCapabilities("moonshot", "kimi-k2.5");
    expect(doc).toBeDefined();
    // Confirms the real descriptor shape this exclusion has to defeat (pins the AMENDED rationale).
    expect(doc!.params.responseFormat?.type).toBe("enum");
    const controls = buildParamControls(doc!);
    expect(controls.some((c) => c.key === "responseFormat")).toBe(false);
  });
});

describe("violationsByParam", () => {
  it("prefers violation.message when present", () => {
    const violations: LlmValidationViolation[] = [
      { param: "temperature", code: "out_of_range", message: "must be between 0 and 2" }
    ];
    expect(violationsByParam(violations)).toEqual({ temperature: "must be between 0 and 2" });
  });

  it("falls back to `${code} (rule ${ruleId})` when message is absent but ruleId is present", () => {
    const violations: LlmValidationViolation[] = [{ param: "topP", code: "forbidden_param", ruleId: "r1" }];
    expect(violationsByParam(violations)).toEqual({ topP: "forbidden_param (rule r1)" });
  });

  it("falls back to just the code when neither message nor ruleId is present", () => {
    const violations: LlmValidationViolation[] = [{ param: "stopSequences", code: "unknown_param" }];
    expect(violationsByParam(violations)).toEqual({ stopSequences: "unknown_param" });
  });
});

describe("groupModelRoutes", () => {
  const models: LlmModelSummary[] = [
    summary({
      providerId: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      family: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      company: "Anthropic"
    }),
    summary({
      providerId: "openrouter",
      modelId: "anthropic/claude-haiku-4.5",
      family: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      company: "Anthropic"
    }),
    summary({
      providerId: "openai",
      modelId: "gpt-5-legacy",
      family: "gpt-5-legacy",
      displayName: "GPT-5 Legacy",
      company: "OpenAI",
      deprecated: true
    }),
    summary({
      providerId: "openai",
      modelId: "gpt-5.2",
      family: "gpt-5-2",
      displayName: "GPT-5.2",
      company: "OpenAI"
    })
  ];

  it("merges native+openrouter routes of the same company|displayName into one group", () => {
    const groups = groupModelRoutes(models);
    const anthropicGroup = groups.find((g) => g.key === "Anthropic|Claude Haiku 4.5");
    expect(anthropicGroup?.routes.map((r) => r.providerId)).toEqual(["anthropic", "openrouter"]);
  });

  it("excludes deprecated entries entirely", () => {
    const groups = groupModelRoutes(models);
    const all = groups.flatMap((g) => g.routes.map((r) => r.modelId));
    expect(all).not.toContain("gpt-5-legacy");
    const openAiGroup = groups.find((g) => g.key === "OpenAI|GPT-5.2");
    expect(openAiGroup?.routes.map((r) => r.modelId)).toEqual(["gpt-5.2"]);
  });

  it("orders openrouter routes last within a group", () => {
    const groups = groupModelRoutes(models);
    const anthropicGroup = groups.find((g) => g.key === "Anthropic|Claude Haiku 4.5")!;
    expect(anthropicGroup.routes.at(-1)?.providerId).toBe("openrouter");
  });

  it("sorts groups by company then displayName", () => {
    const groups = groupModelRoutes(models);
    expect(groups.map((g) => g.key)).toEqual(["Anthropic|Claude Haiku 4.5", "OpenAI|GPT-5.2"]);
  });
});

describe("defaultRoute", () => {
  it("returns the first non-openrouter route whose provider is configured", () => {
    const group: RouteGroup = {
      key: "Anthropic|Claude Haiku 4.5",
      company: "Anthropic",
      displayName: "Claude Haiku 4.5",
      routes: [
        summary({ providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" }),
        summary({ providerId: "openrouter", modelId: "anthropic/claude-haiku-4.5" })
      ]
    };
    expect(defaultRoute(group, new Set(["anthropic"]))?.providerId).toBe("anthropic");
  });

  it("falls back to the openrouter route when it is configured but the native one is not", () => {
    const group: RouteGroup = {
      key: "DeepSeek|DeepSeek V4",
      company: "DeepSeek",
      displayName: "DeepSeek V4",
      routes: [
        summary({ providerId: "deepseek", modelId: "deepseek-v4" }),
        summary({ providerId: "openrouter", modelId: "deepseek/deepseek-v4" })
      ]
    };
    expect(defaultRoute(group, new Set(["openrouter"]))?.providerId).toBe("openrouter");
  });

  it("falls back to the first route when nothing is configured", () => {
    const group: RouteGroup = {
      key: "XAI|Grok 4.3",
      company: "XAI",
      displayName: "Grok 4.3",
      routes: [summary({ providerId: "xai", modelId: "grok-4.3" })]
    };
    expect(defaultRoute(group, new Set())?.providerId).toBe("xai");
  });
});

describe("findRoute", () => {
  const models: LlmModelSummary[] = [
    summary({
      providerId: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      family: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      company: "Anthropic"
    }),
    summary({
      providerId: "openrouter",
      modelId: "anthropic/claude-haiku-4.5",
      family: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      company: "Anthropic"
    }),
    summary({
      providerId: "openai",
      modelId: "gpt-5-legacy",
      family: "gpt-5-legacy",
      displayName: "GPT-5 Legacy",
      company: "OpenAI",
      deprecated: true
    })
  ];

  it("resolves a stored native pair back to its group", () => {
    const found = findRoute(models, "anthropic", "claude-haiku-4-5-20251001");
    expect(found?.group.key).toBe("Anthropic|Claude Haiku 4.5");
    expect(found?.route.providerId).toBe("anthropic");
  });

  it("resolves a stored openrouter pair back to its group", () => {
    const found = findRoute(models, "openrouter", "anthropic/claude-haiku-4.5");
    expect(found?.group.key).toBe("Anthropic|Claude Haiku 4.5");
    expect(found?.route.providerId).toBe("openrouter");
  });

  it("returns undefined for an unknown pair", () => {
    expect(findRoute(models, "openai", "gpt-nonexistent")).toBeUndefined();
  });

  it("returns undefined for a stored pair that is now deprecated (excluded from groups)", () => {
    expect(findRoute(models, "openai", "gpt-5-legacy")).toBeUndefined();
  });
});

describe("real registry fixture (pins the actual descriptor shape)", () => {
  const handler = createGatewayHandler({});

  it("buildParamControls does not throw and produces non-empty, sensible output for a real native model", () => {
    const doc = handler.gateway.getCapabilities("anthropic", "claude-haiku-4-5-20251001");
    expect(doc).toBeDefined();
    const controls = buildParamControls(doc!);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(["sampling", "reasoning", "other"]).toContain(control.group);
      expect(typeof control.descriptor.type).toBe("string");
    }
    expect(controls.some((c) => c.key === "temperature")).toBe(true);
  });

  it("groupModelRoutes does not throw and produces non-empty, sensible output for the real registry (incl. an openrouter route)", async () => {
    const res = await handler.handle(new Request("http://gateway.internal/v1/models"));
    expect(res.status).toBe(200);
    const { models } = (await res.json()) as { models: LlmModelSummary[] };
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.providerId === "openrouter")).toBe(true);

    const groups = groupModelRoutes(models);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.routes.length).toBeGreaterThan(0);
      expect(group.routes.every((r) => !r.deprecated)).toBe(true);
    }

    const openrouterRoute = models.find((m) => m.providerId === "openrouter" && !m.deprecated);
    expect(openrouterRoute).toBeDefined();
    const doc = handler.gateway.getCapabilities(openrouterRoute!.providerId, openrouterRoute!.modelId);
    expect(doc).toBeDefined();
    const controls = buildParamControls(doc!);
    expect(controls.length).toBeGreaterThan(0);
  });
});

describe("clampToDescriptor", () => {
  const numberDescriptor: Pick<ParamDescriptor, "type" | "min" | "max"> = { type: "number", min: 0, max: 2 };
  const intDescriptor: Pick<ParamDescriptor, "type" | "min" | "max"> = { type: "int", min: 0, max: 100 };

  it("parses a numeric string within bounds unchanged", () => {
    expect(clampToDescriptor(numberDescriptor, "1.5")).toBe(1.5);
  });

  it("accepts a raw number directly", () => {
    expect(clampToDescriptor(numberDescriptor, 1.5)).toBe(1.5);
  });

  it("clamps below min up to min", () => {
    expect(clampToDescriptor(numberDescriptor, "-3")).toBe(0);
  });

  it("clamps above max down to max", () => {
    expect(clampToDescriptor(numberDescriptor, "9")).toBe(2);
  });

  it("rounds to the nearest integer for type 'int'", () => {
    expect(clampToDescriptor(intDescriptor, "42.6")).toBe(43);
    expect(clampToDescriptor(intDescriptor, "42.4")).toBe(42);
  });

  it("clamps an out-of-range int after rounding", () => {
    expect(clampToDescriptor(intDescriptor, "150")).toBe(100);
    expect(clampToDescriptor(intDescriptor, "-1")).toBe(0);
  });

  it("returns undefined for an empty string (caller clears the key)", () => {
    expect(clampToDescriptor(numberDescriptor, "")).toBeUndefined();
    expect(clampToDescriptor(numberDescriptor, "   ")).toBeUndefined();
  });

  it("returns undefined for a non-numeric string", () => {
    expect(clampToDescriptor(numberDescriptor, "not-a-number")).toBeUndefined();
  });

  it("only clamps the bound that is actually present on the descriptor", () => {
    expect(clampToDescriptor({ type: "number", min: 0 }, "-5")).toBe(0);
    expect(clampToDescriptor({ type: "number", min: 0 }, "999")).toBe(999);
    expect(clampToDescriptor({ type: "number", max: 10 }, "999")).toBe(10);
  });
});

describe("addTag", () => {
  it("appends a trimmed, non-empty tag", () => {
    expect(addTag(["a"], "  b  ")).toEqual(["a", "b"]);
  });

  it("returns the same list reference when raw is blank or whitespace-only", () => {
    const list = ["a"];
    expect(addTag(list, "")).toBe(list);
    expect(addTag(list, "   ")).toBe(list);
  });

  it("returns the same list reference when the tag already exists (no duplicates)", () => {
    const list = ["a", "b"];
    expect(addTag(list, "a")).toBe(list);
  });

  it("refuses to add once maxItems is reached, returning the same list reference", () => {
    const list = ["a", "b"];
    expect(addTag(list, "c", 2)).toBe(list);
  });

  it("adds up to and including maxItems", () => {
    expect(addTag(["a"], "b", 2)).toEqual(["a", "b"]);
  });

  it("is unlimited when maxItems is not given", () => {
    const list = ["a", "b", "c", "d", "e"];
    expect(addTag(list, "f")).toEqual([...list, "f"]);
  });
});

describe("paramLabel", () => {
  it("title-cases a simple key", () => {
    expect(paramLabel("temperature")).toBe("Temperature");
  });

  it("splits camelCase into spaced Title Case", () => {
    expect(paramLabel("maxOutputTokens")).toBe("Max Output Tokens");
  });

  it("drops the dotted namespace prefix, since the section header already names it", () => {
    expect(paramLabel("reasoning.enabled")).toBe("Enabled");
    expect(paramLabel("reasoning.budgetTokens")).toBe("Budget Tokens");
  });

  it("uses the leaf segment for vendor-namespaced 'other' params too", () => {
    expect(paramLabel("google.safetySettings")).toBe("Safety Settings");
  });
});
