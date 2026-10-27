// Crash, restart and catch-up (Living cast spec §5.7, §12): a crash between a tool call and its
// result, and between a Discord send and its result, recovers without a duplicate send; boot catch-up
// takes what arrived during downtime within the window; queued wakes start turns again.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendIntent, appendLifeLog, readLifeFile, readLifeLog, readLifeState, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { RESTART_NOTE, UNCERTAIN_SEND } from "../src/life/repair.js";
import { contentDigest } from "../src/life/tools/messages.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { textTurn } from "./modelFakes.js";
import { ELLA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, MINA_BOT, ROOM, ROOM_KEY, script, toolTurn, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 32);

async function mention(w: LifeWorld, text: string) {
  const message = w.discord.post(ROOM, `<@${ELLA_BOT}> ${text}`, { mentions: { [ELLA_BOT]: "Ella" } });
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
  await w.cast.settle();
  // Her wake waits for the burst's quiet time (§4.2): fire it now.
  w.cast.intake.flushDetector();
  await w.cast.settle();
  return message;
}

/** One finished turn (so she has an epoch and a log), then a crash inside the next turn after `calls`. */
async function crashAfter(w: LifeWorld, call: { id: string; name: string; input: unknown }, o: { intent?: boolean } = {}): Promise<void> {
  await mention(w, "hello!");
  await w.cast.life("ella").runNow();
  // Time passes before the crash: the intake marks are on disk (they are written within a second).
  await w.cast.marks.flush();
  const state = await readLifeState(w.storage, "ella");
  const log = await readLifeLog(w.storage, "ella", state.epoch);
  const turnId = "t-crash";
  const at = w.clock.now().toISOString();
  const line: LifeLogLine = {
    seq: log[log.length - 1]!.seq + 1,
    at,
    kind: "assistant",
    turnId,
    message: { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }] } as never
  };
  await appendLifeLog(w.storage, "ella", state.epoch, [line]);
  if (o.intent) await appendIntent(w.storage, "ella", { turnId, toolCallId: call.id, tool: call.name, argsDigest: digest(call.input), at });
  await updateLifeState(w.storage, "ella", (current) => ({ ...current, status: "turn", currentTurn: { id: turnId, startedAt: at, rounds: 1, wakeIds: [], wakes: [] } }));
}

async function tail(w: LifeWorld): Promise<LifeLogLine> {
  const state = await readLifeState(w.storage, "ella");
  const log = await readLifeLog(w.storage, "ella", state.epoch);
  return log[log.length - 1]!;
}

