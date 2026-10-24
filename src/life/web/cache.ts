// TEMPORARY local port (Living cast L2) of winter's short-lived page cache (winter-agent-sdk,
// packages/runtime/src/tools/impl/_web-fetch-cache.ts, MIT, ours): converted pages keyed by the
// normalized URL, a TTL (`life.webFetch.cacheMinutes`), LRU by total text size. Failures are never
// cached. The digest still runs on a hit (the question may differ).

import type { WebPage } from "./fetchPage.js";

export const DEFAULT_WEB_CACHE_MAX_BYTES = 20 * 1024 * 1024;

export class WebFetchCache {
  private readonly entries = new Map<string, { page: WebPage; at: number; bytes: number }>();
  private bytes = 0;

  constructor(private readonly o: { ttlMs: () => number; maxBytes?: number; now?: () => number }) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  private sweep(): void {
    const ttl = this.o.ttlMs();
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (ttl <= 0 || now - entry.at >= ttl) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
      }
    }
  }

  get(key: string): WebPage | undefined {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.page;
  }

  set(key: string, page: WebPage): void {
    if (this.o.ttlMs() <= 0) return;
    this.sweep();
    const bytes = Buffer.byteLength(page.text, "utf8") + 256;
    const max = this.o.maxBytes ?? DEFAULT_WEB_CACHE_MAX_BYTES;
    if (bytes > max) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    this.entries.set(key, { page: { ...page }, at: this.now(), bytes });
    this.bytes += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= max) break;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
