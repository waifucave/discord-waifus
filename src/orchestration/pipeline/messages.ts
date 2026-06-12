import type { ChatMessage, ResolvedModel } from "@waifucave/gateway";
import {
  ContextMessage,
  formatSelfWaifuContent,
  formatWaifuContextBlock,
} from "../context.js";

type ImageBlockOut = { type: "image"; mimeType: string; data: string };
type UserBlock = { type: "text"; text: string } | ImageBlockOut;

export type WaifuMessageInputs = {
  systemPrompt: string;
  midSystemBlock?: string;
  trailingSystemBlock?: string;
  retryUserMessage?: string;
  selfAuthorIds?: string[];
  messages: ContextMessage[];
};

const systemNote = (content: string) =>
  `<system_note>\n${content}\n</system_note>`;

async function inlineImages(
  message: ContextMessage,
  fetchImpl: typeof fetch
): Promise<ImageBlockOut[]> {
  const blocks: ImageBlockOut[] = [];
  for (const image of message.images ?? []) {
    try {
      const response = await fetchImpl(image.url);
      if (!response.ok) continue;
      const mimeType =
        response.headers.get("content-type")?.split(";")[0] ||
        image.contentType ||
        "image/png";
      const data = Buffer.from(await response.arrayBuffer()).toString("base64");
      blocks.push({ type: "image", mimeType, data });
    } catch {
      // Unreachable image: the textual context (incl. OCR text rendered by
      // formatWaifuContextBlock) is the fallback — same as today's text-only path.
    }
  }
  return blocks;
}

/**
 * The ONE waifu-context builder (replaces the four per-protocol variants in
 * pipelines.ts: contextToChatMessagesForWaifu, contextToResponsesInputForWaifu,
 * contextToAnthropicMessagesForWaifu, contextToGoogleMessagesForWaifu).
 *
 * Role mapping (W2 contract): a context message is SELF iff
 *   authorKind === "waifu" && selfAuthorIds.includes(authorId)
 * → assistant turn with formatSelfWaifuContent (raw body).
 * Everything else → user turn with formatWaifuContextBlock.
 *
 * System placement is capability-driven via the resolved model doc, never
 * per-provider. Models with features.multipleSystemMessages === true get
 * mid/trailing as real {role:"system"} turns; others get user turns wrapped
 * in <system_note> (mirrors today's anthropic/google behavior).
 *
 * Images: fetched and base64-inlined as gateway ImageBlocks. Non-ok/throwing
 * fetch → skip (text context already carries OCR text via formatWaifuContextBlock).
 * Models whose modalities.input lacks "image" never fetch.
 */
export async function buildWaifuMessages(
  model: ResolvedModel,
  inputs: WaifuMessageInputs,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<ChatMessage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const selfIds = new Set(inputs.selfAuthorIds ?? []);
  const midAsSystem = model.features.multipleSystemMessages === true;
  const supportsImages = model.modalities.input.includes("image");

  const context: ChatMessage[] = [];
  for (const message of inputs.messages) {
    const isSelf =
      message.authorKind === "waifu" && selfIds.has(message.authorId);
    if (isSelf) {
      context.push({
        role: "assistant",
        content: formatSelfWaifuContent(message),
      });
      continue;
    }
    const text = formatWaifuContextBlock(message);
    const images = supportsImages
      ? await inlineImages(message, fetchImpl)
      : [];
    context.push(
      images.length > 0
        ? {
            role: "user",
            content: [{ type: "text", text }, ...images] as UserBlock[],
          }
        : { role: "user", content: text }
    );
  }

  const auxTurn = (content: string): ChatMessage =>
    midAsSystem
      ? { role: "system", content }
      : { role: "user", content: systemNote(content) };

  // Inject mid block at context.length - 2 (same anchor as
  // injectMemoriesIntoChatContext in pipelines.ts:1097).
  if (inputs.midSystemBlock) {
    const at = Math.max(0, context.length - 2);
    context.splice(at, 0, auxTurn(inputs.midSystemBlock));
  }

  const out: ChatMessage[] = [
    { role: "system", content: inputs.systemPrompt },
    ...context,
  ];
  if (inputs.trailingSystemBlock) out.push(auxTurn(inputs.trailingSystemBlock));
  if (inputs.retryUserMessage)
    out.push({ role: "user", content: inputs.retryUserMessage });
  return out;
}
