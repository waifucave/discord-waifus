import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { ContextMessage } from "../src/orchestration/context.js";

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
