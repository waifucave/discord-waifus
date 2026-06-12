import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator, currentlyDoingForWaifu } from "../src/orchestration/runtime.js";
import { ContextMessage } from "../src/orchestration/context.js";
import { OrchestratorDecision, RETRIGGER_MAX_SECONDS } from "../src/orchestration/decisions.js";
import {
  DiscordGatewayFacade,
  DiscordClearCommandEvent,
  DiscordClearCommandListener,
  DiscordDebugCommandEvent,
  DiscordDebugCommandListener,
  DiscordMemoriesCommandEvent,
  DiscordMemoriesCommandListener,
  DiscordPrintCommandEvent,
  DiscordPrintCommandListener,
  DiscordPrintWaifuAutocompleteEvent,
  DiscordPrintWaifuAutocompleteListener,
  DiscordReviewCommandEvent,
  DiscordReviewCommandListener,
  DiscordRunCommandEvent,
  DiscordRunCommandListener,
  DiscordRunWaifuAutocompleteEvent,
  DiscordRunWaifuAutocompleteListener,
  DiscordStopCommandEvent,
  DiscordStopCommandListener,
  DiscordRuntimeStatus
} from "../src/discord/client.js";
import {
  ModelPipeline,
  PipelineCredentials,
  ProviderRequest,
  StageManagerObserveRequest,
  StageManagerRequest,
  WaifuGenerationRequest
} from "../src/providers/types.js";
import { ProviderPipelineError } from "../src/providers/pipelines.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import {
  ActiveChatParticipantsFileSchema,
  AgentConfigSchema,
  GuildMembersFileSchema,
  MemoryStoreSchema,
  OrchestratorDebugConfigFileSchema,
  OrchestratorHistoryFileSchema,
  ProviderCredentialsFileSchema,
  ReviewerHistoryFileSchema,
  ServerConfigSchema,
  ShortTermMemoryStoreSchema,
  StageManagerHistoryFileSchema,
  WaifuConfig,
  WaifuConfigSchema,
  createEmptyRevisionedFile,
  defaultWaifuPromptLayout
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
  deletedAll: Array<{
    guildId: string;
    channelId: string;
  }> = [];
  deleteAllResult = {
    scannedMessageCount: 0,
    deletedCount: 0,
    failedCount: 0,
    failedMessageIds: [] as Array<{ messageId: string; message: string }>
  };
  debugMessages: Array<{ channelId: string; content: string }> = [];
  debugChannelInfo = new Map<string, { channelId: string; guildId?: string; name?: string }>();
  guilds: Array<{ guildId: string; name: string }> = [];
  channelMetadata = new Map<
    string,
    { guildId: string; guildName?: string; channelId: string; channelName?: string }
  >();
  channelMetadataCalls: Array<{ guildId: string; channelId: string }> = [];
  reviewListeners = new Set<DiscordReviewCommandListener>();
  clearListeners = new Set<DiscordClearCommandListener>();
  runListeners = new Set<DiscordRunCommandListener>();
  runWaifuAutocompleteListeners = new Set<DiscordRunWaifuAutocompleteListener>();
  stopListeners = new Set<DiscordStopCommandListener>();
  memoriesListeners = new Set<DiscordMemoriesCommandListener>();
  printListeners = new Set<DiscordPrintCommandListener>();
  printWaifuAutocompleteListeners = new Set<DiscordPrintWaifuAutocompleteListener>();
  debugListeners = new Set<DiscordDebugCommandListener>();
  contexts: ContextMessage[][] = [
    [contextMessage("m1", "user", "Kevin", "hello")],
    [contextMessage("m1", "user", "Kevin", "hello")],
    [contextMessage("m2", "waifu", "Yuki", "hi")]
  ];

  async connect(): Promise<DiscordRuntimeStatus> {
    return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
  }

  async disconnect(): Promise<void> {}

  async listGuilds() {
    return this.guilds;
  }

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

  onRunWaifuAutocomplete(listener: DiscordRunWaifuAutocompleteListener): () => void {
    this.runWaifuAutocompleteListeners.add(listener);
    return () => this.runWaifuAutocompleteListeners.delete(listener);
  }

  onStopCommand(listener: DiscordStopCommandListener): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  onMemoriesCommand(listener: DiscordMemoriesCommandListener): () => void {
    this.memoriesListeners.add(listener);
    return () => this.memoriesListeners.delete(listener);
  }

  onPrintCommand(listener: DiscordPrintCommandListener): () => void {
    this.printListeners.add(listener);
    return () => this.printListeners.delete(listener);
  }

  onPrintWaifuAutocomplete(listener: DiscordPrintWaifuAutocompleteListener): () => void {
    this.printWaifuAutocompleteListeners.add(listener);
    return () => this.printWaifuAutocompleteListeners.delete(listener);
  }

  onDebugCommand(listener: DiscordDebugCommandListener): () => void {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
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

  async emitRunWaifuAutocomplete(
    event: Omit<DiscordRunWaifuAutocompleteEvent, "respond"> & {
      respond?: DiscordRunWaifuAutocompleteEvent["respond"];
    }
  ): Promise<void> {
    await Promise.all(
      [...this.runWaifuAutocompleteListeners].map((listener) =>
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

  async emitPrintCommand(
    event: Omit<DiscordPrintCommandEvent, "respond"> & { respond?: DiscordPrintCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.printListeners].map((listener) =>
        listener({
          ...event,
          respond: event.respond ?? (async () => undefined)
        })
      )
    );
  }

  async emitPrintWaifuAutocomplete(
    event: Omit<DiscordPrintWaifuAutocompleteEvent, "respond"> & {
      respond?: DiscordPrintWaifuAutocompleteEvent["respond"];
    }
  ): Promise<void> {
    await Promise.all(
      [...this.printWaifuAutocompleteListeners].map((listener) =>
        listener({
          ...event,
          respond: event.respond ?? (async () => undefined)
        })
      )
    );
  }

  async emitDebugCommand(
    event: Omit<DiscordDebugCommandEvent, "respond"> & { respond?: DiscordDebugCommandEvent["respond"] }
  ): Promise<void> {
    await Promise.all(
      [...this.debugListeners].map((listener) =>
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

  async validateDebugChannel(input: { channelId: string }) {
    return this.debugChannelInfo.get(input.channelId) ?? { channelId: input.channelId };
  }

  async fetchChannelMetadata(input: { guildId: string; channelId: string }) {
    this.channelMetadataCalls.push(input);
    return (
      this.channelMetadata.get(`${input.guildId}:${input.channelId}`) ?? {
        guildId: input.guildId,
        channelId: input.channelId
      }
    );
  }

  async sendDebugMessage(input: { channelId: string; content: string }): Promise<{ messageId: string }> {
    this.debugMessages.push(input);
    return { messageId: `debug-${this.debugMessages.length}` };
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

  async deleteAllMessages(input: {
    guildId: string;
    channelId: string;
  }) {
    this.deletedAll.push(input);
    return this.deleteAllResult;
  }
}

class FakePipeline implements ModelPipeline {
  decisions: OrchestratorDecision[] = [
    {
      action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer Kevin, then pull in Mira" }, replyToMessageId: "m1" }],
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
    // W2 block structure assertions
    expect(request.systemPrompt).toContain("You are Yuki");
    // identity block: W2 format with roster
    expect(request.systemPrompt).toMatch(
      /^<yuki_identity>\nYou are Yuki, chatting in a live Discord text channel[\s\S]*<\/yuki_identity>/
    );
    // persona block: raw persona (no "You are X. Stay in character." prefix)
    expect(request.systemPrompt).toMatch(/<yuki_persona>\nkind\n<\/yuki_persona>/);
    // schedule block: renamed from _shedule to _schedule
    expect(request.systemPrompt).toMatch(
      /<yuki_schedule>[\s\S]*configured routine[\s\S]*changes only when your schedule is edited[\s\S]*Sleep: 23:00-07:00 daily[\s\S]*09:00-10:00: school focus block[\s\S]*<\/yuki_schedule>/
    );
    expect(request.systemPrompt).not.toContain("<yuki_shedule>");
    // ioFormat replaces contextStructure + replyTargeting + mentionPolicy
    expect(request.systemPrompt).toMatch(/<io_format>[\s\S]*DisplayName: <body>[\s\S]*<\/io_format>/);
    // outputContract replaces styleConstraints + hardRules + environment + directorNotes
    expect(request.systemPrompt).toMatch(
      /<output_contract>[\s\S]*You are typing into a real Discord chat box[\s\S]*<\/output_contract>/
    );
    expect(request.systemPrompt).toMatch(/<\/output_contract>$/);
    // Old blocks removed
    expect(request.systemPrompt).not.toContain("<yuki_behavior>");
    expect(request.systemPrompt).not.toContain("<context_message_structure>");
    expect(request.systemPrompt).not.toContain("<environment_instructions>");
    expect(request.systemPrompt).not.toContain("<style_constraints>");
    expect(request.systemPrompt).not.toContain("<hard_rules>");
    expect(request.systemPrompt).not.toMatch(/<memories>/);
    expect(request.systemPrompt).not.toMatch(/<short_term_memory>/);
    expect(request.systemPrompt).not.toMatch(/<available_emojis>/);
    expect(request.systemPrompt).not.toMatch(/<server_emojis>/);
    expect(request.systemPrompt).not.toMatch(/<current_time>/);
    // mid: roomInfo combines participants + emojis
    expect(request.midSystemBlock).toBeDefined();
    expect(request.midSystemBlock).toMatch(
      /^<room_info>\n<active_chat_participants>[\s\S]*- Kevin[\s\S]*<\/active_chat_participants>\n<server_emojis>[\s\S]*<\/server_emojis>\n<\/room_info>$/
    );
    expect(request.midSystemBlock).not.toMatch(/<memories>|<relevant_memories>|<yuki_relevant_memories>/);
    expect(request.midSystemBlock).not.toContain("<director_notes>");
    // trailing: memories, then anchor (not full persona duplicate)
    expect(request.trailingSystemBlock).toBeDefined();
    expect(request.trailingSystemBlock).toMatch(
      /<yuki_relevant_memories>\n- Yuki remembers Kevin likes tea\.\n<\/yuki_relevant_memories>/
    );
    expect(request.trailingSystemBlock).toContain("<yuki_anchor>");
    expect(request.trailingSystemBlock).not.toContain("<yuki_persona>");
    expect(request.trailingSystemBlock).toContain(
      expectedDirectorNote("(spotlight) answer Kevin, then pull in Mira")
    );
    return { content: "hello <@Kevin> <:cutecat:>" };
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    // System prompt: identity + rules + chat_message_structure + server info; no trailing-prompt content
    expect(request.systemPrompt).toContain("director");
    expect(request.systemPrompt).not.toMatch(/<active_waifus>\n[\s\S]*<\/active_waifus>/);
    expect(request.systemPrompt).not.toMatch(/<task_instructions>\n[\s\S]*<\/task_instructions>/);
    expect(request.systemPrompt).not.toMatch(/<current_time>\n[\s\S]*<\/current_time>/);
    expect(request.systemPrompt).toContain("<orchestrator_identity>");
    expect(request.systemPrompt).toContain("<orchestrator_rules>");
    expect(request.systemPrompt).not.toContain("<orchestrator_behavior>");
    expect(request.systemPrompt).toContain("<chat_message_structure>");
    expect(request.systemPrompt).not.toContain("<identity>");
    expect(request.systemPrompt).not.toContain("<behavior>");
    expect(request.systemPrompt).not.toContain("<message_structure>");
    // New rules text (not the old verbatim strings)
    expect(request.systemPrompt).toContain("soft signals");
    expect(request.systemPrompt).toContain("respondingWaifus non-empty");
    // Trailing prompt: task_instructions + pause_planning + active_waifus (casting cards) + current_time
    expect(request.trailingPrompt).toBeTruthy();
    expect(request.trailingPrompt).toMatch(/<task_instructions>\n[\s\S]*<\/task_instructions>/);
    expect(request.trailingPrompt).toMatch(/<pause_planning>\n[\s\S]*<\/pause_planning>/);
    expect(request.trailingPrompt).toMatch(
      /<active_waifus>\n<yuki>\nID: yuki · Yuki\nAbout: kind\nNow: [\s\S]*<\/yuki>\n<\/active_waifus>/
    );
    expect(request.trailingPrompt).not.toMatch(/<active_waifus>[\s\S]*Persona:/);
    expect(request.trailingPrompt).toMatch(/<current_time>\n[\s\S]*<\/current_time>/);
    expect(request.availableWaifuIds).toEqual(["yuki"]);
    const decision = this.decisions.shift();
    if (!decision) throw new Error("No fake decision left.");
    return decision;
  }
}

describe("RuntimeOrchestrator", () => {
  describe("currentlyDoingForWaifu", () => {
    const baseWaifu = {
      availability: {
        sleep: { enabled: true, start: "23:00", end: "07:00" },
        busy: [{ start: "09:00", end: "11:00", reason: "university lectures" }]
      }
    } as unknown as WaifuConfig;

    it("returns the busy interval's reason when the local time is inside a busy window", () => {
      const now = new Date(2026, 5, 3, 9, 30, 0);
      expect(currentlyDoingForWaifu(baseWaifu, now)).toBe("university lectures");
    });

    it("returns \"sleepy\" when in the sleep window with no busy match", () => {
      const now = new Date(2026, 5, 3, 23, 30, 0);
      expect(currentlyDoingForWaifu(baseWaifu, now)).toBe("sleepy");
    });

    it("returns undefined when the waifu is free", () => {
      const now = new Date(2026, 5, 3, 14, 0, 0);
      expect(currentlyDoingForWaifu(baseWaifu, now)).toBeUndefined();
    });

    it("prefers busy reason over sleepy on overlap", () => {
      const overlappingWaifu = {
        availability: {
          sleep: { enabled: true, start: "08:00", end: "12:00" },
          busy: [{ start: "09:00", end: "11:00", reason: "morning class" }]
        }
      } as unknown as WaifuConfig;
      const now = new Date(2026, 5, 3, 10, 0, 0);
      expect(currentlyDoingForWaifu(overlappingWaifu, now)).toBe("morning class");
    });

    it("ignores empty busy reasons but still falls through to sleepy", () => {
      const emptyReasonWaifu = {
        availability: {
          sleep: { enabled: true, start: "09:00", end: "11:00" },
          busy: [{ start: "09:00", end: "11:00", reason: "" }]
        }
      } as unknown as WaifuConfig;
      const now = new Date(2026, 5, 3, 10, 0, 0);
      expect(currentlyDoingForWaifu(emptyReasonWaifu, now)).toBe("sleepy");
    });
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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
        tools: {
          pickNextWaifu: true,
          shortTermMemory: true
        },
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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

  it("inserts PickNextWaifu before remaining orchestrator responders without dropping them", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await seedWaifu(storage, "aria", "Aria", "aria-bot", "dry");
    await enableWaifus(storage, ["yuki", "mika", "aria"]);
    await setServerTools(storage, { pickNextWaifu: true });

    const events: string[] = [];
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0 },
            { waifuId: "mika", delaySeconds: 0, directive: { intent: "spotlight", goal: "finish the beat" } }
          ],
          reasoning: "Yuki starts and Mika finishes."
        };
      },
      async generateWaifu(request) {
        if (request.systemPrompt.includes("You are Yuki")) {
          events.push("yuki");
          return { content: "Aria, jump in.", pickedNextWaifuId: "aria" };
        }
        if (request.systemPrompt.includes("You are Aria")) {
          events.push("aria");
          return { content: "I am here." };
        }
        events.push("mika");
        expect(request.trailingSystemBlock).toContain(
          expectedDirectorNote("(spotlight) finish the beat")
        );
        return { content: "Finished." };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(events).toEqual(["yuki", "aria", "mika"]);
    expect(discord.sent.map((message) => message.senderBotId)).toEqual([
      "yuki-bot",
      "aria-bot",
      "mika-bot"
    ]);
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.respondingWaifus.map((responder) => responder.waifuId)).toEqual(["yuki", "mika"]);
    expect(decision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      source: outcome.source,
      handoffFromWaifuId: outcome.handoffFromWaifuId,
      status: outcome.status,
      messageCount: outcome.messageIds.length
    }))).toEqual([
      {
        waifuId: "yuki",
        source: "orchestrator",
        handoffFromWaifuId: undefined,
        status: "sent",
        messageCount: 1
      },
      {
        waifuId: "aria",
        source: "handoff",
        handoffFromWaifuId: "yuki",
        status: "sent",
        messageCount: 1
      },
      {
        waifuId: "mika",
        source: "orchestrator",
        handoffFromWaifuId: undefined,
        status: "sent",
        messageCount: 1
      }
    ]);
  });

  it("moves an already planned PickNextWaifu responder next without duplicating it", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const sleepCalls: number[] = [];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await seedWaifu(storage, "aria", "Aria", "aria-bot", "dry");
    await enableWaifus(storage, ["yuki", "mika", "aria"]);
    await setServerTools(storage, { pickNextWaifu: true });

    const events: string[] = [];
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0 },
            { waifuId: "mika", delaySeconds: 0 },
            {
              waifuId: "aria",
              delaySeconds: 20,
              
              directive: { intent: "spotlight", goal: "keep the planned direction" }
            }
          ],
          reasoning: "Yuki then Mika."
        };
      },
      async generateWaifu(request) {
        if (request.systemPrompt.includes("You are Yuki")) {
          events.push("yuki");
          return { content: "Aria should answer now.", pickedNextWaifuId: "aria" };
        }
        if (request.systemPrompt.includes("You are Aria")) {
          events.push("aria");
          expect(request.trailingSystemBlock).toContain(
            expectedDirectorNote("(spotlight) keep the planned direction")
          );
          return { content: "Right away." };
        }
        events.push("mika");
        return { content: "Still here." };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(events).toEqual(["yuki", "aria", "mika"]);
    expect(sleepCalls).toEqual([]);
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      source: outcome.source,
      handoffFromWaifuId: outcome.handoffFromWaifuId,
      status: outcome.status
    }))).toEqual([
      {
        waifuId: "yuki",
        source: "orchestrator",
        handoffFromWaifuId: undefined,
        status: "sent"
      },
      {
        waifuId: "aria",
        source: "orchestrator",
        handoffFromWaifuId: "yuki",
        status: "sent"
      },
      {
        waifuId: "mika",
        source: "orchestrator",
        handoffFromWaifuId: undefined,
        status: "sent"
      }
    ]);
  });

  it("keeps PickNextWaifu disabled by default at server scope", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki starts."
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        checked = true;
        expect(request.availableWaifuIds).toEqual(["mika"]);
        expect(request.pickNextWaifuToolEnabled).toBe(false);
        expect(request.systemPrompt).not.toContain("PickNextWaifu");
        return { content: "plain reply" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(checked).toBe(true);
  });

  it("does not offer waifus without a linked Discord bot to the orchestrator", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);
    const mika = await storage.readJson("user/waifus/mika/waifu.json", WaifuConfigSchema);
    await storage.writeJson(
      "waifu:mika",
      "user/waifus/mika/waifu.json",
      WaifuConfigSchema,
      WaifuConfigSchema.parse({ ...mika, botId: undefined })
    );

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        checked = true;
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        expect(request.trailingPrompt).toContain("ID: yuki");
        expect(request.trailingPrompt).not.toContain("ID: mika");
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "mika", delaySeconds: 0 },
            { waifuId: "yuki", delaySeconds: 0 }
          ],
          reasoning: "Simulate a provider returning an excluded waifu anyway."
        };
      },
      async generateWaifu() {
        return { content: "available" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(checked).toBe(true);
    expect(discord.sent.map((message) => message.senderBotId)).toEqual(["yuki-bot"]);
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      status: outcome.status,
      reason: outcome.reason
    }))).toEqual([
      { waifuId: "mika", status: "unavailable", reason: "missing_discord_bot" },
      { waifuId: "yuki", status: "sent", reason: undefined }
    ]);
  });

  it("treats the waifu tool-use toggle as prompt-only", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);
    await setServerTools(storage, { pickNextWaifu: true, shortTermMemory: true });
    await setWaifuToolUse(storage, "yuki", false);

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki starts."
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        checked = true;
        expect(request.pickNextWaifuToolEnabled).toBe(true);
        expect(request.shortTermMemoryToolEnabled).toBe(true);
        expect(request.systemPrompt).not.toContain("<tool_use>");
        return { content: "plain reply" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(checked).toBe(true);
  });

  it("honors per-waifu prompt-layout block toggles", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    // Disable the ioFormat and outputContract blocks in the W2 layout.
    await setWaifuBlocksEnabled(storage, "yuki", { ioFormat: false, outputContract: false });

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            {
              waifuId: "yuki",
              delaySeconds: 0,

              directive: { intent: "spotlight", goal: "answer Kevin" }
            }
          ],
          reasoning: "Yuki starts."
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        checked = true;
        // Identity and persona still render.
        expect(request.systemPrompt).toContain("<yuki_identity>");
        expect(request.systemPrompt).toContain("<yuki_persona>");
        // Disabled blocks are omitted.
        expect(request.systemPrompt).not.toContain("<io_format>");
        expect(request.systemPrompt).not.toContain("<output_contract>");
        // Mid: roomInfo still renders active_chat_participants and server_emojis.
        expect(request.midSystemBlock).toContain("<active_chat_participants>");
        expect(request.midSystemBlock).toContain("<server_emojis>");
        // No old block names.
        expect(request.midSystemBlock).not.toContain("<director_notes>");
        expect(request.trailingSystemBlock).not.toContain("<yuki_persona>");
        expect(request.trailingSystemBlock).toContain("<yuki_anchor>");
        expect(request.trailingSystemBlock).toContain(
          expectedDirectorNote("(spotlight) answer Kevin")
        );
        return { content: "plain reply" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(checked).toBe(true);
  });

  it("truncates casting-card persona to 200 chars in trailing prompt and excludes raw persona from system prompt", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[{ id: "m1", channelId: "channel-1", guildId: "guild-1", authorKind: "user", authorId: "u1", authorBot: false, name: "Kevin", displayName: "Kevin", content: "hi", timestamp: "2026-05-16T12:00:00Z", reactions: [] }]];

    const longPersona = "A".repeat(50) + " " + "B".repeat(50) + " " + "C".repeat(50) + " " + "D".repeat(50) + " " + "E".repeat(50);
    // longPersona is 254 chars (4 spaces + 5*50 = 254); after .replace(/\s+/g, " ") it collapses to same length
    // The slice(0, 200) should cut off before "D".repeat(50) fully

    await seedRuntimeConfig(storage);
    // Overwrite yuki with long persona
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
        persona: longPersona,
        contextWindow: 50
      })
    );

    let trailingPrompt: string | undefined;
    let systemPrompt: string | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request: ProviderRequest) {
        trailingPrompt = request.trailingPrompt;
        systemPrompt = request.systemPrompt;
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" };
      },
      async generateWaifu() {
        return { content: "hi" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(trailingPrompt).toBeDefined();
    // The About: line must be at most 200 chars of persona text
    const aboutMatch = trailingPrompt!.match(/About: (.+)/);
    expect(aboutMatch).not.toBeNull();
    const aboutText = aboutMatch![1];
    expect(aboutText.length).toBeLessThanOrEqual(200);
    // The tail of the long persona (past 200 chars) must NOT appear in trailing prompt
    const normalised = longPersona.trim().replace(/\s+/g, " ");
    expect(trailingPrompt).not.toContain(normalised.slice(200));
    // System prompt must not contain the raw persona at all
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt).not.toContain(normalised.slice(0, 50));
  });

  it("tracks active chat participants from human messages and refreshes their expiry", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      isPaused: () => true,
      createPipeline: () => {
        throw new Error("pipeline should not be created while paused");
      },
      logger: quietLogger()
    });

    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "human-1",
      authorId: "u1",
      authorDisplayName: "Kevin",
      authorBot: false
    });

    const first = await waitForActiveParticipants(storage, "channel-1", (file) =>
      file.participants.some((participant) => participant.displayName === "Kevin")
    );
    expect(first).toMatchObject({ guildId: "guild-1", channelId: "channel-1" });
    expect(first.participants).toHaveLength(1);
    expect(first.participants[0]).toMatchObject({ userId: "u1", displayName: "Kevin" });
    const firstLastSeen = Date.parse(first.participants[0].lastSeenAt);
    const firstExpires = Date.parse(first.participants[0].expiresAt);
    expect(firstExpires - firstLastSeen).toBe(7 * 24 * 60 * 60 * 1000);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "human-2",
      authorId: "u1",
      authorDisplayName: "Kevin Prime",
      authorBot: false
    });

    const refreshed = await waitForActiveParticipants(storage, "channel-1", (file) =>
      file.participants.some((participant) => participant.displayName === "Kevin Prime")
    );
    expect(refreshed.participants).toHaveLength(1);
    expect(refreshed.participants[0]).toMatchObject({ userId: "u1", displayName: "Kevin Prime" });
    expect(Date.parse(refreshed.participants[0].expiresAt)).toBeGreaterThan(firstExpires);
  });

  it("keeps active human participants isolated by channel", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      isPaused: () => true,
      createPipeline: () => {
        throw new Error("pipeline should not be created while paused");
      },
      logger: quietLogger()
    });

    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "channel-1-human",
      authorId: "u1",
      authorDisplayName: "Kevin",
      authorBot: false
    });
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-2",
      messageId: "channel-2-human",
      authorId: "u1",
      authorDisplayName: "Kevin Lounge",
      authorBot: false
    });

    const channelOne = await waitForActiveParticipants(storage, "channel-1", (file) =>
      file.participants.some((participant) => participant.displayName === "Kevin")
    );
    const channelTwo = await waitForActiveParticipants(storage, "channel-2", (file) =>
      file.participants.some((participant) => participant.displayName === "Kevin Lounge")
    );

    expect(channelOne.participants.map((participant) => participant.displayName)).toEqual(["Kevin"]);
    expect(channelTwo.participants.map((participant) => participant.displayName)).toEqual(["Kevin Lounge"]);
    expect(channelOne.participants[0].userId).toBe("u1");
    expect(channelTwo.participants[0].userId).toBe("u1");
  });

  it("does not add bot authors to active chat participants", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      isPaused: () => true,
      createPipeline: () => {
        throw new Error("pipeline should not be created while paused");
      },
      logger: quietLogger()
    });

    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "bot-1",
      authorId: "bot-1",
      authorDisplayName: "Helper Bot",
      authorBot: true
    });

    const participants = await storage.readJson(
      "user/servers/guild-1/active-chat-participants/channel-1.json",
      ActiveChatParticipantsFileSchema,
      ActiveChatParticipantsFileSchema.parse(
        createEmptyRevisionedFile({ guildId: "guild-1", channelId: "channel-1", participants: [] })
      )
    );
    expect(participants.participants).toEqual([]);
  });

  it("omits expired active chat participants from the waifu prompt", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);
    await storage.writeJson(
      "active-chat-participants:guild-1:channel-1",
      "user/servers/guild-1/active-chat-participants/channel-1.json",
      ActiveChatParticipantsFileSchema,
      ActiveChatParticipantsFileSchema.parse(
        createEmptyRevisionedFile({
          guildId: "guild-1",
          channelId: "channel-1",
          participants: [
            {
              userId: "old",
              displayName: "Old User",
              lastSeenAt: "2026-05-01T12:00:00.000Z",
              expiresAt: "2026-05-08T12:00:00.000Z"
            },
            {
              userId: "active",
              displayName: "Mira",
              lastSeenAt: new Date(Date.now()).toISOString(),
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            },
            {
              userId: "same-name-as-waifu",
              displayName: "yuki",
              lastSeenAt: new Date(Date.now()).toISOString(),
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }
          ]
        })
      )
    );
    await storage.writeJson(
      "active-chat-participants:guild-1:channel-2",
      "user/servers/guild-1/active-chat-participants/channel-2.json",
      ActiveChatParticipantsFileSchema,
      ActiveChatParticipantsFileSchema.parse(
        createEmptyRevisionedFile({
          guildId: "guild-1",
          channelId: "channel-2",
          participants: [
            {
              userId: "other-channel",
              displayName: "Other Channel User",
              lastSeenAt: new Date(Date.now()).toISOString(),
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }
          ]
        })
      )
    );

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "talk"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        checked = true;
        expect(request.midSystemBlock).toMatch(
          /<active_chat_participants>\n- Kevin\n- Mika\n- Mira\n- Yuki\n<\/active_chat_participants>/
        );
        expect(request.midSystemBlock).not.toContain("Old User");
        expect(request.midSystemBlock).not.toContain("Other Channel User");
        return { content: "ok" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(checked).toBe(true);
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 45 }],
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
            { waifuId: "yuki", delaySeconds: 12 },
            { waifuId: "mika", delaySeconds: 5 },
            { waifuId: "aria", delaySeconds: 9 }
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
            { waifuId: "yuki", delaySeconds: 3 },
            { waifuId: "mika", delaySeconds: 4 }
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
              respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
              reasoning: "leftover",
              status: "pending",
              waifuMessageIds: [],
              responderOutcomes: [
                {
                  id: "leftover-yuki",
                  waifuId: "yuki",
                  source: "orchestrator",
                  status: "pending",
                  messageIds: []
                }
              ],
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
    const healed = history.decisions.find((entry) => entry.id === "leftover-pending");
    expect(healed?.status).toBe("interrupted");
    expect(healed?.responderOutcomes).toMatchObject([
      {
        id: "leftover-yuki",
        status: "interrupted",
        reason: "runtime_restarted"
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
      async decideStageManagerObservations(request: StageManagerObserveRequest) {
        expect(request.systemPrompt).toBeUndefined();
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        return [
          { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" as const }
        ];
      },
      async decideStageManager(request: StageManagerRequest) {
        expect(request.memories).toEqual([]);
        expect(request.observations).toEqual([
          { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" }
        ]);
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
      permanent: false,
      sourceMessageIds: []
    });
    expect(discord.sent).toEqual([]);

    const history = await storage.readJson(
      "user/stage-manager/history.json",
      StageManagerHistoryFileSchema
    );
    expect(history.edits[0].tool).toBe("add_memory");
    expect(history.edits[0].observationCount).toBe(1);
  });

  it("logs provider error details when stage-manager fails", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        throw new ProviderPipelineError("Provider request failed with HTTP 400.", {
          error: {
            status: "INVALID_ARGUMENT",
            message: "ANY mode rejected deeply nested schema."
          }
        });
      },
      async decideStageManager() {
        return [];
      }
    };
    const loggedErrors: Array<{ message: string; context?: unknown }> = [];

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
        error: (message, context) => loggedErrors.push({ message, context })
      }
    });

    const result = await runtime.triggerStageManager("guild-1", "channel-1");

    expect(result.status).toBe("failed");
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0].message).toBe("Stage manager failed");
    expect(loggedErrors[0].context).toMatchObject({
      message: "Provider request failed with HTTP 400.",
      details: expect.stringContaining("deeply nested schema")
    });
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
      async decideStageManagerObservations() {
        return [
          { waifuId: "yuki", content: "Kevin asked something.", importance: 2, kind: "fact" as const }
        ];
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
      async decideStageManagerObservations() {
        return [
          { waifuId: "yuki", content: "Kevin enjoys tea regularly.", importance: 3, kind: "preference" as const }
        ];
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

  it("rejects stale stage-manager edits after memories become permanent", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();
    const fallback = MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }));

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
              sourceMessageIds: [],
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
              sourceMessageIds: [],
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
      async decideStageManagerObservations() {
        return [
          { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" as const }
        ];
      },
      async decideStageManager(request: StageManagerRequest) {
        expect(request.memories).toHaveLength(2);
        await storage.updateRevisionedJson({
          resourceKey: "memories:global",
          relativePath: "user/memories.json",
          schema: MemoryStoreSchema,
          fallback,
          transform: (current) => ({
            ...current,
            memories: current.memories.map((memory) => ({
              ...memory,
              permanent: true
            }))
          })
        });
        return [
          { tool: "update_memory", memoryIndex: 1, patch: { content: "Changed." } },
          { tool: "archive_memory", memoryIndex: 2 },
          {
            tool: "merge_memories",
            sourceMemoryIndices: [1, 2],
            mergedContent: "Merged."
          }
        ];
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    const result = await runtime.triggerStageManager("guild-1", "channel-1");

    expect(result.status).toBe("no_change");
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories).toHaveLength(2);
    expect(memories.memories).toEqual([
      expect.objectContaining({
        id: "first",
        content: "Kevin likes tea.",
        permanent: true,
        status: "active"
      }),
      expect.objectContaining({
        id: "second",
        content: "Kevin likes green tea.",
        permanent: true,
        status: "active"
      })
    ]);
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
      async decideStageManagerObservations() {
        return [
          { waifuId: "yuki", content: "Kevin keeps mentioning tea.", importance: 3, kind: "preference" as const }
        ];
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

  it("short-circuits when the observer extracts no observations", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let librarianCalls = 0;

    await seedRuntimeConfig(storage);
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        return [];
      },
      async decideStageManager() {
        librarianCalls += 1;
        return [{ tool: "no_change", reason: "should not run" }];
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

    expect(librarianCalls).toBe(0);
    const history = await storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema);
    expect(history.edits[0]).toMatchObject({
      tool: "no_change",
      observationCount: 0,
      summary: "No observations extracted"
    });
  });

  it("prunes the memory list passed to the librarian by observation token overlap", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "mika persona");
    await enableWaifus(storage, ["yuki", "mika"]);
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "yuki-tea",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin enjoys tea most mornings.",
              importance: 3,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: [],
              status: "active"
            },
            {
              id: "yuki-permanent-tea",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin permanently prefers ceremonial green tea.",
              importance: 5,
              permanent: true,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: [],
              status: "active"
            },
            {
              id: "mika-tea",
              waifuId: "mika",
              scope: "guild",
              guildId: "guild-1",
              content: "Kevin asks Mika about tea sometimes.",
              importance: 2,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: [],
              status: "active"
            },
            {
              id: "mika-pizza",
              waifuId: "mika",
              scope: "guild",
              guildId: "guild-1",
              content: "Mia ordered pepperoni pizza last weekend.",
              importance: 1,
              createdAt: now,
              updatedAt: now,
              sourceMessageIds: [],
              status: "active"
            }
          ]
        })
      )
    );

    let librarianMemories: unknown;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        return [
          { waifuId: "yuki", content: "Kevin asked for a tea recommendation.", importance: 3, kind: "event" as const }
        ];
      },
      async decideStageManager(request: StageManagerRequest) {
        librarianMemories = request.memories;
        return [{ tool: "no_change", reason: "tested" }];
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

    expect(librarianMemories).toEqual([
      { memoryIndex: 1, waifuId: "yuki", content: "Kevin enjoys tea most mornings.", importance: 3 },
      { memoryIndex: 2, waifuId: "mika", content: "Kevin asks Mika about tea sometimes.", importance: 2 }
    ]);
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "reply"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        expect(request.systemPrompt).not.toContain("Kevin likes tea.");
        expect(request.trailingSystemBlock).toContain("Kevin likes tea.");
        expect(request.trailingSystemBlock).not.toContain("Kevin hates tea.");
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
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: RETRIGGER_MAX_SECONDS, reasoning: "wait" };
      },
      async decideStageManagerObservations() {
        return [{ waifuId: "yuki", content: "Kevin pinged.", importance: 2, kind: "event" as const }];
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
      stageManagerIdleDelayMs: 120,
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

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stageCalls).toBe(1);
    await runtime.stop();
  });

  it("rearms the idle timer on each new message instead of firing on a fixed cadence", async () => {
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
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: RETRIGGER_MAX_SECONDS, reasoning: "wait" };
      },
      async decideStageManagerObservations() {
        return [{ waifuId: "yuki", content: "Kevin pinged.", importance: 2, kind: "event" as const }];
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
      stageManagerIdleDelayMs: 1000,
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-2",
      authorId: "u1",
      authorBot: false
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(stageCalls).toBe(0);

    await waitForStageCalls(1);
    expect(stageCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stageCalls).toBe(1);
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
      async decideStageManagerObservations() {
        return [{ waifuId: "yuki", content: "Kevin pinged.", importance: 2, kind: "event" as const }];
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

  it("fetches and stores Discord names when a new channel is detected", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    await storage.writeJson(
      "server:guild-1",
      "user/servers/guild-1/server.json",
      ServerConfigSchema,
      ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId: "guild-1",
        name: "Stale server name",
        enabled: true
      })
    );
    discord.channelMetadata.set("guild-1:channel-1", {
      guildId: "guild-1",
      guildName: "我的服务器",
      channelId: "channel-1",
      channelName: "聊天频道"
    });

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      createPipeline: () => new FakePipeline(),
      logger: quietLogger()
    });

    const event = {
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "external-bot",
      authorBot: true
    };
    await runtime.handleDiscordMessage(event);
    await runtime.handleDiscordMessage({ ...event, messageId: "message-2" });

    const server = await storage.readJson(
      "user/servers/guild-1/server.json",
      ServerConfigSchema
    );
    expect(discord.channelMetadataCalls).toEqual([
      { guildId: "guild-1", channelId: "channel-1" }
    ]);
    expect(server.name).toBe("我的服务器");
    expect(server.channels["channel-1"]).toMatchObject({
      channelId: "channel-1",
      name: "聊天频道",
      enabled: false,
      enabledWaifuIds: []
    });
  });

  it("refreshes existing server and channel names from Discord during startup", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.guilds = [{ guildId: "guild-1", name: "我的服务器" }];
    discord.channelMetadata.set("guild-1:channel-1", {
      guildId: "guild-1",
      guildName: "我的服务器",
      channelId: "channel-1",
      channelName: "聊天频道"
    });
    discord.channelMetadata.set("guild-1:channel-2", {
      guildId: "guild-1",
      guildName: "我的服务器",
      channelId: "channel-2",
      channelName: "公告"
    });
    await storage.writeJson(
      "server:guild-1",
      "user/servers/guild-1/server.json",
      ServerConfigSchema,
      ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId: "guild-1",
        name: "guild-1",
        enabled: true,
        channels: {
          "channel-1": {
            channelId: "channel-1",
            enabled: false,
            enabledWaifuIds: []
          },
          "channel-2": {
            channelId: "channel-2",
            name: "channel-2",
            enabled: true,
            enabledWaifuIds: ["yuki"]
          }
        }
      })
    );

    const runtime = new RuntimeOrchestrator({
      storage,
      discord,
      createPipeline: () => new FakePipeline(),
      logger: quietLogger()
    });
    await runtime.start();
    await runtime.stop();

    const server = await storage.readJson(
      "user/servers/guild-1/server.json",
      ServerConfigSchema
    );
    expect(discord.channelMetadataCalls).toEqual([
      { guildId: "guild-1", channelId: "channel-1" },
      { guildId: "guild-1", channelId: "channel-2" }
    ]);
    expect(server.name).toBe("我的服务器");
    expect(server.channels["channel-1"]?.name).toBe("聊天频道");
    expect(server.channels["channel-2"]?.name).toBe("公告");
    expect(server.channels["channel-2"]?.enabledWaifuIds).toEqual(["yuki"]);
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
      async decideStageManagerObservations() {
        return [{ waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" as const }];
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
      count: 1,
      type: "waifus",
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
      type: "waifus",
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

  it("clears latest human and waifu messages when /clear type is both", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("old-waifu", "waifu", "Yuki", "old reply"),
        contextMessage("user-1", "user", "Kevin", "first user message"),
        contextMessage("other-bot", "user", "Helper", "bot message", undefined, { authorBot: true, authorId: "helper-bot" }),
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
      type: "both",
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

  it("clears latest human user messages without deleting waifus or other bots", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("user-1", "user", "Kevin", "first user message", undefined, { authorBot: false }),
        contextMessage("waifu-1", "waifu", "Yuki", "waifu reply"),
        contextMessage("other-bot", "user", "Helper", "bot message", undefined, { authorBot: true, authorId: "helper-bot" }),
        contextMessage("user-2", "user", "Kevin", "latest user message", undefined, { authorBot: false })
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
      logger: quietLogger()
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
      type: "users",
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
        messageIds: ["user-2", "user-1"],
        authorIdByMessageId: {
          "user-2": "u1",
          "user-1": "u1"
        }
      }
    ]);
    expect(responses).toEqual(["Cleared 2 user messages."]);
  });

  it.each(["waifus", "users", "both"] as const)("requires count for /clear type %s", async (type) => {
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
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitClearCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "moderator-user",
      type,
      respond: async (content) => {
        responses.push(content);
      }
    });
    await runtime.stop();

    expect(discord.deleted).toEqual([]);
    expect(discord.deletedAll).toEqual([]);
    expect(responses).toEqual(["Count is required for this clear type."]);
  });

  it("clears every message in the channel without requiring count", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.deleteAllResult = {
      scannedMessageCount: 3,
      deletedCount: 3,
      failedCount: 0,
      failedMessageIds: []
    };

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
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitClearCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "moderator-user",
      type: "everything",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await runtime.stop();

    expect(discord.deleted).toEqual([]);
    expect(discord.deletedAll).toEqual([{ guildId: "guild-1", channelId: "channel-1" }]);
    expect(responses).toEqual(["Cleared 3 messages."]);
  });

  it("sets and unsets a cross-guild debug log route from /console", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.debugChannelInfo.set("source-channel", { channelId: "source-channel", guildId: "guild-a" });
    discord.debugChannelInfo.set("debug-channel", { channelId: "debug-channel", guildId: "guild-b" });

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
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitDebugCommand({
      guildId: "guild-b",
      channelId: "debug-channel",
      userId: "admin-user",
      type: "set",
      sourceChannelId: "source-channel",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "debug set response");
    const afterSet = await storage.readJson("user/orchestrator/debug.json", OrchestratorDebugConfigFileSchema);
    await discord.emitDebugCommand({
      guildId: "guild-b",
      channelId: "debug-channel",
      userId: "admin-user",
      type: "unset",
      sourceChannelId: "source-channel",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 2, "debug unset response");
    const afterUnset = await storage.readJson("user/orchestrator/debug.json", OrchestratorDebugConfigFileSchema);
    await runtime.stop();

    expect(afterSet.routes["source-channel"]).toMatchObject({
      sourceGuildId: "guild-a",
      sourceChannelId: "source-channel",
      destinationGuildId: "guild-b",
      destinationChannelId: "debug-channel",
      createdByUserId: "admin-user"
    });
    expect(afterUnset.routes).toEqual({});
    expect(responses).toEqual([
      "Debug logs for channel source-channel will be posted in this channel.",
      "Debug logs disabled for channel source-channel."
    ]);
  });

  it("reports that stale /console print is deprecated", async () => {
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
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitDebugCommand({
      guildId: "guild-b",
      channelId: "print-channel",
      userId: "admin-user",
      type: "print",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "debug print empty response");
    await runtime.stop();

    expect(responses).toEqual(["/console print is deprecated. Use /print instead."]);
    expect(discord.debugMessages).toEqual([]);
  });

  it("prints a fresh selected waifu system prompt for the current guild", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "yuki", "Yuki", "yuki-bot", `kind\n${"long detail line\n".repeat(260)}`);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "admin-user",
      type: "system_prompt",
      waifuId: "yuki",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "print system prompt response");
    await runtime.stop();

    expect(responses).toEqual(["Printed system prompt for Yuki."]);
    expect(discord.debugMessages.length).toBeGreaterThan(3);
    expect(discord.debugMessages.every((message) => message.channelId === "channel-1")).toBe(true);
    const printed = discord.debugMessages.map((message) => message.content).join("\n");
    expect(printed).toContain("## System prompt block 1 (Yuki)");
    expect(printed).toContain("## System prompt block 2 (Yuki)");
    expect(printed).toContain("## System prompt block 3 (Yuki)");
    expect(printed).not.toContain("(continued");
    expect(printed).not.toMatch(/`{3,}xml/);
    expect(printed).toContain("<yuki_identity>");
    expect(printed).toContain("<active_chat_participants>");
    expect(printed).not.toContain("<scene_direction>");
    expect(printed).not.toContain("\\n");
  });

  it("prints model-visible memories for the selected waifu in the current guild and channel", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = Date.now();
    const createdAt = new Date(now - 60_000).toISOString();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "current-active",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Yuki knows Kevin likes green tea.",
              importance: 3,
              createdAt,
              updatedAt: createdAt,
              sourceMessageIds: [],
              status: "active"
            },
            {
              id: "current-permanent",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Yuki always remembers Kevin is allergic to peanuts.",
              importance: 5,
              permanent: true,
              createdAt,
              updatedAt: createdAt,
              sourceMessageIds: [],
              status: "active"
            },
            {
              id: "archived-current",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-1",
              content: "Archived current guild memory.",
              importance: 2,
              createdAt,
              updatedAt: createdAt,
              sourceMessageIds: [],
              status: "archived"
            },
            {
              id: "other-guild",
              waifuId: "yuki",
              scope: "guild",
              guildId: "guild-2",
              content: "Other guild memory.",
              importance: 2,
              createdAt,
              updatedAt: createdAt,
              sourceMessageIds: [],
              status: "active"
            },
            {
              id: "other-waifu",
              waifuId: "mika",
              scope: "guild",
              guildId: "guild-1",
              content: "Mika-only memory.",
              importance: 2,
              createdAt,
              updatedAt: createdAt,
              sourceMessageIds: [],
              status: "active"
            }
          ]
        })
      )
    );
    await storage.writeJson(
      "short-term-memories",
      "user/short-term-memories.json",
      ShortTermMemoryStoreSchema,
      ShortTermMemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          entries: [
            {
              id: "short-current",
              guildId: "guild-1",
              channelId: "channel-1",
              waifuId: "yuki",
              content: "Kevin is leaving at 5pm.",
              createdAt,
              expiresAt: new Date(now + 60_000).toISOString()
            },
            {
              id: "short-expired",
              guildId: "guild-1",
              channelId: "channel-1",
              waifuId: "yuki",
              content: "Expired short-term memory.",
              createdAt,
              expiresAt: new Date(now - 60_000).toISOString()
            },
            {
              id: "short-other-channel",
              guildId: "guild-1",
              channelId: "channel-2",
              waifuId: "yuki",
              content: "Other channel short-term memory.",
              createdAt,
              expiresAt: new Date(now + 60_000).toISOString()
            }
          ]
        })
      )
    );

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "admin-user",
      type: "memories",
      waifuId: "yuki",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "print memories response");
    await runtime.stop();

    expect(responses).toEqual(["Printed memories for Yuki."]);
    const printed = discord.debugMessages.map((message) => message.content).join("\n");
    expect(printed).toContain("## Memories (Yuki)");
    expect(printed).toContain("<yuki_relevant_memories>");
    expect(printed).toContain("- Yuki knows Kevin likes green tea.");
    expect(printed).toContain("- Yuki always remembers Kevin is allergic to peanuts.");
    expect(printed).toContain("- Kevin is leaving at 5pm.");
    expect(printed).not.toContain("Archived current guild memory.");
    expect(printed).not.toContain("Other guild memory.");
    expect(printed).not.toContain("Mika-only memory.");
    expect(printed).not.toContain("Expired short-term memory.");
    expect(printed).not.toContain("Other channel short-term memory.");
  });

  it("prints the selected waifu raw personality", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "dry\nsharp");
    await enableWaifus(storage, ["yuki", "mika"]);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "admin-user",
      type: "personality",
      waifuId: "mika",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "print personality response");
    await runtime.stop();

    expect(responses).toEqual(["Printed personality for Mika."]);
    const printed = discord.debugMessages.map((message) => message.content).join("\n");
    expect(printed).toContain("## Personality (Mika)");
    expect(printed).toContain("dry\nsharp");
    expect(printed).not.toContain("You are Mika");
  });

  it("rejects /print waifus outside the current guild", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "admin-user",
      type: "personality",
      waifuId: "mika",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "print invalid waifu response");
    await runtime.stop();

    expect(responses).toEqual(['Waifu "mika" is not enabled in this server.']);
    expect(discord.debugMessages).toEqual([]);
  });

  it("posts orchestrator reply decisions to the configured debug channel", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "bold");
    await enableWaifus(storage, ["yuki", "mika"]);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => ({
        async decideOrchestrator() {
          return {
            action: "reply",
            respondingWaifus: [
              { waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "ask Kevin about the trip" } },
              { waifuId: "mika", delaySeconds: 7 }
            ],
            reasoning: "Yuki should answer first, then Mika can add a quick aside."
          };
        },
        async generateWaifu() {
          return { content: "ok" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();
    const debugResponses: string[] = [];
    await discord.emitDebugCommand({
      guildId: "guild-b",
      channelId: "debug-channel",
      userId: "admin-user",
      type: "set",
      sourceChannelId: "channel-1",
      respond: async (content) => {
        debugResponses.push(content);
      }
    });
    await waitFor(() => debugResponses.length === 1, "debug set response");

    await runtime.triggerChannel("guild-1", "channel-1");
    await waitFor(() => discord.debugMessages.length === 1, "orchestrator debug message");
    await runtime.stop();

    expect(discord.debugMessages[0]).toMatchObject({ channelId: "debug-channel" });
    expect(discord.debugMessages[0]?.content).toContain("Decision: reply");
    expect(discord.debugMessages[0]?.content).toContain("Waifus: Yuki (yuki) -> Mika (mika)");
    expect(discord.debugMessages[0]?.content).toContain("Directives:");
    expect(discord.debugMessages[0]?.content).toContain("- Yuki (yuki): (spotlight) ask Kevin about the trip");
    expect(discord.debugMessages[0]?.content).not.toContain("delaySeconds");
  });

  it("posts orchestrator no-reply decisions with idle trigger and reasoning", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => ({
        async decideOrchestrator() {
          return {
            action: "no_reply",
            respondingWaifus: [],
            retriggerAfterSeconds: 240,
            reasoning: "The room has gone quiet naturally."
          };
        },
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();
    const debugResponses: string[] = [];
    await discord.emitDebugCommand({
      guildId: "guild-b",
      channelId: "debug-channel",
      userId: "admin-user",
      type: "set",
      sourceChannelId: "channel-1",
      respond: async (content) => {
        debugResponses.push(content);
      }
    });
    await waitFor(() => debugResponses.length === 1, "debug set response");

    await runtime.triggerChannel("guild-1", "channel-1");
    await waitFor(() => discord.debugMessages.length === 1, "no-reply debug message");
    await runtime.stop();

    expect(discord.debugMessages[0]?.content).toContain("Decision: no_reply");
    expect(discord.debugMessages[0]?.content).toContain("Idle trigger: 240s");
    expect(discord.debugMessages[0]?.content).toContain("The room has gone quiet naturally.");
  });

  it("posts stage-manager memory changes to the configured debug channel", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "Yuki likes tea now")]];

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({
        async decideStageManagerObservations() {
          return [{ waifuId: "yuki", content: "Yuki likes green tea.", importance: 3, kind: "preference" }];
        },
        async decideStageManager() {
          return [{
            tool: "add_memory",
            memory: { waifuId: "yuki", content: "Yuki likes green tea.", importance: 3 }
          }];
        },
        async generateWaifu() {
          return { content: "unused" };
        }
      }),
      logger: quietLogger()
    });
    await runtime.start();
    const debugResponses: string[] = [];
    await discord.emitDebugCommand({
      guildId: "guild-b",
      channelId: "debug-channel",
      userId: "admin-user",
      type: "set",
      sourceChannelId: "channel-1",
      respond: async (content) => {
        debugResponses.push(content);
      }
    });
    await waitFor(() => debugResponses.length === 1, "debug set response");

    await runtime.triggerStageManager("guild-1", "channel-1");
    await waitFor(() => discord.debugMessages.length === 1, "stage-manager debug message");
    await runtime.stop();

    expect(discord.debugMessages[0]?.content).toContain("[stage-manager debug]");
    expect(discord.debugMessages[0]?.content).toContain("Observations: 1");
    expect(discord.debugMessages[0]?.content).toContain("added: Yuki likes green tea.");
    expect(discord.debugMessages[0]?.content).not.toContain("affectedMemoryIds");
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
            respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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
          expect(request.trailingSystemBlock).toContain(
            expectedDirectorNote("start topic")
          );
          return { content: "mika first", pickedNextWaifuId: "yuki" };
        }
        waifuCalls.push("yuki");
        expect(request.trailingSystemBlock ?? "").not.toMatch(/<director_note>/);
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

  it("suggests channel-enabled waifus for /run autocomplete", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "bold");
    await enableWaifus(storage, ["yuki", "mika"]);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => new FakePipeline(),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    await runtime.start();

    expect(discord.runWaifuAutocompleteListeners.size).toBe(1);

    let choices: Array<{ name: string; value: string }> = [];
    await discord.emitRunWaifuAutocomplete({
      guildId: "guild-1",
      channelId: "channel-1",
      focusedValue: "",
      respond: async (nextChoices) => {
        choices = nextChoices;
      }
    });

    expect(choices).toEqual([
      { name: "Yuki (yuki)", value: "yuki" },
      { name: "Mika (mika)", value: "mika" }
    ]);

    await discord.emitRunWaifuAutocomplete({
      guildId: "guild-1",
      channelId: "channel-1",
      focusedValue: "mi",
      respond: async (nextChoices) => {
        choices = nextChoices;
      }
    });
    await runtime.stop();

    expect(choices).toEqual([{ name: "Mika (mika)", value: "mika" }]);
  });

  it("suggests guild-enabled waifus for /print autocomplete", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "bold");
    await seedWaifu(storage, "aria", "Aria", "aria-bot", "dry");
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
          },
          "channel-2": {
            channelId: "channel-2",
            enabled: true,
            enabledWaifuIds: ["mika", "yuki", "aria"]
          }
        }
      })
    );

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => new FakePipeline(),
      logger: quietLogger()
    });
    await runtime.start();

    expect(discord.printWaifuAutocompleteListeners.size).toBe(1);

    let choices: Array<{ name: string; value: string }> = [];
    await discord.emitPrintWaifuAutocomplete({
      guildId: "guild-1",
      channelId: "channel-1",
      focusedValue: "",
      respond: async (nextChoices) => {
        choices = nextChoices;
      }
    });

    expect(choices).toEqual([
      { name: "Yuki (yuki)", value: "yuki" },
      { name: "Mika (mika)", value: "mika" },
      { name: "Aria (aria)", value: "aria" }
    ]);

    await discord.emitPrintWaifuAutocomplete({
      guildId: "guild-1",
      channelId: "channel-1",
      focusedValue: "ar",
      respond: async (nextChoices) => {
        choices = nextChoices;
      }
    });
    await runtime.stop();

    expect(choices).toEqual([{ name: "Aria (aria)", value: "aria" }]);
  });

  it("applies /run scene direction to the first orchestrator-selected waifu", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hello")],
      [contextMessage("m1", "user", "Kevin", "hello")],
      [contextMessage("m2", "waifu", "Yuki", "yuki first")]
    ];

    const waifuCalls: Array<{ waifuId: string; directiveText?: string }> = [];
    let resolveGenerated: () => void = () => undefined;
    const generated = new Promise<void>((resolve) => {
      resolveGenerated = resolve;
    });
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        expect(request.replyRequired).toBe(true);
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "orchestrator first" } },
            { waifuId: "mika", delaySeconds: 0, directive: { intent: "spotlight", goal: "orchestrator second" } }
          ],
          reasoning: "manual run reply"
        };
      },
      async generateWaifu(request) {
        const waifuId = request.systemPrompt.includes("You are Mika") ? "mika" : "yuki";
        const directiveMatch = request.trailingSystemBlock?.match(
          /<director_note>\nDirector's goal for this one message: ([^\n]+)\n/
        );
        waifuCalls.push({ waifuId, directiveText: directiveMatch?.[1] });
        if (waifuCalls.length === 2) {
          resolveGenerated();
        }
        return { content: `${waifuId} reply` };
      }
    };

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "bold");
    await enableWaifus(storage, ["yuki", "mika"]);

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

    const responses: string[] = [];
    let resolveRun: () => void = () => undefined;
    const runResponded = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    await discord.emitRunCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "runner-user",
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
        generated,
        new Promise((_, reject) => setTimeout(() => reject(new Error("waifus did not generate")), 1000))
      ])
    ]);

    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    await runtime.stop();

    expect(responses).toEqual(["Started orchestrator run with scene direction."]);
    expect(waifuCalls).toEqual([
      { waifuId: "yuki", directiveText: "start topic" },
      { waifuId: "mika", directiveText: "(spotlight) orchestrator second" }
    ]);
    expect(history.decisions.at(-1)?.respondingWaifus.map((responder) => ({
      waifuId: responder.waifuId,
      directive: responder.directive
    }))).toEqual([
      { waifuId: "yuki", directive: { intent: "manual", goal: "start topic" } },
      { waifuId: "mika", directive: { intent: "spotlight", goal: "orchestrator second" } }
    ]);
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
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" }, replyToMessageId: "m1" }],
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
              
              directive: { intent: "spotlight", goal: "answer" },
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer older" }, replyToMessageId: "m1" }],
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

  it("derives the reply target from a leading `>` quote in the waifu output", async () => {
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

    class QuotePipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }],
          reasoning: "Reply with a quote."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "> Kevin: older question\nhere is the answer" };
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
      createPipeline: () => new QuotePipeline(),
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
    expect(discord.sent[0].content).toBe("here is the answer");
  });

  it("salvages an implicit `Name: text` quote (missing `>`) into a real Discord reply", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "hello there"),
        contextMessage("m2", "user", "Kevin", "anyone home")
      ],
      [
        contextMessage("m1", "user", "Kevin", "hello there"),
        contextMessage("m2", "user", "Kevin", "anyone home")
      ],
      [contextMessage("m3", "waifu", "Yuki", "done")]
    ];

    class ImplicitQuotePipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }],
          reasoning: "Yuki replies with an implicit quote."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "Kevin: hello there\nthats your victory lap" };
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
      createPipeline: () => new ImplicitQuotePipeline(),
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
    expect(discord.sent[0].content).toBe("thats your victory lap");
  });

  it("derives the reply target from the preferred `replying to >` quote in waifu output", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "K", "older question", undefined, { authorId: "k-user" }),
        contextMessage("m2", "user", "Aria", "newer follow-up", undefined, { authorId: "aria-user" })
      ],
      [
        contextMessage("m1", "user", "K", "older question", undefined, { authorId: "k-user" }),
        contextMessage("m2", "user", "Aria", "newer follow-up", undefined, { authorId: "aria-user" })
      ],
      [contextMessage("m3", "waifu", "Yuki", "done")]
    ];

    class PreferredQuotePipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }],
          reasoning: "Yuki replies with a preferred quote."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu() {
        return { content: "replying to > K: older question\nthats your victory lap" };
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
      createPipeline: () => new PreferredQuotePipeline(),
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
    expect(discord.sent[0].content).toBe("thats your victory lap");
  });

  it("strips an embedded hallucinated reply control without creating a Discord reply", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "K", "You guys talk a lot", undefined, { authorId: "k-user" })],
      [contextMessage("m1", "user", "K", "You guys talk a lot", undefined, { authorId: "k-user" })],
      [contextMessage("m2", "waifu", "Yuki", "done")]
    ];

    class HallucinatedEmbeddedQuotePipeline implements ModelPipeline {
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }
          ],
          reasoning: "Yuki answers without a real reply target."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu() {
        const repeated = "fr babe i knew u were up to something 💀";
        return {
          content:
            `${repeated}\n` +
            "replying to > K: bro been getting caught up in too much po\n" +
            repeated
        };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new HallucinatedEmbeddedQuotePipeline();
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

    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0].content).toBe("fr babe i knew u were up to something 💀");
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
  });

  it("strips recent human speaker impersonation lines and includes human names in stop sequences", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "K", "shall i mute you?", undefined, { authorId: "k-user" })],
      [contextMessage("m1", "user", "K", "shall i mute you?", undefined, { authorId: "k-user" })],
      [contextMessage("m2", "waifu", "Yuki", "done")]
    ];

    class HumanImpersonationPipeline implements ModelPipeline {
      receivedStopSequences: string[] | undefined;
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }],
          reasoning: "Yuki answers."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu(request: WaifuGenerationRequest) {
        this.receivedStopSequences = request.stopSequences;
        return {
          content: [
            "K: Its your choice not mine",
            "There was a pause that lasted indefinite.",
            "K: Shall i?"
          ].join("\n")
        };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);

    const pipeline = new HumanImpersonationPipeline();
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

    expect(discord.sent.map((message) => message.content)).toEqual([
      "There was a pause that lasted indefinite."
    ]);
    expect(pipeline.receivedStopSequences).toEqual(expect.arrayContaining(["\nYuki:", "\nK:"]));
  });

  it("strips an indented human speaker block before sending to Discord", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "K", "shall i mute you?", undefined, { authorId: "k-user" })],
      [contextMessage("m1", "user", "K", "shall i mute you?", undefined, { authorId: "k-user" })]
    ];

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki answers."
        };
      },
      async generateWaifu() {
        return {
          content: ["K:", "  leaked body from another participant", "", "actual reply"].join("\n")
        };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((message) => message.content)).toEqual(["actual reply"]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
  });

  it("strips active participant impersonation even when the participant is absent from fetched context", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "anyone home?", undefined, { authorId: "kevin-user" })],
      [contextMessage("m1", "user", "Kevin", "anyone home?", undefined, { authorId: "kevin-user" })]
    ];

    await seedRuntimeConfig(storage);
    await seedActiveParticipants(storage, [{ userId: "mira-user", displayName: "Mira" }]);

    let receivedStopSequences: string[] | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki answers."
        };
      },
      async generateWaifu(request) {
        receivedStopSequences = request.stopSequences;
        return {
          content: ["Mira:", "  cached participant leak", "", "actual reply"].join("\n")
        };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((message) => message.content)).toEqual(["actual reply"]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
    expect(receivedStopSequences).toEqual(expect.arrayContaining(["\nMira:"]));
  });

  it("strips a nonexistent preferred reply directive and sends the remaining body normally", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "real message")],
      [contextMessage("m1", "user", "Kevin", "real message")]
    ];

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki answers."
        };
      },
      async generateWaifu() {
        return { content: "replying to > Ghost: message that never existed\nclean body" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((message) => message.content)).toEqual(["clean body"]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
  });

  it("strips an unmatched blockquote reply directive and sends the remaining body normally", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "real message")],
      [contextMessage("m1", "user", "Kevin", "real message")]
    ];

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki answers."
        };
      },
      async generateWaifu() {
        return { content: "> fabricated message that never existed\nclean body" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((message) => message.content)).toEqual(["clean body"]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
  });

  it("omits an orchestrator-provided reply target that is not in fetched context", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "real message")],
      [contextMessage("m1", "user", "Kevin", "real message")]
    ];

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            {
              waifuId: "yuki",
              delaySeconds: 0,
              
              replyToMessageId: "missing-message-id"
            }
          ],
          reasoning: "Yuki answers."
        };
      },
      async generateWaifu() {
        return { content: "clean body" };
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent.map((message) => message.content)).toEqual(["clean body"]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
  });

  it("strips a leading other-waifu name prefix and passes participant stop sequences", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "tell me a joke")],
      [contextMessage("m1", "user", "Kevin", "tell me a joke")],
      [contextMessage("m2", "waifu", "Yuki", "done")]
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

    class ImpersonationPipeline implements ModelPipeline {
      receivedStopSequences: string[] | undefined;
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }],
          reasoning: "Yuki answers."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu(request: { stopSequences?: string[] }) {
        this.receivedStopSequences = request.stopSequences;
        return { content: "hello there\nMika: this should drop\nokay" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    const pipeline = new ImpersonationPipeline();
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

    expect(discord.sent.map((message) => message.content)).toEqual(["hello there", "okay"]);
    expect(pipeline.receivedStopSequences).toEqual(expect.arrayContaining(["\nYuki:", "\nMika:"]));
  });

  it("retries once when the entire reply is stripped as impersonation, and sends the recovered reply", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "tell me a joke")],
      [contextMessage("m1", "user", "Kevin", "tell me a joke")],
      [contextMessage("m2", "waifu", "Yuki", "oh wait that was me sorry")],
      [contextMessage("m3", "waifu", "Mika", "I can add something too")]
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

    class RetryRecoversPipeline implements ModelPipeline {
      waifuCalls = 0;
      retryUserMessages: Array<string | undefined> = [];
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } },
            { waifuId: "mika", delaySeconds: 0, directive: { intent: "spotlight", goal: "add something" } }
          ],
          reasoning: "Yuki and Mika answer."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu(request: WaifuGenerationRequest) {
        this.waifuCalls += 1;
        this.retryUserMessages.push(request.retryUserMessage);
        if (this.waifuCalls === 1) {
          return { content: "Mika: i meant to let Yuki go first" };
        }
        if (this.waifuCalls === 2) {
          return { content: "oh wait that was me sorry" };
        }
        return { content: "I can add something too" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    const pipeline = new RetryRecoversPipeline();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
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

    expect(pipeline.waifuCalls).toBe(3);
    expect(pipeline.retryUserMessages).toEqual([undefined, "Yuki:", undefined]);
    expect(discord.sent.map((m) => m.content)).toEqual([
      "oh wait that was me sorry",
      "I can add something too"
    ]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Waifu reply was entirely removed during cleaning; retrying once",
        meta: expect.objectContaining({
          waifuId: "yuki",
          metadataStripped: false,
          replyQuoteExtracted: false,
          impersonationStripped: true
        })
      })
    );
    expect(warnings.some((w) => w.message === "Waifu reply was empty after cleaning; nothing sent")).toBe(false);
  });

  it("retries once when reply-quote extraction removes the entire reply, and sends the recovered reply", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const quotedContent = "back off riko nobody asked for your commentary fr";
    discord.contexts = [
      [contextMessage("m1", "waifu", "Aria", quotedContent)],
      [contextMessage("m1", "waifu", "Aria", quotedContent)],
      [contextMessage("m2", "waifu", "Stupid hoe", "I have my own reply")]
    ];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "stupid-hoe", "Stupid hoe", "stupid-hoe-bot", "blunt");
    await enableWaifus(storage, ["stupid-hoe"]);

    class QuoteOnlyRetryPipeline implements ModelPipeline {
      waifuCalls = 0;
      retryUserMessages: Array<string | undefined> = [];
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "stupid-hoe", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }
          ],
          reasoning: "Stupid hoe answers."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu(request: WaifuGenerationRequest) {
        this.waifuCalls += 1;
        this.retryUserMessages.push(request.retryUserMessage);
        return this.waifuCalls === 1
          ? { content: `Aria: ${quotedContent}` }
          : { content: "I have my own reply" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    const pipeline = new QuoteOnlyRetryPipeline();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
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

    expect(pipeline.waifuCalls).toBe(2);
    expect(pipeline.retryUserMessages).toEqual([undefined, "Stupid hoe:"]);
    expect(discord.sent.map((message) => message.content)).toEqual(["I have my own reply"]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Waifu reply was entirely removed during cleaning; retrying once",
        meta: expect.objectContaining({
          waifuId: "stupid-hoe",
          metadataStripped: false,
          replyQuoteExtracted: true,
          impersonationStripped: false
        })
      })
    );
    expect(warnings.some((warning) => warning.message === "Waifu reply was empty after cleaning; nothing sent"))
      .toBe(false);
  });

  it("gives up after one retry when both replies contain only a matching reply quote", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const quotedContent = "back off riko nobody asked for your commentary fr";
    discord.contexts = [
      [contextMessage("m1", "waifu", "Aria", quotedContent)],
      [contextMessage("m1", "waifu", "Aria", quotedContent)],
      [contextMessage("m1", "waifu", "Aria", quotedContent)]
    ];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "stupid-hoe", "Stupid hoe", "stupid-hoe-bot", "blunt");
    await enableWaifus(storage, ["stupid-hoe"]);

    class AlwaysQuotesPipeline implements ModelPipeline {
      waifuCalls = 0;
      retryUserMessages: Array<string | undefined> = [];
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "stupid-hoe", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }
          ],
          reasoning: "Stupid hoe answers."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu(request: WaifuGenerationRequest) {
        this.waifuCalls += 1;
        this.retryUserMessages.push(request.retryUserMessage);
        return { content: `Aria: ${quotedContent}` };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    const pipeline = new AlwaysQuotesPipeline();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
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

    expect(pipeline.waifuCalls).toBe(2);
    expect(pipeline.retryUserMessages).toEqual([undefined, "Stupid hoe:"]);
    expect(discord.sent).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Waifu reply was empty after cleaning; nothing sent",
        meta: expect.objectContaining({
          waifuId: "stupid-hoe",
          attempts: 2
        })
      })
    );
  });

  it("gives up after one retry when the second attempt is also full impersonation", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "tell me a joke")],
      [contextMessage("m1", "user", "Kevin", "tell me a joke")],
      [contextMessage("m2", "user", "Kevin", "tell me a joke")]
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

    class AlwaysImpersonatesPipeline implements ModelPipeline {
      waifuCalls = 0;
      decisions: OrchestratorDecision[] = [
        {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" } }],
          reasoning: "Yuki answers."
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ];
      async generateWaifu() {
        this.waifuCalls += 1;
        return { content: `Mika: attempt ${this.waifuCalls} pretending to be someone else` };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    const pipeline = new AlwaysImpersonatesPipeline();
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
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

    expect(pipeline.waifuCalls).toBe(2);
    expect(discord.sent).toHaveLength(0);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Waifu reply was empty after cleaning; nothing sent",
        meta: expect.objectContaining({ waifuId: "yuki", attempts: 2 })
      })
    );
  });

  it("records an empty cleaned reply and continues to the next planned responder", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);

    let yukiAttempts = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0 },
            { waifuId: "mika", delaySeconds: 0 }
          ],
          reasoning: "Both should get a turn."
        };
      },
      async generateWaifu(request) {
        if (request.systemPrompt.includes("You are Yuki")) {
          yukiAttempts += 1;
          return { content: `Mika: impersonation attempt ${yukiAttempts}` };
        }
        return { content: "Mika still responds." };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(yukiAttempts).toBe(2);
    expect(discord.sent.map((message) => message.content)).toEqual(["Mika still responds."]);
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.status).toBe("completed");
    expect(decision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      status: outcome.status,
      reason: outcome.reason,
      messageCount: outcome.messageIds.length
    }))).toEqual([
      {
        waifuId: "yuki",
        status: "empty",
        reason: "empty_after_cleaning",
        messageCount: 0
      },
      {
        waifuId: "mika",
        status: "sent",
        reason: undefined,
        messageCount: 1
      }
    ]);
  });

  it("marks the active responder failed and later responders not run after a provider error", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0 },
            { waifuId: "mika", delaySeconds: 0 }
          ],
          reasoning: "Yuki then Mika."
        };
      },
      async generateWaifu() {
        throw new Error("waifu provider failed");
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.status).toBe("failed");
    expect(decision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      status: outcome.status,
      reason: outcome.reason
    }))).toEqual([
      { waifuId: "yuki", status: "failed", reason: "waifu provider failed" },
      { waifuId: "mika", status: "not_run", reason: "previous_responder_failed" }
    ]);
    expect(discord.sent).toEqual([]);
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
          action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer" }, replyToMessageId: "m1" }],
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
          action: "reply",
          respondingWaifus: [
            {
              waifuId: "yuki",
              delaySeconds: 0,
              
              directive: { intent: "spotlight", goal: "answer" },
              replyToMessageId: "m1"
            },
            { waifuId: "mika", delaySeconds: 5 }
          ],
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
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);

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
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const interruptedDecision = history.decisions.find(
      (entry) => entry.action === "reply" && entry.status === "interrupted"
    );
    expect(interruptedDecision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      status: outcome.status,
      messageCount: outcome.messageIds.length
    }))).toEqual([
      { waifuId: "yuki", status: "interrupted", messageCount: 1 },
      { waifuId: "mika", status: "interrupted", messageCount: 0 }
    ]);
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

  it("records a successful memory-only waifu turn as tool_only", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await enableShortTermMemory(storage, "yuki");

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Remember the plan."
        };
      },
      async generateWaifu() {
        return {
          content: "",
          shortTermMemoryEntries: ["Kevin is leaving at 5pm."]
        };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent).toEqual([]);
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.responderOutcomes).toMatchObject([
      {
        waifuId: "yuki",
        source: "orchestrator",
        status: "tool_only",
        messageIds: []
      }
    ]);
  });

  it("persists short-term entries returned by a waifu and shows them in her next system prompt", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await enableShortTermMemory(storage, "yuki");
    await enableWaifus(storage, ["yuki"]);

    let waifuRun = 0;
    const capturedSystemPrompts: string[] = [];
    const capturedTrailingBlocks: Array<string | undefined> = [];
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "talk"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        capturedSystemPrompts.push(request.systemPrompt);
        capturedTrailingBlocks.push(request.trailingSystemBlock);
        waifuRun += 1;
        if (waifuRun === 1) {
          return {
            content: "noted",
            shortTermMemoryEntries: [
              "Kevin is heading out at 5pm.",
              "Kevin prefers green tea today.",
              "extra 3",
              "extra 4",
              "extra 5",
              "extra 6 should be dropped",
              "extra 7 should be dropped"
            ]
          };
        }
        return { content: "ok" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");

    const stored = await storage.readJson("user/short-term-memories.json", ShortTermMemoryStoreSchema);
    expect(stored.entries).toHaveLength(5);
    expect(stored.entries.map((entry) => entry.content)).toEqual([
      "Kevin is heading out at 5pm.",
      "Kevin prefers green tea today.",
      "extra 3",
      "extra 4",
      "extra 5"
    ]);
    expect(stored.entries[0]).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-1",
      waifuId: "yuki"
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    const secondPrompt = capturedSystemPrompts[1];
    expect(secondPrompt).not.toMatch(/<short_term_memory>/);
    expect(secondPrompt).not.toContain("<memories>");
    expect(secondPrompt).not.toContain("<relevant_memories>\n");
    expect(secondPrompt).not.toContain("<yuki_relevant_memories>\n");
    const secondMemoriesBlock = capturedTrailingBlocks[1];
    expect(secondMemoriesBlock).toBeDefined();
    expect(secondMemoriesBlock).toMatch(/<yuki_relevant_memories>[\s\S]*Kevin is heading out at 5pm\.[\s\S]*Kevin prefers green tea today\.[\s\S]*<\/yuki_relevant_memories>/);
    expect(secondMemoriesBlock).not.toMatch(/<short_term>/);
    expect(secondMemoriesBlock).not.toMatch(/<long_term>/);
  });

  it("does not expose or persist add_memory when the server toggle is disabled", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await enableWaifus(storage, ["yuki"]);
    await setServerTools(storage, { shortTermMemory: false });

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "talk"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        checked = true;
        expect(request.shortTermMemoryToolEnabled).toBe(false);
        expect(request.systemPrompt).not.toContain("add_memory");
        return {
          content: "noted",
          shortTermMemoryEntries: ["Kevin is heading out at 5pm."]
        };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    const stored = await storage.readJson(
      "user/short-term-memories.json",
      ShortTermMemoryStoreSchema,
      ShortTermMemoryStoreSchema.parse(createEmptyRevisionedFile({ entries: [] }))
    );
    expect(checked).toBe(true);
    expect(stored.entries).toEqual([]);
  });

  it("scopes short-term memories per waifu — waifu B does not see waifu A's notes", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "mika persona");
    await enableShortTermMemory(storage, "yuki");
    await enableShortTermMemory(storage, "mika");
    await enableWaifus(storage, ["yuki", "mika"]);

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await storage.writeJson(
      "short-term-memories:global",
      "user/short-term-memories.json",
      ShortTermMemoryStoreSchema,
      ShortTermMemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          entries: [
            {
              id: "yuki-1",
              guildId: "guild-1",
              channelId: "channel-1",
              waifuId: "yuki",
              content: "Kevin promised to ping Yuki tonight.",
              createdAt: now,
              expiresAt
            }
          ]
        })
      )
    );

    const memoriesByWaifu = new Map<string, string | undefined>();
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "mika", delaySeconds: 0 }],
          reasoning: "mika answers"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        // Identity block: "You are {Name}, chatting..." — match the name before the comma.
        const match = request.systemPrompt.match(/You are (\w+),/);
        if (match) memoriesByWaifu.set(match[1], request.trailingSystemBlock);
        return { content: "ok" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(memoriesByWaifu.has("Mika")).toBe(true);
    const mikaMemories = memoriesByWaifu.get("Mika");
    // Mika has no notes of her own, so the trailing memories block should be undefined or not contain Yuki's note.
    if (mikaMemories) {
      expect(mikaMemories).not.toContain("Kevin promised to ping Yuki tonight.");
    }
  });

  it("drops expired short-term entries from the file on next write and omits them from the prompt", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await enableShortTermMemory(storage, "yuki");
    await enableWaifus(storage, ["yuki"]);

    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const longAgoExpired = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await storage.writeJson(
      "short-term-memories:global",
      "user/short-term-memories.json",
      ShortTermMemoryStoreSchema,
      ShortTermMemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          entries: [
            {
              id: "expired",
              guildId: "guild-1",
              channelId: "channel-1",
              waifuId: "yuki",
              content: "stale note from yesterday",
              createdAt: longAgo,
              expiresAt: longAgoExpired
            }
          ]
        })
      )
    );

    let capturedSystemPrompt = "";
    let capturedTrailingBlock: string | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "talk"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        capturedSystemPrompt = request.systemPrompt;
        capturedTrailingBlock = request.trailingSystemBlock;
        return {
          content: "fresh",
          shortTermMemoryEntries: ["Kevin is back from lunch."]
        };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(capturedSystemPrompt).not.toContain("stale note from yesterday");
    expect(capturedTrailingBlock ?? "").not.toContain("stale note from yesterday");
    const after = await storage.readJson("user/short-term-memories.json", ShortTermMemoryStoreSchema);
    expect(after.entries.map((entry) => entry.content)).toEqual(["Kevin is back from lunch."]);
  });

  it("honors the first directive and strips the next one inside the cooldown window", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hello there")],
      [contextMessage("w1", "waifu", "Yuki", "first reply")],
      [contextMessage("m2", "user", "Kevin", "totally different topic")],
      [contextMessage("w2", "waifu", "Yuki", "second reply")]
    ];

    await seedRuntimeConfig(storage);

    const waifuTrailingBlocks: string[] = [];
    const pipeline: ModelPipeline = {
      decisions: [
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "change_topic", goal: "talk about food" } }
          ],
          reasoning: "open with a directive"
        },
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "change_topic", goal: "talk about food" } }
          ],
          reasoning: "second directive inside cooldown"
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ] as OrchestratorDecision[],
      async decideOrchestrator() {
        const decision = (this as unknown as { decisions: OrchestratorDecision[] }).decisions.shift();
        if (!decision) throw new Error("No fake decision left.");
        return decision;
      },
      async generateWaifu(request) {
        waifuTrailingBlocks.push(request.trailingSystemBlock ?? "");
        return { content: "ok" };
      }
    } as ModelPipeline & { decisions: OrchestratorDecision[] };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(waifuTrailingBlocks).toHaveLength(2);
    expect(waifuTrailingBlocks[0]).toContain("director_note");
    expect(waifuTrailingBlocks[0]).toContain("(change topic) talk about food");
    expect(waifuTrailingBlocks[1]).not.toContain("director_note");

    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const replyDecisions = history.decisions.filter((entry) => entry.action === "reply");
    // Newest first: index 0 is the second (stripped) decision.
    expect(replyDecisions[0]?.responderOutcomes[0]?.directiveStripped).toBe("cooldown");
    expect(replyDecisions[1]?.responderOutcomes[0]?.directiveStripped).toBeUndefined();
  });

  it("strips an over-cap goal regardless of budget", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hello there")],
      [contextMessage("w1", "waifu", "Yuki", "reply")]
    ];

    await seedRuntimeConfig(storage);

    const overCapGoal = "x".repeat(150);
    let waifuTrailing = "";
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "change_topic", goal: overCapGoal } }
          ],
          reasoning: "over-cap directive"
        };
      },
      async generateWaifu(request) {
        waifuTrailing = request.trailingSystemBlock ?? "";
        return { content: "ok" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(waifuTrailing).not.toContain("director_note");
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const reply = history.decisions.find((entry) => entry.action === "reply");
    expect(reply?.responderOutcomes[0]?.directiveStripped).toBe("over_cap");
  });

  it("manual /run scene direction bypasses budget and cap", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello there")]];

    await seedRuntimeConfig(storage);

    const longDirection = "y".repeat(150);
    let waifuTrailing = "";
    let resolveGenerated: () => void = () => undefined;
    const generated = new Promise<void>((resolve) => {
      resolveGenerated = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu(request) {
        waifuTrailing = request.trailingSystemBlock ?? "";
        resolveGenerated();
        return { content: "ok" };
      },
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "after directed run" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });
    await runtime.start();

    await discord.emitRunCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "runner-user",
      waifuId: "yuki",
      sceneDirection: longDirection,
      respond: async () => undefined
    });
    await Promise.race([
      generated,
      new Promise((_, reject) => setTimeout(() => reject(new Error("waifu did not generate")), 1000))
    ]);
    await runtime.stop();

    expect(waifuTrailing).toContain("director_note");
    expect(waifuTrailing).toContain(longDirection);
  });

  it("passes a wake marker to the orchestrator on a scheduled retrigger", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello there")]];

    await seedRuntimeConfig(storage);
    await seedOrchestratorHistory(storage, [
      {
        id: "past-no-reply",
        guildId: "guild-1",
        channelId: "channel-1",
        action: "no_reply",
        respondingWaifus: [],
        retriggerAfterSeconds: 600,
        wakePlan: "have yuki answer",
        reasoning: "quiet for now",
        status: "completed",
        waifuMessageIds: [],
        responderOutcomes: [],
        createdAt: new Date().toISOString()
      }
    ]);

    let capturedMarkers: ProviderRequest["decisionMarkers"];
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        capturedMarkers = request.decisionMarkers;
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 200, reasoning: "still quiet" };
      },
      async generateWaifu() {
        return { content: "unused" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", { trigger: "retrigger" });
    await runtime.stop();

    expect(capturedMarkers?.[0]?.kind).toBe("wake");
    expect(capturedMarkers?.[0]?.scheduledSeconds).toBe(600);
    expect(capturedMarkers?.[0]?.wakePlan).toBe("have yuki answer");
  });

  it("enforces escalating backoff when a timer-fired pass chooses no_reply again", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello there")]];

    await seedRuntimeConfig(storage);
    await seedOrchestratorHistory(storage, [
      {
        id: "past-no-reply",
        guildId: "guild-1",
        channelId: "channel-1",
        action: "no_reply",
        respondingWaifus: [],
        retriggerAfterSeconds: 600,
        wakePlan: "have yuki answer",
        reasoning: "quiet for now",
        status: "completed",
        waifuMessageIds: [],
        responderOutcomes: [],
        createdAt: new Date().toISOString()
      }
    ]);

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "still quiet" };
      },
      async generateWaifu() {
        return { content: "unused" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    const before = Date.now();
    await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", { trigger: "retrigger" });
    await runtime.stop();

    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.scheduledRetriggerAt).toBeDefined();
    const scheduledInSeconds = (Date.parse(session.scheduledRetriggerAt!) - before) / 1000;
    expect(scheduledInSeconds).toBeGreaterThanOrEqual(900);
  });

  it("loop notice reaches the trailing prompt and unlocks the budget", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    // First decision honors a directive (closing the budget). The second turn's context trips the
    // loop detector, which should reopen the budget so the second directive is honored anyway.
    const loopyContext = [
      contextMessage("c1", "user", "Kevin", "what about the weekend trip plans"),
      contextMessage("w1", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"),
      contextMessage("w2", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"),
      contextMessage("w3", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"),
      contextMessage("w4", "waifu", "Yuki", "the weekend trip plans sound fun and exciting")
    ];
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hello there")],
      [contextMessage("w0", "waifu", "Yuki", "first reply")],
      loopyContext,
      loopyContext
    ];

    await seedRuntimeConfig(storage);

    const waifuTrailingBlocks: string[] = [];
    const trailingPrompts: string[] = [];
    const pipeline: ModelPipeline = {
      decisions: [
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "change_topic", goal: "talk about food" } }
          ],
          reasoning: "open with a directive"
        },
        {
          action: "reply",
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 0, directive: { intent: "break_loop", goal: "switch gears entirely" } }
          ],
          reasoning: "break the loop with a directive"
        },
        { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, reasoning: "done" }
      ] as OrchestratorDecision[],
      async decideOrchestrator(request) {
        trailingPrompts.push(request.trailingPrompt ?? "");
        const decision = (this as unknown as { decisions: OrchestratorDecision[] }).decisions.shift();
        if (!decision) throw new Error("No fake decision left.");
        return decision;
      },
      async generateWaifu(request) {
        waifuTrailingBlocks.push(request.trailingSystemBlock ?? "");
        return { content: "ok" };
      }
    } as ModelPipeline & { decisions: OrchestratorDecision[] };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 3,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(waifuTrailingBlocks).toHaveLength(2);
    // Budget was closed after the first honored directive, but the loop notice reopened it.
    expect(waifuTrailingBlocks[1]).toContain("director_note");
    expect(waifuTrailingBlocks[1]).toContain("(break loop) switch gears entirely");
    // The second orchestrator turn saw the loop notice in its trailing prompt.
    expect(trailingPrompts[1]).toContain("runtime_notice");
  });

  it("W2: strips a guild-nickname self-prefix from the reply and sends the cleaned content", async () => {
    // Aria is configured as displayName "Aria" but her prior message in context has
    // displayName "K的小娇妻" (her guild nickname). The pipeline returns a prefixed reply
    // mimicking that nickname. The runtime must strip it rather than drop the whole message,
    // and must pass selfAuthorIds containing her botId on the generateWaifu request.
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    // Context: one user message, then Aria's own prior message under her guild nickname
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "hey"),
        {
          ...contextMessage("m2", "waifu", "Aria", "hi Kevin", undefined, { authorId: "aria-bot" }),
          displayName: "K的小娇妻"
        }
      ],
      [
        contextMessage("m1", "user", "Kevin", "hey"),
        {
          ...contextMessage("m2", "waifu", "Aria", "hi Kevin", undefined, { authorId: "aria-bot" }),
          displayName: "K的小娇妻"
        }
      ]
    ];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "aria", "Aria", "aria-bot", "playful");
    await enableWaifus(storage, ["aria"]);

    let capturedRequest: WaifuGenerationRequest | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "aria", delaySeconds: 0 }],
          reasoning: "Aria should reply."
        };
      },
      async generateWaifu(request) {
        capturedRequest = request;
        // Model emits with guild-nickname prefix — the bug scenario
        return { content: "K的小娇妻: my actual reply" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    // The prefix must be stripped — not dropped entirely
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0].content).toBe("my actual reply");
    // selfAuthorIds must include Aria's botId
    expect(capturedRequest?.selfAuthorIds).toContain("aria-bot");
  });

  it("uses guild display name from members.json for serverNickname in identity block", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    // Seed members.json with yuki's botId having a different guild display name.
    await storage.writeJson(
      "members:guild-1",
      "user/servers/guild-1/members.json",
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(
        createEmptyRevisionedFile({
          guildId: "guild-1",
          members: [
            {
              userId: "yuki-bot",
              guildDisplayName: "K的小娇妻",
              bot: true,
              perChannelLastSeenAt: {}
            }
          ]
        })
      )
    );

    let checked = false;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki should reply."
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        checked = true;
        expect(request.systemPrompt).toContain(`shown in this server as "K的小娇妻"`);
        return { content: "hi" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(checked).toBe(true);
  });
});

async function enableShortTermMemory(storage: StorageService, waifuId: string) {
  void waifuId;
  await setServerTools(storage, { shortTermMemory: true });
}

async function setServerTools(
  storage: StorageService,
  tools: Partial<{ pickNextWaifu: boolean; shortTermMemory: boolean }>
) {
  const path = "user/servers/guild-1/server.json";
  const config = await storage.readJson(path, ServerConfigSchema);
  await storage.writeJson(
    "server:guild-1",
    path,
    ServerConfigSchema,
    ServerConfigSchema.parse({
      ...config,
      tools: { ...config.tools, ...tools }
    })
  );
}

async function setWaifuToolUse(storage: StorageService, waifuId: string, toolUse: boolean) {
  const path = `user/waifus/${waifuId}/waifu.json`;
  const config = await storage.readJson(path, WaifuConfigSchema);
  await storage.writeJson(
    `waifu:${waifuId}`,
    path,
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...config,
      tools: { ...config.tools, toolUse }
    })
  );
}

// Helper to disable specific W2 block IDs in a waifu's stored prompt layout.
async function setWaifuBlocksEnabled(
  storage: StorageService,
  waifuId: string,
  blockEnabled: Record<string, boolean>
) {
  const filePath = `user/waifus/${waifuId}/waifu.json`;
  const config = await storage.readJson(filePath, WaifuConfigSchema);
  const layout = defaultWaifuPromptLayout();
  const setEnabled = (blockId: string, enabled: boolean) => {
    for (const section of [layout.top, layout.mid, layout.trailing]) {
      for (const node of section) {
        if (node.kind === "block") {
          if (node.blockId === blockId) node.enabled = enabled;
        } else {
          for (const child of node.children) {
            if (child.blockId === blockId) child.enabled = enabled;
          }
        }
      }
    }
  };
  for (const [blockId, enabled] of Object.entries(blockEnabled)) {
    setEnabled(blockId, enabled);
  }
  await storage.writeJson(
    `waifu:${waifuId}`,
    filePath,
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...config,
      promptLayout: layout
    })
  );
}

async function seedRuntimeConfig(storage: StorageService, orchestratorConfig: Record<string, unknown> = {}) {
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
      prompt: "decide",
      ...orchestratorConfig
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
        toolUse: true
      }
    })
  );
}

async function seedOrchestratorHistory(
  storage: StorageService,
  decisions: Array<Record<string, unknown>>
) {
  await storage.writeJson(
    "orchestrator:history",
    "user/orchestrator/history.json",
    OrchestratorHistoryFileSchema,
    OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions }))
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
        toolUse: true
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

async function seedActiveParticipants(
  storage: StorageService,
  participants: Array<{ userId: string; displayName: string }>
) {
  const now = Date.now();
  await storage.writeJson(
    "active-chat-participants:guild-1:channel-1",
    "user/servers/guild-1/active-chat-participants/channel-1.json",
    ActiveChatParticipantsFileSchema,
    ActiveChatParticipantsFileSchema.parse(
      createEmptyRevisionedFile({
        guildId: "guild-1",
        channelId: "channel-1",
        participants: participants.map((participant) => ({
          ...participant,
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString()
        }))
      })
    )
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

function expectedDirectorNote(text: string): string {
  return `<director_note>\nDirector's goal for this one message: ${text}\nPursue the goal in your own voice and words; never quote or restate this note.\n</director_note>`;
}

function contextMessage(
  id: string,
  authorKind: "user" | "waifu",
  displayName: string,
  content: string,
  sourceMessageIds?: string[],
  options: { authorBot?: boolean; authorId?: string } = {}
): ContextMessage {
  return {
    id,
    channelId: "channel-1",
    guildId: "guild-1",
    authorKind,
    authorId: options.authorId ?? (authorKind === "user" ? "u1" : "yuki-bot"),
    authorBot: options.authorBot,
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForActiveParticipants(
  storage: StorageService,
  channelId: string,
  predicate: (file: { participants: Array<{ displayName: string }> }) => boolean
) {
  const fallback = ActiveChatParticipantsFileSchema.parse(
    createEmptyRevisionedFile({ guildId: "guild-1", channelId, participants: [] })
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const file = await storage.readJson(
      `user/servers/guild-1/active-chat-participants/${channelId}.json`,
      ActiveChatParticipantsFileSchema,
      fallback
    );
    if (predicate(file)) return file;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for active chat participants");
}

function quietLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
