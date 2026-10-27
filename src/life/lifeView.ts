// The owner's views of a life (Living cast spec §14.1, §14.4, §10.4, D14): the dashboard's life log
// and `/print life` / `/print system_prompt` / `/print notes` (her MEMORY.md: lines linking to a file
// from a private chat or naming a DM are left out, `redactNotesLines`). DM content stays private from the owner too unless the
// owner asks for it on this computer: the dashboard's reveal toggle (`includePrivate=1`, local
// requests only) and `/print … private:true` (owner-only and ephemeral) show everything.
//
// What counts as DM content (hidden by default, spec §14.4):
// - everything she did in a DM turn: a turn whose wakes include a DM place, or in which any tool call
//   resolved to a DM place. Every tool call's input and result in it (web search, notes, any tool)
//   and her own text are hidden;
// - outside DM turns, the input and result of any tool call that resolved to a DM place;
// - in notifications (a turn's block, or folded into a tool result), everything from the first quote
//   to the end of a line about a DM (a preview, a matched word, a note), across lines while a quote
//   stays open;
// - her compaction summary (`<life_so_far>`), which can carry anything from her DMs, and so her own
//   text in a rest turn (§19), the summary she writes herself.
// The life loop records what each call resolved to (`dmCalls` on the tool-results line, `dmWakes`
// on lines that carry wakes); a line written before that, or a call whose results are not written
// yet, falls back to matching DM place references the way `resolvePlace` reads them (trimmed,
// without `<>`, any case; any string containing `dm/` or `dm_`). Room sends, room reads and her notes
// outside DM turns are shown. Reasoning is never shown: reasoning blocks become a bare marker and
// opaque provider state (`nativeState`, signatures) is never returned.

import type { LifeLogLine, LifeState } from "../shared/schemas/life.js";
import { lifeSystem } from "./request.js";
import { isRestNotice, selfSummaryOf } from "./rest.js";

export const DM_REDACTED = "[private chat redacted]";

/** A DM place reference anywhere in a text, read like `resolvePlace` does (any case, `<…>` allowed). */
const DM_REFERENCE = /(?:^|[^a-z0-9_])<?dm[/_][^\s>]/iu;

/** A place argument (or any string input) that names a DM: `dm/kevin`, ` DM/Kevin `, `<dm/kevin>`, `dm_<key>`. */
export function isDmPlaceRef(value: unknown): boolean {
  return typeof value === "string" && value.length <= 4000 && /dm[/_]/iu.test(value);
}

/** A placeKey a tool resolved to: a DM conversation (`dm_<user>_<waifu>`). */
export function isDmPlaceKey(placeKey: string | undefined): boolean {
  return typeof placeKey === "string" && placeKey.startsWith("dm_");
}

/** A wake that brings DM content into her turn (D14): one for a DM place, or a morning batch that shows a DM (§23). */
export function wakeShowsDm(wake: { placeKey?: string | undefined; dm?: boolean | undefined }): boolean {
  return isDmPlaceKey(wake.placeKey) || wake.dm === true;
}

/**
 * A notification line about a DM (one per message, §20): `- dm · dm/kevin · …`, `- dm/kevin · …`,
 * `- +3 more from Kevin (dm/kevin)`, `  · watch matched · dm/kevin · …`.
 */
