// Building a life request (Living cast spec §5.3, §5.4): system blocks A and B from the epoch's
// snapshot, every log message of the epoch in order (images resolved through the fetcher), and
// the epoch's tools. Nothing already sent is ever changed, so each request is a prefix of the next.

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { CuratedModel } from "../models/catalog.js";
import type { ModelTool } from "../models/client.js";
import { imageTextFor, inlineImageBlock, ImageBuildAbortedError } from "../orchestration/context/images.js";
import { estimateTokens } from "../orchestration/context/tokens.js";
import { LifeImageBlockSchema, type LifeLogLine, type LifeState } from "../shared/schemas/life.js";
import type { LifeDeps } from "./deps.js";
import { buildBlockB } from "./lifeHarness.js";
import { modelTools } from "./tools/index.js";

/** A pinned inline image could not be fetched again: the epoch must end (§5.3). */
export class PinnedImageMissingError extends Error {
  override name = "PinnedImageMissingError";
  constructor(readonly key: string) {
    super("A pinned image of this epoch can no longer be fetched.");
  }
}

export type LifeRequest = {
  system: string[];
  messages: ProviderMessageLike[];
  tools: ModelTool[];
  imageCount: number;
  /** Keys of the inline images this epoch shows (pinned in the image cache). */
  imageKeys: string[];
};

/** [A, B] for the epoch. */
export function lifeSystem(state: LifeState): string[] {
  const snapshot = state.systemSnapshot;
  if (!snapshot) throw new Error("The life has no system snapshot yet.");
  return [snapshot.harness, buildBlockB({ memoryIndex: snapshot.memoryIndex, summary: state.summary, places: snapshot.places })];
}

type Resolve = { images: number; keys: string[] };

async function resolveBlock(
  block: unknown,
  deps: LifeDeps,
  o: { missing: "throw" | "text"; signal?: AbortSignal; acceptsImages: boolean },
  count: Resolve
): Promise<ContentBlockLike> {
  const image = LifeImageBlockSchema.safeParse(block);
  if (image.success) {
    const value = image.data;
    if (value.mode !== "inline") return { type: "text", text: value.mode.text };
    if (!o.acceptsImages) return { type: "text", text: imageTextFor(await deps.ocr?.cachedText(value.attachment).catch(() => undefined)) };
    const fetched = deps.images
      ? await inlineImageBlock(value.attachment, { fetcher: deps.images, ...(o.signal ? { signal: o.signal } : {}), logger: deps.logger })
      : undefined;
    if (!fetched) {
      if (o.missing === "throw") throw new PinnedImageMissingError(value.attachment.key);
      return { type: "text", text: imageTextFor(await deps.ocr?.cachedText(value.attachment).catch(() => undefined)) };
    }
    count.images += 1;
    count.keys.push(value.attachment.key);
    return fetched.block;
  }
  const typed = block as ContentBlockLike;
  if (typed.type === "tool_result" && Array.isArray(typed.content)) {
    const inner: ContentBlockLike[] = [];
    for (const part of typed.content) inner.push(await resolveBlock(part, deps, o, count));
    return { ...typed, content: inner };
  }
  return typed;
}

/** One stored log message as a winter message (images resolved). */
async function resolveMessage(
  stored: Record<string, unknown>,
  deps: LifeDeps,
  o: { missing: "throw" | "text"; signal?: AbortSignal; acceptsImages: boolean },
  count: Resolve
): Promise<ProviderMessageLike> {
  const message = stored as unknown as ProviderMessageLike;
  if (typeof message.content === "string") return message;
  const content: ContentBlockLike[] = [];
  for (const block of message.content) content.push(await resolveBlock(block, deps, o, count));
  return { ...message, content };
}

/** The log's messages (boundary lines carry none). */
export function logMessages(lines: readonly LifeLogLine[]): Array<Record<string, unknown>> {
  return lines.flatMap((line) => (line.message ? [line.message] : []));
}

export async function buildLifeRequest(
  deps: LifeDeps,
  o: { state: LifeState; lines: readonly LifeLogLine[]; route: CuratedModel; missing?: "throw" | "text"; signal?: AbortSignal; extra?: ProviderMessageLike[] }
): Promise<LifeRequest> {
  const count: Resolve = { images: 0, keys: [] };
  const options = { missing: o.missing ?? "throw", ...(o.signal ? { signal: o.signal } : {}), acceptsImages: o.route.imageInput };
  const messages: ProviderMessageLike[] = [];
  for (const stored of logMessages(o.lines)) {
    if (o.signal?.aborted) throw new ImageBuildAbortedError("Request build aborted.");
    messages.push(await resolveMessage(stored, deps, options, count));
  }
  if (o.extra) messages.push(...o.extra);
  return {
    system: lifeSystem(o.state),
    messages,
    tools: modelTools(o.state.systemSnapshot?.tools ?? []).map((tool) => ({
      ...tool,
      description: o.state.systemSnapshot?.toolDescriptions?.[tool.name] ?? tool.description,
      inputSchema: o.state.systemSnapshot?.toolSchemas?.[tool.name] ?? tool.inputSchema
    })),
    imageCount: count.images,
    imageKeys: count.keys
  };
}

/** The pre-flight estimate of a request (calibrated). */
export function estimateRequest(request: Pick<LifeRequest, "system" | "messages" | "tools">, ratio?: number): number {
  return estimateTokens(request.messages, { system: request.system, tools: request.tools, ...(ratio !== undefined ? { ratio } : {}) });
}

const DEFAULT_WINDOW = 128_000;
const OUTPUT_RESERVE_CAP = 8_192;

/** The compaction budget (§5.4): min(life.maxContextTokens, window − output reserve). */
export function lifeBudget(route: Pick<CuratedModel, "contextWindow" | "maxOutputTokens">, maxContextTokens: number): number {
  const window = route.contextWindow ?? DEFAULT_WINDOW;
  const reserve = Math.min(route.maxOutputTokens ?? OUTPUT_RESERVE_CAP, OUTPUT_RESERVE_CAP);
  return Math.max(1_000, Math.min(maxContextTokens, window - reserve));
}
