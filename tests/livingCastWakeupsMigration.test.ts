// Step `living-cast-wakeups-v1` (Living cast spec §30.3): her reminders.json and watches.json become
// ~/life/wakeups.json (every reminder and watch shape; ids r4 → t4, w3 stays), the side files follow
// (counters, resolved names, fires, the occurrences already routed under their new names), the old
// files are archived, a life on the retired tools gets a pending epoch start, and the per-waifu
// marker makes a re-run (lost ledger) change nothing and a crash resume where it stopped.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLivingCastWakeups, WAKEUPS_STEP_ID, type WakeupsCrash } from "../src/backend/migrationSteps/livingCastWakeups.js";
import { SEND_CAP_STEP_ID } from "../src/backend/migrationSteps/livingCastSendCap.js";
import { MIGRATION_STEPS } from "../src/backend/migrations.js";
import { checkWakeupsText } from "../src/life/wakeups/file.js";
import { WakeupSideSchema } from "../src/shared/schemas/life.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const NOW = new Date("2026-10-27T08:00:00.000Z"); // a Tuesday
const TZ = "UTC";
const migrate = (root: string, crashAfter?: WakeupsCrash) => migrateLivingCastWakeups(root, { now: () => NOW, timeZone: TZ, ...(crashAfter ? { crashAfter } : {}) });

async function write(root: string, relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const read = (root: string, relative: string) => readFile(path.join(root, relative), "utf8").catch(() => undefined);
const readJson = async (root: string, relative: string) => JSON.parse((await read(root, relative))!) as Record<string, unknown>;

async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(path.relative(root, full), await readFile(full, "utf8"));
    }
  };
  await walk(root);
  return out;
}

const ELLA = "user/waifus/ella";
const REMINDERS = json([
  { id: "r4", at: "2026-10-28 18:00", note: "ask Kevin about the exam" },
  { id: "r5", at: "2026-10-28 09:00", repeat: "daily", note: "water the plants" },
  { id: "r6", at: "2026-10-30 18:30", repeat: "weekly", note: "friday bake club" },
  // Written by hand while the app was down: no id yet.
  { at: "2026-10-29 12:00", note: "lunch" }
]);
const WATCHES = json([
  { id: "w3", timeout: "2026-10-28 18:00", once: true, note: "tea", when: [] },
  { id: "w4", timeout: "2026-10-28 18:00", once: true, note: "brownie tips", when: [{ place: "bake-club/#general", from: "Mina", words: ["brownie"] }] },
  { id: "w5", timeout: "2026-10-29 18:00", once: false, note: "Kevin's news", when: [{ place: "dm/kevin", any_message: true }] },
  { id: "w6", timeout: "2026-10-29 18:00", once: true, note: "exam talk", when: [{ place: "bake-club/#general", words: ["exam"] }, { place: "bake-club/#random", any_message: true }] },
  { id: "w7", timeout: "2026-10-29 18:00", once: true, note: "cake", when: [{ from: "Kevin" }, { place: "bake-club/#general", words: ["cake"] }] }
]);
const SCHEDULE_IDS = json({ nextId: 7, fired: ["w-reminder-r4-abc", "w-reminder-r44-xyz"] });
const WATCH_IDS = json({
  nextId: 8,
  sourceHash: "x",
  watches: {
    w4: { bindings: [{ placeKey: "g_1_2", fromUserId: "300", fromName: "Mina", words: ["brownie"] }], fires: ["2026-10-27T07:00:00.000Z"] },
    w5: { bindings: [{ placeKey: "dm_301_ella", anyMessage: true }], fires: [] }
  },
  fired: ["once-w3-2026-10-28 18:00", "w-timeout-w3-zzz"]
});
const STATE = json({ schemaVersion: 2, revision: 4, updatedAt: NOW.toISOString(), epoch: 3, summary: "s", systemSnapshot: { harnessHash: "h", harness: "x", memoryIndex: "", places: "", tools: ["Read", "WatchFor", "ScheduleWake"] } });

async function oldRoot(): Promise<string> {
  const root = await makeTempRoot("dc-waifus-wakeups-");
  roots.push(root);
  await write(root, `${ELLA}/waifu.json`, json({ id: "ella", name: "Ella" }));
  await write(root, `${ELLA}/home/MEMORY.md`, "# Memory\n");
  await write(root, `${ELLA}/home/life/reminders.json`, REMINDERS);
  await write(root, `${ELLA}/home/life/watches.json`, WATCHES);
  await write(root, `${ELLA}/life/schedule-ids.json`, SCHEDULE_IDS);
  await write(root, `${ELLA}/life/watch-ids.json`, WATCH_IDS);
  await write(root, `${ELLA}/life/state.json`, STATE);
  // A waifu whose life never began, with her reminders in odd case.
  await write(root, "user/waifus/mina/waifu.json", json({ id: "mina", name: "Mina" }));
  await write(root, "user/waifus/mina/home/life/Reminders.json", json([{ id: "r1", at: "2026-10-28 10:00", note: "bake" }]));
  // One with nothing to convert.
  await write(root, "user/waifus/nora/waifu.json", json({ id: "nora", name: "Nora" }));
  await write(root, "user/waifus/nora/home/life/profile.json", json({ name: "Nora" }));
  return root;
}

