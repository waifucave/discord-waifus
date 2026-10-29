// tools.send_message (Living cast spec §27, §32): several messages in one call, checked whole before
// anything is sent, waits stopped by someone writing (not by typing), file-only sends, reply/attach
// binding, plan and per-message intents, caps across a script's calls, the room-aware length nudge,
// and the §27 calls from before §32. Against a temp data root and the fake Discord; no live calls.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readIntents, readLifeLog, readLifeState } from "../src/life/lifeStore.js";
import { scanDmContent, viewLogLine } from "../src/life/lifeView.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import { textTurn } from "./modelFakes.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { DEFAULT_APP_CONFIG } from "../src/shared/schemas/config.js";
import { CHANNEL, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, script, seedTranscript, tinyPng, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { readMessages, receiptsOf, runScript, sendMessage, withoutReceipts } from "./toolCalls.js";
import { sendScriptWallMs } from "../src/life/tools/messages.js";
import { MAX_TYPING_DELAY_MS } from "../src/life/outbound.js";
import { notePlace } from "../src/life/placeRecorder.js";
import { DM_NAMED } from "../src/life/tools/script.js";

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

const send = (items: unknown[], ctx: ToolContext, place = "bake-club/#general"): Promise<ToolOutput> => sendMessage(ctx, place, items);
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
/** What a send_message call returned (its JSON, the receipts set aside). */
const result = (output: ToolOutput) =>
  JSON.parse(withoutReceipts(text(output))) as { sent: string[]; reactions: string[]; stopped?: { reason: string; next_index: number; incoming?: string[]; error?: string }; note?: string };
/** Her script's error, thrown by the call on line `line`. */
const thrown = (message: string, line = 1) => ({ content: `error: Error: tools.send_message: ${message} (line ${line})`, isError: true });

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

describe("tools.send_message (§27.1, §32.2)", () => {
  it("sends each text item as its own message, typing before each, and reacts; the result lists the refs", async () => {
    const w = await lifeWorld(roots);
    const kevin = w.discord.post(ROOM, "who's baking");
    const ctx = await ctxFor(w);
    // Kevin's message gets its ref first (as a notification would give it).
    expect(result(await send([{ text: "hi" }], ctx)).sent).toEqual([expect.stringMatching(/^#[0-9a-z]+$/u)]);
    const before = text(await readMessages(ctx, { place: "bake-club/#general" }));
    const kevinRef = /\[\d\d:\d\d #([0-9a-z]+)\] Kevin/u.exec(before)![1]!;
    w.discord.typing.length = 0;
    const out = result(await send([{ text: "brownies are ready" }, { text: "come get them" }, { text: "you asked", reply_to: `#${kevinRef}` }, { react: "🎉", to: `#${kevinRef}` }], ctx));
    expect(out).toEqual({ sent: [expect.stringMatching(/^#/u), expect.stringMatching(/^#/u), expect.stringMatching(/^#/u)], reactions: [`#${kevinRef}`] });
    expect(w.discord.sent.slice(1).map((entry) => entry.content)).toEqual(["brownies are ready", "come get them", "you asked"]);
    expect(w.discord.sent[3]!.replyToMessageId).toBe(kevin.id);
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL, CHANNEL]);
    expect(w.discord.reactions).toMatchObject([{ messageId: kevin.id, emoji: "🎉" }]);
    expect(ctx.turn.sends).toBe(4);
  });

  it("writes a receipt after her output for what went out, whatever her script did (§32.3a)", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    // No text(), then a throw: the receipt still says what was sent.
    const output = await runScript("SendMessage", 'await tools.send_message({ place: "bake-club/#general", messages: [{ text: "hi" }, { text: "again" }] });\nthrow new Error("oops")', ctx);
    expect(text(output).split("\n")).toEqual(["error: Error: oops (line 2)", expect.stringMatching(/^\[receipt\] send_message to bake-club\/#general: sent #\w+ #\w+; the whole list ran$/u)]);
    // An unawaited send is waited for: it goes out and gets its receipt.
    const unawaited = await runScript("SendMessage", 'tools.send_message({ place: "bake-club/#general", messages: [{ text: "later" }] }); return "bye"', ctx);
    expect(text(unawaited).split("\n")).toEqual(["bye", expect.stringMatching(/^\[receipt\] send_message to bake-club\/#general: sent #\w+; the whole list ran$/u)]);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["hi", "again", "later"]);
    // Sends to one place started together go out in call order.
    const together = await runScript("SendMessage", 'await Promise.all(["one", "two", "three"].map((t) => tools.send_message({ place: "bake-club/#general", messages: [{ text: t }] })))', ctx);
    expect(receiptsOf(text(together))).toHaveLength(3);
    expect(w.discord.sent.slice(3).map((entry) => entry.content)).toEqual(["one", "two", "three"]);
  });

  it("takes exactly one variant per item; attach is always a list", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(text(await send([{ text: "hi", wait: 2 }], ctx))).toBe('error: TypeError: messages[0]: unknown field "wait" here (it takes text, reply_to, attach) (line 1)');
    expect(text(await send([{}], ctx))).toBe("error: TypeError: messages[0] is { text, reply_to, attach }, { attach }, { react, to }, { wait } or { typing } (line 1)");
    expect(text(await send([{ react: "👍", to: "#a0", wait: 1 }], ctx))).toBe('error: TypeError: messages[0]: unknown field "wait" here (it takes react, to) (line 1)');
    expect(text(await send([{ text: "hi", attach: "~/cat.png" }], ctx))).toBe('error: TypeError: messages[0].attach is a list of paths in your folders, like ["~/cake.png"] (line 1)');
    expect(w.discord.sent).toEqual([]);
  });

  it("checks the whole call first: any error refuses it with its item and nothing of it is sent", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(await send([{ text: "one" }, { text: "two" }, { text: "three", reply_to: "#zz9" }], ctx)).toEqual(thrown("messages[2]: #zz9: message too old; nothing was sent"));
    expect(await send([{ text: "one" }, { attach: ["~/nothing-here.png"] }], ctx)).toEqual(thrown("messages[1]: can't attach ~/nothing-here.png (it doesn't exist); nothing was sent"));
    expect(text(await send([{ text: "one", attach: ["~/MEMORY.md"] }], ctx))).toMatch(/^error: Error: tools\.send_message: messages\[0\]: can't attach ~\/MEMORY\.md \(your notes/u);
    expect(await send([{ text: "one" }, { react: "👍", to: "#zz9" }], ctx)).toEqual(thrown("messages[1]: #zz9: message too old; nothing was sent"));
    expect(await send([{ text: "one" }, { text: 'SendMessage({"place": "x"})' }], ctx)).toEqual(thrown("messages[1]: that looks like a tool call, not a message; write what you want to say; nothing was sent"));
    expect(await send([{ text: "hi" }, { wave: true }], ctx)).toEqual({ content: "error: TypeError: messages[1] is { text, reply_to, attach }, { attach }, { react, to }, { wait } or { typing } (line 1)", isError: true });
    expect(await send([{ text: "hi", mood: "happy" }], ctx)).toEqual({ content: 'error: TypeError: messages[0]: unknown field "mood" here (it takes text, reply_to, attach) (line 1)', isError: true });
    expect(w.discord.sent).toEqual([]);
    // A copied transcript header is stripped per message.
    expect(result(await send([{ text: "[14:02 #k3] Ella: hello again" }], ctx)).sent).toHaveLength(1);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["hello again"]);
    // A later call's error leaves an earlier call's sends sent; her script sees both.
    const both = await runScript("SendMessage", 'const a = await tools.send_message({ place: "bake-club/#general", messages: [{ text: "first" }] });\ntext(a);\nawait tools.send_message({ place: "bake-club/#general", messages: [{ text: "x", reply_to: "#zz9" }] });', ctx);
    expect(text(both)).toMatch(/^\{"sent":\["#\w+"\],"reactions":\[\]\}\nerror: Error: tools\.send_message: messages\[0\]: #zz9: message too old; nothing was sent \(line 3\)\n\[receipt\] send_message to bake-club\/#general: sent #\w+; the whole list ran$/u);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["hello again", "first"]);
  });

  it("a call from before §32 still runs: a §27 script of lines and one text message", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(text(await lifeTool("SendMessage")!.run({ place: "bake-club/#general", script: "m: one\nm: two" }, ctx))).toMatch(/^sent #\w+ #\w+$/u);
    expect(await lifeTool("SendMessage")!.run({ place: "bake-club/#general", script: "m: hi\nwave" }, ctx)).toMatchObject({ isError: true, content: expect.stringMatching(/^error: line 2: not a command/u) });
    expect((await lifeTool("SendMessage")!.run({ place: "bake-club/#general" }, ctx)).isError).toBe(true);
    expect(text(await lifeTool("SendMessage")!.run({ place: "bake-club/#general", text: "the old way" }, ctx))).toMatch(/^sent #/u);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["one", "two", "the old way"]);
  });

  it("counts every send against life.maxSendsPerTurn (default 15) and refuses a call over it before sending", async () => {
    expect(DEFAULT_APP_CONFIG.life.maxSendsPerTurn).toBe(15);
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendsPerTurn: 3 } }) });
    const ctx = await ctxFor(w);
    expect(result(await send([{ text: "a" }, { text: "b" }], ctx)).sent).toHaveLength(2);
    expect(await send([{ text: "c" }, { text: "d" }], ctx)).toEqual(thrown("this script sends 2 messages, and you can send 1 more this turn; nothing was sent"));
    expect(result(await send([{ text: "c" }], ctx)).sent).toHaveLength(1);
    expect(await send([{ text: "e" }], ctx)).toEqual(thrown("you've already sent 3 messages this turn; wait for replies"));
    expect(w.discord.sent).toHaveLength(3);
    // Several calls in one script share the cap.
    const v = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendsPerTurn: 2 } }) });
    const vctx = await ctxFor(v);
    const many = text(await runScript("SendMessage", 'for (const t of ["a", "b", "c"]) text(await tools.send_message({ place: "bake-club/#general", messages: [{ text: t }] }));', vctx));
    expect(withoutReceipts(many)).toMatch(/error: Error: tools\.send_message: you.ve already sent 2 messages this turn; wait for replies \(line 1\)$/u);
    expect(v.discord.sent).toHaveLength(2);
  });

  it("a wait that someone else writes during stops the rest and shows what came in, with refs; typing doesn't stop it", async () => {
    const { w, sleeps } = await worldWithSleep((world, ms) => {
      if (ms === 5000) world.discord.post(ROOM, "wait what", { authorId: MINA_USER, authorName: "Mina" });
    });
    const ctx = await ctxFor(w);
    const output = await send([{ text: "so" }, { wait: 5 }, { text: "Anyone here?" }, { text: "hello?" }], ctx);
    expect(output.isError).toBeUndefined();
    const out = result(output);
    expect(out.sent).toHaveLength(1);
    expect(out.stopped).toEqual({ reason: "new_message", next_index: 2, incoming: [expect.stringMatching(/^- bake-club\/#general · from Mina · #[0-9a-z]+ "wait what"$/u)] });
    expect(output.receipts).toEqual([expect.stringMatching(/^send_message to bake-club\/#general: sent #\w+; stopped \(someone wrote during the wait\): messages\[2\] and after were not sent$/u)]);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["so"]);
    expect(sleeps).toContain(5000);
    expect(output.messageIds).toHaveLength(2);

    // Nobody writes (someone only types): the wait passes and the rest goes out.
    const { w: quiet } = await worldWithSleep((world, ms) => {
      if (ms === 3000) world.cast.onTyping({ kind: "guild", guildId: GUILD, channelId: CHANNEL, userId: KEVIN, bot: false });
    });
    expect(result(await send([{ text: "so" }, { wait: 3 }, { text: "anyway" }], await ctxFor(quiet))).sent).toHaveLength(2);
    // Her own messages never stop a wait.
    const { w: own } = await worldWithSleep((world, ms) => {
      if (ms === 2000) world.discord.post(ROOM, "me again", { authorId: "400000000000000004", authorName: "Ella", bot: true });
    });
    expect(result(await send([{ text: "one" }, { wait: 2 }, { text: "two" }], await ctxFor(own))).sent).toHaveLength(2);
  });

  it("waits and typing are at most 120 seconds in one script, across its calls", async () => {
    const { w, sleeps } = await worldWithSleep(() => undefined);
    const ctx = await ctxFor(w);
    const over = await send([{ text: "a" }, { wait: 60 }, { wait: 60 }, { typing: 1 }], ctx);
    expect(text(over)).toMatch(/^error: (RangeError|Error): /u);
    expect(text(over)).toContain("120");
    expect(w.discord.sent).toEqual([]);
    const twoCalls = text(
      await runScript(
        "SendMessage",
        'text(await tools.send_message({ place: "bake-club/#general", messages: [{ wait: 60 }, { text: "a" }] }));\ntext(await tools.send_message({ place: "bake-club/#general", messages: [{ wait: 60 }, { text: "b" }, { typing: 1 }] }));',
        ctx
      )
    );
    expect(withoutReceipts(twoCalls)).toMatch(/^\{"sent":\["#\w+"\],"reactions":\[\]\}\nerror: RangeError: tools\.send_message: waiting and typing add up to 121 seconds in this script; at most 120 \(line 2\)$/u);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["a"]);
    expect(sleeps.filter((ms) => ms === 60_000)).toHaveLength(1);
  });

  it("typing items show typing without sending; typing pacing runs before each message", async () => {
    const { w, sleeps } = await worldWithSleep(() => undefined);
    const ctx = await ctxFor(w);
    expect(result(await send([{ typing: 4 }, { text: "hey" }], ctx)).sent).toHaveLength(1);
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL]);
    expect(sleeps).toEqual([4000, 600]);
  });

  it("sends an attach item on its own as a file-only message, and a text item's attach with it", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const home = path.join(w.root, "user", "waifus", "ella", "home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "cat.png"), tinyPng());
    const kevin = w.discord.post(ROOM, "show me");
    const ref = /#([0-9a-z]+)\] Kevin/u.exec(text(await readMessages(ctx, { place: "bake-club/#general" })))![1]!;
    const out = result(await send([{ attach: ["~/cat.png"] }, { wait: 5 }, { text: "Anyone here?", reply_to: `#${ref}`, attach: ["~/cat.png"] }], ctx));
    expect(out.sent).toHaveLength(2);
    expect(w.discord.sent).toMatchObject([
      { content: "", files: [{ name: "cat.png" }] },
      { content: "Anyone here?", replyToMessageId: kevin.id, files: [{ name: "cat.png" }] }
    ]);
    expect(w.discord.sent[0]!.replyToMessageId).toBeUndefined();
  });

  it("writes a plan intent, one per message and a call done line; a Discord error stops the rest and says what was not sent", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w, { intent: true });
    w.discord.sendErrors.push(undefined, new Error("boom"));
    const output = await send([{ text: "first" }, { text: "second" }, { text: "third" }], ctx);
    expect(output.isError).toBeUndefined();
    expect(result(output)).toEqual({ sent: [expect.stringMatching(/^#\w+$/u)], reactions: [], stopped: { reason: "send_failed", next_index: 1, error: "the message could not be sent" } });
    const intents = await readIntents(w.storage, "ella");
    expect(intents.map((intent) => ({ plan: intent.plan?.sends.map((send) => [send.line, send.text]), line: intent.line, lineDone: intent.lineDone, callDone: intent.callDone }))).toEqual([
      { plan: [[1, "first"], [2, "second"], [3, "third"]], line: undefined, lineDone: undefined, callDone: undefined },
      { plan: undefined, line: 1, lineDone: undefined, callDone: undefined },
      { plan: undefined, line: 1, lineDone: true, callDone: undefined },
      { plan: undefined, line: undefined, lineDone: undefined, callDone: 1 }
    ]);
    expect(intents[2]!.resultRef).toBe(w.discord.sent[0]!.messageId);
    // The first message failing: an error, nothing went out.
    w.discord.sendErrors.push(new Error("boom"));
    expect(await send([{ text: "a" }, { text: "b" }], ctx)).toEqual(thrown("messages[0]: the message could not be sent; nothing was sent"));
  });

  it("an interrupted script sends nothing more and says what went out", async () => {
    const controller = new AbortController();
    const { w } = await worldWithSleep((_world, ms) => {
      if (ms === 10_000) controller.abort();
    });
    const ctx = await ctxFor(w, { signal: controller.signal });
    const output = await send([{ text: "one" }, { wait: 10 }, { text: "two" }], ctx);
    expect(text(output)).toMatch(/interrupted/u);
    expect(w.discord.sent).toHaveLength(1);
  });

  it("a server paused during a wait or a typing item stops the rest: you can't post there (review)", async () => {
    const pause = async (world: LifeWorld) =>
      world.storage.updateRevisionedJson({
        resourceKey: `server:${GUILD}`,
        relativePath: `user/servers/${GUILD}/server.json`,
        schema: ServerConfigSchema,
        fallback: undefined as never,
        transform: (server) => ({ ...server, paused: true })
      });
    let pending: Promise<unknown> | undefined;
    const { w } = await worldWithSleep((world, ms) => {
      if (ms === 3000) pending = pause(world);
    });
    // The sleep hook can't await: the pause is written before the next item runs.
    const ctx = await ctxFor(w);
    const original = w.cast.deps.sleep;
    w.cast.deps.sleep = async (ms, signal) => {
      await original(ms, signal);
      await pending;
    };
    const out = result(await send([{ text: "one" }, { wait: 3 }, { text: "two" }, { text: "three" }], ctx));
    expect(out).toEqual({ sent: [expect.stringMatching(/^#\w+$/u)], reactions: [], stopped: { reason: "send_failed", next_index: 2, error: "you can't post there" } });
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["one"]);

    // Nothing sent before the pause: an error, nothing went out.
    const { w: v } = await worldWithSleep((world, ms) => {
      if (ms === 2000) pending = pause(world);
    });
    const vctx = await ctxFor(v);
    const vOriginal = v.cast.deps.sleep;
    v.cast.deps.sleep = async (ms, signal) => {
      await vOriginal(ms, signal);
      await pending;
    };
    expect(await send([{ typing: 2 }, { text: "two" }], vctx)).toEqual(thrown("messages[1]: you can't post there; nothing was sent"));
    expect(v.discord.sent).toEqual([]);
  });

  it("a DM script refused for a bad item, or that doesn't parse, is still a DM call: hidden in her life views and /print life (D14, review)", async () => {
    const bad = 'await tools.send_message({ place: "dm/kevin", messages: [{ text: "SECRET-LINE about the divorce" }, { wave: "hello" }] })';
    const broken = 'await tools.send_message({ place: "dm/kevin", messages: [{ text: "SECRET-TWO about the divorce" }] ';
    const w = await lifeWorld(roots, {
      scripts: script(
        textTurn("(read it)"),
        toolTurn([{ name: "SendMessage", input: { script: bad } }]),
        toolTurn([{ name: "SendMessage", input: { script: broken } }]),
        textTurn("(oops)")
      )
    });
    // Kevin DMed her before (the DM is hers), in a turn of its own.
    const dm = w.discord.post(dmOf("ella"), "hi ella");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await w.cast.life("ella").runNow();
    // A room mention wakes the next turn, where she writes to the DM with a bad item, then a script that doesn't parse.
    const message = w.discord.post(ROOM, `<@${ELLA_BOT}> you there?`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
    await w.cast.settle();
    w.cast.intake.flushDetector();
    await w.cast.settle();
    await w.cast.life("ella").runNow();
    const lines = await readLifeLog(w.storage, "ella", (await readLifeState(w.storage, "ella")).epoch);
    const results = lines.filter((entry) => entry.kind === "tool_results" && JSON.stringify(entry.message).includes("SendMessage"));
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results[0]!.message)).toContain("messages[1] is { text, reply_to, attach }");
    expect(JSON.stringify(results[1]!.message)).toContain("SyntaxError");
    for (const entry of results) expect(entry.dmCalls).toHaveLength(1);
    const scan = scanDmContent(lines);
    const view = JSON.stringify(lines.map((entry) => viewLogLine(entry, scan, { includePrivate: false }).view));
    expect(view).not.toContain("SECRET-LINE");
    expect(view).not.toContain("SECRET-TWO");
    const printed = await w.cast.printLife("ella");
    expect(printed).not.toContain("SECRET-LINE");
    expect(printed).not.toContain("SECRET-TWO");
    expect(printed).toContain("SendMessage([private chat redacted])");
    expect(w.discord.sent).toEqual([]);
  });

  it("a DM call that throws still records its places: hidden in her life views (D14, review)", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(toolTurn([{ name: "SendMessage", input: { script: 'await tools.send_message({ place: "dm/kevin", messages: [{ text: "SECRET-THREE" }] })' } }]), textTurn("(hm)"))
    });
    const tool = lifeTool("SendMessage")!;
    // A tool that named a DM, then failed outside her script (a worker that didn't start, say).
    const spy = vi.spyOn(tool, "run").mockImplementation(async () => {
      notePlace(DM_NAMED);
      throw new Error("worker failed to start");
    });
    try {
      const message = w.discord.post(ROOM, `<@${ELLA_BOT}> you there?`, { mentions: { [ELLA_BOT]: "Ella" } });
      await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
      await w.cast.settle();
      w.cast.intake.flushDetector();
      await w.cast.settle();
      await w.cast.life("ella").runNow();
    } finally {
      spy.mockRestore();
    }
    const lines = await readLifeLog(w.storage, "ella", (await readLifeState(w.storage, "ella")).epoch);
    const results = lines.filter((entry) => entry.kind === "tool_results" && JSON.stringify(entry.message).includes("something went wrong"));
    expect(results).toHaveLength(1);
    expect(results[0]!.dmCalls).toHaveLength(1);
    const scan = scanDmContent(lines);
    const view = JSON.stringify(lines.map((entry) => viewLogLine(entry, scan, { includePrivate: false }).view));
    expect(view).not.toContain("SECRET-THREE");
  });

  it("refuses a second place when the turn already wrote in its maximum", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendPlacesPerTurn: 1 } }) });
    const ctx = await ctxFor(w);
    ctx.turn.sentPlaces.add("elsewhere");
    expect(await send([{ text: "hi" }], ctx)).toEqual(thrown("you've already written in 1 places this turn"));
  });

  it("the wall clock covers 120 s of waits plus the typing before every allowed send (review)", () => {
    // 120 s + 15 × 4.5 s + 30 s: a script within its caps is never cut off part way.
    expect(sendScriptWallMs(15)).toBe(217_500);
    expect(sendScriptWallMs(15)).toBeGreaterThan(120_000 + 15 * MAX_TYPING_DELAY_MS);
  });

  it("once the script is stopped, the call in progress sends nothing more and a queued call never starts (review)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const { w } = await worldWithSleep((_world, ms) => {
        // Her script's wall clock runs out during the wait (the turn itself is not aborted).
        if (ms === 60_000) vi.advanceTimersByTime(sendScriptWallMs(15) + 1_000);
      });
      const ctx = await ctxFor(w);
      const output = text(
        await runScript(
          "SendMessage",
          'const a = tools.send_message({ place: "bake-club/#general", messages: [{ text: "one" }, { wait: 60 }, { text: "two" }] });\nconst b = tools.send_message({ place: "bake-club/#general", messages: [{ text: "three" }] });\nawait a;\nawait b;',
          ctx
        )
      );
      expect(ctx.signal.aborted).toBe(false);
      expect(output).toContain("was stopped");
      expect(w.discord.sent.map((entry) => entry.content)).toEqual(["one"]);
      // What did go out still reaches her receipts.
      expect(receiptsOf(output).join("\n")).toMatch(/send_message to bake-club\/#general: sent #\w+/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a call after the first looks again: a pause since the first call refuses it (review)", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const paused = w.cast.deps.isPaused;
    w.cast.deps.isPaused = () => w.discord.sent.length > 0 || paused();
    const output = text(
      await runScript(
        "SendMessage",
        'text(await tools.send_message({ place: "bake-club/#general", messages: [{ text: "one" }] }));\ntext(await tools.send_message({ place: "bake-club/#general", messages: [{ text: "two" }] }));',
        ctx
      )
    );
    expect(withoutReceipts(output)).toMatch(/^\{"sent":\["#\w+"\],"reactions":\[\]\}\nerror: Error: tools\.send_message: you can't post there \(line 2\)$/u);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["one"]);

    // A server paused between two calls (no wait in either): the second call sees it.
    const v = await lifeWorld(roots);
    const vctx = await ctxFor(v);
    let pending: Promise<unknown> | undefined;
    const sendOriginal = v.discord.sendWaifuMessage.bind(v.discord);
    v.discord.sendWaifuMessage = async (...args: Parameters<typeof v.discord.sendWaifuMessage>) => {
      const sent = await sendOriginal(...args);
      pending ??= v.storage.updateRevisionedJson({
        resourceKey: `server:${GUILD}`,
        relativePath: `user/servers/${GUILD}/server.json`,
        schema: ServerConfigSchema,
        fallback: undefined as never,
        transform: (server) => ({ ...server, paused: true })
      });
      await pending;
      return sent;
    };
    const vOutput = text(
      await runScript(
        "SendMessage",
        'text(await tools.send_message({ place: "bake-club/#general", messages: [{ text: "one" }] }));\ntext(await tools.send_message({ place: "bake-club/#general", messages: [{ text: "two" }] }));',
        vctx
      )
    );
    expect(withoutReceipts(vOutput)).toMatch(/\nerror: Error: tools\.send_message: you can't post there.* \(line 2\)$/u);
    expect(v.discord.sent.map((entry) => entry.content)).toEqual(["one"]);
  });

  it("a storage error after Discord took a message never loses it: the result and receipt still list it (review)", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w, { intent: true });
    const withLocks = w.storage.withLocks.bind(w.storage);
    vi.spyOn(w.storage, "withLocks").mockImplementation(async (keys, task) => {
      if (w.discord.sent.length > 0 && keys.some((key) => key.startsWith("life-reads:"))) throw new Error("disk full");
      return withLocks(keys, task);
    });
    const output = text(await send([{ text: "first" }, { text: "second" }], ctx));
    expect(output).not.toContain("didn't work");
    expect(result({ content: output }).sent).toEqual([expect.stringMatching(/^#\w+$/u), expect.stringMatching(/^#\w+$/u)]);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["first", "second"]);
  });
});

describe("the room-aware length nudge (§27.2)", () => {
  const long = "x".repeat(180);

  it("says how long the message was against the median of the last 50 people's messages, from 10 of them", async () => {
    const w = await lifeWorld(roots);
    // 12 short lines from people, and long ones from a waifu that don't count.
    await seedTranscript(w, [
      ...Array.from({ length: 12 }, (_, index) => ({ text: `hey ${"y".repeat(16 + (index % 3))}`, minutesAgo: 40 - index })),
      ...Array.from({ length: 5 }, (_, index) => ({ text: "z".repeat(300), author: "Mina", authorId: "400000000000000005", waifu: "mina", minutesAgo: 20 - index }))
    ]);
    const ctx = await ctxFor(w);
    expect(result(await send([{ text: "short one" }, { text: long }], ctx)).note).toBe("that line was 180 characters; people here usually write about 21");
    // Under the threshold (max(3 × 21, 120)): nothing added.
    expect(result(await send([{ text: "x".repeat(119) }], ctx)).note).toBeUndefined();
  });

  it("needs at least 10 messages from people; a DM uses the other person", async () => {
    const w = await lifeWorld(roots);
    await seedTranscript(w, Array.from({ length: 9 }, () => ({ text: "short" })));
    const ctx = await ctxFor(w);
    expect(result(await send([{ text: long }], ctx)).note).toBeUndefined();

    const v = await lifeWorld(roots);
    const message = v.discord.post(dmOf("ella"), "hi ella");
    await v.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    v.cast.intake.close();
    await seedTranscript(v, [
      ...Array.from({ length: 10 }, () => ({ text: "ok cool" })),
      ...Array.from({ length: 10 }, () => ({ text: "w".repeat(400), author: "Ella", authorId: "400000000000000004", waifu: "ella" }))
    ], { conversation: dmOf("ella") });
    const dmCtx = await ctxFor(v);
    expect(result(await send([{ text: long }], dmCtx, "dm/kevin")).note).toBe("that line was 180 characters; people here usually write about 7");
  });
});
