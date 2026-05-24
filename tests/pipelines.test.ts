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

const directorNotes = "<director_notes>\nKeep your reply short.\nDo not repeat what the previous waifu just said.\n</director_notes>";
const directorNotesWithSceneDirection = "<director_notes>\nKeep your reply short.\nDo not repeat what the previous waifu just said.\nScene direction: answer Kevin\n</director_notes>";

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
    expect(responderProperties.repleyToMessageIndex).toBeDefined();
    expect(responderProperties.replyToMessageId).toBeUndefined();
    expect(responderProperties.delaySeconds?.maximum).toBe(30);
    expect(query?.payload.tool_choice).toEqual({
      type: "function",
      function: { name: "orchestrator_decision" }
    });
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
    expect(messages.some((message) => message.content.includes("[sender: Kevin] that one [replying to: #2]"))).toBe(true);
  });

  it("renders orchestrator no_reply markers with retrigger after reason", async () => {
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
      decisionMarkers: [
        {
          kind: "no_reply",
          timestamp: "2026-05-16T12:05:00Z",
          retriggerAfterSeconds: 600,
          reasoning: "wait   for   Kevin"
        }
      ],
      systemPrompt: "decide"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ content: string }>;
    const renderedContext = messages.find((message) => message.content.includes("[no_reply]"))?.content ?? "";
    expect(renderedContext).toContain("[no_reply] [timestamp: 2026-05-16T12:05:00Z] [reason: wait for Kevin] [retrigger: 600s]");
    expect(renderedContext).not.toContain("[type: no_reply]");
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
    expect(query?.role).toBe("stage_manager");
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
    expect(memorySchema.sourceMessageIndices).toBeUndefined();
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
                replyStyle: "normal",
                repleyToMessageIndex: 1,
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
          delaySeconds: 1,
          replyStyle: "normal",
          replyToMessageId: "m1"
        }
      ]
    });
    const query = recentQueries().at(-1);
    expect(query?.role).toBe("orchestrator");
    expect((query?.payload.tools as Array<{ name: string }>)[0].name).toBe("orchestrator_decision");
    expect(query?.payload.tool_choice).toEqual({ type: "tool", name: "orchestrator_decision" });
  });

  it("passes waifu stop sequences to OpenAI-compatible chat", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    expect(query?.payload.stop).toEqual(["\n[timestamp:", "\n[sender:"]);
  });

  it("sends every waifu context message as assistant to OpenAI-compatible chat", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.slice(1).map((message) => message.role)).toEqual(["user", "assistant", "assistant", "system"]);
    expect(messages[2].content).toContain("[sender: Yuki]");
    expect(messages[3].content).toContain("[sender: Mika]");
  });

  it("sends every waifu context message as assistant to OpenAI Responses", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; content: string }>;
    expect(input.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "system"]);
    expect(input[1].content).toContain("[sender: Yuki]");
    expect(input[2].content).toContain("[sender: Mika]");
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

  it("passes waifu stop sequences to Anthropic Messages", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    expect(query?.payload.stop_sequences).toEqual(["\n[timestamp:", "\n[sender:"]);
  });

  it("sends every waifu context message as assistant to Anthropic Messages", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(messages[1].content).toContain("[sender: Yuki]");
    expect(messages[2].content).toContain("[sender: Mika]");
  });

  it("injects a reply_style hint when non-normal", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      replyStyle: "short"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.some((message) => message.content === "<reply_style>short</reply_style>")).toBe(true);
  });

  it("does not inject a reply_style hint when normal", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      replyStyle: "normal"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; content: string }>;
    expect(messages.some((message) => message.content.includes("<reply_style>"))).toBe(false);
  });
});

describe("director note payloads", () => {
  it("always sends OpenAI-compatible chat director notes without a name field", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; name?: string; content: string }>;
    expect(messages.at(-1)).toEqual({
      role: "system",
      content: directorNotes
    });
  });

  it("injects OpenAI-compatible chat scene direction into director notes", async () => {
    mockFetch({ choices: [{ message: { content: "ok" } }] });

    const pipeline = createModelPipeline("grok-4.3", { apiKey: "xai-test" });
    await pipeline.generateWaifu({
      modelId: "grok-4.3",
      messages: context,
      systemPrompt: "stay in character",
      sceneDirection: "answer Kevin"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; name?: string; content: string }>;
    expect(messages.at(-1)).toEqual({
      role: "system",
      content: directorNotesWithSceneDirection
    });
  });

  it("injects OpenAI Responses scene direction into director notes", async () => {
    mockFetch({ output_text: "ok" });

    const pipeline = createModelPipeline("gpt-4o-mini", { apiKey: "openai-test" });
    await pipeline.generateWaifu({
      modelId: "gpt-4o-mini",
      messages: context,
      systemPrompt: "stay in character",
      sceneDirection: "answer Kevin"
    });

    const query = recentQueries().at(-1);
    const input = query?.payload.input as Array<{ role: string; name?: string; content: string }>;
    expect(input.at(-1)).toEqual({
      role: "system",
      content: directorNotesWithSceneDirection
    });
  });

  it("sends Anthropic director notes as the trailing user message", async () => {
    mockFetch({ content: [{ type: "text", text: "ok" }] });

    const pipeline = createModelPipeline("claude-haiku-4-5-20251001", { apiKey: "anthropic-test" });
    await pipeline.generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      messages: context,
      systemPrompt: "stay in character",
      sceneDirection: "answer Kevin"
    });

    const query = recentQueries().at(-1);
    const messages = query?.payload.messages as Array<{ role: string; name?: string; content: string }>;
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: directorNotesWithSceneDirection
    });
  });
});

function mockFetch(json: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }))
  );
}