describe("crash repair (§5.7)", () => {
  it("a crash between a tool call and its result: the call is closed as interrupted, the turn ends", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    await crashAfter(w, { id: "call_x", name: "Read", input: { file_path: "~/life/places.md" } });
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const last = await tail(w);
    expect(last.kind).toBe("tool_results");
    expect(last.message).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_x", content: "[interrupted]", is_error: true }, { type: "text", text: RESTART_NOTE }, { type: "text" }]
    });
    expect((await readLifeState(w.storage, "ella")).status).toBe("idle");
  });

  it("a crash after a Discord send but before its result: recovered from the conversation, never sent twice", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    const input = { place: "bake-club/#general", text: "brownies are out of the oven!" };
    await crashAfter(w, { id: "call_send", name: "SendMessage", input }, { intent: true });
    // The send reached Discord before the crash.
    w.discord.post(ROOM, input.text, { authorId: ELLA_BOT, authorName: "Ella", bot: true });
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
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
    await crashAfter(w, { id: "call_send", name: "SendMessage", input }, { intent: true });
    // The facade resolved the emoji and recorded the final content's digest just before the call.
    const final = "brownies are out 🎉";
    await appendIntent(w.storage, "ella", { turnId: "t-crash", toolCallId: "call_send", tool: "SendMessage", argsDigest: digest(input), at: w.clock.now().toISOString(), contentDigest: contentDigest(final) });
    w.discord.post(ROOM, final, { authorId: ELLA_BOT, authorName: "Ella", bot: true });
    // A busy room: 60 more messages before the restart.
    for (let index = 0; index < 60; index += 1) w.discord.post(ROOM, `chatter ${index}`);
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const results = ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content;
    expect(results[0]!.content).toMatch(/^sent #[0-9a-z]+ \(recovered\)$/u);
    expect(w.discord.sent).toEqual([]);
  });

  it("a conversation it cannot read leaves the send unknown, never 'not sent'", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    const input = { place: "bake-club/#general", text: "did this go out?" };
    await crashAfter(w, { id: "call_send", name: "SendMessage", input }, { intent: true });
    w.discord.fetchContextSince = async () => {
      throw new Error("503 Service Unavailable");
    };
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const results = ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content;
    expect(results[0]).toMatchObject({ content: UNCERTAIN_SEND, is_error: true });
  });

  it("the interrupted turn's wakes go back to the queue (review I4)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    await crashAfter(w, { id: "call_x", name: "Read", input: { file_path: "~/life/places.md" } });
    const wake = { id: "w-lost", reason: "mention" as const, placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: "900000000000000001", at: w.clock.now().toISOString() };
    await updateLifeState(w.storage, "ella", (current) => ({ ...current, currentTurn: { ...current.currentTurn!, wakeIds: [wake.id], wakes: [wake] } }));
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((entry) => entry.id)).toEqual(["w-lost"]);
  });

  it("a crash before the send reached Discord: interrupted, not sent (and not retried by repair)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing to send)")) });
    await crashAfter(w, { id: "call_send", name: "SendMessage", input: { place: "bake-club/#general", text: "never arrived" } }, { intent: true });
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    const results = ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content;
    expect(results[0]).toMatchObject({ content: "[interrupted] not sent", is_error: true });
    expect(w.discord.sent).toEqual([]);
  });
});

describe("crash repair of her file tools (review minors)", () => {
  /** Restarts and returns the repaired call's result. */
  async function repaired(w: LifeWorld): Promise<{ content?: string; is_error?: boolean }> {
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    return ((await tail(w)).message as { content: Array<{ content?: string; is_error?: boolean }> }).content[0]!;
  }

  it("a Write of watches.json counts as done when the file holds the same entries with ids; another file only when equal", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing)")) });
    const content = '[{"timeout": "2026-10-25 14:00", "once": true, "note": "tea", "when": []}]';
    await crashAfter(w, { id: "call_w", name: "Write", input: { file_path: "~/life/watches.json", content } }, { intent: true });
    await writeHerFile(w, "life/watches.json", content);
    expect(await repaired(w)).toMatchObject({ content: "wrote ~/life/watches.json (recovered)" });

    const v = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing)")) });
    await crashAfter(v, { id: "call_n", name: "Write", input: { file_path: "~/notes.md", content: "short" } }, { intent: true });
    // A longer file that merely has "id": in it is not what she wrote.
    await writeHerFile(v, "notes.md", 'something else entirely, "id": 1');
    expect(await repaired(v)).toMatchObject({ content: "[interrupted] not written", is_error: true });
  }, 30_000);

  it("a ScheduleWake counts as done only for an entry with its note at the time it asked for", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing)")) });
    await crashAfter(w, { id: "call_s", name: "ScheduleWake", input: { at: "2026-10-25 18:00", note: "call mum" } }, { intent: true });
    // An older reminder with the same note at another time is not this one.
    await writeHerFile(w, "life/reminders.json", '[{"at": "2026-10-26 09:00", "note": "call mum"}]');
    expect(await repaired(w)).toMatchObject({ content: "[interrupted] not set", is_error: true });

    const v = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing)")) });
    await crashAfter(v, { id: "call_s", name: "ScheduleWake", input: { at: "2026-10-25 18:00", note: "call mum" } }, { intent: true });
    await writeHerFile(v, "life/reminders.json", '[{"at": "2026-10-26 09:00", "note": "call mum"}, {"at": "2026-10-25 18:00", "note": "call mum"}]');
    expect(await repaired(v)).toMatchObject({ content: "set r2 (recovered)" });
  }, 30_000);

  it("a Bash change set saved just before the crash (its done line not written yet) is reported as saved", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi!"), textTurn("(nothing)")) });
    await crashAfter(w, { id: "call_b", name: "Bash", input: { command: "echo hi > ~/x.md" } }, { intent: true });
    const dir = path.join(w.root, "user", "waifus", "ella", "life", "pending-changes");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "call_b.applied"), "{}");
    expect(await repaired(w)).toMatchObject({ content: "[interrupted by a restart] the command ran and its changes were saved" });
  });
});

