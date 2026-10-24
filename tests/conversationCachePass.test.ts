// Spec 9.8 acceptance 6: a pass with two responders makes at most 1 Discord message fetch and 0
// reaction-user fetches when the conversation cache is trusted. Driven through the real
// RuntimeOrchestrator -> ChannelRunner -> ResponderExecutor -> ContextRuntime -> cache, with a
// scripted pipeline and a Discord facade whose every fetch path is a spy.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import type { DiscordConversationEvent, DiscordConversationEventListener } from "../src/discord/gatewayEvents.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import type { OrchestratorDecision } from "../src/orchestration/decisions.js";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import type { BuiltPrompt } from "../src/orchestration/context/types.js";
import type { ModelPipeline, WaifuGenerationRequest, WaifuGenerationResult } from "../src/providers/types.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import {
  AgentConfigSchema,
  ProviderCredentialsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const CONVERSATION = { kind: "guild" as const, guildId: GUILD, channelId: CHANNEL };

/** A channel behind a facade where every way of reading messages or reaction users is counted. */
class SpyDiscord implements DiscordGatewayFacade {
  readonly messages: RawDiscordMessage[] = [];
  readonly fetchContextSince = vi.fn(async (i: { afterMessageId: string | null; maxMessages: number }) => {
    const index = i.afterMessageId === null ? -1 : this.messages.findIndex((m) => m.id === i.afterMessageId);
    const after = this.messages.slice(index + 1);
    return { messages: after.slice(-i.maxMessages), reachedCursor: after.length <= i.maxMessages };
  });
  /** The legacy full-context read; it resolves reaction users through `usersFetch`, like discord.js. */
  readonly usersFetch = vi.fn(async () => []);
  readonly fetchFreshContext = vi.fn(async (): Promise<ContextMessage[]> => {
    await this.usersFetch();
    return [];
  });
  private readonly listeners = new Set<DiscordConversationEventListener>();
  private counter = 300_000_000_000_000_000n;
  private clock = Date.now() - 3_600_000; // reactions are timestamped with the real clock
  /** Runs right after a waifu's message is sent (the reaction that lands mid-pass). */
  afterSend: ((message: RawDiscordMessage) => void) | undefined;

  readonly onConversationEvent = (listener: DiscordConversationEventListener) => {
    this.listeners.add(listener);
    listener({ type: "connection", scope: "guild", state: "ready" });
    return () => this.listeners.delete(listener);
  };
  readonly ownAuthorIds = () => ["aria-bot", "riko-bot"];

  emit(event: DiscordConversationEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private make(authorId: string, authorName: string, content: string, bot: boolean): RawDiscordMessage {
    this.counter += 1n;
    this.clock += 60_000;
    const message: RawDiscordMessage = {
      id: this.counter.toString(),
      channelId: CHANNEL,
      guildId: GUILD,
      authorId,
      authorName,
      authorIsBot: bot,
      createdAt: new Date(this.clock).toISOString(),
      type: 0,
      content,
      attachments: [],
      embeds: [],
      stickers: [],
      snapshots: [],
      mentions: { users: {}, roles: {}, channels: {} }
    };
    this.messages.push(message);
    return message;
  }

  /** A human message: stored, then delivered over the gateway. */
  human(authorId: string, authorName: string, content: string): RawDiscordMessage {
    const message = this.make(authorId, authorName, content, false);
    this.emit({ type: "create", conversation: CONVERSATION, message });
    return message;
  }

  async connect() {
    return { connected: true, orchestratorConnected: true, waifuBotCount: 2, warnings: [] };
  }
  async disconnect() {}

  async sendWaifuMessage(input: { content: string; senderBotId?: string }) {
    const bot = input.senderBotId ?? "aria-bot";
    const message = this.make(bot, bot === "riko-bot" ? "Riko" : "Aria", input.content, true);
    // Published before sendWaifuMessage returns, like DiscordJsGateway.
    this.emit({ type: "create", own: true, conversation: CONVERSATION, message });
    // ...and the orchestrator's own gateway delivers the same message a moment later.
    this.emit({ type: "create", conversation: CONVERSATION, message });
    this.afterSend?.(message);
    return { messageId: message.id };
  }

  async sendTyping() {}
}

class ScriptedPipeline implements ModelPipeline {
  readonly prompts: BuiltPrompt[] = [];
  decisions: OrchestratorDecision[] = [];

