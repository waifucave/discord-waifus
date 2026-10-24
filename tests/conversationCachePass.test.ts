// Spec 9.8 acceptance 6: a pass with two responders makes at most 1 Discord message fetch and 0
// reaction-user fetches when the conversation cache is trusted. Exercised through the real
// ContextRuntime (orchestrator decision + two responder turns), not the cache alone.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMessageCache } from "../src/discord/conversationCache.js";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import type { DiscordConversationEvent, DiscordConversationEventListener } from "../src/discord/gatewayEvents.js";
import { compareIds, pageMessagesSince } from "../src/discord/rawMessage.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { NoopCompaction } from "../src/orchestration/context/types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeImageFetcher, fakeModel, fakeRoleRenderer, noSnapshots, quietLogger, raw } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };

async function pass() {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 3_600_000 };
  const storage = new StorageService(root);
  const store = new FileContextStore(storage, { now: () => new Date(clock.now), timeZone: () => "UTC" });

  const channel: RawDiscordMessage[] = [];
  const listeners = new Set<DiscordConversationEventListener>();
  const emit = (event: DiscordConversationEvent) => listeners.forEach((listener) => listener(event));
  const restFetches: Array<{ afterMessageId: string | null; maxMessages: number }> = [];
  const usersFetch = vi.fn();
  let counter = 0;
  const post = (partial: Partial<RawDiscordMessage>, live = true) => {
    counter += 1;
    const message = raw({ id: (1_500_000_000_000_000_000n + BigInt(counter)).toString(), createdAt: new Date(BASE_TIME + counter * 1000).toISOString(), ...partial });
    channel.push(message);
    if (live) emit({ type: "create", conversation: GUILD, message });
    return message;
  };

  const facade = {
    onConversationEvent: (listener: DiscordConversationEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetchContextSince: async (input: { afterMessageId: string | null; maxMessages: number }) => {
      restFetches.push({ afterMessageId: input.afterMessageId, maxMessages: input.maxMessages });
      return pageMessagesSince(
        async (before) =>
          [...channel]
            .filter((m) => before === undefined || compareIds(m.id, before) < 0)
            .sort((a, b) => compareIds(b.id, a.id))
            .slice(0, 100),
        { afterMessageId: input.afterMessageId, maxMessages: input.maxMessages }
      );
    },
    fetchFreshContext: async () => []
  } as unknown as DiscordGatewayFacade;

  const cache = new ConversationMessageCache({ discord: () => facade, logger: quietLogger() });
  cache.attach();
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction: NoopCompaction,
    messages: cache,
    images: new FakeImageFetcher(),
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
    logger: quietLogger(),
    now: () => new Date(clock.now),
    timeZone: () => "UTC"
  });
  const prepare = (agent: { kind: "orchestrator" } | { kind: "waifu"; waifuId: string }, name = "Aria") =>
    runtime.prepare({
      conversation: GUILD,
      agent,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: ["aria-bot", "riko-bot"],
      render: fakeRoleRenderer(name)
    });
  return { post, emit, restFetches, usersFetch, cache, prepare, clock };
}

describe("acceptance 6: a trusted pass with two responders", () => {
  it("makes at most 1 message fetch, 0 reaction-user fetches, and the second responder sees the first", async () => {
    const t = await pass();
    t.post({ content: "who wants cake?" });
    t.post({ authorId: "riko", authorName: "Riko", content: "me!" });

    // Boot is untrusted: the first read of the conversation is the one REST fetch.
    expect(t.cache.isTrusted(GUILD)).toBe(false);
    await t.prepare({ kind: "orchestrator" }, "Orchestrator");
    expect(t.restFetches).toHaveLength(1);
    expect(t.cache.isTrusted(GUILD)).toBe(true);

    // A pass: new human message, orchestrator decision, responder 1 prepares and sends, responder 2 prepares.
    t.post({ authorId: "kevin", authorName: "Kevin", content: "and tea please" });
    const before = t.restFetches.length;
    const decision = await t.prepare({ kind: "orchestrator" }, "Orchestrator");
    const first = await t.prepare({ kind: "waifu", waifuId: "aria" }, "Aria");
    const sent = t.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "Coming right up!" }, false);
    t.emit({ type: "create", own: true, conversation: GUILD, message: sent });
    const second = await t.prepare({ kind: "waifu", waifuId: "riko" }, "Riko");

    expect(t.restFetches.length - before).toBe(0); // trusted: not even the one allowed fetch
    expect(t.restFetches.length).toBeLessThanOrEqual(1);
    expect(t.usersFetch).not.toHaveBeenCalled();
    expect(decision.transcript.map((e) => e.body)).toContain("and tea please");
    expect(first.transcript.map((e) => e.body)).not.toContain("Coming right up!");
    expect(second.transcript.map((e) => e.body)).toContain("Coming right up!");
  });

  it("a reconnect costs exactly one catch-up fetch for the whole pass, shared by every agent", async () => {
    const t = await pass();
    t.post({ content: "hello" });
    await t.prepare({ kind: "orchestrator" }, "Orchestrator");
    expect(t.restFetches).toHaveLength(1);

    t.emit({ type: "connection", scope: "guild", state: "reconnecting" });
    t.emit({ type: "connection", scope: "guild", state: "resumed" });
    t.post({ content: "missed while down" }, false); // never delivered over the gateway

    const before = t.restFetches.length;
    const decision = await t.prepare({ kind: "orchestrator" }, "Orchestrator");
    await t.prepare({ kind: "waifu", waifuId: "aria" }, "Aria");
    await t.prepare({ kind: "waifu", waifuId: "riko" }, "Riko");
    expect(t.restFetches.length - before).toBe(1);
    expect(decision.transcript.map((e) => e.body)).toContain("missed while down");
    expect(t.usersFetch).not.toHaveBeenCalled();
  });
});
