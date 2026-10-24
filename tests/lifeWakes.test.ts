// Waking (Living cast spec §4.1–§4.4, §4.6, §10.3): every wake reason, waifu authors, the detector
// mapping and fallback, staggering, and the guards in order. Fake Discord, fake detector, temp data
// root; no live calls. Lives never run here (the wake queue is read directly).
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { newWakeId } from "../src/life/wakeQueue.js";
import { updateDmLimit } from "../src/orchestration/dm/dmStore.js";
import { DetectorHistoryFileSchema } from "../src/shared/schemas/detector.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import {
  ARIA_BOT,
  CHANNEL,
  closeWorlds,
  dmOf,
  GUILD,
  KEVIN,
  lifeWorld,
  MINA_BOT,
  MINA_USER,
  ROOM,
  ROOM_KEY,
  type LifeWorld
} from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const TWO = [
  { id: "aria", name: "Aria", botId: "aria-bot" },
  { id: "mina", name: "Mina", botId: "mina-bot" }
];

type FakeDetector = { calls: Array<{ target: string; candidates: string[] }>; answer: { choice: string; probabilities: Record<string, number> } | Error };

function fakeDetector(): FakeDetector & { decide: (input: { target: string; question: { candidates: Array<{ waifuId: string }> } }) => Promise<{ choice: string; probabilities: Record<string, number> }>; close(): void } {
  const detector = {
    calls: [] as FakeDetector["calls"],
    answer: { choice: "none", probabilities: { none: 1 } } as FakeDetector["answer"],
    async decide(input: { target: string; question: { candidates: Array<{ waifuId: string }> } }) {
      detector.calls.push({ target: input.target, candidates: input.question.candidates.map((candidate) => candidate.waifuId) });
      if (detector.answer instanceof Error) throw detector.answer;
      return detector.answer;
    },
    close() {}
  };
  return detector;
}

async function world(o: Parameters<typeof lifeWorld>[1] = {}): Promise<LifeWorld & { detector: ReturnType<typeof fakeDetector> }> {
  const detector = fakeDetector();
  const built = await lifeWorld(roots, { waifus: TWO, ...o, options: { detector: detector as never, ...o.options } });
  // Lives never run here: the tests read the wake queue.
  for (const waifu of o.waifus ?? TWO) vi.spyOn(built.cast.life(waifu.id), "poke").mockImplementation(() => undefined);
  return Object.assign(built, { detector });
}

/** Posts a guild message and runs it through intake (and the detector, flushed). */
async function say(w: LifeWorld, text: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}): Promise<RawDiscordMessage> {
  const message = w.discord.post(ROOM, text, o);
  const authorIsWaifu = message.authorId === ARIA_BOT || message.authorId === MINA_BOT;
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria", "mina"], authorIsWaifu, raw: message });
  await w.cast.settle();
  w.cast.intake.flushDetector();
  await w.cast.settle();
  return message;
}

async function queued(w: LifeWorld, waifuId: string) {
  return readLifeFile(w.storage, waifuId, "wakes");
}

async function reasons(w: LifeWorld, waifuId: string): Promise<string[]> {
  return (await queued(w, waifuId)).immediate.map((wake) => [wake.reason, ...(wake.reasons ?? []).slice(1)].join("+"));
}

const asMina = { authorId: MINA_BOT, authorName: "Mina", bot: true };

