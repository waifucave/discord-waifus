import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import { migrateOrchestratorHistoryPerGuild } from "../src/backend/migrationSteps/orchestratorHistoryPerGuild.js";
import { dropServerEnabledFlags } from "../src/backend/migrationSteps/serverDropEnabledFlags.js";
import {
  DECISION_HISTORY_CAP_PER_GUILD,
  appendOrchestratorHistory,
  healPendingOrchestratorDecisions,
  readMergedOrchestratorHistory,
  readOrchestratorDecision,
  readOrchestratorHistoryForGuild,
  updateOrchestratorDecisionStatus
} from "../src/orchestration/stores/decisionHistory.js";
import { listKnownGuildIds } from "../src/orchestration/stores/config.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { ResourceLockManager } from "../src/storage/locks.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function root(): Promise<string> {
  const dir = await makeTempRoot();
  roots.push(dir);
  return dir;
}

function at(minute: number, second = 0): string {
  return new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + (minute * 60 + second) * 1000).toISOString();
}

function decisionEntry(id: string, guildId: string | undefined, channelId: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ...(guildId ? { guildId } : {}),
    channelId,
    action: "no_reply",
    respondingWaifus: [],
    reasoning: "seeded",
    status: "completed",
    waifuMessageIds: [],
    responderOutcomes: [],
    createdAt,
    ...extra
  };
}

function appendInput(id: string, guildId: string, createdAt: string) {
  return {
    id,
    guildId,
    channelId: "channel-1",
    action: "no_reply" as const,
    respondingWaifus: [],
    reasoning: "r",
    status: "completed" as const,
    waifuMessageIds: [],
    responderOutcomes: [],
    createdAt
  };
}

async function writeJson(dataRoot: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(dataRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = any>(dataRoot: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dataRoot, relativePath), "utf8")) as T;
}

function globalFile(decisions: unknown[]) {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 4, updatedAt: at(0), decisions };
}

