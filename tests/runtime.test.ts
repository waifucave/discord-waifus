import { afterEach, describe, expect, it } from "vitest";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import { ContextMessage } from "../src/orchestration/context.js";
import { OrchestratorDecision } from "../src/orchestration/decisions.js";
import {
  DiscordGatewayFacade,
  DiscordReviewCommandEvent,
  DiscordReviewCommandListener,
  DiscordRuntimeStatus
} from "../src/discord/client.js";
import {
  ModelPipeline,
  PipelineCredentials,
  ProviderRequest,
  StageManagerRequest,
  WaifuGenerationRequest
} from "../src/providers/types.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import {
  AgentConfigSchema,
  MemoryStoreSchema,
  OrchestratorHistoryFileSchema,
  ProviderCredentialsFileSchema,
  ReviewerHistoryFileSchema,
  ServerConfigSchema,
  StageManagerHistoryFileSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

class FakeDiscord implements DiscordGatewayFacade {
  sent: Array<{ content: string; senderBotId?: string; replyToMessageId?: string }> = [];
  typingCalls: Array<{ channelId: string; senderBotId?: string }> = [];
  deleted: Array<{ guildId: string; channelId: string; messageIds: string[]; authorId?: string }> = [];
  reviewListeners = new Set<DiscordReviewCommandListener>();
  contexts: ContextMessage[][] = [
    [contextMessage("m1", "user", "Kevin", "hello")],
    [contextMessage("m1", "user", "Kevin", "hello")],
    [contextMessage("m2", "waifu", "Yuki", "hi")]
  ];

  async connect(): Promise<DiscordRuntimeStatus> {
    return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
  }

  async disconnect(): Promise<void> {}

  onReviewCommand(listener: DiscordReviewCommandListener): () => void {
    this.reviewListeners.add(listener);
    return () => this.reviewListeners.delete(listener);
  }

  async emitReviewCommand(
    event: Omit<DiscordReviewCommandEvent, "respond"> & { respond?: DiscordReviewCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.reviewListeners].map((listener) =>
        listener({
          ...event,
          respond: event.respond ?? (async () => undefined)
        })
      )
    );
  }

  async fetchFreshContext(): Promise<ContextMessage[]> {
    return this.contexts.shift() ?? [contextMessage("m3", "waifu", "Yuki", "done")];
  }

  async sendWaifuMessage(input: {
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }> {
    this.sent.push(input);
    return { messageId: `sent-${this.sent.length}` };
  }

  async sendTyping(input: { channelId: string; senderBotId?: string }): Promise<void> {
    this.typingCalls.push({ channelId: input.channelId, senderBotId: input.senderBotId });
  }

  async deleteMessages(input: {
    guildId: string;
    channelId: string;
    messageIds: string[];
    authorId?: string;
  }) {
    this.deleted.push(input);
    return {
      deletedMessageIds: input.messageIds,
      failedMessageIds: []
    };
  }
}

class FakePipeline implements ModelPipeline {
  decisions: OrchestratorDecision[] = [
    {
      action: "waifus",
      selectedWaifus: [{ waifuId: "yuki", sceneDirection: "answer Kevin", replyToMessageId: "m1" }],
      reasoning: "Kevin should get a reply."
    },
    {
      action: "no_reply",
      retriggerAfterSeconds: 100,
      reasoning: "Wait now."
    }
  ];

  async generateWaifu(request: WaifuGenerationRequest) {
    expect(request.systemPrompt).toContain("You are Yuki");
    expect(request.sceneDirection).toBe("answer Kevin");
    return { content: "hello <@Kevin> <:cutecat:>" };
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    expect(request.systemPrompt).toContain("decide");
    expect(request.systemPrompt).toContain("## Active Waifus");
    expect(request.systemPrompt).toContain("ID: yuki");
    expect(request.systemPrompt).toContain("kind");
    expect(request.systemPrompt).toContain("## Current Time");
    expect(request.availableWaifuIds).toEqual(["yuki"]);
    const decision = this.decisions.shift();
    if (!decision) throw new Error("No fake decision left.");
    return decision;
  }
}

