// Shared fixtures for the DM tests (spec 9.1): a fake DM transport, a scripted model pipeline and
// a data root with one DM-capable waifu ("aria" on bot "aria-bot").

import type { DiscordDirectMessageEvent, DiscordGatewayFacade } from "../src/discord/client.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import type { OrchestratorDecision } from "../src/orchestration/decisions.js";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import type { ModelPipeline, WaifuGenerationRequest, WaifuGenerationResult } from "../src/providers/types.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import type { WaifuDmSettings } from "../src/shared/schemas/dm.js";
import {
  AgentConfigSchema,
  DiscordBotsFileSchema,
  ProviderCredentialsFileSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import type { RuntimeOrchestratorOptions } from "../src/orchestration/runtimeShared.js";
import { quietLogger } from "./contextFixtures.js";
import { makeTempRoot } from "./testUtils.js";

export const USER = "500000000000000005";
export const USER_2 = "500000000000000006";
export const BOT_USER = "600000000000000006";
export const DM_CHANNEL = "700000000000000007";

export type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One bot's DMs with any number of users: humans post, waifu sends land like real messages. */
export class DmDiscord implements DiscordGatewayFacade {
  readonly messages = new Map<string, RawDiscordMessage[]>(); // userId → DM channel
  readonly sent: Array<{ userId: string; content: string; replyToMessageId?: string }> = [];
  readonly typing: string[] = [];
  /** Errors thrown by the next sendDirectMessage calls (in order). */
  sendErrors: unknown[] = [];
  /** When set, every send waits for it (to hold a run in its sending phase). */
  sendGate: Promise<void> | undefined;
  private counter = 800_000_000_000_000_000n;
  clock = Date.parse("2026-10-24T14:00:00.000Z");

  post(userId: string, content: string, o: { bot?: boolean } = {}): RawDiscordMessage {
    this.counter += 1n;
    this.clock += 1_000;
    const message: RawDiscordMessage = {
      id: this.counter.toString(),
      channelId: DM_CHANNEL,
      authorId: o.bot ? BOT_USER : userId,
      authorName: o.bot ? "Aria" : "Kevin",
      authorIsBot: o.bot ?? false,
      createdAt: new Date(this.clock).toISOString(),
      type: 0,
      content,
      attachments: [],
      embeds: [],
      stickers: [],
      snapshots: [],
      mentions: { users: {}, roles: {}, channels: {} }
    };
    const list = this.messages.get(userId) ?? [];
    list.push(message);
    this.messages.set(userId, list);
    return message;
  }

  /** A human DM plus the gateway event the runtime receives. */
  dm(content: string, userId = USER): DiscordDirectMessageEvent {
    const message = this.post(userId, content);
    return {
      waifuId: "aria",
      botId: "aria-bot",
      userId,
      userDisplayName: "Kevin",
      channelId: DM_CHANNEL,
      messageId: message.id,
      createdAt: message.createdAt
    };
  }

  async connect() {
    return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
  }
  async disconnect() {}
  async fetchFreshContext(): Promise<ContextMessage[]> {
    return [];
  }
  async sendWaifuMessage(): Promise<{ messageId: string }> {
    throw new Error("no guild sends in DM tests");
  }
  async sendTyping() {}
  ownAuthorIds() {
    return [BOT_USER];
  }

  async fetchDmContextSince(i: { userId: string; afterMessageId: string | null; maxMessages: number }) {
    const all = this.messages.get(i.userId) ?? [];
    const index = i.afterMessageId === null ? -1 : all.findIndex((m) => m.id === i.afterMessageId);
    const after = all.slice(index + 1);
    return { messages: after.slice(-i.maxMessages), reachedCursor: after.length <= i.maxMessages };
  }

  async sendDirectMessage(input: { userId: string; content: string; replyToMessageId?: string }) {
    if (this.sendGate) await this.sendGate;
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sent.push({ userId: input.userId, content: input.content, ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}) });
    return { messageId: this.post(input.userId, input.content, { bot: true }).id };
  }

  async sendDirectTyping(input: { userId: string }) {
    this.typing.push(input.userId);
  }
}

