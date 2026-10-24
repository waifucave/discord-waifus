import { readFileSync } from "node:fs";
import { activeWinterIdentity, setWinterIdentity, type ProviderEvent, type ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { DISCORD_WAIFUS_IDENTITY, discordWaifusIdentity } from "../src/models/winter.js";
import { describe, expect, it } from "vitest";
import { callCostUsd, DEFAULT_OUTPUT_CAP_TOKENS, ModelClient, type ModelCallRequest } from "../src/models/client.js";
import { isContextOverflowError, ModelCallError } from "../src/models/errors.js";
import { ProviderAlerts, ProviderCooldownError } from "../src/orchestration/providerAlerts.js";
import type { UsageLedger } from "../src/orchestration/usageLedger.js";
import { UsageLedgerEntrySchema, type UsageLedgerEntry } from "../src/shared/schemas/usage.js";
import { ANTHROPIC_MESSAGES, CHAT_COMPLETIONS, errorTurn, fakeAdapter, fakeWinter, hangingTurn, textTurn, type FakeAdapter } from "./modelFakes.js";

const DEEPSEEK = { providerId: "deepseek", modelId: "deepseek-flash" };
const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };

function harness(o: { adapters?: FakeAdapter[]; key?: string | undefined; now?: () => number } = {}) {
  const chat = fakeAdapter(CHAT_COMPLETIONS, [() => textTurn("hello")]);
  const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, [() => textTurn("hello")]);
  const lines: UsageLedgerEntry[] = [];
  const ledger: UsageLedger = { record: async (entry) => void lines.push(entry as UsageLedgerEntry), flush: async () => undefined };
  const alerts = new ProviderAlerts(o.now ? { now: o.now } : {});
  const key = "key" in o ? o.key : "sk-test-key";
  const client = new ModelClient({
    winter: fakeWinter(...(o.adapters ?? [chat, anthropic])),
    credentials: () => key,
    usageLedger: ledger,
    providerAlerts: alerts
  });
  return { client, chat, anthropic, lines, alerts };
}

function request(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    route: DEEPSEEK,
    system: ["SYSTEM A", "HEADER B"],
    messages: [{ role: "user", content: "hi" }],
    attribution: { purpose: "life", waifuId: "aria", turnId: "turn-1" },
    ...over
  };
}

describe("winter identity (0.0.56 W9)", () => {
  it("names Discord Waifus and its own release; winter accepts it", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(discordWaifusIdentity()).toEqual({ ...DISCORD_WAIFUS_IDENTITY, version: pkg.version });
    const restore = setWinterIdentity(discordWaifusIdentity());
    try {
      expect(activeWinterIdentity()).toMatchObject({ product: "discord-waifus", version: pkg.version });
    } finally {
      restore();
    }
  });
});

