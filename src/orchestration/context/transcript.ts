// Transcript rendering (spec 8.3) — one implementation for every agent.
//
// - Header `[HH:MM #ref] Name: body`; replies `[HH:MM #k4 ↩#a1] Name: body`; `↩you` when the
//   target is the viewer's own message; `↩Name` when the target is before the cursor.
// - Consecutive non-self messages merge into one user turn with ONE text block per message
//   (appending never changes earlier blocks); self messages are assistant turns (raw text).
// - Images render through FrozenImages after the entry's header block.
// - A gap ≥ 30 min inserts its own block `— 3 hours later —`; a day change appends `· Tue 24 Oct`
//   (the first entry gets a day marker so the model always knows the date).
// - Notes render after their anchor entry (the last transcript entry with seq ≤ anchorSeq; notes
//   anchored before the transcript lead it), ordered by seq; Phase 5 edit events interleave.
// - Times render in the context's frozen timeZone.
//
// Every TextBlock is tagged with the address (entry/note/event + seq) of the item it belongs to,
// which is how the builder places and finds cache breakpoints C and C_prev.

import type { ChatMessage, ImageBlock, TextBlock, ToolCallBlock } from "@waifucave/gateway";
import type { ContextNote, ContextState, ConversationEvent, LedgerEntry } from "../../shared/schemas/context.js";
import { IMAGE_PLACEHOLDER } from "./images.js";
import { isGapEntry } from "./ledger.js";
import { formatClock, transitionMarker } from "./timeFormat.js";
import type { FrozenImages } from "./types.js";

export type BlockAddress = { kind: "entry" | "note" | "event"; seq: number };

/** Tool name used for orchestrator decision notes rendered as tool-call turns. */
export const DECISION_TOOL_NAME = "orchestrator_decision";
export const EMPTY_SELF_MESSAGE = "…";

export type TranscriptInput = {
  /** Transcript entries (ledger seq > cursorSeq), in seq order. */
  entries: LedgerEntry[];
  notes: ContextNote[];
  events: ConversationEvent[];
  state: ContextState;
  selfAuthorIds: readonly string[];
  /** messageId → ref for transcript entries. */
  refs: ReadonlyMap<string, string>;
  /** Ledger-wide lookup (reply targets before the cursor). */
  lookup: (messageId: string) => LedgerEntry | undefined;
  timeZone: string;
  renderToolTurnsAsText?: boolean;
  images: FrozenImages;
};

export type BlockPosition = { messageIndex: number; blockIndex: number; address: BlockAddress };

export type RenderedTranscript = {
  messages: ChatMessage[];
  /** Every TextBlock that belongs to an addressable item, in order. */
  textBlocks: BlockPosition[];
  /** Plain-text view for /print and the inspector. */
  text: string;
};

type Part =
  | { role: "user"; block: TextBlock | ImageBlock; address: BlockAddress | null }
  | { role: "assistant"; block: TextBlock | ToolCallBlock; address: BlockAddress | null }
  | { role: "tool"; toolCallId: string; content: string; address: BlockAddress };

export function toolCallIdFor(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "call";
}

/** `[14:02 #k3]`, `[14:03 #k4 ↩#a1]`, `[14:03 #k4 ↩you]`, `[14:03 #k4 ↩Kevin]`. */
export function entryHeader(
  entry: LedgerEntry,
  i: Pick<TranscriptInput, "refs" | "lookup" | "selfAuthorIds" | "timeZone">
): string {
  const ref = i.refs.get(entry.id);
  const parts = [formatClock(entry.at, i.timeZone)];
  if (ref) parts.push(`#${ref}`);
  if (entry.replyToId) {
    const target = i.lookup(entry.replyToId);
    if (target && i.selfAuthorIds.includes(target.authorId)) parts.push("↩you");
    else if (i.refs.has(entry.replyToId)) parts.push(`↩#${i.refs.get(entry.replyToId)}`);
    else if (target && target.authorName) parts.push(`↩${target.authorName}`);
  }
  return `[${parts.join(" ")}]`;
}

export function entryLine(
  entry: LedgerEntry,
  i: Pick<TranscriptInput, "refs" | "lookup" | "selfAuthorIds" | "timeZone">
): string {
  const head = `${entryHeader(entry, i)} ${entry.authorName || "Unknown"}:`;
  return entry.body ? `${head} ${entry.body}` : head;
}

function noteText(note: ContextNote, i: TranscriptInput, anchor: LedgerEntry | undefined): string | undefined {
  switch (note.kind) {
    case "memory":
      return `<memory_note>${note.text}</memory_note>`;
    case "direction":
      return `<direction>${note.text}</direction>`;
    case "tool":
      return i.renderToolTurnsAsText ? `[tool ${note.name}] ${note.arguments} → ${note.result}` : undefined;
    case "decision": {
      if (!i.renderToolTurnsAsText) return undefined;
      const time = anchor ? ` ${formatClock(anchor.at, i.timeZone)}` : "";
      return `[decision${time}] ${note.call} · ${note.outcome}`;
    }
  }
}

function eventText(event: ConversationEvent, i: TranscriptInput): string | undefined {
  if (event.kind !== "edit") return undefined; // deletes are audit-only
  const target = i.lookup(event.messageId);
  const who = target?.authorName || "Someone";
  const ref = i.refs.get(event.messageId);
  return ref ? `<edit>${who} edited #${ref}: ${event.text}</edit>` : `<edit>${who} edited an earlier message: ${event.text}</edit>`;
}

