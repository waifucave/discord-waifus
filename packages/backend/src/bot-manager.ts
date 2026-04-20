import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type GuildEmoji,
  type GuildMember,
  type Interaction,
  Partials,
  type CloseEvent,
  type Message
} from "discord.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MessageHandler } from "./message-handler.js";
import type { WaifuConfig } from "./types/index.js";
import { Logger } from "./utils/logger.js";

export interface BotManagerMessagePayload {
  waifuId: string;
  message: Message;
}

export interface BotManagerDeps {
  onMessage?: (payload: BotManagerMessagePayload) => Promise<void> | void;
  onInteraction?: (payload: { waifuId: string; interaction: Interaction }) => Promise<void> | void;
  onListenerReady?: (payload: { waifuId: string; client: Client }) => Promise<void> | void;
  messageHandler?: MessageHandler;
  workspaceRoot?: string;
  localAssetsRoot?: string;
}

interface BotInstance {
  waifuId: string;
  client: Client;
  ready: boolean;
  userId: string | null;
  avatarHash: string | null;
  bannerHash: string | null;
}

interface QueueEntry {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class BotManager {
  private readonly logger = new Logger("BotManager");
  private readonly bots = new Map<string, BotInstance>();
  private readonly userIdToWaifuId = new Map<string, string>();
  private readonly deps: BotManagerDeps;
  private listenerBotId: string | null = null;
  private readonly sendQueues = new Map<string, QueueEntry[]>();
  private readonly sendHistory = new Map<string, number[]>();
  private readonly queueProcessors = new Set<string>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly manualStops = new Set<string>();
  private readonly waifuConfigs = new Map<string, WaifuConfig>();
  private readonly startingBots = new Set<string>();

  constructor(deps: BotManagerDeps = {}) {
    this.deps = deps;
  }

  setOnMessageHandler(handler: BotManagerDeps["onMessage"]): void {
    this.deps.onMessage = handler;
  }

  setOnInteractionHandler(handler: BotManagerDeps["onInteraction"]): void {
    this.deps.onInteraction = handler;
  }

  setOnListenerReadyHandler(handler: BotManagerDeps["onListenerReady"]): void {
    this.deps.onListenerReady = handler;
  }

  async startBot(waifu: WaifuConfig): Promise<void> {
    this.waifuConfigs.set(waifu.id, waifu);
    this.manualStops.delete(waifu.id);
    if (this.bots.has(waifu.id) || this.startingBots.has(waifu.id)) {
      this.logger.warn("Bot already started", { waifuId: waifu.id });
      return;
    }
    this.startingBots.add(waifu.id);

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });

    const instance: BotInstance = {
      waifuId: waifu.id,
      client,
      ready: false,
      userId: null,
      avatarHash: null,
      bannerHash: null
    };
    this.bots.set(waifu.id, instance);

    client.once(Events.ClientReady, async (readyClient) => {
      try {
        if (!this.isCurrentInstance(waifu.id, instance) || this.manualStops.has(waifu.id)) {
          return;
        }

        instance.ready = true;
        instance.userId = readyClient.user.id;
        this.userIdToWaifuId.set(readyClient.user.id, waifu.id);
        this.logger.info("Bot ready", {
          waifuId: waifu.id,
          username: readyClient.user.tag
        });

        await this.applyProfile(waifu, instance);
        if (!this.isCurrentInstance(waifu.id, instance) || this.manualStops.has(waifu.id)) {
          return;
        }

        await this.registerListenerBotIfNeeded(waifu.id, client);
      } catch (error) {
        this.logger.error("Bot ready handler failed", { waifuId: waifu.id, error });
      }
    });

    client.on(Events.Error, (error) => {
      this.logger.error("Discord client error", { waifuId: waifu.id, error });
    });

    client.on(Events.Warn, (warning) => {
      this.logger.warn("Discord client warning", { waifuId: waifu.id, warning });
    });

    client.on(Events.ShardDisconnect, (event: CloseEvent, shardId: number) => {
      this.logger.warn("Discord shard disconnected", {
        waifuId: waifu.id,
        shardId,
        code: event.code
      });
      this.scheduleReconnect(waifu.id);
    });

