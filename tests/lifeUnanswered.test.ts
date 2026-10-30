// Her unanswered streak (Living cast spec §34): separate sends of hers in a place since anyone else
// wrote there, counted by send (messages close together are one), reset by anyone else's message,
// shown from two sends on her ended watches' notification lines, at the end of a ReadMessages page that
// reaches now and in the SendMessage receipt. Soft only: nothing is refused. Against temp data roots and
// the fake Discord; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { morningBatch, notificationLines, type NotificationView } from "../src/life/notifications.js";
import { selfAuthorIds } from "../src/life/people.js";
import { offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext } from "../src/life/tools/types.js";
import { addTranscriptLine } from "../src/life/transcripts/store.js";
import {
  readUnanswered,
  showsUnanswered,
  sinceText,
  unansweredForWakes,
  unansweredReceipt,
  unansweredStreak,
  unansweredText,
  UNANSWERED_NOTICE_FROM,
  UNANSWERED_SEND_GAP_MS
} from "../src/life/unanswered.js";
import { endWake } from "../src/life/wakeups/schedule.js";
import { updateLifeState } from "../src/life/lifeStore.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { WakeupSideSchema, type Wake } from "../src/shared/schemas/life.js";
import type { StorageService } from "../src/storage/storageService.js";
import { CHANNEL, closeWorlds, dmOf, ELLA_BOT, GUILD, KEVIN, lifeWorld, ROOM, ROOM_KEY, script, toolTurn, TZ, type LifeWorld } from "./lifeFixtures.js";
import { textTurn } from "./modelFakes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
import { readMessages, receiptsOf, runScript, sendMessage } from "./toolCalls.js";

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const HOUR = 3_600_000;
/** Sat 24 Oct 2026 (the fixtures' clock day). */
const NOW = new Date("2026-10-24T14:00:00.000Z");

async function ctxFor(w: LifeWorld): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: `turn-${w.clock.ms}`, sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps)
  };
}

const text = (output: { content: unknown }) => (typeof output.content === "string" ? output.content : JSON.stringify(output.content));

describe("unansweredStreak (§34)", () => {
  it("counts sends, not messages: her messages less than the gap apart are one send", () => {
    const lines = [
      { id: "1", at: "2026-10-20T20:00:00Z", self: false },
      { id: "2", at: "2026-10-20T21:00:00Z", self: true },
      { id: "3", at: "2026-10-20T21:00:20Z", self: true },
      { id: "4", at: "2026-10-20T21:01:00Z", self: true }
    ];
    expect(unansweredStreak(lines)).toEqual({ sends: 1, since: "2026-10-20T21:00:00Z" });
    // Two hours later: a second send. Then the next morning: a third. Order of the input doesn't matter.
    const more = [...lines, { id: "6", at: "2026-10-21T09:00:00Z", self: true }, { id: "5", at: "2026-10-20T23:00:00Z", self: true }];
    expect(unansweredStreak(more)).toEqual({ sends: 3, since: "2026-10-20T21:00:00Z" });
    // Exactly the gap apart starts a new send; just under it does not.
    const gap = UNANSWERED_SEND_GAP_MS;
    const t0 = Date.parse("2026-10-20T21:00:00Z");
    expect(unansweredStreak([{ id: "1", at: new Date(t0).toISOString(), self: true }, { id: "2", at: new Date(t0 + gap - 1).toISOString(), self: true }])?.sends).toBe(1);
    expect(unansweredStreak([{ id: "1", at: new Date(t0).toISOString(), self: true }, { id: "2", at: new Date(t0 + gap).toISOString(), self: true }])?.sends).toBe(2);
  });

  it("resets when anyone else writes, and is nothing when the newest message isn't hers", () => {
    const lines = [
      { id: "1", at: "2026-10-20T21:00:00Z", self: true },
      { id: "2", at: "2026-10-20T23:00:00Z", self: true },
      { id: "3", at: "2026-10-21T08:00:00Z", self: false }
    ];
    expect(unansweredStreak(lines)).toBeUndefined();
    expect(unansweredStreak([...lines, { id: "4", at: "2026-10-21T09:00:00Z", self: true }])).toEqual({ sends: 1, since: "2026-10-21T09:00:00Z" });
    expect(unansweredStreak([])).toBeUndefined();
  });

  it("is shown from two sends", () => {
    expect(UNANSWERED_NOTICE_FROM).toBe(2);
    expect(showsUnanswered(undefined)).toBe(false);
    expect(showsUnanswered({ sends: 1, since: NOW.toISOString() })).toBe(false);
    expect(showsUnanswered({ sends: 2, since: NOW.toISOString() })).toBe(true);
  });

  it("words the start with its weekday: the weekday and time within six days, else the date too", () => {
    expect(sinceText("2026-10-24T09:05:00Z", NOW, TZ)).toBe("Sat 09:05");
    expect(sinceText("2026-10-20T21:00:00Z", NOW, TZ)).toBe("Tue 21:00");
    expect(sinceText("2026-10-18T23:50:00Z", NOW, TZ)).toBe("Sun 23:50");
    expect(sinceText("2026-10-17T23:50:00Z", NOW, TZ)).toBe("Sat 17 Oct 23:50");
    const streak = { sends: 3, since: "2026-10-20T21:00:00Z" };
    expect(unansweredText(streak, { dm: false, now: NOW, timeZone: TZ })).toBe("you've written here 3 times since anyone answered (since Tue 21:00)");
    expect(unansweredText(streak, { dm: true, now: NOW, timeZone: TZ, where: "in dm/kevin" })).toBe("you've written in dm/kevin 3 times since they answered (since Tue 21:00)");
    expect(unansweredReceipt(streak, { dm: false, now: NOW, timeZone: TZ })).toBe("No one has answered your last 3 here (since Tue 21:00). Let it rest: wait for someone to write before you write here again.");
    expect(unansweredReceipt(streak, { dm: true, now: NOW, timeZone: TZ })).toBe("They haven't answered your last 3 here (since Tue 21:00). Let it rest: wait for them to write before you write here again.");
  });
});

