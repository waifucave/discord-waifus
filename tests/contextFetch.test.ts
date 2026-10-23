import { afterEach, describe, expect, it } from "vitest";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { loadGuildDirectoryView } from "../src/discord/directoryView.js";
import { pageMessagesSince, toRawDiscordMessage, withoutAuthors, type DiscordMessageLike } from "../src/discord/rawMessage.js";
import { DiscordConversationSource, filterSinceCursor } from "../src/orchestration/context/fetchTranscript.js";
import type { ContextMessage } from "../src/orchestration/contextMessages.js";
import { RawDiscordMessageSchema } from "../src/shared/schemas/discordMessage.js";
import { StorageService } from "../src/storage/storageService.js";
import { raw } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const map = <T>(entries: Array<[string, T]>) => new Map(entries);

describe("toRawDiscordMessage", () => {
  it("maps a discord.js message to one raw record", () => {
    const message: DiscordMessageLike = {
      id: "1300000000000000123",
      channelId: "200",
      guildId: "100",
      author: { id: "111", username: "kev", globalName: "Kevin G", bot: false },
      member: { displayName: "Kevin" },
      createdTimestamp: Date.parse("2026-10-24T14:02:00.000Z"),
      editedTimestamp: Date.parse("2026-10-24T14:03:00.000Z"),
      type: 19,
      content: "hi <@222>",
      flags: { bitfield: 1 << 13 },
      attachments: map([["9", { id: "9", url: "https://cdn.discordapp.com/attachments/200/9/v.ogg", name: "voice-message.ogg", contentType: "audio/ogg", size: 3000, duration: 12.5 }]]),
      embeds: [{ data: { type: "link" }, title: "T", description: "D", url: "https://x.example", provider: { name: "X" }, thumbnail: { url: "https://x.example/t.png" } }],
      stickers: map([["s", { name: "Wave" }]]),
      poll: { question: { text: "Q?" }, answers: map([["1", { text: "A" }], ["2", { text: "B" }]]) },
      messageSnapshots: map([["f", { content: "fwd", attachments: map([]) }]]),
      reference: { messageId: "1300000000000000100", type: 0 },
      interaction: null,
      mentions: {
        users: map([["222", { username: "riko", globalName: null }]]),
        members: { get: (id: string) => (id === "222" ? { displayName: "Riko" } : undefined) },
        roles: map([["555", { name: "Bakers" }]]),
        channels: map([["900", { name: "recipes" }]])
      }
    };
    const out = toRawDiscordMessage(message, "fallback");
    expect(RawDiscordMessageSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      id: "1300000000000000123",
      guildId: "100",
      authorId: "111",
      authorName: "Kevin",
      authorIsBot: false,
      createdAt: "2026-10-24T14:02:00.000Z",
      editedAt: "2026-10-24T14:03:00.000Z",
      type: 19,
      attachments: [{ id: "9", filename: "voice-message.ogg", size: 3000, durationSecs: 12.5, isVoice: true }],
      embeds: [{ type: "link", title: "T", description: "D", url: "https://x.example", providerName: "X", thumbnailUrl: "https://x.example/t.png" }],
      stickers: [{ name: "Wave" }],
      poll: { question: "Q?", answers: ["A", "B"] },
      snapshots: [{ content: "fwd", attachments: [] }],
      referenceMessageId: "1300000000000000100",
      mentions: { users: { "222": "Riko" }, roles: { "555": "Bakers" }, channels: { "900": "recipes" } }
    });
  });

  it("drops forward references, maps poll results and command names", () => {
    const base = {
      channelId: "200",
      author: { id: "b", username: "bot", bot: true },
      createdTimestamp: 0,
      content: ""
    };
    const forward = toRawDiscordMessage({ ...base, id: "1", type: 0, reference: { messageId: "9", type: 1 } }, "100");
    expect(forward.referenceMessageId).toBeUndefined();
    expect(forward.guildId).toBe("100");
    const result = toRawDiscordMessage({
      ...base,
      id: "2",
      type: 46,
      embeds: [{ data: { type: "poll_result", fields: [{ name: "poll_question_text", value: "Q?" }, { name: "victor_answer_text", value: "B" }] } }]
    });
    expect(result.poll).toEqual({ question: "Q?", answers: ["B"] });
    expect(result.embeds).toEqual([]);
    expect(toRawDiscordMessage({ ...base, id: "3", type: 20, interaction: { commandName: "roll" } }).commandName).toBe("roll");
  });
});

