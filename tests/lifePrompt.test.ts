// The life's prompt on the wire (Living cast spec §5.4, §5.6, §12): the REAL winter
// anthropic-messages adapter talks to a loopback Anthropic server, so these checks see the exact body
// production sends. Prefix stability, exactly one system prompt, reasoning replayed byte-identically
// across 20 calls, `thinkingBlocksDropped` only on an epoch's first call, and a turn that outgrows
// `life.maxContextTokens` compacted before the next call.
import { afterEach, describe, expect, it } from "vitest";
import { readLifeState } from "../src/life/lifeStore.js";
import { closeWorlds, KEVIN, ROOM, type LifeWorld } from "./lifeFixtures.js";
import type { FakeAnthropic } from "./eval/fakeAnthropic.js";
import { blocksOf, dmWake, isCompaction, isMaintenance, lifeTurn, realAnthropicWorld as wireWorld, roomWake, unmarked } from "./eval/lifeWire.js";
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
        return { thinking: `reading page ${reads}`, toolCalls: [{ name: "read_messages", input: { place: "bake-club/#general", limit: 50 } }] };
      }
      return { thinking: "enough", text: "(done reading)" };
    };
    for (let index = 0; index < 60; index += 1) w.discord.post(ROOM, `${long} #${index}`, { authorId: "300000000000000077", authorName: "Mina" });
    await roomWake(w, "find me the best recipe", 0);
    const compactions = server.exchanges.filter((exchange) => isCompaction(exchange.body));
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    const state = await readLifeState(w.storage, "aria");
    expect(state.epoch).toBeGreaterThan(1);
    // Every life request stayed within the budget (the app's own estimate, ~4 characters a token).
    for (const exchange of server.exchanges.filter((entry) => !isCompaction(entry.body))) {
      expect(JSON.stringify(exchange.body).length / 4).toBeLessThan(32_000 * 1.25);
    }
    // The request after the compaction is in the new epoch: its system block B carries the summary.
    const after = server.exchanges[server.exchanges.indexOf(compactions[0]!) + 1]!.body;
    expect(JSON.stringify(after.system)).toContain("Kevin asked about recipes");
    const firstOfEpoch = w.ledger.lines.filter((line) => line.purpose === "life")[server.exchanges.filter((entry) => !isCompaction(entry.body)).indexOf(server.exchanges[server.exchanges.indexOf(compactions[0]!) + 1]!)];
    expect(firstOfEpoch?.thinkingBlocksDropped ?? 0).toBeGreaterThan(0);
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
