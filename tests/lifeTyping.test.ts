// "Typing…" while she works (Living cast spec §6.3): the keeper's refresh and cleanup under fake
// timers, the turn's plan (direct wakes at once, uncertain ones once she commits), and a life turn
// end to end over the fake Discord. No live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueWake } from "../src/life/wakeQueue.js";
import { TYPING_REFRESH_MS, TypingKeeper, typingPlan } from "../src/life/typing.js";
import type { Wake } from "../src/shared/schemas/life.js";
import { CHANNEL, closeWorlds, KEVIN, lifeWorld, ROOM, ROOM_KEY, script, toolTurn } from "./lifeFixtures.js";
import { textTurn } from "./modelFakes.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const AT = "2026-10-24T14:00:00.000Z";
const wake = (reason: Wake["reason"], placeKey?: string): Wake => ({ id: `w-${reason}`, reason, ...(placeKey ? { placeKey } : {}), at: AT });

function fakeDeps(o: { fail?: boolean } = {}) {
  const typed: string[] = [];
  const warnings: string[] = [];
  let ms = Date.parse(AT);
  const discord = {
    async sendTyping(input: { channelId: string; senderBotId?: string }) {
      typed.push(`${input.senderBotId}:${input.channelId}`);
      if (o.fail) throw new Error("rate limited");
    },
    async sendDirectTyping(input: { userId: string }) {
      typed.push(`dm:${input.userId}`);
    }
  };
  return {
    typed,
    warnings,
    advance: (by: number) => (ms += by),
    deps: { discord: () => discord as never, logger: { warn: (message: string) => warnings.push(message) } as never, now: () => new Date(ms) }
  };
}

describe("the typing keeper", () => {
  it("shows typing at once, refreshes every 8 s, and stops on send, on stop and for another place", async () => {
    vi.useFakeTimers();
    const f = fakeDeps();
    const keeper = new TypingKeeper(f.deps, { id: "ella", botId: "ella-bot" });
    keeper.start(ROOM_KEY);
    keeper.start(ROOM_KEY);
    expect(f.typed).toEqual([`ella-bot:${CHANNEL}`]);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
    expect(f.typed).toHaveLength(4);
    keeper.sent(ROOM_KEY);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
    expect(f.typed).toHaveLength(4);
    // Her next message there types again; starting elsewhere moves it (one place at a time).
    keeper.start(ROOM_KEY);
    expect(f.typed).toHaveLength(5);
    keeper.start(`dm_${KEVIN}_ella`);
    expect(f.typed.at(-1)).toBe(`dm:${KEVIN}`);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    expect(f.typed.at(-1)).toBe(`dm:${KEVIN}`);
    keeper.stop();
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
    expect(f.typed).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows nothing without her own bot or for another waifu's DM; a failure warns at most once a minute", async () => {
    vi.useFakeTimers();
    const f = fakeDeps({ fail: true });
    new TypingKeeper(f.deps, { id: "ella" }).start(ROOM_KEY);
    new TypingKeeper(f.deps, { id: "ella", botId: "ella-bot" }).start(`dm_${KEVIN}_mina`);
    expect(f.typed).toEqual([]);
    const keeper = new TypingKeeper(f.deps, { id: "ella", botId: "ella-bot" });
    keeper.start(ROOM_KEY);
    for (let i = 0; i < 5; i += 1) {
      f.advance(TYPING_REFRESH_MS);
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    }
    expect(f.typed).toHaveLength(6);
    expect(f.warnings).toEqual(["Could not show typing"]);
    keeper.stop();
  });

  it("plans the place of the wake that started the turn: wakes meant for her type at once, looser ones wait", () => {
    expect(typingPlan([wake("mention", ROOM_KEY), wake("detector", "g_1_2")])).toEqual({ placeKey: ROOM_KEY, immediate: true });
    expect(typingPlan([wake("dm", `dm_${KEVIN}_ella`)])).toEqual({ placeKey: `dm_${KEVIN}_ella`, immediate: true });
    expect(typingPlan([wake("detector", ROOM_KEY)])).toEqual({ placeKey: ROOM_KEY, immediate: true });
    for (const reason of ["watch", "everyone", "role"] as const) expect(typingPlan([wake(reason, ROOM_KEY)])).toEqual({ placeKey: ROOM_KEY, immediate: false });
    expect(typingPlan([wake("reminder"), wake("watch", ROOM_KEY)])).toEqual({ placeKey: ROOM_KEY, immediate: false });
    expect(typingPlan([wake("reminder"), wake("owner")])).toBeUndefined();
    expect(typingPlan([{ ...wake("watch", ROOM_KEY), reasons: ["watch", "mention"] }])).toEqual({ placeKey: ROOM_KEY, immediate: true });
  });
});

describe("typing in a turn", () => {
  it("a mention types from the start; it stops once she sent there", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "hi!" } }]), textTurn("(sent)"))
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const message = w.discord.post(ROOM, "hey ella");
    await enqueueWake(w.storage, "ella", { id: "w-m", reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: message.id, preview: "hey ella", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    // Turn start, then SendMessage's own typing before the send.
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL]);
  });

  it("a 'maybe for you' types from the start; a watch waits until she does more than read", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        textTurn("(not for me)"),
        toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]),
        textTurn("(nothing)"),
        toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]),
        toolTurn([{ name: "WebSearch", input: { query: "lemon tart recipe" } }]),
        textTurn("(nothing to add)")
      )
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const message = w.discord.post(ROOM, "any good tart recipes?");
    const base = { placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: message.id, preview: "any good tart recipes?", at: w.clock.now().toISOString() };
    await enqueueWake(w.storage, "ella", { id: "w-d1", reason: "detector", ...base });
    await w.cast.life("ella").runNow();
    expect(w.discord.typing).toEqual([CHANNEL]);
    // A watch that only reads shows nothing; one that goes on to search does.
    await enqueueWake(w.storage, "ella", { id: "w-w1", reason: "watch", ...base });
    await w.cast.life("ella").runNow();
    expect(w.discord.typing).toEqual([CHANNEL]);
    await enqueueWake(w.storage, "ella", { id: "w-w2", reason: "watch", ...base });
    await w.cast.life("ella").runNow();
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL]);
  });

  it("types again for her next message after a send, but not while she only writes notes", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "hi!" } }]),
        toolTurn([{ name: "Write", input: { file_path: "~/kevin.md", content: "likes tarts" } }]),
        toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "also, lemon" } }]),
        textTurn("(sent)")
      )
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const message = w.discord.post(ROOM, "hey ella");
    await enqueueWake(w.storage, "ella", { id: "w-m", reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: message.id, preview: "hey ella", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    // Turn start + the first send's own typing; nothing for the note; the second SendMessage
    // typing as it starts streaming + its own typing.
    expect(w.discord.typing).toEqual([CHANNEL, CHANNEL, CHANNEL, CHANNEL]);
  });
});
