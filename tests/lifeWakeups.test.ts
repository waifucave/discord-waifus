// Wakeup(script) and ~/life/wakeups.json (Living cast spec §30): the time words of at() and every(),
// her functions (closures refused, compiled in the sandbox), the tool's all-or-nothing script with
// line numbers and caps, the file's checks on every write, watches matching with object and code
// filters (state across messages, string returns, errors disabling after three), several wakeups on
// one message as one wake, timed wakeups and ends in the scheduler, state saved at most once a
// minute, and pages (contains, changes, a function; every ≥ 1h; the fetcher's SSRF deny).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLivingCastWakeups } from "../src/backend/migrationSteps/livingCastWakeups.js";
import { homeStoreFor } from "../src/life/home/index.js";
import { readLifeFile } from "../src/life/lifeStore.js";
import { selfAuthorIds } from "../src/life/people.js";
import { sharedSandbox } from "../src/life/sandbox/index.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { renderNotifications } from "../src/life/notifications.js";
import { CLOSURE_REFUSED, checkFunctionSource } from "../src/life/wakeups/functionSource.js";
import { checkPages, fireWakeupWatches, type WakeupMessage } from "../src/life/wakeups/run.js";
import { timedWakeId } from "../src/life/wakeups/schedule.js";
import { STATE_SAVE_MS } from "../src/life/wakeups/state.js";
import { nextOccurrences, parseAt, parseDuration, parseEvery } from "../src/life/wakeups/when.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { closeWorlds, dmOf, ELLA_BOT, GUILD, CHANNEL, herEntries, herFile, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, applyPatch, readFile as readFile_, runScript, wakeupCall, wakeupCalls } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const TZ = "UTC";
const NOW = new Date("2026-10-24T14:00:00.000Z"); // a Saturday

