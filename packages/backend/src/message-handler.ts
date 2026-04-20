import type { Collection, Message, Snowflake, TextBasedChannel } from "discord.js";
import type { BotManager } from "./bot-manager.js";

const MAX_REACTION_TYPES = 5;
const MAX_REACTOR_USERS = 5;

export interface FormattedReactionUser {
  displayName: string;
  userId: string;
  isWaifu: boolean;
  waifuId: string | null;
}

export interface FormattedReaction {
  emoji: string;
  count: number;
  reactors: FormattedReactionUser[];
}

export interface FormattedMessage {
  id: string;
  content: string;
  authorDisplayName: string;
  authorId: string;
  isWaifu: boolean;
  waifuId: string | null;
  isUser: boolean;
  timestamp: string;
  replyingTo: {
    id: string;
    content: string;
    author: string;
  } | null;
  mentions: string[];
  quotedLines: string[];
  reactions: FormattedReaction[];
}

export class MessageHandler {
  constructor(private readonly botManager: BotManager) {}

  async fetchContext(
    channel: TextBasedChannel,
    limit = 80,
    afterMessageId: string | null = null
  ): Promise<FormattedMessage[]> {
    if (!("messages" in channel)) {
      return [];
    }

    const clampedLimit = Math.min(Math.max(limit, 1), 100);
    const messages = (await channel.messages.fetch({
      limit: 100
    })) as Collection<Snowflake, Message>;

    const sorted = [...messages.values()]
      .filter((message) =>
        afterMessageId ? BigInt(message.id) > BigInt(afterMessageId) : true
      )
      .sort(
      (left, right) => left.createdTimestamp - right.createdTimestamp
      )
      .slice(-clampedLimit);

    return Promise.all(sorted.map(async (message) => this.formatMessage(message)));
  }

  async formatMessage(message: Message): Promise<FormattedMessage> {
    const waifuId = this.botManager.getWaifuIdByUserId(message.author.id);
    const normalizedContent = this.normalizeDiscordMentions(message);
    const replyContext = message.reference?.messageId
      ? await this.fetchReplyContext(message)
      : null;

    return {
      id: message.id,
      content: normalizedContent,
      authorDisplayName: this.resolvePromptFacingUserName(
        message.author.id,
        message.member?.displayName ?? message.author.globalName ?? message.author.username
      ),
      authorId: message.author.id,
      isWaifu: waifuId !== null,
      waifuId,
      isUser: !message.author.bot,
      timestamp: message.createdAt.toISOString(),
      replyingTo: replyContext,
      mentions: [
        ...new Set(
          [...message.mentions.users.values()].map((user) =>
            this.resolvePromptFacingUserName(user.id, user.globalName ?? user.username)
          )
        )
      ],
      quotedLines: extractQuotedLines(normalizedContent),
      reactions: await this.fetchReactions(message)
    };
  }

  private async fetchReplyContext(message: Message): Promise<FormattedMessage["replyingTo"]> {
    try {
      const replied = await message.fetchReference();
      return {
        id: replied.id,
        content: this.normalizeDiscordMentions(replied),
        author: this.resolvePromptFacingUserName(
          replied.author.id,
          replied.member?.displayName ?? replied.author.globalName ?? replied.author.username
        )
      };
    } catch {
      return null;
    }
  }

  private async fetchReactions(message: Message): Promise<FormattedReaction[]> {
    const reactions = [...message.reactions.cache.values()]
      .sort((left, right) => (right.count ?? 0) - (left.count ?? 0))
      .slice(0, MAX_REACTION_TYPES);

    return Promise.all(
      reactions.map(async (reaction) => {
        let users: FormattedReactionUser[] = [];

        try {
          const fetched = await reaction.users.fetch({ limit: MAX_REACTOR_USERS });
          users = [...fetched.values()].slice(0, MAX_REACTOR_USERS).map((user) => {
            const waifuId = this.botManager.getWaifuIdByUserId(user.id);
            return {
              displayName: this.resolvePromptFacingUserName(
                user.id,
                user.globalName ?? user.username
              ),
              userId: user.id,
              isWaifu: waifuId !== null,
              waifuId
            };
          });
        } catch {
          users = [...reaction.users.cache.values()].slice(0, MAX_REACTOR_USERS).map((user) => {
            const waifuId = this.botManager.getWaifuIdByUserId(user.id);
            return {
              displayName: this.resolvePromptFacingUserName(
                user.id,
                user.globalName ?? user.username
              ),
              userId: user.id,
              isWaifu: waifuId !== null,
              waifuId
            };
          });
        }

        return {
          emoji: formatReactionEmoji(reaction.emoji.name, reaction.emoji.id),
          count: reaction.count ?? users.length,
          reactors: users
        };
      })
    );
  }

  private resolvePromptFacingUserName(userId: string, fallbackName: string): string {
    return this.botManager.getWaifuNameByUserId(userId) ?? fallbackName;
  }

  private normalizeDiscordMentions(message: Message): string {
    return message.content
      .replace(/<@!?(\d+)>/g, (match, userId: string) => {
        const user =
          message.mentions.users.get(userId) ??
          message.client.users.cache.get(userId);
        if (!user) {
          return match;
        }

        return `@${this.resolvePromptFacingUserName(
          userId,
          user.globalName ?? user.username
        )}`;
      })
      .replace(/<#(\d+)>/g, (match, channelId: string) => {
        const channel = message.client.channels.cache.get(channelId);
        if (!channel || !("name" in channel) || typeof channel.name !== "string") {
          return match;
        }

        return `#${channel.name}`;
      })
      .replace(/<a?:([A-Za-z0-9_]{2,32}):\d+>/g, ":$1:");
  }
}

function extractQuotedLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^>\s?/, ""))
    .filter(Boolean);
}

function formatReactionEmoji(name: string | null, id?: string | null): string {
  if (!name) {
    return "unknown";
  }

  if (!id) {
    return name;
  }

  return `:${name}:`;
}
