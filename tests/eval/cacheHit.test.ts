// Offline cache-hit simulation (Living cast spec §12). A real life runs end to end — intake, wake
// queue, life loop, tools, the winter model layer and its REAL anthropic-messages adapter — against a
// loopback Anthropic server that applies Anthropic's caching rules (anthropicCacheSim.ts) to the exact
// wire body: at most 4 breakpoints, a 20-block lookback, each breakpoint's own TTL (the life asks for
// one hour). Compaction calls and the first call after a gap longer than the TTL are excluded.
//
// Targets (§12): a busy room (wakes under 5 minutes apart) and a DM conversation ≥ 0.85 of prompt
// tokens read from cache; a quiet day (wakes 15–60 minutes apart) ≥ 0.75. A miss is a finding about
// the prefix or breakpoint layout, not a reason to loosen the target. CACHE_HIT_TRACE=1 prints a row
// per request.

import { afterEach, describe, expect, it, vi } from "vitest";

/** The request size the life loop sees: forced only to bring the rest notice on (§19, §25, §26). */
const estimate = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("../../src/life/request.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/life/request.js")>();
  return { ...real, estimateRequest: (...args: Parameters<typeof real.estimateRequest>) => estimate.value ?? real.estimateRequest(...args) };
});

import { REST_NOTICE } from "../../src/life/lifeLoop.js";
import { readLifeState } from "../../src/life/lifeStore.js";
import { lifeBudget } from "../../src/life/request.js";
import { closeWorlds, type LifeWorld } from "../lifeFixtures.js";
import { removeTempRoot } from "../testUtils.js";
import { AnthropicCacheSim, ONE_HOUR_MS, readRatio, tally, type CacheUsage, type WireBlock, type WireBody } from "./anthropicCacheSim.js";
import type { Exchange, FakeAnthropic } from "./fakeAnthropic.js";
import { dmWake, isCompaction, isMaintenance, lifeTurn, realAnthropicWorld, roomWake } from "./lifeWire.js";

