// The waifu reply path end to end through RuntimeOrchestrator → ResponderExecutor →
// ContextRuntime.prepare/call/commit (spec 8.5): prefix stability across turns, direction notes,
// tool notes and suppression, the reply marker, and the I5 length retry.

import type { ChatMessage } from "@waifucave/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { stripCacheMarkers } from "../src/orchestration/context/builder.js";
import { conversationKey, contextStatePath } from "../src/orchestration/context/keys.js";
import type { BuiltPrompt } from "../src/orchestration/context/types.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import type { OrchestratorDecision } from "../src/orchestration/decisions.js";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import { CUT_OFF_RETRY_NOTE } from "../src/orchestration/verbosity.js";
import type { ModelPipeline, WaifuGenerationRequest, WaifuGenerationResult } from "../src/providers/types.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ContextStateSchema } from "../src/shared/schemas/context.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import {
  AgentConfigSchema,
  MemoryStoreSchema,
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

/** One Discord channel: humans post into it; waifu sends land in it like real messages. */
class ChannelDiscord implements DiscordGatewayFacade {
  readonly messages: RawDiscordMessage[] = [];
  readonly sent: Array<{ content: string; replyToMessageId?: string }> = [];
  private counter = 300_000_000_000_000_000n;
  private clock = Date.parse("2026-10-24T14:00:00.000Z");

  post(authorId: string, authorName: string, content: string, o: { bot?: boolean; replyTo?: string } = {}): RawDiscordMessage {
    this.counter += 1n;
    this.clock += 60_000;
    const message: RawDiscordMessage = {
      id: this.counter.toString(),
      channelId: CHANNEL,
      guildId: GUILD,
      authorId,
      authorName,
      authorIsBot: o.bot ?? false,
      createdAt: new Date(this.clock).toISOString(),
      type: o.replyTo ? 19 : 0,
      content,
      attachments: [],
      embeds: [],
      stickers: [],
      snapshots: [],
      ...(o.replyTo ? { referenceMessageId: o.replyTo } : {}),
      mentions: { users: {}, roles: {}, channels: {} }
    };
    this.messages.push(message);
    return message;
  }

  async connect() {
    return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
  }
  async disconnect() {}

  async fetchFreshContext(): Promise<ContextMessage[]> {
    return this.messages.slice(-20).map((m) => ({
      id: m.id,
      channelId: m.channelId,
      guildId: m.guildId,
      authorKind: m.authorIsBot ? "waifu" : "user",
      authorId: m.authorId,
      authorBot: m.authorIsBot,
      name: m.authorName,
      displayName: m.authorName,
      content: m.content,
      timestamp: m.createdAt,
      reactions: []
    }));
  }

  async fetchContextSince(i: { afterMessageId: string | null; maxMessages: number }) {
    const index = i.afterMessageId === null ? -1 : this.messages.findIndex((m) => m.id === i.afterMessageId);
    const after = this.messages.slice(index + 1);
    return { messages: after.slice(-i.maxMessages), reachedCursor: after.length <= i.maxMessages };
  }

  async sendWaifuMessage(input: { content: string; replyToMessageId?: string }) {
    this.sent.push({ content: input.content, ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}) });
    const message = this.post("aria-bot", "Aria", input.content, { bot: true, ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}) });
    return { messageId: message.id };
  }

  async sendTyping() {}
}

class ScriptedPipeline implements ModelPipeline {
  readonly prompts: BuiltPrompt[] = [];
  readonly requests: WaifuGenerationRequest[] = [];
  decisions: OrchestratorDecision[] = [];
  replies: WaifuGenerationResult[] = [];

  async decideOrchestrator(): Promise<OrchestratorDecision> {
    return this.decisions.shift() ?? { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" };
  }

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    this.requests.push(request);
    this.prompts.push(request.prompt!);
    return this.replies.shift() ?? { content: "ok" };
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
    channels: { [CHANNEL]: { channelId: CHANNEL, name: "general", enabled: true, enabledWaifuIds: ["aria"] } }
  }));
  await storage.writeJson("waifu:aria", "user/waifus/aria/waifu.json", WaifuConfigSchema, WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id: "aria", name: "Aria", displayName: "Aria", enabled: true, providerId: "openai", modelId: "gpt-5.4-mini",
    botId: "aria-bot", persona: "sunny baker", contextWindow: 50,
    availability: { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [] }
  }));
  const discord = new ChannelDiscord();
  const pipeline = new ScriptedPipeline();
  const runtime = new RuntimeOrchestrator({
    sleep: async () => undefined,
    storage,
    discord,
    maxAutomaticTurns: 1,
    createPipeline: () => pipeline,
    logger: quietLogger()
  });
  return { storage, discord, pipeline, runtime };
}

