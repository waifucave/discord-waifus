// Discord image fetching (spec 8.4, I6): one fetcher shared by inline images and OCR.
// - Cache keys come from attachmentKey(), never from the signed query (ex/is/hm), which Discord
//   rotates, so a re-signed URL still hits the cache.
// - SSRF guard: only cdn.discordapp.com / media.discordapp.net over https.
// - Size cap checked against the declared size, Content-Length and the streamed body.
// - Per-fetch timeout merged with the caller's signal; global concurrency 4; single-flight per key
//   with ref-counted abort (the network fetch is aborted only when every waiter gave up).
// - Memory LRU + disk cache (app/cache/images/<sha256(key)>.{bin,json}, 0600, TTL, LRU to a byte
//   cap) so inline images stay byte-identical across rebuilds, restarts and signed-URL expiry.
// - An expired URL (403/404 with a past `ex`) triggers one URL refresh through a hook.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../backend/logger.js";
import { appDataPath } from "../config/paths.js";
import type { DiscordConfig } from "../shared/schemas/config.js";
import { DEFAULT_APP_CONFIG } from "../shared/schemas/config.js";
import type { ImageRef } from "../shared/schemas/discordMessage.js";
import { recordConversationImages } from "./imageIndex.js";

export type ImageFetchPurpose = "inline" | "ocr";
export type ImageFetchFailure =
  | "too_large"
  | "unsupported_type"
  | "http_error"
  | "timeout"
  | "aborted"
  | "network"
  | "blocked_host";
export type ImageFetchResult =
  | { ok: true; mimeType: string; data: Buffer; source: "memory" | "disk" | "network" }
  | { ok: false; reason: ImageFetchFailure };

/** Returns a fresh signed URL for `ref` (e.g. via a single-message refetch), or undefined. */
export type ImageUrlRefresher = (ref: ImageRef) => Promise<string | undefined>;

export interface ImageFetcher {
  get(
    ref: ImageRef,
    o: { signal?: AbortSignal; purpose: ImageFetchPurpose; refreshUrl?: ImageUrlRefresher }
  ): Promise<ImageFetchResult>;
  /** Drop cached bytes for these image keys (a deleted message's images, spec 9.5). */
  purge?(keys: readonly string[]): Promise<void>;
}

export const ALLOWED_IMAGE_HOSTS: ReadonlySet<string> = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

const ATTACHMENT_PATH_RE = /^\/(?:ephemeral-)?attachments\/\d+\/(\d+)\/[^/]+$/;
const GLOBAL_CONCURRENCY = 4;
const DISK_SCHEMA_VERSION = 1;

/**
 * "att:<attachmentId>" when known or parsed from /attachments/<channel>/<id>/<name>, else
 * "url:" + sha256(origin + pathname). Never includes the signed query.
 */
export function attachmentKey(url: string, attachmentId?: string): string {
  if (attachmentId && /^\d+$/.test(attachmentId)) return `att:${attachmentId}`;
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed) return `url:${sha256(url)}`;
  const match = ATTACHMENT_PATH_RE.exec(parsed.pathname);
  if (match && ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) return `att:${match[1]}`;
  return `url:${sha256(parsed.origin + parsed.pathname)}`;
}

/** Normalized MIME type ("image/jpg" → "image/jpeg"), or undefined when unknown. */
export function normalizeImageMime(contentType: string | undefined | null): string | undefined {
  if (!contentType) return undefined;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  if (base === "image/jpg" || base === "image/pjpeg") return "image/jpeg";
  return base || undefined;
}

/** MIME from a file name extension (png/jpeg/webp/gif only). */
export function mimeFromFilename(name: string | undefined): string | undefined {
  const match = /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(name ?? "");
  if (!match) return undefined;
  const ext = match[1]!.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
}

