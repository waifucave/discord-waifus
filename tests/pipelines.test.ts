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

const directorNotes = "<director_notes>\nKeep your reply short.\nDo not repeat what the previous waifu just said.\nDo not repeat a person's name when recent context already makes the target clear.\nTo pull a quiet person back in, use their <@Name> tag instead of repeating their name; do not tag them again if anyone already tagged them recently.\n</director_notes>";
const directorNotesWithSceneDirection = "<director_notes>\nKeep your reply short.\nDo not repeat what the previous waifu just said.\nDo not repeat a person's name when recent context already makes the target clear.\nTo pull a quiet person back in, use their <@Name> tag instead of repeating their name; do not tag them again if anyone already tagged them recently.\nScene direction: answer Kevin\n</director_notes>";

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
      { type: "text", text: expect.stringContaining("[images: 1]") },
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
      { type: "input_text", text: expect.stringContaining("[images: 1]") },
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
      { type: "text", text: expect.stringContaining("[images: 1]") },
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
    expect(messages[1].content).toEqual(expect.stringContaining("[images: 1]"));
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
    expect(messages[1].content).toEqual(expect.stringContaining("[image_text #1: Start chatting with Instant Vision tab]"));
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

  it("maps waifu turns to role 'model' and puts the system prompt under systemInstruction", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-2.5-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-2.5-flash",
      messages: contextWithWaifus,
      systemPrompt: "stay in character"
    });

    const query = recentQueries().at(-1);
    expect(query?.payload.systemInstruction).toEqual({ parts: [{ text: "stay in character" }] });
    const contents = query?.payload.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.slice(0, 3).map((turn) => turn.role)).toEqual(["user", "model", "model"]);
    expect(contents.at(-1)?.parts[0].text).toContain("<director_notes>");
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
      { text: expect.stringContaining("[images: 1]") },
      { inlineData: { mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") } }
    ]);
  });

  it("translates reasoning.effort to thinkingLevel on Gemini 3.x flash models", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    const pipeline = createModelPipeline("gemini-3-flash", { apiKey: "g-test" });
    await pipeline.generateWaifu({
      modelId: "gemini-3-flash",
      messages: context,
      systemPrompt: "stay in character",
      reasoning: { effort: "medium" }
    });

    const query = recentQueries().at(-1);
    const generationConfig = query?.payload.generationConfig as { thinkingConfig?: { thinkingLevel?: string } };
    expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });
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

  it("clamps thinkingBudget to 512 on Gemini 2.5 Flash Lite (cannot disable)", async () => {
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
});

function mockFetch(json: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }))
  );
}