describe("ModelClient request shape (spec §5.4, §9.1)", () => {
  it("passes system blocks as system + systemBlocks with a 1h TTL, never as a system message, and the key inline", async () => {
    const { client, chat } = harness();
    const result = await client.call(request({ cacheKey: "life:aria", effort: "high", maxOutputTokens: 512 }));
    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(chat.calls).toHaveLength(1);
    const { request: turn, context } = chat.calls[0]!;
    expect(turn.system).toBe("SYSTEM A\n\nHEADER B");
    expect(turn.systemBlocks).toEqual([
      { text: "SYSTEM A", cacheScope: "org" },
      { text: "HEADER B", cacheScope: "org" }
    ]);
    expect(turn.cacheTtl).toBe("1h");
    // winter W3: rolling message TTL never above the system TTL.
    expect((turn as { messageCacheTtl?: unknown }).messageCacheTtl).toEqual({ rolling: "1h" });
    expect(turn.cacheKey).toBe("life:aria");
    expect(turn.effort).toBe("high");
    expect(turn.maxOutputTokens).toBe(512);
    expect(turn.messages.some((message) => message.role === "system")).toBe(false);
    expect(turn.signal).toBeInstanceOf(AbortSignal);
    expect(context.authRef).toEqual({ kind: "inline", value: "sk-test-key" });
    expect(context.connection.providerId).toBe("deepseek");
  });

  it("applies our own output cap only when neither the caller nor the catalog row names one (winter W2)", async () => {
    const { client, chat } = harness();
    await client.call(request({ route: { providerId: "meta", modelId: "muse-spark-1.3-contributor" } }));
    expect(chat.calls[0]!.request.maxOutputTokens).toBe(DEFAULT_OUTPUT_CAP_TOKENS);
    await client.call(request({ route: { providerId: "meta", modelId: "muse-spark-1.3-contributor" }, maxOutputTokens: 300 }));
    expect(chat.calls[1]!.request.maxOutputTokens).toBe(300);
    await client.call(request());
    expect(chat.calls[2]!.request.maxOutputTokens).toBeUndefined();
  });

  it("drops empty system blocks and sends no system at all when none are left", async () => {
    const { client, chat } = harness();
    await client.call(request({ system: ["", ""] }));
    expect(chat.calls[0]!.request.system).toBeUndefined();
    expect(chat.calls[0]!.request.systemBlocks).toBeUndefined();
  });

  it("refuses a role:system message before any network or ledger work", async () => {
    const { client, chat, lines } = harness();
    await expect(client.call(request({ messages: [{ role: "system", content: "no" }, { role: "user", content: "hi" }] }))).rejects.toBeInstanceOf(TypeError);
    expect(chat.calls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it("sends tools as JSON-schema tools and a forced tool choice", async () => {
    const { client, chat } = harness();
    const tools = [{ name: "send", description: "Send a message.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
    await client.call(request({ tools, toolChoice: { type: "tool", name: "send" } }));
    expect(chat.calls[0]!.request.tools).toEqual(tools);
    expect(chat.calls[0]!.request.toolChoice).toEqual({ type: "tool", name: "send" });
  });

  it("renders the history through winter: an earlier tool loop reaches the adapter", async () => {
    const { client, chat } = harness();
    const first = await client.call(request());
    const history: ProviderMessageLike[] = [
      { role: "user", content: "hi" },
      first.message,
      { role: "user", content: "again" }
    ];
    await client.call(request({ messages: history }));
    const sent = chat.calls[1]!.request.messages;
    expect(sent.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("ModelClient assembly", () => {
  it("assembles fragmented tool calls and reports tool_use", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () => [
        { type: "message_start" },
        { type: "text_delta", text: "Let me look." },
        { type: "tool_call_start", id: "c1", name: "read_messages" },
        { type: "tool_call_delta", id: "c1", argumentsJsonDelta: '{"limit":' },
        { type: "tool_call_delta", id: "c1", argumentsJsonDelta: "20}" },
        { type: "tool_call_end", id: "c1" },
        { type: "tool_call_start", id: "c2", name: "broken" },
        { type: "tool_call_delta", id: "c2", argumentsJsonDelta: "{not json" },
        { type: "tool_call_end", id: "c2" },
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        { type: "done", stopReason: "tool_use" }
      ]
    ]);
    const { client } = harness({ adapters: [chat] });
    const result = await client.call(request());
    expect(result.finishReason).toBe("tool_use");
    expect(result.text).toBe("Let me look.");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "read_messages", input: { limit: 20 } },
      { id: "c2", name: "broken", input: { __winter_unparsed_arguments: "{not json" } }
    ]);
    expect(result.message.content.map((block) => block.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(result.message.origin).toMatchObject({ providerId: "deepseek", modelKey: "deepseek/deepseek-flash" });
  });

  it("keeps Anthropic thinking blocks in stream order, stamps native state and streams deltas to the sink", async () => {
    const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, [
      () => [
        { type: "message_start", id: "msg_1" },
        { type: "thinking_summary_delta", text: "thinking…" },
        { type: "native_thinking_block", block: { type: "thinking", thinking: "plan", signature: "sig-1" } },
        { type: "text_delta", text: "Hi " },
        { type: "text_delta", text: "there" },
        { type: "tool_call_start", id: "t1", name: "send" },
        { type: "tool_call_delta", id: "t1", argumentsJsonDelta: '{"text":"yo"}' },
        { type: "tool_call_end", id: "t1" },
        { type: "native_state", items: [{ opaque: 1 }] },
        { type: "usage", inputTokens: 50, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 20 },
        { type: "done", stopReason: "tool_use" }
      ]
    ]);
    const { client } = harness({ adapters: [anthropic] });
    const seen: string[] = [];
    const result = await client.stream(request({ route: SONNET }), {
      onTextDelta: (text) => seen.push(`text:${text}`),
      onReasoningDelta: (text) => seen.push(`reasoning:${text}`),
      onToolCallStart: (_id, name) => seen.push(`call:${name}`),
      onToolCallEnd: (id) => seen.push(`end:${id}`)
    });
    expect(seen).toEqual(["reasoning:thinking…", "text:Hi ", "text:there", "call:send", "end:t1"]);
    expect(result.message.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig-1" },
      { type: "text", text: "Hi there" },
      { type: "tool_use", id: "t1", name: "send", input: { text: "yo" } }
    ]);
    expect(result.message.nativeState).toMatchObject({ family: "anthropic", items: [{ opaque: 1 }] });
    expect(result.reasoningSummary).toBe("thinking…");
    expect(result.responseId).toBe("msg_1");
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 20 });
  });

  it("maps winter stop reasons", async () => {
    const cases: Array<[Extract<ProviderEvent, { type: "done" }>["stopReason"], string]> = [
      ["max_tokens", "length"],
      ["refusal", "refusal"],
      ["model_context_window_exceeded", "context_window"],
      ["pause_turn", "paused"],
      ["end_turn", "stop"]
    ];
    for (const [stopReason, finishReason] of cases) {
      const chat = fakeAdapter(CHAT_COMPLETIONS, [() => [{ type: "text_delta", text: "x" }, { type: "done", stopReason }]]);
      const { client } = harness({ adapters: [chat] });
      expect((await client.call(request())).finishReason, stopReason).toBe(finishReason);
    }
  });
});

describe("ModelClient usage ledger (spec §9.1)", () => {
  it("writes one ok line per call with the attribution, winter usage and a list-price cost", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [() => textTurn("ok", { inputTokens: 1_000_000, outputTokens: 1_000_000 })]);
    const { client, lines } = harness({ adapters: [chat] });
    const result = await client.call(request({ attribution: { purpose: "maintenance", waifuId: "aria", turnId: "t-9", conversationKey: "life:aria" } }));
    expect(lines).toHaveLength(1);
    const line = UsageLedgerEntrySchema.parse(lines[0]);
    expect(line).toMatchObject({
      purpose: "maintenance",
      waifuId: "aria",
      turnId: "t-9",
      conversationKey: "life:aria",
      providerId: "deepseek",
      modelId: "deepseek-flash",
      status: "ok",
      usageKnown: true,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      finishReason: "stop"
    });
    // DeepSeek Flash's official list price: $0.30 in + $1.20 out per million tokens.
    expect(line.costUsd).toBeCloseTo(1.5, 6);
    expect(result.costUsd).toBeCloseTo(1.5, 6);
    expect(line.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("prefers the provider's reported cost (winter W5), 0 included, over the list-price estimate", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () => [
        { type: "text_delta", text: "ok" },
        { type: "usage", inputTokens: 1_000_000, outputTokens: 1_000_000, reportedCostUsd: 0 } as ProviderEvent,
        { type: "done", stopReason: "end_turn" }
      ]
    ]);
    const { client, lines } = harness({ adapters: [chat] });
    const result = await client.call(request());
    expect(result.costUsd).toBe(0);
    expect(lines[0]!.costUsd).toBe(0);
    expect(callCostUsd({ inputTokens: 1, outputTokens: 1, reportedCostUsd: 0.42 }, { costUsd: 9, costBasis: "list" })).toBe(0.42);
    expect(callCostUsd({ inputTokens: 1, outputTokens: 1 }, { costUsd: 9, costBasis: "list" })).toBe(9);
    expect(callCostUsd({ inputTokens: 1, outputTokens: 1 }, { costUsd: 0, costBasis: "unknown" })).toBeUndefined();
  });

  it("records failed and aborted calls with their error kind", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () => errorTurn({ code: "server", message: "upstream exploded", status: 500, retryable: false }, [{ type: "message_start" }, { type: "usage", inputTokens: 7, outputTokens: 0 }])
    ]);
    const { client, lines } = harness({ adapters: [chat] });
    const failure = await client.call(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelCallError);
    expect(failure).toMatchObject({ kind: "other", code: "server", status: 500 });
    expect(lines).toEqual([expect.objectContaining({ status: "failed", errorKind: "other", inputTokens: 7 })]);
  });

  it("prices a failed line whenever its usage is known", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () => errorTurn({ code: "server", message: "boom", status: 500, retryable: false }, [{ type: "message_start" }, { type: "usage", inputTokens: 1_000_000, outputTokens: 0 }])
    ]);
    const { client, lines } = harness({ adapters: [chat] });
    await client.call(request()).catch(() => undefined);
    // deepseek-flash lists $0.30 per million input tokens.
    expect(lines[0]).toMatchObject({ status: "failed", inputTokens: 1_000_000 });
    expect(lines[0]!.costUsd).toBeCloseTo(0.3, 6);
  });
});

