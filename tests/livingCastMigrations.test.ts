// The Living cast L2 data migrations (spec §7.4, §11.2) on a realistic main-era data root: the
// memory store becomes notes (forgotten people left out), the director's data is archived, an
// in-flight DM becomes a wake, and server files and config.toml lose the retired settings. Re-running
// every step, with or without the ledger, leaves the data root byte-identical.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/backend/migrations.js";
import { migrateLivingCastMemoriesToNotes, notesForWaifu } from "../src/backend/migrationSteps/livingCastMemoriesToNotes.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { AppConfigSchema } from "../src/shared/schemas/config.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import { DmStateSchema } from "../src/shared/schemas/dm.js";
import { WakeQueueSchema } from "../src/shared/schemas/life.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const T = "2026-10-01T12:00:00.000Z";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const APP_VERSION = "3.0.0";
const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const KEVIN = "300000000000000003";
const KEVIN_2 = "300000000000009999";
const MINA = "300000000000000004";
const FORGOTTEN = "300000000000000005";
const SCRUBBED = "300000000000000006";

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = Record<string, unknown>>(root: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as T;
}

async function exists(root: string, relativePath: string): Promise<boolean> {
  return readFile(path.join(root, relativePath)).then(() => true, () => readdir(path.join(root, relativePath)).then(() => true, () => false));
}

const memory = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  waifuId: "aria",
  content: `memory ${id}`,
  kind: "fact",
  source: "stage_manager",
  pinned: false,
  strength: 3,
  origin: { guildId: GUILD, channelId: CHANNEL },
  subjects: [],
  revision: 0,
  createdAt: T,
  updatedAt: T,
  status: "active",
  ...o
});