function reply(directive?: { intent: string; goal: string }, replyToMessageId?: string): OrchestratorDecision {
  return {
    action: "reply",
    respondingWaifus: [{ waifuId: "aria", delaySeconds: 0, ...(directive ? { directive } : {}), ...(replyToMessageId ? { replyToMessageId } : {}) }],
    reasoning: "aria"
  } as OrchestratorDecision;
}

/** Every content block in order, cache markers stripped (tool results as one block). */
function blocks(messages: ChatMessage[]): unknown[] {
  return stripCacheMarkers(messages).flatMap((m) =>
    m.role === "tool" || typeof m.content === "string" ? [{ role: m.role, m }] : m.content.map((b) => ({ role: m.role, b }))
  );
}

async function contextState(storage: StorageService) {
  return storage.readJson(contextStatePath(conversationKey(CONVERSATION), { kind: "waifu", waifuId: "aria" }), ContextStateSchema);
}

describe("waifu reply path on the context engine", () => {
  it("keeps the prefix stable across turns (everything but the tail is a prefix of the next prompt)", async () => {
    const { discord, pipeline, runtime } = await setup();
    discord.post("kevin", "Kevin", "morning!");
    pipeline.decisions.push(reply({ intent: "spotlight", goal: "greet Kevin" }));
    pipeline.replies.push({ content: "morning kevin" });
    await runtime.triggerChannel(GUILD, CHANNEL);

    discord.post("kevin", "Kevin", "what are you baking today?");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "lemon bars probably" });
    await runtime.triggerChannel(GUILD, CHANNEL);

    discord.post("mina", "Mina", "save me one");
    pipeline.decisions.push(reply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    expect(pipeline.prompts).toHaveLength(3);
    for (let n = 1; n < pipeline.prompts.length; n += 1) {
      const previous = blocks(pipeline.prompts[n - 1]!.messages).slice(0, -1); // drop the ephemeral tail
      const next = blocks(pipeline.prompts[n]!.messages);
      expect(next.slice(0, previous.length)).toEqual(previous);
    }
    for (const prompt of pipeline.prompts) {
      expect(prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
      expect(prompt.promptCacheKey).toBe(`waifu:aria:${conversationKey(CONVERSATION)}`);
    }
    // Her own sent messages are assistant turns of her transcript.
    expect(pipeline.prompts[2]!.debug.transcript).toContain("(you) lemon bars probably");
    expect(discord.sent.map((m) => m.content)).toEqual(["morning kevin", "lemon bars probably", "ok"]);
  });

  it("persists this turn's direction as a transcript note that stays there", async () => {
    const { storage, discord, pipeline, runtime } = await setup();
    discord.post("kevin", "Kevin", "anyone up?");
    pipeline.decisions.push(reply({ intent: "change_topic", goal: "bring up the bake sale" }));
    await runtime.triggerChannel(GUILD, CHANNEL);
    discord.post("kevin", "Kevin", "oh nice");
    pipeline.decisions.push(reply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    const direction = "<direction>(change topic) bring up the bake sale</direction>";
    expect(pipeline.prompts[0]!.debug.transcript).toContain(direction);
    expect(pipeline.prompts[1]!.debug.transcript).toContain(direction);
    expect(pipeline.prompts[1]!.debug.transcript.match(/<direction>/g)).toHaveLength(1);
    // The direction is user-role content, never a mid-transcript system message.
    expect(pipeline.prompts[0]!.messages.slice(1).every((m) => m.role !== "system")).toBe(true);
    const state = await contextState(storage);
    expect(state.notes.filter((n) => n.kind === "direction").map((n) => n.kind === "direction" && n.text)).toEqual([
      "(change topic) bring up the bake sale"
    ]);
  });

  it("records tool calls as tool notes; a suppressed add_memory is answered `ignored` and stays listed", async () => {
    const { storage, discord, pipeline, runtime } = await setup();
    discord.post("kevin", "Kevin", "i'm off to tokyo next week");
    // Turn 1: a tool-only add_memory turn (no visible text) → the next decision suppresses add_memory.
    pipeline.decisions.push(reply());
    pipeline.replies.push({
      content: "",
      toolCalls: [{ id: "call_1", name: "add_memory", arguments: '{"content":"Kevin goes to Tokyo next week."}' }],
      shortTermMemoryEntries: ["Kevin goes to Tokyo next week."]
    });
    await runtime.triggerChannel(GUILD, CHANNEL);
    // Turn 2: add_memory again (suppressed) with a visible reply.
    discord.post("kevin", "Kevin", "any tips?");
    pipeline.decisions.push(reply());
    pipeline.replies.push({
      content: "eat everything",
      toolCalls: [{ id: "call_2", name: "add_memory", arguments: '{"content":"Kevin wants Tokyo tips."}' }],
      shortTermMemoryEntries: ["Kevin wants Tokyo tips."]
    });
    await runtime.triggerChannel(GUILD, CHANNEL);
    // Turn 3: the tool turns are in her transcript.
    discord.post("kevin", "Kevin", "lol ok");
    pipeline.decisions.push(reply());
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    // The tool list never toggles (breakpoint A stays stable).
    expect(pipeline.prompts.map((p) => p.tools.map((t) => t.name))).toEqual([["add_memory"], ["add_memory"], ["add_memory"]]);
    expect(pipeline.prompts[1]!.messages[0]).toEqual(pipeline.prompts[0]!.messages[0]);

    const state = await contextState(storage);
    expect(state.notes.filter((n) => n.kind === "tool").map((n) => n.kind === "tool" && [n.callId, n.result])).toEqual([
      ["call_1", "saved"],
      ["call_2", "ignored"]
    ]);
    const transcript = pipeline.prompts[2]!.debug.transcript;
    expect(transcript).toContain('[tool call add_memory] {"content":"Kevin goes to Tokyo next week."}');
    expect(transcript).toContain("[tool result] ignored");

    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.map((m) => m.content)).toEqual(["Kevin goes to Tokyo next week."]);
  });

  it("threads to a ↩#ref target and sends an unknown ref unthreaded", async () => {
    const { discord, pipeline, runtime } = await setup();
    const first = discord.post("kevin", "Kevin", "who wants cake");
    discord.post("mina", "Mina", "me");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "↩#a0 always me" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    discord.post("kevin", "Kevin", "ok");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "↩#zz9 deal" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    // Times render in the host zone frozen at epoch start; the ref is what matters here.
    expect(pipeline.prompts[0]!.debug.transcript).toMatch(/\[\d\d:\d\d #a0\] Kevin: who wants cake/);
    expect(discord.sent).toEqual([{ content: "always me", replyToMessageId: first.id }, { content: "deal" }]);
  });

  it("I5: a reply cut off with nothing complete retries once with the cut-off note in the tail", async () => {
    const { discord, pipeline, runtime } = await setup();
    discord.post("kevin", "Kevin", "tell me about your day");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "so basically this morning i", finishReason: "length" }, { content: "busy but fun" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    expect(pipeline.prompts).toHaveLength(2);
    expect(pipeline.prompts[0]!.debug.tail).not.toContain(CUT_OFF_RETRY_NOTE);
    expect(pipeline.prompts[1]!.debug.tail).toContain(CUT_OFF_RETRY_NOTE);
    // Only the tail differs: the retry never rewrites the cached prefix.
    expect(blocks(pipeline.prompts[1]!.messages).slice(0, -1)).toEqual(blocks(pipeline.prompts[0]!.messages).slice(0, -1));
    expect(pipeline.requests.map((r) => r.attribution?.purpose)).toEqual(["waifu_reply", "waifu_retry"]);
    expect(pipeline.requests[0]!.stopSequences).toEqual(["\n[", "\nAria:"]);
    expect(discord.sent.map((m) => m.content)).toEqual(["busy but fun"]);
  });
});
