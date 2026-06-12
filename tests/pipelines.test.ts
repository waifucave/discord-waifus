import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMessage } from "../src/orchestration/context.js";
import { RETRIGGER_MAX_SECONDS, RETRIGGER_MIN_SECONDS } from "../src/orchestration/decisions.js";
import { listModels } from "../src/providers/catalog.js";
import { createModelPipeline, ORCHESTRATOR_TOOL_PARAMETERS, __testables } from "../src/providers/pipelines.js";
import { recentQueries, recentReplies } from "../src/shared/queryLog.js";

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

const contextWithWaifus: ContextMessage[] = [
  context[0],
  {
    id: "m2",
    channelId: "c1",
    guildId: "g1",
    authorKind: "waifu",
    authorId: "yuki-bot",
    name: "Yuki",
    displayName: "Yuki",
    content: "tea is serious business",
    timestamp: "2026-05-16T12:00:01Z",
    reactions: []
  },
  {
    id: "m3",
    channelId: "c1",
    guildId: "g1",
    authorKind: "waifu",
    authorId: "mika-bot",
    name: "Mika",
    displayName: "Mika",
    content: "Kevin has taste",
    timestamp: "2026-05-16T12:00:02Z",
    reactions: []
  }
];


afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider reply logging", () => {
  it("captures successful provider response bodies with query correlation", async () => {
    const providerResponse = { choices: [{ message: { content: "ok" } }] };
    mockFetch(providerResponse);

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const reply = recentReplies().at(-1);
    expect(reply).toMatchObject({
      role: "waifu",
      queryId: query?.id,
      status: 200,
      ok: true,
      payload: providerResponse
    });
  });

  it("captures provider error response bodies before throwing", async () => {
    const providerResponse = { error: { message: "bad schema" } };
    mockFetch(providerResponse, 400);

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await expect(
      pipeline.generateWaifu({
        modelId: "grok-4.3",
        messages: context,
        systemPrompt: "stay in character"
      })
    ).rejects.toThrow("Provider request failed with HTTP 400.");

    const query = recentQueries().at(-1);
    const reply = recentReplies().at(-1);
    expect(reply).toMatchObject({
      role: "waifu",
      queryId: query?.id,
      status: 400,
      ok: false,
      payload: providerResponse
    });
  });
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
                    respondingWaifus: [],
                    retriggerAfterSeconds: 600,
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

    expect(decision).toMatchObject({
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 600
    });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("orchestrator");
    expect((query?.payload.tools as Array<{ function: { name: string } }>)[0].function.name).toBe("orchestrator_decision");
    const waifuIdSchema = (query?.payload.tools as Array<{
      function: {
        parameters: {
          properties: {
            respondingWaifus: {
              items: {
                properties: {
                  waifuId: { enum?: string[] };
                  repleyToMessageIndex?: unknown;
                  replyToMessageId?: unknown;
                  delaySeconds?: { maximum?: number };
                };
              };
            };
          };
        };
      };
    }>)[0].function.parameters.properties.respondingWaifus.items.properties.waifuId;
    const responderProperties = (query?.payload.tools as Array<{
      function: {
        parameters: {
          properties: {
            respondingWaifus: {
              items: {
                properties: {
                  repleyToMessageIndex?: unknown;
                  replyToMessageId?: unknown;
                };
              };
            };
          };
        };
      };
    }>)[0].function.parameters.properties.respondingWaifus.items.properties;
    expect(waifuIdSchema.enum).toEqual(["yuki", "mika"]);
    expect(responderProperties.repleyToMessageIndex).toBeUndefined();
    expect(responderProperties.directive).toBeDefined();
    expect(responderProperties.replyToMessageId).toBeUndefined();
    expect(responderProperties.delaySeconds?.maximum).toBe(30);
    expect(query?.payload.tool_choice).toEqual({
      type: "function",
      function: { name: "orchestrator_decision" }
    });
  });

  it("removes no_reply from the orchestrator tool for reply-required runs", async () => {
    mockFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "orchestrator_decision",
                  arguments: JSON.stringify({
                    action: "reply",
                    respondingWaifus: [
                      {
                        waifuId: "yuki",
                        delaySeconds: 0,
                        
                        repleyToMessageIndex: null,
                        sceneDirection: null
                      }
                    ],
                    retriggerAfterSeconds: null,
                    reasoning: "manual run should speak"
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
      availableWaifuIds: ["yuki", "mika"],
      replyRequired: true
    });

    expect(decision?.action).toBe("reply");
    const actionSchema = (recentQueries().at(-1)?.payload.tools as Array<{
      function: { parameters: { properties: { action: { enum?: string[] } } } };
    }>)[0].function.parameters.properties.action;
    expect(actionSchema.enum).toEqual(["reply"]);
  });

  it("uses Z.AI's coding chat endpoint and provider-safe auto tool choice", async () => {
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
                    respondingWaifus: [],
                    retriggerAfterSeconds: 600,
                    reasoning: "wait for more context"
                  })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("glm-5.1", { apiKey: "zai-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "glm-5.1",
      messages: context,
      systemPrompt: "decide",
      availableWaifuIds: ["yuki", "mika"]
    });

    const fetchMock = (globalThis.fetch as unknown) as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    const query = recentQueries().at(-1);
    expect(query?.payload.tool_choice).toBe("auto");
  });

  it("disables DeepSeek thinking before forcing tool calls on both V4 models", async () => {
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
                    respondingWaifus: [],
                    retriggerAfterSeconds: 600,
                    reasoning: "wait for more context"
                  })
                }
              }
            ]
          }
        }
      ]
    });

    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const pipeline = createModelPipeline(modelId, { apiKey: "deepseek-test" });
      await pipeline.decideOrchestrator?.({
        modelId,
        messages: context,
        systemPrompt: "decide",
        availableWaifuIds: ["yuki", "mika"],
        reasoning: { enabled: true, effort: "max" }
      });

      const body = lastFetchJsonBody();
      expect(body.model).toBe(modelId);
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "orchestrator_decision" }
      });
    }
  });

  it("sends DeepSeek reasoning_effort at top level only when thinking is enabled", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const pipeline = createModelPipeline(modelId, { apiKey: "deepseek-test" });
      await pipeline.generateWaifu({
        modelId,
        messages: context,
        systemPrompt: "stay in character",
        reasoning: { enabled: true, effort: "max" }
      });

      const body = lastFetchJsonBody();
      expect(body.model).toBe(modelId);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("max");
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
    }
  });

  it("keeps DeepSeek optional waifu tools out of thinking mode", async () => {
    mockFetch({
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [
              {
                function: {
                  name: "PickNextWaifu",
                  arguments: JSON.stringify({ waifuId: "mika" })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("deepseek-v4-pro", { apiKey: "deepseek-test" });
    await pipeline.generateWaifu({
      modelId: "deepseek-v4-pro",
      messages: context,
      systemPrompt: "stay in character",
      availableWaifuIds: ["mika"],
      pickNextWaifuToolEnabled: true,
      reasoning: { enabled: true, effort: "max" }
    });

    const body = lastFetchJsonBody();
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("shields malformed hex escapes in DeepSeek message content", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("deepseek-v4-pro", { apiKey: "deepseek-test" });
    await pipeline.generateWaifu({
      modelId: "deepseek-v4-pro",
      messages: [
        {
          ...context[0],
          content: String.raw`broken \u003 \U0001F60 \xA path C:\users`
        }
      ],
      systemPrompt: "stay in character"
    });

    const messages = lastFetchJsonBody().messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toBe(String.raw`Kevin: broken \\u003 \\U0001F60 \\xA path C:\\users`);
  });

  it("preserves valid, already shielded, and non-DeepSeek hex escape text", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const deepSeek = createModelPipeline("deepseek-v4-pro", { apiKey: "deepseek-test" });
    await deepSeek.generateWaifu({
      modelId: "deepseek-v4-pro",
      messages: [
        {
          ...context[0],
          content: String.raw`valid \u003c already \\u003 path C:\docs`
        }
      ],
      systemPrompt: "stay in character"
    });
    let messages = lastFetchJsonBody().messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toBe(String.raw`Kevin: valid \u003c already \\u003 path C:\docs`);

    const xai = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await xai.generateWaifu({
      modelId: "grok-4.3",
      messages: [
        {
          ...context[0],
          content: String.raw`broken \u003`
        }
      ],
      systemPrompt: "stay in character"
    });
    messages = lastFetchJsonBody().messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toBe(String.raw`Kevin: broken \u003`);
  });

  it("uses Z.AI-compatible top_p clamping for chat completions", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("glm-5.1", { apiKey: "zai-test" });
    await pipeline.generateWaifu({
      modelId: "glm-5.1",
      messages: context,
      systemPrompt: "stay in character",
      topP: 0
    });

    const body = lastFetchJsonBody();
    expect(body.temperature).toBe(1);
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("stop");
  });

  it("forwards stopSequences as the OpenAI chat `stop` field when supplied", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.20-0309-non-reasoning", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.20-0309-non-reasoning",
      messages: context,
      systemPrompt: "stay in character",
      stopSequences: ["\nAria:", "\nRiko:"]
    });

    expect(lastFetchJsonBody().stop).toEqual(["\nAria:", "\nRiko:"]);
  });

  it("clamps Z.AI stopSequences to the first entry only", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("glm-5.1", { apiKey: "zai-test" });
    await pipeline.generateWaifu({
      modelId: "glm-5.1",
      messages: context,
      systemPrompt: "stay in character",
      stopSequences: ["\nAria:", "\nRiko:", "\nLumi:"]
    });

    expect(lastFetchJsonBody().stop).toEqual(["\nAria:"]);
  });

  it("does not expose xAI multi-agent models through the chat/tools pipeline", () => {
    const ids = listModels().map((model) => model.modelId);
    expect(ids).not.toContain("grok-4.20-multi-agent-0309");
    expect(ids).not.toContain("grok-4-1-fast-reasoning");
    expect(ids).not.toContain("grok-4-1-fast-non-reasoning");
  });

  it("uses provider-specific catalog roles, image support, and output caps", () => {
    const models = new Map(listModels().map((model) => [model.modelId, model]));
    expect(models.get("grok-4.3")?.supportedRoles).not.toContain("developer");
    expect(models.get("deepseek-v4-pro")?.supportedRoles).not.toContain("developer");
    expect(models.get("deepseek-v4-pro")?.maxOutputTokens).toBe(384000);
    expect(models.get("claude-opus-4-7")?.supportedRoles).toEqual(["user", "assistant"]);
    expect(models.get("claude-opus-4-7")?.maxOutputTokens).toBe(128000);
    expect(models.get("glm-5.1")?.supportedRoles).not.toContain("developer");
    expect(models.get("glm-5.1")?.supportsImageInput).toBe(false);
    expect(models.get("glm-5.1")?.maxOutputTokens).toBe(131072);
    expect(models.get("gpt-4o-mini")?.maxOutputTokens).toBe(16384);
  });

  it("renders reply targets against split logical context messages", async () => {
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
                    respondingWaifus: [],
                    retriggerAfterSeconds: 180,
                    reasoning: "wait"
                  })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "grok-4.3",
      messages: [
        {
          id: "chunk-1",
          channelId: "c1",
          guildId: "g1",
          authorKind: "waifu",
          authorId: "aria-bot",
          name: "Aria",
          displayName: "Aria",
          content: "one two",
          sourceMessageIds: ["chunk-1", "chunk-2"],
          timestamp: "2026-05-16T12:00:02Z",
          reactions: []
        },
        {
          id: "chunk-3",
          channelId: "c1",
          guildId: "g1",
          authorKind: "waifu",
          authorId: "aria-bot",
          name: "Aria",
          displayName: "Aria",
          content: "three",
          timestamp: "2026-05-16T12:00:03Z",
          reactions: []
        },
        {
          id: "reply",
          channelId: "c1",
          guildId: "g1",
          authorKind: "user",
          authorId: "u1",
          name: "Kevin",
          displayName: "Kevin",
          content: "that one",
          timestamp: "2026-05-16T12:00:04Z",
          replyTo: { messageId: "chunk-3", authorName: "Aria", contentPreview: "three" },
          reactions: []
        }
      ],
      systemPrompt: "decide"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ content: string }>;
    expect(messages.some((message) => message.content.includes("[message_id:"))).toBe(false);
    expect(messages.some((message) => message.content.includes("[index:"))).toBe(false);
    expect(
      messages.some((message) =>
        message.content === "replying to > Aria: three\nKevin: that one"
      )
    ).toBe(true);
  });

  it("replays past completed orchestrator decisions as assistant tool_calls", async () => {
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
                    respondingWaifus: [],
                    retriggerAfterSeconds: 180,
                    reasoning: "wait"
                  })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "grok-4.3",
      messages: context,
      pastDecisions: [
        {
          id: "decision-1",
          guildId: "g1",
          channelId: "c1",
          action: "no_reply",
          respondingWaifus: [],
          retriggerAfterSeconds: 600,
          reasoning: "wait for Kevin",
          status: "completed",
          waifuMessageIds: [],
          createdAt: "2026-05-16T12:05:00Z"
        }
      ],
      trailingPrompt: "trailing-block",
      systemPrompt: "decide"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{
      role: string;
      content: string | null;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    }>;
    const toolCallMessage = messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(toolCallMessage?.tool_calls?.[0].id).toBe("decision-1");
    expect(toolCallMessage?.tool_calls?.[0].function.name).toBe("orchestrator_decision");
    const args = JSON.parse(toolCallMessage?.tool_calls?.[0].function.arguments ?? "{}");
    expect(args).toMatchObject({
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 600,
      reasoning: "wait for Kevin"
    });
    const toolResultMessage = messages.find((m) => m.role === "tool");
    expect(toolResultMessage?.tool_call_id).toBe("decision-1");
    const trailing = messages[messages.length - 1];
    expect(trailing.role).toBe("user");
    expect(trailing.content).toBe("trailing-block");
  });

  it("orchestrator messages no longer carry no_reply text markers", async () => {
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
                    respondingWaifus: [],
                    retriggerAfterSeconds: 180,
                    reasoning: "wait"
                  })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "grok-4.3",
      messages: context,
      pastDecisions: [
        {
          id: "decision-noreply",
          guildId: "g1",
          channelId: "c1",
          action: "no_reply",
          respondingWaifus: [],
          retriggerAfterSeconds: 600,
          reasoning: "wait for Kevin",
          status: "completed",
          waifuMessageIds: [],
          createdAt: "2026-05-16T12:05:00Z"
        }
      ],
      systemPrompt: "decide"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ content: string | null }>;
    expect(
      messages.some((message) => typeof message.content === "string" && message.content.includes("[no_reply]"))
    ).toBe(false);
    expect(
      messages.some((message) => typeof message.content === "string" && message.content.includes("[type: no_reply]"))
    ).toBe(false);
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
                  content: "Kevin likes tea.",
                  importance: 3
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
      availableWaifuIds: ["yuki", "mika"],
      memories: [
        {
          memoryIndex: 1,
          waifuId: "yuki",
          content: "Kevin likes tea.",
          importance: 3
        }
      ],
      systemPrompt: "memories"
    });

    expect(calls?.[0]).toEqual({
      tool: "add_memory",
      memory: {
        content: "Kevin likes tea.",
        importance: 3,
        waifuId: "yuki"
      }
    });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("stage_manager_librarian");
    const instructions = query?.payload.instructions as string;
    expect(instructions).toContain("Absence of evidence is not a contradiction.");
    expect(instructions).toContain("only when a specific observer observation directly contradicts");
    expect(instructions).toContain("preserve every non-contradicted fact from every source memory");
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("manage_memories");
    expect(query?.payload.tool_choice).toEqual({ type: "function", name: "manage_memories" });
    const toolParameters = (query?.payload.tools as Array<{
      parameters: {
        properties: {
          toolCalls: {
            items: {
              properties: {
                memory: { properties: Record<string, unknown> };
                memoryIndex?: unknown;
                patch: { properties: Record<string, unknown> };
                sourceMemoryIndices?: unknown;
                [key: string]: unknown;
              };
            };
          };
        };
      };
    }>)[0].parameters.properties.toolCalls.items.properties;
    const memorySchema = toolParameters.memory.properties;
    const patchSchema = toolParameters.patch.properties;
    expect(toolParameters.memoryIndex).toBeDefined();
    expect(toolParameters.sourceMemoryIndices).toBeDefined();
    expect(toolParameters.memoryId).toBeUndefined();
    expect(toolParameters.sourceMemoryIds).toBeUndefined();
    expect(memorySchema.scope).toBeUndefined();
    expect(memorySchema.waifuId).toMatchObject({ enum: ["yuki", "mika"] });
    expect(memorySchema.sourceMessageIndices).toBeUndefined();
    expect(patchSchema.waifuId).toMatchObject({ enum: ["yuki", "mika"] });
    expect(patchSchema.scope).toBeUndefined();
    expect(patchSchema.status).toBeUndefined();
    expect(patchSchema.sourceMessageIds).toBeUndefined();
    const memoryInput = (query?.payload.input as Array<{ content: string }>)[1].content;
    expect(memoryInput).toContain("\"memoryIndex\":1");
    expect(memoryInput).not.toContain("\"id\"");
    expect(memoryInput).not.toContain("sourceMessageIds");
    expect(memoryInput).not.toContain("createdAt");
    expect(memoryInput).not.toContain("updatedAt");
    expect(memoryInput).not.toContain("guildId");
    expect(memoryInput).not.toContain("\"scope\"");
    expect(memoryInput).not.toContain("\"status\"");
  });

  it("uses a single Anthropic tool for orchestrator decisions", async () => {
    mockFetch({
      content: [
        {
          type: "tool_use",
          name: "orchestrator_decision",
          input: {
            action: "reply",
            respondingWaifus: [
              {
                waifuId: "yuki",
                delaySeconds: 1,
                
                repleyToMessageIndex: null,
                sceneDirection: null
              }
            ],
            retriggerAfterSeconds: null,
            reasoning: "yuki should answer"
          }
        }
      ]
    });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    const decision = await pipeline.decideOrchestrator?.({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "decide",
      availableWaifuIds: ["yuki"]
    });

    expect(decision).toMatchObject({
      action: "reply",
      respondingWaifus: [
        {
          waifuId: "yuki",
          delaySeconds: 1
        }
      ]
    });
    expect(decision?.respondingWaifus?.[0].replyToMessageId).toBeUndefined();
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("orchestrator");
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("orchestrator_decision");
    expect(query?.payload.tool_choice).toEqual({ type: "tool", name: "orchestrator_decision" });
  });

  it("omits Anthropic thinking when a tool is forced", async () => {
    mockFetch({
      content: [
        {
          type: "tool_use",
          name: "orchestrator_decision",
          input: {
            action: "no_reply",
            respondingWaifus: [],
            retriggerAfterSeconds: 600,
            reasoning: "wait"
          }
        }
      ]
    });

    const pipeline = createModelPipeline("claude-opus-4-7", { apiKey: "anthropic-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "claude-opus-4-7",
      messages: context,
      systemPrompt: "decide",
      availableWaifuIds: ["yuki"],
      reasoning: { effort: "high" }
    });

    const body = lastFetchJsonBody();
    expect(body.tool_choice).toEqual({ type: "tool", name: "orchestrator_decision" });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  it("sends Anthropic adaptive effort through output_config", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-opus-4-7", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-opus-4-7",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { effort: "xhigh" }
    });

    const body = lastFetchJsonBody();
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  it("keeps Anthropic Haiku manual thinking below max_tokens by default", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { enabled: true }
    });

    const body = lastFetchJsonBody();
    expect(body.max_tokens).toBe(2048);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body.temperature).toBe(1);
    expect(body).not.toHaveProperty("top_p");
  });

  it("omits Anthropic Haiku manual thinking when max_tokens is too low for the minimum budget", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      maxOutputTokens: 512,
      reasoning: { enabled: true }
    });

    const body = lastFetchJsonBody();
    expect(body.max_tokens).toBe(512);
    expect(body).not.toHaveProperty("thinking");
    expect(body.temperature).toBe(0.7);
  });

  it("omits stop for xAI reasoning models and keeps it for non-reasoning models", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character"
    });

    expect(recentQueries().at(-1)?.payload).not.toHaveProperty("stop");

    const nonReasoningPipeline = createModelPipeline("grok-4.20-0309-non-reasoning", { apiKey: "xai-test" });
    await nonReasoningPipeline.generateWaifu({
      modelId: "grok-4.20-0309-non-reasoning",
      messages: context,
      systemPrompt: "stay in character"
    });

    expect(recentQueries().at(-1)?.payload).not.toHaveProperty("stop");
  });

  it("maps xAI disabled reasoning to reasoning_effort none", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { enabled: false }
    });

    const body = lastFetchJsonBody();
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("stop");
  });

  it("sends only the self waifu's messages as assistant to OpenAI-compatible chat", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      selfAuthorIds: ["yuki-bot"]
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    // Kevin=user, Yuki=assistant(self), Mika=user
    expect(messages.slice(1).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    // Yuki's turn is raw content (no prefix), Mika's turn has name prefix
    expect(messages[2].content).toBe("tea is serious business");
    expect(messages[3].content).toContain("Mika:");
  });

  it("sends every waifu context message as user when no selfAuthorIds given (OpenAI chat)", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.slice(1).map((message) => message.role)).toEqual(["user", "user", "user"]);
    expect(messages[2].content).toContain("Yuki:");
    expect(messages[3].content).toContain("Mika:");
  });

  it("sends only the self waifu's messages as assistant to OpenAI Responses", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      selfAuthorIds: ["yuki-bot"]
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; content: string }>;
    // Kevin=user, Yuki=assistant(self), Mika=user
    expect(input.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(input[1].content).toBe("tea is serious business");
    expect(input[2].content).toContain("Mika:");
  });

  it("sends every waifu context message as user when no selfAuthorIds given (OpenAI Responses)", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; content: string }>;
    expect(input.map((message) => message.role)).toEqual(["user", "user", "user"]);
    expect(input[1].content).toContain("Yuki:");
    expect(input[2].content).toContain("Mika:");
  });

  it("never sends a stop field from the OpenAI Responses waifu path", async () => {
    mockFetch({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }]
        }
      ]
    });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    const result = await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: context,
      systemPrompt: "stay in character"
    });

    const body = lastFetchJsonBody();
    expect(body).not.toHaveProperty("stop");
    expect(result.content).toBe("hello");
  });

  it("passes expanded OpenAI reasoning efforts through Responses", async () => {
    mockFetch({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });

    const pipeline = createModelPipeline("gpt-5.5", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-5.5",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { effort: "xhigh" }
    });

    expect(lastFetchJsonBody().reasoning).toEqual({ effort: "xhigh" });

    await pipeline.generateWaifu({
      modelId: "gpt-5.5",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { effort: "none" }
    });

    expect(lastFetchJsonBody().reasoning).toEqual({ effort: "none" });
  });

  it("rejects max output token values above catalog limits before calling providers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await expect(
      pipeline.generateWaifu({
        modelId: "gpt-4o-mini",
        messages: context,
        systemPrompt: "stay in character",
        maxOutputTokens: 20_000
      })
    ).rejects.toThrow("supports at most 16384 output tokens");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes optional PickNextWaifu for waifu generation", async () => {
    mockFetch({
      choices: [
        {
          message: {
            content: "mika should take this",
            tool_calls: [
              {
                function: {
                  name: "PickNextWaifu",
                  arguments: JSON.stringify({ waifuId: "mika" })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const result = await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      availableWaifuIds: ["mika"],
      pickNextWaifuToolEnabled: true
    });

    expect(result).toEqual({
      content: "mika should take this",
      pickedNextWaifuId: "mika"
    });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("waifu");
    expect((query?.payload.tools as Array<{ function: { name: string } }>)[0].function.name).toBe("PickNextWaifu");
    expect(query?.payload.tool_choice).toBe("auto");
  });

  it("ignores malformed PickNextWaifu calls and keeps the normal waifu message", async () => {
    mockFetch({
      choices: [
        {
          message: {
            content: "normal reply still sends",
            tool_calls: [
              {
                function: {
                  name: "PickNextWaifu",
                  arguments: "{not json"
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const result = await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      availableWaifuIds: ["mika"],
      pickNextWaifuToolEnabled: true
    });

    expect(result).toEqual({
      content: "normal reply still sends",
      rejectedPickNextWaifu: {
        reason: "malformed"
      }
    });
  });

  it("treats an empty waifu message with a bad PickNextWaifu call as no handoff instead of a pipeline error", async () => {
    mockFetch({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "PickNextWaifu",
                  arguments: JSON.stringify({ waifuId: "not-enabled" })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const result = await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      availableWaifuIds: ["mika"],
      pickNextWaifuToolEnabled: true
    });

    expect(result).toEqual({
      content: "",
      rejectedPickNextWaifu: {
        reason: "unavailable_waifu",
        waifuId: "not-enabled"
      }
    });
  });

  it("does not send a stop_sequences field on the Anthropic Messages waifu path when none are supplied", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    expect(query?.payload).not.toHaveProperty("stop_sequences");
  });

  it("forwards stopSequences as stop_sequences on the Anthropic Messages waifu path", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      stopSequences: ["\nAria:", "\nRiko:"]
    });

    const query = recentQueries().at(-1);
    expect(query?.payload.stop_sequences).toEqual(["\nAria:", "\nRiko:"]);
  });

  it("sends only the self waifu's messages as assistant to Anthropic Messages", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      selfAuthorIds: ["yuki-bot"]
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    // Kevin=user, Yuki=assistant(self), Mika=user
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].content).toBe("tea is serious business");
    expect(messages[2].content).toContain("Mika:");
  });

  it("sends every waifu context message as user when no selfAuthorIds given (Anthropic)", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "user"]);
    expect(messages[1].content).toContain("Yuki:");
    expect(messages[2].content).toContain("Mika:");
  });

});