describe("wake reasons (§4.1, §4.2)", () => {
  it("mention, reply-to-her, role, @everyone and her name; other waifus are not woken", async () => {
    const w = await world();
    w.discord.botRoles["aria-bot"] = ["500000000000000001"];
    await say(w, `hey <@${ARIA_BOT}>`, { mentions: { [ARIA_BOT]: "Aria" } });
    const hers = w.discord.post(ROOM, "fresh brownies!", { authorId: ARIA_BOT, authorName: "Aria", bot: true });
    await say(w, "omg yes", { replyTo: hers.id });
    await say(w, "bakers, assemble", { roles: { "500000000000000001": "Bakers" } });
    await say(w, "did Aria finish the cake?");
    expect(await reasons(w, "aria")).toEqual(["mention", "mention", "role", "name"]);
    expect((await queued(w, "aria")).immediate[0]).toMatchObject({ placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", preview: "hey <@Aria>" });
    expect(await reasons(w, "mina")).toEqual([]);
    // The name rule: whole words only, and off with wakeOnName: false.
    await say(w, "Ariana Grande is playing");
    expect(await reasons(w, "aria")).toHaveLength(4);
  });

  it("@everyone wakes the whole cast, staggered by 0–20 s", async () => {
    const w = await world({ options: { random: () => 0.5 } });
    const routes: Array<{ waifuId: string; stagger: boolean }> = [];
    const route = w.cast.router.route.bind(w.cast.router);
    vi.spyOn(w.cast.router, "route").mockImplementation((waifuId, wake, context = {}) => {
      routes.push({ waifuId, stagger: context.stagger === true });
      // Routed at once here; the delay itself is checked below.
      return route(waifuId, wake, { ...context, stagger: false });
    });
    await say(w, "@everyone bake sale tomorrow!", { everyone: true });
    expect(routes).toEqual([
      { waifuId: "aria", stagger: true },
      { waifuId: "mina", stagger: true }
    ]);
    expect(await reasons(w, "aria")).toEqual(["everyone"]);
    expect(await reasons(w, "mina")).toEqual(["everyone"]);
    // One waifu woken alone is never delayed.
    await say(w, `<@${ARIA_BOT}> hi`, { mentions: { [ARIA_BOT]: "Aria" } });
    expect(routes[2]).toEqual({ waifuId: "aria", stagger: false });
    // The delay is random() × 20 s.
    const timers = vi.spyOn(globalThis, "setTimeout");
    void route("aria", { id: newWakeId(), reason: "everyone", at: w.clock.now().toISOString() }, { stagger: true });
    expect(timers.mock.calls.map((call) => call[1])).toContain(10_000);
  });

  it("waifu authors wake only through mention, role, reply and watch; her own messages never wake her", async () => {
    const w = await world();
    w.discord.botRoles["aria-bot"] = ["500000000000000001"];
    await say(w, "Aria, you should try this", asMina);
    await say(w, "@everyone look", { ...asMina, everyone: true });
    expect(await reasons(w, "aria")).toEqual([]);
    expect(w.detector.calls).toEqual([]);
    await say(w, "<@aria> taste this", { ...asMina, mentions: { [ARIA_BOT]: "Aria" } });
    await say(w, "role call", { ...asMina, roles: { "500000000000000001": "Bakers" } });
    const wakes = (await queued(w, "aria")).immediate;
    expect(wakes.map((wake) => wake.reason)).toEqual(["mention", "role"]);
    expect(wakes.every((wake) => wake.waifuAuthored === true)).toBe(true);
    // Her own message mentioning herself.
    await say(w, "<@aria> note to self", { authorId: ARIA_BOT, authorName: "Aria", bot: true, mentions: { [ARIA_BOT]: "Aria" } });
    expect(await reasons(w, "aria")).toEqual(["mention", "role"]);
  });

  it("watches fire with her note, never on her own messages", async () => {
    const w = await world();
    await updateLifeFile(w.storage, "aria", "watches", (file) => ({
      ...file,
      watches: [
        {
          id: "w1",
          note: "Mina wanted brownie tips",
          createdAt: w.clock.now().toISOString(),
          expiresAt: new Date(w.clock.ms + 86_400_000).toISOString(),
          once: false,
          bindings: [{ placeKey: ROOM_KEY, words: ["brownie"] }],
          fires: []
        }
      ]
    }));
    await say(w, "anyone have a good brownie recipe?");
    const wake = (await queued(w, "aria")).immediate[0];
    expect(wake).toMatchObject({ reason: "watch", watchId: "w1", matched: "brownie", note: "Mina wanted brownie tips", fromName: "Kevin" });
    await say(w, "my brownie came out great", { authorId: ARIA_BOT, authorName: "Aria", bot: true });
    expect((await queued(w, "aria")).immediate).toHaveLength(1);
  });

  it("a DM wakes her 30 s after the last message (timer reset), capped at 180 s", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const dm = async (text: string) => {
      const message = w.discord.post(dmOf("aria"), text);
      await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    };
    await dm("hey");
    await vi.advanceTimersByTimeAsync(25_000);
    await dm("quick question");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await reasons(w, "aria")).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    await w.cast.settle();
    const wake = (await queued(w, "aria")).immediate[0];
    expect(wake).toMatchObject({ reason: "dm", placeKey: `dm_${KEVIN}_aria`, fromName: "Kevin", count: 2, preview: "quick question" });
    // A user who keeps writing every 20 s is answered after 180 s at the latest.
    for (let index = 0; index < 9; index += 1) {
      await dm(`msg ${index}`);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    await w.cast.settle();
    expect((await queued(w, "aria")).immediate.length).toBe(2);
  });
});

describe("addressee detector (§4.3)", () => {
  it("maps waifu_<i> to her, anyone to a weighted draw, human/none to nothing, and keeps a history", async () => {
    const w = await world();
    w.detector.answer = { choice: "waifu_1", probabilities: { waifu_1: 0.9, none: 0.1 } };
    await say(w, "what do you think about lemon tarts");
    expect(w.detector.calls[0]).toEqual({ target: "openrouter:cloudflare/clef", candidates: ["aria", "mina"] });
    expect(await reasons(w, "mina")).toEqual(["detector"]);
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    await say(w, "so who's baking saturday");
    expect((await reasons(w, "aria")).concat(await reasons(w, "mina"))).toEqual(["detector", "detector"]);
    w.detector.answer = { choice: "human", probabilities: { human: 1 } };
    await say(w, "kevin you there");
    expect((await queued(w, "aria")).immediate.length + (await queued(w, "mina")).immediate.length).toBe(2);
    const history = DetectorHistoryFileSchema.parse(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(w.root, "user/servers", GUILD, "detector-history.json"), "utf8")));
    expect(history.entries.map((entry) => entry.choice)).toEqual(["waifu_1", "anyone", "human"]);
    expect(history.entries[0]).toMatchObject({ channelId: CHANNEL, woke: ["mina"], probabilities: { waifu_1: 0.9 }, target: "openrouter:cloudflare/clef" });
    expect(history.entries[2]!.woke).toBeUndefined();
  });

  it("direct reasons anywhere in the burst skip the detector; a server override and no target are honoured", async () => {
    const w = await world();
    await say(w, "<@aria> hi", { mentions: { [ARIA_BOT]: "Aria" } });
    expect(w.detector.calls).toEqual([]);
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, detector: { target: "laya:english" } })
    });
    await say(w, "nice weather today");
    expect(w.detector.calls.map((call) => call.target)).toEqual(["laya:english"]);
    // "" turns the detector off for the server: the fallback decides.
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, detector: { target: "" } })
    });
    await say(w, "is anyone around?");
    expect(w.detector.calls).toHaveLength(1);
    expect((await reasons(w, "aria")).length + (await reasons(w, "mina")).length).toBe(2);
  });

  it("a burst is direct when any message in it is, also one arriving after the mention (M9)", async () => {
    const w = await world();
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    for (const [text, o] of [
      [`<@${ARIA_BOT}> are you there`, { mentions: { [ARIA_BOT]: "Aria" } }],
      ["also what's for dinner?", {}]
    ] as const) {
      const message = w.discord.post(ROOM, text, o);
      await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria", "mina"], authorIsWaifu: false, raw: message });
    }
    await w.cast.settle();
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect(w.detector.calls).toEqual([]);
    expect(await reasons(w, "aria")).toEqual(["mention"]);
    expect(await reasons(w, "mina")).toEqual([]);
  });

  it("one wake per message: the detector skips a waifu her watch already woke for the burst; others can still be picked (D-c)", async () => {
    const w = await world();
    await updateLifeFile(w.storage, "aria", "watches", (file) => ({
      ...file,
      watches: [
        {
          id: "w1",
          note: "brownies",
          createdAt: w.clock.now().toISOString(),
          expiresAt: new Date(w.clock.ms + 86_400_000).toISOString(),
          once: false,
          bindings: [{ placeKey: ROOM_KEY, words: ["brownie"] }],
          fires: []
        }
      ]
    }));
    // The detector picks her: she already has the watch wake, so nothing more.
    w.detector.answer = { choice: "waifu_0", probabilities: { waifu_0: 1 } };
    await say(w, "brownie emergency, help");
    expect(await reasons(w, "aria")).toEqual(["watch"]);
    expect(await reasons(w, "mina")).toEqual([]);
    // "anyone": the draw leaves her out.
    w.clock.advance(11 * 60_000);
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    await say(w, "who has a brownie pan?");
    expect(await reasons(w, "mina")).toEqual(["detector"]);
    // Another waifu chosen by name is still woken.
    w.clock.advance(11 * 60_000);
    w.detector.answer = { choice: "waifu_1", probabilities: { waifu_1: 1 } };
    await say(w, "brownie pans are overrated, right?");
    expect(await reasons(w, "mina")).toEqual(["detector", "detector"]);
    expect((await queued(w, "aria")).immediate.every((wake) => wake.reason === "watch")).toBe(true);
  });

  it("unreadable forget records fail closed: previews hidden, no detector, an owner notice until repaired", async () => {
    const w = await world();
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    const file = path.join(w.root, "user/people/forgotten.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"forgotten": [{"userId": "3000');
    await say(w, `<@${ARIA_BOT}> my secret is cardamom`, { mentions: { [ARIA_BOT]: "Aria" } });
    await say(w, "anyone around?");
    expect(w.detector.calls).toEqual([]);
    const [wake] = (await queued(w, "aria")).immediate;
    expect(wake).toMatchObject({ reason: "mention", fromName: "someone" });
    expect(JSON.stringify(wake)).not.toContain("cardamom");
    expect(w.cast.notices.list()).toEqual([expect.stringContaining("forgotten.json is unreadable")]);
    // Repaired: the notice clears and the detector runs again.
    await writeFile(file, JSON.stringify({ forgotten: [] }));
    w.clock.advance(11 * 60_000);
    await say(w, "anyone around now?");
    expect(w.detector.calls).toHaveLength(1);
    expect(w.cast.notices.list()).toEqual([]);
  });

  it("on failure: anyone for a question or the first human message in 10 minutes, else nothing; never retried", async () => {
    const w = await world();
    w.detector.answer = new Error("detector_timeout");
    await say(w, "lovely day");
    expect((await reasons(w, "aria")).length + (await reasons(w, "mina")).length).toBe(1);
    w.clock.advance(60_000);
    await say(w, "really lovely");
    expect((await reasons(w, "aria")).length + (await reasons(w, "mina")).length).toBe(1);
    w.clock.advance(60_000);
    await say(w, "should we bake?");
    expect((await reasons(w, "aria")).length + (await reasons(w, "mina")).length).toBe(2);
    expect(w.detector.calls).toHaveLength(3);
    const history = DetectorHistoryFileSchema.parse(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(w.root, "user/servers", GUILD, "detector-history.json"), "utf8")));
    expect(history.entries.map((entry) => [entry.choice, entry.error])).toEqual([
      ["fallback:anyone", "detector_timeout"],
      ["fallback:none", "detector_timeout"],
      ["fallback:anyone", "detector_timeout"]
    ]);
  });
});

