import { Client, Events, GatewayIntentBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordJsGateway } from "../src/discord/client.js";
import type { DiscordConversationEvent, DiscordDirectoryEvent } from "../src/discord/gatewayEvents.js";
import { attachGatewayFeed, guildSnapshotEvent } from "../src/discord/gatewayFeed.js";
import { quietLogger } from "./contextFixtures.js";

function feed(ignored: string[] = ["orch-bot"]) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const conversation: DiscordConversationEvent[] = [];
  const directory: DiscordDirectoryEvent[] = [];
  attachGatewayFeed(client, "guild", {
    conversation: (event) => conversation.push(event),
    directory: (event) => directory.push(event),
    ignoredAuthorIds: () => new Set(ignored)
  });
  const emit = (event: string, ...args: unknown[]) => (client as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit(event, ...args);
  return { client, conversation, directory, emit };
}

function discordMessage(o: Record<string, unknown> = {}) {
  return {
    id: "1300000000000000001",
    channelId: "200",
    guildId: "100",
    author: { id: "kevin", username: "kev", globalName: "Kevin", bot: false },
    member: { displayName: "Kev" },
    createdTimestamp: Date.parse("2026-10-24T14:00:00.000Z"),
    editedTimestamp: null,
    type: 0,
    content: "hello",
    attachments: { values: () => [] },
    embeds: [],
    stickers: { values: () => [] },
    mentions: { users: new Map(), roles: new Map(), channels: new Map() },
    ...o
  };
}

describe("gateway feed: messages", () => {
  it("turns guild messages into raw create events and skips DMs and the orchestrator's own posts", () => {
    const { conversation, emit } = feed();
    emit(Events.MessageCreate, discordMessage());
    emit(Events.MessageCreate, discordMessage({ id: "2", guildId: null }));
    emit(Events.MessageCreate, discordMessage({ id: "3", author: { id: "orch-bot", username: "orch", bot: true } }));
    expect(conversation).toHaveLength(1);
    expect(conversation[0]).toMatchObject({
      type: "create",
      conversation: { kind: "guild", guildId: "100", channelId: "200" },
      message: { id: "1300000000000000001", authorName: "Kev", content: "hello" }
    });
  });

  it("separates a complete update from a partial one that only carries changed fields", () => {
    const { conversation, emit } = feed();
    emit(Events.MessageUpdate, discordMessage(), discordMessage({ content: "hello!", editedTimestamp: Date.parse("2026-10-24T14:05:00.000Z") }));
    emit(Events.MessageUpdate, discordMessage(), {
      id: "1300000000000000001",
      channelId: "200",
      guildId: "100",
      embeds: [{ data: { type: "link" }, title: "Cake", url: "https://example.com" }]
    });
    emit(Events.MessageUpdate, discordMessage(), { id: "1300000000000000001", channelId: "200", guildId: "100" }); // nothing usable
    expect(conversation).toHaveLength(2);
    expect(conversation[0]).toMatchObject({ type: "update", message: { content: "hello!", editedAt: "2026-10-24T14:05:00.000Z" } });
    expect(conversation[1]).toMatchObject({ type: "update", messageId: "1300000000000000001", patch: { embeds: [{ title: "Cake" }] } });
    expect((conversation[1] as { message?: unknown }).message).toBeUndefined();
  });

  it("emits deletes and bulk deletes", () => {
    const { conversation, emit } = feed();
    emit(Events.MessageDelete, { id: "5", channelId: "200", guildId: "100" });
    emit(Events.MessageDelete, { id: "6", channelId: "dm", guildId: null });
    emit(Events.MessageBulkDelete, new Map([["7", {}], ["8", {}]]), { id: "200", guildId: "100" });
    expect(conversation).toEqual([
      { type: "delete", conversation: { kind: "guild", guildId: "100", channelId: "200" }, messageId: "5" },
      { type: "deleteBulk", conversation: { kind: "guild", guildId: "100", channelId: "200" }, messageIds: ["7", "8"] }
    ]);
  });
});

