// The morning summary shows what came in, with times (Living cast spec §23): the night's DMs one
// line per message, rooms with the night's span and one line per message that addressed her, watch
// matches with their message's time and ref; at most `life.morningLinesPerPlace` per DM or room (the
// newest, the first saying `+N earlier`); every ref resolves in SendMessage and React; DM lines are
// redacted one by one (D14); a budget pause batch reads the same.
import { afterEach, describe, expect, it, vi } from "vitest";
import { snowflakeAt } from "../src/discord/refStore.js";
import { readLifeFile, readLifeLog, readLifeState, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { DM_REDACTED, printLifeLines, redactDmNotifications, scanDmContent, viewLogLine, wakeShowsDm } from "../src/life/lifeView.js";
import { updateDmLimit } from "../src/orchestration/dm/dmStore.js";
import { recordForgottenPerson } from "../src/orchestration/dm/forgotten.js";
import { morningBatch, type MorningPlace, type NotificationView } from "../src/life/notifications.js";
import { handleOf } from "../src/life/places.js";
import { MAX_WAKE_MESSAGES } from "../src/life/wakeMessages.js";
import { scrubWakeQueue, takeDeferred, withDeferred } from "../src/life/wakeQueue.js";
import type { Wake, WakeQueue } from "../src/shared/schemas/life.js";
import { textTurn } from "./modelFakes.js";
import { CHANNEL, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, script, toolTurn, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const DM_KEY = `dm_${KEVIN}_ella`;
const ROOM_2 = "g_100000000000000001_200000000000000099";
const DM_MINA = `dm_${MINA_USER}_ella`;
const at = (iso: string) => Date.parse(iso);
const idAt = (iso: string, n = 0) => (BigInt(snowflakeAt(at(iso))) + BigInt(n)).toString();
const EMPTY: WakeQueue = { immediate: [], held: [], deferred: { places: {}, items: [] }, quiet: [], userWakes: {} } as never;

function view(refs: Record<string, string> = {}, handles: Record<string, string> = {}): NotificationView {
  return { timeZone: "UTC", handle: (key) => handles[key] ?? key, unread: () => undefined, ref: (_key, id) => refs[id] };
}

describe("the morning summary (§23)", () => {
  it("golden: the spec's example (DMs, rooms by most mentions with their span and lines, a watch match with time and ref, a timeout)", async () => {
    const d3 = idAt("2026-10-27T02:14:10Z");
    const d4 = idAt("2026-10-27T02:15:20Z");
    const c41 = idAt("2026-10-27T03:02:00Z");
    const c55 = idAt("2026-10-27T05:12:00Z");
    const c70 = idAt("2026-10-27T07:40:00Z");
    const handles = { [DM_KEY]: "dm/kevin", [ROOM_KEY]: "kingdom-16062/#general", [ROOM_2]: "winter-s-secret-room/#general" };
    const places: MorningPlace[] = [
      { placeKey: ROOM_2, kind: "room", mentions: 0, messages: 4, span: { from: new Date(at("2026-10-27T06:10:00Z")), to: new Date(at("2026-10-27T06:30:00Z")) } },
      {
        placeKey: ROOM_KEY,
        kind: "room",
        mentions: 2,
        messages: 31,
        span: { from: new Date(at("2026-10-27T01:50:00Z")), to: new Date(at("2026-10-27T07:58:00Z")) },
        lines: [
          { id: c41, fromName: "Lianne", preview: "@Lumi the cat did the thing again", reasons: ["mention"], at: new Date(at("2026-10-27T03:02:00Z")) },
          { id: c70, fromName: "Kevin", preview: "@Lumi morning!!", reasons: ["mention"], at: new Date(at("2026-10-27T07:40:00Z")) }
        ]
      },
      {
        placeKey: DM_KEY,
        kind: "dm",
        mentions: 0,
        messages: 2,
        lines: [
          { id: d3, fromName: "Kevin", preview: "you up? need a hand with the essay tmrw", reasons: ["dm"], at: new Date(at("2026-10-27T02:14:10Z")) },
          { id: d4, fromName: "Kevin", preview: "nvm going to sleep", reasons: ["dm"], at: new Date(at("2026-10-27T02:15:20Z")) }
        ]
      }
    ];
    const items: Wake[] = [
      { id: "w-t", reason: "watch_timeout", note: "ask Kevin how the essay went", at: "2026-10-27T04:00:00.000Z" },
      { id: "w-s", reason: "watch", placeKey: ROOM_KEY, fromUserId: MINA_USER, fromName: "Lianne", messageId: c55, matched: "sushi", note: "Lianne wants to try the new sushi place", at: "2026-10-27T05:12:00.000Z" }
    ];
    const lines = morningBatch(
      { reason: "sleep", since: new Date(at("2026-10-27T01:42:00Z")), until: new Date(at("2026-10-27T08:30:00Z")), places, items },
      view({ [d3]: "d3", [d4]: "d4", [c41]: "c41", [c55]: "c55", [c70]: "c70" }, handles)
    );
    await expect(`<notifications>\n${lines.join("\n")}\n</notifications>\n`).toMatchFileSnapshot("./golden/__snapshots__/life-morning-summary.txt");
  });

  it("at most `linesPerPlace` per DM or room, the newest, the first saying +N earlier (kept and stored ones)", () => {
    const ids = Array.from({ length: 11 }, (_, index) => idAt("2026-10-27T03:00:00Z", index));
    const place: MorningPlace = {
      placeKey: DM_KEY,
      kind: "dm",
      mentions: 0,
      messages: 11,
      earlier: 2,
      lines: ids.map((id, index) => ({ id, preview: `message ${index + 1}`, reasons: ["dm"], at: new Date(at("2026-10-27T03:00:00Z")) }))
    };
    const lines = morningBatch({ reason: "sleep", since: new Date(at("2026-10-27T01:00:00Z")), until: new Date(at("2026-10-27T08:30:00Z")), places: [place], items: [], linesPerPlace: 8 }, view({}, { [DM_KEY]: "dm/kevin" }));
    expect(lines.slice(1)).toEqual([
      "  · DMs:",
      '    · dm/kevin · +5 earlier · 03:00 "message 4"',
      ...Array.from({ length: 7 }, (_, index) => `    · dm/kevin · 03:00 "message ${index + 5}"`)
    ]);
  });

  it("a time on another day than the morning's has its weekday; a DM with no kept lines keeps a count", () => {
    const late = idAt("2026-10-26T23:50:00Z");
    const places: MorningPlace[] = [
      { placeKey: DM_KEY, kind: "dm", mentions: 0, messages: 1, lines: [{ id: late, preview: "still up?", reasons: ["dm"], at: new Date(at("2026-10-26T23:50:00Z")) }] },
      { placeKey: DM_MINA, kind: "dm", mentions: 0, messages: 3 },
      { placeKey: ROOM_KEY, kind: "room", mentions: 0, messages: 5, span: { from: new Date(at("2026-10-26T23:10:00Z")), to: new Date(at("2026-10-27T00:20:00Z")) } }
    ];
    const lines = morningBatch({ reason: "sleep", since: new Date(at("2026-10-26T23:00:00Z")), until: new Date(at("2026-10-27T07:00:00Z")), places, items: [] }, view({ [late]: "a4" }, { [DM_KEY]: "dm/kevin", [DM_MINA]: "dm/mina", [ROOM_KEY]: "bake-club/#general" }));
    expect(lines.slice(1)).toEqual(["  · DMs:", '    · dm/kevin · Mon 23:50 #a4 "still up?"', "    · dm/mina: 3 messages", "  · bake-club/#general: 5 messages (Mon 23:10–00:20)"]);
  });

  it("deferred wakes keep a DM's messages and a room's messages that addressed her, the newest 50 with a count", () => {
    const now = new Date(at("2026-10-27T03:00:00Z"));
    const burst: Wake = {
      id: "w1",
      reason: "mention",
      reasons: ["mention", "name"],
      placeKey: ROOM_KEY,
      messageId: idAt("2026-10-27T03:00:00Z", 2),
      messages: [
        { id: idAt("2026-10-27T03:00:00Z", 0), fromUserId: MINA_USER, fromName: "Mina", preview: "the oven is on", reasons: [] },
        { id: idAt("2026-10-27T03:00:00Z", 1), fromUserId: KEVIN, fromName: "Kevin", preview: "ella are you up", reasons: ["name"] },
        { id: idAt("2026-10-27T03:00:00Z", 2), fromUserId: KEVIN, fromName: "Kevin", preview: "<@Ella> hello", reasons: ["mention"] }
      ],
      at: now.toISOString()
    };
    const pick: Wake = { id: "w2", reason: "detector", placeKey: ROOM_KEY, messageId: idAt("2026-10-27T03:05:00Z"), preview: "who wants cake", fromName: "Mina", at: now.toISOString() };
    let queue = withDeferred(withDeferred(EMPTY, burst, "sleep", now), pick, "sleep", now);
    expect(queue.deferred.places[ROOM_KEY]!.lines!.map((line) => line.preview)).toEqual(["ella are you up", "<@Ella> hello"]);
    for (let index = 0; index < MAX_WAKE_MESSAGES + 5; index += 1) {
      const id = idAt("2026-10-27T04:00:00Z", index);
      queue = withDeferred(queue, { id: `d${index}`, reason: "dm", placeKey: DM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: id, preview: `dm ${index}`, at: now.toISOString() }, "sleep", now);
    }
    const dm = queue.deferred.places[DM_KEY]!;
    expect(dm.lines).toHaveLength(MAX_WAKE_MESSAGES);
    expect(dm.earlier).toBe(5);
    expect(dm.lines![0]!.preview).toBe("dm 5");
  });

  it("forget: the person's lines leave a room's summary, quotes naming them go", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const now = new Date(at("2026-10-24T14:00:00Z"));
    const wake: Wake = {
      id: "w1",
      reason: "mention",
      placeKey: ROOM_KEY,
      messages: [
        { id: idAt("2026-10-24T14:00:00Z", 0), fromUserId: KEVIN, fromName: "Kevin", preview: "<@Ella> my secret plan", reasons: ["mention"] },
        { id: idAt("2026-10-24T14:00:00Z", 1), fromUserId: MINA_USER, fromName: "Mina", preview: "<@Ella> Kevin said what?", reasons: ["mention"] }
      ],
      at: now.toISOString()
    };
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => withDeferred(queue, wake, "sleep", now));
    await scrubWakeQueue(w.storage, "ella", { userId: KEVIN, placeKeys: new Set([DM_KEY]), mentions: (text) => text.includes("Kevin") });
    const lines = (await readLifeFile(w.storage, "ella", "wakes")).deferred.places[ROOM_KEY]!.lines!;
    expect(lines.map((line) => [line.fromName, line.preview])).toEqual([["Mina", "(removed)"]]);
  });

  it("D14: each DM line loses its preview on its own; room lines stay", () => {
    const text = [
      "<notifications>",
      "- during your bed time (00:30–08:30):",
      "  · DMs:",
      '    · dm/kevin · +2 earlier · 02:14 #d3 "secret one"',
      '    · dm/kevin · 02:15 #d4 "secret two"',
      "  · bake-club/#general: 1 mention, 3 messages (01:50–07:58)",
      '    · mention · 03:02 #c41 from Lianne "@Ella hi"',
      "</notifications>"
    ].join("\n");
    expect(redactDmNotifications(text).split("\n")).toEqual([
      "<notifications>",
      "- during your bed time (00:30–08:30):",
      "  · DMs:",
      `    · dm/kevin · +2 earlier · 02:14 #d3 "${DM_REDACTED}"`,
      `    · dm/kevin · 02:15 #d4 "${DM_REDACTED}"`,
      "  · bake-club/#general: 1 mention, 3 messages (01:50–07:58)",
      '    · mention · 03:02 #c41 from Lianne "@Ella hi"',
      "</notifications>"
    ]);
  });

  it("a budget pause batch reads the same, under its own header", () => {
    const id = idAt("2026-10-27T03:00:00Z");
    const places: MorningPlace[] = [{ placeKey: DM_KEY, kind: "dm", mentions: 0, messages: 1, lines: [{ id, preview: "hey", reasons: ["dm"], at: new Date(at("2026-10-27T03:00:00Z")) }] }];
    const o = { since: new Date(at("2026-10-27T01:00:00Z")), until: new Date(at("2026-10-27T08:30:00Z")), places, items: [] };
    const asleep = morningBatch({ ...o, reason: "sleep" }, view({ [id]: "a0" }, { [DM_KEY]: "dm/kevin" }));
    const away = morningBatch({ ...o, reason: "budget" }, view({ [id]: "a0" }, { [DM_KEY]: "dm/kevin" }));
    expect(away[0]).toBe("- while you were away (since 01:00):");
    expect(away.slice(1)).toEqual(asleep.slice(1));
  });

  it("the refs in her morning resolve: she replies to the mention and reacts to the DM", async () => {
    const w = await sleeperWorld(
      toolTurn([
        {
          name: "SendMessage",
          input: {
            script: [
              'await tools.send_message({ place: "bake-club/#general", messages: [{ text: "saving you the best one", reply_to: "#a0" }] });',
              'await tools.send_message({ place: "dm/kevin", messages: [{ react: "👍", to: "#a0" }] });'
            ].join("\n")
          }
        }
      ]),
      textTurn("(morning done)")
    );
    const dm = await nightDm(w, "2026-10-24T02:00:00Z", "are you coming saturday?");
    const mention = await nightMention(w, "2026-10-24T03:00:00Z", "save me a lemon tart");
    await morning(w);
    const text = JSON.stringify(w.anthropic.calls[1]!.request.messages);
    expect(text).toContain('· dm/kevin · 02:00 #a0 \\"are you coming saturday?\\"');
    expect(text).toContain('· mention · 03:00 #a0 from Mina \\"<@Ella> save me a lemon tart\\"');
    expect(w.discord.sent.find((sent) => sent.content === "saving you the best one")).toMatchObject({ replyToMessageId: mention.id });
    expect(w.discord.reactions).toContainEqual(expect.objectContaining({ messageId: dm.id, emoji: "👍" }));
  }, 30_000);
});