describe("catch-up never takes a routed message twice (review I3)", () => {
  it("a mention she was woken for but never read does not wake her again after a reload", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("not now"), textTurn("(nothing to send)")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await mention(w, "are you free saturday?");
    await w.cast.life("ella").runNow();
    // A config save rebuilds the runtime: a clean stop, then a new cast over the same data root.
    await w.cast.stop();
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    await restarted.settle();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toEqual([]);
  });

  it("a message delivered live after connect and seen again by catch-up wakes her once", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const message = await mention(w, "hello?");
    await w.cast.catchUpAndResume();
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
    await w.cast.settle();
    // Her wake waits for the burst's quiet time (§4.2): fire it now.
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.messageId)).toEqual([message.id]);
  });

  it("a resume catches up from the pause start, past the boot window", async () => {
    let paused = false;
    const w = await lifeWorld(roots, { paused: () => paused, config: (config) => ({ ...config, discord: { ...config.discord, dm: { ...config.discord.dm, resumeWindowMinutes: 10 } } }) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await mention(w, "warm-up");
    await w.cast.life("ella").runNow().catch(() => undefined);
    await updateLifeFile(w.storage, "ella", "wakes", (queue) => ({ ...queue, immediate: [] }));
    paused = true;
    w.cast.pause();
    // Paused for two hours; the ping came early in the pause.
    w.clock.advance(5 * 60_000);
    const ping = w.discord.post(ROOM, `<@${ELLA_BOT}> ping`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: ping.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: ping });
    await w.cast.settle();
    // Her wake waits for the burst's quiet time (§4.2): fire it now.
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toEqual([]);
    w.clock.advance(2 * 3_600_000);
    paused = false;
    w.cast.resume();
    await w.cast.settle();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.messageId)).toEqual([ping.id]);
  });

  it("a reload while paused keeps the pause start: the resume still catches up from it (N4)", async () => {
    let paused = false;
    const w = await lifeWorld(roots, { paused: () => paused, config: (config) => ({ ...config, discord: { ...config.discord, dm: { ...config.discord.dm, resumeWindowMinutes: 10 } } }) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    paused = true;
    w.cast.pause();
    w.clock.advance(5 * 60_000);
    const ping = w.discord.post(ROOM, `<@${ELLA_BOT}> are you there?`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: ping.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: ping });
    // The owner saves a setting while paused: the runtime is rebuilt.
    await w.cast.stop();
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    w.clock.advance(2 * 3_600_000);
    paused = false;
    restarted.resume();
    await restarted.settle();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.messageId)).toEqual([ping.id]);
  });

  it("a pause before the new runtime has loaded its marks keeps every saved mark (third review, minor 2)", async () => {
    let paused = false;
    const w = await lifeWorld(roots, { paused: () => paused });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    // A waifu's message is marked once routed: at once when direct, else once its burst's detector
    // call is done (§4.3; fired here).
    const message = w.discord.post(ROOM, "good morning", { authorId: "400000000000000005", authorName: "Mina", bot: true });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: true, raw: message });
    w.cast.intake.flushDetector();
    await w.cast.settle();
    await w.cast.stop();
    const saved = JSON.parse(await readFile(`${w.root}/app/intake-marks.json`, "utf8")) as { marks: Record<string, string> };
    expect(saved.marks[ROOM_KEY]).toBe(message.id);
    // A config save rebuilds the runtime, and the owner presses Pause before it has started.
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    paused = true;
    restarted.pause();
    await restarted.settle();
    await restarted.start();
    const after = JSON.parse(await readFile(`${w.root}/app/intake-marks.json`, "utf8")) as { marks: Record<string, string>; pausedAt?: string };
    expect(after.marks[ROOM_KEY]).toBe(message.id);
    expect(after.pausedAt).toBeDefined();
    expect(restarted.marks.get(ROOM_KEY)).toBe(message.id);
  });

  it("a pause during a resume's catch-up keeps the earlier start; a reload then still catches up (third review, minor 3)", async () => {
    let paused = false;
    const w = await lifeWorld(roots, { paused: () => paused, config: (config) => ({ ...config, discord: { ...config.discord, dm: { ...config.discord.dm, resumeWindowMinutes: 10 } } }) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    paused = true;
    w.cast.pause();
    const firstStart = w.clock.now().toISOString();
    w.clock.advance(60_000);
    paused = false;
    w.cast.resume();
    // Paused again while that resume still catches up.
    paused = true;
    w.cast.pause();
    await w.cast.settle();
    const saved = JSON.parse(await readFile(`${w.root}/app/intake-marks.json`, "utf8")) as { pausedAt?: string };
    expect(saved.pausedAt).toBe(firstStart);
    w.clock.advance(5 * 60_000);
    const ping = w.discord.post(ROOM, `<@${ELLA_BOT}> are you there?`, { mentions: { [ELLA_BOT]: "Ella" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: ping.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: ping });
    w.clock.advance(30 * 60_000);
    await w.cast.stop();
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    w.clock.advance(2 * 3_600_000);
    paused = false;
    restarted.resume();
    await restarted.settle();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.messageId)).toEqual([ping.id]);
    // That resume finished undisturbed: the saved start goes.
    expect((JSON.parse(await readFile(`${w.root}/app/intake-marks.json`, "utf8")) as { pausedAt?: string }).pausedAt).toBeUndefined();
  });

  it("a staggered @everyone wake a reload drops is taken again by the catch-up (N3)", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "ella", name: "Ella", botId: "ella-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ],
      options: { random: () => 0.5 }
    });
    for (const id of ["ella", "mina"]) vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
    const ping = w.discord.post(ROOM, "@everyone bake sale tomorrow!", { everyone: true });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: ping.id, castWaifuIds: ["ella", "mina"], authorIsWaifu: false, raw: ping });
    // Still inside the 10 s stagger: no mark yet. A reload drops both staggered wakes.
    expect(w.cast.marks.get(ROOM_KEY)).toBeUndefined();
    await w.cast.stop();
    const restarted = w.restart({ random: () => 0 });
    for (const id of ["ella", "mina"]) vi.spyOn(restarted.life(id), "poke").mockImplementation(() => undefined);
    await restarted.start();
    await restarted.settle();
    for (const id of ["ella", "mina"]) expect((await readLifeFile(w.storage, id, "wakes")).immediate.map((wake) => [wake.reason, wake.messageId])).toEqual([["everyone", ping.id]]);
    expect(restarted.marks.get(ROOM_KEY)).toBe(ping.id);
  });

  it("a waifu's message never moves the mark past a human message whose burst is still pending (N3)", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "ella", name: "Ella", botId: "ella-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ]
    });
    for (const id of ["ella", "mina"]) vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
    const human = w.discord.post(ROOM, "anyone know a good brownie recipe?");
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: human.id, castWaifuIds: ["ella", "mina"], authorIsWaifu: false, raw: human });
    w.clock.advance(500);
    const fromMina = w.discord.post(ROOM, "good morning everyone", { authorId: MINA_BOT, authorName: "Mina", bot: true });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: fromMina.id, castWaifuIds: ["ella", "mina"], authorIsWaifu: true, raw: fromMina });
    expect(w.cast.marks.get(ROOM_KEY)).toBeUndefined();
    // A reload while the human's burst is still debouncing: the catch-up takes the human message again.
    await w.cast.stop();
    const restarted = w.restart();
    const taken: string[] = [];
    const original = restarted.intake.onGuildMessage.bind(restarted.intake);
    vi.spyOn(restarted.intake, "onGuildMessage").mockImplementation(async (input) => {
      taken.push(input.messageId);
      return original(input);
    });
    for (const id of ["ella", "mina"]) vi.spyOn(restarted.life(id), "poke").mockImplementation(() => undefined);
    await restarted.start();
    expect(taken).toContain(human.id);
  });
});

