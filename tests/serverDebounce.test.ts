// I2 server debounce (spec 9.2, 9.9 acceptance 5): a human burst costs one orchestrator pass;
// `serverMs: 0` reproduces the pre-debounce behaviour.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import type { DiscordGatewayFacade, DiscordMessageEvent } from "../src/discord/client.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import type { OrchestratorDecision } from "../src/orchestration/decisions.js";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import type { RuntimeOrchestratorOptions } from "../src/orchestration/runtimeShared.js";
import { runKey } from "../src/orchestration/runtimeShared.js";
import { sessionRelativePath } from "../src/orchestration/stores/sessions.js";
import { ChannelSessionStateSchema } from "../src/orchestration/session.js";
import type { ModelPipeline, ProviderRequest } from "../src/providers/types.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import {
  AgentConfigSchema,
  DiscordBotsFileSchema,
  ProviderCredentialsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { quietLogger } from "./contextFixtures.js";
import { deferred, until } from "./dmFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD = "100000000000000001";
const A = "200000000000000002";
const B = "200000000000000003";

class GuildDiscord implements DiscordGatewayFacade {
  readonly messages = new Map<string, RawDiscordMessage[]>();
  private counter = 300_000_000_000_000_000n;
  private clock = Date.parse("2026-10-24T14:00:00.000Z");

  post(channelId: string, content: string): DiscordMessageEvent {
    this.counter += 1n;
    this.clock += 1_000;
    const message: RawDiscordMessage = {
      id: this.counter.toString(),
      channelId,
      guildId: GUILD,
      authorId: "kevin",
      authorName: "Kevin",
      authorIsBot: false,
      createdAt: new Date(this.clock).toISOString(),
      type: 0,
      content,
      attachments: [],
      embeds: [],
      stickers: [],
      snapshots: [],
      mentions: { users: {}, roles: {}, channels: {} }
    };
    const list = this.messages.get(channelId) ?? [];
    list.push(message);
    this.messages.set(channelId, list);
    return { guildId: GUILD, channelId, messageId: message.id, authorId: "kevin", authorDisplayName: "Kevin", authorBot: false };
  }

  async connect() {
    return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
  }
  async disconnect() {}
  async fetchFreshContext(): Promise<ContextMessage[]> {
    return [];
  }
  async fetchContextSince(i: { channelId: string; afterMessageId: string | null; maxMessages: number }) {
    const all = this.messages.get(i.channelId) ?? [];
    const index = i.afterMessageId === null ? -1 : all.findIndex((m) => m.id === i.afterMessageId);
    const after = all.slice(index + 1);
    return { messages: after.slice(-i.maxMessages), reachedCursor: after.length <= i.maxMessages };
  }
  async sendWaifuMessage() {
    return { messageId: "1" };
  }
  async sendTyping() {}
}

class DirectorPipeline implements ModelPipeline {
  calls: Array<{ channel: string | undefined; signal?: AbortSignal }> = [];
  /** Orchestrator passes (one run may make several decisions; each run has its own signal). */
  get passes(): number {
    return new Set(this.calls.map((call) => call.signal)).size;
  }
  gate: (() => Promise<void>) | undefined;

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const signal = request.signal;
    this.calls.push({ channel: request.attribution?.channelId, signal });
    if (this.gate) {
      const gate = this.gate();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        void gate.then(resolve, reject);
      });
    }
    return { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" } as OrchestratorDecision;
  }

  async generateWaifu() {
    return { content: "hi" };
  }
}