/** A main-era data root (Phase 5 shapes) with something for every L2 data step. */
async function mainEraRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  for (const [id, name] of [["aria", "Aria"], ["mina", "Mina"], ["noted", "Noted"]]) {
    await writeJson(root, `user/waifus/${id}/waifu.json`, { schemaVersion: 2, revision: 1, updatedAt: T, id, name, displayName: name, persona: "kind" });
  }
  // A waifu that already has notes keeps them untouched.
  await mkdir(path.join(root, "user/waifus/noted/notes"), { recursive: true });
  await writeFile(path.join(root, "user/waifus/noted/notes/MEMORY.md"), "# Memory\n- hand written\n");

  await writeJson(root, "user/memories.json", {
    schemaVersion: 2,
    revision: 7,
    updatedAt: T,
    memories: [
      memory("k1", { content: "Kevin studies chemistry.", strength: 4, subjects: [{ discordUserId: KEVIN, name: "Kevin" }], updatedAt: "2026-10-02T00:00:00.000Z" }),
      memory("k2", { content: "Kevin is allergic to peanuts.", pinned: true, strength: 2, subjects: [{ discordUserId: KEVIN, name: "Kev" }] }),
      memory("k3", { content: "Kevin and Mina run the bake sale.", subjects: [{ discordUserId: KEVIN, name: "Kevin" }, { discordUserId: MINA, name: "Mina" }] }),
      memory("k4", { content: "The other Kevin likes jazz.", subjects: [{ discordUserId: KEVIN_2, name: "Kevin" }] }),
      memory("dm1", { content: "Mina is nervous about her exam.", origin: { dm: true, userId: MINA }, subjects: [{ discordUserId: MINA, name: "Mina" }] }),
      memory("dm2", { content: "Wants to learn baking.", origin: { dm: true, userId: MINA } }),
      memory("me1", { content: "I prefer lemon tarts.", subjects: [{ waifuId: "aria", name: "Aria" }] }),
      memory("misc1", { content: "The bake sale is on Saturday.", strength: 5 }),
      memory("gone1", { content: "Old news.", status: "archived", archivedReason: "user" }),
      memory("exp1", { content: "Short-lived.", expiresAt: "2026-10-05T00:00:00.000Z" }),
      memory("f1", { content: "Forgotten person's secret.", subjects: [{ discordUserId: FORGOTTEN, name: "Zed" }] }),
      memory("f2", { content: "Said in a forgotten DM.", origin: { dm: true, userId: FORGOTTEN } }),
      memory("s1", { content: "Scrubbed user's hobby.", subjects: [{ discordUserId: SCRUBBED, name: "Sam" }] }),
      memory("s2", { waifuId: "mina", content: "Mina's view of Sam.", subjects: [{ discordUserId: SCRUBBED, name: "Sam" }] }),
      memory("n1", { waifuId: "noted", content: "Never migrated.", subjects: [] })
    ]
  });
  await writeJson(root, "user/memory/pending-observations.json", { schemaVersion: 2, revision: 1, updatedAt: T, observations: [] });
  await writeJson(root, "user/memory/dream-cursor.json", { schemaVersion: 2, revision: 1, updatedAt: T, lastDreamAt: T });
  await writeJson(root, "user/people/forgotten.json", { forgotten: [{ userId: FORGOTTEN, at: T }] });
  await writeJson(root, "user/waifus/aria/life/pending-scrubs.json", { scrubs: [{ userId: SCRUBBED, at: T, source: "dm_forget_everything" }] });

  // The director.
  await writeJson(root, "user/orchestrator/config.json", { schemaVersion: 2, revision: 1, updatedAt: T });
  await writeJson(root, "user/orchestrator/debug.json", { schemaVersion: 2, revision: 1, updatedAt: T, routes: {} });
  await writeJson(root, "user/stage-manager/history.json", { schemaVersion: 2, revision: 1, updatedAt: T, edits: [] });
  await writeJson(root, "user/reviewer/history.json", { schemaVersion: 2, revision: 1, updatedAt: T, reviews: [] });
  await writeJson(root, `user/servers/${GUILD}/orchestrator-history.json`, { schemaVersion: 2, revision: 1, updatedAt: T, decisions: [] });
  await writeJson(root, `user/servers/${GUILD}/sessions/${CHANNEL}.json`, { schemaVersion: 2, revision: 1, updatedAt: T });
  await writeJson(root, `user/servers/${GUILD}/server.json`, {
    schemaVersion: 2,
    revision: 4,
    updatedAt: T,
    guildId: GUILD,
    name: "Bake Club",
    orchestratorMode: "one-shot",
    oneShot: { target: "laya:english" },
    stageManagerEnabled: true,
    contextWindows: { orchestrator: 20, waifu: 50 },
    memoryInjectionLimit: 12,
    tools: { webSearch: true },
    compaction: { enabled: true },
    paused: false,
    channels: { [CHANNEL]: { channelId: CHANNEL, name: "general", enabledWaifuIds: ["aria"] } }
  });
  await writeJson(root, "user/servers/100000000000000002/server.json", {
    schemaVersion: 2, revision: 1, updatedAt: T, guildId: "100000000000000002", orchestratorMode: "one-shot", oneShot: { target: "openrouter:cloudflare/clef" }, channels: {}
  });
  await writeJson(root, "user/servers/100000000000000003/server.json", {
    schemaVersion: 2, revision: 1, updatedAt: T, guildId: "100000000000000003", orchestratorMode: "model", oneShot: { target: "laya:english" }, channels: {}
  });

  // The context engine: a guild ledger with an image ref, contexts, and the ref store that stays.
  const conversation = `user/conversations/g_${GUILD}_${CHANNEL}`;
  await writeJson(root, `${conversation}/ledger.json`, { entries: { m1: { images: [{ key: "att:1:img.png" }] }, m2: { images: [] } } });
  await writeJson(root, `${conversation}/contexts/waifu-aria.json`, { epoch: 3 });
  await writeJson(root, `${conversation}/refs.json`, { refs: {} });
  await writeJson(root, `${conversation}/images.json`, { keys: ["att:0:old.png"] });

  // DMs: one in flight at upgrade (with run records), one idle, one for a deleted waifu.
  await writeJson(root, `user/dms/${MINA}/aria.json`, {
    schemaVersion: 2, revision: 9, updatedAt: T, waifuId: "aria", userId: MINA, botId: "aria-bot", userDisplayName: "Mina",
    lastInboundMessageId: "900000000000000010", lastInboundAt: T,
    pendingTriggerMessageId: "900000000000000010", pendingSince: "2026-10-23T22:00:00.000Z",
    recentRuns: [{ id: "r1", at: T, triggerMessageId: "900000000000000009", status: "sent", messageIds: [] }]
  });
  await writeJson(root, `user/dms/${KEVIN}/aria.json`, {
    schemaVersion: 2, revision: 2, updatedAt: T, waifuId: "aria", userId: KEVIN, botId: "aria-bot", recentRuns: []
  });
  await writeJson(root, `user/dms/${KEVIN}/ghost.json`, {
    schemaVersion: 2, revision: 2, updatedAt: T, waifuId: "ghost", userId: KEVIN, botId: "ghost-bot", pendingSince: T
  });
  await writeJson(root, `user/dms/${KEVIN}/limits/aria.json`, { schemaVersion: 2, revision: 1, updatedAt: T, waifuId: "aria", userId: KEVIN, replyTimestamps: [] });

  // config.toml as main wrote it (old defaults spelled out).
  const config = await readFile(path.join(root, "config.toml"), "utf8");
  const legacy = config
    .replace(/\[life\][\s\S]*?(?=\n\[)/u, "")
    .replace("[discord.debounce]", "[discord.deletedMessages]\nredactRecent = 20\n\n[discord.debounce]")
    .replace(/dmMs = \d+/u, "dmMs = 1500")
    .replace(/dmMaxWaitMs = \d+/u, "dmMaxWaitMs = 8000")
    .replace("resumeWindowMinutes = 60", "maxConcurrentRuns = 6\nresumeWindowMinutes = 60");
  await writeFile(path.join(root, "config.toml"), `${legacy}\n[memory]\ndreamHourLocal = 4\nmaxInlineImagesPerEpoch = 32\nretrievalLimit = 12\n`);
  return root;
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "app/migrations.json" || relative.startsWith("app/logs") || relative === "app/runtime.json") continue;
      if (entry.isDirectory()) await walk(absolute);
      else out.set(relative, await readFile(absolute, "utf8"));
    }
  };
  await walk(root);
  return out;
}

