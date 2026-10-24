import { describe, expect, it, vi } from "vitest";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { ConversationMessageCache, type CacheDirectoryHooks, type ConversationCacheEvent } from "../src/discord/conversationCache.js";
import type { DiscordConnectionState, DiscordConversationEvent, DiscordConversationEventListener } from "../src/discord/gatewayEvents.js";
import { compareIds, pageMessagesSince } from "../src/discord/rawMessage.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { BASE_TIME, quietLogger, raw } from "./contextFixtures.js";

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const OTHER: ConversationRef = { kind: "guild", guildId: "100", channelId: "300" };

type RestCall = { channelId: string; afterMessageId: string | null; maxMessages: number };

/** A gateway facade with one scripted channel per id, a real REST pager, and an event feed. */
class FakeGateway {
  readonly channels = new Map<string, RawDiscordMessage[]>();
  readonly restCalls: RestCall[] = [];
  readonly usersFetch = vi.fn();
  /** Runs inside every REST call, before the page is returned (to land a reconnect mid-flight). */
  onRest: (() => void) | undefined;
  private listeners = new Set<DiscordConversationEventListener>();
  private counter = 0n;

  nextId(): string {
    this.counter += 1n;
    return (1_400_000_000_000_000_000n + this.counter).toString();
  }

  post(channelId: string, partial: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
    const message = raw({ id: this.nextId(), channelId, createdAt: new Date(BASE_TIME + Number(this.counter) * 1000).toISOString(), ...partial });
    const list = this.channels.get(channelId) ?? [];
    list.push(message);
    this.channels.set(channelId, list);
    return message;
  }

  /** Post and also deliver the gateway create event. */
  live(channelId: string, partial: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
    const message = this.post(channelId, partial);
    this.emit({ type: "create", conversation: { kind: "guild", guildId: "100", channelId }, message });
    return message;
  }