describe("gateway feed: reactions never call users.fetch", () => {
  it("builds reaction events from the payload alone", () => {
    const { conversation, emit } = feed();
    const usersFetch = vi.fn();
    const message = { id: "9", channelId: "200", guildId: "100", guild: { members: { cache: { get: (id: string) => (id === "kevin" ? { displayName: "Kev" } : undefined) } } } };
    const reaction = { message, emoji: { id: null, name: "😂", identifier: "%F0%9F%98%82", animated: false }, count: 3, users: { fetch: usersFetch } };
    emit(Events.MessageReactionAdd, reaction, { id: "kevin", username: "kev", globalName: "Kevin" });
    emit(Events.MessageReactionAdd, { ...reaction, emoji: { id: "55", name: "wave", identifier: "wave:55", animated: true }, count: null }, { id: "ghost" /* partial user */ });
    emit(Events.MessageReactionRemove, reaction, { id: "kevin" });
    emit(Events.MessageReactionRemoveEmoji, reaction);
    emit(Events.MessageReactionRemoveAll, message, []);

    expect(usersFetch).not.toHaveBeenCalled();
    expect(conversation.map((event) => (event as { action: string }).action)).toEqual(["add", "add", "remove", "removeEmoji", "removeAll"]);
    expect(conversation[0]).toMatchObject({ emoji: { name: "😂" }, count: 3, userId: "kevin", userName: "Kev" });
    expect(conversation[1]).toMatchObject({ emoji: { id: "55", name: "wave", animated: true }, userId: "ghost" });
    expect((conversation[1] as { userName?: string }).userName).toBeUndefined();
    expect((conversation[1] as { count?: number }).count).toBeUndefined();
  });
});

describe("gateway feed: connection state", () => {
  it("maps shard events to trust transitions", () => {
    const { conversation, emit } = feed();
    emit(Events.ShardReady, 0);
    emit(Events.ShardReconnecting, 0);
    emit(Events.ShardResume, 0, 5);
    emit(Events.ShardDisconnect, { code: 4014 }, 0);
    expect(conversation).toEqual(
      ["ready", "reconnecting", "resumed", "disconnected"].map((state) => ({ type: "connection", scope: "guild", state }))
    );
  });
});

describe("gateway feed: guild directory", () => {
  it("emits role, emoji, channel, thread and member events", () => {
    const { directory, emit } = feed();
    const guild = { id: "100" };
    emit(Events.GuildRoleCreate, { id: "r1", name: "Bakers", color: 5, guild });
    emit(Events.GuildRoleUpdate, { id: "r1", name: "Bakers" }, { id: "r1", name: "Chefs", guild });
    emit(Events.GuildRoleDelete, { id: "r1", guild });
    emit(Events.GuildEmojiCreate, { id: "e1", name: "wave", animated: false, available: true, guild });
    emit(Events.GuildEmojiDelete, { id: "e1", guild });
    emit(Events.GuildEmojiCreate, { id: null, name: null, guild }); // unusable
    emit(Events.ChannelCreate, { id: "c1", name: "general", guildId: "100", parentId: "cat" });
    emit(Events.ChannelDelete, { id: "c1", guildId: "100" });
    emit(Events.ThreadCreate, { id: "t1", name: "Best brownies", guildId: "100", parentId: "c1", isThread: () => true });
    emit(Events.ThreadDelete, { id: "t1", guildId: "100" });
    emit(Events.GuildMemberAdd, { id: "u1", nickname: "Kev", displayName: "Kev", user: { username: "kev", globalName: "Kevin", bot: false }, guild });
    emit(Events.GuildMemberRemove, { id: "u1", guild });
    emit(Events.GuildDelete, { id: "100" });

    expect(directory.map((event) => event.type)).toEqual([
      "roleUpsert", "roleUpsert", "roleDelete", "emojiUpsert", "emojiDelete", "channelUpsert", "channelDelete",
      "channelUpsert", "channelDelete", "memberUpsert", "memberRemove", "guildDelete"
    ]);
    expect(directory[1]).toMatchObject({ role: { id: "r1", name: "Chefs" } });
    expect(directory[7]).toMatchObject({ channel: { id: "t1", kind: "thread", parentId: "c1" } });
    expect(directory[9]).toMatchObject({ member: { userId: "u1", guildDisplayName: "Kev", globalDisplayName: "Kevin", bot: false } });
  });

  it("builds a snapshot from the guild's own caches (GUILD_CREATE), without the @everyone role", () => {
    const mapOf = <T,>(entries: Array<[string, T]>) => new Map(entries);
    const guild = {
      id: "100",
      name: "Bake Club",
      roles: { cache: mapOf([["100", { id: "100", name: "@everyone" }], ["r1", { id: "r1", name: "Bakers", color: 1 }]]) },
      emojis: { cache: mapOf([["e1", { id: "e1", name: "wave", animated: true, available: true, roles: { cache: mapOf([["r1", {}]]) } }]]) },
      channels: { cache: mapOf([["c1", { id: "c1", name: "general", guildId: "100" }], ["t1", { id: "t1", name: "thread", parentId: "c1", isThread: () => true }]]) },
      members: { cache: mapOf([["u1", { id: "u1", nickname: null, displayName: "Kevin", user: { username: "kev", globalName: "Kevin", bot: false } }]]) }
    };
    expect(guildSnapshotEvent(guild as never)).toMatchObject({
      type: "snapshot",
      guildId: "100",
      name: "Bake Club",
      roles: [{ id: "r1", name: "Bakers" }],
      emojis: [{ id: "e1", name: "wave", animated: true, roles: ["r1"] }],
      channels: [{ id: "c1", name: "general", kind: "channel" }, { id: "t1", name: "thread", parentId: "c1", kind: "thread" }],
      members: [{ userId: "u1", guildDisplayName: "Kevin" }]
    });
  });
});

