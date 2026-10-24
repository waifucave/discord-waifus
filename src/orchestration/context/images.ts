// Frozen per-context image modes over the ImageFetcher (spec 8.4 freeze rule).
//
// At an image's first render in a context it becomes `inline` iff the model accepts images,
// `inlineImageCount < maxInlineImagesPerEpoch` and the fetch is ok; otherwise it freezes to text:
// "[image: <ocr>]" when OCR text is available at that moment, else "[image]". That exact text is
// what later builds render, so OCR finishing later never rewrites the prefix. `aborted` never
// freezes (the build is abandoned instead). A frozen-inline image that later becomes unobtainable
// renders "[image unavailable]" for that build only (rare, logged).
//
// Decisions are collected here, not written to the state: ContextRuntime persists them in the
// prepare's single write (`decisions()`).

import type { ImageBlock, TextBlock } from "@waifucave/gateway";
import type { Logger } from "../../backend/logger.js";
import type { ImageFetcher } from "../../discord/attachments.js";
import type { ContextState, ImageMode, LedgerEntry } from "../../shared/schemas/context.js";
import type { ImageRef } from "../../shared/schemas/discordMessage.js";
import type { FrozenImages } from "./types.js";

export const IMAGE_PLACEHOLDER = "[image]";
export const IMAGE_UNAVAILABLE = "[image unavailable]";

/**
 * OCR text lookups (ImageOcrService): `cachedText` never runs OCR; the optional `textFor` runs it
 * (bounded by a timeout) for an image that is not cached yet.
 */
export type OcrTextLookup = {
  cachedText(ref: ImageRef): Promise<string | undefined>;
  textFor?(ref: ImageRef, o: { timeoutMs: number; signal?: AbortSignal }): Promise<string | undefined>;
  /** Drop the cached OCR text of these image keys (a deleted message's images, spec 9.5). */
  purge?(keys: readonly string[]): Promise<void>;
};

/**
 * Provider-safe cap on an inline image's raw bytes. Anthropic's Messages API rejects an image over
 * 5 MB, measured on the base64 payload (5 MiB = 5,242,880 chars); base64 is 4/3 of the raw size, so
 * 3.75 MiB of raw bytes is the most that stays under it. An inline image over the cap would be
 * frozen into the epoch prefix and fail every call (compaction included), so it freezes to text
 * (reason `too_large`) instead, whatever `discord.images.maxBytes` allows the fetcher.
 */
export const MAX_INLINE_IMAGE_BYTES = 3_932_160;

/** Default wait for OCR of a not-yet-frozen image when the model cannot take images. */
export const DEFAULT_OCR_FREEZE_TIMEOUT_MS = 4_000;

export type FrozenImagesOptions = {
  fetcher: ImageFetcher;
  acceptsImages: boolean;
  maxInlinePerEpoch: number;
  ocr?: OcrTextLookup;
  /** Wait for `ocr.textFor` before freezing an image to text (text-only models only). */
  ocrTimeoutMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  refreshUrl?: (entry: LedgerEntry, ref: ImageRef) => Promise<string | undefined>;
};

export class ImageBuildAbortedError extends Error {
  override name = "AbortError";
}

/** "[image: <ocr>]" with whitespace collapsed, or "[image]". */
export function imageTextFor(ocrText: string | undefined): string {
  const text = (ocrText ?? "").replace(/\s+/g, " ").trim();
  return text ? `[image: ${text}]` : IMAGE_PLACEHOLDER;
}

export class FrozenImageRenderer implements FrozenImages {
  private readonly pending = new Map<string, ImageMode>();
  private inlineAdded = 0;

  constructor(private readonly o: FrozenImagesOptions) {}

  async blocksFor(entry: LedgerEntry, state: ContextState): Promise<Array<TextBlock | ImageBlock>> {
    const blocks: Array<TextBlock | ImageBlock> = [];
    for (const ref of entry.images) {
      const mode = state.imageModes[ref.key] ?? this.pending.get(ref.key);
      if (mode?.mode === "text") {
        blocks.push({ type: "text", text: mode.text });
        continue;
      }
      if (mode?.mode === "inline") {
        const result = await this.fetch(entry, ref);
        if (result) blocks.push(result);
        else {
          this.o.logger?.warn("Frozen inline image is no longer obtainable", { messageId: entry.id });
          blocks.push({ type: "text", text: IMAGE_UNAVAILABLE });
        }
        continue;
      }
      const canInline = this.o.acceptsImages && state.inlineImageCount + this.inlineAdded < this.o.maxInlinePerEpoch;
      if (canInline) {
        const result = await this.fetch(entry, ref);
        if (result) {
          this.pending.set(ref.key, { mode: "inline" });
          this.inlineAdded += 1;
          blocks.push(result);
          continue;
        }
      }
      const text = imageTextFor(await this.ocrText(ref));
      this.pending.set(ref.key, { mode: "text", text });
      blocks.push({ type: "text", text });
    }
    return blocks;
  }

  /**
   * The text an image freezes to. A model that cannot take images only ever sees this text, so
   * for it OCR runs now (bounded) when nothing is cached; otherwise the cached text, if any.
   * Freezing happens once, at first render, so a slow OCR never rewrites the prefix later.
   */
  private async ocrText(ref: ImageRef): Promise<string | undefined> {
    const ocr = this.o.ocr;
    if (!ocr) return undefined;
    const cached = await ocr.cachedText(ref).catch(() => undefined);
    if (cached || this.o.acceptsImages || !ocr.textFor) return cached;
    const text = await ocr
      .textFor(ref, { timeoutMs: this.o.ocrTimeoutMs ?? DEFAULT_OCR_FREEZE_TIMEOUT_MS, ...(this.o.signal ? { signal: this.o.signal } : {}) })
      .catch(() => undefined);
    // An abort while OCR ran must not freeze "[image]" for good.
    if (this.o.signal?.aborted) throw new ImageBuildAbortedError("Image OCR aborted; nothing frozen.");
    return text;
  }

  /** Modes decided during this build (to persist) and how many of them are inline. */
  decisions(): { imageModes: Record<string, ImageMode>; inlineAdded: number } {
    return { imageModes: Object.fromEntries(this.pending), inlineAdded: this.inlineAdded };
  }

  private async fetch(entry: LedgerEntry, ref: ImageRef): Promise<ImageBlock | undefined> {
    if (ref.bytes !== undefined && ref.bytes > MAX_INLINE_IMAGE_BYTES) return this.tooLarge(entry, ref.bytes);
    const refresh = this.o.refreshUrl;
    const result = await this.o.fetcher.get(ref, {
      signal: this.o.signal,
      purpose: "inline",
      ...(refresh ? { refreshUrl: (r: ImageRef) => refresh(entry, r) } : {})
    });
    if (result.ok) {
      if (result.data.length > MAX_INLINE_IMAGE_BYTES) return this.tooLarge(entry, result.data.length);
      return { type: "image", mimeType: result.mimeType, data: result.data.toString("base64") };
    }
    if (result.reason === "aborted") throw new ImageBuildAbortedError("Image fetch aborted; nothing frozen.");
    return undefined;
  }

  /**
   * Over the provider-safe inline cap: never inline. A new image freezes to text; one frozen
   * inline before the cap existed renders "[image unavailable]" so it cannot break the epoch.
   */
  private tooLarge(entry: LedgerEntry, bytes: number): undefined {
    this.o.logger?.debug("Image over the provider-safe inline cap; using text", {
      messageId: entry.id,
      reason: "too_large",
      bytes,
      maxInlineBytes: MAX_INLINE_IMAGE_BYTES
    });
    return undefined;
  }
}
