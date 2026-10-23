import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/backend/migrations.js";
import { migrateDreamCursorGlobal } from "../src/backend/migrationSteps/dreamCursorGlobal.js";
import { MEMORIES_DEDUPE_AUDIT, MEMORIES_DEDUPE_MARKER, migrateMemoriesCrossGuildDedupe } from "../src/backend/migrationSteps/memoriesCrossGuildDedupe.js";
import { migrateMemoriesGlobalOriginSubjects } from "../src/backend/migrationSteps/memoriesGlobalOriginSubjects.js";
import { migratePendingObservationsGlobal } from "../src/backend/migrationSteps/pendingObservationsGlobal.js";
import { MemoryStoreSchema, PendingObservationsFileSchema } from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const T = "2026-10-01T12:00:00.000Z";

async function root(): Promise<string> {
  const dir = await makeTempRoot();
  roots.push(dir);
  return dir;
}

async function writeJson(dataRoot: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(dataRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = Record<string, unknown>>(dataRoot: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dataRoot, relativePath), "utf8")) as T;
}

async function seedCast(dataRoot: string): Promise<void> {
  await writeJson(dataRoot, "user/waifus/yuki/waifu.json", { id: "yuki", name: "Yuki", displayName: "Yuki" });
  await writeJson(dataRoot, "user/waifus/riko/waifu.json", { id: "riko", name: "Riko", displayName: "Riko-chan" });
  await writeJson(dataRoot, "user/servers/guild-a/members.json", {
    schemaVersion: 2, revision: 0, updatedAt: T, guildId: "guild-a",
    members: [
      { userId: "111", username: "kev", guildDisplayName: "Kevin", bot: false },
      { userId: "222", username: "alex1", guildDisplayName: "Alex", bot: false },
      { userId: "333", username: "alex2", guildDisplayName: "Alex", bot: false },
      { userId: "900", username: "yukibot", guildDisplayName: "Yuki", bot: true }
    ]
  });
  await writeJson(dataRoot, "user/servers/guild-b/members.json", {
    schemaVersion: 2, revision: 0, updatedAt: T, guildId: "guild-b",
    members: [{ userId: "111", username: "kev", guildDisplayName: "Kev", bot: false }]
  });
}

function legacyMemory(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    guildId: "guild-a",
    channelId: "chan-1",
    waifuId: "yuki",
    content: "Kevin is allergic to peanuts.",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    entities: [],
    createdAt: T,
    updatedAt: T,
    status: "active",
    ...overrides
  };
}

async function writeStore(dataRoot: string, memories: unknown[]): Promise<void> {
  await writeJson(dataRoot, "user/memories.json", { schemaVersion: 2, revision: 4, updatedAt: T, memories });
}

describe("memories-global-origin-subjects-v1", () => {
  it("moves guild/channel into origin and resolves only unique member/waifu names", async () => {
    const dir = await root();
    await seedCast(dir);
    await writeStore(dir, [
      legacyMemory("m1", { entities: ["Kevin", "Alex", "Tuesday", "Riko-chan"] }),
      legacyMemory("m2", { guildId: "guild-b", channelId: undefined, entities: ["Kev", "Kevin"] }),
      legacyMemory("m3", { guildId: "global", entities: ["Yuki"] })
    ]);

    expect(await migrateMemoriesGlobalOriginSubjects(dir)).toBe("migrate-memories-global-origin-subjects-3");
    const store = MemoryStoreSchema.parse(await readJson(dir, "user/memories.json"));
    const [m1, m2, m3] = store.memories;
    // Alex is ambiguous (two members), Tuesday is not a person: both dropped.
    expect(m1).toMatchObject({ origin: { guildId: "guild-a", channelId: "chan-1" }, revision: 0 });
    expect(m1!.subjects).toEqual([{ discordUserId: "111", name: "Kevin" }, { waifuId: "riko", name: "Riko-chan" }]);
    // Names resolve against THAT guild's members: guild-b knows "Kev", not "Kevin".
    expect(m2!.origin).toEqual({ guildId: "guild-b" });
    expect(m2!.subjects).toEqual([{ discordUserId: "111", name: "Kev" }]);
    // The dashboard's "global" placeholder guild is no provenance; the bot member is not a human.
    expect(m3!.origin).toEqual({});
    expect(m3!.subjects).toEqual([{ waifuId: "yuki", name: "Yuki" }]);
    const raw = await readJson<{ memories: Array<Record<string, unknown>> }>(dir, "user/memories.json");
    for (const memory of raw.memories) {
      expect(memory).not.toHaveProperty("guildId");
      expect(memory).not.toHaveProperty("channelId");
      expect(memory).not.toHaveProperty("entities");
    }

    // Idempotent: a second run changes nothing.
    const before = await readFile(path.join(dir, "user/memories.json"), "utf8");
    expect(await migrateMemoriesGlobalOriginSubjects(dir)).toBeUndefined();
    expect(await readFile(path.join(dir, "user/memories.json"), "utf8")).toBe(before);
  });
});

