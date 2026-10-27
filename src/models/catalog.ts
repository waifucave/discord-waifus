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

import { estimateCostUsd } from "@yanlinglabs/winter-provider-runtime";
import { CURATED_FAMILY_ROUTES, DEFAULT_ALLOWED_ROUTES, DEFAULT_MAX_OUTPUT_USD_PER_MTOK } from "./defaults.js";

export { CURATED_FAMILY_ROUTES, DEFAULT_ALLOWED_ROUTES, DEFAULT_MAX_OUTPUT_USD_PER_MTOK };

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
  /** How long her prompt stays cached after a request (§25, `explicitCacheTtlMs`); absent: not known. */
  cacheTtlMs?: number;
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
 * Priced-ness, decided once for the whole app: a route is priced when the catalog's price comes from
 * the vendor's official docs (exactly when winter's `estimateCostUsd` returns a `list` basis). The
 * curated list's `pricing`, the price cap, the usage ledger's cost and the `model_unpriced` warning
 * all use this.
 */
export function isPricedRoute(descriptor: Pick<WinterModelDescriptor, "pricing">): boolean {
  return descriptor.pricing?.source === "official-doc";
}

/** The list prices of a priced route, else undefined. */
export function listPricing(descriptor: Pick<WinterModelDescriptor, "pricing">): NonNullable<WinterModelDescriptor["pricing"]>["value"] | undefined {
  return isPricedRoute(descriptor) ? descriptor.pricing!.value : undefined;
}

/** winter's list-price estimate for a call's usage on a priced route, else undefined. */
export function listPricedEstimate(
  usage: Parameters<typeof estimateCostUsd>[0] | undefined,
  descriptor: WinterModelDescriptor | undefined
): ReturnType<typeof estimateCostUsd> | undefined {
  if (!usage || !descriptor || !isPricedRoute(descriptor)) return undefined;
  return estimateCostUsd(usage, descriptor);
}

/** The route keeps reasoning state that a later turn must replay (its continuation is not `none`). */
function needsReasoningReplay(descriptor: WinterModelDescriptor): boolean {
  const reasoning = descriptor.reasoning;
  return reasoning !== undefined && reasoning.supported.value === true && reasoning.continuation !== "none";
}

/**
 * Whether the installed winter can replay this OpenRouter row's reasoning (W7 ships "catalog
 * continuation for those rows"): a row without reasoning, or one whose continuation is not `none`.
 */
export function openRouterReasoningReplaySupported(descriptor: WinterModelDescriptor): boolean {
  const reasoning = descriptor.reasoning;
  if (!reasoning || reasoning.supported.value !== true) return true;
  return reasoning.continuation !== "none";
}

/** The vendor's own route for an OpenRouter row: the curated family pair, else the row named by its upstream id. */
export function directCounterpart(descriptor: WinterModelDescriptor, catalog: WinterCatalog): WinterModelDescriptor | undefined {
  for (const routes of Object.values(CURATED_FAMILY_ROUTES)) {
    if (routeKey(routes.openrouter) === descriptor.key) return catalogModel(routes.direct, catalog);
  }
  return catalog.models.find((model) => model.key === descriptor.upstreamId && model.providerId !== "openrouter");
}

/**
 * The W7 feature check (spec §9.2, §9.5 W7): an OpenRouter route is hidden only when its family
 * needs reasoning replay (the vendor's own route has a continuation) and the installed winter
 * cannot replay it through OpenRouter (the OpenRouter row's continuation is still `none`). A family
 * with no reasoning state to replay (Muse Spark: continuation `none` on both rows) is offered
 * either way. Without a known direct counterpart the route is assumed to need replay.
 */
export function openRouterRouteOffered(descriptor: WinterModelDescriptor, catalog: WinterCatalog): boolean {
  if (openRouterReasoningReplaySupported(descriptor)) return true;
  const direct = directCounterpart(descriptor, catalog);
  return direct !== undefined && !needsReasoningReplay(direct);
}

