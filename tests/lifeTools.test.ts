// Life tools (Living cast spec §6): schemas and limits for every tool, D11 send permissions, note
// path rules, watch matching and `from` resolution, schedule limits. Tools run directly against a
// temp data root and the fake Discord; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readLifeFile } from "../src/life/lifeStore.js";
import { fireWatches, bindingMatch } from "../src/life/watches.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { updateDmLimit } from "../src/orchestration/dm/dmStore.js";
import { recordForgottenPerson } from "../src/orchestration/dm/forgotten.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import { ARIA_BOT, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function ctxFor(w: LifeWorld, waifuId = "aria"): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, waifuId);
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

const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, ctx);
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));

/** Kevin DMs Aria (so the DM is a place she may write to, D11). */
async function kevinDms(w: LifeWorld, content = "hi aria") {
  const message = w.discord.post(dmOf("aria"), content);
  await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
  w.cast.intake.close();
  return message;
}

describe("send_message (§6.3, D11)", () => {
  it("posts in a cast room (typing first), returns a ref, and refuses unknown places", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const sent = await run("send_message", { place: "bake-club/#general", text: "brownies are ready" }, ctx);
    expect(text(sent)).toMatch(/^sent #[0-9a-z]+$/u);
    expect(w.discord.typing).toEqual(["200000000000000002"]);
    expect(w.discord.sent).toMatchObject([{ placeKey: ROOM_KEY, content: "brownies are ready", senderBotId: "aria-bot" }]);
    expect(await run("send_message", { place: "elsewhere/#random", text: "hi" }, ctx)).toEqual({ content: "error: unknown place; use list_places", isError: true });
    expect((await run("send_message", { place: "bake-club/#general", text: "" }, ctx)).isError).toBe(true);
    expect((await run("send_message", { place: "bake-club/#general", text: "x".repeat(2001) }, ctx)).isError).toBe(true);
  });

  it("never cold-DMs; a DM opens once the user wrote, until undeliverable, forgotten or rate-limited", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", dm: { allowDms: true, rateLimit: { maxReplies: 1, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } }] });
    let ctx = await ctxFor(w);
    expect((await run("send_message", { place: `dm_${KEVIN}_aria`, text: "hey kevin" }, ctx)).isError).toBe(true);
    await kevinDms(w);
    ctx = await ctxFor(w);
    expect(text(await run("send_message", { place: "dm/kevin", text: "hey kevin!" }, ctx))).toMatch(/^sent #/u);
    // The same turn may keep writing to him even though that reply reached the limit.
    expect(text(await run("send_message", { place: "dm/kevin", text: "and also" }, ctx))).toMatch(/^sent #/u);
    // A new turn is rate-limited.
    const next = await ctxFor(w);
    expect(await run("send_message", { place: "dm/kevin", text: "one more" }, next)).toEqual({ content: "error: you can't post there", isError: true });
    // Undeliverable (Discord 50007) closes the DM until he writes again.
    await updateDmLimit(w.storage, KEVIN, "aria", (limits) => ({ ...limits, replyTimestamps: [] }));
    w.discord.sendErrors.push(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
    expect(await run("send_message", { place: "dm/kevin", text: "hello?" }, await ctxFor(w))).toEqual({ content: "error: they can't receive your messages right now", isError: true });
    expect((await run("send_message", { place: "dm/kevin", text: "hello??" }, await ctxFor(w))).isError).toBe(true);
  });

  it("a forget floor above his last message closes the DM", async () => {
    const w = await lifeWorld(roots);
    await kevinDms(w);
    w.clock.advance(5_000);
    await updateDmLimit(w.storage, KEVIN, "aria", (limits) => ({ ...limits, floorMessageId: "999999999999999999999" }));
    expect(await run("send_message", { place: "dm/kevin", text: "hi" }, await ctxFor(w))).toEqual({ content: "error: you can't post there", isError: true });
  });

  it("caps distinct places per turn, refuses a paused server, strips a copied header and refuses tool-call syntax", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, maxSendPlacesPerTurn: 1 } }) });
    await kevinDms(w);
    const ctx = await ctxFor(w);
    expect(text(await run("send_message", { place: "bake-club/#general", text: "[14:02 #k3] Aria: hello all" }, ctx))).toMatch(/^sent/u);
    expect(w.discord.sent[0]!.content).toBe("hello all");
    expect(await run("send_message", { place: "dm/kevin", text: "hi" }, ctx)).toEqual({ content: "error: you've already written in 1 places this turn", isError: true });
    expect((await run("send_message", { place: "bake-club/#general", text: 'read_messages({"place":"bake-club/#general"})' }, ctx)).isError).toBe(true);
    await w.storage.updateRevisionedJson({
      resourceKey: `server:${GUILD}`,
      relativePath: `user/servers/${GUILD}/server.json`,
      schema: ServerConfigSchema,
      fallback: undefined as never,
      transform: (server) => ({ ...server, paused: true })
    });
    expect(await run("send_message", { place: "bake-club/#general", text: "still here?" }, await ctxFor(w))).toEqual({ content: "error: you can't post there", isError: true });
  });
});