describe("ModelClient errors and alerts", () => {
  it("maps rate limits, auth and context overflow", async () => {
    const cases: Array<[Extract<ProviderEvent, { type: "error" }>["error"], string]> = [
      [{ code: "rate_limit", message: "slow down", status: 429, retryable: true }, "rate_limit"],
      [{ code: "auth", message: "bad key", status: 401, retryable: false }, "auth"],
      [{ code: "bad_request", message: "prompt is too long", status: 400, retryable: false, contextOverflow: true }, "context_overflow"]
    ];
    for (const [error, kind] of cases) {
      const chat = fakeAdapter(CHAT_COMPLETIONS, [() => errorTurn(error)]);
      const { client, alerts } = harness({ adapters: [chat] });
      const failure = await client.call(request()).catch((caught: unknown) => caught);
      expect(failure, kind).toMatchObject({ kind });
      expect(alerts.snapshot()).toEqual([]);
      if (kind === "context_overflow") expect(isContextOverflowError(failure)).toBe(true);
    }
  });

  it("a quota error opens the provider cooldown; later calls fail fast with no request and no ledger line", async () => {
    let now = Date.parse("2026-10-24T12:00:00.000Z");
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () => errorTurn({ code: "rate_limit", message: "You exceeded your current quota", status: 429, providerCode: "insufficient_quota", retryable: false }),
      () => textTurn("back")
    ]);
    const { client, alerts, lines } = harness({ adapters: [chat], now: () => now });
    await expect(client.call(request())).rejects.toMatchObject({ kind: "quota" });
    expect(alerts.snapshot()).toMatchObject([{ providerId: "deepseek", kind: "quota" }]);
    const blocked = await client.call(request()).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ProviderCooldownError);
    expect(blocked).toMatchObject({ code: "provider_quota" });
    expect(chat.calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    now += 10 * 60_000;
    expect((await client.call(request())).text).toBe("back");
  });

  it("a subscription-quota rate_limit event makes a 429 a quota error; a billing code opens the billing cooldown", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () => [
        { type: "rate_limit", kind: "subscription-quota", info: {} },
        { type: "error", error: { code: "rate_limit", message: "window used", status: 429, retryable: false } }
      ],
      () => errorTurn({ code: "bad_request", message: "credit balance too low", status: 400, providerCode: "billing_error", retryable: false })
    ]);
    const { client, alerts } = harness({ adapters: [chat] });
    await expect(client.call(request())).rejects.toMatchObject({ kind: "quota" });
    alerts.clear("deepseek");
    await expect(client.call(request())).rejects.toMatchObject({ kind: "billing" });
    expect(alerts.snapshot()).toMatchObject([{ providerId: "deepseek", kind: "billing" }]);
  });

  it("Anthropic's credit-balance 400 opens the billing cooldown (review I7)", async () => {
    const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, [
      () =>
        errorTurn({
          code: "bad_request",
          status: 400,
          providerCode: "invalid_request_error",
          message: "HTTP 400 — Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
          retryable: false
        })
    ]);
    const { client, alerts } = harness({ adapters: [anthropic] });
    await expect(client.call(request({ route: SONNET }))).rejects.toMatchObject({ kind: "billing" });
    expect(alerts.snapshot()).toMatchObject([{ providerId: "anthropic", kind: "billing" }]);
  });

  it("a throw inside the adapter becomes a typed ModelCallError", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () =>
        (async function* () {
          yield { type: "message_start" } as ProviderEvent;
          throw new Error("socket hang up");
        })()
    ]);
    const { client } = harness({ adapters: [chat] });
    await expect(client.call(request())).rejects.toBeInstanceOf(ModelCallError);
  });

  it("missing credentials and unknown routes fail before the adapter", async () => {
    const { client, chat, lines } = harness({ key: undefined });
    await expect(client.call(request())).rejects.toMatchObject({ kind: "auth", code: "missing_credentials" });
    const known = harness();
    await expect(known.client.call(request({ route: { providerId: "deepseek", modelId: "no-such-model" } }))).rejects.toMatchObject({ code: "unknown_model" });
    expect(chat.calls).toHaveLength(0);
    expect(known.chat.calls).toHaveLength(0);
    expect(lines).toEqual([expect.objectContaining({ status: "failed", errorKind: "auth" })]);
  });
});