describe("DiscordJsGateway publishes events to its listeners", () => {
  it("publishes our own send before sendWaifuMessage returns, and survives a listener that throws", async () => {
    const gateway = new DiscordJsGateway({ orchestrator: { id: "orch", displayName: "Orch", token: "t", enabled: true }, logger: quietLogger() });
    const events: DiscordConversationEvent[] = [];
    gateway.onConversationEvent(() => {
      throw new Error("listener bug");
    });
    gateway.onConversationEvent((event) => events.push(event));
    (gateway as unknown as { clients: Map<string, unknown> }).clients.set("aria-bot", {
      channels: {
        async fetch() {
          return {
            async send() {
              return {
                id: "1300000000000000099",
                channelId: "200",
                author: { id: "aria-user", username: "aria", bot: true },
                createdTimestamp: Date.parse("2026-10-24T14:00:00.000Z"),
                type: 0,
                content: "hi!"
              };
            }
          };
        }
      }
    });

    const result = await gateway.sendWaifuMessage({ guildId: "100", channelId: "200", content: "hi!", senderBotId: "aria-bot", allowedUserMentionIds: [] });
    expect(result.messageId).toBe("1300000000000000099");
    expect(events).toEqual([
      expect.objectContaining({
        type: "create",
        own: true,
        conversation: { kind: "guild", guildId: "100", channelId: "200" },
        message: expect.objectContaining({ id: "1300000000000000099", authorId: "aria-user", content: "hi!" })
      })
    ]);
  });

  it("returns the send result even when discord.js hands back too little to publish", async () => {
    const gateway = new DiscordJsGateway({ orchestrator: { id: "orch", displayName: "Orch", token: "t", enabled: true }, logger: quietLogger() });
    const events: DiscordConversationEvent[] = [];
    gateway.onConversationEvent((event) => events.push(event));
    (gateway as unknown as { clients: Map<string, unknown> }).clients.set("aria-bot", {
      channels: { fetch: async () => ({ send: async () => ({ id: "sent-1" }) }) }
    });
    await expect(
      gateway.sendWaifuMessage({ guildId: "100", channelId: "200", content: "x", senderBotId: "aria-bot", allowedUserMentionIds: [] })
    ).resolves.toEqual({ messageId: "sent-1" });
    expect(events).toEqual([]);
  });
});