/** True when a signed Discord CDN URL's `ex` (hex unix seconds) is in the past. */
export function isExpiredSignedUrl(url: string, now = Date.now()): boolean {
  try {
    const ex = new URL(url).searchParams.get("ex");
    if (!ex || !/^[0-9a-f]+$/i.test(ex)) return false;
    return Number.parseInt(ex, 16) * 1000 <= now;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hostAllowed(url: string, allowedHosts: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && allowedHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

type DiskMeta = { schemaVersion: number; key: string; mimeType: string; bytes: number; sha256: string; fetchedAt: string };

export type ImageCacheConfig = DiscordConfig["images"];

/**
 * The shared fetcher's limits (spec 8.4: OCR and inline images use one fetcher). Before Phase 4
 * the OCR service fetched with `ocr.maxImageBytes` / `ocr.timeoutMs`. A legacy value counts only
 * when the owner customised it (it differs from its own default): then the max of it and
 * `discord.images` applies so nobody loses headroom, and a warning is logged because those keys
 * are deprecated for fetching. A legacy value left at its default never raises the limit, so
 * `discord.images.maxBytes` / `fetchTimeoutMs` stay authoritative and lowering them takes effect.
 * (Inline images have their own provider-safe cap on top, see `MAX_INLINE_IMAGE_BYTES`.)
 */
export function sharedImageFetcherConfig(
  app: { discord: { images: ImageCacheConfig }; ocr: { maxImageBytes: number; timeoutMs: number } },
  logger?: Pick<Logger, "warn">
): ImageCacheConfig {
  const images = app.discord.images;
  const defaults = DEFAULT_APP_CONFIG.ocr;
  const legacyBytesSet = app.ocr.maxImageBytes !== defaults.maxImageBytes;
  const legacyTimeoutSet = app.ocr.timeoutMs !== defaults.timeoutMs;
  const maxBytes = legacyBytesSet ? Math.max(images.maxBytes, app.ocr.maxImageBytes) : images.maxBytes;
  const fetchTimeoutMs = legacyTimeoutSet
    ? Math.max(images.fetchTimeoutMs, Math.max(500, app.ocr.timeoutMs))
    : images.fetchTimeoutMs;
  const raised: string[] = [];
  if (maxBytes > images.maxBytes) raised.push("ocr.maxImageBytes");
  if (fetchTimeoutMs > images.fetchTimeoutMs) raised.push("ocr.timeoutMs");
  if (raised.length > 0) {
    logger?.warn(
      `Deprecated: ${raised.join(" and ")} still raise the shared image fetch limits; set discord.images.maxBytes / fetchTimeoutMs instead.`
    );
  }
  return { ...images, maxBytes, fetchTimeoutMs };
}

export type DiscordImageFetcherOptions = {
  dataRoot: string;
  config?: Partial<ImageCacheConfig>;
  logger?: Logger;
  /** Default URL refresh hook (a per-call `refreshUrl` wins). */
  refreshUrl?: ImageUrlRefresher;
  /** Test seams. */
  fetch?: typeof fetch;
  allowedHosts?: ReadonlySet<string>;
  now?: () => number;
};

type Flight = { promise: Promise<ImageFetchResult>; controller: AbortController; waiters: number };

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(() => this.release());
      };
      const onAbort = () => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

class TimeoutError extends Error {}
class TooLargeError extends Error {}

export class DiscordImageFetcher implements ImageFetcher {
  private readonly config: ImageCacheConfig;
  private readonly memory = new Map<string, { mimeType: string; data: Buffer }>();
  private memoryBytes = 0;
  private readonly flights = new Map<string, Flight>();
  private readonly semaphore = new Semaphore(GLOBAL_CONCURRENCY);
  private readonly fetchImpl: typeof fetch;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly now: () => number;
  private diskBytes: number | undefined;

  constructor(private readonly options: DiscordImageFetcherOptions) {
    this.config = { ...DEFAULT_APP_CONFIG.discord.images, ...options.config };
    this.fetchImpl = options.fetch ?? fetch;
    this.allowedHosts = options.allowedHosts ?? ALLOWED_IMAGE_HOSTS;
    this.now = options.now ?? Date.now;
  }

  async get(
    ref: ImageRef,
    o: { signal?: AbortSignal; purpose: ImageFetchPurpose; refreshUrl?: ImageUrlRefresher }
  ): Promise<ImageFetchResult> {
    const result = await this.getCached(ref, o);
    // The conversation's durable image index (forget purges from it without the runtime).
    if (result.ok && ref.conversationKey) {
      await recordConversationImages(this.options.dataRoot, ref.conversationKey, [ref.key]).catch((error: unknown) => {
        this.options.logger?.warn("Conversation image index write failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return result;
  }

  private async getCached(
    ref: ImageRef,
    o: { signal?: AbortSignal; purpose: ImageFetchPurpose; refreshUrl?: ImageUrlRefresher }
  ): Promise<ImageFetchResult> {
    if (o.signal?.aborted) return { ok: false, reason: "aborted" };
    const cached = this.memoryGet(ref.key);
    if (cached) return { ok: true, ...cached, source: "memory" };
    if (!hostAllowed(ref.url, this.allowedHosts)) return { ok: false, reason: "blocked_host" };

    let flight = this.flights.get(ref.key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = {
        controller,
        waiters: 0,
        promise: this.load(ref, o.purpose, controller.signal, o.refreshUrl).finally(() => {
          if (this.flights.get(ref.key) === created) this.flights.delete(ref.key);
        })
      };
      flight = created;
      this.flights.set(ref.key, flight);
    }
    return this.wait(ref.key, flight, o.signal);
  }

  /** The keys that have cached bytes (memory or disk), for an exact deletion count. */
  async cachedKeys(keys: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const key of new Set(keys)) {
      if (this.memory.has(key)) {
        found.push(key);
        continue;
      }
      const exists = await stat(path.join(this.diskDir(), `${this.diskBase(key)}.bin`)).then(() => true, () => false);
      if (exists) found.push(key);
    }
    return found;
  }

  async purge(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) {
      const cached = this.memory.get(key);
      if (cached) {
        this.memory.delete(key);
        this.memoryBytes -= cached.data.byteLength;
      }
      await this.removeDisk(this.diskBase(key));
    }
  }

  /** Byte total of the disk cache after enforcing TTL and the size cap. */
  async pruneDisk(): Promise<number> {
    const dir = this.diskDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      this.diskBytes = 0;
      return 0;
    }
    const entries: Array<{ base: string; bytes: number; mtimeMs: number; expired: boolean }> = [];
    const ttlMs = this.config.diskCacheTtlHours * 3_600_000;
    for (const name of names) {
      if (!name.endsWith(".bin")) {
        if (name.endsWith(".tmp")) await rm(path.join(dir, name), { force: true }).catch(() => undefined);
        continue;
      }
      const base = name.slice(0, -4);
      try {
        const info = await stat(path.join(dir, name));
        const meta = await this.readMeta(base);
        const fetchedAt = meta ? Date.parse(meta.fetchedAt) : Number.NaN;
        entries.push({
          base,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
          expired: !meta || !Number.isFinite(fetchedAt) || this.now() - fetchedAt > ttlMs
        });
      } catch {
        // vanished concurrently
      }
    }
    let total = 0;
    const live: typeof entries = [];
    for (const entry of entries) {
      if (entry.expired) await this.removeDisk(entry.base);
      else {
        live.push(entry);
        total += entry.bytes;
      }
    }
    const cap = this.config.diskCacheMb * 1024 * 1024;
    live.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of live) {
      if (total <= cap) break;
      await this.removeDisk(entry.base);
      total -= entry.bytes;
    }
    this.diskBytes = total;
    return total;
  }

  private async wait(key: string, flight: Flight, signal: AbortSignal | undefined): Promise<ImageFetchResult> {
    flight.waiters += 1;
    let settled = false;
    const leave = () => {
      if (settled) return;
      settled = true;
      flight.waiters -= 1;
      if (flight.waiters <= 0) {
        // Nobody wants this download any more: abort it, and let a later caller start afresh
        // instead of joining an aborted flight.
        if (this.flights.get(key) === flight) this.flights.delete(key);
        flight.controller.abort(new Error("all waiters aborted"));
      }
    };
    if (!signal) {
      try {
        return await flight.promise;
      } finally {
        settled = true;
        flight.waiters -= 1;
      }
    }
    return new Promise<ImageFetchResult>((resolve) => {
      const onAbort = () => {
        leave();
        resolve({ ok: false, reason: "aborted" });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            flight.waiters -= 1;
          }
          resolve(result);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            flight.waiters -= 1;
          }
          resolve({ ok: false, reason: "network" });
        }
      );
    });
  }

  private async load(
    ref: ImageRef,
    purpose: ImageFetchPurpose,
    signal: AbortSignal,
    refreshUrl: ImageUrlRefresher | undefined
  ): Promise<ImageFetchResult> {
    const disk = await this.readDisk(ref.key);
    if (disk) {
      this.memorySet(ref.key, disk);
      return { ok: true, ...disk, source: "disk" };
    }
    if (ref.bytes !== undefined && ref.bytes > this.config.maxBytes) return { ok: false, reason: "too_large" };
    const declared = normalizeImageMime(ref.contentType);
    if (declared && !SUPPORTED_IMAGE_MIME_TYPES.has(declared)) return { ok: false, reason: "unsupported_type" };

    let release: (() => void) | undefined;
    try {
      release = await this.semaphore.acquire(signal);
    } catch {
      return { ok: false, reason: "aborted" };
    }
    try {
      let url = ref.url;
      let result = await this.download(url, declared, signal);
      if (
        !result.ok &&
        "status" in result &&
        (result.status === 403 || result.status === 404) &&
        isExpiredSignedUrl(url, this.now())
      ) {
        const refresher = refreshUrl ?? this.options.refreshUrl;
        const fresh = refresher ? await refresher(ref).catch(() => undefined) : undefined;
        if (fresh && fresh !== url) {
          if (!hostAllowed(fresh, this.allowedHosts)) return { ok: false, reason: "blocked_host" };
          url = fresh;
          result = await this.download(url, declared, signal);
        }
      }
      if (!result.ok) {
        this.options.logger?.debug("Discord image fetch failed", { purpose, reason: result.reason });
        return { ok: false, reason: result.reason };
      }
      const value = { mimeType: result.mimeType, data: result.data };
      this.memorySet(ref.key, value);
      await this.writeDisk(ref.key, value).catch((error: unknown) => {
        this.options.logger?.warn("Discord image disk cache write failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
      return { ok: true, ...value, source: "network" };
    } finally {
      release();
    }
  }

  private async download(
    url: string,
    declared: string | undefined,
    signal: AbortSignal
  ): Promise<
    | { ok: true; mimeType: string; data: Buffer }
    | { ok: false; reason: Exclude<ImageFetchFailure, "blocked_host">; status?: number }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TimeoutError("timeout")), this.config.fetchTimeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const classify = (error: unknown): Exclude<ImageFetchFailure, "blocked_host"> => {
      if (error instanceof TooLargeError) return "too_large";
      if (controller.signal.reason instanceof TimeoutError && !signal.aborted) return "timeout";
      if (signal.aborted) return "aborted";
      return "network";
    };
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: controller.signal, redirect: "error" });
      } catch (error) {
        return { ok: false, reason: classify(error) };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "http_error", status: response.status };
      }
      const mimeType = normalizeImageMime(response.headers.get("content-type")) ?? declared;
      if (!mimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "unsupported_type" };
      }
      const length = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(length) && length > this.config.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      try {
        const data = await readCapped(response, this.config.maxBytes);
        return { ok: true, mimeType, data };
      } catch (error) {
        return { ok: false, reason: classify(error) };
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private memoryGet(key: string): { mimeType: string; data: Buffer } | undefined {
    const value = this.memory.get(key);
    if (!value) return undefined;
    this.memory.delete(key);
    this.memory.set(key, value);
    return value;
  }

  private memorySet(key: string, value: { mimeType: string; data: Buffer }): void {
    const cap = this.config.memoryCacheMb * 1024 * 1024;
    if (value.data.byteLength > cap) return;
    const existing = this.memory.get(key);
    if (existing) {
      this.memory.delete(key);
      this.memoryBytes -= existing.data.byteLength;
    }
    this.memory.set(key, value);
    this.memoryBytes += value.data.byteLength;
    for (const [oldKey, oldValue] of this.memory) {
      if (this.memoryBytes <= cap) break;
      this.memory.delete(oldKey);
      this.memoryBytes -= oldValue.data.byteLength;
    }
  }

  private diskDir(): string {
    return appDataPath(this.options.dataRoot, "cache", "images");
  }

  private diskBase(key: string): string {
    return sha256(key);
  }

  private async readMeta(base: string): Promise<DiskMeta | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.diskDir(), `${base}.json`), "utf8")) as Partial<DiskMeta>;
      if (
        parsed.schemaVersion !== DISK_SCHEMA_VERSION ||
        typeof parsed.key !== "string" ||
        typeof parsed.mimeType !== "string" ||
        typeof parsed.sha256 !== "string" ||
        typeof parsed.fetchedAt !== "string"
      ) {
        return undefined;
      }
      return parsed as DiskMeta;
    } catch {
      return undefined;
    }
  }

  private async readDisk(key: string): Promise<{ mimeType: string; data: Buffer } | undefined> {
    if (this.config.diskCacheMb <= 0) return undefined;
    const base = this.diskBase(key);
    const meta = await this.readMeta(base);
    if (!meta || meta.key !== key) return undefined;
    const fetchedAt = Date.parse(meta.fetchedAt);
    if (!Number.isFinite(fetchedAt) || this.now() - fetchedAt > this.config.diskCacheTtlHours * 3_600_000) {
      await this.removeDisk(base);
      return undefined;
    }
    const binPath = path.join(this.diskDir(), `${base}.bin`);
    try {
      const data = await readFile(binPath);
      if (sha256Buffer(data) !== meta.sha256) {
        await this.removeDisk(base);
        return undefined;
      }
      const touched = new Date(this.now());
      await utimes(binPath, touched, touched).catch(() => undefined);
      return { mimeType: meta.mimeType, data };
    } catch {
      return undefined;
    }
  }

  private async writeDisk(key: string, value: { mimeType: string; data: Buffer }): Promise<void> {
    if (this.config.diskCacheMb <= 0) return;
    const cap = this.config.diskCacheMb * 1024 * 1024;
    if (value.data.byteLength > cap) return;
    const dir = this.diskDir();
    await mkdir(dir, { recursive: true });
    const base = this.diskBase(key);
    const meta: DiskMeta = {
      schemaVersion: DISK_SCHEMA_VERSION,
      key,
      mimeType: value.mimeType,
      bytes: value.data.byteLength,
      sha256: sha256Buffer(value.data),
      fetchedAt: new Date(this.now()).toISOString()
    };
    const tmpBin = path.join(dir, `${base}.${randomUUID()}.tmp`);
    const tmpMeta = path.join(dir, `${base}.${randomUUID()}.tmp`);
    await writeFile(tmpBin, value.data, { mode: 0o600 });
    await rename(tmpBin, path.join(dir, `${base}.bin`));
    await writeFile(tmpMeta, JSON.stringify(meta) + "\n", { mode: 0o600 });
    await rename(tmpMeta, path.join(dir, `${base}.json`));
    if (this.diskBytes === undefined) await this.pruneDisk();
    else {
      this.diskBytes += value.data.byteLength;
      if (this.diskBytes > cap) await this.pruneDisk();
    }
  }

  private async removeDisk(base: string): Promise<void> {
    const dir = this.diskDir();
    await Promise.all([
      rm(path.join(dir, `${base}.bin`), { force: true }),
      rm(path.join(dir, `${base}.json`), { force: true })
    ]).catch(() => undefined);
  }
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new TooLargeError("too large");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