async function setup(o: Partial<RuntimeOrchestratorOptions> = {}) {
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
  await storage.writeJson("discord-bots", "user/discord-bots.json", DiscordBotsFileSchema, DiscordBotsFileSchema.parse(
    createEmptyRevisionedFile({ orchestrator: null, waifus: [{ id: "aria-bot", displayName: "Aria", enabled: true }] })
  ));
  await storage.writeJson(`server:${GUILD}`, `user/servers/${GUILD}/server.json`, ServerConfigSchema, ServerConfigSchema.parse({
    ...createRevisionedBase(),
    guildId: GUILD,
    name: "Bake Club",
    channels: {
      [A]: { channelId: A, name: "general", enabledWaifuIds: ["aria"] },
      [B]: { channelId: B, name: "random", enabledWaifuIds: ["aria"] }
    }
  }));
  await storage.writeJson("waifu:aria", "user/waifus/aria/waifu.json", WaifuConfigSchema, WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id: "aria", name: "Aria", displayName: "Aria", enabled: true, providerId: "openai", modelId: "gpt-5.4-mini",
    botId: "aria-bot", persona: "sunny baker", contextWindow: 50,
    availability: { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [] }
  }));
  const discord = new GuildDiscord();
  const pipeline = new DirectorPipeline();
  const runtime = new RuntimeOrchestrator({
    storage,
    discord,
    logger: quietLogger(),
    createPipeline: () => pipeline,
    sleep: async () => undefined,
    maxAutomaticTurns: 1,
    ...o
  });
  return { storage, discord, pipeline, runtime };
}

const DEBOUNCE = { serverMs: 150, serverMaxWaitMs: 2000 };

