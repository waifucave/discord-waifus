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

/** Cached OCR text for an image, without running OCR (ImageOcrService.cachedText). */
export type OcrTextLookup = { cachedText(ref: ImageRef): Promise<string | undefined> };

export type FrozenImagesOptions = {
  fetcher: ImageFetcher;
  acceptsImages: boolean;
  maxInlinePerEpoch: number;
  ocr?: OcrTextLookup;
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
      const text = imageTextFor(await this.o.ocr?.cachedText(ref).catch(() => undefined));
      this.pending.set(ref.key, { mode: "text", text });
      blocks.push({ type: "text", text });
    }
    return blocks;
  }

  /** Modes decided during this build (to persist) and how many of them are inline. */
  decisions(): { imageModes: Record<string, ImageMode>; inlineAdded: number } {
    return { imageModes: Object.fromEntries(this.pending), inlineAdded: this.inlineAdded };
  }

  private async fetch(entry: LedgerEntry, ref: ImageRef): Promise<ImageBlock | undefined> {
    const refresh = this.o.refreshUrl;
    const result = await this.o.fetcher.get(ref, {
      signal: this.o.signal,
      purpose: "inline",
      ...(refresh ? { refreshUrl: (r: ImageRef) => refresh(entry, r) } : {})
    });
    if (result.ok) return { type: "image", mimeType: result.mimeType, data: result.data.toString("base64") };
    if (result.reason === "aborted") throw new ImageBuildAbortedError("Image fetch aborted; nothing frozen.");
    return undefined;
  }
}
