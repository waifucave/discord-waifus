// Waking (Living cast spec §4.1–§4.4, §4.6, §10.3): every wake reason, waifu authors, the detector
// mapping and fallback, staggering, and the guards in order. Fake Discord, fake detector, temp data
// root; no live calls. Lives never run here (the wake queue is read directly).
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { morningBatch, renderNotifications } from "../src/life/notifications.js";
import { newWakeId, withDeferred } from "../src/life/wakeQueue.js";
import { updateDmLimit } from "../src/orchestration/dm/dmStore.js";
import { DetectorHistoryFileSchema } from "../src/shared/schemas/detector.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import {
  ELLA_BOT,
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
  writeHerFile,
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
  { id: "ella", name: "Ella", botId: "ella-bot" },
  { id: "mina", name: "Mina", botId: "mina-bot" }
];

type FakeAnswer = { choice: string; probabilities: Record<string, number>; chimeIn?: { choice: string; probabilities: Record<string, number> } };
type FakeQuestion = { state: string; candidates: Array<{ waifuId: string }>; questions: Record<string, { criteria: Record<string, string> }> };
type FakeDetector = { calls: Array<{ target: string; candidates: string[] }>; states: string[]; questions: Array<Record<string, string[]>>; answer: FakeAnswer | Error };