describe("image attachments", () => {
  const contextWithImage: ContextMessage[] = [
    {
      id: "img1",
      channelId: "c1",
      guildId: "g1",
      authorKind: "user",
      authorId: "u1",
      name: "Kevin",
      displayName: "Kevin",
      content: "what is this?",
      timestamp: "2026-05-16T12:00:00Z",
      images: [{ url: "https://cdn.example/cat.png", contentType: "image/png" }],
      reactions: []
    }
  ];

  it("attaches an image_url block for vision-capable OpenAI-compatible chat models", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: contextWithImage,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: unknown }>;
    const userMessage = messages[1];
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toEqual([
      { type: "text", text: expect.stringContaining("[attachments: 1x image]") },
      { type: "image_url", image_url: { url: "https://cdn.example/cat.png" } }
    ]);
  });

  it("attaches an input_image block for vision-capable OpenAI Responses models", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: contextWithImage,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; content: unknown }>;
    expect(input[0].content).toEqual([
      { type: "input_text", text: expect.stringContaining("[attachments: 1x image]") },
      { type: "input_image", image_url: "https://cdn.example/cat.png" }
    ]);
  });

  it("attaches an image source block for vision-capable Anthropic models", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: contextWithImage,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].content).toEqual([
      { type: "text", text: expect.stringContaining("[attachments: 1x image]") },
      { type: "image", source: { type: "url", url: "https://cdn.example/cat.png" } }
    ]);
  });

  it("does not attach image blocks for DeepSeek text-only API models", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("deepseek-v4-pro", { apiKey: "deepseek-test" });
    await pipeline.generateWaifu({
      modelId: "deepseek-v4-pro",
      messages: contextWithImage,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1].content).toEqual(expect.stringContaining("[attachments: 1x image]"));
  });

  it("renders OCR text as text context for DeepSeek text-only API models", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("deepseek-v4-pro", { apiKey: "deepseek-test" });
    await pipeline.generateWaifu({
      modelId: "deepseek-v4-pro",
      messages: [
        {
          ...contextWithImage[0],
          images: [
            {
              url: "https://cdn.example/cat.png",
              contentType: "image/png",
              ocrText: "Start chatting with Instant\nVision tab"
            }
          ]
        }
      ],
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1].content).toEqual(expect.stringContaining("[image_text: Start chatting with Instant Vision tab]"));
  });

  it("renders OCR text instead of image_url blocks for Z.AI text models", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("glm-5.1", { apiKey: "zai-test" });
    await pipeline.generateWaifu({
      modelId: "glm-5.1",
      messages: [
        {
          ...contextWithImage[0],
          images: [
            {
              url: "https://cdn.example/cat.png",
              contentType: "image/png",
              ocrText: "cat says hello"
            }
          ]
        }
      ],
      systemPrompt: "stay in character"
    });

    const body = lastFetchJsonBody();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1].content).toEqual(expect.stringContaining("[image_text: cat says hello]"));
    expect(JSON.stringify(messages[1].content)).not.toContain("image_url");
  });

  it("renders one [image_text] line per OCR-equipped image with no #N index", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("deepseek-v4-pro", { apiKey: "deepseek-test" });
    await pipeline.generateWaifu({
      modelId: "deepseek-v4-pro",
      messages: [
        {
          ...contextWithImage[0],
          images: [
            { url: "https://cdn.example/a.png", contentType: "image/png", ocrText: "first ocr" },
            { url: "https://cdn.example/b.png", contentType: "image/png" }
          ]
        }
      ],
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    const rendered = messages[1].content;
    expect(rendered).toContain("[attachments: 2x image]");
    expect(rendered).toContain("[image_text: first ocr]");
    expect(rendered).not.toMatch(/\[image_text #\d+:/);
    expect(rendered.match(/\[image_text:/g)?.length).toBe(1);
  });
});

describe("trailing system message payloads", () => {
  const trailingWithSceneDirection = "<yuki_personality>\nYou are Yuki\n</yuki_personality>\n<scene_direction>answer Kevin</scene_direction>";
  const trailingWithoutSceneDirection = "<yuki_personality>\nYou are Yuki\n</yuki_personality>";

  it("OpenAI Chat: places trailingSystemBlock as the last system message", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithSceneDirection
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)).toEqual({
      role: "system",
      content: trailingWithSceneDirection
    });
  });

  it("OpenAI Chat: omits the trailing message entirely when trailingSystemBlock is unset", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    const lastSystemContent = messages.at(-1)?.content ?? "";
    expect(lastSystemContent).not.toMatch(/<yuki_personality>|<director_notes>/);
  });

  it("OpenAI Chat: appends retryUserMessage as the final user message", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithSceneDirection,
      retryUserMessage: "Yuki:"
    });

    const messages = lastFetchJsonBody().messages as Array<{ role: string; content: string }>;
    expect(messages.at(-2)).toEqual({
      role: "system",
      content: trailingWithSceneDirection
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "Yuki:"
    });
  });

  it("OpenAI Responses: places trailingSystemBlock as the last input message", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithoutSceneDirection
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; content: string }>;
    expect(input.at(-1)).toEqual({
      role: "system",
      content: trailingWithoutSceneDirection
    });
  });

  it("OpenAI Responses: appends retryUserMessage as the final user input", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithoutSceneDirection,
      retryUserMessage: "Yuki:"
    });

    const input = lastFetchJsonBody().input as Array<{ role: string; content: string }>;
    expect(input.at(-2)).toEqual({
      role: "system",
      content: trailingWithoutSceneDirection
    });
    expect(input.at(-1)).toEqual({
      role: "user",
      content: "Yuki:"
    });
  });

  it("Anthropic: sends trailingSystemBlock wrapped in system_note as the trailing user message", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithSceneDirection
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: `<system_note>\n${trailingWithSceneDirection}\n</system_note>`
    });
  });

  it("Anthropic: appends retryUserMessage after the trailing user message (retryUserMessage is not wrapped)", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithSceneDirection,
      retryUserMessage: "Yuki:"
    });

    const messages = lastFetchJsonBody().messages as Array<{ role: string; content: string }>;
    expect(messages.at(-2)).toEqual({
      role: "user",
      content: `<system_note>\n${trailingWithSceneDirection}\n</system_note>`
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "Yuki:"
    });
  });

  it("Google: appends retryUserMessage as the final user content (retryUserMessage is not wrapped)", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingWithoutSceneDirection,
      retryUserMessage: "Yuki:"
    });

    const contents = lastFetchJsonBody().contents as Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    expect(contents.at(-2)).toEqual({
      role: "user",
      parts: [{ text: `<system_note>\n${trailingWithoutSceneDirection}\n</system_note>` }]
    });
    expect(contents.at(-1)).toEqual({
      role: "user",
      parts: [{ text: "Yuki:" }]
    });
  });
});

