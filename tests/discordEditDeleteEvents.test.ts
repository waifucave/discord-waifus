import { ChannelType, Client, Events } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordJsGateway, threadInfoOf } from "../src/discord/client.js";
import type {
  DiscordJsGatewayOptions,
  DiscordMessageDeleteEvent,
  DiscordMessageEditEvent,
  DiscordMessageEvent,
  DiscordThreadEvent
} from "../src/discord/client.js";
import { quietLogger } from "./contextFixtures.js";

const GUILD = "123456789012345678";
const PARENT = "223456789012345678";
const THREAD = "323456789012345678";

const gateways: DiscordJsGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.disconnect()));
});

async function connected(): Promise<{ gateway: DiscordJsGateway; client: Client }> {
  let created: Client | undefined;
  const createClient: NonNullable<DiscordJsGatewayOptions["createClient"]> = ({ options }) => {
    const client = new Client(options);
    created = client;
    (client as unknown as { login: (t?: string) => Promise<string> }).login = async (token = "") => {
      queueMicrotask(() => client.emit(Events.ClientReady, client as Client<true>));
      return token;
    };
    return client;
  };
  const gateway = new DiscordJsGateway({
    orchestrator: { id: "orchestrator", displayName: "o", token: "t", enabled: true },
    waifus: [],
    createClient,
    logger: quietLogger()
  });
  gateways.push(gateway);
  await gateway.connect();
  return { gateway, client: created! };
}

function fakeThread(o: { archived?: boolean; locked?: boolean; parentType?: number; type?: number; name?: string } = {}) {
  return {
    id: THREAD,
    guildId: GUILD,
    parentId: PARENT,
    parent: { type: o.parentType ?? ChannelType.GuildText },
    type: o.type ?? ChannelType.PublicThread,
    name: o.name ?? "Best brownies",
    archived: o.archived ?? false,
    locked: o.locked ?? false,
    isThread: () => true
  };
}

