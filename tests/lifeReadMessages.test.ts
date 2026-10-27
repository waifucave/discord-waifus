// ReadMessages v2 (Living cast spec §22): refs given at ingest and stored on transcript lines, a
// pruned ref still resolving through the transcript (ReadMessages, SendMessage reply_to, React), the
// freeform query (grammar, anchors, ranges, max), several places at once, and people: / search: over
// her transcripts (access intervals, everywhere, D14). Temp data roots, fake Discord; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { snowflakeAt, snowflakeTime } from "../src/discord/refStore.js";
import { selfAuthorIds } from "../src/life/people.js";
import { withPlaceRecord } from "../src/life/placeRecorder.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import { matchesSearch, parseReadQuery, QUERY_SYNTAX } from "../src/life/tools/readQuery.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { readTranscriptDay, settleTranscripts, updateTranscriptAccess } from "../src/life/transcripts/store.js";
import { conversationKey, conversationRefsPath, type ConversationRef } from "../src/orchestration/context/keys.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { ConversationRefsSchema } from "../src/shared/schemas/context.js";
import { CHANNEL_2, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await settleTranscripts();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const RECIPES: ConversationRef = { kind: "guild", guildId: GUILD, channelId: CHANNEL_2 };
const TZ = "UTC";
const NOW = new Date("2026-10-24T14:00:00.000Z");

async function ctxFor(w: LifeWorld): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps)
  };
}

const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));

async function read(w: LifeWorld, place: string, query?: string): Promise<ToolOutput> {
  return lifeTool("ReadMessages")!.run({ place, ...(query !== undefined ? { query } : {}) }, await ctxFor(w));
}

/** Messages a minute apart, by Kevin and Mina in turn; returns them. */
function postMinutes(w: LifeWorld, place: ConversationRef, texts: string[]) {
  return texts.map((content, index) => {
    w.clock.advance(59_000);
    return w.discord.post(place, content, index % 2 ? { authorId: MINA_USER, authorName: "Mina" } : {});
  });
}

/** The ref of the line whose text ends with `body`. */
function refOf(output: string, body: string): string {
  const line = output.split("\n").find((entry) => entry.endsWith(body));
  return /#([0-9a-z]+)\]/u.exec(line ?? "")?.[1] ?? "";
}

function bodies(output: string): string[] {
  return output.split("\n").filter((line) => line.startsWith("[")).map((line) => line.replace(/^\[[^\]]*\] /u, ""));
}