describe("pageMessagesSince", () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(1000 + i)); // oldest → newest
  const pager = (calls: Array<string | undefined>) => async (before: string | undefined) => {
    calls.push(before);
    const end = before ? ids.indexOf(before) : ids.length;
    return ids.slice(Math.max(0, end - 100), end).reverse().map((id) => ({ id }));
  };

  it("pages before in batches of 100 until the cursor", async () => {
    const calls: Array<string | undefined> = [];
    const out = await pageMessagesSince(pager(calls), { afterMessageId: "1100", maxMessages: 500 });
    expect(out.messages.map((m) => m.id)).toEqual(ids.slice(101));
    expect(out.reachedCursor).toBe(true);
    expect(calls).toEqual([undefined, "1150"]);
  });

  it("stops at the cap and reports reachedCursor false (true when the cursor is the next one)", async () => {
    const capped = await pageMessagesSince(pager([]), { afterMessageId: "1000", maxMessages: 120 });
    expect(capped.messages).toHaveLength(120);
    expect(capped.messages[0]!.id).toBe("1130");
    expect(capped.reachedCursor).toBe(false);
    const exact = await pageMessagesSince(pager([]), { afterMessageId: "1229", maxMessages: 20 });
    expect(exact.messages.map((m) => m.id)).toEqual(ids.slice(230));
    expect(exact.reachedCursor).toBe(true);
  });

  it("treats the beginning of the channel as reached", async () => {
    const out = await pageMessagesSince(pager([]), { afterMessageId: null, maxMessages: 1000 });
    expect(out.messages).toHaveLength(250);
    expect(out.reachedCursor).toBe(true);
  });
});

describe("DiscordConversationSource", () => {
  const contextMessage = (id: string): ContextMessage => ({
    id,
    channelId: "200",
    guildId: "100",
    authorKind: "user",
    authorId: "111",
    name: "kev",
    displayName: "Kevin",
    content: `m${id}`,
    timestamp: "2026-10-24T14:00:00.000Z",
    reactions: [],
    images: [{ url: `https://cdn.discordapp.com/attachments/200/${id}9/a.png?ex=1`, contentType: "image/png" }]
  });

  it("prefers fetchContextSince", async () => {
    const seen: unknown[] = [];
    const facade = {
      fetchContextSince: async (i: unknown) => (seen.push(i), { messages: [raw({ id: "5" })], reachedCursor: true }),
      fetchFreshContext: async () => {
        throw new Error("not used");
      }
    } as unknown as DiscordGatewayFacade;
    const source = new DiscordConversationSource(() => facade);
    const out = await source.fetchSince({ conversation: { kind: "guild", guildId: "100", channelId: "200" }, afterMessageId: "4", maxMessages: 10 });
    expect(out.messages.map((m) => m.id)).toEqual(["5"]);
    expect(seen).toEqual([{ guildId: "100", channelId: "200", afterMessageId: "4", maxMessages: 10, signal: undefined }]);
  });

  it("falls back to fetchFreshContext + cursor filter for fakes", async () => {
    const facade = {
      fetchFreshContext: async ({ limit }: { limit: number }) => ["11", "12", "13", "14"].slice(-limit).map(contextMessage)
    } as unknown as DiscordGatewayFacade;
    const source = new DiscordConversationSource(() => facade);
    const guild = { kind: "guild", guildId: "100", channelId: "200" } as const;
    const out = await source.fetchSince({ conversation: guild, afterMessageId: "12", maxMessages: 10 });
    expect(out.messages.map((m) => m.id)).toEqual(["13", "14"]);
    expect(out.reachedCursor).toBe(true);
    expect(out.messages[0]!.attachments[0]).toMatchObject({ id: "139", filename: "a.png" });
    const dm = await source.fetchSince({ conversation: { kind: "dm", waifuId: "aria", userId: "5" }, afterMessageId: null, maxMessages: 10 });
    expect(dm).toEqual({ messages: [], reachedCursor: true });
  });

  it("filterSinceCursor reports a missed cursor", () => {
    const messages = ["20", "21", "22"].map((id) => raw({ id }));
    expect(filterSinceCursor(messages, "10", 10, true).reachedCursor).toBe(false);
    expect(filterSinceCursor(messages, "20", 10, true)).toMatchObject({ reachedCursor: true });
    expect(filterSinceCursor(messages, "10", 2, false).messages.map((m) => m.id)).toEqual(["21", "22"]);
  });
});

describe("loadGuildDirectoryView", () => {
  it("reads members/roles/emojis caches and tolerates missing files", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const storage = new StorageService(root);
    const empty = await loadGuildDirectoryView(storage, "100");
    expect(empty.memberName("1")).toBeUndefined();
    await storage.writeJson("m", "user/servers/100/members.json", (await import("../src/shared/schemas/domain.js")).GuildMembersFileSchema, {
      schemaVersion: 2,
      revision: 1,
      updatedAt: "2026-10-24T00:00:00.000Z",
      guildId: "100",
      members: [{ userId: "1", username: "kev", guildDisplayName: "Kevin", bot: false, perChannelLastSeenAt: {} }]
    });
    const view = await loadGuildDirectoryView(storage, "100", { channelName: (id) => (id === "9" ? "general" : undefined) });
    expect(view.memberName("1")).toBe("Kevin");
    expect(view.channelName("9")).toBe("general");
    expect(view.roleName("x")).toBeUndefined();
  });
});

describe("withoutAuthors (orchestrator posts never reach the ledger)", () => {
  it("drops messages by the orchestrator bot (user or application id) and keeps the rest", () => {
    const messages = [
      { id: "1", author: { id: "kevin" } },
      { id: "2", author: { id: "orch-bot" } },
      { id: "3", author: { id: "aria-bot" } },
      { id: "4", author: { id: "orch-app" } }
    ];
    expect(withoutAuthors(messages, ["orch-bot", "orch-app", undefined]).map((m) => m.id)).toEqual(["1", "3"]);
    expect(withoutAuthors(messages, [undefined, null])).toBe(messages);
  });
});