type Attached = { kind: "note"; seq: number; note: ContextNote } | { kind: "event"; seq: number; event: ConversationEvent };

export async function renderTranscript(i: TranscriptInput): Promise<RenderedTranscript> {
  // Group notes/events by the index of the transcript entry they render after (-1 = leading).
  const indexBySeq = i.entries.map((entry) => entry.seq);
  const slotFor = (anchorSeq: number): number => {
    let lo = 0;
    let hi = indexBySeq.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (indexBySeq[mid]! <= anchorSeq) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const attached = new Map<number, Attached[]>();
  const attach = (slot: number, item: Attached) => {
    const list = attached.get(slot) ?? [];
    list.push(item);
    attached.set(slot, list);
  };
  for (const note of i.notes) attach(slotFor(note.anchorSeq), { kind: "note", seq: note.seq, note });
  for (const event of i.events) {
    if (event.kind === "edit") attach(slotFor(event.anchorSeq), { kind: "event", seq: event.seq, event });
  }
  for (const list of attached.values()) {
    list.sort((a, b) => a.seq - b.seq || (a.kind === b.kind ? 0 : a.kind === "note" ? -1 : 1));
  }

  const parts: Part[] = [];
  const debug: string[] = [];

  const renderAttached = (slot: number) => {
    const anchor = slot >= 0 ? i.entries[slot] : undefined;
    for (const item of attached.get(slot) ?? []) {
      if (item.kind === "event") {
        const text = eventText(item.event, i);
        if (!text) continue;
        parts.push({ role: "user", block: { type: "text", text }, address: { kind: "event", seq: item.seq } });
        debug.push(text);
        continue;
      }
      const note = item.note;
      const address: BlockAddress = { kind: "note", seq: note.seq };
      const text = noteText(note, i, anchor);
      if (text !== undefined) {
        parts.push({ role: "user", block: { type: "text", text }, address });
        debug.push(text);
        continue;
      }
      // Tool-call turn: assistant toolCall + tool result (results never carry a breakpoint).
      const isDecision = note.kind === "decision";
      const id = toolCallIdFor(isDecision ? note.decisionId : note.kind === "tool" ? note.callId : note.id);
      const name = isDecision ? DECISION_TOOL_NAME : note.kind === "tool" ? note.name : "tool";
      const args = isDecision ? note.call : note.kind === "tool" ? note.arguments : "{}";
      const result = isDecision ? note.outcome : note.kind === "tool" ? note.result : "";
      parts.push({ role: "assistant", block: { type: "toolCall", id, name, arguments: args }, address: null });
      parts.push({ role: "tool", toolCallId: id, content: result, address });
      debug.push(`[tool call ${name}] ${args}`, `[tool result] ${result}`);
    }
  };

  renderAttached(-1);
  let previous: LedgerEntry | undefined;
  for (const [index, entry] of i.entries.entries()) {
    const marker = transitionMarker(previous?.at, entry.at, i.timeZone);
    if (marker) {
      parts.push({ role: "user", block: { type: "text", text: marker }, address: null });
      debug.push(marker);
    }
    const address: BlockAddress = { kind: "entry", seq: entry.seq };
    if (isGapEntry(entry)) {
      parts.push({ role: "user", block: { type: "text", text: entry.body }, address });
      debug.push(entry.body);
    } else if (i.selfAuthorIds.includes(entry.authorId)) {
      const extras = entry.images.map(() => IMAGE_PLACEHOLDER);
      const text = [entry.body, ...extras].filter(Boolean).join("\n") || EMPTY_SELF_MESSAGE;
      parts.push({ role: "assistant", block: { type: "text", text }, address });
      debug.push(`(you) ${text}`);
    } else {
      const line = entryLine(entry, i);
      parts.push({ role: "user", block: { type: "text", text: line }, address });
      debug.push(line);
      if (entry.images.length > 0) {
        for (const block of await i.images.blocksFor(entry, i.state)) {
          parts.push({ role: "user", block, address: block.type === "text" ? address : null });
          debug.push(block.type === "text" ? block.text : `[inline image ${block.mimeType}]`);
        }
      }
    }
    previous = entry;
    renderAttached(index);
  }

  // Assemble: consecutive user / assistant parts share one message; tool results stand alone.
  const messages: ChatMessage[] = [];
  const textBlocks: BlockPosition[] = [];
  for (const part of parts) {
    if (part.role === "tool") {
      messages.push({ role: "tool", toolCallId: part.toolCallId, content: part.content });
      continue;
    }
    const last = messages[messages.length - 1];
    let target: Extract<ChatMessage, { role: "user" | "assistant" }>;
    if (last && last.role === part.role && Array.isArray(last.content)) target = last as typeof target;
    else {
      target = part.role === "user" ? { role: "user", content: [] } : { role: "assistant", content: [] };
      messages.push(target);
    }
    const blocks = target.content as Array<TextBlock | ImageBlock | ToolCallBlock>;
    blocks.push(part.block);
    if (part.block.type === "text" && part.address) {
      textBlocks.push({ messageIndex: messages.length - 1, blockIndex: blocks.length - 1, address: part.address });
    }
  }
  return { messages, textBlocks, text: debug.join("\n") };
}
