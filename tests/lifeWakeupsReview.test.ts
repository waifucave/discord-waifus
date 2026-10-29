// Review fixes of Wakeup(script) (Living cast spec §30.6): one bad wakeup never reaches another
// waifu or her other scheduler steps, pages follow the owner's fetch switch and never refetch sooner
// for an edit, a forgotten person's id never reaches her code, D14 covers why a wakeup stopped, its
// error wake and her own reads of the file, forget looks at a page's URL and the stop reason, and the
// app never grows her file past its cap.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubOtherState } from "../src/life/forget.js";
import { HomeStore } from "../src/life/home/homeStore.js";
import { homeStoreFor } from "../src/life/home/index.js";
import { readLifeFile } from "../src/life/lifeStore.js";
import { withPlaceRecord } from "../src/life/placeRecorder.js";
import { sharedSandbox } from "../src/life/sandbox/index.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { MAX_WAKEUPS_FILE_BYTES, WAKEUPS_FILE_HARD_BYTES } from "../src/life/wakeups/file.js";
import { checkPages, fireWakeupWatches, PAGE_FETCHES_PER_DAY, type WakeupMessage } from "../src/life/wakeups/run.js";
import { saveWakeupStates, STATE_TOO_BIG } from "../src/life/wakeups/schedule.js";
import { setState } from "../src/life/wakeups/state.js";
import { redactedWakeupsText, wakeupView } from "../src/life/wakeups/view.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { PRIVATE_FILE_NAME } from "../src/shared/constants/files.js";
import { WakeupSideSchema } from "../src/shared/schemas/life.js";
import { CHANNEL, closeWorlds, dmOf, GUILD, herEntries, herFile, KEVIN, lifeWorld, MINA_BOT, ROOM, ROOM_KEY, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { readFile as readFile_, wakeupCall, wakeupCalls } from "./toolCalls.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

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
const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, ctx);
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
/** §30-style calls over tools.wakeup (tests/toolCalls.ts). */
const wakeup = async (w: LifeWorld, script: string) => text(await wakeupCalls(await ctxFor(w), script));
const storeOf = async (w: LifeWorld) => homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
function message(body: string, o: Partial<WakeupMessage> = {}): WakeupMessage {
  return { placeKey: ROOM_KEY, handle: async () => "bake-club/#general", authorId: KEVIN, fromName: "Kevin", isWaifu: false, text: body, mentionsMe: false, repliesToMe: false, own: false, ...o };
}
async function kevinDm(w: LifeWorld): Promise<void> {
  const posted = w.discord.post(dmOf("ella"), "hi");
  await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: posted.id, createdAt: posted.createdAt });
  w.cast.intake.close();
}

describe("one waifu's wakeups never reach anyone else (review 1)", () => {
  it("her failing wakeup (a sandbox that throws, a state that isn't JSON) never stops another waifu's mention in that room", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }, { id: "mina", name: "Mina", botId: "mina-bot" }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    vi.spyOn(w.cast.life("mina"), "poke").mockImplementation(() => undefined);
    expect(await wakeup(w, 'watch("bake-club/#general", (m, s) => { s.toJSON = function () { return undefined }; return true }, {for: "1d", once: false}, "odd")')).toMatch(/^set w1 /u);
    const say = async (body: string) => {
      const posted = w.discord.post(ROOM, body, { mentions: { [MINA_BOT]: "Mina" } });
      await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: posted.id, castWaifuIds: ["ella", "mina"], authorIsWaifu: false, raw: posted });
      w.cast.intake.flushDetector();
      await w.cast.settle();
    };
    await say("<@Mina> first?");
    // The sandbox itself failing for her: caught for her alone.
    const call = vi.spyOn(sharedSandbox(), "call").mockRejectedValueOnce(new Error("boom"));
    await say("<@Mina> second?");
    expect(call).toHaveBeenCalled();
    const mina = (await readLifeFile(w.storage, "mina", "wakes")).immediate;
    expect(mina.filter((wake) => wake.reason === "mention")).toHaveLength(2);
    // Her state that isn't JSON counted as her error (the second message's run never happened).
    const side = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/wakeup-ids.json"), "utf8")) as { errors: Record<string, number> };
    expect(side.errors["w1"]).toBe(1);
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.filter((wake) => wake.reason === "watch")).toEqual([]);
  }, 30_000);

  it("her wakeups step failing never stops her other scheduler steps (a timed plan still fires)", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await writeHerFile(w, "life/schedule.json", JSON.stringify({ date: "2026-10-24", plans: [{ at: "14:05", what: "bake the tarts" }] }));
    await w.cast.scheduler.tick();
    w.clock.ms = Date.parse("2026-10-24T14:06:00.000Z");
    const failing = vi.spyOn(HomeStore.prototype, "readWakeups").mockRejectedValueOnce(new Error("unreadable"));
    const warn = vi.spyOn(w.cast.deps.logger, "warn");
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(failing).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Life scheduler tick failed", expect.objectContaining({ step: "wakeups", message: "unreadable" }));
    expect(queue.immediate.map((wake) => wake.reason)).toContain("plan");
  });
});