function fakeMessage(o: Record<string, unknown> = {}) {
  const channel = (o["channel"] as unknown) ?? { isThread: () => false };
  return {
    id: "900000000000000001",
    guildId: GUILD,
    channelId: PARENT,
    channel,
    partial: false,
    author: { id: "42", bot: false, username: "kevin", globalName: "Kevin" },
    member: null,
    createdTimestamp: Date.parse("2026-10-24T10:00:00.000Z"),
    editedTimestamp: null,
    type: 0,
    content: "hello",
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    messageSnapshots: new Map(),
    mentions: { users: new Map(), roles: new Map(), channels: new Map(), members: new Map() },
    ...o
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("threadInfoOf", () => {
  it("is undefined for non-threads and maps thread kinds", () => {
    expect(threadInfoOf({ isThread: () => false })).toBeUndefined();
    expect(threadInfoOf(undefined)).toBeUndefined();
    expect(threadInfoOf(fakeThread())).toEqual({ parentId: PARENT, name: "Best brownies", kind: "public_thread", archived: false, locked: false });
    expect(threadInfoOf(fakeThread({ type: ChannelType.PrivateThread }))?.kind).toBe("private_thread");
    expect(threadInfoOf(fakeThread({ type: ChannelType.AnnouncementThread }))?.kind).toBe("announcement_thread");
    expect(threadInfoOf(fakeThread({ parentType: ChannelType.GuildForum }))?.kind).toBe("forum_post");
    expect(threadInfoOf(fakeThread({ parentType: ChannelType.GuildMedia }))?.kind).toBe("forum_post");
    expect(threadInfoOf(fakeThread({ archived: true, locked: true }))).toMatchObject({ archived: true, locked: true });
  });
});

describe("DiscordJsGateway edit, delete and thread events (spec 9.5)", () => {
  it("emits an edit only when Discord reports a new editedTimestamp, with the previous mentions", async () => {
    const { gateway, client } = await connected();
    const edits: DiscordMessageEditEvent[] = [];
    gateway.onMessageEdit((event) => void edits.push(event));
    const oldMessage = fakeMessage({ mentions: { users: new Map([["77", { id: "77" }]]), roles: new Map(), channels: new Map(), members: new Map() } });

    // An embed unfurl: no editedTimestamp, not an edit.
    client.emit(Events.MessageUpdate, oldMessage as never, fakeMessage() as never);
    await flush();
    expect(edits).toEqual([]);

    const edited = fakeMessage({
      content: "hello <@88>",
      editedTimestamp: Date.parse("2026-10-24T10:01:00.000Z"),
      mentions: { users: new Map([["88", { id: "88", username: "aria", globalName: "Aria" }]]), roles: new Map(), channels: new Map(), members: new Map() }
    });
    client.emit(Events.MessageUpdate, oldMessage as never, edited as never);
    await flush();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      guildId: GUILD,
      channelId: PARENT,
      messageId: "900000000000000001",
      authorId: "42",
      authorBot: false,
      previousMentionIds: ["77"],
      message: { content: "hello <@88>", editedAt: "2026-10-24T10:01:00.000Z" }
    });
    expect(edits[0]!.thread).toBeUndefined();
  });

  it("fetches a partial updated message and skips DMs", async () => {
    const { gateway, client } = await connected();
    const edits: DiscordMessageEditEvent[] = [];
    gateway.onMessageEdit((event) => void edits.push(event));
    const full = fakeMessage({ editedTimestamp: Date.parse("2026-10-24T10:01:00.000Z"), content: "fetched" });
    const partial = { ...fakeMessage(), partial: true, fetch: async () => full };
    client.emit(Events.MessageUpdate, { partial: true, guildId: GUILD } as never, partial as never);
    await flush();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.message.content).toBe("fetched");
    expect(edits[0]!.previousMentionIds).toBeUndefined();

    client.emit(Events.MessageUpdate, { partial: true, guildId: null } as never, { ...full, guildId: null } as never);
    await flush();
    expect(edits).toHaveLength(1);
  });

  it("carries thread info on edits and message creates inside a thread", async () => {
    const { gateway, client } = await connected();
    const edits: DiscordMessageEditEvent[] = [];
    const messages: DiscordMessageEvent[] = [];
    gateway.onMessageEdit((event) => void edits.push(event));
    gateway.onMessage((event) => void messages.push(event));
    const channel = fakeThread({ parentType: ChannelType.GuildForum });
    client.emit(Events.MessageCreate, fakeMessage({ channel, channelId: THREAD }) as never);
    client.emit(
      Events.MessageUpdate,
      fakeMessage({ channel, channelId: THREAD }) as never,
      fakeMessage({ channel, channelId: THREAD, editedTimestamp: Date.parse("2026-10-24T10:01:00.000Z") }) as never
    );
    await flush();
    expect(messages[0]!.thread).toMatchObject({ parentId: PARENT, kind: "forum_post" });
    expect(edits[0]!.thread).toMatchObject({ parentId: PARENT, kind: "forum_post", archived: false });
  });

  it("emits single and bulk deletes with message ids", async () => {
    const { gateway, client } = await connected();
    const deletes: DiscordMessageDeleteEvent[] = [];
    gateway.onMessageDelete((event) => void deletes.push(event));
    client.emit(Events.MessageDelete, fakeMessage() as never);
    client.emit(Events.MessageDelete, { ...fakeMessage(), guildId: null } as never);
    client.emit(
      Events.MessageBulkDelete,
      new Map([["1", {}], ["2", {}]]) as never,
      { id: PARENT, guildId: GUILD, isThread: () => false } as never
    );
    await flush();
    expect(deletes).toEqual([
      { guildId: GUILD, channelId: PARENT, messageIds: ["900000000000000001"], bulk: false },
      { guildId: GUILD, channelId: PARENT, messageIds: ["1", "2"], bulk: true }
    ]);
  });

  it("emits thread create, update (with the previous state) and delete", async () => {
    const { gateway, client } = await connected();
    const events: DiscordThreadEvent[] = [];
    gateway.onThreadChange((event) => void events.push(event));
    client.emit(Events.ThreadCreate, fakeThread() as never, true);
    client.emit(Events.ThreadUpdate, fakeThread({ archived: false }) as never, fakeThread({ archived: true }) as never);
    client.emit(Events.ThreadDelete, fakeThread() as never);
    await flush();
    expect(events.map((e) => e.change)).toEqual(["create", "update", "delete"]);
    expect(events[1]).toMatchObject({
      guildId: GUILD,
      threadId: THREAD,
      thread: { archived: true, parentId: PARENT },
      previous: { archived: false, locked: false, name: "Best brownies" }
    });
  });

  it("unsubscribes listeners", async () => {
    const { gateway, client } = await connected();
    const deletes: DiscordMessageDeleteEvent[] = [];
    const off = gateway.onMessageDelete((event) => void deletes.push(event));
    off();
    client.emit(Events.MessageDelete, fakeMessage() as never);
    await flush();
    expect(deletes).toEqual([]);
  });
});