function fakeDetector(): FakeDetector & { decide: (input: { target: string; question: FakeQuestion }) => Promise<FakeAnswer>; close(): void } {
  const detector = {
    calls: [] as FakeDetector["calls"],
    states: [] as string[],
    /** Each call's questions and their choices. */
    questions: [] as FakeDetector["questions"],
    answer: { choice: "none", probabilities: { none: 1 } } as FakeDetector["answer"],
    async decide(input: { target: string; question: FakeQuestion }) {
      detector.calls.push({ target: input.target, candidates: input.question.candidates.map((candidate) => candidate.waifuId) });
      detector.states.push(input.question.state);
      detector.questions.push(Object.fromEntries(Object.entries(input.question.questions).map(([name, question]) => [name, Object.keys(question.criteria)])));
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
  const authorIsWaifu = message.authorId === ELLA_BOT || message.authorId === MINA_BOT;
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella", "mina"], authorIsWaifu, raw: message });
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
    w.discord.botRoles["ella-bot"] = ["500000000000000001"];
    await say(w, `hey <@${ELLA_BOT}>`, { mentions: { [ELLA_BOT]: "Ella" } });
    const hers = w.discord.post(ROOM, "fresh brownies!", { authorId: ELLA_BOT, authorName: "Ella", bot: true });
    await say(w, "omg yes", { replyTo: hers.id });
    await say(w, "bakers, assemble", { roles: { "500000000000000001": "Bakers" } });
    await say(w, "did Ella finish the cake?");
    expect(await reasons(w, "ella")).toEqual(["mention", "mention", "role", "name"]);
    expect((await queued(w, "ella")).immediate[0]).toMatchObject({ placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", preview: "hey <@Ella>" });
    expect(await reasons(w, "mina")).toEqual([]);
    // The name rule: whole words only, and off with wakeOnName: false.
    await say(w, "Cinderella and Ellaria are playing");
    expect(await reasons(w, "ella")).toHaveLength(4);
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
      { waifuId: "ella", stagger: true },
      { waifuId: "mina", stagger: true }
    ]);
    expect(await reasons(w, "ella")).toEqual(["everyone"]);
    expect(await reasons(w, "mina")).toEqual(["everyone"]);
    // One waifu woken alone is never delayed.
    await say(w, `<@${ELLA_BOT}> hi`, { mentions: { [ELLA_BOT]: "Ella" } });
    expect(routes[2]).toEqual({ waifuId: "ella", stagger: false });
    // The delay is random() × 20 s.
    const timers = vi.spyOn(globalThis, "setTimeout");
    void route("ella", { id: newWakeId(), reason: "everyone", at: w.clock.now().toISOString() }, { stagger: true });
    expect(timers.mock.calls.map((call) => call[1])).toContain(10_000);
  });

  it("waifu authors wake directly only through mention, role, reply and watch; her own messages never wake her", async () => {
    const w = await world();
    w.discord.botRoles["ella-bot"] = ["500000000000000001"];
    await say(w, "Ella, you should try this", asMina);
    await say(w, "@everyone look", { ...asMina, everyone: true });
    expect(await reasons(w, "ella")).toEqual([]);
    // Not direct for anyone: the detector decides who speaks next, without the author (§4.3).
    expect(w.detector.calls).toEqual([
      { target: "openrouter:typesafe/jev-1.14", candidates: ["ella"] },
      { target: "openrouter:typesafe/jev-1.14", candidates: ["ella"] }
    ]);
    await say(w, "<@ella> taste this", { ...asMina, mentions: { [ELLA_BOT]: "Ella" } });
    await say(w, "role call", { ...asMina, roles: { "500000000000000001": "Bakers" } });
    const wakes = (await queued(w, "ella")).immediate;
    expect(wakes.map((wake) => wake.reason)).toEqual(["mention", "role"]);
    expect(wakes.every((wake) => wake.waifuAuthored === true)).toBe(true);
    expect(w.detector.calls).toHaveLength(2);
    // Her own message mentioning herself: never her wake, and the detector never offers her.
    await say(w, "<@ella> note to self", { authorId: ELLA_BOT, authorName: "Ella", bot: true, mentions: { [ELLA_BOT]: "Ella" } });
    expect(await reasons(w, "ella")).toEqual(["mention", "role"]);
    expect(w.detector.calls[2]!.candidates).toEqual(["mina"]);
  });

  it("watches fire with her note, never on her own messages", async () => {
    const w = await world();
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: false, note: "Mina wanted brownie tips", when: [{ place: "bake-club/#general", words: ["brownie"] }] }]));
    await say(w, "anyone have a good brownie recipe?");
    const wake = (await queued(w, "ella")).immediate[0];
    expect(wake).toMatchObject({ reason: "watch", watchId: "w1", matched: "brownie", note: "Mina wanted brownie tips", fromName: "Kevin" });
    await say(w, "my brownie came out great", { authorId: ELLA_BOT, authorName: "Ella", bot: true });
    expect((await queued(w, "ella")).immediate).toHaveLength(1);
  });

  it("a watch matching a DM rides on its DM wake: one line, one wake (§16.5)", async () => {
    const w = await world();
    const hello = w.discord.post(dmOf("ella"), "hi!");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: hello.id, createdAt: hello.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({ ...queue, immediate: [] }));
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: true, note: "ask how his exam went", when: [{ from: "Kevin", words: ["exam"] }] }]));
    const message = w.discord.post(dmOf("ella"), "the exam went great btw");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    // Nothing at once: the watch waits for the DM's hold.
    await w.cast.settle();
    expect((await queued(w, "ella")).immediate).toEqual([]);
    w.cast.intake.flushDms();
    await w.cast.settle();
    const wakes = (await queued(w, "ella")).immediate;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason: "dm", reasons: ["dm", "watch"], watchId: "w1", matched: "exam", note: "ask how his exam went", messageId: message.id });
    const view = { handle: () => "dm/kevin", unread: () => undefined, timeZone: "UTC" };
    expect(renderNotifications({ wakes }, view)).toContain('- dm, watch · dm/kevin · "exam" · from Kevin · "the exam went great btw" · your note: "ask how his exam went"');
    // A once-watch is gone after its match.
    expect(JSON.parse((await (await import("./lifeFixtures.js")).homeOf(w, "ella").read("watches.json")) ?? "[]")).toEqual([]);
  });

  it("deferred while she sleeps, a DM wake with a watch keeps its note for the morning batch", async () => {
    const at = "2026-10-24T14:00:00.000Z";
    const wake = { id: "w1", reason: "dm" as const, reasons: ["dm" as const, "watch" as const], watchId: "w3", matched: "exam", note: "his exam", placeKey: "dm_k_ella", fromUserId: KEVIN, fromName: "Kevin", at };
    const queue = withDeferred({ immediate: [], deferred: { places: {}, items: [] }, quiet: [], userWakes: {} } as never, wake, "sleep", new Date(at));
    expect(queue.deferred.items).toEqual([wake]);
    expect(queue.deferred.places["dm_k_ella"]).toMatchObject({ dms: 1 });
    const view = { handle: () => "dm/kevin", unread: () => undefined, timeZone: "UTC" };
    const lines = morningBatch({ reason: "sleep", since: new Date(at), until: new Date(at), places: [{ placeKey: "dm_k_ella", kind: "dm", name: "Kevin", mentions: 0, messages: 1 }], items: queue.deferred.items }, view);
    expect(lines).toContain('  · watch matched · dm/kevin · "exam" · from Kevin · your note: "his exam"');
  });

  it("a DM dropped by its rate limit still brings her watch match", async () => {
    const w = await world({ waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", dm: { allowDms: true, rateLimit: { maxReplies: 1, windowMinutes: 60 }, notifyWhenLimited: false, limitNotice: "", sleepNotice: "" } }] });
    const hello = w.discord.post(dmOf("ella"), "hi!");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: hello.id, createdAt: hello.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({ ...queue, immediate: [] }));
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: true, note: "his exam", when: [{ from: "Kevin", words: ["exam"] }] }]));
    const at = w.clock.now().toISOString();
    await updateDmLimit(w.storage, KEVIN, "ella", (current) => ({ ...current, replyTimestamps: [at] }));
    const message = w.discord.post(dmOf("ella"), "exam done!");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    expect((await queued(w, "ella")).immediate).toMatchObject([{ reason: "watch", watchId: "w1", note: "his exam", matched: "exam" }]);
  });

  it("a DM wakes her 2.5 s after the last message (timer reset), capped at 60 s", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const dm = async (text: string) => {
      const message = w.discord.post(dmOf("ella"), text);
      await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    };
    await dm("hey");
    await vi.advanceTimersByTimeAsync(2_000);
    await dm("quick question");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await reasons(w, "ella")).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    await w.cast.settle();
    const wake = (await queued(w, "ella")).immediate[0];
    expect(wake).toMatchObject({ reason: "dm", placeKey: `dm_${KEVIN}_ella`, fromName: "Kevin", count: 2, preview: "quick question" });
    // A user who keeps writing every 2 s is answered after 60 s at the latest.
    for (let index = 0; index < 31; index += 1) {
      await dm(`msg ${index}`);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    await w.cast.settle();
    expect((await queued(w, "ella")).immediate.length).toBe(2);
  });
});

