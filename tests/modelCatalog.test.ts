import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { describe, expect, it } from "vitest";
import {
  allowedProviderIds,
  curatedCatalog,
  DEFAULT_ALLOWED_ROUTES,
  DEFAULT_MAX_OUTPUT_USD_PER_MTOK,
  findCuratedModel,
  installedCatalog,
  isContributorRoute,
  openRouterReasoningReplaySupported,
  parseRouteKey,
  routeKey
} from "../src/models/catalog.js";
import { AppConfigSchema, UpdateAppConfigBodySchema } from "../src/shared/schemas/config.js";

function cloneCatalog(): WinterCatalog {
  return structuredClone(installedCatalog());
}

function row(catalog: WinterCatalog, key: string) {
  const found = catalog.models.find((model) => model.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

describe("route keys", () => {
  it("split at the first slash, so OpenRouter model ids keep theirs", () => {
    expect(parseRouteKey("anthropic/claude-sonnet-5-5")).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(parseRouteKey("openrouter/openai/gpt-6-luna")).toEqual({ providerId: "openrouter", modelId: "openai/gpt-6-luna" });
    expect(parseRouteKey("nope")).toBeUndefined();
    expect(parseRouteKey("/x")).toBeUndefined();
    expect(parseRouteKey("x/")).toBeUndefined();
    expect(routeKey({ providerId: "openrouter", modelId: "openai/gpt-6-luna" })).toBe("openrouter/openai/gpt-6-luna");
  });
});

describe("curated catalog over the installed winter 0.0.55 catalog (spec §9.2)", () => {
  const curated = curatedCatalog();

  it("offers the direct routes the catalog carries, in allow-list order", () => {
    expect(curated.catalogVersion).toBe(installedCatalog().catalogVersion);
    expect(curated.models.map((model) => model.id)).toEqual([
      "meta/muse-spark-1.3-contributor",
      "anthropic/claude-sonnet-5-5",
      "deepseek/deepseek-flash",
      "openai/gpt-6-luna",
      "openai/gpt-6.1-sol"
    ]);
  });

  it("hides routes the installed catalog lacks (W2) and OpenRouter routes until W7", () => {
    const hidden = Object.fromEntries(curated.hidden.map((entry) => [entry.id, entry.reason]));
    expect(hidden).toEqual({
      "openrouter/meta/muse-spark-1.3-contributor": "not_in_catalog",
      "anthropic/claude-haiku-5-5": "not_in_catalog",
      "openrouter/anthropic/claude-haiku-5.5": "not_in_catalog",
      "openrouter/anthropic/claude-sonnet-5.5": "openrouter_reasoning_replay",
      "openrouter/deepseek/deepseek-v4.1-flash": "openrouter_reasoning_replay",
      "openrouter/openai/gpt-6-luna": "openrouter_reasoning_replay",
      "openrouter/openai/gpt-6.1-sol": "not_in_catalog"
    });
    expect(curated.models.length + curated.hidden.length).toBe(DEFAULT_ALLOWED_ROUTES.length);
  });

  it("describes each route: efforts from the catalog, pricing, image input, contributor label", () => {
    const sonnet = findCuratedModel({ providerId: "anthropic", modelId: "claude-sonnet-5-5" }, curated)!;
    expect(sonnet).toMatchObject({ providerDisplayName: expect.any(String), imageInput: true, contributor: false, defaultEffort: "high" });
    expect(sonnet.efforts).toEqual(row(installedCatalog(), "anthropic/claude-sonnet-5-5").reasoning!.efforts);
    expect(sonnet.pricing?.outputPerMTokUsd).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_USD_PER_MTOK);
    const muse = findCuratedModel({ providerId: "meta", modelId: "muse-spark-1.3-contributor" }, curated)!;
    expect(muse.contributor).toBe(true);
    expect(isContributorRoute({ key: "meta/muse-spark-1.3", upstreamId: "muse-spark-1.3" })).toBe(false);
  });

  it("models.allowed narrows and orders the list; unknown and duplicate entries are tolerated", () => {
    const narrowed = curatedCatalog({ allowed: ["openai/gpt-6-luna", "deepseek/deepseek-flash", "openai/gpt-6-luna", "nobody/nothing"] });
    expect(narrowed.models.map((model) => model.id)).toEqual(["openai/gpt-6-luna", "deepseek/deepseek-flash"]);
    expect(narrowed.hidden).toEqual([{ id: "nobody/nothing", reason: "not_in_catalog" }]);
    expect(allowedProviderIds({ allowed: ["openai/gpt-6-luna", "nobody/nothing"] })).toEqual(["openai"]);
  });

  it("the output price cap hides routes above it", () => {
    const cheap = curatedCatalog({ maxOutputUsdPerMTok: 1 });
    expect(cheap.models.map((model) => model.id)).toEqual(["meta/muse-spark-1.3-contributor", "openai/gpt-6-luna"]);
    expect(cheap.hidden.filter((entry) => entry.reason === "over_price_cap" && !entry.id.startsWith("openrouter/")).map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet-5-5",
      "deepseek/deepseek-flash",
      "openai/gpt-6.1-sol"
    ]);
  });

  it("hides blocked providers, deprecated rows and rows without native tool calling", () => {
    const catalog = cloneCatalog();
    catalog.providers.find((provider) => provider.id === "deepseek")!.risk.class = "blocked";
    row(catalog, "openai/gpt-6-luna").status = "deprecated";
    row(catalog, "openai/gpt-6.1-sol").toolCalling.value = "none" as never;
    const hidden = Object.fromEntries(curatedCatalog({ catalog }).hidden.map((entry) => [entry.id, entry.reason]));
    expect(hidden["deepseek/deepseek-flash"]).toBe("provider_blocked");
    expect(hidden["openai/gpt-6-luna"]).toBe("deprecated");
    expect(hidden["openai/gpt-6.1-sol"]).toBe("no_tool_calling");
  });

  it("an unpriced route stays visible (its cost counts as 0; /api/runtime warns)", () => {
    const catalog = cloneCatalog();
    delete row(catalog, "deepseek/deepseek-flash").pricing;
    const model = findCuratedModel({ providerId: "deepseek", modelId: "deepseek-flash" }, curatedCatalog({ catalog }));
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty("pricing");
  });
});

