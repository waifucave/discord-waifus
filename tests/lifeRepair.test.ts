// Crash, restart and catch-up (Living cast spec §5.7, §12): a crash between a tool call and its
// result, and between a Discord send and its result, recovers without a duplicate send; boot catch-up
// takes what arrived during downtime within the window; queued wakes start turns again.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendIntent, appendLifeLog, readLifeFile, readLifeLog, readLifeState, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { RESTART_NOTE, UNCERTAIN_SEND } from "../src/life/repair.js";
import { contentDigest } from "../src/life/tools/messages.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { textTurn } from "./modelFakes.js";
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, ROOM, ROOM_KEY, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 32);

async function mention(w: LifeWorld, text: string) {
  const message = w.discord.post(ROOM, `<@${ARIA_BOT}> ${text}`, { mentions: { [ARIA_BOT]: "Aria" } });
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
  await w.cast.settle();
  return message;
}

/** One finished turn (so she has an epoch and a log), then a crash inside the next turn after `calls`. */
async function crashAfter(w: LifeWorld, call: { id: string; name: string; input: unknown }, o: { intent?: boolean } = {}): Promise<void> {
  await mention(w, "hello!");
  await w.cast.life("aria").runNow();
  // Time passes before the crash: the intake marks are on disk (they are written within a second).
  await w.cast.marks.flush();
  const state = await readLifeState(w.storage, "aria");
  const log = await readLifeLog(w.storage, "aria", state.epoch);
  const turnId = "t-crash";
  const at = w.clock.now().toISOString();
  const line: LifeLogLine = {
    seq: log[log.length - 1]!.seq + 1,
    at,
    kind: "assistant",
    turnId,
    message: { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }] } as never
  };
  await appendLifeLog(w.storage, "aria", state.epoch, [line]);
  if (o.intent) await appendIntent(w.storage, "aria", { turnId, toolCallId: call.id, tool: call.name, argsDigest: digest(call.input), at });
  await updateLifeState(w.storage, "aria", (current) => ({ ...current, status: "turn", currentTurn: { id: turnId, startedAt: at, rounds: 1, wakeIds: [], wakes: [] } }));
}

async function tail(w: LifeWorld): Promise<LifeLogLine> {
  const state = await readLifeState(w.storage, "aria");
  const log = await readLifeLog(w.storage, "aria", state.epoch);
  return log[log.length - 1]!;
}

describe("crash repair (§5.7)", () => {
  it("a crash between a tool call and its result: the call is closed as interrupted, the turn ends", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    await crashAfter(w, { id: "call_x", name: "list_places", input: {} });
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const last = await tail(w);
    expect(last.kind).toBe("tool_results");
    expect(last.message).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_x", content: "[interrupted]", is_error: true }, { type: "text", text: RESTART_NOTE }, { type: "text" }]
    });
    expect((await readLifeState(w.storage, "aria")).status).toBe("idle");
  });

  it("a crash after a Discord send but before its result: recovered from the conversation, never sent twice", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    const input = { place: "bake-club/#general", text: "brownies are out of the oven!" };
    await crashAfter(w, { id: "call_send", name: "send_message", input }, { intent: true });
    // The send reached Discord before the crash.
    w.discord.post(ROOM, input.text, { authorId: ARIA_BOT, authorName: "Aria", bot: true });
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const last = await tail(w);
    const results = (last.message as { content: Array<{ type: string; content?: string; is_error?: boolean }> }).content;
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_send" });
    expect(results[0]!.content).toMatch(/^sent #[0-9a-z]+ \(recovered\)$/u);
    expect(results[0]!.is_error).toBeUndefined();
    expect(w.discord.sent).toEqual([]);
  });

  it("finds a send Discord's side rewrote (by the digest of the final content), even past the newest 50 messages", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    const input = { place: "bake-club/#general", text: "brownies are out :tada:" };
    await crashAfter(w, { id: "call_send", name: "send_message", input }, { intent: true });
    // The facade resolved the emoji and recorded the final content's digest just before the call.
    const final = "brownies are out 🎉";
    await appendIntent(w.storage, "aria", { turnId: "t-crash", toolCallId: "call_send", tool: "send_message", argsDigest: digest(input), at: w.clock.now().toISOString(), contentDigest: contentDigest(final) });
    w.discord.post(ROOM, final, { authorId: ARIA_BOT, authorName: "Aria", bot: true });
    // A busy room: 60 more messages before the restart.
    for (let index = 0; index < 60; index += 1) w.discord.post(ROOM, `chatter ${index}`);
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const results = ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content;
    expect(results[0]!.content).toMatch(/^sent #[0-9a-z]+ \(recovered\)$/u);
    expect(w.discord.sent).toEqual([]);
  });

  it("a conversation it cannot read leaves the send unknown, never 'not sent'", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    const input = { place: "bake-club/#general", text: "did this go out?" };
    await crashAfter(w, { id: "call_send", name: "send_message", input }, { intent: true });
    w.discord.fetchContextSince = async () => {
      throw new Error("503 Service Unavailable");
    };
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const results = ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content;
    expect(results[0]).toMatchObject({ content: UNCERTAIN_SEND, is_error: true });
  });

  it("the interrupted turn's wakes go back to the queue (review I4)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    await crashAfter(w, { id: "call_x", name: "list_places", input: {} });
    const wake = { id: "w-lost", reason: "mention" as const, placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: "900000000000000001", at: w.clock.now().toISOString() };
    await updateLifeState(w.storage, "aria", (current) => ({ ...current, currentTurn: { ...current.currentTurn!, wakeIds: [wake.id], wakes: [wake] } }));
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate.map((entry) => entry.id)).toEqual(["w-lost"]);
  });

  it("a crash before the send reached Discord: interrupted, not sent (and not retried by repair)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    await crashAfter(w, { id: "call_send", name: "send_message", input: { place: "bake-club/#general", text: "never arrived" } }, { intent: true });
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const results = ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content;
    expect(results[0]).toMatchObject({ content: "[interrupted] not sent", is_error: true });
    expect(w.discord.sent).toEqual([]);
  });
});