async function ctxFor(w: LifeWorld, waifuId = "ella"): Promise<ToolContext> {
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
/** §30-style calls over tools.wakeup (setting wakeups up), and one tools.wakeup call. */
const wakeup = async (w: LifeWorld, script: string) => text(await wakeupCalls(await ctxFor(w), script));
const call = async (w: LifeWorld, arg: string) => text(await wakeupCall(await ctxFor(w), arg));

function message(body: string, o: Partial<WakeupMessage> = {}): WakeupMessage {
  return { placeKey: ROOM_KEY, handle: async () => "bake-club/#general", authorId: KEVIN, fromName: "Kevin", isWaifu: false, text: body, mentionsMe: false, repliesToMe: false, own: false, ...o };
}

describe("times: at() and every() (§30.2)", () => {
  it("at: a local time, HH:MM (today, else tomorrow), a weekday, tomorrow, in 45m / 2h", () => {
    const at = (value: string) => {
      const parsed = parseAt(value, NOW, TZ);
      return parsed.ok ? parsed.value.toISOString() : parsed.error;
    };
    expect(at("2026-10-30 18:00")).toBe("2026-10-30T18:00:00.000Z");
    expect(at("18:00")).toBe("2026-10-24T18:00:00.000Z");
    expect(at("13:00")).toBe("2026-10-25T13:00:00.000Z");
    expect(at("fri 18:00")).toBe("2026-10-30T18:00:00.000Z");
    expect(at("Friday 18:00")).toBe("2026-10-30T18:00:00.000Z");
    expect(at("sat 13:00")).toBe("2026-10-31T13:00:00.000Z");
    expect(at("sat 15:00")).toBe("2026-10-24T15:00:00.000Z");
    expect(at("tomorrow 09:00")).toBe("2026-10-25T09:00:00.000Z");
    expect(at("in 45m")).toBe("2026-10-24T14:45:00.000Z");
    expect(at("in 2h")).toBe("2026-10-24T16:00:00.000Z");
    expect(at("in 1h30m")).toBe("2026-10-24T15:30:00.000Z");
    expect(at("someday")).toMatch(/isn't a time/u);
    expect(at("in a bit")).toMatch(/isn't a duration/u);
  });

  it("every: day, weekday, weekend, day lists and a 5-field cron with steps of at least 15 minutes", () => {
    const next = (value: string) => {
      const spec = parseEvery(value);
      if (!spec.ok) return spec.error;
      return nextOccurrences(spec.value, NOW, TZ, 3).map((date) => date.toISOString().slice(0, 16));
    };
    expect(next("day 09:00")).toEqual(["2026-10-25T09:00", "2026-10-26T09:00", "2026-10-27T09:00"]);
    expect(next("weekday 08:30")).toEqual(["2026-10-26T08:30", "2026-10-27T08:30", "2026-10-28T08:30"]);
    expect(next("weekend 11:00")).toEqual(["2026-10-25T11:00", "2026-10-31T11:00", "2026-11-01T11:00"]);
    expect(next("mon,fri 18:30")).toEqual(["2026-10-26T18:30", "2026-10-30T18:30", "2026-11-02T18:30"]);
    expect(next("0 20 1 * *")).toEqual(["2026-11-01T20:00", "2026-12-01T20:00", "2027-01-01T20:00"]);
    expect(next("*/15 9 * * 1-5")).toEqual(["2026-10-26T09:00", "2026-10-26T09:15", "2026-10-26T09:30"]);
    expect(next("*/10 * * * *")).toMatch(/repeats too often; steps of at least 15 minutes/u);
    expect(next("0,10 9 * * *")).toMatch(/repeats too often/u);
    expect(next("0 25 * * *")).toMatch(/isn't a cron I can read/u);
    expect(next("someday 09:00")).toMatch(/isn't a day/u);
  });

  it("durations", () => {
    expect(parseDuration("2h")).toEqual({ ok: true, value: 7_200_000 });
    expect(parseDuration("1h30m")).toEqual({ ok: true, value: 5_400_000 });
    expect(parseDuration("3d")).toEqual({ ok: true, value: 259_200_000 });
    expect(parseDuration("soon").ok).toBe(false);
  });
});

describe("her functions (§30.1)", () => {
  it("must be one self-contained plain function", () => {
    expect(checkFunctionSource("(msg, state) => msg.text.includes('cake') && Math.random() < 2 && JSON.stringify(state) !== ''")).toEqual({ ok: true });
    expect(checkFunctionSource("function (msg) { const words = ['a']; for (const w of words) if (msg.text === w) return true; return false }")).toEqual({ ok: true });
    expect(checkFunctionSource("(msg) => msg.text === kevinId")).toEqual({ ok: false, error: `${CLOSURE_REFUSED} (it uses kevinId)` });
    expect(checkFunctionSource("async (msg) => true")).toMatchObject({ ok: false, error: "the function can't be async or a generator" });
    expect(checkFunctionSource("(m) => true); evil(); ((x) => x")).toMatchObject({ ok: false, error: expect.stringMatching(/give one function/u) });
    expect(checkFunctionSource("(m) => {\n  return m.text ===\n}")).toMatchObject({ ok: false, error: expect.stringMatching(/^SyntaxError/u), line: 3 });
    expect(checkFunctionSource("x".repeat(9000))).toMatchObject({ ok: false, error: expect.stringMatching(/over 8 KiB/u) });
  });

  it("resolves names scope by scope: an inner function's parameter, a catch or a block binding never covers a use outside it (review 9)", () => {
    const refused = (source: string, name: string) => expect(checkFunctionSource(source)).toEqual({ ok: false, error: `${CLOSURE_REFUSED} (it uses ${name})` });
    refused("(msg) => { const f = (kevin) => kevin; return msg.text.includes(kevin) }", "kevin");
    refused("(msg) => { try { JSON.parse(msg.text) } catch (kevin) {} return kevin }", "kevin");
    refused("(msg) => { if (msg.text) { let k = 1 } return k }", "k");
    refused("(msg) => { function inner() { var hidden = 1 } return hidden }", "hidden");
    refused("(msg) => { for (let i = 0; i < 1; i++) {} return i }", "i");
    refused("(msg, kevinDefault = mina) => true", "mina");
    const fine = [
      "(msg) => { var n = 0; for (const w of ['a']) { if (msg.text === w) n++ } return n > 0 }",
      "function f(m) { return f.length > 0 && helper(m); function helper(x) { return !!x } }",
      "(m) => { const C = class K { a() { return K } }; return new C().a() !== null }",
      "(m) => { switch (m.text) { case 'a': const z = 1; return z === 1; default: return false } }",
      "(m) => { if (true) { var later = 1 } return later === 1 }",
      "(m, { a = 1, ...rest } = {}) => a === 1 && Object.keys(rest).length === 0",
      "function (m) { return arguments.length > 0 }"
    ];
    for (const source of fine) expect(checkFunctionSource(source), source).toEqual({ ok: true });
  });
});

describe("Wakeup: tools.wakeup (§30.2, §32.2)", () => {
  it("adds many wakeups in one call, all saved in ~/life/wakeups.json, and echoes the next three times of an every", async () => {
    const w = await lifeWorld(roots);
    const out = await call(
      w,
      `{
        watch: [{ places: "bake-club/#general", from: "<@${KEVIN}>", words: ["saturday"], for: "2h", note: "asked Kevin about saturday" }],
        at: [{ when: "fri 18:00", note: "ask Kevin how the exam went" }],
        every: [{ when: "weekday 08:30", note: "check the bake club" }],
        page: [{ url: "https://example.com/shop", contains: "in stock", every: "6h", for: "3d", note: "the mixer" }]
      }`
    );
    expect(out).toBe(
      [
        "set t1 (Fri 30 Oct 18:00), t2 (every weekday 08:30), w1 (bake-club/#general, until Sat 24 Oct 16:00), p1 (every 6h, until Tue 27 Oct 14:00) (in ~/life/wakeups.json)",
        "t2 next: Mon 26 Oct 08:30, Tue 27 Oct 08:30, Wed 28 Oct 08:30"
      ].join("\n")
    );
    const entries = await herEntries(w);
    expect(entries).toEqual([
      { id: "t1", kind: "at", when: "2026-10-30 18:00", note: "ask Kevin how the exam went" },
      { id: "t2", kind: "every", when: "weekday 08:30", note: "check the bake club" },
      { id: "w1", kind: "watch", places: "bake-club/#general", filter: { from: `<@${KEVIN}>`, words: ["saturday"] }, options: { until: "2026-10-24 16:00", once: true }, note: "asked Kevin about saturday" },
      { id: "p1", kind: "page", url: "https://example.com/shop", check: { contains: "in stock" }, options: { every: "6h", until: "2026-10-27 14:00" }, note: "the mixer" }
    ]);
    // One entry per line; the resolution lives outside her folder.
    expect((await herFile(w, "ella", "home/life/wakeups.json"))!.split("\n")).toHaveLength(7);
    const side = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/wakeup-ids.json"), "utf8")) as { watches: Record<string, unknown> };
    expect(side.watches["w1"]).toEqual({ placeKeys: [ROOM_KEY], filters: [{ fromUserId: KEVIN, fromName: KEVIN, words: ["saturday"] }], fires: [] });
    // cancel in a later script; several calls in one script, each saved on its own.
    expect(await call(w, '{ cancel: ["t1"] }')).toBe("cancelled t1 (in ~/life/wakeups.json)");
    expect((await herEntries(w)).map((entry) => entry.id)).toEqual(["t2", "w1", "p1"]);
    const two = text(await runScript("Wakeup", 'text(await tools.wakeup({ at: [{ when: "in 2h", note: "a" }] })); text(await tools.wakeup({ cancel: "t2" }))', await ctxFor(w)));
    expect(two).toBe("set t3 (Sat 24 Oct 16:00) (in ~/life/wakeups.json)\ncancelled t2 (in ~/life/wakeups.json)");
  });

  it("is all or nothing per call: any error names the item and saves nothing of it", async () => {
    const w = await lifeWorld(roots);
    await call(w, '{ at: [{ when: "in 1h", note: "first" }] }');
    const before = await herFile(w, "ella", "home/life/wakeups.json");
    const error = (text: string) => `error: Error: ${text}; nothing was saved (line 1)`;
    expect(await call(w, '{ at: [{ when: "fri 18:00", note: "ok" }, { when: "someday", note: "bad" }] }')).toBe(error('at[1]: "someday" isn\'t a time; write it like "fri 18:00", "2026-10-30 18:00", "18:00", "in 45m" or "in 2h"'));
    expect(await call(w, '{ at: [{ when: "in 2m", note: "too soon" }] }')).toBe(error("at[0]: at must be at least 5 minutes ahead"));
    expect(await call(w, '{ watch: [{ places: "nowhere/#x", any: true, for: "1h", note: "n" }] }')).toBe(error("watch[0]: unknown place nowhere/#x; see places.md"));
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", any: true, for: "8d", note: "n" }] }')).toBe(error("watch[0]: options.for can be at most 7d"));
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", any: true, note: "n" }] }')).toBe(error('watch[0]: options needs for (like "2h") or until (a local time like 2026-10-30 18:00)'));
    expect(await call(w, '{ page: [{ url: "https://example.com", changes: true, every: "30m", for: "1d", note: "n" }] }')).toBe(error("page[0]: options.every is at least 1h"));
    expect(await call(w, '{ cancel: ["w9"] }')).toBe(error("cancel[0]: there is no wakeup w9; see ~/life/wakeups.json"));
    expect(await call(w, '{ every: [{ when: "*/5 * * * *", note: "spam" }] }')).toMatch(/^error: Error: every\[0\]: .*repeats too often/u);
    // Shapes are checked before anything runs.
    expect(await call(w, '{ at: [{ when: "fri 18:00", note: "x", extra: 1 }] }')).toBe('error: TypeError: at[0]: unknown field "extra" (it takes when, note) (line 1)');
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", for: "1h" }] }')).toBe("error: TypeError: watch[0] needs from, words, any: true (any message) or a filter function (line 1)");
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", from: "Kevin", filter: (m) => true, for: "1h" }] }')).toBe("error: TypeError: watch[0]: give a filter function or from/words/any, not both (line 1)");
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", filter: "(m) => true", for: "1h" }] }')).toMatch(/^error: TypeError: watch\[0\]: filter is your function/u);
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", any: true, for: () => "1h" }] }')).toBe("error: TypeError: watch[0].for can't be a function (line 1)");
    expect(await call(w, '{ page: [{ url: "https://example.com", every: "1h", for: "1d" }] }')).toMatch(/^error: TypeError: page\[0\] needs one of contains/u);
    expect(await call(w, "{}")).toBe("error: TypeError: tools.wakeup: give it at, every, watch, page or cancel (line 1)");
    expect(await call(w, '"at fri 18:00"')).toMatch(/^error: TypeError: tools\.wakeup takes one object/u);
    expect(text(await runScript("Wakeup", 'const x = 1;\nnothing.here();', await ctxFor(w)))).toBe("error: ReferenceError: 'nothing' is not defined (line 2)");
    expect(text(await runScript("Wakeup", "while (true) {}", await ctxFor(w)))).toMatch(/^error: your script computed for too long/u);
    // An old habit gets told what replaced it.
    expect(text(await runScript("Wakeup", 'at("fri 18:00", "x")', await ctxFor(w)))).toBe("error: TypeError: at() is gone: call tools.wakeup({ at: [...] }) (line 1)");
    expect(text(await run("Wakeup", { script: "" }, await ctxFor(w)))).toMatch(/^error: script/u);
    expect(await herFile(w, "ella", "home/life/wakeups.json")).toBe(before);
    // At most 4 calls in one script.
    const five = text(await runScript("Wakeup", 'for (let i = 0; i < 5; i++) await tools.wakeup({ at: [{ when: "in " + (i + 2) + "h", note: "n" }] })', await ctxFor(w)));
    expect(five).toMatch(/tools\.wakeup: at most 4 calls in one script/u);
  });

  it("refuses filters that use the script's variables, and her code's syntax errors with their line", async () => {
    const w = await lifeWorld(roots);
    expect(text(await runScript("Wakeup", `const kevin = "${KEVIN}";\ntext(await tools.wakeup({ watch: [{ places: "everywhere", filter: (m) => m.fromId === kevin, for: "1h", note: "n" }] }))`, await ctxFor(w)))).toBe(
      `error: Error: watch[0]: its filter: ${CLOSURE_REFUSED} (it uses kevin); nothing was saved (line 2)`
    );
    // Her own toString changes nothing: the host reads the real source and checks it.
    expect(text(await runScript("Wakeup", `const kevin = "x"; const f = (m) => m.fromId === kevin; f.toString = () => "(m) => true"; Function.prototype.toString = () => "(m) => true";\nawait tools.wakeup({ watch: [{ places: "everywhere", filter: f, for: "1h" }] })`, await ctxFor(w)))).toMatch(
      /its filter: filters can't use variables from outside them/u
    );
    // A forged source is checked the same way.
    expect(text(await runScript("Wakeup", `await tools.wakeup({ watch: [{ places: "everywhere", filter: { $function: "(m) => m.fromId === kevin" }, for: "1h" }] })`, await ctxFor(w)))).toMatch(/\(it uses kevin\)/u);
    // A filter that is self-contained is fine, wherever it is defined.
    const filter = `function f(msg, state) {\n  return msg.fromId === "${KEVIN}"\n}\ntext(await tools.wakeup({ watch: [{ places: "everywhere", filter: f, for: "1h", once: false, note: "kevin anywhere" }] }))`;
    expect(text(await runScript("Wakeup", filter, await ctxFor(w)))).toBe("set w1 (everywhere, until Sat 24 Oct 15:00, repeating) (in ~/life/wakeups.json)");
    expect((await herEntries(w))[0]!["filter"]).toBe(`function f(msg, state) {\n  return msg.fromId === "${KEVIN}"\n}`);
    expect(await call(w, '{ watch: [{ places: "everywhere", filter: (m) => {, for: "1h" }] }')).toMatch(/^error: SyntaxError/u);
    expect(await call(w, '{ watch: [{ places: "everywhere", filter: function (m) { return m.x.y.z === ; }, for: "1h" }] }')).toMatch(/^error: SyntaxError/u);
  });

  it("resolves a filter's `from` to one person (ambiguity is an error) and keeps that outside her folder", async () => {
    const w = await lifeWorld(roots);
    // Two people she knows as Kevin (from her DMs).
    for (const userId of [KEVIN, MINA_USER]) {
      const posted = w.discord.post(dmOf("ella", userId), "hi", { authorId: userId, authorName: "Kevin" });
      await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId, userDisplayName: "Kevin", channelId: "dm", messageId: posted.id, createdAt: posted.createdAt });
    }
    w.cast.intake.close();
    expect(await call(w, '{ at: [{ when: "in 1h", note: "fine" }], watch: [{ places: "everywhere", from: "Kevin", for: "1h", note: "n" }] }')).toBe(
      "error: Error: watch[0]: filter: more than one person called Kevin; use <@id>; nothing was saved (line 1)"
    );
    expect(await call(w, `{ watch: [{ places: "everywhere", from: "<@${KEVIN}>", words: ["cake"], for: "1h", note: "Kevin's cake news" }] }`)).toMatch(/^set w1 /u);
    const side = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/wakeup-ids.json"), "utf8")) as { watches: Record<string, { filters: unknown[] }> };
    expect(side.watches["w1"]!.filters).toEqual([{ fromUserId: KEVIN, fromName: "Kevin", words: ["cake"] }]);
  });

  it("caps: 20 timed, 10 watches, 3 pages", async () => {
    const w = await lifeWorld(roots);
    const watches = `{ watch: Array.from({ length: 10 }, (_, i) => ({ places: "bake-club/#general", words: ["w" + i], for: "1h", note: "n" + i })) }`;
    expect(await call(w, watches)).toMatch(/^set w1 .* w10 /u);
    expect(await call(w, '{ watch: [{ places: "bake-club/#general", any: true, for: "1h", note: "one more" }] }')).toBe("error: Error: you'd have 11 watches; at most 10; nothing was saved (line 1)");
    expect(await call(w, `{ page: Array.from({ length: 4 }, (_, i) => ({ url: "https://example.com/" + i, changes: true, every: "1h", for: "1d", note: "p" })) }`)).toBe("error: Error: you'd have 4 pages; at most 3; nothing was saved (line 1)");
    expect(await call(w, `{ at: Array.from({ length: 21 }, (_, i) => ({ when: "in " + (i + 1) + "h", note: "t" })) }`)).toBe("error: Error: you'd have 21 timed wakeups (at and every); at most 20; nothing was saved (line 1)");
  });

  it("is the one wakeup tool: ScheduleWake and WatchFor are gone", () => {
    expect(lifeTool("Wakeup")).toBeDefined();
    expect(lifeTool("ScheduleWake")).toBeUndefined();
    expect(lifeTool("WatchFor")).toBeUndefined();
  });
});

describe("~/life/wakeups.json: every write is checked (§30.3)", () => {
  it("line and column for broken JSON, entry problems by id, for → until and new ids written back (an Edit patch)", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const written = await applyPatch(ctx, addFilePatch("~/life/wakeups.json", JSON.stringify([{ kind: "watch", places: "everywhere", filter: { words: ["cake"] }, options: { for: "2h" }, note: "cake" }])));
    expect(text(written)).toBe("Updated: A ~/life/wakeups.json");
    expect(await herEntries(w)).toEqual([{ id: "w1", kind: "watch", places: "everywhere", filter: { words: ["cake"] }, options: { until: "2026-10-24 16:00", once: true }, note: "cake" }]);
    const file = (await herFile(w, "ella", "home/life/wakeups.json"))!;
    const line = file.split("\n")[1]!;
    const edit = (from: string, to: string) => applyPatch(ctx, `*** Begin Patch\n*** Update File: ~/life/wakeups.json\n@@\n-${line}\n+${line.replace(from, to)}\n*** End Patch`);
    expect(text(await edit('"id": "w1",', '"id": "w1",,'))).toMatch(/^error: Error: apply_patch: wakeups\.json line 2, column \d+: .*; nothing was changed/u);
    expect(text(await edit('"until": "2026-10-24 16:00"', '"until": "2026-10-20 10:00"'))).toMatch(/wakeups\.json entry w1: options\.until is in the past; nothing was changed/u);
    expect(text(await edit('{"words": ["cake"]}', '"(msg) => msg.text.includes(\\"cake\\") &&"'))).toMatch(/wakeups\.json entry w1: its filter: SyntaxError/u);
    expect(text(await edit('{"words": ["cake"]}', '"(msg) => msg.text === cake"'))).toMatch(new RegExp(`wakeups\\.json entry w1: its filter: ${CLOSURE_REFUSED.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(it uses cake\\)`, "u"));
    expect(text(await edit('"id": "w1"', '"id": "t1"'))).toMatch(/wakeups\.json entry t1: a watch wakeup's id starts with w/u);
    expect(await herFile(w, "ella", "home/life/wakeups.json")).toBe(file);
    expect((await edit('{"words": ["cake"]}', '"(msg, state) => msg.text.includes(\\"cake\\")"')).isError).toBeFalsy();
  });

  it("the retired Write (kept for old log lines) still needs a current Read before replacing wakeups.json", async () => {
    const w = await lifeWorld(roots);
    await run("Write", { file_path: "~/life/wakeups.json", content: "[]" }, await ctxFor(w));
    const ctx = await ctxFor(w);
    expect(text(await run("Write", { file_path: "~/life/wakeups.json", content: "[]" }, ctx))).toBe("error: wakeups.json already exists; Read it first (Write replaces the whole file)");
    await readFile_(ctx, "~/life/wakeups.json");
    expect(text(await run("Write", { file_path: "~/life/wakeups.json", content: '[\n  {"id": "w1",}\n]' }, ctx))).toMatch(/^error: wakeups\.json line 2, column \d+: /u);
  });

  it("changing a stopped wakeup's code turns it back on", async () => {
    const w = await lifeWorld(roots);
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ id: "w1", kind: "watch", places: "everywhere", filter: "(m) => m.x.y", options: { for: "2h" }, note: "n", disabled: "TypeError: x (line 1)" }]));
    expect((await herEntries(w))[0]!["disabled"]).toBe("TypeError: x (line 1)");
    const ctx = await ctxFor(w);
    const line = (await herFile(w, "ella", "home/life/wakeups.json"))!.split("\n").find((entry) => entry.includes("m.x.y"))!;
    const patched = await applyPatch(ctx, `*** Begin Patch\n*** Update File: ~/life/wakeups.json\n@@\n-${line}\n+${line.replace("m.x.y", "m.text === 'hi'")}\n*** End Patch`);
    expect(text(patched)).toBe("Updated: M ~/life/wakeups.json");
    expect((await herEntries(w))[0]!["disabled"]).toBeUndefined();
  });
});

