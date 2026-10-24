// The owner's views of a life (Living cast spec §14.1, §10.4, D14): the dashboard's life log and
// `/print life` / `/print system_prompt`. DM content stays private from the owner too unless the
// owner asks for it on this computer: the dashboard's reveal toggle (`includePrivate=1`, local
// requests only) and `/print … private:true` (owner-only and ephemeral) show everything.
//
// What counts as DM content (hidden by default):
// - the arguments and the result of any tool call that names a DM place (whatever the tool is called:
//   a call is about a DM when one of its string arguments is a DM place, `dm/<name>` or `dm_<key>`);
// - every quoted part of a notification line about a DM (a preview, a matched word, a note), in a
//   turn's notification block or folded into a tool result;
// - her own assistant text in a turn whose wakes or tool calls touched a DM place;
// - her compaction summary (`<life_so_far>`), which can carry anything from her DMs.
// Room sends, room reads and her notes are shown (her notes are labelled as possibly holding things
// from private chats). Reasoning is never shown: reasoning blocks become a bare marker and opaque
// provider state (`nativeState`, signatures) is never returned.

import type { LifeLogLine, LifeState } from "../shared/schemas/life.js";
import { lifeSystem } from "./request.js";

export const DM_REDACTED = "[private chat redacted]";

/** A place argument that names a DM: a handle (`dm/kevin`) or a raw key (`dm_<user>_<waifu>`). */
export function isDmPlaceRef(value: unknown): boolean {
  return typeof value === "string" && value.length <= 200 && /^dm[/_]\S+$/u.test(value);
}

/** A notification line about a DM: `- dm · dm/kevin · …`, `- +3 more from Kevin (dm/kevin)`. */
const DM_NOTIFICATION_LINE = /^\s*[-·] .*(?:· |\()dm[/_]/u;

/**
 * Notification lines about a DM keep their reason, place and sender but lose every quoted part (the
 * preview, a matched watch word, a note), wherever they appear: a turn's notification block, or
 * notifications folded into a tool result.
 */
export function redactDmNotifications(text: string): string {
  return text
    .split("\n")
    .map((line) => (DM_NOTIFICATION_LINE.test(line) ? line.replace(/"[^"\n]*"/gu, `"${DM_REDACTED}"`) : line))
    .join("\n");
}

function mentionsDmNotification(text: string): boolean {
  return text.split("\n").some((line) => DM_NOTIFICATION_LINE.test(line));
}

/** Any string inside a tool call's input that names a DM place (generic over tool and argument names). */
function inputNamesDm(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (isDmPlaceRef(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => inputNamesDm(entry, depth + 1));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((entry) => inputNamesDm(entry, depth + 1));
  return false;
}

type Block = Record<string, unknown>;

function blocksOf(message: Record<string, unknown> | null): Block[] {
  const content = message?.["content"];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content.filter((block) => block && typeof block === "object") as Block[]) : [];
}

function resultText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return (raw as Block[])
      .map((part) => (part["type"] === "text" ? String(part["text"] ?? "") : part["type"] === "life_image" ? imageText(part) : `[${String(part["type"])}]`))
      .join("\n");
  }
  return raw === undefined ? "" : JSON.stringify(raw);
}

function imageText(block: Block): string {
  const mode = block["mode"];
  if (mode && typeof mode === "object" && typeof (mode as Record<string, unknown>)["text"] === "string") {
    const text = String((mode as Record<string, unknown>)["text"]);
    return text ? `[image: ${text}]` : "[image]";
  }
  return "[image]";
}

/** Which tool calls name a DM place, and which turns touched one (their wakes or their tool calls). */
export type DmScan = { dmCalls: ReadonlySet<string>; dmTurns: ReadonlySet<string> };

export function scanDmContent(lines: readonly LifeLogLine[]): DmScan {
  const dmCalls = new Set<string>();
  const dmTurns = new Set<string>();
  for (const line of lines) {
    for (const block of blocksOf(line.message)) {
      const type = block["type"];
      const touches =
        (type === "tool_use" && inputNamesDm(block["input"])) ||
        (type === "text" && mentionsDmNotification(String(block["text"] ?? ""))) ||
        (type === "tool_result" && mentionsDmNotification(resultText(block["content"])));
      if (type === "tool_use" && touches) dmCalls.add(String(block["id"]));
      if (touches && line.turnId) dmTurns.add(line.turnId);
    }
  }
  return { dmCalls, dmTurns };
}

const REASONING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);

export type LogBlockView = {
  type: "text" | "tool_use" | "tool_result" | "image" | "reasoning" | "other";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  isError?: boolean;
  redacted?: boolean;
};

export type LogLineView = {
  seq: number;
  at: string;
  kind: LifeLogLine["kind"];
  turnId?: string;
  role?: "user" | "assistant";
  blocks: LogBlockView[];
  dm: boolean;
  origin?: { providerId?: string; modelId?: string };
  boundary?: LifeLogLine["boundary"];
};

/** Strips opaque provider state from a tool call's input copy (it never carries any, but stay safe). */
function plainInput(input: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(input ?? {}));
  } catch {
    return {};
  }
}

/**
 * One log line for the owner. Without `includePrivate`, DM content is replaced by `redacted: true`
 * blocks (see the header); `redacted` counts what was left out.
 */
