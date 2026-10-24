import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway, type ChatRequest, type ChatResponse } from "@waifucave/gateway";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { TruncatedOutputError } from "../src/orchestration/pipeline/params.js";
import { createUsageLedger } from "../src/orchestration/usageLedger.js";
import { UsageLedgerEntrySchema, type UsageLedgerEntry } from "../src/shared/schemas/usage.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import { ORCHESTRATOR_TOOL_NAME, REVIEWER_TOOL_NAME, OBSERVER_TOOL_NAME, DREAM_TOOL_NAME, PERSONA_DIGEST_TOOL_NAME } from "../src/orchestration/tools.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
import { testPrompt } from "./contextFixtures.js";

const roots: string[] = [];
const ledgers: Array<{ flush(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((l) => l.flush()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const msg = (over: Partial<ContextMessage> = {}): ContextMessage => ({
  id: "m1", channelId: "c", authorKind: "user", authorId: "u1", name: "ann",
  displayName: "Ann", content: "hello", timestamp: "2026-06-12T10:00:00.000Z", reactions: [], ...over
});

type Script = Array<ChatResponse | Error | ((request: ChatRequest) => ChatResponse)>;

function fakeGateway(script: Script) {
  const real = createGateway({});
  const calls: ChatRequest[] = [];
  const gateway = new Proxy(real, {
    get(target, prop) {
      if (prop === "chat") {
        return async (request: ChatRequest) => {
          calls.push(request);
          const next = script.shift();
          if (!next) throw new Error("no scripted response left");
          if (next instanceof Error) throw next;
          return typeof next === "function" ? next(request) : next;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { gateway: gateway as never, calls };
}

const response = (
  content: ChatResponse["content"],
  finishReason: ChatResponse["finishReason"] = "stop",
  usage: ChatResponse["usage"] = { inputTokens: 100, outputTokens: 10 },
  warnings: ChatResponse["warnings"] = []
): ChatResponse => ({ id: "r", provider: "deepseek", model: "deepseek-v4-flash", content, finishReason, usage, warnings });

const toolCall = (name: string, args: unknown): ChatResponse["content"][number] =>
  ({ type: "toolCall", id: "c1", name, arguments: JSON.stringify(args) });

async function ledgerLines(root: string): Promise<UsageLedgerEntry[]> {
  const day = new Date().toISOString().slice(0, 10);
  const text = await readFile(path.join(root, "user", "usage", `${day}.jsonl`), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => UsageLedgerEntrySchema.parse(JSON.parse(l)));
}

async function setup(script: Script, extra: Partial<Parameters<typeof createGatewayModelPipeline>[0]> = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  const ledger = createUsageLedger(root);
  ledgers.push(ledger);
  const { gateway, calls } = fakeGateway(script);
  const pipeline = createGatewayModelPipeline({
    providerId: "deepseek", modelId: "deepseek-v4-flash", queryRole: "waifu", gateway, usageLedger: ledger, ...extra
  });
  return { pipeline, calls, lines: async () => { await ledger.flush(); return ledgerLines(root); } };
}

const base = { modelId: "deepseek-v4-flash", messages: [msg()] };
// The director sends a context-engine prompt verbatim (spec 8.7).
const orchestratorPrompt = {
  messages: [{ role: "system", content: "director" }, { role: "user", content: "Call orchestrator_decision." }],
  tools: [{ name: ORCHESTRATOR_TOOL_NAME, parameters: { type: "object" } }],
  promptCacheKey: "orchestrator:g_1_2"
} as never;

describe("usage ledger coverage per call path", () => {
  it("writes exactly one attributed line per purpose", async () => {
    const { pipeline, lines } = await setup([
      response([{ type: "text", text: "hi" }]),
      response([{ type: "text", text: "hi again" }]),
      response([toolCall(ORCHESTRATOR_TOOL_NAME, { action: "no_reply", reasoning: "quiet" })], "tool_calls"),
      response([toolCall(REVIEWER_TOOL_NAME, { hallucination: false })], "tool_calls"),
      response([toolCall(OBSERVER_TOOL_NAME, { observations: [] })], "tool_calls"),
      response([toolCall(DREAM_TOOL_NAME, { ops: [] })], "tool_calls"),
      response([toolCall(PERSONA_DIGEST_TOOL_NAME, { voice: "v", role: "r" })], "tool_calls")
    ]);
    await pipeline.generateWaifu({ ...base, prompt: testPrompt() });
    await pipeline.generateWaifu({ ...base, prompt: testPrompt(), attribution: { purpose: "waifu_retry" } });
    await pipeline.decideOrchestrator!({ ...base, prompt: orchestratorPrompt, availableWaifuIds: ["a"], replyRequired: false }).catch(() => undefined);
    await pipeline.decideReviewer!({ ...base, message: "x" }).catch(() => undefined);
    await pipeline.decideStageManagerObservations!({ ...base, availableWaifuIds: ["a"], observerInput: "Transcript:" }).catch(() => undefined);
    await pipeline.decideDream!({ ...base, memories: [], observations: [], availableWaifuIds: ["a"] }).catch(() => undefined);
    await pipeline.generatePersonaDigest!({ ...base, personaText: "p" }).catch(() => undefined);

    const got = await lines();
    expect(got.map((l) => l.purpose)).toEqual([
      "waifu_reply", "waifu_retry", "orchestrator", "reviewer", "observer", "dream", "persona_digest"
    ]);
    for (const line of got) {
      expect(line).toMatchObject({ providerId: "deepseek", modelId: "deepseek-v4-flash", status: "ok", usageKnown: true, inputTokens: 100, outputTokens: 10 });
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
      expect(line.estimatedInputTokens).toBeGreaterThan(0);
    }
  });

  it("records the assistant tool loop as one line per round", async () => {
    const { pipeline, lines } = await setup([
      response([toolCall("list_waifus", {})], "tool_calls"),
      response([{ type: "text", text: "done" }])
    ]);
    await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-flash",
      messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async () => "[]"
    });
    expect((await lines()).map((l) => l.purpose)).toEqual(["assistant", "assistant"]);
  });

  it("prefers ProviderRequest.attribution and carries its ids", async () => {
    const { pipeline, lines } = await setup([response([{ type: "text", text: "summary" }])]);
    await pipeline.generateWaifu({
      ...base, prompt: testPrompt(),
      attribution: { purpose: "compaction", agentId: "ag", waifuId: "w1", guildId: "g1", channelId: "c1", conversationKey: "g_g1_c1" }
    });
    expect((await lines())[0]).toMatchObject({ purpose: "compaction", agentId: "ag", waifuId: "w1", guildId: "g1", channelId: "c1", conversationKey: "g_g1_c1" });
  });

  it("records aborted calls (caller signal) with zero tokens and usageKnown false", async () => {
    const controller = new AbortController();
    const { pipeline, lines } = await setup([
      (request) => { controller.abort(); throw request.signal?.reason ?? new DOMException("aborted", "AbortError"); }
    ]);
    await expect(pipeline.generateWaifu({ ...base, prompt: testPrompt(), signal: controller.signal })).rejects.toBeDefined();
    expect((await lines())[0]).toMatchObject({ status: "aborted", usageKnown: false, inputTokens: 0, outputTokens: 0, purpose: "waifu_reply" });
  });

  it("records failed calls with errorKind, and the timeout case as failed", async () => {
    const { GatewayError } = await import("@waifucave/gateway");
    const { pipeline, lines } = await setup([
      new GatewayError("server", "boom"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" })
    ]);
    await expect(pipeline.generateWaifu({ ...base, prompt: testPrompt() })).rejects.toThrow("boom");
    await expect(pipeline.decideReviewer!({ ...base, message: "x" })).rejects.toThrow("timed out");
    const got = await lines();
    expect(got[0]).toMatchObject({ status: "failed", errorKind: "server", usageKnown: false, inputTokens: 0 });
    expect(got[1]).toMatchObject({ status: "failed", errorKind: "timeout", purpose: "reviewer" });
  });

  it("records cache, reasoning and cost fields and surfaces finishReason/usage on the result", async () => {
    const usage = { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, reasoningTokens: 20, costUsd: 0.0042 };
    const { pipeline, lines } = await setup([response([{ type: "text", text: "hey" }], "length", usage)]);
    const result = await pipeline.generateWaifu({ ...base, prompt: testPrompt() });
    expect(result.usage).toEqual(usage);
    expect(result.finishReason).toBe("length");
    expect((await lines())[0]).toMatchObject({ ...usage, finishReason: "length", usageKnown: true });
  });
});

describe("promptCacheKey", () => {
  it("passes ProviderRequest.prompt.promptCacheKey through to the gateway", async () => {
    const { pipeline, calls } = await setup([response([{ type: "text", text: "hey" }]), response([{ type: "text", text: "hey" }])]);
    const prompt = testPrompt({ promptCacheKey: "waifu:w1:g_1_2" });
    await pipeline.generateWaifu({ ...base, prompt });
    await pipeline.decideReviewer!({ ...base, message: "x" }).catch(() => undefined);
    expect(calls[0]!.promptCacheKey).toBe("waifu:w1:g_1_2");
    expect(calls[1]!.promptCacheKey).toBeUndefined();
  });
});

describe("truncated structured decisions", () => {
  it("throws TruncatedOutputError for a length-finished forced-tool decision", async () => {
    const { pipeline } = await setup([
      response([toolCall(REVIEWER_TOOL_NAME, { hallucination: true })], "length")
    ]);
    await expect(pipeline.decideReviewer!({ ...base, message: "x" })).rejects.toBeInstanceOf(TruncatedOutputError);
  });

  it("throws TruncatedOutputError on the JSON-schema path", async () => {
    const { pipeline } = await setup([response([{ type: "text", text: '{"halluc' }], "length")], {
      providerId: "openrouter", modelId: "meta/muse-spark-1.1"
    });
    await expect(pipeline.decideReviewer!({ ...base, message: "x" })).rejects.toMatchObject({ code: "truncated" });
  });

  it("rejects a length-finished orchestrator decision so the runner's deterministic fallback runs", async () => {
    // channelRunner wraps decideOrchestrator in try/catch and falls back to decideDeterministically
    // for any error unless the run was aborted or a reply is required (see its catch block).
    const { pipeline } = await setup([response([toolCall(ORCHESTRATOR_TOOL_NAME, { action: "no_re" })], "length")]);
    await expect(pipeline.decideOrchestrator!({ ...base, prompt: orchestratorPrompt, availableWaifuIds: ["a"], replyRequired: false }))
      .rejects.toBeInstanceOf(TruncatedOutputError);
  });

  it("does not throw for plain waifu replies that hit length", async () => {
    const { pipeline } = await setup([response([{ type: "text", text: "cut off" }], "length")]);
    await expect(pipeline.generateWaifu({ ...base, prompt: testPrompt() })).resolves.toMatchObject({ content: "cut off", finishReason: "length" });
  });
});

describe("single system message", () => {
  const assertOnlyFirstSystem = (calls: ChatRequest[]) => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      call.messages.forEach((message, index) => {
        if (index > 0) expect(message.role, `message ${index}`).not.toBe("system");
      });
    }
  };

  it("sends the schema-tool JSON nudge as a final user message", async () => {
    const { pipeline, calls } = await setup([response([{ type: "text", text: '{"hallucination":true}' }])], {
      providerId: "openrouter", modelId: "meta/muse-spark-1.1"
    });
    await pipeline.decideReviewer!({ ...base, message: "x" });
    assertOnlyFirstSystem(calls);
    const last = calls[0]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Return the arguments for review_message as JSON");
  });

  it("sends the waifu BuiltPrompt verbatim with its single system message", async () => {
    const { pipeline, calls } = await setup([response([{ type: "text", text: "hey" }])], { providerId: "xai", modelId: "grok-4.3" });
    const prompt = testPrompt({
      messages: [
        { role: "user", content: [{ type: "text", text: "HEADER" }] },
        { role: "user", content: [{ type: "text", text: "TAIL" }] }
      ]
    });
    await pipeline.generateWaifu({ modelId: "grok-4.3", prompt });
    assertOnlyFirstSystem(calls);
    expect(calls[0]!.messages).toEqual(prompt.messages);
    expect(JSON.stringify(calls[0]!.messages)).not.toContain("<system_note>");
  });

  it("keeps the assistant transcript's single system message across rounds", async () => {
    const { pipeline, calls } = await setup([
      response([toolCall("list_waifus", {})], "tool_calls"),
      response([{ type: "text", text: "ok" }])
    ]);
    await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-flash",
      messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async () => "[]"
    });
    assertOnlyFirstSystem(calls);
  });
});

describe("assistant reasoning replay", () => {
  it("round-trips reasoning blocks (signature, redacted data, replay, details) unchanged on tool loops", async () => {
    const reasoning = [
      { type: "reasoning" as const, text: "thinking", signature: "sig-1" },
      { type: "reasoning" as const, text: "", redacted: true, data: "ENCRYPTED" },
      { type: "reasoning" as const, text: "", replay: "original hidden thinking" },
      { type: "reasoning" as const, text: "or", details: [{ type: "reasoning.encrypted", data: "x" }] }
    ];
    const call = { type: "toolCall" as const, id: "c1", name: "list_waifus", arguments: "{}", signature: "gem-sig" };
    const { pipeline, calls } = await setup([
      response([...reasoning, call], "tool_calls"),
      response([{ type: "text", text: "final" }])
    ]);
    const events: unknown[] = [];
    const result = await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-flash",
      messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async () => "[]",
      onEvent: (event) => events.push(event)
    });
    const second = calls[1]!.messages.find((m) => m.role === "assistant")!;
    expect(second.content).toEqual([...reasoning, call]);
    expect(result.content).toBe("final");
    // reasoning/replay text is never surfaced through events or the displayed reply
    expect(JSON.stringify(events)).not.toContain("original hidden thinking");
    expect(result.content).not.toContain("original hidden thinking");
  });
});

describe("content_dropped / cache_ignored warnings", () => {
  it("logs each warning once per model", async () => {
    const logger = { warn: vi.fn() };
    const warning = { code: "cache_ignored" as const, param: "promptCacheKey", message: "no prompt caching on this model" };
    const dropped = { code: "content_dropped" as const, param: "messages[0]", message: "image dropped" };
    const { pipeline } = await setup(
      [0, 1, 2].map(() => response([{ type: "text", text: "x" }], "stop", { inputTokens: 1, outputTokens: 1 }, [warning, dropped])),
      { providerId: "deepseek", modelId: "deepseek-v4-pro", logger }
    );
    for (let i = 0; i < 3; i++) await pipeline.generateWaifu({ modelId: "deepseek-v4-pro", prompt: testPrompt(), messages: [] });
    const codes = logger.warn.mock.calls.map((c) => c[0]);
    expect(codes.filter((m) => String(m).includes("cache_ignored"))).toHaveLength(1);
    expect(codes.filter((m) => String(m).includes("content_dropped"))).toHaveLength(1);
  });
});

describe("alerts default", () => {
  it("does nothing special without a dataRoot or alerts", async () => {
    const { pipeline } = await setup([response([{ type: "text", text: "x" }])]);
    await expect(pipeline.generateWaifu({ ...base, prompt: testPrompt() })).resolves.toMatchObject({ content: "x" });
    expect(new ProviderAlerts().snapshot()).toEqual([]);
  });
});