describe("guards in order (§4.4, §4.5)", () => {
  it("1. a paused app or server drops every wake", async () => {
    let paused = true;
    const w = await world({ paused: () => paused });
    await say(w, "<@aria> hi", { mentions: { [ARIA_BOT]: "Aria" } });
    expect(await reasons(w, "aria")).toEqual([]);
    paused = false;
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, paused: true })
    });
    await say(w, "<@aria> hi again", { mentions: { [ARIA_BOT]: "Aria" } });
    expect(await reasons(w, "aria")).toEqual([]);
  });

  it("2. a rate-limited DM user is dropped; the fixed limit notice goes out once per period", async () => {
    const w = await world({ waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", dm: { allowDms: true, rateLimit: { maxReplies: 2, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }] });
    const at = w.clock.now().toISOString();
    await updateDmLimit(w.storage, KEVIN, "aria", (current) => ({ ...current, replyTimestamps: [at, at] }));
    for (const text of ["hello?", "hello??"]) {
      const message = w.discord.post(dmOf("aria"), text);
      await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, channelId: "dm", messageId: message.id, createdAt: message.createdAt });
      w.cast.intake.flushDms();
      await w.cast.settle();
    }
    expect(await reasons(w, "aria")).toEqual([]);
    const notices = w.discord.sent.filter((sent) => sent.placeKey === `dm_${KEVIN}_aria`);
    expect(notices).toHaveLength(1);
    const limits = await (await import("../src/orchestration/dm/dmStore.js")).readDmLimit(w.storage, KEVIN, "aria");
    expect(limits.autoMessageIds).toEqual([notices[0]!.messageId]);
  });

  it("3. past the per-user wake limit, wakes become one merged quiet line", async () => {
    const w = await world({ config: (config) => ({ ...config, life: { ...config.life, maxWakesPerUserPerHour: 2 } }) });
    for (const text of ["<@aria> one", "<@aria> two", "<@aria> three", "<@aria> four"]) await say(w, text, { mentions: { [ARIA_BOT]: "Aria" } });
    const queue = await queued(w, "aria");
    expect(queue.immediate).toHaveLength(2);
    expect(queue.quiet).toEqual([{ userId: KEVIN, name: "Kevin", count: 2, placeKey: ROOM_KEY }]);
    // Another person is counted separately.
    await say(w, "<@aria> hi from mina", { authorId: MINA_USER, authorName: "Mina", mentions: { [ARIA_BOT]: "Aria" } });
    expect((await queued(w, "aria")).immediate).toHaveLength(3);
  });

  it("4. asleep: wakes are deferred (DMs too); the sleep notice goes once per window; the owner's wake goes through", async () => {
    const sleeping = { sleep: { enabled: true, start: "13:00", end: "15:00" }, busy: [] };
    const w = await world({
      waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", availability: sleeping, dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "zzz, I'll answer in the morning" } }]
    });
    await say(w, "<@aria> you up?", { mentions: { [ARIA_BOT]: "Aria" } });
    for (const text of ["psst", "still there?"]) {
      const message = w.discord.post(dmOf("aria"), text);
      await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, channelId: "dm", messageId: message.id, createdAt: message.createdAt });
      w.cast.intake.flushDms();
      await w.cast.settle();
    }
    const queue = await queued(w, "aria");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.reason).toBe("sleep");
    expect(queue.deferred.places[ROOM_KEY]).toMatchObject({ mentions: 1 });
    expect(queue.deferred.places[`dm_${KEVIN}_aria`]).toMatchObject({ dms: 2 });
    expect(w.discord.sent.map((sent) => sent.content)).toEqual(["zzz, I'll answer in the morning"]);
    expect(await w.cast.ownerWake("aria", "test")).toBe("queued");
    expect(await reasons(w, "aria")).toEqual(["owner"]);
  });

  it("5. over her daily budget: deferred to the next day; the owner's wake still goes through", async () => {
    const w = await world({ waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", life: { dailyBudgetUsd: 0.5 } }] });
    const day = w.clock.now().toISOString().slice(0, 10);
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${day}.jsonl`), `${JSON.stringify({ at: w.clock.now().toISOString(), waifuId: "aria", purpose: "life", costUsd: 0.6 })}\n`);
    await say(w, "<@aria> hi", { mentions: { [ARIA_BOT]: "Aria" } });
    const queue = await queued(w, "aria");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.reason).toBe("budget");
    expect(await w.cast.ownerWake("aria")).toBe("queued");
  });

  it("6. the room loop guard (when set) stops waifu-authored wakes until a human speaks", async () => {
    const w = await world({ config: (config) => ({ ...config, life: { ...config.life, maxWaifuTriggeredTurns: 1 } }) });
    await say(w, "<@aria> one", { ...asMina, mentions: { [ARIA_BOT]: "Aria" } });
    await say(w, "<@aria> two", { ...asMina, mentions: { [ARIA_BOT]: "Aria" } });
    expect(await reasons(w, "aria")).toEqual(["mention"]);
    await say(w, "lol you two");
    await say(w, "<@aria> three", { ...asMina, mentions: { [ARIA_BOT]: "Aria" } });
    expect(await reasons(w, "aria")).toEqual(["mention", "mention"]);
  });
});

describe("edits and deletes (§4.2, §10.3)", () => {
  it("an edit adding her mention to a fresh human message wakes her once; deletes of read messages become pending notices", async () => {
    const w = await world();
    const original = w.discord.post(ROOM, "who's bringing cake");
    const edited = { ...original, content: "who's bringing cake <@aria>", mentions: { ...original.mentions, users: { [ARIA_BOT]: "Aria" } } };
    const event = { type: "update" as const, conversation: ROOM, message: edited, previous: original, source: "gateway" as const };
    w.cast.onCacheEvent(event, async () => ["aria", "mina"]);
    w.cast.onCacheEvent(event, async () => ["aria", "mina"]);
    await w.cast.settle();
    expect(await reasons(w, "aria")).toEqual(["mention"]);
    // Too old: no wake.
    const old = w.discord.post(ROOM, "old one");
    w.clock.advance(3 * 60_000);
    w.cast.onCacheEvent({ ...event, message: { ...old, mentions: { ...old.mentions, users: { [ARIA_BOT]: "Aria" } } }, previous: old }, async () => ["aria"]);
    await w.cast.settle();
    expect(await reasons(w, "aria")).toEqual(["mention"]);

    await updateLifeState(w.storage, "aria", (state) => ({ ...state, readMessageIds: [original.id] }));
    w.cast.onCacheEvent({ type: "delete", conversation: ROOM, messageId: original.id, previous: original, source: "gateway" }, async () => ["aria"]);
    await w.cast.settle();
    const state = await (await import("../src/life/lifeStore.js")).readLifeState(w.storage, "aria");
    expect(state.deletedReadIds).toEqual([original.id]);
    expect(state.pendingNotices).toEqual(["(Kevin deleted a message you read in bake-club/#general)"]);
    // Pending notices never start a turn on their own.
    expect(await reasons(w, "aria")).toEqual(["mention"]);
  });

  it("the queue merges reasons for one place only past 200 entries", async () => {
    const w = await world();
    await updateLifeFile(w.storage, "aria", "wakes", (queue) => ({
      ...queue,
      immediate: Array.from({ length: 200 }, (_, index) => ({ id: `w${index}`, reason: "mention" as const, placeKey: ROOM_KEY, at: w.clock.now().toISOString() }))
    }));
    await w.cast.router.routeNow("aria", { id: newWakeId(), reason: "watch", placeKey: ROOM_KEY, at: w.clock.now().toISOString() }, { guildId: GUILD });
    const queue = await queued(w, "aria");
    expect(queue.immediate).toHaveLength(200);
    expect(queue.immediate[0]).toMatchObject({ reasons: ["mention", "watch"], count: 2 });
  });
});
