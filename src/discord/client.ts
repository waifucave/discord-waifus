import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { Logger } from "../backend/logger.js";
import { ContextMessage } from "../orchestration/context.js";
import {
  DiscordBotConfig,
  GuildEmojiCacheEntry,
  GuildMemberCacheEntry,
  GuildRoleCacheEntry
} from "../shared/schemas/domain.js";
import { buildNormalizedDiscordContext } from "./contextBuilder.js";
import { unresolvedMentionIdsByType } from "./memberCache.js";
import { denormalizeModelContentForDiscord } from "./normalization.js";

export type DiscordRuntimeStatus = {
  connected: boolean;
  orchestratorConnected: boolean;
  waifuBotCount: number;
  warnings: string[];
};

export interface DiscordGatewayFacade {
  connect(): Promise<DiscordRuntimeStatus>;
  disconnect(): Promise<void>;
  onMessage?(listener: DiscordMessageListener): () => void;
  onReviewCommand?(listener: DiscordReviewCommandListener): () => void;
  listGuilds?(): Promise<Array<{ guildId: string; name: string }>>;
  fetchFreshContext(input: {
    guildId: string;
    channelId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ContextMessage[]>;
  sendWaifuMessage(input: {
    guildId: string;
    channelId: string;
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
  }): Promise<{ messageId: string }>;
  sendTyping(input: {
    guildId: string;
    channelId: string;
    senderBotId?: string;
  }): Promise<void>;
  deleteMessages?(input: {
    guildId: string;
    channelId: string;
    messageIds: string[];
    authorId?: string;
  }): Promise<DiscordDeleteMessagesResult>;
}

export type DiscordMessageEvent = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorBot: boolean;
};

export type DiscordMessageListener = (event: DiscordMessageEvent) => void | Promise<void>;

export type DiscordReviewCommandEvent = {
  guildId: string;
  channelId: string;
  userId: string;
  commandMessageId?: string;
  respond: (content: string) => Promise<void>;
};

export type DiscordReviewCommandListener = (event: DiscordReviewCommandEvent) => void | Promise<void>;

export type DiscordDeleteMessagesResult = {
  deletedMessageIds: string[];
  failedMessageIds: Array<{ messageId: string; message: string }>;
};

type DiscordCache = {
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  roles?: GuildRoleCacheEntry[];
};

export type DiscordJsGatewayOptions = {
  orchestrator: DiscordBotConfig;
  waifus?: DiscordBotConfig[];
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  cacheForGuild?: (guildId: string) => Promise<DiscordCache>;
  refreshMembersForGuild?: (guildId: string) => Promise<DiscordCache>;
  refreshRolesForGuild?: (guildId: string) => Promise<DiscordCache>;
  logger?: Logger;
};

export class DiscordJsGateway implements DiscordGatewayFacade {
  private readonly clients = new Map<string, Client>();
  private readonly listeners = new Set<DiscordMessageListener>();
  private readonly reviewListeners = new Set<DiscordReviewCommandListener>();
  private readonly recentMentionRefreshes = new Map<string, number>();

  constructor(private readonly options: DiscordJsGatewayOptions) {}

