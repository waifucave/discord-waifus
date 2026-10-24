// The stream assembler: one winter `streamTurn` → one `ProviderMessageLike` (Living cast spec §5.3).
//
// LOCAL STAND-IN for winter W8, shaped like it. winter v0.0.56 exports `foldProviderStream`,
// `assembledToMessage` and `ProviderStreamError` from provider-runtime; until the pin moves, the
// three local definitions below mirror `foldProviderStream` + `stampNativeState` from winter
// 0.0.55's `runtime/src/provider/bridge.ts` with the same contract:
//   - text, tool calls and in-dialect reasoning blocks in stream order (Anthropic family; every
//     other family keeps winter's per-kind assembly: text, then calls), empty text runs dropped;
//   - `origin` (route and model) and opaque `nativeState`, stamped with the resolved family and
//     continuation domain (the route's model key when the catalog names none);
//   - fragmented tool arguments parsed once at the end (unparseable → `__winter_unparsed_arguments`);
//   - the first stream `error` (or a throw) ends the fold with a typed `ProviderStreamError`.
// `assembleTurn` is the thin wrapper the rest of the app calls. The 0.0.56 switch is this file
// only: delete the local `foldProviderStream` / `assembledToMessage` / `ProviderStreamError`,
// import winter's, and map winter's folded turn onto `AssembledTurn` in `assembleTurn`.

import {
  normalizeThrown,
  type ContentBlockLike,
  type MessageOrigin,
  type ProviderError,
  type ProviderEvent,
  type ProviderMessageLike,
  type ProviderNativeState
} from "@yanlinglabs/winter-provider-runtime";

export type WinterStopReason = Extract<ProviderEvent, { type: "done" }>["stopReason"];
export type WinterUsage = Omit<Extract<ProviderEvent, { type: "usage" }>, "type">;

export type AssemblySink = {
  onTextDelta?(text: string): void;
  onToolCallStart?(id: string, name: string): void;
  onToolCallEnd?(id: string): void;
  /** Readable reasoning (a provider summary or exposed reasoning) as it streams. */
  onReasoningDelta?(text: string): void;
  onRetry?(event: Omit<Extract<ProviderEvent, { type: "retry" }>, "type">): void;
};

export type AssembledTurn = {
  /** The assistant message exactly as it is stored and replayed. */
  message: ProviderMessageLike & { role: "assistant"; content: ContentBlockLike[]; origin: MessageOrigin };
  stopReason?: WinterStopReason;
  stopDetails?: { category: string | null; explanation: string | null };
  usage?: WinterUsage;
  responseId?: string;
  /** A provider-written reasoning summary (never part of the message content). */
  reasoningSummary?: string;
  /** Raw exposed reasoning (DeepSeek-class); its replay copy rides `nativeState`. */
  exposedReasoning?: string;
  /** A subscription-quota `rate_limit` event was seen. */
  subscriptionQuota: boolean;
};

/** The fold ended on a provider failure. `committed`: the stream had begun (bytes reached us). */
export class ProviderStreamError extends Error {
  override name = "ProviderStreamError";
  constructor(
    readonly providerError: ProviderError,
    readonly committed: boolean,
    readonly subscriptionQuota: boolean,
    readonly usage?: WinterUsage
  ) {
    super(providerError.message);
  }
}

type InDialectBlock = Extract<ContentBlockLike, { type: "thinking" }> | Extract<ContentBlockLike, { type: "redacted_thinking" }>;

function coerceInDialectBlock(value: unknown): InDialectBlock | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const block = value as Record<string, unknown>;
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { type: "thinking", thinking: block.thinking, signature: typeof block.signature === "string" ? block.signature : "" };
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string") return { type: "redacted_thinking", data: block.data };
  return undefined;
}

function parseToolArguments(argumentsJson: string): unknown {
  if (argumentsJson.trim().length === 0) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return { __winter_unparsed_arguments: argumentsJson };
  }
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // An observation sink never breaks a generation.
  }
}

