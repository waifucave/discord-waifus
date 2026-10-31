// One notification line per message (Living cast spec §20): a burst or several queued wakes for one
// place are still one wake, but her notification shows a line per message, in message order, each
// with its own reasons, sender, ref and preview; at most `life.notificationLinesPerPlace` per place
// (the newest, the first line saying how many earlier ones were left out); watch matches and notes
// on the line of the message they belong to; DM lines redacted one by one (D14).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, updateLifeFile } from "../src/life/lifeStore.js";
import { redactDmNotifications, DM_REDACTED } from "../src/life/lifeView.js";
import { morningBatch, renderNotifications, type NotificationView } from "../src/life/notifications.js";
import { MAX_IMMEDIATE_WAKES, scrubWakeQueue, withImmediate } from "../src/life/wakeQueue.js";
import { MAX_WAKE_MESSAGES } from "../src/life/wakeMessages.js";
import type { Wake, WakeQueue } from "../src/shared/schemas/life.js";
import { CHANNEL, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const AT = "2026-10-24T14:00:00.000Z";
const DM_KEY = `dm_${KEVIN}_ella`;

async function world(): Promise<LifeWorld> {
  const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }] });
  // Lives never run here: the tests read the wake queue.
  vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
  return w;
}

async function dm(w: LifeWorld, text: string): Promise<void> {
  const message = w.discord.post(dmOf("ella"), text);
  await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
}

async function room(w: LifeWorld, text: string, o: Parameters<LifeWorld["discord"]["post"]>[2] = {}): Promise<void> {
  const message = w.discord.post(ROOM, text, o);
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
}

const queued = async (w: LifeWorld) => (await readLifeFile(w.storage, "ella", "wakes")).immediate;

function view(o: { handle?: string; unread?: number; lines?: number } = {}): NotificationView {
  return { handle: () => o.handle ?? "bake-club/#general", unread: () => o.unread, timeZone: "UTC", ...(o.lines ? { linesPerPlace: o.lines } : {}) };
}

const id = (n: number) => String(1_000_000_000_000_000_000n + BigInt(n));

describe("bursts are one wake with a line per message (§20)", () => {
  it("a DM burst: one wake, one `dm` line per message, a watch on the line of the message it matched", async () => {
    const w = await world();
    // She knows Kevin from an earlier DM (a watch names people she knows).
    await dm(w, "hi!");
    w.cast.intake.flushDms();
    await w.cast.settle();
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({ ...queue, immediate: [] }));
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "watch", places: "everywhere", filter: { from: "Kevin", words: ["poem"] }, options: { until: "2026-10-25 14:00", once: true }, note: "ask about the poem" }]));
    await dm(w, "can you write me a poem about rain");
    await dm(w, "and bring the cat pic");
    w.cast.intake.flushDms();
    await w.cast.settle();
    const wakes = await queued(w);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.messages).toHaveLength(2);
    expect(renderNotifications({ wakes }, view({ handle: "dm/kevin" }))).toBe(
      [
        "<notifications>",
        '- dm, watch · dm/kevin · "poem" · from Kevin · "can you write me a poem about rain" · your note: "ask about the poem"',
        '- dm · dm/kevin · from Kevin · "and bring the cat pic"',
        "</notifications>"
      ].join("\n")
    );
  });

  it("a room burst: one held wake keeps every message, each line with the reasons it gave her", async () => {
    const w = await world();
    await room(w, "ok who is on dessert", { authorId: KEVIN, authorName: "Kevin" });
    await room(w, `<@${ELLA_BOT}> you?`, { authorId: KEVIN, authorName: "Kevin", mentions: { [ELLA_BOT]: "Ella" } });
    await room(w, "please ella", { authorId: MINA_USER, authorName: "Mina" });
    await room(w, "@everyone sale starts at 10", { authorId: MINA_USER, authorName: "Mina", everyone: true });
    await w.cast.settle();
    w.cast.intake.flushDetector();
    await w.cast.settle();
    const wakes = await queued(w);
    expect(wakes).toHaveLength(1);
    // The wake's own reasons as before (a mention makes her name redundant); each line keeps its own.
    expect(wakes[0]).toMatchObject({ reason: "mention", reasons: ["mention", "everyone"] });
    const lines = renderNotifications({ wakes }, view())!.split("\n").slice(1, -1);
    expect(lines).toEqual([
      '- bake-club/#general · from Kevin · "ok who is on dessert"',
      '- mention · bake-club/#general · from Kevin · "<@Ella> you?"',
      '- your name · bake-club/#general · from Mina · "please ella"',
      '- @everyone · bake-club/#general · from Mina · "@everyone sale starts at 10"'
    ]);
  });

  it("a detector wake shows the burst's messages, each read as the pick (a chime-in as a chime-in)", () => {
    const wake: Wake = {
      id: "w1",
      reason: "detector",
      chimeIn: true,
      placeKey: ROOM_KEY,
      fromUserId: KEVIN,
      fromName: "Kevin",
      messageId: id(2),
      messages: [
        { id: id(1), fromUserId: KEVIN, fromName: "Kevin", preview: "mina what are you baking" },
        { id: id(2), fromUserId: KEVIN, fromName: "Kevin", preview: "something with lemons?" }
      ],
      at: AT
    };
    expect(renderNotifications({ wakes: [wake] }, view())!.split("\n").slice(1, -1)).toEqual([
      '- for someone else, you could chime in · bake-club/#general · from Kevin · "mina what are you baking"',
      '- for someone else, you could chime in · bake-club/#general · from Kevin · "something with lemons?"'
    ]);
  });
});