describe("typing-aware holds (§4.2)", () => {
  /** Posts a guild message and runs it through intake without firing its burst. */
  async function post(w: LifeWorld, text: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}): Promise<RawDiscordMessage> {
    const message = w.discord.post(ROOM, text, o);
    const authorIsWaifu = message.authorId === ELLA_BOT || message.authorId === MINA_BOT;
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella", "mina"], authorIsWaifu, raw: message });
    return message;
  }
  const typing = (w: LifeWorld, userId: string, bot = false) => w.cast.onTyping({ kind: "guild", guildId: GUILD, channelId: CHANNEL, userId, bot });
  const dmTyping = (w: LifeWorld, userId: string, bot = false) => w.cast.onTyping({ kind: "dm", waifuId: "ella", botId: "ella-bot", userId, bot });
  async function advance(w: LifeWorld, ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await w.cast.settle();
  }
  async function fakeTimers(): Promise<LifeWorld & { detector: ReturnType<typeof fakeDetector> }> {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    return w;
  }

  it("a waifu's lines in one turn are one burst; a direct line in it keeps the detector out", async () => {
    const w = await fakeTimers();
    w.detector.answer = { choice: "waifu_0", probabilities: { waifu_0: 1 } };
    await post(w, "ok the tarts are out", asMina);
    await advance(w, 500);
    await post(w, "they look amazing", asMina);
    await advance(w, 1_600);
    expect(w.detector.calls).toHaveLength(1);
    expect(await reasons(w, "ella")).toEqual(["detector"]);
    await post(w, "brb", asMina);
    await post(w, `<@${ELLA_BOT}> save me one`, { ...asMina, mentions: { [ELLA_BOT]: "Ella" } });
    await advance(w, 1_600);
    expect(w.detector.calls).toHaveLength(1);
    expect(await reasons(w, "ella")).toEqual(["detector", "mention"]);
  });

  it("a mention waits the quiet time, then wakes her; with nobody typing it is not held longer", async () => {
    const w = await fakeTimers();
    await post(w, `<@${ELLA_BOT}> hi`, { mentions: { [ELLA_BOT]: "Ella" } });
    await advance(w, 1_400);
    expect(await reasons(w, "ella")).toEqual([]);
    await advance(w, 200);
    expect(await reasons(w, "ella")).toEqual(["mention"]);
  });

  it("the author typing holds the wake for 6 s per typing event; their next message ends the hold and becomes the preview (mention + follow-up = one wake)", async () => {
    const w = await fakeTimers();
    const ping = await post(w, `<@${ELLA_BOT}>`, { mentions: { [ELLA_BOT]: "Ella" } });
    await advance(w, 1_000);
    typing(w, KEVIN);
    // Past the 1.5 s quiet time, still inside the typing hold.
    await advance(w, 4_000);
    expect(await reasons(w, "ella")).toEqual([]);
    // A second typing event extends the hold past the first one's 6 s.
    typing(w, KEVIN);
    await advance(w, 2_500);
    expect(await reasons(w, "ella")).toEqual([]);
    // The follow-up arrives: Kevin is no longer typing; the burst fires 1.5 s later.
    const question = await post(w, "what do you think about lemon tarts?");
    await advance(w, 1_400);
    expect(await reasons(w, "ella")).toEqual([]);
    await advance(w, 200);
    const wakes = (await queued(w, "ella")).immediate;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason: "mention", fromName: "Kevin", messageId: question.id, preview: "what do you think about lemon tarts?" });
    expect(wakes[0]!.messageId).not.toBe(ping.id);
    // The follow-up rode on the direct burst: no detector call for it.
    expect(w.detector.calls).toEqual([]);
    expect(await reasons(w, "mina")).toEqual([]);
  });

  it("a typing event counts for 6 s: once it lapses without a message the wake fires", async () => {
    const w = await fakeTimers();
    await post(w, `<@${ELLA_BOT}> hey`, { mentions: { [ELLA_BOT]: "Ella" } });
    await advance(w, 1_000);
    typing(w, KEVIN);
    await advance(w, 5_900);
    expect(await reasons(w, "ella")).toEqual([]);
    await advance(w, 200);
    expect(await reasons(w, "ella")).toEqual(["mention"]);
  });

  it("a room burst is held at most 10 s from its first message, however long the author keeps typing", async () => {
    const w = await fakeTimers();
    await post(w, `<@${ELLA_BOT}> so`, { mentions: { [ELLA_BOT]: "Ella" } });
    for (let index = 0; index < 4; index += 1) {
      typing(w, KEVIN);
      await advance(w, 2_400);
    }
    expect(await reasons(w, "ella")).toEqual([]);
    typing(w, KEVIN);
    await advance(w, 500);
    expect(await reasons(w, "ella")).toEqual(["mention"]);
  });

  it("a DM is held while the person types, at most 60 s from their first message", async () => {
    const w = await fakeTimers();
    const dm = async (text: string) => {
      const message = w.discord.post(dmOf("ella"), text);
      await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    };
    await dm("hey");
    await advance(w, 2_000);
    dmTyping(w, KEVIN);
    await advance(w, 5_900);
    expect(await reasons(w, "ella")).toEqual([]);
    await advance(w, 200);
    expect(await reasons(w, "ella")).toEqual(["dm"]);
    // Typing on and off for over a minute: the cap wakes her at 60 s.
    await dm("so about that recipe");
    for (let index = 0; index < 12; index += 1) {
      dmTyping(w, KEVIN);
      await advance(w, 4_900);
    }
    expect(await reasons(w, "ella")).toEqual(["dm"]);
    dmTyping(w, KEVIN);
    await advance(w, 1_300);
    expect(await reasons(w, "ella")).toEqual(["dm", "dm"]);
  });

  it("typing by someone with no message in the burst, by a bot or by a waifu holds nothing", async () => {
    const w = await fakeTimers();
    await post(w, `<@${ELLA_BOT}> hi`, { mentions: { [ELLA_BOT]: "Ella" } });
    await advance(w, 1_000);
    typing(w, MINA_USER);
    typing(w, MINA_BOT, true);
    typing(w, ELLA_BOT, true);
    // Discord marks the typist as a bot: ignored even with Kevin's id.
    typing(w, KEVIN, true);
    // Typing in a DM does not hold a room burst.
    dmTyping(w, KEVIN);
    await advance(w, 600);
    expect(await reasons(w, "ella")).toEqual(["mention"]);
  });

  it("a waifu's message is never held, and a burst sent to the detector waits for its author's typing too", async () => {
    const w = await fakeTimers();
    await post(w, `<@${ELLA_BOT}> taste this`, { ...asMina, mentions: { [ELLA_BOT]: "Ella" } });
    // Routed at once, before any timer.
    expect(await reasons(w, "ella")).toEqual(["mention"]);
    w.detector.answer = { choice: "waifu_1", probabilities: { waifu_1: 1 } };
    await post(w, "anyone know a good frosting?");
    await advance(w, 1_000);
    typing(w, KEVIN);
    await advance(w, 3_000);
    expect(w.detector.calls).toEqual([]);
    await advance(w, 3_100);
    expect(w.detector.calls).toHaveLength(1);
  });
});