describe("readUnanswered (§34)", () => {
  it("reads the transcript back when the latest page holds only her messages", async () => {
    const root = await makeTempRoot("dc-waifus-unanswered-");
    roots.push(root);
    const key = conversationKey(dmOf("ella"));
    const env = { dataRoot: root, timeZone: TZ };
    const line = (id: string, iso: string, authorId: string) => ({ id, at: iso, authorId, author: authorId === ELLA_BOT ? "Ella" : "Kevin", text: "x" });
    // Kevin wrote on Monday; she wrote Monday night, Tuesday morning and Tuesday night.
    await addTranscriptLine(env, key, line("1100", "2026-10-19T18:00:00Z", KEVIN));
    await addTranscriptLine(env, key, line("1200", "2026-10-19T22:00:00Z", ELLA_BOT));
    await addTranscriptLine(env, key, line("1300", "2026-10-20T09:00:00Z", ELLA_BOT));
    // Only her latest messages are on the page (one send of two messages).
    const page = [
      { id: "1400", createdAt: "2026-10-20T21:00:00Z", authorId: ELLA_BOT },
      { id: "1401", createdAt: "2026-10-20T21:00:30Z", authorId: ELLA_BOT }
    ];
    const deps = {
      storage: { dataRoot: root } as StorageService,
      conversations: { readPage: async () => ({ messages: page, hasMore: false, hasNewer: false }), bufferedMessages: () => [] }
    } as unknown as Parameters<typeof readUnanswered>[0];
    expect(await readUnanswered(deps, [ELLA_BOT], key)).toEqual({ sends: 3, since: "2026-10-19T22:00:00Z" });
    // Kevin answered on Tuesday at noon: only the night's send is left.
    await addTranscriptLine(env, key, line("1350", "2026-10-20T12:00:00Z", KEVIN));
    expect(await readUnanswered(deps, [ELLA_BOT], key)).toEqual({ sends: 1, since: "2026-10-20T21:00:00Z" });
    // A failing page read falls back to the buffer; a bad key is nothing.
    const failing = { ...deps, conversations: { readPage: async () => Promise.reject(new Error("offline")), bufferedMessages: () => page } } as unknown as Parameters<typeof readUnanswered>[0];
    expect(await readUnanswered(failing, [ELLA_BOT], key)).toEqual({ sends: 1, since: "2026-10-20T21:00:00Z" });
    expect(await readUnanswered(deps, [ELLA_BOT], "not-a-key")).toBeUndefined();
  });
});