describe("server debounce", () => {
  it("serverMs = 1200 style: a 3-message burst costs one orchestrator call", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: DEBOUNCE });
    const burst = [discord.post(A, "hey"), discord.post(A, "anyone"), discord.post(A, "around?")];
    await Promise.all(burst.map((event) => runtime.handleDiscordMessage(event)));
    expect(pipeline.passes).toBe(0);
    await until(() => pipeline.passes === 1, "the burst's pass");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.settleBackground();
    expect(pipeline.passes).toBe(1);
    await runtime.stop();
  });

  it("maxWait bounds a long burst", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: { serverMs: 40, serverMaxWaitMs: 100 } });
    const started = Date.now();
    while (Date.now() - started < 260) {
      await runtime.handleDiscordMessage(discord.post(A, "spam"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The burst kept re-arming, but maxWait fired it anyway.
    await until(() => pipeline.passes >= 1, "a pass inside the burst", 10_000);
    await runtime.stop();
  });

  it("serverMs: 0 reproduces today's behaviour (one run per message, at once)", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: { serverMs: 0 } });
    await runtime.handleDiscordMessage(discord.post(A, "hey"));
    expect(pipeline.passes).toBe(1);
    await runtime.handleDiscordMessage(discord.post(A, "anyone"));
    expect(pipeline.passes).toBe(2);
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(false);
    await runtime.stop();
  });

  it("aborts this channel's pre-send run at arrival; another channel's run only when the burst fires", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: DEBOUNCE });
    const hold = deferred();
    pipeline.gate = () => hold.promise;
    await runtime.handleDiscordMessage(discord.post(A, "hey"));
    await until(() => pipeline.calls.length === 1, "first pass in A");
    const first = pipeline.calls[0]!;

    // Same channel: aborted on arrival, before the burst fires.
    await runtime.handleDiscordMessage(discord.post(A, "wait, one more"));
    expect(first.signal?.aborted).toBe(true);
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(true);
    await until(() => pipeline.calls.length === 2, "the burst's pass in A");
    const second = pipeline.calls[1]!;

    // Another channel: A keeps running until B's burst fires.
    await runtime.handleDiscordMessage(discord.post(B, "hello B"));
    expect(second.signal?.aborted).toBe(false);
    await until(() => pipeline.calls.length === 3, "B's pass");
    expect(second.signal?.aborted).toBe(true);
    expect(pipeline.calls[2]!.channel).toBe(B);
    hold.resolve();
    await runtime.stop();
  });

  it("holds a preempted channel's retrigger while a burst is pending in the guild", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: DEBOUNCE });
    const hold = deferred();
    pipeline.gate = () => hold.promise;
    const runner = (runtime as unknown as { runner: { retriggerTimers: Map<string, unknown>; preemptedChannels: Map<string, Map<string, unknown>> } }).runner;
    await runtime.handleDiscordMessage(discord.post(B, "B talks"));
    await until(() => pipeline.passes === 1, "B's pass");
    await runtime.handleDiscordMessage(discord.post(A, "A talks"));
    await until(() => pipeline.passes === 2, "A's pass (B preempted)");
    expect(runner.preemptedChannels.get(GUILD)?.has(B)).toBe(true);
    // A new message in A aborts A's pass; its slot frees while A's burst is pending: B must wait.
    await runtime.handleDiscordMessage(discord.post(A, "A again"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(true);
    expect(runner.retriggerTimers.has(`${GUILD}:${B}`)).toBe(false);
    expect(runner.preemptedChannels.get(GUILD)?.has(B)).toBe(true);
    // The burst's run ends: now B gets its turn back.
    await until(() => pipeline.passes === 3, "A's burst pass");
    hold.resolve();
    await until(() => runner.retriggerTimers.has(`${GUILD}:${B}`), "B's retrigger");
    await runtime.stop();
  });

  it("drops a timer wake while a burst is pending", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: { serverMs: 60_000, serverMaxWaitMs: 60_000 } });
    await runtime.handleDiscordMessage(discord.post(A, "hey"));
    const runner = (runtime as unknown as { runner: { scheduleRetrigger(g: string, c: string, s: number, w: unknown): Promise<void> } }).runner;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await runner.scheduleRetrigger(GUILD, A, 10, { source: "no_reply" });
    vi.advanceTimersByTime(11_000);
    vi.useRealTimers();
    await runtime.settleBackground();
    expect(pipeline.calls).toHaveLength(0);
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(true);
    await runtime.stop();
  });

  it("/stop cancels a pending burst; a manual run cancels it and runs now", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: { serverMs: 80, serverMaxWaitMs: 400 } });
    await runtime.handleDiscordMessage(discord.post(A, "hey"));
    await runtime.stopChannel(GUILD, A);
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(false);

    await runtime.handleDiscordMessage(discord.post(A, "hey again"));
    await runtime.triggerChannel(GUILD, A, "manual");
    expect(pipeline.passes).toBe(1);
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runtime.settleBackground();
    expect(pipeline.passes).toBe(1);
    await runtime.stop();
  });

  it("pause cancels pending bursts; shutdown persists them as wakes", async () => {
    const paused = await setup({ debounce: { serverMs: 60_000, serverMaxWaitMs: 60_000 } });
    await paused.runtime.handleDiscordMessage(paused.discord.post(A, "hey"));
    await paused.runtime.pause();
    expect(paused.runtime.hasPendingBurst(GUILD, A)).toBe(false);
    await paused.runtime.stop();

    const { storage, discord, runtime } = await setup({ debounce: { serverMs: 60_000, serverMaxWaitMs: 60_000 } });
    await runtime.handleDiscordMessage(discord.post(A, "hey"));
    await runtime.stop();
    const session = await storage.readJson(sessionRelativePath(GUILD, A), ChannelSessionStateSchema);
    expect(session.scheduledRetrigger).toMatchObject({ source: "shutdown" });
    expect(runtime.hasPendingBurst(GUILD, A)).toBe(false);
  });

  it("records the burst's newest message as the run's trigger (trigger_deleted still works)", async () => {
    const { discord, pipeline, runtime } = await setup({ debounce: DEBOUNCE });
    const hold = deferred();
    pipeline.gate = () => hold.promise;
    await runtime.handleDiscordMessage(discord.post(A, "one"));
    const last = discord.post(A, "two");
    await runtime.handleDiscordMessage(last);
    await until(() => pipeline.calls.length === 1, "the pass");
    const runs = (runtime as unknown as { runner: { activeRuns: Map<string, { triggerMessageId?: string }> } }).runner.activeRuns;
    expect(runs.get(runKey(GUILD))?.triggerMessageId).toBe(last.messageId);
    hold.resolve();
    await runtime.stop();
  });
});