  emit(event: DiscordConversationEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  connection(state: DiscordConnectionState): void {
    this.emit({ type: "connection", scope: "guild", state });
  }

  facade(): DiscordGatewayFacade {
    return {
      onConversationEvent: (listener: DiscordConversationEventListener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      fetchContextSince: async (input: { channelId: string; afterMessageId: string | null; maxMessages: number }) => {
        this.restCalls.push({ channelId: input.channelId, afterMessageId: input.afterMessageId, maxMessages: input.maxMessages });
        const all = [...(this.channels.get(input.channelId) ?? [])];
        const result = await pageMessagesSince(
          async (before) => {
            const older = before === undefined ? all : all.filter((m) => compareIds(m.id, before) < 0);
            return [...older].sort((a, b) => compareIds(b.id, a.id)).slice(0, 100);
          },
          { afterMessageId: input.afterMessageId, maxMessages: input.maxMessages }
        );
        this.onRest?.();
        return result;
      },
      fetchFreshContext: async () => []
    } as unknown as DiscordGatewayFacade;
  }
}

function setup(o: { directory?: CacheDirectoryHooks; now?: () => number; tailCheckAfterMs?: number; maxMessagesPerConversation?: number } = {}) {
  const gateway = new FakeGateway();
  const facade = gateway.facade();
  const cache = new ConversationMessageCache({ discord: () => facade, logger: quietLogger(), ...o });
  cache.attach();
  const events: ConversationCacheEvent[] = [];
  cache.onEvent((event) => events.push(event));
  const read = (afterMessageId: string | null = null, maxMessages = 200, conversation = GUILD) =>
    cache.fetchSince({ conversation, afterMessageId, maxMessages });
  return { gateway, cache, events, read };
}

const ids = (messages: RawDiscordMessage[]) => messages.map((m) => m.id);

describe("ConversationMessageCache trust", () => {
  it("starts untrusted: the first read is one REST sync, trusted reads make no REST calls", async () => {
    const { gateway, cache, read } = setup();
    const posted = [gateway.post("200"), gateway.post("200"), gateway.post("200")];
    expect(cache.isTrusted(GUILD)).toBe(false);

    const first = await read();
    expect(ids(first.messages)).toEqual(ids(posted));
    expect(first.reachedCursor).toBe(true);
    expect(gateway.restCalls).toHaveLength(1);
    expect(cache.isTrusted(GUILD)).toBe(true);

    for (let pass = 0; pass < 5; pass++) {
      expect(ids((await read(posted[0]!.id)).messages)).toEqual(ids(posted.slice(1)));
      expect(ids((await read(posted[2]!.id)).messages)).toEqual([]);
    }
    expect(gateway.restCalls).toHaveLength(1);
  });

  it("applies gateway creates and our own sends without a refetch (responder i+1 sees responder i)", async () => {
    const { gateway, read, events } = setup();
    const first = gateway.post("200");
    await read();

    const human = gateway.live("200", { authorName: "Riko", authorId: "riko" });
    const own = gateway.post("200", { authorId: "aria-bot", authorName: "Aria", authorIsBot: true });
    gateway.emit({ type: "create", own: true, conversation: GUILD, message: own });
    // The orchestrator's own gateway delivers the same message a moment later: no duplicate.
    gateway.emit({ type: "create", conversation: GUILD, message: own });

    expect(ids((await read(first.id)).messages)).toEqual([human.id, own.id]);
    expect(gateway.restCalls).toHaveLength(1);
    expect(events.filter((e) => e.type === "create").map((e) => (e as { own: boolean }).own)).toEqual([false, true]);
  });

  it("a reconnect, an invalidated session or a fresh ready forces one catch-up; a resume keeps trust", async () => {
    const { gateway, cache, read } = setup();
    const first = gateway.post("200");
    await read();
    expect(gateway.restCalls).toHaveLength(1);

    gateway.connection("resumed");
    expect(cache.isTrusted(GUILD)).toBe(true);
    await read(first.id);
    expect(gateway.restCalls).toHaveLength(1);

    for (const state of ["reconnecting", "invalidated", "ready", "disconnected"] as const) {
      const missed = gateway.post("200"); // arrives while the socket is down: no event
      gateway.connection(state);
      expect(cache.isTrusted(GUILD)).toBe(false);
      const before = gateway.restCalls.length;
      const result = await read(first.id);
      expect(gateway.restCalls).toHaveLength(before + 1);
      expect(ids(result.messages)).toContain(missed.id);
      expect(cache.isTrusted(GUILD)).toBe(true);
      // Trusted again: further reads are free.
      await read(first.id);
      expect(gateway.restCalls).toHaveLength(before + 1);
    }
  });

  it("a reconnect that lands during the sync leaves the conversation untrusted", async () => {
    const { gateway, cache, read } = setup();
    const posted = gateway.post("200");
    gateway.onRest = () => gateway.connection("reconnecting");
    // The socket keeps dropping mid-sync: one retry, then the answer comes straight from REST.
    expect(ids((await read()).messages)).toEqual([posted.id]);
    expect(gateway.restCalls).toHaveLength(3);
    expect(cache.isTrusted(GUILD)).toBe(false);

    gateway.onRest = undefined;
    await read();
    expect(cache.isTrusted(GUILD)).toBe(true);
    await read();
    expect(gateway.restCalls).toHaveLength(4);
  });

  it("serves a request below its coverage with exactly one REST page", async () => {
    const { gateway, read } = setup();
    const old = Array.from({ length: 5 }, () => gateway.post("200"));
    await read(old[3]!.id); // buffer now covers only (old[3], now]
    expect(gateway.restCalls).toHaveLength(1);
    const wider = await read(old[0]!.id);
    expect(ids(wider.messages)).toEqual(ids(old.slice(1)));
    expect(gateway.restCalls).toHaveLength(2);
    expect(gateway.restCalls[1]).toMatchObject({ afterMessageId: old[0]!.id });
    await read(old[0]!.id);
    expect(gateway.restCalls).toHaveLength(2);
  });

  it("an epoch-start read (no cursor) is served from memory once the buffer holds that many messages", async () => {
    const { gateway, read } = setup();
    const posted = Array.from({ length: 12 }, () => gateway.post("200"));
    const first = await read(null, 5);
    expect(first).toMatchObject({ reachedCursor: false });
    expect(ids(first.messages)).toEqual(ids(posted.slice(-5)));
    expect(gateway.restCalls).toHaveLength(1);
    const again = await read(null, 5);
    expect(ids(again.messages)).toEqual(ids(posted.slice(-5)));
    expect(again.reachedCursor).toBe(false);
    expect(gateway.restCalls).toHaveLength(1);
    // The whole channel (fewer than the cap) reports that it reached the start.
    const all = await read(null, 50);
    expect(all.reachedCursor).toBe(true);
    expect(ids(all.messages)).toEqual(ids(posted));
  });

  it("shares one REST round between concurrent reads of an untrusted conversation", async () => {
    const { gateway, read } = setup();
    gateway.post("200");
    gateway.post("200");
    const [a, b, c] = await Promise.all([read(), read(), read()]);
    expect(gateway.restCalls).toHaveLength(1);
    expect(ids(b.messages)).toEqual(ids(a.messages));
    expect(ids(c.messages)).toEqual(ids(a.messages));
  });

  it("keeps conversations independent", async () => {
    const { gateway, read } = setup();
    const a = gateway.post("200");
    const b = gateway.post("300");
    expect(ids((await read(null, 200, GUILD)).messages)).toEqual([a.id]);
    expect(ids((await read(null, 200, OTHER)).messages)).toEqual([b.id]);
    expect(gateway.restCalls.map((call) => call.channelId)).toEqual(["200", "300"]);
    gateway.live("300");
    await read(null, 200, GUILD);
    expect(gateway.restCalls).toHaveLength(2);
  });

  it("an aborted caller does not cancel the shared sync", async () => {
    const { gateway, cache, read } = setup();
    gateway.post("200");
    const controller = new AbortController();
    const aborted = cache.fetchSince({ conversation: GUILD, afterMessageId: null, maxMessages: 10, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(aborted).rejects.toThrow("stop");
    await vi.waitFor(() => expect(cache.isTrusted(GUILD)).toBe(true));
    expect(await read()).toMatchObject({ reachedCursor: true });
    expect(gateway.restCalls).toHaveLength(1);
  });

  it("without an event feed every read is a plain REST fetch (the Phase 4 adapter)", async () => {
    const gateway = new FakeGateway();
    const facade = { ...gateway.facade(), onConversationEvent: undefined } as unknown as DiscordGatewayFacade;
    const cache = new ConversationMessageCache({ discord: () => facade, logger: quietLogger() });
    expect(cache.attach()()).toBeUndefined();
    gateway.post("200");
    await cache.fetchSince({ conversation: GUILD, afterMessageId: null, maxMessages: 10 });
    await cache.fetchSince({ conversation: GUILD, afterMessageId: null, maxMessages: 10 });
    expect(gateway.restCalls).toHaveLength(2);
    expect(cache.isTrusted(GUILD)).toBe(false);
  });
});

describe("ConversationMessageCache tail check and catch-up", () => {
  it("re-validates the newest 10 messages after the trust window and repairs drift", async () => {
    const clock = { now: 1_000_000 };
    const { gateway, cache, read, events } = setup({ now: () => clock.now, tailCheckAfterMs: 10 * 60_000 });
    const posted = Array.from({ length: 15 }, () => gateway.post("200"));
    await read();
    expect(gateway.restCalls).toHaveLength(1);

    clock.now += 9 * 60_000;
    await read(posted[14]!.id);
    expect(gateway.restCalls).toHaveLength(1); // still inside the trust window

    // A delete the gateway never told us about.
    gateway.channels.set("200", gateway.channels.get("200")!.filter((m) => m.id !== posted[12]!.id));
    clock.now += 2 * 60_000;
    const result = await read(posted[4]!.id);
    expect(gateway.restCalls).toHaveLength(2);
    expect(gateway.restCalls[1]).toMatchObject({ afterMessageId: null, maxMessages: 10 });
    expect(ids(result.messages)).not.toContain(posted[12]!.id);
    expect(events).toContainEqual(expect.objectContaining({ type: "delete", messageId: posted[12]!.id, source: "catchup" }));

    // Renewed: free again for another 10 minutes.
    await read(posted[4]!.id);
    expect(gateway.restCalls).toHaveLength(2);
    expect(cache.isTrusted(GUILD)).toBe(true);
  });

  it("a matching tail renews trust without emitting anything", async () => {
    const clock = { now: 5_000_000 };
    const { gateway, read, events } = setup({ now: () => clock.now });
    const posted = Array.from({ length: 4 }, () => gateway.post("200"));
    await read();
    clock.now += 11 * 60_000;
    expect(ids((await read(posted[0]!.id)).messages)).toEqual(ids(posted.slice(1)));
    expect(gateway.restCalls).toHaveLength(2);
    expect(events).toEqual([]);
    await read(posted[0]!.id);
    expect(gateway.restCalls).toHaveLength(2);
  });

  it("a catch-up re-fetches from the 10th newest message so downtime edits and deletes surface", async () => {
    const { gateway, read, events } = setup();
    const posted = Array.from({ length: 14 }, () => gateway.post("200"));
    await read();
    const edited = { ...posted[10]!, content: "fixed typo", editedAt: new Date(BASE_TIME + 999_000).toISOString() };
    gateway.channels.set(
      "200",
      gateway.channels.get("200")!.filter((m) => m.id !== posted[12]!.id).map((m) => (m.id === edited.id ? edited : m))
    );
    const missed = gateway.post("200");
    gateway.connection("reconnecting");

    const result = await read(posted[13]!.id);
    expect(gateway.restCalls).toHaveLength(2);
    expect(gateway.restCalls[1]!.afterMessageId).toBe(posted[4]!.id); // 10th newest of 14
    expect(ids(result.messages)).toEqual([missed.id]);
    expect(events).toContainEqual(expect.objectContaining({ type: "update", source: "catchup", message: expect.objectContaining({ id: edited.id, content: "fixed typo" }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "delete", source: "catchup", messageId: posted[12]!.id }));
    expect(events.filter((e) => e.type === "create")).toEqual([]);
  });

  it("bounds the buffer to the newest messages and raises its coverage floor", async () => {
    const { gateway, read } = setup({ maxMessagesPerConversation: 5 });
    const posted = Array.from({ length: 4 }, () => gateway.post("200"));
    await read();
    const live = Array.from({ length: 4 }, () => gateway.live("200"));
    // Everything after the cursor is still there...
    expect(ids((await read(posted[3]!.id)).messages)).toEqual(ids(live));
    expect(gateway.restCalls).toHaveLength(1);
    // ...but a cursor that fell off the buffer needs REST again (and is answered whole).
    expect(ids((await read(posted[0]!.id)).messages)).toEqual([...ids(posted.slice(1)), ...ids(live)]);
    expect(gateway.restCalls).toHaveLength(2);
  });

  it("reports a gap when more than the cap arrived after the cursor", async () => {
    const { gateway, read } = setup();
    const cursor = gateway.post("200");
    const flood = Array.from({ length: 30 }, () => gateway.post("200"));
    const result = await read(cursor.id, 10);
    expect(result.reachedCursor).toBe(false);
    expect(ids(result.messages)).toEqual(ids(flood.slice(-10)));
    // The next pass advances its cursor and is free.
    const next = await read(flood[29]!.id, 10);
    expect(next).toEqual({ messages: [], reachedCursor: true });
    expect(gateway.restCalls).toHaveLength(1);
  });
});

describe("ConversationMessageCache events for edits and deletes (task C hook)", () => {
  it("applies full and partial updates and emits them with the previous version", async () => {
    const { gateway, read, events } = setup();
    const first = gateway.post("200", { content: "hello" });
    await read();

    const editedAt = new Date(BASE_TIME + 500_000).toISOString();
    gateway.emit({ type: "update", conversation: GUILD, messageId: first.id, message: { ...first, content: "hello!", editedAt } });
    gateway.emit({
      type: "update",
      conversation: GUILD,
      messageId: first.id,
      patch: { embeds: [{ type: "link", title: "Cake", url: "https://example.com" }] }
    });

    const result = await read(null, 10);
    expect(result.messages[0]).toMatchObject({ content: "hello!", editedAt, embeds: [{ title: "Cake" }] });
    expect(gateway.restCalls).toHaveLength(1);
    const updates = events.filter((e) => e.type === "update") as Array<Extract<ConversationCacheEvent, { type: "update" }>>;
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ source: "gateway", previous: { content: "hello" }, message: { content: "hello!" } });
    expect(updates[1]!.message.editedAt).toBe(editedAt); // an embed unfurl is not an edit
  });

  it("ignores a partial update for a message it does not hold, but forwards a full one", async () => {
    const { gateway, events } = setup();
    const stranger = gateway.post("200");
    gateway.emit({ type: "update", conversation: GUILD, messageId: stranger.id, patch: { content: "x" } });
    expect(events).toEqual([]);
    gateway.emit({ type: "update", conversation: GUILD, messageId: stranger.id, message: { ...stranger, content: "y" } });
    expect(events).toHaveLength(1);
  });

  it("removes deleted messages from the buffer and emits the event", async () => {
    const { gateway, read, events } = setup();
    const a = gateway.post("200");
    const b = gateway.post("200");
    const c = gateway.post("200");
    await read();
    gateway.emit({ type: "delete", conversation: GUILD, messageId: b.id });
    gateway.emit({ type: "deleteBulk", conversation: GUILD, messageIds: [c.id] });
    expect(ids((await read()).messages)).toEqual([a.id]);
    expect(events).toContainEqual(expect.objectContaining({ type: "delete", messageId: b.id, source: "gateway", previous: expect.objectContaining({ id: b.id }) }));
    expect(events).toContainEqual({ type: "deleteBulk", conversation: GUILD, messageIds: [c.id] });
    expect(gateway.restCalls).toHaveLength(1);
  });
});

describe("ConversationMessageCache reactions (event-fed, never users.fetch)", () => {
  async function reacted() {
    const ctx = setup();
    const own = ctx.gateway.post("200", { authorId: "aria-bot", authorName: "Aria", authorIsBot: true });
    const target = ctx.gateway.post("200", { content: "I made brownies" });
    await ctx.read();
    return { ...ctx, own, target };
  }

  it("keeps count and up to 20 user ids per emoji without any REST", async () => {
    const { gateway, cache, target } = await reacted();
    for (let i = 0; i < 25; i++) {
      gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: target.id, emoji: { name: "😂" }, userId: `u${i}`, userName: `User ${i}` });
    }
    gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: target.id, emoji: { id: "55", name: "wave" }, userId: "u1" });
    const summaries = cache.reactionsFor(GUILD, target.id);
    expect(summaries.find((s) => s.emoji === "😂")).toMatchObject({ count: 25 });
    expect(summaries.find((s) => s.emoji === "😂")!.userIds).toHaveLength(20);
    expect(summaries.find((s) => s.emoji === "55")).toMatchObject({ count: 1, userIds: ["u1"] });
    expect(gateway.usersFetch).not.toHaveBeenCalled();
    expect(gateway.restCalls).toHaveLength(1);

    gateway.emit({ type: "reaction", conversation: GUILD, action: "remove", messageId: target.id, emoji: { id: "55", name: "wave" }, userId: "u1" });
    expect(cache.reactionsFor(GUILD, target.id).find((s) => s.emoji === "55")).toBeUndefined();
    gateway.emit({ type: "reaction", conversation: GUILD, action: "removeEmoji", messageId: target.id, emoji: { name: "😂" } });
    expect(cache.reactionsFor(GUILD, target.id)).toEqual([]);
  });