const roots: string[] = [];
const servers: FakeAnthropic[] = [];
afterEach(async () => {
  estimate.value = undefined;
  await closeWorlds();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

/** The calls that count: life calls, minus the first one after a gap longer than the TTL. */
function counted(exchanges: readonly Exchange[]): CacheUsage[] {
  const out: CacheUsage[] = [];
  let lastAt: number | undefined;
  for (const exchange of exchanges) {
    if (isMaintenance(exchange.body)) continue;
    const gap = lastAt === undefined ? Infinity : exchange.at - lastAt;
    lastAt = exchange.at;
    if (isCompaction(exchange.body) || gap > ONE_HOUR_MS) continue;
    out.push(exchange.usage);
  }
  return out;
}

function trace(label: string, exchanges: readonly Exchange[]): void {
  if (process.env.CACHE_HIT_TRACE !== "1") return;
  for (const [index, exchange] of exchanges.entries()) {
    const u = exchange.usage;
    console.log(`${label} #${index} t=${new Date(exchange.at).toISOString().slice(11, 16)} total=${u.total} read=${u.read} write=${u.write} hit=${u.hitIndex ?? "-"}/${u.blocks} bps=${u.breakpoints.join(",")}${isCompaction(exchange.body) ? " (compaction)" : ""}`);
  }
}

async function scenario(o: { place: "room" | "dm"; wakes: number; gapMinutes: (index: number) => number; chatter?: number }): Promise<{ ratio: number; calls: number; w: LifeWorld; server: FakeAnthropic }> {
  const { w, server } = await realAnthropicWorld(roots, servers);
  server.next = lifeTurn(() => (o.place === "dm" ? "dm/kevin" : "bake-club/#general"));
  for (let index = 0; index < o.wakes; index += 1) {
    if (o.place === "dm") await dmWake(w, `message ${index}: how's your day going? any baking plans?`);
    else await roomWake(w, `question ${index}: what should we bake next?`, o.chatter ?? 4);
    w.clock.advance(o.gapMinutes(index) * 60_000);
  }
  trace(o.place, server.exchanges);
  const t = tally(counted(server.exchanges));
  return { ratio: readRatio(t), calls: t.calls, w, server };
}

describe("the cache model", () => {
  it("honours each breakpoint's TTL: a 1-hour entry outlives five minutes, a 5-minute one does not", () => {
    let now = 0;
    const sim = new AnthropicCacheSim({ now: () => now });
    const body = (ttl?: "1h", blocks = 3) => ({
      system: [{ type: "text", text: "S ".repeat(400), cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } } as WireBlock],
      messages: [{ role: "user", content: Array.from({ length: blocks }, (_, i): WireBlock => ({ type: "text", text: `block ${i}` })) }]
    });
    sim.process(body("1h"));
    now = 30 * 60_000;
    expect(sim.process(body("1h", 4)).read).toBeGreaterThan(0);
    const short = new AnthropicCacheSim({ now: () => now });
    short.process(body());
    now += 6 * 60_000;
    expect(short.process(body(undefined, 4)).read).toBe(0);
    expect(() => sim.process({ messages: [{ role: "user", content: Array.from({ length: 5 }, (): WireBlock => ({ type: "text", text: "x", cache_control: { type: "ephemeral" } })) }] })).toThrow(/more than 4/u);
  });
});

describe("cache-hit targets (§12)", { timeout: 120_000 }, () => {
  it("busy room (wakes under 5 minutes apart) ≥ 0.85", async () => {
    const { ratio, calls, w } = await scenario({ place: "room", wakes: 12, gapMinutes: (index) => 2 + (index % 3), chatter: 6 });
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(30);
    expect(ratio).toBeGreaterThanOrEqual(0.85);
  });

  it("DM conversation ≥ 0.85", async () => {
    const { ratio, calls } = await scenario({ place: "dm", wakes: 12, gapMinutes: (index) => 1 + (index % 4) });
    expect(calls).toBeGreaterThanOrEqual(30);
    expect(ratio).toBeGreaterThanOrEqual(0.85);
  });

  it("quiet day (wakes 15–60 minutes apart) ≥ 0.75", async () => {
    const gaps = [15, 40, 25, 55, 30, 60, 20, 45, 35, 50];
    const { ratio, calls } = await scenario({ place: "room", wakes: 10, gapMinutes: (index) => gaps[index % gaps.length]!, chatter: 8 });
    expect(calls).toBeGreaterThanOrEqual(25);
    expect(ratio).toBeGreaterThanOrEqual(0.75);
  });
});

describe("the rest turn (§19.3)", { timeout: 120_000 }, () => {
  it("keeps the cached prefix: same tools and system, the turn before it read from cache", async () => {
    const { w, server } = await realAnthropicWorld(roots, servers);
    const isRest = (body: WireBody) => JSON.stringify(body.messages[body.messages.length - 1]).includes(REST_NOTICE.slice(0, 60));
    const turn = lifeTurn(() => "bake-club/#general");
    server.next = (body) => {
      if (!isRest(body) && !JSON.stringify(body.messages.slice(-1)).includes("saturday.md")) return turn(body);
      if (isRest(body)) return { thinking: "Let me keep the plan.", toolCalls: [{ name: "Write", input: { file_path: "~/saturday.md", content: "Saturday: lemon tarts\n" } }] };
      estimate.value = undefined;
      return { text: "Bake Club #general: Kevin asked what to bake next; I said lemon tarts. ".repeat(6) };
    };
    for (let index = 0; index < 3; index += 1) {
      await roomWake(w, `question ${index}: what should we bake next?`, 4);
      w.clock.advance(2 * 60_000);
    }
    const route = (await readLifeState(w.storage, "ella")).modelRoute!;
    const model = w.cast.deps.catalog().models.find((entry) => entry.providerId === route.providerId && entry.modelId === route.modelId)!;
    const budget = lifeBudget(model, w.config.life.maxContextTokens);
    estimate.value = Math.round(0.8 * budget);
    await roomWake(w, "last question: lemon or lime?", 4);
    trace("rest", server.exchanges);
    const at = server.exchanges.findIndex((exchange) => isRest(exchange.body));
    expect(at).toBeGreaterThan(0);
    const before = server.exchanges[at - 1]!;
    const rest = server.exchanges[at]!;
    expect(rest.body.tools).toEqual(before.body.tools);
    expect(rest.body.system).toEqual(before.body.system);
    // Everything up to her last call is read from cache; only the notice is new.
    expect(rest.usage.read).toBeGreaterThanOrEqual(0.9 * rest.usage.total);
    expect((await readLifeState(w.storage, "ella")).lastCompaction).toMatchObject({ reason: "rest" });
  });
});

describe("the quiet-time rest (§25)", { timeout: 120_000 }, () => {
  it("comes before her 1-hour cache expires and is read from it: the usage ledger shows the rest turn as cache reads", async () => {
    const { w, server } = await realAnthropicWorld(roots, servers);
    const isRest = (body: WireBody) => JSON.stringify(body.messages[body.messages.length - 1]).includes("You've been quiet a while");
    const turn = lifeTurn(() => "bake-club/#general");
    server.next = (body) => {
      if (!isRest(body)) return turn(body);
      estimate.value = undefined;
      return { text: "Bake Club #general: Kevin asked what to bake next; I said lemon tarts. ".repeat(6) };
    };
    for (let index = 0; index < 3; index += 1) {
      await roomWake(w, `question ${index}: what should we bake next?`, 4);
      w.clock.advance(2 * 60_000);
    }
    const route = (await readLifeState(w.storage, "ella")).modelRoute!;
    const model = w.cast.deps.catalog().models.find((entry) => entry.providerId === route.providerId && entry.modelId === route.modelId)!;
    estimate.value = Math.round(0.6 * w.config.compaction.triggerRatio * lifeBudget(model, w.config.life.maxContextTokens));
    await roomWake(w, "last question: lemon or lime?", 4);
    // Quiet for 52 minutes: the tick starts her rest turn, 8 minutes before the cache expires.
    w.clock.advance(52 * 60_000);
    await w.cast.scheduler.tick();
    await w.cast.life("ella").whenIdle();
    trace("quiet rest", server.exchanges);
    const at = server.exchanges.findIndex((exchange) => isRest(exchange.body));
    expect(at).toBeGreaterThan(0);
    const rest = server.exchanges[at]!;
    expect(rest.at - server.exchanges[at - 1]!.at).toBeGreaterThanOrEqual(50 * 60_000);
    expect(rest.usage.read).toBeGreaterThanOrEqual(0.9 * rest.usage.total);
    const line = w.ledger.lines.filter((entry) => entry.purpose === "life").at(-1)!;
    expect(line.cacheReadTokens).toBe(rest.usage.read);
    expect((await readLifeState(w.storage, "ella")).lastCompaction).toMatchObject({ reason: "cache_rest" });
  });
});