describe("Living cast L2 data migrations on a main-era root", () => {
  it("converts every L2 shape once; re-running (ledger kept or lost) leaves the root byte-identical", async () => {
    const root = await mainEraRoot();
    const first = await runMigrations(root, { appVersion: APP_VERSION });
    expect(first.applied).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^living-cast-memories-to-notes-/u),
        expect.stringMatching(/^living-cast-archive-director-/u),
        "living-cast-dm-state-1-of-3",
        "living-cast-server-fields-3-detector-1",
        "living-cast-app-config-v1"
      ])
    );
    const migrated = await snapshot(root);

    // memories → notes (§7.4).
    const notes = (file: string) => migrated.get(`user/waifus/aria/notes/${file}`);
    // A person's own file carries their id marker, so a later forget deletes it whole (§7.5 step 5).
    expect(notes("people/kevin-0003.md")).toBe(
      `# Kevin\n<!-- user:${KEVIN} -->\n\n- Kevin is allergic to peanuts.\n- Kevin studies chemistry.\n- Kevin and Mina run the bake sale.\n`
    );
    expect(notes("people/kevin-9999.md")).toBe(`# Kevin\n<!-- user:${KEVIN_2} -->\n\n- The other Kevin likes jazz.\n`);
    expect(notes("people/mina.md")).toBe(
      `# Mina\n<!-- user:${MINA} -->\n\n- Mina is nervous about her exam. (from a private chat with Mina)\n- Wants to learn baking. (from a private chat with Mina)\n- Kevin and Mina run the bake sale.\n`
    );
    expect(notes("me.md")).toBe("# Me\n\n- I prefer lemon tarts.\n");
    expect(notes("misc.md")).toBe("# Misc\n\n- The bake sale is on Saturday.\n");
    expect(notes("MEMORY.md")).toBe(
      [
        "# Memory",
        "- [Kevin](people/kevin-0003.md) — Kevin is allergic to peanuts.",
        "- [Mina](people/mina.md) — Mina is nervous about her exam.",
        "- [Misc](misc.md) — The bake sale is on Saturday.",
        "- [Me](me.md) — I prefer lemon tarts.",
        "- [Kevin](people/kevin-9999.md) — The other Kevin likes jazz.",
        ""
      ].join("\n")
    );
    // Forgotten people (owner forget, her pending scrub) are nowhere: not in notes, not in the archive.
    const everything = [...migrated.entries()].filter(([file]) => !file.endsWith("forgotten.json") && !file.endsWith("pending-scrubs.json")).map(([, text]) => text).join("\n");
    for (const secret of ["Forgotten person's secret.", "Said in a forgotten DM.", "Scrubbed user's hobby."]) expect(everything).not.toContain(secret);
    // Her pending scrub only concerns her: Mina's record about Sam is kept.
    expect(migrated.get("user/waifus/mina/notes/people/sam.md")).toBe(`# Sam\n<!-- user:${SCRUBBED} -->\n\n- Mina's view of Sam.\n`);
    // Archived, expired and already-noted waifus' records are not carried over.
    expect(everything).not.toContain("- Old news.");
    expect(everything).not.toContain("- Short-lived.");
    expect(migrated.get("user/waifus/noted/notes/MEMORY.md")).toBe("# Memory\n- hand written\n");
    expect(migrated.has("user/memories.json")).toBe(false);
    expect(migrated.has("user/memory/dream-cursor.json")).toBe(false);
    expect(migrated.has("user/.archive/living-cast/memory/dream-cursor.json")).toBe(true);
    const archived = JSON.parse(migrated.get("user/.archive/living-cast/memories.json")!) as { revision: number; memories: Array<{ id: string }> };
    expect(archived.revision).toBe(7);
    expect(archived.memories.map((entry) => entry.id)).toEqual(["k1", "k2", "k3", "k4", "dm1", "dm2", "me1", "misc1", "gone1", "exp1", "s2", "n1"]);

    // The director's data (§11.2).
    for (const gone of ["user/orchestrator/config.json", "user/stage-manager/history.json", "user/reviewer/history.json", `user/servers/${GUILD}/orchestrator-history.json`, `user/servers/${GUILD}/sessions/${CHANNEL}.json`]) {
      expect(migrated.has(gone), gone).toBe(false);
    }
    for (const kept of [
      "user/.archive/living-cast/orchestrator/config.json",
      "user/.archive/living-cast/orchestrator/debug.json",
      "user/.archive/living-cast/stage-manager/history.json",
      "user/.archive/living-cast/reviewer/history.json",
      `user/.archive/living-cast/servers/${GUILD}/orchestrator-history.json`,
      `user/.archive/living-cast/servers/${GUILD}/sessions/${CHANNEL}.json`,
      `user/.archive/living-cast/conversations/g_${GUILD}_${CHANNEL}/ledger.json`,
      `user/.archive/living-cast/conversations/g_${GUILD}_${CHANNEL}/contexts/waifu-aria.json`
    ]) {
      expect(migrated.has(kept), kept).toBe(true);
    }
    const conversation = `user/conversations/g_${GUILD}_${CHANNEL}`;
    expect(migrated.has(`${conversation}/ledger.json`)).toBe(false);
    expect(migrated.has(`${conversation}/refs.json`)).toBe(true);
    // The ledger's image refs live on in the image index, so a forget still purges them.
    expect(JSON.parse(migrated.get(`${conversation}/images.json`)!)).toEqual({ keys: ["att:0:old.png", "att:1:img.png"] });

    // DM state (§11.2): the in-flight DM is an immediate dm wake; run records are gone.
    const queue = WakeQueueSchema.parse(JSON.parse(migrated.get("user/waifus/aria/life/wakes.json")!));
    expect(queue.immediate).toEqual([
      { id: `w-upgrade-dm-${MINA}`, reason: "dm", placeKey: `dm_${MINA}_aria`, fromUserId: MINA, fromName: "Mina", messageId: "900000000000000010", at: "2026-10-23T22:00:00.000Z" }
    ]);
    const minaDm = JSON.parse(migrated.get(`user/dms/${MINA}/aria.json`)!);
    expect(minaDm).not.toHaveProperty("pendingTriggerMessageId");
    expect(minaDm).not.toHaveProperty("recentRuns");
    expect(DmStateSchema.parse(minaDm).lastInboundMessageId).toBe("900000000000000010");
    expect(migrated.has("user/waifus/ghost/life/wakes.json")).toBe(false);

    // Server files (§11.2): retired fields gone; a custom one-shot target is the detector override.
    const server = JSON.parse(migrated.get(`user/servers/${GUILD}/server.json`)!);
    for (const field of ["orchestratorMode", "oneShot", "stageManagerEnabled", "contextWindows", "memoryInjectionLimit", "tools", "compaction"]) expect(server).not.toHaveProperty(field);
    expect(ServerConfigSchema.parse(server).detector).toEqual({ target: "laya:english" });
    expect(JSON.parse(migrated.get("user/servers/100000000000000002/server.json")!)).not.toHaveProperty("detector");
    expect(JSON.parse(migrated.get("user/servers/100000000000000003/server.json")!)).not.toHaveProperty("detector");

    // config.toml (§11.2) loads, with the moved values.
    const config = AppConfigSchema.parse(parseToml(migrated.get("config.toml")!));
    expect(config.life).toMatchObject({ maintenanceHourLocal: 4, maxInlineImagesPerEpoch: 20, maxConcurrentTurns: 6 });
    expect(config.discord.debounce).toMatchObject({ dmMs: 30_000, dmMaxWaitMs: 180_000 });
    const rawConfig = parseToml(migrated.get("config.toml")!) as Record<string, Record<string, unknown>>;
    expect(rawConfig).not.toHaveProperty("memory");
    expect(rawConfig.discord).not.toHaveProperty("deletedMessages");
    expect(rawConfig.discord!["dm"]).toEqual({ resumeWindowMinutes: 60 });

    // Re-runs: same version, then without the ledger, then a new version.
    expect((await runMigrations(root, { appVersion: APP_VERSION })).applied).toEqual([]);
    expect(await snapshot(root)).toEqual(migrated);
    await rm(path.join(root, "app", "migrations.json"));
    await runMigrations(root, { appVersion: APP_VERSION });
    expect(await snapshot(root)).toEqual(migrated);
    await runMigrations(root, { appVersion: "3.0.1" });
    expect(await snapshot(root)).toEqual(migrated);
  });

  it("fails (and is not recorded) while a forget record is unreadable, then converts after the repair", async () => {
    const root = await mainEraRoot();
    await writeFile(path.join(root, "user/people/forgotten.json"), "{ broken");
    await expect(runMigrations(root, { appVersion: APP_VERSION })).rejects.toThrow(/forgotten\.json is unreadable/u);
    expect(await exists(root, "user/memories.json")).toBe(true);
    expect(await exists(root, "user/waifus/aria/notes")).toBe(false);
    await writeJson(root, "user/people/forgotten.json", { forgotten: [{ userId: FORGOTTEN, at: T }] });
    await runMigrations(root, { appVersion: APP_VERSION });
    expect(await readFile(path.join(root, "user/waifus/aria/notes/MEMORY.md"), "utf8")).toContain("people/kevin-0003.md");
  });

  it("finishes a run that crashed after the notes were written (the store is still there)", async () => {
    const root = await mainEraRoot();
    await migrateLivingCastMemoriesToNotes(root, { now: () => NOW });
    // Simulate the crash before the store was removed.
    await writeJson(root, "user/memories.json", await readJson(root, "user/.archive/living-cast/memories.json"));
    const before = await readFile(path.join(root, "user/waifus/aria/notes/MEMORY.md"), "utf8");
    await migrateLivingCastMemoriesToNotes(root, { now: () => NOW });
    expect(await readFile(path.join(root, "user/waifus/aria/notes/MEMORY.md"), "utf8")).toBe(before);
    expect(await exists(root, "user/memories.json")).toBe(false);
    expect(await exists(root, "user/waifus/aria/notes.migrating")).toBe(false);
  });
});

