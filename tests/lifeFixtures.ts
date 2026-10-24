// Shared fixtures for the Living cast tests (spec §12): a fake Discord that holds guild channels
// and DMs in memory, a data root with a server, a cast channel and waifus, a ModelClient over winter
// fakes, and a LivingCast wired to all of it. No live Discord, model or web calls.

import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { fakeToolCallTurn } from "@yanlinglabs/winter-provider-runtime/testing";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { ConversationMessageCache } from "../src/discord/conversationCache.js";
import { GuildDirectory } from "../src/discord/guildDirectory.js";
import { filterSinceCursor } from "../src/discord/conversationSource.js";
import { ModelClient } from "../src/models/client.js";
import { conversationKey, type ConversationRef } from "../src/orchestration/context/keys.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from "../src/shared/schemas/config.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import {
  DiscordBotsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile,
  type WaifuConfig
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { LivingCast, type LivingCastOptions } from "../src/life/livingCast.js";
import { NoopUsageLedger, type UsageLedger, type UsageLedgerLine } from "../src/orchestration/usageLedger.js";
import { ANTHROPIC_MESSAGES, CHAT_COMPLETIONS, OPENAI_RESPONSES, fakeAdapter, fakeWinter, type FakeAdapter, type ScriptedTurn } from "./modelFakes.js";
import { quietLogger } from "./contextFixtures.js";
import { makeTempRoot } from "./testUtils.js";

export const GUILD = "100000000000000001";
export const CHANNEL = "200000000000000002";
export const CHANNEL_2 = "200000000000000003";
export const KEVIN = "300000000000000003";
export const MINA_USER = "300000000000000004";
export const ARIA_BOT = "400000000000000004";
export const MINA_BOT = "400000000000000005";
export const HOUSE_BOT = "400000000000000009";
export const TZ = "UTC";

const DISCORD_EPOCH = 1_420_070_400_000n;

/** A test clock that only moves when told. */
export class Clock {
  constructor(public ms = Date.parse("2026-10-24T14:00:00.000Z")) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

type PostOptions = {
  authorId?: string;
  authorName?: string;
  bot?: boolean;
  mentions?: Record<string, string>;
  roles?: Record<string, string>;
  everyone?: boolean;
  replyTo?: string;
  attachments?: RawDiscordMessage["attachments"];
};

/** Guild channels and DMs in memory. Sends land as real messages; nothing leaves the process. */
export class FakeDiscord implements DiscordGatewayFacade {
  readonly store = new Map<string, RawDiscordMessage[]>();
  readonly sent: Array<{ placeKey: string; content: string; senderBotId?: string; replyToMessageId?: string; messageId: string }> = [];
  readonly typing: string[] = [];
  readonly reactions: Array<{ placeKey: string; messageId: string; emoji: string; botId: string }> = [];
  botRoles: Record<string, string[]> = {};
  sendErrors: unknown[] = [];
  private counter = 0n;

  constructor(readonly clock: Clock) {}

  private nextId(): string {
    const base = (BigInt(this.clock.ms) - DISCORD_EPOCH) << 22n;
    this.counter = this.counter >= base ? this.counter + 1n : base;
    return this.counter.toString();
  }

  post(conversation: ConversationRef, content: string, o: PostOptions = {}): RawDiscordMessage {
    this.clock.advance(1_000);
    const message: RawDiscordMessage = {
      id: this.nextId(),
      channelId: conversation.kind === "guild" ? conversation.channelId : `dm-${conversation.userId}`,
      ...(conversation.kind === "guild" ? { guildId: conversation.guildId } : {}),
      authorId: o.authorId ?? KEVIN,
      authorName: o.authorName ?? "Kevin",
      authorIsBot: o.bot ?? false,
      createdAt: new Date(this.clock.ms).toISOString(),
      type: o.replyTo ? 19 : 0,
      content,
      attachments: o.attachments ?? [],
      embeds: [],
      stickers: [],
      snapshots: [],
      ...(o.replyTo ? { referenceMessageId: o.replyTo } : {}),
      mentions: { users: o.mentions ?? {}, roles: o.roles ?? {}, channels: {} },
      ...(o.everyone ? { mentionsEveryone: true } : {})
    };
    const key = conversationKey(conversation);
    this.store.set(key, [...(this.store.get(key) ?? []), message]);
    return message;
  }

  remove(conversation: ConversationRef, messageId: string): void {
    const key = conversationKey(conversation);
    this.store.set(key, (this.store.get(key) ?? []).filter((message) => message.id !== messageId));
  }

  messages(conversation: ConversationRef): RawDiscordMessage[] {
    return this.store.get(conversationKey(conversation)) ?? [];
  }

  async connect() {
    return { connected: true, houseConnected: true, waifuBotCount: 2, warnings: [] };
  }
  async disconnect() {}
  async fetchFreshContext(): Promise<never[]> {
    return [];
  }
  ownAuthorIds() {
    return [ARIA_BOT, MINA_BOT, HOUSE_BOT];
  }

  async fetchContextSince(i: { guildId: string; channelId: string; afterMessageId: string | null; maxMessages: number }) {
    const all = this.messages({ kind: "guild", guildId: i.guildId, channelId: i.channelId });
    return filterSinceCursor(all, i.afterMessageId, i.maxMessages, false);
  }

  async fetchDmContextSince(i: { waifuId: string; userId: string; afterMessageId: string | null; maxMessages: number }) {
    const all = this.messages({ kind: "dm", waifuId: i.waifuId, userId: i.userId });
    return filterSinceCursor(all, i.afterMessageId, i.maxMessages, false);
  }

  async fetchMessagesBefore(i: { conversation: ConversationRef; beforeId: string; limit: number }) {
    const older = this.messages(i.conversation).filter((message) => BigInt(message.id) < BigInt(i.beforeId));
    return older.slice(-i.limit);
  }

  private botAuthor(botId: string | undefined): { authorId: string; authorName: string } {
    if (botId === "mina-bot") return { authorId: MINA_BOT, authorName: "Mina" };
    return { authorId: ARIA_BOT, authorName: "Aria" };
  }

  async sendWaifuMessage(input: { guildId: string; channelId: string; content: string; senderBotId?: string; replyToMessageId?: string }) {
    const error = this.sendErrors.shift();
    if (error) throw error;
    const conversation: ConversationRef = { kind: "guild", guildId: input.guildId, channelId: input.channelId };
    const message = this.post(conversation, input.content, { ...this.botAuthor(input.senderBotId), bot: true, ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}) });
    this.sent.push({ placeKey: conversationKey(conversation), content: input.content, ...(input.senderBotId ? { senderBotId: input.senderBotId } : {}), ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}), messageId: message.id });
    return { messageId: message.id };
  }

  async sendDirectMessage(input: { waifuId: string; userId: string; content: string; replyToMessageId?: string }) {
    const error = this.sendErrors.shift();
    if (error) throw error;
    const conversation: ConversationRef = { kind: "dm", waifuId: input.waifuId, userId: input.userId };
    const message = this.post(conversation, input.content, { ...this.botAuthor(input.waifuId === "mina" ? "mina-bot" : "aria-bot"), bot: true });
    this.sent.push({ placeKey: conversationKey(conversation), content: input.content, messageId: message.id });
    return { messageId: message.id };
  }

  async sendTyping(input: { channelId: string }) {
    this.typing.push(input.channelId);
  }
  async sendDirectTyping(input: { userId: string }) {
    this.typing.push(`dm:${input.userId}`);
  }

  async addReaction(input: { botId: string; conversation: ConversationRef; messageId: string; emoji: string }) {
    this.reactions.push({ placeKey: conversationKey(input.conversation), messageId: input.messageId, emoji: input.emoji, botId: input.botId });
  }

  async fetchBotMemberRoles(input: { botId: string; guildId: string }) {
    return this.botRoles[input.botId] ?? [];
  }
}