describe("the W7 feature check (OpenRouter reasoning replay)", () => {
  it("is false for every OpenRouter reasoning row in winter 0.0.55 (continuation none)", () => {
    for (const model of installedCatalog().models.filter((candidate) => candidate.providerId === "openrouter" && candidate.reasoning?.supported.value === true)) {
      expect(openRouterReasoningReplaySupported(model), model.key).toBe(false);
    }
  });

  it("turns an OpenRouter route on once its row carries a continuation (as W7 ships it)", () => {
    const catalog = cloneCatalog();
    const sonnet = row(catalog, "openrouter/anthropic/claude-sonnet-5.5");
    sonnet.reasoning = { ...sonnet.reasoning!, continuation: "native-state" as never };
    expect(openRouterReasoningReplaySupported(sonnet)).toBe(true);
    expect(curatedCatalog({ catalog }).models.map((model) => model.id)).toContain("openrouter/anthropic/claude-sonnet-5.5");
  });

  it("a route without reasoning has nothing to replay", () => {
    const catalog = cloneCatalog();
    const luna = row(catalog, "openrouter/openai/gpt-6-luna");
    luna.reasoning = { ...luna.reasoning!, supported: { ...luna.reasoning!.supported, value: false } };
    expect(openRouterReasoningReplaySupported(luna)).toBe(true);
  });
});

describe("models config (config.toml [models])", () => {
  it("defaults to the spec's allow-list and $10 cap, and validates writes", () => {
    const config = AppConfigSchema.parse({});
    expect(config.models).toEqual({ allowed: [...DEFAULT_ALLOWED_ROUTES], maxOutputUsdPerMTok: 10 });
    expect(UpdateAppConfigBodySchema.parse({ models: { maxOutputUsdPerMTok: 5 } })).toEqual({ models: { maxOutputUsdPerMTok: 5 } });
    expect(() => UpdateAppConfigBodySchema.parse({ models: { allowed: ["no-slash"] } })).toThrow();
    expect(() => UpdateAppConfigBodySchema.parse({ models: { maxOutputUsdPerMTok: 0 } })).toThrow();
  });
});