  async connect(): Promise<DiscordRuntimeStatus> {
    const bots = [this.options.orchestrator, ...(this.options.waifus ?? [])].filter(
      (bot): bot is DiscordBotConfig & { token: string } => Boolean(bot.token)
    );
    await Promise.all(
      bots.map(async (bot) => {
        const client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.MessageContent
          ],
          partials: [Partials.Channel, Partials.Message, Partials.Reaction]
        });
        if (bot.id === this.options.orchestrator.id) {
          client.on("messageCreate", (message) => {
            if (!message.guildId) return;
            const event: DiscordMessageEvent = {
              guildId: message.guildId,
              channelId: message.channelId,
              messageId: message.id,
              authorId: message.author.id,
              authorBot: message.author.bot
            };
            this.options.logger?.info("Discord gateway received message", {
              guildId: event.guildId,
              channelId: event.channelId,
              messageId: event.messageId,
              authorBot: event.authorBot
            });
            for (const listener of this.listeners) {
              void listener(event);
            }
          });
          client.on(Events.InteractionCreate, (interaction) => {
            if (!interaction.isChatInputCommand() || interaction.commandName !== REVIEW_COMMAND_NAME) return;
            void this.handleReviewInteraction(interaction);
          });
        }
        await loginAndWaitUntilReady(client, bot.token);
        this.clients.set(bot.id, client);
        if (bot.id === this.options.orchestrator.id) {
          await registerReviewCommand(client, this.options.logger);
        }
        this.options.logger?.info("Discord bot connected", {
          botId: bot.id,
          displayName: bot.displayName,
          kind: bot.id === this.options.orchestrator.id ? "orchestrator" : "waifu"
        });
      })
    );
    return {
      connected: this.clients.size > 0,
      orchestratorConnected: this.clients.has(this.options.orchestrator.id),
      waifuBotCount: (this.options.waifus ?? []).filter((bot) => this.clients.has(bot.id)).length,
      warnings:
        this.clients.size > 0
          ? []
          : ["No enabled Discord bot tokens are configured."]
    };
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.destroy()));
    this.clients.clear();
  }

  onMessage(listener: DiscordMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onReviewCommand(listener: DiscordReviewCommandListener): () => void {
    this.reviewListeners.add(listener);
    return () => this.reviewListeners.delete(listener);
  }

  async listGuilds(): Promise<Array<{ guildId: string; name: string }>> {
    const client = this.orchestratorClient();
    await client.guilds.fetch();
    return client.guilds.cache.map((guild) => ({
      guildId: guild.id,
      name: guild.name
    }));
  }

  async fetchFreshContext(input: {
    guildId: string;
    channelId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ContextMessage[]> {
    throwIfAborted(input.signal);
    const client = this.orchestratorClient();
    let cache = await this.cacheForGuild(input.guildId);
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("messages" in channel)) {
      return [];
    }
    const collection = await channel.messages.fetch({ limit: input.limit });
    const rawMessages = [...collection.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const mentionedRoles = uniqueMentionedRoles(rawMessages, cache.roles ?? []);
    const roleCacheForResolution = mergeRoleCaches(cache.roles ?? [], mentionedRoles);
    const missingMentionIds = unresolvedMentionIdsByType(
      rawMessages.map((message) => message.content),
      cache.members ?? [],
      roleCacheForResolution
    );
    if ((missingMentionIds.userIds.length > 0 || missingMentionIds.roleIds.length > 0) && this.shouldRefreshMentions(input.guildId)) {
      this.options.logger?.info("Refreshing Discord mention caches for unresolved mentions", {
        guildId: input.guildId,
        channelId: input.channelId,
        userMentionCount: missingMentionIds.userIds.length,
        roleMentionCount: missingMentionIds.roleIds.length,
        mentionIds: [...missingMentionIds.userIds, ...missingMentionIds.roleIds].slice(0, 5)
      });
      try {
        const [refreshedMembers, refreshedRoles] = await Promise.all([
          missingMentionIds.userIds.length > 0 ? this.options.refreshMembersForGuild?.(input.guildId) : undefined,
          missingMentionIds.roleIds.length > 0 ? this.options.refreshRolesForGuild?.(input.guildId) : undefined
        ]);
        cache = {
          ...cache,
          ...refreshedMembers,
          ...refreshedRoles
        };
      } catch (error) {
        this.options.logger?.warn("Discord mention cache refresh for unresolved mentions failed", {
          guildId: input.guildId,
          channelId: input.channelId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const messages = await Promise.all(
      rawMessages.map(async (message) => {
        const [replyTo, reactions] = await Promise.all([
          message.reference?.messageId
            ? resolveReplyReference(message).catch(() => ({ messageId: message.reference?.messageId ?? "" }))
            : undefined,
          summarizeReactions(message.reactions.cache.values(), cache)
        ]);
        return {
          id: message.id,
          channelId: message.channelId,
          guildId: message.guildId ?? input.guildId,
          authorId: message.author.id,
          authorName: message.author.username,
          authorDisplayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
          authorBot: message.author.bot,
          content: message.content,
          createdAt: message.createdAt,
          replyTo,
          reactions
        };
      })
    );
    return buildNormalizedDiscordContext(
      messages,
      { ...cache, roles: mergeRoleCaches(cache.roles ?? [], mentionedRoles) },
      {
        orchestratorAuthorIds: botAuthorIds([this.options.orchestrator]),
        waifuAuthorIds: botAuthorIds(this.options.waifus ?? [])
      }
    ).messages;
  }

  async sendWaifuMessage(input: {
    guildId: string;
    channelId: string;
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
  }): Promise<{ messageId: string }> {
    const client = input.senderBotId ? this.clients.get(input.senderBotId) : this.orchestratorClient();
    if (!client) {
      throw new Error(input.senderBotId
        ? `Waifu Discord bot ${input.senderBotId} is not connected.`
        : "Orchestrator Discord client is not connected.");
    }
    const cache = await this.cacheForGuild(input.guildId);
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Discord channel ${input.channelId} is not sendable.`);
    }
    const denormalized = denormalizeModelContentForDiscord(input.content, {
      ...cache,
      activeAuthorIds: input.allowedUserMentionIds
    });
    const replyToMessageId = sanitizeReplyTarget(input.replyToMessageId);
    if (input.replyToMessageId && !replyToMessageId) {
      this.options.logger?.warn("Dropping non-snowflake replyToMessageId", {
        guildId: input.guildId,
        channelId: input.channelId,
        value: input.replyToMessageId
      });
    }
    const sent = await channel.send({
      content: denormalized.content,
      allowedMentions: denormalized.allowedMentions,
      reply: replyToMessageId ? { messageReference: replyToMessageId } : undefined
    });
    return { messageId: sent.id };
  }

  async sendTyping(input: {
    guildId: string;
    channelId: string;
    senderBotId?: string;
  }): Promise<void> {
    const client = input.senderBotId ? this.clients.get(input.senderBotId) : this.orchestratorClient();
    if (!client) return;
    try {
      const channel = await client.channels.fetch(input.channelId);
      if (channel && "sendTyping" in channel) {
        await channel.sendTyping();
      }
    } catch (error) {
      this.options.logger?.warn("Failed to send typing indicator", {
        guildId: input.guildId,
        channelId: input.channelId,
        senderBotId: input.senderBotId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async deleteMessages(input: {
    guildId: string;
    channelId: string;
    messageIds: string[];
    authorId?: string;
  }): Promise<DiscordDeleteMessagesResult> {
    const client = this.clientForAuthor(input.authorId);
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Discord channel ${input.channelId} is not message-manageable.`);
    }
    const result: DiscordDeleteMessagesResult = {
      deletedMessageIds: [],
      failedMessageIds: []
    };
    for (const messageId of input.messageIds) {
      try {
        await channel.messages.delete(messageId);
        result.deletedMessageIds.push(messageId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failedMessageIds.push({ messageId, message });
        this.options.logger?.warn("Failed to delete Discord message", {
          guildId: input.guildId,
          channelId: input.channelId,
          messageId,
          authorId: input.authorId,
          deletingBotId: this.botIdForClient(client),
          message
        });
      }
    }
    return result;
  }

  private async cacheForGuild(guildId: string): Promise<DiscordCache> {
    return this.options.cacheForGuild?.(guildId) ?? {
      members: this.options.members,
      emojis: this.options.emojis
    };
  }

  private orchestratorClient(): Client {
    const client = this.clients.get(this.options.orchestrator.id);
    if (!client) {
      throw new Error("Orchestrator Discord client is not connected.");
    }
    return client;
  }

  private clientForAuthor(authorId?: string): Client {
    if (authorId) {
      const bots = [this.options.orchestrator, ...(this.options.waifus ?? [])];
      const bot = bots.find((candidate) => candidate.id === authorId || candidate.applicationId === authorId);
      const client = bot ? this.clients.get(bot.id) : undefined;
      if (client) {
        return client;
      }
    }
    return this.orchestratorClient();
  }

  private botIdForClient(client: Client): string | undefined {
    for (const [botId, candidate] of this.clients) {
      if (candidate === client) return botId;
    }
    return undefined;
  }

  private shouldRefreshMentions(guildId: string): boolean {
    if (!this.options.refreshMembersForGuild) return false;
    const now = Date.now();
    const previous = this.recentMentionRefreshes.get(guildId) ?? 0;
    if (now - previous < MENTION_REFRESH_COOLDOWN_MS) {
      return false;
    }
    this.recentMentionRefreshes.set(guildId, now);
    return true;
  }

  private async handleReviewInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/review can only be used in a server channel.");
      return;
    }
    const event: DiscordReviewCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.reviewListeners) {
      void listener(event);
    }
  }
}

export class DiscordGatewayNotConfigured implements DiscordGatewayFacade {
  async connect(): Promise<DiscordRuntimeStatus> {
    return {
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: ["Discord tokens are not configured yet."]
    };
  }

  async disconnect(): Promise<void> {}

  async fetchFreshContext(): Promise<ContextMessage[]> {
    return [];
  }

  async sendWaifuMessage(): Promise<{ messageId: string }> {
    throw new Error("Discord sending is not configured yet.");
  }

  async sendTyping(): Promise<void> {}
}

async function loginAndWaitUntilReady(client: Client, token: string): Promise<void> {
  if (client.isReady()) return;
  await Promise.all([
    new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    }),
    client.login(token)
  ]);
}