describe("mid-system block injection", () => {
  const midPayload = "<director_notes>\nKeep it short.\n</director_notes>\n<active_chat_participants>\n- Kevin\n</active_chat_participants>\n<server_emojis>\n(none cached)\n</server_emojis>";
  const trailingPayload = "<yuki_relevant_memories>\n- example\n</yuki_relevant_memories>\n<yuki_personality>\nYou are Yuki\n</yuki_personality>";

  it("OpenAI Chat: inserts midSystemBlock at contextLen - 2, leaving 2 chat messages before trailing", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      midSystemBlock: midPayload,
      trailingSystemBlock: trailingPayload
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    // [leading, chat[0], mid, chat[1], chat[2], trailing] — length 6
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe("system");
    expect(messages.at(-4)).toEqual({ role: "system", content: midPayload });
    expect(messages.at(-1)).toEqual({ role: "system", content: trailingPayload });
  });

  it("OpenAI Chat: no insertion when midSystemBlock is undefined", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      trailingSystemBlock: trailingPayload
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(5);
    expect(messages.every((m) => m.content !== midPayload)).toBe(true);
  });

  it("OpenAI Responses: inserts midSystemBlock into input at contextLen - 2", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      midSystemBlock: midPayload,
      trailingSystemBlock: trailingPayload
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; content: string }>;
    // [chat[0], mid, chat[1], chat[2], trailing] — instructions holds leading, length 5
    expect(input).toHaveLength(5);
    expect(input.at(-4)).toEqual({ role: "system", content: midPayload });
    expect(input.at(-1)).toEqual({ role: "system", content: trailingPayload });
  });

  it("Anthropic: inserts midSystemBlock wrapped in system_note as a mid-conversation user message at contextLen - 2", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      midSystemBlock: midPayload,
      trailingSystemBlock: trailingPayload
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: unknown }>;
    // [chat[0], mid, chat[1], chat[2], trailing] — system field holds leading, length 5
    expect(messages).toHaveLength(5);
    expect(messages.at(-4)).toEqual({ role: "user", content: `<system_note>\n${midPayload}\n</system_note>` });
    expect(messages.at(-1)).toEqual({ role: "user", content: `<system_note>\n${trailingPayload}\n</system_note>` });
  });

  it("Google: inserts midSystemBlock wrapped in system_note as a googleUserTurn at contextLen - 2", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash-lite",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      midSystemBlock: midPayload,
      trailingSystemBlock: trailingPayload
    });

    const query = recentQueries().at(-1);
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    // [chat[0], mid, chat[1], chat[2], trailing] — systemInstruction holds leading, length 5
    expect(contents).toHaveLength(5);
    expect(contents.at(-4)).toEqual({ role: "user", parts: [{ text: `<system_note>\n${midPayload}\n</system_note>` }] });
    expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: `<system_note>\n${trailingPayload}\n</system_note>` }] });
  });
});