  it("renders 'Kevin reacted 😂 to #k3' lines for reactions since the agent's last message", async () => {
    const { gateway, cache, own, target } = await reacted();
    const refs = new Map([[own.id, "k2"], [target.id, "k3"]]);
    gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: target.id, emoji: { name: "😂" }, userId: "kevin", userName: "Kevin" });
    gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: own.id, emoji: { id: "7", name: "heart" }, userId: "riko" });
    gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: "999", emoji: { name: "👍" }, userId: "x", userName: "X" }); // not rendered: no ref

    expect(cache.recentReactions(GUILD, { sinceMs: 0, refs })).toEqual([
      "Kevin reacted 😂 to #k3",
      "Someone reacted :heart: to #k2"
    ]);
    expect(cache.recentReactions(GUILD, { sinceMs: Date.now() + 60_000, refs })).toEqual([]);
    // A reaction that was taken back disappears from the tail.
    gateway.emit({ type: "reaction", conversation: GUILD, action: "remove", messageId: target.id, emoji: { name: "😂" }, userId: "kevin" });
    expect(cache.recentReactions(GUILD, { sinceMs: 0, refs })).toEqual(["Someone reacted :heart: to #k2"]);
    // Reactions on a deleted message are dropped with it.
    gateway.emit({ type: "delete", conversation: GUILD, messageId: own.id });
    expect(cache.recentReactions(GUILD, { sinceMs: 0, refs })).toEqual([]);
  });

  it("keeps at most the newest 8 lines and resolves names and custom emoji through the directory", async () => {
    const directory: CacheDirectoryHooks = {
      observeMessages: () => undefined,
      resolveMentions: async () => undefined,
      memberName: (_guild, userId) => (userId === "riko" ? "Riko" : undefined),
      emojiName: (_guild, id) => (id === "7" ? "heart_eyes" : undefined)
    };
    const { gateway, cache, target } = await (async () => {
      const ctx = setup({ directory });
      const target = ctx.gateway.post("200");
      await ctx.read();
      return { ...ctx, target };
    })();
    for (let i = 0; i < 12; i++) {
      gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: target.id, emoji: { name: `e${i}` }, userId: "riko" });
    }
    gateway.emit({ type: "reaction", conversation: GUILD, action: "add", messageId: target.id, emoji: { id: "7", name: "old_name" }, userId: "riko" });
    const lines = cache.recentReactions(GUILD, { sinceMs: 0, refs: new Map([[target.id, "a1"]]) });
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toBe("Riko reacted :heart_eyes: to #a1");
  });
});

