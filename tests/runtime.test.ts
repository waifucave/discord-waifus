import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator, clipSceneDirectionForWaifu } from "../src/orchestration/runtime.js";
import { ContextMessage } from "../src/orchestration/context.js";
import { OrchestratorDecision } from "../src/orchestration/decisions.js";
import {
  DiscordGatewayFacade,
  DiscordClearCommandEvent,
  DiscordClearCommandListener,
  DiscordMemoriesCommandEvent,
  DiscordMemoriesCommandListener,
  DiscordReviewCommandEvent,
  DiscordReviewCommandListener,
  DiscordRunCommandEvent,
  DiscordRunCommandListener,
  DiscordStopCommandEvent,
  DiscordStopCommandListener,
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
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  stopListeners = new Set<DiscordStopCommandListener>();
  memoriesListeners = new Set<DiscordMemoriesCommandListener>();
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

  onStopCommand(listener: DiscordStopCommandListener): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  onMemoriesCommand(listener: DiscordMemoriesCommandListener): () => void {
    this.memoriesListeners.add(listener);
    return () => this.memoriesListeners.delete(listener);
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

  async emitStopCommand(
    event: Omit<DiscordStopCommandEvent, "respond"> & { respond?: DiscordStopCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.stopListeners].map((listener) =>
        listener({
          ...event,
          respond: event.respond ?? (async () => undefined)
        })
      )
    );
  }

  async emitMemoriesCommand(
    event: Omit<DiscordMemoriesCommandEvent, "respond"> & { respond?: DiscordMemoriesCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.memoriesListeners].map((listener) =>
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
      action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal", sceneDirection: "answer Kevin, then pull in Mira", replyToMessageId: "m1" }],
      reasoning: "Kevin should get a reply."
    },
    {
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 180,
      reasoning: "Wait now."
    }
  ];

  async generateWaifu(request: WaifuGenerationRequest) {
    expect(request.systemPrompt).toContain("You are Yuki");
    expect(request.systemPrompt).toMatch(
      /<behavior>\n<personality_instructions>[\s\S]*You are Yuki[\s\S]*kind[\s\S]*<\/personality_instructions>\n<your_schedule>[\s\S]*configured routine[\s\S]*changes only when your schedule is edited[\s\S]*Sleep: 23:00-07:00 daily[\s\S]*09:00-10:00: school focus block[\s\S]*<\/your_schedule>\n<environment_instructions>[\s\S]*<\/environment_instructions>\n<hard_rules>[\s\S]*Write exactly one short phrase[\s\S]*Never write a second sentence[\s\S]*This length rule overrides your persona, reply_style, and scene_direction[\s\S]*Do not ping a user who is already active[\s\S]*Use only listed server emojis[\s\S]*<\/hard_rules>/
    );
    expect(request.systemPrompt).not.toContain("<yuki_behavior>");
    expect(request.systemPrompt).not.toContain("</yuki_behavior>");
    expect(request.systemPrompt).not.toMatch(/<your_schedule>[\s\S]*(Current local schedule time|currently busy|currently inside sleep time)[\s\S]*<\/your_schedule>/);
    expect(request.systemPrompt).not.toMatch(
      /<environment_instructions>[\s\S]*Write exactly one short phrase[\s\S]*<\/environment_instructions>/
    );
    expect(request.systemPrompt).not.toMatch(
      /<environment_instructions>[\s\S]*Use only listed server emojis[\s\S]*<\/environment_instructions>/
    );
    if (request.systemPrompt.includes("<memories>")) {
      expect(request.systemPrompt).toMatch(
        /<\/behavior>\n<memories>\n- Yuki remembers Kevin likes tea\.\n<\/memories>\n<server_emojis>/
      );
      expect(request.systemPrompt).not.toMatch(/<behavior>[\s\S]*<memories>[\s\S]*<\/behavior>/);
    }
    expect(request.systemPrompt).toMatch(
      /<\/behavior>(?:\n<memories>[\s\S]*<\/memories>)?\n<server_emojis>[\s\S]*<\/server_emojis>\n<current_time>\n\d{4}-\d{2}-\d{2}T\d{2}\n<\/current_time>/
    );
    expect(request.sceneDirection).toBe("answer Kevin");
    return { content: "hello <@Kevin> <:cutecat:>" };
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    expect(request.systemPrompt).toContain("decide");
    expect(request.systemPrompt).not.toMatch(/<active_waifus>\n[\s\S]*<\/active_waifus>/);
    expect(request.systemPrompt).not.toMatch(/<task_instructions>\n[\s\S]*<\/task_instructions>/);
    expect(request.systemPrompt).not.toMatch(/<current_time>\n[\s\S]*<\/current_time>/);
    expect(request.systemPrompt).toContain("do not default to no_reply");
    expect(request.systemPrompt).toContain("Prefer a two-waifu chain");
    expect(request.systemPrompt).toContain("0 to 30");
    expect(request.trailingPrompt).toBeTruthy();
    expect(request.trailingPrompt).toMatch(/<task_instructions>\n[\s\S]*<\/task_instructions>/);
    expect(request.trailingPrompt).toMatch(
      /<active_waifus>\n<yuki>\nID: yuki\nDisplay name: Yuki\nPersona:\nkind\nAvailability:\n[\s\S]*Sleep: 23:00-07:00 daily[\s\S]*Busy:[\s\S]*09:00-10:00: school focus block[\s\S]*<\/yuki>\n<\/active_waifus>/
    );
    expect(request.trailingPrompt).toMatch(/<current_time>\n[\s\S]*<\/current_time>/);
    expect(request.availableWaifuIds).toEqual(["yuki"]);
    const decision = this.decisions.shift();
    if (!decision) throw new Error("No fake decision left.");
    return decision;
  }
}

