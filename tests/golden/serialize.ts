// Readable, deterministic serialization of the requests a life sends (Living cast spec §12): golden
// files live in tests/golden/__snapshots__/ and are reviewed by the owner as plain-text diffs. Images
// show as MIME type, size and a short content hash; thinking shows its text and the signature length.
// Not a test file.

import { createHash } from "node:crypto";
import type { TurnRequest } from "@yanlinglabs/winter-provider-runtime";

type Block = { type: string; [key: string]: unknown };

function blockLines(block: Block): string[] {
  switch (block.type) {
    case "text":
      return ["--- text ---", String(block["text"])];
    case "tool_use":
      return [`--- tool call ${String(block["name"])} (${String(block["id"])}) ---`, JSON.stringify(block["input"])];
    case "tool_result": {
      const content = block["content"];
      const body = typeof content === "string" ? [content] : Array.isArray(content) ? (content as Block[]).flatMap(blockLines) : [JSON.stringify(content)];
      return [`--- tool result ${String(block["tool_use_id"])}${block["is_error"] ? " [error]" : ""} ---`, ...body];
    }
    case "image": {
      const source = block["source"] as { media_type?: string; data?: string } | undefined;
      const bytes = Buffer.from(source?.data ?? "", "base64");
      return [`--- image ${source?.media_type ?? "?"} · ${bytes.byteLength} bytes · ${createHash("sha256").update(bytes).digest("hex").slice(0, 12)} ---`];
    }
    case "thinking":
      return [`--- thinking (signature ${String(block["signature"] ?? "").length} chars) ---`, String(block["thinking"] ?? "")];
    default:
      return [`--- ${block.type} ---`, JSON.stringify(block)];
  }
}

export function serializeMessages(messages: TurnRequest["messages"], from = 0): string {
  const out: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (index < from) continue;
    out.push(`=== ${index} ${message.role} ===`);
    if (typeof message.content === "string") out.push(message.content);
    else for (const block of message.content as Block[]) out.push(...blockLines(block));
  }
  return out.join("\n");
}

export function serializeSystem(request: Pick<TurnRequest, "system" | "systemBlocks">): string {
  const blocks = request.systemBlocks?.length ? request.systemBlocks : request.system ? [{ text: request.system }] : [];
  return blocks.map((block, index) => `=== system block ${index} ===\n${(block as { text: string }).text}`).join("\n");
}

export function serializeTools(tools: TurnRequest["tools"]): string {
  return (tools ?? []).map((tool) => `- ${tool.name}: ${tool.description}\n  ${JSON.stringify(tool.inputSchema)}`).join("\n");
}

/** The whole request: options, system, tools and the messages from `from` on. */
export function serializeRequest(request: TurnRequest, o: { from?: number; tools?: boolean } = {}): string {
  const options = [
    `model: ${request.model}`,
    ...(request.effort !== undefined ? [`effort: ${String(request.effort)}`] : []),
    ...(request.cacheTtl ? [`cacheTtl: ${request.cacheTtl}`] : []),
    ...(request.maxOutputTokens ? [`maxOutputTokens: ${request.maxOutputTokens}`] : [])
  ];
  return [
    options.join("\n"),
    serializeSystem(request),
    ...(o.tools === false ? [] : ["=== tools ===", serializeTools(request.tools) || "(none)"]),
    serializeMessages(request.messages, o.from ?? 0),
    ""
  ].join("\n");
}
