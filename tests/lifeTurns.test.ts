// Turn endings (Living cast spec §5.2, §5.6; review I1, I2, I4, I6, M6, M8, M13): what happens to
// her wakes when a turn is capped, interrupted, compacted, refused or blocked by a provider
// cooldown. Scripted winter fakes, temp data root; no live calls.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { CUT_OFF_RESULT, FOLLOW_UP_NOTE, REFUSED_RESULT, UNSENT_REPLY_NOTE } from "../src/life/lifeLoop.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { lifeLocks } from "../src/life/paths.js";
import { TOKEN_ESTIMATOR_VERSION } from "../src/orchestration/context/tokens.js";
import { ModelClient } from "../src/models/client.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { ANTHROPIC_MESSAGES, CHAT_COMPLETIONS, errorTurn, fakeAdapter, fakeWinter, hangingTurn, OPENAI_RESPONSES, textTurn } from "./modelFakes.js";
import { readConversationRefs } from "../src/discord/refStore.js";
import { closeWorlds, KEVIN, lifeWorld, ROOM, ROOM_KEY, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { scriptInput } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const reminder = (w: LifeWorld, note: string) => enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });
const mentionWake = (w: LifeWorld, id: string) =>
  enqueueWake(w.storage, "ella", { id, reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: "900000000000000001", preview: "hey", at: w.clock.now().toISOString() });
const queuedIds = async (w: LifeWorld) => (await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.id);
const lastLine = async (w: LifeWorld) => {
  const state = await readLifeState(w.storage, "ella");
  const log = await readLifeLog(w.storage, "ella", state.epoch);
  return log[log.length - 1]!;
};

async function untilCalls(w: LifeWorld, count: number): Promise<void> {
  for (let tries = 0; w.anthropic.calls.length < count && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("token calibration", () => {
  it("a ratio learned under the old estimator is dropped and learned again (third review, minor 6)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("(nothing to send)", { inputTokens: 4_000, outputTokens: 20 }), textTurn("(nothing to send)", { inputTokens: 4_000, outputTokens: 20 })) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    // Learned under characters / 3.5 alone: for a CJK-heavy life about 2x too high now.
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, tokenCalibration: { ratio: 2, samples: 40, updatedAt: w.clock.now().toISOString() } }));
    await reminder(w, "water the plants");
    await w.cast.life("ella").runNow();
    const first = (await readLifeState(w.storage, "ella")).tokenCalibration;
    // Started over: one sample, this estimator's version, a ratio of this call alone.
    expect(first).toMatchObject({ samples: 1, estimator: TOKEN_ESTIMATOR_VERSION });
    // The next turn builds on it (same version).
    w.clock.advance(60_000);
    await reminder(w, "feed the cat");
    await w.cast.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).tokenCalibration).toMatchObject({ samples: 2, estimator: TOKEN_ESTIMATOR_VERSION });
  });
});