export const ROOM: ConversationRef = { kind: "guild", guildId: GUILD, channelId: CHANNEL };
export const ROOM_KEY = conversationKey(ROOM);
export const dmOf = (waifuId: string, userId = KEVIN): ConversationRef => ({ kind: "dm", waifuId, userId });

export type WaifuSeed = Partial<WaifuConfig> & { id: string; name: string; botId?: string };

export async function writeWaifuConfig(storage: StorageService, seed: WaifuSeed): Promise<void> {
  await storage.writeJson(
    `waifu:${seed.id}`,
    `user/waifus/${seed.id}/waifu.json`,
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      displayName: seed.name,
      enabled: true,
      model: { providerId: "anthropic", modelId: "claude-haiku-5-5" },
      persona: `${seed.name} is a sunny baker.`,
      availability: { sleep: { enabled: false, start: "23:00", end: "07:00" }, busy: [] },
      dm: { allowDms: true, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" },
      ...seed
    })
  );
}

/** A data root with Bake Club (#general cast: Aria, and Mina when given), bots and waifus. */
export async function seedWorld(storage: StorageService, o: { waifus?: WaifuSeed[]; cast?: string[] } = {}): Promise<void> {
  const waifus = o.waifus ?? [{ id: "aria", name: "Aria", botId: "aria-bot" }];
  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(
      createEmptyRevisionedFile({
        orchestrator: { id: HOUSE_BOT, displayName: "House", enabled: true, token: "t" },
        waifus: [
          { id: "aria-bot", displayName: "Aria", enabled: true, token: "t", applicationId: ARIA_BOT },
          { id: "mina-bot", displayName: "Mina", enabled: true, token: "t", applicationId: MINA_BOT }
        ]
      })
    )
  );
  for (const waifu of waifus) await writeWaifuConfig(storage, waifu);
  const cast = o.cast ?? waifus.map((waifu) => waifu.id);
  await storage.writeJson(
    `server:${GUILD}`,
    `user/servers/${GUILD}/server.json`,
    ServerConfigSchema,
    ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId: GUILD,
      name: "Bake Club",
      channels: {
        [CHANNEL]: { channelId: CHANNEL, name: "general", enabledWaifuIds: cast },
        [CHANNEL_2]: { channelId: CHANNEL_2, name: "recipes", enabledWaifuIds: cast }
      }
    })
  );
}

