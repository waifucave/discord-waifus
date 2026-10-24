// Turn endings (Living cast spec §5.2, §5.6; review I1, I2, I4, I6, M6, M8, M13): what happens to
// her wakes when a turn is capped, interrupted, compacted, refused or blocked by a provider
// cooldown. Scripted winter fakes, temp data root; no live calls.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { FOLLOW_UP_NOTE, REFUSED_RESULT, UNSENT_REPLY_NOTE } from "../src/life/lifeLoop.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { lifeLocks } from "../src/life/paths.js";
import { ModelClient } from "../src/models/client.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { ANTHROPIC_MESSAGES, CHAT_COMPLETIONS, errorTurn, fakeAdapter, fakeWinter, hangingTurn, OPENAI_RESPONSES, textTurn } from "./modelFakes.js";
import { closeWorlds, KEVIN, lifeWorld, ROOM_KEY, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const reminder = (w: LifeWorld, note: string) => enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });
const mentionWake = (w: LifeWorld, id: string) =>
  enqueueWake(w.storage, "aria", { id, reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", messageId: "900000000000000001", preview: "hey", at: w.clock.now().toISOString() });
const queuedIds = async (w: LifeWorld) => (await readLifeFile(w.storage, "aria", "wakes")).immediate.map((wake) => wake.id);
const lastLine = async (w: LifeWorld) => {
  const state = await readLifeState(w.storage, "aria");
  const log = await readLifeLog(w.storage, "aria", state.epoch);
  return log[log.length - 1]!;
};

async function untilCalls(w: LifeWorld, count: number): Promise<void> {
  for (let tries = 0; w.anthropic.calls.length < count && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("turn endings", () => {
  it("a wake arriving in a capped round is never folded in: it stays queued for the next turn (I1)", async () => {
    let w!: LifeWorld;
    w = await lifeWorld(roots, {
      config: (config) => ({ ...config, life: { ...config.life, maxToolRounds: 1 } }),
      scripts: [
        () => {
          void mentionWake(w, "w-late");
          return toolTurn([{ name: "list_places", input: {} }]);
        }
      ]
    });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await reminder(w, "first");
    await w.cast.life("aria").runNow();
    const last = await lastLine(w);
    expect(JSON.stringify(last.message)).toContain("[system] turn ended: max tool rounds");
    expect(JSON.stringify(last.message)).not.toContain("<notifications>");
    expect(await queuedIds(w)).toEqual(["w-late"]);
  });

  it("a direct wake folded in mid-turn makes the turn direct: the unsent-reply check runs (I1)", async () => {
    let w!: LifeWorld;
    w = await lifeWorld(roots, {
      scripts: [
        () => {
          void mentionWake(w, "w-direct");
          return toolTurn([{ name: "list_places", input: {} }]);
        },
        () => textTurn("I'd say yes"),
        () => textTurn("never mind")
      ]
    });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await reminder(w, "a reminder: not direct");
    await w.cast.life("aria").runNow();
    const state = await readLifeState(w.storage, "aria");
    const log = await readLifeLog(w.storage, "aria", state.epoch);
    expect(log.some((line) => line.kind === "system_note" && JSON.stringify(line.message).includes(UNSENT_REPLY_NOTE.slice(0, 30)))).toBe(true);
  });

  it("an interrupted turn puts its wakes back in the queue (I4)", async () => {
    const w = await lifeWorld(roots, { scripts: [hangingTurn()] });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await mentionWake(w, "w-1");
    const running = w.cast.life("aria").runNow();
    await untilCalls(w, 1);
    w.cast.life("aria").abort("pause");
    await running;
    expect(JSON.stringify((await lastLine(w)).message)).toContain("[system] interrupted");
    expect(await queuedIds(w)).toEqual(["w-1"]);
  });

  it("an aborted compaction changes nothing and takes no wakes (I2)", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("first turn")) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await reminder(w, "first");
    await w.cast.life("aria").runNow();
    const before = await readLifeState(w.storage, "aria");
    const logBefore = await readLifeLog(w.storage, "aria", before.epoch);
    // Over the trigger: the next turn compacts first, and that call hangs until the pause.
    await updateLifeState(w.storage, "aria", (state) => ({ ...state, lastRequestTokens: 10_000_000 }));
    w.anthropic.scripts.splice(0, w.anthropic.scripts.length, hangingTurn());
    await mentionWake(w, "w-2");
    const calls = w.anthropic.calls.length;
    const running = w.cast.life("aria").runNow();
    await untilCalls(w, calls + 1);
    w.cast.life("aria").abort("pause");
    await running;
    const after = await readLifeState(w.storage, "aria");
    expect(after.epoch).toBe(before.epoch);
    expect(after.summary).toBe(before.summary);
    expect(after.compactionPausedUntil).toBeUndefined();
    expect(await readLifeLog(w.storage, "aria", after.epoch)).toEqual(logBefore);
    expect(await queuedIds(w)).toEqual(["w-2"]);
  });

  it("a refusal in the middle of tool calls closes them with error results (M8)", async () => {
    const refusal: ProviderEvent[] = [
      ...toolTurn([{ name: "send_message", input: { place: "bake-club/#general", text: "x" }, id: "call_r" }]).filter((event) => event.type !== "done"),
      { type: "done", stopReason: "refusal" } as ProviderEvent
    ];
    const w = await lifeWorld(roots, { scripts: script(refusal) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await reminder(w, "x");
    await w.cast.life("aria").runNow();
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
    await w.cast.life("aria").runNow();
    expect(anthropic.calls).toHaveLength(1);
    expect(await queuedIds(w)).toEqual(["w-q"]);
    expect((await readLifeState(w.storage, "aria")).failedTurn).toBeUndefined();
    // Still cooling: a poke takes nothing and calls nothing.
    await w.cast.life("aria").runNow();
    expect(anthropic.calls).toHaveLength(1);
    expect(await queuedIds(w)).toEqual(["w-q"]);
    expect(alerts.remainingMs("anthropic")).toBeGreaterThan(0);
  });

  it("life.maxConcurrentTurns bounds turns across the host: a second life waits for the slot", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "aria", name: "Aria", botId: "aria-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ],
      config: (config) => ({ ...config, life: { ...config.life, maxConcurrentTurns: 1 } }),
      scripts: [hangingTurn(), () => textTurn("mina here")]
    });
    for (const id of ["aria", "mina"]) {
      vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
      await enqueueWake(w.storage, id, { id: newWakeId(), reason: "reminder", note: "hi", at: w.clock.now().toISOString() });
    }
    const aria = w.cast.life("aria").runNow();
    await untilCalls(w, 1);
    const mina = w.cast.life("mina").runNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.anthropic.calls).toHaveLength(1);
    w.cast.life("aria").abort("pause");
    await Promise.all([aria, mina]);
    expect(w.anthropic.calls).toHaveLength(2);
  });

  it("a life waiting for her own lock holds no turn slot (M6)", async () => {
    const w = await lifeWorld(roots, {
      waifus: [
        { id: "aria", name: "Aria", botId: "aria-bot" },
        { id: "mina", name: "Mina", botId: "mina-bot" }
      ],
      config: (config) => ({ ...config, life: { ...config.life, maxConcurrentTurns: 1 } }),
      scripts: script(textTurn("ok"))
    });
    for (const id of ["aria", "mina"]) {
      vi.spyOn(w.cast.life(id), "poke").mockImplementation(() => undefined);
      await enqueueWake(w.storage, id, { id: newWakeId(), reason: "reminder", note: "hi", at: w.clock.now().toISOString() });
    }
    // Her maintenance (or a forget scrub) holds Aria's life lock.
    let release!: () => void;
    const held = w.cast.mutex.run(lifeLocks.life("aria"), () => new Promise<void>((resolve) => (release = resolve)));
    const aria = w.cast.life("aria").runNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.cast.life("mina").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
    release();
    await Promise.all([held, aria]);
    expect(w.anthropic.calls).toHaveLength(2);
  });

  it("a turn stops when her daily budget runs out during it", async () => {
    const w = await lifeWorld(roots, {
      waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", life: { dailyBudgetUsd: 0.0001 } }],
      scripts: [() => toolTurn([{ name: "list_places", input: {} }]), () => textTurn("should not run")]
    });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await reminder(w, "first");
    await w.cast.life("aria").runNow();
    expect(w.anthropic.calls).toHaveLength(1);
    expect(JSON.stringify((await lastLine(w)).message)).toContain("[system] turn ended: daily budget reached");
  });

  it("wakes queued before her budget ran out wait for the next day; the owner's wake still runs", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", life: { dailyBudgetUsd: 0.5 } }], scripts: script(textTurn("hi owner")) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await mentionWake(w, "w-mention");
    await mkdir(path.join(w.root, "user/usage"), { recursive: true });
    await appendFile(path.join(w.root, "user/usage", `${w.clock.now().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ at: w.clock.now().toISOString(), waifuId: "aria", purpose: "life", costUsd: 0.75 })}\n`);
    await w.cast.life("aria").runNow();
    expect(w.anthropic.calls).toEqual([]);
    let queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.immediate).toEqual([]);
    expect(queue.deferred).toMatchObject({ reason: "budget", places: { [ROOM_KEY]: { mentions: 1 } } });
    await enqueueWake(w.storage, "aria", { id: "w-owner", reason: "owner", note: "test", at: w.clock.now().toISOString() });
    await w.cast.life("aria").runNow();
    // Her answer, then the unsent-reply check (the owner's wake is direct and exempt from the budget).
    expect(w.anthropic.calls).toHaveLength(2);
    queue = await readLifeFile(w.storage, "aria", "wakes");
    expect(queue.deferred.reason).toBe("budget");
  });

  it("a failed turn's follow-up is armed again after a restart (M13)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = await lifeWorld(roots, { scripts: script(textTurn("following up")) });
    await updateLifeState(w.storage, "aria", (state) => ({ ...state, failedTurn: { at: w.clock.now().toISOString(), followUpDone: false } }));
    await w.cast.stop();
    const restarted = w.restart();
    await restarted.start();
    w.clock.advance(61_000);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(0);
    await restarted.life("aria").whenIdle();
    const calls = w.anthropic.calls.map((call) => JSON.stringify(call.request.messages));
    expect(calls.some((messages) => messages.includes(FOLLOW_UP_NOTE.slice(0, 30)))).toBe(true);
    expect((await readLifeState(w.storage, "aria")).failedTurn?.followUpDone).toBe(true);
  });
});
