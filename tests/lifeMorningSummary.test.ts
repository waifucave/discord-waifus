// The morning summary shows what came in, with times (Living cast spec §23): the night's DMs one
// line per message, rooms with the night's span and one line per message that addressed her, watch
// matches with their message's time and ref; at most `life.morningLinesPerPlace` per DM or room (the
// newest, the first saying `+N earlier`); every ref resolves in SendMessage and React; DM lines are
// redacted one by one (D14); a budget pause batch reads the same.
import { afterEach, describe, expect, it, vi } from "vitest";
import { snowflakeAt } from "../src/discord/refStore.js";
import { readLifeFile, updateLifeFile } from "../src/life/lifeStore.js";
import { DM_REDACTED, redactDmNotifications } from "../src/life/lifeView.js";
import { morningBatch, type MorningPlace, type NotificationView } from "../src/life/notifications.js";
import { MAX_WAKE_MESSAGES } from "../src/life/wakeMessages.js";
import { scrubWakeQueue, withDeferred } from "../src/life/wakeQueue.js";
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
        name: "Kevin",
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
    const sleeper = { id: "ella", name: "Ella", botId: "ella-bot", availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } }, dm: { allowDms: true, rateLimit: null, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" } };
    const w: LifeWorld = await lifeWorld(roots, {
      waifus: [sleeper],
      scripts: script(
        textTurn("(evening)"),
        toolTurn([
          { name: "SendMessage", input: { place: "bake-club/#general", text: "saving you the best one", reply_to: "#a0" } },
          { name: "React", input: { place: "dm/kevin", ref: "#a0", emoji: "👍" } }
        ]),
        textTurn("(morning done)")
      )
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    w.clock.ms = at("2026-10-23T20:00:00Z");
    await w.cast.scheduler.tick();
    await writeHerFile(w, "life/reminders.json", JSON.stringify([{ at: "2026-10-23 20:10", note: "say goodnight" }]));
    w.clock.ms = at("2026-10-23T20:10:00Z");
    await w.cast.scheduler.tick();
    await w.cast.life("ella").runNow();
    // Asleep: Kevin's DM and Mina's mention wait for the morning.
    w.clock.ms = at("2026-10-24T02:00:00Z");
    const dm = w.discord.post(dmOf("ella"), "are you coming saturday?");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    w.clock.ms = at("2026-10-24T03:00:00Z");
    const mention = w.discord.post(ROOM, `<@${ELLA_BOT}> save me a lemon tart`, { authorId: MINA_USER, authorName: "Mina", mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: mention.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: mention });
    await w.cast.settle();
    w.cast.intake.flushDetector();
    await w.cast.settle();
    w.clock.ms = at("2026-10-24T08:31:00Z");
    await w.cast.scheduler.tick();
    await w.cast.life("ella").runNow();
    const morning = JSON.stringify(w.anthropic.calls[1]!.request.messages);
    expect(morning).toContain('· dm/kevin · 02:00 #a0 \\"are you coming saturday?\\"');
    expect(morning).toContain('· mention · 03:00 #a0 from Mina \\"<@Ella> save me a lemon tart\\"');
    expect(w.discord.sent.find((sent) => sent.content === "saving you the best one")).toMatchObject({ replyToMessageId: mention.id });
    expect(w.discord.reactions).toContainEqual(expect.objectContaining({ messageId: dm.id, emoji: "👍" }));
  }, 30_000);
});