describe("pages follow the owner's fetch switch and their own timing (review 5)", () => {
  it("with page fetching off, page() is refused and the scheduler fetches nothing", async () => {
    const w = await lifeWorld(roots);
    expect(await wakeup(w, 'page("https://example.com/shop", "changes", {every: "1h", for: "1d"}, "shop")')).toMatch(/^set p1 /u);
    w.setConfig((config) => ({ ...config, life: { ...config.life, webFetch: { ...config.life.webFetch, maxPerWaifuPerDay: 0 } } }));
    expect(await wakeup(w, 'page("https://example.com/other", "changes", {every: "1h", for: "1d"}, "other")')).toBe(
      "error: Error: page[0]: web pages can't be checked: the owner turned page fetching off; nothing was saved (line 2)"
    );
    // Her other wakeups still save, the unchanged page stays.
    expect(await wakeup(w, 'at("in 1h", "tea")')).toMatch(/^set t1 /u);
    const fetch = vi.spyOn(w.cast.deps.web!, "fetchForWakeup");
    w.clock.advance(2 * 3_600_000);
    await w.cast.scheduler.tick();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an edit, or a cancel and a new page() for the same URL, never fetches it sooner; at most 72 page fetches a day", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, 'page("https://example.com/shop", "changes", {every: "1h", for: "2d"}, "shop")');
    const store = await storeOf(w);
    const fetches: string[] = [];
    const fetch = async (url: string) => {
      fetches.push(url);
      return { ok: true as const, page: { url, status: 200, title: "Shop", text: "v1" } };
    };
    const check = (minutes: number) => checkPages({ store, sandbox: sharedSandbox(), now: new Date(NOW.getTime() + minutes * 60_000), timeZone: TZ, fetch, everyMs: () => 3_600_000 });
    await check(0);
    expect(fetches).toHaveLength(1);
    await wakeup(w, 'cancel("p1")\npage("https://example.com/shop", {contains: "v2"}, {every: "1h", for: "2d"}, "again")');
    await check(10);
    expect(fetches).toHaveLength(1);
    await check(60);
    expect(fetches).toHaveLength(2);
    // The day's cap holds whatever the pages.
    await store.rewriteWakeups((entries, side) => ({ entries, side: { ...side, pageFetches: Array.from({ length: PAGE_FETCHES_PER_DAY }, () => new Date(NOW.getTime() + 61 * 60_000).toISOString()) } }));
    await check(240);
    expect(fetches).toHaveLength(2);
  });
});

describe("a forgotten person's id never reaches her code (review 6)", () => {
  it("a removed message gives her filter no fromId and no files, and matches no `from`", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, ['watch("bake-club/#general", (m) => m.fromId === null && m.files.length === 0 ? "anonymous" : "seen " + m.fromId, {for: "1d", once: false}, "who")', `watch("bake-club/#general", {from: "<@${KEVIN}>"}, {for: "1d"}, "kevin")`].join("\n"));
    const { fired } = await fireWakeupWatches({ store: await storeOf(w), sandbox: sharedSandbox(), now: NOW, timeZone: TZ }, message("(removed)", { removed: true, files: [{ name: "a.png" }] }), { maxFiresPerDay: 24 });
    expect(fired).toEqual([{ id: "w1", note: "who", matched: "anonymous" }]);
  });
});