describe("pending-observations-global-v1", () => {
  it("converts guild scope to origin + conversationKey and entities to subjects", async () => {
    const dir = await root();
    await seedCast(dir);
    await writeJson(dir, "user/memory/pending-observations.json", {
      schemaVersion: 2, revision: 1, updatedAt: T,
      observations: [{
        id: "o1", guildId: "guild-a", channelId: "chan-1", waifuId: "yuki",
        content: "Kevin likes tea.", kind: "preference", importance: 3, entities: ["Kevin", "Alex"], createdAt: T
      }]
    });
    expect(await migratePendingObservationsGlobal(dir)).toBe("migrate-pending-observations-global-1");
    const file = PendingObservationsFileSchema.parse(await readJson(dir, "user/memory/pending-observations.json"));
    expect(file.observations[0]).toMatchObject({
      origin: { guildId: "guild-a", channelId: "chan-1" },
      conversationKey: "g_guild-a_chan-1",
      subjects: [{ discordUserId: "111", name: "Kevin" }]
    });
    expect(await migratePendingObservationsGlobal(dir)).toBeUndefined();
  });
});

describe("dream-cursor-global-v1", () => {
  it("collapses per-guild cursors into one waifu cursor", async () => {
    const dir = await root();
    await writeJson(dir, "user/memory/dream-cursor.json", {
      schemaVersion: 2, revision: 3, updatedAt: T, cursors: { "guild-a": "yuki", "guild-b": "orphan", "guild-c": "mika" }
    });
    expect(await migrateDreamCursorGlobal(dir)).toBe("migrate-dream-cursor-global");
    const file = await readJson(dir, "user/memory/dream-cursor.json");
    expect(file).toMatchObject({ cursor: "mika", revision: 3 });
    expect(file).not.toHaveProperty("cursors");
    expect(await migrateDreamCursorGlobal(dir)).toBeUndefined();
  });
});

