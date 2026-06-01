import { ApplicationCommandOptionType, Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
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
  onClearCommand?(listener: DiscordClearCommandListener): () => void;
  onRunCommand?(listener: DiscordRunCommandListener): () => void;
  onStopCommand?(listener: DiscordStopCommandListener): () => void;
  onMemoriesCommand?(listener: DiscordMemoriesCommandListener): () => void;
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
    authorIdByMessageId?: Record<string, string>;
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

export type DiscordSlashCommandEvent = {
  guildId: string;
  channelId: string;
  userId: string;
  commandMessageId?: string;
  respond: (content: string) => Promise<void>;
};

export type DiscordReviewCommandEvent = DiscordSlashCommandEvent;
export type DiscordClearCommandEvent = DiscordSlashCommandEvent & {
  count?: number;
  type?: DiscordClearType;
};
export type DiscordRunCommandEvent = DiscordSlashCommandEvent & {
  waifuId?: string;
  sceneDirection?: string;
};
export type DiscordStopCommandEvent = DiscordSlashCommandEvent;
export type DiscordMemoriesCommandEvent = DiscordSlashCommandEvent;
export type DiscordReviewCommandListener = (event: DiscordReviewCommandEvent) => void | Promise<void>;
export type DiscordClearCommandListener = (event: DiscordClearCommandEvent) => void | Promise<void>;
export type DiscordRunCommandListener = (event: DiscordRunCommandEvent) => void | Promise<void>;
export type DiscordStopCommandListener = (event: DiscordStopCommandEvent) => void | Promise<void>;
export type DiscordMemoriesCommandListener = (event: DiscordMemoriesCommandEvent) => void | Promise<void>;

export type DiscordClearType = "waifus" | "all";

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
  private readonly clearListeners = new Set<DiscordClearCommandListener>();
  private readonly runListeners = new Set<DiscordRunCommandListener>();
  private readonly stopListeners = new Set<DiscordStopCommandListener>();
  private readonly memoriesListeners = new Set<DiscordMemoriesCommandListener>();
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
            if (!interaction.isChatInputCommand()) return;
            if (interaction.commandName === REVIEW_COMMAND_NAME) {
              void this.handleReviewInteraction(interaction);
            } else if (interaction.commandName === CLEAR_COMMAND_NAME) {
              void this.handleClearInteraction(interaction);
            } else if (interaction.commandName === RUN_COMMAND_NAME) {
              void this.handleRunInteraction(interaction);
            } else if (interaction.commandName === STOP_COMMAND_NAME) {
              void this.handleStopInteraction(interaction);
            } else if (interaction.commandName === MEMORIES_COMMAND_NAME) {
              void this.handleMemoriesInteraction(interaction);
            }
          });
        }
        await loginAndWaitUntilReady(client, bot.token);
        this.clients.set(bot.id, client);
        if (bot.id === this.options.orchestrator.id) {
          await registerOrchestratorCommands(client, this.options.logger);
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

  onClearCommand(listener: DiscordClearCommandListener): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  onRunCommand(listener: DiscordRunCommandListener): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  onStopCommand(listener: DiscordStopCommandListener): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  onMemoriesCommand(listener: DiscordMemoriesCommandListener): () => void {
    this.memoriesListeners.add(listener);
    return () => this.memoriesListeners.delete(listener);
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
          images: collectImageAttachments(message),
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
    authorIdByMessageId?: Record<string, string>;
  }): Promise<DiscordDeleteMessagesResult> {
    const result: DiscordDeleteMessagesResult = {
      deletedMessageIds: [],
      failedMessageIds: []
    };
    if (input.messageIds.length === 0) return result;

    const orchestrator = this.orchestratorClient();
    const orchestratorChannel = await orchestrator.channels.fetch(input.channelId);
    if (!orchestratorChannel || !("messages" in orchestratorChannel)) {
      throw new Error(`Discord channel ${input.channelId} is not message-manageable.`);
    }

    const remaining = new Set(input.messageIds);
    const supportsBulkDelete =
      "bulkDelete" in orchestratorChannel &&
      typeof (orchestratorChannel as { bulkDelete?: unknown }).bulkDelete === "function";
    if (input.messageIds.length >= 2 && supportsBulkDelete) {
      try {
        const bulkChannel = orchestratorChannel as unknown as {
          bulkDelete(messages: string[], filterOld?: boolean): Promise<{ keys(): IterableIterator<string> }>;
        };
        const bulkDeleted = await bulkChannel.bulkDelete(input.messageIds, true);
        for (const id of bulkDeleted.keys()) {
          if (remaining.has(id)) {
            result.deletedMessageIds.push(id);
            remaining.delete(id);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn(
          "Discord bulk delete failed, falling back to per-message deletes",
          {
            guildId: input.guildId,
            channelId: input.channelId,
            messageCount: input.messageIds.length,
            message
          }
        );
      }
    }

    if (remaining.size === 0) return result;

    const channelByBotId = new Map<string, typeof orchestratorChannel>();
    channelByBotId.set(this.options.orchestrator.id, orchestratorChannel);
    for (const messageId of input.messageIds) {
      if (!remaining.has(messageId)) continue;
      const messageAuthorId = input.authorIdByMessageId?.[messageId] ?? input.authorId;
      const client = this.clientForAuthor(messageAuthorId);
      const botId = this.botIdForClient(client);
      let channel = botId ? channelByBotId.get(botId) : undefined;
      try {
        if (!channel) {
          const fetched = await client.channels.fetch(input.channelId);
          if (!fetched || !("messages" in fetched)) {
            throw new Error(`Discord channel ${input.channelId} is not message-manageable from this bot.`);
          }
          channel = fetched;
          if (botId) channelByBotId.set(botId, fetched);
        }
        await channel.messages.delete(messageId);
        result.deletedMessageIds.push(messageId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failedMessageIds.push({ messageId, message });
        this.options.logger?.warn("Failed to delete Discord message", {
          guildId: input.guildId,
          channelId: input.channelId,
          messageId,
          authorId: messageAuthorId,
          deletingBotId: botId,
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

  private async handleClearInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/clear can only be used in a server channel.");
      return;
    }
    const event: DiscordClearCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      count: interaction.options.getInteger(CLEAR_COUNT_OPTION_NAME) ?? 1,
      type: parseClearType(interaction.options.getString(CLEAR_TYPE_OPTION_NAME)),
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.clearListeners) {
      void listener(event);
    }
  }

  private async handleRunInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/run can only be used in a server channel.");
      return;
    }
    const event: DiscordRunCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      waifuId: sanitizeRunString(interaction.options.getString(RUN_WAIFU_OPTION_NAME)),
      sceneDirection: sanitizeRunString(interaction.options.getString(RUN_SCENE_DIRECTION_OPTION_NAME)),
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.runListeners) {
      void listener(event);
    }
  }

  private async handleStopInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/stop can only be used in a server channel.");
      return;
    }
    const event: DiscordStopCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.stopListeners) {
      void listener(event);
    }
  }

  private async handleMemoriesInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/memories can only be used in a server channel.");
      return;
    }
    const event: DiscordMemoriesCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.memoriesListeners) {
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

function collectImageAttachments(message: {
  attachments?: { values(): Iterable<{ url: string; contentType?: string | null; name?: string | null; size?: number | null }> };
}): Array<{ url: string; contentType?: string; contentLengthBytes?: number }> | undefined {
  if (!message.attachments) return undefined;
  const images: Array<{ url: string; contentType?: string; contentLengthBytes?: number }> = [];
  for (const attachment of message.attachments.values()) {
    if (!attachment.url) continue;
    const contentType = attachment.contentType ?? undefined;
    if (isImageAttachment(contentType, attachment.name ?? undefined)) {
      images.push({
        url: attachment.url,
        contentType,
        contentLengthBytes: attachment.size ?? undefined
      });
    }
  }
  return images.length ? images : undefined;
}

function isImageAttachment(contentType: string | undefined, name: string | undefined): boolean {
  if (contentType) return contentType.startsWith("image/");
  return /\.(png|jpe?g|webp|gif)$/i.test(name ?? "");
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
const CLEAR_COMMAND_NAME = "clear";
const RUN_COMMAND_NAME = "run";
const STOP_COMMAND_NAME = "stop";
const MEMORIES_COMMAND_NAME = "memories";
const CLEAR_COUNT_OPTION_NAME = "count";
const CLEAR_TYPE_OPTION_NAME = "type";
const RUN_WAIFU_OPTION_NAME = "waifu";
const RUN_SCENE_DIRECTION_OPTION_NAME = "scene_direction";
const MAX_CLEAR_COUNT = 100;

function sanitizeReplyTarget(value?: string): string | undefined {
  return value && SNOWFLAKE_PATTERN.test(value) ? value : undefined;
}

function sanitizeRunString(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function registerOrchestratorCommands(client: Client, logger?: Logger): Promise<void> {
  try {
    const manager = client.application?.commands;
    if (!manager) return;
    const payloads = [
      {
        name: REVIEW_COMMAND_NAME,
        description: "Review and remove the latest waifu message if it leaked hallucinated internals."
      },
      {
        name: CLEAR_COMMAND_NAME,
        description: "Delete the latest waifu messages without running reviewer judgment.",
        options: [
          {
            type: ApplicationCommandOptionType.Integer as ApplicationCommandOptionType.Integer,
            name: CLEAR_COUNT_OPTION_NAME,
            description: "How many latest waifu messages to delete.",
            required: false,
            min_value: 1,
            max_value: MAX_CLEAR_COUNT
          },
          {
            type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
            name: CLEAR_TYPE_OPTION_NAME,
            description: "Which messages to clear.",
            required: false,
            choices: [
              { name: "waifus", value: "waifus" },
              { name: "all", value: "all" }
            ]
          }
        ]
      },
      {
        name: RUN_COMMAND_NAME,
        description: "Run the orchestrator in this channel immediately if the runtime is idle.",
        options: [
          {
            type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
            name: RUN_WAIFU_OPTION_NAME,
            description: "Optional waifu id or display name to speak first.",
            required: false
          },
          {
            type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
            name: RUN_SCENE_DIRECTION_OPTION_NAME,
            description: "Optional private scene direction for the selected waifu.",
            required: false
          }
        ]
      },
      {
        name: STOP_COMMAND_NAME,
        description: "Stop the current orchestrator and waifu work in this channel."
      },
      {
        name: MEMORIES_COMMAND_NAME,
        description: "Run the stage manager for this channel and update guild memories."
      }
    ];
    const commands = await manager.fetch();
    for (const payload of payloads) {
      const existing = commands.find((command) => command.name === payload.name);
      if (existing) {
        await manager.edit(existing.id, payload);
      } else {
        await manager.create(payload);
      }
    }
  } catch (error) {
    logger?.warn("Failed to register orchestrator slash commands", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseClearType(value: string | null): DiscordClearType {
  return value === "all" ? "all" : "waifus";
}
