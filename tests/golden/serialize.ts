// Readable, deterministic serialization of prompts for golden files (spec 8.0: snapshots live in
// tests/golden/__snapshots__/ and are reviewed as plain-text diffs). Cache breakpoints are shown
// as `[cache]`, images by MIME type, size and a short content hash (never the base64 payload).

import { createHash } from "node:crypto";
import type { ChatMessage, ToolDef } from "@waifucave/gateway";
import type { BuiltPrompt } from "../../src/orchestration/context/types.js";

function mark(o: { cacheControl?: unknown }): string {
  return o.cacheControl ? " [cache]" : "";
}

export function serializeMessages(messages: readonly ChatMessage[]): string {
  const out: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      out.push(`=== ${index} tool ← ${message.toolCallId}${mark(message)} ===`, message.content);
      continue;
    }
    out.push(`=== ${index} ${message.role}${mark(message)} ===`);
    if (typeof message.content === "string") {
      out.push(message.content);
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          out.push(`--- text${mark(block)} ---`, block.text);
          break;
        case "image": {
          const bytes = Buffer.from(block.data, "base64");
          const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
          out.push(`--- image ${block.mimeType} · ${bytes.byteLength} bytes · ${hash} ---`);
          break;
        }
        case "toolCall":
          out.push(`--- tool call ${block.name} (${block.id}) ---`, block.arguments);
          break;
        case "reasoning":
          out.push("--- reasoning ---", block.text);
          break;
      }
    }
  }
  return out.join("\n") + "\n";
}

export function serializeTools(tools: readonly ToolDef[]): string {
  return tools.map((tool) => `- ${tool.name}: ${JSON.stringify(tool.parameters)}`).join("\n");
}

export function serializePrompt(prompt: BuiltPrompt): string {
  return [
    `promptCacheKey: ${prompt.promptCacheKey}`,
    `cursorSeq: ${prompt.cursorSeq ?? "null"} · transcriptCount: ${prompt.transcriptCount} · estimatedTokens: ${prompt.estimatedTokens}`,
    `breakpoint: ${prompt.breakpoint ? `${prompt.breakpoint.kind}#${prompt.breakpoint.seq}` : "none"}`,
    `tools:\n${serializeTools(prompt.tools) || "(none)"}`,
    "",
    serializeMessages(prompt.messages)
  ].join("\n");
}
