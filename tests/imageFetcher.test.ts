import { readdir, stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachmentKey,
  DiscordImageFetcher,
  isExpiredSignedUrl,
  type DiscordImageFetcherOptions
} from "../src/discord/attachments.js";
import { appDataPath } from "../src/config/paths.js";
import { sharedImageFetcherConfig } from "../src/discord/attachments.js";
import { DEFAULT_APP_CONFIG } from "../src/shared/schemas/config.js";
import {
  decideImageMode,
  ImageBuildAbortedError,
  imageTextFor,
  inlineImageBlock,
  MAX_INLINE_IMAGE_BYTES
} from "../src/orchestration/context/images.js";
import type { ImageRef } from "../src/shared/schemas/discordMessage.js";
import { FakeImageFetcher, quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

async function root(): Promise<string> {
  const dir = await makeTempRoot();
  roots.push(dir);
  return dir;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const url = (id: string, query = "ex=ffffffff&is=1&hm=abc") => `https://cdn.discordapp.com/attachments/200/${id}/a.png?${query}`;
const ref = (id: string, extra: Partial<ImageRef> = {}): ImageRef => ({ key: attachmentKey(url(id)), url: url(id), ...extra });

type Handler = (url: string, init: RequestInit) => Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (body: Buffer = PNG, headers: Record<string, string> = { "content-type": "image/png" }) =>
  new Response(new Uint8Array(body), { status: 200, headers });

async function fetcher(o: Partial<DiscordImageFetcherOptions> & { handler: Handler; dataRoot?: string }) {
  const f = fakeFetch(o.handler);
  const dataRoot = o.dataRoot ?? (await root());
  return { fetcher: new DiscordImageFetcher({ ...o, dataRoot, fetch: f.impl }), calls: f.calls, dataRoot };
}

describe("attachmentKey", () => {
  it("is stable across re-signed URLs and uses the attachment id", () => {
    expect(attachmentKey(url("42", "ex=1&is=2&hm=3"))).toBe("att:42");
    expect(attachmentKey(url("42", "ex=9&is=8&hm=7"))).toBe("att:42");
    expect(attachmentKey("https://media.discordapp.net/attachments/1/42/x.png?width=100")).toBe("att:42");
    expect(attachmentKey("https://anything", "77")).toBe("att:77");
  });

  it("hashes origin + pathname for other URLs, never the query", () => {
    const a = attachmentKey("https://cdn.discordapp.com/emojis/9.png?size=48");
    expect(a).toMatch(/^url:[0-9a-f]{64}$/);
    expect(attachmentKey("https://cdn.discordapp.com/emojis/9.png?size=96")).toBe(a);
    expect(attachmentKey("https://evil.example/attachments/1/42/x.png")).not.toBe("att:42");
  });

  it("detects expired signed URLs from the hex ex parameter", () => {
    expect(isExpiredSignedUrl(url("1", "ex=1"), Date.now())).toBe(true);
    expect(isExpiredSignedUrl(url("1", "ex=ffffffff"), Date.now())).toBe(false);
    expect(isExpiredSignedUrl("https://cdn.discordapp.com/x.png", Date.now())).toBe(false);
  });
});

describe("DiscordImageFetcher", () => {
  it("blocks hosts outside the allowlist and non-https URLs without fetching", async () => {
    const { fetcher: f, calls } = await fetcher({ handler: async () => ok() });
    for (const bad of ["https://evil.example/a.png", "http://cdn.discordapp.com/attachments/1/2/a.png", "file:///etc/passwd"]) {
      expect(await f.get({ key: attachmentKey(bad), url: bad }, { purpose: "inline" })).toEqual({ ok: false, reason: "blocked_host" });
    }
    expect(calls).toEqual([]);
  });

  it("fetches, then serves from memory", async () => {
    const { fetcher: f, calls } = await fetcher({ handler: async () => ok() });
    const first = await f.get(ref("1"), { purpose: "inline" });
    expect(first).toMatchObject({ ok: true, mimeType: "image/png", source: "network" });
    const second = await f.get(ref("1"), { purpose: "ocr" });
    expect(second).toMatchObject({ ok: true, source: "memory" });
    expect(calls).toHaveLength(1);
  });

  it("enforces the size cap on declared size, Content-Length and the streamed body", async () => {
    const big = Buffer.alloc(2048, 1);
    const { fetcher: f, calls } = await fetcher({
      config: { maxBytes: 1024 },
      handler: async (u) =>
        u.includes("/2/")
          ? ok(big, { "content-type": "image/png", "content-length": String(big.byteLength) })
          : new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(big)); c.close(); } }), { headers: { "content-type": "image/png" } })
    });
    expect(await f.get(ref("1", { bytes: 4096 }), { purpose: "inline" })).toEqual({ ok: false, reason: "too_large" });
    expect(calls).toHaveLength(0);
    expect(await f.get(ref("2"), { purpose: "inline" })).toEqual({ ok: false, reason: "too_large" });
    expect(await f.get(ref("3"), { purpose: "inline" })).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects unsupported types (declared or served)", async () => {
    const { fetcher: f, calls } = await fetcher({ handler: async () => ok(PNG, { "content-type": "text/html" }) });
    expect(await f.get(ref("1", { contentType: "image/svg+xml" }), { purpose: "inline" })).toEqual({ ok: false, reason: "unsupported_type" });
    expect(calls).toHaveLength(0);
    expect(await f.get(ref("2"), { purpose: "inline" })).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("maps HTTP errors, network errors and timeouts", async () => {
    const { fetcher: f } = await fetcher({
      config: { fetchTimeoutMs: 30 },
      handler: (u, init) => {
        if (u.includes("/1/")) return Promise.resolve(new Response("no", { status: 500 }));
        if (u.includes("/2/")) return Promise.reject(new TypeError("fetch failed"));
        return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
    });
    expect(await f.get(ref("1"), { purpose: "inline" })).toEqual({ ok: false, reason: "http_error" });
    expect(await f.get(ref("2"), { purpose: "inline" })).toEqual({ ok: false, reason: "network" });
    expect(await f.get(ref("3"), { purpose: "inline" })).toEqual({ ok: false, reason: "timeout" });
  });

  it("single-flights per key with ref-counted abort", async () => {
    let release!: () => void;
    let networkSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetcher: f, calls } = await fetcher({
      handler: async (_u, init) => {
        networkSignal = init.signal ?? undefined;
        await gate;
        if (init.signal?.aborted) throw new Error("aborted");
        return ok();
      }
    });
    const a = new AbortController();
    const first = f.get(ref("1"), { purpose: "inline", signal: a.signal });
    const second = f.get(ref("1"), { purpose: "ocr" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.abort();
    expect(await first).toEqual({ ok: false, reason: "aborted" });
    expect(networkSignal?.aborted).toBe(false); // another waiter still wants it
    release();
    expect(await second).toMatchObject({ ok: true, source: "network" });
    expect(calls).toHaveLength(1);
  });

  it("aborts the network fetch when every waiter gave up", async () => {
    let networkSignal: AbortSignal | undefined;
    const { fetcher: f } = await fetcher({
      handler: (_u, init) => {
        networkSignal = init.signal ?? undefined;
        return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = f.get(ref("1"), { purpose: "inline", signal: a.signal });
    const second = f.get(ref("1"), { purpose: "inline", signal: b.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.abort();
    expect(networkSignal?.aborted).toBe(false);
    b.abort();
    expect(await first).toEqual({ ok: false, reason: "aborted" });
    expect(await second).toEqual({ ok: false, reason: "aborted" });
    expect(networkSignal?.aborted).toBe(true);
  });

  it("disk cache survives a new instance byte-identically (0600 files)", async () => {
    const dataRoot = await root();
    const body = Buffer.from("exact-bytes-of-an-image");
    const one = await fetcher({ dataRoot, handler: async () => ok(body, { "content-type": "image/webp" }) });
    const first = await one.fetcher.get(ref("1"), { purpose: "inline" });
    const two = await fetcher({ dataRoot, handler: async () => { throw new Error("must not fetch"); } });
    // A re-signed URL for the same attachment still hits the disk entry.
    const second = await two.fetcher.get({ key: attachmentKey(url("1", "ex=1&is=2&hm=zz")), url: url("1", "ex=1&is=2&hm=zz") }, { purpose: "inline" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.source).toBe("disk");
      expect(second.mimeType).toBe("image/webp");
      expect(Buffer.compare(second.data, first.data)).toBe(0);
    }
    const dir = appDataPath(dataRoot, "cache", "images");
    const files = await readdir(dir);
    expect(files.filter((n) => n.endsWith(".bin"))).toHaveLength(1);
    for (const name of files) expect((await stat(`${dir}/${name}`)).mode & 0o777).toBe(0o600);
  });

  it("expires disk entries after the TTL and evicts LRU beyond the byte cap", async () => {
    const dataRoot = await root();
    let now = Date.now();
    const big = Buffer.alloc(600 * 1024, 7);
    const { fetcher: f, calls } = await fetcher({
      dataRoot,
      now: () => now,
      config: { diskCacheMb: 1, memoryCacheMb: 0, diskCacheTtlHours: 1 },
      handler: async () => ok(big)
    });
    await f.get(ref("1"), { purpose: "inline" });
    now += 1000;
    await f.get(ref("2"), { purpose: "inline" }); // 1.2 MB > 1 MB cap → "1" evicted
    const bins = (await readdir(appDataPath(dataRoot, "cache", "images"))).filter((n) => n.endsWith(".bin"));
    expect(bins).toHaveLength(1);
    expect(await f.get(ref("2"), { purpose: "inline" })).toMatchObject({ source: "disk" });
    now += 2 * 3_600_000;
    expect(await f.get(ref("2"), { purpose: "inline" })).toMatchObject({ source: "network" });
    expect(calls).toHaveLength(3);
  });

  it("refreshes an expired signed URL once through the hook", async () => {
    const expired = url("5", "ex=1&is=1&hm=old");
    const fresh = url("5", "ex=ffffffff&is=2&hm=new");
    const refreshed: string[] = [];
    const { fetcher: f, calls } = await fetcher({
      handler: async (u) => (u === expired ? new Response("gone", { status: 403 }) : ok()),
      refreshUrl: async (r) => {
        refreshed.push(r.key);
        return fresh;
      }
    });
    expect(await f.get({ key: attachmentKey(expired), url: expired }, { purpose: "inline" })).toMatchObject({ ok: true });
    expect(refreshed).toEqual(["att:5"]);
    expect(calls).toEqual([expired, fresh]);

    // A 403 on an unexpired URL is a plain http_error (no refresh).
    const { fetcher: g } = await fetcher({ handler: async () => new Response("no", { status: 403 }), refreshUrl: async () => fresh });
    expect(await g.get(ref("6"), { purpose: "inline" })).toEqual({ ok: false, reason: "http_error" });
  });
});

describe("decideImageMode freeze rule (Living cast §5.3)", () => {
  const unlimited = () => true;
  const label = (decided: { mode: "inline" } | { mode: { text: string } }) => (decided.mode === "inline" ? "inline" : decided.mode.text);

  it("inlines while the epoch budget allows, then freezes to OCR text or [image]", async () => {
    const images = new FakeImageFetcher();
    let inlineLeft = 1;
    const o = {
      fetcher: images,
      acceptsImages: true,
      allowInline: () => inlineLeft-- > 0,
      ocr: { cachedText: async (image: ImageRef) => (image.key === "att:3" ? "SALE\n50%  off" : undefined) }
    };
    const decided = [];
    for (const id of ["1", "2", "3"]) decided.push(label(await decideImageMode(ref(id), o)));
    expect(decided).toEqual(["inline", "[image]", "[image: SALE 50% off]"]);
  });

  it.each(["too_large", "unsupported_type", "http_error", "timeout", "network", "blocked_host"] as const)(
    "%s freezes to text",
    async (reason) => {
      const images = new FakeImageFetcher();
      images.failKeys.set("att:1", reason);
      expect(await decideImageMode(ref("1"), { fetcher: images, acceptsImages: true, allowInline: unlimited })).toEqual({ mode: { text: "[image]" } });
    }
  );

  it("aborted never freezes (the build fails instead)", async () => {
    const images = new FakeImageFetcher();
    images.failKeys.set("att:1", "aborted");
    await expect(decideImageMode(ref("1"), { fetcher: images, acceptsImages: true, allowInline: unlimited })).rejects.toBeInstanceOf(ImageBuildAbortedError);
  });

  it("runs OCR (bounded) for a text-only model when nothing is cached yet; a vision model only uses cached text", async () => {
    const images = new FakeImageFetcher();
    const calls: Array<{ key: string; timeoutMs: number }> = [];
    const ocr = {
      cachedText: async () => undefined,
      textFor: async (image: { key: string }, o: { timeoutMs: number }) => {
        calls.push({ key: image.key, timeoutMs: o.timeoutMs });
        return "MENU\n  ramen 9€";
      }
    };
    expect(await decideImageMode(ref("1"), { fetcher: images, acceptsImages: false, allowInline: unlimited, ocr, ocrTimeoutMs: 1500 })).toEqual({
      mode: { text: "[image: MENU ramen 9€]" }
    });
    expect(calls).toEqual([{ key: "att:1", timeoutMs: 1500 }]);
    expect(images.calls).toHaveLength(0);
    calls.length = 0;
    images.failKeys.set("att:2", "http_error");
    expect(await decideImageMode(ref("2"), { fetcher: images, acceptsImages: true, allowInline: unlimited, ocr })).toEqual({ mode: { text: "[image]" } });
    expect(calls).toEqual([]);
  });

  it("does not freeze an image whose OCR was cut short by an abort", async () => {
    const controller = new AbortController();
    const ocr = {
      cachedText: async () => undefined,
      textFor: async () => {
        controller.abort();
        return undefined;
      }
    };
    await expect(
      decideImageMode(ref("1"), { fetcher: new FakeImageFetcher(), acceptsImages: false, allowInline: unlimited, ocr, signal: controller.signal })
    ).rejects.toBeInstanceOf(ImageBuildAbortedError);
  });

  // Acceptance I1: an inline image over the provider's per-image limit would fail every call of
  // the epoch; it must freeze to text instead.
  it("freezes an image over the provider-safe inline cap to text (OCR text when available)", async () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(3_932_160);
    expect(Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
    const images = new FakeImageFetcher();
    images.sizes.set("att:1", MAX_INLINE_IMAGE_BYTES + 1);
    images.sizes.set("att:2", MAX_INLINE_IMAGE_BYTES);
    images.sizes.set("att:3", 6 * 1024 * 1024);
    const debug: unknown[] = [];
    const logger = { ...quietLogger(), debug: (_m: string, context?: unknown) => void debug.push(context) };
    const o = {
      fetcher: images,
      acceptsImages: true,
      allowInline: unlimited,
      logger,
      ocr: { cachedText: async (image: ImageRef) => (image.key === "att:3" ? "big poster" : undefined) }
    };
    const decided = [];
    for (const id of ["1", "2", "3"]) decided.push(label(await decideImageMode(ref(id), o)));
    expect(decided).toEqual(["[image]", "inline", "[image: big poster]"]);
    expect(debug).toEqual([
      expect.objectContaining({ reason: "too_large", bytes: MAX_INLINE_IMAGE_BYTES + 1 }),
      expect.objectContaining({ reason: "too_large", bytes: 6 * 1024 * 1024 })
    ]);
  });

  it("skips the fetch when the attachment's declared size is over the inline cap", async () => {
    const images = new FakeImageFetcher();
    const big = ref("1", { bytes: MAX_INLINE_IMAGE_BYTES + 1 });
    expect(await decideImageMode(big, { fetcher: images, acceptsImages: true, allowInline: unlimited })).toEqual({ mode: { text: "[image]" } });
    expect(images.calls).toHaveLength(0);
  });

  it("re-resolving an inline image reports a lost one as undefined (the caller compacts), never a substitute", async () => {
    const images = new FakeImageFetcher();
    const fetched = await inlineImageBlock(ref("1"), { fetcher: images });
    expect(fetched?.block).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png:att:1").toString("base64") } });
    images.failKeys.set("att:2", "http_error");
    expect(await inlineImageBlock(ref("2"), { fetcher: images })).toBeUndefined();
    images.sizes.set("att:3", 7 * 1024 * 1024);
    expect(await inlineImageBlock(ref("3"), { fetcher: images })).toBeUndefined();
  });

  it("imageTextFor collapses whitespace", () => {
    expect(imageTextFor("  a\n b  ")).toBe("[image: a b]");
    expect(imageTextFor(undefined)).toBe("[image]");
  });
});

describe("sharedImageFetcherConfig", () => {
  const images = DEFAULT_APP_CONFIG.discord.images;
  const ocr = DEFAULT_APP_CONFIG.ocr;

  it("takes the max of discord.images and the legacy ocr limits", () => {
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const config = sharedImageFetcherConfig(
      { discord: { images: { ...images, maxBytes: 1_000, fetchTimeoutMs: 1_000 } }, ocr: { ...ocr, maxImageBytes: 9_000_000, timeoutMs: 20_000 } },
      logger
    );
    expect(config.maxBytes).toBe(9_000_000);
    expect(config.fetchTimeoutMs).toBe(20_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ocr.maxImageBytes and ocr.timeoutMs");
  });

  // Acceptance I1: at defaults the legacy 8 MiB OCR limit used to win over discord.images (5 MiB),
  // so lowering discord.images.maxBytes did nothing.
  it("ignores legacy ocr values left at their defaults, so discord.images is authoritative", () => {
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    expect(sharedImageFetcherConfig({ discord: { images }, ocr }, logger)).toMatchObject({
      maxBytes: images.maxBytes,
      fetchTimeoutMs: images.fetchTimeoutMs
    });
    const lowered = sharedImageFetcherConfig({ discord: { images: { ...images, maxBytes: 1_000_000, fetchTimeoutMs: 600 } }, ocr }, logger);
    expect(lowered.maxBytes).toBe(1_000_000);
    expect(lowered.fetchTimeoutMs).toBe(600);
    expect(warnings).toEqual([]);
  });

  it("a customised legacy value below discord.images neither raises the limit nor warns", () => {
    const warnings: string[] = [];
    const config = sharedImageFetcherConfig(
      { discord: { images }, ocr: { ...ocr, maxImageBytes: 2_000_000, timeoutMs: 1_000 } },
      { warn: (message: string) => warnings.push(message) }
    );
    expect(config.maxBytes).toBe(images.maxBytes);
    expect(config.fetchTimeoutMs).toBe(images.fetchTimeoutMs);
    expect(warnings).toEqual([]);
  });

  it("keeps discord.images when it is larger, and does not warn for default ocr values", () => {
    const warnings: string[] = [];
    const config = sharedImageFetcherConfig(
      { discord: { images: { ...images, maxBytes: 50_000_000, fetchTimeoutMs: 60_000 } }, ocr },
      { warn: (message: string) => warnings.push(message) }
    );
    expect(config.maxBytes).toBe(50_000_000);
    expect(config.fetchTimeoutMs).toBe(60_000);
    expect(warnings).toEqual([]);
  });
});
