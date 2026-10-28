// SendMessage scripts (Living cast spec §27): several messages in one call, checked whole before
// anything is sent, waits stopped by someone writing (not by typing), file-only sends, reply/attach
// binding, per-line intents, caps, the room-aware length nudge. Against a temp data root and the fake
// Discord; no live calls.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readIntents } from "../src/life/lifeStore.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { DEFAULT_APP_CONFIG } from "../src/shared/schemas/config.js";
import { CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, seedTranscript, tinyPng, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
// Several tests build more than one world: slow under full-suite load.
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function ctxFor(w: LifeWorld, o: { signal?: AbortSignal; intent?: boolean } = {}): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: o.signal ?? new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps),
    ...(o.intent ? { intent: { turnId: "turn-1", toolCallId: "call_1", tool: "SendMessage", argsDigest: "d" } } : {})
  };
}

const send = (script: string, ctx: ToolContext, place = "bake-club/#general"): Promise<ToolOutput> => lifeTool("SendMessage")!.run({ place, script }, ctx);
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));

/** A world whose sleeps run `during` (with the ms asked) instead of waiting. */
async function worldWithSleep(during: (w: LifeWorld, ms: number) => void, o: Parameters<typeof lifeWorld>[1] = {}): Promise<{ w: LifeWorld; sleeps: number[] }> {
  const sleeps: number[] = [];
  let world: LifeWorld | undefined;
  const w = await lifeWorld(roots, {
    ...o,
    options: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        if (world) during(world, ms);
      }
    }
  });
  world = w;
  return { w, sleeps };
}

