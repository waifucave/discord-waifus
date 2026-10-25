// Step `living-cast-home-v1` (Living cast spec §16.13): a development host's L2-era life layout —
// `notes/`, the app-kept `life/schedule.json` and `life/watches.json`, and a life on the L2 tools —
// becomes her home folder and files, and a new epoch is pending. Re-running it changes nothing.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLivingCastHome } from "../src/backend/migrationSteps/livingCastHome.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const NOW = new Date("2026-10-24T14:00:00.000Z");
const KEVIN = "300000000000000003";

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
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

async function l2Root(): Promise<string> {
  const root = await makeTempRoot("dc-waifus-home-mig-");
  roots.push(root);
  await writeJson(root, "user/waifus/aria/waifu.json", { id: "aria", name: "Aria" });
  await mkdir(path.join(root, "user/waifus/aria/notes/people"), { recursive: true });
  await writeFile(path.join(root, "user/waifus/aria/notes/MEMORY.md"), "# Memory\n- [Kevin](people/kevin.md)\n");
  await writeFile(path.join(root, "user/waifus/aria/notes/people/kevin.md"), "# Kevin\n");
  await writeJson(root, "user/waifus/aria/life/schedule.json", {
    schemaVersion: 2,
    revision: 3,
    updatedAt: NOW.toISOString(),
    nextId: 4,
    reminders: [
      { id: "r2", note: "check the flyer", dueAt: "2026-10-24T18:00:00.000Z", repeat: "daily", createdAt: NOW.toISOString() },
      { id: "r3", note: "late one", dueAt: "2026-10-24T13:00:00.000Z", createdAt: NOW.toISOString() }
    ]
  });
  await writeJson(root, "user/waifus/aria/life/handles.json", { schemaVersion: 2, revision: 1, updatedAt: NOW.toISOString(), handles: { "bake-club/#general": "g_1_2", "dm/kevin": `dm_${KEVIN}_aria` }, primary: { g_1_2: "bake-club/#general", [`dm_${KEVIN}_aria`]: "dm/kevin" } });
  await writeJson(root, "user/waifus/aria/life/watches.json", {
    schemaVersion: 2,
    revision: 2,
    updatedAt: NOW.toISOString(),
    nextId: 6,
    watches: [
      { id: "w1", note: "brownies", createdAt: NOW.toISOString(), expiresAt: "2026-10-25T10:00:00.000Z", once: true, bindings: [{ placeKey: "g_1_2", words: ["brownie"] }], fires: [] },
      { id: "w4", note: "his answer", createdAt: NOW.toISOString(), expiresAt: "2026-10-24T20:00:00.000Z", once: false, bindings: [{ fromUserId: KEVIN, fromName: "Kevin" }, { placeKey: `dm_${KEVIN}_aria`, anyMessage: true }], fires: ["2026-10-24T13:30:00.000Z"] },
      { id: "w5", note: "expired", createdAt: NOW.toISOString(), expiresAt: "2026-10-24T09:00:00.000Z", once: true, bindings: [{ anyMessage: true }], fires: [] },
      { id: "w2", note: "a room that is gone", createdAt: NOW.toISOString(), expiresAt: "2026-10-25T09:00:00.000Z", once: true, bindings: [{ placeKey: "g_9_9", anyMessage: true }], fires: [] }
    ]
  });
  await writeJson(root, "user/waifus/aria/life/state.json", { schemaVersion: 2, revision: 7, updatedAt: NOW.toISOString(), epoch: 3, summary: "s", systemSnapshot: { harnessHash: "h", harness: "x", memoryIndex: "", places: "", tools: ["read_messages", "send_message", "write_note"] } });
  return root;
}