function botAuthorIds(bots: DiscordBotConfig[]): string[] {
  return bots.flatMap((bot) => [bot.id, bot.applicationId].filter((id): id is string => Boolean(id)));
}

async function resolveReplyReference(message: {
  reference?: { messageId?: string } | null;
  fetchReference?: () => Promise<{
    author: { username: string; globalName?: string | null };
    member?: { displayName?: string | null } | null;
    content: string;
  }>;
}): Promise<{ messageId: string; authorName?: string; contentPreview?: string } | undefined> {
  if (!message.reference?.messageId) return undefined;
  if (!message.fetchReference) {
    return { messageId: message.reference.messageId };
  }
  const referenced = await message.fetchReference();
  return {
    messageId: message.reference.messageId,
    authorName: referenced.member?.displayName ?? referenced.author.globalName ?? referenced.author.username,
    contentPreview: referenced.content.slice(0, 160)
  };
}

async function summarizeReactions(
  reactions: Iterable<{
    emoji: { name: string | null; identifier: string; id?: string | null; animated?: boolean | null };
    count: number | null;
    users?: {
      fetch: (options?: { limit?: number }) => Promise<
        { values(): Iterable<{ id: string; username: string; globalName?: string | null }> }
      >;
    };
  }>,
  cache: DiscordCache
) {
  const membersById = new Map((cache.members ?? []).map((member) => [member.userId, member]));
  const emojisById = new Map((cache.emojis ?? []).map((emoji) => [emoji.id, emoji]));
  return Promise.all(
    [...reactions].map(async (reaction) => {
      let users: string[] | undefined;
      if (reaction.users) {
        try {
          const fetched = await reaction.users.fetch({ limit: 20 });
          users = [...fetched.values()].map((user) => {
            const member = membersById.get(user.id);
            return member?.guildDisplayName ?? member?.globalDisplayName ?? user.globalName ?? user.username;
          });
        } catch {
          users = undefined;
        }
      }
      return {
        emoji: modelVisibleReactionEmoji(reaction.emoji, emojisById),
        count: reaction.count ?? 0,
        users
      };
    })
  );
}

