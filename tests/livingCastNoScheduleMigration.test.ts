// Step `living-cast-no-schedule-v1` (Living cast spec §38): her bed time, `scheduleInPrompt` and the
// sleep notice are archived and dropped from every waifu.json, the day's settings from config.toml,
// her `~/life/schedule.json` is archived, the app's plans record goes, and a begun life gets a pending
// epoch start. Re-running changes nothing; a waifu with nothing to do is left byte-identical.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import { migrateLivingCastNoSchedule, NO_SCHEDULE_STEP_ID } from "../src/backend/migrationSteps/livingCastNoSchedule.js";
import { WAKEUPS_STEP_ID } from "../src/backend/migrationSteps/livingCastWakeups.js";
import { LifeStateSchema } from "../src/shared/schemas/life.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const NOW = new Date("2026-10-31T09:00:00.000Z");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const read = (root: string, relative: string) => readFile(path.join(root, relative), "utf8").catch(() => undefined);

async function write(root: string, relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
}

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

const DAY = json({ date: "2026-10-31", mood: "slow", busy: [{ from: "12:00", to: "15:00", why: "studio shift" }], phoneChecks: ["13:30"], plans: [{ at: "21:00", what: "movie night" }] });
const OLD_STATE = {
  schemaVersion: 2,
  revision: 7,
  updatedAt: "2026-10-30T22:00:00.000Z",
  waifuId: "ella",
  epoch: 4,
  epochStartedAt: "2026-10-30T08:30:00.000Z",
  status: "idle",
  summary: "s",
  systemSnapshot: { harnessHash: "h", harness: "x", memoryIndex: "", places: "", tools: ["Read"] },
  modelRoute: null,
  inlineImageCount: 0,
  inlineImageBytes: 0,
  shownImageKeys: [],
  readMessageIds: [],
  pendingNotices: [],
  deletedReadIds: [],
  scrubbedAt: {},
  lastDayStart: "2026-10-30T08:30:00.000Z",
  dayCompactionDue: true,
  busyOpen: {},
  lastSentAt: "2026-10-30T21:00:00.000Z",
  recentSends: {}
};

/** A 3.8 data root: Ella (her life begun, a day file, a plans record) and Mina (never run, only a bed time). */
async function oldRoot(): Promise<string> {
  const root = await makeTempRoot("dc-waifus-no-schedule-");
  roots.push(root);
  await write(
    root,
    "user/waifus/ella/waifu.json",
    json({ schemaVersion: 2, revision: 3, updatedAt: "2026-10-30T00:00:00.000Z", id: "ella", name: "Ella", displayName: "Ella", persona: "p", availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } }, scheduleInPrompt: false, dm: { allowDms: true, limitNotice: "", sleepNotice: "asleep, back at 9" } })
  );
  await write(root, "user/waifus/ella/home/MEMORY.md", "# Memory\n");
  await write(root, "user/waifus/ella/home/life/schedule.json", DAY);
  await write(root, "user/waifus/ella/home/life/wakeups.json", "[]\n");
  await write(root, "user/waifus/ella/life/plans-fired.json", json({ schemaVersion: 2, revision: 1, updatedAt: NOW.toISOString(), date: "2026-10-31", seen: { "21:00 abc": NOW.toISOString() }, fired: [], skipped: [] }));
  await write(root, "user/waifus/ella/life/state.json", json(OLD_STATE));
  await write(root, "user/waifus/mina/waifu.json", json({ schemaVersion: 2, revision: 1, updatedAt: "2026-10-30T00:00:00.000Z", id: "mina", name: "Mina", displayName: "Mina", persona: "p", availability: { bedTime: { enabled: false, start: "23:00", end: "07:00" } } }));
  await write(
    root,
    "config.toml",
    ["schemaVersion = 2", "", "[life]", "maintenanceHourLocal = 4", "morningLinesPerPlace = 12", "dayStartHourLocal = 9", "busyEngagedMinutes = 20", "bedDozeMinutes = 30", "dreamAfterAsleepMinutes = 5", ""].join("\n")
  );
  return root;
}