function hiddenReason(
  descriptor: WinterModelDescriptor | undefined,
  provider: WinterProviderDescriptor | undefined,
  maxOutputUsdPerMTok: number,
  catalog: WinterCatalog
): HiddenRouteReason | undefined {
  if (!descriptor || !provider) return "not_in_catalog";
  if (provider.risk.class === "blocked") return "provider_blocked";
  if (descriptor.status === "deprecated" || descriptor.status === "blocked") return "deprecated";
  if (descriptor.toolCalling.value !== "native") return "no_tool_calling";
  const output = listPricing(descriptor)?.outputPerMTokUsd;
  if (typeof output === "number" && output > maxOutputUsdPerMTok) return "over_price_cap";
  if (descriptor.providerId === "openrouter" && !openRouterRouteOffered(descriptor, catalog)) {
    return "openrouter_reasoning_replay";
  }
  return undefined;
}

/** The prompt cache lifetime every call asks for (`cacheTtl` and the rolling message TTL in client.ts). */
export const PROMPT_CACHE_TTL = "1h" as const;
export const PROMPT_CACHE_TTL_MS = 60 * 60_000;

/**
 * How long her prompt stays cached after a request on this route (Living cast spec §25), or undefined
 * when that is not known. winter's catalog states that a route caches (`promptCaching`) but carries no
 * lifetime fact; winter's runtime sends the explicit 1-hour TTL (`cacheTtl`, `messageCacheTtl`) only
 * on the Anthropic Messages adapter and, through OpenRouter, for an `anthropic/…` upstream with
 * prompt caching (every other adapter ignores it). So the TTL is derived here from the route: a Claude
 * model (`modelFamily` `claude`) with prompt caching, on a provider of winter's `anthropic` adapter
 * family or on OpenRouter with an `anthropic/` upstream. Anything else: undefined (no guessing).
 */
export function explicitCacheTtlMs(route: ModelRoute, catalog: WinterCatalog = installedCatalog()): number | undefined {
  const descriptor = catalogModel(route, catalog);
  return descriptor ? cacheTtlMsOf(descriptor, catalogProvider(descriptor.providerId, catalog)) : undefined;
}

/** `explicitCacheTtlMs` for a catalog row and its provider (the curated list stores it as `cacheTtlMs`). */
export function cacheTtlMsOf(descriptor: WinterModelDescriptor, provider: Pick<WinterProviderDescriptor, "family"> | undefined): number | undefined {
  if (descriptor.modelFamily !== "claude" || descriptor.promptCaching?.value !== true) return undefined;
  if (descriptor.providerId === "openrouter") return descriptor.upstreamId.startsWith("anthropic/") ? PROMPT_CACHE_TTL_MS : undefined;
  return provider?.family === "anthropic" ? PROMPT_CACHE_TTL_MS : undefined;
}

export function isContributorRoute(descriptor: Pick<WinterModelDescriptor, "key" | "upstreamId">): boolean {
  return /-contributor$/u.test(descriptor.upstreamId) || /-contributor$/u.test(descriptor.key);
}

export function curatedModelOf(descriptor: WinterModelDescriptor, provider: WinterProviderDescriptor): CuratedModel {
  const route = parseRouteKey(descriptor.key)!;
  const pricing = listPricing(descriptor);
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
    promptCaching: descriptor.promptCaching?.value === true,
    ...(cacheTtlMsOf(descriptor, provider) !== undefined ? { cacheTtlMs: cacheTtlMsOf(descriptor, provider)! } : {})
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
    const reason = hiddenReason(descriptor, provider, cap, catalog);
    if (reason) hidden.push({ id, reason });
    else models.push(curatedModelOf(descriptor!, provider!));
  }
  return { catalogVersion: catalog.catalogVersion, models, hidden };
}

/**
 * Curated routes the allow list leaves out that would be offered if allowed (the default allow list's
 * routes the installed catalog has and every filter passes), so the dashboard can switch them back on.
 */
export function offListRoutes(options: CuratedCatalogOptions & { allowed: readonly string[] }): CuratedModel[] {
  const allowed = new Set(options.allowed);
  return curatedCatalog({ ...options, allowed: DEFAULT_ALLOWED_ROUTES.filter((id) => !allowed.has(id)) }).models;
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