export function viewLogLine(line: LifeLogLine, scan: DmScan, o: { includePrivate: boolean }): { view: LogLineView; redacted: number } {
  const hide = !o.includePrivate;
  const dmTurn = line.turnId !== undefined && scan.dmTurns.has(line.turnId);
  const role = line.message?.["role"];
  const assistant = role === "assistant";
  let redacted = 0;
  const blocks: LogBlockView[] = [];
  for (const block of blocksOf(line.message)) {
    const type = String(block["type"] ?? "");
    if (REASONING_TYPES.has(type)) {
      blocks.push({ type: "reasoning" });
      continue;
    }
    if (type === "text") {
      const text = String(block["text"] ?? "");
      if (hide && assistant && dmTurn) {
        blocks.push({ type: "text", redacted: true });
        redacted += 1;
      } else blocks.push({ type: "text", text: hide ? redactDmNotifications(text) : text });
      continue;
    }
    if (type === "tool_use") {
      const id = String(block["id"] ?? "");
      const name = String(block["name"] ?? "");
      if (hide && scan.dmCalls.has(id)) {
        blocks.push({ type: "tool_use", id, name, redacted: true });
        redacted += 1;
      } else blocks.push({ type: "tool_use", id, name, input: plainInput(block["input"]) });
      continue;
    }
    if (type === "tool_result") {
      const toolUseId = String(block["tool_use_id"] ?? "");
      const isError = block["is_error"] === true;
      if (hide && scan.dmCalls.has(toolUseId)) {
        blocks.push({ type: "tool_result", toolUseId, ...(isError ? { isError } : {}), redacted: true });
        redacted += 1;
      } else {
        const text = resultText(block["content"]);
        blocks.push({ type: "tool_result", toolUseId, ...(isError ? { isError } : {}), text: hide ? redactDmNotifications(text) : text });
      }
      continue;
    }
    if (type === "life_image") {
      blocks.push({ type: "image", text: imageText(block) });
      continue;
    }
    blocks.push({ type: "other", text: `[${type || "block"}]` });
  }
  const origin = line.message?.["origin"];
  const originView =
    origin && typeof origin === "object"
      ? {
          ...(typeof (origin as Record<string, unknown>)["providerId"] === "string" ? { providerId: String((origin as Record<string, unknown>)["providerId"]) } : {}),
          ...(typeof (origin as Record<string, unknown>)["modelId"] === "string" ? { modelId: String((origin as Record<string, unknown>)["modelId"]) } : {})
        }
      : undefined;
  return {
    view: {
      seq: line.seq,
      at: line.at,
      kind: line.kind,
      ...(line.turnId ? { turnId: line.turnId } : {}),
      ...(role === "user" || role === "assistant" ? { role } : {}),
      blocks,
      dm: dmTurn,
      ...(originView && Object.keys(originView).length > 0 ? { origin: originView } : {}),
      ...(line.boundary ? { boundary: line.boundary } : {})
    },
    redacted
  };
}

/** One log line as `/print life` prints it (one line of text, parts joined by ` | `). */
export function printLogLine(line: LifeLogLine, scan: DmScan, o: { private: boolean }): string {
  if (!line.message) return `${line.at.slice(11, 16)} ${line.kind}: —`;
  const { view } = viewLogLine(line, scan, { includePrivate: o.private });
  const parts: string[] = [];
  for (const block of view.blocks) {
    if (block.type === "text") parts.push(block.redacted ? DM_REDACTED : (block.text ?? "").slice(0, 300));
    else if (block.type === "tool_use") parts.push(block.redacted ? `${block.name}(${DM_REDACTED})` : `${block.name}(${JSON.stringify(block.input ?? {}).slice(0, 200)})`);
    else if (block.type === "tool_result") parts.push(block.redacted ? `result: ${DM_REDACTED}` : `result: ${(block.text ?? "").slice(0, 200)}`);
    else if (block.type === "image") parts.push(block.text ?? "[image]");
    else if (block.type === "reasoning") parts.push("[reasoning]");
  }
  return `${line.at.slice(11, 16)} ${line.kind}: ${parts.join(" | ")}`;
}

/** `/print life`: the last `count` lines of her current epoch (DM content redacted unless `private`). */
export function printLifeLines(all: readonly LifeLogLine[], o: { private: boolean; count?: number }): string {
  // The scan covers the whole epoch: a result's call (or the turn's wakes) may sit before the last lines.
  const scan = scanDmContent(all);
  const lines = all.slice(-(o.count ?? 20));
  return lines.map((line) => printLogLine(line, scan, o)).join("\n") || "(her life log is empty)";
}

export const SUMMARY_REDACTED = `${DM_REDACTED}: her summary can include things from private chats. Run /print system_prompt private:true to see it.`;

/** `/print system_prompt`: blocks A and B; the `<life_so_far>` summary is hidden unless `private`. */
export function printSystemPromptText(state: LifeState, o: { private: boolean }): string {
  if (!state.systemSnapshot) return "(no system prompt yet: her life has not started)";
  const shown = o.private || !state.summary?.trim() ? state : { ...state, summary: SUMMARY_REDACTED };
  return lifeSystem(shown).join("\n\n");
}