    try {
      await client.login(waifu.botToken);
      if (!this.isCurrentInstance(waifu.id, instance)) {
        client.destroy();
      }
    } catch (error) {
      if (this.isCurrentInstance(waifu.id, instance)) {
        this.bots.delete(waifu.id);
      }
      throw error;
    } finally {
      this.startingBots.delete(waifu.id);
    }
  }

  async stopBot(waifuId: string): Promise<void> {
    this.manualStops.add(waifuId);
    this.startingBots.delete(waifuId);
    const reconnectTimer = this.reconnectTimers.get(waifuId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(waifuId);
    }

    const bot = this.bots.get(waifuId);
    if (!bot) {
      return;
    }

    if (bot.userId) {
      this.userIdToWaifuId.delete(bot.userId);
    }

    bot.client.destroy();
    this.bots.delete(waifuId);

    if (this.listenerBotId === waifuId) {
      this.listenerBotId = null;
      const nextBot = this.bots.values().next().value as BotInstance | undefined;
      if (nextBot) {
        this.registerListenerBotIfNeeded(nextBot.waifuId, nextBot.client);
      }
    }
  }

  getClient(waifuId: string): Client | undefined {
    return this.bots.get(waifuId)?.client;
  }

  getUserIdByWaifuId(waifuId: string): string | null {
    return this.bots.get(waifuId)?.userId ?? null;
  }

  getFirstReadyClient(waifuIds?: string[]): Client | undefined {
    if (waifuIds && waifuIds.length > 0) {
      for (const waifuId of waifuIds) {
        const bot = this.bots.get(waifuId);
        if (bot?.ready) {
          return bot.client;
        }
      }
    }

    for (const bot of this.bots.values()) {
      if (bot.ready) {
        return bot.client;
      }
    }

    return undefined;
  }

  async getAvailableGuildEmojis(guildId: string): Promise<string[]> {
    const emojis = await this.fetchGuildEmojis(guildId);
    return emojis.map((emoji) => `:${emoji.name}:`);
  }

  async resolveGuildEmojiToken(guildId: string, token: string): Promise<string | null> {
    const match = token.match(/^:([A-Za-z0-9_]{2,32}):$/);
    if (!match) {
      return null;
    }

    const emojiName = match[1];
    const emojis = await this.fetchGuildEmojis(guildId);
    const emoji = emojis.find((entry) => entry.name === emojiName);
    return emoji?.toString() ?? null;
  }

  async fetchGuildMembers(guildId: string): Promise<GuildMember[]> {
    const client = this.getListenerClient();
    if (!client) {
      return [];
    }

    try {
      const guild = await client.guilds.fetch(guildId);
      const members = await guild.members.fetch();
      return [...members.values()];
    } catch (error) {
      this.logger.warn("Failed to fetch guild members", { guildId, error });
      return [];
    }
  }

  isOurBot(userId: string): boolean {
    return this.userIdToWaifuId.has(userId);
  }

  getWaifuIdByUserId(userId: string): string | null {
    return this.userIdToWaifuId.get(userId) ?? null;
  }

  getWaifuNameByUserId(userId: string): string | null {
    const waifuId = this.getWaifuIdByUserId(userId);
    return waifuId ? this.waifuConfigs.get(waifuId)?.name ?? null : null;
  }

  async applyGuildNicknames(waifuId: string, guildIds: string[]): Promise<void> {
    const instance = this.bots.get(waifuId);
    const waifu = this.waifuConfigs.get(waifuId);
    const userId = instance?.userId;
    if (!instance?.client.isReady() || !waifu || !userId) {
      return;
    }

    for (const guildId of [...new Set(guildIds)]) {
      try {
        const guild = await instance.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        if (member.nickname === waifu.displayName) {
          continue;
        }

        await member.setNickname(waifu.displayName);
      } catch (error) {
        this.logger.warn("Failed to apply guild nickname", {
          waifuId,
          guildId,
          displayName: waifu.displayName,
          error
        });
      }
    }
  }

  getBotStatuses(): Array<{ waifuId: string; ready: boolean; userId: string | null }> {
    return [...this.bots.values()].map((bot) => ({
      waifuId: bot.waifuId,
      ready: bot.ready,
      userId: bot.userId
    }));
  }

  getDebugState(): {
    listenerBotId: string | null;
    knownBotUserIds: Array<{ waifuId: string; userId: string }>;
    reconnectAttempts: Array<{ waifuId: string; attempts: number }>;
  } {
    return {
      listenerBotId: this.listenerBotId,
      knownBotUserIds: [...this.userIdToWaifuId.entries()].map(([userId, waifuId]) => ({
        waifuId,
        userId
      })),
      reconnectAttempts: [...this.reconnectAttempts.entries()].map(([waifuId, attempts]) => ({
        waifuId,
        attempts
      }))
    };
  }

  async sendWithRateLimit(channelId: string, task: () => Promise<void>): Promise<void> {
    const queue = this.sendQueues.get(channelId) ?? [];
    this.sendQueues.set(channelId, queue);

    return new Promise<void>((resolve, reject) => {
      queue.push({ run: task, resolve, reject });
      if (!this.queueProcessors.has(channelId)) {
        this.queueProcessors.add(channelId);
        void this.processQueue(channelId);
      }
    });
  }

  private async processQueue(channelId: string): Promise<void> {
    const queue = this.sendQueues.get(channelId);
    if (!queue) {
      this.queueProcessors.delete(channelId);
      return;
    }

    while (queue.length > 0) {
      const timestamps = this.sendHistory.get(channelId) ?? [];
      const now = Date.now();
      const recent = timestamps.filter((timestamp) => now - timestamp < 5_000);
      this.sendHistory.set(channelId, recent);

      if (recent.length >= 5) {
        const waitForMs = 5_000 - (now - recent[0]) + 25;
        await sleep(waitForMs);
        continue;
      }

      const entry = queue.shift();
      if (!entry) {
        continue;
      }

      try {
        await entry.run();
        recent.push(Date.now());
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }

    this.queueProcessors.delete(channelId);
  }

  private async registerListenerBotIfNeeded(waifuId: string, client: Client): Promise<void> {
    if (this.listenerBotId) {
      return;
    }

    this.listenerBotId = waifuId;
    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot && this.isOurBot(message.author.id)) {
        return;
      }

      await this.deps.onMessage?.({ waifuId, message });
    });
    client.on(Events.InteractionCreate, async (interaction) => {
      await this.deps.onInteraction?.({ waifuId, interaction });
    });
    this.logger.info("Assigned listener bot", { waifuId });
    await this.deps.onListenerReady?.({ waifuId, client });
  }

  getListenerClient(): Client | undefined {
    return this.listenerBotId
      ? this.bots.get(this.listenerBotId)?.client
      : undefined;
  }

  private async fetchGuildEmojis(guildId: string): Promise<GuildEmoji[]> {
    const client = this.getListenerClient();
    if (!client) {
      return [];
    }

    try {
      const guild = await client.guilds.fetch(guildId);
      const emojis = await guild.emojis.fetch();
      return [...emojis.values()].filter((emoji) => emoji.available !== false);
    } catch (error) {
      this.logger.warn("Failed to fetch guild emojis", { guildId, error });
      return [];
    }
  }

  private async applyProfile(waifu: WaifuConfig, instance: BotInstance): Promise<void> {
    const user = instance.client.user;
    if (!user || !instance.client.isReady() || !this.isCurrentInstance(waifu.id, instance)) {
      return;
    }

    if (waifu.avatarPath) {
      instance.avatarHash = await this.maybeSetAsset(
        waifu.avatarPath,
        instance.avatarHash,
        (data) => user.setAvatar(data)
      );
    }

    if (waifu.bannerPath) {
      instance.bannerHash = await this.maybeSetAsset(
        waifu.bannerPath,
        instance.bannerHash,
        (data) => user.setBanner(data)
      );
    }

    if (waifu.statusText) {
      if (!instance.client.isReady() || !this.isCurrentInstance(waifu.id, instance)) {
        return;
      }
      user.setActivity({
        name: waifu.statusText,
        type: ActivityType.Custom
      });
    }

    if (!instance.client.isReady() || !this.isCurrentInstance(waifu.id, instance)) {
      return;
    }
    user.setStatus(waifu.statusType);
  }

  private async maybeSetAsset(
    assetPath: string,
    currentHash: string | null,
    apply: (data: Buffer) => Promise<unknown>
  ): Promise<string | null> {
    const resolvedPath = this.resolveAssetPath(assetPath);
    const data = await fs.readFile(resolvedPath);
    const nextHash = createHash("sha256").update(data).digest("hex");
    if (nextHash === currentHash) {
      return currentHash;
    }

    await apply(data);
    return nextHash;
  }

  private resolveAssetPath(assetPath: string): string {
    if (path.isAbsolute(assetPath)) {
      return assetPath;
    }

    if (assetPath.startsWith("./") || assetPath.startsWith("config/") || assetPath.startsWith(".waifus/")) {
      if (this.deps.workspaceRoot) {
        return path.resolve(this.deps.workspaceRoot, assetPath.replace(/^\.\//, ""));
      }
      return path.resolve(assetPath);
    }

    if (this.deps.localAssetsRoot) {
      return path.join(this.deps.localAssetsRoot, assetPath);
    }

    return path.resolve(assetPath);
  }

  private scheduleReconnect(waifuId: string): void {
    if (this.manualStops.has(waifuId) || this.reconnectTimers.has(waifuId)) {
      return;
    }

    const waifu = this.waifuConfigs.get(waifuId);
    if (!waifu?.enabled) {
      return;
    }

    const nextAttempt = (this.reconnectAttempts.get(waifuId) ?? 0) + 1;
    this.reconnectAttempts.set(waifuId, nextAttempt);
    const delayMs = Math.min(30_000, 1_000 * 2 ** (nextAttempt - 1));

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(waifuId);
      void this.reconnectBot(waifuId, waifu);
    }, delayMs);

    this.reconnectTimers.set(waifuId, timer);
  }

  private async reconnectBot(waifuId: string, waifu: WaifuConfig): Promise<void> {
    try {
      await this.stopBotInternal(waifuId);
      await this.startBot(waifu);
      this.reconnectAttempts.set(waifuId, 0);
    } catch (error) {
      this.logger.error("Bot reconnect failed", { waifuId, error });
      this.scheduleReconnect(waifuId);
    }
  }

  private async stopBotInternal(waifuId: string): Promise<void> {
    this.manualStops.delete(waifuId);
    const bot = this.bots.get(waifuId);
    if (!bot) {
      return;
    }

    if (bot.userId) {
      this.userIdToWaifuId.delete(bot.userId);
    }

    bot.client.destroy();
    this.bots.delete(waifuId);

    if (this.listenerBotId === waifuId) {
      this.listenerBotId = null;
    }
  }

  private isCurrentInstance(waifuId: string, instance: BotInstance): boolean {
    return this.bots.get(waifuId) === instance;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
