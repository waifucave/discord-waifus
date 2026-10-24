// Image fetch and OCR freeze for lives (Living cast spec §5.3, §6.2), kept from the Phase 4 frozen
// image renderer and rewritten over the life-owned image modes.
//
// An image's mode is decided ONCE, when the tool result that shows it is created, and stored in
// that result: `"inline"` (sent as an image block) or `{text}` ("[image: <ocr>]" / "[image]").
// Later builds resolve an inline image through the fetcher again; one that can no longer be
// fetched is reported (undefined) so the caller can force a compaction, never substituted in place.
// `aborted` never freezes anything (the build is abandoned instead).

import type { ContentBlockLike } from "@yanlinglabs/winter-provider-runtime";
import type { Logger } from "../../backend/logger.js";
import type { ImageFetcher } from "../../discord/attachments.js";
import type { ImageRef } from "../../shared/schemas/discordMessage.js";

export const IMAGE_PLACEHOLDER = "[image]";

/** A life-owned image mode (spec §5.3). */
export type LifeImageMode = "inline" | { text: string };

export type ImageContentBlock = Extract<ContentBlockLike, { type: "image" }>;

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
 * 3.75 MiB of raw bytes is the most that stays under it. A larger image freezes to text instead.
 */
export const MAX_INLINE_IMAGE_BYTES = 3_932_160;

/** Default wait for OCR of an image that freezes to text on a model that cannot take images. */
export const DEFAULT_OCR_FREEZE_TIMEOUT_MS = 4_000;

export class ImageBuildAbortedError extends Error {
  override name = "AbortError";
}

/** "[image: <ocr>]" with whitespace collapsed, or "[image]". */
export function imageTextFor(ocrText: string | undefined): string {
  const text = (ocrText ?? "").replace(/\s+/g, " ").trim();
  return text ? `[image: ${text}]` : IMAGE_PLACEHOLDER;
}

export type ImageFetchOptions = {
  fetcher: ImageFetcher;
  signal?: AbortSignal;
  logger?: Pick<Logger, "debug" | "warn">;
  /** A fresh CDN URL for an expired attachment link. */
  refreshUrl?: (ref: ImageRef) => Promise<string | undefined>;
};

/** The inline image block for `ref`, or undefined when it cannot be fetched or is over the cap. */
export async function inlineImageBlock(ref: ImageRef, o: ImageFetchOptions): Promise<{ block: ImageContentBlock; bytes: number } | undefined> {
  if (ref.bytes !== undefined && ref.bytes > MAX_INLINE_IMAGE_BYTES) return tooLarge(ref.bytes, o);
  const result = await o.fetcher.get(ref, {
    signal: o.signal,
    purpose: "inline",
    ...(o.refreshUrl ? { refreshUrl: o.refreshUrl } : {})
  });
  if (result.ok) {
    if (result.data.length > MAX_INLINE_IMAGE_BYTES) return tooLarge(result.data.length, o);
    return {
      block: { type: "image", source: { type: "base64", media_type: result.mimeType, data: result.data.toString("base64") } },
      bytes: result.data.length
    };
  }
  if (result.reason === "aborted") throw new ImageBuildAbortedError("Image fetch aborted; nothing frozen.");
  return undefined;
}

function tooLarge(bytes: number, o: ImageFetchOptions): undefined {
  o.logger?.debug("Image over the provider-safe inline cap; using text", {
    reason: "too_large",
    bytes,
    maxInlineBytes: MAX_INLINE_IMAGE_BYTES
  });
  return undefined;
}

export type ImageModeOptions = ImageFetchOptions & {
  /** The route reads images. */
  acceptsImages: boolean;
  /** The epoch's inline budget still allows one more image of `bytes` (count and byte caps). */
  allowInline: (bytes: number) => boolean;
  ocr?: OcrTextLookup;
  ocrTimeoutMs?: number;
};

export type DecidedImage =
  | { mode: "inline"; block: ImageContentBlock; bytes: number }
  | { mode: { text: string } };

/**
 * Decides an image's mode at its first occurrence: inline when the route reads images, the budget
 * allows it and the fetch succeeds; otherwise the frozen text. A model that cannot read images gets
 * OCR now (bounded) when nothing is cached, so the text never changes later.
 */
export async function decideImageMode(ref: ImageRef, o: ImageModeOptions): Promise<DecidedImage> {
  if (o.acceptsImages) {
    const fetched = await inlineImageBlock(ref, o);
    if (fetched && o.allowInline(fetched.bytes)) return { mode: "inline", ...fetched };
  }
  return { mode: { text: imageTextFor(await ocrText(ref, o)) } };
}

async function ocrText(ref: ImageRef, o: ImageModeOptions): Promise<string | undefined> {
  const ocr = o.ocr;
  if (!ocr) return undefined;
  const cached = await ocr.cachedText(ref).catch(() => undefined);
  if (cached || o.acceptsImages || !ocr.textFor) return cached;
  const text = await ocr
    .textFor(ref, { timeoutMs: o.ocrTimeoutMs ?? DEFAULT_OCR_FREEZE_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) })
    .catch(() => undefined);
  // An abort while OCR ran must not freeze "[image]" for good.
  if (o.signal?.aborted) throw new ImageBuildAbortedError("Image OCR aborted; nothing frozen.");
  return text;
}