describe("watches: object and code filters (§30.2)", () => {
  async function storeOf(w: LifeWorld) {
    return homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
  }
  const ctxOf = async (w: LifeWorld, at: Date) => ({ store: await storeOf(w), sandbox: sharedSandbox(), now: at, timeZone: TZ });

  it("object filters match words, people and any message; once watches go at their first fire; never her own messages", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, ['watch("bake-club/#general", {words: ["brownie"]}, {for: "1h"}, "brownies")', 'watch("everywhere", {from: "<@' + KEVIN + '>"}, {for: "1h", once: false}, "kevin")'].join("\n"));
    const fire = async (body: string, o: Partial<WakeupMessage> = {}, at = NOW) => (await fireWakeupWatches(await ctxOf(w, at), message(body, o), { maxFiresPerDay: 24 })).fired;
    expect(await fire("one BROWNIE please", { own: true })).toEqual([]);
    expect(await fire("one BROWNIE please")).toEqual([
      { id: "w1", note: "brownies", matched: "brownie" },
      { id: "w2", note: "kevin", matched: `from ${KEVIN}` }
    ]);
    // w1 is gone; w2 repeats at most once per 10 minutes.
    expect(await fire("brownie again", {}, new Date(NOW.getTime() + 5 * 60_000))).toEqual([]);
    expect((await fire("hi", {}, new Date(NOW.getTime() + 11 * 60_000))).map((hit) => hit.id)).toEqual(["w2"]);
    expect(await fire("hi", { authorId: MINA_USER }, new Date(NOW.getTime() + 30 * 60_000))).toEqual([]);
    expect((await herEntries(w)).map((entry) => entry.id)).toEqual(["w2"]);
  });

  it("a function filter keeps state across messages and may return its own line", async () => {
    const w = await lifeWorld(roots);
    const filter = `(msg, state) => {
      state.seen = state.seen || {};
      state.seen[msg.from] = Date.parse(msg.at);
      const k = state.seen.Kevin, m = state.seen.Mina;
      if (k && m && Math.abs(k - m) < 10 * 60000) return "Kevin and Mina both talked within 10 minutes";
      return false;
    }`;
    await wakeup(w, `watch("bake-club/#general", ${filter}, {for: "1d"}, "both of them")`);
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const fire = async (from: string, minutes: number) =>
      (await fireWakeupWatches(await ctxOf(w, at(minutes)), message("hi", { fromName: from, createdAt: at(minutes).toISOString() }), { maxFiresPerDay: 24 })).fired;
    expect(await fire("Kevin", 0)).toEqual([]);
    expect(await fire("Mina", 15)).toEqual([]);
    expect(await fire("Kevin", 20)).toEqual([{ id: "w1", note: "both of them", matched: "Kevin and Mina both talked within 10 minutes" }]);
  });

  it("errors are counted: three in a row stop the wakeup with a wakeup_error wake; a state over 4 KiB is an error", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, ['watch("bake-club/#general", (msg) => msg.nothing.here, {for: "1d"}, "broken")', 'watch("bake-club/#general", (msg, state) => { state.big = "x".repeat(5000); return false }, {for: "1d"}, "big")'].join("\n"));
    const ctx = await ctxOf(w, NOW);
    const errors = [];
    for (let i = 0; i < 3; i += 1) errors.push(...(await fireWakeupWatches(ctx, message(`m${i}`), { maxFiresPerDay: 24 })).errorWakes);
    expect(errors.map((wake) => wake.note)).toEqual([
      "wakeup w1 stopped: TypeError: cannot read property 'here' of undefined (line 1)",
      "wakeup w2 stopped: your filter's state is over 4 KiB; keep less in it"
    ]);
    expect(errors.map((wake) => wake.reason)).toEqual(["wakeup_error", "wakeup_error"]);
    expect(renderNotifications({ wakes: [errors[0]!] }, { timeZone: TZ, handle: (key) => key, unread: () => undefined })).toBe(
      "<notifications>\n- wakeup w1 stopped: TypeError: cannot read property 'here' of undefined (line 1)\n</notifications>"
    );
    const entries = await herEntries(w);
    expect(entries.map((entry) => entry["disabled"])).toEqual(["TypeError: cannot read property 'here' of undefined (line 1)", "your filter's state is over 4 KiB; keep less in it"]);
    // A stopped wakeup stays listed and never runs again.
    expect((await fireWakeupWatches(ctx, message("again"), { maxFiresPerDay: 24 })).errorWakes).toEqual([]);
  });

  it("a filter that runs too long is stopped and counted, never a host problem", async () => {
    const w = await lifeWorld(roots);
    await wakeup(w, 'watch("bake-club/#general", (msg) => { while (true) {} }, {for: "1d"}, "loop")');
    const ctx = await ctxOf(w, NOW);
    const started = Date.now();
    for (let i = 0; i < 3; i += 1) await fireWakeupWatches(ctx, message("x"), { maxFiresPerDay: 24 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await herEntries(w))[0]!["disabled"]).toBe("your filter took too long");
  }, 30_000);

  it("several wakeups on one room message are one wake with a line each (§30.4)", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await wakeup(w, ['watch("bake-club/#general", {words: ["cake"]}, {for: "1h"}, "cake news")', 'watch("bake-club/#general", (msg) => msg.text.length > 5 && "a long one", {for: "1h"}, "long messages")'].join("\n"));
    const posted = w.discord.post(ROOM, "the cake is ready");
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: posted.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: posted });
    w.cast.intake.flushDetector();
    await w.cast.settle();
    const watches = (await readLifeFile(w.storage, "ella", "wakes")).immediate.filter((wake) => wake.reason === "watch");
    expect(watches).toHaveLength(1);
    expect(watches[0]!.wakeups).toEqual([
      { id: "w1", matched: "cake", note: "cake news" },
      { id: "w2", matched: "a long one", note: "long messages" }
    ]);
    const lines = renderNotifications({ wakes: watches }, { timeZone: TZ, handle: () => "bake-club/#general", unread: () => undefined, ref: () => "k1" })!;
    expect(lines.split("\n").slice(1, -1)).toEqual([
      '- watch · bake-club/#general · "cake" · from Kevin · #k1 "the cake is ready" · your note: "cake news"',
      '- watch · bake-club/#general · #k1 · "a long one" · your note: "long messages"'
    ]);
  });
});