describe("ConversationMessageCache directory hooks and DMs", () => {
  it("lets the directory learn from every ingested message and resolve mentions before returning", async () => {
    const calls: string[] = [];
    const directory: CacheDirectoryHooks = {
      observeMessages: (guildId, messages) => void calls.push(`observe:${guildId}:${messages.length}`),
      resolveMentions: async (guildId, messages) => void calls.push(`resolve:${guildId}:${messages.length}`),
      memberName: () => undefined,
      emojiName: () => undefined
    };
    const { gateway, read } = setup({ directory });
    const posted = [gateway.post("200"), gateway.post("200")];
    await read();
    gateway.live("200");
    await read(posted[1]!.id);
    expect(calls).toEqual(["observe:100:2", "resolve:100:2", "observe:100:1", "resolve:100:1"]);
  });

  it("a failing mention resolution never fails the read", async () => {
    const directory: CacheDirectoryHooks = {
      observeMessages: () => undefined,
      resolveMentions: async () => {
        throw new Error("boom");
      },
      memberName: () => undefined,
      emojiName: () => undefined
    };
    const { gateway, read } = setup({ directory });
    gateway.post("200");
    expect((await read()).messages).toHaveLength(1);
  });

  it("reads DMs through fetchDmContextSince and answers empty while the transport is missing", async () => {
    const gateway = new FakeGateway();
    const dmCalls: unknown[] = [];
    const message = raw({ id: gateway.nextId(), channelId: "dm1", guildId: undefined, authorId: "kevin" });
    const facade = {
      ...gateway.facade(),
      fetchDmContextSince: async (input: unknown) => {
        dmCalls.push(input);
        return { messages: [message], reachedCursor: true };
      }
    } as unknown as DiscordGatewayFacade;
    const cache = new ConversationMessageCache({ discord: () => facade, logger: quietLogger() });
    const dm: ConversationRef = { kind: "dm", waifuId: "aria", userId: "5" };
    const out = await cache.fetchSince({ conversation: dm, afterMessageId: null, maxMessages: 10 });
    expect(out.messages).toEqual([message]);
    expect(dmCalls).toEqual([{ waifuId: "aria", userId: "5", afterMessageId: null, maxMessages: 10 }]);

    const bare = new ConversationMessageCache({ discord: () => gateway.facade(), logger: quietLogger() });
    expect(await bare.fetchSince({ conversation: dm, afterMessageId: null, maxMessages: 10 })).toEqual({ messages: [], reachedCursor: true });
  });

  it("forget() drops a conversation so the next read syncs again", async () => {
    const { gateway, cache, read } = setup();
    gateway.post("200");
    await read();
    cache.forget(GUILD);
    expect(cache.isTrusted(GUILD)).toBe(false);
    await read();
    expect(gateway.restCalls).toHaveLength(2);
  });
});