describe("the unanswered line in her tools (§34)", () => {
  it("room: the receipt and the latest page say so from her second unanswered send, and stop once someone writes", async () => {
    const w = await lifeWorld(roots);
    w.discord.post(ROOM, "seeds are up for the tournament");
    const ctx = await ctxFor(w);
    // One send of two messages: one send, nothing said.
    const first = await sendMessage(ctx, "bake-club/#general", [{ text: "who's seed 2" }, { text: "felix?" }]);
    expect(first.receipts).toEqual([expect.stringMatching(/^send_message to bake-club\/#general: sent #\w+ #\w+; the whole list ran$/u)]);
    expect(text(await readMessages(ctx, { place: "bake-club/#general" }))).not.toContain("since anyone answered");
    // Two hours later, the same question again: the receipt says to let it rest. Nothing is refused.
    w.clock.advance(2 * HOUR);
    const second = await sendMessage(await ctxFor(w), "bake-club/#general", [{ text: "seed 2 anyone" }]);
    expect(second.receipts).toEqual([
      expect.stringMatching(/^send_message to bake-club\/#general: sent #\w+; the whole list ran\. No one has answered your last 2 here \(since Sat 14:00\)\. Let it rest: wait for someone to write before you write here again\.$/u)
    ]);
    expect(w.discord.sent.map((entry) => entry.content)).toEqual(["who's seed 2", "felix?", "seed 2 anyone"]);
    // The latest page ends with the line; an older page does not.
    const page = text(await readMessages(ctx, { place: "bake-club/#general" })).split("\n");
    expect(page.at(-1)).toBe("— you've written here 2 times since anyone answered (since Sat 14:00) —");
    const older = text(await readMessages(ctx, { place: "bake-club/#general", before: "16:00" }));
    expect(older).not.toContain("since anyone answered");
    // A third, in a script with two calls to the room: said once.
    w.clock.advance(2 * HOUR);
    const third = await ctxFor(w);
    const twice = await runScript("SendMessage", 'await tools.send_message({ place: "bake-club/#general", messages: [{ text: "ok" }] }); await tools.send_message({ place: "bake-club/#general", messages: [{ text: "nvm" }] })', third);
    const receipts = receiptsOf(text(twice));
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toContain("No one has answered your last 3 here (since Sat 14:00)");
    expect(receipts[1]).not.toContain("No one has answered");
    // Someone writes: gone from the page and the next receipt.
    w.clock.advance(HOUR);
    w.discord.post(ROOM, "it's lena, chill");
    expect(text(await readMessages(ctx, { place: "bake-club/#general" }))).not.toContain("since anyone answered");
    const after = await sendMessage(await ctxFor(w), "bake-club/#general", [{ text: "ty lena" }]);
    expect(after.receipts?.[0]).not.toContain("No one has answered");
  });

  it("DM: counts her sends since the other person wrote", async () => {
    const w = await lifeWorld(roots);
    const hello = w.discord.post(dmOf("ella"), "had the interview today. and we broke up");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: hello.id, createdAt: hello.createdAt });
    w.cast.intake.close();
    const first = await sendMessage(await ctxFor(w), "dm/kevin", [{ text: "oh no" }, { text: "i'm here if you want to talk 🌿" }]);
    expect(first.receipts?.[0]).not.toContain("haven't answered");
    w.clock.advance(20 * HOUR);
    const second = await sendMessage(await ctxFor(w), "dm/kevin", [{ text: "no pressure to reply 🌿" }]);
    expect(second.receipts?.[0]).toContain("They haven't answered your last 2 here (since Sat 14:00). Let it rest: wait for them to write before you write here again.");
    const page = text(await readMessages(await ctxFor(w), { place: "dm/kevin" })).split("\n");
    expect(page.at(-1)).toBe("— you've written here 2 times since they answered (since Sat 14:00) —");
  });
});

describe("the unanswered line in her notifications (§34)", () => {
  const side = WakeupSideSchema.parse({ watches: { w1: { placeKeys: [ROOM_KEY] }, w2: {}, w3: { filters: [{ placeKey: "dm_300000000000000003_ella", fromUserId: KEVIN }] } } });

  it("an ended watch carries the places it named (none for everywhere)", () => {
    const ends = new Date("2026-10-24T17:00:00Z");
    expect(endWake({ entry: { id: "w1", kind: "watch", places: "bake-club/#general", note: "asked felix" }, ends, wakeId: "e1" }, side).watchedPlaces).toEqual([ROOM_KEY]);
    expect(endWake({ entry: { id: "w2", kind: "watch", places: "everywhere", note: "x" }, ends, wakeId: "e2" }, side).watchedPlaces).toBeUndefined();
    expect(endWake({ entry: { id: "w3", kind: "watch", filter: { place: "dm/kevin", from: "Kevin" }, note: "x" }, ends, wakeId: "e3" }, side)).toMatchObject({ watchedPlaces: ["dm_300000000000000003_ella"], dm: true });
  });

  it("the watch timeout line and the morning batch line add it where the view has one", () => {
    const wake: Wake = { id: "e1", reason: "watch_timeout", watchId: "w1", note: "asked felix about seed 2", watchedPlaces: [ROOM_KEY, "g_1_2"], at: "2026-10-24T17:00:00.000Z" };
    const view: NotificationView = {
      timeZone: TZ,
      handle: (key) => key,
      unread: () => undefined,
      unanswered: (key) => (key === ROOM_KEY ? "you've written in bake-club/#general 3 times since anyone answered (since Tue 21:00)" : undefined)
    };
    expect(notificationLines([wake], view)).toEqual(['- watch timed out · your note: "asked felix about seed 2" · you\'ve written in bake-club/#general 3 times since anyone answered (since Tue 21:00)']);
    expect(notificationLines([wake], { ...view, unanswered: () => undefined })).toEqual(['- watch timed out · your note: "asked felix about seed 2"']);
    const batch = morningBatch({ reason: "sleep", since: new Date("2026-10-24T00:00:00Z"), until: new Date("2026-10-24T08:00:00Z"), places: [], items: [wake] }, view);
    expect(batch).toContain('  · watch timed out (Sat 24 Oct 17:00) · your note: "asked felix about seed 2" · you\'ve written in bake-club/#general 3 times since anyone answered (since Tue 21:00)');
  });

  it("unansweredForWakes words the streaks of her ended watches' places, from two sends", async () => {
    const w = await lifeWorld(roots);
    w.discord.post(ROOM, "seeds are up");
    await sendMessage(await ctxFor(w), "bake-club/#general", [{ text: "who's seed 2" }]);
    const wake: Wake = { id: "e1", reason: "watch_timeout", watchedPlaces: [ROOM_KEY], at: w.clock.now().toISOString() };
    const self = await selfAuthorIds(w.storage, await readWaifu(w.storage, "ella"));
    expect([...(await unansweredForWakes(w.cast.deps, { waifuId: "ella", selfAuthorIds: self, wakes: [wake], now: w.clock.now() })).entries()]).toEqual([]);
    w.clock.advance(2 * HOUR);
    await sendMessage(await ctxFor(w), "bake-club/#general", [{ text: "seed 2??" }]);
    // Only watch timeouts count; a mention's place is not looked at.
    const other: Wake = { id: "m1", reason: "mention", placeKey: ROOM_KEY, at: w.clock.now().toISOString() };
    expect([...(await unansweredForWakes(w.cast.deps, { waifuId: "ella", selfAuthorIds: self, wakes: [wake, other], now: w.clock.now() })).entries()]).toEqual([
      [ROOM_KEY, "you've written in bake-club/#general 2 times since anyone answered (since Sat 14:00)"]
    ]);
    expect((await unansweredForWakes(w.cast.deps, { waifuId: "ella", selfAuthorIds: self, wakes: [other], now: w.clock.now() })).size).toBe(0);
  });

  it("a real turn: her watch on the room ends after two unanswered sends, and the notification says so", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([
          { name: "Wakeup", input: { script: `text(await tools.wakeup({ watch: [{ places: "bake-club/#general", from: "<@${KEVIN}>", for: "3h", note: "asked kevin about seed 2" }] }))` } },
          { name: "SendMessage", input: { script: 'text(await tools.send_message({ place: "bake-club/#general", messages: [{ text: "kevin who is seed 2" }] }))' } }
        ]),
        textTurn("(waiting)"),
        textTurn("(letting it go)")
      )
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const message = w.discord.post(ROOM, `<@${ELLA_BOT}> you there?`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
    await w.cast.settle();
    w.cast.intake.flushDetector();
    await w.cast.settle();
    await w.cast.life("ella").runNow();
    // Her follow-up two hours later (sent here directly), then the watch ends with no answer.
    w.clock.advance(2 * HOUR);
    await sendMessage(await ctxFor(w), "bake-club/#general", [{ text: "seed 2?" }]);
    w.clock.advance(HOUR + 60_000);
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, lastMaintenanceAt: w.clock.now().toISOString() }));
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    await w.cast.life("ella").runNow();
    const last = JSON.stringify(w.anthropic.calls[w.anthropic.calls.length - 1]!.request.messages);
    expect(last).toContain("- watch timed out · your note: \\\"asked kevin about seed 2\\\" · you've written in bake-club/#general 2 times since anyone answered (since Sat 14:00)");
  });
});