describe("read_messages (§6.2) and react (§6.4)", () => {
  it("renders the transcript with refs, pages with before, and shows forgotten authors as removed", async () => {
    const w = await lifeWorld(roots);
    for (let index = 1; index <= 20; index += 1) w.discord.post(ROOM, `message ${index}`, index % 2 ? {} : { authorId: MINA_USER, authorName: "Mina" });
    const ctx = await ctxFor(w);
    const first = text(await run("read_messages", { place: "bake-club/#general", limit: 5 }, ctx));
    const lines = first.split("\n");
    expect(lines[0]).toBe("bake-club/#general (Bake Club › #general)");
    expect(lines.slice(1, 6).map((line) => line.replace(/^\[\d\d:\d\d #[0-9a-z]+\] /u, ""))).toEqual(["Mina: message 16", "Kevin: message 17", "Mina: message 18", "Kevin: message 19", "Mina: message 20"]);
    const footer = lines[lines.length - 1]!;
    expect(footer).toMatch(/^— older messages available; pass before:"#[0-9a-z]+" —$/u);
    const before = /before:"(#[0-9a-z]+)"/u.exec(footer)![1]!;
    const older = text(await run("read_messages", { place: "bake-club/#general", limit: 2, before }, ctx));
    expect(older).toContain("message 14");
    expect(older).toContain("message 15");
    expect(await run("read_messages", { place: "bake-club/#general", before: "#zzzz" }, ctx)).toEqual({ content: "error: message too old", isError: true });
    for (const limit of [0, 51]) expect((await run("read_messages", { place: "bake-club/#general", limit }, ctx)).isError).toBe(true);
    // The owner forgot Mina: her messages so far read as (removed).
    await recordForgottenPerson(w.storage, MINA_USER, w.clock.now());
    const after = text(await run("read_messages", { place: "bake-club/#general", limit: 2 }, ctx));
    expect(after).toMatch(/someone: \(removed\)/u);
    expect(after).not.toContain("message 20");
    const state = await readLifeFile(w.storage, "aria", "reads");
    expect(state.cursors[ROOM_KEY]?.lastReadMessageId).toBeTruthy();
  });

  it("reacts with unicode or a server emoji through her own bot", async () => {
    const w = await lifeWorld(roots);
    w.discord.post(ROOM, "we won the bake-off!");
    const ctx = await ctxFor(w);
    const read = text(await run("read_messages", { place: "bake-club/#general", limit: 1 }, ctx));
    const ref = /#([0-9a-z]+)\]/u.exec(read)![1]!;
    expect(text(await run("react", { place: "bake-club/#general", ref: `#${ref}`, emoji: "🎉" }, ctx))).toBe("reacted");
    expect(w.discord.reactions).toMatchObject([{ placeKey: ROOM_KEY, emoji: "🎉", botId: "aria-bot" }]);
    expect(await run("react", { place: "bake-club/#general", ref: `#${ref}`, emoji: ":partyblob:" }, ctx)).toEqual({ content: "error: there is no :partyblob: emoji here", isError: true });
    expect(await run("react", { place: "bake-club/#general", ref: "#nope", emoji: "🎉" }, ctx)).toEqual({ content: "error: message too old", isError: true });
  });
});

describe("watch_for, list_watches, cancel_watch (§6.5)", () => {
  it("validates bindings and expiry, resolves `from` (ambiguity is an error), caps active watches at 10", async () => {
    const w = await lifeWorld(roots);
    // Two people she knows as Kevin (from her DMs).
    for (const userId of [KEVIN, MINA_USER]) {
      const message = w.discord.post(dmOf("aria", userId), "hi", { authorId: userId, authorName: "Kevin" });
      await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    }
    w.cast.intake.close();
    const ctx = await ctxFor(w);
    const watch = (input: Record<string, unknown>) => run("watch_for", { note: "n", expires_in_minutes: 60, ...input }, ctx);
    expect((await watch({ bindings: [{}] })).content).toBe("error: bindings.0: each binding needs a place, from, words or any_message");
    expect((await watch({ bindings: [{ any_message: true }], expires_in_minutes: 4 })).isError).toBe(true);
    expect((await watch({ bindings: [{ any_message: true }], expires_in_minutes: 10_081 })).isError).toBe(true);
    expect((await watch({ bindings: [{ words: Array.from({ length: 11 }, (_, i) => `w${i}`) }] })).isError).toBe(true);
    expect(await watch({ bindings: [{ from: "Kevin" }] })).toEqual({ content: "error: more than one person called Kevin; use <@id>", isError: true });
    expect(await watch({ bindings: [{ place: "nowhere/#x" }] })).toEqual({ content: "error: unknown place; use list_places", isError: true });
    expect(text(await watch({ bindings: [{ from: `<@${KEVIN}>`, words: ["cake"] }], note: "Kevin's cake news" }))).toMatch(/^watching w1 until Sat 24 Oct 15:00$/u);
    const file = await readLifeFile(w.storage, "aria", "watches");
    expect(file.watches[0]!.bindings).toEqual([{ fromUserId: KEVIN, fromName: "Kevin", words: ["cake"] }]);
    for (let index = 2; index <= 10; index += 1) expect((await watch({ bindings: [{ any_message: true }] })).isError).toBeFalsy();
    expect(await watch({ bindings: [{ any_message: true }] })).toEqual({ content: "error: you already have 10 watches; cancel one first", isError: true });
    expect(text(await run("list_watches", {}, ctx)).split("\n")).toHaveLength(10);
    expect(text(await run("cancel_watch", { id: "w1" }, ctx))).toBe("cancelled w1");
    expect(await run("cancel_watch", { id: "w1" }, ctx)).toEqual({ content: "error: no watch w1; use list_watches", isError: true });
  });

  it("matches place, person, whole words or any message; once-watches go at the first match; spacing and daily cap", async () => {
    expect(bindingMatch({ words: ["brownie"] }, { placeKey: ROOM_KEY, authorId: KEVIN, text: "Brownies?", own: false })).toBeUndefined();
    expect(bindingMatch({ words: ["brownie"] }, { placeKey: ROOM_KEY, authorId: KEVIN, text: "one BROWNIE please", own: false })).toBe("brownie");
    expect(bindingMatch({ fromUserId: KEVIN, fromName: "Kevin" }, { placeKey: "elsewhere", authorId: KEVIN, text: "x", own: false })).toBe("from Kevin");
    expect(bindingMatch({ placeKey: ROOM_KEY, fromUserId: KEVIN }, { placeKey: ROOM_KEY, authorId: MINA_USER, text: "x", own: false })).toBeUndefined();
    const w = await lifeWorld(roots);
    const now = w.clock.now();
    const base = { createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), fires: [] };
    await (await import("../src/life/lifeStore.js")).updateLifeFile(w.storage, "aria", "watches", (file) => ({
      ...file,
      watches: [
        { id: "w1", note: "once", once: true, bindings: [{ anyMessage: true, placeKey: ROOM_KEY }], ...base },
        { id: "w2", note: "repeat", once: false, bindings: [{ words: ["cake"] }], ...base }
      ]
    }));
    const message = (text: string, own = false) => ({ placeKey: ROOM_KEY, authorId: KEVIN, text, own });
    expect((await fireWatches(w.storage, "aria", message("cake time", true), { now, maxFiresPerDay: 2 }))).toEqual([]);
    expect((await fireWatches(w.storage, "aria", message("cake time"), { now, maxFiresPerDay: 2 })).map((hit) => hit.watch.id)).toEqual(["w1", "w2"]);
    expect((await fireWatches(w.storage, "aria", message("more cake"), { now: new Date(now.getTime() + 5 * 60_000), maxFiresPerDay: 2 }))).toEqual([]);
    expect((await fireWatches(w.storage, "aria", message("more cake"), { now: new Date(now.getTime() + 11 * 60_000), maxFiresPerDay: 2 })).map((hit) => hit.watch.id)).toEqual(["w2"]);
    expect((await fireWatches(w.storage, "aria", message("cake again"), { now: new Date(now.getTime() + 30 * 60_000), maxFiresPerDay: 2 }))).toEqual([]);
    expect((await readLifeFile(w.storage, "aria", "watches")).watches.map((watch) => watch.id)).toEqual(["w2"]);
  });
});

describe("schedule_wake, list_schedule, cancel_wake (§6.6)", () => {
  it("takes exactly one of at / in_minutes, 5 minutes to 30 days ahead, at most 20 pending", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const schedule = (input: Record<string, unknown>) => run("schedule_wake", { note: "n", ...input }, ctx);
    expect((await schedule({})).content).toBe("error: give exactly one of at or in_minutes");
    expect((await schedule({ at: "2026-10-25 18:00", in_minutes: 10 })).isError).toBe(true);
    expect(await schedule({ in_minutes: 4 })).toEqual({ content: "error: reminders must be at least 5 minutes ahead", isError: true });
    expect(await schedule({ at: "2026-12-01 10:00" })).toEqual({ content: "error: reminders can be at most 30 days ahead", isError: true });
    expect(await schedule({ at: "next tuesday" })).toEqual({ content: "error: use a local time like 2026-10-25 18:00", isError: true });
    expect(text(await schedule({ at: "2026-10-25 18:00", note: "ask Kevin about the exam", repeat: "weekly" }))).toBe("set r1 for Sun 25 Oct 18:00, then weekly");
    for (let index = 2; index <= 20; index += 1) expect((await schedule({ in_minutes: 10 + index })).isError).toBeFalsy();
    expect(await schedule({ in_minutes: 60 })).toEqual({ content: "error: you already have 20 reminders; cancel one first", isError: true });
    expect(text(await run("list_schedule", {}, ctx)).split("\n")[0]).toMatch(/^r2 · Sat 24 Oct 14:12 · "n"$/u);
    expect(text(await run("cancel_wake", { id: "R1" }, ctx))).toBe("cancelled r1");
    expect(await run("cancel_wake", { id: "r1" }, ctx)).toEqual({ content: "error: no reminder r1; use list_schedule", isError: true });
  });
});

describe("notes tools (§6.7)", { timeout: 60_000 }, () => {
  it("enforces the path rules", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    for (const good of ["MEMORY.md", "me.md", "people/kevin.md", "places/bake-club/recipes.md"]) {
      expect((await run("write_note", { path: good, content: "# x\n" }, ctx)).isError, good).toBeFalsy();
    }
    for (const bad of ["/me.md", "../me.md", "people/../me.md", "people//kevin.md", "People/Kevin.md", "a/b/c/d.md", "notes.txt", ".md", "memory.MD", ""]) {
      expect((await run("write_note", { path: bad, content: "x" }, ctx)).isError, bad).toBe(true);
    }
  });

  it("limits a note to 16 KB and 200 files; edit replaces exactly one occurrence; search and delete", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(await run("write_note", { path: "big.md", content: "x".repeat(16 * 1024 + 1) }, ctx)).toEqual({ content: "error: a note can be at most 16 KB; split it into several notes", isError: true });
    await run("write_note", { path: "people/kevin.md", content: "# Kevin\n- likes tea\n- likes tea a lot\n" }, ctx);
    expect(await run("edit_note", { path: "people/kevin.md", find: "likes tea", replace: "likes coffee" }, ctx)).toEqual({ content: "error: that text appears 2 times; include more of the surrounding text", isError: true });
    expect(await run("edit_note", { path: "people/kevin.md", find: "hates tea", replace: "x" }, ctx)).toEqual({ content: "error: that text is not in the note; read it first", isError: true });
    expect((await run("edit_note", { path: "people/kevin.md", find: "likes tea a lot", replace: "likes coffee now" }, ctx)).isError).toBeFalsy();
    expect(text(await run("read_note", { path: "people/kevin.md" }, ctx))).toBe("# Kevin\n- likes tea\n- likes coffee now\n");
    expect(text(await run("search_notes", { query: "coffee" }, ctx))).toContain("people/kevin.md");
    expect(text(await run("delete_note", { path: "people/kevin.md" }, ctx))).toBe("deleted people/kevin.md");
    expect(await run("read_note", { path: "people/kevin.md" }, ctx)).toEqual({ content: "error: no note at people/kevin.md", isError: true });
    for (let index = 0; index < 200; index += 1) await run("write_note", { path: `n/n${index}.md`, content: "x" }, ctx);
    expect(await run("write_note", { path: "one-too-many.md", content: "x" }, ctx)).toEqual({ content: "error: you have 200 notes already; merge or delete some first", isError: true });
  });
});