describe("after the migration (§30.3)", () => {
  it("a migrated reminder fires under its new id, a daily one keeps its time, and a migrated watch matches", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const dir = path.join(w.root, "user/waifus/ella");
    await mkdir(path.join(dir, "home/life"), { recursive: true });
    await mkdir(path.join(dir, "life"), { recursive: true });
    await writeFile(path.join(dir, "home/life/reminders.json"), JSON.stringify([{ id: "r4", at: "2026-10-24 14:10", note: "tea" }, { id: "r5", at: "2026-10-24 14:20", repeat: "daily", note: "stretch" }]));
    await writeFile(path.join(dir, "home/life/watches.json"), JSON.stringify([{ id: "w3", timeout: "2026-10-25 14:00", once: true, note: "his exam", when: [{ place: "bake-club/#general", words: ["exam"] }] }]));
    await writeFile(path.join(dir, "life/watch-ids.json"), JSON.stringify({ nextId: 4, watches: { w3: { bindings: [{ placeKey: ROOM_KEY, words: ["exam"] }], fires: [] } } }));
    await migrateLivingCastWakeups(w.root, { now: () => w.clock.now(), timeZone: TZ });
    w.clock.advance(21 * 60_000);
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => [wake.id, wake.note])).toEqual([
      [timedWakeId("t4", new Date("2026-10-24T14:10:00.000Z")), "tea"],
      [timedWakeId("t5", new Date("2026-10-24T14:20:00.000Z")), "stretch"]
    ]);
    expect((await herEntries(w)).map((entry) => entry.id)).toEqual(["t5", "w3"]);
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const { fired } = await fireWakeupWatches({ store, sandbox: sharedSandbox(), now: w.clock.now(), timeZone: TZ }, message("the exam went fine"), { maxFiresPerDay: 24 });
    expect(fired.map((hit) => hit.id)).toEqual(["w3"]);
  }, 30_000);
});

