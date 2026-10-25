// The life's prompt on the wire (Living cast spec §5.4, §5.6, §12): the REAL winter
// anthropic-messages adapter talks to a loopback Anthropic server, so these checks see the exact body
// production sends. Prefix stability, exactly one system prompt, reasoning replayed byte-identically
// across 20 calls, `thinkingBlocksDropped` only on an epoch's first call, and a turn that outgrows
// `life.maxContextTokens` compacted before the next call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeState } from "../src/life/lifeStore.js";
import { enqueueWake } from "../src/life/wakeQueue.js";
import { FakeImageFetcher } from "./contextFixtures.js";
import { CHANNEL, closeWorlds, KEVIN, ROOM, ROOM_KEY, tinyPng, type LifeWorld } from "./lifeFixtures.js";
import type { FakeAnthropic } from "./eval/fakeAnthropic.js";
import { blocksOf, dmWake, isCompaction, isMaintenance, lifeTurn, realAnthropicWorld as wireWorld, roomWake, unmarked } from "./eval/lifeWire.js";
import { modelTokens } from "./eval/tokenModel.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const servers: FakeAnthropic[] = [];
afterEach(async () => {
  await closeWorlds();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const realAnthropicWorld = (o: Parameters<typeof wireWorld>[2] = {}) => wireWorld(roots, servers, o);

describe("the life prompt on the wire", { timeout: 60_000 }, () => {
  it("every request in an epoch is a byte prefix of the next; one system prompt; reasoning replayed byte-identically over 20 calls", async () => {
    const { w, server } = await realAnthropicWorld();
    server.next = lifeTurn(() => "bake-club/#general");
    for (let wake = 0; wake < 7; wake += 1) {
      await roomWake(w, `question ${wake}: brownies or blondies?`);
      w.clock.advance(3 * 60_000);
    }
    const life = server.exchanges.filter((exchange) => !isMaintenance(exchange.body) && !isCompaction(exchange.body));
    expect(life.length).toBeGreaterThanOrEqual(20);
    const state = await readLifeState(w.storage, "aria");
    expect(state.epoch).toBe(1);
    for (const [index, exchange] of life.entries()) {
      const body = exchange.body;
      // One system prompt (blocks A and B), never a role:"system" message; the same tools every time.
      expect(Array.isArray(body.system) && body.system.length).toBe(2);
      expect(body.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
      if (index === 0) continue;
      const before = life[index - 1]!.body;
      expect(JSON.stringify(body.system)).toBe(JSON.stringify(before.system));
      expect(JSON.stringify(body.tools)).toBe(JSON.stringify(before.tools));
      expect(body.messages.length).toBeGreaterThan(before.messages.length);
      for (const [position, message] of before.messages.entries()) {
        expect(unmarked(body.messages[position]!), `request ${index}, message ${position}`).toBe(unmarked(message));
      }
    }
    // Every reply came back exactly as the server sent it: thinking with its signature, in order.
    const last = life[life.length - 1]!.body;
    const replayed = last.messages.filter((message) => message.role === "assistant").flatMap(blocksOf).filter((block) => block.type === "thinking");
    expect(replayed.length).toBe(life.length - 1);
    expect(replayed.every((block) => typeof block.signature === "string" && String(block.signature).startsWith("sig-"))).toBe(true);
    // Nothing dropped inside the epoch.
    const lifeLines = w.ledger.lines.filter((line) => line.purpose === "life");
    expect(lifeLines.length).toBe(life.length);
    expect(lifeLines.every((line) => !line.thinkingBlocksDropped)).toBe(true);
    // Sends really went out; private end-of-turn text never did.
    expect(w.discord.sent.map((sent) => sent.content)).toEqual(Array.from({ length: 7 }, () => "on it!"));
  });

  it("a turn that grows past life.maxContextTokens is compacted before the next call; the new epoch's first call reports its stripped thinking", async () => {
    const { w, server } = await realAnthropicWorld({ config: (config) => ({ ...config, life: { ...config.life, maxContextTokens: 32_000 } }) });
    // Two ordinary turns first: they are the kept window, replayed without their thinking.
    server.next = lifeTurn(() => "bake-club/#general");
    await roomWake(w, "morning!", 0);
    await roomWake(w, "what are we baking?", 0);
    const long = "a very long recipe line with plenty of detail about butter, sugar and cocoa ".repeat(30);
    let reads = 0;
    server.next = (body) => {
      if (isCompaction(body)) return { text: "Earlier: Kevin asked about recipes; I read a lot of them." };
      const last = body.messages[body.messages.length - 1]!;
      const results = blocksOf(last).filter((block) => block.type === "tool_result");
      if (results.length === 0 || reads < 12) {
        reads += 1;
        // Ten long messages a read: each round adds about 6,000 tokens, so the turn climbs toward
        // the 32,000-token budget a step at a time.
        return { thinking: `reading page ${reads}`, toolCalls: [{ name: "ReadMessages", input: { place: "bake-club/#general", limit: 10 } }] };
      }
      return { thinking: "enough", text: "(done reading)" };
    };
    for (let index = 0; index < 60; index += 1) w.discord.post(ROOM, `${long} #${index}`, { authorId: "300000000000000077", authorName: "Mina" });
    await roomWake(w, "find me the best recipe", 0);
    const compactions = server.exchanges.filter((exchange) => isCompaction(exchange.body));
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    const state = await readLifeState(w.storage, "aria");
    expect(state.epoch).toBeGreaterThan(1);
    // The budget on the wire, measured by the provider (the loopback server's own count of the
    // body). The loop sends a request only when its calibrated estimate (characters / 3.5 times the
    // EMA, alpha 0.3, of measured / estimated) is within the budget, so a sent request can exceed
    // it only by the calibration's lag behind the newest content: 10% here, where every round
    // appends the same kind of text. The turn did come close: the request that would have crossed
    // it was never sent (a compaction ran instead).
    const BUDGET = 32_000;
    const lifeRequests = server.exchanges.filter((entry) => !isCompaction(entry.body) && !isMaintenance(entry.body));
    const largest = Math.max(...lifeRequests.map((entry) => entry.usage.total));
    expect(largest).toBeGreaterThan(BUDGET * 0.6);
    expect(largest).toBeLessThanOrEqual(BUDGET * 1.1);
    // The request after the compaction is in the new epoch: its system block B carries the summary.
    const compactionIndex = server.exchanges.indexOf(compactions[0]!);
    const after = server.exchanges[compactionIndex + 1]!.body;
    expect(JSON.stringify(after.system)).toContain("Kevin asked about recipes");
    // On the wire: the kept turns' assistant messages come back without their thinking (it was bound
    // to the old prefix), and the call reports exactly the blocks those messages lost.
    const keptAssistant = after.messages.filter((message) => message.role === "assistant");
    expect(keptAssistant.length).toBeGreaterThan(0);
    expect(keptAssistant.flatMap(blocksOf).filter((block) => block.type === "thinking" || block.type === "redacted_thinking")).toEqual([]);
    const lastOfOldEpoch = server.exchanges.slice(0, compactionIndex).filter((entry) => !isMaintenance(entry.body)).at(-1)!.body;
    const withoutThinking = (message: (typeof after.messages)[number]) =>
      JSON.stringify(blocksOf(message).filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking").map(({ cache_control: _drop, ...block }) => block));
    let dropped = 0;
    for (const kept of keptAssistant) {
      const original = lastOfOldEpoch.messages.find((message) => message.role === "assistant" && withoutThinking(message) === withoutThinking(kept));
      expect(original, "every kept assistant message was on the wire in the old epoch").toBeDefined();
      dropped += blocksOf(original!).filter((block) => block.type === "thinking" || block.type === "redacted_thinking").length;
    }
    expect(dropped).toBeGreaterThan(0);
    const firstOfEpoch = w.ledger.lines.filter((line) => line.purpose === "life")[lifeRequests.indexOf(server.exchanges[compactionIndex + 1]!)];
    expect(firstOfEpoch?.thinkingBlocksDropped).toBe(dropped);
  });

  it("mixed content (CJK, Hangul, code, emoji, URLs, an image) stays within the documented margin of the budget", async () => {
    const BUDGET = 32_000;
    const ENGLISH = [
      "```ts\nconst bake = (minutes: number) => oven.set({ celsius: 180, minutes });\nbake(25);\n```",
      "see https://cdn.example.net/a/very/long/path/to/the/recipe/card/with/many/segments/and-a-query?x=1&y=2&z=3 for the card",
      "melt the butter with the dark chocolate, then fold in the flour and a pinch of salt before baking"
    ];
    const DENSE = [
      "今日は抹茶のブラウニーを焼きました。バターと砂糖をよく混ぜて、卵を一つずつ加えます。焼き時間は二十五分です。",
      "🍫🧁🍰🥐🍪 so good!! 😋😋 https://bake.example/recipes/matcha-brownies?ref=discord&utm_source=chat",
      "오늘 브라우니를 구웠어요. 정말 맛있어요! 다음에는 말차를 넣어 볼게요."
    ];
    /** The largest life request on the wire, over the budget, after she reads every page of `posts` (oldest first). */
    const largestOver = async (posts: string[]): Promise<number> => {
      const { w, server } = await realAnthropicWorld({ config: (config) => ({ ...config, life: { ...config.life, maxContextTokens: BUDGET } }), options: { images: new FakeImageFetcher() } });
      // The provider's count is script-aware here (tests/eval/tokenModel.ts): CJK about 1.2 tokens
      // a character, emoji about 3, an image 1,600 tokens against the estimate's flat 1,000.
      server.sim.tokenizer = (json) => modelTokens(JSON.parse(json) as unknown);
      // Two English turns first: the calibration settles on English before the pages arrive.
      server.next = lifeTurn(() => "bake-club/#general");
      await roomWake(w, "morning!", 0);
      await roomWake(w, "what are we baking?", 0);
      let reads = 0;
      server.next = (body) => {
        if (isMaintenance(body)) return { text: "nothing to tidy" };
        if (isCompaction(body)) return { text: "Earlier: Kevin asked about recipes; I read a lot of them." };
        const results = blocksOf(body.messages[body.messages.length - 1]!).filter((block) => block.type === "tool_result");
        if (results.length === 0 || reads < 14) {
          reads += 1;
          // Each read goes one page further back (before the oldest ref the last page showed).
          const oldest = results.length > 0 ? /#([a-z0-9]+)\]/u.exec(JSON.stringify(results))?.[1] : undefined;
          return { thinking: `reading page ${reads}`, toolCalls: [{ name: "ReadMessages", input: { place: "bake-club/#general", limit: 10, ...(oldest ? { before: `#${oldest}` } : {}) } }] };
        }
        return { thinking: "enough", text: "(done reading)" };
      };
      posts.forEach((text, index) =>
        w.discord.post(ROOM, `${text} #${index}`, {
          authorId: "300000000000000077",
          authorName: "Mina",
          ...(index === 5 ? { attachments: [{ id: "9402", url: `https://cdn.discordapp.com/attachments/${CHANNEL}/9402/matcha.png`, filename: "matcha.png", contentType: "image/png", size: 2048, width: 64, height: 64 }] } : {})
        })
      );
      await roomWake(w, "find me the best recipe", 0);
      const lifeRequests = server.exchanges.filter((entry) => !isCompaction(entry.body) && !isMaintenance(entry.body));
      expect(server.exchanges.some((entry) => isCompaction(entry.body)), "the turn crossed the budget").toBe(true);
      return Math.max(...lifeRequests.map((entry) => entry.usage.total)) / BUDGET;
    };
    // Every page a mix; then the worst case, a change of script near the budget: she reads newest
    // first, so English pages (about 3,800 tokens each) bring the turn up and the dense ones (the
    // oldest, about 13,000 tokens a page) arrive last, while the calibration still says English.
    const mixedThroughout = Array.from({ length: 150 }, (_, index) => [...ENGLISH, ...DENSE][index % 6]!.repeat(10));
    const scriptChange = [...Array.from({ length: 40 }, (_, index) => DENSE[index % 3]!.repeat(30)), ...Array.from({ length: 30 }, (_, index) => ENGLISH[index % 3]!.repeat(14))];
    const [mixedMargin, changeMargin] = [await largestOver(mixedThroughout), await largestOver(scriptChange)];
    // The documented margin (spec §12): measured 0.91 and 0.84 of the budget with the script-aware
    // estimate (characters / 3.5 alone sent 1.02 and 1.29). The bound allows 5% for the per-script
    // error the calibration has not caught up with yet.
    for (const margin of [mixedMargin!, changeMargin!]) {
      expect(margin).toBeGreaterThan(0.6);
      expect(margin).toBeLessThanOrEqual(1.05);
    }
  });

  it("prefix stability holds through an inline image, a folded wake and an interrupted turn", async () => {
    const fetcher = new FakeImageFetcher();
    // ReadMessages saves the picture in her /tmp; she looks at it with Read.
    fetcher.files.set("att:9401", tinyPng(8, 8));
    const { w, server } = await realAnthropicWorld({ options: { images: fetcher } });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    w.discord.post(ROOM, "look at my cake", {
      authorId: KEVIN,
      authorName: "Kevin",
      attachments: [{ id: "9401", url: `https://cdn.discordapp.com/attachments/${CHANNEL}/9401/cake.png`, filename: "cake.png", contentType: "image/png", size: 2048, width: 64, height: 64 }]
    });
    let step = 0;
    let folded: Promise<void> | undefined;
    // The interrupted call is in flight once the server answers it with a hang: abort only then
    // (a fixed number of polls ran out on a loaded machine, so the hang came after the abort).
    let hangStarted!: () => void;
    const hanging = new Promise<void>((resolve) => (hangStarted = resolve));
    server.next = (body) => {
      if (isMaintenance(body)) return { text: "nothing to tidy" };
      step += 1;
      if (step === 1) {
        // Mina pings her while she reads: folded into a later tool-results message.
        folded = enqueueWake(w.storage, "aria", { id: "w-fold", reason: "mention", placeKey: ROOM_KEY, fromUserId: "300000000000000077", fromName: "Mina", messageId: "900000000000000777", preview: "and mine?", at: new Date(w.clock.ms).toISOString() });
        return { thinking: "let me look", toolCalls: [{ name: "ReadMessages", input: { place: "bake-club/#general" } }] };
      }
      if (step === 2) return { thinking: "a cake", toolCalls: [{ name: "Read", input: { file_path: "/tmp/bake-club/general/a0-cake.png" } }] };
      if (step === 3) return { thinking: "answering", toolCalls: [{ name: "SendMessage", input: { place: "bake-club/#general", text: "that cake looks great" } }] };
      // The next call hangs until the owner pauses her.
      if (step === 4) {
        hangStarted();
        return { hang: true };
      }
      return { thinking: "back again", text: "(done)" };
    };
    await enqueueWake(w.storage, "aria", { id: "w-cake", reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: "900000000000000776", preview: "look at my cake", at: new Date(w.clock.ms).toISOString() });
    const running = w.cast.life("aria").runNow();
    await hanging;
    await folded;
    w.cast.life("aria").abort("pause");
    await running;
    // Her wakes went back to the queue: the next turn picks them up in the same epoch.
    await w.cast.life("aria").runNow();
    const life = server.exchanges.filter((exchange) => !isMaintenance(exchange.body) && !isCompaction(exchange.body));
    expect(life.length).toBeGreaterThanOrEqual(5);
    expect((await readLifeState(w.storage, "aria")).epoch).toBe(1);
    const wire = JSON.stringify(life[life.length - 1]!.body.messages);
    expect(wire).toContain('"type":"image"');
    expect(wire).toContain("and mine?");
    expect(wire).toContain("[system] interrupted");
    // Block by block (with each block's role): the interrupted call ended on a user message and
    // the next turn's notifications are joined onto it (adjacent user messages, §5.4), so the
    // earlier request is a prefix of the next at block level, which is what the cache keys on.
    const blockSequence = (body: (typeof life)[number]["body"]) =>
      body.messages.flatMap((message) => blocksOf(message).map(({ cache_control: _drop, ...block }) => JSON.stringify({ role: message.role, ...block })));
    for (let index = 1; index < life.length; index += 1) {
      const before = blockSequence(life[index - 1]!.body);
      const after = blockSequence(life[index]!.body);
      expect(after.length).toBeGreaterThan(before.length);
      for (const [position, block] of before.entries()) expect(after[position], `request ${index}, block ${position}`).toBe(block);
    }
  });

  it("a DM wake on the wire: notification, read, send to the DM", async () => {
    const { w, server } = await realAnthropicWorld();
    server.next = lifeTurn(() => "dm/kevin", { answer: "hey! yes, saturday works" });
    await dmWake(w, "are you free saturday?");
    expect(w.discord.sent).toMatchObject([{ placeKey: `dm_${KEVIN}_aria`, content: "hey! yes, saturday works" }]);
    const first = JSON.stringify(server.exchanges[0]!.body.messages[0]);
    expect(first).toContain("dm · dm/kevin · from Kevin");
  });
});