describe("RuntimeOrchestrator", () => {
  it("clips sceneDirection before sending it to the waifu model", () => {
    expect(clipSceneDirectionForWaifu("answer Kevin, then ask Mira")).toBe("answer Kevin");
    expect(clipSceneDirectionForWaifu("answer Kevin and ask Mira")).toBe("answer Kevin");
    expect(clipSceneDirectionForWaifu("answer Kevin or ask Mira")).toBe("answer Kevin");
    expect(clipSceneDirectionForWaifu("answer candy or ask Mira")).toBe("answer candy");
    expect(clipSceneDirectionForWaifu("or ask Mira")).toBeUndefined();
  });

  it("runs orchestrator -> waifu -> orchestrator and persists history/session", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const pipeline = new FakePipeline();

    await seedRuntimeConfig(storage);
    const now = new Date().toISOString();
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "memory-1",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Yuki remembers Kevin likes tea.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m1"],
              status: "active"
            }
          ]
        })
      )
    );

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
    expect(
      history.decisions.map((entry) => ({
        action: entry.action,
        ids: entry.respondingWaifus.map((responder) => responder.waifuId),
        status: entry.status,
        waifuMessageCount: entry.waifuMessageIds.length
      }))
    ).toEqual([
      { action: "no_reply", ids: [], status: "completed", waifuMessageCount: 0 },
      { action: "reply", ids: ["yuki"], status: "completed", waifuMessageCount: 1 }
    ]);

    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.guildId).toBe("guild-1");
  });

  it("adds OCR text before non-vision model calls", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const imageMessage = imageContextMessage();
    discord.contexts = [[imageMessage], [imageMessage]];
    await seedRuntimeConfig(storage);
    await setPrimaryRuntimeModel(storage, "deepseek", "deepseek-v4-pro");

    let orchestratorMessages: ContextMessage[] = [];
    let waifuMessages: ContextMessage[] = [];
    const ocr = {
      enrichMessages: vi.fn(async (messages: ContextMessage[]) =>
        messages.map((message) => ({
          ...message,
          images: message.images?.map((image) => ({ ...image, ocrText: "Start chatting with Instant" }))
        }))
      )
    };
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        orchestratorMessages = request.messages;
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "image text is useful"
        };
      },
      async generateWaifu(request) {
        waifuMessages = request.messages;
        return { content: "Got it." };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      ocr,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(ocr.enrichMessages).toHaveBeenCalledTimes(2);
    expect(orchestratorMessages[0].images?.[0].ocrText).toBe("Start chatting with Instant");
    expect(waifuMessages[0].images?.[0].ocrText).toBe("Start chatting with Instant");
    expect(discord.sent[0].content).toBe("Got it.");
  });

  it("skips OCR for vision-capable model calls", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const imageMessage = imageContextMessage();
    discord.contexts = [[imageMessage], [imageMessage]];
    await seedRuntimeConfig(storage);

    const ocr = {
      enrichMessages: vi.fn(async (messages: ContextMessage[]) => messages)
    };
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "openai can see images"
        };
      },
      async generateWaifu() {
        return { content: "Seen." };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      ocr,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(ocr.enrichMessages).not.toHaveBeenCalled();
    expect(discord.sent[0].content).toBe("Seen.");
  });

  it("continues without OCR text when OCR enrichment fails", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const imageMessage = imageContextMessage();
    discord.contexts = [[imageMessage], [imageMessage]];
    await seedRuntimeConfig(storage);
    await setPrimaryRuntimeModel(storage, "deepseek", "deepseek-v4-pro");

    const warn = vi.fn();
    let waifuMessages: ContextMessage[] = [];
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "continue"
        };
      },
      async generateWaifu(request) {
        waifuMessages = request.messages;
        return { content: "Still works." };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      ocr: {
        enrichMessages: vi.fn(async () => {
          throw new Error("ocr unavailable");
        })
      },
      createPipeline: () => pipeline,
      logger: {
        ...quietLogger(),
        warn
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(waifuMessages[0].images?.[0].ocrText).toBeUndefined();
    expect(discord.sent[0].content).toBe("Still works.");
    expect(warn).toHaveBeenCalledWith(
      "OCR enrichment failed; continuing without OCR text",
      expect.objectContaining({ modelId: "deepseek-v4-pro" })
    );
  });

  it("lets PickNextWaifu hand off once before orchestration resumes", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hello")],
      [contextMessage("m1", "user", "Kevin", "hello")],
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("yuki-message", "waifu", "Yuki", "mika should take this")
      ],
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("yuki-message", "waifu", "Yuki", "mika should take this"),
        contextMessage("mika-message", "waifu", "Mika", "got it")
      ]
    ];

    await seedRuntimeConfig(storage);
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
            enabledWaifuIds: ["yuki", "mika"]
          }
        }
      })
    );
    await storage.writeJson(
      "waifu:mika",
      "user/waifus/mika/waifu.json",
      WaifuConfigSchema,
      WaifuConfigSchema.parse({
        ...createRevisionedBase(),
        id: "mika",
        name: "Mika",
        displayName: "Mika",
        enabled: true,
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        botId: "mika-bot",
        persona: "direct",
        contextWindow: 50
      })
    );

    class HandoffPipeline implements ModelPipeline {
      events: string[] = [];
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "Yuki starts."
        },
        {
          action: "no_reply",
          respondingWaifus: [],
          retriggerAfterSeconds: 180,
          reasoning: "Done after Mika."
        }
      ];

      async generateWaifu(request: WaifuGenerationRequest) {
        if (request.systemPrompt.includes("You are Yuki")) {
          this.events.push("waifu:yuki");
          expect(request.availableWaifuIds).toEqual(["mika"]);
          expect(request.pickNextWaifuToolEnabled).toBe(true);
          expect(request.systemPrompt).toContain("<tool_use>");
          return { content: "mika should take this", pickedNextWaifuId: "mika" };
        }
        this.events.push("waifu:mika");
        expect(request.replyStyle).toBe("normal");
        return { content: "got it" };
      }

      async decideOrchestrator() {
        this.events.push("orchestrator");
        const decision = this.decisions.shift();
        if (!decision) throw new Error("No fake decision left.");
        return decision;
      }
    }

    const pipeline = new HandoffPipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
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

    expect(pipeline.events).toEqual(["orchestrator", "waifu:yuki", "waifu:mika", "orchestrator"]);
    expect(discord.sent.map((entry) => ({ content: entry.content, senderBotId: entry.senderBotId }))).toEqual([
      { content: "mika should take this", senderBotId: "yuki-bot" },
      { content: "got it", senderBotId: "mika-bot" }
    ]);
  });

  it("logs invalid PickNextWaifu calls, sends the normal message, and returns to orchestration", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

    await seedRuntimeConfig(storage);

    class InvalidPickPipeline implements ModelPipeline {
      events: string[] = [];
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "Yuki starts."
        },
        {
          action: "no_reply",
          respondingWaifus: [],
          retriggerAfterSeconds: 180,
          reasoning: "Back to orchestrator."
        }
      ];

      async generateWaifu() {
        this.events.push("waifu:yuki");
        return {
          content: "still a normal reply",
          rejectedPickNextWaifu: {
            reason: "unavailable_waifu" as const,
            waifuId: "yuki"
          }
        };
      }

      async decideOrchestrator() {
        this.events.push("orchestrator");
        const decision = this.decisions.shift();
        if (!decision) throw new Error("No fake decision left.");
        return decision;
      }
    }

    const pipeline = new InvalidPickPipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 2,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message, meta) => warnings.push({ message, meta }),
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(pipeline.events).toEqual(["orchestrator", "waifu:yuki", "orchestrator"]);
    expect(discord.sent.map((entry) => entry.content)).toEqual(["still a normal reply"]);
    expect(warnings).toContainEqual({
      message: "Ignoring invalid PickNextWaifu call from waifu",
      meta: expect.objectContaining({
        waifuId: "yuki",
        attemptedWaifuId: "yuki",
        attemptedSelfPick: true,
        reason: "unavailable_waifu"
      })
    });
  });

  it("caps orchestrator waifu delay seconds at 30 before waiting and recording history", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("w1", "waifu", "Yuki", "still here")]];
    const sleepCalls: number[] = [];

    await seedRuntimeConfig(storage);

    class DelayCapPipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 45, replyStyle: "normal" }],
          reasoning: "Delay too high."
        },
        {
          action: "no_reply",
          respondingWaifus: [],
          retriggerAfterSeconds: 180,
          reasoning: "Done."
        }
      ];

      async generateWaifu() {
        return { content: "delayed hello" };
      }

      async decideOrchestrator() {
        const decision = this.decisions.shift();
        if (!decision) throw new Error("No fake decision left.");
        return decision;
      }
    }

    const pipeline = new DelayCapPipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      storage,
      discord,
      maxAutomaticTurns: 2,
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

    expect(sleepCalls[0]).toBe(30_000);
    const history = await storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema
    );
    expect(history.decisions.find((entry) => entry.action === "reply")?.respondingWaifus[0].delaySeconds).toBe(30);
  });

  it("ignores the first waifu delay and counts later delays from decision time when recent context has a user", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("old-waifu", "waifu", "Yuki", "old beat"),
        contextMessage("user-1", "user", "Kevin", "jumping in"),
        contextMessage("waifu-2", "waifu", "Yuki", "reaction"),
        contextMessage("waifu-3", "waifu", "Mika", "another reaction")
      ]
    ];
    const sleepCalls: number[] = [];
    let nowMs = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await seedWaifu(storage, "aria", "Aria", "aria-bot", "dry");
    await enableWaifus(storage, ["yuki", "mika", "aria"]);

    class RecentUserDelayPipeline implements ModelPipeline {
      events: string[] = [];

      async decideOrchestrator() {
        return {
          action: "reply" as const,
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 12, replyStyle: "normal" as const },
            { waifuId: "mika", delaySeconds: 5, replyStyle: "normal" as const },
            { waifuId: "aria", delaySeconds: 9, replyStyle: "normal" as const }
          ],
          reasoning: "Recent user activity should make the chain feel immediate."
        };
      }

      async generateWaifu(request: WaifuGenerationRequest) {
        if (request.systemPrompt.includes("You are Yuki")) {
          this.events.push("yuki");
          nowMs = 107_000;
          return { content: "one" };
        }
        if (request.systemPrompt.includes("You are Mika")) {
          this.events.push("mika");
          return { content: "two" };
        }
        this.events.push("aria");
        return { content: "three" };
      }
    }

    const pipeline = new RecentUserDelayPipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async (ms) => {
        sleepCalls.push(ms);
        nowMs += ms;
      },
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

    expect(pipeline.events).toEqual(["yuki", "mika", "aria"]);
    expect(sleepCalls).toEqual([2000]);
    expect(discord.sent.map((entry) => entry.content)).toEqual(["one", "two", "three"]);
  });

  it("keeps sequential waifu delays when the latest four messages have no user", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("waifu-1", "waifu", "Yuki", "one"),
        contextMessage("waifu-2", "waifu", "Mika", "two"),
        contextMessage("waifu-3", "waifu", "Yuki", "three"),
        contextMessage("waifu-4", "waifu", "Mika", "four")
      ]
    ];
    const sleepCalls: number[] = [];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);

    class SequentialDelayPipeline implements ModelPipeline {
      async decideOrchestrator() {
        return {
          action: "reply" as const,
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 3, replyStyle: "normal" as const },
            { waifuId: "mika", delaySeconds: 4, replyStyle: "normal" as const }
          ],
          reasoning: "No recent user message, so use the normal chained pacing."
        };
      }

      async generateWaifu(request: WaifuGenerationRequest) {
        return { content: request.systemPrompt.includes("You are Yuki") ? "one" : "two" };
      }
    }

    const runtime = new RuntimeOrchestrator({
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => new SequentialDelayPipeline(),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(sleepCalls).toEqual([3000, 4000]);
    expect(discord.sent.map((entry) => entry.content)).toEqual(["one", "two"]);
  });

  it("passes completed past orchestrator decisions to the pipeline", async () => {
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
      capturedDecisions: ProviderRequest["pastDecisions"] = [];

      async generateWaifu() {
        return { content: "unused" };
      }

      async decideOrchestrator(request: ProviderRequest) {
        this.capturedDecisions = request.pastDecisions ?? [];
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" };
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
              action: "no_reply",
              respondingWaifus: [],
              retriggerAfterSeconds: 300,
              reasoning: "before latest user message",
              createdAt: "2026-05-16T12:09:00.000Z"
            },
            {
              id: "after-latest-chat",
              guildId: "guild-1",
              channelId: "channel-1",
              action: "no_reply",
              respondingWaifus: [],
              retriggerAfterSeconds: 1800,
              reasoning: "after latest user message",
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

    expect(pipeline.capturedDecisions?.map((d) => d.id).sort()).toEqual(
      ["after-latest-chat", "before-latest-chat"].sort()
    );
    for (const decision of pipeline.capturedDecisions ?? []) {
      expect(decision.status).toBe("completed");
    }
  });

  it("heals leftover pending decisions to interrupted on startup", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "orchestrator:history",
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(
        createEmptyRevisionedFile({
          decisions: [
            {
              id: "leftover-pending",
              guildId: "guild-1",
              channelId: "channel-1",
              action: "reply",
              respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
              reasoning: "leftover",
              status: "pending",
              waifuMessageIds: [],
              createdAt: "2026-05-16T12:05:00.000Z"
            }
          ]
        })
      )
    );

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 0,
      createPipeline: () => ({ generateWaifu: async () => ({ content: "" }) } as ModelPipeline),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    await runtime.start();
    await runtime.stop();

    const history = await storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema
    );
    expect(history.decisions.find((entry) => entry.id === "leftover-pending")?.status).toBe("interrupted");
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
        expect(request.memories).toEqual([]);
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        return [
          {
            tool: "add_memory",
            memory: {
              waifuId: "yuki",
              content: "Kevin likes tea.",
              importance: 3
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
    expect(memories.memories[0]).toMatchObject({
      scope: "guild",
      guildId: "guild-1",
      sourceMessageIds: []
    });
    expect(discord.sent).toEqual([]);

    const history = await storage.readJson(
      "user/stage-manager/history.json",
      StageManagerHistoryFileSchema
    );
    expect(history.edits[0].tool).toBe("add_memory");
  });

  it("skips stage-manager memory writes for user names in waifuId", async () => {
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
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        return [
          {
            tool: "add_memory",
            memory: {
              waifuId: "K",
              content: "K is a user, not a waifu.",
              importance: 3
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
    expect(memories.memories).toEqual([]);
    const history = await storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema);
    expect(history.edits[0]).toMatchObject({
      tool: "add_memory",
      affectedMemoryIds: [],
      summary: "Skipped invalid waifu id K"
    });
  });

  it("keeps stage-manager memory input and edits inside the current guild", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();

    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "same-guild",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin likes tea.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m1"],
              status: "active"
            },
            {
              id: "same-guild-archived",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Old archived note.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m0"],
              status: "archived"
            },
            {
              id: "other-guild",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-2",
              content: "Other guild secret.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m2"],
              status: "active"
            }
          ]
        })
      )
    );

    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManager(request: StageManagerRequest) {
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        expect(request.memories).toEqual([
          {
            memoryIndex: 1,
            waifuId: "yuki",
            content: "Kevin likes tea.",
            importance: 3
          }
        ]);
        return [
          { tool: "update_memory", memoryIndex: 2, patch: { content: "leaked update" } },
          { tool: "archive_memory", memoryIndex: 1 },
          {
            tool: "add_memory",
            memory: {
              waifuId: "yuki",
              content: "Guild one only.",
              importance: 3
            }
          }
        ];
      }
    };

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
    expect(memories.memories.find((memory) => memory.id === "other-guild")).toMatchObject({
      guildId: "guild-2",
      content: "Other guild secret.",
      status: "active"
    });
    expect(memories.memories.find((memory) => memory.id === "same-guild")?.status).toBe("archived");
    expect(memories.memories.find((memory) => memory.content === "Guild one only.")).toMatchObject({
      guildId: "guild-1",
      scope: "guild"
    });
  });

  it("merges stage-manager memories by memory index", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();

    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "first",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin likes tea.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m1"],
              status: "active"
            },
            {
              id: "second",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin likes green tea.",
              importance: 4,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m2"],
              status: "active"
            }
          ]
        })
      )
    );

    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManager(request: StageManagerRequest) {
        expect(request.memories).toEqual([
          {
            memoryIndex: 1,
            waifuId: "yuki",
            content: "Kevin likes tea.",
            importance: 3
          },
          {
            memoryIndex: 2,
            waifuId: "yuki",
            content: "Kevin likes green tea.",
            importance: 4
          }
        ]);
        return [
          {
            tool: "merge_memories",
            sourceMemoryIndices: [1, 2],
            mergedContent: "Kevin likes tea, especially green tea."
          }
        ];
      }
    };

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
    expect(memories.memories.find((memory) => memory.id === "first")?.status).toBe("archived");
    expect(memories.memories.find((memory) => memory.id === "second")?.status).toBe("archived");
    expect(memories.memories.find((memory) => memory.content === "Kevin likes tea, especially green tea.")).toMatchObject({
      waifuId: "yuki",
      guildId: "guild-1",
      sourceMessageIds: ["m1", "m2"],
      status: "active"
    });
  });

  it("hides cross-guild memories from waifu prompts", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();

    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "same",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin likes tea.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m1"],
              status: "active"
            },
            {
              id: "cross",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-2",
              content: "Kevin hates tea.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: ["m2"],
              status: "active"
            }
          ]
        })
      )
    );

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "reply"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        expect(request.systemPrompt).toContain("Kevin likes tea.");
        expect(request.systemPrompt).not.toContain("Kevin hates tea.");
        return { content: "noted" };
      }
    };

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
  });

  it("schedules stage-manager runs after activity and once after silence", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let stageCalls = 0;
    const stageWaiters: Array<() => void> = [];
    const waitForStageCalls = (count: number) => {
      if (stageCalls >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stageWaiters.push(() => {
          if (stageCalls >= count) resolve();
        });
      });
    };

    await seedRuntimeConfig(storage);
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 7200, reasoning: "wait" };
      },
      async decideStageManager() {
        stageCalls += 1;
        for (const waiter of stageWaiters) waiter();
        return [{ tool: "no_change", reason: "none" }];
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      stageManagerActiveIntervalMs: 80,
      stageManagerIdleDelayMs: 180,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-1",
      authorId: "u1",
      authorBot: false
    });
    expect(stageCalls).toBe(0);

    await waitForStageCalls(1);
    expect(stageCalls).toBe(1);

    await waitForStageCalls(2);
    expect(stageCalls).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(stageCalls).toBe(2);
    await runtime.stop();
  });

  it("keeps the five-minute stage-manager cadence while activity continues", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let stageCalls = 0;
    const stageWaiters: Array<() => void> = [];
    const waitForStageCalls = (count: number) => {
      if (stageCalls >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stageWaiters.push(() => {
          if (stageCalls >= count) resolve();
        });
      });
    };

    await seedRuntimeConfig(storage);
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 7200, reasoning: "wait" };
      },
      async decideStageManager() {
        stageCalls += 1;
        for (const waiter of stageWaiters) waiter();
        return [{ tool: "no_change", reason: "none" }];
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      stageManagerActiveIntervalMs: 100,
      stageManagerIdleDelayMs: 300,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-1",
      authorId: "u1",
      authorBot: false
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-2",
      authorId: "u1",
      authorBot: false
    });

    await waitForStageCalls(1);
    expect(stageCalls).toBe(1);
    await waitForStageCalls(2);
    expect(stageCalls).toBe(2);
    await runtime.stop();
  });

  it("does not schedule stage-manager work for inactive channels and clears timers on pause", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let stageCalls = 0;

    await seedRuntimeConfig(storage);
    await enableWaifus(storage, []);
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManager() {
        stageCalls += 1;
        return [{ tool: "no_change", reason: "none" }];
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      stageManagerActiveIntervalMs: 50,
      stageManagerIdleDelayMs: 100,
      createPipeline: () => pipeline,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "inactive",
      authorId: "u1",
      authorBot: false
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stageCalls).toBe(0);

    await enableWaifus(storage, ["yuki"]);
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "active",
      authorId: "u1",
      authorBot: false
    });
    await runtime.pause();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(stageCalls).toBe(0);
  });

  it("responds to /memories ephemerally without sending a public channel message", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManager() {
        return [
          {
            tool: "add_memory",
            memory: {
              waifuId: "yuki",
              content: "Kevin likes tea.",
              importance: 3
            }
          }
        ];
      }
    };

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
    let resolveResponded: () => void = () => undefined;
    const responded = new Promise<void>((resolve) => {
      resolveResponded = resolve;
    });
    await discord.emitMemoriesCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "memory-user",
      respond: async (content) => {
        responses.push(content);
        resolveResponded();
      }
    });
    await Promise.race([
      responded,
      new Promise((_, reject) => setTimeout(() => reject(new Error("memories command did not respond")), 1000))
    ]);
    await runtime.stop();

    expect(responses).toEqual(["Stage manager updated memories."]);
    expect(discord.sent).toEqual([]);
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
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "post-review" };
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
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "unused" };
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
    let orchestratorCalls = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "manual reply" };
      },
      async decideOrchestrator(request) {
        orchestratorCalls += 1;
        if (orchestratorCalls === 1) {
          expect(request.replyRequired).toBe(true);
          resolveOrchestrated();
          return {
            action: "reply",
            respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
            reasoning: "manual run reply"
          };
        }
        expect(request.replyRequired).toBeFalsy();
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "manual run complete" };
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

  it("runs a selected waifu first from /run, preserves scene direction and handoffs, then resumes orchestration", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hello")],
      [contextMessage("m1", "user", "Kevin", "hello")],
      [contextMessage("m2", "waifu", "Mika", "mika first")],
      [contextMessage("m3", "waifu", "Yuki", "yuki next")]
    ];

    let resolveOrchestrated: () => void = () => undefined;
    const orchestrated = new Promise<void>((resolve) => {
      resolveOrchestrated = resolve;
    });
    const waifuCalls: string[] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu(request) {
        if (request.systemPrompt.includes("You are Mika")) {
          waifuCalls.push("mika");
          expect(request.sceneDirection).toBe("start topic");
          return { content: "mika first", pickedNextWaifuId: "yuki" };
        }
        waifuCalls.push("yuki");
        expect(request.sceneDirection).toBeUndefined();
        return { content: "yuki next" };
      },
      async decideOrchestrator(request) {
        expect(request.replyRequired).toBeFalsy();
        resolveOrchestrated();
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "after directed run" };
      }
    };

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "bold");
    await enableWaifus(storage, ["yuki", "mika"]);

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
      waifuId: "Mika",
      sceneDirection: "start topic",
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
        new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator did not resume")), 1000))
      ])
    ]);
    await runtime.stop();

    expect(responses).toEqual(["Started directed run for Mika."]);
    expect(waifuCalls).toEqual(["mika", "yuki"]);
    expect(discord.sent.map((message) => message.content)).toEqual(["mika first", "yuki next"]);
    expect(discord.sent.map((message) => message.senderBotId)).toEqual(["mika-bot", "yuki-bot"]);
  });

  it("rejects scene direction on /run without a selected waifu", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        throw new Error("orchestrator should not run");
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
    await discord.emitRunCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "runner-user",
      sceneDirection: "start topic",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await runtime.stop();

    expect(responses).toEqual(["scene_direction requires a waifu option."]);
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
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "active run complete" };
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

  it("stops an in-flight waifu generation from /stop", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];

    let resolveWaifuEntered: () => void = () => undefined;
    const waifuEntered = new Promise<void>((resolve) => {
      resolveWaifuEntered = resolve;
    });
    let waifuAborted = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal" }],
          reasoning: "Start waifu."
        };
      },
      async generateWaifu(request) {
        resolveWaifuEntered();
        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              waifuAborted = true;
              reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
            },
            { once: true }
          );
        });
        return { content: "should not send" };
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

    const running = runtime.triggerChannel("guild-1", "channel-1", "test-stop-waifu");
    await Promise.race([
      waifuEntered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("waifu did not enter")), 1000))
    ]);

    const responses: string[] = [];
    await discord.emitStopCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "stop-user",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await running;
    await runtime.stop();

    expect(responses).toEqual(["Stopped orchestrator and waifu work in this channel."]);
    expect(waifuAborted).toBe(true);
    expect(discord.sent).toEqual([]);
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
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "review complete" };
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "Reply to Kevin."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
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

  it("sends a multi-chunk reply in full as one waifu turn", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    class FullChunkPipeline implements ModelPipeline {
      generateCalls = 0;
      decisionCalls = 0;
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [
            {
              waifuId: "yuki",
              delaySeconds: 0,
              replyStyle: "normal",
              sceneDirection: "answer",
              replyToMessageId: "m1"
            }
          ],
          reasoning: "Reply to Kevin."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
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

    const pipeline = new FullChunkPipeline();
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 2,
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

    expect(discord.sent.map((entry) => entry.content)).toEqual([
      "One.",
      "Two.",
      "This third chunk is too long.",
      "Four."
    ]);
    expect(pipeline.generateCalls).toBe(1);
    expect(pipeline.decisionCalls).toBe(2);
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal", sceneDirection: "answer older", replyToMessageId: "m1" }],
          reasoning: "Reply to the older message."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "respond"
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, replyStyle: "normal", sceneDirection: "answer", replyToMessageId: "m1" }],
          reasoning: "respond"
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
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
          },
          deepseek: {
            providerId: "deepseek",
            apiKey: "deepseek-test",
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
      contextWindow: 50,
      availability: {
        sleep: { enabled: true, start: "23:00", end: "07:00" },
        busy: [
          { start: "09:00", end: "10:00", reason: "school focus block" }
        ]
      },
      tools: {
        toolUse: true,
        pickNextWaifu: true
      }
    })
  );
}