describe("intake marks and forget (F10)", () => {
  const marksFile = async (w: LifeWorld) => (await import("node:fs/promises")).readFile(`${w.root}/app/intake-marks.json`, "utf8");

  it("a DM forget, the owner's forget and a boot-time queued scrub each drop the person's DM marks at once", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "ella", name: "Ella", botId: "ella-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ]
    });
    w.cast.marks.advance(`dm_${KEVIN}_ella`, "900000000000000001");
    w.cast.marks.advance(`dm_${KEVIN}_mina`, "900000000000000002");
    w.cast.marks.advance(ROOM_KEY, "900000000000000003");
    await w.cast.marks.flush();
    await mkdirLife(w, "ella");
    await mkdirLife(w, "mina");
    // A DM /forget conversation (also rate-limited ones): her DM's mark, at once.
    await w.cast.prepareForget({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "conversation" });
    expect(await marksFile(w)).not.toContain(`dm_${KEVIN}_ella`);
    expect(await marksFile(w)).toContain(`dm_${KEVIN}_mina`);
    // The owner's forget-user: every DM mark of the person.
    await w.cast.prepareOwnerForget(KEVIN);
    expect(await marksFile(w)).not.toContain(KEVIN);
    expect(await marksFile(w)).toContain(ROOM_KEY);
    // An owner forget queued while the host was down runs at boot and drops the mark too.
    w.cast.marks.advance(`dm_${KEVIN}_mina`, "900000000000000004");
    await w.cast.marks.flush();
    await w.cast.stop();
    const restarted = w.restart();
    await restarted.start();
    await restarted.settle();
    expect(await marksFile(w)).not.toContain(KEVIN);
  });
});

