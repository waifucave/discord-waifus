import { afterEach, describe, expect, it } from "vitest";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import { ContextMessage } from "../src/orchestration/context.js";
import { OrchestratorDecision } from "../src/orchestration/decisions.js";
import {
  DiscordGatewayFacade,
  DiscordClearCommandEvent,
  DiscordClearCommandListener,
  DiscordReviewCommandEvent,
  DiscordReviewCommandListener,
  DiscordRunCommandEvent,
  DiscordRunCommandListener,
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
  deleted: Array<{
    guildId: string;
    channelId: string;
    messageIds: string[];
    authorId?: string;
    authorIdByMessageId?: Record<string, string>;
  }> = [];
  reviewListeners = new Set<DiscordReviewCommandListener>();
  clearListeners = new Set<DiscordClearCommandListener>();
  runListeners = new Set<DiscordRunCommandListener>();
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

  onClearCommand(listener: DiscordClearCommandListener): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  onRunCommand(listener: DiscordRunCommandListener): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
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

  async emitClearCommand(
    event: Omit<DiscordClearCommandEvent, "respond"> & { respond?: DiscordClearCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.clearListeners].map((listener) =>
        listener({
          ...event,
          respond: event.respond ?? (async () => undefined)
        })
      )
    );
  }

  async emitRunCommand(
    event: Omit<DiscordRunCommandEvent, "respond"> & { respond?: DiscordRunCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.runListeners].map((listener) =>
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
    authorIdByMessageId?: Record<string, string>;
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
      steps: [{ kind: "yuki", sceneDirection: "answer Kevin", replyToMessageId: "m1" }],
      reasoning: "Kevin should get a reply."
    },
    {
      steps: [{ kind: "no_reply" }],
      idleTrigger: 180,
      reasoning: "Wait now."
    }
  ];

  async generateWaifu(request: WaifuGenerationRequest) {
    expect(request.systemPrompt).toContain("You are Yuki");
    expect(request.systemPrompt).toMatch(
      /<\/yuki_behavior>\n<available_server_emojis>[\s\S]*<\/available_server_emojis>\n<current_time>\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(UTC\)\n<\/current_time>/
    );
    expect(request.sceneDirection).toBe("answer Kevin");
    return { content: "hello <@Kevin> <:cutecat:>" };
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    expect(request.systemPrompt).toContain("decide");
    expect(request.systemPrompt).toContain("<active_waifus>");
    expect(request.systemPrompt).toMatch(
      /<active_waifus>\n<yuki>\nID: yuki\nDisplay name: Yuki\nPersona:\nkind\n<\/yuki>\n<\/active_waifus>/
    );
    expect(request.systemPrompt).toContain("kind");
    expect(request.systemPrompt).not.toContain("<current_time>");
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
      sleep: async () => undefined,
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
    expect(history.decisions.map((entry) => entry.steps.map((step) => step.kind))).toEqual([
      ["no_reply"],
      ["yuki"]
    ]);

    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.guildId).toBe("guild-1");
  });

  it("sends only no_reply markers created after the latest chat message", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        {
          ...contextMessage("m1", "user", "Kevin", "latest user message"),
          timestamp: "2026-05-16T12:10:00Z"
        }
      ]
    ];

    class MarkerCapturePipeline implements ModelPipeline {
      capturedMarkers: ProviderRequest["decisionMarkers"] = [];

      async generateWaifu() {
        return { content: "unused" };
      }

      async decideOrchestrator(request: ProviderRequest) {
        this.capturedMarkers = request.decisionMarkers ?? [];
        return { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "done" };
      }
    }

    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "orchestrator:history",
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(
        createEmptyRevisionedFile({
          decisions: [
            {
              id: "before-latest-chat",
              guildId: "guild-1",
              channelId: "channel-1",
              steps: [{ kind: "no_reply" }],
              reasoning: "before latest user message",
              idleTrigger: 300,
              createdAt: "2026-05-16T12:09:00.000Z"
            },
            {
              id: "after-latest-chat",
              guildId: "guild-1",
              channelId: "channel-1",
              steps: [{ kind: "no_reply" }],
              reasoning: "after latest user message",
              idleTrigger: 1800,
              createdAt: "2026-05-16T12:11:00.000Z"
            }
          ]
        })
      )
    );

    const pipeline = new MarkerCapturePipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(pipeline.capturedMarkers).toEqual([
      {
        kind: "no_reply",
        timestamp: "2026-05-16T12:11:00Z",
        idleTrigger: 1800,
        reasoning: "after latest user message"
      }
    ]);
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
      sleep: async () => undefined,
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
        return { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "post-review" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
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

  it("clears the latest waifu chunk group without running reviewer or retriggering orchestration", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("chunk-2", "waifu", "Yuki", "bad reply", ["chunk-1", "chunk-2"])
      ]
    ];

    let reviewerCalls = 0;
    let orchestratorCalls = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideReviewer() {
        reviewerCalls += 1;
        return { hallucination: true };
      },
      async decideOrchestrator() {
        orchestratorCalls += 1;
        return { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "unused" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
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
    let resolveClear: () => void = () => undefined;
    const cleared = new Promise<void>((resolve) => {
      resolveClear = resolve;
    });
    await discord.emitClearCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "moderator-user",
      respond: async (content) => {
        responses.push(content);
        resolveClear();
      }
    });
    await Promise.race([
      cleared,
      new Promise((_, reject) => setTimeout(() => reject(new Error("clear command did not respond")), 1000))
    ]);
    await runtime.stop();

    expect(discord.deleted).toEqual([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        messageIds: ["chunk-1", "chunk-2"],
        authorIdByMessageId: { "chunk-1": "yuki-bot", "chunk-2": "yuki-bot" }
      }
    ]);
    expect(responses).toEqual(["Cleared 1 waifu message (2 Discord chunks)."]);
    expect(reviewerCalls).toBe(0);
    expect(orchestratorCalls).toBe(0);
  });

  it("clears the requested number of latest logical waifu messages", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("old", "waifu", "Yuki", "old reply"),
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("mid-2", "waifu", "Yuki", "middle reply", ["mid-1", "mid-2"]),
        contextMessage("new", "waifu", "Yuki", "new reply")
      ]
    ];

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    await runtime.start();

    const responses: string[] = [];
    let resolveClear: () => void = () => undefined;
    const cleared = new Promise<void>((resolve) => {
      resolveClear = resolve;
    });
    await discord.emitClearCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "moderator-user",
      count: 2,
      respond: async (content) => {
        responses.push(content);
        resolveClear();
      }
    });
    await Promise.race([
      cleared,
      new Promise((_, reject) => setTimeout(() => reject(new Error("clear command did not respond")), 1000))
    ]);
    await runtime.stop();

    expect(discord.deleted).toEqual([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        messageIds: ["new", "mid-1", "mid-2"],
        authorIdByMessageId: {
          new: "yuki-bot",
          "mid-1": "yuki-bot",
          "mid-2": "yuki-bot"
        }
      }
    ]);
    expect(responses).toEqual(["Cleared 2 waifu messages (3 Discord chunks)."]);
  });

  it("clears latest messages from any author when /clear type is all", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("old-waifu", "waifu", "Yuki", "old reply"),
        contextMessage("user-1", "user", "Kevin", "first user message"),
        contextMessage("waifu-2", "waifu", "Yuki", "latest waifu reply", ["waifu-1", "waifu-2"]),
        contextMessage("user-2", "user", "Kevin", "latest user message")
      ]
    ];

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    await runtime.start();

    const responses: string[] = [];
    let resolveClear: () => void = () => undefined;
    const cleared = new Promise<void>((resolve) => {
      resolveClear = resolve;
    });
    await discord.emitClearCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "moderator-user",
      count: 2,
      type: "all",
      respond: async (content) => {
        responses.push(content);
        resolveClear();
      }
    });
    await Promise.race([
      cleared,
      new Promise((_, reject) => setTimeout(() => reject(new Error("clear command did not respond")), 1000))
    ]);
    await runtime.stop();

    expect(discord.deleted).toEqual([
      {
        guildId: "guild-1",
        channelId: "channel-1",
        messageIds: ["user-2", "waifu-1", "waifu-2"],
        authorIdByMessageId: {
          "user-2": "u1",
          "waifu-1": "yuki-bot",
          "waifu-2": "yuki-bot"
        }
      }
    ]);
    expect(responses).toEqual(["Cleared 2 messages (3 Discord chunks)."]);
  });

  it("runs the orchestrator from /run when the channel is idle", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];

    let resolveOrchestrated: () => void = () => undefined;
    const orchestrated = new Promise<void>((resolve) => {
      resolveOrchestrated = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        resolveOrchestrated();
        return { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "manual run complete" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
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
    let resolveRun: () => void = () => undefined;
    const runResponded = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    await discord.emitRunCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "runner-user",
      respond: async (content) => {
        responses.push(content);
        resolveRun();
      }
    });
    await Promise.all([
      Promise.race([
        runResponded,
        new Promise((_, reject) => setTimeout(() => reject(new Error("run command did not respond")), 1000))
      ]),
      Promise.race([
        orchestrated,
        new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator did not run")), 1000))
      ])
    ]);
    await runtime.stop();

    expect(responses).toEqual(["Started orchestrator run."]);
  });

  it("does not restart an already active run from /run", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];

    let orchestratorCalls = 0;
    let resolveEntered: () => void = () => undefined;
    let releaseOrchestrator: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseOrchestrator = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        orchestratorCalls += 1;
        resolveEntered();
        await release;
        return { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "active run complete" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    await runtime.start();

    const running = runtime.triggerChannel("guild-1", "channel-1", "test-active-run");
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator did not enter")), 1000))
    ]);

    const responses: string[] = [];
    let resolveRun: () => void = () => undefined;
    const runResponded = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    await discord.emitRunCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "runner-user",
      respond: async (content) => {
        responses.push(content);
        resolveRun();
      }
    });
    await Promise.race([
      runResponded,
      new Promise((_, reject) => setTimeout(() => reject(new Error("run command did not respond")), 1000))
    ]);
    releaseOrchestrator();
    await running;
    await runtime.stop();

    expect(responses).toEqual(["Orchestrator is already running in this channel."]);
    expect(orchestratorCalls).toBe(1);
  });

  it("does not start /run while reviewer is in flight", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("waifu-message", "waifu", "Yuki", "latest waifu reply")]
    ];

    let resolveReviewerEntered: () => void = () => undefined;
    let releaseReviewer: () => void = () => undefined;
    const reviewerEntered = new Promise<void>((resolve) => {
      resolveReviewerEntered = resolve;
    });
    const reviewerRelease = new Promise<void>((resolve) => {
      releaseReviewer = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideReviewer() {
        resolveReviewerEntered();
        await reviewerRelease;
        return { hallucination: false };
      },
      async decideOrchestrator() {
        return { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "review complete" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
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

    const reviewing = runtime.triggerReviewer("guild-1", "channel-1", "reviewer-user");
    await Promise.race([
      reviewerEntered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("reviewer did not enter")), 1000))
    ]);

    const responses: string[] = [];
    let resolveRun: () => void = () => undefined;
    const runResponded = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    await discord.emitRunCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "runner-user",
      respond: async (content) => {
        responses.push(content);
        resolveRun();
      }
    });
    await Promise.race([
      runResponded,
      new Promise((_, reject) => setTimeout(() => reject(new Error("run command did not respond")), 1000))
    ]);
    releaseReviewer();
    await reviewing;
    await runtime.stop();

    expect(responses).toEqual(["Reviewer is already running."]);
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
          steps: [{ kind: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "Reply to Kevin."
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "done" }
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
      sleep: async () => undefined,
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

  it("caches overflow reply chunks, sends them after channel idle, and reruns the orchestrator", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let resolveThirdDecision!: () => void;
    const thirdDecision = new Promise<void>((resolve) => {
      resolveThirdDecision = resolve;
    });

    class OverflowPipeline implements ModelPipeline {
      generateCalls = 0;
      decisionCalls = 0;
      decisions: OrchestratorDecision[] = [
        {
          steps: [{ kind: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "Reply to Kevin."
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "wait" },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "cached chunks posted" }
      ];
      async generateWaifu() {
        this.generateCalls += 1;
        return { content: "One. Two. This third chunk is too long. Four." };
      }
      async decideOrchestrator() {
        this.decisionCalls += 1;
        if (this.decisionCalls === 3) {
          resolveThirdDecision();
        }
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new OverflowPipeline();
    const decisionCallsDuringCachedSends: number[] = [];
    const originalSend = discord.sendWaifuMessage.bind(discord);
    discord.sendWaifuMessage = async (input) => {
      if (input.content === "This third chunk is too long." || input.content === "Four.") {
        decisionCallsDuringCachedSends.push(pipeline.decisionCalls);
      }
      return originalSend(input);
    };
    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 2,
      continuationIdleMs: 1,
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
    await Promise.race([
      thirdDecision,
      new Promise((_, reject) => setTimeout(() => reject(new Error("cached continuation did not rerun orchestrator")), 1000))
    ]);
    await runtime.stop();

    expect(discord.sent.map((entry) => entry.content)).toEqual([
      "One.",
      "Two.",
      "This third chunk is too long.",
      "Four."
    ]);
    expect(pipeline.generateCalls).toBe(1);
    expect(pipeline.decisionCalls).toBe(3);
    expect(decisionCallsDuringCachedSends).toEqual([2, 2]);
  });

  it("uses cached chunks when the orchestrator selects the same waifu with no scene direction", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    class SameWaifuContinuationPipeline implements ModelPipeline {
      generateCalls = 0;
      decisionCalls = 0;
      decisions: OrchestratorDecision[] = [
        {
          steps: [{ kind: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "Reply to Kevin."
        },
        {
          steps: [{ kind: "yuki" }],
          reasoning: "Let Yuki continue."
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "done" }
      ];
      async generateWaifu() {
        this.generateCalls += 1;
        return { content: "One. Two. This third chunk is too long. Four." };
      }
      async decideOrchestrator() {
        this.decisionCalls += 1;
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new SameWaifuContinuationPipeline();
    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      maxAutomaticTurns: 3,
      continuationIdleMs: 60_000,
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
      "One.",
      "Two.",
      "This third chunk is too long.",
      "Four."
    ]);
    expect(pipeline.generateCalls).toBe(1);
    expect(pipeline.decisionCalls).toBe(3);
  });

  it("discards cached chunks when chat activity arrives after the trimmed waifu message", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    class ActivityClearsContinuationPipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          steps: [{ kind: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "Reply to Kevin."
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "wait" },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "user spoke" }
      ];
      async generateWaifu() {
        return { content: "One. Two. This third chunk is too long. Four." };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new ActivityClearsContinuationPipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
      continuationIdleMs: 100,
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
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-after-trim",
      authorId: "kevin",
      authorBot: false
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.stop();

    expect(discord.sent.map((entry) => entry.content)).toEqual(["One.", "Two."]);
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
          steps: [{ kind: "yuki", sceneDirection: "answer older", replyToMessageId: "m1" }],
          reasoning: "Reply to the older message."
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "done" }
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
      sleep: async () => undefined,
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
          steps: [{ kind: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "respond"
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "done" }
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
      sleep: async () => undefined,
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
          steps: [{ kind: "yuki", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "respond"
        },
        { steps: [{ kind: "no_reply" }], idleTrigger: 180, reasoning: "done" }
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
      sleep: async () => undefined,
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
      sleep: async () => undefined,
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
