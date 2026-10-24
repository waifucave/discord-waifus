// The curated model catalog (Living cast spec §9.2): a small allow-list of winter catalog routes,
// filtered by capability and price. winter's provider catalog is the only source of model facts
// (context window, prices, efforts, image input); this module only decides which routes the app
// offers.
//
// A route is a winter catalog key `<providerId>/<modelId>` (`anthropic/claude-sonnet-5-5`,
// `openrouter/anthropic/claude-sonnet-5.5`). Provider ids never contain "/", so the first segment
// is the provider and the rest is the provider-local model id winter resolves.

import {
  loadCatalog,
  type WinterCatalog,
  type WinterModelDescriptor,
  type WinterProviderDescriptor
} from "@yanlinglabs/winter-provider-catalog";

import { DEFAULT_ALLOWED_ROUTES, DEFAULT_MAX_OUTPUT_USD_PER_MTOK } from "./defaults.js";

export { DEFAULT_ALLOWED_ROUTES, DEFAULT_MAX_OUTPUT_USD_PER_MTOK };

export type ModelRoute = { providerId: string; modelId: string };
/** A stored model choice: a route plus an optional reasoning effort from the route's own list. */
export type ModelChoice = ModelRoute & { effort?: string };

export type ModelPricing = {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd?: number;
  cacheWritePerMTokUsd?: number;
};

export type CuratedModel = {
  /** The route key, `<providerId>/<modelId>`. */
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  providerDisplayName: string;
  family: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  imageInput: boolean;
  /** Reasoning efforts this route accepts (empty when it has no reasoning control). */
  efforts: string[];
  defaultEffort?: string;
  /** Absent for an unpriced route (it counts as 0 toward budgets). */
  pricing?: ModelPricing;
  /** Muse Spark contributor variants enable training on prompts (§9.2): the picker labels them. */
  contributor: boolean;
  promptCaching: boolean;
};

export type HiddenRouteReason =
  | "not_in_catalog"
  | "provider_blocked"
  | "deprecated"
  | "no_tool_calling"
  | "over_price_cap"
  | "openrouter_reasoning_replay";

export type HiddenRoute = { id: string; reason: HiddenRouteReason };

export type CuratedCatalog = {
  catalogVersion: string;
  models: CuratedModel[];
  hidden: HiddenRoute[];
};

export type CuratedCatalogOptions = {
  allowed?: readonly string[];
  maxOutputUsdPerMTok?: number;
  catalog?: WinterCatalog;
};

export function routeKey(route: ModelRoute): string {
  return `${route.providerId}/${route.modelId}`;
}

/** `anthropic/claude-sonnet-5-5` → `{providerId: "anthropic", modelId: "claude-sonnet-5-5"}`. */
export function parseRouteKey(key: string): ModelRoute | undefined {
  const index = key.indexOf("/");
  if (index <= 0 || index === key.length - 1) return undefined;
  return { providerId: key.slice(0, index), modelId: key.slice(index + 1) };
}

/** The installed winter catalog (memoised by winter itself). */
export function installedCatalog(): WinterCatalog {
  return loadCatalog();
}

export function catalogModel(route: ModelRoute, catalog: WinterCatalog = installedCatalog()): WinterModelDescriptor | undefined {
  const key = routeKey(route);
  return catalog.models.find((model) => model.key === key);
}

export function catalogProvider(providerId: string, catalog: WinterCatalog = installedCatalog()): WinterProviderDescriptor | undefined {
  return catalog.providers.find((provider) => provider.id === providerId);
}

/**
 * The W7 feature check: OpenRouter routes are offered only once the installed winter can replay
 * reasoning through OpenRouter (spec §9.2, §9.5 W7). W7 ships "catalog continuation for those rows",
 * so a row whose reasoning continuation is still `none` predates it. A route without reasoning has
 * nothing to replay. This is the single switch for W7; winter 0.0.55 has no OpenRouter
 * continuation, so every curated OpenRouter route stays hidden there.
 */
export function openRouterReasoningReplaySupported(descriptor: WinterModelDescriptor): boolean {
  const reasoning = descriptor.reasoning;
  if (!reasoning || reasoning.supported.value !== true) return true;
  return reasoning.continuation !== "none";
}