describe("queued wakes for one place (§20)", () => {
  it("append their messages in message order; two wakes about one message share its line", () => {
    const watch: Wake = { id: "w1", reason: "watch", watchId: "w1", matched: "brownie", note: "Mina wanted brownie tips", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: id(2), preview: "a brownie recipe?", at: AT };
    const mention: Wake = { id: "w2", reason: "mention", placeKey: ROOM_KEY, fromUserId: MINA_USER, fromName: "Mina", messageId: id(1), preview: "<@Ella> hi", at: AT };
    const again: Wake = { id: "w3", reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: id(2), preview: "a brownie recipe?", at: AT };
    expect(renderNotifications({ wakes: [watch, mention, again] }, view())!.split("\n").slice(1, -1)).toEqual([
      '- mention · bake-club/#general · from Mina · "<@Ella> hi"',
      '- watch, mention · bake-club/#general · "brownie" · from Kevin · "a brownie recipe?" · your note: "Mina wanted brownie tips"'
    ]);
  });

  it("merged in the queue past its cap, a place's wake keeps both wakes' messages", () => {
    let queue = { immediate: [], deferred: { places: {}, items: [] }, quiet: [], userWakes: {} } as unknown as WakeQueue;
    for (let index = 0; index < MAX_IMMEDIATE_WAKES - 1; index += 1) queue = withImmediate(queue, { id: `o${index}`, reason: "reminder", note: "x", at: AT });
    queue = withImmediate(queue, { id: "a", reason: "dm", placeKey: DM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: id(1), preview: "one", at: AT });
    queue = withImmediate(queue, { id: "b", reason: "dm", placeKey: DM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: id(2), preview: "two", at: AT });
    const merged = queue.immediate.find((wake) => wake.id === "a")!;
    expect(queue.immediate).toHaveLength(MAX_IMMEDIATE_WAKES);
    expect(merged.messages?.map((message) => message.preview)).toEqual(["one", "two"]);
  });
});

describe("lines per place (§20)", () => {
  const burst = (count: number): Wake => ({
    id: "w1",
    reason: "dm",
    placeKey: DM_KEY,
    fromUserId: KEVIN,
    fromName: "Kevin",
    messageId: id(count),
    messages: Array.from({ length: count }, (_, index) => ({ id: id(index + 1), fromUserId: KEVIN, fromName: "Kevin", preview: `message ${index + 1}` })),
    at: AT
  });

  it("the newest `notificationLinesPerPlace`; the first line says how many earlier were left out", () => {
    const lines = renderNotifications({ wakes: [burst(12)] }, view({ handle: "dm/kevin", lines: 8, unread: 12 }))!.split("\n").slice(1, -1);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('- dm · dm/kevin · +4 earlier · from Kevin · "message 5"');
    // Not every unread message is shown: the count stays on the place's last line.
    expect(lines[7]).toBe('- dm · dm/kevin · from Kevin · 12 unread · "message 12"');
    expect(lines.slice(1, 7).every((line) => !line.includes("unread") && !line.includes("earlier"))).toBe(true);
  });

  it("no unread count when every unread message has its line; the default is 8", () => {
    const lines = renderNotifications({ wakes: [burst(3)] }, view({ handle: "dm/kevin", unread: 3 }))!.split("\n").slice(1, -1);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("unread");
    expect(renderNotifications({ wakes: [burst(9)] }, view({ handle: "dm/kevin" }))!.split("\n")[1]).toContain("+1 earlier");
  });

  it("a wake keeps at most MAX_WAKE_MESSAGES messages; the rest count as earlier", () => {
    const kept = { ...burst(MAX_WAKE_MESSAGES), earlier: 20 };
    expect(renderNotifications({ wakes: [kept] }, view({ handle: "dm/kevin", lines: 2 }))!.split("\n")[1]).toContain(`+${20 + MAX_WAKE_MESSAGES - 2} earlier`);
  });

  it("the setting is in the config (default 8) and reaches her notifications", async () => {
    const w = await world();
    expect(w.config.life.notificationLinesPerPlace).toBe(8);
    w.setConfig((config) => ({ ...config, life: { ...config.life, notificationLinesPerPlace: 2 } }));
    for (const text of ["one", "two", "three"]) await dm(w, text);
    w.cast.intake.flushDms();
    await w.cast.settle();
    expect((await queued(w))[0]!.messages).toHaveLength(3);
  });
});

