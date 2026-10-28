// The web behind her `Web` script (Living cast spec §31; §6.8, §6.9 for the caps), with its budgets.
//
// - Search (`search()`): Exa through winter-web (src/life/web/), host-wide `search.maxPerSecond` (a
//   rolling window of call starts, paced rather than refused; winter's own pacer additionally spaces
//   keyless starts 500 ms apart, which only ever adds a wait) and `search.maxPerDay`, per waifu
//   `search.maxPerWaifuPerDay`; 0 disables. Queries are recorded (`user/search/usage.json`, newest
//   100) for the dashboard (§14), private in a DM turn (D14).
// - Open (`open()`): one page through winter-web's SSRF-checked fetcher (always
//   `privateAddressPolicy: "deny"`), as text with its title and links; a PDF through the app's PDF
//   worker. Caps: `life.webFetch.maxPerTurn` and `maxPerWaifuPerDay`; a short-lived cache keyed by the
//   normalized URL.
// - Ask (`page.ask()`): one digest call on the cheapest offered curated route with a key (by input
//   then output price; contributor routes only when named in `life.webFetch.model`), purpose `web`,
//   no reasoning effort.
// The per-call caps and her arguments are checked in tools/web.ts. Failures are `{ok: false, error}`
// (her script's error), never thrown.

import type { Logger } from "../backend/logger.js";
import type { CuratedCatalog, CuratedModel } from "../models/catalog.js";
import type { ModelClient } from "../models/client.js";
import { ModelCallError } from "../models/errors.js";
import type { ProviderKeyLookup } from "../models/credentials.js";
import type { AppConfig } from "../shared/schemas/config.js";
import { createRevisionedBase } from "../shared/schemas/common.js";
import { SearchUsageSchema, type SearchUsage } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { abortableSleep } from "./sync.js";
import { localDayKey } from "./clock.js";
import { pageTitle } from "./wakeups/run.js";
import { updateLifeFile } from "./lifeStore.js";
import { extractPdfText } from "./home/pdf.js";
import { buildWebFetchDigestRequest, webFetchFailureText, type FetchWebPageOptions, type LifeWebFetchCache, type WebBackend } from "./web/index.js";
import type { TurnScratch } from "./tools/types.js";

export const SEARCH_USAGE_PATH = "user/search/usage.json";
/** The pages of a PDF `open()` reads. */
export const PDF_MAX_PAGES = 50;

export type WebSearchParams = { query: string; numResults: number; recentDays?: number; includeDomains?: string[]; excludeDomains?: string[] };
/** One search result as her script gets it. */
export type WebHit = { n: number; title: string; url: string; date?: string; snippet: string };
/** A page `open()` read: its text (markdown for HTML), title and links (HTML only). */
export type WebOpenedPage = { url: string; title: string; status: number; text: string; links: Array<{ text: string; url: string }>; note?: string };
const MAX_RECENT = 100;

/** Forget (§7.5 step 3): recent queries and URLs naming the person leave the dashboard list. Returns how many went. */
export async function scrubSearchUsage(storage: StorageService, drop: (query: string) => boolean): Promise<number> {
  const current = await storage.readJson(SEARCH_USAGE_PATH, SearchUsageSchema, SearchUsageSchema.parse({ ...createRevisionedBase() })).catch(() => undefined);
  if (!current || !current.recent.some((entry) => drop(entry.query))) return 0;
  let removed = 0;
  await storage.updateRevisionedJson({
    resourceKey: "search-usage",
    relativePath: SEARCH_USAGE_PATH,
    schema: SearchUsageSchema,
    fallback: SearchUsageSchema.parse({ ...createRevisionedBase() }),
    transform: (usage: SearchUsage) => {
      const recent = usage.recent.filter((entry) => !drop(entry.query));
      removed = usage.recent.length - recent.length;
      return { ...usage, recent };
    }
  });
  return removed;
}
const HIGHLIGHT_CHARS = 300;
const DIGEST_MAX_OUTPUT_TOKENS = 1_024;
const DIGEST_TIMEOUT_MS = 60_000;