const DM_NOTIFICATION_LINE = /^\s*[-·] (?:.*(?:· |\(|\s))?<?dm[/_]/iu;

/** A line that starts a notification entry (or the block's tags); anything else continues the line before. */
const ENTRY_START = /^\s*(?:[-·] |<\/?notifications>)/u;

/**
 * Notification lines about a DM keep their reason, place and sender up to the first quote; from the
 * first quote to the end of the line (a preview, a matched word, a note) is left out, and so is every
 * line that continues it (an old note with a line break), until the next entry starts.
 */
export function redactDmNotifications(text: string): string {
  const out: string[] = [];
  let continuing = false;
  for (const line of text.split("\n")) {
    const entry = ENTRY_START.test(line);
    if (continuing && !entry) {
      out.push(DM_REDACTED);
      continue;
    }
    continuing = false;
    if (!DM_NOTIFICATION_LINE.test(line)) {
      out.push(line);
      continue;
    }
    const first = line.indexOf('"');
    out.push(first < 0 ? line : `${line.slice(0, first)}"${DM_REDACTED}"`);
    continuing = true;
  }
  return out.join("\n");
}

/**
 * A tool result outside a DM turn: notification-style lines about a DM lose their quoted parts, and
 * any other line naming a DM place keeps only what comes before the reference.
 */
function redactDmResult(text: string): string {
  const notified = redactDmNotifications(text);
  return notified
    .split("\n")
    .map((line) => {
      if (DM_NOTIFICATION_LINE.test(line)) return line;
      const match = DM_REFERENCE.exec(line);
      return match ? `${line.slice(0, match.index + match[0].search(/<?dm[/_]/iu))}${DM_REDACTED}` : line;
    })
    .join("\n");
}

function mentionsDmNotification(text: string): boolean {
  return text.split("\n").some((line) => DM_NOTIFICATION_LINE.test(line));
}

function namesDmPlace(text: string): boolean {
  return DM_REFERENCE.test(text);
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

/**
 * Which tool calls touched a DM place, which turns are DM turns (spec §14.4), and which are rest
 * turns (§19: her text there is her summary, private like `<life_so_far>`).
 */
export type DmScan = { dmCalls: ReadonlySet<string>; dmTurns: ReadonlySet<string>; restTurns?: ReadonlySet<string> };

export function scanDmContent(lines: readonly LifeLogLine[]): DmScan {
  const dmCalls = new Set<string>();
  const dmTurns = new Set<string>();
  const restTurns = new Set<string>();
  // What the life loop recorded when the tools ran: per call, whether it resolved to a DM place.
  const recorded = new Map<string, boolean>();
  for (const line of lines) {
    if (line.dmCalls === undefined) continue;
    for (const block of blocksOf(line.message)) {
      if (block["type"] === "tool_result") recorded.set(String(block["tool_use_id"]), line.dmCalls.includes(String(block["tool_use_id"])));
    }
  }
  for (const line of lines) {
    const turn = line.turnId;
    if (line.dmWakes === true && turn) dmTurns.add(turn);
    for (const block of blocksOf(line.message)) {
      const type = block["type"];
      if (type === "text" && turn && line.message?.["role"] !== "assistant" && isRestNotice(String(block["text"] ?? ""))) restTurns.add(turn);
      if (type === "tool_use") {
        const id = String(block["id"]);
        const dm = recorded.has(id) ? recorded.get(id)! : inputNamesDm(block["input"]);
        if (dm) dmCalls.add(id);
      } else if (type === "tool_result") {
        const id = String(block["tool_use_id"]);
        if (!recorded.has(id) && namesDmPlace(resultText(block["content"]))) dmCalls.add(id);
      } else if (type === "text" && line.dmWakes === undefined && line.message?.["role"] !== "assistant") {
        // A line written before the life loop recorded its wakes: read its notifications.
        if (mentionsDmNotification(String(block["text"] ?? "")) && turn) dmTurns.add(turn);
      }
    }
  }
  for (const line of lines) {
    if (!line.turnId) continue;
    for (const block of blocksOf(line.message)) {
      const id = block["type"] === "tool_use" ? String(block["id"]) : block["type"] === "tool_result" ? String(block["tool_use_id"]) : undefined;
      if (id !== undefined && dmCalls.has(id)) dmTurns.add(line.turnId);
    }
  }
  return { dmCalls, dmTurns, restTurns };
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
  // Her text in a rest turn is her summary: private like `<life_so_far>` (§19, D14).
  const restTurn = line.turnId !== undefined && scan.restTurns?.has(line.turnId) === true;
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
      // Her own fresh-start summary (§21.6b) is private the same way.
      if (hide && assistant && (dmTurn || restTurn || selfSummaryOf(text) !== undefined)) {
        blocks.push({ type: "text", redacted: true });
        redacted += 1;
      } else blocks.push({ type: "text", text: hide ? redactDmNotifications(text) : text });
      continue;
    }
    if (type === "tool_use") {
      const id = String(block["id"] ?? "");
      const name = String(block["name"] ?? "");
      if (hide && (dmTurn || scan.dmCalls.has(id))) {
        blocks.push({ type: "tool_use", id, name, redacted: true });
        redacted += 1;
      } else blocks.push({ type: "tool_use", id, name, input: plainInput(block["input"]) });
      continue;
    }
    if (type === "tool_result") {
      const toolUseId = String(block["tool_use_id"] ?? "");
      const isError = block["is_error"] === true;
      if (hide && (dmTurn || scan.dmCalls.has(toolUseId))) {
        blocks.push({ type: "tool_result", toolUseId, ...(isError ? { isError } : {}), redacted: true });
        redacted += 1;
      } else {
        const text = resultText(block["content"]);
        blocks.push({ type: "tool_result", toolUseId, ...(isError ? { isError } : {}), text: hide ? redactDmResult(text) : text });
      }
      continue;
    }
    if (type === "life_image") {
      if (hide && dmTurn) {
        blocks.push({ type: "image", redacted: true });
        redacted += 1;
      } else blocks.push({ type: "image", text: imageText(block) });
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

/** `/print system_prompt`: blocks A and B; the `<life_so_far>` summary is hidden unless `private`, and so are the index lines `privateLine` names. */
export function printSystemPromptText(state: LifeState, o: { private: boolean; privateLine?: (line: string) => boolean }): string {
  const snapshot = state.systemSnapshot;
  if (!snapshot) return "(no system prompt yet: her life has not started)";
  if (o.private) return lifeSystem(state).join("\n\n");
  const memoryIndex = redactNotesLines(snapshot.memoryIndex, o.privateLine).text;
  const summary = state.summary?.trim() ? SUMMARY_REDACTED : state.summary;
  return lifeSystem({ ...state, summary, systemSnapshot: { ...snapshot, memoryIndex } }).join("\n\n");
}

/** A line of her notes that names a DM place or path (`dm/kevin`, `/tmp/dm/…`, `/transcripts/dm/…`, `dm_<key>`) or carries a migrated DM record's suffix. */
export function notesLineNamesDm(line: string): boolean {
  return namesDmPlace(line) || /\(from a private chat\b/iu.test(line);
}

/**
 * Her notes without what is private (D14): every line that names a DM (`notesLineNamesDm`) or that
 * `privateLine` names (a link to a DM-origin file) becomes `[private chat redacted]`, keeping its
 * indent and list marker.
 */
export function redactNotesLines(text: string, privateLine?: (line: string) => boolean): { text: string; redacted: number } {
  let redacted = 0;
  const lines = text.split("\n").map((line) => {
    if (!notesLineNamesDm(line) && !privateLine?.(line)) return line;
    redacted += 1;
    const marker = /^\s*(?:[-*+]|\d+[.)])?\s*/u.exec(line)?.[0] ?? "";
    return `${marker}${DM_REDACTED}`;
  });
  return { text: lines.join("\n"), redacted };
}

export const NOTES_INDEX_PRIVATE = `${DM_REDACTED}: her MEMORY.md came from a private chat. Run /print notes private:true to see it, or open Life → Files on the host.`;

/** `/print notes`: her MEMORY.md; unless `private`, the lines from private chats are left out (D14). */
export function printNotesText(text: string, o: { private: boolean; privateLine?: (line: string) => boolean }): string {
  if (o.private) return text;
  const { text: shown, redacted } = redactNotesLines(text, o.privateLine);
  if (redacted === 0) return shown;
  const footer = `(${redacted} ${redacted === 1 ? "line" : "lines"} from private chats left out: run /print notes private:true to see them, or open Life → Files on the host.)`;
  return `${shown.replace(/\n+$/u, "")}\n\n${footer}`;
}