/** A life folder, so the forget paths treat her as a waifu with a life. */
async function mkdirLife(w: LifeWorld, waifuId: string): Promise<void> {
  await updateLifeState(w.storage, waifuId, (state) => state);
}

describe("boot catch-up (§5.7)", () => {
  it("takes what arrived during downtime within the window, newer than her read cursor; queued wakes restart her", async () => {
    const w = await lifeWorld(roots, { scripts: script(toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]), textTurn("hi!"), textTurn("(nothing to send)")) });
    await mention(w, "hello!");
    await w.cast.life("ella").runNow();
    await w.cast.stop();
    // Downtime: an old ping (outside the 60-minute window) and a recent one.
    w.discord.post(ROOM, `<@${ELLA_BOT}> are you there?`, { mentions: { [ELLA_BOT]: "Ella" } });
    w.clock.advance(90 * 60_000);
    const recent = w.discord.post(ROOM, `<@${ELLA_BOT}> back yet?`, { mentions: { [ELLA_BOT]: "Ella" } });
    const dm = w.discord.post(dmOf("ella"), "psst");
    await (await import("../src/orchestration/dm/dmStore.js")).updateDmState(w.storage, { userId: KEVIN, waifuId: "ella", botId: "ella-bot" }, (state) => ({
      ...state,
      userDisplayName: "Kevin",
      lastInboundMessageId: dm.id,
      lastInboundAt: dm.createdAt
    }));
    w.clock.advance(5 * 60_000);
    const restarted = w.restart();
    const poke = vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    restarted.intake.flushDms();
    await restarted.settle();
    const queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate.map((wake) => [wake.reason, wake.messageId])).toEqual([
      ["mention", recent.id],
      ["dm", dm.id]
    ]);
    expect(poke).toHaveBeenCalled();
    expect(queue.immediate[0]!.placeKey).toBe(ROOM_KEY);
  });
});