describe("addressee detector (§4.3)", () => {
  it("decides who speaks after a waifu: never her, the others as for a person; no fallback", async () => {
    const w = await world();
    // Mina's line is for Ella (the only candidate, waifu_0).
    w.detector.answer = { choice: "waifu_0", probabilities: { waifu_0: 1 } };
    await say(w, "what do you think, should we add cardamom?", asMina);
    expect(w.detector.calls.at(-1)!.candidates).toEqual(["ella"]);
    const [wake] = (await queued(w, "ella")).immediate;
    expect(wake).toMatchObject({ reason: "detector", waifuAuthored: true, fromUserId: MINA_BOT, fromName: "Mina" });
    // `all` and `anyone` never wake the author.
    w.detector.answer = { choice: "all", probabilities: { all: 1 } };
    await say(w, "you all should taste this", asMina);
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    await say(w, "anyone want some?", asMina);
    expect(await reasons(w, "mina")).toEqual([]);
    expect(await reasons(w, "ella")).toEqual(["detector", "detector", "detector"]);
    // A failed call wakes nobody for a waifu's burst (a person's would get the fallback).
    w.detector.answer = new Error("detector_http_500");
    await say(w, "anyone around?", asMina);
    expect(await reasons(w, "ella")).toHaveLength(3);
    const history = DetectorHistoryFileSchema.parse(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(w.root, "user/servers", GUILD, "detector-history.json"), "utf8")));
    expect(history.entries.map((entry) => [entry.choice, entry.authorWaifuId])).toEqual([
      ["waifu_0", "mina"],
      ["all", "mina"],
      ["anyone", "mina"],
      ["fallback:none", "mina"]
    ]);
  });

  it("detector wakes from a waifu's message respect the room loop guard when it is set", async () => {
    const w = await world({ config: (config) => ({ ...config, life: { ...config.life, maxWaifuTriggeredTurns: 1 } }) });
    w.detector.answer = { choice: "waifu_0", probabilities: { waifu_0: 1 } };
    await say(w, "tarts or cake?", asMina);
    await say(w, "seriously, tarts or cake?", asMina);
    expect(await reasons(w, "ella")).toEqual(["detector"]);
    w.detector.answer = { choice: "none", probabilities: { none: 1 } };
    await say(w, "lol");
    w.detector.answer = { choice: "waifu_0", probabilities: { waifu_0: 1 } };
    await say(w, "well?", asMina);
    expect(await reasons(w, "ella")).toEqual(["detector", "detector"]);
  });

  it("chime-in: with `human`, one awake waifu gets a soft wake, at most once per room every 10 minutes", async () => {
    const sleeping = { sleep: { enabled: true, start: "13:00", end: "15:00" }, busy: [] };
    const w = await world({ waifus: [TWO[0]!, { ...TWO[1]!, availability: sleeping }] });
    w.detector.answer = { choice: "human", probabilities: { human: 1 }, chimeIn: { choice: "waifu_0", probabilities: { waifu_0: 0.8, nobody: 0.2 } } };
    await say(w, "Sam what should I bake for my mom? she loves lemon");
    // Only the awake one is offered; the state says who is asleep.
    expect(w.detector.questions[0]).toEqual({ addressee: ["waifu_0", "waifu_1", "human", "anyone", "all", "none"], chime_in: ["waifu_0", "nobody"] });
    expect(JSON.parse(w.detector.states[0]!).cast.map((member: { availability: string }) => member.availability)).toEqual(["awake", "asleep"]);
    const [wake] = (await queued(w, "ella")).immediate;
    expect(wake).toMatchObject({ reason: "detector", chimeIn: true, fromName: "Kevin" });
    const view = { handle: () => "bake-club/#general", unread: () => undefined, timeZone: "UTC" };
    expect(renderNotifications({ wakes: [wake!] }, view)).toContain("- for someone else, you could chime in · bake-club/#general · from Kevin");
    // Within 10 minutes the question is not even asked.
    w.clock.advance(9 * 60_000);
    await say(w, "Sam also, lemon bars or lemon tarts?");
    expect(Object.keys(w.detector.questions[1]!)).toEqual(["addressee"]);
    expect(await reasons(w, "ella")).toEqual(["detector"]);
    // Past 10 minutes since the routed chime-in, again (the history remembers it after a restart).
    w.clock.advance(2 * 60_000);
    w.cast.intake["chimedAt"].clear();
    await say(w, "Sam ok last question, lemon curd from scratch?");
    expect(Object.keys(w.detector.questions[2]!)).toEqual(["addressee", "chime_in"]);
    expect(await reasons(w, "ella")).toEqual(["detector", "detector"]);
    // Another addressee than `human` never chimes in.
    w.clock.advance(11 * 60_000);
    w.detector.answer = { choice: "none", probabilities: { none: 1 }, chimeIn: { choice: "waifu_0", probabilities: { waifu_0: 1 } } };
    await say(w, "lol");
    expect(await reasons(w, "ella")).toHaveLength(2);
    const history = DetectorHistoryFileSchema.parse(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(w.root, "user/servers", GUILD, "detector-history.json"), "utf8")));
    expect(history.entries.map((entry) => entry.chimeIn?.woke ?? null)).toEqual(["ella", null, "ella", null]);
    expect(history.entries[0]).toMatchObject({ choice: "human", chimeIn: { choice: "waifu_0", probabilities: { waifu_0: 0.8 } } });
    expect(history.entries[0]!.woke).toBeUndefined();
  });

  it("chime-in never picks an asleep, watched or authoring waifu", async () => {
    const w = await world();
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: false, note: "lemons", when: [{ place: "bake-club/#general", words: ["lemon"] }] }]));
    w.detector.answer = { choice: "human", probabilities: { human: 1 }, chimeIn: { choice: "waifu_0", probabilities: { waifu_0: 1 } } };
    await say(w, "Sam where do you buy a lemon?");
    expect(await reasons(w, "ella")).toEqual(["watch"]);
    // A waifu's reply to a person: the other one may chime in, never the author.
    w.clock.advance(11 * 60_000);
    w.detector.answer = { choice: "human", probabilities: { human: 1 }, chimeIn: { choice: "waifu_0", probabilities: { waifu_0: 1 } } };
    await say(w, "Kevin, the trick is cold butter", asMina);
    expect(w.detector.calls.at(-1)!.candidates).toEqual(["ella"]);
    expect(await reasons(w, "ella")).toEqual(["watch", "detector"]);
    expect(await reasons(w, "mina")).toEqual([]);
  });

  it("maps waifu_<i> to her, anyone to a weighted draw, human/none to nothing, and keeps a history", async () => {
    const w = await world();
    w.detector.answer = { choice: "waifu_1", probabilities: { waifu_1: 0.9, none: 0.1 } };
    await say(w, "what do you think about lemon tarts");
    expect(w.detector.calls[0]).toEqual({ target: "openrouter:typesafe/jev-1.14", candidates: ["ella", "mina"] });
    expect(await reasons(w, "mina")).toEqual(["detector"]);
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    await say(w, "so who's baking saturday");
    expect((await reasons(w, "ella")).concat(await reasons(w, "mina"))).toEqual(["detector", "detector"]);
    w.detector.answer = { choice: "human", probabilities: { human: 1 } };
    await say(w, "kevin you there");
    expect((await queued(w, "ella")).immediate.length + (await queued(w, "mina")).immediate.length).toBe(2);
    const history = DetectorHistoryFileSchema.parse(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(w.root, "user/servers", GUILD, "detector-history.json"), "utf8")));
    expect(history.entries.map((entry) => entry.choice)).toEqual(["waifu_1", "anyone", "human"]);
    expect(history.entries[0]).toMatchObject({ channelId: CHANNEL, woke: ["mina"], probabilities: { waifu_1: 0.9 }, target: "openrouter:typesafe/jev-1.14" });
    expect(history.entries[2]!.woke).toBeUndefined();
  });

  it("all wakes the whole cast, staggered, as 'for all of you'; a watched waifu is skipped (D-c)", async () => {
    const w = await world({ options: { random: () => 0.5 } });
    const routes: Array<{ waifuId: string; stagger: boolean }> = [];
    const route = w.cast.router.route.bind(w.cast.router);
    vi.spyOn(w.cast.router, "route").mockImplementation((waifuId, wake, context = {}) => {
      routes.push({ waifuId, stagger: context.stagger === true });
      return route(waifuId, wake, { ...context, stagger: false });
    });
    w.detector.answer = { choice: "all", probabilities: { all: 0.8, anyone: 0.2 } };
    const asked = await say(w, "what can you all do");
    expect(routes).toEqual([
      { waifuId: "ella", stagger: true },
      { waifuId: "mina", stagger: true }
    ]);
    const [ella] = (await queued(w, "ella")).immediate;
    expect(ella).toMatchObject({ reason: "detector", forAll: true, messageId: asked.id });
    expect(await reasons(w, "mina")).toEqual(["detector"]);
    const view = { timeZone: "UTC", handle: () => "bake-club/#general", unread: () => undefined, ref: () => "a7" };
    expect(renderNotifications({ wakes: [ella!] }, view)).toContain('- for all of you · bake-club/#general · from Kevin · #a7 "what can you all do"');
    const history = DetectorHistoryFileSchema.parse(JSON.parse(await (await import("node:fs/promises")).readFile(path.join(w.root, "user/servers", GUILD, "detector-history.json"), "utf8")));
    expect(history.entries.at(-1)).toMatchObject({ choice: "all", woke: ["ella", "mina"] });
    // Her watch already woke Ella for the burst: only Mina gets the detector wake, never staggered alone.
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: false, note: "movies", when: [{ place: "bake-club/#general", words: ["movie"] }] }]));
    routes.length = 0;
    await say(w, "you two pick a movie for tonight");
    expect(routes).toEqual([
      { waifuId: "ella", stagger: false },
      { waifuId: "mina", stagger: false }
    ]);
    expect(await reasons(w, "ella")).toEqual(["detector", "watch"]);
    expect(await reasons(w, "mina")).toEqual(["detector", "detector"]);
  });

  it("the state marks a Discord reply with the author it answers", async () => {
    const w = await world();
    const hers = w.discord.post(ROOM, "hi Kevin, nice to meet you!", { authorId: MINA_BOT, authorName: "Mina", bot: true });
    await say(w, "lol", { replyTo: hers.id });
    await say(w, "nice to meet you too", { replyTo: (await say(w, "hello all")).id });
    const chat = JSON.parse(w.detector.states.at(-1)!).chronologicalChat as Array<{ text: string; replyTo?: string }>;
    expect(chat.find((line) => line.text === "nice to meet you too")).toMatchObject({ replyTo: "Kevin" });
    expect(chat.find((line) => line.text === "lol")).toMatchObject({ replyTo: "Mina" });
    expect(chat.find((line) => line.text === "hello all")).not.toHaveProperty("replyTo");
  });

  it("direct reasons anywhere in the burst skip the detector; a server override and no target are honoured", async () => {
    const w = await world();
    await say(w, "<@ella> hi", { mentions: { [ELLA_BOT]: "Ella" } });
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
    expect((await reasons(w, "ella")).length + (await reasons(w, "mina")).length).toBe(2);
  });

  it("a burst is direct when any message in it is, also one arriving after the mention (M9)", async () => {
    const w = await world();
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    for (const [text, o] of [
      [`<@${ELLA_BOT}> are you there`, { mentions: { [ELLA_BOT]: "Ella" } }],
      ["also what's for dinner?", {}]
    ] as const) {
      const message = w.discord.post(ROOM, text, o);
      await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella", "mina"], authorIsWaifu: false, raw: message });
    }
    await w.cast.settle();
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect(w.detector.calls).toEqual([]);
    expect(await reasons(w, "ella")).toEqual(["mention"]);
    expect(await reasons(w, "mina")).toEqual([]);
  });

  it("one wake per message: the detector skips a waifu her watch already woke for the burst; others can still be picked (D-c)", async () => {
    const w = await world();
    await writeHerFile(w, "watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: false, note: "brownies", when: [{ place: "bake-club/#general", words: ["brownie"] }] }]));
    // The detector picks her: she already has the watch wake, so nothing more.
    w.detector.answer = { choice: "waifu_0", probabilities: { waifu_0: 1 } };
    await say(w, "brownie emergency, help");
    expect(await reasons(w, "ella")).toEqual(["watch"]);
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
    expect((await queued(w, "ella")).immediate.every((wake) => wake.reason === "watch")).toBe(true);
  });

  it("unreadable forget records fail closed: previews hidden, no detector, an owner notice until repaired", async () => {
    const w = await world();
    w.detector.answer = { choice: "anyone", probabilities: { anyone: 1 } };
    const file = path.join(w.root, "user/people/forgotten.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"forgotten": [{"userId": "3000');
    await say(w, `<@${ELLA_BOT}> my secret is cardamom`, { mentions: { [ELLA_BOT]: "Ella" } });
    await say(w, "anyone around?");
    expect(w.detector.calls).toEqual([]);
    const [wake] = (await queued(w, "ella")).immediate;
    expect(wake).toMatchObject({ reason: "mention", fromName: "someone" });
    expect(JSON.stringify(wake)).not.toContain("cardamom");
    expect(w.cast.notices.list()).toEqual([expect.stringContaining("forgotten.json is unreadable")]);
    // A DM's preview and name are hidden too (review F11).
    const dm = w.discord.post(dmOf("ella"), "my other secret is saffron");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    const dmWake = (await queued(w, "ella")).immediate.find((entry) => entry.reason === "dm");
    expect(dmWake).toMatchObject({ fromName: "someone", preview: "(removed)" });
    expect(JSON.stringify(await queued(w, "ella"))).not.toContain("saffron");
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
    expect((await reasons(w, "ella")).length + (await reasons(w, "mina")).length).toBe(1);
    w.clock.advance(60_000);
    await say(w, "really lovely");
    expect((await reasons(w, "ella")).length + (await reasons(w, "mina")).length).toBe(1);
    w.clock.advance(60_000);
    await say(w, "should we bake?");
    expect((await reasons(w, "ella")).length + (await reasons(w, "mina")).length).toBe(2);
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
    await say(w, "<@ella> hi", { mentions: { [ELLA_BOT]: "Ella" } });
    expect(await reasons(w, "ella")).toEqual([]);
    paused = false;
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, paused: true })
    });
    await say(w, "<@ella> hi again", { mentions: { [ELLA_BOT]: "Ella" } });
    expect(await reasons(w, "ella")).toEqual([]);
  });

  it("2. a rate-limited DM user is dropped; the fixed limit notice goes out once per period", async () => {
    const w = await world({ waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", dm: { allowDms: true, rateLimit: { maxReplies: 2, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }] });
    const at = w.clock.now().toISOString();
    await updateDmLimit(w.storage, KEVIN, "ella", (current) => ({ ...current, replyTimestamps: [at, at] }));
    for (const text of ["hello?", "hello??"]) {
      const message = w.discord.post(dmOf("ella"), text);
      await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, channelId: "dm", messageId: message.id, createdAt: message.createdAt });
      w.cast.intake.flushDms();
      await w.cast.settle();
    }
    expect(await reasons(w, "ella")).toEqual([]);
    const notices = w.discord.sent.filter((sent) => sent.placeKey === `dm_${KEVIN}_ella`);
    expect(notices).toHaveLength(1);
    const limits = await (await import("../src/orchestration/dm/dmStore.js")).readDmLimit(w.storage, KEVIN, "ella");
    expect(limits.autoMessageIds).toEqual([notices[0]!.messageId]);
  });

  it("3. past the per-user wake limit, wakes become one merged quiet line", async () => {
    const w = await world({ config: (config) => ({ ...config, life: { ...config.life, maxWakesPerUserPerHour: 2 } }) });
    for (const text of ["<@ella> one", "<@ella> two", "<@ella> three", "<@ella> four"]) await say(w, text, { mentions: { [ELLA_BOT]: "Ella" } });
    const queue = await queued(w, "ella");
    expect(queue.immediate).toHaveLength(2);
    expect(queue.quiet).toEqual([{ userId: KEVIN, name: "Kevin", count: 2, placeKey: ROOM_KEY }]);
    // Another person is counted separately.
    await say(w, "<@ella> hi from mina", { authorId: MINA_USER, authorName: "Mina", mentions: { [ELLA_BOT]: "Ella" } });
    expect((await queued(w, "ella")).immediate).toHaveLength(3);
  });

  it("4. asleep: wakes are deferred (DMs too); the sleep notice goes once per window; the owner's wake goes through", async () => {
    const sleeping = { sleep: { enabled: true, start: "13:00", end: "15:00" }, busy: [] };
    const w = await world({
      waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", availability: sleeping, dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "zzz, I'll answer in the morning" } }]
    });
    await say(w, "<@ella> you up?", { mentions: { [ELLA_BOT]: "Ella" } });
    for (const text of ["psst", "still there?"]) {
      const message = w.discord.post(dmOf("ella"), text);
      await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, channelId: "dm", messageId: message.id, createdAt: message.createdAt });
      w.cast.intake.flushDms();
      await w.cast.settle();
    }
    const queue = await queued(w, "ella");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.reason).toBe("sleep");
    expect(queue.deferred.places[ROOM_KEY]).toMatchObject({ mentions: 1 });
    expect(queue.deferred.places[`dm_${KEVIN}_ella`]).toMatchObject({ dms: 2 });
    expect(w.discord.sent.map((sent) => sent.content)).toEqual(["zzz, I'll answer in the morning"]);
    expect(await w.cast.ownerWake("ella", "test")).toBe("queued");
    expect(await reasons(w, "ella")).toEqual(["owner"]);
  });

  it("5. over her daily budget: deferred to the next day; the owner's wake still goes through", async () => {
    const w = await world({ waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", life: { dailyBudgetUsd: 0.5 } }] });
    const day = w.clock.now().toISOString().slice(0, 10);
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${day}.jsonl`), `${JSON.stringify({ at: w.clock.now().toISOString(), waifuId: "ella", purpose: "life", costUsd: 0.6 })}\n`);
    await say(w, "<@ella> hi", { mentions: { [ELLA_BOT]: "Ella" } });
    const queue = await queued(w, "ella");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred.reason).toBe("budget");
    expect(await w.cast.ownerWake("ella")).toBe("queued");
  });

  it("6. the room loop guard (when set) stops waifu-authored wakes until a human speaks", async () => {
    const w = await world({ config: (config) => ({ ...config, life: { ...config.life, maxWaifuTriggeredTurns: 1 } }) });
    await say(w, "<@ella> one", { ...asMina, mentions: { [ELLA_BOT]: "Ella" } });
    await say(w, "<@ella> two", { ...asMina, mentions: { [ELLA_BOT]: "Ella" } });
    expect(await reasons(w, "ella")).toEqual(["mention"]);
    await say(w, "lol you two");
    await say(w, "<@ella> three", { ...asMina, mentions: { [ELLA_BOT]: "Ella" } });
    expect(await reasons(w, "ella")).toEqual(["mention", "mention"]);
  });

  it("combined guards apply in order: the first that matches decides", async () => {
    const sleeping = { sleep: { enabled: true, start: "13:00", end: "15:00" }, busy: [] };
    const w = await world({
      waifus: [
        {
          id: "ella",
          name: "Ella",
          botId: "ella-bot",
          availability: sleeping,
          life: { dailyBudgetUsd: 0.5 },
          dm: { allowDms: true, rateLimit: { maxReplies: 1, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "zzz" }
        }
      ],
      config: (config) => ({ ...config, life: { ...config.life, maxWakesPerUserPerHour: 1 } })
    });
    const day = w.clock.now().toISOString().slice(0, 10);
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${day}.jsonl`), `${JSON.stringify({ at: w.clock.now().toISOString(), waifuId: "ella", purpose: "life", costUsd: 0.6 })}\n`);
    // 2 before 4: a rate-limited DM user gets the limit notice, never the sleep notice; nothing is deferred.
    await updateDmLimit(w.storage, KEVIN, "ella", (current) => ({ ...current, replyTimestamps: [w.clock.now().toISOString()] }));
    const dm = w.discord.post(dmOf("ella"), "are you there?");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    expect(w.discord.sent.map((sent) => sent.content)).not.toContain("zzz");
    expect(w.discord.sent).toHaveLength(1);
    expect((await queued(w, "ella")).deferred.places[`dm_${KEVIN}_ella`]).toBeUndefined();
    // 4 before 5: asleep and over budget, a mention waits for her morning under "sleep".
    await say(w, "<@ella> one", { mentions: { [ELLA_BOT]: "Ella" } });
    let queue = await queued(w, "ella");
    expect(queue.deferred.reason).toBe("sleep");
    expect(queue.deferred.places[ROOM_KEY]).toMatchObject({ mentions: 1 });
    // 3 before 4: past the per-user limit the next mention is a quiet line, not another deferred one.
    await say(w, "<@ella> two", { mentions: { [ELLA_BOT]: "Ella" } });
    queue = await queued(w, "ella");
    expect(queue.deferred.places[ROOM_KEY]).toMatchObject({ mentions: 1 });
    expect(queue.quiet).toEqual([{ userId: KEVIN, name: "Kevin", count: 1, placeKey: ROOM_KEY }]);
    // 1 before everything, the owner's wake included: a paused server drops it.
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, paused: true })
    });
    expect(await w.cast.router.route("ella", { id: newWakeId(), reason: "owner", note: "x", at: w.clock.now().toISOString() }, { guildId: GUILD })).toBe("dropped");
    // Outside that server the owner skips 3–6: queued despite sleep, budget and the user limit.
    expect(await w.cast.ownerWake("ella", "test")).toBe("queued");
  });

  it("6. the loop guard counts each waifu message once, however many waifus it wakes (M16)", async () => {
    const w = await world({ config: (config) => ({ ...config, life: { ...config.life, maxWaifuTriggeredTurns: 1 } }) });
    const wake = (messageId: string) => ({ id: newWakeId(), reason: "mention" as const, placeKey: ROOM_KEY, waifuAuthored: true, messageId, fromUserId: MINA_BOT, fromName: "Mina", at: w.clock.now().toISOString() });
    // One message from a third waifu wakes both: one step of the loop.
    expect(await w.cast.router.route("ella", wake("900000000000000101"), { guildId: GUILD })).toBe("queued");
    expect(await w.cast.router.route("mina", wake("900000000000000101"), { guildId: GUILD })).toBe("queued");
    // The next waifu message is the second step: over the limit.
    expect(await w.cast.router.route("ella", wake("900000000000000102"), { guildId: GUILD })).toBe("dropped");
  });
});