describe("memories → notes limits (§7.4)", () => {
  const entry = (id: string, o: Partial<{ content: string; strength: number; pinned: boolean; updatedAt: string; userId: string; name: string }> = {}) => ({
    id,
    waifuId: "aria",
    content: o.content ?? `fact ${id}`,
    pinned: o.pinned ?? false,
    strength: o.strength ?? 3,
    updatedAt: o.updatedAt ?? T,
    subjects: o.userId ? [{ discordUserId: o.userId, name: o.name ?? `Person ${o.userId}` }] : []
  });

  it("orders lines pinned, strength, newest; cuts a file at 16 KB and lists the rest", () => {
    const records = [
      entry("a", { userId: KEVIN, name: "Kevin", strength: 2, updatedAt: "2026-10-03T00:00:00.000Z" }),
      entry("b", { userId: KEVIN, name: "Kevin", strength: 5 }),
      entry("c", { userId: KEVIN, name: "Kevin", strength: 1, pinned: true }),
      entry("d", { userId: KEVIN, name: "Kevin", strength: 2, updatedAt: "2026-10-01T00:00:00.000Z" })
    ];
    expect(notesForWaifu("aria", records).files[0]!.lines.map((line) => line.record.id)).toEqual(["c", "b", "a", "d"]);
    const big = Array.from({ length: 200 }, (_, index) => entry(`x${index}`, { userId: KEVIN, name: "Kevin", content: `${"long fact ".repeat(10)}${index}` }));
    const { files, omitted } = notesForWaifu("aria", big);
    const rendered = `# Kevin\n\n${files[0]!.lines.map((line) => `- ${line.text}`).join("\n")}\n`;
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16 * 1024);
    expect(files[0]!.lines.length + omitted.length).toBe(200);
    expect(omitted[0]).toMatchObject({ path: "people/kevin.md", why: "note_limit" });
  });

  it("merges the weakest people into people/others.md beyond 200 files", () => {
    const records = Array.from({ length: 230 }, (_, index) =>
      entry(`p${index}`, { userId: `4000000000000${String(index).padStart(5, "0")}`, name: `Person ${index}`, strength: index < 10 ? 5 : 1 })
    );
    const { files } = notesForWaifu("aria", [...records, entry("misc")]);
    // MEMORY.md + misc.md + others.md + the people files make 200.
    expect(files.length + 1).toBe(200);
    const others = files.find((file) => file.path === "people/others.md")!;
    expect(others.lines.length).toBe(230 - 197);
    expect(others.lines[0]!.text).toMatch(/^Person \d+: fact p\d+$/u);
    expect(files.some((file) => file.path === "people/person-0.md")).toBe(true);
  });
});