describe("SendMessage scripts (§27.1)", () => {
  it("sends each m: line as its own message, typing before each, and reacts; the result lists the refs", async () => {
    const w = await lifeWorld(roots);
    const kevin = w.discord.post(ROOM, "who's baking");
    const ctx = await ctxFor(w);
    // Kevin's message gets its ref first (as a notification would give it).
    const first = text(await send("m: hi", ctx));
    expect(first).toMatch(/^sent #[0-9a-z]+$/u);
    const before = (await lifeTool("ReadMessages")!.run({ place: "bake-club/#general" }, ctx)).content as string;
    const kevinRef = /\[\d\d:\d\d #([0-9a-z]+)\] Kevin/u.exec(before)![1]!;
    w.discord.typing.length = 0;
    const result = text(await send(`m: brownies are ready\nm: come get them\nreply #${kevinRef}\nm: you asked\nreact #${kevinRef} 🎉`, ctx));
    expect(result).toMatch(new RegExp(`^sent #[0-9a-z]+ #[0-9a-z]+ #[0-9a-z]+, reacted to #${kevinRef}$`, "u"));
    expect(w.discord.sent.slice(1).map((entry) => entry.content)).toEqual(["brownies are ready", "come get them", "you asked"]);
    expect(w.discord.sent[3]!.replyToMessageId).toBe(kevin.id);
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL, CHANNEL]);
    expect(w.discord.reactions).toMatchObject([{ messageId: kevin.id, emoji: "🎉" }]);
    expect(ctx.turn.sends).toBe(4);
  });

  it("checks the whole script first: any error refuses it with its line number and nothing is sent", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(await send("m: one\nm: two\nreply #zz9\nm: three", ctx)).toEqual({ content: "error: line 3: #zz9: message too old; nothing was sent", isError: true });
    expect(await send("m: one\nattach ~/nothing-here.png", ctx)).toEqual({ content: "error: line 2: can't attach ~/nothing-here.png (it doesn't exist); nothing was sent", isError: true });
    expect(await send("m: one\nattach ~/MEMORY.md", ctx)).toMatchObject({ content: expect.stringMatching(/^error: line 2: can't attach ~\/MEMORY\.md \(your notes/u), isError: true });
    expect(await send("m: one\nreact #zz9 👍", ctx)).toMatchObject({ content: "error: line 2: #zz9: message too old; nothing was sent" });
    expect(await send("m: one\nm: SendMessage({\"place\": \"x\"})", ctx)).toMatchObject({ content: "error: line 2: that looks like a tool call, not a message; write what you want to say; nothing was sent" });
    expect(await send("m: hi\nwave", ctx)).toMatchObject({ isError: true, content: expect.stringMatching(/^error: line 2: not a command/u) });
    expect(w.discord.sent).toEqual([]);
    // A copied transcript header is stripped per line.
    expect(text(await send("m: [14:02 #k3] Ella: hello again", ctx))).toMatch(/^sent #/u);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["hello again"]);
    // The argument is required; an old call (text) still runs as one message.
    expect((await lifeTool("SendMessage")!.run({ place: "bake-club/#general" }, ctx)).isError).toBe(true);
    expect(text(await lifeTool("SendMessage")!.run({ place: "bake-club/#general", text: "the old way" }, ctx))).toMatch(/^sent #/u);
  });

  it("counts every send against life.maxSendsPerTurn (default 15) and refuses a script over it before sending", async () => {
    expect(DEFAULT_APP_CONFIG.life.maxSendsPerTurn).toBe(15);
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendsPerTurn: 3 } }) });
    const ctx = await ctxFor(w);
    expect(text(await send("m: a\nm: b", ctx))).toMatch(/^sent #\w+ #\w+$/u);
    expect(await send("m: c\nm: d", ctx)).toEqual({ content: "error: this script sends 2 messages, and you can send 1 more this turn; nothing was sent", isError: true });
    expect(text(await send("m: c", ctx))).toMatch(/^sent/u);
    expect(await send("m: e", ctx)).toEqual({ content: "error: you've already sent 3 messages this turn; wait for replies", isError: true });
    expect(w.discord.sent).toHaveLength(3);
  });

  it("a wait that someone else writes during stops the rest and shows what came in, with refs; typing doesn't stop it", async () => {
    const { w, sleeps } = await worldWithSleep((world, ms) => {
      if (ms === 5000) world.discord.post(ROOM, "wait what", { authorId: MINA_USER, authorName: "Mina" });
    });
    const ctx = await ctxFor(w);
    const result = await send("m: so\nwait 5\nm: Anyone here?\nm: hello?", ctx);
    expect(result.isError).toBeUndefined();
    const lines = text(result).split("\n");
    expect(lines[0]).toMatch(/^sent #[0-9a-z]+; stopped at line 2 \(wait 5\):$/u);
    expect(lines[1]).toMatch(/^- bake-club\/#general · from Mina · #[0-9a-z]+ "wait what"$/u);
    expect(lines.slice(2)).toEqual(["not sent: Anyone here?", "not sent: hello?"]);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["so"]);
    expect(sleeps).toContain(5000);
    expect(result.messageIds).toHaveLength(2);

    // Nobody writes (someone only types): the wait passes and the rest goes out.
    const { w: quiet } = await worldWithSleep((world, ms) => {
      if (ms === 3000) world.cast.onTyping({ kind: "guild", guildId: GUILD, channelId: CHANNEL, userId: KEVIN, bot: false });
    });
    const quietCtx = await ctxFor(quiet);
    expect(text(await send("m: so\nwait 3\nm: anyway", quietCtx))).toMatch(/^sent #\w+ #\w+$/u);
    // Her own messages never stop a wait.
    const { w: own } = await worldWithSleep((world, ms) => {
      if (ms === 2000) world.discord.post(ROOM, "me again", { authorId: "400000000000000004", authorName: "Ella", bot: true });
    });
    expect(text(await send("m: one\nwait 2\nm: two", await ctxFor(own)))).toMatch(/^sent #\w+ #\w+$/u);
  });

  it("typing lines show typing without sending; typing pacing runs before each m:", async () => {
    const { w, sleeps } = await worldWithSleep(() => undefined);
    const ctx = await ctxFor(w);
    expect(text(await send("typing 4\nm: hey", ctx))).toMatch(/^sent #/u);
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL]);
    expect(sleeps).toEqual([4000, 600]);
  });

  it("sends attach lines on their own as a file-only message, and those after an m: with it", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const home = path.join(w.root, "user", "waifus", "ella", "home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "cat.png"), tinyPng());
    const kevin = w.discord.post(ROOM, "show me");
    await lifeTool("ReadMessages")!.run({ place: "bake-club/#general" }, ctx);
    const ref = /#([0-9a-z]+)\] Kevin/u.exec((await lifeTool("ReadMessages")!.run({ place: "bake-club/#general" }, ctx)).content as string)![1]!;
    const result = text(await send(`attach ~/cat.png\nwait 5\nreply #${ref}\nm: Anyone here?\nattach ~/cat.png`, ctx));
    expect(result).toMatch(/^sent #\w+ #\w+$/u);
    expect(w.discord.sent).toMatchObject([
      { content: "", files: [{ name: "cat.png" }] },
      { content: "Anyone here?", replyToMessageId: kevin.id, files: [{ name: "cat.png" }] }
    ]);
    expect(w.discord.sent[0]!.replyToMessageId).toBeUndefined();
  });

  it("writes an intent and a done line per message; a Discord error stops the rest and says what was not sent", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w, { intent: true });
    w.discord.sendErrors.push(undefined, new Error("boom"));
    const result = await send("m: first\n\nm: second\nm: third", ctx);
    expect(text(result).split("\n")).toEqual([expect.stringMatching(/^sent #\w+; line 3 failed: the message could not be sent$/u), "not sent: second", "not sent: third"]);
    expect(result.isError).toBeUndefined();
    const intents = await readIntents(w.storage, "ella");
    expect(intents.map((intent) => ({ line: intent.line, lineDone: intent.lineDone, digest: intent.contentDigest !== undefined }))).toEqual([
      { line: 1, lineDone: undefined, digest: true },
      { line: 1, lineDone: true, digest: false }
    ]);
    expect(intents[1]!.resultRef).toBe(w.discord.sent[0]!.messageId);
    // The first line failing: an error, nothing went out.
    w.discord.sendErrors.push(new Error("boom"));
    expect(await send("m: a\nm: b", ctx)).toEqual({ content: "error: line 1: the message could not be sent; nothing was sent", isError: true });
  });

  it("an interrupted script sends nothing more and says what went out", async () => {
    const controller = new AbortController();
    const { w } = await worldWithSleep((_world, ms) => {
      if (ms === 10_000) controller.abort();
    });
    const ctx = await ctxFor(w, { signal: controller.signal });
    const result = await send("m: one\nwait 10\nm: two", ctx);
    expect(text(result).split("\n")).toEqual([expect.stringMatching(/^sent #\w+; interrupted at line 2$/u), "not sent: two"]);
    expect(w.discord.sent).toHaveLength(1);
  });

  it("refuses a second place when the turn already wrote in its maximum, and a paused server", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendPlacesPerTurn: 1 } }) });
    const ctx = await ctxFor(w);
    ctx.turn.sentPlaces.add("elsewhere");
    expect(await send("m: hi", ctx)).toEqual({ content: "error: you've already written in 1 places this turn", isError: true });
  });
});

describe("the room-aware length nudge (§27.2)", () => {
  const long = "x".repeat(180);

  it("says how long the line was against the median of the last 50 people's messages, from 10 of them", async () => {
    const w = await lifeWorld(roots);
    // 12 short lines from people, and long ones from a waifu that don't count.
    await seedTranscript(w, [
      ...Array.from({ length: 12 }, (_, index) => ({ text: `hey ${"y".repeat(16 + (index % 3))}`, minutesAgo: 40 - index })),
      ...Array.from({ length: 5 }, (_, index) => ({ text: "z".repeat(300), author: "Mina", authorId: "400000000000000005", waifu: "mina", minutesAgo: 20 - index }))
    ]);
    const ctx = await ctxFor(w);
    expect(text(await send(`m: short one\nm: ${long}`, ctx)).split("\n")).toEqual([expect.stringMatching(/^sent #\w+ #\w+$/u), "that line was 180 characters; people here usually write about 21"]);
    // Under the threshold (max(3 × 21, 120)): nothing added.
    expect(text(await send(`m: ${"x".repeat(119)}`, ctx))).toMatch(/^sent #\w+$/u);
  });

  it("needs at least 10 messages from people; a DM uses the other person", async () => {
    const w = await lifeWorld(roots);
    await seedTranscript(w, Array.from({ length: 9 }, () => ({ text: "short" })));
    const ctx = await ctxFor(w);
    expect(text(await send(`m: ${long}`, ctx))).toMatch(/^sent #\w+$/u);

    const v = await lifeWorld(roots);
    const message = v.discord.post(dmOf("ella"), "hi ella");
    await v.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    v.cast.intake.close();
    await seedTranscript(v, [
      ...Array.from({ length: 10 }, () => ({ text: "ok cool" })),
      ...Array.from({ length: 10 }, () => ({ text: "w".repeat(400), author: "Ella", authorId: "400000000000000004", waifu: "ella" }))
    ], { conversation: dmOf("ella") });
    const dmCtx = await ctxFor(v);
    expect(text(await send(`m: ${long}`, dmCtx, "dm/kevin")).split("\n")[1]).toBe("that line was 180 characters; people here usually write about 7");
  });
});

