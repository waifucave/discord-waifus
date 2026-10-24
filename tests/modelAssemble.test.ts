import type { MessageOrigin, ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { describe, expect, it } from "vitest";
import { assembleTurn, ProviderStreamError, messageText, messageToolCalls, stampNativeState } from "../src/models/assemble.js";

const OPENAI: MessageOrigin = { providerId: "deepseek", modelKey: "deepseek/deepseek-flash", family: "openai" };
const ANTHROPIC: MessageOrigin = { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic", continuationDomain: "anthropic-claude" };

async function* stream(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  for (const event of events) yield event;
}

describe("assembleTurn (local stand-in for winter W8)", () => {
  it("non-Anthropic families: the joined text, then the calls, whatever the stream order", async () => {
    const turn = await assembleTurn(
      stream([
        { type: "tool_call_start", id: "a", name: "first" },
        { type: "text_delta", text: "Hel" },
        { type: "tool_call_delta", id: "a", argumentsJsonDelta: '{"x":1}' },
        { type: "text_delta", text: "lo" },
        { type: "tool_call_start", id: "b", name: "second" },
        { type: "done", stopReason: "tool_use" }
      ]),
      { origin: OPENAI }
    );
    expect(turn.message.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "a", name: "first", input: { x: 1 } },
      { type: "tool_use", id: "b", name: "second", input: {} }
    ]);
    expect(turn.stopReason).toBe("tool_use");
  });

  it("Anthropic: text runs, thinking blocks and calls in stream order; empty text runs are dropped", async () => {
    const turn = await assembleTurn(
      stream([
        { type: "native_thinking_block", block: { type: "thinking", thinking: "one" } },
        { type: "text_delta", text: "" },
        { type: "tool_call_start", id: "t1", name: "read" },
        { type: "native_thinking_block", block: { type: "redacted_thinking", data: "opaque" } },
        { type: "native_thinking_block", block: { type: "unknown" } },
        { type: "text_delta", text: "after" },
        { type: "done", stopReason: "end_turn" }
      ]),
      { origin: ANTHROPIC }
    );
    expect(turn.message.content).toEqual([
      { type: "thinking", thinking: "one", signature: "" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "after" }
    ]);
    expect(turn.message.origin).toEqual(ANTHROPIC);
  });

  it("stamps the last native_state with the family and the continuation domain (else the model key)", async () => {
    const anthropic = await assembleTurn(stream([{ type: "native_state", items: [1] }, { type: "native_state", items: [2] }]), { origin: ANTHROPIC });
    expect(anthropic.message.nativeState).toEqual({ family: "anthropic", continuationDomain: "anthropic-claude", items: [2] });
    expect(stampNativeState(["x"], OPENAI)).toEqual({ family: "openai", continuationDomain: "deepseek/deepseek-flash", items: ["x"] });
    const none = await assembleTurn(stream([{ type: "text_delta", text: "x" }]), { origin: OPENAI });
    expect(none.message).not.toHaveProperty("nativeState");
  });

  it("keeps summaries and exposed reasoning out of the content, and reports usage, id and quota flags", async () => {
    const turn = await assembleTurn(
      stream([
        { type: "message_start", id: "resp_9" },
        { type: "thinking_summary_delta", text: "sum" },
        { type: "thinking_exposed_delta", text: "raw" },
        { type: "reasoning_progress", block: "b", phase: "delta", kind: "summary", text: "ignored" },
        { type: "rate_limit", kind: "subscription-quota", info: {} },
        { type: "text_delta", text: "answer" },
        { type: "usage", inputTokens: 3, outputTokens: 4, reasoningTokens: 2 },
        { type: "done", stopReason: "end_turn" }
      ]),
      { origin: OPENAI }
    );
    expect(turn.message.content).toEqual([{ type: "text", text: "answer" }]);
    expect(turn).toMatchObject({ responseId: "resp_9", reasoningSummary: "sum", exposedReasoning: "raw", subscriptionQuota: true, usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 2 } });
  });

  it("unparseable tool arguments are kept raw under __winter_unparsed_arguments", async () => {
    const turn = await assembleTurn(
      stream([
        { type: "tool_call_start", id: "x", name: "send" },
        { type: "tool_call_delta", id: "x", argumentsJsonDelta: '{"text": "unterminated' }
      ]),
      { origin: OPENAI }
    );
    expect(messageToolCalls(turn.message)).toEqual([{ id: "x", name: "send", input: { __winter_unparsed_arguments: '{"text": "unterminated' } }]);
  });

  it("an error event ends the fold with the typed error, committed once bytes arrived", async () => {
    const before = await assembleTurn(stream([{ type: "retry", attempt: 1, maxRetries: 3, retryDelayMs: 1, error: "rate_limit" }, { type: "error", error: { code: "rate_limit", message: "429", retryable: true } }]), { origin: OPENAI }).catch((error: unknown) => error);
    expect(before).toBeInstanceOf(ProviderStreamError);
    expect((before as ProviderStreamError).committed).toBe(false);
    const after = await assembleTurn(
      stream([
        { type: "text_delta", text: "partial" },
        { type: "usage", inputTokens: 1, outputTokens: 1 },
        { type: "error", error: { code: "stall", message: "stalled", retryable: false } }
      ]),
      { origin: OPENAI }
    ).catch((error: unknown) => error);
    expect(after).toMatchObject({ committed: true, providerError: { code: "stall" }, usage: { inputTokens: 1, outputTokens: 1 } });
    // An overflow refused before anything was produced is not a committed turn.
    const overflow = await assembleTurn(
      stream([{ type: "message_start" }, { type: "error", error: { code: "bad_request", message: "too long", retryable: false, contextOverflow: true } }]),
      { origin: OPENAI }
    ).catch((error: unknown) => error);
    expect((overflow as ProviderStreamError).committed).toBe(false);
  });

  it("a throwing stream becomes an ProviderStreamError; a throwing sink never breaks the fold", async () => {
    const thrown = await assembleTurn(
      (async function* () {
        yield { type: "text_delta", text: "x" } as ProviderEvent;
        throw new Error("socket closed");
      })(),
      { origin: OPENAI }
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ProviderStreamError);
    const retries: number[] = [];
    const turn = await assembleTurn(
      stream([
        { type: "retry", attempt: 2, maxRetries: 10, retryDelayMs: 5, error: "server_error" },
        { type: "text_delta", text: "fine" },
        { type: "done", stopReason: "end_turn" }
      ]),
      {
        origin: OPENAI,
        sink: {
          onTextDelta: () => {
            throw new Error("sink bug");
          },
          onRetry: (event) => retries.push(event.attempt)
        }
      }
    );
    expect(messageText(turn.message)).toBe("fine");
    expect(retries).toEqual([2]);
  });
});

describe("messageText / messageToolCalls", () => {
  it("read string and block content", () => {
    expect(messageText({ content: "plain" })).toBe("plain");
    expect(messageToolCalls({ content: "plain" })).toEqual([]);
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "tool_use", id: "1", name: "n", input: {} }, { type: "text", text: "b" }] })).toBe("ab");
  });
});