function hiddenReason(
  descriptor: WinterModelDescriptor | undefined,
  provider: WinterProviderDescriptor | undefined,
  maxOutputUsdPerMTok: number
): HiddenRouteReason | undefined {
  if (!descriptor || !provider) return "not_in_catalog";
  if (provider.risk.class === "blocked") return "provider_blocked";
  if (descriptor.status === "deprecated" || descriptor.status === "blocked") return "deprecated";
  if (descriptor.toolCalling.value !== "native") return "no_tool_calling";
  const output = descriptor.pricing?.value.outputPerMTokUsd;
  if (typeof output === "number" && output > maxOutputUsdPerMTok) return "over_price_cap";
  if (descriptor.providerId === "openrouter" && !openRouterReasoningReplaySupported(descriptor)) {
    return "openrouter_reasoning_replay";
  }
  return undefined;
}

export function isContributorRoute(descriptor: Pick<WinterModelDescriptor, "key" | "upstreamId">): boolean {
  return /-contributor$/u.test(descriptor.upstreamId) || /-contributor$/u.test(descriptor.key);
}

export function curatedModelOf(descriptor: WinterModelDescriptor, provider: WinterProviderDescriptor): CuratedModel {
  const route = parseRouteKey(descriptor.key)!;
  const pricing = descriptor.pricing?.value;
  const reasoning = descriptor.reasoning;
  const efforts = reasoning && reasoning.supported.value === true ? [...reasoning.efforts] : [];
  return {
    id: descriptor.key,
    providerId: route.providerId,
    modelId: route.modelId,
    displayName: descriptor.displayName,
    providerDisplayName: provider.displayName,
    family: descriptor.modelFamily,
    ...(descriptor.contextWindow ? { contextWindow: descriptor.contextWindow.value } : {}),
    ...(descriptor.maxOutputTokens ? { maxOutputTokens: descriptor.maxOutputTokens.value } : {}),
    imageInput: descriptor.inputModalities.value.includes("image"),
    efforts,
    ...(reasoning?.defaultEffort && efforts.includes(reasoning.defaultEffort) ? { defaultEffort: reasoning.defaultEffort } : {}),
    ...(pricing
      ? {
          pricing: {
            inputPerMTokUsd: pricing.inputPerMTokUsd,
            outputPerMTokUsd: pricing.outputPerMTokUsd,
            ...(pricing.cacheReadPerMTokUsd !== undefined ? { cacheReadPerMTokUsd: pricing.cacheReadPerMTokUsd } : {}),
            ...(pricing.cacheWritePerMTokUsd !== undefined ? { cacheWritePerMTokUsd: pricing.cacheWritePerMTokUsd } : {})
          }
        }
      : {}),
    contributor: isContributorRoute(descriptor),
    promptCaching: descriptor.promptCaching?.value === true
  };
}

/** The curated view: allowed routes that pass every filter, in allow-list order, plus why the rest are hidden. */
export function curatedCatalog(options: CuratedCatalogOptions = {}): CuratedCatalog {
  const catalog = options.catalog ?? installedCatalog();
  const allowed = options.allowed ?? DEFAULT_ALLOWED_ROUTES;
  const cap = options.maxOutputUsdPerMTok ?? DEFAULT_MAX_OUTPUT_USD_PER_MTOK;
  const models: CuratedModel[] = [];
  const hidden: HiddenRoute[] = [];
  const seen = new Set<string>();
  for (const id of allowed) {
    if (seen.has(id)) continue;
    seen.add(id);
    const route = parseRouteKey(id);
    const descriptor = route ? catalog.models.find((model) => model.key === id) : undefined;
    const provider = route ? catalog.providers.find((candidate) => candidate.id === route.providerId) : undefined;
    const reason = hiddenReason(descriptor, provider, cap);
    if (reason) hidden.push({ id, reason });
    else models.push(curatedModelOf(descriptor!, provider!));
  }
  return { catalogVersion: catalog.catalogVersion, models, hidden };
}

export function findCuratedModel(route: ModelRoute, curated: CuratedCatalog): CuratedModel | undefined {
  const id = routeKey(route);
  return curated.models.find((model) => model.id === id);
}

/** Provider ids that serve at least one allowed route in the installed catalog (hidden or not). */
export function allowedProviderIds(options: CuratedCatalogOptions = {}): string[] {
  const catalog = options.catalog ?? installedCatalog();
  const ids = new Set<string>();
  for (const id of options.allowed ?? DEFAULT_ALLOWED_ROUTES) {
    const route = parseRouteKey(id);
    if (route && catalog.providers.some((provider) => provider.id === route.providerId)) ids.add(route.providerId);
  }
  return [...ids];
}