describe("living-cast-wakeups-v1 (§30.3)", () => {
  it("turns every reminder and watch shape into wakeups; ids r4 → t4, w3 stays; side files follow", async () => {
    const root = await oldRoot();
    expect(await migrate(root)).toBe("living-cast-wakeups-2-5-1");
    const text = (await read(root, `${ELLA}/home/life/wakeups.json`))!;
    expect(JSON.parse(text)).toEqual([
      { id: "t4", kind: "at", when: "2026-10-28 18:00", note: "ask Kevin about the exam" },
      { id: "t5", kind: "every", when: "day 09:00", note: "water the plants" },
      { id: "t6", kind: "every", when: "fri 18:30", note: "friday bake club" },
      { id: "t7", kind: "at", when: "2026-10-29 12:00", note: "lunch" },
      { id: "w3", kind: "watch", places: "everywhere", filter: [], options: { until: "2026-10-28 18:00", once: true }, note: "tea" },
      { id: "w4", kind: "watch", places: "bake-club/#general", filter: { from: "Mina", words: ["brownie"] }, options: { until: "2026-10-28 18:00", once: true }, note: "brownie tips" },
      { id: "w5", kind: "watch", places: "dm/kevin", filter: { any: true }, options: { until: "2026-10-29 18:00", once: false }, note: "Kevin's news" },
      {
        id: "w6",
        kind: "watch",
        places: ["bake-club/#general", "bake-club/#random"],
        filter: [{ place: "bake-club/#general", words: ["exam"] }, { place: "bake-club/#random", any: true }],
        options: { until: "2026-10-29 18:00", once: true },
        note: "exam talk"
      },
      { id: "w7", kind: "watch", places: "everywhere", filter: [{ from: "Kevin" }, { place: "bake-club/#general", words: ["cake"] }], options: { until: "2026-10-29 18:00", once: true }, note: "cake" }
    ]);
    // One entry per line, like the app writes it.
    expect(text.trim().split("\n")).toHaveLength(11);
    // The converted file passes her file's own checks as it stands (no new ids, nothing rewritten).
    const checked = await checkWakeupsText(text, {
      now: NOW,
      timeZone: TZ,
      previous: [],
      side: WakeupSideSchema.parse({}),
      resolvePlace: async (handle) => `key:${handle}`,
      resolvePerson: async (name) => ({ ok: true, userId: "300", name }),
      compile: async () => []
    });
    expect(checked).toMatchObject({ ok: true, rewritten: false });

    const side = await readJson(root, `${ELLA}/life/wakeup-ids.json`);
    expect(side["nextId"]).toEqual({ t: 8, w: 8, p: 1 });
    // An every counts from just before its saved time: due when the host is back, it still fires.
    expect(side["every"]).toEqual({ t5: { when: "day 09:00", since: "2026-10-28T08:59:00.000Z" }, t6: { when: "fri 18:30", since: "2026-10-30T18:29:00.000Z" } });
    expect(side["watches"]).toEqual({
      w3: { filters: [], fires: [] },
      w4: { placeKeys: ["g_1_2"], filters: [{ placeKey: "g_1_2", fromUserId: "300", fromName: "Mina", words: ["brownie"] }], fires: ["2026-10-27T07:00:00.000Z"] },
      w5: { placeKeys: ["dm_301_ella"], filters: [{ placeKey: "dm_301_ella", anyMessage: true }], fires: [] },
      w6: { filters: [], fires: [] },
      w7: { filters: [], fires: [] }
    });
    // w6 and w7 had no resolution saved: no source hash, so the app resolves the file again.
    expect(side["sourceHash"]).toBe("");
    // Routed occurrences keep their wake ids under the new names (r44 is not r4).
    expect(side["fired"]).toEqual(["w-reminder-t4-abc", "w-reminder-r44-xyz", "once-w3-2026-10-28 18:00", "w-timeout-w3-zzz"]);

    // The old files and side files are archived; her marker says done.
    for (const name of ["reminders.json", "watches.json"]) expect(await read(root, `${ELLA}/home/life/${name}`)).toBeUndefined();
    for (const name of ["schedule-ids.json", "watch-ids.json"]) expect(await read(root, `${ELLA}/life/${name}`)).toBeUndefined();
    const archive = "user/.archive/living-cast/wakeups/ella";
    expect(await read(root, `${archive}/reminders.json`)).toBe(REMINDERS);
    expect(await read(root, `${archive}/watches.json`)).toBe(WATCHES);
    expect(await read(root, `${archive}/schedule-ids.json`)).toBe(SCHEDULE_IDS);
    expect(await read(root, `${archive}/watch-ids.json`)).toBe(WATCH_IDS);
    expect(await readJson(root, `${ELLA}/life/wakeups-v1.json`)).toEqual({ version: 1, state: "done" });

    // Her life offered the retired tools: a pending epoch start (summarised, no kept turns).
    expect(await readJson(root, `${ELLA}/life/state.json`)).toMatchObject({ revision: 5, pendingEpochStart: true, pendingEpochReason: "tools" });

    // A file in odd case is hers all the same; a life that never began gets no epoch.
    expect(JSON.parse((await read(root, "user/waifus/mina/home/life/wakeups.json"))!)).toEqual([{ id: "t1", kind: "at", when: "2026-10-28 10:00", note: "bake" }]);
    expect(await read(root, "user/.archive/living-cast/wakeups/mina/Reminders.json")).toContain("bake");
    expect(await read(root, "user/waifus/mina/life/state.json")).toBeUndefined();
    expect((await readJson(root, "user/waifus/mina/life/wakeup-ids.json"))["sourceHash"]).toBe(createHash("sha256").update((await read(root, "user/waifus/mina/home/life/wakeups.json"))!, "utf8").digest("hex"));
    // Nothing to convert: no marker, nothing written.
    expect(await read(root, "user/waifus/nora/life/wakeups-v1.json")).toBeUndefined();
    expect(await read(root, "user/waifus/nora/home/life/wakeups.json")).toBeUndefined();
  });

  it("re-running changes nothing, and a reminders.json she writes later is an ordinary file", async () => {
    const root = await oldRoot();
    await migrate(root);
    await write(root, `${ELLA}/home/life/reminders.json`, "my own list\n");
    const before = await snapshot(root);
    expect(await migrate(root)).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
  });

  it("a root without old files stays byte-identical", async () => {
    const root = await makeTempRoot("dc-waifus-wakeups-");
    roots.push(root);
    await write(root, "user/waifus/ella/waifu.json", json({ id: "ella", name: "Ella" }));
    await write(root, "user/waifus/ella/life/state.json", json({ schemaVersion: 2, revision: 1, epoch: 1, systemSnapshot: { tools: ["Read", "Wakeup"] } }));
    const before = await snapshot(root);
    expect(await migrate(root)).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
  });

  it("a crash after any part resumes where it stopped, ending like an uninterrupted run", async () => {
    const clean = await oldRoot();
    await migrate(clean);
    const expected = new Map([...(await snapshot(clean))].map(([name, text]) => [name, text] as const));
    for (const crash of ["start", "written", "convert", "archive", "epoch"] as const) {
      const root = await oldRoot();
      await expect(migrate(root, crash)).rejects.toThrow(`crash after ${crash}`);
      await migrate(root);
      const got = await snapshot(root);
      expect([...got.keys()].sort(), crash).toEqual([...expected.keys()].sort());
      for (const [name, text] of expected) {
        // The other waifus' runs never happened on the crashed pass; their files match all the same.
        expect(got.get(name), `${crash}: ${name}`).toBe(text);
      }
    }
  }, 30_000);

  it("an epoch start already pending is left as it is", async () => {
    const root = await oldRoot();
    await write(root, `${ELLA}/life/state.json`, json({ ...JSON.parse(STATE), pendingEpochStart: true, pendingEpochReason: "config" }));
    await migrate(root);
    expect(await readJson(root, `${ELLA}/life/state.json`)).toMatchObject({ revision: 4, pendingEpochStart: true, pendingEpochReason: "config" });
  });

  it("a file that does not read whole is left alone and the step stays incomplete until it does", async () => {
    const root = await oldRoot();
    await write(root, `${ELLA}/home/life/watches.json`, '[{"id": "w1",]');
    const outcome = await migrate(root);
    expect(outcome).toMatchObject({ incomplete: "1 reminder or watch file(s) could not be parsed" });
    expect(await read(root, `${ELLA}/home/life/watches.json`)).toBe('[{"id": "w1",]');
    expect(await read(root, `${ELLA}/home/life/reminders.json`)).toBe(REMINDERS);
    expect(await read(root, `${ELLA}/home/life/wakeups.json`)).toBeUndefined();
    await write(root, `${ELLA}/home/life/watches.json`, "[]\n");
    expect(await migrate(root)).toMatch(/^living-cast-wakeups-1-/u);
    expect(JSON.parse((await read(root, `${ELLA}/home/life/wakeups.json`))!).map((entry: { id: string }) => entry.id)).toEqual(["t4", "t5", "t6", "t7"]);
  });

  it("is a once step registered after the send cap and before the schema stamp", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const at = ids.indexOf(WAKEUPS_STEP_ID);
    expect(MIGRATION_STEPS[at]!.frequency).toBe("once");
    expect(at).toBeGreaterThan(ids.indexOf(SEND_CAP_STEP_ID));
    expect(at).toBeLessThan(ids.length - 1);
    expect(ids.at(-1)).toMatch(/^stamp-schema-version-/u);
  });
});
