// Prompt builder (spec 8.3): system (A) → epoch header (B) → append-only transcript (C_prev, C)
// → ephemeral tail. Pure given its inputs and the FrozenImages it is handed, so two builds over
// the same input are byte-identical.
//
// Breakpoints (Anthropic allows 4 and looks back ~20 blocks from each):
//   A      the system TextBlock
//   B      the header TextBlock
//   C_prev the exact block addressed by state.lastBreakpoint (the previous request's C), omitted
//          when it no longer exists or equals C
//   C      the LAST transcript TextBlock — never an ImageBlock or a tool-result message; when the
//          transcript ends with a tool result, the latest text block before it
// The tail is a separate, never-marked final text block (same user turn when the transcript ends
// with a user turn, otherwise a new user turn). Exactly one role:"system" message (spec 6.8).

import type { CacheControl, ChatMessage, ResolvedModel, TextBlock, ToolDef } from "@waifucave/gateway";
import type { ContextState, ConversationEvent, LedgerEntry } from "../../shared/schemas/context.js";
import type { ContextAgent, ConversationRef } from "./keys.js";
import { conversationKey, promptCacheKey } from "./keys.js";
import { estimateTokens } from "./tokens.js";
import { renderTranscript, type BlockAddress, type BlockPosition } from "./transcript.js";
import type { BuiltPrompt, FrozenImages } from "./types.js";

export type BuildInput = {
  conversation: ConversationRef;
  agent: ContextAgent;
  model: ResolvedModel;
  state: ContextState;
  systemText: string;
  headerText: string;
  transcript: LedgerEntry[];
  /** Ledger events. Not rendered directly: ContextRuntime converts edit events into `edit` notes (one note counter orders everything). */
  events: ConversationEvent[];
  selfAuthorIds: string[];
  refs: ReadonlyMap<string, string>;
  tail: string;
  tools: ToolDef[];
  renderToolTurnsAsText?: boolean; // orchestrator JSON-schema path
  /** Ledger-wide lookup for reply targets before the cursor (defaults to the transcript only). */
  lookup?: (messageId: string) => LedgerEntry | undefined;
};

export function cacheMark(): CacheControl {
  return { type: "ephemeral", ttl: "5m" };
}

export function modelKeyFor(model: Pick<ResolvedModel, "providerId" | "modelId">): string {
  return `${model.providerId}:${model.modelId}`;
}

type AnyAddress = { kind: string; seq: number }; // stored breakpoints may carry the legacy "event" kind
function sameAddress(a: AnyAddress | null | undefined, b: AnyAddress | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.seq === b.seq;
}

function lastPositionOf(positions: BlockPosition[], address: AnyAddress): BlockPosition | undefined {
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    if (sameAddress(positions[index]!.address, address)) return positions[index];
  }
  return undefined;
}

function markBlock(messages: ChatMessage[], position: { messageIndex: number; blockIndex: number }): void {
  const message = messages[position.messageIndex]!;
  const blocks = message.content as unknown as TextBlock[];
  blocks[position.blockIndex] = { ...blocks[position.blockIndex]!, cacheControl: cacheMark() };
}

export async function buildContext(i: BuildInput, images: FrozenImages): Promise<BuiltPrompt> {
  const timeZone = i.state.timeZone;
  const byId = new Map(i.transcript.map((entry) => [entry.id, entry]));
  const lookup = (id: string) => byId.get(id) ?? i.lookup?.(id);
  const refs = new Map<string, string>();
  for (const entry of i.transcript) {
    const ref = i.refs.get(entry.id);
    if (ref !== undefined) refs.set(entry.id, ref);
  }
  const transcript = await renderTranscript({
    entries: i.transcript,
    notes: i.state.notes,
    state: i.state,
    selfAuthorIds: i.selfAuthorIds,
    refs,
    lookup,
    timeZone,
    renderToolTurnsAsText: i.renderToolTurnsAsText,
    images
  });

  const messages: ChatMessage[] = [
    { role: "system", content: [{ type: "text", text: i.systemText, cacheControl: cacheMark() }] }
  ];
  const headerOffset = i.headerText ? 1 : 0;
  if (i.headerText) {
    messages.push({ role: "user", content: [{ type: "text", text: i.headerText, cacheControl: cacheMark() }] });
  }
  const offset = 1 + headerOffset;
  messages.push(...transcript.messages);
  const positions = transcript.textBlocks.map((p) => ({ ...p, messageIndex: p.messageIndex + offset }));

  const last = positions[positions.length - 1];
  const breakpoint: BlockAddress | null = last ? { ...last.address } : null;
  if (last) markBlock(messages, last);
  const previous = i.state.lastBreakpoint;
  if (previous && !sameAddress(previous, breakpoint)) {
    const target = lastPositionOf(positions, previous);
    if (target && !(target.messageIndex === last?.messageIndex && target.blockIndex === last.blockIndex)) {
      markBlock(messages, target);
    }
  }

  // Ephemeral tail: never marked, never stored.
  if (i.tail) {
    const final = messages[messages.length - 1]!;
    const tailBlock: TextBlock = { type: "text", text: i.tail };
    if (final.role === "user" && Array.isArray(final.content)) final.content.push(tailBlock);
    else messages.push({ role: "user", content: [tailBlock] });
  }

  const refToMessageId = new Map<string, string>();
  for (const [messageId, ref] of refs) refToMessageId.set(ref, messageId);
  const modelKey = modelKeyFor(i.model);
  const ratio = i.state.tokenCalibration[modelKey]?.ratio ?? 1;
  const key = conversationKey(i.conversation);
  return {
    messages,
    tools: i.tools,
    promptCacheKey: promptCacheKey(key, i.agent),
    refToMessageId,
    messageIdToRef: refs,
    estimatedTokens: estimateTokens(messages, i.tools, ratio),
    transcriptCount: i.transcript.length,
    cursorSeq: i.state.cursorSeq,
    breakpoint,
    debug: { system: i.systemText, header: i.headerText, transcript: transcript.text, tail: i.tail }
  };
}

/** Deep copy of the messages with every cache marker removed (prefix-stability comparisons). */
export function stripCacheMarkers(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const { cacheControl: _drop, ...rest } = message as ChatMessage & { cacheControl?: CacheControl };
    if (!Array.isArray(rest.content)) return structuredClone(rest) as ChatMessage;
    return {
      ...rest,
      content: rest.content.map((block) => {
        const { cacheControl: _ignored, ...plain } = block as TextBlock;
        return structuredClone(plain);
      })
    } as ChatMessage;
  });
}
