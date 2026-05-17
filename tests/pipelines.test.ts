import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMessage } from "../src/orchestration/context.js";
import { createModelPipeline } from "../src/providers/pipelines.js";
import { recentQueries } from "../src/shared/queryLog.js";

const context: ContextMessage[] = [
  {
    id: "m1",
    channelId: "c1",
    guildId: "g1",
    authorKind: "user",
    authorId: "u1",
    name: "Kevin",
    displayName: "Kevin",
    content: "remember I like tea",
    timestamp: "2026-05-16T12:00:00Z",
    reactions: []
  }
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider-native decision tools", () => {
  it("uses a single OpenAI-compatible tool for orchestrator decisions", async () => {
    mockFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "orchestrator_decision",
                  arguments: JSON.stringify({
                    action: "no_reply",
                    retriggerAfterSeconds: 100,
                    reasoning: "wait for more context"
                  })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const decision = await pipeline.decideOrchestrator?.({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "decide",
      availableWaifuIds: ["yuki", "mika"]
    });

    expect(decision).toMatchObject({ action: "no_reply", retriggerAfterSeconds: 100 });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("orchestrator");
    expect((query?.payload.tools as Array<{ function: { name: string } }>)[0].function.name).toBe("orchestrator_decision");
    const waifuIdSchema = (query?.payload.tools as Array<{
      function: { parameters: { properties: { selectedWaifus: { items: { properties: { waifuId: { enum?: string[] } } } } } } };
    }>)[0].function.parameters.properties.selectedWaifus.items.properties.waifuId;
    expect(waifuIdSchema.enum).toEqual(["yuki", "mika"]);
    expect(query?.payload.tool_choice).toEqual({
      type: "function",
      function: { name: "orchestrator_decision" }
    });
  });

  it("uses a single OpenAI Responses tool for stage-manager edits", async () => {
    mockFetch({
      output: [
        {
          type: "function_call",
          name: "manage_memories",
          arguments: JSON.stringify({
            toolCalls: [
              {
                tool: "add_memory",
                memory: {
                  waifuId: "yuki",
                  scope: "global",
                  content: "Kevin likes tea.",
                  importance: 3,
                  sourceMessageIndices: [1]
                }
              }
            ]
          })
        }
      ]
    });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    const calls = await pipeline.decideStageManager?.({
      modelId: "gpt-4o-mini",
      messages: context,
      memories: [],
      systemPrompt: "memories"
    });

    expect(calls?.[0]).toMatchObject({
      tool: "add_memory",
      memory: {
        content: "Kevin likes tea.",
        sourceMessageIds: ["m1"]
      }
    });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("stage_manager");
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("manage_memories");
    expect(query?.payload.tool_choice).toEqual({ type: "function", name: "manage_memories" });
  });

  it("uses a single Anthropic tool for orchestrator decisions", async () => {
    mockFetch({
      content: [
        {
          type: "tool_use",
          name: "orchestrator_decision",
          input: {
            action: "stage_manager",
            retriggerAfterSeconds: 300,
            reasoning: "new durable memory may be needed"
          }
        }
      ]
    });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    const decision = await pipeline.decideOrchestrator?.({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "decide"
    });

    expect(decision).toMatchObject({ action: "stage_manager" });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("orchestrator");
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("orchestrator_decision");
    expect(query?.payload.tool_choice).toEqual({ type: "tool", name: "orchestrator_decision" });
  });
});

function mockFetch(json: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }))
  );
}