describe("the scheduler: timed wakeups, ends, state (§30.2, §30.3)", () => {
  it("an at fires once as a reminder and goes; an every fires once per occurrence and stays", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await wakeup(w, ['at("in 10m", "tea")', 'every("day 14:30", "stretch")'].join("\n"));
    w.clock.advance(11 * 60_000);
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    let queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => [wake.reason, wake.note])).toEqual([["reminder", "tea"]]);
    expect((await herEntries(w)).map((entry) => entry.id)).toEqual(["t2"]);
    w.clock.advance(20 * 60_000);
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => wake.note)).toEqual(["tea", "stretch"]);
    expect(queue.immediate[1]!.at).toBe("2026-10-24T14:30:00.000Z");
    // The next day's occurrence fires once too.
    w.clock.ms = Date.parse("2026-10-25T14:31:00.000Z");
    await w.cast.scheduler.tick();
    await w.cast.scheduler.tick();
    queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => wake.note)).toEqual(["tea", "stretch", "stretch"]);
  });

  it("a watch that ends is a watch_timeout wake (a timer); her code's state is saved at most once a minute", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    // A [] timer is written in her file (tools.wakeup's watch always has a filter).
    const timers = [
      { kind: "watch", places: "bake-club/#general", filter: [], options: { for: "30m" }, note: "tea's ready" },
      { kind: "watch", places: "bake-club/#general", filter: "(msg, state) => { state.n = (state.n || 0) + 1; return false }", options: { for: "1d" }, note: "count" }
    ];
    expect(text(await applyPatch(await ctxFor(w), addFilePatch("~/life/wakeups.json", JSON.stringify(timers))))).toBe("Updated: A ~/life/wakeups.json");
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    await fireWakeupWatches({ store, sandbox: sharedSandbox(), now: w.clock.now(), timeZone: TZ }, message("one"), { maxFiresPerDay: 24 });
    await fireWakeupWatches({ store, sandbox: sharedSandbox(), now: w.clock.now(), timeZone: TZ }, message("two"), { maxFiresPerDay: 24 });
    await w.cast.scheduler.tick();
    expect((await herEntries(w))[1]!["state"]).toBeUndefined();
    w.clock.advance(STATE_SAVE_MS);
    await w.cast.scheduler.tick();
    expect((await herEntries(w))[1]!["state"]).toEqual({ n: 2 });
    w.clock.advance(30 * 60_000);
    await w.cast.scheduler.tick();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => [wake.reason, wake.note])).toEqual([["watch_timeout", "tea's ready"]]);
    expect((await herEntries(w)).map((entry) => entry.id)).toEqual(["w2"]);
  });
});