/** winter's `stampNativeState`: the resolved family and domain (else the model key) on the state. */
export function stampNativeState(items: unknown[], origin: MessageOrigin): ProviderNativeState {
  return { family: String(origin.family), continuationDomain: origin.continuationDomain ?? origin.modelKey, items };
}

type OrderedEntry = { kind: "text"; text: string } | { kind: "block"; block: InDialectBlock } | { kind: "call"; id: string };

/** What the fold produces before it becomes a message (the local twin of winter's folded turn). */
export type FoldedTurn = {
  text: string;
  /** Stream-order content; tool calls are materialised from `calls` by id. */
  ordered: OrderedEntry[];
  calls: Array<{ type: "tool_use"; id: string; name: string; input: unknown }>;
  thinkingBlocks: InDialectBlock[];
  nativeItems?: unknown[];
  stopReason?: WinterStopReason;
  stopDetails?: AssembledTurn["stopDetails"];
  usage?: WinterUsage;
  responseId?: string;
  summary: string;
  exposed: string;
  subscriptionQuota: boolean;
};

/**
 * The fold: consumes one `streamTurn` (local twin of winter W8's `foldProviderStream`). `signal` is
 * accepted for parity with winter's signature; the adapter ends an aborted stream itself.
 */
export async function foldProviderStream(stream: AsyncIterable<ProviderEvent>, sink?: AssemblySink, _signal?: AbortSignal): Promise<FoldedTurn> {
  let text = "";
  let summary = "";
  let exposed = "";
  const thinkingBlocks: InDialectBlock[] = [];
  const callOrder: string[] = [];
  const pendingCalls = new Map<string, { name: string; argumentsJson: string }>();
  const ordered: OrderedEntry[] = [];
  let textOpen = false;
  let usage: WinterUsage | undefined;
  let stopReason: WinterStopReason | undefined;
  let stopDetails: AssembledTurn["stopDetails"];
  let nativeItems: unknown[] | undefined;
  let responseId: string | undefined;
  let committed = false;
  let subscriptionQuota = false;

  try {
    for await (const event of stream) {
      if (event.type !== "retry" && event.type !== "rate_limit" && event.type !== "auth_status" && event.type !== "error") committed = true;
      switch (event.type) {
        case "message_start":
          if (event.id !== undefined) responseId = event.id;
          break;
        case "text_delta": {
          text += event.text;
          const open = ordered[ordered.length - 1];
          if (textOpen && open?.kind === "text") open.text += event.text;
          else {
            ordered.push({ kind: "text", text: event.text });
            textOpen = true;
          }
          if (sink?.onTextDelta) safely(() => sink.onTextDelta!(event.text));
          break;
        }
        case "thinking_summary_delta":
          summary += event.text;
          if (sink?.onReasoningDelta) safely(() => sink.onReasoningDelta!(event.text));
          break;
        case "thinking_exposed_delta":
          exposed += event.text;
          if (sink?.onReasoningDelta) safely(() => sink.onReasoningDelta!(event.text));
          break;
        case "native_thinking_block": {
          const block = coerceInDialectBlock(event.block);
          if (block) {
            thinkingBlocks.push(block);
            ordered.push({ kind: "block", block });
            textOpen = false;
          }
          break;
        }
        case "tool_call_start":
          if (!pendingCalls.has(event.id)) {
            callOrder.push(event.id);
            ordered.push({ kind: "call", id: event.id });
          }
          pendingCalls.set(event.id, { name: event.name, argumentsJson: "" });
          textOpen = false;
          if (sink?.onToolCallStart) safely(() => sink.onToolCallStart!(event.id, event.name));
          break;
        case "tool_call_delta": {
          const pending = pendingCalls.get(event.id);
          if (pending) pending.argumentsJson += event.argumentsJsonDelta;
          break;
        }
        case "tool_call_end":
          if (sink?.onToolCallEnd) safely(() => sink.onToolCallEnd!(event.id));
          break;
        case "native_state":
          // Captured from the completion event only: the last one wins.
          nativeItems = event.items;
          break;
        case "usage": {
          const { type: _type, ...rest } = event;
          usage = rest;
          break;
        }
        case "retry": {
          const { type: _type, ...rest } = event;
          if (sink?.onRetry) safely(() => sink.onRetry!(rest));
          break;
        }
        case "rate_limit":
          if (event.kind === "subscription-quota") subscriptionQuota = true;
          break;
        case "done":
          stopReason = event.stopReason;
          stopDetails = event.stopDetails;
          break;
        case "error": {
          // An overflow refused before anything was produced is not a committed turn (winter I-6).
          const overflow = event.error.contextOverflow === true || event.error.imageOverflow === true;
          throw new ProviderStreamError(event.error, committed && !(overflow && ordered.length === 0), subscriptionQuota, usage);
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof ProviderStreamError) throw error;
    throw new ProviderStreamError(normalizeThrown(error), committed, subscriptionQuota, usage);
  }

  const calls = callOrder.flatMap((id) => {
    const pending = pendingCalls.get(id);
    return pending ? [{ type: "tool_use" as const, id, name: pending.name, input: parseToolArguments(pending.argumentsJson) }] : [];
  });
  return {
    text,
    ordered,
    calls,
    thinkingBlocks,
    ...(nativeItems !== undefined ? { nativeItems } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(stopDetails !== undefined ? { stopDetails } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(responseId !== undefined ? { responseId } : {}),
    summary,
    exposed,
    subscriptionQuota
  };
}

/** A folded turn → the assistant message as stored and replayed (local twin of winter W8's `assembledToMessage`). */
export function assembledToMessage(folded: FoldedTurn, origin: MessageOrigin): AssembledTurn["message"] {
  const { text, ordered, calls, nativeItems } = folded;
  const callsById = new Map(calls.map((call) => [call.id, call]));
  let content: ContentBlockLike[];
  if (origin.family === "anthropic") {
    // Stream order: Anthropic binds thinking blocks to their exact place in a tool loop.
    content = [];
    for (const entry of ordered) {
      if (entry.kind === "text") {
        if (entry.text.length > 0) content.push({ type: "text", text: entry.text });
      } else if (entry.kind === "block") content.push(entry.block);
      else {
        const call = callsById.get(entry.id);
        if (call) content.push(call);
      }
    }
  } else {
    // Every other family: the joined text, then the calls (winter's per-kind assembly).
    content = [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...calls];
  }

  return {
    role: "assistant",
    content,
    origin: { ...origin },
    ...(nativeItems !== undefined ? { nativeState: stampNativeState(nativeItems, origin) } : {})
  };
}

/** The app's one entry point: fold a stream and build the stored message. */
export async function assembleTurn(
  stream: AsyncIterable<ProviderEvent>,
  o: { origin: MessageOrigin; sink?: AssemblySink; signal?: AbortSignal }
): Promise<AssembledTurn> {
  const folded = await foldProviderStream(stream, o.sink, o.signal);
  return {
    message: assembledToMessage(folded, o.origin),
    ...(folded.stopReason !== undefined ? { stopReason: folded.stopReason } : {}),
    ...(folded.stopDetails !== undefined ? { stopDetails: folded.stopDetails } : {}),
    ...(folded.usage !== undefined ? { usage: folded.usage } : {}),
    ...(folded.responseId !== undefined ? { responseId: folded.responseId } : {}),
    ...(folded.summary.length > 0 ? { reasoningSummary: folded.summary } : {}),
    ...(folded.exposed.length > 0 ? { exposedReasoning: folded.exposed } : {}),
    subscriptionQuota: folded.subscriptionQuota
  };
}

/** The joined text blocks of an assembled (or stored) assistant message. */
export function messageText(message: Pick<ProviderMessageLike, "content">): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is Extract<ContentBlockLike, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** The tool calls of an assembled (or stored) assistant message, in order. */
export function messageToolCalls(message: Pick<ProviderMessageLike, "content">): Array<{ id: string; name: string; input: unknown }> {
  if (typeof message.content === "string") return [];
  return message.content
    .filter((block): block is Extract<ContentBlockLike, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
}
