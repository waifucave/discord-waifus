// Event shapes the Discord gateway publishes for the Phase 5 caches (spec 9.4): the
// ConversationMessageCache consumes `DiscordConversationEvent`, the GuildDirectory consumes
// `DiscordDirectoryEvent`. Plain data only (no discord.js types) so fakes and tests can emit them.

import type { ConversationRef } from "../orchestration/context/keys.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type {
  GuildEmojiCacheEntry,
  GuildMemberCacheEntry,
  GuildRoleCacheEntry
} from "../shared/schemas/domain.js";

/** Fields a partial `messageUpdate` (embed unfurl, pin, ...) can carry for a message we know. */
export type DiscordMessagePatch = Partial<Pick<RawDiscordMessage, "content" | "embeds" | "editedAt" | "attachments">>;

export type DiscordReactionEmoji = { id?: string; name: string; animated?: boolean };

/**
 * Gateway scope of a connection event: "guild" is the orchestrator client (guild messages); DM
 * transports (wave 2) use `dm:<botId>`. A cache trusts a conversation only while its scope has not
 * reconnected since the conversation was synced.
 */
export type DiscordConnectionScope = "guild" | `dm:${string}`;

export type DiscordConnectionState = "ready" | "reconnecting" | "resumed" | "invalidated" | "disconnected";

export type DiscordConversationEvent =
  | {
      type: "create";
      conversation: ConversationRef;
      message: RawDiscordMessage;
      /** True for a message one of our own bots just sent (published before sendWaifuMessage returns). */
      own?: boolean;
    }
  | {
      type: "update";
      conversation: ConversationRef;
      messageId: string;
      /** The full new version when the gateway delivered one. */
      message?: RawDiscordMessage;
      /** Otherwise (partial payload) only the changed fields. */
      patch?: DiscordMessagePatch;
    }
  | { type: "delete"; conversation: ConversationRef; messageId: string }
  | { type: "deleteBulk"; conversation: ConversationRef; messageIds: string[] }
  | {
      type: "reaction";
      conversation: ConversationRef;
      action: "add" | "remove" | "removeAll" | "removeEmoji";
      messageId: string;
      emoji?: DiscordReactionEmoji;
      /** Gateway-reported total after the change, when known (partials report null). */
      count?: number;
      userId?: string;
      userName?: string;
    }
  | { type: "connection"; scope: DiscordConnectionScope; state: DiscordConnectionState };

export type DiscordChannelEntry = {
  id: string;
  name: string;
  parentId?: string;
  kind: "channel" | "thread";
};

export type DiscordDirectoryEvent = { guildId: string } & (
  | {
      type: "snapshot";
      name?: string;
      roles: GuildRoleCacheEntry[];
      emojis: GuildEmojiCacheEntry[];
      channels: DiscordChannelEntry[];
      members: GuildMemberCacheEntry[];
    }
  | { type: "guildDelete" }
  | { type: "roleUpsert"; role: GuildRoleCacheEntry }
  | { type: "roleDelete"; roleId: string }
  | { type: "emojiUpsert"; emoji: GuildEmojiCacheEntry }
  | { type: "emojiDelete"; emojiId: string }
  | { type: "channelUpsert"; channel: DiscordChannelEntry }
  | { type: "channelDelete"; channelId: string }
  | { type: "memberUpsert"; member: GuildMemberCacheEntry }
  | { type: "memberRemove"; userId: string }
);

export type DiscordConversationEventListener = (event: DiscordConversationEvent) => void;
export type DiscordDirectoryEventListener = (event: DiscordDirectoryEvent) => void;