describe("living-cast-home-v1 (§16.13)", () => {
  it("moves notes to home, turns her reminders and watches into her files with local times and names, and starts a new epoch", async () => {
    const root = await l2Root();
    const outcome = await migrateLivingCastHome(root, { now: () => NOW, timeZone: "UTC" });
    expect(outcome).toBe("living-cast-home-1-1-1-1");
    const files = await snapshot(root);
    expect(files.get("user/waifus/aria/home/MEMORY.md")).toBe("# Memory\n- [Kevin](people/kevin.md)\n");
    expect(files.get("user/waifus/aria/home/people/kevin.md")).toBe("# Kevin\n");
    expect([...files.keys()].some((name) => name.startsWith("user/waifus/aria/notes/"))).toBe(false);
    expect(JSON.parse(files.get("user/waifus/aria/home/schedule.json")!)).toEqual([
      { id: "r2", at: "2026-10-24 18:00", repeat: "daily", note: "check the flyer" },
      { id: "r3", at: "2026-10-24 13:00", note: "late one" }
    ]);
    expect(JSON.parse(files.get("user/waifus/aria/life/schedule-ids.json")!)).toEqual({ nextId: 4, fired: [] });
    expect(JSON.parse(files.get("user/waifus/aria/home/watches.json")!)).toEqual([
      { id: "w1", timeout: "2026-10-25 10:00", once: true, note: "brownies", when: [{ place: "bake-club/#general", words: ["brownie"] }] },
      { id: "w4", timeout: "2026-10-24 20:00", once: false, note: "his answer", when: [{ from: "Kevin" }, { place: "dm/kevin", any_message: true }] }
    ]);
    const ids = JSON.parse(files.get("user/waifus/aria/life/watch-ids.json")!) as { nextId: number; watches: Record<string, { bindings: unknown[]; fires: string[] }> };
    expect(ids.nextId).toBe(6);
    expect(Object.keys(ids.watches)).toEqual(["w1", "w4"]);
    expect(ids.watches["w4"]).toEqual({ bindings: [{ fromUserId: KEVIN, fromName: "Kevin" }, { placeKey: `dm_${KEVIN}_aria`, anyMessage: true }], fires: ["2026-10-24T13:30:00.000Z"] });
    // The originals are archived, not in her life folder any more.
    expect(files.has("user/waifus/aria/life/schedule.json")).toBe(false);
    expect(files.has("user/waifus/aria/life/watches.json")).toBe(false);
    expect(files.has("user/.archive/living-cast/life/aria/watches.json")).toBe(true);
    const state = JSON.parse(files.get("user/waifus/aria/life/state.json")!) as Record<string, unknown>;
    expect(state).toMatchObject({ pendingEpochStart: true, pendingEpochReason: "reset", revision: 8, epoch: 3, summary: "s" });
    // Re-running changes nothing.
    expect(await migrateLivingCastHome(root, { now: () => new Date(NOW.getTime() + 3_600_000), timeZone: "UTC" })).toBeUndefined();
    expect(await snapshot(root)).toEqual(files);
  });

  it("a root without any L2-era data is left byte-identical; an unreadable file makes the step incomplete", async () => {
    const root = await makeTempRoot("dc-waifus-home-mig-");
    roots.push(root);
    await writeJson(root, "user/waifus/aria/waifu.json", { id: "aria", name: "Aria" });
    await mkdir(path.join(root, "user/waifus/aria/home"), { recursive: true });
    await writeFile(path.join(root, "user/waifus/aria/home/MEMORY.md"), "# Memory\n");
    const before = await snapshot(root);
    expect(await migrateLivingCastHome(root, { now: () => NOW, timeZone: "UTC" })).toBeUndefined();
    expect(await snapshot(root)).toEqual(before);
    await mkdir(path.join(root, "user/waifus/aria/life"), { recursive: true });
    await writeFile(path.join(root, "user/waifus/aria/life/watches.json"), "{ torn");
    expect(await migrateLivingCastHome(root, { now: () => NOW, timeZone: "UTC" })).toEqual({ incomplete: "1 L2-era life file(s) could not be parsed" });
    expect(await readFile(path.join(root, "user/waifus/aria/life/watches.json"), "utf8")).toBe("{ torn");
  });
});
