// Pure formatting for Discord debug logs and /print output.

import { WaifuConfig } from "../shared/schemas/domain.js";
import { type OrchestratorDecision, RETRIGGER_DEFAULT_SECONDS } from "./decisions.js";

export type StageManagerDebugEntry = {
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  summary: string;
};

export type WaifuPromptDebugParts = {
  waifuDisplayName: string;
  debug: { system: string; header: string; transcript: string; tail: string };
};

export function formatOrchestratorDebugLog(input: {
  guildId: string;
  channelId: string;
  decision: OrchestratorDecision;
  availableWaifus: WaifuConfig[];
}): string {
  const waifuNameById = new Map(input.availableWaifus.map((waifu) => [waifu.id, waifuDebugName(waifu)]));
  const lines = [
    `[orchestrator debug] guild=${input.guildId} channel=${input.channelId}`,
    `Decision: ${input.decision.action}`
  ];
  if (input.decision.action === "reply") {
    lines.push(
      `Waifus: ${input.decision.respondingWaifus
        .map((responder) => waifuNameById.get(responder.waifuId) ?? responder.waifuId)
        .join(" -> ")}`
    );
    const directives = input.decision.respondingWaifus
      .map((responder) => ({
        name: waifuNameById.get(responder.waifuId) ?? responder.waifuId,
        directive: responder.directive
      }))
      .filter(
        (entry): entry is { name: string; directive: NonNullable<typeof entry.directive> } =>
          Boolean(entry.directive)
      );
    if (directives.length > 0) {
      lines.push("Directives:");
      for (const entry of directives) {
        lines.push(`- ${entry.name}: (${entry.directive.intent}) ${clipDebugText(entry.directive.goal)}`);
      }
    }
  } else {
    lines.push(`Idle trigger: ${input.decision.retriggerAfterSeconds ?? RETRIGGER_DEFAULT_SECONDS}s`);
    if (input.decision.wakePlan) {
      lines.push(`Wake plan: ${clipDebugText(input.decision.wakePlan)}`);
    }
  }
  lines.push(`Reasoning: ${clipDebugText(input.decision.reasoning)}`);
  return lines.join("\n");
}

export function formatStageManagerDebugLog(input: {
  guildId: string;
  channelId: string;
  entries: StageManagerDebugEntry[];
  observationCount: number;
}): string {
  const lines = [
    `[stage-manager debug] guild=${input.guildId} channel=${input.channelId}`,
    `Observations: ${input.observationCount}`
  ];
  const entries = input.entries.length > 0 ? input.entries : [{ tool: "no_change" as const, summary: "No memory changes" }];
  if (entries.every((entry) => entry.tool === "no_change")) {
    lines.push("Memory changes: none");
  } else {
    lines.push("Memory changes:");
  }
  for (const entry of entries) {
    lines.push(`- ${stageManagerToolLabel(entry.tool)}: ${clipDebugText(entry.summary || "No details")}`);
  }
  return lines.join("\n");
}

export function formatDreamDebugLog(input: {
  guildId: string;
  entries: Array<{ tool: StageManagerDebugEntry["tool"]; summary: string }>;
}): string {
  const lines = [`[dream debug] guild=${input.guildId}`];
  if (input.entries.length === 0 || input.entries.every((entry) => entry.tool === "no_change")) {
    lines.push("Memory changes: none");
  } else {
    lines.push("Memory changes:");
  }
  const entries = input.entries.length > 0 ? input.entries : [{ tool: "no_change" as const, summary: "No memory changes" }];
  for (const entry of entries) {
    lines.push(`- ${stageManagerToolLabel(entry.tool)}: ${clipDebugText(entry.summary || "No details")}`);
  }
  return lines.join("\n");
}

function waifuDebugName(waifu: WaifuConfig): string {
  const display = waifu.displayName || waifu.name || waifu.id;
  return display === waifu.id ? waifu.id : `${display} (${waifu.id})`;
}

function stageManagerToolLabel(tool: StageManagerDebugEntry["tool"]): string {
  if (tool === "add_memory") return "added";
  if (tool === "update_memory") return "updated";
  if (tool === "archive_memory") return "deleted/archived";
  if (tool === "merge_memories") return "merged";
  return "no change";
}

function clipDebugText(value: string, maxLength = 700): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

/** /print system_prompt: the four parts of a BuiltPrompt (spec 8.8 — reads BuiltPrompt.debug). */
export function formatWaifuPromptDebugMessages(input: WaifuPromptDebugParts): string[] {
  return [
    ...formatPrintDebugBlock(`System prompt (${input.waifuDisplayName})`, input.debug.system),
    ...formatPrintDebugBlock(`Epoch header (${input.waifuDisplayName})`, input.debug.header),
    ...formatPrintDebugBlock(`Transcript (${input.waifuDisplayName})`, input.debug.transcript),
    ...formatPrintDebugBlock(`Tail (${input.waifuDisplayName})`, input.debug.tail)
  ];
}

export function formatPrintDebugBlock(title: string, content: string): string[] {
  const rawContent = content.length > 0 ? content : "(empty)";
  const fence = promptDebugCodeFence(rawContent);
  const messages: string[] = [];
  let remaining = rawContent;
  let part = 1;
  while (remaining.length > 0) {
    const prefix = part === 1 ? `## ${title}\n${fence}\n` : `${fence}\n`;
    const suffix = `\n${fence}`;
    const maxContentLength = Math.max(1, DISCORD_DEBUG_MESSAGE_LIMIT - prefix.length - suffix.length);
    const chunk = takePromptDebugChunk(remaining, maxContentLength);
    messages.push(`${prefix}${chunk}${suffix}`);
    remaining = remaining.slice(chunk.length);
    part += 1;
  }
  return messages;
}

function promptDebugCodeFence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 3);
  return "`".repeat(longestRun + 1);
}

function takePromptDebugChunk(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  const splitAt = content.lastIndexOf("\n", maxLength);
  if (splitAt > 0) {
    return content.slice(0, splitAt + 1);
  }
  return content.slice(0, maxLength);
}

export function splitDebugMessage(content: string): string[] {
  if (content.length <= DISCORD_DEBUG_MESSAGE_LIMIT) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > DISCORD_DEBUG_MESSAGE_LIMIT) {
    const splitAt = remaining.lastIndexOf("\n", DISCORD_DEBUG_MESSAGE_LIMIT);
    const index = splitAt > 0 ? splitAt : DISCORD_DEBUG_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

const DISCORD_DEBUG_MESSAGE_LIMIT = 1900;
