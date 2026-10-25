// Shared fixtures for the DM tests (spec 9.1): a fake DM transport and a data root with one
// DM-capable waifu ("ella" on bot "ella-bot").

import type { DiscordDirectMessageEvent, DiscordGatewayFacade } from "../src/discord/client.js";
import { dmFloorAt } from "../src/orchestration/dm/dmStore.js";
import { CastRuntime } from "../src/orchestration/runtime.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import type { WaifuDmSettings } from "../src/shared/schemas/dm.js";
import {
  DiscordBotsFileSchema,
  ProviderCredentialsFileSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import type { CastRuntimeOptions } from "../src/orchestration/runtimeShared.js";
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
  // Real-time snowflakes (a forget floor is the snowflake of "now", spec 9.1.4).
  private counter = 0n;
  clock = Date.parse("2026-10-24T14:00:00.000Z");

  post(userId: string, content: string, o: { bot?: boolean } = {}): RawDiscordMessage {
    const now = BigInt(dmFloorAt(new Date()));
    this.counter = this.counter >= now ? this.counter + 1n : now;
    this.clock += 1_000;
    const message: RawDiscordMessage = {
      id: this.counter.toString(),
      channelId: DM_CHANNEL,
      authorId: o.bot ? BOT_USER : userId,
      authorName: o.bot ? "Ella" : "Kevin",
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
      waifuId: "ella",
      botId: "ella-bot",
      userId,
      userDisplayName: "Kevin",
      channelId: DM_CHANNEL,
      messageId: message.id,
      createdAt: message.createdAt
    };
  }

  async connect() {
    return { connected: true, houseConnected: true, waifuBotCount: 1, warnings: [] };
  }
  async disconnect() {}
  async fetchFreshContext(): Promise<never[]> {
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
    const after = i.afterMessageId === null ? all : all.filter((m) => BigInt(m.id) > BigInt(i.afterMessageId!));
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

export async function seedDmWorld(
  storage: StorageService,
  o: { dm?: Partial<WaifuDmSettings>; sharedBot?: boolean; modelId?: string | null } = {}
): Promise<void> {
  const now = new Date().toISOString();
  await storage.writeJson("providers", "user/providers.json", ProviderCredentialsFileSchema, ProviderCredentialsFileSchema.parse(
    createEmptyRevisionedFile({ providers: { openai: { providerId: "openai", apiKey: "sk-test", createdAt: now, updatedAt: now } } })
  ));
  await storage.writeJson("discord-bots", "user/discord-bots.json", DiscordBotsFileSchema, DiscordBotsFileSchema.parse(
    createEmptyRevisionedFile({
      orchestrator: { id: "orchestrator", displayName: "Director", enabled: true, token: "t" },
      waifus: [{ id: "ella-bot", displayName: "Ella", enabled: true, token: "t", applicationId: BOT_USER }]
    })
  ));
  await writeWaifu(storage, "ella", { dm: { allowDms: true, ...o.dm }, modelId: o.modelId });
  if (o.sharedBot) await writeWaifu(storage, "mina", { dm: { allowDms: false } });
}

export async function writeWaifu(
  storage: StorageService,
  id: string,
  o: { dm?: Partial<WaifuDmSettings>; modelId?: string | null } = {}
): Promise<void> {
  await storage.writeJson(`waifu:${id}`, `user/waifus/${id}/waifu.json`, WaifuConfigSchema, WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id,
    name: id === "ella" ? "Ella" : "Mina",
    displayName: id === "ella" ? "Ella" : "Mina",
    enabled: true,
    ...(o.modelId === null ? {} : { model: { providerId: "openai", modelId: o.modelId ?? "gpt-6-luna" } }),
    botId: "ella-bot",
    persona: "sunny baker",
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
  o: Partial<CastRuntimeOptions> = {}
): CastRuntime {
  return new CastRuntime({
    storage,
    discord,
    logger: quietLogger(),
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