describe("the morning summary's privacy (§23, D14, review)", () => {
  /** Everything of her life log as the owner sees it, with or without the local reveal. */
  async function ownerView(w: LifeWorld, includePrivate: boolean): Promise<string> {
    const epoch = (await readLifeState(w.storage, "ella")).epoch;
    const lines = [];
    for (let index = 1; index <= epoch; index += 1) lines.push(...(await readLifeLog(w.storage, "ella", index)));
    const scan = scanDmContent(lines);
    return JSON.stringify(lines.map((line) => viewLogLine(line, scan, { includePrivate }).view)) + printLifeLines(lines, { private: includePrivate });
  }

  it("a morning whose batch shows a DM line is a DM turn: her text there is hidden without the local reveal", async () => {
    const w = await sleeperWorld(textTurn("kevin wants to meet at the lake at noon"));
    await nightDm(w, "2026-10-24T02:00:00Z", "are you free tomorrow? secret plans");
    await morning(w);
    const queueView = await ownerView(w, false);
    expect(queueView).not.toContain("meet at the lake");
    expect(queueView).not.toContain("secret plans");
    expect(await ownerView(w, true)).toContain("meet at the lake");
  }, 30_000);

  it("a morning with only room lines stays an ordinary turn", async () => {
    const w = await sleeperWorld(textTurn("mina wants a lemon tart"));
    await nightMention(w, "2026-10-24T03:00:00Z", "save me a lemon tart");
    await morning(w);
    expect(await ownerView(w, false)).toContain("mina wants a lemon tart");
  }, 30_000);

  it("an earlier unread batch with a DM line keeps the morning it rides in a DM turn", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const earlier: Wake = { id: "w-old", reason: "morning", batch: ["- during your bed time (00:30–08:30):", "  · DMs:", '    · dm/kevin · 02:00 #a0 "secret"'], dm: true, at: w.clock.now().toISOString() };
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => withDeferred(queue, earlier, "budget", w.clock.now()));
    await w.cast.scheduler.tick();
    const [released] = (await readLifeFile(w.storage, "ella", "wakes")).immediate;
    expect(released).toMatchObject({ reason: "morning", dm: true });
    expect(released!.batch).toContain('    · dm/kevin · 02:00 #a0 "secret"');
    expect(wakeShowsDm(released!)).toBe(true);
  });

  it("DM lines at or below the DM's forget floor and lines from a forgotten person are left out", async () => {
    const w = await sleeperWorld(textTurn("(morning)"));
    const dm = await nightDm(w, "2026-10-24T02:00:00Z", "my old secret");
    await nightDm(w, "2026-10-24T02:30:00Z", "and a new one");
    await nightMention(w, "2026-10-24T03:00:00Z", "the plan is on", { authorId: MINA_USER, authorName: "Mina" });
    // A DM floor written by a /forget whose scrub has not run, and Mina forgotten meanwhile.
    await updateDmLimit(w.storage, KEVIN, "ella", (current) => ({ ...current, floorMessageId: dm.id }));
    await recordForgottenPerson(w.storage, MINA_USER, new Date(at("2026-10-24T04:00:00Z")));
    w.clock.ms = at("2026-10-24T08:31:00Z");
    await w.cast.scheduler.tick();
    const batch = (await readLifeFile(w.storage, "ella", "wakes")).immediate.find((wake) => wake.reason === "morning")!.batch!.join("\n");
    expect(batch).not.toContain("my old secret");
    expect(batch).toContain('"and a new one"');
    expect(batch).not.toContain("the plan is on");
  }, 30_000);

  it("a rate-limited DM /forget drops the DM's waiting lines at once, before its scrub runs", async () => {
    const w = await sleeperWorld(textTurn("(morning)"));
    await nightDm(w, "2026-10-24T02:00:00Z", "forget this please");
    expect((await readLifeFile(w.storage, "ella", "wakes")).deferred.places[DM_KEY]!.lines).toHaveLength(1);
    // Inside the 6-hour window: the scrub only queues (it would wait for her dream).
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, scrubbedAt: { [KEVIN]: new Date(w.clock.ms - 60_000).toISOString() } }));
    const prepared = await w.cast.prepareForget({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "conversation" });
    expect(prepared?.rateLimited).toBe(true);
    expect((await readLifeFile(w.storage, "ella", "wakes")).deferred.places[DM_KEY]).toBeUndefined();
  }, 30_000);

  it("forget also takes the person's lines out of an earlier unread batch waiting in the deferred items", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    // She has a DM with Kevin (her handle dm/kevin) and a batch her budget kept her from reading.
    await nightDm(w, "2026-10-24T14:00:00Z", "hi ella");
    const handle = await handleOf(w.storage, "ella", DM_KEY);
    expect(handle).toMatch(/^dm\//u);
    const earlier: Wake = {
      id: "w-old",
      reason: "morning",
      dm: true,
      batch: [
        "- during your bed time (00:30–08:30):",
        "  · DMs:",
        `    · ${handle} · 02:00 #a0 "a secret"`,
        "  · bake-club/#general: 2 mentions, 5 messages (01:00–03:00)",
        '    · mention · 03:00 #a4 from Kevin "<@Ella> my plan"',
        '    · mention · 03:10 #a5 from Mina "<@Ella> hi"',
        `  · watch matched · ${handle} · "exam" · from Kevin · 02:00 #a0 · your note: "his exam"`
      ],
      at: w.clock.now().toISOString()
    };
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({ ...queue, immediate: [], deferred: { reason: "budget", since: w.clock.now().toISOString(), places: {}, items: [earlier] } }));
    // Inside the 6-hour window (a rate-limited DM forget): only what waits for her goes now.
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, scrubbedAt: { [KEVIN]: new Date(w.clock.ms - 60_000).toISOString() } }));
    await w.cast.prepareForget({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "everything" });
    const [left] = (await readLifeFile(w.storage, "ella", "wakes")).deferred.items;
    expect(left!.batch).toEqual(["- during your bed time (00:30–08:30):", "  · bake-club/#general: 2 mentions, 5 messages (01:00–03:00)", '    · mention · 03:10 #a5 from Mina "<@Ella> hi"']);
  }, 30_000);
});

