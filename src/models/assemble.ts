// The stream assembler (Living cast spec §5.3): winter's own, `foldProviderStream` +
// `assembledToMessage` from `@yanlinglabs/winter-provider-runtime` (0.0.56, W8). One `streamTurn`
// becomes one assistant message: text, tool calls and in-dialect reasoning blocks in winter's order
// (stream order for the Anthropic family), `origin` and opaque `nativeState` stamped with the
// resolved family and continuation domain. A failure throws winter's `ProviderStreamError`
// (`error`, `committed`).
//
// What the app layers on top, in `assembleTurn`:
//   - an observation tap in front of the fold drives the app's sink (text, tool call start/end,
//     readable reasoning as it streams, retries). A throwing app sink method is dropped: watching a
//     generation never ends it;
//   - `StreamObservation` keeps what a failed fold does not return: the last usage event (so a
//     failed or aborted call is still billed) and whether a subscription-quota rate limit was seen.

import {
  assembledToMessage,
  foldProviderStream,
  type AssembledUsage,
  type ContentBlockLike,
  type MessageOrigin,
  type ProviderEvent,
  type ProviderMessageLike
} from "@yanlinglabs/winter-provider-runtime";

export { ProviderStreamError, stampNativeState } from "@yanlinglabs/winter-provider-runtime";

export type WinterStopReason = Extract<ProviderEvent, { type: "done" }>["stopReason"];
export type WinterUsage = AssembledUsage;
type RetryEvent = Omit<Extract<ProviderEvent, { type: "retry" }>, "type">;

/** The app's live view of a generation (the dashboard assistant's SSE). Every method is optional. */
export type AssemblySink = {
  onTextDelta?(text: string): void;
  onToolCallStart?(id: string, name: string): void;
  onToolCallEnd?(id: string): void;
  /** Readable reasoning (a provider summary or exposed reasoning) as it streams. */
  onReasoningDelta?(text: string): void;
  onRetry?(event: RetryEvent): void;
};

/** What the stream showed, kept even when the fold fails. */
export type StreamObservation = {
  /** The last usage event. */
  usage?: WinterUsage;
  /** A subscription-quota `rate_limit` event was seen. */
  subscriptionQuota: boolean;
};

export type AssembledMessage = ProviderMessageLike & { role: "assistant"; origin: MessageOrigin };

export type AssembledTurn = {
  /** The assistant message exactly as it is stored and replayed (a plain-text turn keeps string content). */
  message: AssembledMessage;
  stopReason?: WinterStopReason;
  stopDetails?: { category: string | null; explanation: string | null };
  usage?: WinterUsage;
  responseId?: string;
  /** A provider-written reasoning summary (never part of the message content). */
  reasoningSummary?: string;
  /** Raw exposed reasoning (DeepSeek-class); its replay copy rides `nativeState`. */
  exposedReasoning?: string;
  subscriptionQuota: boolean;
};

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // An observation sink never breaks a generation.
  }
}

/** Observes each event on its way into winter's fold. */
async function* observe(stream: AsyncIterable<ProviderEvent>, observation: StreamObservation, sink: AssemblySink | undefined): AsyncIterable<ProviderEvent> {
  for await (const event of stream) {
    switch (event.type) {
      case "usage": {
        const { type: _type, ...usage } = event;
        observation.usage = usage;
        break;
      }
      case "rate_limit":
        if (event.kind === "subscription-quota") observation.subscriptionQuota = true;
        break;
      case "text_delta":
        if (sink?.onTextDelta) safely(() => sink.onTextDelta!(event.text));
        break;
      case "tool_call_start":
        if (sink?.onToolCallStart) safely(() => sink.onToolCallStart!(event.id, event.name));
        break;
      case "tool_call_end":
        if (sink?.onToolCallEnd) safely(() => sink.onToolCallEnd!(event.id));
        break;
      case "thinking_summary_delta":
      case "thinking_exposed_delta":
        if (sink?.onReasoningDelta) safely(() => sink.onReasoningDelta!(event.text));
        break;
      case "retry": {
        const { type: _type, ...retry } = event;
        if (sink?.onRetry) safely(() => sink.onRetry!(retry));
        break;
      }
      default:
        break;
    }
    yield event;
  }
}

/** The app's one entry point: fold a stream with winter's assembler and build the stored message. */
export async function assembleTurn(
  stream: AsyncIterable<ProviderEvent>,
  o: { origin: MessageOrigin; sink?: AssemblySink; signal?: AbortSignal; observation?: StreamObservation }
): Promise<AssembledTurn> {
  const observation = o.observation ?? { subscriptionQuota: false };
  const turn = await foldProviderStream(observe(stream, observation, o.sink), o.signal ? { signal: o.signal } : {});
  return {
    message: assembledToMessage(turn, o.origin) as AssembledMessage,
    ...(turn.stopReason !== undefined ? { stopReason: turn.stopReason } : {}),
    ...(turn.stopDetails !== undefined ? { stopDetails: turn.stopDetails } : {}),
    ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    ...(turn.responseId !== undefined ? { responseId: turn.responseId } : {}),
    ...(turn.thinking?.summary ? { reasoningSummary: turn.thinking.summary } : {}),
    ...(turn.thinking?.exposed ? { exposedReasoning: turn.thinking.exposed } : {}),
    subscriptionQuota: observation.subscriptionQuota
  };
}

/** True when a message carries any content (text, a call or reasoning). */
export function messageHasContent(message: Pick<ProviderMessageLike, "content">): boolean {
  return message.content.length > 0;
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