describe("catch-up never takes a routed message twice (review I3)", () => {
  it("a mention she was woken for but never read does not wake her again after a reload", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("not now"), textTurn("(nothing to send)")) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await mention(w, "are you free saturday?");
    await w.cast.life("aria").runNow();
    // A config save rebuilds the runtime: a clean stop, then a new cast over the same data root.
    await w.cast.stop();
    const restarted = w.restart();
    vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    await restarted.settle();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([]);
  });

  it("a message delivered live after connect and seen again by catch-up wakes her once", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const message = await mention(w, "hello?");
    await w.cast.catchUpAndResume();
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
    await w.cast.settle();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate.map((wake) => wake.messageId)).toEqual([message.id]);
  });

  it("a resume catches up from the pause start, past the boot window", async () => {
    let paused = false;
    const w = await lifeWorld(roots, { paused: () => paused, config: (config) => ({ ...config, discord: { ...config.discord, dm: { ...config.discord.dm, resumeWindowMinutes: 10 } } }) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await mention(w, "warm-up");
    await w.cast.life("aria").runNow().catch(() => undefined);
    await updateLifeFile(w.storage, "aria", "wakes", (queue) => ({ ...queue, immediate: [] }));
    paused = true;
    w.cast.pause();
    // Paused for two hours; the ping came early in the pause.
    w.clock.advance(5 * 60_000);
    const ping = w.discord.post(ROOM, `<@${ARIA_BOT}> ping`, { mentions: { [ARIA_BOT]: "Aria" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: ping.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: ping });
    await w.cast.settle();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([]);
    w.clock.advance(2 * 3_600_000);
    paused = false;
    w.cast.resume();
    await w.cast.settle();
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate.map((wake) => wake.messageId)).toEqual([ping.id]);
  });
});

describe("boot catch-up (§5.7)", () => {
  it("takes what arrived during downtime within the window, newer than her read cursor; queued wakes restart her", async () => {
    const w = await lifeWorld(roots, { scripts: script(toolTurn([{ name: "read_messages", input: { place: "bake-club/#general" } }]), textTurn("hi!"), textTurn("(nothing to send)")) });
    await mention(w, "hello!");
    await w.cast.life("aria").runNow();
    await w.cast.stop();
    // Downtime: an old ping (outside the 60-minute window) and a recent one.
    w.discord.post(ROOM, `<@${ARIA_BOT}> are you there?`, { mentions: { [ARIA_BOT]: "Aria" } });
    w.clock.advance(90 * 60_000);
    const recent = w.discord.post(ROOM, `<@${ARIA_BOT}> back yet?`, { mentions: { [ARIA_BOT]: "Aria" } });
    const dm = w.discord.post(dmOf("aria"), "psst");
    await (await import("../src/orchestration/dm/dmStore.js")).updateDmState(w.storage, { userId: KEVIN, waifuId: "aria", botId: "aria-bot" }, (state) => ({
      ...state,
      userDisplayName: "Kevin",
      lastInboundMessageId: dm.id,
      lastInboundAt: dm.createdAt
    }));
    w.clock.advance(5 * 60_000);
    const restarted = w.restart();
    const poke = vi.spyOn(restarted.life("aria"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    restarted.intake.flushDms();
    await restarted.settle();
    const queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate.map((wake) => [wake.reason, wake.messageId])).toEqual([
      ["mention", recent.id],
      ["dm", dm.id]
    ]);
    expect(poke).toHaveBeenCalled();
    expect(queue.immediate[0]!.placeKey).toBe(ROOM_KEY);
  });
});
