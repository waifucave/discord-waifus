// discord.js → cache events (spec 9.4). The orchestrator client's gateway events become plain
// `DiscordConversationEvent`s (messages, reactions, connection state) and `DiscordDirectoryEvent`s
// (roles, emojis, channels, threads, members). Nothing here calls REST: reaction users and message
// authors come from the event payload and the discord.js caches only.

import { Events } from "discord.js";
import type { Client, Guild } from "discord.js";
import type { GuildEmojiCacheEntry, GuildMemberCacheEntry, GuildRoleCacheEntry } from "../shared/schemas/domain.js";
import {
  isCompleteDiscordMessage,
  rawMessagePatch,
  toRawDiscordMessage,
  type DiscordMessageLike
} from "./rawMessage.js";
import type {
  DiscordChannelEntry,
  DiscordConnectionScope,
  DiscordConnectionState,
  DiscordConversationEvent,
  DiscordDirectoryEvent,
  DiscordReactionEmoji
} from "./gatewayEvents.js";

type Sink = {
  conversation(event: DiscordConversationEvent): void;
  directory(event: DiscordDirectoryEvent): void;
  /** Our own bots' user ids (orchestrator included): its debug posts are never conversation. */
  ignoredAuthorIds(): ReadonlySet<string>;
};

// Structural views of the discord.js objects we read, so a malformed event cannot throw here.
type MessageRefLike = { id: string; channelId?: string | null; guildId?: string | null; guild?: { id: string } | null };
type EmojiLike = { id?: string | null; name?: string | null; identifier?: string; animated?: boolean | null };
type UserLike = { id: string; username?: string | null; globalName?: string | null };

export function connectionEvent(scope: DiscordConnectionScope, state: DiscordConnectionState): DiscordConversationEvent {
  return { type: "connection", scope, state };
}

function emojiOf(emoji: EmojiLike): DiscordReactionEmoji {
  return {
    ...(emoji.id ? { id: emoji.id } : {}),
    name: emoji.name ?? emoji.identifier ?? "?",
    ...(emoji.animated ? { animated: true } : {})
  };
}

export function memberEntry(member: {
  id: string;
  nickname?: string | null;
  displayName?: string | null;
  user: { username?: string | null; globalName?: string | null; bot?: boolean | null };
}): GuildMemberCacheEntry {
  return {
    userId: member.id,
    ...(member.user.username ? { username: member.user.username } : {}),
    ...(member.user.globalName ? { globalDisplayName: member.user.globalName } : {}),
    guildDisplayName: member.nickname ?? member.user.globalName ?? member.user.username ?? member.displayName ?? undefined,
    bot: member.user.bot ?? false,
    lastSeenAt: new Date().toISOString(),
    perChannelLastSeenAt: {}
  };
}

export function roleEntry(role: { id: string; name: string; color?: number; hoist?: boolean; mentionable?: boolean; managed?: boolean }): GuildRoleCacheEntry {
  return {
    id: role.id,
    name: role.name,
    color: role.color ?? 0,
    hoist: role.hoist ?? false,
    mentionable: role.mentionable ?? false,
    managed: role.managed ?? false,
    fetchedAt: new Date().toISOString()
  };
}

export function emojiEntry(emoji: { id: string | null; name: string | null; animated?: boolean | null; available?: boolean | null; roles?: { cache?: { keys(): Iterable<string> } } }): GuildEmojiCacheEntry | undefined {
  if (!emoji.id || !emoji.name) return undefined;
  return {
    id: emoji.id,
    name: emoji.name,
    animated: emoji.animated ?? false,
    available: emoji.available ?? true,
    roles: emoji.roles?.cache ? [...emoji.roles.cache.keys()] : [],
    fetchedAt: new Date().toISOString()
  };
}

type ChannelLike = { id: string; name?: string | null; parentId?: string | null; guildId?: string | null; isThread?: () => boolean };

export function channelEntry(channel: ChannelLike): DiscordChannelEntry | undefined {
  if (!channel.name) return undefined;
  return {
    id: channel.id,
    name: channel.name,
    ...(channel.parentId ? { parentId: channel.parentId } : {}),
    kind: channel.isThread?.() ? "thread" : "channel"
  };
}