describe("Google AI Studio (Gemini) pipeline", () => {
  it("forces the orchestrator tool, routes to the model-scoped URL, and parses functionCall args", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "orchestrator_decision",
                  args: {
                    action: "no_reply",
                    respondingWaifus: [],
                    retriggerAfterSeconds: 300,
                    reasoning: "hold"
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    const decision = await pipeline.decideOrchestrator?.({
      modelId: "gemini-2.5-flash",
      messages: context,
      systemPrompt: "decide",
      availableWaifuIds: ["yuki", "mika"]
    });

    expect(decision).toMatchObject({ action: "no_reply", retriggerAfterSeconds: 300 });

    const fetchMock = (globalThis.fetch as unknown) as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    const calledInit = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(calledInit.headers["x-goog-api-key"]).toBe("g-test");

    const query = recentQueries().at(-1);
    expect(query?.role).toBe("orchestrator");
    const tools = query?.payload.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    expect(tools[0].functionDeclarations[0].name).toBe("orchestrator_decision");
    expect(query?.payload.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["orchestrator_decision"] }
    });
    expect(query?.payload.systemInstruction).toEqual({ parts: [{ text: "decide" }] });
  });

  it("sanitizes Google tool schemas for Gemini function declarations", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "orchestrator_decision",
                  args: {
                    action: "no_reply",
                    respondingWaifus: [],
                    retriggerAfterSeconds: 300,
                    reasoning: "hold"
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-3.1-flash-lite", { apiKey: "g-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "gemini-3.1-flash-lite",
      messages: context,
      systemPrompt: "decide",
      availableWaifuIds: ["lumi", "aria", "stupid-hoe"]
    });

    const query = recentQueries().at(-1);
    const tools = query?.payload.tools as Array<{
      functionDeclarations: Array<{
        parameters: {
          additionalProperties?: unknown;
          anyOf?: unknown;
          properties: {
            respondingWaifus: {
              items: {
                additionalProperties?: unknown;
                properties: {
                  directive: Record<string, unknown>;
                };
              };
            };
            retriggerAfterSeconds: Record<string, unknown>;
            wakePlan: Record<string, unknown>;
          };
        };
      }>;
    }>;
    const parameters = tools[0]!.functionDeclarations[0]!.parameters;
    const respondingItem = parameters.properties.respondingWaifus.items;

    expect(JSON.stringify(parameters)).not.toContain("additionalProperties");
    expect(JSON.stringify(parameters)).not.toContain("\"anyOf\"");
    expect(parameters).not.toHaveProperty("additionalProperties");
    expect(respondingItem).not.toHaveProperty("additionalProperties");
    expect(respondingItem.properties.directive).toBeDefined();
    expect(parameters.properties.retriggerAfterSeconds).toMatchObject({
      type: "number",
      minimum: RETRIGGER_MIN_SECONDS,
      maximum: RETRIGGER_MAX_SECONDS,
      nullable: true
    });
    expect(parameters.properties.wakePlan).toMatchObject({
      type: "string",
      nullable: true
    });
  });

  it("replays Google function responses as user turns", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "orchestrator_decision",
                  args: {
                    action: "no_reply",
                    respondingWaifus: [],
                    retriggerAfterSeconds: 300,
                    reasoning: "hold"
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.decideOrchestrator?.({
      modelId: "gemini-2.5-flash",
      messages: context,
      pastDecisions: [
        {
          id: "decision-1",
          guildId: "g1",
          channelId: "c1",
          action: "no_reply",
          respondingWaifus: [],
          retriggerAfterSeconds: 600,
          reasoning: "wait for Kevin",
          status: "completed",
          waifuMessageIds: [],
          createdAt: "2026-05-16T12:05:00Z"
        }
      ],
      systemPrompt: "decide",
      availableWaifuIds: ["yuki"]
    });

    const query = recentQueries().at(-1);
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const responseTurn = contents.find((turn) => turn.parts.some((part) => part.functionResponse));
    expect(responseTurn?.role).toBe("user");
  });

  it("forces the stage-manager tool and sends a memories user-turn", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "manage_memories",
                  args: {
                    toolCalls: [
                      {
                        tool: "add_memory",
                        memory: { waifuId: "yuki", content: "Kevin likes tea.", importance: 3 }
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    const calls = await pipeline.decideStageManager?.({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      memories: [{ memoryIndex: 1, waifuId: "yuki", content: "Kevin likes tea.", importance: 3 }],
      systemPrompt: "memories"
    });

    expect(calls?.[0]).toMatchObject({ tool: "add_memory" });
    const query = recentQueries().at(-1);
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.at(-1)?.parts[0].text).toContain("memories: ");
    expect(query?.payload.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["manage_memories"] }
    });
  });

  it("uses a shallow Google stage-manager schema and parses flat memory edits", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "manage_memories",
                  args: {
                    toolCalls: [
                      { tool: "add_memory", waifuId: "yuki", content: "Kevin likes tea.", importance: "3" },
                      { tool: "update_memory", memoryIndex: 1, content: "Kevin likes green tea.", importance: "4" },
                      { tool: "merge_memories", sourceMemoryIndices: [1, 2], content: "Kevin likes green tea." },
                      { tool: "archive_memory", memoryIndex: 3 },
                      { tool: "no_change", reason: "done" }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-3.1-flash-lite", { apiKey: "g-test" });
    const calls = await pipeline.decideStageManager?.({
      modelId: "gemini-3.1-flash-lite",
      messages: context,
      memories: [{ memoryIndex: 1, waifuId: "yuki", content: "Kevin likes tea.", importance: 3 }],
      observations: [{ waifuId: "yuki", content: "Kevin likes green tea.", importance: 4, kind: "preference" }],
      availableWaifuIds: ["yuki"],
      systemPrompt: "memories",
      reasoning: { effort: "high" }
    });

    expect(calls).toEqual([
      { tool: "add_memory", memory: { waifuId: "yuki", content: "Kevin likes tea.", importance: 3 } },
      { tool: "update_memory", memoryIndex: 1, patch: { content: "Kevin likes green tea.", importance: 4 } },
      { tool: "merge_memories", sourceMemoryIndices: [1, 2], mergedContent: "Kevin likes green tea." },
      { tool: "archive_memory", memoryIndex: 3 },
      { tool: "no_change", reason: "done" }
    ]);

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingLevel?: string } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
    const tools = query?.payload.tools as Array<{
      functionDeclarations: Array<{
        parameters: {
          properties: {
            toolCalls: {
              items: { properties: Record<string, unknown> };
            };
          };
        };
      }>;
    }>;
    const itemProperties = tools[0]!.functionDeclarations[0]!.parameters.properties.toolCalls.items.properties;
    expect(itemProperties).toHaveProperty("waifuId");
    expect(itemProperties).toHaveProperty("content");
    expect(itemProperties).toHaveProperty("importance");
    expect(itemProperties.importance).toMatchObject({ type: "integer", enum: ["1", "2", "3", "4", "5"] });
    expect(itemProperties).toHaveProperty("memoryIndex");
    expect(itemProperties).toHaveProperty("sourceMemoryIndices");
    expect(itemProperties).not.toHaveProperty("memory");
    expect(itemProperties).not.toHaveProperty("patch");
    expect(itemProperties).not.toHaveProperty("mergedContent");
    expect(query?.payload.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["manage_memories"] }
    });
  });

  it("skips malformed stage-manager tool-call items when later items are valid", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "manage_memories",
                  args: {
                    toolCalls: [
                      { tool: "add_memory", waifuId: "lumi" },
                      {
                        tool: "add_memory",
                        waifuId: "lumi",
                        content: "Lumi used to play old-school RPGs.",
                        importance: 2
                      },
                      {
                        tool: "add_memory",
                        waifuId: "aria",
                        content: "Aria thinks the Trix Rabbit would fight dirty.",
                        importance: 2
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-3.1-flash-lite", { apiKey: "g-test" });
    const calls = await pipeline.decideStageManager?.({
      modelId: "gemini-3.1-flash-lite",
      messages: context,
      memories: [],
      observations: [{ waifuId: "lumi", content: "Lumi used to play old-school RPGs.", importance: 2, kind: "fact" }],
      availableWaifuIds: ["lumi", "aria"],
      systemPrompt: "memories"
    });

    expect(calls).toEqual([
      { tool: "add_memory", memory: { waifuId: "lumi", content: "Lumi used to play old-school RPGs.", importance: 2 } },
      { tool: "add_memory", memory: { waifuId: "aria", content: "Aria thinks the Trix Rabbit would fight dirty.", importance: 2 } }
    ]);
  });

  it("still fails stage-manager parsing when every returned tool-call item is malformed", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "manage_memories",
                  args: {
                    toolCalls: [
                      { tool: "add_memory", waifuId: "lumi" },
                      { tool: "archive_memory" }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-3.1-flash-lite", { apiKey: "g-test" });
    await expect(
      pipeline.decideStageManager?.({
        modelId: "gemini-3.1-flash-lite",
        messages: context,
        memories: [],
        observations: [{ waifuId: "lumi", content: "Lumi used to play old-school RPGs.", importance: 2, kind: "fact" }],
        availableWaifuIds: ["lumi"],
        systemPrompt: "memories"
      })
    ).rejects.toThrow("Provider did not return valid stage-manager tool calls.");
  });

  it("forces the reviewer tool with a single user turn", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "review_message", args: { hallucination: false } } }]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.decideReviewer?.({
      modelId: "gemini-2.5-flash",
      messages: context,
      systemPrompt: "review",
      message: "hello?"
    });

    const query = recentQueries().at(-1);
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "hello?" }] });
    expect(query?.payload.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["review_message"] }
    });
  });

  it("maps only the self waifu's turns to role 'model' and puts the system prompt under systemInstruction", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: contextWithWaifus,
      systemPrompt: "stay in character",
      selfAuthorIds: ["yuki-bot"]
    });

    const query = recentQueries().at(-1);
    expect(query?.payload.systemInstruction).toEqual({ parts: [{ text: "stay in character" }] });
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    // Kevin=user, Yuki=model(self), Mika=user
    expect(contents.map((turn) => turn.role)).toEqual(["user", "model", "user"]);
    // Yuki's turn is raw content, Mika has name prefix
    expect(contents[1]?.parts[0].text).toBe("tea is serious business");
    expect(contents.at(-1)?.parts[0].text).toContain("Mika:");
  });

  it("maps every waifu turn to role 'user' when no selfAuthorIds given (Google)", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.map((turn) => turn.role)).toEqual(["user", "user", "user"]);
    expect(contents.at(-1)?.parts[0].text).toContain("Mika:");
  });

  it("forwards stopSequences inside generationConfig on the Google waifu path", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: context,
      systemPrompt: "stay in character",
      stopSequences: ["\nAria:", "\nRiko:"]
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { stopSequences?: string[] };
    expect(generationConfig.stopSequences).toEqual(["\nAria:", "\nRiko:"]);
  });

  it("omits stopSequences from Google generationConfig when none are supplied", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-3.1-flash-lite", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-3.1-flash-lite",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { stopSequences?: string[] };
    expect(generationConfig).not.toHaveProperty("stopSequences");
  });

  it("clamps Google stopSequences to the first five entries", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-3.1-flash-lite", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-3.1-flash-lite",
      messages: context,
      systemPrompt: "stay in character",
      stopSequences: [
        "\nAria:",
        "\nRiko:",
        "\nLumi:",
        "\nYuki:",
        "\nMika:",
        "\nKevin:",
        "\nAlice:"
      ]
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { stopSequences?: string[] };
    expect(generationConfig.stopSequences).toEqual([
      "\nAria:",
      "\nRiko:",
      "\nLumi:",
      "\nYuki:",
      "\nMika:"
    ]);
  });

  it("attaches inlineData parts with base64 image bytes", async () => {
    const apiResponse = {
      candidates: [{ content: { parts: [{ text: "nice cat" }] } }]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.startsWith("https://cdn.example/")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "content-type": "image/png" }
          });
        }
        return new Response(JSON.stringify(apiResponse), { status: 200 });
      })
    );

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: [
        {
          id: "img1",
          channelId: "c1",
          guildId: "g1",
          authorKind: "user",
          authorId: "u1",
          name: "Kevin",
          displayName: "Kevin",
          content: "what is this?",
          timestamp: "2026-05-16T12:00:00Z",
          images: [{ url: "https://cdn.example/cat.png", contentType: "image/png" }],
          reactions: []
        }
      ],
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const userTurn = contents[0];
    expect(userTurn.role).toBe("user");
    expect(userTurn.parts).toEqual([
      { text: expect.stringContaining("[attachments: 1x image]") },
      { inlineData: { mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") } }
    ]);
  });

  it("translates reasoning.effort to thinkingLevel on Gemini 3.x flash models", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-3-flash-preview", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-3-flash-preview",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { effort: "medium" }
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingLevel?: string } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });
    const fetchMock = (globalThis.fetch as unknown) as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent");
  });

  it("sets thinkingBudget:0 when reasoning is disabled on Gemini 2.5 Flash", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { enabled: false }
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("supports disabling and dynamic thinking on Gemini 2.5 Flash Lite", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { enabled: false }
    });

    let query = recentQueries().at(-1);
    let generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });

    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { enabled: true }
    });

    query = recentQueries().at(-1);
    generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it("clamps thinkingBudget to 512 on Gemini 2.5 Flash Lite", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { budgetTokens: 100 }
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: 512 });
  });

  it("sends BLOCK_NONE safety settings on all four configurable categories", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const safety = query?.payload.safetySettings as Array<{ category: string; threshold: string }>;
    expect(safety.map((entry) => entry.category).sort()).toEqual([
      "HARM_CATEGORY_DANGEROUS_CONTENT",
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT"
    ]);
    expect(safety.every((entry) => entry.threshold === "BLOCK_NONE")).toBe(true);
  });

  it("forces the OpenAI Chat observer tool with chat context only", async () => {
    mockFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "record_observations",
                  arguments: JSON.stringify({
                    observations: [
                      { waifuId: "yuki", content: "Kevin likes tea.", importance: "3", kind: "preference" }
                    ]
                  })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const observations = await pipeline.decideStageManagerObservations?.({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "extract",
      availableWaifuIds: ["yuki"]
    });

    expect(observations).toEqual([
      { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" }
    ]);
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("stage_manager_observer");
    expect((query?.payload.tools as Array<{ function: { name: string } }>)[0].function.name).toBe("record_observations");
    expect(query?.payload.tool_choice).toMatchObject({ function: { name: "record_observations" } });
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.some((message) => typeof message.content === "string" && message.content.includes("memories:"))).toBe(false);
    expect(messages.some((message) => typeof message.content === "string" && message.content.includes("observations:"))).toBe(false);
  });

  it("forces the OpenAI Responses observer tool with chat context only", async () => {
    mockFetch({
      output: [
        {
          type: "function_call",
          name: "record_observations",
          arguments: JSON.stringify({
            observations: [
              { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" }
            ]
          })
        }
      ]
    });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    const observations = await pipeline.decideStageManagerObservations?.({
      modelId: "gpt-4o-mini",
      messages: context,
      systemPrompt: "extract",
      availableWaifuIds: ["yuki", "mika"]
    });

    expect(observations?.[0]).toMatchObject({ waifuId: "yuki", kind: "preference" });
    const query = recentQueries().at(-1);
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("record_observations");
    expect(query?.payload.tool_choice).toEqual({ type: "function", name: "record_observations" });
    const inputMessages = query?.payload.input as Array<{ content: string }>;
    expect(inputMessages).toHaveLength(1);
    expect(inputMessages[0].content).not.toContain("memories:");
    expect(inputMessages[0].content).not.toContain("observations:");
    const toolParameters = (query?.payload.tools as Array<{
      parameters: { properties: { observations: { items: { properties: { waifuId: Record<string, unknown>; kind: Record<string, unknown> } } } } };
    }>)[0].parameters.properties.observations.items.properties;
    expect(toolParameters.waifuId).toMatchObject({ enum: ["yuki", "mika"] });
    expect(toolParameters.kind).toMatchObject({ enum: ["fact", "preference", "relationship", "event", "commitment"] });
  });

  it("forces the Anthropic observer tool with chat context only", async () => {
    mockFetch({
      content: [
        {
          type: "tool_use",
          name: "record_observations",
          input: {
            observations: [
              { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    const observations = await pipeline.decideStageManagerObservations?.({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "extract",
      availableWaifuIds: ["yuki"]
    });

    expect(observations?.[0]).toMatchObject({ waifuId: "yuki" });
    const query = recentQueries().at(-1);
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("record_observations");
    expect(query?.payload.tool_choice).toEqual({ type: "tool", name: "record_observations" });
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).not.toContain("memories:");
    expect(messages[0].content).not.toContain("observations:");
  });

  it("forces the Google observer tool with chat context only", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "record_observations",
                  args: {
                    observations: [
                      { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    const observations = await pipeline.decideStageManagerObservations?.({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      systemPrompt: "extract",
      availableWaifuIds: ["yuki"]
    });

    expect(observations?.[0]).toMatchObject({ kind: "preference", importance: 3 });
    const query = recentQueries().at(-1);
    expect(query?.payload.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["record_observations"] }
    });
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents).toHaveLength(1);
    expect(contents[0].parts[0].text).not.toContain("memories:");
    expect(contents[0].parts[0].text).not.toContain("observations:");
    const toolParameters = (query?.payload.tools as Array<{
      functionDeclarations: Array<{
        parameters: {
          properties: {
            observations: {
              items: {
                properties: {
                  importance: Record<string, unknown>;
                };
              };
            };
          };
        };
      }>;
    }>)[0].functionDeclarations[0].parameters.properties.observations.items.properties;
    expect(toolParameters.importance).toMatchObject({ type: "integer", enum: ["1", "2", "3", "4", "5"] });
  });

  it("OpenAI Chat: collects all add_memory calls alongside the optional PickNextWaifu", async () => {
    mockFetch({
      choices: [
        {
          message: {
            content: "noted",
            tool_calls: [
              { function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "mika" }) } },
              { function: { name: "add_memory", arguments: JSON.stringify({ content: "Kevin heading out at 5pm." }) } },
              { function: { name: "add_memory", arguments: JSON.stringify({ content: "Kevin prefers green tea today." }) } }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const result = await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      availableWaifuIds: ["mika"],
      pickNextWaifuToolEnabled: true,
      shortTermMemoryToolEnabled: true
    });

    expect(result.pickedNextWaifuId).toBe("mika");
    expect(result.shortTermMemoryEntries).toEqual([
      "Kevin heading out at 5pm.",
      "Kevin prefers green tea today."
    ]);
    const query = recentQueries().at(-1);
    const toolNames = (query?.payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(toolNames).toEqual(["PickNextWaifu", "add_memory"]);
  });

  it("OpenAI Chat: omits the short-term tool when the gate is off", async () => {
    mockFetch({ choices: [{ message: { content: "hi" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      availableWaifuIds: ["mika"],
      pickNextWaifuToolEnabled: true,
      shortTermMemoryToolEnabled: false
    });

    const query = recentQueries().at(-1);
    const toolNames = (query?.payload.tools as Array<{ function: { name: string } }> | undefined)?.map(
      (t) => t.function.name
    ) ?? [];
    expect(toolNames).not.toContain("add_memory");
  });

  it("OpenAI Responses: collects multiple add_memory calls", async () => {
    mockFetch({
      output: [
        { type: "function_call", name: "add_memory", arguments: JSON.stringify({ content: "note one" }) },
        { type: "function_call", name: "add_memory", arguments: JSON.stringify({ content: "note two" }) }
      ],
      output_text: "ok"
    });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    const result = await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: context,
      systemPrompt: "stay in character",
      shortTermMemoryToolEnabled: true
    });

    expect(result.shortTermMemoryEntries).toEqual(["note one", "note two"]);
    const query = recentQueries().at(-1);
    const toolNames = (query?.payload.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("add_memory");
  });

  it("Anthropic: collects multiple add_memory calls", async () => {
    mockFetch({
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", name: "add_memory", input: { content: "first" } },
        { type: "tool_use", name: "add_memory", input: { content: "second" } }
      ]
    });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    const result = await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      shortTermMemoryToolEnabled: true
    });

    expect(result.shortTermMemoryEntries).toEqual(["first", "second"]);
    const query = recentQueries().at(-1);
    const toolNames = (query?.payload.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("add_memory");
  });

  it("Google: collects multiple add_memory calls", async () => {
    mockFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: "ok" },
              { functionCall: { name: "add_memory", args: { content: "alpha" } } },
              { functionCall: { name: "add_memory", args: { content: "beta" } } }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("gemini-2.5-flash-lite", { apiKey: "g-test" });
    const result = await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash-lite",
      messages: context,
      systemPrompt: "stay in character",
      shortTermMemoryToolEnabled: true
    });

    expect(result.shortTermMemoryEntries).toEqual(["alpha", "beta"]);
    const query = recentQueries().at(-1);
    const toolConfig = query?.payload.toolConfig as { functionCallingConfig?: { allowedFunctionNames?: string[] } };
    expect(toolConfig?.functionCallingConfig?.allowedFunctionNames).toBeUndefined();
  });
});

describe("orchestrator wire format (W1)", () => {
  it("tool schema requires only waifuId per responder and has no replyStyle/index fields", () => {
    const params = ORCHESTRATOR_TOOL_PARAMETERS as any;
    const responder = params.properties.respondingWaifus.items;
    expect(responder.required).toEqual(["waifuId"]);
    expect(responder.properties.replyStyle).toBeUndefined();
    expect(responder.properties.repleyToMessageIndex).toBeUndefined();
    expect(responder.properties.directive).toBeDefined();
    expect(params.properties.wakePlan).toBeDefined();
  });

  it("parseDecision normalizes directives, drops unknown intents, defaults delaySeconds", () => {
    const decision = __testables.parseDecision(JSON.stringify({
      action: "reply",
      respondingWaifus: [
        { waifuId: "aria", directive: { intent: "change_topic", goal: "bring up the snowstorm" } },
        { waifuId: "riko", directive: { intent: "write_her_reply", goal: "say hi" } }
      ],
      retriggerAfterSeconds: null,
      reasoning: "test"
    }));
    expect(decision.respondingWaifus[0].directive).toEqual({ intent: "change_topic", goal: "bring up the snowstorm" });
    expect(decision.respondingWaifus[0].delaySeconds).toBe(0);
    expect(decision.respondingWaifus[1].directive).toBeUndefined();
  });

  it("replays past decisions with intent-only directives, clipped reasoning, and real outcomes", () => {
    const model = listModels().find((m) => m.modelId === "grok-4.3");
    expect(model).toBeDefined();
    const longReasoning = "x".repeat(300);
    const entry = {
      id: "decision-replay-1",
      guildId: "g1",
      channelId: "c1",
      action: "reply" as const,
      respondingWaifus: [
        {
          waifuId: "aria",
          delaySeconds: 0,
          directive: { intent: "spotlight" as const, goal: "secret goal text" }
        }
      ],
      reasoning: longReasoning,
      status: "completed" as const,
      waifuMessageIds: [],
      responderOutcomes: [
        {
          id: "o1",
          waifuId: "aria",
          source: "orchestrator" as const,
          status: "empty" as const,
          messageIds: []
        }
      ],
      createdAt: "2026-05-16T12:00:01Z"
    };
    const messages: ContextMessage[] = [
      {
        id: "m-before",
        channelId: "c1",
        guildId: "g1",
        authorKind: "user",
        authorId: "u1",
        name: "Kevin",
        displayName: "Kevin",
        content: "hello",
        timestamp: "2026-05-16T12:00:00Z",
        reactions: []
      },
      {
        id: "m-after",
        channelId: "c1",
        guildId: "g1",
        authorKind: "user",
        authorId: "u1",
        name: "Kevin",
        displayName: "Kevin",
        content: "anyone there?",
        timestamp: "2026-05-16T12:00:01Z",
        reactions: []
      }
    ];
    const result = __testables.buildOpenAiChatOrchestratorMessages({
      model: model!,
      systemPrompt: "",
      messages,
      decisions: [entry],
      trailingPrompt: "go"
    });
    const assistantMsg = result.find((m: any) => m.role === "assistant" && m.tool_calls);
    const args = JSON.parse((assistantMsg as any)?.tool_calls[0].function.arguments ?? "{}");
    expect(args.respondingWaifus[0].directive).toEqual({ intent: "spotlight" });
    expect(JSON.stringify(args)).not.toContain("secret goal text");
    expect(args.reasoning.length).toBeLessThanOrEqual(160);
    const toolMsg = result.find((m: any) => m.role === "tool");
    expect((toolMsg as any)?.content).toContain("aria: empty");
  });

  it("inserts gap notes for >=15min silences and renders a wake marker last", () => {
    const model = listModels().find((m) => m.modelId === "grok-4.3");
    expect(model).toBeDefined();
    const messages: ContextMessage[] = [
      {
        id: "gap-m1",
        channelId: "c1",
        guildId: "g1",
        authorKind: "user",
        authorId: "u1",
        name: "Kevin",
        displayName: "Kevin",
        content: "hello",
        timestamp: "2026-05-16T10:00:00Z",
        reactions: []
      },
      {
        id: "gap-m2",
        channelId: "c1",
        guildId: "g1",
        authorKind: "user",
        authorId: "u1",
        name: "Kevin",
        displayName: "Kevin",
        content: "still here?",
        timestamp: "2026-05-16T12:00:00Z",
        reactions: []
      }
    ];
    const markers = [
      {
        kind: "wake" as const,
        timestamp: "2026-05-16T12:30:00Z",
        scheduledSeconds: 1800,
        wakePlan: "have Lumi answer"
      }
    ];
    const result = __testables.buildOpenAiChatOrchestratorMessages({
      model: model!,
      systemPrompt: "",
      messages,
      decisions: [],
      markers,
      trailingPrompt: "go"
    });
    const userContents = result
      .filter((m: any) => m.role === "user")
      .map((m: any) => m.content as string);
    expect(userContents.some((c) => c === "[2h pass]")).toBe(true);
    // The last user message before the trailing "go" should be the wake marker
    const nonTrailingUser = userContents.slice(0, -1);
    const lastContent = nonTrailingUser[nonTrailingUser.length - 1];
    expect(lastContent).toContain("[wake:");
    expect(lastContent).toContain("have Lumi answer");
  });
});

describe("per-waifu context roles (W2)", () => {
  const messages: ContextMessage[] = [
    { id: "m1", channelId: "c1", authorKind: "user", authorId: "u1", name: "Kevin", displayName: "Kevin", content: "hey everyone", timestamp: "2026-06-12T10:00:00Z", reactions: [] },
    { id: "m2", channelId: "c1", authorKind: "waifu", authorId: "bot-aria", name: "aria", displayName: "K的小娇妻", content: "hi Kevin", timestamp: "2026-06-12T10:00:05Z", reactions: [], replyTo: { messageId: "m1", authorName: "Kevin", contentPreview: "hey everyone" } },
    { id: "m3", channelId: "c1", authorKind: "waifu", authorId: "bot-riko", name: "riko", displayName: "Riko", content: "yo", timestamp: "2026-06-12T10:00:10Z", reactions: [] }
  ];

  it("marks only the self waifu's messages as assistant", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, ["bot-aria"]);
    expect(result.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("renders self messages as raw content without prefix, quote, or tags", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, ["bot-aria"]);
    expect(result[1].content).toBe("hi Kevin");
    expect(result[2].content).toBe("Riko: yo");
  });

  it("treats other waifus as user turns with name framing", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, ["bot-riko"]);
    expect(result.map((m: any) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(result[1].content).toContain("K的小娇妻: hi Kevin");
    expect(result[1].content).toContain("replying to > Kevin");
    expect(result[2].content).toBe("yo");
  });

  it("falls back to user role for waifu messages when no selfAuthorIds given", () => {
    const result = __testables.contextToChatMessagesForWaifu(messages, false, []);
    expect(result.map((m: any) => m.role)).toEqual(["user", "user", "user"]);
  });
});

describe("generatePersonaDigest (OpenAI-chat, end-to-end)", () => {
  it("sends forced set_persona_digest tool call and parses voice/role from response", async () => {
    const toolResponse = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "set_persona_digest",
                  arguments: JSON.stringify({
                    voice: "Speaks in short playful bursts, heavy emoji, casual contractions.",
                    role: "Fits best when the room needs energy or a quick mood lift."
                  })
                }
              }
            ]
          }
        }
      ]
    };
    mockFetch(toolResponse);

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    const result = await pipeline.generatePersonaDigest!({
      modelId: "grok-4.3",
      messages: [],
      personaText: "A bubbly, energetic character who loves memes."
    });

    expect(result.voice).toBe("Speaks in short playful bursts, heavy emoji, casual contractions.");
    expect(result.role).toBe("Fits best when the room needs energy or a quick mood lift.");

    const body = lastFetchJsonBody();
    const tools = body.tools as Array<{ function: { name: string; parameters: unknown } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("set_persona_digest");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "set_persona_digest" } });
    expect(body.stream).toBe(false);
    const messages = body.messages as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("A bubbly, energetic character who loves memes.");
  });

  it("throws ProviderPipelineError on malformed digest response", async () => {
    mockFetch({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "set_persona_digest",
                  arguments: JSON.stringify({ voice: "", role: "valid role" })
                }
              }
            ]
          }
        }
      ]
    });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await expect(
      pipeline.generatePersonaDigest!({
        modelId: "grok-4.3",
        messages: [],
        personaText: "test persona"
      })
    ).rejects.toThrow("Provider did not return a valid persona digest.");
  });
});

function mockFetch(json: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), { status }))
  );
}

function lastFetchJsonBody(): Record<string, unknown> {
  const fetchMock = (globalThis.fetch as unknown) as ReturnType<typeof vi.fn>;
  const init = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  if (!init?.body) throw new Error("No fetch body recorded.");
  return JSON.parse(init.body) as Record<string, unknown>;
}