describe("tool list (§6)", () => {
  it("offers every tool; web tools only while their caps allow", async () => {
    const w = await lifeWorld(roots);
    expect(offeredToolNames(w.cast.deps)).toEqual([
      "read_messages",
      "send_message",
      "react",
      "watch_for",
      "list_watches",
      "cancel_watch",
      "schedule_wake",
      "list_schedule",
      "cancel_wake",
      "list_notes",
      "read_note",
      "write_note",
      "edit_note",
      "delete_note",
      "search_notes",
      "web_search",
      "web_fetch",
      "list_places"
    ]);
    w.setConfig((config) => ({ ...config, search: { ...config.search, maxPerDay: 0 }, life: { ...config.life, webFetch: { ...config.life.webFetch, maxPerTurn: 0 } } }));
    expect(offeredToolNames(w.cast.deps)).not.toContain("web_search");
    expect(offeredToolNames(w.cast.deps)).not.toContain("web_fetch");
  });

  it("list_places shows her rooms and DMs by handle", async () => {
    const w = await lifeWorld(roots);
    await kevinDms(w);
    const listed = text(await run("list_places", {}, await ctxFor(w)));
    expect(listed).toContain("bake-club/#general");
    expect(listed).toContain("bake-club/#recipes");
    expect(listed).toContain("dm/kevin");
    vi.restoreAllMocks();
    expect(ARIA_BOT).toBeTruthy();
  });
});