describe("the query grammar (§22.2)", () => {
  const parse = (query: string) => parseReadQuery(query, { now: NOW, timeZone: TZ });

  it("reads each term, in any order, `key:value` or `key value`, any case", () => {
    expect(parse("")).toEqual({ ok: true, query: {} });
    expect(parse("before #K3")).toEqual({ ok: true, query: { before: { kind: "ref", ref: "k3" } } });
    expect(parse("max 10 AFTER:2026-10-23 17:02")).toEqual({ ok: true, query: { max: 10, after: { kind: "time", at: new Date("2026-10-23T17:02:00.000Z") } } });
    expect(parse("around 09:30")).toEqual({ ok: true, query: { around: { kind: "time", at: new Date("2026-10-24T09:30:00.000Z") } } });
    expect(parse("around yesterday 23:10")).toEqual({ ok: true, query: { around: { kind: "time", at: new Date("2026-10-23T23:10:00.000Z") } } });
    expect(parse("around 2026-10-20")).toMatchObject({ ok: true, query: { around: { kind: "day", day: "2026-10-20", start: new Date("2026-10-20T00:00:00.000Z"), end: new Date("2026-10-21T00:00:00.000Z") } } });
    expect(parse("people:Evgueny, Léa search:London restaurant, sushi")).toEqual({ ok: true, query: { people: ["evgueny", "lea"], search: [["london", "restaurant"], ["sushi"]] } });
    // Inside a search, "before" is a word unless it starts a term.
    expect(parse("search:meet before lunch max:5")).toEqual({ ok: true, query: { search: [["meet", "before", "lunch"]], max: 5 } });
    expect(parse("search:meet before #k3")).toEqual({ ok: true, query: { search: [["meet"]], before: { kind: "ref", ref: "k3" } } });
    expect(parse("after #a1 before #a9")).toEqual({ ok: true, query: { after: { kind: "ref", ref: "a1" }, before: { kind: "ref", ref: "a9" } } });
  });

  it("refuses what it can't read, with the syntax and an example", () => {
    for (const [query, problem] of [
      ["hello", '"hello" is not a query term'],
      ["max:0", "max must be a whole number from 1 to 100"],
      ["max:101", "max must be a whole number from 1 to 100"],
      ["max:2 max:3", "max is given twice"],
      ["around #k3 before #k1", "around can't be combined with before or after"],
      ["after 2026-10-26 before 2026-10-25", "the range is empty"],
      ["before tomorrow", '"tomorrow" is not an anchor for before'],
      ["people:", "people needs a value"]
    ] as const) {
      const result = parse(query);
      expect(result.ok, query).toBe(false);
      if (!result.ok) {
        expect(result.error, query).toContain(problem);
        expect(result.error.endsWith(QUERY_SYNTAX), query).toBe(true);
        expect(QUERY_SYNTAX.split("\n")).toHaveLength(3);
      }
    }
  });

  it("matches whole words, case- and accent-insensitively; any alternative, every word of it", () => {
    expect(matchesSearch("Dinner at the CAFÉ in London", [["cafe", "london"]])).toBe(true);
    expect(matchesSearch("Dinner in London", [["cafe", "london"], ["dinner"]])).toBe(true);
    expect(matchesSearch("Londoner", [["london"]])).toBe(false);
  });

  it("turns a time into the first snowflake of that millisecond", () => {
    const ms = Date.parse("2026-10-25T17:02:00.000Z");
    expect(snowflakeTime(snowflakeAt(ms))).toBe(ms);
    expect(BigInt(snowflakeAt(ms + 1))).toBeGreaterThan(BigInt(snowflakeAt(ms)));
  });
});