describe("D14: why a wakeup stopped, its error wake, her own reads (review 7)", () => {
  it("a stop reason of a private or everywhere watch is redacted in the owner's views and the redacted file", () => {
    const side = WakeupSideSchema.parse({ watches: { w1: { placeKeys: ["dm_300000000000000003_ella"], fires: [] } } });
    const dm = { id: "w1", kind: "watch" as const, places: "dm/kevin", filter: "(m) => JSON.parse(m.text)", options: { until: "2026-10-25 14:00" }, note: "biopsy", disabled: "SyntaxError: unexpected token: 'biopsy'" };
    const anywhere = { id: "w2", kind: "watch" as const, places: "everywhere", filter: "(m) => JSON.parse(m.text)", options: { until: "2026-10-25 14:00" }, note: "json", disabled: "SyntaxError: unexpected token: 'my'" };
    const room = { id: "w3", kind: "watch" as const, places: "bake-club/#general", filter: "(m) => m.x.y", options: { until: "2026-10-25 14:00" }, note: "room", disabled: "TypeError: x" };
    const view = (entry: typeof dm, includePrivate: boolean) => wakeupView(entry, side, { includePrivate, timeZone: TZ, now: NOW });
    expect(view(dm, false).disabled).toBe(PRIVATE_FILE_NAME);
    expect(view(anywhere, false).disabled).toBe(PRIVATE_FILE_NAME);
    expect(view(room, false).disabled).toBe("TypeError: x");
    expect(view(anywhere, true).disabled).toBe("SyntaxError: unexpected token: 'my'");
    const file = `${[dm, anywhere, room].map((entry) => JSON.stringify(entry)).join(",\n")}`;
    const redacted = redactedWakeupsText(`[\n${file}\n]\n`, [dm, anywhere, room], side);
    expect(redacted).not.toContain("biopsy");
    expect(redacted).not.toContain("'my'");
    expect(redacted).toContain("TypeError: x");
  });

  it("an error wake of a watch that may have seen a DM is a DM wake; a room watch's is not", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, ['watch("everywhere", (m) => m.nothing.here, {for: "1d"}, "anywhere")', 'watch("bake-club/#general", (m) => m.nothing.here, {for: "1d"}, "room")'].join("\n"));
    const ctx = { store: await storeOf(w), sandbox: sharedSandbox(), now: NOW, timeZone: TZ };
    const wakes = [];
    for (let i = 0; i < 3; i += 1) wakes.push(...(await fireWakeupWatches(ctx, message(`m${i}`), { maxFiresPerDay: 24 })).errorWakes);
    expect(wakes.map((wake) => [wake.watchId, wake.dm ?? false])).toEqual([
      ["w1", true],
      ["w2", false]
    ]);
  });

  it("her Read or cat of ~/life/wakeups.json holding a private wakeup is a DM call", async () => {
    const w = await lifeWorld(roots);
    await kevinDm(w);
    const ctx = await ctxFor(w);
    expect(await wakeup(w, 'at("in 1h", "tea")')).toMatch(/^set t1/u);
    const before = await withPlaceRecord(() => readFile_(ctx, "~/life/wakeups.json"));
    expect([...before.places].some((key) => key.startsWith("dm_"))).toBe(false);
    expect(await wakeup(w, 'watch("dm/kevin", {words: ["biopsy"]}, {for: "1d"}, "ask how it went")')).toMatch(/^set w1/u);
    const read = await withPlaceRecord(() => readFile_(ctx, "~/life/wakeups.json"));
    expect([...read.places].some((key) => key.startsWith("dm_"))).toBe(true);
    const bash = await withPlaceRecord(() => run("Bash", { command: "cat ~/life/wakeups.json" }, ctx));
    expect(text(bash.value)).toContain("biopsy");
    expect([...bash.places].some((key) => key.startsWith("dm_"))).toBe(true);
  }, 30_000);
});