async function setPrimaryRuntimeModel(
  storage: StorageService,
  providerId: "openai" | "deepseek",
  modelId: string
) {
  await storage.writeJson(
    "orchestrator",
    "user/orchestrator/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: true,
      providerId,
      modelId,
      contextWindow: 20,
      prompt: "decide"
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
      providerId,
      modelId,
      botId: "yuki-bot",
      persona: "kind",
      contextWindow: 50,
      availability: {
        sleep: { enabled: true, start: "23:00", end: "07:00" },
        busy: []
      },
      tools: {
        toolUse: true,
        pickNextWaifu: true
      }
    })
  );
}

async function enableWaifus(storage: StorageService, waifuIds: string[]) {
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
          enabledWaifuIds: waifuIds
        }
      }
    })
  );
}

async function seedWaifu(
  storage: StorageService,
  id: string,
  displayName: string,
  botId: string,
  persona: string
) {
  await storage.writeJson(
    `waifu:${id}`,
    `user/waifus/${id}/waifu.json`,
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id,
      name: displayName,
      displayName,
      enabled: true,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      botId,
      persona,
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

function imageContextMessage(): ContextMessage {
  return {
    ...contextMessage("m1", "user", "Kevin", "look at this"),
    images: [{ url: "https://cdn.example/screenshot.png", contentType: "image/png" }]
  };
}

function quietLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
