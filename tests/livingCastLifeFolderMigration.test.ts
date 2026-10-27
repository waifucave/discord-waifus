// Steps `living-cast-life-folder-v1`, `living-cast-drop-busy-v1` and `living-cast-bed-time-v1` (Living cast spec §21.6, §21.6c): her
// app-managed files move into `~/life/` (reminders renamed), name collisions keep the newer file and
// archive the other, provenance and journal paths follow, a begun life starts a new epoch, and the
// owner-set busy blocks are archived and dropped, and her sleep window becomes her bed time. Re-running any changes nothing.
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLivingCastBedTime, migrateLivingCastDropBusy, migrateLivingCastLifeFolder } from "../src/backend/migrationSteps/livingCastLifeFolder.js";
import { MIGRATION_STEPS } from "../src/backend/migrations.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const NOW = new Date("2026-10-27T08:00:00.000Z");

async function write(root: string, relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const read = (root: string, relative: string) => readFile(path.join(root, relative), "utf8").catch(() => undefined);

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

const REMINDERS = '[\n  {"id": "r1", "at": "2026-10-28 18:00", "note": "ask Kevin about the exam"}\n]\n';
const WATCHES = '[\n  {"id": "w1", "timeout": "2026-10-28 18:00", "once": true, "note": "tea", "when": []}\n]\n';

async function oldRoot(): Promise<string> {
  const root = await makeTempRoot("dc-waifus-life-folder-");
  roots.push(root);
  const home = "user/waifus/ella/home";
  await write(root, "user/waifus/ella/waifu.json", json({ id: "ella", name: "Ella", availability: { sleep: { enabled: true, start: "00:30", end: "08:30" }, busy: [{ start: "13:00", end: "16:00", reason: "fragrance counter" }] } }));
  await write(root, `${home}/MEMORY.md`, "# Memory\n- [Kevin](people/kevin.md)\n");
  await write(root, `${home}/people/kevin.md`, "# Kevin\n");
  await write(root, `${home}/schedule.json`, REMINDERS);
  await write(root, `${home}/watches.json`, WATCHES);
  await write(root, `${home}/profile.json`, json({ name: "Ella", username: null, bio: null, nicknames: {} }));
  await write(root, `${home}/places.md`, "# Your places\n");
  await write(
    root,
    "user/waifus/ella/life/files-index.json",
    json({ entries: [{ sha256: "a", placeKey: "dm_1_ella", messageId: "1", authorId: "1", attachmentId: "1", downloadedAt: NOW.toISOString(), path: "/home/ella/schedule.json", size: 3 }, { sha256: "b", placeKey: "g_1_2", messageId: "2", authorId: "2", attachmentId: "2", downloadedAt: NOW.toISOString(), path: "/tmp/x.png", size: 4 }] })
  );
  await write(root, "user/waifus/ella/life/pending-changes/call_1.json", json({ writes: [{ path: "/home/ella/watches.json", data: Buffer.from(WATCHES).toString("base64") }, { path: "/home/ella/notes.md", data: "" }], deletes: ["/home/ella/Places.md"], dirs: [] }));
  await write(root, "user/waifus/ella/life/state.json", json({ schemaVersion: 2, revision: 4, updatedAt: NOW.toISOString(), epoch: 3, summary: "s", systemSnapshot: { harnessHash: "h", harness: "x", memoryIndex: "", places: "", tools: ["Read"] } }));
  // A waifu whose life never began, with a file in odd case and no busy key.
  await write(root, "user/waifus/mina/waifu.json", json({ id: "mina", name: "Mina", availability: { sleep: { enabled: false, start: "23:00", end: "07:00" } } }));
  await write(root, "user/waifus/mina/home/Watches.json", "[]\n");
  return root;
}

describe("living-cast-life-folder-v1 (§21.6)", () => {
  it("moves her files into ~/life/ (schedule.json becomes reminders.json); MEMORY.md and notes stay", async () => {
    const root = await oldRoot();
    const outcome = await migrateLivingCastLifeFolder(root, { now: () => NOW });
    expect(outcome).toBe("living-cast-life-folder-5-0-2-1");
    const home = "user/waifus/ella/home";
    expect(await read(root, `${home}/life/reminders.json`)).toBe(REMINDERS);
    expect(await read(root, `${home}/life/watches.json`)).toBe(WATCHES);
    expect(await read(root, `${home}/life/places.md`)).toBe("# Your places\n");
    expect(JSON.parse((await read(root, `${home}/life/profile.json`))!)).toMatchObject({ name: "Ella" });
    for (const old of ["schedule.json", "watches.json", "profile.json", "places.md"]) expect(await read(root, `${home}/${old}`)).toBeUndefined();
    expect(await read(root, `${home}/MEMORY.md`)).toContain("[Kevin]");
    expect(await read(root, `${home}/people/kevin.md`)).toBe("# Kevin\n");
    expect(await read(root, `${home}/life/schedule.json`)).toBeUndefined();
    // Any spelling moves, under its canonical name.
    expect(await read(root, "user/waifus/mina/home/life/watches.json")).toBe("[]\n");
  });

  it("rewrites provenance and journal paths, and starts a new epoch for a begun life only", async () => {
    const root = await oldRoot();
    await migrateLivingCastLifeFolder(root, { now: () => NOW });
    const index = JSON.parse((await read(root, "user/waifus/ella/life/files-index.json"))!) as { entries: Array<{ path: string }> };
    expect(index.entries.map((entry) => entry.path)).toEqual(["/home/ella/life/reminders.json", "/tmp/x.png"]);
    const journal = JSON.parse((await read(root, "user/waifus/ella/life/pending-changes/call_1.json"))!) as { writes: Array<{ path: string }>; deletes: string[] };
    expect(journal.writes.map((write) => write.path)).toEqual(["/home/ella/life/watches.json", "/home/ella/notes.md"]);
    expect(journal.deletes).toEqual(["/home/ella/life/places.md"]);
    const state = JSON.parse((await read(root, "user/waifus/ella/life/state.json"))!) as Record<string, unknown>;
    expect(state).toMatchObject({ pendingEpochStart: true, pendingEpochReason: "tools", revision: 5 });
    expect(await read(root, "user/waifus/mina/life/state.json")).toBeUndefined();
  });

  it("keeps the newer file on a name collision and archives the other", async () => {
    const root = await oldRoot();
    const home = path.join(root, "user/waifus/ella/home");
    await write(root, "user/waifus/ella/home/life/watches.json", "[]\n");
    // Her old file is newer than the one already in life/: it wins, the other is archived.
    await utimes(path.join(home, "life/watches.json"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    await utimes(path.join(home, "watches.json"), NOW, NOW);
    // The old reminders file is older than the one in life/: the newer one stays.
    await write(root, "user/waifus/ella/home/life/reminders.json", "[]\n");
    await utimes(path.join(home, "schedule.json"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    await utimes(path.join(home, "life/reminders.json"), NOW, NOW);
    await migrateLivingCastLifeFolder(root, { now: () => NOW });
    expect(await read(root, "user/waifus/ella/home/life/watches.json")).toBe(WATCHES);
    expect(await read(root, "user/waifus/ella/home/life/reminders.json")).toBe("[]\n");
    expect(await read(root, "user/.archive/living-cast/life-folder/ella/watches.json")).toBe("[]\n");
    expect(await read(root, "user/.archive/living-cast/life-folder/ella/schedule.json")).toBe(REMINDERS);
  });

  it("archives a file called life that stands where her folder goes", async () => {
    const root = await oldRoot();
    await write(root, "user/waifus/ella/home/life", "my life story\n");
    await migrateLivingCastLifeFolder(root, { now: () => NOW });
    expect(await read(root, "user/.archive/living-cast/life-folder/ella/life")).toBe("my life story\n");
    expect(await read(root, "user/waifus/ella/home/life/reminders.json")).toBe(REMINDERS);
  });

  it("is idempotent: a re-run changes no byte", async () => {
    const root = await oldRoot();
    await migrateLivingCastLifeFolder(root, { now: () => NOW });
    const before = await snapshot(root);
    expect(await migrateLivingCastLifeFolder(root, { now: () => new Date("2026-10-28T00:00:00Z") })).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
  });

  it("reports an unreadable state file as incomplete and leaves it alone", async () => {
    const root = await oldRoot();
    await write(root, "user/waifus/ella/life/state.json", "{ torn");
    const outcome = await migrateLivingCastLifeFolder(root, { now: () => NOW });
    expect(outcome).toMatchObject({ incomplete: "1 life file(s) could not be parsed" });
    expect(await read(root, "user/waifus/ella/life/state.json")).toBe("{ torn");
  });
});

describe("living-cast-drop-busy-v1 (§21.6, S3)", () => {
  it("archives her busy blocks, drops them, keeps her sleep, and changes nothing on a re-run", async () => {
    const root = await oldRoot();
    expect(await migrateLivingCastDropBusy(root, { now: () => NOW })).toBe("living-cast-drop-busy-1");
    const waifu = JSON.parse((await read(root, "user/waifus/ella/waifu.json"))!) as { availability: Record<string, unknown> };
    expect(waifu.availability).toEqual({ sleep: { enabled: true, start: "00:30", end: "08:30" } });
    expect(JSON.parse((await read(root, "user/.archive/living-cast/busy/ella.json"))!)).toEqual({
      waifuId: "ella",
      archivedAt: NOW.toISOString(),
      busy: [{ start: "13:00", end: "16:00", reason: "fragrance counter" }]
    });
    expect(await read(root, "user/.archive/living-cast/busy/mina.json")).toBeUndefined();
    const before = await snapshot(root);
    expect(await migrateLivingCastDropBusy(root, { now: () => NOW })).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
  });

  it("never replaces the first archived copy", async () => {
    const root = await oldRoot();
    await write(root, "user/.archive/living-cast/busy/ella.json", json({ waifuId: "ella", busy: ["first"] }));
    await migrateLivingCastDropBusy(root, { now: () => NOW });
    expect(JSON.parse((await read(root, "user/.archive/living-cast/busy/ella.json"))!)).toEqual({ waifuId: "ella", busy: ["first"] });
  });

  it("both steps are registered once, before the schema stamp", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const stamp = ids.findIndex((id) => id.startsWith("stamp-schema-version-"));
    expect(stamp).toBe(ids.length - 1);
    for (const id of ["living-cast-life-folder-v1", "living-cast-drop-busy-v1", "living-cast-bed-time-v1"]) {
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("living-cast-typing-holds-v1"));
      expect(ids.indexOf(id)).toBeLessThan(stamp);
      expect(MIGRATION_STEPS.find((step) => step.id === id)?.frequency).toBe("once");
    }
  });
});

describe("living-cast-bed-time-v1 (§21.6c)", () => {
  it("renames availability.sleep to bedTime after archiving the document, and changes nothing on a re-run", async () => {
    const root = await oldRoot();
    await migrateLivingCastDropBusy(root, { now: () => NOW });
    const original = JSON.parse((await read(root, "user/waifus/ella/waifu.json"))!) as Record<string, unknown>;
    expect(await migrateLivingCastBedTime(root, { now: () => NOW })).toBe("living-cast-bed-time-2");
    const waifu = JSON.parse((await read(root, "user/waifus/ella/waifu.json"))!) as { availability: Record<string, unknown> };
    expect(waifu.availability).toEqual({ bedTime: { enabled: true, start: "00:30", end: "08:30" } });
    expect(JSON.parse((await read(root, "user/.archive/living-cast/bed-time/ella.json"))!)).toEqual({ waifuId: "ella", archivedAt: NOW.toISOString(), waifu: original });
    const before = await snapshot(root);
    expect(await migrateLivingCastBedTime(root, { now: () => NOW })).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
  });

  it("keeps a bedTime that is already there and drops the old key", async () => {
    const root = await oldRoot();
    await write(root, "user/waifus/ella/waifu.json", json({ id: "ella", availability: { sleep: { enabled: true, start: "22:00", end: "06:00" }, bedTime: { enabled: true, start: "01:00", end: "09:00" } } }));
    await migrateLivingCastBedTime(root, { now: () => NOW });
    const waifu = JSON.parse((await read(root, "user/waifus/ella/waifu.json"))!) as { availability: Record<string, unknown> };
    expect(waifu.availability).toEqual({ bedTime: { enabled: true, start: "01:00", end: "09:00" } });
  });

  it("leaves an unparsable waifu file alone and reports itself incomplete", async () => {
    const root = await oldRoot();
    await write(root, "user/waifus/broken/waifu.json", "{ not json");
    const outcome = await migrateLivingCastBedTime(root, { now: () => NOW });
    expect(outcome).toMatchObject({ incomplete: "1 waifu file(s) could not be parsed" });
    expect(await read(root, "user/waifus/broken/waifu.json")).toBe("{ not json");
  });
});