describe("pages (§30.2)", () => {
  type Page = { status: number; text: string };
  function pageWorld(pages: Page[]) {
    let index = 0;
    const fetches: string[] = [];
    return {
      fetches,
      fetch: async (url: string) => {
        fetches.push(url);
        const page = pages[Math.min(index, pages.length - 1)]!;
        index += 1;
        return { ok: true as const, page: { url, status: page.status, title: "Shop", text: page.text } };
      }
    };
  }

  it("contains fires when the text appears, changes when it changes, a function with its line; each at most every `every`", async () => {
    const w = await lifeWorld(roots);
    await wakeup(
      w,
      [
        'page("https://example.com/a", {contains: "in stock"}, {every: "1h", for: "2d"}, "mixer")',
        'page("https://example.com/b", "changes", {every: "1h", for: "2d"}, "news")',
        'page("https://example.com/c", (page, state) => { const price = Number(/price: (\\d+)/.exec(page.text)[1]); const was = state.price; state.price = price; return was !== undefined && price < was ? "price is now " + price : false }, {every: "1h", for: "2d"}, "price")'
      ].join("\n")
    );
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const sites: Record<string, ReturnType<typeof pageWorld>> = {
      a: pageWorld([{ status: 200, text: "sold out" }, { status: 200, text: "now In Stock!" }, { status: 200, text: "in stock" }]),
      b: pageWorld([{ status: 200, text: "v1" }, { status: 200, text: "v1" }, { status: 200, text: "v2" }]),
      c: pageWorld([{ status: 200, text: "price: 50" }, { status: 200, text: "price: 50" }, { status: 200, text: "price: 45" }])
    };
    const fetch = (url: string) => sites[url.slice(-1)]!.fetch(url);
    const check = (hours: number) =>
      checkPages({ store, sandbox: sharedSandbox(), now: new Date(NOW.getTime() + hours * 3_600_000), timeZone: TZ, fetch, everyMs: () => 3_600_000 });
    expect(await check(0)).toEqual([]);
    // Not due again within the hour.
    expect(await check(0.5)).toEqual([]);
    expect(sites.a!.fetches).toHaveLength(1);
    const second = await check(1);
    expect(second.map((wake) => [wake.watchId, wake.matched])).toEqual([["p1", 'the page has "in stock"']]);
    const third = await check(2);
    expect(third.map((wake) => [wake.watchId, wake.matched, wake.url])).toEqual([
      ["p2", "the page changed", "https://example.com/b"],
      ["p3", "price is now 45", "https://example.com/c"]
    ]);
    expect(renderNotifications({ wakes: [third[1]!] }, { timeZone: TZ, handle: (key) => key, unread: () => undefined })).toBe('<notifications>\n- watch · https://example.com/c · "price is now 45" · your note: "price"\n</notifications>');
  });

  it("goes through the SSRF-checked fetcher: a private address is never fetched", async () => {
    const w = await lifeWorld(roots);
    expect(await w.cast.deps.web!.fetchForWakeup("http://127.0.0.1:9/secret")).toEqual({ ok: false });
    expect(await w.cast.deps.web!.fetchForWakeup("http://10.0.0.1/")).toEqual({ ok: false });
  });
});

describe("the mention bot id is hers", () => {
  it("msg.mentionsMe and repliesToMe reach her filter", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await wakeup(w, 'watch("bake-club/#general", (msg) => msg.mentionsMe && msg.place === "bake-club/#general" && msg.ref !== null && "pinged by " + msg.from, {for: "1h"}, "pings")');
    const posted = w.discord.post(ROOM, `<@${ELLA_BOT}> hey`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: posted.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: posted });
    w.cast.intake.flushDetector();
    await w.cast.settle();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.some((wake) => wake.reason === "watch" && wake.matched === "pinged by Kevin")).toBe(true);
  });
});
