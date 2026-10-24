// The host around the lives (Living cast spec §3, §6.6, §7.3; review I7, M3, M4, M5): busy work is
// visible to the idle updater and `/api/runtime`, maintenance runs in the background without
// blocking the scheduler, reminders survive a crash between routing and removal, and nothing is
// rewritten when nothing changed. Scripted winter fakes, temp data root; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, readLifeState, updateLifeFile } from "../src/life/lifeStore.js";
import { reminderWakeId } from "../src/life/scheduler.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { hangingTurn, textTurn } from "./modelFakes.js";
import { closeWorlds, lifeWorld, script, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const reminder = (w: LifeWorld, note: string) => enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });

describe("busy work is visible (I7)", () => {
  it("each turn cycle holds an update-activity lease and is counted in the active runs", async () => {
    const leases: string[] = [];
    const active: number[] = [];
    const w = await lifeWorld(roots, {
      scripts: script(textTurn("noted")),
      options: {
        updateActivity: {
          begin: () => {
            leases.push("begin");
            return () => leases.push("release");
          }
        },
        onActiveRunsChange: (count) => active.push(count)
      }
    });
    await reminder(w, "water the plants");
    await w.cast.life("aria").runNow();
    expect(leases).toEqual(["begin", "release"]);
    expect(active).toEqual([1, 0]);
  });

  it("a sealed app (an update restart is coming) starts no turn: her wakes wait", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("noted")), options: { updateActivity: { begin: () => undefined } } });
    await reminder(w, "later");
    await w.cast.life("aria").runNow();
    expect(w.anthropic.calls).toEqual([]);
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toHaveLength(1);
  });
});

describe("maintenance in the background (M3)", () => {
  it("never blocks the scheduler tick; stop() aborts it and waits; it is not recorded as done", async () => {
    const w = await lifeWorld(roots, { scripts: [hangingTurn()] });
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({
      ...file,
      reminders: [{ id: "r1", note: "call mom", dueAt: new Date(w.clock.ms - 1_000).toISOString(), createdAt: w.clock.now().toISOString() }]
    }));
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    // 14:00 is past the 05:00 maintenance hour: it starts and hangs on its model call.
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    for (let tries = 0; w.anthropic.calls.length === 0 && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(w.anthropic.calls).toHaveLength(1);
    // The same tick fired her reminder.
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate.map((wake) => wake.reason)).toEqual(["reminder"]);
    // A second cast (a reload) does not start another maintenance for her while this one runs.
    const second = w.restart();
    await second.scheduler.tick({ waitForMaintenance: false });
    expect(w.anthropic.calls).toHaveLength(1);
    await w.cast.stop();
    expect((await readLifeState(w.storage, "aria")).lastMaintenanceAt).toBeUndefined();
  });
});

describe("reminders (M4) and quiet writes (M5)", () => {
  it("a reminder is routed before it is removed, under one wake id per occurrence", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const due = { id: "r1", note: "call mom", dueAt: new Date(w.clock.ms - 1_000).toISOString(), createdAt: w.clock.now().toISOString() };
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({ ...file, reminders: [due] }));
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    // A crash before the removal: the reminder is back, the next tick routes the same wake again.
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({ ...file, reminders: [due] }));
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    const wakes = (await readLifeFile(w.storage, "aria", "wakes")).immediate;
    expect(wakes.map((wake) => wake.id)).toEqual([reminderWakeId(due)]);
    expect((await readLifeFile(w.storage, "aria", "schedule")).reminders).toEqual([]);
  });

  it("a tick or a message that changes nothing rewrites nothing (no new revision)", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({
      ...file,
      reminders: [{ id: "r1", note: "later", dueAt: new Date(w.clock.ms + 3_600_000).toISOString(), createdAt: w.clock.now().toISOString() }]
    }));
    await updateLifeFile(w.storage, "aria", "watches", (file) => ({ ...file }));
    const schedule = await readLifeFile(w.storage, "aria", "schedule");
    const watches = await readLifeFile(w.storage, "aria", "watches");
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    await w.cast.scheduler.tick({ waitForMaintenance: false });
    expect((await readLifeFile(w.storage, "aria", "schedule")).revision).toBe(schedule.revision);
    expect((await readLifeFile(w.storage, "aria", "watches")).revision).toBe(watches.revision);
  });
});