async function seedServers(dataRoot: string, ...guildIds: string[]): Promise<void> {
  for (const guildId of guildIds) {
    await writeJson(dataRoot, `user/servers/${guildId}/server.json`, {
      schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: at(0), guildId
    });
  }
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

describe("per-guild decision history store (spec 9.3)", () => {
  it("keeps 300 per guild, newest first, and two guilds writing at once never share a lock", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    await seedServers(dataRoot, "guild-a", "guild-b");
    const heldKeys: string[] = [];
    const locks = new ResourceLockManager();
    const withLock = locks.withLock.bind(locks);
    locks.withLock = (async (key: string, task: () => unknown) => {
      heldKeys.push(key);
      return withLock(key, task as never);
    }) as typeof locks.withLock;
    const storage = new StorageService(dataRoot, { locks });

    const total = DECISION_HISTORY_CAP_PER_GUILD + 15;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < total; i += 1) {
      writes.push(appendOrchestratorHistory(storage, appendInput(`a-${i}`, "guild-a", at(i))));
      writes.push(appendOrchestratorHistory(storage, appendInput(`b-${i}`, "guild-b", at(i))));
    }
    await Promise.all(writes);

    for (const guildId of ["guild-a", "guild-b"]) {
      const history = await readOrchestratorHistoryForGuild(storage, guildId);
      expect(history.decisions).toHaveLength(DECISION_HISTORY_CAP_PER_GUILD);
      // every kept decision belongs to this guild; the newest write is first
      expect(history.decisions.every((d) => d.guildId === guildId)).toBe(true);
      expect(history.decisions[0]!.id).toBe(`${guildId === "guild-a" ? "a" : "b"}-${total - 1}`);
    }
    for (const guildId of ["guild-a", "guild-b"]) {
      expect(heldKeys).toContain(`orchestrator:history:${guildId}`);
    }
    expect(heldKeys.filter((key) => key.startsWith("orchestrator:history:")).length).toBe(total * 2);
    expect(await exists(path.join(dataRoot, "user", "orchestrator", "history.json"))).toBe(false);
  }, 60_000);

  it("updates and reads decisions through their own guild file", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    await seedServers(dataRoot, "guild-a", "guild-b");
    await appendOrchestratorHistory(storage, { ...appendInput("d1", "guild-a", at(1)), status: "pending" });
    await appendOrchestratorHistory(storage, appendInput("d1b", "guild-b", at(2)));
    await updateOrchestratorDecisionStatus(storage, "guild-a", "d1", "completed");
    expect((await readOrchestratorDecision(storage, "guild-a", "d1"))?.status).toBe("completed");
    expect(await readOrchestratorDecision(storage, "guild-b", "d1")).toBeUndefined();
    expect(await exists(path.join(dataRoot, "user", "servers", "guild-a", "orchestrator-history.json"))).toBe(true);
  });

  it("rejects guild ids that are not safe directory names", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    await expect(appendOrchestratorHistory(storage, appendInput("x", "../escape", at(1)))).rejects.toThrow(/Invalid guild id/);
  });

  it("never creates a server directory: a write for a deleted server is skipped", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    expect(await appendOrchestratorHistory(storage, appendInput("x", "gone-guild", at(1)))).toBe(false);
    expect(await exists(path.join(dataRoot, "user", "servers", "gone-guild"))).toBe(false);
    await seedServers(dataRoot, "live-guild");
    expect(await appendOrchestratorHistory(storage, appendInput("y", "live-guild", at(1)))).toBe(true);
  });

  it("a history write racing DELETE /api/servers cannot resurrect the folder", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    await seedServers(dataRoot, "guild-a");
    // the DELETE route removes the folder while holding the server lock
    const removal = storage.withLocks(["server:guild-a"], async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await rm(path.join(dataRoot, "user", "servers", "guild-a"), { recursive: true, force: true });
    });
    const write = appendOrchestratorHistory(storage, appendInput("late", "guild-a", at(1)));
    await Promise.all([removal, write]);
    expect(await exists(path.join(dataRoot, "user", "servers", "guild-a"))).toBe(false);
  });

  it("the restart heal walks every guild and the legacy file, writing only what changed", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    await seedServers(dataRoot, "guild-a", "guild-b");
    const pending = (id: string, guildId?: string) =>
      decisionEntry(id, guildId, "channel-1", at(1), {
        status: "pending",
        responderOutcomes: [{ id: `${id}-o`, waifuId: "yuki", source: "orchestrator", status: "pending", messageIds: [] }]
      });
    await writeJson(dataRoot, "user/servers/guild-a/orchestrator-history.json", globalFile([pending("pa", "guild-a")]));
    await writeJson(dataRoot, "user/servers/guild-b/orchestrator-history.json", globalFile([decisionEntry("done", "guild-b", "c", at(2))]));
    await writeJson(dataRoot, "user/orchestrator/history-legacy.json", globalFile([pending("pl")]));

    await healPendingOrchestratorDecisions(storage);

    const a = await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json");
    expect(a.decisions[0]).toMatchObject({
      status: "interrupted",
      responderOutcomes: [{ status: "interrupted", reason: "runtime_restarted" }]
    });
    expect(a.revision).toBe(5);
    expect((await readJson(dataRoot, "user/servers/guild-b/orchestrator-history.json")).revision).toBe(4);
    expect((await readJson(dataRoot, "user/orchestrator/history-legacy.json")).decisions[0].status).toBe("interrupted");
  });

  it("the heal survives a corrupt guild file and logs it; the other guilds still heal", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    await seedServers(dataRoot, "guild-a", "guild-b");
    await writeFile(path.join(dataRoot, "user/servers/guild-a/orchestrator-history.json"), "{broken");
    await writeJson(dataRoot, "user/servers/guild-b/orchestrator-history.json", globalFile([
      decisionEntry("pb", "guild-b", "c", at(1), { status: "pending" })
    ]));
    const warnings: string[] = [];
    await healPendingOrchestratorDecisions(storage, { warn: (m) => void warnings.push(m) });
    expect((await readJson(dataRoot, "user/servers/guild-b/orchestrator-history.json")).decisions[0].status).toBe("interrupted");
    expect(warnings).toHaveLength(1);
  });

  it("merges every guild file plus the legacy file newest first and skips an unreadable file", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const storage = new StorageService(dataRoot);
    await writeJson(dataRoot, "user/servers/guild-a/orchestrator-history.json", globalFile([decisionEntry("a2", "guild-a", "c1", at(30)), decisionEntry("a1", "guild-a", "c1", at(10))]));
    await writeJson(dataRoot, "user/servers/guild-b/orchestrator-history.json", { ...globalFile([decisionEntry("b1", "guild-b", "c1", at(20))]), revision: 9 });
    await writeJson(dataRoot, "user/orchestrator/history-legacy.json", globalFile([decisionEntry("old", undefined, "c9", at(5))]));
    await mkdir(path.join(dataRoot, "user", "servers", "guild-broken"), { recursive: true });
    await writeFile(path.join(dataRoot, "user", "servers", "guild-broken", "orchestrator-history.json"), "{not json");

    const warnings: string[] = [];
    const merged = await readMergedOrchestratorHistory(storage, { warn: (m) => void warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(merged.decisions.map((d) => d.id)).toEqual(["a2", "b1", "a1", "old"]);
    expect(merged.revision).toBe(9);
    expect(merged.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("an empty data root merges to an empty history", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    const merged = await readMergedOrchestratorHistory(new StorageService(dataRoot));
    expect(merged.decisions).toEqual([]);
  });
});

describe("orchestrator-history-per-guild-v1 migration", () => {
  const SOURCE = "user/orchestrator/history.json";

  it("splits the global file by guild, sends guildless entries to history-legacy.json and renames the source", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a", "guild-b");
    await writeJson(dataRoot, SOURCE, globalFile([
      decisionEntry("a2", "guild-a", "c1", at(30)),
      decisionEntry("b1", "guild-b", "c1", at(20)),
      decisionEntry("a1", "guild-a", "c1", at(10)),
      decisionEntry("old", undefined, "c9", at(5)),
      { not: "a decision" },
      "garbage"
    ]));

    const label = await migrateOrchestratorHistoryPerGuild(dataRoot);

    expect(label).toBe("migrate-orchestrator-history-per-guild-4");
    expect((await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json")).decisions.map((d: any) => d.id)).toEqual(["a2", "a1"]);
    expect((await readJson(dataRoot, "user/servers/guild-b/orchestrator-history.json")).decisions.map((d: any) => d.id)).toEqual(["b1"]);
    expect((await readJson(dataRoot, "user/orchestrator/history-legacy.json")).decisions.map((d: any) => d.id)).toEqual(["old"]);
    expect(await exists(path.join(dataRoot, SOURCE))).toBe(false);
    expect(await exists(path.join(dataRoot, `${SOURCE}.migrated`))).toBe(true);
    // the result is readable through the store schema
    const merged = await readMergedOrchestratorHistory(new StorageService(dataRoot));
    expect(merged.decisions.map((d) => d.id)).toEqual(["a2", "b1", "a1", "old"]);
  });

  it("caps each guild at 300 and keeps the newest", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    const entries = Array.from({ length: 450 }, (_, i) => decisionEntry(`a-${i}`, "guild-a", "c1", at(i)));
    await writeJson(dataRoot, SOURCE, globalFile([...entries].reverse()));
    await migrateOrchestratorHistoryPerGuild(dataRoot);
    const file = await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json");
    expect(file.decisions).toHaveLength(300);
    expect(file.decisions[0].id).toBe("a-449");
    expect(file.decisions[299].id).toBe("a-150");
  });

  it("is idempotent: a second run is a no-op, and a replay after a crash merges by id without duplicates", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    const source = globalFile([
      decisionEntry("a2", "guild-a", "c1", at(30)),
      decisionEntry("a1", "guild-a", "c1", at(10)),
      decisionEntry("old", undefined, "c9", at(5))
    ]);
    await writeJson(dataRoot, SOURCE, source);
    await migrateOrchestratorHistoryPerGuild(dataRoot);
    const afterFirst = await readFile(path.join(dataRoot, "user/servers/guild-a/orchestrator-history.json"), "utf8");

    expect(await migrateOrchestratorHistoryPerGuild(dataRoot)).toBeUndefined();
    expect(await readFile(path.join(dataRoot, "user/servers/guild-a/orchestrator-history.json"), "utf8")).toBe(afterFirst);

    // crash between the writes and the rename: the source is still there, the guild files are written
    await rename(path.join(dataRoot, `${SOURCE}.migrated`), path.join(dataRoot, SOURCE));
    await migrateOrchestratorHistoryPerGuild(dataRoot);
    expect((await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json")).decisions.map((d: any) => d.id)).toEqual(["a2", "a1"]);
    expect((await readJson(dataRoot, "user/orchestrator/history-legacy.json")).decisions.map((d: any) => d.id)).toEqual(["old"]);
  });

  it("keeps the existing copy of a decision a guild file already holds", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    await writeJson(dataRoot, "user/servers/guild-a/orchestrator-history.json", globalFile([decisionEntry("a1", "guild-a", "c1", at(10), { status: "interrupted" })]));
    await writeJson(dataRoot, SOURCE, globalFile([decisionEntry("a1", "guild-a", "c1", at(10), { status: "pending" })]));
    await migrateOrchestratorHistoryPerGuild(dataRoot);
    expect((await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json")).decisions[0].status).toBe("interrupted");
  });

  it("a missing source is a no-op and creates nothing", async () => {
    const dataRoot = await root();
    expect(await migrateOrchestratorHistoryPerGuild(dataRoot)).toBeUndefined();
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("a corrupt source is quarantined as history.json.corrupt-<ts> and boot continues", async () => {
    const dataRoot = await root();
    const steps = MIGRATION_STEPS.filter((step) => step.id === "orchestrator-history-per-guild-v1");
    await mkdir(path.join(dataRoot, "user", "orchestrator"), { recursive: true });
    await writeFile(path.join(dataRoot, SOURCE), "{truncated");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await runMigrations(dataRoot, { steps, appVersion: "9.9.9" });
      expect(result.applied).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(await exists(path.join(dataRoot, SOURCE))).toBe(false);
    const files = await readdir(path.join(dataRoot, "user", "orchestrator"));
    const quarantined = files.filter((name) => name.startsWith("history.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(dataRoot, "user/orchestrator", quarantined[0]!), "utf8")).toBe("{truncated");
  });

  it("a global file that parses but is not a history is quarantined too", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, SOURCE, { schemaVersion: CURRENT_SCHEMA_VERSION });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await migrateOrchestratorHistoryPerGuild(dataRoot)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    expect(await exists(path.join(dataRoot, SOURCE))).toBe(false);
  });

  it("a corrupt guild target is quarantined and replaced, not fatal", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    await writeFile(path.join(dataRoot, "user/servers/guild-a/orchestrator-history.json"), "{bad");
    await writeJson(dataRoot, SOURCE, globalFile([decisionEntry("a1", "guild-a", "c1", at(10))]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await migrateOrchestratorHistoryPerGuild(dataRoot);
    } finally {
      warn.mockRestore();
    }
    expect((await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json")).decisions.map((d: any) => d.id)).toEqual(["a1"]);
    const files = await readdir(path.join(dataRoot, "user/servers/guild-a"));
    expect(files.some((name) => name.startsWith("orchestrator-history.json.corrupt-"))).toBe(true);
  });

  it("entries of guilds without a server.json go to history-legacy.json and create no folder (I1)", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    await writeJson(dataRoot, SOURCE, globalFile([
      decisionEntry("a1", "guild-a", "c1", at(10)),
      decisionEntry("gone", "deleted-guild", "c1", at(20))
    ]));
    await migrateOrchestratorHistoryPerGuild(dataRoot);
    expect(await exists(path.join(dataRoot, "user/servers/deleted-guild"))).toBe(false);
    expect((await readJson(dataRoot, "user/orchestrator/history-legacy.json")).decisions.map((d: any) => d.id)).toEqual(["gone"]);
  });

  it("runs on every boot: a reseeded history.json after a rollback is split again", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    const step = MIGRATION_STEPS.find((candidate) => candidate.id === "orchestrator-history-per-guild-v1")!;
    expect(step.frequency).toBe("every-boot");
    expect(await step.run(dataRoot)).toBeUndefined();
    await writeJson(dataRoot, SOURCE, globalFile([decisionEntry("a1", "guild-a", "c1", at(10))]));
    expect(await step.run(dataRoot)).toBe("migrate-orchestrator-history-per-guild-1");
    await writeJson(dataRoot, SOURCE, globalFile([decisionEntry("a2", "guild-a", "c1", at(20))]));
    await step.run(dataRoot);
    expect((await readJson(dataRoot, "user/servers/guild-a/orchestrator-history.json")).decisions.map((d: any) => d.id)).toEqual(["a2", "a1"]);
  });

  it("is registered before the schema-version stamp and after the legacy shape conversion", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    expect(ids.indexOf("orchestrator-history-per-guild-v1")).toBeGreaterThan(ids.indexOf("orchestrator-history-responding-waifus"));
    expect(ids.indexOf("server-drop-enabled-flags-v1")).toBeLessThan(ids.length - 1);
    expect(ids.indexOf("orchestrator-history-per-guild-v1")).toBeLessThan(ids.length - 1);
  });

  it("the data layout no longer seeds the global history file", async () => {
    const dataRoot = await root();
    await ensureDataLayout(dataRoot);
    expect(await exists(path.join(dataRoot, SOURCE))).toBe(false);
    expect(await exists(path.join(dataRoot, "user/orchestrator/config.json"))).toBe(true);
  });
});

describe("server-drop-enabled-flags-v1 migration", () => {
  it("removes the server and channel enabled flags and nothing else", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, "user/servers/guild-a/server.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: at(0),
      guildId: "guild-a",
      enabled: false,
      paused: true,
      channels: {
        c1: { channelId: "c1", enabled: true, enabledWaifuIds: ["yuki"] },
        c2: { channelId: "c2", enabled: false, enabledWaifuIds: [] }
      }
    });
    await writeJson(dataRoot, "user/servers/guild-b/server.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 1,
      updatedAt: at(0),
      guildId: "guild-b",
      channels: { c1: { channelId: "c1", enabledWaifuIds: ["yuki"] } }
    });

    expect(await dropServerEnabledFlags(dataRoot)).toBe(1);

    const a = await readJson(dataRoot, "user/servers/guild-a/server.json");
    expect(a).not.toHaveProperty("enabled");
    expect(a.paused).toBe(true);
    expect(a.channels).toEqual({
      c1: { channelId: "c1", enabledWaifuIds: ["yuki"] },
      c2: { channelId: "c2", enabledWaifuIds: [] }
    });
    // idempotent
    const before = await readFile(path.join(dataRoot, "user/servers/guild-a/server.json"), "utf8");
    expect(await dropServerEnabledFlags(dataRoot)).toBe(0);
    expect(await readFile(path.join(dataRoot, "user/servers/guild-a/server.json"), "utf8")).toBe(before);
  });

  it("tolerates a missing servers folder, stray files and unparsable server files", async () => {
    const dataRoot = await root();
    expect(await dropServerEnabledFlags(dataRoot)).toBe(0);
    await mkdir(path.join(dataRoot, "user", "servers", "guild-x"), { recursive: true });
    await writeFile(path.join(dataRoot, "user", "servers", "guild-x", "server.json"), "{nope");
    await writeFile(path.join(dataRoot, "user", "servers", "stray.txt"), "x");
    expect(await dropServerEnabledFlags(dataRoot)).toBe(0);
  });
});

describe("server-drop-enabled-flags-v1 logging and known guilds", () => {
  it("logs one line per server that had an explicit enabled:false, pointing to paused, and does not pause it", async () => {
    const dataRoot = await root();
    await writeJson(dataRoot, "user/servers/guild-a/server.json", { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, updatedAt: at(0), guildId: "guild-a", enabled: false });
    await writeJson(dataRoot, "user/servers/guild-b/server.json", { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, updatedAt: at(0), guildId: "guild-b", enabled: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await dropServerEnabledFlags(dataRoot);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/guild-a.*paused/);
    } finally {
      warn.mockRestore();
    }
    expect((await readJson(dataRoot, "user/servers/guild-a/server.json")).paused).toBeUndefined();
  });

  it("listKnownGuildIds only returns folders that hold a server.json (I1)", async () => {
    const dataRoot = await root();
    await seedServers(dataRoot, "guild-a");
    await mkdir(path.join(dataRoot, "user/servers/deleted-guild"), { recursive: true });
    await writeJson(dataRoot, "user/servers/deleted-guild/orchestrator-history.json", globalFile([]));
    expect(await listKnownGuildIds(new StorageService(dataRoot))).toEqual(["guild-a"]);
  });
});