describe("forget looks at a page's URL and why a wakeup stopped (review 8)", () => {
  it("removes a page whose URL names the person and a wakeup whose stop reason does", async () => {
    const w = await lifeWorld(roots);
    await writeHerFile(
      w,
      "life/wakeups.json",
      JSON.stringify([
        { kind: "page", url: "https://example.com/quillon-blog", check: "changes", options: { every: "6h", for: "2d" }, note: "a blog" },
        { kind: "watch", places: "bake-club/#general", filter: "(m) => m.x.y", options: { for: "1d" }, note: "a filter", disabled: "TypeError: Quillon is not defined" },
        { kind: "at", when: "in 2h", note: "buy flour" }
      ])
    );
    const deps = (w.cast as unknown as { deps: Parameters<typeof scrubOtherState>[0] }).deps;
    await scrubOtherState(deps, { id: "ella", name: "Ella", displayName: "Ella" } as Parameters<typeof scrubOtherState>[1], { userId: KEVIN, names: ["Quillon"], sharedNames: [] });
    expect((await herEntries(w)).map((entry) => entry["note"])).toEqual(["buy flour"]);
  });
});

describe("the app never grows her file past its cap (review 10)", () => {
  it("a waiting state that would push wakeups.json past her cap is not written, counts, and stops the wakeup at three", async () => {
    const w = await lifeWorld(roots);
    const filler = `/* ${"x".repeat(5_000)} */`;
    await writeHerFile(w, "life/wakeups.json", JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ kind: "watch", places: "bake-club/#general", filter: `(m, s) => { ${filler} return false }`, options: { for: "1d" }, note: `w${i}` }))));
    const store = await storeOf(w);
    const { entries } = await store.readWakeups();
    const dataRoot = w.storage.dataRoot;
    const wakes = [];
    for (let round = 0; round < 3; round += 1) {
      for (const entry of entries) setState(dataRoot, "ella", entry.id, entry.filter as string, { kept: "y".repeat(2_000 + round) }, NOW.getTime());
      const saved = await saveWakeupStates(store, NOW.getTime(), { force: true });
      wakes.push(...saved.errorWakes);
      const written = (await readFile(path.join(w.root, "user/waifus/ella/home/life/wakeups.json"), "utf8"));
      expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(WAKEUPS_FILE_HARD_BYTES);
    }
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes[0]!.note).toBe(`wakeup ${wakes[0]!.watchId} stopped: ${STATE_TOO_BIG}`);
    const after = await herEntries(w);
    expect(after.filter((entry) => entry["disabled"] === STATE_TOO_BIG).length).toBe(wakes.length);
  }, 30_000);

  it("why a wakeup stopped is bounded in her file", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, 'watch("bake-club/#general", (m) => { throw new Error("e".repeat(100000)) }, {for: "1d"}, "loud")');
    const ctx = { store: await storeOf(w), sandbox: sharedSandbox(), now: NOW, timeZone: TZ };
    for (let i = 0; i < 3; i += 1) await fireWakeupWatches(ctx, message(`m${i}`), { maxFiresPerDay: 24 });
    const [entry] = await herEntries(w);
    expect([...(entry!["disabled"] as string)].length).toBeLessThanOrEqual(300);
  });
});