describe("the morning batch's bookkeeping (review)", () => {
  it("when the deferred wakes keep changing, nothing is released that tick (no day started); the next tick takes them all", async () => {
    const w = await sleeperWorld(textTurn("(morning)"));
    await nightDm(w, "2026-10-24T02:00:00Z", "first");
    const scheduler = w.cast.scheduler as unknown as { morningView: (...args: unknown[]) => Promise<unknown> };
    const original = scheduler.morningView.bind(scheduler);
    let built = 0;
    const spy = vi.spyOn(scheduler, "morningView").mockImplementation(async (...args: unknown[]) => {
      const view = await original(...args);
      // A DM arrives while each attempt is built.
      built += 1;
      await updateLifeFile(w.storage, "ella", "wakes", (queue) =>
        withDeferred(queue, { id: `late${built}`, reason: "dm", placeKey: DM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: idAt("2026-10-24T08:00:00Z", built), preview: `late ${built}`, at: w.clock.now().toISOString() }, "sleep", w.clock.now())
      );
      return view;
    });
    const before = (await readLifeState(w.storage, "ella")).lastDayStart;
    w.clock.ms = at("2026-10-24T08:31:00Z");
    await w.cast.scheduler.tick();
    expect(built).toBe(5);
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.filter((wake) => wake.reason === "morning")).toEqual([]);
    expect(queue.deferred.places[DM_KEY]!.lines).toHaveLength(6);
    expect((await readLifeState(w.storage, "ella")).lastDayStart).toBe(before);
    spy.mockRestore();
    await w.cast.scheduler.tick();
    const day = (await readLifeFile(w.storage, "ella", "wakes")).immediate.find((wake) => wake.reason === "morning")!;
    expect(day).toMatchObject({ id: "w-day-2026-10-24", dm: true });
    expect(day.batch!.filter((line) => line.startsWith("    · dm/"))).toHaveLength(6);
  }, 30_000);


  it("taking the deferred batch refuses when it changed since it was read", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }] });
    const now = w.clock.now();
    const first: Wake = { id: "d1", reason: "dm", placeKey: DM_KEY, fromUserId: KEVIN, messageId: idAt("2026-10-24T13:00:00Z"), preview: "one", at: now.toISOString() };
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => withDeferred(queue, first, "sleep", now));
    const read = (await readLifeFile(w.storage, "ella", "wakes")).deferred;
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => withDeferred(queue, { ...first, id: "d2", messageId: idAt("2026-10-24T13:01:00Z"), preview: "two" }, "sleep", now));
    const taken = await takeDeferred(w.storage, "ella", () => ({ id: "m", reason: "morning", batch: ["x"], at: now.toISOString() }), read);
    expect(taken).toEqual({ wake: undefined, conflict: true });
    expect((await readLifeFile(w.storage, "ella", "wakes")).deferred.places[DM_KEY]!.lines).toHaveLength(2);
    expect((await takeDeferred(w.storage, "ella", () => undefined, (await readLifeFile(w.storage, "ella", "wakes")).deferred)).conflict).toBe(false);
  });

  it("an afternoon line moved into the night does not stretch the night's span; old DM wakes count as earlier", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    // The deferred batch as a night left it: since 22:00, a mention held from 14:00 moved into it,
    // and a DM whose first two wakes were deferred before lines were kept (an upgrade night).
    const afternoon = idAt("2026-10-24T14:00:00Z");
    const night = idAt("2026-10-25T02:00:00Z");
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({
      ...queue,
      deferred: {
        reason: "sleep",
        since: "2026-10-24T22:00:00.000Z",
        places: {
          [ROOM_KEY]: { mentions: 1, messages: 0, dms: 0, detector: 0, fromUserIds: [MINA_USER], names: {}, lines: [{ id: afternoon, fromUserId: MINA_USER, fromName: "Mina", preview: "<@Ella> you around?", reasons: ["mention"] }] },
          [DM_KEY]: { mentions: 0, messages: 0, dms: 3, detector: 0, fromUserIds: [KEVIN], names: {}, lines: [{ id: night, fromUserId: KEVIN, fromName: "Kevin", preview: "still up?", reasons: ["dm"] }] }
        },
        items: []
      }
    }));
    w.clock.ms = at("2026-10-25T08:00:00Z");
    await w.cast.scheduler.tick();
    const batch = (await readLifeFile(w.storage, "ella", "wakes")).immediate.find((wake) => wake.reason === "morning")!.batch!;
    expect(batch).toContain("  · bake-club/#general: 1 mention, 1 message");
    expect(batch).toContainEqual(expect.stringMatching(/^ {4}· mention · Sat 14:00 #\w+ from Mina "<@Ella> you around\?"$/u));
    expect(batch).toContainEqual(expect.stringMatching(/^ {4}· dm\/\w+ · \+2 earlier · 02:00 #\w+ "still up\?"$/u));
  });
});