describe("turn endings", () => {
  it("a wake arriving in a capped round is never folded in: it stays queued and starts the next turn (I1)", async () => {
    let w!: LifeWorld;
    let queuedAfterCap: string[] | undefined;
    let cappedTail: string | undefined;
    w = await lifeWorld(roots, {
      scripts: [
        // The first turn's only round: the late wake arrives while it runs (once).
        () => {
          void mentionWake(w, "w-late");
          w.clock.advance(181_000);
          return toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
        },
        // The next turn's first call: the capped turn ended with the late wake still queued.
        (request) =>
          (async function* () {
            const state = await readLifeState(w.storage, "ella");
            const log = await readLifeLog(w.storage, "ella", state.epoch);
            cappedTail = JSON.stringify(log.filter((line) => line.turnId !== state.currentTurn?.id).at(-1)?.message);
            queuedAfterCap = state.currentTurn?.wakeIds;
            expect(JSON.stringify(request.messages.at(-1))).toContain("from Kevin");
            yield* textTurn("(nothing to send)");
          })(),
        () => textTurn("(still nothing)")
      ]
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "first");
    await w.cast.life("ella").runNow();
    expect(cappedTail).toContain("[system] turn ended: max turn time");
    expect(cappedTail).not.toContain("<notifications>");
    expect(queuedAfterCap).toEqual(["w-late"]);
    // Exactly the capped turn, the next turn and its unsent-reply check: no turn re-queued it.
    expect(w.anthropic.calls).toHaveLength(3);
    expect(await queuedIds(w)).toEqual([]);
  });

  it("a first DM folded into a running turn is a place she can read and answer at once (N2)", async () => {
    const NOVA = "300000000000000099";
    const novaKey = `dm_${NOVA}_ella`;
    let w!: LifeWorld;
    w = await lifeWorld(roots, {
      scripts: [
        // While her first round runs, someone DMs her for the first time.
        () =>
          (async function* () {
            await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: NOVA, userDisplayName: "Nova", channelId: "500000000000000001", messageId: "900000000000000123", createdAt: w.clock.now().toISOString() });
            w.cast.intake.flushDms();
            await w.cast.intake.settle();
            yield* toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
          })(),
        () => toolTurn([{ name: "ReadMessages", input: scriptInput.readMessages({ place: "dm/nova" }), id: "call_read" }, { name: "SendMessage", input: scriptInput.sendMessage("dm/nova", [{ text: "hi Nova!" }]), id: "call_send" }, { name: "Read", input: scriptInput.readFile("~/life/places.md"), id: "call_list" }]),
        () => textTurn("done")
      ]
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "water the plants");
    await w.cast.life("ella").runNow();
    const state = await readLifeState(w.storage, "ella");
    const log = JSON.stringify(await readLifeLog(w.storage, "ella", state.epoch));
    // The notification names her handle for the DM, never the raw key with his id.
    expect(log).toContain("- dm · dm/nova · from Nova");
    expect(log).not.toContain(novaKey);
    expect(log).not.toContain("unknown place");
    expect(w.discord.sent).toMatchObject([{ placeKey: novaKey, content: "hi Nova!" }]);
    const results = (await readLifeLog(w.storage, "ella", state.epoch)).flatMap((line) => ((line.message?.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>) ?? []));
    expect(JSON.stringify(results.find((block) => block.tool_use_id === "call_list")?.content)).toContain("dm/nova");
  });

  it("a notification never shows a raw place key for a place that is not hers", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hm")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await enqueueWake(w.storage, "ella", { id: "w-x", reason: "dm", placeKey: "dm_300000000000000098_ella", fromUserId: "300000000000000098", fromName: "Ghost", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    const first = JSON.stringify(w.anthropic.calls[0]!.request.messages);
    expect(first).toContain("dm/someone");
    expect(first).not.toContain("dm_300000000000000098_ella");
  });

  it("a notification carries the message's ref; refs stay in message order through her send (§4.7)", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(toolTurn([{ name: "SendMessage", input: scriptInput.sendMessage("bake-club/#general", [{ text: "right here!", reply_to: "#a1" }]) }]), textTurn("(sent)"))
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    w.discord.post(ROOM, "hi ella");
    const asked = w.discord.post(ROOM, "where did you go");
    await enqueueWake(w.storage, "ella", { id: "w-ref", reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: asked.id, preview: "where did you go", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    expect(JSON.stringify(w.anthropic.calls[0]!.request.messages)).toContain('from Kevin · #a1 \\"where did you go\\"');
    expect(w.discord.sent.at(-1)).toMatchObject({ replyToMessageId: asked.id });
    expect(JSON.stringify(w.anthropic.calls[1]!.request.messages)).toContain(String.raw`{\"sent\":[\"#a2\"]}`);
    const refs = await readConversationRefs(w.storage, ROOM_KEY as never);
    expect(Object.values(refs.refs).sort()).toEqual(["a0", "a1", "a2"]);
  });

  it("a direct wake folded in mid-turn makes the turn direct: the unsent-reply check runs (I1)", async () => {
    let w!: LifeWorld;
    w = await lifeWorld(roots, {
      scripts: [
        () => {
          void mentionWake(w, "w-direct");
          return toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
        },
        () => textTurn("I'd say yes"),
        () => textTurn("never mind")
      ]
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "a reminder: not direct");
    await w.cast.life("ella").runNow();
    const state = await readLifeState(w.storage, "ella");
    const log = await readLifeLog(w.storage, "ella", state.epoch);
    expect(log.some((line) => line.kind === "system_note" && JSON.stringify(line.message).includes(UNSENT_REPLY_NOTE.slice(0, 30)))).toBe(true);
  });

  it("an interrupted turn puts its wakes back in the queue (I4)", async () => {
    const w = await lifeWorld(roots, { scripts: [hangingTurn()] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await mentionWake(w, "w-1");
    const running = w.cast.life("ella").runNow();
    await untilCalls(w, 1);
    w.cast.life("ella").abort("pause");
    await running;
    expect(JSON.stringify((await lastLine(w)).message)).toContain("[system] interrupted");
    expect(await queuedIds(w)).toEqual(["w-1"]);
  });

  it("an aborted compaction changes nothing and takes no wakes (I2)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("first turn")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "first");
    await w.cast.life("ella").runNow();
    const before = await readLifeState(w.storage, "ella");
    const logBefore = await readLifeLog(w.storage, "ella", before.epoch);
    // Over the trigger: the next turn compacts first, and that call hangs until the pause.
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, lastRequestTokens: 10_000_000 }));
    w.anthropic.scripts.splice(0, w.anthropic.scripts.length, hangingTurn());
    await mentionWake(w, "w-2");
    const calls = w.anthropic.calls.length;
    const running = w.cast.life("ella").runNow();
    await untilCalls(w, calls + 1);
    w.cast.life("ella").abort("pause");
    await running;
    const after = await readLifeState(w.storage, "ella");
    expect(after.epoch).toBe(before.epoch);
    expect(after.summary).toBe(before.summary);
    expect(after.compactionPausedUntil).toBeUndefined();
    expect(await readLifeLog(w.storage, "ella", after.epoch)).toEqual(logBefore);
    expect(await queuedIds(w)).toEqual(["w-2"]);
  });

  it("a refusal in the middle of tool calls closes them with error results (M8)", async () => {
    const refusal: ProviderEvent[] = [
      ...toolTurn([{ name: "SendMessage", input: scriptInput.sendMessage("bake-club/#general", [{ text: "x" }]), id: "call_r" }]).filter((event) => event.type !== "done"),
      { type: "done", stopReason: "refusal" } as ProviderEvent
    ];
    const w = await lifeWorld(roots, { scripts: script(refusal) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "x");
    await w.cast.life("ella").runNow();
    const last = await lastLine(w);
    expect(last.kind).toBe("tool_results");
    expect(last.message).toMatchObject({ content: [{ type: "tool_result", tool_use_id: "call_r", content: REFUSED_RESULT, is_error: true }, { type: "text" }] });
    expect(w.discord.sent).toEqual([]);
  });

  it("a provider cooldown keeps her wakes queued; she waits for it to end instead of a follow-up (I6)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let alerts!: ProviderAlerts;
    const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, [() => errorTurn({ code: "rate_limit", status: 429, providerCode: "insufficient_quota", message: "quota exceeded", retryable: false } as never)]);
    const w = await lifeWorld(roots, {
      models: ({ ledger, clock }) => {
        alerts = new ProviderAlerts({ now: () => clock.ms });
        return new ModelClient({ winter: fakeWinter(anthropic, fakeAdapter(CHAT_COMPLETIONS), fakeAdapter(OPENAI_RESPONSES)), credentials: () => "test-key", usageLedger: ledger, providerAlerts: alerts, now: () => clock.ms });
      }
    });
    await mentionWake(w, "w-q");
    await w.cast.life("ella").runNow();
    expect(anthropic.calls).toHaveLength(1);
    expect(await queuedIds(w)).toEqual(["w-q"]);
    expect((await readLifeState(w.storage, "ella")).failedTurn).toBeUndefined();
    // Still cooling: a poke takes nothing and calls nothing.
    await w.cast.life("ella").runNow();
    expect(anthropic.calls).toHaveLength(1);
    expect(await queuedIds(w)).toEqual(["w-q"]);
    expect(alerts.remainingMs("anthropic")).toBeGreaterThan(0);
  });

  it("life.maxConcurrentTurns bounds turns across the host: a second life waits for the slot", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "ella", name: "Ella", botId: "ella-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ],
      config: (config) => ({ ...config, life: { ...config.life, maxConcurrentTurns: 1 } }),
      scripts: [hangingTurn(), () => textTurn("mina here")]
    });
    for (const id of ["ella", "mina"]) {
      vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
      await enqueueWake(w.storage, id, { id: newWakeId(), reason: "reminder", note: "hi", at: w.clock.now().toISOString() });
    }
    const ella = w.cast.life("ella").runNow();
    await untilCalls(w, 1);
    const mina = w.cast.life("mina").runNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.anthropic.calls).toHaveLength(1);
    w.cast.life("ella").abort("pause");
    await Promise.all([ella, mina]);
    expect(w.anthropic.calls).toHaveLength(2);
  });

  it("a life aborted while she waits for a turn slot takes no wake (a forget gets her lock next)", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "ella", name: "Ella", botId: "ella-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ],
      config: (config) => ({ ...config, life: { ...config.life, maxConcurrentTurns: 1 } }),
      scripts: [hangingTurn(), () => textTurn("should not run")]
    });
    for (const id of ["ella", "mina"]) vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
    await enqueueWake(w.storage, "mina", { id: newWakeId(), reason: "reminder", note: "hi", at: w.clock.now().toISOString() });
    await mentionWake(w, "w-ella");
    const mina = w.cast.life("mina").runNow();
    await untilCalls(w, 1);
    // Ella holds her lock and waits for Mina's slot; a forget scrub aborts her meanwhile.
    const ella = w.cast.life("ella").runNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.cast.life("ella").abort("forget");
    // The wait ends at once (N6): Ella is done while Mina's turn still runs, and her lock is free.
    const ellaDone = await Promise.race([ella.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200))]);
    expect(ellaDone).toBe("done");
    expect(await w.cast.mutex.run(lifeLocks.life("ella"), async () => "free")).toBe("free");
    w.cast.life("mina").abort("pause");
    await mina;
    expect(w.anthropic.calls).toHaveLength(1);
    expect(await queuedIds(w)).toEqual(["w-ella"]);
  });

  it("a life waiting for her own lock holds no turn slot (M6)", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "ella", name: "Ella", botId: "ella-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ],
      config: (config) => ({ ...config, life: { ...config.life, maxConcurrentTurns: 1 } }),
      scripts: script(textTurn("ok"))
    });
    for (const id of ["ella", "mina"]) {
      vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
      await enqueueWake(w.storage, id, { id: newWakeId(), reason: "reminder", note: "hi", at: w.clock.now().toISOString() });
    }
    // Her maintenance (or a forget scrub) holds Ella's life lock.
    let release!: () => void;
    const held = w.cast.mutex.run(lifeLocks.life("ella"), () => new Promise<void>((resolve) => (release = resolve)));
    const ella = w.cast.life("ella").runNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.cast.life("mina").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
    release();
    await Promise.all([held, ella]);
    expect(w.anthropic.calls).toHaveLength(2);
  });

  it("a length stop: a cut-off tool call gets an error result and the turn goes on; cut-off text ends the turn", async () => {
    const cutOff: ProviderEvent[] = [
      ...toolTurn([{ name: "SendMessage", input: scriptInput.sendMessage("bake-club/#general", [{ text: "a very long answ" }]), id: "call_cut" }]).filter((event) => event.type !== "done"),
      { type: "done", stopReason: "max_tokens" } as ProviderEvent
    ];
    const textCut: ProviderEvent[] = [...textTurn("I was going to say").filter((event) => event.type !== "done"), { type: "done", stopReason: "max_tokens" } as ProviderEvent];
    const w = await lifeWorld(roots, { scripts: script(cutOff, textCut) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "x");
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(2);
    expect(w.discord.sent).toEqual([]);
    const state = await readLifeState(w.storage, "ella");
    const log = await readLifeLog(w.storage, "ella", state.epoch);
    const results = log.find((line) => line.kind === "tool_results")!;
    expect((results.message as { content: unknown[] }).content[0]).toEqual({ type: "tool_result", tool_use_id: "call_cut", content: CUT_OFF_RESULT, is_error: true });
    expect(log[log.length - 1]!.kind).toBe("assistant");
    expect(state.status).toBe("idle");
  });

  it("a turn past life.maxTurnMs ends with the cap line after its round", async () => {
    let w!: LifeWorld;
    w = await lifeWorld(roots, {
      config: (config) => ({ ...config, life: { ...config.life, maxTurnMs: 30_000 } }),
      scripts: [
        () => {
          w.clock.advance(31_000);
          return toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
        },
        () => textTurn("should not run")
      ]
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "x");
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
    expect(JSON.stringify((await lastLine(w)).message)).toContain("[system] turn ended: max turn time");
  });

  it("a failed turn logs the error, keeps its wakes consumed and follows up once after 60 s", async () => {
    const w = await lifeWorld(roots, {
      scripts: [() => errorTurn({ code: "server_error", status: 500, message: "upstream exploded", retryable: false } as never), () => textTurn("following up")]
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await mentionWake(w, "w-fail");
    await w.cast.life("ella").runNow();
    expect(JSON.stringify((await lastLine(w)).message)).toContain("[system] error:");
    expect(await queuedIds(w)).toEqual([]);
    expect((await readLifeState(w.storage, "ella")).failedTurn).toMatchObject({ followUpDone: false });
    // Not yet due.
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
    w.clock.advance(61_000);
    await w.cast.life("ella").runNow();
    expect(JSON.stringify(w.anthropic.calls[1]!.request.messages)).toContain(FOLLOW_UP_NOTE.slice(0, 30));
    expect((await readLifeState(w.storage, "ella")).failedTurn?.followUpDone).toBe(true);
    // Once.
    w.clock.advance(61_000);
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(2);
  });

  it("a turn stops when her daily budget runs out during it", async () => {
    const w = await lifeWorld(roots, {
      waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", life: { dailyBudgetUsd: 0.0001 } }],
      scripts: [() => toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]), () => textTurn("should not run")]
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await reminder(w, "first");
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
    expect(JSON.stringify((await lastLine(w)).message)).toContain("[system] turn ended: daily budget reached");
  });

  it("wakes queued before her budget ran out wait for the next day; the owner's wake still runs", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", life: { dailyBudgetUsd: 0.5 } }], scripts: script(textTurn("hi owner")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await mentionWake(w, "w-mention");
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${w.clock.now().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ at: w.clock.now().toISOString(), waifuId: "ella", purpose: "life", costUsd: 0.75 })}\n`);
    await w.cast.life("ella").runNow();
    expect(w.anthropic.calls).toEqual([]);
    let queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred).toMatchObject({ reason: "budget", places: { [ROOM_KEY]: { mentions: 1 } } });
    await enqueueWake(w.storage, "ella", { id: "w-owner", reason: "owner", note: "test", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    // Her answer, then the unsent-reply check (the owner's wake is direct and exempt from the budget).
    expect(w.anthropic.calls).toHaveLength(2);
    queue = await readLifeFile(w.storage, "ella", "wakes");
    expect(queue.deferred.reason).toBe("budget");
  });

  it("a failed turn's follow-up is armed again after a restart (M13)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = await lifeWorld(roots, { scripts: script(textTurn("following up")) });
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, failedTurn: { at: w.clock.now().toISOString(), followUpDone: false } }));
    await w.cast.stop();
    const restarted = w.restart();
    await restarted.start();
    w.clock.advance(61_000);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(0);
    await restarted.life("ella").whenIdle();
    const calls = w.anthropic.calls.map((call) => JSON.stringify(call.request.messages));
    expect(calls.some((messages) => messages.includes(FOLLOW_UP_NOTE.slice(0, 30)))).toBe(true);
    expect((await readLifeState(w.storage, "ella")).failedTurn?.followUpDone).toBe(true);
  });
});