describe("a nearly full file still takes a stop, and its side file is always saved (re-review 1)", () => {
  /** Her wakeups.json as full as her own writes may make it, with long code in every entry. */
  async function nearlyFull(w: LifeWorld, entries: Array<Record<string, unknown>>) {
    const base = JSON.stringify(entries.map((entry) => ({ ...entry, code: "" })));
    const room = MAX_WAKEUPS_FILE_BYTES - Buffer.byteLength(base, "utf8") - 1_500;
    const filler = Math.floor(room / entries.length);
    const withCode = entries.map(({ code, ...entry }) => {
      const body = `(${entry["kind"] === "page" ? "p" : "m"}, s) => { /* ${"x".repeat(filler - 60)} */ ${String(code)} }`;
      return entry["kind"] === "page" ? { ...entry, check: body } : { ...entry, filter: body };
    });
    await writeHerFile(w, "life/wakeups.json", JSON.stringify(withCode));
    const size = await fileSize(w);
    expect(size).toBeGreaterThan(MAX_WAKEUPS_FILE_BYTES - 2_000);
    expect(size).toBeLessThanOrEqual(MAX_WAKEUPS_FILE_BYTES);
  }
  const fileSize = async (w: LifeWorld) => Buffer.byteLength(await readFile(path.join(w.root, "user/waifus/ella/home/life/wakeups.json"), "utf8"), "utf8");

  it("ten throwing watches with long errors are all stopped at the third message, each with one wake, never again", async () => {
    const w = await lifeWorld(roots);
    await nearlyFull(
      w,
      Array.from({ length: 10 }, (_, i) => ({ kind: "watch", places: "bake-club/#general", options: { for: "1d", once: false }, note: `w${i}`, code: 'throw new Error("é\\u0001" + "e".repeat(5000))' }))
    );
    const ctx = { store: await storeOf(w), sandbox: sharedSandbox(), now: NOW, timeZone: TZ };
    const perMessage: number[] = [];
    for (let i = 0; i < 5; i += 1) perMessage.push((await fireWakeupWatches(ctx, message(`m${i}`), { maxFiresPerDay: 24 })).errorWakes.length);
    expect(perMessage).toEqual([0, 0, 10, 0, 0]);
    expect((await herEntries(w)).every((entry) => typeof entry["disabled"] === "string")).toBe(true);
    expect(await fileSize(w)).toBeLessThanOrEqual(WAKEUPS_FILE_HARD_BYTES);
    const side = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/wakeup-ids.json"), "utf8")) as { errors: Record<string, number> };
    expect(side.errors).toEqual({});
  }, 60_000);

  it("a throwing hourly page check is fetched once an hour (never every tick) and stopped at its third failure", async () => {
    const w = await lifeWorld(roots);
    await nearlyFull(w, [
      ...Array.from({ length: 9 }, (_, i) => ({ kind: "watch", places: "bake-club/#general", options: { for: "1d" }, note: `w${i}`, code: "return false" })),
      { kind: "page", url: "https://example.com/shop", options: { every: "1h", for: "2d" }, note: "shop", code: 'throw new Error("x".repeat(5000))' }
    ]);
    const store = await storeOf(w);
    const fetches: string[] = [];
    const fetch = async (url: string) => {
      fetches.push(url);
      return { ok: true as const, page: { url, status: 200, title: "Shop", text: "v1" } };
    };
    const wakes = [];
    // A tick every 15 s for three hours and a bit.
    for (let tick = 0; tick <= (3 * 3_600) / 15 + 4; tick += 1) {
      const now = new Date(NOW.getTime() + tick * 15_000);
      wakes.push(...(await checkPages({ store, sandbox: sharedSandbox(), now, timeZone: TZ, fetch, everyMs: () => 3_600_000 })));
    }
    expect(fetches).toHaveLength(3);
    expect(wakes.map((wake) => wake.reason)).toEqual(["wakeup_error"]);
    expect((await herEntries(w)).find((entry) => entry["id"] === "p1")!["disabled"]).toMatch(/^Error: x+…$/u);
  }, 120_000);
});

