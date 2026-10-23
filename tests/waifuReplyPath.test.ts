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
import { applyMemoryDecisions, planMemoryCalls, toolNotes, waifuStopSequences } from "../src/orchestration/responderExecutor.js";
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
    // The call it steers carries it in the ephemeral tail; it is not yet history.
    expect(pipeline.prompts[0]!.debug.tail).toContain(direction);
    expect(pipeline.prompts[0]!.debug.transcript).not.toContain("<direction>");
    // Committed with her turn, anchored before her reply, exactly once.
    const later = pipeline.prompts[1]!.debug.transcript;
    expect(later).toContain(direction);
    expect(later.match(/<direction>/g)).toHaveLength(1);
    expect(later.indexOf(direction)).toBeLessThan(later.indexOf("(you) ok"));
    expect(pipeline.prompts[1]!.debug.tail).not.toContain("<direction>");
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
    expect(transcript).toContain('[tool add_memory] {"content":"Kevin goes to Tokyo next week."} → saved');
    expect(transcript).toContain('[tool add_memory] {"content":"Kevin wants Tokyo tips."} → ignored');
    // C1: after the tool-only turn, the waifu request carries no tool_use / tool_result blocks.
    for (const prompt of pipeline.prompts.slice(1)) {
      expect(prompt.messages.some((m) => m.role === "tool")).toBe(false);
      expect(
        prompt.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === "toolCall"))
      ).toBe(false);
    }

    const memories = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(memories.memories.map((m) => m.content)).toEqual(["Kevin goes to Tokyo next week."]);
  });

  it("never persists a direction whose turn did not land", async () => {
    const { storage, discord, pipeline, runtime } = await setup();
    discord.post("kevin", "Kevin", "anyone up?");
    pipeline.decisions.push(reply({ intent: "change_topic", goal: "bring up the bake sale" }));
    pipeline.replies.push({ content: "" }); // nothing to send
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();
    expect(discord.sent).toEqual([]);
    const state = await contextState(storage);
    expect(state.notes.filter((n) => n.kind === "direction")).toEqual([]);
  });

  it("commits on the failure path too (breakpoint kept), with no direction", async () => {
    const { storage, discord, pipeline, runtime } = await setup();
    discord.post("kevin", "Kevin", "anyone up?");
    pipeline.decisions.push(reply({ intent: "change_topic", goal: "bring up the bake sale" }));
    pipeline.generateWaifu = async (request) => {
      pipeline.prompts.push(request.prompt!);
      throw new Error("provider down");
    };
    await runtime.triggerChannel(GUILD, CHANNEL).catch(() => undefined);
    await runtime.stop();
    expect(discord.sent).toEqual([]);
    const state = await contextState(storage);
    expect(state.lastBreakpoint).toEqual(pipeline.prompts[0]!.breakpoint);
    expect(state.lastUsedAt).toBeTruthy();
    expect(state.notes.filter((n) => n.kind === "direction")).toEqual([]);
  });

  it("I3: accepts `↩#REF:` / `↩#ref,` variants and sends a leading ↩you / ↩Name unthreaded", async () => {
    const { discord, pipeline, runtime } = await setup();
    const first = discord.post("kevin", "Kevin", "who wants cake");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "↩#A0: always me" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    discord.post("kevin", "Kevin", "ok");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "↩#a0, still me" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    discord.post("kevin", "Kevin", "fine");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "↩you deal" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    discord.post("kevin", "Kevin", "really");
    pipeline.decisions.push(reply());
    pipeline.replies.push({ content: "↩Kevin yes really" });
    await runtime.triggerChannel(GUILD, CHANNEL);
    await runtime.stop();

    expect(discord.sent).toEqual([
      { content: "always me", replyToMessageId: first.id },
      { content: "still me", replyToMessageId: first.id },
      { content: "deal" },
      { content: "yes really" }
    ]);
  });

  it("stop sequences add her server nickname when it differs from her display name", () => {
    expect(waifuStopSequences({ displayName: "Aria", name: "aria" })).toEqual(["\n[", "\nAria:"]);
    expect(waifuStopSequences({ displayName: "Aria", name: "aria" }, "Aria")).toEqual(["\n[", "\nAria:"]);
    expect(waifuStopSequences({ displayName: "Aria", name: "aria" }, "Aria✨")).toEqual(["\n[", "\nAria:", "\nAria✨:"]);
  });

  it("tool note results: saved / duplicate — not saved / over limit / invalid arguments / ignored; handover names the display name", () => {
    const call = (id: string, args: string, name = "add_memory") => ({ id, name, arguments: args });
    const result = {
      content: "hi",
      toolCalls: [
        call("c1", '{"content":"Kevin likes tea."}'),
        call("c2", '{"content":"Kevin likes tea."}'),
        call("c3", "{not json"),
        call("c4", '{"content":"  "}'),
        ...[5, 6, 7, 8, 9].map((n) => call(`c${n}`, JSON.stringify({ content: `fact ${n}` }))),
        call("p1", '{"waifuId":"riko"}', "PickNextWaifu")
      ]
    };
    const calls = planMemoryCalls(result, false);
    expect(calls.map((c) => c.outcome)).toEqual([
      "saved", "saved", "invalid arguments", "invalid arguments", "saved", "saved", "saved", "over limit", "over limit"
    ]);
    applyMemoryDecisions(calls, [
      { action: "insert" },
      { action: "skip", duplicateOf: "m1" },
      { action: "insert" },
      { action: "insert" },
      { action: "insert" }
    ]);
    const notes = toolNotes(result, calls, { handoff: "accepted", pickedName: "Riko✨" });
    expect(notes.map((n) => n.kind === "tool" && `${n.callId}:${n.result}`)).toEqual([
      "c1:saved",
      "c2:duplicate — not saved",
      "c3:invalid arguments",
      "c4:invalid arguments",
      "c5:saved",
      "c6:saved",
      "c7:saved",
      "c8:over limit",
      "c9:over limit",
      "p1:handing over to Riko✨"
    ]);
    // Suppressed: every add_memory is `ignored`; a refused / limited handoff says why.
    expect(planMemoryCalls(result, true).every((c) => c.outcome === "ignored")).toBe(true);
    expect(toolNotes({ ...result, toolCalls: [call("p1", "{}", "PickNextWaifu")] }, [], { handoff: "limit", pickedName: "Riko" })[0]).toMatchObject({
      result: "ignored — handoff limit reached"
    });
    expect(
      toolNotes(
        { ...result, toolCalls: [call("p1", "{}", "PickNextWaifu")], rejectedPickNextWaifu: { reason: "malformed" } as never },
        [],
        { handoff: undefined, pickedName: undefined }
      )[0]
    ).toMatchObject({ result: "invalid arguments" });
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