/** Everything the guild's own caches already hold (GUILD_CREATE payload): no REST involved. */
export function guildSnapshotEvent(guild: Guild): DiscordDirectoryEvent {
  return {
    type: "snapshot",
    guildId: guild.id,
    name: guild.name,
    roles: [...guild.roles.cache.values()].filter((role) => role.id !== guild.id).map(roleEntry),
    emojis: [...guild.emojis.cache.values()].flatMap((emoji) => emojiEntry(emoji) ?? []),
    channels: [...guild.channels.cache.values()].flatMap((channel) => channelEntry(channel as unknown as ChannelLike) ?? []),
    members: [...guild.members.cache.values()].map((member) => memberEntry(member))
  };
}

export function attachGatewayFeed(client: Client, scope: DiscordConnectionScope, sink: Sink): void {
  const guildConversation = (guildId: string, channelId: string) => ({ kind: "guild" as const, guildId, channelId });

  // ---- messages -------------------------------------------------------------------------------
  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId || sink.ignoredAuthorIds().has(message.author.id)) return;
    sink.conversation({
      type: "create",
      conversation: guildConversation(message.guildId, message.channelId),
      message: toRawDiscordMessage(message as unknown as DiscordMessageLike, message.guildId)
    });
  });
  client.on(Events.MessageUpdate, (_old, updated) => {
    const guildId = updated.guildId;
    if (!guildId) return;
    const conversation = guildConversation(guildId, updated.channelId);
    const like = updated as unknown as Partial<DiscordMessageLike>;
    if (isCompleteDiscordMessage(like)) {
      if (sink.ignoredAuthorIds().has(like.author.id)) return;
      sink.conversation({
        type: "update",
        conversation,
        messageId: updated.id,
        message: toRawDiscordMessage(like, guildId)
      });
      return;
    }
    const patch = rawMessagePatch(like);
    if (Object.keys(patch).length === 0) return;
    sink.conversation({ type: "update", conversation, messageId: updated.id, patch });
  });
  client.on(Events.MessageDelete, (message) => {
    if (!message.guildId) return;
    sink.conversation({
      type: "delete",
      conversation: guildConversation(message.guildId, message.channelId),
      messageId: message.id
    });
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    const guildId = channel.guildId;
    if (!guildId) return;
    sink.conversation({
      type: "deleteBulk",
      conversation: guildConversation(guildId, channel.id),
      messageIds: [...messages.keys()]
    });
  });

  // ---- reactions (event-fed summaries; never users.fetch) -------------------------------------
  const reactionContext = (message: MessageRefLike) => {
    const guildId = message.guildId ?? message.guild?.id;
    return guildId && message.channelId ? guildConversation(guildId, message.channelId) : undefined;
  };
  const userNameOf = (message: MessageRefLike & { guild?: { members?: { cache?: { get(id: string): { displayName?: string | null } | undefined } } } | null }, user: UserLike) =>
    message.guild?.members?.cache?.get(user.id)?.displayName ?? user.globalName ?? user.username ?? undefined;
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    const conversation = reactionContext(reaction.message as MessageRefLike);
    if (!conversation) return;
    const name = userNameOf(reaction.message as never, user as UserLike);
    sink.conversation({
      type: "reaction",
      conversation,
      action: "add",
      messageId: reaction.message.id,
      emoji: emojiOf(reaction.emoji),
      ...(typeof reaction.count === "number" ? { count: reaction.count } : {}),
      userId: user.id,
      ...(name ? { userName: name } : {})
    });
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    const conversation = reactionContext(reaction.message as MessageRefLike);
    if (!conversation) return;
    sink.conversation({
      type: "reaction",
      conversation,
      action: "remove",
      messageId: reaction.message.id,
      emoji: emojiOf(reaction.emoji),
      ...(typeof reaction.count === "number" ? { count: reaction.count } : {}),
      userId: user.id
    });
  });
  client.on(Events.MessageReactionRemoveAll, (message) => {
    const conversation = reactionContext(message as MessageRefLike);
    if (!conversation) return;
    sink.conversation({ type: "reaction", conversation, action: "removeAll", messageId: message.id });
  });
  client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
    const conversation = reactionContext(reaction.message as MessageRefLike);
    if (!conversation) return;
    sink.conversation({
      type: "reaction",
      conversation,
      action: "removeEmoji",
      messageId: reaction.message.id,
      emoji: emojiOf(reaction.emoji)
    });
  });

  // ---- connection state (trust) ---------------------------------------------------------------
  client.on(Events.ShardReady, () => sink.conversation(connectionEvent(scope, "ready")));
  client.on(Events.ShardReconnecting, () => sink.conversation(connectionEvent(scope, "reconnecting")));
  client.on(Events.ShardResume, () => sink.conversation(connectionEvent(scope, "resumed")));
  client.on(Events.ShardDisconnect, () => sink.conversation(connectionEvent(scope, "disconnected")));

  // ---- guild directory ------------------------------------------------------------------------
  // GuildCreate only fires for guilds joined (or becoming available) later; guilds the bot is
  // already in arrive with the READY payload, so seed them from the cache once the client is ready.
  client.on(Events.GuildCreate, (guild) => sink.directory(guildSnapshotEvent(guild)));
  client.on(Events.GuildAvailable, (guild) => sink.directory(guildSnapshotEvent(guild)));
  client.on(Events.ClientReady, (ready) => {
    for (const guild of ready.guilds.cache.values()) sink.directory(guildSnapshotEvent(guild));
  });
  client.on(Events.GuildDelete, (guild) => sink.directory({ type: "guildDelete", guildId: guild.id }));
  client.on(Events.GuildRoleCreate, (role) => sink.directory({ type: "roleUpsert", guildId: role.guild.id, role: roleEntry(role) }));
  client.on(Events.GuildRoleUpdate, (_old, role) => sink.directory({ type: "roleUpsert", guildId: role.guild.id, role: roleEntry(role) }));
  client.on(Events.GuildRoleDelete, (role) => sink.directory({ type: "roleDelete", guildId: role.guild.id, roleId: role.id }));
  client.on(Events.GuildEmojiCreate, (emoji) => {
    const entry = emojiEntry(emoji);
    if (entry) sink.directory({ type: "emojiUpsert", guildId: emoji.guild.id, emoji: entry });
  });
  client.on(Events.GuildEmojiUpdate, (_old, emoji) => {
    const entry = emojiEntry(emoji);
    if (entry) sink.directory({ type: "emojiUpsert", guildId: emoji.guild.id, emoji: entry });
  });
  client.on(Events.GuildEmojiDelete, (emoji) => sink.directory({ type: "emojiDelete", guildId: emoji.guild.id, emojiId: emoji.id }));
  const channelUpsert = (channel: ChannelLike) => {
    const entry = channelEntry(channel);
    if (channel.guildId && entry) sink.directory({ type: "channelUpsert", guildId: channel.guildId, channel: entry });
  };
  client.on(Events.ChannelCreate, (channel) => channelUpsert(channel as unknown as ChannelLike));
  client.on(Events.ChannelUpdate, (_old, channel) => channelUpsert(channel as unknown as ChannelLike));
  client.on(Events.ChannelDelete, (channel) => {
    if ("guildId" in channel && channel.guildId) sink.directory({ type: "channelDelete", guildId: channel.guildId, channelId: channel.id });
  });
  client.on(Events.ThreadCreate, (thread) => channelUpsert(thread as unknown as ChannelLike));
  client.on(Events.ThreadUpdate, (_old, thread) => channelUpsert(thread as unknown as ChannelLike));
  client.on(Events.ThreadDelete, (thread) => {
    if (thread.guildId) sink.directory({ type: "channelDelete", guildId: thread.guildId, channelId: thread.id });
  });
  // Member events are only delivered with the opt-in privileged GuildMembers intent (O7).
  client.on(Events.GuildMemberAdd, (member) => sink.directory({ type: "memberUpsert", guildId: member.guild.id, member: memberEntry(member) }));
  client.on(Events.GuildMemberUpdate, (_old, member) => sink.directory({ type: "memberUpsert", guildId: member.guild.id, member: memberEntry(member) }));
  client.on(Events.GuildMemberRemove, (member) => sink.directory({ type: "memberRemove", guildId: member.guild.id, userId: member.id }));
}