describe("pages: before, after, around, ranges and several places (§22.2)", () => {
  async function twenty(): Promise<{ w: LifeWorld; all: string }> {
    const w = await lifeWorld(roots);
    postMinutes(w, ROOM, Array.from({ length: 20 }, (_, index) => `message ${index + 1}`));
    const all = text(await read(w, "bake-club/#general", "max:20"));
    return { w, all };
  }

  it("the latest 15 by default, with the hint to read before; a #ref anchor is included", async () => {
    const { w, all } = await twenty();
    const latest = text(await read(w, "bake-club/#general"));
    expect(bodies(latest)).toHaveLength(15);
    expect(latest.split("\n")[1]).toBe(`— more before: before #${refOf(all, "message 6")} —`);
    const before = text(await read(w, "bake-club/#general", `before #${refOf(all, "message 10")} max:3`));
    expect(bodies(before)).toEqual(["Kevin: message 7", "Mina: message 8", "Kevin: message 9", "Mina: message 10"]);
    const after = text(await read(w, "bake-club/#general", `after #${refOf(all, "message 5")} max:3`));
    expect(bodies(after)).toEqual(["Kevin: message 5", "Mina: message 6", "Kevin: message 7", "Mina: message 8"]);
    expect(after.split("\n").at(-1)).toBe(`— more after: after #${refOf(all, "message 8")} —`);
    const around = text(await read(w, "bake-club/#general", `around #${refOf(all, "message 10")} max:5`));
    expect(bodies(around)).toEqual(["Mina: message 8", "Kevin: message 9", "Mina: message 10", "Kevin: message 11", "Mina: message 12"]);
    expect(around).toContain("— more before:");
    expect(around).toContain("— more after:");
  });

  it("a range between two anchors (up to 50 without max), times and days her local time", async () => {
    const { w, all } = await twenty();
    const range = text(await read(w, "bake-club/#general", `after #${refOf(all, "message 3")} before #${refOf(all, "message 6")}`));
    expect(bodies(range)).toEqual(["Kevin: message 3", "Mina: message 4", "Kevin: message 5", "Mina: message 6"]);
    // message n was posted at 14:0n (a minute apart from 14:01).
    const beforeTime = text(await read(w, "bake-club/#general", "before 14:04"));
    expect(bodies(beforeTime)).toEqual(["Kevin: message 1", "Mina: message 2", "Kevin: message 3"]);
    const afterTime = text(await read(w, "bake-club/#general", "after 14:18"));
    expect(bodies(afterTime)).toEqual(["Mina: message 18", "Kevin: message 19", "Mina: message 20"]);
    expect(bodies(text(await read(w, "bake-club/#general", "around 2026-10-24")))).toHaveLength(20);
    expect(text(await read(w, "bake-club/#general", "before 2026-10-24"))).toContain("(no messages)");
    expect(bodies(text(await read(w, "bake-club/#general", "after 14:05 before 14:08 max:2")))).toEqual(["Kevin: message 5", "Mina: message 6"]);
  });

  it("reads up to five places, grouped; a #ref needs one place", async () => {
    const w = await lifeWorld(roots);
    postMinutes(w, ROOM, ["in general"]);
    postMinutes(w, RECIPES, ["in recipes"]);
    const both = text(await read(w, "bake-club/#general, bake-club/#recipes", "max:5"));
    const [general, recipes] = both.split("\n\n");
    expect(general!.split("\n")[0]).toBe("bake-club/#general (Bake Club › #general)");
    expect(bodies(general!)).toEqual(["Kevin: in general"]);
    expect(recipes!.split("\n")[0]).toBe("bake-club/#recipes (Bake Club › #recipes)");
    expect(bodies(recipes!)).toEqual(["Kevin: in recipes"]);
    expect((await read(w, "bake-club/#general, bake-club/#recipes", "around #a0")).content).toBe("error: a #ref belongs to one place; read one place with it");
    expect(text(await read(w, "a, b, c, d, e, f"))).toContain("at most 5 places");
    expect(text(await read(w, "everywhere"))).toContain('"everywhere" needs people: or search:');
  });

  it("a page across days says which day each part is", async () => {
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-23T22:00:00.000Z");
    postMinutes(w, ROOM, ["late last night"]);
    w.clock.ms = Date.parse("2026-10-24T09:00:00.000Z");
    postMinutes(w, ROOM, ["good morning"]);
    const page = text(await read(w, "bake-club/#general"));
    expect(page.split("\n").slice(1)).toEqual([
      "— Fri 23 Oct —",
      expect.stringMatching(/^\[22:01 #[0-9a-z]+\] Kevin: late last night$/u),
      "— Sat 24 Oct —",
      expect.stringMatching(/^\[09:01 #[0-9a-z]+\] Kevin: good morning$/u)
    ]);
  });
});

describe("refs at ingest, resolving after refs.json pruned them (§22.1)", () => {
  it("ReadMessages, SendMessage reply_to and React find a pruned ref through the transcript", async () => {
    const w = await lifeWorld(roots);
    const message = w.discord.post(ROOM, "we won the bake-off!");
    w.cast.transcripts.onCacheEvent({ type: "create", conversation: ROOM, message, own: false });
    await w.cast.transcripts.settle();
    expect((await readTranscriptDay(w.root, ROOM_KEY, "2026-10-24")).map((line) => line.ref)).toEqual(["a0"]);
    // refs.json loses it (as its 30-day / 10,000-message pruning would); the counter stays.
    const refsFile = conversationRefsPath(ROOM_KEY as never);
    const refs = await w.storage.readJson(refsFile, ConversationRefsSchema);
    expect(refs.refs[message.id]).toBe("a0");
    await w.storage.writeJson(`refs:${ROOM_KEY}`, refsFile, ConversationRefsSchema, { ...refs, refs: {} });
    expect(bodies(text(await read(w, "bake-club/#general", "around #a0")))).toEqual(["Kevin: we won the bake-off!"]);
    const ctx = await ctxFor(w);
    expect(text(await lifeTool("React")!.run({ place: "bake-club/#general", ref: "#a0", emoji: "🎉" }, ctx))).toBe("reacted");
    const sent = await lifeTool("SendMessage")!.run({ place: "bake-club/#general", text: "congrats!!", reply_to: "#a0" }, ctx);
    expect(sent.isError).not.toBe(true);
    expect(w.discord.sent.at(-1)).toMatchObject({ content: "congrats!!", replyToMessageId: message.id });
    expect((await read(w, "bake-club/#general", "around #zz")).content).toBe("error: message too old");
  });
});

describe("people: and search: over her transcripts (§22.2)", () => {
  async function fed(w: LifeWorld, place: ConversationRef, content: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}) {
    const message = w.discord.post(place, content, o);
    w.cast.transcripts.onCacheEvent({ type: "create", conversation: place, message, own: o.authorId === ELLA_BOT });
    await w.cast.transcripts.settle();
    return message;
  }

  it("finds by author and words over days, reports what matched and where it searched", async () => {
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-23T10:00:00.000Z");
    await w.cast.transcripts.start();
    await fed(w, ROOM, "my exam is on Monday");
    await fed(w, ROOM, "good luck with the EXAM", { authorId: MINA_USER, authorName: "Mina" });
    w.clock.ms = Date.parse("2026-10-24T13:00:00.000Z");
    await fed(w, ROOM, "the exam went great");
    await fed(w, ROOM, "told you so", { authorId: ELLA_BOT, authorName: "Ella", bot: true });
    const exam = text(await read(w, "bake-club/#general", "search:exam"));
    expect(exam.split("\n")[1]).toBe("3 messages match (searched 2026-10-23 (when your transcripts begin) – 2026-10-24)");
    expect(exam).toContain("— Fri 23 Oct —");
    expect(bodies(exam)).toEqual(["Kevin: my exam is on Monday", "Mina: good luck with the EXAM", "Kevin: the exam went great"]);
    expect(bodies(text(await read(w, "bake-club/#general", "people:mina")))).toEqual(["Mina: good luck with the EXAM"]);
    expect(bodies(text(await read(w, "bake-club/#general", "people:you")))).toEqual(["you: told you so"]);
    const latestOne = text(await read(w, "bake-club/#general", "search:exam max:1"));
    expect(bodies(latestOne)).toEqual(["Kevin: the exam went great"]);
    expect(latestOne.split("\n")[1]).toBe("3 messages match, 1 shown (searched 2026-10-23 (when your transcripts begin) – 2026-10-24)");
    expect(latestOne).toContain("— more before: before #");
    const since = text(await read(w, "bake-club/#general", "search:exam after 2026-10-24"));
    expect(since.split("\n")[1]).toBe("1 message matches (searched 2026-10-24 – 2026-10-24)");
    expect(text(await read(w, "bake-club/#general", "search:nothing like this"))).toContain("0 messages match");
  });

  it("only what she could see: her access intervals", async () => {
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-24T09:00:00.000Z");
    await w.cast.transcripts.start();
    await fed(w, ROOM, "the secret recipe is cardamom");
    // She was cast there only from 12:00 on.
    await updateTranscriptAccess(w.root, "ella", (access) => ({ conversations: { ...access.conversations, [ROOM_KEY]: [{ from: "2026-10-24T12:00:00.000Z" }] } }));
    w.clock.ms = Date.parse("2026-10-24T13:00:00.000Z");
    await fed(w, ROOM, "cardamom buns tomorrow");
    expect(bodies(text(await read(w, "bake-club/#general", "search:cardamom")))).toEqual(["Kevin: cardamom buns tomorrow"]);
  });

  it("everywhere: grouped by place, places without matches left out, a DM in it marks the call private (D14)", async () => {
    const w = await lifeWorld(roots);
    await w.cast.transcripts.start();
    await fed(w, ROOM, "brownies at noon");
    await fed(w, RECIPES, "brownie recipe: lots of butter");
    await fed(w, RECIPES, "nothing to see");
    // Kevin writes to her privately (so the DM is one of her places), then about brownies.
    const hello = w.discord.post(dmOf("ella"), "hi ella");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: hello.id, createdAt: hello.createdAt });
    w.cast.intake.close();
    await fed(w, dmOf("ella"), "save me a brownie?");
    const ctx = await ctxFor(w);
    const { value, places } = await withPlaceRecord(() => lifeTool("ReadMessages")!.run({ place: "everywhere", query: "search:brownie, brownies" }, ctx));
    const sections = text(value).split("\n\n");
    expect(sections.map((section) => section.split("\n")[0])).toEqual([
      "bake-club/#general (Bake Club › #general)",
      "bake-club/#recipes (Bake Club › #recipes)",
      expect.stringMatching(/^dm\/[a-z0-9-]+ \(DM with .+\)$/u)
    ]);
    expect(places.has(conversationKey(dmOf("ella")))).toBe(true);
    // Rooms only: the call is not about a DM.
    const rooms = await withPlaceRecord(() => lifeTool("ReadMessages")!.run({ place: "everywhere", query: "search:butter" }, ctx));
    expect(text(rooms.value).split("\n")[0]).toBe("bake-club/#recipes (Bake Club › #recipes)");
    expect([...rooms.places].some((key) => key.startsWith("dm_"))).toBe(false);
    expect(text(await read(w, "everywhere", "search:pineapple"))).toMatch(/^no messages match \(searched /u);
  });
});

describe("review fixes: refs from transcripts, filters, limits (§22)", () => {
  async function fedAt(w: LifeWorld, iso: string, place: ConversationRef, content: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}) {
    w.clock.ms = Date.parse(iso);
    const message = w.discord.post(place, content, o);
    w.cast.transcripts.onCacheEvent({ type: "create", conversation: place, message, own: o.authorId === ELLA_BOT });
    await w.cast.transcripts.settle();
    return message;
  }

  async function clearRefs(w: LifeWorld, key = ROOM_KEY) {
    const refsFile = conversationRefsPath(key as never);
    const refs = await w.storage.readJson(refsFile, ConversationRefsSchema);
    await w.storage.writeJson(`refs:${key}`, refsFile, ConversationRefsSchema, { ...refs, refs: {} });
  }

  async function refsJson(w: LifeWorld, key = ROOM_KEY) {
    return (await w.storage.readJson(conversationRefsPath(key as never), ConversationRefsSchema).catch(() => ({ refs: {} as Record<string, string> }))).refs;
  }

  it("a page takes the ref stored on the transcript line (refs.json pruned it) and never gives a message a second ref", async () => {
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-20T00:00:00.000Z");
    await w.cast.transcripts.start();
    await fedAt(w, "2026-10-24T09:00:00.000Z", ROOM, "an old one");
    await fedAt(w, "2026-10-24T09:01:00.000Z", ROOM, "a newer one");
    await clearRefs(w);
    w.clock.ms = Date.parse("2026-10-24T14:00:00.000Z");
    const page = text(await read(w, "bake-club/#general"));
    expect(page).toContain("[09:00 #a0] Kevin: an old one");
    expect(page).toContain("[09:01 #a1] Kevin: a newer one");
    expect(await refsJson(w)).toEqual({});
    expect((await read(w, "bake-club/#general", "around #a0")).isError).not.toBe(true);
  });

  it("a message past the age limit gets no new ref; the page's edge hint is its time instead", async () => {
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-09-01T10:00:00.000Z");
    postMinutes(w, ROOM, Array.from({ length: 6 }, (_, index) => `september ${index + 1}`));
    w.clock.ms = Date.parse("2026-10-24T14:00:00.000Z");
    const page = text(await read(w, "bake-club/#general", "before 2026-09-02 max:3"));
    expect(bodies(page)).toEqual(["Mina: september 4", "Kevin: september 5", "Mina: september 6"]);
    expect(page).toContain("[10:04] Mina: september 4");
    // `before` leaves its minute out: the hint names the next one, so nothing older is skipped.
    expect(page.split("\n")[1]).toBe("— more before: before 2026-09-01 10:05 —");
    expect(await refsJson(w)).toEqual({});
  });

  it("refs.json is pruned only once it has grown well past the span", async () => {
    const { assignConversationRefs, MAX_REF_SPAN, REF_PRUNE_SLACK } = await import("../src/discord/refStore.js");
    const w = await lifeWorld(roots);
    const oldId = snowflakeAt(Date.parse("2026-08-01T00:00:00.000Z"));
    const refsFile = conversationRefsPath(ROOM_KEY as never);
    const seed = (count: number) =>
      ConversationRefsSchema.parse({
        schemaVersion: 2,
        revision: 0,
        updatedAt: NOW.toISOString(),
        conversationKey: ROOM_KEY,
        counter: 360 + count,
        refs: { [oldId]: "a0", ...Object.fromEntries(Array.from({ length: count - 1 }, (_, index) => [snowflakeAt(NOW.getTime() - 60_000 + index), (361 + index).toString(36)])) }
      });
    await w.storage.writeJson(`refs:${ROOM_KEY}`, refsFile, ConversationRefsSchema, seed(10));
    await assignConversationRefs(w.storage, ROOM_KEY as never, [snowflakeAt(NOW.getTime())], NOW);
    expect((await refsJson(w))[oldId]).toBe("a0");
    await w.storage.writeJson(`refs:${ROOM_KEY}`, refsFile, ConversationRefsSchema, seed(MAX_REF_SPAN + REF_PRUNE_SLACK + 1));
    await assignConversationRefs(w.storage, ROOM_KEY as never, [snowflakeAt(NOW.getTime() + 1)], NOW);
    expect((await refsJson(w))[oldId]).toBeUndefined();
  }, 30_000);

  it("finds a ref a gap fill wrote into an older day (refs are not in day order)", async () => {
    const { addTranscriptLine, findTranscriptRef } = await import("../src/life/transcripts/store.js");
    const w = await lifeWorld(roots);
    const env = { dataRoot: w.root, timeZone: TZ };
    const line = (at: string, ref: string) => ({ id: snowflakeAt(Date.parse(at)), at, authorId: MINA_USER, author: "Mina", text: `ref ${ref}`, ref });
    await addTranscriptLine(env, ROOM_KEY, line("2026-10-20T10:00:00.000Z", "b5"));
    await addTranscriptLine(env, ROOM_KEY, line("2026-10-23T10:00:00.000Z", "a3"));
    expect((await findTranscriptRef(w.root, ROOM_KEY, "b5"))?.text).toBe("ref b5");
    expect((await findTranscriptRef(w.root, ROOM_KEY, "a3"))?.text).toBe("ref a3");
    expect(await findTranscriptRef(w.root, ROOM_KEY, "zz")).toBeUndefined();
  });

  it("a forgotten person's lines stay out of searches, ref lookups and /transcripts even before the forget job's transcript part ran", async () => {
    const { recordForgottenPerson } = await import("../src/orchestration/dm/forgotten.js");
    const { TranscriptView } = await import("../src/life/transcripts/view.js");
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-20T00:00:00.000Z");
    await w.cast.transcripts.start();
    await fedAt(w, "2026-10-24T09:00:00.000Z", ROOM, "my secret recipe uses cardamom", { authorId: MINA_USER, authorName: "Mina" });
    await fedAt(w, "2026-10-24T09:01:00.000Z", ROOM, "cardamom is great");
    await clearRefs(w);
    await recordForgottenPerson(w.storage, MINA_USER, new Date("2026-10-24T10:00:00.000Z"));
    w.clock.ms = Date.parse("2026-10-24T14:00:00.000Z");
    expect(bodies(text(await read(w, "bake-club/#general", "search:cardamom")))).toEqual(["Kevin: cardamom is great"]);
    expect((await read(w, "bake-club/#general", "around #a0")).content).toBe("error: message too old");
    const day = await new TranscriptView({ storage: w.storage, waifuId: "ella", timeZone: TZ, now: w.clock.now }).read(["bake-club", "general", "2026-10-24.md"]);
    expect(day).not.toContain("secret recipe");
    expect(day).toContain("cardamom is great");
  });

  it("a DM's lines at or below its forget floor stay out of searches", async () => {
    const { updateDmLimit } = await import("../src/orchestration/dm/dmStore.js");
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-20T00:00:00.000Z");
    await w.cast.transcripts.start();
    const hello = w.discord.post(dmOf("ella"), "hi ella");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: hello.id, createdAt: hello.createdAt });
    w.cast.intake.close();
    const before = await fedAt(w, "2026-10-24T15:00:00.000Z", dmOf("ella"), "the old brownie secret");
    await fedAt(w, "2026-10-24T16:00:00.000Z", dmOf("ella"), "new brownie plans");
    await updateDmLimit(w.storage, KEVIN, "ella", (current) => ({ ...current, floorMessageId: before.id }));
    const found = text(await read(w, "everywhere", "search:brownie"));
    expect(found).toContain("new brownie plans");
    expect(found).not.toContain("old brownie secret");
  });

  it("the cache's unwritten tail starts after the store's newest line and stays inside her interval", async () => {
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-20T00:00:00.000Z");
    await w.cast.transcripts.start();
    await fedAt(w, "2026-10-24T12:00:00.000Z", ROOM, "written: muffins");
    await updateTranscriptAccess(w.root, "ella", (access) => ({ conversations: { ...access.conversations, [ROOM_KEY]: [{ from: "2026-10-24T11:00:00.000Z" }] } }));
    w.clock.ms = Date.parse("2026-10-24T13:00:00.000Z");
    const outside = { ...w.discord.post(ROOM, "muffins before she came"), id: snowflakeAt(Date.parse("2026-10-24T10:30:00.000Z")), createdAt: "2026-10-24T10:30:00.000Z" };
    const fresh = w.discord.post(ROOM, "muffins again, not written yet");
    vi.spyOn(w.cast.deps.conversations, "bufferedMessages").mockReturnValue([outside, fresh]);
    expect(bodies(text(await read(w, "bake-club/#general", "search:muffins")))).toEqual(["Kevin: written: muffins", "Kevin: muffins again, not written yet"]);
  });

  it("stops at its limits and says how far it searched; an aborted call stops between days", async () => {
    const { SEARCH_LIMITS } = await import("../src/life/tools/messages.js");
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-20T00:00:00.000Z");
    await w.cast.transcripts.start();
    for (const day of ["21", "22", "23", "24"]) await fedAt(w, `2026-10-${day}T09:00:00.000Z`, ROOM, `tea on day ${day}`);
    w.clock.ms = Date.parse("2026-10-24T14:00:00.000Z");
    const days = SEARCH_LIMITS.days;
    SEARCH_LIMITS.days = 2;
    try {
      const found = text(await read(w, "bake-club/#general", "search:tea"));
      expect(found.split("\n")[1]).toBe("2 messages match (searched 2026-10-23 – 2026-10-24; the search stopped at its size limit: add before or after to look further)");
      expect(found).toContain("— more before: before #");
      expect(bodies(found)).toEqual(["Kevin: tea on day 23", "Kevin: tea on day 24"]);
    } finally {
      SEARCH_LIMITS.days = days;
    }
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const ctx = { ...(await ctxFor(w)), signal: controller.signal };
    await expect(lifeTool("ReadMessages")!.run({ place: "bake-club/#general", query: "search:tea" }, ctx)).rejects.toThrow("stop");
  });

  it("everywhere names the places its size limit cut, also when nothing matched", async () => {
    const { SEARCH_LIMITS } = await import("../src/life/tools/messages.js");
    const w = await lifeWorld(roots);
    w.clock.ms = Date.parse("2026-10-20T00:00:00.000Z");
    await w.cast.transcripts.start();
    for (const day of ["21", "22", "23", "24"]) await fedAt(w, `2026-10-${day}T09:00:00.000Z`, ROOM, `tea on day ${day}`);
    await fedAt(w, "2026-10-24T10:00:00.000Z", RECIPES, "tea cake");
    w.clock.ms = Date.parse("2026-10-24T14:00:00.000Z");
    const bytes = SEARCH_LIMITS.bytes;
    SEARCH_LIMITS.bytes = 1;
    try {
      const nothing = text(await read(w, "everywhere", "search:pineapple"));
      expect(nothing).toMatch(/^no messages match \(searched /u);
      const cut = nothing.split("\n\n").at(-1)!;
      expect(cut).toMatch(/^— the search reached its size limit; /u);
      // The first place read one day before the budget ran out; the other wasn't read at all.
      expect(cut).toMatch(/not searched: bake-club\/#(general|recipes); searched only in part: bake-club\/#(general|recipes) /u);
      const found = text(await read(w, "everywhere", "search:tea"));
      expect(found.split("\n\n").at(-1)).toMatch(/^— the search reached its size limit; /u);
      // A named place says it in its own section; no extra line.
      const named = text(await read(w, "bake-club/#general", "search:pineapple"));
      expect(named).not.toContain("— the search reached its size limit");
    } finally {
      SEARCH_LIMITS.bytes = bytes;
    }
    expect(text(await read(w, "everywhere", "search:pineapple"))).not.toContain("size limit");
  });

  it("people:Max 5 is a name; the old limit field counts only without a max term; max:100 still says when there is more", async () => {
    const parse = (query: string) => parseReadQuery(query, { now: NOW, timeZone: TZ });
    expect(parse("people:Max 5")).toEqual({ ok: true, query: { people: ["max 5"] } });
    expect(parse("people:Max max:5")).toEqual({ ok: true, query: { people: ["max"], max: 5 } });
    const w = await lifeWorld(roots);
    postMinutes(w, ROOM, Array.from({ length: 101 }, (_, index) => `n${index + 1}`));
    const ctx = await ctxFor(w);
    expect(bodies(text(await lifeTool("ReadMessages")!.run({ place: "bake-club/#general", limit: 2, query: "people:Max" }, ctx)))).toEqual([]);
    expect(bodies(text(await lifeTool("ReadMessages")!.run({ place: "bake-club/#general", limit: 2 }, ctx)))).toEqual(["Mina: n100", "Kevin: n101"]);
    expect(bodies(text(await lifeTool("ReadMessages")!.run({ place: "bake-club/#general", limit: 2, query: "max:3" }, ctx)))).toHaveLength(3);
    const hundred = text(await read(w, "bake-club/#general", "max:100"));
    expect(bodies(hundred)).toHaveLength(100);
    expect(hundred.split("\n")[1]).toMatch(/^— more before: before #[0-9a-z]+ —$/u);
    // A #ref and max:100 over the network: that message and 100 before it (two pages), and the hint.
    postMinutes(w, ROOM, Array.from({ length: 49 }, (_, index) => `m${index + 1}`));
    const anchor = refOf(text(await read(w, "bake-club/#general", "max:100")), ": m30");
    const wide = text(await read(w, "bake-club/#general", `before #${anchor} max:100`));
    expect(bodies(wide)).toHaveLength(101);
    expect(bodies(wide).at(-1)).toMatch(/: m30$/u);
    expect(bodies(wide)[0]).toMatch(/: n31$/u);
    expect(wide.split("\n")[1]).toMatch(/^— more before: before #[0-9a-z]+ —$/u);
  }, 30_000);
});