const SLEEPER = { id: "ella", name: "Ella", botId: "ella-bot", availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } }, dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } };

/** A sleeper whose life has begun (an evening reminder turn); `morning` is her next scripted turn. */
async function sleeperWorld(...morningTurns: Parameters<typeof script>): Promise<LifeWorld> {
  const w = await lifeWorld(roots, { waifus: [SLEEPER], scripts: script(textTurn("(evening)"), ...morningTurns) });
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  w.clock.ms = at("2026-10-23T20:00:00Z");
  await w.cast.scheduler.tick();
  await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "at", when: "2026-10-23 20:10", note: "say goodnight" }]));
  w.clock.ms = at("2026-10-23T20:10:00Z");
  await w.cast.scheduler.tick();
  await w.cast.life("ella").runNow();
  return w;
}

async function nightDm(w: LifeWorld, iso: string, text: string) {
  w.clock.ms = at(iso);
  const message = w.discord.post(dmOf("ella"), text);
  await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
  w.cast.intake.flushDms();
  await w.cast.settle();
  return message;
}

async function nightMention(w: LifeWorld, iso: string, text: string, o: { authorId?: string; authorName?: string } = {}) {
  w.clock.ms = at(iso);
  const message = w.discord.post(ROOM, `<@${ELLA_BOT}> ${text}`, { authorId: o.authorId ?? MINA_USER, authorName: o.authorName ?? "Mina", mentions: { [ELLA_BOT]: "Ella" } });
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
  await w.cast.settle();
  w.cast.intake.flushDetector();
  await w.cast.settle();
  return message;
}

async function morning(w: LifeWorld): Promise<void> {
  w.clock.ms = at("2026-10-24T08:31:00Z");
  await w.cast.scheduler.tick();
  await w.cast.life("ella").runNow();
}
