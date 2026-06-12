import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { GatewayPipelineError } from "../src/orchestration/pipeline/params.js";
import { ContextMessage } from "../src/orchestration/context.js";
import type { ProviderRequest } from "../src/providers/types.js";

const msg = (over: Partial<ContextMessage>): ContextMessage => ({
  id: "m1", channelId: "c", authorKind: "user", authorId: "u1", name: "ann",
  displayName: "Ann", content: "hello", timestamp: "2026-06-12T10:00:00.000Z",
  reactions: [], ...over
});

const okFetch = (payload: unknown) => vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

const makePipeline = (fetchImpl: typeof fetch, providerId = "deepseek", modelId = "deepseek-v4-flash") =>
  createGatewayModelPipeline({
    providerId, modelId, queryRole: "waifu",
    gateway: createGateway({ credentials: { deepseek: "sk-t", anthropic: "sk-a", openai: "sk-o", "google-ai-studio": "sk-g" }, fetchImpl })
  });

describe("generateWaifu (gateway)", () => {
  const baseRequest = {
    modelId: "deepseek-v4-flash",
    systemPrompt: "SYS",
    messages: [msg({}), msg({ id: "m2", authorKind: "waifu" as const, authorId: "bot-1", content: "yo" })],
    selfAuthorIds: ["bot-1"],
    temperature: 0.7,
    reasoning: { enabled: false }
  };

  it("returns trimmed text content and flat usage", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "  hey there  " }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu(baseRequest);
    expect(result.content).toBe("hey there");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });

  it("throws on empty content", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "   " }, finish_reason: "stop" }], usage: {} });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu(baseRequest)).rejects.toThrow();
  });

  it("collects add_memory entries and a valid PickNextWaifu handoff", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{
        message: {
          content: "answer text",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "add_memory", arguments: JSON.stringify({ content: "Ann likes tea" }) } },
            { id: "c2", type: "function", function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "riko" }) } }
          ]
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true, pickNextWaifuToolEnabled: true, availableWaifuIds: ["riko"]
    });
    expect(result.content).toBe("answer text");
    expect(result.shortTermMemoryEntries).toEqual(["Ann likes tea"]);
    expect(result.pickedNextWaifuId).toBe("riko");
  });

  it("rejects an unavailable PickNextWaifu target", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: "text", tool_calls: [{ id: "c1", type: "function", function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "ghost" }) } }] }, finish_reason: "stop" }],
      usage: {}
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, pickNextWaifuToolEnabled: true, availableWaifuIds: ["riko"]
    });
    expect(result.pickedNextWaifuId).toBeUndefined();
    expect(result.rejectedPickNextWaifu).toEqual({ reason: "unavailable_waifu", waifuId: "ghost" });
  });

  it("sends tools only when enabled, with auto toolChoice (wire golden)", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: {} });
    await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("add_memory");
    expect(body.tool_choice === undefined || body.tool_choice === "auto").toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("decideOrchestrator (gateway)", () => {
  const orchRequest: ProviderRequest = {
    modelId: "deepseek-v4-flash",
    systemPrompt: "ORCH SYSTEM",
    trailingPrompt: "Decide now.",
    messages: [msg({})],
    availableWaifuIds: ["yuki"],
    replyRequired: false,
    directiveBudgetOpen: true,
    reasoning: { enabled: true, effort: "high" as const }
  };

  it("forces the decision tool, disables thinking via pre-conform, parses the decision", async () => {
    const decision = { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 2, directive: { intent: "spotlight", goal: "greet Ann" } }], reasoning: "Ann said hi" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(decision) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    const parsed = await pipeline.decideOrchestrator!(orchRequest);
    expect(parsed.action).toBe("reply");
    expect(parsed.respondingWaifus[0]).toMatchObject({ waifuId: "yuki", directive: { intent: "spotlight", goal: "greet Ann" } });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "orchestrator_decision" } });
    // pre-conform disables thinking when forcing a tool; the gateway may still emit
    // reasoning_effort on the wire as a separate parameter — what matters is thinking is off.
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("rejects a decision violating the zod refinements", async () => {
    const bad = { action: "reply", respondingWaifus: [], reasoning: "contradiction" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(bad) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!(orchRequest)).rejects.toThrow(GatewayPipelineError);
  });

  it("enforces replyRequired: a no_reply decision under /run throws", async () => {
    const noReply = { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "nothing to say" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(noReply) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(
      makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!({ ...orchRequest, replyRequired: true })
    ).rejects.toThrow(/replyRequired/);
  });
});

describe("decideReviewer (gateway)", () => {
  it("forces review_message and parses the verdict", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "review_message", arguments: JSON.stringify({ hallucination: true }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    const verdict = await pipeline.decideReviewer!({ modelId: "deepseek-v4-flash", messages: [msg({})], message: "suspect text" });
    expect(verdict).toEqual({ hallucination: true });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "review_message" } });
    expect(JSON.stringify(body.messages)).toContain("suspect text");
  });
});

describe("decideStageManagerObservations (gateway)", () => {
  it("forces record_observations and parses entities", async () => {
    const observations = [{ waifuId: "yuki", content: "Ann prefers tea", importance: 3, kind: "preference", entities: ["Ann"] }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "record_observations", arguments: JSON.stringify({ observations }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideStageManagerObservations!({
      modelId: "deepseek-v4-flash", messages: [msg({})], availableWaifuIds: ["yuki"]
    });
    expect(out).toEqual(observations);
  });
});

describe("decideDream (gateway)", () => {
  const dreamRequest = {
    modelId: "deepseek-v4-flash",
    messages: [],
    memories: [{ memoryIndex: 1, waifuId: "yuki", content: "old note", kind: "note" as const, strength: 2, ageDays: 10, daysSinceRetrieved: 5 }],
    observations: [],
    availableWaifuIds: ["yuki"]
  };

  it("forces dream_memories and parses ops", async () => {
    const ops = [{ op: "decay", memoryIndex: 1, strength: 1 }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "dream_memories", arguments: JSON.stringify({ ops }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideDream!(dreamRequest);
    expect(out).toEqual([{ op: "decay", memoryIndex: 1, strength: 1 }]);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body.messages)).toContain("old note");
  });
});

describe("generatePersonaDigest (gateway)", () => {
  it("forces set_persona_digest and returns voice/role", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: JSON.stringify({ voice: "dry wit", role: "older sister" }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).generatePersonaDigest!({
      modelId: "deepseek-v4-flash", messages: [], personaText: "PERSONA TEXT"
    });
    expect(out).toEqual({ voice: "dry wit", role: "older sister" });
  });

  it("throws on malformed digest", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: JSON.stringify({ voice: "" }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).generatePersonaDigest!({
      modelId: "deepseek-v4-flash", messages: [], personaText: "X"
    })).rejects.toThrow();
  });
});