describe("RuntimeOrchestrator", () => {
  it("runs orchestrator -> waifu -> orchestrator and persists history/session", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const pipeline = new FakePipeline();

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: (_modelId: string, _credentials: PipelineCredentials) => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent).toEqual([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        content: "hello <@Kevin> <:cutecat:>",
        senderBotId: "yuki-bot",
        replyToMessageId: undefined,
        allowedUserMentionIds: ["u1"]
      }
    ]);

    const history = await storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema
    );
    expect(history.decisions.map((entry) => entry.action)).toEqual(["no_reply", "waifus"]);

    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.scheduledRetriggerAt).toBeDefined();
  });

  it("runs stage-manager tool calls in the background and updates memories", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManager(request: StageManagerRequest) {
        expect(request.systemPrompt).toBe("memories");
        return [
          {
            tool: "add_memory",
            memory: {
              waifuId: "yuki",
              scope: "global",
              content: "Kevin likes tea.",
              importance: 3,
              sourceMessageIds: ["m1"]
            }
          }
        ];
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerStageManager("guild-1", "channel-1");

    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories[0].content).toBe("Kevin likes tea.");
    expect(discord.sent[0].content).toBe("memories updated");

    const history = await storage.readJson(
      "user/stage-manager/history.json",
      StageManagerHistoryFileSchema
    );
    expect(history.edits[0].tool).toBe("add_memory");
  });

  it("reviews the latest waifu chunk group, deletes hallucinated chunks, and retriggers orchestration", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage(
          "chunk-2",
          "waifu",
          "Yuki",
          "</analysis> I should answer as Yuki. Response draft: hi",
          ["chunk-1", "chunk-2"]
        )
      ],
      [contextMessage("m1", "user", "Kevin", "hello")]
    ];

    let reviewedMessage = "";
    let orchestratorCalls = 0;
    let resolveOrchestrated: () => void = () => undefined;
    const orchestrated = new Promise<void>((resolve) => {
      resolveOrchestrated = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideReviewer(request) {
        reviewedMessage = request.message;
        return { hallucination: true };
      },
      async decideOrchestrator() {
        orchestratorCalls += 1;
        resolveOrchestrated();
        return { action: "no_reply", retriggerAfterSeconds: 100, reasoning: "post-review" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitReviewCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "reviewer-user",
      commandMessageId: "review-command",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await Promise.race([
      orchestrated,
      new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator was not retriggered")), 1000))
    ]);
    await runtime.stop();

    expect(reviewedMessage).toBe("</analysis> I should answer as Yuki. Response draft: hi");
    expect(discord.deleted[0]).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      messageIds: ["chunk-1", "chunk-2"],
      authorId: "yuki-bot"
    });
    expect(discord.deleted[1]).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      messageIds: ["review-command"]
    });
    expect(responses).toEqual(["Removed 2 hallucinated waifu message chunks."]);
    expect(orchestratorCalls).toBe(1);

    const history = await storage.readJson(
      "user/reviewer/history.json",
      ReviewerHistoryFileSchema
    );
    expect(history.reviews[0]).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-1",
      reviewerUserId: "reviewer-user",
      targetMessageIds: ["chunk-1", "chunk-2"],
      hallucination: true,
      deleted: true
    });
  });

  it("lets the orchestrator delegate suspected hallucinations to the reviewer", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("w1", "waifu", "Yuki", "analysis leak")
      ],
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("w1", "waifu", "Yuki", "analysis leak")
      ],
      [contextMessage("m1", "user", "Kevin", "hello")]
    ];

    let reviewerCalls = 0;
    let resolveRetriggered: () => void = () => undefined;
    const retriggered = new Promise<void>((resolve) => {
      resolveRetriggered = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideReviewer() {
        reviewerCalls += 1;
        return { hallucination: false };
      },
      async decideOrchestrator() {
        if (reviewerCalls === 0) {
          return { action: "reviewer", reasoning: "latest waifu may have leaked analysis" };
        }
        resolveRetriggered();
        return { action: "no_reply", retriggerAfterSeconds: 100, reasoning: "review complete" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await Promise.all([
      runtime.triggerChannel("guild-1", "channel-1"),
      Promise.race([
        retriggered,
        new Promise((_, reject) => setTimeout(() => reject(new Error("reviewer completion did not retrigger")), 1000))
      ])
    ]);
    await runtime.stop();

    expect(reviewerCalls).toBe(1);
    const history = await storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema
    );
    expect(history.decisions.map((entry) => entry.action)).toEqual(["no_reply", "reviewer"]);
  });

  it("splits a multi-sentence waifu reply into multiple Discord messages and emits typing", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    class MultiChunkPipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "waifus",
          selectedWaifus: [{ waifuId: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "Reply to Kevin."
        },
        { action: "no_reply", retriggerAfterSeconds: 100, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "Hi there. How are you today? Want to play?" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new MultiChunkPipeline();
    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: () => pipeline,
      sleep: async () => undefined,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((entry) => entry.content)).toEqual([
      "Hi there.",
      "How are you today?",
      "Want to play?"
    ]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
    expect(discord.sent[1].replyToMessageId).toBeUndefined();
    expect(discord.sent[2].replyToMessageId).toBeUndefined();
    expect(discord.typingCalls.some((call) => call.senderBotId === "yuki-bot")).toBe(true);
    expect(discord.typingCalls.some((call) => call.senderBotId === undefined)).toBe(true);
  });

  it("keeps Discord reply targets only for older non-latest messages", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "older question"),
        contextMessage("m2", "user", "Kevin", "newer follow-up")
      ],
      [
        contextMessage("m1", "user", "Kevin", "older question"),
        contextMessage("m2", "user", "Kevin", "newer follow-up")
      ],
      [contextMessage("m3", "waifu", "Yuki", "done")]
    ];

    class OlderReplyPipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "waifus",
          selectedWaifus: [{ waifuId: "yuki", sceneDirection: "answer older", replyToMessageId: "m1" }],
          reasoning: "Reply to the older message."
        },
        { action: "no_reply", retriggerAfterSeconds: 100, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "answering the older one" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: () => new OlderReplyPipeline(),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent[0].replyToMessageId).toBe("m1");
  });

  it("ignores gateway echoes of its own waifu messages so chunked replies finish", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    class StubPipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "waifus",
          selectedWaifus: [{ waifuId: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "respond"
        },
        { action: "no_reply", retriggerAfterSeconds: 100, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "Hi. How are you? Want to play?" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new StubPipeline();
    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: () => pipeline,
      sleep: async () => undefined,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    let nextEchoMessageId = 1;
    const originalSend = discord.sendWaifuMessage.bind(discord);
    discord.sendWaifuMessage = async (input) => {
      const messageId = `echo-${nextEchoMessageId++}`;
      // Simulate Discord's gateway echo arriving BEFORE the REST response resolves —
      // and from a Discord user id that is NOT the same as our waifu config bot id.
      await runtime.handleDiscordMessage({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId,
        authorId: "different-discord-user-id-from-bot-config",
        authorBot: true
      });
      const result = await originalSend(input);
      return { ...result, messageId };
    };

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((entry) => entry.content)).toEqual([
      "Hi.",
      "How are you?",
      "Want to play?"
    ]);
  });

  it("still lets a real user message interrupt an in-flight chunked reply", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    class StubPipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "waifus",
          selectedWaifus: [{ waifuId: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "respond"
        },
        { action: "no_reply", retriggerAfterSeconds: 100, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "Hi. How are you? Want to play?" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new StubPipeline();
    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: () => pipeline,
      sleep: async () => undefined,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    let interrupted = false;
    const originalSend = discord.sendWaifuMessage.bind(discord);
    discord.sendWaifuMessage = async (input) => {
      const result = await originalSend(input);
      if (!interrupted) {
        interrupted = true;
        await runtime.handleDiscordMessage({
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "user-interrupt",
          authorId: "kevin",
          authorBot: false
        });
      }
      return result;
    };

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.length).toBeLessThan(3);
    expect(discord.sent[0].content).toBe("Hi.");
  });

  it("does not start channel work while paused", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      isPaused: () => true,
      createPipeline: () => new FakePipeline(),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    expect(discord.sent).toEqual([]);
  });
});