function modelVisibleReactionEmoji(
  emoji: { name: string | null; identifier: string; id?: string | null; animated?: boolean | null },
  emojisById: Map<string, GuildEmojiCacheEntry>
): string {
  if (emoji.id) {
    const cached = emojisById.get(emoji.id);
    if (cached) {
      return `<${cached.animated ? "a" : ""}:${cached.name}:>`;
    }
    return emoji.name ? `:${emoji.name}:` : emoji.identifier;
  }
  return emoji.name ?? emoji.identifier;
}

function uniqueMentionedRoles(
  messages: Array<{ mentions?: { roles?: { values: () => Iterable<{ id: string; name: string }> } } }>,
  cachedRoles: GuildRoleCacheEntry[]
): GuildRoleCacheEntry[] {
  const cachedById = new Map(cachedRoles.map((role) => [role.id, role]));
  const rolesById = new Map<string, GuildRoleCacheEntry>();
  for (const message of messages) {
    for (const role of message.mentions?.roles?.values() ?? []) {
      rolesById.set(role.id, cachedById.get(role.id) ?? {
        id: role.id,
        name: role.name,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
        fetchedAt: new Date().toISOString()
      });
    }
  }
  return [...rolesById.values()];
}

function mergeRoleCaches(primary: GuildRoleCacheEntry[], fallback: GuildRoleCacheEntry[]): GuildRoleCacheEntry[] {
  const rolesById = new Map(fallback.map((role) => [role.id, role]));
  for (const role of primary) {
    rolesById.set(role.id, role);
  }
  return [...rolesById.values()];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Discord request aborted.");
  }
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MENTION_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const REVIEW_COMMAND_NAME = "review";

function sanitizeReplyTarget(value?: string): string | undefined {
  return value && SNOWFLAKE_PATTERN.test(value) ? value : undefined;
}

async function registerReviewCommand(client: Client, logger?: Logger): Promise<void> {
  try {
    const manager = client.application?.commands;
    if (!manager) return;
    const payload = {
      name: REVIEW_COMMAND_NAME,
      description: "Review and remove the latest waifu message if it leaked hallucinated internals."
    };
    const commands = await manager.fetch();
    const existing = commands.find((command) => command.name === REVIEW_COMMAND_NAME);
    if (existing) {
      await manager.edit(existing.id, payload);
    } else {
      await manager.create(payload);
    }
  } catch (error) {
    logger?.warn("Failed to register /review command", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