  async decideOrchestrator(): Promise<OrchestratorDecision> {
    return this.decisions.shift() ?? { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" };
  }

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    this.prompts.push(request.prompt!);
    return { content: `reply ${this.prompts.length}` };
  }
}

async function setup() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const now = new Date().toISOString();
  await storage.writeJson("providers", "user/providers.json", ProviderCredentialsFileSchema, ProviderCredentialsFileSchema.parse(
    createEmptyRevisionedFile({ providers: { openai: { providerId: "openai", apiKey: "sk-test", createdAt: now, updatedAt: now } } })
  ));
  await storage.writeJson("orchestrator", "user/orchestrator/config.json", AgentConfigSchema, AgentConfigSchema.parse({
    ...createRevisionedBase(), enabled: true, providerId: "openai", modelId: "gpt-5.4-mini", contextWindow: 20, prompt: "decide"
  }));
  await storage.writeJson(`server:${GUILD}`, `user/servers/${GUILD}/server.json`, ServerConfigSchema, ServerConfigSchema.parse({
    ...createRevisionedBase(),
    guildId: GUILD,
    name: "Bake Club",
    enabled: true,
    tools: { shortTermMemory: true, pickNextWaifu: false },
    channels: { [CHANNEL]: { channelId: CHANNEL, name: "general", enabled: true, enabledWaifuIds: ["aria", "riko"] } }
  }));
  for (const [id, name] of [["aria", "Aria"], ["riko", "Riko"]] as const) {
    await storage.writeJson(`waifu:${id}`, `user/waifus/${id}/waifu.json`, WaifuConfigSchema, WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id, name, displayName: name, enabled: true, providerId: "openai", modelId: "gpt-5.4-mini",
      botId: `${id}-bot`, persona: "sunny baker", contextWindow: 50,
      availability: { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [] }
    }));
  }
  const discord = new SpyDiscord();
  const pipeline = new ScriptedPipeline();
  const runtime = new RuntimeOrchestrator({
    sleep: async () => undefined,
    storage,
    discord,
    maxAutomaticTurns: 1,
    createPipeline: () => pipeline,
    logger: quietLogger()
  });
  runtime.conversations.attach(); // start() does this in production
  return { discord, pipeline, runtime };
}

const bothReply = (): OrchestratorDecision =>
  ({
    action: "reply",
    respondingWaifus: [
      { waifuId: "aria", delaySeconds: 0 },
      { waifuId: "riko", delaySeconds: 0 }
    ],
    reasoning: "both"
  }) as OrchestratorDecision;

const messageFetches = (discord: SpyDiscord) => discord.fetchContextSince.mock.calls.length + discord.fetchFreshContext.mock.calls.length;

describe("acceptance 6: a pass with two responders through the real runtime", () => {
  it("costs one fetch while untrusted, then none; never fetches reaction users; responder 2 sees responder 1", async () => {
    const { discord, pipeline, runtime } = await setup();

    // Pass 1 starts untrusted (boot): the whole pass, orchestrator + two responders, shares one fetch.
    discord.human("kevin", "Kevin", "who wants cake?");
    pipeline.decisions.push(bothReply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    expect(pipeline.prompts).toHaveLength(2);
    expect(messageFetches(discord)).toBeLessThanOrEqual(1);
    expect(runtime.conversations.isTrusted(CONVERSATION)).toBe(true);
    expect(pipeline.prompts[1]!.debug.transcript).toContain("reply 1"); // Riko saw Aria's message

    // Pass 2 is trusted: no message fetch at all, even though a reaction lands in the middle of it.
    discord.human("mina", "Mina", "save me a slice");
    const reacted = discord.messages.find((m) => m.content === "who wants cake?")!;
    discord.afterSend = (sent) => {
      discord.afterSend = undefined;
      discord.emit({
        type: "reaction",
        conversation: CONVERSATION,
        action: "add",
        messageId: sent.id,
        emoji: { name: "😂" },
        count: 1,
        userId: "kevin",
        userName: "Kevin"
      });
      discord.emit({ type: "reaction", conversation: CONVERSATION, action: "add", messageId: reacted.id, emoji: { name: "🎂" }, userId: "mina", userName: "Mina" });
    };
    const before = messageFetches(discord);
    pipeline.decisions.push(bothReply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    expect(pipeline.prompts).toHaveLength(4);
    expect(messageFetches(discord) - before).toBe(0);
    expect(discord.usersFetch).not.toHaveBeenCalled();
    expect(pipeline.prompts[3]!.debug.transcript).toContain("reply 3"); // Riko saw Aria's second message
    expect(pipeline.prompts[3]!.debug.tail).toMatch(/Kevin reacted 😂 to #/);
  });
});
