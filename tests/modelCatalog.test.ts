import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { describe, expect, it } from "vitest";
import { FAMILY_ROUTES } from "../src/backend/migrationSteps/livingCastModels.js";
import {
  allowedProviderIds,
  CURATED_FAMILY_ROUTES,
  curatedCatalog,
  isPricedRoute,
  openRouterRouteOffered,
  DEFAULT_ALLOWED_ROUTES,
  DEFAULT_MAX_OUTPUT_USD_PER_MTOK,
  explicitCacheTtlMs,
  findCuratedModel,
  PROMPT_CACHE_TTL_MS,
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

describe("curated catalog over the installed winter 0.0.56 catalog (spec §9.2)", () => {
  const curated = curatedCatalog();

  it("offers every allowed route, direct and through OpenRouter, in allow-list order (W2 rows, W7 continuation)", () => {
    expect(curated.catalogVersion).toBe(installedCatalog().catalogVersion);
    expect(curated.models.map((model) => model.id)).toEqual([...DEFAULT_ALLOWED_ROUTES]);
    expect(curated.hidden).toEqual([]);
  });

  it("applies our own output cap where a row names none (W2: the direct Muse Spark contributor row)", () => {
    expect(findCuratedModel({ providerId: "meta", modelId: "muse-spark-1.3-contributor" }, curated)).not.toHaveProperty("maxOutputTokens");
    expect(findCuratedModel({ providerId: "openrouter", modelId: "meta/muse-spark-1.3-contributor" }, curated)?.maxOutputTokens).toBeGreaterThan(0);
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
    expect(cheap.models.map((model) => model.id)).toEqual([
      "meta/muse-spark-1.3-contributor",
      "openrouter/meta/muse-spark-1.3-contributor",
      "anthropic/claude-haiku-5-5",
      "openrouter/anthropic/claude-haiku-5.5",
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openai/gpt-6-luna",
      "openrouter/openai/gpt-6-luna"
    ]);
    expect(cheap.hidden).toEqual(
      ["anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "deepseek/deepseek-flash", "openai/gpt-6.1-sol", "openrouter/openai/gpt-6.1-sol"].map(
        (id) => ({ id, reason: "over_price_cap" })
      )
    );
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

  it("decides priced-ness once: only official-doc prices count, everywhere", () => {
    const catalog = cloneCatalog();
    const flash = row(catalog, "deepseek/deepseek-flash");
    expect(isPricedRoute(flash)).toBe(true);
    flash.pricing = { ...flash.pricing!, source: "community" as never };
    expect(isPricedRoute(flash)).toBe(false);
    const model = findCuratedModel({ providerId: "deepseek", modelId: "deepseek-flash" }, curatedCatalog({ catalog }));
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty("pricing");
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
  it("winter replays reasoning on every curated OpenRouter row that needs it, and every curated route is offered", () => {
    const catalog = installedCatalog();
    for (const routes of Object.values(CURATED_FAMILY_ROUTES)) {
      const openrouter = row(catalog, routeKey(routes.openrouter));
      const direct = row(catalog, routeKey(routes.direct));
      const needsReplay = direct.reasoning?.supported.value === true && direct.reasoning.continuation !== "none";
      // A row may replay more than its direct counterpart needs (0.0.62 replays Muse Spark's opaque state).
      if (needsReplay) expect(openRouterReasoningReplaySupported(openrouter), openrouter.key).toBe(true);
      expect(openRouterRouteOffered(openrouter, catalog), openrouter.key).toBe(true);
    }
  });

  it("turns an OpenRouter route on once its row carries a continuation (as W7 ships it)", () => {
    const catalog = cloneCatalog();
    const sonnet = row(catalog, "openrouter/anthropic/claude-sonnet-5.5");
    sonnet.reasoning = { ...sonnet.reasoning!, continuation: "none" };
    expect(curatedCatalog({ catalog }).hidden).toContainEqual({ id: "openrouter/anthropic/claude-sonnet-5.5", reason: "openrouter_reasoning_replay" });
    sonnet.reasoning = { ...sonnet.reasoning!, continuation: "opaque-provider-state" };
    expect(openRouterReasoningReplaySupported(sonnet)).toBe(true);
    expect(curatedCatalog({ catalog }).models.map((model) => model.id)).toContain("openrouter/anthropic/claude-sonnet-5.5");
  });

  it("offers an OpenRouter route whose family has nothing to replay, even with continuation none (Muse Spark)", () => {
    const catalog = cloneCatalog();
    // The OpenRouter Muse contributor row as winter 0.0.56 ships it: reasoning efforts, continuation none.
    const template = row(catalog, "openrouter/anthropic/claude-sonnet-5.5");
    const muse = row(catalog, "meta/muse-spark-1.3-contributor");
    expect(muse.reasoning?.continuation).toBe("none");
    catalog.models = catalog.models.filter((model) => model.key !== "openrouter/meta/muse-spark-1.3-contributor");
    catalog.models.push({
      ...structuredClone(template),
      key: "openrouter/meta/muse-spark-1.3-contributor",
      upstreamId: "meta/muse-spark-1.3-contributor",
      displayName: "Muse Spark 1.3 (contributor) via OpenRouter",
      modelFamily: muse.modelFamily,
      reasoning: { ...template.reasoning!, continuation: "none" }
    });
    const orMuse = row(catalog, "openrouter/meta/muse-spark-1.3-contributor");
    expect(openRouterReasoningReplaySupported(orMuse)).toBe(false);
    expect(openRouterRouteOffered(orMuse, catalog)).toBe(true);
    expect(curatedCatalog({ catalog }).models.map((model) => model.id)).toContain("openrouter/meta/muse-spark-1.3-contributor");
  });

  it("hides an OpenRouter route when the vendor's own route needs replay and the row cannot replay it", () => {
    const catalog = cloneCatalog();
    const sonnet = row(catalog, "openrouter/anthropic/claude-sonnet-5.5");
    // As winter 0.0.55 shipped the row: no OpenRouter continuation.
    sonnet.reasoning = { ...sonnet.reasoning!, continuation: "none" };
    expect(row(catalog, "anthropic/claude-sonnet-5-5").reasoning?.continuation).not.toBe("none");
    expect(openRouterRouteOffered(sonnet, catalog)).toBe(false);
    // Once the direct route keeps no reasoning state, the OpenRouter twin has nothing to replay.
    const direct = row(catalog, "anthropic/claude-sonnet-5-5");
    direct.reasoning = { ...direct.reasoning!, continuation: "none" };
    expect(openRouterRouteOffered(sonnet, catalog)).toBe(true);
  });

  it("assumes replay is needed when an OpenRouter row has no known direct counterpart", () => {
    const catalog = cloneCatalog();
    const template = row(catalog, "openrouter/anthropic/claude-sonnet-5.5");
    const stranger = {
      ...structuredClone(template),
      key: "openrouter/acme/thinker-1",
      upstreamId: "acme/thinker-1",
      reasoning: { ...template.reasoning!, continuation: "none" as const }
    };
    catalog.models.push(stranger);
    expect(openRouterRouteOffered(stranger, catalog)).toBe(false);
  });

  it("the migration's family table is the catalog's", () => {
    expect(FAMILY_ROUTES).toBe(CURATED_FAMILY_ROUTES);
  });

  // Every route the models migration can map to is offered by the installed catalog (winter W2, W7).
  it("offers every curated family route, direct and through OpenRouter, in the installed catalog", () => {
    const offered = new Set(curatedCatalog().models.map((model) => model.id));
    for (const [family, routes] of Object.entries(CURATED_FAMILY_ROUTES)) {
      expect(offered.has(routeKey(routes.direct)), `${family} direct`).toBe(true);
      expect(offered.has(routeKey(routes.openrouter)), `${family} via OpenRouter`).toBe(true);
    }
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
    // D6: the cap can be lowered, never raised past $10 per million output tokens.
    expect(UpdateAppConfigBodySchema.parse({ models: { maxOutputUsdPerMTok: 10 } })).toEqual({ models: { maxOutputUsdPerMTok: 10 } });
    expect(() => UpdateAppConfigBodySchema.parse({ models: { maxOutputUsdPerMTok: 10.01 } })).toThrow();
    expect(() => AppConfigSchema.parse({ models: { maxOutputUsdPerMTok: 50 } })).toThrow();
  });
});

describe("explicitCacheTtlMs (spec §25)", () => {
  it("is one hour for Claude on Anthropic and through OpenRouter, undefined for the other curated routes", () => {
    const ttl = (key: string) => explicitCacheTtlMs(parseRouteKey(key)!);
    expect(PROMPT_CACHE_TTL_MS).toBe(3_600_000);
    for (const key of ["anthropic/claude-haiku-5-5", "openrouter/anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5"]) expect(ttl(key), key).toBe(3_600_000);
    for (const key of ["deepseek/deepseek-flash", "openrouter/deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna", "openrouter/openai/gpt-6-luna", "openai/gpt-6.1-sol", "meta/muse-spark-1.3-contributor", "openrouter/meta/muse-spark-1.3-contributor"]) expect(ttl(key), key).toBeUndefined();
    expect(ttl("nowhere/claude-haiku-5-5")).toBeUndefined();
  });

  it("the curated catalog carries it (cacheTtlMs), so callers use the catalog they were given", () => {
    const catalog = cloneCatalog();
    const models = curatedCatalog({ catalog }).models;
    expect(models.find((model) => model.id === "anthropic/claude-haiku-5-5")?.cacheTtlMs).toBe(3_600_000);
    expect(models.find((model) => model.id === "openrouter/anthropic/claude-sonnet-5.5")?.cacheTtlMs).toBe(3_600_000);
    expect(models.find((model) => model.id === "openai/gpt-6-luna")?.cacheTtlMs).toBeUndefined();
    delete (row(catalog, "anthropic/claude-haiku-5-5") as { promptCaching?: unknown }).promptCaching;
    expect(curatedCatalog({ catalog }).models.find((model) => model.id === "anthropic/claude-haiku-5-5")?.cacheTtlMs).toBeUndefined();
  });

  it("needs prompt caching on the row and, through OpenRouter, an anthropic/ upstream", () => {
    const catalog = cloneCatalog();
    delete (row(catalog, "anthropic/claude-haiku-5-5") as { promptCaching?: unknown }).promptCaching;
    expect(explicitCacheTtlMs(parseRouteKey("anthropic/claude-haiku-5-5")!, catalog)).toBeUndefined();
    const routed = row(catalog, "openrouter/anthropic/claude-sonnet-5.5") as { upstreamId: string };
    routed.upstreamId = "someone/claude-sonnet-5.5";
    expect(explicitCacheTtlMs(parseRouteKey("openrouter/anthropic/claude-sonnet-5.5")!, catalog)).toBeUndefined();
  });
});