describe("living-cast-no-schedule-v1 (§38)", () => {
  it("archives then drops her bed time, scheduleInPrompt and the sleep notice from every waifu.json", async () => {
    const root = await oldRoot();
    expect(await migrateLivingCastNoSchedule(root, { now: () => NOW })).toBe(`${NO_SCHEDULE_STEP_ID}: 2 waifu(s), 1 day file(s), 1 epoch(s), config`);
    const ella = JSON.parse((await read(root, "user/waifus/ella/waifu.json"))!) as Record<string, unknown>;
    expect(ella).not.toHaveProperty("availability");
    expect(ella).not.toHaveProperty("scheduleInPrompt");
    expect(ella.dm).toEqual({ allowDms: true, limitNotice: "" });
    expect(ella).toMatchObject({ id: "ella", revision: 3, persona: "p" });
    expect(WaifuConfigSchema.parse(ella).name).toBe("Ella");
    expect(JSON.parse((await read(root, "user/.archive/living-cast/no-schedule/ella.json"))!)).toEqual({
      waifuId: "ella",
      archivedAt: NOW.toISOString(),
      availability: { bedTime: { enabled: true, start: "00:30", end: "08:30" } },
      scheduleInPrompt: false,
      sleepNotice: "asleep, back at 9"
    });
    expect(JSON.parse((await read(root, "user/.archive/living-cast/no-schedule/mina.json"))!)).toEqual({ waifuId: "mina", archivedAt: NOW.toISOString(), availability: { bedTime: { enabled: false, start: "23:00", end: "07:00" } } });
    expect(JSON.parse((await read(root, "user/waifus/mina/waifu.json"))!)).not.toHaveProperty("availability");
  });

  it("archives her day file, drops the plans record, starts a new epoch for a begun life and writes her marker", async () => {
    const root = await oldRoot();
    await migrateLivingCastNoSchedule(root, { now: () => NOW });
    expect(await read(root, "user/waifus/ella/home/life/schedule.json")).toBeUndefined();
    expect(await read(root, "user/.archive/living-cast/no-schedule/ella/schedule.json")).toBe(DAY);
    expect(await read(root, "user/waifus/ella/home/life/wakeups.json")).toBe("[]\n");
    expect(await read(root, "user/waifus/ella/life/plans-fired.json")).toBeUndefined();
    const state = JSON.parse((await read(root, "user/waifus/ella/life/state.json"))!) as Record<string, unknown>;
    expect(state).toMatchObject({ pendingEpochStart: true, pendingEpochReason: "tools", revision: 8, updatedAt: NOW.toISOString() });
    // The old keys are still on disk until the app writes the state; reading drops them.
    const parsed = LifeStateSchema.parse(state);
    for (const key of ["lastDayStart", "dayCompactionDue", "busyOpen", "lastSentAt"]) expect(parsed).not.toHaveProperty(key);
    expect(JSON.parse((await read(root, "user/waifus/ella/life/no-schedule-v1.json"))!)).toEqual({ version: 1, state: "done" });
    // Mina had nothing of a day and no life: no marker, no state.
    expect(await read(root, "user/waifus/mina/life/no-schedule-v1.json")).toBeUndefined();
    expect(await read(root, "user/waifus/mina/life/state.json")).toBeUndefined();
  });

  it("a pending epoch start already queued (a forget's) keeps its reason", async () => {
    const root = await oldRoot();
    await write(root, "user/waifus/ella/life/state.json", json({ ...OLD_STATE, pendingEpochStart: true, pendingEpochReason: "forget" }));
    await migrateLivingCastNoSchedule(root, { now: () => NOW });
    expect(JSON.parse((await read(root, "user/waifus/ella/life/state.json"))!)).toMatchObject({ pendingEpochStart: true, pendingEpochReason: "forget", revision: 7 });
  });

  it("drops the day's [life] keys from config.toml, archiving the file first", async () => {
    const root = await oldRoot();
    const before = (await read(root, "config.toml"))!;
    await migrateLivingCastNoSchedule(root, { now: () => NOW });
    const after = (await read(root, "config.toml"))!;
    expect(after).toContain("maintenanceHourLocal = 4");
    for (const key of ["morningLinesPerPlace", "dayStartHourLocal", "busyEngagedMinutes", "bedDozeMinutes", "dreamAfterAsleepMinutes"]) expect(after).not.toContain(key);
    expect(await read(root, "user/.archive/living-cast/no-schedule/config.toml")).toBe(before);
  });

  it("is idempotent: a re-run (a lost ledger) changes nothing, also after she writes a ~/life/schedule.json of her own", async () => {
    const root = await oldRoot();
    await migrateLivingCastNoSchedule(root, { now: () => NOW });
    const first = await snapshot(root);
    expect(await migrateLivingCastNoSchedule(root, { now: () => new Date("2026-11-01T00:00:00.000Z") })).toBeUndefined();
    expect(await snapshot(root)).toEqual(first);
    // After the upgrade the file is hers like any other: her marker keeps a re-run away from it.
    await write(root, "user/waifus/ella/home/life/schedule.json", "my own list\n");
    expect(await migrateLivingCastNoSchedule(root)).toBeUndefined();
    expect(await read(root, "user/waifus/ella/home/life/schedule.json")).toBe("my own list\n");
  });

  it("an archived day file never overwrites an earlier copy (schedule-2.json)", async () => {
    const root = await oldRoot();
    await write(root, "user/.archive/living-cast/no-schedule/ella/schedule.json", "older\n");
    await migrateLivingCastNoSchedule(root, { now: () => NOW });
    expect(await read(root, "user/.archive/living-cast/no-schedule/ella/schedule.json")).toBe("older\n");
    expect(await read(root, "user/.archive/living-cast/no-schedule/ella/schedule-2.json")).toBe(DAY);
  });

  it("a root with nothing of the kind stays byte-identical", async () => {
    const root = await makeTempRoot("dc-waifus-no-schedule-clean-");
    roots.push(root);
    await write(root, "user/waifus/ella/waifu.json", json({ id: "ella", name: "Ella", displayName: "Ella", persona: "p", dm: { allowDms: false } }));
    await write(root, "user/waifus/ella/home/MEMORY.md", "# Memory\n");
    await write(root, "config.toml", "schemaVersion = 2\n\n[life]\nmaintenanceHourLocal = 5\n");
    const before = await snapshot(root);
    expect(await migrateLivingCastNoSchedule(root, { now: () => NOW })).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
  });

  it("an unreadable waifu.json or state is reported, and the next boot tries again", async () => {
    const root = await oldRoot();
    await write(root, "user/waifus/mina/waifu.json", "{ not json");
    await write(root, "user/waifus/ella/life/state.json", "{ torn");
    const outcome = await migrateLivingCastNoSchedule(root, { now: () => NOW });
    expect(outcome).toMatchObject({ incomplete: "2 waifu or life state file(s) could not be parsed" });
    // Her day was archived; her marker waits for a readable state.
    expect(await read(root, "user/waifus/ella/home/life/schedule.json")).toBeUndefined();
    expect(await read(root, "user/waifus/ella/life/no-schedule-v1.json")).toBeUndefined();
  });

  it("is a once step registered after the wakeups step and before the schema stamp; the whole boot order runs it", async () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const at = ids.indexOf(NO_SCHEDULE_STEP_ID);
    expect(MIGRATION_STEPS[at]!.frequency).toBe("once");
    expect(at).toBeGreaterThan(ids.indexOf(WAKEUPS_STEP_ID));
    expect(at).toBe(ids.length - 2);
    expect(ids.at(-1)).toMatch(/^stamp-schema-version-/u);
    const root = await oldRoot();
    const result = await runMigrations(root, { appVersion: "3.9.0" });
    expect(result.applied.some((entry) => entry.startsWith(NO_SCHEDULE_STEP_ID))).toBe(true);
    expect(JSON.parse((await read(root, "user/waifus/ella/waifu.json"))!)).not.toHaveProperty("availability");
    expect(await read(root, "user/.archive/living-cast/no-schedule/ella/schedule.json")).toBe(DAY);
  });
});