export class ScriptedPipeline implements ModelPipeline {
  readonly requests: WaifuGenerationRequest[] = [];
  replies: WaifuGenerationResult[] = [];
  decisions: OrchestratorDecision[] = [];
  /** Awaited inside generateWaifu (before replying) when set: hold a run in "generating". */
  gate: (() => Promise<void>) | undefined;
  decideCalls = 0;

  async decideOrchestrator(): Promise<OrchestratorDecision> {
    this.decideCalls += 1;
    return this.decisions.shift() ?? { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" } as OrchestratorDecision;
  }

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    this.requests.push(request);
    if (this.gate) {
      const gate = this.gate();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
        if (request.signal?.aborted) return onAbort();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        gate.then(() => {
          request.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, reject);
      });
    }
    // Distinct default replies: the validator rejects a waifu repeating herself.
    const words = ["sure thing", "oh nice", "haha really", "tell me more", "wow okay", "no way", "same here", "cool cool", "hmm maybe", "love that"];
    return this.replies.shift() ?? { content: `${words[this.requests.length % words.length]} ${this.requests.length}` };
  }
}

export async function seedDmWorld(
  storage: StorageService,
  o: { dm?: Partial<WaifuDmSettings>; sharedBot?: boolean; toolUse?: boolean; modelId?: string | null } = {}
): Promise<void> {
  const now = new Date().toISOString();
  await storage.writeJson("providers", "user/providers.json", ProviderCredentialsFileSchema, ProviderCredentialsFileSchema.parse(
    createEmptyRevisionedFile({ providers: { openai: { providerId: "openai", apiKey: "sk-test", createdAt: now, updatedAt: now } } })
  ));
  await storage.writeJson("orchestrator", "user/orchestrator/config.json", AgentConfigSchema, AgentConfigSchema.parse({
    ...createRevisionedBase(), enabled: true, providerId: "openai", modelId: "gpt-5.4-mini", contextWindow: 20, prompt: "decide"
  }));
  await storage.writeJson("discord-bots", "user/discord-bots.json", DiscordBotsFileSchema, DiscordBotsFileSchema.parse(
    createEmptyRevisionedFile({
      orchestrator: { id: "orchestrator", displayName: "Director", enabled: true, token: "t" },
      waifus: [{ id: "aria-bot", displayName: "Aria", enabled: true, token: "t", applicationId: BOT_USER }]
    })
  ));
  await writeWaifu(storage, "aria", { dm: { allowDms: true, ...o.dm }, toolUse: o.toolUse, modelId: o.modelId });
  if (o.sharedBot) await writeWaifu(storage, "mina", { dm: { allowDms: false } });
}

export async function writeWaifu(
  storage: StorageService,
  id: string,
  o: { dm?: Partial<WaifuDmSettings>; toolUse?: boolean; modelId?: string | null } = {}
): Promise<void> {
  await storage.writeJson(`waifu:${id}`, `user/waifus/${id}/waifu.json`, WaifuConfigSchema, WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id,
    name: id === "aria" ? "Aria" : "Mina",
    displayName: id === "aria" ? "Aria" : "Mina",
    enabled: true,
    providerId: "openai",
    ...(o.modelId === null ? {} : { modelId: o.modelId ?? "gpt-5.4-mini" }),
    botId: "aria-bot",
    persona: "sunny baker",
    contextWindow: 50,
    tools: { toolUse: o.toolUse ?? false },
    availability: { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [] },
    dm: { allowDms: false, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", ...o.dm }
  }));
}

export async function dmRoot(roots: string[]): Promise<{ root: string; storage: StorageService }> {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  return { root, storage: new StorageService(root) };
}

export function dmRuntime(
  storage: StorageService,
  discord: DiscordGatewayFacade,
  pipeline: ModelPipeline,
  o: Partial<RuntimeOrchestratorOptions> = {}
): RuntimeOrchestrator {
  return new RuntimeOrchestrator({
    storage,
    discord,
    logger: quietLogger(),
    createPipeline: () => pipeline,
    sleep: async () => undefined,
    restartResumeDelayMs: 0,
    dmResumeStaggerMs: 0,
    ...o
  });
}

export async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