describe("edits and deletes (§4.2, §10.3)", () => {
  it("an edit adding her mention to a fresh human message wakes her once; deletes of read messages become pending notices", async () => {
    const w = await world();
    const original = w.discord.post(ROOM, "who's bringing cake");
    const edited = { ...original, content: "who's bringing cake <@ella>", mentions: { ...original.mentions, users: { [ELLA_BOT]: "Ella" } } };
    const event = { type: "update" as const, conversation: ROOM, message: edited, previous: original, source: "gateway" as const };
    w.cast.onCacheEvent(event, async () => ["ella", "mina"]);
    w.cast.onCacheEvent(event, async () => ["ella", "mina"]);
    await w.cast.settle();
    expect(await reasons(w, "ella")).toEqual(["mention"]);
    // Too old: no wake.
    const old = w.discord.post(ROOM, "old one");
    w.clock.advance(3 * 60_000);
    w.cast.onCacheEvent({ ...event, message: { ...old, mentions: { ...old.mentions, users: { [ELLA_BOT]: "Ella" } } }, previous: old }, async () => ["ella"]);
    await w.cast.settle();
    expect(await reasons(w, "ella")).toEqual(["mention"]);

    await updateLifeState(w.storage, "ella", (state) => ({ ...state, readMessageIds: [original.id] }));
    w.cast.onCacheEvent({ type: "delete", conversation: ROOM, messageId: original.id, previous: original, source: "gateway" }, async () => ["ella"]);
    await w.cast.settle();
    const state = await (await import("../src/life/lifeStore.js")).readLifeState(w.storage, "ella");
    expect(state.deletedReadIds).toEqual([original.id]);
    expect(state.pendingNotices).toEqual(["(Kevin deleted a message you read in bake-club/#general)"]);
    // Pending notices never start a turn on their own.
    expect(await reasons(w, "ella")).toEqual(["mention"]);
  });

  it("the queue merges reasons for one place only past 200 entries", async () => {
    const w = await world();
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({
      ...queue,
      immediate: Array.from({ length: 200 }, (_, index) => ({ id: `w${index}`, reason: "mention" as const, placeKey: ROOM_KEY, at: w.clock.now().toISOString() }))
    }));
    await w.cast.router.routeNow("ella", { id: newWakeId(), reason: "watch", placeKey: ROOM_KEY, at: w.clock.now().toISOString() }, { guildId: GUILD });
    const queue = await queued(w, "ella");
    expect(queue.immediate).toHaveLength(200);
    expect(queue.immediate[0]).toMatchObject({ reasons: ["mention", "watch"], count: 2 });
  });
});