describe("ModelClient abort and timeout", () => {
  it("the caller's abort ends the call as aborted, with an aborted ledger line and no alert", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [hangingTurn()]);
    const { client, lines, alerts } = harness({ adapters: [chat] });
    const controller = new AbortController();
    const pending = client.call(request({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(chat.calls[0]!.request.signal?.aborted).toBe(true);
    expect(lines).toEqual([expect.objectContaining({ status: "aborted", errorKind: "aborted" })]);
    expect(alerts.snapshot()).toEqual([]);
  });

  it("the wall-clock timeout aborts the adapter and reports a retryable timeout", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [hangingTurn()]);
    const { client, lines } = harness({ adapters: [chat] });
    const failure = await client.call(request({ timeoutMs: 20 })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "other", code: "timeout", retryable: true, committed: false });
    expect(lines).toEqual([expect.objectContaining({ status: "failed", errorKind: "other" })]);
  });

  it("a timeout after part of the answer arrived is not retryable (review I6)", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [hangingTurn([{ type: "message_start" }, { type: "text_delta", text: "half an ans" }])]);
    const { client } = harness({ adapters: [chat] });
    const failure = await client.call(request({ timeoutMs: 20 })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "other", code: "timeout", retryable: false, committed: true });
  });

  it("a retryable provider error is retryable only while nothing was committed (review I6)", async () => {
    const early = fakeAdapter(CHAT_COMPLETIONS, [() => errorTurn({ code: "server", message: "overloaded", status: 503, retryable: true })]);
    const before = await harness({ adapters: [early] }).client.call(request()).catch((error: unknown) => error);
    expect(before).toMatchObject({ code: "server", retryable: true, committed: false });

    const late = fakeAdapter(CHAT_COMPLETIONS, [
      () => errorTurn({ code: "network", message: "socket closed", retryable: true }, [{ type: "message_start" }, { type: "text_delta", text: "Hel" }])
    ]);
    const after = await harness({ adapters: [late] }).client.call(request()).catch((error: unknown) => error);
    expect(after).toBeInstanceOf(ModelCallError);
    expect(after).toMatchObject({ code: "network", retryable: false, committed: true });
  });

  it("an abort reported as done:aborted keeps the fold's partial usage, priced", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      hangingTurn([{ type: "message_start" }, { type: "text_delta", text: "so" }, { type: "usage", inputTokens: 1_000_000, outputTokens: 10 }])
    ]);
    const { client, lines } = harness({ adapters: [chat] });
    const controller = new AbortController();
    const pending = client.call(request({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "aborted", inputTokens: 1_000_000, outputTokens: 10, usageKnown: true });
    expect(lines[0]!.costUsd).toBeGreaterThan(0);
  });

  it("a call whose stream completed is ok even when the caller aborts right after", async () => {
    const controller = new AbortController();
    const chat = fakeAdapter(CHAT_COMPLETIONS, [
      () =>
        (async function* () {
          for (const event of textTurn("done in time")) yield event;
          controller.abort();
        })()
    ]);
    const { client, lines } = harness({ adapters: [chat] });
    const result = await client.call(request({ signal: controller.signal }));
    expect(controller.signal.aborted).toBe(true);
    expect(result.text).toBe("done in time");
    expect(lines).toEqual([expect.objectContaining({ status: "ok" })]);
  });
});