async function seedRuntimeConfig(storage: StorageService) {
  await storage.writeJson(
    "providers",
    "user/providers.json",
    ProviderCredentialsFileSchema,
    ProviderCredentialsFileSchema.parse(
      createEmptyRevisionedFile({
        providers: {
          openai: {
            providerId: "openai",
            apiKey: "sk-test",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      })
    )
  );
  await storage.writeJson(
    "orchestrator",
    "user/orchestrator/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: true,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      contextWindow: 20,
      prompt: "decide"
    })
  );
  await storage.writeJson(
    "stage-manager",
    "user/stage-manager/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: true,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      contextWindow: 80,
      prompt: "memories"
    })
  );
  await storage.writeJson(
    "reviewer",
    "user/reviewer/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: true,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      contextWindow: 20,
      prompt: "review"
    })
  );
  await storage.writeJson(
    "server:guild-1",
    "user/servers/guild-1/server.json",
    ServerConfigSchema,
    ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId: "guild-1",
      enabled: true,
      channels: {
        "channel-1": {
          channelId: "channel-1",
          enabled: true,
          enabledWaifuIds: ["yuki"]
        }
      }
    })
  );
  await storage.writeJson(
    "waifu:yuki",
    "user/waifus/yuki/waifu.json",
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      enabled: true,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      botId: "yuki-bot",
      persona: "kind",
      contextWindow: 50
    })
  );
}

function contextMessage(
  id: string,
  authorKind: "user" | "waifu",
  displayName: string,
  content: string,
  sourceMessageIds?: string[]
): ContextMessage {
  return {
    id,
    channelId: "channel-1",
    guildId: "guild-1",
    authorKind,
    authorId: authorKind === "user" ? "u1" : "yuki-bot",
    name: displayName,
    displayName,
    content,
    sourceMessageIds,
    timestamp: "2026-05-16T12:00:00Z",
    reactions: []
  };
}