describe("the morning batch and privacy (§20, D14)", () => {
  it("a deferred DM wake shows each watch match on its own line", () => {
    const wake: Wake = {
      id: "w1",
      reason: "dm",
      reasons: ["dm", "watch"],
      matched: "exam",
      note: "his exam",
      placeKey: DM_KEY,
      fromUserId: KEVIN,
      fromName: "Kevin",
      messageId: id(2),
      messages: [
        { id: id(1), fromUserId: KEVIN, fromName: "Kevin", preview: "exam done", reasons: ["dm", "watch"], matched: "exam", note: "his exam" },
        { id: id(2), fromUserId: KEVIN, fromName: "Kevin", preview: "now the party", reasons: ["dm", "watch"], matched: "party", note: "party plans" }
      ],
      at: AT
    };
    const lines = morningBatch({ reason: "sleep", since: new Date(AT), until: new Date(AT), places: [{ placeKey: DM_KEY, kind: "dm", mentions: 0, messages: 2 }], items: [wake] }, view({ handle: "dm/kevin" }));
    expect(lines.filter((line) => line.includes("watch matched"))).toEqual([
      '  · watch matched · dm/kevin · "exam" · from Kevin · Fri 22 Jul 11:22 · your note: "his exam"',
      '  · watch matched · dm/kevin · "party" · from Kevin · Fri 22 Jul 11:22 · your note: "party plans"'
    ]);
  });

  it("each DM line is redacted on its own, a line without a reason label too", () => {
    const text = ["<notifications>", '- dm · dm/kevin · from Kevin · #a1 "secret one"', '- dm/kevin · from Kevin · #a2 "secret two"', '- mention · bake-club/#general · from Mina · "hi"', "</notifications>"].join("\n");
    expect(redactDmNotifications(text).split("\n")).toEqual([
      "<notifications>",
      `- dm · dm/kevin · from Kevin · #a1 "${DM_REDACTED}"`,
      `- dm/kevin · from Kevin · #a2 "${DM_REDACTED}"`,
      '- mention · bake-club/#general · from Mina · "hi"',
      "</notifications>"
    ]);
  });

  it("forget: the person's messages leave someone else's wake, quotes naming them go", async () => {
    const w = await world();
    const wake: Wake = {
      id: "w1",
      reason: "mention",
      placeKey: ROOM_KEY,
      fromUserId: MINA_USER,
      fromName: "Mina",
      messageId: id(3),
      messages: [
        { id: id(1), fromUserId: KEVIN, fromName: "Kevin", preview: "my secret plan", reasons: [] },
        { id: id(2), fromUserId: MINA_USER, fromName: "Mina", preview: "Kevin said what?", reasons: [] },
        { id: id(3), fromUserId: MINA_USER, fromName: "Mina", preview: "<@Ella> look", reasons: ["mention"] }
      ],
      at: AT
    };
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({ ...queue, immediate: [wake] }));
    const changed = await scrubWakeQueue(w.storage, "ella", { userId: KEVIN, placeKeys: new Set([DM_KEY]), mentions: (text) => text.includes("Kevin") });
    expect(changed).toBe(1);
    const [left] = await queued(w);
    expect(left!.messages?.map((message) => message.preview)).toEqual(["(removed)", "<@Ella> look"]);
    expect(JSON.stringify(left)).not.toContain("secret");
  });
});
