// The web backend behind `web_search` and `web_fetch` (Living cast spec §6.8, §6.9).
//
// TEMPORARY: `src/life/web/` is a local port of winter's web tools (MIT, ours) shaped like the
// planned `@yanlinglabs/winter-web` package (`fetchWebPage`, `createExaSearchClient`,
// `buildWebFetchDigestRequest`). When that package ships, these files are replaced by imports from it
// behind this same `WebBackend` interface; the tools (src/life/search.ts) do not change.

import { createExaSearchClient, sharedExaSearchState, type ExaSearchOutcome, type ExaSearchParams, type ExaSearchState } from "./exa.js";
import { fetchWebPage, type FetchWebPageOptions, type WebFetchOutcome } from "./fetchPage.js";

export { buildWebFetchDigestRequest } from "./digest.js";
export { WebFetchCache } from "./cache.js";
export type { ExaSearchOutcome, ExaSearchHit, ExaSearchParams } from "./exa.js";
export type { WebFetchOutcome, WebPage, FetchWebPageOptions } from "./fetchPage.js";

export interface WebBackend {
  search(params: ExaSearchParams, opts?: { signal?: AbortSignal }): Promise<ExaSearchOutcome>;
  fetchPage(url: string, opts?: FetchWebPageOptions): Promise<WebFetchOutcome>;
}

export type WebBackendOptions = {
  /** The saved Exa key (`exa` provider credential), read live. */
  resolveExaKey?: () => string | undefined;
  /** Anonymous Exa pacing in ms (from `search.maxPerSecond`). */
  exaMinIntervalMs?: () => number;
  exaEndpoint?: string;
  state?: ExaSearchState;
  fetchImpl?: typeof fetch;
  userAgent?: string;
};

export function createWebBackend(options: WebBackendOptions = {}): WebBackend {
  const exa = createExaSearchClient({
    state: options.state ?? sharedExaSearchState,
    ...(options.resolveExaKey ? { resolveKey: options.resolveExaKey } : {}),
    ...(options.exaMinIntervalMs ? { minIntervalMs: options.exaMinIntervalMs } : {}),
    ...(options.exaEndpoint ? { endpoint: options.exaEndpoint } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {})
  });
  return {
    search: (params, opts) => exa.search(params, opts),
    fetchPage: (url, opts) => fetchWebPage(url, { ...(options.userAgent ? { userAgent: options.userAgent } : {}), ...opts })
  };
}
