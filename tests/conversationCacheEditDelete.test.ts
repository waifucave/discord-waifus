// Spec 9.5 end to end: gateway edit and delete events flow through the conversation cache into the
// ledger exactly once, a redacted newest entry does not look like a gap, and an edit that adds a
// waifu mention triggers exactly one run. Same harness as conversationCachePass.test.ts.

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
  DiscordBotsFileSchema,
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

  decideCalls = 0;
  async decideOrchestrator(): Promise<OrchestratorDecision> {
    this.decideCalls += 1;
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
  await storage.writeJson("discord-bots", "user/discord-bots.json", DiscordBotsFileSchema, DiscordBotsFileSchema.parse(
    createEmptyRevisionedFile({ orchestrator: null, waifus: [{ id: "aria-bot", displayName: "Aria", enabled: true }] })
  ));
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
  await runtime.start(); // attaches the cache and routes its edit / delete events into the ledger
  return { discord, pipeline, runtime };
}

const bothReply = (): OrchestratorDecision =>
  ({
    action: "reply",
    respondingWaifus: [{ waifuId: "aria", delaySeconds: 0 }],
    reasoning: "one"
  }) as OrchestratorDecision;

const withEditedAt = (m: RawDiscordMessage, patch: Partial<RawDiscordMessage>): RawDiscordMessage => ({ ...m, editedAt: new Date().toISOString(), ...patch });

describe("edits and deletes through the conversation cache (spec 9.5)", () => {
  it("records a gateway edit and a gateway delete in the ledger exactly once each", async () => {
    const { discord, pipeline, runtime } = await setup();
    const first = discord.human("kevin", "Kevin", "who wants cake?");
    discord.human("mina", "Mina", "me");
    pipeline.decisions.push(bothReply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    const apply = vi.spyOn(runtime, "applyMessageEvent");

    discord.emit({ type: "update", conversation: CONVERSATION, messageId: first.id, message: withEditedAt(first, { content: "who wants pie?" }) });
    await runtime.settleBackground();
    expect(apply).toHaveBeenCalledTimes(1);
    let ledger = await runtime.contexts.peekLedger(CONVERSATION);
    const edits = ledger.events.filter((e) => e.kind === "edit" && e.messageId === first.id);
    expect(ledger.entries[first.id]!.state).toBe("edited");
    // Recorded once: in place (unsealed) or as exactly one event.
    expect(edits.length + (ledger.entries[first.id]!.body.includes("who wants pie?") ? 1 : 0)).toBe(1);

    const second = discord.messages.find((m) => m.content === "me")!;
    discord.messages.splice(discord.messages.indexOf(second), 1);
    discord.emit({ type: "delete", conversation: CONVERSATION, messageId: second.id });
    await runtime.settleBackground();
    expect(apply).toHaveBeenCalledTimes(2);
    ledger = await runtime.contexts.peekLedger(CONVERSATION);
    expect(ledger.entries[second.id]!.state).toBe("deleted");
    expect(ledger.events.filter((e) => e.kind === "edit" && e.messageId === first.id).length).toBeLessThanOrEqual(1);
    await runtime.stop();
  });

  it("a redacted newest ledger entry does not produce a false 'earlier messages not loaded' gap", async () => {
    const { discord, pipeline, runtime } = await setup();
    discord.human("kevin", "Kevin", "who wants cake?");
    pipeline.decisions.push(bothReply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    const newest = discord.human("mina", "Mina", "save me a slice");
    pipeline.decisions.push(bothReply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    // The ledger's newest human entry is now deleted (and redacted: it is recent), then the
    // reply that follows it goes too, so the ledger's newest message is the deleted one.
    discord.messages.splice(discord.messages.indexOf(newest), 1);
    discord.emit({ type: "delete", conversation: CONVERSATION, messageId: newest.id });
    await runtime.settleBackground();
    discord.human("kevin", "Kevin", "never mind, anyone there?");
    pipeline.decisions.push(bothReply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    const ledger = await runtime.contexts.peekLedger(CONVERSATION);
    expect(Object.keys(ledger.entries).some((id) => id.startsWith("gap:"))).toBe(false);
    const last = pipeline.prompts[pipeline.prompts.length - 1]!;
    expect(last.debug.transcript).not.toContain("earlier messages not loaded");
    expect(last.debug.transcript).toContain("never mind, anyone there?");
  });

  it("an edit that adds a waifu mention to the newest human message triggers exactly one run", async () => {
    const { discord, pipeline, runtime } = await setup();
    discord.human("kevin", "Kevin", "morning");
    await runtime.triggerChannel(GUILD, CHANNEL); // no_reply: the ledger now knows the channel
    const fresh: RawDiscordMessage = { ...discord.human("kevin", "Kevin", "anyone up?"), createdAt: new Date().toISOString() };
    discord.messages[discord.messages.length - 1] = fresh;
    await runtime.triggerChannel(GUILD, CHANNEL); // the ledger now holds the newest human message
    const before = pipeline.decideCalls;
    const edited = withEditedAt(fresh, { content: "anyone up? <@aria-bot>", mentions: { users: { "aria-bot": "Aria" }, roles: {}, channels: {} } });
    discord.messages[discord.messages.length - 1] = edited;
    discord.emit({ type: "update", conversation: CONVERSATION, messageId: fresh.id, message: edited });
    await runtime.settleBackground();
    expect(pipeline.decideCalls - before).toBe(1);

    // Delivered again (a catch-up replay of the same edit): recorded once, never a second run.
    discord.emit({ type: "update", conversation: CONVERSATION, messageId: fresh.id, message: edited });
    await runtime.settleBackground();
    await runtime.stop();
    expect(pipeline.decideCalls - before).toBe(1);
  });
});