export type WebToolsOptions = {
  storage: StorageService;
  backend: WebBackend;
  config: () => AppConfig;
  models: ModelClient;
  catalog: () => CuratedCatalog;
  credentials: ProviderKeyLookup;
  cache: LifeWebFetchCache;
  now: () => Date;
  timeZone: string;
  logger: Pick<Logger, "info" | "warn">;
  /** Test seams for the page fetcher: a fake resolver and transport. The policy is always "deny". */
  fetchOptions?: Pick<FetchWebPageOptions, "resolveHost" | "transport">;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export class WebTools {
  private readonly recentSearches: number[] = [];

  constructor(private readonly o: WebToolsOptions) {}

  searchOffered(): boolean {
    const search = this.o.config().search;
    return search.maxPerSecond > 0 && search.maxPerDay > 0 && search.maxPerWaifuPerDay > 0;
  }

  fetchOffered(): boolean {
    const fetch = this.o.config().life.webFetch;
    return fetch.maxPerWaifuPerDay > 0 && fetch.maxPerTurn > 0;
  }

  /** The digest route: `life.webFetch.model` when keyed, else the cheapest keyed non-contributor curated route, else `fallback`. */
  digestRoute(fallback?: CuratedModel): CuratedModel | undefined {
    const curated = this.o.catalog();
    const keyed = (model: CuratedModel) => Boolean(this.o.credentials(model.providerId));
    const configured = this.o.config().life.webFetch.model;
    if (configured) {
      const model = curated.models.find((candidate) => candidate.id === configured);
      if (model && keyed(model)) return model;
    }
    const candidates = curated.models
      .filter((model) => !model.contributor && model.pricing && keyed(model))
      .sort(
        (a, b) =>
          a.pricing!.inputPerMTokUsd - b.pricing!.inputPerMTokUsd ||
          a.pricing!.outputPerMTokUsd - b.pricing!.outputPerMTokUsd ||
          a.id.localeCompare(b.id)
      );
    return candidates[0] ?? fallback;
  }

  private day(): string {
    return localDayKey(this.o.now(), this.o.timeZone);
  }

  /**
   * Host-wide daily counter (+ the recent list). Returns false when the cap is reached. An entry of
   * a DM turn is recorded `dm: true` (D14): the dashboard shows its text only on a local reveal.
   */
  private async countHost(kind: "search" | "fetch", waifuId: string, query: string, cap: number | undefined, turn?: TurnScratch): Promise<boolean> {
    const day = this.day();
    let allowed = true;
    await this.o.storage.updateRevisionedJson({
      resourceKey: "search-usage",
      relativePath: SEARCH_USAGE_PATH,
      schema: SearchUsageSchema,
      fallback: SearchUsageSchema.parse({ ...createRevisionedBase() }),
      transform: (current: SearchUsage) => {
        const base = current.day === day ? current : { ...current, day, searches: 0, fetches: 0 };
        const used = kind === "search" ? base.searches : base.fetches;
        if (cap !== undefined && used >= cap) {
          allowed = false;
          return base;
        }
        const entry = { at: this.o.now().toISOString(), waifuId, kind, query: query.slice(0, 300), ok: true, ...(turn ? { turnId: turn.id } : {}), ...(turn?.dm ? { dm: true } : {}) };
        const recent = [...base.recent, entry].slice(-MAX_RECENT);
        return kind === "search" ? { ...base, searches: base.searches + 1, recent } : { ...base, fetches: base.fetches + 1, recent };
      }
    });
    if (allowed && turn) turn.webEntries = (turn.webEntries ?? 0) + 1;
    return allowed;
  }

  /** A turn became a DM turn after it searched or fetched: its entries on the list become private (D14). */
  async markTurnPrivate(turnId: string): Promise<void> {
    await this.o.storage.updateRevisionedJson({
      resourceKey: "search-usage",
      relativePath: SEARCH_USAGE_PATH,
      schema: SearchUsageSchema,
      fallback: SearchUsageSchema.parse({ ...createRevisionedBase() }),
      transform: (current: SearchUsage) => ({ ...current, recent: current.recent.map((entry) => (entry.turnId === turnId ? { ...entry, dm: true } : entry)) })
    });
  }

  /** Per-waifu daily counter. Returns false when the cap is reached. */
  private async countWaifu(waifuId: string, kind: "searches" | "fetches", cap: number): Promise<boolean> {
    const day = this.day();
    let allowed = true;
    await updateLifeFile(this.o.storage, waifuId, "usage", (usage) => {
      const base = usage.day === day ? usage : { ...usage, day, searches: 0, fetches: 0 };
      if (base[kind] >= cap) {
        allowed = false;
        return base;
      }
      return { ...base, [kind]: base[kind] + 1 };
    });
    return allowed;
  }

  /** Waits for a slot in the host-wide per-second window. */
  private async pace(signal: AbortSignal | undefined): Promise<void> {
    const perSecond = Math.max(1, this.o.config().search.maxPerSecond);
    const sleep = this.o.sleep ?? abortableSleep;
    for (;;) {
      const nowMs = Date.now();
      while (this.recentSearches.length > 0 && nowMs - this.recentSearches[0]! >= 1_000) this.recentSearches.shift();
      if (this.recentSearches.length < perSecond) {
        this.recentSearches.push(nowMs);
        return;
      }
      await sleep(1_000 - (nowMs - this.recentSearches[0]!), signal);
      if (signal?.aborted) return;
    }
  }

  /**
   * One `search()` of her Web script (§31.1): the daily caps (per waifu, then host-wide), the
   * per-second pace, then Exa. A refused or failed search is `{ok: false, error}` (her script's
   * error text); the hits carry their number, title, url, date (YYYY-MM-DD) and a snippet.
   */
  async searchHits(waifuId: string, params: WebSearchParams, signal?: AbortSignal, turn?: TurnScratch): Promise<{ ok: true; hits: WebHit[] } | { ok: false; error: string }> {
    const config = this.o.config().search;
    if (!this.searchOffered()) return { ok: false, error: "web search is off" };
    if (!(await this.countWaifu(waifuId, "searches", config.maxPerWaifuPerDay))) return { ok: false, error: "no more searches today" };
    if (!(await this.countHost("search", waifuId, params.query, config.maxPerDay, turn))) return { ok: false, error: "no more searches today" };
    await this.pace(signal);
    let outcome: Awaited<ReturnType<WebBackend["search"]>>;
    try {
      outcome = await this.o.backend.search(
        {
          query: params.query,
          numResults: params.numResults,
          ...(params.recentDays !== undefined ? { recentDays: params.recentDays } : {}),
          ...(params.includeDomains?.length ? { includeDomains: params.includeDomains } : {}),
          ...(params.excludeDomains?.length ? { excludeDomains: params.excludeDomains } : {})
        },
        signal ? { signal } : {}
      );
    } catch (error) {
      // winter refuses a bad filter with a TypeError before any request (the session checks them first).
      if (error instanceof TypeError) return { ok: false, error: `search: ${error.message}` };
      throw error;
    }
    if (!outcome.ok) {
      // Keyless tier exhausted with no usable key, or the key's own quota: unavailable for now.
      if (outcome.code === "rate_limited" || outcome.code === "quota_exhausted" || outcome.code === "key_unreadable") return { ok: false, error: "web search is unavailable right now; try again later" };
      if (outcome.code === "aborted") return { ok: false, error: "the search was interrupted" };
      if (outcome.code === "key_rejected") {
        this.o.logger.warn("Exa rejected the saved key", { category: "life" });
        return { ok: false, error: "web search is unavailable right now; try again later" };
      }
      if (outcome.code === "timeout") return { ok: false, error: "web search took too long; try again later" };
      if (outcome.code === "blocked_domains") return { ok: false, error: "web search can't search those sites" };
      // An MCP tool error (backend_error) or an unreachable backend; winter scrubs the key from messages.
      return { ok: false, error: `web search failed: ${outcome.message}` };
    }
    const hits = outcome.results.map((hit, index): WebHit => {
      const snippet = (hit.highlights?.join(" … ") || hit.text).replace(/\s+/g, " ").trim();
      const date = hit.publishedDate && /^\d{4}-\d{2}-\d{2}/u.test(hit.publishedDate) ? hit.publishedDate.slice(0, 10) : undefined;
      return { n: index + 1, title: hit.title, url: hit.url, ...(date ? { date } : {}), snippet: snippet.length > HIGHLIGHT_CHARS ? `${snippet.slice(0, HIGHLIGHT_CHARS)}…` : snippet };
    });
    this.o.logger.info("Life web search", { category: "life", waifuId, results: hits.length, tier: outcome.tier });
    return { ok: true, hits };
  }

  /**
   * A page for one of her `page` wakeups (§30.2): the same SSRF-checked fetcher (always
   * `privateAddressPolicy: "deny"`, the https upgrade and redirect rules), never the cache, no model
   * call and no daily fetch cap (at most 3 pages, each at most hourly). Text pages only.
   */
  async fetchForWakeup(url: string, signal?: AbortSignal): Promise<{ ok: true; page: { url: string; status: number; title: string; text: string } } | { ok: false }> {
    const config = this.o.config().life.webFetch;
    const page = await this.o.backend.fetchPage(url, {
      ...this.o.fetchOptions,
      privateAddressPolicy: "deny",
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      maxRedirects: config.maxRedirects,
      ...(signal ? { signal } : {})
    });
    if (!page.ok || page.kind === "binary") return { ok: false };
    return { ok: true, page: { url: page.finalUrl, status: page.status, title: pageTitle(page.text), text: page.text } };
  }

  /**
   * One `open()` of her Web script (§31.1): the per-turn and daily fetch caps, then winter-web's
   * SSRF-checked fetcher (always "deny", the cache, the https upgrade and redirect rules). HTML
   * comes with its title and links; a PDF is read by the app's PDF worker (its bytes, pages 1–50); any
   * other binary body is refused. Failures are fixed phrases, never a host or network detail.
   */
  async openPage(o: { waifuId: string; turn: TurnScratch; signal?: AbortSignal }, url: string): Promise<{ ok: true; page: WebOpenedPage } | { ok: false; error: string }> {
    const config = this.o.config().life.webFetch;
    if (!this.fetchOffered()) return { ok: false, error: "page fetching is off" };
    if (o.turn.fetches >= config.maxPerTurn) return { ok: false, error: `you've opened ${config.maxPerTurn} pages this turn; that's the most for one turn` };
    if (!(await this.countWaifu(o.waifuId, "fetches", config.maxPerWaifuPerDay))) return { ok: false, error: "no more page fetches today" };
    o.turn.fetches += 1;
    await this.countHost("fetch", o.waifuId, url, undefined, o.turn);
    const page = await this.o.backend.fetchPage(url, {
      ...this.o.fetchOptions,
      privateAddressPolicy: "deny",
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      maxRedirects: config.maxRedirects,
      cache: this.o.cache,
      binary: "bytes",
      ...(o.signal ? { signal: o.signal } : {})
    });
    if (!page.ok) return { ok: false, error: webFetchFailureText(page) };
    if (page.kind === "binary") {
      const bytes = page.bytes;
      const isPdf = /pdf/iu.test(page.contentType) || (bytes !== undefined && bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-");
      if (!isPdf || !bytes) return { ok: false, error: `that page is not text (${page.contentType || "unknown type"})` };
      if (page.truncated) return { ok: false, error: "that PDF is too large" };
      const read = await extractPdfText(bytes, { first: 1, last: PDF_MAX_PAGES, ...(o.signal ? { signal: o.signal } : {}) });
      if (!read.ok) return { ok: false, error: `that PDF can't be read (${read.error})` };
      const text = read.pages.map((entry) => `--- page ${entry.page} ---\n${entry.text}`).join("\n");
      const note = read.totalPages > PDF_MAX_PAGES ? `a PDF of ${read.totalPages} pages; the first ${PDF_MAX_PAGES} are here` : read.pages.every((entry) => !entry.text.trim()) ? "a PDF with no text in it (a scan?)" : undefined;
      return { ok: true, page: { url: page.finalUrl, title: pageTitle(text.replace(/^--- page \d+ ---$/gmu, "")) || "PDF", status: page.status, text, links: [], ...(note ? { note } : {}) } };
    }
    const title = page.title?.trim() || pageTitle(page.text);
    const note = page.truncated ? "cut: the page was too long" : !page.text.trim() ? "the page has no readable text" : undefined;
    return { ok: true, page: { url: page.finalUrl, title, status: page.status, text: page.text, links: (page.links ?? []).map((link) => ({ text: link.text, url: link.url })), ...(note ? { note } : {}) } };
  }

  /**
   * `page.ask(question)` (§31.1): today's WebFetch digest over the whole page, one call on the
   * cheapest offered route with a key (else her own), purpose `web`, no reasoning effort.
   */
  async askPage(o: { waifuId: string; turn: TurnScratch; route: CuratedModel; signal?: AbortSignal }, page: { url: string; text: string }, question: string): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
    const text = page.text.trim();
    if (!text) return { ok: false, error: "the page has no readable text to ask about" };
    const route = this.digestRoute(o.route);
    if (!route) return { ok: false, error: "no model is available to read the page" };
    const request = buildWebFetchDigestRequest({ url: page.url, text, prompt: question });
    try {
      const result = await this.o.models.call({
        route: { providerId: route.providerId, modelId: route.modelId },
        system: [request.system],
        messages: request.messages,
        maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
        timeoutMs: DIGEST_TIMEOUT_MS,
        ...(o.signal ? { signal: o.signal } : {}),
        attribution: { purpose: "web", waifuId: o.waifuId, turnId: o.turn.id }
      });
      const answer = result.text.trim();
      if (!answer) return { ok: false, error: "reading the page gave no answer" };
      return { ok: true, answer };
    } catch (error) {
      const kind = error instanceof ModelCallError ? error.kind : "other";
      this.o.logger.warn("Life web page reading failed", { waifuId: o.waifuId, kind });
      return { ok: false, error: kind === "aborted" ? "the page reading was interrupted" : "the page could not be read right now" };
    }
  }
}