describe("memories-cross-guild-dedupe-v1", () => {
  const phase4 = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    waifuId: "yuki",
    content: "Kevin is allergic to peanuts.",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: { guildId: "guild-a" },
    subjects: [{ discordUserId: "111", name: "Kevin" }],
    revision: 0,
    createdAt: T,
    updatedAt: T,
    status: "active",
    ...overrides
  });

  it("archives cross-guild duplicates (pinned > strongest > oldest), audits, and never re-runs", async () => {
    const dir = await root();
    await writeStore(dir, [
      phase4("a-weak", { strength: 2 }),
      phase4("b-strong", { origin: { guildId: "guild-b" }, strength: 4, content: "Kevin is allergic to peanuts" }),
      // Same text but disjoint subjects: a different person, kept.
      phase4("c-other-person", { origin: { guildId: "guild-c" }, subjects: [{ discordUserId: "999", name: "Kevin" }] }),
      // Same guild: left to the dream.
      phase4("d-same-guild", { origin: { guildId: "guild-a" }, createdAt: "2026-10-02T00:00:00.000Z" }),
      // Subject-less pair: only normalized-equal text merges.
      phase4("e-empty", { subjects: [], content: "The server's bake-off is in December.", kind: "event" }),
      phase4("f-empty", { subjects: [], content: "the server's bake-off is in december", kind: "event", origin: { guildId: "guild-b" }, createdAt: "2026-09-01T00:00:00.000Z" }),
      phase4("g-empty-near", { subjects: [], content: "The server's bake-off is in early December.", kind: "event", origin: { guildId: "guild-c" } }),
      // Different kind: never merged.
      phase4("h-kind", { origin: { guildId: "guild-b" }, kind: "preference" }),
      // Pinned duplicate: kept even though another pinned is better.
      phase4("i-pinned", { origin: { guildId: "guild-d" }, pinned: true, strength: 5 })
    ]);

    const label = await migrateMemoriesCrossGuildDedupe(dir);
    expect(label).toBe("memories-cross-guild-dedupe-4");
    const store = MemoryStoreSchema.parse(await readJson(dir, "user/memories.json"));
    const byId = new Map(store.memories.map((memory) => [memory.id, memory]));
    // Cluster {a, b, d (via a), i}: i is pinned → kept; a, b, d archived into i.
    expect(byId.get("i-pinned")!.status).toBe("active");
    for (const id of ["a-weak", "b-strong"]) {
      expect(byId.get(id)).toMatchObject({ status: "archived", archivedReason: "deduped", mergedInto: "i-pinned", revision: 1 });
    }
    // d is in guild-a like a, so it only joins through other guilds; it is cross-guild with b and i.
    expect(byId.get("d-same-guild")!.status).toBe("archived");
    expect(byId.get("c-other-person")!.status).toBe("active");
    expect(byId.get("h-kind")!.status).toBe("active");
    // e/f normalized-equal: oldest (f) kept; the near-but-not-equal subject-less g stays.
    expect(byId.get("f-empty")!.status).toBe("active");
    expect(byId.get("e-empty")).toMatchObject({ status: "archived", mergedInto: "f-empty" });
    expect(byId.get("g-empty-near")!.status).toBe("active");

    const audit = await readJson<{ archived: number; clusters: unknown[] }>(dir, MEMORIES_DEDUPE_AUDIT);
    expect(audit.archived).toBe(4);
    expect((await readJson<{ archived: number }>(dir, MEMORIES_DEDUPE_MARKER)).archived).toBe(4);

    // The marker blocks a re-run even when the migration ledger is lost.
    await rm(path.join(dir, "app/migrations.json"), { force: true });
    await writeStore(dir, [phase4("x"), phase4("y", { origin: { guildId: "guild-b" } })]);
    expect(await migrateMemoriesCrossGuildDedupe(dir)).toBeUndefined();
    const untouched = MemoryStoreSchema.parse(await readJson(dir, "user/memories.json"));
    expect(untouched.memories.every((memory) => memory.status === "active")).toBe(true);
  });
});

describe("full boot", () => {
  it("migrates a legacy guild-scoped store end to end; re-running every migration is a no-op", async () => {
    const dir = await root();
    await seedCast(dir);
    await writeStore(dir, [
      legacyMemory("dup-a", { entities: ["Kevin"] }),
      legacyMemory("dup-b", { guildId: "guild-b", channelId: "chan-9", entities: ["Kev"], createdAt: "2026-09-01T00:00:00.000Z" }),
      legacyMemory("solo", { content: "Riko owes Kevin a rematch.", waifuId: "riko", entities: ["Riko", "Kevin"] })
    ]);
    const first = await runMigrations(dir, { appVersion: "2.200.0" });
    expect(first.applied).toEqual(expect.arrayContaining(["migrate-memories-global-origin-subjects-3", "memories-cross-guild-dedupe-1"]));
    const store = MemoryStoreSchema.parse(await readJson(dir, "user/memories.json"));
    expect(store.memories.find((memory) => memory.id === "dup-b")!.status).toBe("active");
    expect(store.memories.find((memory) => memory.id === "dup-a")).toMatchObject({ status: "archived", mergedInto: "dup-b" });

    const snapshot = await readFile(path.join(dir, "user/memories.json"), "utf8");
    const second = await runMigrations(dir, { appVersion: "2.200.0" });
    expect(second.applied).toEqual([]);
    // Even with the ledger gone every step is idempotent.
    await rm(path.join(dir, "app/migrations.json"), { force: true });
    const third = await runMigrations(dir, { appVersion: "2.200.0" });
    expect(third.applied).toEqual([]);
    expect(await readFile(path.join(dir, "user/memories.json"), "utf8")).toBe(snapshot);
  });
});
