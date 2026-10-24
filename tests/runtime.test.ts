import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator, currentlyDoingForWaifu, DreamPassResult } from "../src/orchestration/runtime.js";
import { redactPrivateMemories } from "../src/orchestration/commands.js";
import { ContextMessage } from "../src/orchestration/contextMessages.js";
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
  ProviderRequest,
  StageManagerObserveRequest,
  WaifuGenerationRequest
} from "../src/providers/types.js";
import { GatewayPipelineError } from "../src/orchestration/pipeline/params.js";
import type { BuiltPrompt } from "../src/orchestration/context/types.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import {
  ActiveChatParticipantsFileSchema,
  AgentConfigSchema,
  DiscordBotConfig,
  DiscordBotsFileSchema,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  MemoryStoreSchema,
  OrchestratorDebugConfigFileSchema,
  OrchestratorHistoryFileSchema,
  PendingObservationsFileSchema,
  ProviderCredentialsFileSchema,
  ReviewerHistoryFileSchema,
  ServerConfigSchema,
  StageManagerHistoryFileSchema,
  WaifuConfig,
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
  /** When set, sendWaifuMessage rejects with it (a Discord API error such as { code: 50083 }). */
  sendError: unknown;
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
    if (this.sendError) throw this.sendError;
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
    // Spec 8.5 waifu harness through the context engine (one system message, epoch header,
    // append-only transcript with this turn's direction note, ephemeral tail).
    const prompt = promptOf(request);
    expect(prompt.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(prompt.messages[0]!.role).toBe("system");
    expect(prompt.debug.system).toMatch(/^<harness>\nYou are chatting in a live Discord text channel/);
    expect(prompt.debug.system).toContain("<identity>\nYou are Yuki.");
    expect(prompt.debug.system).toContain("<persona>\nkind\n</persona>");
    expect(prompt.debug.system).toMatch(
      /<schedule>[\s\S]*Sleep: 23:00-07:00 daily[\s\S]*09:00-10:00: school focus block[\s\S]*<\/schedule>/
    );
    expect(prompt.debug.system).toContain("<style>\nKeep messages short");
    expect(prompt.debug.system).not.toContain("replying to >");
    expect(prompt.debug.header).toContain("<memories>\n- Yuki remembers Kevin likes tea (fact");
    expect(prompt.debug.header).toContain("<place>");
    expect(prompt.debug.transcript).toMatch(/\[\d\d:\d\d #a0\] Kevin: hello/);
    // This turn's direction rides in the tail of the call it steers (persisted only at commit).
    expect(prompt.debug.tail).toContain("<direction>(spotlight) answer Kevin, then pull in Mira</direction>");
    expect(prompt.debug.transcript).not.toContain("<direction>(spotlight)");
    expect(prompt.debug.tail).toMatch(/Write Yuki's next message\.$/);
    expect(request.stopSequences).toEqual(["\n[", "\nYuki:"]);
    return { content: "hello <@Kevin> <:cutecat:>" };
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    // Spec 8.7: the context engine builds the director's prompt — one system message (director
    // rules + static casting cards), the epoch header, the transcript and the ephemeral tail.
    const prompt = request.prompt!;
    expect(prompt).toBeDefined();
    expect(prompt.promptCacheKey).toBe("orchestrator:g_guild-1_channel-1");
    expect(prompt.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(prompt.debug.system).toContain("<director>");
    expect(prompt.debug.system).toContain("<policy>");
    expect(prompt.debug.system).toMatch(/<cast>\n<waifu>\nid: yuki · Yuki · sees images natively\nAbout: kind\n<\/waifu>\n<\/cast>/);
    // Static: no clock, no availability, no per-pass state in the system prompt.
    expect(prompt.debug.system).not.toMatch(/Now:|Reply required|Directive budget/);
    // Availability lives only in the tail (it changes mid-epoch); the header is the place.
    expect(prompt.debug.header).toMatch(/^<place>.*<\/place>$/);
    expect(prompt.debug.tail).toMatch(/Cast right now:\n- yuki \(Yuki\): /);
    expect(prompt.debug.transcript).toMatch(/\[\d\d:\d\d #a0\] Kevin: hello/);
    expect(prompt.debug.tail).toMatch(/^<status>\nNow: [\s\S]*Reply required: no\.[\s\S]*Directive budget: [\s\S]*<\/status>\nCall orchestrator_decision\.$/);
    expect(prompt.tools.map((tool) => tool.name)).toEqual(["orchestrator_decision"]);
    expect(request.availableWaifuIds).toEqual(["yuki"]);
    const decision = this.decisions.shift();
    if (!decision) throw new Error("No fake decision left.");
    return decision;
  }
}

describe("RuntimeOrchestrator", () => {
  describe("One shot mode", () => {
    async function setup() {
      const root = await makeTempRoot(); roots.push(root); await ensureDataLayout(root);
      const storage = new StorageService(root); await seedRuntimeConfig(storage, { modelId: null });
      const server = await storage.readJson("user/servers/guild-1/server.json", ServerConfigSchema);
      await storage.writeJson("server:guild-1", "user/servers/guild-1/server.json", ServerConfigSchema, { ...server, orchestratorMode: "one-shot", stageManagerEnabled: false });
      const discord = new FakeDiscord(); const pipeline = new FakePipeline();
      const generate = vi.fn(async () => ({ content: "one shot response" }));
      pipeline.generateWaifu = generate;
      const native = vi.fn(async () => ({ decision: { action: "reply" as const, respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "one_shot: fixture" }, loopDetected: false }));
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const runtime = new RuntimeOrchestrator({ storage, discord, logger, maxAutomaticTurns: 1, sleep: async () => undefined,
        createPipeline: (target) => { expect(target.queryRole).not.toBe("orchestrator"); return pipeline; }, decideOneShot: native });
      return { runtime, discord, native, storage, logger, generate };
    }
    it("runs the third mode even without a global LLM model, then uses the waifu's own generation", async () => {
      const s = await setup();
      try {
        await s.runtime.triggerChannel("guild-1", "channel-1");
        expect(s.native).toHaveBeenCalledTimes(1);
        expect(s.native.mock.calls[0][0]).toMatchObject({ target: "openrouter:cloudflare/clef" });
        expect(s.discord.sent).toHaveLength(1); expect(s.generate).toHaveBeenCalledTimes(1);
        const history = await s.storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
        expect(history.decisions[0].reasoning).toBe("one_shot: fixture");
      } finally { await s.runtime.stop(); }
    });
    // T5 review C1: one-shot keeps its old input size even though the transcript may be longer.
    it("hands one-shot only the newest window of the transcript", async () => {
      const s = await setup();
      s.discord.contexts = [
        Array.from({ length: 30 }, (_, i) => ({
          ...contextMessage(`m${i}`, "user", "Kevin", `message ${i}`),
          timestamp: new Date(Date.parse("2026-05-16T12:00:00Z") + i * 60_000).toISOString()
        }))
      ];
      try {
        await s.runtime.triggerChannel("guild-1", "channel-1");
        const input = s.native.mock.calls[0][0] as { messages: Array<{ content: string }>; timeZone?: string };
        expect(input.messages.length).toBeLessThanOrEqual(20);
        expect(input.messages.at(-1)?.content).toBe("message 29");
        expect(input.timeZone).toBeDefined();
      } finally { await s.runtime.stop(); }
    });
    it("uses the existing deterministic fallback automatically without logging unrestricted errors", async () => {
      const s = await setup(); s.native.mockRejectedValue(new Error("private provider payload"));
      try {
        await s.runtime.triggerChannel("guild-1", "channel-1");
        expect(s.logger.warn).toHaveBeenCalledWith("One shot failed; deterministic fallback decision used", expect.objectContaining({ code: "one_shot_failed" }));
        expect(JSON.stringify(s.logger.warn.mock.calls)).not.toContain("private provider payload");
      } finally { await s.runtime.stop(); }
    });
    it("surfaces a required manual pass failure instead of silently falling back", async () => {
      const s = await setup(); s.native.mockRejectedValue(new Error("one_shot_http_400"));
      try {
        await s.runtime.triggerChannel("guild-1", "channel-1", "manual", { firstOrchestratorMustReply: true });
        expect(s.logger.error).toHaveBeenCalledWith("Channel runtime loop failed", expect.objectContaining({ message: "one_shot_http_400" }));
        expect(s.generate).not.toHaveBeenCalled();
      } finally { await s.runtime.stop(); }
    });
  });
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
              guildId: "guild-1",
              content: "Yuki remembers Kevin likes tea.",
              strength: 3,
              createdAt: now,
              updatedAt: now,
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

  it.each([
    { code: 50083, status: "unavailable", reason: "thread_archived" },
    { code: 200000, status: "blocked", reason: "automod" },
    { code: 200001, status: "blocked", reason: "automod" }
  ])("records a Discord send error $code as $status/$reason instead of crashing the decision", async ({ code, status, reason }) => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.sendError = Object.assign(new Error(`Discord error ${code}`), { code });
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
              guildId: "guild-1",
              content: "Yuki remembers Kevin likes tea.",
              strength: 3,
              createdAt: now,
              updatedAt: now,
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
      createPipeline: () => new FakePipeline(),
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(discord.sent).toEqual([]);
    const history = await readDecisionHistory(storage);
    const reply = history.decisions.find((entry) => entry.action === "reply");
    expect(reply?.responderOutcomes[0]).toMatchObject({ waifuId: "yuki", status, reason });
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

    let orchestratorTranscript = "";
    let waifuTranscript = "";
    const ocr = {
      enrichMessages: vi.fn(async (messages: ContextMessage[]) =>
        messages.map((message) => ({
          ...message,
          images: message.images?.map((image) => ({ ...image, ocrText: "Start chatting with Instant" }))
        }))
      ),
      // Both contexts freeze a non-inline image to its cached OCR text (spec 8.4).
      cachedText: vi.fn(async () => "Start chatting with Instant")
    };
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        orchestratorTranscript = request.prompt!.debug.transcript;
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "image text is useful"
        };
      },
      async generateWaifu(request) {
        waifuTranscript = promptOf(request).debug.transcript;
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

    // Both context-engine prompts read the frozen image text.
    expect(orchestratorTranscript).toContain("[image: Start chatting with Instant]");
    expect(waifuTranscript).toContain("[image: Start chatting with Instant]");
    expect(discord.sent[0].content).toBe("Got it.");
  });

  it("runs bounded OCR (ocr.textFor) for text-only models when nothing is cached yet", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const imageMessage = imageContextMessage();
    discord.contexts = [[imageMessage], [imageMessage]];
    await seedRuntimeConfig(storage);
    await setPrimaryRuntimeModel(storage, "deepseek", "deepseek-v4-pro");

    let orchestratorTranscript = "";
    let waifuTranscript = "";
    const ocr = {
      enrichMessages: vi.fn(async (messages: ContextMessage[]) => messages),
      cachedText: vi.fn(async () => undefined),
      textFor: vi.fn(async (_ref: unknown, o: { timeoutMs: number }) => (o.timeoutMs > 0 ? "Fresh OCR text" : undefined))
    };
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        orchestratorTranscript = request.prompt!.debug.transcript;
        return { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "image" };
      },
      async generateWaifu(request) {
        waifuTranscript = promptOf(request).debug.transcript;
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

    expect(ocr.textFor).toHaveBeenCalled();
    expect(orchestratorTranscript).toContain("[image: Fresh OCR text]");
    expect(waifuTranscript).toContain("[image: Fresh OCR text]");
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
    let waifuTranscript = "";
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "continue"
        };
      },
      async generateWaifu(request) {
        waifuTranscript = promptOf(request).debug.transcript;
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

    // No cached OCR text (and no textFor): the image freezes to the bare placeholder. The legacy
    // enrichment no longer runs on the reply path (both prompts use the context engine).
    expect(waifuTranscript).toContain("[image]");
    expect(discord.sent[0].content).toBe("Still works.");
    expect(warn).not.toHaveBeenCalledWith("OCR enrichment failed; continuing without OCR text", expect.anything());
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
        if (promptOf(request).debug.system.includes("You are Yuki")) {
          this.events.push("waifu:yuki");
          expect(request.availableWaifuIds).toEqual(["mika"]);
          expect(promptOf(request).tools.some((tool) => tool.name === "PickNextWaifu")).toBe(true);
          expect(promptOf(request).debug.system).toContain("<tools>");
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
        if (promptOf(request).debug.system.includes("You are Yuki")) {
          events.push("yuki");
          return { content: "Aria, jump in.", pickedNextWaifuId: "aria" };
        }
        if (promptOf(request).debug.system.includes("You are Aria")) {
          events.push("aria");
          return { content: "I am here." };
        }
        events.push("mika");
        expect(promptText(request)).toContain(
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
        if (promptOf(request).debug.system.includes("You are Yuki")) {
          events.push("yuki");
          return { content: "Aria should answer now.", pickedNextWaifuId: "aria" };
        }
        if (promptOf(request).debug.system.includes("You are Aria")) {
          events.push("aria");
          expect(promptText(request)).toContain(
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
        expect(promptOf(request).tools.some((tool) => tool.name === "PickNextWaifu")).toBe(false);
        expect(promptOf(request).debug.system).not.toContain("PickNextWaifu");
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
        // Casting cards are static system content now (spec 8.7).
        expect(request.prompt!.debug.system).toContain("id: yuki");
        expect(request.prompt!.debug.system).not.toContain("id: mika");
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
        expect(promptOf(request).tools.some((tool) => tool.name === "PickNextWaifu")).toBe(true);
        expect(promptOf(request).tools.some((tool) => tool.name === "add_memory")).toBe(true);
        expect(promptOf(request).debug.system).not.toContain("<tools>");
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

  it("truncates the casting-card persona to 200 chars and never sends the rest of the raw persona", async () => {
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
    let wholePrompt: string | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request: ProviderRequest) {
        trailingPrompt = request.prompt!.debug.system;
        wholePrompt = JSON.stringify(request.prompt!.messages);
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
    // Nothing in the request carries the persona beyond the card's 200 chars
    expect(wholePrompt).toBeDefined();
    expect(wholePrompt).not.toContain(normalised.slice(200));
  });

  it("uses Voice/Cast-her-when lines in casting card when personaDigest is set", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[{ id: "m1", channelId: "channel-1", guildId: "guild-1", authorKind: "user", authorId: "u1", authorBot: false, name: "Kevin", displayName: "Kevin", content: "hi", timestamp: "2026-05-16T12:00:00Z", reactions: [] }]];

    await seedRuntimeConfig(storage);
    // Overwrite yuki with a personaDigest
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
        persona: "kind and bubbly",
        contextWindow: 50,
        personaDigest: {
          voice: "Speaks warmly and briefly.",
          role: "Fits when the room needs gentle energy.",
          personaHash: "abc123"
        }
      })
    );

    let trailingPrompt: string | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request: ProviderRequest) {
        trailingPrompt = request.prompt!.debug.system;
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
    // Digest path: Voice and Cast-her-when lines
    expect(trailingPrompt).toContain("Voice: Speaks warmly and briefly.");
    expect(trailingPrompt).toContain("Cast her when: Fits when the room needs gentle energy.");
    // About: line must NOT appear (digest path replaces it)
    expect(trailingPrompt).not.toContain("About:");
    // Raw persona text must not appear in casting card
    expect(trailingPrompt).not.toContain("kind and bubbly");
  });

  it("marks vision-capable waifus on casting cards and leaves text-only ones unmarked", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "look at this")]];

    // Seeded yuki runs openai gpt-5.4-mini (image input per registry); mika runs deepseek (text-only).
    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "waifu:mika",
      "user/waifus/mika/waifu.json",
      WaifuConfigSchema,
      WaifuConfigSchema.parse({
        ...createRevisionedBase(),
        id: "mika",
        name: "Mika",
        displayName: "Mika",
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        botId: "mika-bot",
        persona: "dry and sharp",
        contextWindow: 50
      })
    );
    await storage.writeJson(
      "server:guild-1",
      "user/servers/guild-1/server.json",
      ServerConfigSchema,
      ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId: "guild-1",
        channels: {
          "channel-1": { channelId: "channel-1", enabled: true, enabledWaifuIds: ["yuki", "mika"] }
        }
      })
    );

    let trailingPrompt: string | undefined;
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request: ProviderRequest) {
        trailingPrompt = request.prompt!.debug.system;
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
    expect(trailingPrompt).toContain("Yuki · sees images natively");
    expect(trailingPrompt).toContain("id: mika · Mika\n");
    expect(trailingPrompt).not.toContain("Mika · sees images natively");
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

    let header = "";
    let system = "";
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "talk"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        header = promptOf(request).debug.header;
        system = promptOf(request).debug.system;
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

    // Humans present (characters are in her identity roster; a human named like a character is
    // folded into the character, as before).
    expect(header).toContain("People here: Kevin, Mira\n");
    expect(system).toContain("The other character here is Mika, who writes their own messages; you write only yours.");
    expect(header).not.toContain("Old User");
    expect(header).not.toContain("Other Channel User");
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
        if (promptOf(request).debug.system.includes("You are Yuki")) {
          this.events.push("yuki");
          nowMs = 107_000;
          return { content: "one" };
        }
        if (promptOf(request).debug.system.includes("You are Mika")) {
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
        // History text differs from the replies below (her own "one" again would be a self-repeat).
        contextMessage("waifu-1", "waifu", "Yuki", "first"),
        contextMessage("waifu-2", "waifu", "Mika", "second"),
        contextMessage("waifu-3", "waifu", "Yuki", "third"),
        contextMessage("waifu-4", "waifu", "Mika", "fourth")
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
        return { content: promptOf(request).debug.system.includes("You are Yuki") ? "one" : "two" };
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

  it("does not treat another (non-waifu) bot's message as a recent human for delay pacing", async () => {
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
        contextMessage("bot-1", "user", "MEE6", "GG, you reached level 5", undefined, { authorBot: true, authorId: "mee6" })
      ]
    ];
    const sleepCalls: number[] = [];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await enableWaifus(storage, ["yuki", "mika"]);

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply" as const,
          respondingWaifus: [
            { waifuId: "yuki", delaySeconds: 3 },
            { waifuId: "mika", delaySeconds: 4 }
          ],
          reasoning: "Only a bot spoke; use chained pacing."
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        return { content: promptOf(request).debug.system.includes("You are Yuki") ? "first line" : "second line" };
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

    expect(sleepCalls).toEqual([3000, 4000]);
  });

  // Decisions replay as text lines, never assistant tool_use turns: with thinking on, Anthropic
  // rejects (400) a replayed tool_use that has no thinking block (T3 review).
  it("replays the director's own final decisions as frozen text lines, even for a thinking model", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const first = { ...contextMessage("m1", "user", "Kevin", "anyone around?"), timestamp: "2026-05-16T12:10:00Z" };
    const second = { ...contextMessage("m2", "user", "Kevin", "hello??"), timestamp: "2026-05-16T12:20:00Z" };
    discord.contexts = [[first], [first, second]];

    const prompts: NonNullable<ProviderRequest["prompt"]>[] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator(request: ProviderRequest) {
        prompts.push(request.prompt!);
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 180, wakePlan: "re-check", reasoning: "quiet" };
      }
    };

    await seedRuntimeConfig(storage);
    const orchestratorConfig = await storage.readJson("user/orchestrator/config.json", AgentConfigSchema);
    await storage.writeJson("orchestrator", "user/orchestrator/config.json", AgentConfigSchema, {
      ...orchestratorConfig,
      params: { ...orchestratorConfig.params, "reasoning.enabled": true, "reasoning.budgetTokens": 2048 }
    });
    // A stale history entry that predates this context never leaks into the prompt.
    await storage.writeJson(
      "orchestrator:history",
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(
        createEmptyRevisionedFile({
          decisions: [
            {
              id: "old-history",
              guildId: "guild-1",
              channelId: "channel-1",
              action: "no_reply",
              respondingWaifus: [],
              retriggerAfterSeconds: 300,
              reasoning: "from before the context existed",
              createdAt: "2026-05-16T12:09:00.000Z"
            }
          ]
        })
      )
    );
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.debug.transcript).not.toContain("[decision");
    expect(JSON.stringify(prompts[0]!.messages)).not.toContain("from before the context existed");
    // No assistant tool_use (nor tool result) can reach a thinking model's request.
    for (const prompt of prompts) {
      expect(prompt.messages.some((message) => message.role === "assistant" || message.role === "tool")).toBe(false);
    }
    // Append-only: the decision renders after the message it answered and before the new one.
    const transcript = prompts[1]!.debug.transcript;
    const line = transcript.match(/\[decision \d\d:\d\d\] no_reply 180s · plan: "re-check" · paused 180s/);
    expect(line).not.toBeNull();
    expect(transcript.indexOf("anyone around?")).toBeLessThan(transcript.indexOf(line![0]));
    expect(transcript.indexOf(line![0])).toBeLessThan(transcript.indexOf("hello??"));
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

  it("runs observer + dream end-to-end: queues an observation and the dream adds it", async () => {
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
        // B28: the stage manager's custom prompt reaches the observer.
        expect(request.systemPrompt).toBe("memories");
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        expect(request.observerInput).toContain("Transcript:");
        return [
          { waifuId: "yuki", content: "Kevin likes tea.", importance: 3, kind: "preference" as const }
        ];
      },
      async decideDream(request) {
        // The dream pass sees the queued observation (importance < 4 is not fast-tracked).
        expect(request.observations.map((observation) => observation.content)).toEqual(["Kevin likes tea."]);
        const observation = request.observations[0];
        return [
          {
            op: "add",
            memory: { waifuId: observation.waifuId, content: observation.content, kind: observation.kind, strength: observation.importance, entities: [] }
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
      origin: { guildId: "guild-1", channelId: "channel-1" },
      pinned: false,
      source: "dream",
      kind: "preference",
      strength: 3
    });
    expect(discord.sent).toEqual([]);

    // The queue is drained after the dream consumes the observation.
    const pending = await storage.readJson("user/memory/pending-observations.json", PendingObservationsFileSchema);
    expect(pending.observations).toHaveLength(0);

    const history = await storage.readJson(
      "user/stage-manager/history.json",
      StageManagerHistoryFileSchema
    );
    // Most recent entry is the dream add (mapped onto add_memory); the observer's queue summary is older.
    expect(history.edits[0].tool).toBe("add_memory");
    expect(history.edits[0].summary).toContain("[dream:add]");
  });

  it("observer cursor never re-reads: an unchanged window costs no model call, new messages are read once", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    await seedRuntimeConfig(storage);
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "I adopted a cat"), contextMessage("m2", "user", "Kevin", "her name is Miso")],
      [contextMessage("m1", "user", "Kevin", "I adopted a cat"), contextMessage("m2", "user", "Kevin", "her name is Miso")],
      [contextMessage("m1", "user", "Kevin", "I adopted a cat"), contextMessage("m2", "user", "Kevin", "her name is Miso"), contextMessage("m3", "user", "Kevin", "she is two")]
    ];
    const seen: string[][] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations(request: StageManagerObserveRequest) {
        seen.push(request.messages.map((message) => message.content));
        return [];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    expect((await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1")).status).toBe("no_change");
    expect((await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1")).status).toBe("no_change");
    await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");
    expect(seen).toEqual([["I adopted a cat", "her name is Miso"], ["she is two"]]);
    const state = await storage.readJson(
      "user/conversations/g_guild-1_channel-1/contexts/stage-manager.json",
      (await import("../src/shared/schemas/context.js")).ContextStateSchema
    );
    expect(state).toMatchObject({ agentId: "stage-manager", cursorSeq: null, cursorMessageId: "m3" });
  });

  it("requestObserveThrough reads the ledger through a seq in cursor-bounded batches (compaction handoff)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    await seedRuntimeConfig(storage);
    const server = await storage.readJson("user/servers/guild-1/server.json", ServerConfigSchema);
    await storage.writeJson("server:guild-1", "user/servers/guild-1/server.json", ServerConfigSchema, {
      ...server,
      contextWindows: { ...server.contextWindows, stageManager: 2 }
    });
    const { ConversationLedgerSchema } = await import("../src/shared/schemas/context.js");
    const entries = Object.fromEntries([1, 2, 3, 4, 5].map((seq) => [`10${seq}`, {
      id: `10${seq}`, seq, authorId: "u1", authorName: "Kevin", authorIsBot: false, at: "2026-10-23T11:00:00.000Z",
      kind: "default", body: `line ${seq}`, images: [], state: "live", sealed: false
    }]));
    await storage.writeJson("ledger:g_guild-1_channel-1", "user/conversations/g_guild-1_channel-1/ledger.json", ConversationLedgerSchema,
      ConversationLedgerSchema.parse(createEmptyRevisionedFile({ conversationKey: "g_guild-1_channel-1", nextSeq: 6, entries, events: [] })));
    const reads: string[] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations(request: StageManagerObserveRequest) {
        reads.push((request.observerInput ?? "").split("\n").filter((line) => line.includes("line ")).map((line) => line.replace(/.*: /, "")).join(","));
        expect(request.messages).toEqual([]);
        return [];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.memoryJobs.requestObserveThrough({ kind: "guild", guildId: "guild-1", channelId: "channel-1" }, 4);
    expect(reads).toEqual(["line 1,line 2", "line 3,line 4"]);
    // Already through 4: nothing to do.
    await runtime.memoryJobs.requestObserveThrough({ kind: "guild", guildId: "guild-1", channelId: "channel-1" }, 3);
    expect(reads).toHaveLength(2);
    // DM observers arrive in Phase 5: resolves immediately.
    await runtime.memoryJobs.requestObserveThrough({ kind: "dm", waifuId: "yuki", userId: "u1" }, 99);
    await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");
    expect(reads).toEqual(["line 1,line 2", "line 3,line 4", "line 5"]);
  });

  it("an observer response with no valid op fails the run and keeps the cursor, so the messages are re-read", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    await seedRuntimeConfig(storage);
    const window = [contextMessage("m1", "user", "Kevin", "I am allergic to peanuts")];
    discord.contexts = [window, window];
    const reads: number[] = [];
    let call = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations(request: StageManagerObserveRequest) {
        reads.push(request.messages.length);
        call += 1;
        // First response is entirely malformed; the second is valid.
        return call === 1
          ? ([{ op: "update" }, { garbage: true }] as never)
          : [{ op: "add" as const, waifuId: "yuki", content: "Kevin is allergic to peanuts.", kind: "fact" as const, importance: 5 as const, subjects: ["p1"] }];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    expect((await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1")).status).toBe("failed");
    expect((await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1")).status).toBe("updated");
    // The same message was offered again after the failed parse.
    expect(reads).toEqual([1, 1]);
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.map((memory) => memory.content)).toEqual(["Kevin is allergic to peanuts."]);
  });

  it("ignores a stale persisted stage-manager running flag left by a crash", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const { ChannelSessionStateSchema, createEmptyChannelSessionState } = await import("../src/orchestration/session.js");
    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "session:guild-1:channel-1",
      "user/servers/guild-1/sessions/channel-1.json",
      ChannelSessionStateSchema,
      {
        ...createEmptyChannelSessionState("guild-1", "channel-1"),
        stageManager: { active: true, startedAt: "2026-05-16T12:00:00.000Z" }
      }
    );
    let observerCalls = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        observerCalls += 1;
        return [];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    const result = await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");
    expect(result.status).not.toBe("already_running");
    expect(observerCalls).toBe(1);
  });

  it("still rejects a concurrent stage-manager run for the same channel in-process", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    await seedRuntimeConfig(storage);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        await gate;
        return [];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    const first = runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");
    const second = await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");
    release();
    expect(second.status).toBe("already_running");
    expect((await first).status).toBe("no_change");
  });

  it("appends low-importance observations (< 4) to the pending queue file", async () => {
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
          { waifuId: "yuki", content: "Kevin drinks tea.", importance: 2, kind: "preference" as const },
          { waifuId: "yuki", content: "Kevin owns a cat.", importance: 3, kind: "fact" as const }
        ];
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
    });

    // Observer-only: the dream pass (which would drain the queue) is exercised separately.
    await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");

    const pending = await storage.readJson("user/memory/pending-observations.json", PendingObservationsFileSchema);
    expect(pending.observations).toHaveLength(2);
    expect(pending.observations.every((obs) => obs.origin.guildId === "guild-1")).toBe(true);
    expect(pending.observations.every((obs) => obs.origin.channelId === "channel-1")).toBe(true);
    expect(pending.observations.every((obs) => obs.conversationKey === "g_guild-1_channel-1")).toBe(true);
    expect(pending.observations.map((obs) => obs.content).sort()).toEqual(
      ["Kevin drinks tea.", "Kevin owns a cat."].sort()
    );
    // These low-importance observations should NOT be in the memory store
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema, MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] })));
    expect(memories.memories.filter((m) => m.source === "stage_manager")).toHaveLength(0);
  });

  it("fast-tracks observations with importance >= 4 directly to the memory store", async () => {
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
          { waifuId: "yuki", content: "Kevin is allergic to peanuts.", importance: 4, kind: "fact" as const },
          { waifuId: "yuki", content: "Kevin's family runs a bakery.", importance: 5, kind: "relationship" as const },
          { waifuId: "yuki", content: "Kevin likes coffee.", importance: 2, kind: "preference" as const }
        ];
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
    });

    await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");

    // Fast-tracked records (importance >= 4) should be in the memory store
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    const fastTracked = memories.memories.filter((m) => m.source === "stage_manager");
    expect(fastTracked).toHaveLength(2);
    expect(fastTracked.map((m) => m.content).sort()).toEqual(
      ["Kevin is allergic to peanuts.", "Kevin's family runs a bakery."].sort()
    );
    expect(fastTracked.every((m) => m.strength >= 4)).toBe(true);

    // The low-importance one should NOT be fast-tracked but queued
    const pending = await storage.readJson("user/memory/pending-observations.json", PendingObservationsFileSchema);
    expect(pending.observations).toHaveLength(1);
    expect(pending.observations[0].content).toBe("Kevin likes coffee.");
  });

  it("history entries include queued and fastTracked counts", async () => {
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
          { waifuId: "yuki", content: "Kevin likes sushi.", importance: 3, kind: "preference" as const },
          { waifuId: "yuki", content: "Kevin is a chef.", importance: 5, kind: "fact" as const }
        ];
      }
    };

    await seedRuntimeConfig(storage);

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
    });

    await runtime.memoryJobs.startStageManagerRun("guild-1", "channel-1");

    const history = await storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema);
    expect(history.edits[0].summary).toContain("queued: 1");
    expect(history.edits[0].summary).toContain("fastTracked: 1");
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
        throw new GatewayPipelineError("Provider request failed with HTTP 400.", {
          error: {
            status: "INVALID_ARGUMENT",
            message: "ANY mode rejected deeply nested schema."
          }
        });
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

  it("drops observer observations whose waifuId is a user name, never queueing or storing them", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let dreamCalls = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations(request: StageManagerObserveRequest) {
        expect(request.availableWaifuIds).toEqual(["yuki"]);
        return [
          // "K" is a human user, not a configured waifu — the observer filter must drop it.
          { waifuId: "K", content: "K is a user, not a waifu.", importance: 3, kind: "fact" as const }
        ];
      },
      async decideDream() {
        dreamCalls += 1;
        return [{ op: "none" as const }];
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

    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema, MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] })));
    expect(memories.memories).toEqual([]);
    const pending = await storage.readJson("user/memory/pending-observations.json", PendingObservationsFileSchema, PendingObservationsFileSchema.parse(createEmptyRevisionedFile({ observations: [] })));
    expect(pending.observations).toEqual([]);
    // No observations survived, so the dream pass had nothing to do and was never called.
    expect(dreamCalls).toBe(0);
    const history = await storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema);
    expect(history.edits[0]).toMatchObject({ tool: "no_change" });
    expect(history.edits[0].summary).toContain("Dropped 1 observation");
  });

  it("dream pass is global: one waifu chunk spans memories from every guild", async () => {
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
            { id: "guild-1-memory", waifuId: "yuki", origin: { guildId: "guild-1" }, content: "Kevin likes tea.", strength: 3, createdAt: now, updatedAt: now, status: "active" },
            { id: "guild-2-memory", waifuId: "yuki", origin: { guildId: "guild-2" }, content: "Alice likes coffee.", strength: 3, createdAt: now, updatedAt: now, status: "active" }
          ]
        })
      )
    );
    await storage.writeJson(
      "memory:pending",
      "user/memory/pending-observations.json",
      PendingObservationsFileSchema,
      PendingObservationsFileSchema.parse(
        createEmptyRevisionedFile({
          observations: [
            { id: "obs-1", origin: { guildId: "guild-3", channelId: "channel-9" }, waifuId: "yuki", content: "Kevin enjoys tea regularly.", kind: "preference", importance: 3, createdAt: now }
          ]
        })
      )
    );

    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideDream(request) {
        expect(request.memories.map((memory) => memory.content)).toEqual(["Kevin likes tea.", "Alice likes coffee."]);
        expect(request.observations.map((observation) => observation.content)).toEqual(["Kevin enjoys tea regularly."]);
        return [
          { op: "rewrite", memoryIndex: 1, content: "Kevin enjoys tea regularly, especially in the mornings.", entities: ["Kevin"] },
          { op: "add", memory: { waifuId: "yuki", content: "Alice drinks espresso.", kind: "preference", strength: 3, entities: [] } }
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

    await runtime.memoryJobs.startDreamRun();

    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.find((memory) => memory.id === "guild-1-memory")).toMatchObject({
      content: "Kevin enjoys tea regularly, especially in the mornings.",
      revision: 1
    });
    expect(memories.memories.find((memory) => memory.id === "guild-2-memory")?.content).toBe("Alice likes coffee.");
    expect(memories.memories.find((memory) => memory.source === "dream" && memory.content === "Alice drinks espresso.")).toBeDefined();
    const pending = await storage.readJson("user/memory/pending-observations.json", PendingObservationsFileSchema);
    expect(pending.observations).toEqual([]);
    const history = await storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema);
    expect(history.edits.some((edit) => edit.summary.includes("[dream:rewrite]"))).toBe(true);
    expect(history.edits.some((edit) => edit.summary.includes("[dream:add]"))).toBe(true);
  });

  it("dream round-robin over 3 nights reaches every waifu (budget per night, persisted cursor)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();
    await seedRuntimeConfig(storage);
    const cast = ["ann", "bea", "cyd", "dot", "eve"];
    for (const id of cast) await seedWaifu(storage, id, id.toUpperCase(), `${id}-bot`, "direct");
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: cast.map((waifuId) => ({
            id: `${waifuId}-1`, waifuId, origin: { guildId: "guild-1" }, content: `${waifuId} fact`, strength: 3, createdAt: now, updatedAt: now, status: "active"
          }))
        })
      )
    );
    const nights: string[][] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideDream(request) {
        nights.at(-1)!.push(request.memories[0]!.waifuId);
        return [{ op: "none" as const }];
      }
    };
    const makeRuntime = () => new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger(),
      memory: { dreamChunksPerNight: 2 }
    });

    for (let night = 0; night < 3; night += 1) {
      nights.push([]);
      // A fresh runtime each night: the cursor is persisted, not in memory.
      await makeRuntime().memoryJobs.startDreamRun();
    }
    expect(nights).toEqual([["ann", "bea"], ["cyd", "dot"], ["eve", "ann"]]);
    expect(new Set(nights.flat())).toEqual(new Set(cast));
    // yuki (seeded by the runtime config) has no memories, so she costs no call.
  });

  it("a waifu needing more chunks than one night's budget resumes mid-waifu instead of blocking the cast", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "ann", "ANN", "ann-bot", "direct");
    await seedWaifu(storage, "bea", "BEA", "bea-bot", "direct");
    // ann: 170 memories = 3 chunks of 80; bea: 1 memory. Budget 2 chunks a night.
    const memories = [
      ...Array.from({ length: 170 }, (_, index) => {
        const at = new Date(base + index * 60_000).toISOString();
        return { id: `ann-${index}`, waifuId: "ann", origin: {}, content: `ann fact ${index}`, strength: 3, createdAt: at, updatedAt: at, status: "active" };
      }),
      { id: "bea-1", waifuId: "bea", origin: {}, content: "bea fact", strength: 3, createdAt: new Date(base).toISOString(), updatedAt: new Date(base).toISOString(), status: "active" }
    ];
    await storage.writeJson("memories:global", "user/memories.json", MemoryStoreSchema, MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories })));
    const nights: string[][] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideDream(request) {
        nights.at(-1)!.push(`${request.memories[0]!.waifuId}:${request.memories[0]!.content}`);
        return [{ op: "none" as const }];
      }
    };
    for (let night = 0; night < 3; night += 1) {
      nights.push([]);
      await new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        createPipeline: () => pipeline,
        logger: quietLogger(),
        memory: { dreamChunksPerNight: 2 }
      }).memoryJobs.startDreamRun();
    }
    expect(nights).toEqual([
      ["ann:ann fact 0", "ann:ann fact 80"],
      ["ann:ann fact 160", "bea:bea fact"],
      ["ann:ann fact 0", "ann:ann fact 80"]
    ]);
    const { DreamCursorFileSchema } = await import("../src/orchestration/dream.js");
    expect(await storage.readJson("user/memory/dream-cursor.json", DreamCursorFileSchema)).toMatchObject({
      // Night 3 passed yuki (no memories, no call) before re-entering ann.
      cursor: "yuki",
      resume: { waifuId: "ann", chunkIndex: 2 }
    });
  });

  it("dream ops may only assign memories to waifus the chunk is about", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();
    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: ["yuki", "mika"].flatMap((waifuId) =>
            Array.from({ length: 50 }, (_, index) => ({
              id: `${waifuId}-${index}`, waifuId, guildId: "guild-1", content: `${waifuId} fact ${index}`, strength: 3, createdAt: now, updatedAt: now, status: "active"
            }))
          )
        })
      )
    );
    const availableIds: string[][] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideDream(request) {
        availableIds.push(request.availableWaifuIds ?? []);
        if (request.memories[0]?.waifuId !== "yuki") return [];
        return [{ op: "add", memory: { waifuId: "mika", content: "Misattributed to mika.", kind: "fact", strength: 3, entities: [] } }];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.memoryJobs.startDreamRun();
    expect(availableIds).toEqual([["mika"], ["yuki"]]);
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.some((memory) => memory.content === "Misattributed to mika.")).toBe(false);
  });

  it("offers a waifu with observations but no memories yet as a dream owner", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();
    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "direct");
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [{ id: "yuki-1", waifuId: "yuki", guildId: "guild-1", content: "Kevin likes tea.", strength: 3, createdAt: now, updatedAt: now, status: "active" }]
        })
      )
    );
    await storage.writeJson(
      "memory:pending",
      "user/memory/pending-observations.json",
      PendingObservationsFileSchema,
      PendingObservationsFileSchema.parse(
        createEmptyRevisionedFile({
          observations: [
            { id: "obs-mika", guildId: "guild-1", channelId: "channel-1", waifuId: "mika", content: "Kevin told Mika he paints.", kind: "fact", importance: 3, entities: [], createdAt: now }
          ]
        })
      )
    );
    const offered: string[][] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideDream(request) {
        offered.push(request.availableWaifuIds ?? []);
        return [{ op: "add", memory: { waifuId: "mika", content: "Kevin paints.", kind: "fact", strength: 3, entities: [] } }];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.memoryJobs.startDreamRun();
    // Per-waifu chunks: mika (observation only) gets her own call, owned by her alone.
    expect(offered).toEqual([["mika"], ["yuki"]]);
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.find((memory) => memory.content === "Kevin paints.")?.waifuId).toBe("mika");
  });

  it("dream pass leaves pinned records untouched", async () => {
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
            { id: "pinned-1", waifuId: "yuki", guildId: "guild-1", content: "Kevin is allergic to peanuts.", strength: 5, pinned: true, createdAt: now, updatedAt: now, status: "active" }
          ]
        })
      )
    );
    await storage.writeJson(
      "memory:pending",
      "user/memory/pending-observations.json",
      PendingObservationsFileSchema,
      PendingObservationsFileSchema.parse(
        createEmptyRevisionedFile({
          observations: [
            { id: "obs-1", guildId: "guild-1", channelId: "channel-1", waifuId: "yuki", content: "Kevin mentioned peanuts again.", kind: "fact", importance: 2, entities: ["Kevin"], createdAt: now }
          ]
        })
      )
    );

    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        return [];
      },
      async decideDream(request) {
        // Pinned records are excluded from the chunk, so no memoryIndex targets them.
        expect(request.memories).toEqual([]);
        // The model nevertheless tries to archive index 1 (which is unknown for this chunk).
        return [{ op: "archive", memoryIndex: 1, reason: "stale" }];
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.memoryJobs.startDreamRun();

    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.find((memory) => memory.id === "pinned-1")).toMatchObject({ status: "active", pinned: true });
  });

  it("short-circuits when the observer extracts no observations", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    let dreamCalls = 0;

    await seedRuntimeConfig(storage);
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        return [];
      },
      async decideDream() {
        dreamCalls += 1;
        return [{ op: "none" as const }];
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

    // Empty store and empty queue: the dream pass finds no chunk and never calls the model.
    expect(dreamCalls).toBe(0);
    const history = await storage.readJson("user/stage-manager/history.json", StageManagerHistoryFileSchema);
    expect(history.edits[0]).toMatchObject({
      tool: "no_change",
      observationCount: 0,
      summary: "No observations extracted"
    });
  });

  it("dream pass reentrancy: second call for the same guild while first is in-flight returns already_running and skips decideDream", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const now = new Date().toISOString();

    await seedRuntimeConfig(storage);
    // Seed one memory so the dream pass has a chunk to work on.
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            { id: "mem-1", waifuId: "yuki", guildId: "guild-1", content: "Kevin likes tea.", strength: 3, createdAt: now, updatedAt: now, status: "active" }
          ]
        })
      )
    );

    // Deferred promise holds the first dream run in-flight until we choose to release it.
    let releaseDream!: () => void;
    const dreamGate = new Promise<void>((resolve) => { releaseDream = resolve; });

    let decideDreamCalls = 0;

    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideStageManagerObservations() {
        return [];
      },
      async decideDream() {
        decideDreamCalls += 1;
        await dreamGate;
        return [{ op: "none" as const }];
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    // Fire first run without awaiting. dreamingGuilds.add("guild-1") fires synchronously
    // inside startDreamRun before any async work begins.
    const firstRun = runtime.memoryJobs.startDreamRun();

    // Second call: the guard is already set synchronously, so this returns immediately
    // with already_running without touching runDreamPass at all.
    const secondResult = await runtime.memoryJobs.startDreamRun();
    expect(secondResult.status).toBe("already_running");

    // Release the first run and let it complete.
    releaseDream();
    const firstResult = await firstRun;

    // The first run completed normally (no_change since decideDream returns [{op:"none"}]).
    expect(firstResult.status).toBe("no_change");
    // decideDream was invoked exactly once — the second call was short-circuited.
    expect(decideDreamCalls).toBe(1);
  });

  it("dream pass is one global single flight: a concurrent run returns already_running", async () => {
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
            { id: "mem-g1", waifuId: "yuki", origin: { guildId: "guild-1" }, content: "Kevin likes tea.", strength: 3, createdAt: now, updatedAt: now, status: "active" },
            { id: "mem-g2", waifuId: "yuki", origin: { guildId: "guild-2" }, content: "Alice likes coffee.", strength: 3, createdAt: now, updatedAt: now, status: "active" }
          ]
        })
      )
    );
    let decideDreamCalls = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideDream() {
        decideDreamCalls += 1;
        return [{ op: "none" as const }];
      }
    };
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    const [result1, result2] = await Promise.all([runtime.memoryJobs.startDreamRun(), runtime.memoryJobs.startDreamRun()]);
    expect(result1.status, JSON.stringify(result1)).toBe("no_change");
    expect(result2.status).toBe("already_running");
    // One waifu chunk covering both guilds' memories.
    expect(decideDreamCalls).toBe(1);
  });

  it("a memory learned in guild A is retrieved for the same waifu in guild B (global memory)", async () => {
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
            { id: "learned-in-a", waifuId: "yuki", origin: { guildId: "guild-a", channelId: "chan-a" }, content: "Kevin is allergic to peanuts.", strength: 4, createdAt: now, updatedAt: now, status: "active" },
            { id: "other-waifu", waifuId: "mika", origin: { guildId: "guild-1" }, content: "Mika-only secret.", strength: 3, createdAt: now, updatedAt: now, status: "active" }
          ]
        })
      )
    );

    const trailing: string[] = [];
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "reply"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        trailing.push(promptText(request));
        return { content: "noted" };
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

    // guild-1 is "guild B": the memory was learned in guild-a.
    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();
    expect(trailing).toHaveLength(1);
    expect(trailing[0]).toContain("Kevin is allergic to peanuts");
    expect(trailing[0]).not.toContain("Mika-only secret.");
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
        stageCalls += 1;
        for (const waiter of stageWaiters) waiter();
        return [{ waifuId: "yuki", content: "Kevin pinged.", importance: 2, kind: "event" as const }];
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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-1",
      authorId: "u1",
      authorBot: false
    });
    expect(stageCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(120);
    await waitForStageCalls(1);
    expect(stageCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
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
        stageCalls += 1;
        for (const waiter of stageWaiters) waiter();
        return [{ waifuId: "yuki", content: "Kevin pinged.", importance: 2, kind: "event" as const }];
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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-1",
      authorId: "u1",
      authorBot: false
    });
    await vi.advanceTimersByTimeAsync(400);
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "user-2",
      authorId: "u1",
      authorBot: false
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(stageCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(300);
    await waitForStageCalls(1);
    expect(stageCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
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
        stageCalls += 1;
        return [{ waifuId: "yuki", content: "Kevin pinged.", importance: 2, kind: "event" as const }];
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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await runtime.handleDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "inactive",
      authorId: "u1",
      authorBot: false
    });
    await vi.advanceTimersByTimeAsync(80);
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
    await vi.advanceTimersByTimeAsync(120);
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
      async decideDream(request) {
        // The dream pass receives the queued observation and adds a memory for it.
        const observation = request.observations[0];
        return [
          {
            op: "add",
            memory: {
              waifuId: observation.waifuId,
              content: observation.content,
              kind: observation.kind,
              strength: observation.importance,
              entities: []
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
    try {
      // The listener schedules background work: await its actual response, not a
      // one-second disk/model speed assumption. Vitest bounds the whole test.
      await responded;
    } finally {
      await runtime.stop();
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]).toContain("Observer + dream pass");
    expect(responses[0]).toContain("dream pass applied 1");
    // The dreamed memory landed in the store.
    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.find((memory) => memory.content === "Kevin likes tea.")).toMatchObject({ source: "dream" });
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
    expect(discord.debugMessages.length).toBeGreaterThan(2);
    expect(discord.debugMessages.every((message) => message.channelId === "channel-1")).toBe(true);
    const printed = discord.debugMessages.map((message) => message.content).join("\n");
    // No live turn in this channel yet: her static system prompt (the harness), freshly rendered.
    expect(discord.debugMessages[0]!.content).toContain("has not replied in this channel since the backend started");
    expect(printed).toContain("## System prompt (Yuki)");
    expect(printed).not.toContain("(continued");
    expect(printed).not.toMatch(/`{3,}xml/);
    // The longer harness pushes the chunk split right after `<identity>`; check both pieces.
    expect(printed).toContain("<identity>");
    expect(printed).toContain("You are Yuki.\n</identity>");
    expect(printed).toContain("<persona>\nkind\nlong detail line");
    expect(printed).not.toContain("<scene_direction>");
    expect(printed).not.toContain("\\n");
  });

  it("/print system_prompt replies ephemerally when it can, with the channel's cast as the roster", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "yuki", "Yuki", "yuki-bot", "kind");
    await seedWaifu(storage, "mika", "Mika", "mika-bot", "sharp");
    const server = await storage.readJson("user/servers/guild-1/server.json", ServerConfigSchema);
    await storage.writeJson("server:guild-1", "user/servers/guild-1/server.json", ServerConfigSchema, {
      ...server,
      channels: {
        ...server.channels,
        "channel-2": { ...server.channels["channel-1"]!, channelId: "channel-2", enabledWaifuIds: ["yuki", "mika"] }
      }
    });
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({ async generateWaifu() { return { content: "unused" }; } }),
      logger: quietLogger()
    });
    await runtime.start();

    const printed: Record<string, string[]> = { "channel-1": [], "channel-2": [] };
    for (const channelId of ["channel-1", "channel-2"] as const) {
      await discord.emitPrintCommand({
        guildId: "guild-1",
        channelId,
        userId: "admin-user",
        type: "system_prompt",
        waifuId: "yuki",
        followUp: async (content) => {
          printed[channelId]!.push(content);
        }
      });
    }
    await waitFor(() => printed["channel-2"]!.length > 0, "ephemeral print");
    await runtime.stop();

    // Invoker-only follow-ups: nothing is posted to the channel (where the ledger would pick it up).
    expect(discord.debugMessages).toEqual([]);
    const one = printed["channel-1"]!.join("\n");
    const two = printed["channel-2"]!.join("\n");
    expect(one).toContain("You are Yuki.");
    expect(one).not.toContain("Mika");
    expect(two).toContain("The other character here is Mika, who writes their own messages; you write only yours.");
  });

  it("redacts DM-origin memory lines from a printed prompt", () => {
    const debug = {
      system: "<harness>…</harness>",
      header: [
        "<memories>",
        "- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)",
        "- Kevin is moving to Osaka (fact · learned in a private chat with Kevin · 5 days ago)",
        "</memories>"
      ].join("\n"),
      transcript: "[14:02 #a0] Mina: hi\n<memory_note>Mina is pregnant (fact · learned in a private chat with Mina · 2 days ago)</memory_note>",
      tail: "Now: …"
    };
    const redacted = redactPrivateMemories(debug);
    expect(redacted.header).toContain("allergic to peanuts");
    expect(redacted.header).not.toContain("Osaka");
    expect(redacted.transcript).not.toContain("pregnant");
    expect(redacted.header).toContain("- (a memory from a private chat — not shown here)");
    expect(redacted.system).toBe(debug.system);
    expect(redacted.tail).toBe(debug.tail);
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
              guildId: "guild-1",
              content: "Yuki knows Kevin likes green tea.",
              strength: 3,
              createdAt,
              updatedAt: createdAt,
              status: "active"
            },
            {
              id: "current-permanent",
              waifuId: "yuki",
              guildId: "guild-1",
              content: "Yuki always remembers Kevin is allergic to peanuts.",
              strength: 5,
              pinned: true,
              createdAt,
              updatedAt: createdAt,
              status: "active"
            },
            {
              id: "archived-current",
              waifuId: "yuki",
              guildId: "guild-1",
              content: "Archived current guild memory.",
              strength: 2,
              createdAt,
              updatedAt: createdAt,
              status: "archived"
            },
            {
              id: "other-guild",
              waifuId: "yuki",
              origin: { guildId: "guild-2" },
              content: "Other guild memory.",
              strength: 2,
              createdAt,
              updatedAt: createdAt,
              status: "active"
            },
            {
              id: "private-chat",
              waifuId: "yuki",
              origin: { dm: true },
              content: "Secret told in a DM.",
              strength: 3,
              createdAt,
              updatedAt: createdAt,
              status: "active"
            },
            {
              id: "other-waifu",
              waifuId: "mika",
              guildId: "guild-1",
              content: "Mika-only memory.",
              strength: 2,
              createdAt,
              updatedAt: createdAt,
              status: "active"
            },
            // Waifu notes now live in the same unified store (source waifu_tool + expiresAt).
            {
              id: "note-current",
              waifuId: "yuki",
              guildId: "guild-1",
              channelId: "channel-1",
              content: "Kevin is leaving at 5pm.",
              source: "waifu_tool",
              kind: "context",
              strength: 2,
              createdAt,
              updatedAt: createdAt,
              expiresAt: new Date(now + 60_000).toISOString(),
              status: "active"
            },
            {
              id: "note-expired",
              waifuId: "yuki",
              guildId: "guild-1",
              channelId: "channel-1",
              content: "Expired short-term memory.",
              source: "waifu_tool",
              kind: "context",
              strength: 2,
              createdAt,
              updatedAt: createdAt,
              expiresAt: new Date(now - 60_000).toISOString(),
              status: "active"
            },
            {
              // Notes are guild-visible (channel only boosts retrieval), so a note from another
              // channel of the same guild is now carried over — cross-channel continuity.
              id: "note-other-channel",
              waifuId: "yuki",
              guildId: "guild-1",
              channelId: "channel-2",
              content: "Other channel short-term memory.",
              source: "waifu_tool",
              kind: "context",
              strength: 2,
              createdAt,
              updatedAt: createdAt,
              expiresAt: new Date(now + 60_000).toISOString(),
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
    // Full listing with status flags — active AND archived, every guild (memories are global).
    expect(printed).toContain("[active|s3] Yuki knows Kevin likes green tea (fact · just now)");
    expect(printed).toContain("Yuki always remembers Kevin is allergic to peanuts");
    expect(printed).toContain("pinned");
    expect(printed).toContain("Kevin is leaving at 5pm (note");
    expect(printed).toContain("Other channel short-term memory");
    // Archived records in the SAME guild now appear, flagged as archived.
    expect(printed).toContain("Archived current guild memory");
    expect(printed).toContain("[archived|s2]");
    // Expired notes appear too, flagged — this is the everything view.
    expect(printed).toContain("Expired short-term memory");
    expect(printed).toMatch(/\[active\|expired[^\]]*\]/);
    // Other guilds are visible; DM-origin memories never print into a guild channel.
    expect(printed).toContain("Other guild memory");
    expect(printed).not.toContain("Secret told in a DM");
    expect(printed).toContain("(1 memory from private chats not shown)");
    expect(printed).not.toContain("Mika-only memory");
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
    expect(printed).toContain("## Personality block 1 — raw persona (Mika)");
    expect(printed).toContain("dry\nsharp");
    expect(printed).not.toContain("You are Mika");
  });

  it("prints personality as raw persona plus persona digest blocks", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await storage.writeJson(
      "waifu:yuki",
      "user/waifus/yuki/waifu.json",
      WaifuConfigSchema,
      WaifuConfigSchema.parse({
        ...createRevisionedBase(),
        id: "yuki",
        name: "Yuki",
        displayName: "Yuki",
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        botId: "yuki-bot",
        persona: "kind and bubbly",
        contextWindow: 50,
        personaDigest: { voice: "Speaks warmly and briefly.", role: "Gentle energy.", personaHash: "abc" }
      })
    );

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({ async generateWaifu() { return { content: "unused" }; } }),
      logger: quietLogger()
    });
    await runtime.start();

    const responses: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "admin-user",
      type: "personality",
      waifuId: "yuki",
      respond: async (content) => { responses.push(content); }
    });
    await waitFor(() => responses.length === 1, "personality print response");
    await runtime.stop();

    const joined = discord.debugMessages.map((m) => m.content).join("\n");
    expect(joined).toContain("Personality block 1 — raw persona (Yuki)");
    expect(joined).toContain("kind and bubbly");
    expect(joined).toContain("Personality block 2 — persona digest (Yuki)");
    expect(joined).toContain("Voice: Speaks warmly and briefly.");
    expect(joined).toContain("Drives: Gentle energy.");
  });

  it("prints ALL memories including archived ones with status flags", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    const now = new Date().toISOString();
    await storage.writeJson(
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            { id: "m-active", waifuId: "yuki", guildId: "guild-1", content: "Kevin likes tea.", strength: 3, createdAt: now, updatedAt: now, status: "active" },
            { id: "m-archived", waifuId: "yuki", guildId: "guild-1", content: "Old trivia about socks.", strength: 1, createdAt: now, updatedAt: now, status: "archived" }
          ]
        })
      )
    );

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => ({ async generateWaifu() { return { content: "unused" }; } }),
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
      respond: async (content) => { responses.push(content); }
    });
    await waitFor(() => responses.length === 1, "memories print response");
    await runtime.stop();

    const joined = discord.debugMessages.map((m) => m.content).join("\n");
    expect(joined).toContain("2 total (1 active, 1 archived)");
    expect(joined).toContain("Kevin likes tea");
    expect(joined).toContain("Old trivia about socks");
    expect(joined).toContain("archived");
  });

  it("prints the exact system prompt captured from the waifu's last reply", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hi yuki")]];

    await seedRuntimeConfig(storage);

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "greet" };
      },
      async generateWaifu() {
        return { content: "hey!" };
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

    // Before any reply: fallback note.
    const early: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1", channelId: "channel-1", userId: "admin-user",
      type: "system_prompt", waifuId: "yuki",
      respond: async (content) => { early.push(content); }
    });
    await waitFor(() => early.length === 1, "early system prompt print");
    const earlyJoined = discord.debugMessages.map((m) => m.content).join("\n");
    expect(earlyJoined).toContain("has not replied in this channel since the backend started");

    discord.debugMessages.length = 0;
    await runtime.triggerChannel("guild-1", "channel-1", "manual");

    const late: string[] = [];
    await discord.emitPrintCommand({
      guildId: "guild-1", channelId: "channel-1", userId: "admin-user",
      type: "system_prompt", waifuId: "yuki",
      respond: async (content) => { late.push(content); }
    });
    await waitFor(() => late.length === 1, "captured system prompt print");
    await runtime.stop();

    const lateJoined = discord.debugMessages.map((m) => m.content).join("\n");
    expect(lateJoined).toContain("Captured from Yuki's last reply at");
    expect(lateJoined).toContain("## System prompt (Yuki)");
    expect(lateJoined).toContain("## Transcript (Yuki)");
    expect(lateJoined).toContain("## Tail (Yuki)");
    expect(lateJoined).toContain("You are Yuki");
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
        async decideDream(request) {
          const observation = request.observations[0];
          return [{
            op: "add",
            memory: { waifuId: observation.waifuId, content: observation.content, kind: observation.kind, strength: observation.importance, entities: [] }
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
    // Observer posts its [stage-manager debug] queue summary; the dream posts a [dream debug] log.
    await waitFor(() => discord.debugMessages.length === 2, "stage-manager + dream debug messages");
    await runtime.stop();

    const combined = discord.debugMessages.map((message) => message.content).join("\n");
    expect(combined).toContain("[stage-manager debug]");
    expect(combined).toContain("queued: 1");
    expect(combined).toContain("[dream debug]");
    expect(combined).toContain("[dream:add] Yuki likes green tea.");
    expect(combined).not.toContain("affectedMemoryIds");
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

  it("enforces reply-required in code: a manual pass that pauses still gets a voice", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];
    const tails: string[] = [];
    const tools: string[] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "forced hello" };
      },
      async decideOrchestrator(request) {
        tails.push(request.prompt!.debug.tail);
        tools.push(JSON.stringify(request.prompt!.tools));
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 300, wakePlan: "wait", reasoning: "too quiet" };
      }
    };
    await seedRuntimeConfig(storage);
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 2,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1", "manual", { firstOrchestratorMustReply: true });
    await runtime.stop();

    expect(tails[0]).toContain("Reply required: yes.");
    expect(tails[1]).toContain("Reply required: no.");
    // The schema never changes with the per-pass state (prefix stability).
    expect(tools[1]).toBe(tools[0]);
    expect(discord.sent.map((message) => [message.senderBotId, message.content])).toEqual([["yuki-bot", "forced hello"]]);
    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const forced = history.decisions.find((entry) => entry.action === "reply");
    expect(forced?.respondingWaifus.map((responder) => responder.waifuId)).toEqual(["yuki"]);
    expect(forced?.reasoning).toContain("reply required");
  });

  // T7b call-site contract: the director's summarizer mirrors its decision call.
  it("gives the director's context its own-model summarizer (forced tool choice, attribution with conversationKey)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];
    const summarizeRequests: unknown[] = [];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 300, wakePlan: "wait", reasoning: "quiet" };
      },
      async summarizeContext(request) {
        summarizeRequests.push(request);
        return { text: "summary" };
      }
    };
    await seedRuntimeConfig(storage);
    const runtime = new RuntimeOrchestrator({ sleep: async () => undefined, storage, discord, maxAutomaticTurns: 1, createPipeline: () => pipeline, logger: quietLogger() });
    const prepare = vi.spyOn(runtime.contexts, "prepare");
    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();
    const input = prepare.mock.calls[0]![0];
    expect(input.summarize).toBeDefined();
    expect(input.truncateKeep).toBeUndefined();
    await input.summarize!({ promptCacheKey: "k" } as never, "summarize please");
    expect(summarizeRequests[0]).toMatchObject({
      instruction: "summarize please",
      toolChoice: { name: "orchestrator_decision" },
      temperature: 0.2,
      attribution: { agentId: "orchestrator", guildId: "guild-1", channelId: "channel-1", conversationKey: "g_guild-1_channel-1" }
    });
  });

  // T5 review M6: an unusable decision on /run still produces the promised reply.
  it("replies on a reply-required /run when the decision cannot be parsed", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];
    let calls = 0;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "still here" };
      },
      async decideOrchestrator() {
        calls += 1;
        if (calls === 1) throw new GatewayPipelineError("decideOrchestrator: malformed orchestrator_decision arguments");
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 300, wakePlan: "wait", reasoning: "done" };
      }
    };
    await seedRuntimeConfig(storage);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new RuntimeOrchestrator({ sleep: async () => undefined, storage, discord, maxAutomaticTurns: 2, createPipeline: () => pipeline, logger });
    await runtime.triggerChannel("guild-1", "channel-1", "manual", { firstOrchestratorMustReply: true });
    await runtime.stop();
    expect(logger.error).not.toHaveBeenCalledWith("Channel runtime loop failed", expect.anything());
    expect(discord.sent.map((message) => message.content)).toEqual(["still here"]);
  });

  it("still surfaces a provider failure on a reply-required /run", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello")]];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        throw new Error("network down");
      }
    };
    await seedRuntimeConfig(storage);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new RuntimeOrchestrator({ sleep: async () => undefined, storage, discord, maxAutomaticTurns: 1, createPipeline: () => pipeline, logger });
    await runtime.triggerChannel("guild-1", "channel-1", "manual", { firstOrchestratorMustReply: true });
    await runtime.stop();
    expect(logger.error).toHaveBeenCalledWith("Channel runtime loop failed", expect.objectContaining({ message: "network down" }));
    expect(discord.sent).toEqual([]);
  });

  // T5 review I2: policy 2 is enforced as the prompt states it, with no cadence precondition.
  it("overrides a pause on a waiting human's fresh message, without any cadence signal", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const fresh = new Date(Date.now() - 2 * 60_000).toISOString();
    discord.contexts = [[{ ...contextMessage("m1", "user", "Kevin", "Yuki, you around?"), timestamp: fresh }]];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "yep!" };
      },
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 300, wakePlan: "wait", reasoning: "let it breathe" };
      }
    };
    await seedRuntimeConfig(storage);
    // Always available, whatever the host clock says (the structural decider reads her schedule).
    const yuki = await storage.readJson("user/waifus/yuki/waifu.json", WaifuConfigSchema);
    await storage.writeJson("waifu:yuki", "user/waifus/yuki/waifu.json", WaifuConfigSchema, {
      ...yuki,
      availability: { sleep: { enabled: false, start: "00:00", end: "00:00" }, busy: [] }
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new RuntimeOrchestrator({ sleep: async () => undefined, storage, discord, maxAutomaticTurns: 1, createPipeline: () => pipeline, logger });
    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();
    expect(logger.warn).toHaveBeenCalledWith(
      "Waiting-human override: the model paused on a human's message; deterministic reply used",
      expect.anything()
    );
    expect(discord.sent.map((message) => message.content)).toEqual(["yep!"]);
  });

  it("leaves a pause alone when the human's message is older than 15 minutes", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    const stale = new Date(Date.now() - 40 * 60_000).toISOString();
    discord.contexts = [[{ ...contextMessage("m1", "user", "Kevin", "Yuki, you around?"), timestamp: stale }]];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideOrchestrator() {
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 300, wakePlan: "wait", reasoning: "quiet" };
      }
    };
    await seedRuntimeConfig(storage);
    const runtime = new RuntimeOrchestrator({ sleep: async () => undefined, storage, discord, maxAutomaticTurns: 1, createPipeline: () => pipeline, logger: quietLogger() });
    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();
    expect(discord.sent).toEqual([]);
  });

  // T5 review M5: without a config file the director backfills 20 messages (the API default).
  it("backfills the API's default 20 messages when the orchestrator has no config file", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      Array.from({ length: 30 }, (_, i) => ({
        ...contextMessage(`m${i}`, "user", "Kevin", `message ${i}`),
        timestamp: new Date(Date.parse("2026-05-16T12:00:00Z") + i * 60_000).toISOString()
      }))
    ];
    await seedRuntimeConfig(storage);
    await rm(path.join(root, "user", "orchestrator", "config.json"), { force: true });
    const runtime = new RuntimeOrchestrator({ sleep: async () => undefined, storage, discord, maxAutomaticTurns: 1, createPipeline: () => new FakePipeline(), logger: quietLogger() });
    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();
    const state = JSON.parse(
      await readFile(path.join(root, "user", "conversations", "g_guild-1_channel-1", "contexts", "orchestrator.json"), "utf8")
    ) as { cursorSeq: number };
    expect(state.cursorSeq).toBe(10);
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
        if (promptOf(request).debug.system.includes("You are Mika")) {
          waifuCalls.push("mika");
          expect(promptText(request)).toContain(
            expectedDirectorNote("start topic")
          );
          return { content: "mika first", pickedNextWaifuId: "yuki" };
        }
        waifuCalls.push("yuki");
        expect(promptOf(request).debug.transcript).not.toMatch(/<direction>/);
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
        const waifuId = promptOf(request).debug.system.includes("You are Mika") ? "mika" : "yuki";
        waifuCalls.push({ waifuId, directiveText: latestDirection(request) });
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
        return { content: "Hi there\nHow are you today?\nWant to play?" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);
    // Three lines fit the chatty profile (terse allows two).
    await setWaifuVerbosity(storage, "yuki", "chatty");

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
      "Hi there",
      "How are you today?",
      "Want to play?"
    ]);
    expect(discord.sent[0].replyToMessageId).toBeUndefined();
    expect(discord.sent[1].replyToMessageId).toBeUndefined();
    expect(discord.sent[2].replyToMessageId).toBeUndefined();
    expect(discord.typingCalls.some((call) => call.senderBotId === "yuki-bot")).toBe(true);
    // The orchestrator no longer shows a typing indicator while it deliberates (W4 leak fix):
    // only the waifu send path types, so there is never a typing call without a senderBotId.
    expect(discord.typingCalls.some((call) => call.senderBotId === undefined)).toBe(false);
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
        return { content: "One\nTwo\nThis third chunk is too long\nFour" };
      }
      async decideOrchestrator() {
        this.decisionCalls += 1;
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);
    // Four lines fit the expressive profile.
    await setWaifuVerbosity(storage, "yuki", "expressive");

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
      "One",
      "Two",
      "This third chunk is too long",
      "Four"
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

  it("derives the reply target from a leading ↩#ref marker in the waifu output", async () => {
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
        return { content: "↩#a0 here is the answer" };
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

  it("strips an unknown ↩#ref marker and sends unthreaded", async () => {
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
        return { content: "↩#zz9 thats your victory lap" };
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

    expect(discord.sent[0].replyToMessageId).toBeUndefined();
    expect(discord.sent[0].content).toBe("thats your victory lap");
  });

  it("strips recent human speaker impersonation lines; stop sequences are the header guard plus her name", async () => {
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
    expect(pipeline.receivedStopSequences).toEqual(["\n[", "\nYuki:"]);
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
    expect(receivedStopSequences).toEqual(["\n[", "\nYuki:"]);
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

  it("strips an other-waifu impersonation line; stop sequences stay the header guard plus her name", async () => {
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
    expect(pipeline.receivedStopSequences).toEqual(["\n[", "\nYuki:"]);
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
        this.retryUserMessages.push(retryNoteOf(request));
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
    expect(pipeline.retryUserMessages).toEqual([undefined, expect.stringContaining("Your last draft was rejected"), undefined]);
    expect(discord.sent.map((m) => m.content)).toEqual([
      "oh wait that was me sorry",
      "I can add something too"
    ]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: "Waifu reply was entirely removed during cleaning; retrying once",
        meta: expect.objectContaining({ waifuId: "yuki" })
      })
    );
    expect(warnings.some((w) => w.message === "Waifu reply was empty after cleaning; nothing sent")).toBe(false);
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
        if (promptOf(request).debug.system.includes("You are Yuki")) {
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

  it("blocks a waifu reply that leaks a harness tag on both attempts and sends nothing", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);

    let retryMessageOnAttempt2: string | undefined;
    let attempts = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki speaks."
        };
      },
      async generateWaifu(request: WaifuGenerationRequest) {
        attempts += 1;
        if (attempts === 2) {
          retryMessageOnAttempt2 = retryNoteOf(request);
        }
        return { content: "<direction>goal</direction>" };
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

    expect(attempts).toBe(2);
    expect(discord.sent).toEqual([]);
    expect(retryMessageOnAttempt2).toContain("rejected");

    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.status).toBe("completed");
    expect(decision?.responderOutcomes.map((outcome) => ({
      waifuId: outcome.waifuId,
      status: outcome.status,
      messageCount: outcome.messageIds.length
    }))).toEqual([{ waifuId: "yuki", status: "blocked", messageCount: 0 }]);
    expect(decision?.responderOutcomes[0]?.reason).toContain("harness-tag");
  });

  it("recovers when the validator rejects attempt 1 but attempt 2 is clean", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);

    let attempts = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki speaks."
        };
      },
      async generateWaifu() {
        attempts += 1;
        return attempts === 1
          ? { content: "<direction>goal</direction>" }
          : { content: "sure, sounds good" };
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

    expect(attempts).toBe(2);
    expect(discord.sent.map((message) => message.content)).toEqual(["sure, sounds good"]);

    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.responderOutcomes.map((outcome) => outcome.status)).toEqual(["sent"]);
  });

  it("blocks a mass-ping reply immediately without a retry", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);

    let attempts = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki speaks."
        };
      },
      async generateWaifu() {
        attempts += 1;
        return { content: "@everyone hi" };
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

    expect(attempts).toBe(1);
    expect(discord.sent).toEqual([]);

    const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
    const decision = history.decisions.find((entry) => entry.action === "reply");
    expect(decision?.responderOutcomes[0]?.status).toBe("blocked");
    expect(decision?.responderOutcomes[0]?.reason).toContain("mass-ping");
  });

  it("refuses a debug route into a channel with active waifus and allows a clean one", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    // guild-1 / channel-1 has yuki enabled (seedRuntimeConfig). channel-clean has no waifus.
    discord.debugChannelInfo.set("source-channel", { channelId: "source-channel", guildId: "guild-1" });
    discord.debugChannelInfo.set("channel-1", { channelId: "channel-1", guildId: "guild-1" });
    discord.debugChannelInfo.set("channel-clean", { channelId: "channel-clean", guildId: "guild-1" });

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
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "admin-user",
      type: "set",
      sourceChannelId: "source-channel",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 1, "debug set rejection response");

    await discord.emitDebugCommand({
      guildId: "guild-1",
      channelId: "channel-clean",
      userId: "admin-user",
      type: "set",
      sourceChannelId: "source-channel",
      respond: async (content) => {
        responses.push(content);
      }
    });
    await waitFor(() => responses.length === 2, "debug set success response");
    const routes = await storage.readJson("user/orchestrator/debug.json", OrchestratorDebugConfigFileSchema);
    await runtime.stop();

    expect(responses[0]).toBe(
      "Refusing to route debug logs into a channel with active waifus — pick a private channel."
    );
    expect(responses[1]).toBe("Debug logs for channel source-channel will be posted in this channel.");
    expect(routes.routes["source-channel"]).toMatchObject({
      destinationChannelId: "channel-clean"
    });
  });

  it("sends the reviewer one message and no custom prompt when none is configured", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [
      [
        contextMessage("m1", "user", "Kevin", "hello"),
        contextMessage("chunk-1", "waifu", "Yuki", "hi", ["chunk-1"])
      ]
    ];

    await seedRuntimeConfig(storage);
    // Clear the seeded reviewer prompt: the fixed instruction (tools.ts) needs no default text.
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
        prompt: ""
      })
    );

    let reviewerRequest: (ProviderRequest & { message: string; authorName?: string }) | undefined;
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        return { content: "unused" };
      },
      async decideReviewer(request) {
        reviewerRequest = request;
        return { hallucination: false };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerReviewer("guild-1", "channel-1", "reviewer-user");
    await runtime.stop();

    expect(reviewerRequest).toMatchObject({ message: "hi", authorName: "Yuki" });
    expect(reviewerRequest!.systemPrompt).toBeUndefined();
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
        return { content: "Hi\nHow are you?\nWant to play?" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);
    await setWaifuVerbosity(storage, "yuki", "chatty");

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
      "Hi",
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
        return { content: "Hi\nHow are you?\nWant to play?" };
      }
      async decideOrchestrator() {
        const next = this.decisions.shift();
        if (!next) throw new Error("no decision");
        return next;
      }
    }

    await seedRuntimeConfig(storage);
    await setWaifuVerbosity(storage, "yuki", "chatty");
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
    expect(discord.sent[0].content).toBe("Hi");
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
    const capturedMidBlocks: Array<string | undefined> = [];
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
        capturedSystemPrompts.push(promptOf(request).debug.system);
        capturedMidBlocks.push(promptOf(request).debug.header);
        capturedTrailingBlocks.push(promptText(request));
        waifuRun += 1;
        if (waifuRun === 1) {
          const entries = [
            "Kevin is heading out at 5pm.",
            "Kevin prefers green tea today.",
            "extra 3",
            "extra 4",
            "extra 5",
            "extra 6 should be dropped",
            "extra 7 should be dropped"
          ];
          return {
            content: "noted",
            toolCalls: entries.map((content, index) => ({ id: `call_mem_${index + 1}`, name: "add_memory", arguments: JSON.stringify({ content }) })),
            shortTermMemoryEntries: entries
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

    const stored = await storage.readJson("user/memories.json", MemoryStoreSchema);
    const notes = stored.memories.filter((memory) => memory.source === "waifu_tool");
    expect(notes).toHaveLength(5);
    expect(notes.map((note) => note.content)).toEqual([
      "Kevin is heading out at 5pm.",
      "Kevin prefers green tea today.",
      "extra 3",
      "extra 4",
      "extra 5"
    ]);
    expect(notes[0]).toMatchObject({
      origin: { guildId: "guild-1", channelId: "channel-1" },
      waifuId: "yuki",
      kind: "context",
      source: "waifu_tool",
      strength: 2
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    // The system prompt (breakpoint A) and the epoch header never change mid-epoch; her own
    // add_memory call is in the transcript as a recorded tool turn (spec 8.5).
    const secondPrompt = capturedSystemPrompts[1];
    expect(secondPrompt).toBe(capturedSystemPrompts[0]);
    expect(secondPrompt).not.toContain("Kevin is heading out");
    expect(capturedMidBlocks[1]).toBe(capturedMidBlocks[0]);
    // Tool notes render as user-role text lines (no tool_use/tool_result blocks), with accurate results.
    expect(capturedTrailingBlocks[1]).toContain('[tool add_memory] {"content":"Kevin is heading out at 5pm."} → saved');
    expect(capturedTrailingBlocks[1]).toContain('[tool add_memory] {"content":"extra 6 should be dropped"} → over limit');
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
        expect(promptOf(request).tools.some((tool) => tool.name === "add_memory")).toBe(false);
        expect(promptOf(request).debug.system).not.toContain("add_memory");
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
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }))
    );
    expect(checked).toBe(true);
    expect(stored.memories.filter((memory) => memory.source === "waifu_tool")).toEqual([]);
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
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "yuki-1",
              guildId: "guild-1",
              channelId: "channel-1",
              waifuId: "yuki",
              content: "Kevin promised to ping Yuki tonight.",
              source: "waifu_tool",
              kind: "context",
              strength: 2,
              createdAt: now,
              updatedAt: now,
              expiresAt,
              status: "active"
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
        // Identity block: "You are {Name}." — match the name before the period.
        const match = promptOf(request).debug.system.match(/<identity>\nYou are (\w+)\./);
        if (match) memoriesByWaifu.set(match[1], promptText(request));
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

  it("omits expired notes from the prompt and persists fresh ones into the unified store", async () => {
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
      "memories:global",
      "user/memories.json",
      MemoryStoreSchema,
      MemoryStoreSchema.parse(
        createEmptyRevisionedFile({
          memories: [
            {
              id: "expired",
              guildId: "guild-1",
              channelId: "channel-1",
              waifuId: "yuki",
              content: "stale note from yesterday",
              source: "waifu_tool",
              kind: "context",
              strength: 2,
              createdAt: longAgo,
              updatedAt: longAgo,
              expiresAt: longAgoExpired,
              status: "active"
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
        capturedSystemPrompt = promptOf(request).debug.system;
        capturedTrailingBlock = promptText(request);
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
    // The expired note is no longer injected (filtered at read), and the fresh note is persisted.
    // Hard pruning of expired records is now the dream pass's job (Task 4), so the stale record
    // remains in the file but is never shown.
    const after = await storage.readJson("user/memories.json", MemoryStoreSchema);
    const notes = after.memories.filter((memory) => memory.source === "waifu_tool");
    expect(notes.map((note) => note.content)).toContain("Kevin is back from lunch.");
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
        waifuTrailingBlocks.push(directionView(request));
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
    expect(waifuTrailingBlocks[0]).toContain("<direction>(change topic) talk about food</direction>");
    // The second (stripped) directive adds no note; the first one stays in her transcript.
    expect(waifuTrailingBlocks[1].match(/<direction>/g)).toHaveLength(1);

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
        waifuTrailing = directionView(request);
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

    expect(waifuTrailing).not.toContain("<direction>");
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
        waifuTrailing = directionView(request);
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

    expect(waifuTrailing).toContain("<direction>");
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

    let capturedTail = "";
    const pipeline: ModelPipeline = {
      async decideOrchestrator(request) {
        capturedTail = request.prompt!.debug.tail;
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

    // B8 wake marker lives in the ephemeral tail (spec 8.7).
    expect(capturedTail).toMatch(/<wake>This pass is the wake you scheduled at \d\d:\d\d: the 600s pause has elapsed/);
    expect(capturedTail).toContain('Your plan was: "have yuki answer".');
  });

  it("suppresses a timer wake when the cast already stacked unanswered messages", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    // Four trailing bot messages, freshest 5 minutes old, no human in sight.
    const recent = (minsAgo: number) => new Date(Date.now() - minsAgo * 60000).toISOString();
    discord.contexts = [[
      { ...contextMessage("m1", "waifu", "Yuki", "the man vanished for three days"), timestamp: recent(20) },
      { ...contextMessage("m2", "waifu", "Mika", "he really vanished huh"), timestamp: recent(15) },
      { ...contextMessage("m3", "waifu", "Yuki", "and came back with uwu"), timestamp: recent(10) },
      { ...contextMessage("m4", "waifu", "Mika", "the audacity of this man"), timestamp: recent(5) }
    ]];

    await seedRuntimeConfig(storage);

    let decisionCalls = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        decisionCalls += 1;
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 300, reasoning: "quiet" };
      },
      async generateWaifu() {
        return { content: "unused" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    const before = Date.now();
    await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", { trigger: "retrigger" });
    await runtime.stop();

    expect(decisionCalls).toBe(0);
    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.scheduledRetriggerAt).toBeDefined();
    const scheduledInSeconds = (Date.parse(session.scheduledRetriggerAt!) - before) / 1000;
    expect(scheduledInSeconds).toBeGreaterThanOrEqual(1790);
  });

  it("lets a timer wake through after a long-quiet lull even with trailing bot messages", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    // Same trailing-bot shape, but the newest message is 3 hours old: fresh beat allowed.
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
    discord.contexts = [[
      { ...contextMessage("m1", "waifu", "Yuki", "old chatter one"), timestamp: hoursAgo(5) },
      { ...contextMessage("m2", "waifu", "Mika", "old chatter two"), timestamp: hoursAgo(4.5) },
      { ...contextMessage("m3", "waifu", "Yuki", "old chatter three"), timestamp: hoursAgo(4) },
      { ...contextMessage("m4", "waifu", "Mika", "old chatter four"), timestamp: hoursAgo(3) }
    ]];

    await seedRuntimeConfig(storage);

    let decisionCalls = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        decisionCalls += 1;
        return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "fresh look" };
      },
      async generateWaifu() {
        return { content: "unused" };
      }
    };

    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      createPipeline: () => pipeline,
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", { trigger: "retrigger" });
    await runtime.stop();

    expect(decisionCalls).toBe(1);
  });

  it("uses the long cast-only cooldown at the turn limit when no human is recent", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    // Waifu-only room: the helper's fixed 2026-05-16 timestamp keeps any history stale.
    discord.contexts = [[contextMessage("m1", "waifu", "Yuki", "talking to myself again")]];

    await seedRuntimeConfig(storage);

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "keep the room alive"
        };
      },
      async generateWaifu() {
        return { content: "still here" };
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
    await runtime.triggerChannel("guild-1", "channel-1", "manual");
    await runtime.stop();

    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.scheduledRetriggerAt).toBeDefined();
    const scheduledInSeconds = (Date.parse(session.scheduledRetriggerAt!) - before) / 1000;
    expect(scheduledInSeconds).toBeGreaterThanOrEqual(890);
  });

  it("keeps the short cooldown at the turn limit while a human is recent", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[
      { ...contextMessage("m1", "user", "Kevin", "hey yuki"), timestamp: new Date().toISOString() }
    ]];

    await seedRuntimeConfig(storage);

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "answer Kevin"
        };
      },
      async generateWaifu() {
        return { content: "hey!" };
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
    await runtime.triggerChannel("guild-1", "channel-1", "manual");
    await runtime.stop();

    const session = await storage.readJson(
      "user/servers/guild-1/sessions/channel-1.json",
      (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
    );
    expect(session.scheduledRetriggerAt).toBeDefined();
    const scheduledInSeconds = (Date.parse(session.scheduledRetriggerAt!) - before) / 1000;
    expect(scheduledInSeconds).toBeLessThan(300);
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

  describe("runtime lifecycle correctness (phase 1)", () => {
    const sessionPath = (channelId = "channel-1") => `user/servers/guild-1/sessions/${channelId}.json`;
    const readSession = async (storage: StorageService, channelId = "channel-1") =>
      storage.readJson(
        sessionPath(channelId),
        (await import("../src/orchestration/session.js")).ChannelSessionStateSchema
      );
    const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const blockingWaifu = (onStart: () => void) =>
      (request: WaifuGenerationRequest) =>
        new Promise<{ content: string }>((_, reject) => {
          onStart();
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        });
    const replyOnce = (): ModelPipeline["decideOrchestrator"] => {
      let calls = 0;
      return async () => {
        calls += 1;
        return calls === 1
          ? { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "answer Kevin" }
          : { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" };
      };
    };

    async function interruptMidReply(halt: (runtime: RuntimeOrchestrator) => Promise<void>) {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      await seedRuntimeConfig(storage);
      let started = false;
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord: new FakeDiscord(),
        maxAutomaticTurns: 1,
        createPipeline: () => ({ decideOrchestrator: replyOnce(), generateWaifu: blockingWaifu(() => (started = true)) }),
        logger: quietLogger()
      });
      const run = runtime.triggerChannel("guild-1", "channel-1");
      await until(() => started, "waifu generation to start");
      await halt(runtime);
      await run;
      const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
      return { storage, decision: history.decisions[0] };
    }

    async function bootAgain(storage: StorageService, options: { isPaused?: () => boolean } = {}) {
      const discord = new FakeDiscord();
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        maxAutomaticTurns: 1,
        restartResumeDelayMs: 0,
        isPaused: options.isPaused,
        createPipeline: () => ({
          decideOrchestrator: async () => ({ action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" }),
          generateWaifu: async () => ({ content: "sorry, where was I" })
        }),
        logger
      });
      await runtime.start();
      return { runtime, discord, logger };
    }

    it("B6: resumes a reply interrupted by a planned stop (restart/update/reload) on the next start", async () => {
      const { storage, decision } = await interruptMidReply((runtime) => runtime.stop());
      expect(decision.status).toBe("interrupted");
      expect(decision.responderOutcomes[0]).toMatchObject({ status: "interrupted", reason: "runtime_shutdown" });

      const next = await bootAgain(storage);
      try {
        await until(() => next.discord.sent.length === 1, "resumed reply");
        expect(next.discord.sent[0].content).toBe("sorry, where was I");
      } finally {
        await next.runtime.stop();
      }
    });

    it("B6: never resumes a reply interrupted by an explicit user pause", async () => {
      const { storage, decision } = await interruptMidReply((runtime) => runtime.pause());
      expect(decision.responderOutcomes[0]).toMatchObject({ status: "interrupted", reason: "runtime paused" });

      const next = await bootAgain(storage);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(next.discord.sent).toEqual([]);
      } finally {
        await next.runtime.stop();
      }
    });

    it("B2: a runtime that boots paused runs no restart resume and starts no channel runs", async () => {
      const { storage } = await interruptMidReply((runtime) => runtime.stop());
      const next = await bootAgain(storage, { isPaused: () => true });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(next.discord.sent).toEqual([]);
        expect(next.logger.info).toHaveBeenCalledWith("Restart resume skipped because runtime is paused");
      } finally {
        await next.runtime.stop();
      }
      // the interrupted reply is still resumable once the runtime is unpaused
      const resumed = await bootAgain(storage);
      try {
        await until(() => resumed.discord.sent.length === 1, "resumed reply after unpause");
      } finally {
        await resumed.runtime.stop();
      }
    });

    it("B6: leaves a shutdown wake for a run cut down before any reply was planned", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      await seedRuntimeConfig(storage);
      let started = false;
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord: new FakeDiscord(),
        createPipeline: () => ({
          decideOrchestrator: (request) =>
            new Promise((_, reject) => {
              started = true;
              request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
            }),
          generateWaifu: async () => ({ content: "unused" })
        }),
        logger: quietLogger()
      });
      const run = runtime.triggerChannel("guild-1", "channel-1");
      await until(() => started, "orchestrator decision to start");
      await runtime.stop();
      await run;
      const session = await readSession(storage);
      expect(session.scheduledRetriggerAt).toBeDefined();
      expect(session.scheduledRetrigger?.source).toBe("shutdown");
    });

    it("B7: a run consumes the persisted wake so the next boot fires no spurious catch-up", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      const { ChannelSessionStateSchema, createEmptyChannelSessionState } = await import("../src/orchestration/session.js");
      await seedRuntimeConfig(storage);
      await storage.writeJson("session:guild-1:channel-1", sessionPath(), ChannelSessionStateSchema, {
        ...createEmptyChannelSessionState("guild-1", "channel-1"),
        scheduledRetriggerAt: new Date(Date.now() - 60_000).toISOString(),
        scheduledRetrigger: { source: "turn_limit", seconds: 900 }
      });
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord: new FakeDiscord(),
        createPipeline: () => ({
          // the chosen waifu is not enabled here, so the run ends without arming a new wake
          decideOrchestrator: async () => ({ action: "reply", respondingWaifus: [{ waifuId: "ghost", delaySeconds: 0 }], reasoning: "x" }),
          generateWaifu: async () => ({ content: "unused" })
        }),
        logger: quietLogger()
      });
      await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", {
        trigger: "retrigger",
        wake: { source: "turn_limit", seconds: 900 }
      });
      await runtime.stop();
      const session = await readSession(storage);
      expect(session.scheduledRetriggerAt).toBeUndefined();
      expect(session.scheduledRetrigger).toBeUndefined();
    });

    it("B8: a turn-limit cooldown wake gets no stale no_reply plan and no inherited backoff", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      const discord = new FakeDiscord();
      discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello there")]];
      await seedRuntimeConfig(storage);
      await seedOrchestratorHistory(storage, [
        {
          id: "recent-reply", guildId: "guild-1", channelId: "channel-1", action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "talk", status: "completed",
          waifuMessageIds: ["x"], responderOutcomes: [], createdAt: new Date().toISOString()
        },
        {
          id: "old-no-reply", guildId: "guild-1", channelId: "channel-1", action: "no_reply", respondingWaifus: [],
          retriggerAfterSeconds: 600, wakePlan: "have yuki ask about the stale thing", reasoning: "quiet",
          status: "completed", waifuMessageIds: [], responderOutcomes: [], createdAt: new Date(Date.now() - 3_600_000).toISOString()
        }
      ]);
      let capturedTail: string | undefined;
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        maxAutomaticTurns: 1,
        createPipeline: () => ({
          async decideOrchestrator(request) {
            capturedTail = request.prompt!.debug.tail;
            return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 200, reasoning: "still quiet" };
          },
          generateWaifu: async () => ({ content: "unused" })
        }),
        logger: quietLogger()
      });
      const before = Date.now();
      await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", {
        trigger: "retrigger",
        wake: { source: "turn_limit", seconds: 900 }
      });
      await runtime.stop();
      expect(capturedTail).toBeDefined();
      expect(capturedTail).not.toContain("<wake>");
      const session = await readSession(storage);
      expect((Date.parse(session.scheduledRetriggerAt!) - before) / 1000).toBeLessThan(300);
      const history = await storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
      expect(session.scheduledRetrigger).toEqual({ source: "no_reply", seconds: 200, decisionId: history.decisions[0].id });
    });

    it("B8: the wake marker describes the no_reply decision that armed the timer", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      const discord = new FakeDiscord();
      discord.contexts = [[contextMessage("m1", "user", "Kevin", "hello there")]];
      await seedRuntimeConfig(storage);
      const noReply = (id: string, plan: string, seconds: number, minutesAgo: number) => ({
        id, guildId: "guild-1", channelId: "channel-1", action: "no_reply", respondingWaifus: [],
        retriggerAfterSeconds: seconds, wakePlan: plan, reasoning: "quiet", status: "completed",
        waifuMessageIds: [], responderOutcomes: [], createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString()
      });
      await seedOrchestratorHistory(storage, [noReply("newer", "newer plan", 120, 1), noReply("armer", "armed plan", 400, 10)]);
      let capturedTail = "";
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        maxAutomaticTurns: 1,
        createPipeline: () => ({
          async decideOrchestrator(request) {
            capturedTail = request.prompt!.debug.tail;
            return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 100, reasoning: "still quiet" };
          },
          generateWaifu: async () => ({ content: "unused" })
        }),
        logger: quietLogger()
      });
      await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", {
        trigger: "retrigger",
        wake: { source: "no_reply", seconds: 600, decisionId: "armer" }
      });
      await runtime.stop();
      expect(capturedTail).toMatch(/<wake>[^<]*the 600s pause has elapsed[^<]*Your plan was: "armed plan"\./);
      expect(capturedTail).not.toContain("newer plan");
      const session = await readSession(storage);
      expect(session.scheduledRetrigger?.seconds).toBe(900);
    });

    it("B9: crash-recovery wakes back off exponentially and reset after a clean run", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      const discord = new FakeDiscord();
      let failing = true;
      const fetch = discord.fetchFreshContext.bind(discord);
      discord.fetchFreshContext = async () => {
        if (failing) throw new Error("discord exploded");
        return fetch();
      };
      discord.contexts = [];
      await seedRuntimeConfig(storage);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        maxAutomaticTurns: 1,
        createPipeline: () => ({
          decideOrchestrator: async () => ({ action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" }),
          generateWaifu: async () => ({ content: "unused" })
        }),
        logger
      });
      const recoverySeconds = () =>
        logger.warn.mock.calls
          .filter(([message]) => message === "Scheduling crash-recovery wake")
          .map(([, context]) => (context as { seconds: number }).seconds);
      try {
        for (let i = 0; i < 4; i += 1) await runtime.triggerChannel("guild-1", "channel-1");
        expect(recoverySeconds()).toEqual([180, 360, 720, 1440]);
        failing = false;
        await runtime.triggerChannel("guild-1", "channel-1");
        failing = true;
        await runtime.triggerChannel("guild-1", "channel-1");
        expect(recoverySeconds()).toEqual([180, 360, 720, 1440, 180]);
        await until(async () => (await readSession(storage)).scheduledRetrigger?.source === "crash_recovery", "recovery wake persisted");
      } finally {
        await runtime.stop();
      }
    });

    it("B5: a channel whose run was preempted by another channel gets re-triggered afterwards", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      await seedRuntimeConfig(storage);
      const server = await storage.readJson("user/servers/guild-1/server.json", ServerConfigSchema);
      await storage.writeJson("server:guild-1", "user/servers/guild-1/server.json", ServerConfigSchema, {
        ...server,
        channels: {
          ...server.channels,
          "channel-2": { ...server.channels["channel-1"], channelId: "channel-2" }
        }
      });
      const discord = new FakeDiscord();
      discord.fetchFreshContext = async () => [contextMessage("m1", "user", "Kevin", "hello")];
      let started = false;
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        maxAutomaticTurns: 1,
        createPipeline: () => ({
          decideOrchestrator: async () => ({ action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "reply" }),
          generateWaifu: async (request) => {
            if (!started) return blockingWaifu(() => (started = true))(request);
            return { content: "hi from channel 2" };
          }
        }),
        logger: quietLogger()
      });
      try {
        const first = runtime.triggerChannel("guild-1", "channel-1");
        await until(() => started, "channel-1 generation");
        await runtime.triggerChannel("guild-1", "channel-2");
        await first;
        expect(discord.sent.map((entry) => entry.content)).toEqual(["hi from channel 2"]);
        const preempted = await readSession(storage, "channel-1");
        expect(preempted.scheduledRetrigger?.source).toBe("preempted");
        const seconds = (Date.parse(preempted.scheduledRetriggerAt!) - Date.now()) / 1000;
        expect(seconds).toBeLessThanOrEqual(15);
      } finally {
        await runtime.stop();
      }
    });

    it("I9: an all-empty reply ends the pass loop instead of re-deciding on the same context", async () => {
      const root = await makeTempRoot();
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);
      const discord = new FakeDiscord();
      discord.fetchFreshContext = async () => [contextMessage("m1", "user", "Kevin", "hello")];
      await seedRuntimeConfig(storage);
      let decisions = 0;
      const runtime = new RuntimeOrchestrator({
        sleep: async () => undefined,
        storage,
        discord,
        maxAutomaticTurns: 8,
        createPipeline: () => ({
          decideOrchestrator: async () => {
            decisions += 1;
            return { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "reply" };
          },
          generateWaifu: async () => ({ content: "" })
        }),
        logger: quietLogger()
      });
      await runtime.triggerChannel("guild-1", "channel-1");
      await runtime.stop();
      expect(decisions).toBe(1);
      expect(discord.sent).toEqual([]);
      const session = await readSession(storage);
      expect(session.scheduledRetrigger?.source).toBe("nothing_sent");
    });

    describe("follow-ups: resume after pause, preemption fairness, wake backoff", () => {
      // Real-time poll that works while setTimeout is faked (setImmediate/Date stay real).
      const settle = async (predicate: () => boolean | Promise<boolean>, label: string) => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      type Gate = { promise: Promise<void>; open: () => void };
      const gate = (): Gate => {
        let open: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
          open = resolve;
        });
        return { promise, open };
      };
      // Each generateWaifu call takes the next scripted step: a string is sent immediately, a
      // Gate blocks until opened (then sends `content`) or rejects when the run is aborted.
      type Step = string | { gate: Gate; content: string; aborted?: boolean; started?: boolean };
      const scriptedWaifu = (steps: Step[]) => {
        let index = 0;
        return async (request: WaifuGenerationRequest) => {
          const step = steps[index++] ?? "extra";
          if (typeof step === "string") return { content: step };
          step.started = true;
          return new Promise<{ content: string }>((resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => {
                step.aborted = true;
                reject(request.signal?.reason);
              },
              { once: true }
            );
            void step.gate.promise.then(() => resolve({ content: step.content }));
          });
        };
      };
      const blocked = (content: string) => ({ gate: gate(), content }) as { gate: Gate; content: string; aborted?: boolean; started?: boolean };

      async function twoChannelRuntime(steps: Step[], options: { logger?: ReturnType<typeof quietLogger> } = {}) {
        const root = await makeTempRoot();
        roots.push(root);
        await ensureDataLayout(root);
        const storage = new StorageService(root);
        await seedRuntimeConfig(storage);
        const server = await storage.readJson("user/servers/guild-1/server.json", ServerConfigSchema);
        await storage.writeJson("server:guild-1", "user/servers/guild-1/server.json", ServerConfigSchema, {
          ...server,
          channels: { ...server.channels, "channel-2": { ...server.channels["channel-1"], channelId: "channel-2" } }
        });
        const discord = new FakeDiscord();
        discord.fetchFreshContext = async () => [contextMessage("m1", "user", "Kevin", "hello")];
        // one script shared by every pipeline instance (createPipeline runs per model call)
        const generateWaifu = scriptedWaifu(steps);
        const runtime = new RuntimeOrchestrator({
          sleep: async () => undefined,
          storage,
          discord,
          maxAutomaticTurns: 1,
          createPipeline: () => ({
            decideOrchestrator: async () => ({ action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }], reasoning: "reply" }),
            generateWaifu
          }),
          logger: options.logger ?? quietLogger()
        });
        return { storage, discord, runtime };
      }
      const timers = (runtime: RuntimeOrchestrator) =>
        (runtime as unknown as { runner: { retriggerTimers: Map<string, NodeJS.Timeout> } }).runner.retriggerTimers;

      it("resumeAfterPause: a runtime that booted paused re-arms persisted wakes once resumed", async () => {
        const root = await makeTempRoot();
        roots.push(root);
        await ensureDataLayout(root);
        const storage = new StorageService(root);
        const { ChannelSessionStateSchema, createEmptyChannelSessionState } = await import("../src/orchestration/session.js");
        await seedRuntimeConfig(storage);
        await storage.writeJson("session:guild-1:channel-1", sessionPath(), ChannelSessionStateSchema, {
          ...createEmptyChannelSessionState("guild-1", "channel-1"),
          scheduledRetriggerAt: new Date(Date.now() + 600_000).toISOString(),
          scheduledRetrigger: { source: "turn_limit", seconds: 900 }
        });
        let paused = true;
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        // no human in the room, so the planner restores the persisted clock rather than waking now
        const quietRoom = new FakeDiscord();
        quietRoom.contexts = [[contextMessage("m2", "waifu", "Yuki", "hi")]];
        const runtime = new RuntimeOrchestrator({
          sleep: async () => undefined,
          storage,
          discord: quietRoom,
          restartResumeDelayMs: 0,
          isPaused: () => paused,
          createPipeline: () => ({ generateWaifu: async () => ({ content: "unused" }) }),
          logger
        });
        try {
          await runtime.start();
          paused = false;
          runtime.resumeAfterPause();
          await until(() => timers(runtime).has("guild-1:channel-1"), "re-armed wake");
          const restored = logger.info.mock.calls.find(([message]) => message === "Restart resume: retrigger restored");
          expect((restored?.[1] as { seconds: number }).seconds).toBeGreaterThan(590);
          expect((await readSession(storage)).scheduledRetrigger?.source).toBe("turn_limit");
        } finally {
          await runtime.stop();
        }
      });

      it("resumeAfterPause: a live pause clears retrigger timers and resume re-arms them", async () => {
        const root = await makeTempRoot();
        roots.push(root);
        await ensureDataLayout(root);
        const storage = new StorageService(root);
        await seedRuntimeConfig(storage);
        let paused = false;
        const runtime = new RuntimeOrchestrator({
          sleep: async () => undefined,
          storage,
          discord: new FakeDiscord(),
          maxAutomaticTurns: 1,
          restartResumeDelayMs: 0,
          isPaused: () => paused,
          createPipeline: () => ({
            decideOrchestrator: async () => ({ action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" }),
            generateWaifu: async () => ({ content: "unused" })
          }),
          logger: quietLogger()
        });
        try {
          await runtime.triggerChannel("guild-1", "channel-1");
          expect(timers(runtime).has("guild-1:channel-1")).toBe(true);
          paused = true;
          await runtime.pause();
          expect(timers(runtime).size).toBe(0);
          paused = false;
          runtime.resumeAfterPause();
          await until(() => timers(runtime).has("guild-1:channel-1"), "re-armed wake after resume");
          expect((await readSession(storage)).scheduledRetrigger?.source).toBe("no_reply");
        } finally {
          await runtime.stop();
        }
      });

      it("resumeAfterPause: a redundant resume while running does nothing", async () => {
        const root = await makeTempRoot();
        roots.push(root);
        await ensureDataLayout(root);
        const storage = new StorageService(root);
        await seedRuntimeConfig(storage);
        const live = blocked("live reply");
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const discord = new FakeDiscord();
        const decideOrchestrator = replyOnce();
        const generateWaifu = scriptedWaifu([live, "duplicate"]);
        const runtime = new RuntimeOrchestrator({
          sleep: async () => undefined,
          storage,
          discord,
          maxAutomaticTurns: 1,
          restartResumeDelayMs: 0,
          createPipeline: () => ({ decideOrchestrator, generateWaifu }),
          logger
        });
        try {
          const run = runtime.triggerChannel("guild-1", "channel-1");
          await until(() => live.started === true, "live generation");
          runtime.resumeAfterPause();
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(live.aborted).toBeUndefined();
          live.gate.open();
          await run;
          expect(discord.sent.map((entry) => entry.content)).toEqual(["live reply"]);
          expect(logger.info).not.toHaveBeenCalledWith(
            "Restart resume: executing responders the restart interrupted",
            expect.anything()
          );
        } finally {
          await runtime.stop();
        }
      });

      it("a timer wake never aborts another channel's live run; it queues with its wake identity", async () => {
        const live = blocked("channel-1 reply");
        const { storage, discord, runtime } = await twoChannelRuntime([live]);
        try {
          const run = runtime.triggerChannel("guild-1", "channel-1", "message", { trigger: "message" });
          await until(() => live.started === true, "channel-1 generation");
          await runtime.triggerChannel("guild-1", "channel-2", "scheduled-retrigger", {
            trigger: "retrigger",
            wake: { source: "no_reply", seconds: 600, decisionId: "d-2" }
          });
          expect(live.aborted).toBeUndefined();
          live.gate.open();
          await run;
          expect(discord.sent.map((entry) => entry.content)).toEqual(["channel-1 reply"]);
          const queued = await readSession(storage, "channel-2");
          expect(queued.scheduledRetrigger).toEqual({ source: "no_reply", seconds: 600, decisionId: "d-2" });
          expect((Date.parse(queued.scheduledRetriggerAt!) - Date.now()) / 1000).toBeLessThanOrEqual(15);
        } finally {
          await runtime.stop();
        }
      });

      it("a preempted channel's re-trigger actually fires and runs the channel", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const first = blocked("never sent");
        const { discord, runtime } = await twoChannelRuntime([first, "channel-2 reply", "channel-1 again"]);
        try {
          const run = runtime.triggerChannel("guild-1", "channel-1", "message", { trigger: "message" });
          await settle(() => first.started === true, "channel-1 generation");
          await runtime.triggerChannel("guild-1", "channel-2", "message", { trigger: "message" });
          await run;
          expect(first.aborted).toBe(true);
          expect(timers(runtime).has("guild-1:channel-1")).toBe(true);
          await vi.advanceTimersByTimeAsync(10_000);
          await settle(() => discord.sent.length === 2, "re-triggered channel-1 reply");
          expect(discord.sent.map((entry) => entry.content)).toEqual(["channel-2 reply", "channel-1 again"]);
        } finally {
          await runtime.stop();
        }
      });

      it("two busy channels cannot ping-pong: a queued wake waits behind a live run", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const a1 = blocked("a1 never sent");
        const b2 = blocked("b2");
        const { discord, runtime } = await twoChannelRuntime([a1, "b1", b2, "a2"]);
        try {
          const aRun = runtime.triggerChannel("guild-1", "channel-1", "message", { trigger: "message" });
          await settle(() => a1.started === true, "a1");
          await runtime.triggerChannel("guild-1", "channel-2", "message", { trigger: "message" });
          await aRun;
          // channel-1 now has a short preempted wake; channel-2 gets busy again before it fires
          const bRun = runtime.triggerChannel("guild-1", "channel-2", "message", { trigger: "message" });
          await settle(() => b2.started === true, "b2");
          await vi.advanceTimersByTimeAsync(10_000);
          await settle(() => !timers(runtime).has("guild-1:channel-1"), "channel-1 wake fired");
          expect(b2.aborted).toBeUndefined();
          b2.gate.open();
          await bRun;
          await settle(() => timers(runtime).has("guild-1:channel-1"), "channel-1 re-queued wake");
          await vi.advanceTimersByTimeAsync(10_000);
          await settle(() => discord.sent.length === 3, "channel-1 finally runs");
          expect(discord.sent.map((entry) => entry.content)).toEqual(["b1", "b2", "a2"]);
        } finally {
          await runtime.stop();
        }
      });

      it("/stop removes a queued channel so it is never re-triggered", async () => {
        const a = blocked("never");
        const b = blocked("channel-2 reply");
        const { storage, runtime } = await twoChannelRuntime([a, b]);
        try {
          const aRun = runtime.triggerChannel("guild-1", "channel-1", "message", { trigger: "message" });
          await until(() => a.started === true, "channel-1");
          const bRun = runtime.triggerChannel("guild-1", "channel-2", "message", { trigger: "message" });
          await until(() => b.started === true, "channel-2");
          await aRun;
          await runtime.stopChannel("guild-1", "channel-1");
          b.gate.open();
          await bRun;
          expect(timers(runtime).has("guild-1:channel-1")).toBe(false);
          expect((await readSession(storage, "channel-1")).scheduledRetrigger).toBeUndefined();
        } finally {
          await runtime.stop();
        }
      });

      it("/stop during the queued re-trigger's session write still wins", async () => {
        const a = blocked("never");
        const b = blocked("channel-2 reply");
        const { storage, runtime } = await twoChannelRuntime([a, b]);
        try {
          const aRun = runtime.triggerChannel("guild-1", "channel-1", "message", { trigger: "message" });
          await until(() => a.started === true, "channel-1");
          const bRun = runtime.triggerChannel("guild-1", "channel-2", "message", { trigger: "message" });
          await until(() => b.started === true, "channel-2");
          await aRun;
          await new Promise((resolve) => setTimeout(resolve, 50));
          const writeGate = gate();
          let writeHeld = false;
          const original = storage.updateRevisionedJson.bind(storage);
          storage.updateRevisionedJson = (async (options: Parameters<typeof original>[0]) => {
            if (options.relativePath === sessionPath("channel-1") && !writeHeld) {
              writeHeld = true;
              await writeGate.promise;
            }
            return original(options);
          }) as typeof storage.updateRevisionedJson;
          b.gate.open();
          await until(() => writeHeld, "re-trigger session write");
          await runtime.stopChannel("guild-1", "channel-1");
          writeGate.open();
          await bRun;
          expect(timers(runtime).has("guild-1:channel-1")).toBe(false);
          expect((await readSession(storage, "channel-1")).scheduledRetrigger).toBeUndefined();
        } finally {
          await runtime.stop();
        }
      });

      it("a planned stop leaves a wake for a queued channel; a user pause does not", async () => {
        for (const halt of ["stop", "pause"] as const) {
          const a = blocked("never");
          const b = blocked("never either");
          const { storage, runtime } = await twoChannelRuntime([a, b]);
          const aRun = runtime.triggerChannel("guild-1", "channel-1", "message", { trigger: "message" });
          await until(() => a.started === true, "channel-1");
          const bRun = runtime.triggerChannel("guild-1", "channel-2", "message", { trigger: "message" });
          await until(() => b.started === true, "channel-2");
          await aRun;
          await (halt === "stop" ? runtime.stop() : runtime.pause());
          await bRun;
          const queued = await readSession(storage, "channel-1");
          if (halt === "stop") {
            expect(queued.scheduledRetrigger?.source).toBe("shutdown");
          } else {
            expect(queued.scheduledRetrigger).toBeUndefined();
            expect(timers(runtime).size).toBe(0);
            await runtime.stop();
          }
        }
      });

      it("B8: wake backoff compounds 1.5x across no_reply wakes and resets on a human-triggered run", async () => {
        const root = await makeTempRoot();
        roots.push(root);
        await ensureDataLayout(root);
        const storage = new StorageService(root);
        await seedRuntimeConfig(storage);
        await seedOrchestratorHistory(storage, [
          {
            id: "armer", guildId: "guild-1", channelId: "channel-1", action: "no_reply", respondingWaifus: [],
            retriggerAfterSeconds: 600, reasoning: "quiet", status: "completed",
            waifuMessageIds: [], responderOutcomes: [], createdAt: new Date().toISOString()
          }
        ]);
        const discord = new FakeDiscord();
        discord.fetchFreshContext = async () => [contextMessage("m1", "user", "Kevin", "hello")];
        const runtime = new RuntimeOrchestrator({
          sleep: async () => undefined,
          storage,
          discord,
          maxAutomaticTurns: 1,
          createPipeline: () => ({
            decideOrchestrator: async () => ({ action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" }),
            generateWaifu: async () => ({ content: "unused" })
          }),
          logger: quietLogger()
        });
        try {
          // second consecutive no_reply wake: the armed 900s grows to 1350s
          await runtime.triggerChannel("guild-1", "channel-1", "scheduled-retrigger", {
            trigger: "retrigger",
            wake: { source: "no_reply", seconds: 900, decisionId: "armer" }
          });
          expect((await readSession(storage)).scheduledRetrigger?.seconds).toBe(1350);
          // a human message resets the backoff to the model's own number
          await runtime.triggerChannel("guild-1", "channel-1", "message:1", { trigger: "message" });
          expect((await readSession(storage)).scheduledRetrigger?.seconds).toBe(600);
        } finally {
          await runtime.stop();
        }
      });
    });
  });

  it("loop notice reaches the trailing prompt and unlocks the budget", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    // First decision honors a directive (closing the budget). The second turn's context trips the
    // loop detector, which should reopen the budget so the second directive is honored anyway.
    // Separate replies a minute apart (quick consecutive chunks of one reply are joined).
    const loopyContext = [
      contextMessage("c1", "user", "Kevin", "what about the weekend trip plans"),
      { ...contextMessage("w1", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"), timestamp: "2026-05-16T12:01:00Z" },
      { ...contextMessage("w2", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"), timestamp: "2026-05-16T12:02:00Z" },
      { ...contextMessage("w3", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"), timestamp: "2026-05-16T12:03:00Z" },
      { ...contextMessage("w4", "waifu", "Yuki", "the weekend trip plans sound fun and exciting"), timestamp: "2026-05-16T12:04:00Z" }
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
        trailingPrompts.push(request.prompt!.debug.tail);
        const decision = (this as unknown as { decisions: OrchestratorDecision[] }).decisions.shift();
        if (!decision) throw new Error("No fake decision left.");
        return decision;
      },
      async generateWaifu(request) {
        waifuTrailingBlocks.push(directionView(request));
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
    expect(waifuTrailingBlocks[1]).toContain("<direction>(break loop) switch gears entirely</direction>");
    // The second orchestrator turn saw the loop notice and the open budget in its tail.
    expect(trailingPrompts[1]).toContain("<runtime_notice>");
    expect(trailingPrompts[1]).toContain("Directive budget: open (a loop is forming");
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
    // Her own prior message (authored by her bot id) is an assistant turn in her transcript.
    expect(promptOf(capturedRequest!).debug.transcript).toContain("(you) hi Kevin");
  });

  it("resolves selfAuthorIds through the discord-bots entry so snowflake authorIds match", async () => {
    // Production shape: waifu.botId holds the discord-bots ENTRY id ("aria"), while Discord
    // message authorIds carry the bot user snowflake (=== the entry's applicationId). Both ids
    // must land in selfAuthorIds or the waifu never recognizes her own prior messages.
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    const context = [
      contextMessage("m1", "user", "Kevin", "hey"),
      contextMessage("m2", "waifu", "Aria", "hi Kevin", undefined, {
        authorId: "111222333444555666",
        authorBot: true
      })
    ];
    discord.contexts = [context, context];

    await seedRuntimeConfig(storage);
    await seedDiscordBots(storage, [
      { id: "aria", displayName: "Aria", applicationId: "111222333444555666", enabled: true }
    ]);
    await seedWaifu(storage, "aria", "Aria", "aria", "playful");
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
        return { content: "hey hey" };
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

    // The snowflake-authored message is recognized as hers (assistant turn, not a user line).
    expect(promptOf(capturedRequest!).debug.transcript).toContain("(you) hi Kevin");
    expect(promptOf(capturedRequest!).debug.transcript).not.toContain("Aria: hi Kevin");
  });

  it("self-repeat guard catches a repeat when own prior messages carry snowflake authorIds", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    const repeated = "my smoke alarm went off making toast again, i'm cursed";
    const context = [
      contextMessage("m1", "user", "Kevin", "hey"),
      contextMessage("m2", "waifu", "Aria", repeated, undefined, {
        authorId: "111222333444555666",
        authorBot: true
      }),
      contextMessage("m3", "user", "Kevin", "lol")
    ];
    discord.contexts = [context, context];

    await seedRuntimeConfig(storage);
    await seedDiscordBots(storage, [
      { id: "aria", displayName: "Aria", applicationId: "111222333444555666", enabled: true }
    ]);
    await seedWaifu(storage, "aria", "Aria", "aria", "playful");
    await enableWaifus(storage, ["aria"]);

    let generateCalls = 0;
    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "aria", delaySeconds: 0 }],
          reasoning: "Aria should reply."
        };
      },
      async generateWaifu() {
        generateCalls += 1;
        return { content: repeated };
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

    // Identical to her own prior message: one corrective retry, then block — nothing sent.
    expect(generateCalls).toBe(2);
    expect(discord.sent).toHaveLength(0);
  });

  // Acceptance M2: the orchestrator usually reconciles a new message first, freezing its ledger
  // render for every agent, so its prepare must resolve mentions and custom emoji too.
  it("the orchestrator's prepare freezes mentions and custom emoji with the guild directory", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();
    discord.contexts = [[contextMessage("m1", "user", "Kevin", "hey <@555000111> look <:cat:777000111>")]];
    await seedRuntimeConfig(storage);
    await seedDiscordBots(storage, [{ id: "aria", displayName: "Aria", applicationId: "111222333444555666", enabled: true }]);
    await storage.writeJson(
      "members:guild-1",
      "user/servers/guild-1/members.json",
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(
        createEmptyRevisionedFile({
          guildId: "guild-1",
          members: [{ userId: "555000111", guildDisplayName: "Bob", bot: false, perChannelLastSeenAt: {} }]
        })
      )
    );
    await storage.writeJson(
      "emojis:guild-1",
      "user/servers/guild-1/emojis.json",
      GuildEmojisFileSchema,
      GuildEmojisFileSchema.parse(
        createEmptyRevisionedFile({ guildId: "guild-1", emojis: [{ id: "777000111", name: "cutecat", fetchedAt: "2026-10-24T00:00:00.000Z" }] })
      )
    );
    await seedWaifu(storage, "aria", "Aria", "aria", "playful");
    await enableWaifus(storage, ["aria"]);
    let transcript = "";
    const runtime = new RuntimeOrchestrator({
      sleep: async () => undefined,
      storage,
      discord,
      maxAutomaticTurns: 1,
      createPipeline: () => ({
        async decideOrchestrator(request) {
          transcript = promptOf(request).debug.transcript;
          return { action: "no_reply", respondingWaifus: [], reasoning: "Wait." };
        },
        async generateWaifu() {
          throw new Error("no waifu turn expected");
        }
      }),
      logger: quietLogger()
    });

    await runtime.triggerChannel("guild-1", "channel-1");
    await runtime.stop();

    expect(transcript).toContain("Kevin: hey <@Bob> look <:cutecat:>");
    const ledger = JSON.parse(await readFile(path.join(root, "user/conversations/g_guild-1_channel-1/ledger.json"), "utf8"));
    expect(ledger.entries.m1.body).toContain("hey <@Bob> look <:cutecat:>");
  });

  it("resolves serverNickname and roster names via the bots entry applicationId", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    await seedRuntimeConfig(storage);
    await seedDiscordBots(storage, [
      { id: "aria", displayName: "Aria", applicationId: "111222333444555666", enabled: true },
      { id: "yuki", displayName: "Yuki", applicationId: "999888777666555444", enabled: true }
    ]);
    // members.json is keyed by the bot USER snowflake, never the entry id.
    await storage.writeJson(
      "members:guild-1",
      "user/servers/guild-1/members.json",
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(
        createEmptyRevisionedFile({
          guildId: "guild-1",
          members: [
            { userId: "111222333444555666", guildDisplayName: "K的小娇妻", bot: true, perChannelLastSeenAt: {} },
            { userId: "999888777666555444", guildDisplayName: "Yuki-chan", bot: true, perChannelLastSeenAt: {} }
          ]
        })
      )
    );
    await seedWaifu(storage, "aria", "Aria", "aria", "playful");
    await seedWaifu(storage, "yuki", "Yuki", "yuki", "kind");
    await enableWaifus(storage, ["aria", "yuki"]);

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

    expect(promptOf(capturedRequest!).debug.system).toContain(`shown in this server as "K的小娇妻"`);
    expect(promptOf(capturedRequest!).debug.system).toContain("Yuki-chan (Yuki)");
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
        expect(promptOf(request).debug.system).toContain(`shown in this server as "K的小娇妻"`);
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

  it("guild nickname from members.json reaches the impersonation-strip alias set", async () => {
    // Yuki has guildDisplayName "K的小娇妻" in members.json. The context contains NO prior
    // message from Yuki (so "K的小娇妻" is NOT in selfDisplayNames derived from context messages).
    // The model returns "K的小娇妻: first reply here". The runtime must strip the prefix via the
    // guild-nickname alias path and send "first reply here".
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const storage = new StorageService(root);
    const discord = new FakeDiscord();

    // Context: one user message only — no prior Yuki message.
    discord.contexts = [
      [contextMessage("m1", "user", "Kevin", "hey")],
      [contextMessage("m1", "user", "Kevin", "hey")]
    ];

    await seedRuntimeConfig(storage);
    await seedWaifu(storage, "yuki", "Yuki", "yuki-bot", "calm");
    await enableWaifus(storage, ["yuki"]);

    // Seed members.json with Yuki's botId having a guild nickname that differs from displayName.
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

    const pipeline: ModelPipeline = {
      async decideOrchestrator() {
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: "yuki", delaySeconds: 0 }],
          reasoning: "Yuki should reply."
        };
      },
      async generateWaifu() {
        // The nickname prefix must be stripped even though it never appeared in the context.
        return { content: "K的小娇妻: first reply here" };
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

    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0].content).toBe("first reply here");
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

async function setWaifuVerbosity(storage: StorageService, waifuId: string, verbosity: "terse" | "chatty" | "expressive") {
  const path = `user/waifus/${waifuId}/waifu.json`;
  const config = await storage.readJson(path, WaifuConfigSchema);
  await storage.writeJson(`waifu:${waifuId}`, path, WaifuConfigSchema, WaifuConfigSchema.parse({ ...config, verbosity }));
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

/** The orchestrator decision history (one place to change when it moves to per-guild files). */
async function readDecisionHistory(storage: StorageService) {
  return storage.readJson("user/orchestrator/history.json", OrchestratorHistoryFileSchema);
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

async function seedDiscordBots(storage: StorageService, waifus: Array<Partial<DiscordBotConfig> & { id: string; displayName: string }>) {
  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(
      createEmptyRevisionedFile({
        orchestrator: null,
        waifus
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

/** This turn's orchestrator directive as a transcript `direction` note (spec 8.5). */
function expectedDirectorNote(text: string): string {
  return `<direction>${text}</direction>`;
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

/** The context-engine prompt of a waifu generation request (spec 8.5). */
function promptOf(request: WaifuGenerationRequest): BuiltPrompt {
  if (!request.prompt) throw new Error("waifu request without a context-engine prompt");
  return request.prompt;
}

/** Everything the waifu model saw, as plain text (system, header, transcript, tail). */
function promptText(request: WaifuGenerationRequest): string {
  const { debug } = promptOf(request);
  return [debug.system, debug.header, debug.transcript, debug.tail].join("\n");
}

/** The retry note in the ephemeral tail (spec 6.3: never a user turn written as the waifu). */
function retryNoteOf(request: WaifuGenerationRequest): string | undefined {
  return promptOf(request)
    .debug.tail.split("\n")
    .find((line) => line.startsWith("Your last"));
}

/** Her transcript plus the tail: where earlier directions (notes) and this turn's (tail) appear. */
function directionView(request: WaifuGenerationRequest): string {
  return `${promptOf(request).debug.transcript}\n${promptOf(request).debug.tail}`;
}

/** This turn's direction (in the tail), if any. */
function latestDirection(request: WaifuGenerationRequest): string | undefined {
  return [...promptOf(request).debug.tail.matchAll(/<direction>([^<]*)<\/direction>/g)].at(-1)?.[1];
}