/** Captures ledger lines in memory. */
export class MemoryLedger implements UsageLedger {
  readonly lines: UsageLedgerLine[] = [];
  async record(entry: UsageLedgerLine): Promise<void> {
    this.lines.push(entry);
  }
  async flush(): Promise<void> {}
}

export type LifeWorld = {
  root: string;
  storage: StorageService;
  discord: FakeDiscord;
  clock: Clock;
  cast: LivingCast;
  anthropic: FakeAdapter;
  chat: FakeAdapter;
  responses: FakeAdapter;
  ledger: MemoryLedger;
  models: ModelClient;
  config: AppConfig;
  setConfig(patch: (config: AppConfig) => AppConfig): void;
  /** A process restart: a new LivingCast (fresh caches) over the same data root, fake Discord and models. */
  restart(options?: Partial<LivingCastOptions>): LivingCast;
};

const openCasts = new Set<LivingCast>();

/** Stops every LivingCast built by lifeWorld (timers, lives) — call in afterEach before removing roots. */
export async function closeWorlds(): Promise<void> {
  const casts = [...openCasts];
  openCasts.clear();
  await Promise.all(casts.map((cast) => cast.stop().catch(() => undefined)));
}

export async function lifeWorld(
  roots: string[],
  o: {
    waifus?: WaifuSeed[];
    cast?: string[];
    scripts?: ScriptedTurn[];
    config?: (config: AppConfig) => AppConfig;
    options?: Partial<LivingCastOptions>;
    paused?: () => boolean;
    /** A ModelClient of the test's own (e.g. the real winter adapters against a loopback server). */
    models?: (o: { ledger: MemoryLedger; clock: Clock }) => ModelClient;
  } = {}
): Promise<LifeWorld> {
  const root = await makeTempRoot("dc-waifus-life-");
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  await seedWorld(storage, { ...(o.waifus ? { waifus: o.waifus } : {}), ...(o.cast ? { cast: o.cast } : {}) });
  const clock = new Clock();
  const discord = new FakeDiscord(clock);
  const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, o.scripts ?? []);
  const chat = fakeAdapter(CHAT_COMPLETIONS, o.scripts ?? []);
  const responses = fakeAdapter(OPENAI_RESPONSES, o.scripts ?? []);
  const ledger = new MemoryLedger();
  const models = o.models ? o.models({ ledger, clock }) : new ModelClient({ winter: fakeWinter(anthropic, chat, responses), credentials: () => "test-key", usageLedger: ledger, now: () => clock.ms });
  let config = AppConfigSchema.parse(o.config ? o.config(structuredClone(DEFAULT_APP_CONFIG)) : DEFAULT_APP_CONFIG);
  const logger = quietLogger() as never;
  const build = (options: Partial<LivingCastOptions> = {}): LivingCast => {
    const directory = new GuildDirectory({ storage, logger, transport: async () => undefined });
    const conversations = new ConversationMessageCache({ discord: () => discord, logger, directory });
    const built = new LivingCast({
      storage,
      logger,
      discord: () => discord,
      conversations,
      directory,
      models,
      config: () => config,
      isPaused: o.paused ?? (() => false),
      usageLedger: NoopUsageLedger,
      credentials: () => "test-key",
      now: clock.now,
      timeZone: TZ,
      random: () => 0,
      sleep: async () => undefined,
      manualScheduler: true,
      ...o.options,
      ...options
    });
    openCasts.add(built);
    return built;
  };
  const cast = build();
  return {
    root,
    storage,
    discord,
    clock,
    cast,
    anthropic,
    chat,
    responses,
    ledger,
    models,
    get config() {
      return config;
    },
    setConfig(patch) {
      config = AppConfigSchema.parse(patch(structuredClone(config)));
    },
    restart: build
  };
}

/** One assistant turn calling tools (ids `call_<n>`). */
export function toolTurn(calls: Array<{ name: string; input: unknown; id?: string }>, o: { text?: string; usage?: { inputTokens: number; outputTokens: number } } = {}): ProviderEvent[] {
  let n = 0;
  return fakeToolCallTurn(
    calls.map((call) => ({ id: call.id ?? `call_${(n += 1)}_${call.name}`, name: call.name, input: call.input })),
    { ...(o.text !== undefined ? { text: o.text } : {}), usage: o.usage ?? { inputTokens: 1000, outputTokens: 50 } }
  );
}

export function script(...turns: ProviderEvent[][]): ScriptedTurn[] {
  return turns.map((events) => () => events);
}