describe("a file over the app's own cap (written on disk) is never grown, yet its side file is kept (re-review 1)", () => {
  it("a stop it can't take sends no wake; a throwing page check still keeps its hourly pace and the day's cap", async () => {
    const w = await lifeWorld(roots);
    const until = "2026-10-26 14:00";
    const big = (i: number) => `(m, s) => { /* ${i} ${"x".repeat(8_100)} */ return false }`;
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `w${i + 2}`, kind: "watch", places: "bake-club/#general", filter: big(i), options: { until, once: false }, note: `w${i}` })),
      { id: "w1", kind: "watch", places: "bake-club/#general", filter: '(m) => { throw new Error("no") }', options: { until, once: false }, note: "broken" },
      { id: "p1", kind: "page", url: "https://example.com/shop", check: '(p) => { throw new Error("no") }', options: { every: "1h", until }, note: "shop" }
    ];
    const file = path.join(w.root, "user/waifus/ella/home/life/wakeups.json");
    await mkdir(path.dirname(file), { recursive: true });
    const text = `[\n${entries.map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n]\n`;
    await writeFile(file, text);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(WAKEUPS_FILE_HARD_BYTES);
    // Its side file as the app had it (the places resolved).
    const watches = Object.fromEntries(entries.filter((entry) => entry.kind === "watch").map((entry) => [entry.id, { placeKeys: [ROOM_KEY], fires: [] }]));
    await mkdir(path.join(w.root, "user/waifus/ella/life"), { recursive: true });
    await writeFile(path.join(w.root, "user/waifus/ella/life/wakeup-ids.json"), JSON.stringify({ nextId: { t: 1, w: 10, p: 2 }, sourceHash: createHash("sha256").update(text, "utf8").digest("hex"), watches }));
    const store = await storeOf(w);
    const ctx = { store, sandbox: sharedSandbox(), now: NOW, timeZone: TZ };
    const errorWakes = [];
    for (let i = 0; i < 5; i += 1) errorWakes.push(...(await fireWakeupWatches(ctx, message(`m${i}`), { maxFiresPerDay: 24 })).errorWakes);
    // No wake for a stop that never reached her file.
    expect(errorWakes).toEqual([]);
    const fetches: string[] = [];
    const fetch = async (url: string) => {
      fetches.push(url);
      return { ok: true as const, page: { url, status: 200, title: "Shop", text: "v1" } };
    };
    const wakes = [];
    for (let tick = 0; tick < 20; tick += 1) wakes.push(...(await checkPages({ ...ctx, now: new Date(NOW.getTime() + tick * 15_000), fetch, everyMs: () => 3_600_000 })));
    expect(fetches).toHaveLength(1);
    expect(wakes).toEqual([]);
    const side = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/wakeup-ids.json"), "utf8")) as { pageFetches: string[]; errors: Record<string, number> };
    expect(side.pageFetches).toHaveLength(1);
    expect(side.errors["p1"]).toBe(1);
  }, 60_000);
});

describe("pages and watch ends (re-review 2 and 3)", () => {
  it("a URL fragment is the same page: no fetch sooner after a cancel; another query is another page", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, 'page("https://example.com/shop#top", "changes", {every: "1h", for: "2d"}, "shop")');
    const store = await storeOf(w);
    const fetches: string[] = [];
    const fetch = async (url: string) => {
      fetches.push(url);
      return { ok: true as const, page: { url, status: 200, title: "Shop", text: "v1" } };
    };
    const check = (minutes: number) => checkPages({ store, sandbox: sharedSandbox(), now: new Date(NOW.getTime() + minutes * 60_000), timeZone: TZ, fetch, everyMs: () => 3_600_000 });
    await check(0);
    await wakeup(w, 'cancel("p1")\npage("https://example.com/shop#bottom", "changes", {every: "1h", for: "2d"}, "again")');
    await check(5);
    expect(fetches).toEqual(["https://example.com/shop#top"]);
    await wakeup(w, 'page("https://example.com/shop?a=1", "changes", {every: "1h", for: "2d"}, "other")');
    await check(6);
    expect(fetches).toEqual(["https://example.com/shop#top", "https://example.com/shop?a=1"]);
  });

  it("the end of a watch on a DM or on everywhere is a DM wake; a room watch's and a timer's are not", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await kevinDm(w);
    expect(
      await wakeup(
        w,
        [
          'watch("dm/kevin", {any: true}, {for: "30m"}, "his reply")',
          'watch("everywhere", {words: ["cake"]}, {for: "30m"}, "cake")',
          'watch("bake-club/#general", {any: true}, {for: "30m"}, "room")'
        ].join("\n")
      )
    ).toMatch(/^set w1 /u);
    // A timer: a watch with no filter.
    expect(text(await wakeupCall(await ctxFor(w), '{ watch: [{ places: "everywhere", for: "30m", note: "tea" }] }'))).toMatch(/^set w4 \(timer, /u);
    w.clock.advance(31 * 60_000);
    await w.cast.scheduler.tick();
    const ends = (await readLifeFile(w.storage, "ella", "wakes")).immediate.filter((wake) => wake.reason === "watch_timeout");
    expect(ends.map((wake) => [wake.note, wake.dm ?? false])).toEqual([
      ["his reply", true],
      ["cake", true],
      ["room", false],
      ["tea", false]
    ]);
  });
});

